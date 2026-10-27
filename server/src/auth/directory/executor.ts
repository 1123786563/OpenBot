/*
 * DirectoryExecutor — the same-transaction directory command envelope
 * (T02.08 / #530, original task P04; interfaces §2/§3, design §5.2 step 5).
 *
 * One `execute(actor, command)` call owns one outer transaction and runs the
 * frozen order, exactly as the plan states it:
 *
 *   可信 actor → tenant 排他锁 → user/principal 锁 → 锁内授权 → receipt
 *   payload hash → BA 同步 → 核对 hook 分类 → finalizer → 具名
 *   SET CONSTRAINTS … IMMEDIATE → commit → drain read-only/disabled-cache-noop
 *
 * What each step exists for:
 *
 * 1. Envelope validation. The actor must be one of the closed server-issued
 *    kinds (a session/platform actor names its user; a scim/jit actor carries
 *    its fixed binding and the verified provisioning event, not free-form
 *    claims). The operation must be in the closed DirectoryOperation
 *    vocabulary and its payload must pass that operation's strict Zod schema
 *    from interfaces §2's table — unknown fields are refused, never ignored.
 *    Nothing here is trusted from HTTP: the caller passed a command built by
 *    the server-side ingress from a verified actor.
 *
 * 2. Locks. The tenant-exclusive advisory lock (the same key convention the
 *    executor publishes, so two processes serialize on it) is taken first;
 *    the per-user principal lock is taken through PrincipalRegistry.ensure
 *    (T02.07), which reuses an existing principal or creates the first one of
 *    a genuinely new user and refuses damaged history. Member/team/resource
 *    locks belong to the operation's handler, inside the same transaction and
 *    below this layer.
 *
 * 3. Authority gate. The T02.10 DirectoryAuthority is read in this transaction
 *    and `requireWrite(tx, readVersion, "ba")` decides: M0/M1 keep the legacy
 *    writer (the BA writer is closed), M2/M3 pause every writer, M4..M7 admit
 *    only the BA writer; a missing/unknown state or a version race is a 503
 *    refusal, never a fallback. The 503s of the authority module surface
 *    unchanged (they are already named AuthorityRefusal codes).
 *
 * 4. Idempotency (the 2026-10-25 narrow ruling). The receipt's uniqueness
 *    domain is the COMPANY domain target + idempotency key — tenant + key.
 *    The actor and the operation are NOT in the domain; the payload hash
 *    covers `{operation, tenantId, payload}`, so:
 *      - same domain target + key + hash  → replay (same command id, same
 *        versions, no second write);
 *      - same domain target + key, other hash → 409 DIRECTORY_IDEMPOTENCY_CONFLICT;
 *      - a different actor with the same content → replay (the actor is not in
 *        the domain) — but every replay first re-runs the CURRENT authority
 *        gate and the handler's authorization, so a revoked actor can never
 *        borrow a receipt.
 *    The duplicate-key race is still handled: the tenant lock serializes
 *    same-tenant commands, and a 23505 from the begin statement falls back to
 *    the replay read in a fresh transaction.
 *
 * 5. BA sync and hooks. The handler's `sync` runs inside TransactionBoundBa
 *    (T01.03/T01.04): its auth.api calls share this transaction through the
 *    transaction adapter, deferred hooks are classified by source, and an
 *    unclassified or refused source rolls the command back before commit. The
 *    executor never calls auth.handler inside the transaction — the fixed
 *    handler would leave the transaction (interfaces §3.1 entry premise).
 *
 * 6. Mail-callback fence (T02.12). One request-local fence is created per
 *    command and handed to the handler; before the finalizer runs, every token
 *    the handler observed must hold exactly one completed outbox receipt, and
 *    every receipt must have its durable intent row — otherwise the commit is
 *    refused with the preserved original error and the rollback takes the
 *    token and every half-written intent with it. After the transaction
 *    settles the fence is closed, so a late callback can neither write nor
 *    send.
 *
 * 7. Finalizer, named constraints, commit, hooks. The finalizer (this task's
 *    other half) writes the projections/clocks/audit and stamps the receipt;
 *    `SET CONSTRAINTS <the four deferred fences> IMMEDIATE` forces the T02.06
 *    commit fence while the transaction is still open; the commit follows.
 *    Only after the commit does the executor drain the classified hooks, once
 *    each in registration order. A post-commit hook failure is reported to
 *    the caller's `onPostCommitHookError` seam and never rewrites the
 *    committed result — the command's facts stand.
 *
 * Boundaries this file deliberately does not claim: the per-operation
 * business handlers (P06/P08/P09/P12 register them), the ingress that builds
 * the actor/command (P04/P08), the read-side listEligibleScopes (P05/T02.11),
 * and the production factory wiring of the Better Auth instance behind
 * TransactionBoundBa (the caller injects it; T08/P23 assemble it).
 */

