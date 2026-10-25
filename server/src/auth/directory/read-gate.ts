/*
 * DirectoryReadGate — the live authorization every native Admin/Organization
 * read passes before the fixed build answers it (T02.11 / #533, original task
 * P04; interfaces §3.2/§3.3, design §4.2/§9.1).
 *
 * The contract is frozen (`require(tx, actor, tenantId, nativeOperation)`):
 * `nativeOperation` is issued by the ingress's closed endpoint list, never by
 * a client, and the whole check runs in ONE transaction so the lifecycle
 * facts it reads are the facts the read is authorized against.
 *
 * What `require` proves, in order, and why each step is a database fact rather
 * than a client claim:
 *
 * 1. The operation is one of the closed R-class names. Anything else is a
 *    malformed call (400), never treated as "some other read".
 * 2. The authority state is read in this transaction. Native directory reads
 *    belong to the BA authority: under legacy (M0/M1) the BA directory is not
 *    the record — the legacy routes keep serving their own DTO — so the native
 *    read answers 404 here; under paused (M2/M3) the directory is being
 *    backfilled and the answer is 503 DIRECTORY_READ_MIGRATION_PAUSED; a
 *    missing/unknown/racing state keeps the authority module's own 503. There
 *    is no branch that falls back to "probably fine".
 * 3. The actor is a verified session actor and the session row it names still
 *    belongs to that user and has not expired. A session id that arrived from
 *    a client alone proves nothing.
 * 4. The global identity is usable: the user exists and its principal is
 *    active with a comparable identityGeneration. A missing generation is
 *    "cannot compare", which closes the read (interfaces §2/§2.1), never a
 *    default.
 * 5. The company is live: the tenant exists and is `active`, and the BA
 *    organization row exists. Suspended/provisioning companies answer 403;
 *    a company with no organization row answers 404.
 * 6. The member is live in BOTH records the design keeps: the BA member row
 *    (who is a member now) and the business projection `enterprise_memberships`
 *    (active status), plus the durable company clock (epoch/generation are
 *    safe integers and the relationship is not tombstoned). A suspended or
 *    removed member therefore fails the same read that used to succeed, and a
 *    removed-and-rejoined member cannot ride an old ability (the clock is the
 *    persistent fact; interfaces §2).
 * 7. The company's additional-proof policy is asked through the frozen
 *    CompanyAssurance port in this same transaction (T02.10). A company that
 *    demands proof with no usable proof answers 403 COMPANY_REAUTH_REQUIRED.
 * 8. The ORIGINAL action's permission still holds: the role is read live from
 *    the BA member row, not from a token or the active-session preference, and
 *    `organization.list-invitations` needs owner/admin exactly as the native
 *    endpoint's own contract does.
 *
 * The gate does not serve the read; it decides. The caller forwards the
 * native request only after `require` resolves, and the ingress re-checks team
 * ownership (list-team-members) in the same transaction with
 * `assertTeamBelongsToCompany`.
 */

import { sql } from "drizzle-orm";
import type { CompanyAssurance } from "../company-assurance";
import { type DirectoryAuthority, isAuthorityRefusal } from "./authority";
import type { DirectoryActor, DirectoryTx } from "./contracts";

/** The closed R-class operations of interfaces §3.2's Organization table. */
export const NATIVE_DIRECTORY_READ_OPERATIONS = Object.freeze([
  "organization.get-organization",
  "organization.get-full-organization",
  "organization.list-members",
  "organization.list-invitations",
  "organization.list-teams",
  "organization.list-team-members",
  "organization.get-active-member",
  "organization.get-active-member-role",
  "organization.has-permission",
] as const);

export type NativeDirectoryReadOperation =
  (typeof NATIVE_DIRECTORY_READ_OPERATIONS)[number];

/** The closed P-class platform read operations (§3.2's Admin table). */
export const NATIVE_PLATFORM_READ_OPERATIONS = Object.freeze([
  "admin.get-user",
  "admin.list-users",
  "admin.list-user-sessions",
  "admin.has-permission",
] as const);

