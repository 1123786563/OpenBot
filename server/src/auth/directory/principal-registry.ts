/*
 * PrincipalRegistry — the company-independent principal of one User (T02.07 /
 * #529, original task P04; design §4.2/§4.2.1, interfaces §2.1).
 *
 * One User has one Principal, and a Principal is not a company membership: a
 * personal flow (a user accepting an invitation, a first sign-in, a platform
 * command provisioning a company for an owner) needs the stable business
 * identity without inventing a tenant. `ensure` is therefore the only creator
 * of principal rows, and it is idempotent by construction:
 *
 * 1. The principal lock layer. `ensure` takes the same per-user lock the
 *    Identity path takes (`identityUserLock`), after the executor's tenant lock
 *    when there is one and before any member/team/resource lock. Two commands
 *    that race to create the same user's principal serialize here; the
 *    `enterprise_principal_user` unique index stays the database's last line,
 *    not the mechanism callers rely on.
 *
 * 2. Reuse or refuse, never repair. An existing principal is handed back with
 *    its own id and verified generation — `ensure` never writes it, so a
 *    suspended identity stays suspended (restoring is an Identity command with
 *    its own authority) and a generation is never bumped by a read. A
 *    principal that predates the generation column (identity_generation NULL)
 *    has history whose version cannot be verified: it is refused, never
 *    backfilled with a guessed 1, and never shadowed by a second subject for
 *    the same user.
 *
 * 3. First create only for a genuinely new user. A user with no principal row
 *    at all gets one server-generated id with identityGeneration 1 — the only
 *    place the plan allows 1 to be written. An unknown user id is a named
 *    refusal before the insert, so a caller's typo cannot surface as a foreign
 *    key error after partial work.
 *
 * The create runs inside the caller's transaction and nothing is committed or
 * cached here: a command that fails after `ensure` rolls the principal back
 * with the rest of its writes, so the finalizer never has to clean up an
 * orphan subject.
 *
 * Role note (disclosed, not decided here): at M1 the protected projection is
 * still written by the legacy writer of migration 0056. The T02.06 controlled
 * function `auth_principals_register` is the auth-writer's BA-mode path, but it
 * inserts `(id, user_id, created_at)` only and no role may UPDATE the
 * generation, so it cannot satisfy this contract's "generation 1" without a
 * migration change; wiring this registry onto that function belongs to the M4
 * ownership switch.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { enterprisePrincipals, users } from "../../db/schema";
import { identityUserLock } from "../../identity/store";
import type { DirectoryTx, PrincipalRef, PrincipalRegistry } from "./contracts";

export const PRINCIPAL_REGISTRY_INPUT_REQUIRED =
  "PRINCIPAL_REGISTRY_INPUT_REQUIRED";
export const PRINCIPAL_REGISTRY_UNKNOWN_USER =
  "PRINCIPAL_REGISTRY_UNKNOWN_USER";
export const PRINCIPAL_REGISTRY_UNVERIFIED_IDENTITY_HISTORY =
  "PRINCIPAL_REGISTRY_UNVERIFIED_IDENTITY_HISTORY";
export const PRINCIPAL_REGISTRY_UNSAFE_IDENTITY_GENERATION =
  "PRINCIPAL_REGISTRY_UNSAFE_IDENTITY_GENERATION";
export const PRINCIPAL_REGISTRY_PRINCIPAL_UNREADABLE =
  "PRINCIPAL_REGISTRY_PRINCIPAL_UNREADABLE";

/** The generation of a genuinely new user's principal; the only writer of 1. */
export const NEW_PRINCIPAL_IDENTITY_GENERATION = 1;

/**
 * A registry refusal: the command asked for a principal it must not get, and
 * nothing was written. The code is the stable, auditable reason; the message
 * names the user id and the state that made the command impossible without
 * echoing any secret.
 */
export class PrincipalRegistryRefusal extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "PrincipalRegistryRefusal";
  }
}

export function isPrincipalRegistryRefusal(
  error: unknown,
): error is PrincipalRegistryRefusal {
  return error instanceof PrincipalRegistryRefusal;
}

