/*
 * Directory write contracts (T01.03 / #515, extended by T01.04 / #516; frozen
 * excerpt from docs/plans/better-auth/full-integration/interfaces.md
 * §2/§3/§3.1).
 *
 * T01.03 owns the transaction-binding contract: DirectoryTx, BaTxOutcome,
 * PostCommitHook and TransactionBoundBa. T01.04 adds the deferred-hook
 * classification vocabulary those hooks drain under (HookSourceDisposition,
 * HookSourceClassification) and the options view behind the §3.1 factory hard
 * preconditions (BaAuthorityOptionsView). T01.05 adds the team-management
 * authority/capability vocabulary and ScopedTeamExtension (interfaces §3,
 * P01 prototype) together with their base types Version and DirectoryActor.
 * T02.07 adds the PrincipalRef/PrincipalRegistry contract (interfaces §2.1,
 * P04). T02.12 adds the notification-translation contract the transactional
 * outbox is consumed through (AuthMailIntent, OutboxReceipt,
 * EnqueueAuthMailIntent; interfaces §3.1 notification table, §5.1). T02.08
 * adds the Directory command envelope and result (DirectoryRole,
 * DirectoryOperation, EligibilityKey, EligibilityVersion, DirectoryCommand,
 * DirectoryResult), the Directory service view and the DirectoryFinalizer
 * contract (interfaces §2/§3, P04). T04.07 (#551, original task P09) adds the
 * TeamManagementGrantView read model the management-grants GET answers with
 * (interfaces §3).
 */

import type { Database } from "../../db/client";

/**
 * The outer, executor-owned transaction a directory command runs inside — the
 * frozen definition from interfaces §2: the transaction type of the server's
 * Drizzle database (`Database = ReturnType<typeof createDatabase>`,
 * drizzle-orm/bun-sql). Better Auth's adapter is built over exactly this
 * handle, so every directory read/write shares the executor's connection and
 * transaction, and nothing here opens a second one.
 */
export type DirectoryTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * A generation/epoch counter (interfaces §2): a non-negative safe integer.
 * Database bigint values are read and incremented only when
 * `Number.isSafeInteger` holds; an overflow refuses the command instead of
 * wrapping around. Existing `memberEpoch: number` fields keep their shape.
 */
export type Version = number;

/**
 * The trusted actor a directory command runs as (interfaces §2). Issued by the
 * server from a verified session, platform, SCIM or JIT event — never
 * deserialized from HTTP or a queue. A `scim`/`jit` actor carries the fixed
 * binding and the verified provisioning event it was derived from; those are
 * the only actors allowed to hold a provisioning authority.
 */
export type DirectoryActor = Readonly<{
  userId: string | null;
  principalId: string | null;
  sessionId: string | null;
  kind: "session" | "platform" | "scim" | "jit" | "migration";
  bindingId: string | null;
  provisioning: Readonly<{
    eventId: string;
    ruleId: string;
    ruleRevision: Version;
    sourceSubject: string;
  }> | null;
}>;

/**
 * The stable business identity of one User (interfaces §2.1, T02.07 / #529): the
 * OpenBot principal id the rest of the business keys off, and the verified
 * generation an authority compares against. `identityGeneration` is a
 * {@link Version} rather than a nullable column value: a principal whose
 * generation cannot be verified is never represented as a ref — `ensure`
 * refuses that history instead of handing out an unverifiable version.
 */
export type PrincipalRef = Readonly<{
  userId: string;
  principalId: string;
  identityGeneration: Version;
}>;

/**
 * The company-independent principal registry (interfaces §2.1, T02.07 / #529,
 * original task P04). `ensure` runs at the principal lock layer of an executor's
 * open transaction: a company command has already taken its tenant lock, and a
 * personal flow takes no tenant at all. It reuses an existing principal
 * (status and generation included) or creates the one principal of a genuinely
 * new user with generation 1; it never restores a suspended principal, never
 * backfills an unverified generation, and never treats damaged history as a new
 * user.
 */
export interface PrincipalRegistry {
  ensure(tx: DirectoryTx, userId: string): Promise<PrincipalRef>;
}

/**
 * Why one team-member mutation is allowed (interfaces §3): a re-verified
 * company role with the actor's member epoch and company generation, a team
 * management grant with its generation, or an approved provisioning rule with
 * its binding/event/revision. The capability constructor re-reads the branch
 * inside the tenant lock; nothing here is trusted from a client.
 */