export type NativePlatformReadOperation =
  (typeof NATIVE_PLATFORM_READ_OPERATIONS)[number];

/**
 * Stable refusal codes. Statuses are the §4 projection: 400 malformed input,
 * 401 no usable session, 403 authorization/lifecycle/proof, 404 an object this
 * authority does not serve or the caller cannot see, 503 infrastructure or
 * authority.
 */
export const DIRECTORY_READ_OPERATION_UNKNOWN =
  "DIRECTORY_READ_OPERATION_UNKNOWN";
export const DIRECTORY_READ_ACTOR_INVALID = "DIRECTORY_READ_ACTOR_INVALID";
export const DIRECTORY_READ_SESSION_INVALID = "DIRECTORY_READ_SESSION_INVALID";
export const DIRECTORY_READ_IDENTITY_MISSING =
  "DIRECTORY_READ_IDENTITY_MISSING";
export const DIRECTORY_READ_IDENTITY_SUSPENDED =
  "DIRECTORY_READ_IDENTITY_SUSPENDED";
export const DIRECTORY_READ_GENERATION_MISSING =
  "DIRECTORY_READ_GENERATION_MISSING";
export const DIRECTORY_READ_COMPANY_MISSING = "DIRECTORY_READ_COMPANY_MISSING";
export const DIRECTORY_READ_COMPANY_SUSPENDED =
  "DIRECTORY_READ_COMPANY_SUSPENDED";
export const DIRECTORY_READ_MEMBER_MISSING = "DIRECTORY_READ_MEMBER_MISSING";
export const DIRECTORY_READ_MEMBER_SUSPENDED =
  "DIRECTORY_READ_MEMBER_SUSPENDED";
export const DIRECTORY_READ_CLOCK_MISSING = "DIRECTORY_READ_CLOCK_MISSING";
export const DIRECTORY_READ_CLOCK_TOMBSTONED =
  "DIRECTORY_READ_CLOCK_TOMBSTONED";
export const DIRECTORY_READ_ROLE_FORBIDDEN = "DIRECTORY_READ_ROLE_FORBIDDEN";
export const DIRECTORY_READ_MIGRATION_PAUSED =
  "DIRECTORY_READ_MIGRATION_PAUSED";
export const DIRECTORY_READ_AUTHORITY_CLOSED =
  "DIRECTORY_READ_AUTHORITY_CLOSED";
export const DIRECTORY_READ_TEAM_OUT_OF_COMPANY =
  "DIRECTORY_READ_TEAM_OUT_OF_COMPANY";
export const PLATFORM_READ_OPERATION_UNKNOWN =
  "PLATFORM_READ_OPERATION_UNKNOWN";
export const PLATFORM_READ_ACTOR_INVALID = "PLATFORM_READ_ACTOR_INVALID";
export const PLATFORM_READ_ADMIN_REQUIRED = "PLATFORM_READ_ADMIN_REQUIRED";

export class DirectoryReadRefusal extends Error {
  constructor(
    readonly code: string,
    detail: string,
    readonly status: 400 | 401 | 403 | 404 | 503,
  ) {
    super(`${code}: ${detail}`);
    this.name = "DirectoryReadRefusal";
  }
}

export function isDirectoryReadRefusal(
  error: unknown,
): error is DirectoryReadRefusal {
  return error instanceof DirectoryReadRefusal;
}

/** The frozen read-gate contract of interfaces §3.3. */
export interface DirectoryReadGate {
  require(
    tx: DirectoryTx,
    actor: DirectoryActor,
    tenantId: string,
    nativeOperation: string,
  ): Promise<void>;
}

/** The platform-read half: Admin GETs/POSTs, no tenant. */
export interface PlatformReadGate {
  require(
    tx: DirectoryTx,
    actor: DirectoryActor,
    nativeOperation: string,
  ): Promise<void>;
}

