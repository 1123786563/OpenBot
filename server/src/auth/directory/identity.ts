/*
 * IdentityExecutor — the global identity command kernel and its recovery
 * transaction boundary (T02.09 / #531, original task P04; interfaces §2.1,
 * §5.1, design §5.2 step 5).
 *
 * One `execute(actor, command)` call owns one outer transaction and runs the
 * identity half of the frozen order:
 *
 *   可信 actor → user/principal 稳定锁（不持 principal 等 tenant）→ 锁内
 *   分域授权 → identity 域 receipt（payload hash 含秘密 HMAC 承诺）→
 *   TransactionBoundBa 内 BA 调用 → 邮件回调围栏 → 身份 finalizer（代际/
 *   session/proof/受影响事实同事务核验）→ 具名 SET CONSTRAINTS … IMMEDIATE
 *   → commit → drain 已分类 hook
 *
 * What each step exists for:
 *
 * 1. Envelope validation. The actor is one of the closed identity kinds —
 *    session/platform/migration/recovery — with a null binding and null
 *    provisioning (§2.1: the identity domain has no company half). The
 *    operation must be in the closed IdentityOperation vocabulary and its
 *    payload must pass the strict Zod schema of §2.1's table; unknown
 *    fields are refused. A `recovery` kind that arrives without the
 *    transaction-bound HMAC commitment is a client fabrication and is
 *    refused 403 by the in-lock commitment validation (the user locks are
 *    taken first; the refusal still writes nothing).
 *
 * 2. Locks. No tenant lock exists here: identity commands never wait on a
 *    tenant after holding a principal (interfaces §3's order). The per-user
 *    advisory lock the PrincipalRegistry takes (`identityUserLock`) is
 *    taken for the actor's and the target's user ids in stable sorted
 *    order, so two identity commands over the same pair of users cannot
 *    interleave. `identity.user.create` locks the same way but through the
 *    bare lock — its target row does not exist yet — and hands the
 *    principal creation to the registry after the BA user row lands.
 *
 * 3. Authorization (in-lock, re-run on replay). The domain-split of §2.1:
 *    disable/restore/role.set/sessions.revoke/user.create/profile.update
 *    demand a platform (or offline migration) actor with a CURRENT global
 *    admin role, read in this transaction under the actor's own user lock;
 *    session.revoke is the current user or a global admin, and the session
 *    must belong to the target; password.reset is a global admin or the
 *    recovery actor issued inside THIS transaction. A replay re-runs all of
 *    it: a demoted admin never borrows a receipt.
 *
 * 4. Idempotency (the 2026-10-25 §5.6 ruling). The uniqueness domain is
 *    the identity domain target + idempotency key — target user + key. The
 *    actor and the operation are NOT in the domain, but the payload hash
 *    covers `{operation, targetUserId, payload, secretsCommitment}`, where
 *    the commitment is an HMAC under the server key — never a plaintext or
 *    a bare digest an offline attacker could grind. Same key + same hash
 *    replays; same key + any difference conflicts with 409.
 *
 * 5. BA calls and hooks. The kernel itself never imports Better Auth: the
 *    three fixed-build calls it needs — createUser (which honors the
 *    pre-allocated id through `forceAllowId`), the controlled password
 *    write of the admin path, and the native reset POST that is the ONLY
 *    consumeVerificationValue caller — arrive as the injected `ba` seam and
 *    run inside TransactionBoundBa, sharing this transaction and its hook
 *    fence. The executor never calls auth.handler inside a transaction.
 *
 * 6. Recovery boundary (§5.1 step 2). `recovery.resetPasswordByToken` is
 *    the same-connection boundary the RecoveryIngress (P08/T04.04) reuses:
 *    locate the token's target, lock the user/principal, re-verify the
 *    token under lock (present, unexpired, bound to the target), issue the
 *    tx-bound recovery actor — an HMAC commitment over the transaction id,
 *    the target user and the token row, registered internally and carried
 *    on a symbol so it never survives serialization — run
 *    identity.password.reset with it, consume the token through the native
 *    POST, verify the consumption, and finalize. Nothing here skips
 *    authorization, accepts an arbitrary transaction, or issues an actor
 *    that survives its own transaction: the commitment's MAC is recomputed
 *    against the CURRENT transaction id at validation time.
 *
 * 7. Finalizer and commit. The T02.09 identity finalizer (finalizer.ts)
 *    performs the security finalization and stamps the receipt; the four
 *    named deferred fences are forced with SET CONSTRAINTS … IMMEDIATE and
 *    the commit follows. Post-commit, the classified hooks drain exactly
 *    once; their failures are reported through `onPostCommitHookError` and
 *    never rewrite the committed result.
 *
 * Authority note (a deliberate boundary): identity commands do NOT run the
 * §3.3 directory-write authority gate. interfaces §2.1 lists what the
 * identity envelope reuses — same-connection transaction, DML guard,
 * finalization flag, platform-domain audit, post-commit outbox — and the
 * migration authority owns the COMPANY directory writer, not the global
 * user/role/session facts that were Better Auth's before the migration and
 * must keep working in every phase (a password reset cannot pause with the
 * company directory). The production platform actor and every HTTP ingress
 * is P12/T08's wiring; this kernel only accepts server-issued actors.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client";
import { authCommandReceipts } from "../../db/schema/auth-directory";
import { identityUserLock } from "../../identity/store";
import type {
  DirectoryTx,
  Identity,
  IdentityActor,
  IdentityCommand,
  IdentityFinalizer,
  IdentityOperation,
  IdentityResult,
  PostCommitHook,
  PrincipalRegistry,
  TransactionBoundBa,
} from "./contracts";
import { DIRECTORY_COMMIT_CONSTRAINTS } from "./executor";
import type { AuthMailOutbox, MailCallbackFence } from "./outbox";
import {
  assertMailCallbackCompletion,
  createMailCallbackFence,
  settleMailCallbackFence,
} from "./outbox";

export const IDENTITY_COMMAND_INVALID = "IDENTITY_COMMAND_INVALID";
export const IDENTITY_OPERATION_UNKNOWN = "IDENTITY_OPERATION_UNKNOWN";
export const IDENTITY_ACTOR_INVALID = "IDENTITY_ACTOR_INVALID";
export const IDENTITY_ACTOR_FORBIDDEN = "IDENTITY_ACTOR_FORBIDDEN";
export const IDENTITY_ACTOR_PRINCIPAL_MISMATCH =
  "IDENTITY_ACTOR_PRINCIPAL_MISMATCH";
export const IDENTITY_SESSION_UNKNOWN = "IDENTITY_SESSION_UNKNOWN";
export const IDENTITY_SESSION_NOT_OWNED = "IDENTITY_SESSION_NOT_OWNED";
export const IDENTITY_TARGET_DISABLED = "IDENTITY_TARGET_DISABLED";
export const IDENTITY_RECOVERY_ACTOR_INVALID =
  "IDENTITY_RECOVERY_ACTOR_INVALID";
export const IDENTITY_RECOVERY_TOKEN_UNKNOWN =
  "IDENTITY_RECOVERY_TOKEN_UNKNOWN";
export const IDENTITY_RECOVERY_TOKEN_INVALID =
  "IDENTITY_RECOVERY_TOKEN_INVALID";
export const IDENTITY_RECOVERY_TOKEN_NOT_CONSUMED =
  "IDENTITY_RECOVERY_TOKEN_NOT_CONSUMED";
export const IDENTITY_IDEMPOTENCY_CONFLICT = "IDENTITY_IDEMPOTENCY_CONFLICT";
export const IDENTITY_REPLAY_RECEIPT_INVALID =
  "IDENTITY_REPLAY_RECEIPT_INVALID";
export const IDENTITY_SECRETS_MISPLACED = "IDENTITY_SECRETS_MISPLACED";

/**
 * An identity command refusal. The status is the HTTP projection of
 * interfaces §4: a malformed envelope is 400, an authorization failure
 * (including a fabricated or cross-transaction recovery actor) is 403, an
 * unknown reset token is 404, an idempotency conflict is 409, a target
 * whose state refuses the command non-idempotently is 409, and an
 * inconsistent receipt is 500.
 */