import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client";
import {
  authCommandChangeKeys,
  authCommandReceipts,
} from "../../db/schema/auth-directory";
import { runWithAuthMailCommand } from "../mail";
import type { DirectoryAuthority } from "./authority";
import type {
  BaTxOutcome,
  Directory,
  DirectoryActor,
  DirectoryCommand,
  DirectoryFinalizer,
  DirectoryOperation,
  DirectoryResult,
  DirectoryTx,
  PostCommitHook,
  PrincipalRef,
  PrincipalRegistry,
  TransactionBoundBa,
  Version,
} from "./contracts";
import { tombstoneFor } from "./finalizer";
import type { AuthMailOutbox, MailCallbackFence } from "./outbox";
import {
  assertMailCallbackCompletion,
  createMailCallbackFence,
  settleMailCallbackFence,
} from "./outbox";

export const DIRECTORY_COMMAND_INVALID = "DIRECTORY_COMMAND_INVALID";
export const DIRECTORY_OPERATION_UNKNOWN = "DIRECTORY_OPERATION_UNKNOWN";
export const DIRECTORY_OPERATION_NOT_WIRED = "DIRECTORY_OPERATION_NOT_WIRED";
export const DIRECTORY_ACTOR_INVALID = "DIRECTORY_ACTOR_INVALID";
export const DIRECTORY_ACTOR_PRINCIPAL_MISMATCH =
  "DIRECTORY_ACTOR_PRINCIPAL_MISMATCH";
export const DIRECTORY_IDEMPOTENCY_CONFLICT = "DIRECTORY_IDEMPOTENCY_CONFLICT";
export const DIRECTORY_REPLAY_RECEIPT_INVALID =
  "DIRECTORY_REPLAY_RECEIPT_INVALID";

/**
 * A command-envelope refusal. The status is the HTTP projection of
 * interfaces §4: a malformed command/actor is 400, an idempotency conflict is
 * 409, an operation this deployment has not wired is 503. (Authority and
 * principal-registry refusals keep their own classes and statuses; the
 * executor does not re-wrap them.)
 */
export class DirectoryCommandRefusal extends Error {
  constructor(
    readonly code: string,
    detail: string,
    readonly status: 400 | 409 | 500 | 503,
  ) {
    super(`${code}: ${detail}`);
    this.name = "DirectoryCommandRefusal";
  }
}

export function isDirectoryCommandRefusal(
  error: unknown,
): error is DirectoryCommandRefusal {
  return error instanceof DirectoryCommandRefusal;
}

/*
 * The payload vocabulary of interfaces §2's table: one strict schema per
 * operation. `strict` is the point — an unknown field is a refusal, because
 * "payload 按下表 Zod discriminated union 校验，不接受任意字段".
 */
const nonEmptyText = z.string().trim().min(1);
const workspaceIdList = z.array(nonEmptyText);
const directoryRole = z.enum(["owner", "admin", "member", "auditor"]);
const teamMemberActions = z
  .array(z.enum(["team.member.add", "team.member.remove"]))
  .min(1)
  .refine(
    (actions) => new Set(actions).size === actions.length,
    "actions must be a non-empty unique subset of team.member.add/remove",
  );

export const DIRECTORY_OPERATION_PAYLOADS: Readonly<
  Record<DirectoryOperation, z.ZodType<unknown>>
