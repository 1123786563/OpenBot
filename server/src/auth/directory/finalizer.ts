/*
 * DirectoryFinalizer — the in-transaction final half of one directory
 * command (T02.08 / #530, original task P04; interfaces §3, design §5.2
 * step 5, §5.2.1 "约束时序与命令终结").
 *
 * What this file owns, and nothing else. Given the executor's own open
 * transaction and the command id it began, `finalize`:
 *
 * 1. Reads the command's receipt and the relationship keys the T02.06 DML
 *    guard registered while the BA sync ran, and verifies the receipt is an
 *    open company command (the identity domain is §2.1's separate executor).
 *
 * 2. Writes the protected projections in the frozen order — company
 *    membership stubs/members FIRST (auth_project_company_membership, the
 *    function-only write onto enterprise_memberships), then the team
 *    projection — before advancing either clock. The company projection maps
 *    the FINAL BA member set: an existing auth_members row projects
 *    `active`; a removal (member.remove / member.leave) has no final row and
 *    projects the legacy single revoke vocabulary, `suspended`, keeping the
 *    previously projected role. The legacy role vocabulary
 *    (tenant_admin/member/auditor) is a DIFFERENT closed domain from the BA
 *    DirectoryRole (owner/admin/member/auditor): owner and admin both project
 *    to `tenant_admin` because the legacy model has exactly one management
 *    tier; the owner/admin distinction lives in the BA directory, where the
 *    last-owner rule is enforced.
 *
 * 3. Advances every clock through auth_advance_eligibility_clock to exactly
 *    the change key's after-versions, in stable order: team clocks first (the
 *    team projection of this phase IS its clock — no legacy workspace
 *    membership writer exists in the frozen function set), then the company
 *    clocks. The tombstone is set for the removal operations only
 *    (member.remove / member.leave on the company key; team.member.remove /
 *    member.remove / member.leave on the team key) — a suspension advances
 *    the generation without tombstoning the relationship.
 *
 * 4. Records the audit fact in the existing enterprise audit system
 *    (enterprise_audit_events, MT078), inside the same transaction, with the
 *    operator RLS pins the table's write policy demands — a failed audit
 *    write is a failed command, never a silently skipped one.
 *
 * 5. Stamps the receipt finalized and clears the transaction marker
 *    (auth_directory_finalize_command + the caller-side set_config the
 *    controlled function cannot undo). The deferred commit fence the
 *    executor is about to force with SET CONSTRAINTS … IMMEDIATE reads that
 *    final state.
 *
 * Boundaries this file deliberately does not claim:
 * - It never commits, never opens a second connection, never drains hooks and
 *   never runs the commit fence itself — the executor owns all four.
 * - The legacy workspace-membership projection (enterprise_workspace_
 *   memberships) has no controlled writer in the frozen 0214 function set, so
 *   this phase's team projection is the team clock; the writer belongs to the
 *   task that wires team projections (P09 forward).
 * - The audit INSERT runs on the command's own connection. The MT078 table
 *   grants INSERT only to ob_ent_operator; the auth-writer connection the
 *   production executor runs on therefore needs a controlled audit write
 *   (a grant or function added by the M4 wiring task) before the production
 *   switch. Until then a writer-role deployment fails loudly at this step —
 *   by design ("审计缺失绝不被折叠成成功") — and the island suite proves the
 *   in-transaction atomicity on the owner connection.
 */

import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  authCommandChangeKeys,
  authCommandReceipts,
  authMembers,
} from "../../db/schema/auth-directory";
import { enterpriseAuditEvents } from "../../db/schema/enterprise-audit";
import {
  enterpriseMemberships,
  enterprisePrincipals,
} from "../../db/schema/enterprise-tenancy";
import type {
  DirectoryFinalizer,
  DirectoryOperation,
  DirectoryResult,
  DirectoryRole,
  DirectoryTx,
  EligibilityKey,
  EligibilityVersion,
  IdentityCommand,
  IdentityFinalizer,
  IdentityOperation,
  IdentityResult,
  Version,
} from "./contracts";

export const DIRECTORY_FINALIZER_RECEIPT_MISSING =
  "DIRECTORY_FINALIZER_RECEIPT_MISSING";
export const DIRECTORY_FINALIZER_DOMAIN_MISMATCH =
  "DIRECTORY_FINALIZER_DOMAIN_MISMATCH";
export const DIRECTORY_FINALIZER_ALREADY_FINALIZED =
  "DIRECTORY_FINALIZER_ALREADY_FINALIZED";
export const DIRECTORY_FINALIZER_VERSION_UNSAFE =
  "DIRECTORY_FINALIZER_VERSION_UNSAFE";
export const DIRECTORY_FINALIZER_PRINCIPAL_UNREADABLE =
  "DIRECTORY_FINALIZER_PRINCIPAL_UNREADABLE";