export class IdentityCommandRefusal extends Error {
  constructor(
    readonly code: string,
    detail: string,
    readonly status: 400 | 403 | 404 | 409 | 500,
  ) {
    super(`${code}: ${detail}`);
    this.name = "IdentityCommandRefusal";
  }
}

export function isIdentityCommandRefusal(
  error: unknown,
): error is IdentityCommandRefusal {
  return error instanceof IdentityCommandRefusal;
}

/*
 * The payload vocabulary of interfaces §2.1's table: one strict schema per
 * operation, `strict` so an unknown field is a refusal. The global role
 * domain is user/admin — a DirectoryRole value is refused here.
 */
const nonEmptyText = z.string().trim().min(1);
const globalRole = z.enum(["user", "admin"]);

export const IDENTITY_OPERATION_PAYLOADS: Readonly<
  Record<IdentityOperation, z.ZodType<unknown>>
> = Object.freeze({
  "identity.disable": z.strictObject({ reason: nonEmptyText }),
  "identity.restore": z.strictObject({ reason: nonEmptyText }),
  "identity.role.set": z.strictObject({
    role: globalRole,
    reason: nonEmptyText,
  }),
  "identity.session.revoke": z.strictObject({
    sessionId: nonEmptyText,
    reason: nonEmptyText,
  }),
  "identity.sessions.revoke": z.strictObject({ reason: nonEmptyText }),
  "identity.user.create": z.strictObject({
    email: nonEmptyText,
    name: nonEmptyText,
    image: nonEmptyText.optional(),
  }),
  "identity.profile.update": z
    .strictObject({
      name: nonEmptyText.optional(),
      image: nonEmptyText.optional(),
    })
    .refine(
      (value) => Object.values(value).some((field) => field !== undefined),
      "at least one of name/image is required; email/role/status/data belong to other flows",
    ),
  "identity.password.reset": z.strictObject({ reason: nonEmptyText }),
});

export const IDENTITY_OPERATIONS = Object.freeze(
  Object.keys(IDENTITY_OPERATION_PAYLOADS) as IdentityOperation[],
);

/** The operations a secrets envelope may ride on. */
const SECRET_OPERATIONS: ReadonlySet<string> = new Set([
  "identity.user.create",
  "identity.password.reset",
]);

/** The idempotency key rides an indexed text column; printable, bounded. */
const IDEMPOTENCY_KEY_MAX = 512;

const ACTOR_KINDS = ["session", "platform", "migration", "recovery"] as const;

function isPrintable(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new IdentityCommandRefusal(
      IDENTITY_COMMAND_INVALID,
      `${field} must be a non-empty string`,
      400,
    );
  }
  return value;
}

/**
 * The actor checks of interfaces §2.1: a closed identity kind, at least one
 * server-issued identity, a null binding and null provisioning, a session
 * actor always naming its session, and a recovery actor carrying no session.
 * This is the SHAPE half; the recovery commitment is validated in-lock
 * against the live transaction (a fabricated shape never gets that far).
 */
export function assertIdentityActor(actor: IdentityActor): void {
  const invalid = (detail: string): IdentityCommandRefusal =>
    new IdentityCommandRefusal(IDENTITY_ACTOR_INVALID, detail, 400);
  const kind = actor?.kind;
  if (!ACTOR_KINDS.includes(kind as (typeof ACTOR_KINDS)[number])) {
    throw invalid(`actor.kind "${String(kind)}" is not an identity actor kind`);
  }
  if (actor.bindingId !== null || actor.provisioning !== null) {
    throw invalid(
      "an identity actor carries no binding and no provisioning evidence; the identity domain has no company half",
    );
  }
  if (actor.userId === null) {
    throw invalid("an identity actor must name its userId");
  }
  requireText(actor.userId, "actor.userId");
  if (actor.principalId !== null) {
    requireText(actor.principalId, "actor.principalId");
  }
  if (kind === "session") {
    requireText(actor.sessionId, "actor.sessionId");
  } else if (actor.sessionId !== null) {
    throw invalid(
      `a ${kind} actor has no session; only a session actor names one`,
    );
  }
}