> = Object.freeze({
  "company.provision": z.strictObject({
    name: nonEmptyText,
    slug: nonEmptyText,
    ownerUserId: nonEmptyText,
    defaultTeamName: nonEmptyText.optional(),
  }),
  "company.profile.update": z
    .strictObject({
      name: nonEmptyText.optional(),
      slug: nonEmptyText.optional(),
      logo: nonEmptyText.optional(),
    })
    .refine(
      (value) => Object.values(value).some((field) => field !== undefined),
      "at least one of name/slug/logo is required",
    ),
  "company.suspend": z.strictObject({ reason: nonEmptyText }),
  "company.restore": z.strictObject({ reason: nonEmptyText }),
  "company.deletion.request": z.strictObject({ reason: nonEmptyText }),
  "invitation.create": z.strictObject({
    email: nonEmptyText,
    role: directoryRole,
    workspaceIds: workspaceIdList,
  }),
  "invitation.accept": z.strictObject({ invitationId: nonEmptyText }),
  "invitation.reject": z.strictObject({ invitationId: nonEmptyText }),
  "invitation.cancel": z.strictObject({ invitationId: nonEmptyText }),
  "invitation.resend": z.strictObject({ invitationId: nonEmptyText }),
  "provisioning.rule.approve": z.strictObject({
    bindingId: nonEmptyText,
    externalGroup: nonEmptyText.nullable().optional(),
    workspaceIds: workspaceIdList,
  }),
  "provisioning.rule.revoke": z.strictObject({
    ruleId: nonEmptyText,
    reason: nonEmptyText,
  }),
  "member.provision": z.strictObject({ userId: nonEmptyText }),
  "member.role.set": z.strictObject({
    userId: nonEmptyText,
    role: directoryRole,
  }),
  "member.suspend": z.strictObject({
    userId: nonEmptyText,
    reason: nonEmptyText,
  }),
  "member.restore": z.strictObject({
    userId: nonEmptyText,
    reason: nonEmptyText,
  }),
  "member.remove": z.strictObject({
    userId: nonEmptyText,
    reason: nonEmptyText,
  }),
  "member.leave": z.strictObject({}),
  "owner.transfer": z.strictObject({ nextOwnerUserId: nonEmptyText }),
  "team.create": z.strictObject({ name: nonEmptyText }),
  "team.profile.update": z.strictObject({
    workspaceId: nonEmptyText,
    name: nonEmptyText,
  }),
  "team.archive.request": z.strictObject({
    workspaceId: nonEmptyText,
    reason: nonEmptyText,
  }),
  "team.management.grant": z.strictObject({
    workspaceId: nonEmptyText,
    userId: nonEmptyText,
    actions: teamMemberActions,
  }),
  "team.management.revoke": z.strictObject({
    grantId: nonEmptyText,
    reason: nonEmptyText,
  }),
  "team.member.add": z.strictObject({
    workspaceId: nonEmptyText,
    userId: nonEmptyText,
  }),
  "team.member.remove": z.strictObject({
    workspaceId: nonEmptyText,
    userId: nonEmptyText,
  }),
});

export const DIRECTORY_OPERATIONS = Object.freeze(
  Object.keys(DIRECTORY_OPERATION_PAYLOADS) as DirectoryOperation[],
);

/** The deferred T02.06 fences the executor forces before the commit. */
export const DIRECTORY_COMMIT_CONSTRAINTS = Object.freeze([
  "auth_command_receipt_fence",
  "auth_change_key_fence",
  "auth_team_member_orphan_fence",
  "auth_member_orphan_fence",
]);

/** The idempotency key rides an indexed text column; printable, bounded. */
const IDEMPOTENCY_KEY_MAX = 512;

const ACTOR_KINDS = [
  "session",
  "platform",
  "scim",
  "jit",
  "migration",
] as const;

function isPrintable(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DirectoryCommandRefusal(
      DIRECTORY_COMMAND_INVALID,
      `${field} must be a non-empty string`,
      400,
    );
  }
  return value;
}

/**
 * The actor checks of interfaces §2: a closed kind domain, at least one
 * server-issued identity, a session actor always naming its session, and a
 * scim/jit actor always carrying the fixed binding plus the verified
 * provisioning event — never a free-form approximation of one.
 */