export interface DirectoryReadGateDeps {
  readonly authority: Pick<DirectoryAuthority, "read">;
  /**
   * The company proof port (T02.10). Required: an optional proof dependency is
   * exactly the bypass interfaces §5 forbids, so a consumer that forgets it
   * fails at construction.
   */
  readonly assurance: CompanyAssurance;
}

/** The permissions the native Organization reads need, by operation. */
const NATIVE_READ_MINIMUM_ROLE: Readonly<
  Record<NativeDirectoryReadOperation, "member" | "administrator">
> = Object.freeze({
  "organization.get-organization": "member",
  "organization.get-full-organization": "member",
  "organization.list-members": "member",
  "organization.list-invitations": "administrator",
  "organization.list-teams": "member",
  "organization.list-team-members": "member",
  "organization.get-active-member": "member",
  "organization.get-active-member-role": "member",
  "organization.has-permission": "member",
});

const ADMINISTRATOR_ROLES = new Set(["owner", "admin"]);

function rowsOf(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
}

/**
 * A `Version` a reader may compare: a non-negative safe integer. A missing or
 * unusable value is not defaulted — the read closes.
 */
function isSafeVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requireReadOperation(
  nativeOperation: string,
): NativeDirectoryReadOperation {
  const operation = NATIVE_DIRECTORY_READ_OPERATIONS.find(
    (candidate) => candidate === nativeOperation,
  );
  if (!operation) {
    throw new DirectoryReadRefusal(
      DIRECTORY_READ_OPERATION_UNKNOWN,
      `"${nativeOperation}" is not one of the closed native directory read operations (${NATIVE_DIRECTORY_READ_OPERATIONS.join(", ")}); only the fixed ingress list issues these, never a client method name`,
      400,
    );
  }
  return operation;
}

/**
 * The gate factory. Both dependencies are required by type, so a call site
 * that omits the proof port cannot compile — and a runtime caller that passes
 * a half-built object is refused before it can answer an allow.
 */