/** The command checks: closed vocabulary, strict payload, secrets placement. */
export function assertIdentityCommand(command: IdentityCommand): void {
  const operation = command?.operation as string;
  if (!IDENTITY_OPERATIONS.includes(operation as IdentityOperation)) {
    throw new IdentityCommandRefusal(
      IDENTITY_OPERATION_UNKNOWN,
      `operation "${String(operation)}" is not one of the frozen IdentityOperation vocabulary`,
      400,
    );
  }
  requireText(command.targetUserId, "targetUserId");
  const idempotencyKey = requireText(command.idempotencyKey, "idempotencyKey");
  if (
    idempotencyKey.length > IDEMPOTENCY_KEY_MAX ||
    !isPrintable(idempotencyKey)
  ) {
    throw new IdentityCommandRefusal(
      IDENTITY_COMMAND_INVALID,
      `idempotencyKey must be printable text of at most ${IDEMPOTENCY_KEY_MAX} characters; the receipt's uniqueness domain is what makes a replay safe, and a malformed key is refused before any lock`,
      400,
    );
  }
  if (
    command.payload === null ||
    typeof command.payload !== "object" ||
    Array.isArray(command.payload)
  ) {
    throw new IdentityCommandRefusal(
      IDENTITY_COMMAND_INVALID,
      "payload must be a plain object; the operation's Zod schema decides which fields it may carry",
      400,
    );
  }
  const parsed = IDENTITY_OPERATION_PAYLOADS[
    operation as IdentityOperation
  ].safeParse(command.payload);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new IdentityCommandRefusal(
      IDENTITY_COMMAND_INVALID,
      `payload does not match ${operation}'s schema (${issues}); unknown fields and wrong shapes are refused, never ignored`,
      400,
    );
  }
  const secrets = command.secrets;
  if (secrets !== undefined) {
    if (!SECRET_OPERATIONS.has(operation)) {
      throw new IdentityCommandRefusal(
        IDENTITY_SECRETS_MISPLACED,
        `operation ${operation} accepts no secrets; only user.create and password.reset carry a credential`,
        400,
      );
    }
    requireText(secrets.newPassword, "secrets.newPassword");
    if (secrets.resetToken !== undefined) {
      requireText(secrets.resetToken, "secrets.resetToken");
      if (operation !== "identity.password.reset") {
        throw new IdentityCommandRefusal(
          IDENTITY_SECRETS_MISPLACED,
          "secrets.resetToken belongs to the password.reset recovery path alone",
          400,
        );
      }
    }
  }
}

/** Deterministic JSON: sorted keys, no undefined members. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => field !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`)
    .join(",")}}`;
}

function hmacHex(key: Buffer, message: string): string {
  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}

/**
 * The secrets' HMAC commitment (interfaces §2.1: "幂等冲突比较使用服务器密钥
 * HMAC 承诺，禁止可离线猜密码的明文/普通摘要"). The commitment rides the
 * payload hash so the same key under a different password is a conflict,
 * without the receipt ever carrying anything a database leak could grind.
 */
function secretsCommitment(
  command: IdentityCommand,
  key: Buffer,
): string | null {
  if (command.secrets === undefined) return null;
  return hmacHex(
    key,
    canonicalJson({
      newPassword: command.secrets.newPassword,
      resetToken: command.secrets.resetToken ?? null,
    }),
  );
}

/**
 * The receipt's payload hash: the operation, the identity target, the
 * payload and the secrets commitment. The actor is deliberately excluded
 * (the narrow idempotency ruling of 2026-10-25), while the operation IS
 * included so the same key under a different operation is a conflict.
 */
export function identityPayloadHash(
  command: IdentityCommand,
  commitmentKey: Buffer,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        operation: command.operation,
        targetUserId: command.targetUserId,
        payload: command.payload,
        secrets: secretsCommitment(command, commitmentKey),
      }),
    )
    .digest("hex");
}

/**
 * The fixed-build calls the kernel needs (§2.1/§5.1). All three run inside
 * the executor's TransactionBoundBa — same transaction, same hook fence —
 * and are the ONLY places Better Auth is reached from an identity command.
 * `consumeResetToken` is the native reset POST translation and therefore
 * the single consumeVerificationValue caller in the process.
 */
export interface IdentityBaAccess {
  /**
   * identity.user.create: the fixed build's createUser. It must honor the
   * pre-allocated `userId` (the fixed build's adapter passes `forceAllowId`
   * when the id rides the data map) and, when `password` is non-null, link
   * the credential account with the build's own hashing.
   */
  createUser(input: {
    userId: string;
    email: string;
    name: string;
    image: string | null;
    password: string | null;
  }): Promise<void>;
  /**
   * The admin path of identity.password.reset (§5.1's admin set-user-password
   * translation): the controlled BA password write — hash and credential
   * account upsert — in this transaction, demanding no recovery token.
   */
  writePassword(input: { userId: string; newPassword: string }): Promise<void>;
  /**
   * The recovery path's native reset POST: the ONLY consumer of the reset
   * token. Issuing a recovery actor never consumes; this call does.
   */
  consumeResetToken(input: {
    resetToken: string;
    newPassword: string;
  }): Promise<void>;
}

export interface IdentityExecutorOptions {
  readonly database: Pick<Database, "transaction">;
  readonly bound: TransactionBoundBa;
  readonly registry: PrincipalRegistry;
  readonly finalizer: IdentityFinalizer;
  readonly ba: IdentityBaAccess;
  /**
   * The server key behind every recovery-actor commitment and secrets hash.
   * Held in memory only; never a client input, never persisted.
   */
  readonly commitmentKey: Buffer;
  /** The mail service a command's controlled sender may be built from. */
  readonly outbox?: Pick<
    AuthMailOutbox,
    "createControlledMailSender" | "enqueueAuthMailIntent"
  > | null;
  /**
   * Where a post-commit hook's failure is reported. The command has already
   * committed by then, so the failure never rewrites the result.
   */
  readonly onPostCommitHookError?: (hookId: string, error: unknown) => void;
}

/**
 * The private recovery boundary (§5.1 step 2): the same-connection identity
 * transaction the RecoveryIngress reuses. It issues the tx-bound recovery
 * actor and runs exactly one operation — password.reset by token — never a
 * second surface.
 */
export interface IdentityRecoveryBoundary {
  resetPasswordByToken(input: {
    readonly resetToken: string;
    readonly newPassword: string;
    readonly idempotencyKey: string;
    /**
     * The §2.1 internal registration of the issuance: the ingress records
     * the actor fact in its own request-local audit. Receive-only — the
     * actor still cannot survive this transaction.
     */
    readonly onIssued?: (actor: IdentityActor) => void;
  }): Promise<IdentityResult>;
}