export function assertDirectoryActor(actor: DirectoryActor): void {
  const invalid = (detail: string): DirectoryCommandRefusal =>
    new DirectoryCommandRefusal(DIRECTORY_ACTOR_INVALID, detail, 400);
  const kind = actor?.kind;
  if (!ACTOR_KINDS.includes(kind as (typeof ACTOR_KINDS)[number])) {
    throw invalid(`actor.kind "${String(kind)}" is not a directory actor kind`);
  }
  if (actor.userId === null && actor.principalId === null) {
    throw invalid("actor must name a userId or a principalId");
  }
  if (actor.userId !== null) requireText(actor.userId, "actor.userId");
  if (actor.principalId !== null) {
    requireText(actor.principalId, "actor.principalId");
  }
  if (kind === "session") {
    requireText(actor.sessionId, "actor.sessionId");
  }
  if (kind === "platform") {
    // The platform actor is a person's operator identity: the receipt's
    // actor_user_id is what the audit trail names.
    requireText(actor.userId, "actor.userId");
  }
  if (kind === "scim" || kind === "jit") {
    requireText(actor.bindingId, "actor.bindingId");
    if (!actor.provisioning) {
      throw invalid(
        `${kind} actors must carry the verified provisioning event they were derived from`,
      );
    }
  }
  if (actor.provisioning) {
    requireText(actor.provisioning.eventId, "actor.provisioning.eventId");
    requireText(actor.provisioning.ruleId, "actor.provisioning.ruleId");
    requireText(
      actor.provisioning.sourceSubject,
      "actor.provisioning.sourceSubject",
    );
    if (
      typeof actor.provisioning.ruleRevision !== "number" ||
      !Number.isSafeInteger(actor.provisioning.ruleRevision) ||
      actor.provisioning.ruleRevision < 0
    ) {
      throw invalid(
        "actor.provisioning.ruleRevision must be a non-negative safe integer (Version)",
      );
    }
    if (kind !== "scim" && kind !== "jit") {
      throw invalid(
        `a ${kind} actor must not carry provisioning evidence; only scim/jit actors hold a verified provisioning event`,
      );
    }
  }
}

/** The closed-vocabulary + payload validation of interfaces §2's table. */
export function assertDirectoryCommand(command: DirectoryCommand): void {
  const operation = command?.operation as string;
  if (!DIRECTORY_OPERATIONS.includes(operation as DirectoryOperation)) {
    throw new DirectoryCommandRefusal(
      DIRECTORY_OPERATION_UNKNOWN,
      `operation "${String(operation)}" is not one of the frozen DirectoryOperation vocabulary`,
      400,
    );
  }
  requireText(command.tenantId, "tenantId");
  const idempotencyKey = requireText(command.idempotencyKey, "idempotencyKey");
  if (
    idempotencyKey.length > IDEMPOTENCY_KEY_MAX ||
    !isPrintable(idempotencyKey)
  ) {
    throw new DirectoryCommandRefusal(
      DIRECTORY_COMMAND_INVALID,
      `idempotencyKey must be printable text of at most ${IDEMPOTENCY_KEY_MAX} characters; the receipt's uniqueness domain is what makes a replay safe, and a malformed key is refused before any lock`,
      400,
    );
  }
  if (
    command.payload === null ||
    typeof command.payload !== "object" ||
    Array.isArray(command.payload)
  ) {
    throw new DirectoryCommandRefusal(
      DIRECTORY_COMMAND_INVALID,
      "payload must be a plain object; the operation's Zod schema decides which fields it may carry",
      400,
    );
  }
  const parsed = DIRECTORY_OPERATION_PAYLOADS[
    operation as DirectoryOperation
  ].safeParse(command.payload);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new DirectoryCommandRefusal(
      DIRECTORY_COMMAND_INVALID,
      `payload does not match ${operation}'s schema (${issues}); unknown fields and wrong shapes are refused, never ignored`,
      400,
    );
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

/**
 * The receipt's payload hash: the operation, the company target and the
 * payload — the actor is deliberately excluded (the narrow idempotency ruling
 * of 2026-10-25), while the operation IS included so the same key under a
 * different operation is a conflict, not a replay.
 */
export function directoryPayloadHash(command: DirectoryCommand): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        operation: command.operation,
        tenantId: command.tenantId,
        payload: command.payload,
      }),
    )
    .digest("hex");
}