/**
 * A finalizer refusal: the transaction is refused as a whole by the caller's
 * rollback. Everything here is a server-side inconsistency (a command the
 * executor did not begin, an already-stamped receipt, an unversionable
 * change key), never a client error.
 */
export class DirectoryFinalizerError extends Error {
  readonly status = 500;

  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "DirectoryFinalizerError";
  }
}

/** The legacy projection's closed role vocabulary (enterprise_memberships). */
const LEGACY_ROLE_BY_DIRECTORY_ROLE: Readonly<Record<DirectoryRole, string>> = {
  owner: "tenant_admin",
  admin: "tenant_admin",
  member: "member",
  auditor: "auditor",
};

/** Operations whose company projection is the legacy suspension vocabulary. */
const COMPANY_SUSPENDING: ReadonlySet<DirectoryOperation> = new Set([
  "member.suspend",
  "member.remove",
  "member.leave",
]);

/** Operations that tombstone a company clock. */
const COMPANY_TOMBSTONING: ReadonlySet<DirectoryOperation> = new Set([
  "member.remove",
  "member.leave",
]);

/** Operations that tombstone a team clock. */
const TEAM_TOMBSTONING: ReadonlySet<DirectoryOperation> = new Set([
  "team.member.remove",
  "member.remove",
  "member.leave",
]);

/** One registered change key, in the finalizer's own read shape. */
interface ChangeKeyRow {
  tenantId: string;
  principalId: string;
  kind: "company" | "team";
  scopeId: string;
  epochAfter: number;
  generationAfter: number;
}

interface ReceiptRow {
  commandId: string;
  domain: string;
  operation: string;
  tenantId: string;
  finalized: boolean;
  actorUserId: string | null;
  actorKind: string;
}

function requireVersion(value: unknown, field: string): Version {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DirectoryFinalizerError(
      DIRECTORY_FINALIZER_VERSION_UNSAFE,
      `${field} is not a non-negative safe integer (Version); refusing rather than wrapping or coercing`,
    );
  }
  return value;
}

/** The tombstone a command sets on one key: removals only, by operation. */
export function tombstoneFor(
  operation: string,
  kind: "company" | "team",
): boolean {
  if (kind === "company") {
    return COMPANY_TOMBSTONING.has(operation as DirectoryOperation);
  }
  return TEAM_TOMBSTONING.has(operation as DirectoryOperation);
}

/** The version pair one change key reports, with the command's tombstone. */
function versionOf(operation: string, key: ChangeKeyRow): EligibilityVersion {
  return {
    epoch: requireVersion(
      key.epochAfter,
      "auth_command_change_keys.epoch_after",
    ),
    generation: requireVersion(
      key.generationAfter,
      "auth_command_change_keys.generation_after",
    ),
    tombstone: tombstoneFor(operation, key.kind),
  };
}

function eligibilityKeyOf(key: ChangeKeyRow): EligibilityKey {
  return {
    tenantId: key.tenantId,
    principalId: key.principalId,
    kind: key.kind,
    scopeId: key.scopeId,
  };
}

/** Company keys before team keys, then the stable per-key order. */
function compareKeys(left: ChangeKeyRow, right: ChangeKeyRow): number {
  if (left.kind !== right.kind) return left.kind === "company" ? -1 : 1;
  if (left.scopeId !== right.scopeId)
    return left.scopeId < right.scopeId ? -1 : 1;
  if (left.principalId !== right.principalId)
    return left.principalId < right.principalId ? -1 : 1;
  return 0;
}

export interface DirectoryFinalizerOptions {
  /**
   * The audit event type this finalizer records (MT078's
   * enterprise_audit_events). Fixed by default so the durable audit trail has
   * one stable name; a caller may narrow it for an island, never disable it.
   */
  readonly auditEventType?: string;
}

/**
 * The finalizer. It holds no state and no connection: the transaction is the
 * executor's, and the rules live in the module functions below.
 */