export function createDirectoryReadGate(
  deps: DirectoryReadGateDeps,
): DirectoryReadGate {
  if (!deps?.authority || typeof deps.authority.read !== "function") {
    throw new DirectoryReadRefusal(
      DIRECTORY_READ_OPERATION_UNKNOWN,
      "createDirectoryReadGate needs the directory authority: without it the gate cannot tell a BA read from a legacy one",
      503,
    );
  }
  if (!deps.assurance || typeof deps.assurance.require !== "function") {
    throw new DirectoryReadRefusal(
      DIRECTORY_READ_OPERATION_UNKNOWN,
      "createDirectoryReadGate needs the company assurance port: an optional proof dependency is the bypass interfaces §5 forbids",
      503,
    );
  }
  const authority = deps.authority;
  const assurance = deps.assurance;

  async function requireLiveSession(
    tx: DirectoryTx,
    actor: DirectoryActor,
    code: string,
  ): Promise<void> {
    if (actor.kind !== "session" || !actor.userId || !actor.sessionId) {
      throw new DirectoryReadRefusal(
        DIRECTORY_READ_ACTOR_INVALID,
        `a ${actor.kind} actor cannot exercise a native directory read; the read gate answers only a server-verified session actor, which is issued from the signed session cookie, never from a client field`,
        401,
      );
    }
    const [session] = rowsOf(
      await tx.execute(
        sql`SELECT user_id, expires_at > now() AS live
              FROM sessions WHERE id = ${actor.sessionId} LIMIT 1`,
      ),
    );
    if (String(session?.user_id ?? "") !== actor.userId) {
      throw new DirectoryReadRefusal(
        code,
        `session ${actor.sessionId ?? "<none>"} does not belong to the actor's user or no longer exists; a session id alone is not an identity`,
        401,
      );
    }
    if (session?.live !== true) {
      throw new DirectoryReadRefusal(
        code,
        `session ${actor.sessionId} has expired; the read is refused rather than answered for a session the store no longer accepts`,
        401,
      );
    }
  }

  async function requireLiveIdentity(
    tx: DirectoryTx,
    userId: string,
  ): Promise<string> {
    const [user] = rowsOf(
      await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} LIMIT 1`),
    );
    if (!user) {
      throw new DirectoryReadRefusal(
        DIRECTORY_READ_IDENTITY_MISSING,
        `user ${userId} does not exist; a deleted identity cannot be read from the directory`,
        403,
      );
    }
    const [principal] = rowsOf(
      await tx.execute(
        sql`SELECT id, status, identity_generation::text AS generation
              FROM enterprise_principals WHERE user_id = ${userId} LIMIT 1`,
      ),
    );
    if (!principal) {
      throw new DirectoryReadRefusal(
        DIRECTORY_READ_IDENTITY_MISSING,
        `user ${userId} has no principal; a native directory read needs the stable principal the eligibility clocks are keyed by`,
        403,
      );
    }
    if (String(principal.status) !== "active") {
      throw new DirectoryReadRefusal(
        DIRECTORY_READ_IDENTITY_SUSPENDED,
        `the principal behind user ${userId} is ${String(principal.status)}; a disabled identity's directory reads are closed until it is restored (a restore never revives an older generation)`,
        403,
      );
    }
    if (!isSafeVersion(Number(principal.generation))) {
      throw new DirectoryReadRefusal(
        DIRECTORY_READ_GENERATION_MISSING,
        `the principal behind user ${userId} has no verified identityGeneration; a missing version is "cannot compare", never a default, so the read is closed`,
        403,
      );
    }
    return String(principal.id);
  }

  return Object.freeze({
    async require(
      tx: DirectoryTx,
      actor: DirectoryActor,
      tenantId: string,
      nativeOperation: string,
    ): Promise<void> {
      const operation = requireReadOperation(nativeOperation);

      // 2. Authority, read in THIS transaction (§3.3).
      let state: Awaited<ReturnType<DirectoryAuthority["read"]>>;
      try {
        state = await authority.read(tx);
      } catch (error) {
        if (isAuthorityRefusal(error)) throw error;
        throw error;
      }
      if (state.directoryAuthority === "legacy") {
        throw new DirectoryReadRefusal(
          DIRECTORY_READ_AUTHORITY_CLOSED,
          "the directory authority is legacy (M0/M1): the native BA directory is not the record in this phase — the legacy routes keep their own DTO — so this read is not served here",
          404,
        );
      }
      if (state.directoryAuthority === "paused") {
        throw new DirectoryReadRefusal(
          DIRECTORY_READ_MIGRATION_PAUSED,
          `the directory is paused at ${state.phase} for the backfill; native directory reads resume only when the authority reaches ba, and are refused rather than answered from a half-migrated directory`,
          503,
        );
      }

      if (typeof tenantId !== "string" || !tenantId) {
        throw new DirectoryReadRefusal(
          DIRECTORY_READ_COMPANY_MISSING,
          "the read names no company; a directory read is always scoped to one company",
          400,
        );
      }

      await requireLiveSession(tx, actor, DIRECTORY_READ_SESSION_INVALID);
      const principalId = await requireLiveIdentity(tx, actor.userId as string);

      // 5. Company lifecycle + BA organization presence.
      const [tenant] = rowsOf(
        await tx.execute(
          sql`SELECT status FROM enterprise_tenants WHERE id = ${tenantId} LIMIT 1`,
        ),
      );
      if (!tenant) {
        throw new DirectoryReadRefusal(
          DIRECTORY_READ_COMPANY_MISSING,
          `company ${tenantId} does not exist; the read answers not-found rather than inventing a directory`,
          404,
        );
      }
      if (String(tenant.status) !== "active") {
        throw new DirectoryReadRefusal(
          DIRECTORY_READ_COMPANY_SUSPENDED,
          `company ${tenantId} is ${String(tenant.status)}; every directory read of a suspended or provisioning company is refused, and a later restore does not resurrect abilities issued before it`,
          403,
        );
      }
      const [organization] = rowsOf(
        await tx.execute(
          sql`SELECT 1 AS present FROM auth_organizations WHERE id = ${tenantId} LIMIT 1`,
        ),
      );
      if (!organization) {
        throw new DirectoryReadRefusal(
          DIRECTORY_READ_COMPANY_MISSING,
          `company ${tenantId} has no BA organization row; the native directory has nothing to serve for it`,
          404,
        );
      }

      // 6. Member lifecycle: BA member, business projection, durable clock.
      const [member] = rowsOf(
        await tx.execute(
          sql`SELECT role FROM auth_members
               WHERE organization_id = ${tenantId} AND user_id = ${actor.userId}
               LIMIT 1`,
        ),
      );
      if (!member) {
        throw new DirectoryReadRefusal(
          DIRECTORY_READ_MEMBER_MISSING,
          `user ${actor.userId} is not a member of company ${tenantId}; the native directory never serves a non-member`,
          403,
        );
      }
      const [membership] = rowsOf(
        await tx.execute(
          sql`SELECT status, epoch::text AS epoch FROM enterprise_memberships
               WHERE tenant_id = ${tenantId} AND principal_id = ${principalId}
               LIMIT 1`,
        ),
      );
      if (!membership || String(membership.status) !== "active") {
        throw new DirectoryReadRefusal(
          DIRECTORY_READ_MEMBER_SUSPENDED,
          `the business membership of user ${actor.userId} in company ${tenantId} is ${String(membership?.status ?? "missing")}; a suspended or removed member's directory reads are closed`,
          403,
        );
      }
      const [clock] = rowsOf(
        await tx.execute(
          sql`SELECT epoch::text AS epoch, generation::text AS generation, tombstone
                FROM auth_eligibility_clocks
               WHERE tenant_id = ${tenantId} AND principal_id = ${principalId}
                 AND kind = 'company' AND scope_id = ${tenantId}
               LIMIT 1`,
        ),
      );
      if (!clock) {
        throw new DirectoryReadRefusal(
          DIRECTORY_READ_CLOCK_MISSING,
          `no company clock exists for principal ${principalId} in company ${tenantId}; a missing clock in the ba branch closes the operation instead of being treated as an active membership`,
          403,
        );
      }
      if (clock.tombstone === true) {
        throw new DirectoryReadRefusal(
          DIRECTORY_READ_CLOCK_TOMBSTONED,
          `the company clock for principal ${principalId} is tombstoned (removed); a re-join advances the same key's epoch and generation, so an old ability can never ride this row`,
          403,
        );
      }
      if (
        !isSafeVersion(Number(clock.epoch)) ||
        !isSafeVersion(Number(clock.generation))
      ) {
        throw new DirectoryReadRefusal(
          DIRECTORY_READ_CLOCK_MISSING,
          `the company clock for principal ${principalId} holds a version outside the Version domain; an incomparable clock closes the read`,
          403,
        );
      }

      // 7. Additional company proof, in this transaction.
      await assurance.require(tx, actor, tenantId);

      // 8. The original action's permission, read live.
      const role = String(member.role);
      if (
        NATIVE_READ_MINIMUM_ROLE[operation] === "administrator" &&
        !ADMINISTRATOR_ROLES.has(role)
      ) {
        throw new DirectoryReadRefusal(
          DIRECTORY_READ_ROLE_FORBIDDEN,
          `${operation} needs an owner or administrator role; the caller's live company role is "${role}"`,
          403,
        );
      }
    },
  });
}

