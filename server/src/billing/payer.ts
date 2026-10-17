import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { billingCustomers, payerAccounts } from "../db/schema/billing";
import { deploymentExternalCustomerId } from "./service";

/**
 * The payer account layer: the billing subject as { kind, id }, mapped to exactly one existing
 * external customer id — the string `credit_grants`, `credit_ledger` and the CreditWriter already
 * key on. This layer deliberately does NOT re-key those tables or touch any amount: it fixes who
 * a key belongs to (one subject ↔ one key, both directions unique in the database), so later
 * tickets can resolve a payer once and feed the writer unchanged. No balance is ever created,
 * copied or moved here — an account is a mapping row, nothing more.
 *
 * The kind vocabulary is the parent spec's, and `unknown_owner` is its quarantine: group 02.2
 * records unattributable legacy keys as `unknown_owner` mapping rows for audit, and both
 * `payerKey` and `createPayerAccount` refuse that kind, so no new consumption path can resolve a
 * quarantined key into an account that could be charged.
 */

/** The billing subjects a payer account can name. Narrow, checked at the database too. */
export type PayerKind =
  | "personal"
  | "company"
  | "legacy_deployment"
  | "unknown_owner";

/** The unique billing subject: what a grant, hold, settlement and remainder belong to. */
export type PayerRef = {
  kind: PayerKind;
  /** The subject's own stable id: a user id, a tenant id, a deployment tenant id. */
  id: string;
};

/** One payer account row, as the module answers it. */
export type PayerAccount = {
  id: string;
  kind: PayerKind;
  payerId: string;
  /** The one external customer key this account bills through (CreditWriter's account key). */
  externalCustomerId: string;
  createdAt: string;
};

/**
 * A create that could not produce one authoritative mapping: the subject already holds a
 * different key, or the derived key already belongs to a different subject. Deterministic
 * derivation makes both unreachable through this module alone, but a hand-placed row (an
 * operator, a migration) can produce one — and the answer is a loud refusal, never a silent
 * second mapping or a borrowed account.
 */
export class PayerAccountConflictError extends Error {
  readonly code = "payer_account_conflict";
  constructor(message: string) {
    super(message);
    this.name = "PayerAccountConflictError";
  }
}

/** A `pa-` account id: 8 random bytes as hex, the draw size the grant and order ids use. */
function generateAccountId(): string {
  return `pa-${randomBytes(8).toString("hex")}`;
}

function assertRef(ref: PayerRef): void {
  // Strict, not normalising: the derivation embeds the id verbatim, so a padded id must be a
  // caller bug answered here — trimming it silently would let " usr_1" and "usr_1" name two
  // different account keys for what is secretly the same subject (review L2).
  if (
    typeof ref.id !== "string" ||
    ref.id.length === 0 ||
    ref.id.trim() !== ref.id
  ) {
    throw new TypeError(
      "payerKey needs a non-empty payer id with no leading or trailing whitespace: the id is embedded in the account key verbatim.",
    );
  }
}

/**
 * Resolve a payer ref to the external customer id the credit stack keys on — pure, no database,
 * deterministic per ref. CreditWriter keeps its string-keyed interface exactly as it is; callers
 * resolve the payer here and hand the writer the same key every time, so a request, its hold and
 * its settlement cannot drift onto different accounts between calls.
 *
 * The kind rides in the key's prefix, so subject ids never collide or replay across kinds even
 * when the ids themselves are equal ("IDs must not collide or replay between payer types"). The
 * legacy branch reuses `deploymentExternalCustomerId` itself — the one existing spelling of the
 * deployment key — so this group converges the fallback path instead of growing a second one.
 *
 * `unknown_owner` is refused: a quarantined owner is auditable as a record and can never be
 * resolved into a key a new charge could land on.
 */