export function createDirectoryFinalizer(
  options: DirectoryFinalizerOptions = {},
): DirectoryFinalizer {
  const auditEventType =
    options.auditEventType ?? "directory.command.finalized";

  async function readReceipt(
    tx: DirectoryTx,
    commandId: string,
  ): Promise<ReceiptRow> {
    const [row] = await tx
      .select({
        commandId: authCommandReceipts.commandId,
        domain: authCommandReceipts.domain,
        operation: authCommandReceipts.operation,
        tenantId: authCommandReceipts.tenantId,
        finalized: authCommandReceipts.finalized,
        actorUserId: authCommandReceipts.actorUserId,
        actorKind: authCommandReceipts.actorKind,
      })
      .from(authCommandReceipts)
      .where(eq(authCommandReceipts.commandId, commandId))
      .limit(1);
    if (!row) {
      throw new DirectoryFinalizerError(
        DIRECTORY_FINALIZER_RECEIPT_MISSING,
        `command ${commandId} has no receipt in this transaction; a finalizer only completes a command its executor began`,
      );
    }
    if (row.domain !== "company") {
      throw new DirectoryFinalizerError(
        DIRECTORY_FINALIZER_DOMAIN_MISMATCH,
        `command ${commandId} is a ${row.domain} command; the company finalizer completes only company commands (the identity envelope has its own §2.1 finalizer)`,
      );
    }
    if (row.finalized) {
      throw new DirectoryFinalizerError(
        DIRECTORY_FINALIZER_ALREADY_FINALIZED,
        `command ${commandId} is already finalized; a second finalize would advance nothing and hide a double-completion bug`,
      );
    }
    if (row.tenantId === null) {
      throw new DirectoryFinalizerError(
        DIRECTORY_FINALIZER_RECEIPT_MISSING,
        `company command ${commandId} has no tenant; the receipt CHECKs forbid that shape`,
      );
    }
    return { ...row, tenantId: row.tenantId };
  }

  async function readChangeKeys(
    tx: DirectoryTx,
    commandId: string,
  ): Promise<ChangeKeyRow[]> {
    const rows = await tx
      .select({
        tenantId: authCommandChangeKeys.tenantId,
        principalId: authCommandChangeKeys.principalId,
        kind: authCommandChangeKeys.kind,
        scopeId: authCommandChangeKeys.scopeId,
        epochAfter: authCommandChangeKeys.epochAfter,
        generationAfter: authCommandChangeKeys.generationAfter,
      })
      .from(authCommandChangeKeys)
      .where(eq(authCommandChangeKeys.commandId, commandId))
      .orderBy(
        asc(authCommandChangeKeys.kind),
        asc(authCommandChangeKeys.scopeId),
        asc(authCommandChangeKeys.principalId),
      );
    return rows
      .map((row) => ({
        ...row,
        kind: row.kind as "company" | "team",
      }))
      .sort(compareKeys);
  }

  /** The principal's user, or the refusal its absence earns. */
  async function userIdOf(
    tx: DirectoryTx,
    principalId: string,
  ): Promise<string> {
    const [row] = await tx
      .select({ userId: enterprisePrincipals.userId })
      .from(enterprisePrincipals)
      .where(eq(enterprisePrincipals.id, principalId))
      .limit(1);
    if (!row) {
      throw new DirectoryFinalizerError(
        DIRECTORY_FINALIZER_PRINCIPAL_UNREADABLE,
        `change key names principal ${principalId}, which does not exist; a projection without its stable subject is refused`,
      );
    }
    return row.userId;
  }

  /**
   * The company projection of one key: the FINAL BA member row decides
   * active + role; a removal has no final row and keeps the previously
   * projected role under the legacy suspension vocabulary.
   */
  async function projectCompanyMembership(
    tx: DirectoryTx,
    receipt: ReceiptRow,
    key: ChangeKeyRow,
  ): Promise<void> {
    const tenantId = receipt.tenantId;
    const userId = await userIdOf(tx, key.principalId);
    const [finalMember] = await tx
      .select({ role: authMembers.role })
      .from(authMembers)
      .where(
        and(
          eq(authMembers.organizationId, tenantId),
          eq(authMembers.userId, userId),
        ),
      )
      .limit(1);
    let role: string;
    if (finalMember) {
      role =
        LEGACY_ROLE_BY_DIRECTORY_ROLE[finalMember.role as DirectoryRole] ??
        "member";
    } else {
      const [existing] = await tx
        .select({ role: enterpriseMemberships.role })
        .from(enterpriseMemberships)
        .where(
          and(
            eq(enterpriseMemberships.tenantId, tenantId),
            eq(enterpriseMemberships.principalId, key.principalId),
          ),
        )
        .limit(1);
      role = existing?.role ?? "member";
    }
    const status = COMPANY_SUSPENDING.has(
      receipt.operation as DirectoryOperation,
    )
      ? "suspended"
      : "active";
    const epoch = requireVersion(
      key.epochAfter,
      "auth_command_change_keys.epoch_after",
    );
    await tx.execute(
      sql`SELECT public.auth_project_company_membership(${tenantId}, ${key.principalId}, ${role}, ${status}, ${epoch}, ${receipt.commandId})`,
    );
  }

  /** One clock advance, exactly to the change key's after-versions. */
  async function advanceClock(
    tx: DirectoryTx,
    receipt: ReceiptRow,
    key: ChangeKeyRow,
  ): Promise<void> {
    const epoch = requireVersion(
      key.epochAfter,
      "auth_command_change_keys.epoch_after",
    );
    const generation = requireVersion(
      key.generationAfter,
      "auth_command_change_keys.generation_after",
    );
    await tx.execute(
      sql`SELECT public.auth_advance_eligibility_clock(${receipt.tenantId}, ${key.principalId}, ${key.kind}, ${key.scopeId}, ${epoch}, ${generation}, ${tombstoneFor(receipt.operation, key.kind)}, ${receipt.commandId})`,
    );
  }

  /**
   * The durable audit fact (MT078's enterprise_audit_events), written in the
   * command's transaction with the operator RLS pins its insert policy
   * demands. The payload carries only server-shaped fields (ids, operation
   * name, versions) — never the command's user payload, which may hold a
   * client-supplied email or display name that the audit redaction rules
   * would otherwise have to scrub.
   */
  async function recordAudit(
    tx: DirectoryTx,
    receipt: ReceiptRow,
    keys: readonly ChangeKeyRow[],
  ): Promise<void> {
    const tenantId = receipt.tenantId;
    const eventId = randomUUID();
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
    );
    await tx.execute(
      sql`SELECT set_config('app.operation_id', ${eventId}, true)`,
    );
    await tx.insert(enterpriseAuditEvents).values({
      tenantId,
      id: eventId,
      domain: "business",
      eventType: auditEventType,
      actorId: receipt.actorUserId ?? receipt.commandId,
      targetId: null,
      payload: {
        commandId: receipt.commandId,
        operation: receipt.operation,
        actorKind: receipt.actorKind,
        changeKeys: keys.map((key) => ({
          principalId: key.principalId,
          kind: key.kind,
          scopeId: key.scopeId,
          epoch: key.epochAfter,
          generation: key.generationAfter,
          tombstone: tombstoneFor(receipt.operation, key.kind),
        })),
      } as never,
    });
  }

  return Object.freeze({
    async finalize(
      tx: DirectoryTx,
      commandId: string,
    ): Promise<DirectoryResult> {
      const receipt = await readReceipt(tx, commandId);
      const keys = await readChangeKeys(tx, commandId);
      const companyKeys = keys.filter((key) => key.kind === "company");
      const teamKeys = keys.filter((key) => key.kind === "team");

      // 1. Company membership stubs/members first — the protected projection.
      for (const key of companyKeys) {
        await projectCompanyMembership(tx, receipt, key);
      }
      // 2. The team projection (this phase's team clock).
      for (const key of teamKeys) {
        await advanceClock(tx, receipt, key);
      }
      // 3. The company clocks.
      for (const key of companyKeys) {
        await advanceClock(tx, receipt, key);
      }
      // 4. The audit fact, before the receipt is stamped closed.
      await recordAudit(tx, receipt, keys);
      // 5. The finalization stamp and the marker the caller must clear.
      await tx.execute(
        sql`SELECT public.auth_directory_finalize_command(${commandId})`,
      );
      await tx.execute(
        sql`SELECT set_config('auth.current_command', '', true)`,
      );

      const versions = keys.map((key) => ({
        key: eligibilityKeyOf(key),
        value: versionOf(receipt.operation, key),
      }));
      return {
        commandId,
        replayed: false,
        tenantId: receipt.tenantId,
        // The operation's own identity fields (workspace/resource/grant) are
        // reported by the executor from its handler outcome; the receipt's
        // forward columns have no controlled writer in the frozen 0214
        // function set (disclosed in the module header).
        workspaceId: null,
        versions,
        resourceId: null,
        grantId: null,
        grantGeneration: null,
      };
    },
  });
}