/** The executor's public surface: the Identity view plus the recovery seam. */
export interface IdentityExecutor extends Identity {
  readonly recovery: IdentityRecoveryBoundary;
}

/*
 * The recovery actor's transaction-bound commitment. It lives under a module
 * symbol so it never survives JSON serialization — an actor that crossed a
 * process boundary arrives without it and is a client fabrication. The MAC
 * binds the issuing transaction id, the target user and the reset-token row
 * id, so even a captured in-process actor is worthless in any other
 * transaction, and the validation recomputes it against the CURRENT
 * transaction id.
 */
const RECOVERY_COMMITMENT = Symbol("identity.recoveryCommitment");

interface RecoveryCommitment {
  readonly scheme: 1;
  readonly transactionId: string;
  readonly targetUserId: string;
  readonly tokenRowId: string;
  readonly mac: string;
}

function recoveryCommitmentOf(
  actor: IdentityActor,
): RecoveryCommitment | undefined {
  return (actor as Record<symbol, unknown>)[RECOVERY_COMMITMENT] as
    | RecoveryCommitment
    | undefined;
}

function commitmentMac(
  key: Buffer,
  value: Omit<RecoveryCommitment, "mac">,
): string {
  return hmacHex(key, canonicalJson(value));
}

/** One primitive statement result, as the raw executor shapes it. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
}

async function currentTransactionId(tx: DirectoryTx): Promise<string> {
  const result = await tx.execute(
    sql`SELECT txid_current()::text AS transaction_id`,
  );
  const rows = Array.isArray(result)
    ? (result as { transaction_id?: unknown }[])
    : ((result as { rows?: { transaction_id?: unknown }[] }).rows ?? []);
  const transactionId = String(rows[0]?.transaction_id ?? "");
  if (!transactionId) {
    throw new IdentityCommandRefusal(
      IDENTITY_RECOVERY_ACTOR_INVALID,
      "the transaction id could not be read; a recovery actor is never issued or validated without the transaction it is bound to",
      500,
    );
  }
  return transactionId;
}

/**
 * Issue the tx-bound recovery actor (§2.1/§5.1): after the caller locked the
 * user and re-verified the token row, this registers the HMAC commitment —
 * transactionId + target user + token row — and returns the actor carrying
 * it. Issuing consumes nothing; module-private by design.
 */
async function issueRecoveryActor(
  tx: DirectoryTx,
  targetUserId: string,
  tokenRowId: string,
  key: Buffer,
): Promise<IdentityActor> {
  const transactionId = await currentTransactionId(tx);
  const value = {
    scheme: 1 as const,
    transactionId,
    targetUserId,
    tokenRowId,
  };
  const commitment: RecoveryCommitment = {
    ...value,
    mac: commitmentMac(key, value),
  };
  const actor = {
    userId: targetUserId,
    principalId: null,
    sessionId: null,
    kind: "recovery",
    bindingId: null,
    provisioning: null,
    // The commitment rides a symbol key: JSON.stringify drops symbol keys,
    // so the actor that crosses any serialization boundary arrives as the
    // client fabrication it then is.
    [RECOVERY_COMMITMENT]: commitment,
  } as IdentityActor;
  return actor;
}

/**
 * The reset-token verification row of the fixed build: IDENTIFIER
 * `reset-password:<token>`, value = the target user, expiry enforced below.
 * The row's own primary key is an unrelated id — the identifier is the
 * lookup key `consumeVerificationValue` resolves.
 */
function resetTokenRowId(resetToken: string): string {
  return `reset-password:${resetToken}`;
}

/** The locked re-verification of §5.1 step 2: present, unexpired, on-target. */
async function lockResetToken(
  tx: DirectoryTx,
  tokenRowId: string,
  expectedUserId: string,
): Promise<void> {
  const rows = rowsOf(
    await tx.execute(
      sql`SELECT value, expires_at FROM verifications WHERE identifier = ${tokenRowId} LIMIT 1 FOR UPDATE`,
    ),
  );
  const row = rows[0] as { value?: unknown; expires_at?: unknown } | undefined;
  if (!row) {
    throw new IdentityCommandRefusal(
      IDENTITY_RECOVERY_TOKEN_UNKNOWN,
      `the reset token is unknown or already consumed; the recovery path never reveals which`,
      404,
    );
  }
  if (String(row.value) !== expectedUserId) {
    throw new IdentityCommandRefusal(
      IDENTITY_RECOVERY_TOKEN_INVALID,
      "the reset token resolves to a different target than the locked user; the boundary refuses rather than resets another identity",
      400,
    );
  }
  // The raw statement returns the column as `expires_at`; the driver hands
  // back a Date for timestamptz, but a string is parsed rather than trusted.
  const rawExpiry = row.expires_at;
  const expiresAt =
    rawExpiry instanceof Date
      ? rawExpiry
      : typeof rawExpiry === "string" || typeof rawExpiry === "number"
        ? new Date(rawExpiry)
        : null;
  if (expiresAt === null || Number.isNaN(expiresAt.getTime())) {
    throw new IdentityCommandRefusal(
      IDENTITY_RECOVERY_TOKEN_INVALID,
      "the reset token row carries no readable expiry; an unreadable validity is treated as invalid, never as valid",
      400,
    );
  }
  if (expiresAt.getTime() <= Date.now()) {
    throw new IdentityCommandRefusal(
      IDENTITY_RECOVERY_TOKEN_INVALID,
      "the reset token has expired; issuing a fresh token is the request route's business, never this boundary's",
      400,
    );
  }
}

/**
 * Validate a recovery actor against THIS transaction: the commitment must
 * exist, carry the right shape, verify under the server key against the
 * CURRENT transaction id, name this command's target, and the token row it
 * pins must still be unconsumed. This is what makes the actor
 * non-transferable — in another transaction the MAC no longer matches.
 */