export type TeamCommandAuthority =
  | Readonly<{
      kind: "company-role";
      role: "owner" | "admin";
      memberEpoch: Version;
      companyGeneration: Version;
    }>
  | Readonly<{
      kind: "team-grant";
      grantId: string;
      grantGeneration: Version;
    }>
  | Readonly<{
      kind: "provisioning-rule";
      bindingId: string;
      eventId: string;
      ruleId: string;
      ruleRevision: Version;
    }>;

/**
 * A single, transaction-bound permission to run exactly one team-member
 * mutation (interfaces §3): privately constructed by the server, bound to the
 * executor's open transaction, the command, the company/workspace/team, the
 * actor, the target user and one action, and consumable once. It is an
 * internal execution capability — it must never be serialized over HTTP or a
 * queue, and no code may synthesize one outside
 * `issueTeamMutationCapability` in `team-extension.ts`.
 */
export type TeamMutationCapability = Readonly<{
  commandId: string;
  tenantId: string;
  workspaceId: string;
  teamId: string;
  actor: DirectoryActor;
  targetUserId: string;
  action: "team.member.add" | "team.member.remove";
  authority: TeamCommandAuthority;
}>;

/**
 * The two fixed team-member operations a directory command may perform under
 * a {@link TeamMutationCapability}. The team is always the capability's own
 * `teamId`; the caller cannot name a different one. Implementations consume
 * the pinned Better Auth adapter through the transaction-bound ALS store, and
 * refuse a forged, cross-request, cross-target, cross-action or already
 * consumed capability before any DML.
 */
export interface ScopedTeamExtension {
  add(
    tx: DirectoryTx,
    capability: TeamMutationCapability,
    userId: string,
  ): Promise<void>;
  remove(
    tx: DirectoryTx,
    capability: TeamMutationCapability,
    userId: string,
  ): Promise<void>;
}

/**
 * The management-grant read model (interfaces §3, T04.07 / #551, original
 * task P09): what `GET .../admin/teams/:workspaceId/management-grants`
 * answers with. One stable row per (tenant, workspace, principal) — a grant,
 * a revoke and a re-grant all advance the same row's `generation`, and
 * revocation is a status, never a deletion. `userId` is the grantee's BA
 * user id resolved from the stored principal; the durable row and its
 * snapshot generations live in `auth_team_management_grants` (T02.04).
 */
export type TeamManagementGrantView = Readonly<{
  grantId: string;
  tenantId: string;
  workspaceId: string;
  userId: string;
  actions: readonly ("team.member.add" | "team.member.remove")[];
  generation: Version;
  status: "active" | "revoked";
}>;

/**
 * A deferred side effect registered by Better Auth during a transaction-bound
 * command. Internal bookkeeping only — never serialized over HTTP or a queue.
 *
 * The two kinds are the only classifications the contract permits:
 * - "read-only": provably no database write, cache write or network send;
 * - "disabled-cache-noop": a fixed-package cache-maintenance callback whose
 *   storage layer is disabled by the pinned factory configuration, so running
 *   it after commit is an observable no-op.
 *
 * Classification is registered by source (T01.04); an unclassified hook is a
 * hard failure before commit, never a silent drop.
 */
export type PostCommitHook = Readonly<{
  hookId: string;
  kind: "read-only" | "disabled-cache-noop";
  run(): Promise<void>;
}>;

/**
 * What {@link TransactionBoundBa.run} returns: the operation's synchronous
 * result and the hooks Better Auth registered while it ran. The run does not
 * commit and never drains the queue itself; the owning executor classifies,
 * finalizes, commits, and only then runs the registered hooks exactly once —
 * a rollback runs none of them.
 */
export type BaTxOutcome<T> = Readonly<{
  value: T;
  pendingHooks: readonly PostCommitHook[];
}>;

/**
 * Binds one Better Auth command to the executor's outer transaction (frozen
 * interfaces §3.1): run<T> executes `operation` with the request-local adapter
 * bound to `tx`, with `isTransactionActive: true` so Better Auth's nested
 * `runWithTransaction` reuses the outer store instead of opening a second
 * transaction, and with the executor's own `pendingHooks` queue. A nested
 * reuse does not create a savepoint of its own; if the operation fails, the
 * run rolls the command's writes back to its explicit savepoint and surfaces
 * the first SQLSTATE — a compensating write on the aborted transaction may
 * never mask the original error as 25P02.
 */
export interface TransactionBoundBa {
  run<T>(tx: DirectoryTx, operation: () => Promise<T>): Promise<BaTxOutcome<T>>;
}