/*
 * --- T02.09 (#531, original task P04): the identity finalizer -----------
 *
 * The in-transaction final half of one GLOBAL identity command (interfaces
 * §2.1, design §5.2 step 5). Where the company finalizer above projects
 * memberships and eligibility clocks, this one performs the identity
 * security finalization the design names explicitly (§5.1: "Identity
 * finalizer 推进 identityGeneration、撤全部 session/proof、检查 hash/token/
 * 受影响事实"), inside the executor's single transaction:
 *
 * 1. Reads the command's receipt and refuses anything that is not an open
 *    identity-domain command (the company domain is the other finalizer's).
 *
 * 2. Performs the operation's protected writes, in the fixed order — the
 *    principal status/generation first, the role rows, then the session
 *    deletions (§9.1: deleting a session is how it dies; its proofs cascade
 *    with it):
 *    - disable: active→suspended advances the generation exactly once; an
 *      already-suspended target is a no-op that still enforces the no-live-
 *      session invariant, but never grows the generation;
 *    - restore: suspended→active, NEVER a generation change — restoring an
 *      identity does not revive abilities issued against the old one;
 *    - role.set: the user_roles pair is written here (the compatible-role
 *      migration the §3.1 hook table moved out of user.create.after); an
 *      effective change advances the generation and revokes every session,
 *      a no-op changes nothing;
 *    - session.revoke / sessions.revoke: delete the named/all sessions and
 *      never advance the long-lived generation;
 *    - password.reset: verifies the credential password hash, always
 *      advances the generation and revokes every session;
 *    - user.create: verifies the BA user row under the pre-allocated id and
 *      the principal at generation 1, and writes the default `user` role
 *      the fixed build's createUser cannot write (the deployment's user
 *      table has no role column — the compatible role lives in user_roles);
 *    - profile.update: writes only the profile fields of the user row.
 *
 *    The payload facts those rules need (the role value, the named session
 *    id, the profile fields, the password-deployment intent) are NOT durable
 *    on the receipt — only their hash commitment is — so the contract takes
 *    the executor's verified command beside the command id. The executor
 *    only ever calls finalize with the command whose receipt it began in
 *    this transaction; a mismatched pair is refused like any other
 *    inconsistency.
 *
 * 3. Verifies the final facts ("核对完整结果"): the principal state matches
 *    the operation, no active proof survives a fully revoking command, and
 *    the password hash exists where the operation demands one. A
 *    verification failure is a refused transaction, never a warning.
 *
 * 4. Stamps the receipt finalized and clears the transaction marker, so the
 *    deferred commit fence the executor is about to force accepts it.
 *
 * Audit note (a disclosed boundary, not a skipped duty): the platform-domain
 * audit fact of a global identity command is the finalized receipt row
 * itself — domain, operation, target user, actor, payload-hash commitment
 * and timestamp — because `enterprise_audit_events` is tenant-keyed and the
 * identity executor must never fabricate a tenant (interfaces §1: "不伪造
 * tenant"). No enterprise_audit_events row is written here.
 *
 * Production-role note: like the company half above, these writes run on
 * the command's own connection. The frozen 0214 function set has no
 * controlled writer for enterprise_principals.identity_generation,
 * sessions, user_roles or users; a restricted writer-role deployment needs
 * that grant (or a controlled function) from the M4 wiring task before the
 * production switch, and its absence is a loud failure, never a skip.
 */