type PrincipalRow = Readonly<{
  id: string;
  identityGeneration: number | null;
}>;

/**
 * The one principal of a user, locked for the rest of the transaction so a
 * concurrent first create cannot slip between this read and the insert.
 * Absent rows are not lockable in PostgreSQL, which is why the per-user
 * advisory lock precedes this read.
 */
async function readPrincipalRow(
  tx: DirectoryTx,
  userId: string,
): Promise<PrincipalRow | undefined> {
  const [row] = await tx
    .select({
      id: enterprisePrincipals.id,
      identityGeneration: enterprisePrincipals.identityGeneration,
    })
    .from(enterprisePrincipals)
    .where(eq(enterprisePrincipals.userId, userId))
    .limit(1)
    .for("update");
  return row;
}

/**
 * The ref for an existing row, or the refusal its history earns. A missing or
 * unsafe generation is a damaged history: the command is blocked rather than
 * handed an unverifiable version, and the row is left exactly as it was.
 */
function refOf(
  row: PrincipalRow,
  userId: string,
  source: "existing" | "created",
): PrincipalRef {
  const generation = row.identityGeneration;
  if (generation === null) {
    throw new PrincipalRegistryRefusal(
      PRINCIPAL_REGISTRY_UNVERIFIED_IDENTITY_HISTORY,
      `${source} principal ${row.id} of user ${userId} has no verified identity generation; a history that cannot be versioned is never backfilled and never replaced by a new subject`,
    );
  }
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new PrincipalRegistryRefusal(
      PRINCIPAL_REGISTRY_UNSAFE_IDENTITY_GENERATION,
      `principal ${row.id} of user ${userId} carries identity generation ${String(generation)}, which is not a safe Version`,
    );
  }
  return { userId, principalId: row.id, identityGeneration: generation };
}

/**
 * Ensure the one principal of `userId`, or refuse the history that makes that
 * impossible. Runs at the principal lock layer of the caller's open
 * transaction (interfaces §2.1).
 */
export async function ensurePrincipal(
  tx: DirectoryTx,
  userId: string,
): Promise<PrincipalRef> {
  if (typeof userId !== "string" || userId.trim() === "") {
    throw new PrincipalRegistryRefusal(
      PRINCIPAL_REGISTRY_INPUT_REQUIRED,
      "a principal needs a user id; an empty target is refused before any lock or read",
    );
  }

  // The per-user principal lock: the same key the Identity path takes, so a
  // first create and a per-user identity mutation cannot interleave.
  await identityUserLock(tx, userId);

  const [user] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) {
    throw new PrincipalRegistryRefusal(
      PRINCIPAL_REGISTRY_UNKNOWN_USER,
      `user ${userId} does not exist; a principal is never created for an unknown subject`,
    );
  }

  const existing = await readPrincipalRow(tx, userId);
  if (existing) return refOf(existing, userId, "existing");

  const principalId = randomUUID();
  const [created] = await tx
    .insert(enterprisePrincipals)
    .values({
      id: principalId,
      userId,
      identityGeneration: NEW_PRINCIPAL_IDENTITY_GENERATION,
    })
    // A writer that does not take this lock may have created the row after our
    // read; the unique index turns that into "no row returned" instead of a
    // 23505 the caller cannot act on. The row is then read and judged below.
    .onConflictDoNothing({ target: enterprisePrincipals.userId })
    .returning({
      id: enterprisePrincipals.id,
      identityGeneration: enterprisePrincipals.identityGeneration,
    });
  if (created) return refOf(created, userId, "created");

  const raced = await readPrincipalRow(tx, userId);
  if (!raced) {
    throw new PrincipalRegistryRefusal(
      PRINCIPAL_REGISTRY_PRINCIPAL_UNREADABLE,
      `the principal of user ${userId} could neither be created nor read back inside this transaction`,
    );
  }
  return refOf(raced, userId, "existing");
}

/**
 * The injectable service the executor/bootstrap receives (T08.05). It holds no
 * state: the transaction is the caller's, and the lock and rules live in
 * {@link ensurePrincipal}.
 */
export const principalRegistry: PrincipalRegistry = {
  ensure: ensurePrincipal,
};
