/*
 * ScopedTeamExtension — the two fixed team-member operations under a single
 * server-issued capability (T01.05 / #517, P01 prototype; interfaces §3).
 *
 * What this file is responsible for, and nothing else:
 *
 * 1. Issuance. `issueTeamMutationCapability` is the only constructor of a
 *    TeamMutationCapability. It runs inside the executor's open transaction
 *    and inside the TransactionBoundBa ALS store, reads the transaction's own
 *    identity (`txid_current()`), and records both against the frozen
 *    capability object in a module-private WeakMap. A capability is therefore
 *    bound to (transaction, executor store, command, company, workspace, team,
 *    actor, target, action) as one object — an object literal that was not
 *    issued here is not a capability, it is a forgery.
 *
 *    Authority verification is *not* performed here: the caller (the
 *    lock-time planner, P04/P09) resolves and re-verifies the company role,
 *    team grant or provisioning rule inside the same transaction and passes
 *    the result. This module carries that authority; it never invents a
 *    placeholder grant, a pseudo-admin or a provisioning exemption, and it
 *    refuses an actor whose provisioning evidence does not match a
 *    provisioning authority.
 *
 * 2. Consumption. `createScopedTeamExtension(...).add/remove` validates the
 *    capability and consumes it exactly once, before any DML:
 *    - an un-issued object is refused (private construction);
 *    - an already consumed capability is refused (single use);
 *    - the action must be the method's own action;
 *    - the target must be the capability's target;
 *    - the current ALS store must be the exact executor store the capability
 *      was issued in, and it must be a transaction-active executor store —
 *      calling outside `TransactionBoundBa.run` can never write on the pool;
 *    - the transaction must report the same `txid_current()` the capability
 *      was issued in.
 *    Every refusal is a 403 TeamExtensionRefusal raised before the adapter is
 *    touched, so a refused command performs no DML at all.
 *
 * 3. The fixed-BA adapter seam. `createFixedVersionTeamMemberCommands` wraps
 *    exactly the two pinned organization-plugin helpers
 *    (`findOrCreateTeamMember`, `removeTeamMember`) over the plugin's own
 *    adapter resolver. Under the executor's ALS store those helpers resolve to
 *    the transaction adapter, so the teamMember row (and the team's
 *    memberCount counter) commit or roll back with the executor's
 *    transaction. The seam is private to this module: the frozen
 *    ScopedTeamExtension interface exposes only `add`/`remove`, and the
 *    capability — never a session, a role or a skipAuthorization flag — is
 *    what authorizes them. A plain company member can therefore run exactly
 *    the team command a grant names, without an admin session.
 *
 * 4. The P09 handlers (T04.08, the bottom section of this file).
 *    `createScopedTeamMemberHandlers` is the capability's only consumption
 *    path: the executor-registered `team.member.add`/`team.member.remove`
 *    handlers that run the locked authority discrimination (company-role vs
 *    team-grant, replay included), re-verify the target and the pair state in
 *    the same transaction, then issue the single capability and immediately
 *    spend it through the extension.
 */

import { getCurrentDBAdapterAsyncLocalStorage } from "@better-auth/core/context";
import { getOrgAdapter } from "better-auth/plugins/organization";
import { and, eq, sql } from "drizzle-orm";
import { authTeamManagementGrants } from "../../db/schema/auth-directory";
import type {
  DirectoryActor,
  DirectoryOperation,
  DirectoryTx,
  PrincipalRef,
  ScopedTeamExtension,
  TeamCommandAuthority,
  TeamMutationCapability,
  Version,
} from "./contracts";
import type {
  DirectoryCommandHandler,
  DirectoryCommandOutcome,
} from "./executor";

export const TEAM_CAPABILITY_NOT_ISSUED = "TEAM_CAPABILITY_NOT_ISSUED";
export const TEAM_CAPABILITY_ALREADY_CONSUMED =
  "TEAM_CAPABILITY_ALREADY_CONSUMED";
export const TEAM_CAPABILITY_ACTION_MISMATCH =
  "TEAM_CAPABILITY_ACTION_MISMATCH";
export const TEAM_CAPABILITY_TARGET_MISMATCH =
  "TEAM_CAPABILITY_TARGET_MISMATCH";
export const TEAM_CAPABILITY_WITHOUT_TRANSACTION_BINDING =
  "TEAM_CAPABILITY_WITHOUT_TRANSACTION_BINDING";
export const TEAM_CAPABILITY_TRANSACTION_MISMATCH =
  "TEAM_CAPABILITY_TRANSACTION_MISMATCH";
export const TEAM_CAPABILITY_INVALID = "TEAM_CAPABILITY_INVALID";