/**
 * How a deferred hook's registering source is dispositioned (T01.04,
 * interfaces §3.1 hook table). "read-only" and "disabled-cache-noop" are the
 * only classifications a hook may drain under; every other registered source
 * is a named refusal — the classification itself is the evidence, closure
 * text is never inspected to guess side effects.
 */
export type HookSourceDisposition =
  | Readonly<{ kind: "read-only" }>
  | Readonly<{ kind: "disabled-cache-noop" }>
  | Readonly<{
      reason:
        | "unregistered-database-hook"
        | "notification-without-outbox-takeover"
        | "cache-write-with-forbidden-storage";
    }>;

/**
 * One fixed-build source that can register a post-commit hook: the package
 * file and the exact call-site line of its `queueAfterTransactionHook` call
 * in the pinned build. A package upgrade that moves or adds a call site fails
 * the registry pin and must be re-classified before it may commit.
 */
export interface HookSourceClassification {
  readonly hookId: string;
  readonly packageFile: string;
  readonly line: number;
  readonly site: string;
  readonly disposition: HookSourceDisposition;
}

/**
 * The slice of the fixed package's resolved options the §3.1 factory hard
 * preconditions are checked against: no secondaryStorage, no
 * session.cookieCache, and session/verification rows stored in the
 * transaction database. The authority factory asserts this view at startup —
 * a contrary configuration is refused before any route runs, because the
 * internal cache sources it enables would register cache-writing hooks the
 * hook fence must never drain.
 */
export interface BaAuthorityOptionsView {
  readonly secondaryStorage?: unknown;
  readonly session?: {
    readonly cookieCache?: { readonly enabled?: boolean };
    readonly storeSessionInDatabase?: boolean;
  } | null;
  readonly verification?: { readonly storeInDatabase?: boolean } | null;
}

/**
 * The notification kinds the transactional outbox carries (T02.12 /
 * #534, original task P04; interfaces §3.1 notification table). The closed
 * vocabulary arrives with the task that owns its converter: T02.12 owns
 * `link-account.verify`, the takeover target the pinned build's
 * dispatchVerificationEmail hook shape translates into. Verification and
 * reset mail kinds belong to the mail wiring task (T04.04/P08) and are added
 * there, never sketched here.
 */
export type OutboxIntentKind = "link-account.verify";

/**
 * One mail notification to register beside its command, in the command's own
 * transaction (interfaces §5.1): the verified user and address it is bound
 * to, the fixed-package-generated URL and token it carries — both secrets —
 * and the stable event idempotency key that names this notification event
 * across conversions. The key is the durable outbox row's id, so its shape
 * is part of the contract: server-issued, non-empty printable text, derived
 * from stable facts (kind, command, token binding) rather than a clock, so
 * the delivery worker can deduplicate on it and a duplicate registration
 * under a new command is a named refusal instead of a second row.
 */
export type AuthMailIntent = Readonly<{
  commandId: string;
  kind: OutboxIntentKind;
  eventKey: string;
  userId: string;
  to: string;
  subject: string;
  url: string;
  token: string;
}>;

/**
 * The internal receipt one enqueued mail intent earns (T02.12): the durable
 * intent's id and the token binding it completes, handed back to the
 * controlled sender inside the same transaction. The request-local callback
 * ledger keeps one completed receipt per observed token; the pre-commit
 * fence reconciles that pairing and refuses a commit that would leave a
 * token behind without its intent.
 */
export type OutboxReceipt = Readonly<{
  intentId: string;
  commandId: string;
  kind: OutboxIntentKind;
  token: string;
}>;

/**
 * The notification-translation contract (interfaces §3.1: "验证/恢复/邀请
 * 邮件 … finalizer 写加密 outbox 意图，提交后 delivery"): registers one
 * {@link AuthMailIntent} inside the executor's open command transaction —
 * validating the transaction is live, the event key stable-shaped, and
 * sealing the URL and token into the stored payload — and returns the
 * receipt the callback fence accounts. T04.04/P08's mail callbacks consume
 * this; nothing sends here, and delivery happens only after the commit.
 */
export interface EnqueueAuthMailIntent {
  enqueueAuthMailIntent(
    tx: DirectoryTx,
    intent: AuthMailIntent,
  ): Promise<OutboxReceipt>;
}

/*
 * --- T02.08 (#530, original task P04): the Directory command envelope ------
 *
 * The types below are the frozen excerpt of interfaces §2/§3 this task owns:
 * the closed role and operation vocabulary, the stable eligibility key and
 * version a command's result reports, the command/result envelope, the public
 * Directory service view and the finalizer contract. They are types only —
 * this file never reads a database. The executor and finalizer that consume
 * them live in `executor.ts`/`finalizer.ts`.
 */