export const IDENTITY_FINALIZER_RECEIPT_MISSING =
  "IDENTITY_FINALIZER_RECEIPT_MISSING";
export const IDENTITY_FINALIZER_DOMAIN_MISMATCH =
  "IDENTITY_FINALIZER_DOMAIN_MISMATCH";
export const IDENTITY_FINALIZER_ALREADY_FINALIZED =
  "IDENTITY_FINALIZER_ALREADY_FINALIZED";
export const IDENTITY_FINALIZER_PRINCIPAL_UNREADABLE =
  "IDENTITY_FINALIZER_PRINCIPAL_UNREADABLE";
export const IDENTITY_FINALIZER_VERSION_UNSAFE =
  "IDENTITY_FINALIZER_VERSION_UNSAFE";
export const IDENTITY_FINALIZER_TARGET_INCOMPLETE =
  "IDENTITY_FINALIZER_TARGET_INCOMPLETE";

/**
 * An identity-finalizer refusal: the whole transaction is refused by the
 * caller's rollback. Everything here is a server-side inconsistency or a
 * final-fact verification failure, never a client error.
 */
export class IdentityFinalizerError extends Error {
  readonly status = 500;

  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "IdentityFinalizerError";
  }
}

/** An open identity receipt: `targetUserId` is non-null by the CHECKs. */
interface OpenIdentityReceipt {
  commandId: string;
  domain: string;
  operation: string;
  targetUserId: string;
  finalized: boolean;
}

/** A locked principal row with its verified generation. */
interface PrincipalState {
  readonly principalId: string;
  readonly status: string;
  readonly generation: number;
}

async function readIdentityReceipt(
  tx: DirectoryTx,
  commandId: string,
): Promise<OpenIdentityReceipt> {
  const [row] = await tx
    .select({
      commandId: authCommandReceipts.commandId,
      domain: authCommandReceipts.domain,
      operation: authCommandReceipts.operation,
      targetUserId: authCommandReceipts.targetUserId,
      finalized: authCommandReceipts.finalized,
    })
    .from(authCommandReceipts)
    .where(eq(authCommandReceipts.commandId, commandId))
    .limit(1);
  if (!row) {
    throw new IdentityFinalizerError(
      IDENTITY_FINALIZER_RECEIPT_MISSING,
      `command ${commandId} has no receipt in this transaction; an identity finalizer only completes a command its executor began`,
    );
  }
  if (row.domain !== "identity") {
    throw new IdentityFinalizerError(
      IDENTITY_FINALIZER_DOMAIN_MISMATCH,
      `command ${commandId} is a ${row.domain} command; the identity finalizer completes only identity commands (the company envelope has its own finalizer above)`,
    );
  }
  if (row.finalized) {
    throw new IdentityFinalizerError(
      IDENTITY_FINALIZER_ALREADY_FINALIZED,
      `command ${commandId} is already finalized; a second finalize would advance nothing and hide a double-completion bug`,
    );
  }
  if (row.targetUserId === null) {
    throw new IdentityFinalizerError(
      IDENTITY_FINALIZER_RECEIPT_MISSING,
      `identity command ${commandId} has no target user; the receipt CHECKs forbid that shape`,
    );
  }
  return { ...row, targetUserId: row.targetUserId };
}