/** The authorization half of one command: re-run on replay, always current. */
export interface DirectoryAuthorizeContext {
  readonly tx: DirectoryTx;
  readonly actor: DirectoryActor;
  readonly command: DirectoryCommand;
  /** The actor's verified principal, or null for a binding actor without a user. */
  readonly principal: PrincipalRef | null;
  /** The receipt's command id: null for a fresh command, the original on replay. */
  readonly commandId: string | null;
  readonly payloadHash: string;
}

/** The BA-sync half: only runs for a fresh command, inside TransactionBoundBa. */
export interface DirectorySyncContext extends DirectoryAuthorizeContext {
  readonly commandId: string;
  readonly registry: PrincipalRegistry;
  readonly bound: TransactionBoundBa;
  readonly fence: MailCallbackFence;
  readonly outbox: Pick<
    AuthMailOutbox,
    "createControlledMailSender" | "enqueueAuthMailIntent"
  > | null;
}

/**
 * What a handler's BA sync reports back: the result identity fields the
 * operation produced (the receipt's forward columns have no controlled
 * writer in the frozen function set, so the live result carries them and a
 * replay reports the durable half only — disclosed in the finalizer header).
 */
export interface DirectoryCommandOutcome {
  readonly workspaceId?: string | null;
  readonly resourceId?: string | null;
  readonly grantId?: string | null;
  readonly grantGeneration?: Version | null;
}

/**
 * One operation's in-transaction implementation. `authorize` is the locked
 * authority verification and runs for both a fresh command (before the
 * receipt exists) and a replay (with the original command id) — a revoked
 * actor can never borrow a receipt. `sync` is the BA sync plus the
 * operation's business writes; the executor runs it inside
 * TransactionBoundBa, so its auth.api calls share the command transaction.
 */
export interface DirectoryCommandHandler {
  authorize(context: DirectoryAuthorizeContext): Promise<void>;
  sync(context: DirectorySyncContext): Promise<DirectoryCommandOutcome>;
}

export interface DirectoryExecutorOptions {
  readonly database: Pick<Database, "transaction">;
  readonly bound: TransactionBoundBa;
  readonly authority: Pick<DirectoryAuthority, "read" | "requireWrite">;
  readonly registry: PrincipalRegistry;
  readonly finalizer: DirectoryFinalizer;
  readonly handlers: Readonly<
    Partial<Record<DirectoryOperation, DirectoryCommandHandler>>
  >;
  /** The mail service a handler may build its controlled sender from. */
  readonly outbox?: Pick<
    AuthMailOutbox,
    "createControlledMailSender" | "enqueueAuthMailIntent"
  > | null;
  /**
   * Where a post-commit hook's failure is reported. The command has already
   * committed by then, so the failure never rewrites the result; the caller
   * records it wherever its own observability lives.
   */
  readonly onPostCommitHookError?: (hookId: string, error: unknown) => void;
}