/**
 * The fixed company role vocabulary (interfaces §2). It is the BA directory
 * role domain, deliberately separate from the legacy `enterprise_memberships`
 * domain (`tenant_admin`/`member`/`auditor`): the same company has one BA role
 * and one derived legacy projection role, and conflating the two domains
 * would let a projection value re-enter a BA write. The projection mapping
 * belongs to the finalizer; this type names the directory side only.
 */
export type DirectoryRole = "owner" | "admin" | "member" | "auditor";

/**
 * The closed operation vocabulary of interfaces §2's payload table. An
 * operation outside this list is refused before any lock, receipt or DML —
 * the type is the completeness proof the executor's runtime guard is written
 * against, and the payload each one accepts is validated by the executor's
 * Zod union (unknown fields are refused, never ignored).
 */
export type DirectoryOperation =
  | "company.provision"
  | "company.profile.update"
  | "company.suspend"
  | "company.restore"
  | "company.deletion.request"
  | "invitation.create"
  | "invitation.accept"
  | "invitation.reject"
  | "invitation.cancel"
  | "invitation.resend"
  | "provisioning.rule.approve"
  | "provisioning.rule.revoke"
  | "member.provision"
  | "member.role.set"
  | "member.suspend"
  | "member.restore"
  | "member.remove"
  | "member.leave"
  | "owner.transfer"
  | "team.create"
  | "team.profile.update"
  | "team.archive.request"
  | "team.management.grant"
  | "team.management.revoke"
  | "team.member.add"
  | "team.member.remove";

/**
 * The stable business key of one eligibility version (interfaces §2): the
 * company and principal it belongs to, the eligibility domain (company
 * membership or one team) and the scope (the company itself for `company`,
 * the workspace for `team`). Never a BA member/team-member id — those are
 * recreated on every re-join and would make an old version unresolvable.
 */
export type EligibilityKey = Readonly<{
  tenantId: string;
  principalId: string;
  kind: "company" | "team";
  scopeId: string;
}>;

/**
 * The version pair a command's result reports per {@link EligibilityKey}
 * (interfaces §2). `epoch` advances on a relationship/role change, `generation`
 * on a suspension/removal or permission narrowing, and `tombstone` stays true
 * once the relationship was revoked by a removal — a re-joined member's
 * abilities issued against an older generation stay dead.
 */
export type EligibilityVersion = Readonly<{
  epoch: Version;
  generation: Version;
  tombstone: boolean;
}>;

/**
 * One directory command (interfaces §2): the closed operation, the company it
 * targets, the caller's idempotency key and the operation payload. Built by
 * the server-side ingress from a verified actor — an actor, principal,
 * executor or skip-authorization flag is never accepted from HTTP here.
 */
export type DirectoryCommand = Readonly<{
  operation: DirectoryOperation;
  tenantId: string;
  idempotencyKey: string;
  payload: Readonly<Record<string, unknown>>;
}>;

/**
 * What one command returns (interfaces §2): the receipt's command id, whether
 * this call replayed a committed command, the company and (where the
 * operation produces one) workspace/resource/grant identity, and the
 * eligibility versions the command finalized. A replay returns the same
 * versions — it never re-advances a clock.
 */
export type DirectoryResult = Readonly<{
  commandId: string;
  replayed: boolean;
  tenantId: string;
  workspaceId: string | null;
  versions: readonly Readonly<{
    key: EligibilityKey;
    value: EligibilityVersion;
  }>[];
  resourceId: string | null;
  grantId: string | null;
  grantGeneration: Version | null;
}>;

/**
 * The public service view of the directory (interfaces §2): the only way a
 * business caller reaches a write. It takes no transaction handle, executor
 * or "skip authorization" parameter — the executor owns all of those.
 *
 * `listEligibleScopes` is deliberately not declared yet: it is a read-side
 * capability over §4's ScopeListing (P05/T02.11), and sketching it here with
 * no ScopeListing type would shadow the task that owns both. The write half
 * this task produces satisfies this interface today; the read half joins it
 * with its own owner, exactly as the header discipline above requires.
 */
export interface Directory {
  execute(
    actor: DirectoryActor,
    command: DirectoryCommand,
  ): Promise<DirectoryResult>;
}