export function payerKey(ref: PayerRef): string {
  assertRef(ref);
  switch (ref.kind) {
    case "personal":
      return `openbot-personal-${ref.id}`;
    case "company":
      return `openbot-company-${ref.id}`;
    case "legacy_deployment":
      return deploymentExternalCustomerId(ref.id);
    case "unknown_owner":
      throw new TypeError(
        "payerKey: unknown_owner records are quarantined for audit and can never be resolved into a billable account key.",
      );
    default:
      throw new TypeError(
        `payerKey: unknown payer kind ${String((ref as { kind?: unknown }).kind)}.`,
      );
  }
}

function accountOf(row: typeof payerAccounts.$inferSelect): PayerAccount {
  return {
    id: row.id,
    kind: row.kind,
    payerId: row.payerId,
    externalCustomerId: row.externalCustomerId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Create the payer account for a subject, idempotently and race-safely: the customer floor row
 * first (the account's foreign key must not be the thing that discovers it — the same floor
 * grantCredits lays), then one insert-or-nothing against the subject's unique index, then a
 * committed-state re-read. Concurrent callers on separate connections race into the database's
 * two unique indexes, which leave exactly one valid mapping; every caller then answers that one
 * row, the loser's `inserted: false` marking a replay rather than an error.
 *
 * Creates the account and nothing else: no grant, no ledger row, no balance — an account is born
 * empty, and existing records on the mapped key stay exactly where and what they were.
 */
export async function createPayerAccount(
  database: Database,
  ref: PayerRef,
): Promise<{ inserted: boolean; account: PayerAccount }> {
  const key = payerKey(ref);

  // The customer floor, the same insert-if-absent the billing store and grantCredits use.
  await database
    .insert(billingCustomers)
    .values({ externalId: key, name: null })
    .onConflictDoNothing({ target: billingCustomers.externalId });

  const inserted = await database
    .insert(payerAccounts)
    .values({
      id: generateAccountId(),
      kind: ref.kind,
      payerId: ref.id,
      externalCustomerId: key,
    })
    // No conflict target: DO NOTHING absorbs a race on either unique index — the same subject
    // already mapped, or the key already owned — and the re-reads below sort out which it was.
    .onConflictDoNothing()
    .returning();

  if (inserted[0]) return { inserted: true, account: accountOf(inserted[0]) };

  const [existing] = await database
    .select()
    .from(payerAccounts)
    .where(
      and(eq(payerAccounts.kind, ref.kind), eq(payerAccounts.payerId, ref.id)),
    )
    .limit(1);
  if (existing) return { inserted: false, account: accountOf(existing) };

  // Not our subject, so the insert lost the key's other unique index: another subject owns the
  // derived key. Impossible through this module's derivation alone, reachable through a
  // hand-placed row — and answered loudly, never by borrowing the other subject's account.
  const [holder] = await database
    .select()
    .from(payerAccounts)
    .where(eq(payerAccounts.externalCustomerId, key))
    .limit(1);
  throw new PayerAccountConflictError(
    holder
      ? `createPayerAccount: the customer key ${key} already belongs to a ${holder.kind} payer account.`
      : `createPayerAccount: the account for this subject conflicted but no mapping was found for key ${key}.`,
  );
}

/** The account a subject holds, or null when none was ever created. */
export async function readPayerAccount(
  database: Database,
  ref: PayerRef,
): Promise<PayerAccount | null> {
  assertRef(ref);
  const [row] = await database
    .select()
    .from(payerAccounts)
    .where(
      and(eq(payerAccounts.kind, ref.kind), eq(payerAccounts.payerId, ref.id)),
    )
    .limit(1);
  return row ? accountOf(row) : null;
}

/**
 * The account that owns one external customer id, or null — the reverse lookup audits and
 * migrations use (which subject does this key bill?), never a way to derive a new charge: the
 * answer for an `unknown_owner` row is that row, and `payerKey` still refuses its kind.
 */
export async function readPayerAccountForKey(
  database: Database,
  externalCustomerId: string,
): Promise<PayerAccount | null> {
  const [row] = await database
    .select()
    .from(payerAccounts)
    .where(eq(payerAccounts.externalCustomerId, externalCustomerId))
    .limit(1);
  return row ? accountOf(row) : null;
}