/**
 * The platform-read gate: Admin reads are not company-scoped, so there is no
 * tenant, member, clock or assurance step. What remains is the platform fact
 * itself — a live session, an existing user, a usable global identity, and a
 * CURRENT administrator role read in this transaction. Nothing here answers a
 * company's directory.
 */
export function createPlatformReadGate(): PlatformReadGate {
  return Object.freeze({
    async require(
      tx: DirectoryTx,
      actor: DirectoryActor,
      nativeOperation: string,
    ): Promise<void> {
      const operation = NATIVE_PLATFORM_READ_OPERATIONS.find(
        (candidate) => candidate === nativeOperation,
      );
      if (!operation) {
        throw new DirectoryReadRefusal(
          PLATFORM_READ_OPERATION_UNKNOWN,
          `"${nativeOperation}" is not one of the closed platform read operations (${NATIVE_PLATFORM_READ_OPERATIONS.join(", ")})`,
          400,
        );
      }
      if (actor.kind !== "session" || !actor.userId || !actor.sessionId) {
        throw new DirectoryReadRefusal(
          PLATFORM_READ_ACTOR_INVALID,
          `a ${actor.kind} actor cannot exercise a platform read; only a server-verified session whose user currently holds the administrator role may`,
          401,
        );
      }
      const [session] = rowsOf(
        await tx.execute(
          sql`SELECT user_id, expires_at > now() AS live
                FROM sessions WHERE id = ${actor.sessionId} LIMIT 1`,
        ),
      );
      if (
        String(session?.user_id ?? "") !== actor.userId ||
        session?.live !== true
      ) {
        throw new DirectoryReadRefusal(
          PLATFORM_READ_ACTOR_INVALID,
          `session ${actor.sessionId} is not a live session of user ${actor.userId}`,
          401,
        );
      }
      const [principal] = rowsOf(
        await tx.execute(
          sql`SELECT status FROM enterprise_principals WHERE user_id = ${actor.userId} LIMIT 1`,
        ),
      );
      // A platform administrator need not have joined a company, so a missing
      // principal is not itself a refusal; a suspended one is.
      if (principal && String(principal.status) !== "active") {
        throw new DirectoryReadRefusal(
          DIRECTORY_READ_IDENTITY_SUSPENDED,
          `the principal behind user ${actor.userId} is ${String(principal.status)}; a disabled identity's reads are closed`,
          403,
        );
      }
      const [admin] = rowsOf(
        await tx.execute(
          sql`SELECT 1 AS ok FROM user_roles
               WHERE user_id = ${actor.userId} AND role = 'admin' LIMIT 1`,
        ),
      );
      if (!admin) {
        throw new DirectoryReadRefusal(
          PLATFORM_READ_ADMIN_REQUIRED,
          `user ${actor.userId} holds no current global administrator role; the platform read is re-verified in this transaction, so a demoted administrator cannot borrow an earlier decision`,
          403,
        );
      }
    },
  });
}

/**
 * §3.2's `list-team-members` fixes the team to the company it names. The
 * ownership proof is a database read in the gate's transaction: a team id
 * from another company (or a nonexistent one) is answered exactly like a
 * missing object, so the response cannot confirm which company a team belongs
 * to.
 */
export async function assertTeamBelongsToCompany(
  tx: DirectoryTx,
  tenantId: string,
  teamId: string,
): Promise<void> {
  if (typeof teamId !== "string" || !teamId) {
    throw new DirectoryReadRefusal(
      DIRECTORY_READ_TEAM_OUT_OF_COMPANY,
      "list-team-members names no team",
      400,
    );
  }
  const [team] = rowsOf(
    await tx.execute(
      sql`SELECT 1 AS present FROM auth_teams
           WHERE id = ${teamId} AND organization_id = ${tenantId} LIMIT 1`,
    ),
  );
  if (!team) {
    throw new DirectoryReadRefusal(
      DIRECTORY_READ_TEAM_OUT_OF_COMPANY,
      `team ${teamId} is not a team of company ${tenantId}`,
      404,
    );
  }
}