/** The locked principal of the target user, with a safe verified generation. */
async function lockPrincipalState(
  tx: DirectoryTx,
  userId: string,
): Promise<PrincipalState> {
  const [row] = await tx
    .select({
      id: enterprisePrincipals.id,
      status: enterprisePrincipals.status,
      generation: enterprisePrincipals.identityGeneration,
    })
    .from(enterprisePrincipals)
    .where(eq(enterprisePrincipals.userId, userId))
    .limit(1)
    .for("update");
  if (!row) {
    throw new IdentityFinalizerError(
      IDENTITY_FINALIZER_PRINCIPAL_UNREADABLE,
      `user ${userId} has no principal; an identity command without its stable subject is refused`,
    );
  }
  if (
    row.generation === null ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 0
  ) {
    throw new IdentityFinalizerError(
      IDENTITY_FINALIZER_VERSION_UNSAFE,
      `the principal of user ${userId} has no verified identity generation; a history that cannot be versioned is never finalized`,
    );
  }
  return {
    principalId: row.id,
    status: row.status,
    generation: row.generation,
  };
}

/** The generation after one advance, refused at the safe-integer ceiling. */
function advancedGeneration(principal: PrincipalState, userId: string): number {
  if (!Number.isSafeInteger(principal.generation + 1)) {
    throw new IdentityFinalizerError(
      IDENTITY_FINALIZER_VERSION_UNSAFE,
      `the principal of user ${userId} is at the Version ceiling; the generation is never wrapped to keep a command committable`,
    );
  }
  return principal.generation + 1;
}