/**
 * A capability refusal. Everything this module refuses is a 403: the caller
 * never proved it holds the exact, live, single-use capability for this
 * command. The code is the stable, auditable reason; the message names the
 * binding that did not match without echoing any secret.
 */
export class TeamExtensionRefusal extends Error {
  readonly status = 403;

  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "TeamExtensionRefusal";
  }
}

export function isTeamExtensionRefusal(
  error: unknown,
): error is TeamExtensionRefusal {
  return error instanceof TeamExtensionRefusal;
}

/**
 * The fixed package's own two team-member operations, bound to the ALS store
 * the executor installed. `add` is the pinned `findOrCreateTeamMember` (it
 * computes the membership key, reuses an existing pair and keeps the team's
 * memberCount in sync); `remove` is the pinned `removeTeamMember` (deleteMany
 * on the pair plus the seat release). Neither takes a session: authority was
 * decided before the capability was issued.
 */
export interface FixedTeamMemberCommands {
  add(input: {
    readonly teamId: string;
    readonly userId: string;
  }): Promise<void>;
  remove(input: {
    readonly teamId: string;
    readonly userId: string;
  }): Promise<void>;
}

/** The pinned organization-plugin adapter resolver, restricted to the two ops. */
export function createFixedVersionTeamMemberCommands(
  context: Parameters<typeof getOrgAdapter>[0],
  options: Parameters<typeof getOrgAdapter>[1] = { teams: { enabled: true } },
): FixedTeamMemberCommands {
  if (options?.teams?.enabled !== true) {
    throw new Error(
      "TEAM_EXTENSION_REQUIRES_TEAMS: the fixed organization plugin must be configured with teams.enabled; the two pinned team-member helpers do not exist otherwise, and the caller's own resolved options must be the ones the helper sees (schema additionalFields included)",
    );
  }
  const adapter = getOrgAdapter(context, options);
  return {
    async add({ teamId, userId }) {
      await adapter.findOrCreateTeamMember({ teamId, userId });
    },
    async remove({ teamId, userId }) {
      await adapter.removeTeamMember({ teamId, userId });
    },
  };
}

/** Everything the lock-time planner has already verified for one command. */
export interface TeamMutationCapabilityRequest {
  readonly commandId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly actor: DirectoryActor;
  readonly targetUserId: string;
  readonly action: TeamMutationCapability["action"];
  readonly authority: TeamCommandAuthority;
}

interface CapabilityBinding {
  /** `txid_current()` of the transaction the capability was issued in. */
  readonly transactionId: string;
  /** The executor's ALS store object; identity is the binding. */
  readonly store: object;
  consumed: boolean;
}

const bindings = new WeakMap<TeamMutationCapability, CapabilityBinding>();

const ACTIONS = ["team.member.add", "team.member.remove"] as const;
const ACTOR_KINDS = [
  "session",
  "platform",
  "scim",
  "jit",
  "migration",
] as const;

function invalid(detail: string): TeamExtensionRefusal {
  return new TeamExtensionRefusal(TEAM_CAPABILITY_INVALID, detail);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalid(`${field} must be a non-empty string`);
  }
  return value;
}

/** A `Version` is a non-negative safe integer (interfaces §2); no wrapping. */
function requireVersion(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(
      `${field} must be a non-negative safe integer (Version); refusing rather than wrapping`,
    );
  }
  return value;
}

function requireActor(actor: DirectoryActor): void {
  const kind = requireText(actor?.kind, "actor.kind");
  if (!ACTOR_KINDS.includes(kind as (typeof ACTOR_KINDS)[number])) {
    throw invalid(`actor.kind "${kind}" is not a directory actor kind`);
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
    requireVersion(
      actor.provisioning.ruleRevision,
      "actor.provisioning.ruleRevision",
    );
    requireText(
      actor.provisioning.sourceSubject,
      "actor.provisioning.sourceSubject",
    );
  }
}