async function validateRecoveryActor(
  tx: DirectoryTx,
  actor: IdentityActor,
  command: IdentityCommand,
  key: Buffer,
): Promise<RecoveryCommitment> {
  const commitment = recoveryCommitmentOf(actor);
  const refuse = (detail: string): IdentityCommandRefusal =>
    new IdentityCommandRefusal(IDENTITY_RECOVERY_ACTOR_INVALID, detail, 403);
  if (commitment?.scheme !== 1) {
    throw refuse(
      "a recovery actor must be issued inside the transaction it runs in; a client kind field creates nothing",
    );
  }
  const transactionId = await currentTransactionId(tx);
  if (commitment.transactionId !== transactionId) {
    throw refuse(
      "the recovery actor was issued for another transaction; the commitment is transaction-bound and cannot be transferred",
    );
  }
  if (
    commitmentMac(key, {
      scheme: commitment.scheme,
      transactionId: commitment.transactionId,
      targetUserId: commitment.targetUserId,
      tokenRowId: commitment.tokenRowId,
    }) !== commitment.mac
  ) {
    throw refuse(
      "the recovery actor's commitment does not verify under this server's key; a forged or tampered actor is refused",
    );
  }
  if (
    commitment.targetUserId !== command.targetUserId ||
    actor.userId !== command.targetUserId
  ) {
    throw refuse(
      "the recovery actor was issued for another target user; a reset is single-target",
    );
  }
  if (command.operation !== "identity.password.reset") {
    throw refuse(
      `a recovery actor authorizes identity.password.reset only; ${command.operation} is refused`,
    );
  }
  if (
    command.secrets?.resetToken !== undefined &&
    resetTokenRowId(command.secrets.resetToken) !== commitment.tokenRowId
  ) {
    throw refuse(
      "the command's reset token does not match the one the actor's commitment pins",
    );
  }
  // The unconsumed re-verification: the pinned row must still exist — the
  // native POST inside this transaction is what removes it.
  const result = await tx.execute(
    sql`SELECT 1 AS ok FROM verifications WHERE identifier = ${commitment.tokenRowId} LIMIT 1`,
  );
  const rows = Array.isArray(result)
    ? (result as { ok?: unknown }[])
    : ((result as { rows?: { ok?: unknown }[] }).rows ?? []);
  if (rows.length === 0) {
    throw refuse(
      "the reset token the actor was issued against is already consumed; a consumed token never borrows a receipt",
    );
  }
  return commitment;
}

interface CommandExecution {
  readonly result: IdentityResult;
  readonly pendingHooks: readonly PostCommitHook[];
  /** The command's mail-callback fence, for the caller to settle. */
  readonly fence: MailCallbackFence | undefined;
}

interface ReceiptRow {
  commandId: string;
  operation: string;
  payloadHash: string;
  finalized: boolean;
}

/**
 * The named refusal behind a driver failure, mirroring the directory
 * executor's discipline: the marker of a refusal in the cause chain is the
 * stable reason the caller acts on; anything else is a real fault and is
 * rethrown untouched.
 */
const REFUSAL_MARKER =
  /^(IDENTITY_[A-Z0-9_]+|PRINCIPAL_REGISTRY_[A-Z0-9_]+|OUTBOX_[A-Z0-9_]+|AUTHORITY_[A-Z0-9_]+|DIRECTORY_[A-Z0-9_]+|AUTH_[A-Z0-9_]+)/;