/** One primitive statement result, as the raw executor shapes it. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
}

/** Delete every session of the user; §9.1 cascades the proofs away. */
async function deleteAllSessions(
  tx: DirectoryTx,
  userId: string,
): Promise<void> {
  await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${userId}`);
}

/**
 * Verify zero active proofs remain for the user. The proof rows cascade with
 * their sessions, so a survivor is a structural anomaly (or a proof bound to
 * a foreign session) — exactly the corruption the finalizer must refuse.
 */
async function verifyNoActiveProofs(
  tx: DirectoryTx,
  userId: string,
): Promise<void> {
  const rows = rowsOf(
    await tx.execute(
      sql`SELECT count(*)::int AS count FROM auth_company_session_assurances WHERE user_id = ${userId} AND status = 'active'`,
    ),
  );
  if (Number(rows[0]?.count ?? 0) !== 0) {
    throw new IdentityFinalizerError(
      IDENTITY_FINALIZER_TARGET_INCOMPLETE,
      `user ${userId} still holds active company session proofs after a revoking identity command; the final set is incomplete and the transaction is refused`,
    );
  }
}

/** The credential account's password hash must exist for a password reset. */
async function requirePasswordHash(
  tx: DirectoryTx,
  userId: string,
): Promise<void> {
  const rows = rowsOf(
    await tx.execute(
      sql`SELECT 1 AS ok FROM accounts WHERE user_id = ${userId} AND provider_id = 'credential' AND password IS NOT NULL LIMIT 1`,
    ),
  );
  if (rows.length === 0) {
    throw new IdentityFinalizerError(
      IDENTITY_FINALIZER_TARGET_INCOMPLETE,
      `user ${userId} has no credential password after a password command; the controlled BA write either did not run in this transaction or did not land, and the transaction is refused`,
    );
  }
}

/** Read the user's current global roles (the legacy user_roles domain). */
async function currentRoles(
  tx: DirectoryTx,
  userId: string,
): Promise<string[]> {
  const rows = rowsOf(
    await tx.execute(
      sql`SELECT role::text AS role FROM user_roles WHERE user_id = ${userId}`,
    ),
  );
  return rows.map((row) => String(row.role));
}

/**
 * role.set's finalization: write exactly the desired role pair, and only an
 * effective change grows the generation and revokes every session.
 */
async function finalizeRoleSet(
  tx: DirectoryTx,
  userId: string,
  payload: Readonly<Record<string, unknown>>,
  principal: PrincipalState,
): Promise<PrincipalState> {
  const desired = String(payload.role);
  const roles = await currentRoles(tx, userId);
  // The effective test is the actual role set, not "the desired role already
  // appears somewhere": `(user_id, role)` allows several rows and the guard
  // reads any admin row as admin, so {admin, user} → {user} is a real
  // privilege drop even though `user` was already present. Anything but
  // exactly {desired} is a change.
  const effective = roles.length !== 1 || roles[0] !== desired;
  await tx.execute(
    sql`DELETE FROM user_roles WHERE user_id = ${userId} AND role::text <> ${desired}`,
  );
  await tx.execute(
    sql`INSERT INTO user_roles (user_id, role) VALUES (${userId}, ${desired}::role) ON CONFLICT DO NOTHING`,
  );
  if (!effective) return principal;
  const generation = advancedGeneration(principal, userId);
  await tx.execute(
    sql`UPDATE enterprise_principals SET identity_generation = ${generation} WHERE id = ${principal.principalId}`,
  );
  await deleteAllSessions(tx, userId);
  await verifyNoActiveProofs(tx, userId);
  return lockPrincipalState(tx, userId);
}

/**
 * session.revoke's finalization: delete exactly the named session (its
 * proofs cascade), leave every other session alone, never touch the
 * generation. The authorize half already verified the session belongs to
 * the target; a vanished row is the no-op of an already-dead session.
 */
async function finalizeSessionRevoke(
  tx: DirectoryTx,
  userId: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  const sessionId = String(payload.sessionId);
  await tx.execute(
    sql`DELETE FROM sessions WHERE id = ${sessionId} AND user_id = ${userId}`,
  );
}

/**
 * user.create's finalization: the BA user row under the pre-allocated id,
 * the principal at generation 1, the compatible default role — and nothing
 * else (no company eligibility, no credential account unless the command
 * deployed a password).
 */
async function finalizeUserCreate(
  tx: DirectoryTx,
  userId: string,
  payload: Readonly<Record<string, unknown>>,
  deployedPassword: boolean,
): Promise<void> {
  const rows = rowsOf(
    await tx.execute(sql`SELECT email FROM users WHERE id = ${userId} LIMIT 1`),
  );
  if (rows.length === 0) {
    throw new IdentityFinalizerError(
      IDENTITY_FINALIZER_TARGET_INCOMPLETE,
      `no BA user row exists under the pre-allocated id ${userId}; the fixed build's createUser did not run in this transaction, and the principal below it is refused`,
    );
  }
  const email = String(rows[0]?.email ?? "");
  if (email !== String(payload.email).toLowerCase()) {
    throw new IdentityFinalizerError(
      IDENTITY_FINALIZER_TARGET_INCOMPLETE,
      `the BA user row under ${userId} carries a different address than the command asked for; the pre-allocated id was never bound to this command's email`,
    );
  }
  const accounts = rowsOf(
    await tx.execute(
      sql`SELECT 1 AS ok FROM accounts WHERE user_id = ${userId} AND provider_id = 'credential' AND password IS NOT NULL`,
    ),
  );
  if (deployedPassword && accounts.length === 0) {
    throw new IdentityFinalizerError(
      IDENTITY_FINALIZER_TARGET_INCOMPLETE,
      `the password deployment of user ${userId} left no credential hash; the transaction is refused rather than committing a half-deployed credential`,
    );
  }
  // The §3.1 compatible-role ruling: the default role is written here, in
  // the same transaction — never by a user.create.after hook.
  await tx.execute(
    sql`INSERT INTO user_roles (user_id, role) VALUES (${userId}, 'user'::role) ON CONFLICT DO NOTHING`,
  );
}

/**
 * profile.update's finalization: only the profile fields of the user row —
 * email, role and status are structurally out of reach for this operation.
 */
async function finalizeProfileUpdate(
  tx: DirectoryTx,
  userId: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  // Only the provided fields are written: a partial update is a legal input
  // (§2.1: name?/image?, at least one), and writing NULL for the omitted one
  // would erase existing profile data.
  const nameProvided = typeof payload.name === "string";
  const imageProvided = typeof payload.image === "string";
  if (!nameProvided && !imageProvided) {
    throw new IdentityFinalizerError(
      IDENTITY_FINALIZER_TARGET_INCOMPLETE,
      `profile.update reached the finalizer with neither name nor image; the transaction is refused`,
    );
  }
  const [before] = rowsOf(
    await tx.execute(
      sql`SELECT name, image FROM users WHERE id = ${userId} LIMIT 1`,
    ),
  );
  if (!before) {
    throw new IdentityFinalizerError(
      IDENTITY_FINALIZER_TARGET_INCOMPLETE,
      `user ${userId} has no row to update; the transaction is refused`,
    );
  }
  const assignments = [];
  if (nameProvided) assignments.push(sql`name = ${String(payload.name)}`);
  if (imageProvided) assignments.push(sql`image = ${String(payload.image)}`);
  await tx.execute(
    sql`UPDATE users SET ${sql.join(assignments, sql`, `)}, updated_at = now() WHERE id = ${userId}`,
  );
  const [after] = rowsOf(
    await tx.execute(
      sql`SELECT name, image FROM users WHERE id = ${userId} LIMIT 1`,
    ),
  );
  const expectedName = nameProvided ? String(payload.name) : before.name;
  const expectedImage = imageProvided ? String(payload.image) : before.image;
  if (!after || after.name !== expectedName || after.image !== expectedImage) {
    throw new IdentityFinalizerError(
      IDENTITY_FINALIZER_TARGET_INCOMPLETE,
      `the profile of user ${userId} did not take exactly the commanded fields; the transaction is refused`,
    );
  }
}