interface CommandExecution {
  readonly result: DirectoryResult;
  readonly pendingHooks: readonly PostCommitHook[];
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

/**
 * The named refusal behind a driver failure. Drizzle wraps every statement
 * error in its own "Failed query: …" error with the PostgresError in the
 * cause chain; the guard/controlled-function markers (AUTH_*, plus the
 * composed modules' own codes) are precisely the stable, auditable reason a
 * caller must act on, so the executor surfaces that cause instead of the
 * wrapper. Non-refusal failures (connection faults, the wrapper itself) are
 * rethrown untouched — a real fault is never renamed into a refusal.
 */
const REFUSAL_MARKER =
  /^(AUTH_[A-Z0-9_]+|PRINCIPAL_REGISTRY_[A-Z0-9_]+|OUTBOX_[A-Z0-9_]+|AUTHORITY_[A-Z0-9_]+|DIRECTORY_[A-Z0-9_]+|TEAM_[A-Z0-9_]+|BA_AUTHORITY_[A-Z0-9_]+|SCIM_[A-Z0-9_]+|PROVISIONING_RULE_[A-Z0-9_]+)/;

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

export function createDirectoryExecutor(
  options: DirectoryExecutorOptions,
): Directory {
  const onPostCommitHookError = options.onPostCommitHookError ?? (() => {});

  /** The tenant-exclusive lock: same key convention for every executor. */
  async function tenantLock(tx: DirectoryTx, tenantId: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`directory-tenant\u001f${tenantId}`}, 0))`,
    );
  }

  /** The locked authority gate: plan against the state this transaction reads. */
  async function requireBaWriter(tx: DirectoryTx): Promise<void> {
    const state = await options.authority.read(tx);
    await options.authority.requireWrite(tx, state.authorityVersion, "ba");
  }

  /** The principal lock layer (T02.07) for the actor's own user. */
  async function resolveActorPrincipal(
    tx: DirectoryTx,
    actor: DirectoryActor,
  ): Promise<PrincipalRef | null> {
    if (actor.userId === null) return null;
    const principal = await options.registry.ensure(tx, actor.userId);
    if (
      actor.principalId !== null &&
      actor.principalId !== principal.principalId
    ) {
      throw new DirectoryCommandRefusal(
        DIRECTORY_ACTOR_PRINCIPAL_MISMATCH,
        `the actor names principal ${actor.principalId}, but the principal registry verifies ${principal.principalId} for user ${actor.userId}; a stale actor principal is refused, never silently replaced`,
        400,
      );
    }
    return principal;
  }

  /** The command's committed receipt under the narrow idempotency domain. */
  async function findReceipt(
    tx: DirectoryTx,
    tenantId: string,
    idempotencyKey: string,
  ) {
    const [row] = await tx
      .select({
        commandId: authCommandReceipts.commandId,
        domain: authCommandReceipts.domain,
        operation: authCommandReceipts.operation,
        tenantId: authCommandReceipts.tenantId,
        payloadHash: authCommandReceipts.payloadHash,
        finalized: authCommandReceipts.finalized,
        workspaceId: authCommandReceipts.workspaceId,
        resourceId: authCommandReceipts.resourceId,
        grantId: authCommandReceipts.grantId,
        grantGeneration: authCommandReceipts.grantGeneration,
      })
      .from(authCommandReceipts)
      .where(
        and(
          eq(authCommandReceipts.domain, "company"),
          eq(authCommandReceipts.tenantId, tenantId),
          eq(authCommandReceipts.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return row;
  }

  /** The receipt's stored versions, rebuilt exactly as the finalizer wrote them. */
  async function replayResult(
    tx: DirectoryTx,
    receipt: NonNullable<Awaited<ReturnType<typeof findReceipt>>>,
  ): Promise<DirectoryResult> {
    const keys = await tx
      .select({
        tenantId: authCommandChangeKeys.tenantId,
        principalId: authCommandChangeKeys.principalId,
        kind: authCommandChangeKeys.kind,
        scopeId: authCommandChangeKeys.scopeId,
        epochAfter: authCommandChangeKeys.epochAfter,
        generationAfter: authCommandChangeKeys.generationAfter,
      })
      .from(authCommandChangeKeys)
      .where(eq(authCommandChangeKeys.commandId, receipt.commandId));
    const versions = keys
      .map((key) => ({
        key: {
          tenantId: key.tenantId,
          principalId: key.principalId,
          kind: key.kind as "company" | "team",
          scopeId: key.scopeId,
        },
        value: {
          epoch: key.epochAfter,
          generation: key.generationAfter,
          tombstone: tombstoneFor(
            receipt.operation,
            key.kind as "company" | "team",
          ),
        },
      }))
      .sort((left, right) => {
        if (left.key.kind !== right.key.kind) {
          return left.key.kind === "company" ? -1 : 1;
        }
        if (left.key.scopeId !== right.key.scopeId) {
          return left.key.scopeId < right.key.scopeId ? -1 : 1;
        }
        return left.key.principalId < right.key.principalId ? -1 : 1;
      });
    if (receipt.tenantId === null) {
      // The company-domain receipt CHECKs forbid this; refuse rather than
      // report a result for a receipt the database could not have stored.
      throw new DirectoryCommandRefusal(
        DIRECTORY_REPLAY_RECEIPT_INVALID,
        `command ${receipt.commandId} has no tenant despite its company domain; the receipt is inconsistent and is refused rather than replayed`,
        500,
      );
    }
    return {
      commandId: receipt.commandId,
      replayed: true,
      tenantId: receipt.tenantId,
      workspaceId: receipt.workspaceId,
      versions,
      resourceId: receipt.resourceId,
      grantId: receipt.grantId,
      grantGeneration: receipt.grantGeneration,
    };
  }

  /** The replay decision shared by both entry paths. */
  async function replayOrConflict(
    tx: DirectoryTx,
    receipt: NonNullable<Awaited<ReturnType<typeof findReceipt>>>,
    command: DirectoryCommand,
    payloadHash: string,
    handler: DirectoryCommandHandler,
    actor: DirectoryActor,
    principal: PrincipalRef | null,
  ): Promise<CommandExecution> {
    if (receipt.payloadHash !== payloadHash) {
      throw new DirectoryCommandRefusal(
        DIRECTORY_IDEMPOTENCY_CONFLICT,
        `idempotency key "${command.idempotencyKey}" is already committed for this company with different content; the same key under the same domain target is a replay only for the exact same operation and payload`,
        409,
      );
    }
    if (!receipt.finalized) {
      throw new DirectoryCommandRefusal(
        DIRECTORY_REPLAY_RECEIPT_INVALID,
        `command ${receipt.commandId} has a committed receipt that is not finalized; the commit fence guarantees this cannot happen, so the receipt is inconsistent and is refused rather than replayed`,
        500,
      );
    }
    // The replay re-runs the CURRENT authorization: a revoked actor cannot
    // borrow a receipt, and the authority gate above already re-verified.
    await handler.authorize({
      tx,
      actor,
      command,
      principal,
      commandId: receipt.commandId,
      payloadHash,
    });
    return { result: await replayResult(tx, receipt), pendingHooks: [] };
  }

  /**
   * The begin statement: the controlled function writes the receipt, and the
   * caller's own top-level set_config installs the transaction marker the
   * guard demands (a function cannot set a transaction-local setting).
   */
  async function beginCommand(
    tx: DirectoryTx,
    commandId: string,
    command: DirectoryCommand,
    actor: DirectoryActor,
    payloadHash: string,
  ): Promise<void> {
    await tx.execute(
      sql`SELECT set_config('auth.current_command', public.auth_directory_begin_command(${commandId}, 'company', ${command.operation}, ${command.tenantId}, null, ${actor.userId}, ${actor.kind}, ${command.idempotencyKey}, ${payloadHash}), true)`,
    );
  }

  /** Force the four deferred T02.06 fences while the transaction is open. */
  async function forceCommitFences(tx: DirectoryTx): Promise<void> {
    await tx.execute(
      sql.raw(
        `SET CONSTRAINTS ${DIRECTORY_COMMIT_CONSTRAINTS.join(", ")} IMMEDIATE`,
      ),
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
      // A fence that was already settled is a caller bug, not a command
      // failure: the durable facts and the refusal above stand either way.
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

  return Object.freeze({
    async execute(
      actor: DirectoryActor,
      command: DirectoryCommand,
    ): Promise<DirectoryResult> {
      assertDirectoryActor(actor);
      assertDirectoryCommand(command);
      const handler = options.handlers[command.operation];
      if (!handler) {
        throw new DirectoryCommandRefusal(
          DIRECTORY_OPERATION_NOT_WIRED,
          `operation ${command.operation} has no registered handler in this deployment; the command envelope is ready and the operation's business implementation arrives with its owner task`,
          503,
        );
      }
      const payloadHash = directoryPayloadHash(command);

      let fence: MailCallbackFence | undefined;
      try {
        const execution = await options.database.transaction(async (tx) => {
          await tenantLock(tx, command.tenantId);
          await requireBaWriter(tx);
          const principal = await resolveActorPrincipal(tx, actor);

          const existing = await findReceipt(
            tx,
            command.tenantId,
            command.idempotencyKey,
          );
          if (existing) {
            return replayOrConflict(
              tx,
              existing,
              command,
              payloadHash,
              handler,
              actor,
              principal,
            );
          }

          await handler.authorize({
            tx,
            actor,
            command,
            principal,
            commandId: null,
            payloadHash,
          });

          const commandId = randomUUID();
          await beginCommand(tx, commandId, command, actor, payloadHash);
          const fenceBound = createMailCallbackFence(tx, commandId);
          fence = fenceBound;

          /*
           * The command's mail conversion context (T04.04), wrapping the
           * whole TransactionBoundBa run — the BA operation and the
           * deferred-hook classification after it (the link-account
           * takeover converts there): every fixed-package mail callback of
           * this command finds the live tx/fence/outbox, and one fired
           * outside finds nothing and is refused unsent.
           */
          const outcome: BaTxOutcome<DirectoryCommandOutcome> =
            await runWithAuthMailCommand(
              { tx, fence: fenceBound, outbox: options.outbox ?? null },
              () =>
                options.bound.run(tx, () =>
                  handler.sync({
                    tx,
                    actor,
                    command,
                    principal,
                    commandId,
                    payloadHash,
                    registry: options.registry,
                    bound: options.bound,
                    fence: fenceBound,
                    outbox: options.outbox ?? null,
                  }),
                ),
            );
          await assertMailCallbackCompletion(tx, fenceBound);
          const finalized = await options.finalizer.finalize(tx, commandId);
          await forceCommitFences(tx);
          const merged: DirectoryResult = {
            ...finalized,
            workspaceId:
              outcome.value.workspaceId ?? finalized.workspaceId ?? null,
            resourceId:
              outcome.value.resourceId ?? finalized.resourceId ?? null,
            grantId: outcome.value.grantId ?? finalized.grantId ?? null,
            grantGeneration:
              outcome.value.grantGeneration ??
              finalized.grantGeneration ??
              null,
          };
          return {
            result: merged,
            pendingHooks: outcome.pendingHooks,
          } satisfies CommandExecution;
        });

        settleFence(fence, "committed");
        await drainHooks(execution.pendingHooks);
        return execution.result;
      } catch (error) {
        settleFence(fence, "rolled-back");
        /*
         * The duplicate-key race: the tenant lock serializes same-tenant
         * commands inside this deployment, but another executor convention
         * could still win between the pre-read and the begin. The receipt
         * that won is committed; re-read it in a fresh transaction and let
         * the shared replay decision refuse or replay.
         */
        if (!isUniqueViolation(error)) throw preferredRefusal(error);
        const replay = await options.database.transaction(async (tx) => {
          await tenantLock(tx, command.tenantId);
          await requireBaWriter(tx);
          const principal = await resolveActorPrincipal(tx, actor);
          const receipt = await findReceipt(
            tx,
            command.tenantId,
            command.idempotencyKey,
          );
          if (!receipt) throw error;
          return replayOrConflict(
            tx,
            receipt,
            command,
            payloadHash,
            handler,
            actor,
            principal,
          );
        });
        return replay.result;
      }
    },
  });
}

/*
 * T05.05 (#561, P12): the reentrant executor over an already-open transaction.
 *
 * The SCIM transcription runs inside the fixed build's own request
 * transaction — the plugin's endpoint opens it (or the executor's bound.run
 * does, when the ingress drives auth.api) — and the application hooks it
 * fires must execute their directory commands ON that transaction, or a
 * later plugin failure could not roll the membership, the clocks and the
 * audit back with the user row it created. This factory hands the executor a
 * `database` whose `transaction` simply continues on the given tx: the whole
 * envelope (locks, authority gate, receipt, finalizer, commit fences) runs
 * on the caller's transaction and the caller owns the commit. Savepoints,
 * SET CONSTRAINTS and advisory xact locks are all legal on an open
 * transaction, so nothing in the envelope needs a second connection.
 */
export function createDirectoryExecutorOverTransaction(
  tx: DirectoryTx,
  options: Omit<DirectoryExecutorOptions, "database">,
): Directory {
  const overOpenTransaction = {
    transaction: ((run: (open: DirectoryTx) => Promise<unknown>) =>
      run(tx)) as Pick<Database, "transaction">["transaction"],
  };
  return createDirectoryExecutor({ ...options, database: overOpenTransaction });
}