function requireAuthority(
  authority: TeamCommandAuthority,
  actor: DirectoryActor,
): void {
  switch (authority?.kind) {
    case "company-role": {
      if (authority.role !== "owner" && authority.role !== "admin") {
        throw invalid(
          `company-role authority must name owner or admin, not "${authority.role}"`,
        );
      }
      requireVersion(authority.memberEpoch, "authority.memberEpoch");
      requireVersion(
        authority.companyGeneration,
        "authority.companyGeneration",
      );
      if (actor.provisioning) {
        throw invalid(
          "a company-role capability must not carry provisioning evidence",
        );
      }
      return;
    }
    case "team-grant": {
      requireText(authority.grantId, "authority.grantId");
      requireVersion(authority.grantGeneration, "authority.grantGeneration");
      if (actor.provisioning) {
        throw invalid(
          "a team-grant capability must not carry provisioning evidence",
        );
      }
      return;
    }
    case "provisioning-rule": {
      requireText(authority.bindingId, "authority.bindingId");
      requireText(authority.eventId, "authority.eventId");
      requireText(authority.ruleId, "authority.ruleId");
      requireVersion(authority.ruleRevision, "authority.ruleRevision");
      const provisioning = actor.provisioning;
      if (
        !provisioning ||
        provisioning.eventId !== authority.eventId ||
        provisioning.ruleId !== authority.ruleId ||
        provisioning.ruleRevision !== authority.ruleRevision ||
        actor.bindingId !== authority.bindingId
      ) {
        throw invalid(
          "a provisioning-rule capability must match the actor's verified binding/event/rule/revision exactly; a placeholder grant or an unverified exemption is never evidence",
        );
      }
      return;
    }
    default:
      throw invalid(
        `authority.kind "${(authority as { kind?: unknown })?.kind}" is not a team command authority`,
      );
  }
}