/**
 * The identity finalizer. It holds no state and no connection: the
 * transaction is the executor's, and the per-operation rules live in the
 * functions above.
 */
export function createIdentityFinalizer(): IdentityFinalizer {
  return Object.freeze({
    async finalize(
      tx: DirectoryTx,
      commandId: string,
      command: IdentityCommand,
    ): Promise<IdentityResult> {
      const receipt = await readIdentityReceipt(tx, commandId);
      if (
        receipt.operation !== command.operation ||
        receipt.targetUserId !== command.targetUserId
      ) {
        throw new IdentityFinalizerError(
          IDENTITY_FINALIZER_RECEIPT_MISSING,
          `command ${commandId} began as ${receipt.operation} on ${receipt.targetUserId}, but the finalizer was handed ${command.operation} on ${command.targetUserId}; the pair is refused rather than finalized against the wrong target or payload`,
        );
      }
      const userId = receipt.targetUserId;
      let principal = await lockPrincipalState(tx, userId);
      const operation = receipt.operation as IdentityOperation;

      if (operation === "identity.disable") {
        if (principal.status === "active") {
          const generation = advancedGeneration(principal, userId);
          await tx.execute(
            sql`UPDATE enterprise_principals SET status = 'suspended', identity_generation = ${generation} WHERE id = ${principal.principalId}`,
          );
        }
        // The invariant holds even for a no-op disable: a suspended identity
        // has no live session, whatever slipped in after the first one. The
        // generation itself only moved on the effective change above.
        await deleteAllSessions(tx, userId);
        await verifyNoActiveProofs(tx, userId);
        principal = await lockPrincipalState(tx, userId);
      } else if (operation === "identity.restore") {
        if (principal.status === "suspended") {
          // §2.1's disable/restore row applies one rule to both: an EFFECTIVE
          // status change advances identityGeneration and revokes every
          // session/proof. Advancing (never resetting) is also what keeps the
          // old abilities dead — a restore hands out no authority the disable
          // took away.
          const generation = advancedGeneration(principal, userId);
          await tx.execute(
            sql`UPDATE enterprise_principals SET status = 'active', identity_generation = ${generation} WHERE id = ${principal.principalId}`,
          );
          await deleteAllSessions(tx, userId);
          await verifyNoActiveProofs(tx, userId);
          principal = await lockPrincipalState(tx, userId);
        }
      } else if (operation === "identity.role.set") {
        principal = await finalizeRoleSet(
          tx,
          userId,
          command.payload,
          principal,
        );
      } else if (operation === "identity.session.revoke") {
        await finalizeSessionRevoke(tx, userId, command.payload);
      } else if (operation === "identity.sessions.revoke") {
        await deleteAllSessions(tx, userId);
        await verifyNoActiveProofs(tx, userId);
      } else if (operation === "identity.password.reset") {
        await requirePasswordHash(tx, userId);
        const generation = advancedGeneration(principal, userId);
        await tx.execute(
          sql`UPDATE enterprise_principals SET identity_generation = ${generation} WHERE id = ${principal.principalId}`,
        );
        await deleteAllSessions(tx, userId);
        await verifyNoActiveProofs(tx, userId);
        principal = await lockPrincipalState(tx, userId);
      } else if (operation === "identity.user.create") {
        await finalizeUserCreate(
          tx,
          userId,
          command.payload,
          command.secrets?.newPassword !== undefined,
        );
        // A genuinely new user's principal is born at generation 1 (the only
        // writer of 1, the registry); anything else is damaged history the
        // create must not bless.
        if (principal.generation !== 1) {
          throw new IdentityFinalizerError(
            IDENTITY_FINALIZER_TARGET_INCOMPLETE,
            `the principal of the freshly created user ${userId} reports generation ${principal.generation}, not 1; a create never adopts a historical identity`,
          );
        }
      } else if (operation === "identity.profile.update") {
        await finalizeProfileUpdate(tx, userId, command.payload);
      }

      await tx.execute(
        sql`SELECT public.auth_directory_finalize_command(${commandId})`,
      );
      await tx.execute(
        sql`SELECT set_config('auth.current_command', '', true)`,
      );
      return {
        commandId,
        replayed: false,
        userId,
        principalId: principal.principalId,
        identityGeneration: principal.generation,
      };
    },
  });
}