/**
 * The finalizer contract (interfaces §3): given the executor's open
 * transaction and the command id it began, verify the final BA set, write the
 * projections and clocks, record the audit fact and stamp the receipt
 * finalized — everything the deferred commit fence is about to judge. It
 * never commits, never opens a second connection and never drains hooks.
 */
export interface DirectoryFinalizer {
  finalize(tx: DirectoryTx, commandId: string): Promise<DirectoryResult>;
}

/*
 * --- T02.09 (#531, original task P04): the global identity command envelope
 *
 * The types below are the frozen excerpt of interfaces §2.1: the identity
 * domain is a separate executor from the company Directory — a global
 * identity command carries no tenant, and `IdentityActor` deliberately has
 * no company binding or provisioning evidence at all. Like the T02.08
 * excerpt above, these are types only — this file never reads a database.
 */

/**
 * The closed global identity operation vocabulary (interfaces §2.1). The
 * roles here are the global `user`/`admin` domain — deliberately separate
 * from {@link DirectoryRole}, exactly as the legacy `user_roles` domain is
 * separate from `enterprise_memberships`.
 */
export type IdentityOperation =
  | "identity.disable"
  | "identity.restore"
  | "identity.role.set"
  | "identity.session.revoke"
  | "identity.sessions.revoke"
  | "identity.user.create"
  | "identity.profile.update"
  | "identity.password.reset";

/**
 * One global identity command (interfaces §2.1): the closed operation, the
 * target user (for `identity.user.create` the server's pre-allocated id the
 * receipt binds), the idempotency key, the operation payload and — for the
 * two operations that carry a credential — the in-process secrets. Secrets
 * are never written to a receipt, an outbox intent or a log: the idempotency
 * comparison uses a server-key HMAC commitment of them, never a plaintext
 * or a bare digest an offline attacker could grind.
 */
export type IdentityCommand = Readonly<{
  operation: IdentityOperation;
  targetUserId: string;
  idempotencyKey: string;
  payload: Readonly<Record<string, unknown>>;
  secrets?: Readonly<{ newPassword: string; resetToken?: string }>;
}>;

/**
 * The actor a global identity command runs as (interfaces §2.1): a closed
 * kind domain with no company half — no `scim`/`jit`, always a null binding
 * and null provisioning. The `recovery` kind is special: it has no session
 * and is issued only inside a recovery ingress transaction, after that
 * transaction locked and re-verified the fixed build's reset token; it
 * cannot be created from an HTTP kind field, transferred to another
 * transaction, or used to borrow a receipt past a consumed token. The
 * executor enforces that with a transaction-bound HMAC commitment no client
 * can forge.
 */
export type IdentityActor = Omit<DirectoryActor, "kind"> &
  Readonly<{
    kind: "session" | "platform" | "migration" | "recovery";
    bindingId: null;
    provisioning: null;
  }>;

/**
 * What one identity command returns (interfaces §2.1): the receipt's command
 * id, whether this call replayed a committed command, the target user, and
 * the stable principal with the verified generation the command finalized
 * at. A replay returns the same command id and the current verified
 * generation — it never re-advances anything.
 */
export type IdentityResult = Readonly<{
  commandId: string;
  replayed: boolean;
  userId: string;
  principalId: string;
  identityGeneration: Version;
}>;

/**
 * The public service view of the global identity domain (interfaces §2.1):
 * the only way a caller reaches an identity write. It takes no tenant, no
 * transaction handle and no authorization bypass — the executor owns the
 * user/principal stable lock order, the in-lock authorization, the identity
 * idempotency domain and the security finalization.
 */
export interface Identity {
  execute(
    actor: IdentityActor,
    command: IdentityCommand,
  ): Promise<IdentityResult>;
}

/**
 * The identity finalizer contract (interfaces §2.1 "身份终结器核对
 * User/Principal/代际/session/proof 完整结果"): given the executor's open
 * transaction and the command id it began, perform the operation's
 * same-transaction security finalization — status/generation/role/session/
 * proof writes, the verification that the final facts are complete — and
 * stamp the receipt finalized. It never commits, never opens a second
 * connection and never drains hooks.
 */
export interface IdentityFinalizer {
  /**
   * The command beside the id: the payload facts the per-operation rules
   * need (the role value, the named session id, the profile fields, the
   * password-deployment intent) are deliberately NOT durable on the receipt
   * — only their hash commitment is — so the executor hands the finalizer
   * the command whose receipt it began. A pair mismatch is a refusal.
   */
  finalize(
    tx: DirectoryTx,
    commandId: string,
    command: IdentityCommand,
  ): Promise<IdentityResult>;
}