function validateRequest(request: TeamMutationCapabilityRequest): void {
  requireText(request.commandId, "commandId");
  requireText(request.tenantId, "tenantId");
  requireText(request.workspaceId, "workspaceId");
  requireText(request.teamId, "teamId");
  requireText(request.targetUserId, "targetUserId");
  if (!ACTIONS.includes(request.action)) {
    throw invalid(`action "${request.action}" is not a team member action`);
  }
  requireActor(request.actor);
  requireAuthority(request.authority, request.actor);
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * The transaction's own identity. `txid_current()` is stable for the whole
 * transaction and is assigned by the first statement, so two calls inside one
 * transaction agree, and a call in another transaction does not.
 */
async function currentTransactionId(tx: DirectoryTx): Promise<string> {
  const rows = rowsOf<{ txid: unknown }>(
    await tx.execute(sql`select txid_current() as txid`),
  );
  const txid = rows[0]?.txid;
  if (txid === undefined || txid === null) {
    throw new TeamExtensionRefusal(
      TEAM_CAPABILITY_WITHOUT_TRANSACTION_BINDING,
      "the transaction reported no txid_current(); a capability exists only inside an open directory transaction",
    );
  }
  return String(txid);
}

async function executorStore(): Promise<object | undefined> {
  const store = (await getCurrentDBAdapterAsyncLocalStorage()).getStore();
  if (store?.isTransactionActive !== true) return undefined;
  return store;
}

/**
 * The one capability constructor. Call it inside the executor's transaction,
 * inside the same `TransactionBoundBa.run` that will consume it, after the
 * lock-time authority re-verification. The returned object is frozen and
 * registered; no other code can create a value this module will accept.
 */
export async function issueTeamMutationCapability(
  tx: DirectoryTx,
  request: TeamMutationCapabilityRequest,
): Promise<TeamMutationCapability> {
  validateRequest(request);
  const store = await executorStore();
  if (!store) {
    throw new TeamExtensionRefusal(
      TEAM_CAPABILITY_WITHOUT_TRANSACTION_BINDING,
      "a team mutation capability may only be issued inside the executor's TransactionBoundBa.run; issuing it outside the transaction-bound store would let the command write on the pool or in another transaction",
    );
  }
  const transactionId = await currentTransactionId(tx);
  const capability: TeamMutationCapability = Object.freeze({
    commandId: request.commandId,
    tenantId: request.tenantId,
    workspaceId: request.workspaceId,
    teamId: request.teamId,
    actor: Object.freeze({
      ...request.actor,
      provisioning: request.actor.provisioning
        ? Object.freeze({ ...request.actor.provisioning })
        : null,
    }),
    targetUserId: request.targetUserId,
    action: request.action,
    authority: Object.freeze({ ...request.authority }),
  });
  bindings.set(capability, { transactionId, store, consumed: false });
  return capability;
}

/**
 * The extension. `commands` is the private seam over the fixed package; the
 * returned object is the frozen ScopedTeamExtension interface, so callers can
 * neither reach the adapter directly nor pass a team of their own choosing.
 */
export function createScopedTeamExtension(options: {
  readonly commands: FixedTeamMemberCommands;
}): ScopedTeamExtension {
  async function consume(
    expectedAction: TeamMutationCapability["action"],
    tx: DirectoryTx,
    capability: TeamMutationCapability,
    userId: string,
  ): Promise<{ teamId: string; userId: string }> {
    const binding = bindings.get(capability);
    if (!binding) {
      throw new TeamExtensionRefusal(
        TEAM_CAPABILITY_NOT_ISSUED,
        "the team mutation capability was not issued by issueTeamMutationCapability; object literals, deserialized payloads and casts are not capabilities",
      );
    }
    if (binding.consumed) {
      throw new TeamExtensionRefusal(
        TEAM_CAPABILITY_ALREADY_CONSUMED,
        `command ${capability.commandId} already spent its ${capability.action} capability; a capability is single-use and a replay before DML is refused`,
      );
    }
    if (capability.action !== expectedAction) {
      throw new TeamExtensionRefusal(
        TEAM_CAPABILITY_ACTION_MISMATCH,
        `the capability was issued for ${capability.action}, not ${expectedAction}`,
      );
    }
    if (capability.targetUserId !== userId) {
      throw new TeamExtensionRefusal(
        TEAM_CAPABILITY_TARGET_MISMATCH,
        `the capability targets ${capability.targetUserId}; refusing to affect a different user`,
      );
    }
    const store = await executorStore();
    if (!store || store !== binding.store) {
      throw new TeamExtensionRefusal(
        TEAM_CAPABILITY_WITHOUT_TRANSACTION_BINDING,
        "the capability was issued in a different executor run; a capability never crosses requests, and consuming it outside TransactionBoundBa.run would write on the pool",
      );
    }
    const transactionId = await currentTransactionId(tx);
    if (transactionId !== binding.transactionId) {
      throw new TeamExtensionRefusal(
        TEAM_CAPABILITY_TRANSACTION_MISMATCH,
        `the capability is bound to transaction ${binding.transactionId}, not ${transactionId}; a capability never crosses transactions`,
      );
    }
    // Single use is claimed before the write: a failed command must not leave
    // a capability that a retry can spend again.
    binding.consumed = true;
    return { teamId: capability.teamId, userId: capability.targetUserId };
  }

  return {
    async add(tx, capability, userId) {
      const command = await consume("team.member.add", tx, capability, userId);
      await options.commands.add(command);
    },
    async remove(tx, capability, userId) {
      const command = await consume(
        "team.member.remove",
        tx,
        capability,
        userId,
      );
      await options.commands.remove(command);
    },
  };
}

// ---------------------------------------------------------------------------
// T04.08 (#552, P09) — the team.member.add / team.member.remove directory
// command handlers: the capability's only consumption path.
// ---------------------------------------------------------------------------

/*
 * What this section owns, and nothing else:
 *
 * 1. The locked authority discrimination (interfaces §3: 团队能力构造器在锁内
 *    按 actor 选择唯一 authority 分支). Both `authorize` and `sync` run the
 *    SAME resolution inside the executor's transaction — `authorize` is what a
 *    replay re-runs (a revoked grant can never borrow a success receipt), and
 *    `sync` re-derives the authority it then freezes into the capability,
 *    because no verified fact crosses the two phases except through this
 *    transaction's own reads:
 *
 *    - company-role: the actor's live auth_members row in this company reads
 *      owner/admin; the authority carries the actor's business-membership
 *      epoch and company eligibility generation, both read here.
 *    - team-grant: the actor's principal holds the one stable grant row for
 *      (tenant, workspace), that row is active, names this exact team, covers
 *      this exact action, and the grantee's CURRENT identity / company / team
 *      eligibility generations equal the snapshots the grant was issued with
 *      (design §4.4: 适用授权保存签发时的代际并在使用时比较) — a suspended
 *      member, a re-keyed identity or an advanced clock makes the grant's
 *      basis stale and the command is refused, never grandfathered.
 *    - provisioning-rule: NOT wired here — P12 owns the provisioning ingress;
 *      a scim/jit actor's team-member command is refused by name in this
 *      deployment rather than approximated (disclosed in the task report).
 *
 * 2. The target and state re-verification, in the same lock: the target user
 *    resolves to an active principal with an active company membership and a
 *    BA member row (team.member.add never creates a company member, never
 *    changes a role, never invites an outsider), and the pair state must
 *    admit the operation — add refuses an existing pair (409), remove refuses
 *    a missing one (404), so a duplicate/missing DML never reaches the guard.
 *    Capacity: adding a team member consumes no company seat (the target
 *    already holds one — the company-seat capacity check lives in
 *    invitation.accept); the per-team counter stays the pinned adapter's own
 *    memberCount discipline, enforced by the 0216 guard in this same
 *    transaction; per-plan quota enforcement is T07.03's separate read.
 *
 * 3. The single internal capability, precisely bound to the target: sync
 *    issues it (the only constructor) and immediately consumes it through the
 *    ScopedTeamExtension — issuance requires this transaction's
 *    TransactionBoundBa store, which is exactly where the executor runs
 *    `sync`, and consumption refuses a cross-request, cross-transaction,
 *    cross-target or second spend before any DML.
 */

/** The handler's refusal codes — each carries its own HTTP status. */
export const TEAM_MEMBER_ACTOR_FORBIDDEN = "TEAM_MEMBER_ACTOR_FORBIDDEN";
export const TEAM_MEMBER_COMPANY_NOT_FOUND = "TEAM_MEMBER_COMPANY_NOT_FOUND";
export const TEAM_MEMBER_COMPANY_CLOSED = "TEAM_MEMBER_COMPANY_CLOSED";
export const TEAM_MEMBER_TEAM_UNBOUND = "TEAM_MEMBER_TEAM_UNBOUND";
export const TEAM_MEMBER_TARGET_NOT_COMPANY_MEMBER =
  "TEAM_MEMBER_TARGET_NOT_COMPANY_MEMBER";
export const TEAM_MEMBER_ALREADY_MEMBER = "TEAM_MEMBER_ALREADY_MEMBER";
export const TEAM_MEMBER_NOT_A_MEMBER = "TEAM_MEMBER_NOT_A_MEMBER";
export const TEAM_MEMBER_GRANT_REQUIRED = "TEAM_MEMBER_GRANT_REQUIRED";
export const TEAM_MEMBER_GRANT_NOT_COVERING = "TEAM_MEMBER_GRANT_NOT_COVERING";
export const TEAM_MEMBER_GRANT_STALE = "TEAM_MEMBER_GRANT_STALE";

/** A team-member command refusal (interfaces §4: refusal → projection). */
export class TeamMemberRefusal extends Error {
  readonly status: 403 | 404 | 409;

  constructor(
    readonly code: string,
    detail: string,
    status: 403 | 404 | 409,
  ) {
    super(`${code}: ${detail}`);
    this.name = "TeamMemberRefusal";
    this.status = status;
  }
}

export function isTeamMemberRefusal(
  error: unknown,
): error is TeamMemberRefusal {
  return error instanceof TeamMemberRefusal;
}

function memberRefusal(
  code: string,
  detail: string,
  status: 403 | 404 | 409,
): TeamMemberRefusal {
  return new TeamMemberRefusal(code, detail, status);
}

/** Everything the locked discrimination resolved for one command. */
interface TeamMemberResolution {
  readonly teamId: string;
  readonly targetUserId: string;
  readonly authority: TeamCommandAuthority;
}

/** The command's team: the workspace's binding inside this exact company. */
async function resolveBoundTeam(
  tx: DirectoryTx,
  tenantId: string,
  workspaceId: string,
): Promise<string> {
  const [tenant] = rowsOf<{ status: string }>(
    await tx.execute(
      sql`SELECT status FROM enterprise_tenants WHERE id = ${tenantId} LIMIT 1`,
    ),
  );
  if (!tenant) {
    throw memberRefusal(
      TEAM_MEMBER_COMPANY_NOT_FOUND,
      `company ${tenantId} does not exist; the command answers not-found rather than inventing a directory`,
      404,
    );
  }
  if (String(tenant.status) !== "active") {
    throw memberRefusal(
      TEAM_MEMBER_COMPANY_CLOSED,
      `company ${tenantId} is ${String(tenant.status)}; a suspended or provisioning company's team-member commands are refused`,
      403,
    );
  }
  const [binding] = rowsOf<{ team_id: string }>(
    await tx.execute(
      sql`SELECT b.team_id FROM auth_team_bindings b
           JOIN auth_teams t ON t.id = b.team_id AND t.organization_id = b.tenant_id
           WHERE b.workspace_id = ${workspaceId} AND b.tenant_id = ${tenantId}
           LIMIT 1`,
    ),
  );
  if (!binding) {
    throw memberRefusal(
      TEAM_MEMBER_TEAM_UNBOUND,
      `workspace ${workspaceId} is not bound to a team of company ${tenantId}; another company's workspace is answered exactly like a missing one`,
      404,
    );
  }
  return String(binding.team_id);
}

/** One principal's live identity generation and status, or null. */
async function readPrincipal(
  tx: DirectoryTx,
  principalId: string,
): Promise<{ status: string; identityGeneration: number } | null> {
  const [row] = rowsOf<{ status: string; identity_generation: number }>(
    await tx.execute(
      sql`SELECT status, identity_generation FROM enterprise_principals
           WHERE id = ${principalId} LIMIT 1`,
    ),
  );
  return row
    ? {
        status: String(row.status),
        identityGeneration: Number(row.identity_generation),
      }
    : null;
}

/** One principal's live business membership in one company, or null. */
async function readMembership(
  tx: DirectoryTx,
  tenantId: string,
  principalId: string,
): Promise<{ status: string; epoch: number } | null> {
  const [row] = rowsOf<{ status: string; epoch: number }>(
    await tx.execute(
      sql`SELECT status, epoch FROM enterprise_memberships
           WHERE tenant_id = ${tenantId} AND principal_id = ${principalId} LIMIT 1`,
    ),
  );
  return row ? { status: String(row.status), epoch: Number(row.epoch) } : null;
}

/** One principal's live eligibility clock at one scope, or null. */
async function readClock(
  tx: DirectoryTx,
  tenantId: string,
  principalId: string,
  kind: "company" | "team",
  scopeId: string,
): Promise<{ generation: number; tombstone: boolean } | null> {
  const [row] = rowsOf<{ generation: number | null; tombstone: boolean }>(
    await tx.execute(
      sql`SELECT generation, tombstone FROM auth_eligibility_clocks
           WHERE tenant_id = ${tenantId} AND principal_id = ${principalId}
             AND kind = ${kind} AND scope_id = ${scopeId} LIMIT 1`,
    ),
  );
  if (!row || row.generation === null) return null;
  return { generation: Number(row.generation), tombstone: row.tombstone };
}

/**
 * The company-role branch (interfaces §3): the actor's live BA member row in
 * this company reads owner/admin, and the authority carries the actor's
 * business-membership epoch plus the live, untombstoned company eligibility
 * generation — an unverifiable clock is a refusal, never a default.
 */
async function companyRoleAuthority(
  tx: DirectoryTx,
  actor: DirectoryActor,
  principalId: string,
  tenantId: string,
  role: "owner" | "admin",
): Promise<TeamCommandAuthority> {
  const membership = await readMembership(tx, tenantId, principalId);
  if (membership?.status !== "active") {
    throw memberRefusal(
      TEAM_MEMBER_ACTOR_FORBIDDEN,
      `the business membership of user ${actor.userId} in company ${tenantId} is ${membership?.status ?? "missing"}; a suspended member's company-role team commands are closed`,
      403,
    );
  }
  const clock = await readClock(tx, tenantId, principalId, "company", tenantId);
  if (!clock || clock.tombstone) {
    throw memberRefusal(
      TEAM_MEMBER_ACTOR_FORBIDDEN,
      `the company eligibility clock of user ${actor.userId} in company ${tenantId} is ${clock ? "tombstoned" : "missing"}; an unverifiable generation is a refusal, never a default`,
      403,
    );
  }
  return {
    kind: "company-role",
    role,
    memberEpoch: membership.epoch as Version,
    companyGeneration: clock.generation as Version,
  };
}

/**
 * The team-grant branch (interfaces §3, design §4.4): the actor's principal
 * holds the one stable grant row for (tenant, workspace); the row is active,
 * names this exact team and covers this exact action; and the grantee's
 * CURRENT identity/company/team generations equal the snapshots the grant was
 * issued with — the grantee must still be an active company member with a
 * live seat in that team. Any drift refuses by name; a revoked or re-keyed
 * basis never silently authorizes.
 */
async function teamGrantAuthority(
  tx: DirectoryTx,
  actor: DirectoryActor,
  principalId: string,
  tenantId: string,
  workspaceId: string,
  teamId: string,
  action: TeamMutationCapability["action"],
): Promise<TeamCommandAuthority> {
  const [grant] = await tx
    .select({
      grantId: authTeamManagementGrants.grantId,
      teamId: authTeamManagementGrants.teamId,
      actions: authTeamManagementGrants.actions,
      generation: authTeamManagementGrants.generation,
      identityGeneration: authTeamManagementGrants.identityGeneration,
      companyGeneration: authTeamManagementGrants.companyGeneration,
      teamGeneration: authTeamManagementGrants.teamGeneration,
      status: authTeamManagementGrants.status,
    })
    .from(authTeamManagementGrants)
    .where(
      and(
        eq(authTeamManagementGrants.tenantId, tenantId),
        eq(authTeamManagementGrants.workspaceId, workspaceId),
        eq(authTeamManagementGrants.principalId, principalId),
      ),
    )
    .limit(1);
  if (!grant) {
    throw memberRefusal(
      TEAM_MEMBER_GRANT_REQUIRED,
      `user ${actor.userId} holds no team management grant on workspace ${workspaceId} of company ${tenantId} and no owner/admin role; a plain member's team-member command is refused`,
      403,
    );
  }
  if (
    grant.status !== "active" ||
    grant.teamId !== teamId ||
    !(grant.actions ?? []).includes(action)
  ) {
    throw memberRefusal(
      TEAM_MEMBER_GRANT_NOT_COVERING,
      `grant ${grant.grantId} does not cover ${action} on team ${teamId} (status ${grant.status}, team ${grant.teamId}, actions ${(grant.actions ?? []).join(",")}); the exact live grant is the only authority`,
      403,
    );
  }
  const principal = await readPrincipal(tx, principalId);
  const membership = await readMembership(tx, tenantId, principalId);
  const companyClock = await readClock(
    tx,
    tenantId,
    principalId,
    "company",
    tenantId,
  );
  const teamClock = await readClock(
    tx,
    tenantId,
    principalId,
    "team",
    workspaceId,
  );
  const [seat] = rowsOf<{ user_id: string }>(
    await tx.execute(
      sql`SELECT user_id FROM auth_team_members
           WHERE team_id = ${teamId} AND user_id = ${actor.userId} LIMIT 1`,
    ),
  );
  if (
    principal?.status !== "active" ||
    principal.identityGeneration !== Number(grant.identityGeneration) ||
    !membership ||
    membership.status !== "active" ||
    !companyClock ||
    companyClock.tombstone ||
    companyClock.generation !== Number(grant.companyGeneration) ||
    !teamClock ||
    teamClock.tombstone ||
    teamClock.generation !== Number(grant.teamGeneration) ||
    !seat
  ) {
    throw memberRefusal(
      TEAM_MEMBER_GRANT_STALE,
      `grant ${grant.grantId} was issued against identity/company/team generations ${Number(grant.identityGeneration)}/${Number(grant.companyGeneration)}/${Number(grant.teamGeneration)} with a live seat, and the current facts no longer match; a stale grant basis refuses, only a fresh grant authorizes`,
      403,
    );
  }
  return {
    kind: "team-grant",
    grantId: grant.grantId,
    grantGeneration: Number(grant.generation) as Version,
  };
}

/**
 * The locked discrimination both phases run: company + team resolution, the
 * actor's unique authority branch, then the target and pair-state
 * re-verification. The actor is the server-issued envelope identity — never a
 * client field — and a scim/jit/migration actor is refused here: the
 * provisioning-rule branch arrives with P12's ingress wiring.
 */
async function resolveTeamMemberCommand(
  tx: DirectoryTx,
  actor: DirectoryActor,
  principal: PrincipalRef | null,
  tenantId: string,
  workspaceId: string,
  targetUserId: string,
  action: TeamMutationCapability["action"],
): Promise<TeamMemberResolution> {
  const teamId = await resolveBoundTeam(tx, tenantId, workspaceId);

  if (
    (actor.kind !== "session" && actor.kind !== "platform") ||
    !actor.userId ||
    !principal
  ) {
    throw memberRefusal(
      TEAM_MEMBER_ACTOR_FORBIDDEN,
      `a ${actor.kind} actor cannot run ${action} through this handler; the provisioning-rule branch is P12's wiring, and an actor without a verifiable user/principal pair has no authority to discriminate`,
      403,
    );
  }
  const actorPrincipal = await readPrincipal(tx, principal.principalId);
  if (actorPrincipal?.status !== "active") {
    throw memberRefusal(
      TEAM_MEMBER_ACTOR_FORBIDDEN,
      `the principal behind user ${actor.userId} is ${actorPrincipal?.status ?? "missing"}; a disabled identity's team-member commands are closed`,
      403,
    );
  }
  const [actorMember] = rowsOf<{ role: string }>(
    await tx.execute(
      sql`SELECT role FROM auth_members
           WHERE organization_id = ${tenantId} AND user_id = ${actor.userId} LIMIT 1`,
    ),
  );
  const role = actorMember ? String(actorMember.role) : null;
  const authority =
    role === "owner" || role === "admin"
      ? await companyRoleAuthority(
          tx,
          actor,
          principal.principalId,
          tenantId,
          role,
        )
      : await teamGrantAuthority(
          tx,
          actor,
          principal.principalId,
          tenantId,
          workspaceId,
          teamId,
          action,
        );

  // The target: an existing active company member — add never creates the
  // company membership, never sets a role, never invites an outsider.
  const [targetPrincipal] = rowsOf<{ id: string; status: string }>(
    await tx.execute(
      sql`SELECT id, status FROM enterprise_principals
           WHERE user_id = ${targetUserId} LIMIT 1`,
    ),
  );
  if (!targetPrincipal) {
    throw memberRefusal(
      TEAM_MEMBER_TARGET_NOT_COMPANY_MEMBER,
      `no principal names user ${targetUserId}; another company's member and a fabricated id are answered identically`,
      404,
    );
  }
  const [targetMember] = rowsOf<{ user_id: string }>(
    await tx.execute(
      sql`SELECT user_id FROM auth_members
           WHERE organization_id = ${tenantId} AND user_id = ${targetUserId} LIMIT 1`,
    ),
  );
  if (action === "team.member.add") {
    const targetMembership = await readMembership(
      tx,
      tenantId,
      String(targetPrincipal.id),
    );
    if (
      String(targetPrincipal.status) !== "active" ||
      !targetMembership ||
      targetMembership.status !== "active" ||
      !targetMember
    ) {
      throw memberRefusal(
        TEAM_MEMBER_TARGET_NOT_COMPANY_MEMBER,
        `user ${targetUserId} is not an active member of company ${tenantId}; team.member.add only seats an existing active company member`,
        404,
      );
    }
    const [existing] = rowsOf<{ user_id: string }>(
      await tx.execute(
        sql`SELECT user_id FROM auth_team_members
             WHERE team_id = ${teamId} AND user_id = ${targetUserId} LIMIT 1`,
      ),
    );
    if (existing) {
      throw memberRefusal(
        TEAM_MEMBER_ALREADY_MEMBER,
        `user ${targetUserId} is already a member of team ${teamId}; a duplicate seat is a conflict, never a silent no-op`,
        409,
      );
    }
  } else {
    const [existing] = rowsOf<{ user_id: string }>(
      await tx.execute(
        sql`SELECT user_id FROM auth_team_members
             WHERE team_id = ${teamId} AND user_id = ${targetUserId} LIMIT 1`,
      ),
    );
    if (!existing || !targetMember) {
      throw memberRefusal(
        TEAM_MEMBER_NOT_A_MEMBER,
        `user ${targetUserId} is not a member of team ${teamId}; removing a non-member is answered exactly like a missing row`,
        404,
      );
    }
  }
  return { teamId, targetUserId, authority };
}

/**
 * The two handlers the assembly registers as `team.member.add` /
 * `team.member.remove`. The executor owns the envelope, the locks, the receipt
 * and the finalizer; these handlers own the locked discrimination above and
 * the one capability consumption — issued and spent inside the same
 * TransactionBoundBa run the executor wraps `sync` in, so a refused command
 * performs no DML at all and a replay never re-spends.
 */
export function createScopedTeamMemberHandlers(deps: {
  readonly extension: ScopedTeamExtension;
}): Partial<Record<DirectoryOperation, DirectoryCommandHandler>> {
  if (
    typeof deps?.extension?.add !== "function" ||
    typeof deps?.extension?.remove !== "function"
  ) {
    throw new Error(
      "TEAM_MEMBER_HANDLERS_DEPS_REQUIRED: createScopedTeamMemberHandlers needs the ScopedTeamExtension; without the capability-consuming seam there is no team-member write",
    );
  }
  const extension = deps.extension;

  function handlerFor(
    action: TeamMutationCapability["action"],
  ): DirectoryCommandHandler {
    return {
      async authorize(context) {
        const payload = context.command.payload as {
          readonly workspaceId?: string;
          readonly userId?: string;
        };
        if (
          typeof payload.workspaceId !== "string" ||
          payload.workspaceId.trim() === "" ||
          typeof payload.userId !== "string" ||
          payload.userId.trim() === ""
        ) {
          throw memberRefusal(
            TEAM_MEMBER_TARGET_NOT_COMPANY_MEMBER,
            `${action} requires a workspaceId and a userId`,
            404,
          );
        }
        await resolveTeamMemberCommand(
          context.tx,
          context.actor,
          context.principal,
          context.command.tenantId,
          payload.workspaceId,
          payload.userId,
          action,
        );
      },
      async sync(context): Promise<DirectoryCommandOutcome> {
        const payload = context.command.payload as {
          readonly workspaceId: string;
          readonly userId: string;
        };
        const resolution = await resolveTeamMemberCommand(
          context.tx,
          context.actor,
          context.principal,
          context.command.tenantId,
          payload.workspaceId,
          payload.userId,
          action,
        );
        const capability = await issueTeamMutationCapability(context.tx, {
          commandId: context.commandId,
          tenantId: context.command.tenantId,
          workspaceId: payload.workspaceId,
          teamId: resolution.teamId,
          actor: context.actor,
          targetUserId: resolution.targetUserId,
          action,
          authority: resolution.authority,
        });
        if (action === "team.member.add") {
          await extension.add(context.tx, capability, resolution.targetUserId);
        } else {
          await extension.remove(
            context.tx,
            capability,
            resolution.targetUserId,
          );
        }
        return {
          workspaceId: payload.workspaceId,
          ...(resolution.authority.kind === "team-grant"
            ? {
                grantId: resolution.authority.grantId,
                grantGeneration: resolution.authority.grantGeneration,
              }
            : {}),
        };
      },
    };
  }

  return {
    "team.member.add": handlerFor("team.member.add"),
    "team.member.remove": handlerFor("team.member.remove"),
  };
}