function preferredRefusal(error: unknown): unknown {
  let current: unknown = error;
  let named: unknown;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const message =
      current instanceof Error ? current.message : String(current);
    if (REFUSAL_MARKER.test(message)) named = current;
    current = (current as { cause?: unknown }).cause;
  }
  return named ?? error;
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const record = current as { code?: unknown; errno?: unknown };
    for (const code of [record.code, record.errno]) {
      if (code === "23505") return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Force the named deferred fences while the transaction is open. */
async function forceCommitFences(tx: DirectoryTx): Promise<void> {
  await tx.execute(
    sql.raw(
      `SET CONSTRAINTS ${DIRECTORY_COMMIT_CONSTRAINTS.join(", ")} IMMEDIATE`,
    ),
  );
}

export function createIdentityExecutor(
  options: IdentityExecutorOptions,
): IdentityExecutor {
  const onPostCommitHookError = options.onPostCommitHookError ?? (() => {});
  const commitmentKey = options.commitmentKey;

  /** The committed receipt under the narrow identity idempotency domain. */
  async function findReceipt(
    tx: DirectoryTx,
    targetUserId: string,
    idempotencyKey: string,
  ): Promise<ReceiptRow | undefined> {
    const [row] = await tx
      .select({
        commandId: authCommandReceipts.commandId,
        operation: authCommandReceipts.operation,
        payloadHash: authCommandReceipts.payloadHash,
        finalized: authCommandReceipts.finalized,
      })
      .from(authCommandReceipts)
      .where(
        and(
          eq(authCommandReceipts.domain, "identity"),
          eq(authCommandReceipts.targetUserId, targetUserId),
          eq(authCommandReceipts.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return row;
  }

  /** The durable half a replay reports: the current verified principal. */
  async function replayResult(
    tx: DirectoryTx,
    receipt: ReceiptRow,
    targetUserId: string,
  ): Promise<IdentityResult> {
    if (!receipt.finalized) {
      throw new IdentityCommandRefusal(
        IDENTITY_REPLAY_RECEIPT_INVALID,
        `command ${receipt.commandId} has a committed receipt that is not finalized; the commit fence guarantees this cannot happen, so the receipt is inconsistent and is refused rather than replayed`,
        500,
      );
    }
    const rows = rowsOf(
      await tx.execute(
        sql`SELECT p.id AS principal_id, p.identity_generation::int AS generation
              FROM enterprise_principals p WHERE p.user_id = ${targetUserId} LIMIT 1`,
      ),
    );
    const principalId = String(rows[0]?.principal_id ?? "");
    const generation = rows[0]?.generation;
    if (
      !principalId ||
      typeof generation !== "number" ||
      !Number.isSafeInteger(generation)
    ) {
      throw new IdentityCommandRefusal(
        IDENTITY_REPLAY_RECEIPT_INVALID,
        `command ${receipt.commandId} has no verifiable principal behind its target; the replay is refused rather than reported`,
        500,
      );
    }
    return {
      commandId: receipt.commandId,
      replayed: true,
      userId: targetUserId,
      principalId,
      identityGeneration: generation,
    };
  }

  /** The current global admin check, in-lock, re-run on every replay. */
  async function requireGlobalAdmin(
    tx: DirectoryTx,
    actor: IdentityActor,
  ): Promise<void> {
    if (actor.kind !== "platform" && actor.kind !== "migration") {
      throw new IdentityCommandRefusal(
        IDENTITY_ACTOR_FORBIDDEN,
        `a ${actor.kind} actor cannot run an administrator identity operation; the platform actor is issued only after the server verifies a current session, the admin role and the deployment rules`,
        403,
      );
    }
    if (actor.kind === "migration") {
      // The offline sealed channel (§2.1: migration actors exist only in
      // stopped-write offline tooling); the runtime never issues one.
      return;
    }
    const rows = rowsOf(
      await tx.execute(
        sql`SELECT 1 AS ok FROM user_roles WHERE user_id = ${actor.userId} AND role = 'admin' LIMIT 1`,
      ),
    );
    if (rows.length === 0) {
      throw new IdentityCommandRefusal(
        IDENTITY_ACTOR_FORBIDDEN,
        `actor ${actor.userId} holds no current global admin role; the check ran in this transaction under the actor's own lock, and a demoted administrator never borrows a receipt`,
        403,
      );
    }
  }

  /** The session-ownership check of identity.session.revoke. */
  async function requireSessionOwnership(
    tx: DirectoryTx,
    actor: IdentityActor,
    command: IdentityCommand,
  ): Promise<void> {
    if (actor.kind === "session") {
      // Self-service only (§2.1's "当前用户"): another target is an
      // administrator action this kind can never take.
      if (actor.userId !== command.targetUserId) {
        throw new IdentityCommandRefusal(
          IDENTITY_ACTOR_FORBIDDEN,
          "a session actor may revoke only its own user's session; another target is an administrator action",
          403,
        );
      }
    } else {
      await requireGlobalAdmin(tx, actor);
    }
    const sessionId = String(command.payload.sessionId ?? "");
    const rows = rowsOf(
      await tx.execute(
        sql`SELECT user_id FROM sessions WHERE id = ${sessionId} LIMIT 1`,
      ),
    );
    const owner = rows[0]?.user_id;
    if (owner === undefined) {
      throw new IdentityCommandRefusal(
        IDENTITY_SESSION_UNKNOWN,
        `session ${sessionId} does not exist; it may already be gone, and an unknown session is never a reason to touch anything else`,
        404,
      );
    }
    if (String(owner) !== command.targetUserId) {
      throw new IdentityCommandRefusal(
        IDENTITY_SESSION_NOT_OWNED,
        `session ${sessionId} belongs to ${String(owner)}, not to the command's target ${command.targetUserId}; a revoke never crosses identities`,
        403,
      );
    }
  }

  /**
   * The in-lock authorization of one command. Runs for a fresh command AND
   * for every replay — the current checks are never borrowed from a
   * receipt.
   */
  async function authorize(
    tx: DirectoryTx,
    actor: IdentityActor,
    command: IdentityCommand,
  ): Promise<RecoveryCommitment | null> {
    // A recovery actor is single-purpose by issuance: validate its
    // transaction-bound commitment first, whatever the operation asks —
    // the refusal then names the recovery boundary, not the admin gate.
    if (actor.kind === "recovery") {
      if (command.operation !== "identity.password.reset") {
        throw new IdentityCommandRefusal(
          IDENTITY_RECOVERY_ACTOR_INVALID,
          `a recovery actor authorizes identity.password.reset only; ${command.operation} is refused`,
          403,
        );
      }
      return validateRecoveryActor(tx, actor, command, commitmentKey);
    }
    switch (command.operation) {
      case "identity.disable":
      case "identity.restore":
      case "identity.role.set":
      case "identity.sessions.revoke":
      case "identity.user.create":
      case "identity.profile.update":
        await requireGlobalAdmin(tx, actor);
        return null;
      case "identity.session.revoke":
        await requireSessionOwnership(tx, actor, command);
        return null;
      case "identity.password.reset": {
        if (command.secrets === undefined) {
          throw new IdentityCommandRefusal(
            IDENTITY_COMMAND_INVALID,
            "identity.password.reset carries its new password in the secrets envelope; the command is never secretless",
            400,
          );
        }
        await requireGlobalAdmin(tx, actor);
        if (command.secrets.resetToken !== undefined) {
          throw new IdentityCommandRefusal(
            IDENTITY_SECRETS_MISPLACED,
            "secrets.resetToken belongs to the recovery actor path; the administrator path demands and consumes no token",
            400,
          );
        }
        return null;
      }
    }
  }

  /**
   * The disabled-target refusal of §2.1 password.reset: a password reset
   * never restores a disabled identity — restore is its own command.
   */
  async function refuseIfDisabled(
    tx: DirectoryTx,
    command: IdentityCommand,
  ): Promise<void> {
    if (command.operation !== "identity.password.reset") return;
    const rows = rowsOf(
      await tx.execute(
        sql`SELECT status FROM enterprise_principals WHERE user_id = ${command.targetUserId} LIMIT 1`,
      ),
    );
    if (rows[0]?.status === "suspended") {
      throw new IdentityCommandRefusal(
        IDENTITY_TARGET_DISABLED,
        `user ${command.targetUserId} is disabled; a password reset never restores a disabled identity — restore is its own command`,
        409,
      );
    }
  }

  /**
   * The lock layer: the actor's and the target's user ids in stable sorted
   * order, through the registry (which reuses or refuses the principal) —
   * except user.create, whose target row does not exist yet and therefore
   * takes the bare per-user lock with the principal creation deferred until
   * after the BA user row lands.
   */
  async function lockUsers(
    tx: DirectoryTx,
    actor: IdentityActor,
    command: IdentityCommand,
  ): Promise<void> {
    const ids = [actor.userId, command.targetUserId]
      .filter((id): id is string => typeof id === "string" && id.trim() !== "")
      .sort()
      .filter((id, index, all) => all.indexOf(id) === index);
    if (command.operation === "identity.user.create") {
      for (const id of ids) {
        await identityUserLock(tx, id);
      }
      if (actor.principalId !== null) {
        await verifyActorPrincipal(tx, actor);
      }
      return;
    }
    for (const id of ids) {
      await options.registry.ensure(tx, id);
      if (id === actor.userId && actor.principalId !== null) {
        await verifyActorPrincipal(tx, actor);
      }
    }
  }

  /** The stale-actor-principal check of the directory executor's discipline. */
  async function verifyActorPrincipal(
    tx: DirectoryTx,
    actor: IdentityActor,
  ): Promise<void> {
    // assertIdentityActor already guaranteed a non-null userId; the registry
    // call re-locks and re-verifies the principal under it.
    const userId = actor.userId ?? "";
    if (userId === "") return;
    const ref = await options.registry.ensure(tx, userId);
    if (ref.principalId !== actor.principalId) {
      throw new IdentityCommandRefusal(
        IDENTITY_ACTOR_PRINCIPAL_MISMATCH,
        `the actor names principal ${actor.principalId}, but the principal registry verifies ${ref.principalId} for user ${actor.userId}; a stale actor principal is refused, never silently replaced`,
        400,
      );
    }
  }

  /**
   * The begin statement: the controlled function writes the receipt under
   * the identity domain (tenant null, target user set), and the caller's
   * own top-level set_config installs the transaction marker.
   */
  async function beginCommand(
    tx: DirectoryTx,
    commandId: string,
    actor: IdentityActor,
    command: IdentityCommand,
    payloadHash: string,
  ): Promise<void> {
    await tx.execute(
      sql`SELECT set_config('auth.current_command', public.auth_directory_begin_command(${commandId}, 'identity', ${command.operation}, null, ${command.targetUserId}, ${actor.userId}, ${actor.kind}, ${command.idempotencyKey}, ${payloadHash}), true)`,
    );
  }

  /** Best-effort fence settlement outside the transaction that owned it. */
  function settleFence(
    fence: MailCallbackFence | undefined,
    outcome: "committed" | "rolled-back",
  ): void {
    if (!fence) return;
    try {
      settleMailCallbackFence(fence, outcome);
    } catch {
      // An already-settled fence is a caller bug, not a command failure.
    }
  }

  /** Drain the classified hooks exactly once, in registration order. */
  async function drainHooks(hooks: readonly PostCommitHook[]): Promise<void> {
    for (const hook of hooks) {
      try {
        await hook.run();
      } catch (error) {
        onPostCommitHookError(hook.hookId, error);
      }
    }
  }

  /**
   * The BA half that must run BEFORE the receipt begins:
   * identity.user.create only. The receipt's target-user foreign key is
   * immediate (not deferrable) and it is the fixed build's createUser that
   * makes the row exist, so the BA row lands first and the receipt then
   * binds the pre-allocated id to a target that exists. It runs inside a
   * `TransactionBoundBa.run` bound to the SAME tx (see the caller), so the
   * user row and its credential account share the executor's transaction
   * and a later failure rolls all of it away.
   */
  async function syncBeforeReceipt(command: IdentityCommand): Promise<void> {
    if (command.operation !== "identity.user.create") return;
    await options.ba.createUser({
      userId: command.targetUserId,
      email: String(command.payload.email),
      name: String(command.payload.name),
      image:
        typeof command.payload.image === "string"
          ? command.payload.image
          : null,
      password: command.secrets?.newPassword ?? null,
    });
  }

  /**
   * The BA half inside the receipt-bearing TransactionBoundBa run: the
   * password calls, and the principal of the genuinely new user (the
   * registry's per-user lock is already held). Every other operation's
   * writes belong to the finalizer's protected surface.
   */
  async function sync(
    tx: DirectoryTx,
    command: IdentityCommand,
    commitment: RecoveryCommitment | null,
    registry: PrincipalRegistry,
  ): Promise<void> {
    if (command.operation === "identity.user.create") {
      await registry.ensure(tx, command.targetUserId);
      return;
    }
    if (command.operation === "identity.password.reset") {
      // authorize() guaranteed the secrets envelope for this operation; a
      // missing password here is an internal inconsistency, refused loudly.
      const newPassword = command.secrets?.newPassword;
      if (newPassword === undefined) {
        throw new IdentityCommandRefusal(
          IDENTITY_COMMAND_INVALID,
          "identity.password.reset lost its secrets between authorization and the BA sync; the transaction is refused",
          500,
        );
      }
      if (commitment) {
        // The recovery path: the native POST is the token's ONLY consumer.
        await options.ba.consumeResetToken({
          resetToken:
            command.secrets?.resetToken ?? tokenOfRow(commitment.tokenRowId),
          newPassword,
        });
        return;
      }
      await options.ba.writePassword({
        userId: command.targetUserId,
        newPassword,
      });
    }
  }

  /**
   * The §5.1 token-consumption check of the recovery path: after the native
   * POST ran, the pinned row must be gone — the consume happened inside this
   * transaction or the transaction is refused whole.
   */
  async function assertTokenConsumed(
    tx: DirectoryTx,
    tokenRowId: string,
  ): Promise<void> {
    const rows = rowsOf(
      await tx.execute(
        sql`SELECT 1 AS ok FROM verifications WHERE identifier = ${tokenRowId} LIMIT 1`,
      ),
    );
    if (rows.length > 0) {
      throw new IdentityCommandRefusal(
        IDENTITY_RECOVERY_TOKEN_NOT_CONSUMED,
        "the reset token row survived the native consume step; the only consumer did not run in this transaction and the reset is refused whole",
        500,
      );
    }
  }

  /**
   * The shared in-transaction run: locks, replay decision, authorization,
   * receipt, BA sync, mail fence, finalizer, deferred fences. The caller's
   * `options.database.transaction` owns the commit around it, and settles
   * the fence the run registered through the holder.
   */
  async function runInTransaction(
    tx: DirectoryTx,
    actor: IdentityActor,
    command: IdentityCommand,
    payloadHash: string,
    fenceHolder: { fence?: MailCallbackFence },
  ): Promise<CommandExecution> {
    await lockUsers(tx, actor, command);

    const existing = await findReceipt(
      tx,
      command.targetUserId,
      command.idempotencyKey,
    );
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new IdentityCommandRefusal(
          IDENTITY_IDEMPOTENCY_CONFLICT,
          `idempotency key "${command.idempotencyKey}" is already committed for this user with different content; the same key under the same domain target is a replay only for the exact same operation, payload and secrets commitment`,
          409,
        );
      }
      // The replay re-runs the CURRENT authorization: a demoted admin or a
      // consumed token never borrows a receipt.
      await authorize(tx, actor, command);
      return {
        result: await replayResult(tx, existing, command.targetUserId),
        pendingHooks: [],
        fence: undefined,
      };
    }

    const commitment = await authorize(tx, actor, command);
    await refuseIfDisabled(tx, command);

    /*
     * The user.create BA write must land before the receipt begins (the
     * receipt's target-user FK is immediate), and it must still run inside
     * this transaction: `bound.run` installs the ALS store whose adapter is
     * bound to THIS tx. Called beside it, Better Auth's internal adapter
     * would fall back to the base pool and commit the user row on its own —
     * the exact orphan this task's acceptance forbids. Hooks the pre-receipt
     * run registered are drained with the rest, in registration order.
     */
    const preReceiptHooks: PostCommitHook[] = [];
    if (command.operation === "identity.user.create") {
      const preReceipt = await options.bound.run(tx, async () => {
        await syncBeforeReceipt(command);
      });
      preReceiptHooks.push(...preReceipt.pendingHooks);
    }

    const commandId = randomUUID();
    await beginCommand(tx, commandId, actor, command, payloadHash);
    const fence = createMailCallbackFence(tx, commandId);
    fenceHolder.fence = fence;

    const outcome = await options.bound.run(tx, async () => {
      await sync(tx, command, commitment, options.registry);
    });
    await assertMailCallbackCompletion(tx, fence);
    if (commitment) {
      await assertTokenConsumed(tx, commitment.tokenRowId);
    }
    const result = await options.finalizer.finalize(tx, commandId, command);
    await forceCommitFences(tx);
    return {
      result,
      pendingHooks: [...preReceiptHooks, ...outcome.pendingHooks],
      fence,
    };
  }

  const executor: IdentityExecutor = {
    async execute(
      actor: IdentityActor,
      command: IdentityCommand,
    ): Promise<IdentityResult> {
      assertIdentityActor(actor);
      assertIdentityCommand(command);
      const payloadHash = identityPayloadHash(command, commitmentKey);

      const fenceHolder: { fence?: MailCallbackFence } = {};
      let execution: CommandExecution;
      try {
        execution = await options.database.transaction(async (tx) =>
          runInTransaction(tx, actor, command, payloadHash, fenceHolder),
        );
      } catch (error) {
        settleFence(fenceHolder.fence, "rolled-back");
        if (!isUniqueViolation(error)) throw preferredRefusal(error);
        /*
         * The duplicate-key race: a same-user command under the same key
         * committed between the pre-read and the begin. The receipt that
         * won is committed; re-read it in a fresh transaction and let the
         * shared replay decision refuse or replay.
         */
        const replay = await options.database.transaction(async (tx) => {
          await lockUsers(tx, actor, command);
          const receipt = await findReceipt(
            tx,
            command.targetUserId,
            command.idempotencyKey,
          );
          if (!receipt) throw error;
          if (receipt.payloadHash !== payloadHash) {
            throw new IdentityCommandRefusal(
              IDENTITY_IDEMPOTENCY_CONFLICT,
              `idempotency key "${command.idempotencyKey}" is already committed for this user with different content`,
              409,
            );
          }
          await authorize(tx, actor, command);
          return replayResult(tx, receipt, command.targetUserId);
        });
        return replay;
      }
      settleFence(fenceHolder.fence, "committed");
      await drainHooks(execution.pendingHooks);
      return execution.result;
    },

    recovery: {
      /**
       * §5.1 step 2, one identity-executor transaction: locate → lock →
       * re-verify the token → issue the tx-bound actor → run
       * identity.password.reset → consume through the native POST → verify
       * the consumption → finalize. The locating read is deliberately the
       * first statement: an unknown token refuses before any lock.
       */
      async resetPasswordByToken(input: {
        resetToken: string;
        newPassword: string;
        idempotencyKey: string;
        onIssued?: (actor: IdentityActor) => void;
      }): Promise<IdentityResult> {
        const resetToken = requireText(input?.resetToken, "resetToken");
        const newPassword = requireText(input?.newPassword, "newPassword");
        const idempotencyKey = requireText(
          input?.idempotencyKey,
          "idempotencyKey",
        );
        const tokenRowId = resetTokenRowId(resetToken);

        const fenceHolder: { fence?: MailCallbackFence } = {};
        let run: CommandExecution;
        try {
          run = await options.database.transaction(async (tx) => {
            // The non-authorizing locating read (§5.1): find the target the
            // token names, then re-verify everything under the lock below.
            const located = rowsOf(
              await tx.execute(
                sql`SELECT value FROM verifications WHERE identifier = ${tokenRowId} LIMIT 1`,
              ),
            );
            const targetUserId = String(located[0]?.value ?? "");
            if (!targetUserId) {
              throw new IdentityCommandRefusal(
                IDENTITY_RECOVERY_TOKEN_UNKNOWN,
                "the reset token is unknown or already consumed; the recovery path never reveals which",
                404,
              );
            }

            // The user/principal lock layer, then the locked re-verification.
            await options.registry.ensure(tx, targetUserId);
            await lockResetToken(tx, tokenRowId, targetUserId);
            const statusRows = rowsOf(
              await tx.execute(
                sql`SELECT status FROM enterprise_principals WHERE user_id = ${targetUserId} LIMIT 1`,
              ),
            );
            if (statusRows[0]?.status !== "active") {
              throw new IdentityCommandRefusal(
                IDENTITY_TARGET_DISABLED,
                `user ${targetUserId} is disabled; a password reset never restores a disabled identity`,
                409,
              );
            }

            const actor = await issueRecoveryActor(
              tx,
              targetUserId,
              tokenRowId,
              commitmentKey,
            );
            input.onIssued?.(actor);

            const command: IdentityCommand = {
              operation: "identity.password.reset",
              targetUserId,
              idempotencyKey,
              payload: { reason: "password reset by recovery token" },
              secrets: { newPassword, resetToken },
            };
            assertIdentityCommand(command);
            const payloadHash = identityPayloadHash(command, commitmentKey);
            return runInTransaction(
              tx,
              actor,
              command,
              payloadHash,
              fenceHolder,
            );
          });
        } catch (error) {
          settleFence(fenceHolder.fence, "rolled-back");
          throw error;
        }
        settleFence(fenceHolder.fence, "committed");
        await drainHooks(run.pendingHooks);
        return run.result;
      },
    },
  };
  return Object.freeze(executor);
}

/** The token value behind a pinned reset-token row id. */
function tokenOfRow(tokenRowId: string): string {
  return tokenRowId.replace(/^reset-password:/, "");
}
