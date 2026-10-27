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

import { randomUUID } from "node:crypto";
import { getCurrentDBAdapterAsyncLocalStorage } from "@better-auth/core/context";
import { getOrgAdapter } from "better-auth/plugins/organization";
import { and, eq, sql } from "drizzle-orm";
import { authTeamManagementGrants } from "../../db/schema/auth-directory";
import type {
  Directory,
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
 *    - provisioning-rule (T05.06 / P12): the event's ruleId/revision are
 *      matched against the approved rule row of the actor's verified binding
 *      inside this same lock — the row's company, binding, approval status
 *      and fixed workspace targets are the only authority, and the row's
 *      minimum role stays "member" (a directory group never yields owner/
 *      admin or a delegable management Grant).
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
 * client field — a migration actor is refused here; the scim/jit
 * provisioning-rule branch is wired (T05.06 / P12).
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

  if (!actor.userId || !principal) {
    throw memberRefusal(
      TEAM_MEMBER_ACTOR_FORBIDDEN,
      `an actor without a verifiable user/principal pair cannot run ${action}; the server-issued identity envelope is the only thing this handler discriminates`,
      403,
    );
  }
  if (
    actor.kind !== "session" &&
    actor.kind !== "platform" &&
    actor.kind !== "scim" &&
    actor.kind !== "jit"
  ) {
    throw memberRefusal(
      TEAM_MEMBER_ACTOR_FORBIDDEN,
      `a ${actor.kind} actor cannot run ${action} through this handler; only a signed-in company identity or a verified directory event holds team-member authority`,
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
  /*
   * The P12 branch (T05.06, design §9's approved-group-rule row): a scim/jit
   * event actor resolves its authority from the approved rule row its
   * verified evidence names — binding, rule id/revision, approval status and
   * the fixed workspace targets are re-verified in this same lock, and the
   * single-use capability below carries exactly that authority (a company
   * role is never granted from a directory group, and no team-management
   * Grant is delegated).
   */
  const authority =
    actor.kind === "scim" || actor.kind === "jit"
      ? await provisioningRuleAuthority(tx, actor, tenantId, workspaceId)
      : role === "owner" || role === "admin"
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

/*
 * ---------------------------------------------------------------------------
 * T05.06（#562 / P12）：批准组规则 → 单次团队能力 + 规则命令
 *
 * 设计 §9 组规则行的合同：管理员批准的持久规则是已验证 binding 事件的常设
 * 权威。每个事件在 tenant 锁内重新核验 binding、rule id/revision、批准状态
 * 与固定目标（provisioningRuleAuthority，上面 resolveTeamMemberCommand 的
 * scim/jit 分支），然后签发 tx/command/target 绑定的单次能力；规则的批准/
 * 撤销由公司管理面经受控命令调用（createProvisioningRuleHandlers），固定
 * binding 属于目标公司，scim/jit actor 无规则批准权。规则变化推进
 * revision，旧能力和事件重试须重验；撤销阻止后续 provisioning 写，既有成员
 * 资格的移除走明确受控成员命令（member.remove / team.member.remove）。
 * ---------------------------------------------------------------------------
 */

export const PROVISIONING_RULE_ACTOR_FORBIDDEN =
  "PROVISIONING_RULE_ACTOR_FORBIDDEN";
export const PROVISIONING_RULE_COMPANY_NOT_FOUND =
  "PROVISIONING_RULE_COMPANY_NOT_FOUND";
export const PROVISIONING_RULE_COMPANY_CLOSED =
  "PROVISIONING_RULE_COMPANY_CLOSED";
export const PROVISIONING_RULE_BINDING_UNKNOWN =
  "PROVISIONING_RULE_BINDING_UNKNOWN";
export const PROVISIONING_RULE_BINDING_FOREIGN =
  "PROVISIONING_RULE_BINDING_FOREIGN";
export const PROVISIONING_RULE_WORKSPACE_FOREIGN =
  "PROVISIONING_RULE_WORKSPACE_FOREIGN";
export const PROVISIONING_RULE_WORKSPACE_UNBOUND =
  "PROVISIONING_RULE_WORKSPACE_UNBOUND";
export const PROVISIONING_RULE_NOT_FOUND = "PROVISIONING_RULE_NOT_FOUND";
export const PROVISIONING_RULE_NOT_APPROVED = "PROVISIONING_RULE_NOT_APPROVED";
export const PROVISIONING_RULE_WORKSPACE_NOT_COVERED =
  "PROVISIONING_RULE_WORKSPACE_NOT_COVERED";
export const PROVISIONING_RULE_ALREADY_REVOKED =
  "PROVISIONING_RULE_ALREADY_REVOKED";

/** A rule-command refusal (interfaces §4: refusal → projection). */
export class ProvisioningRuleRefusal extends Error {
  readonly status: 400 | 403 | 404 | 409;

  constructor(
    readonly code: string,
    detail: string,
    status: 400 | 403 | 404 | 409,
  ) {
    super(`${code}: ${detail}`);
    this.name = "ProvisioningRuleRefusal";
    this.status = status;
  }
}

export function isProvisioningRuleRefusal(
  error: unknown,
): error is ProvisioningRuleRefusal {
  return error instanceof ProvisioningRuleRefusal;
}

function ruleRefusal(
  code: string,
  detail: string,
  status: 400 | 403 | 404 | 409,
): ProvisioningRuleRefusal {
  return new ProvisioningRuleRefusal(code, detail, status);
}

/** One live rule row, as the event branch reads it inside the lock. */
interface ProvisioningRuleRow {
  readonly ruleId: string;
  readonly tenantId: string;
  readonly bindingId: string;
  readonly externalGroup: string | null;
  readonly workspaceIds: readonly string[];
  readonly revision: number;
  readonly status: string;
  readonly minimumRole: string;
}

async function readRuleByEvent(
  tx: DirectoryTx,
  ruleId: string,
): Promise<ProvisioningRuleRow | null> {
  const [row] = rowsOf<{
    rule_id: string;
    tenant_id: string;
    binding_id: string;
    external_group: string | null;
    workspace_ids: string[] | null;
    revision: number;
    status: string;
    minimum_role: string;
  }>(
    await tx.execute(
      sql`SELECT rule_id, tenant_id, binding_id, external_group, workspace_ids,
                 revision::int AS revision, status, minimum_role
            FROM auth_provisioning_rules WHERE rule_id = ${ruleId} LIMIT 1`,
    ),
  );
  if (!row) return null;
  return {
    ruleId: String(row.rule_id),
    tenantId: String(row.tenant_id),
    bindingId: String(row.binding_id),
    externalGroup:
      row.external_group === null ? null : String(row.external_group),
    workspaceIds: (row.workspace_ids ?? []).map(String),
    revision: Number(row.revision),
    status: String(row.status),
    minimumRole: String(row.minimum_role),
  };
}

/**
 * The event authority (interfaces §3's provisioning-rule branch): the actor's
 * verified evidence names one rule row, and the row must be exactly what the
 * evidence says — same company, same binding, same revision, approved, and
 * the minimum member role. Any drift refuses; a revoked or re-approved rule
 * never lends its old revision to a later event.
 */
async function provisioningRuleAuthority(
  tx: DirectoryTx,
  actor: DirectoryActor,
  tenantId: string,
  workspaceId: string,
): Promise<TeamCommandAuthority> {
  const provisioning = actor.provisioning;
  if (!provisioning || !actor.bindingId) {
    throw memberRefusal(
      TEAM_MEMBER_ACTOR_FORBIDDEN,
      `a ${actor.kind} actor without its verified binding and provisioning event cannot run a team-member command; the evidence is the server's mint, never a client field`,
      403,
    );
  }
  const rule = await readRuleByEvent(tx, provisioning.ruleId);
  if (
    !rule ||
    rule.tenantId !== tenantId ||
    rule.bindingId !== actor.bindingId ||
    rule.revision !== provisioning.ruleRevision ||
    rule.status !== "approved"
  ) {
    throw memberRefusal(
      PROVISIONING_RULE_NOT_APPROVED,
      `the event's provisioning evidence names rule ${provisioning.ruleId} revision ${provisioning.ruleRevision} of binding ${actor.bindingId}, and that is not company ${tenantId}'s approved rule at that revision; a revoked or re-approved rule never lends its old authority`,
      403,
    );
  }
  if (rule.minimumRole !== "member") {
    throw memberRefusal(
      PROVISIONING_RULE_NOT_APPROVED,
      `rule ${rule.ruleId} carries minimum role "${rule.minimumRole}"; an approved group rule holds the minimum member role only, and a directory group never yields a management authority`,
      403,
    );
  }
  if (!rule.workspaceIds.includes(workspaceId)) {
    throw memberRefusal(
      PROVISIONING_RULE_WORKSPACE_NOT_COVERED,
      `workspace ${workspaceId} is not one of rule ${rule.ruleId}'s fixed targets (${rule.workspaceIds.join(",")}); an approved rule's capability covers exactly the workspaces it names`,
      403,
    );
  }
  return {
    kind: "provisioning-rule",
    bindingId: actor.bindingId,
    eventId: provisioning.eventId,
    ruleId: rule.ruleId,
    ruleRevision: rule.revision,
  };
}

/**
 * The locked owner/admin authorization the two rule commands share (replay
 * included): the company exists and is active, the caller is a live
 * owner/admin member with an active principal and business membership. A
 * scim/jit actor is refused by name — the directory's events consume rules,
 * they never approve them.
 */
async function authorizeRuleCommand(
  tx: DirectoryTx,
  actor: DirectoryActor,
  tenantId: string,
): Promise<void> {
  if (
    (actor.kind !== "session" && actor.kind !== "platform") ||
    !actor.userId
  ) {
    throw ruleRefusal(
      PROVISIONING_RULE_ACTOR_FORBIDDEN,
      `a ${actor.kind} actor cannot manage provisioning rules; provisioning.rule.approve/revoke belong to a current owner or admin of the company, and a directory event actor holds no rule approval authority`,
      403,
    );
  }
  const [tenant] = rowsOf<{ status: string }>(
    await tx.execute(
      sql`SELECT status FROM enterprise_tenants WHERE id = ${tenantId} LIMIT 1`,
    ),
  );
  if (!tenant) {
    throw ruleRefusal(
      PROVISIONING_RULE_COMPANY_NOT_FOUND,
      `company ${tenantId} does not exist; the command answers not-found rather than inventing a directory`,
      404,
    );
  }
  if (String(tenant.status) !== "active") {
    throw ruleRefusal(
      PROVISIONING_RULE_COMPANY_CLOSED,
      `company ${tenantId} is ${String(tenant.status)}; a suspended or provisioning company admits no rule commands`,
      403,
    );
  }
  const [member] = rowsOf<{ role: string }>(
    await tx.execute(
      sql`SELECT role FROM auth_members
           WHERE organization_id = ${tenantId} AND user_id = ${actor.userId} LIMIT 1`,
    ),
  );
  if (!member || !["owner", "admin"].includes(String(member.role))) {
    throw ruleRefusal(
      PROVISIONING_RULE_ACTOR_FORBIDDEN,
      `user ${actor.userId}'s live role in company ${tenantId} is ${member ? `"${String(member.role)}"` : "not a member"}; approving or revoking provisioning rules needs an owner or admin`,
      403,
    );
  }
  const [principalRow] = rowsOf<{ id: string; status: string }>(
    await tx.execute(
      sql`SELECT id, status FROM enterprise_principals WHERE user_id = ${actor.userId} LIMIT 1`,
    ),
  );
  if (!principalRow || String(principalRow.status) !== "active") {
    throw ruleRefusal(
      PROVISIONING_RULE_ACTOR_FORBIDDEN,
      `the principal behind user ${actor.userId} is ${principalRow ? String(principalRow.status) : "missing"}; a disabled identity's rule commands are closed`,
      403,
    );
  }
  const [membership] = rowsOf<{ status: string }>(
    await tx.execute(
      sql`SELECT status FROM enterprise_memberships
           WHERE tenant_id = ${tenantId} AND principal_id = ${principalRow.id} LIMIT 1`,
    ),
  );
  if (!membership || String(membership.status) !== "active") {
    throw ruleRefusal(
      PROVISIONING_RULE_ACTOR_FORBIDDEN,
      `the business membership of user ${actor.userId} in company ${tenantId} is ${membership ? String(membership.status) : "missing"}; a suspended member's rule commands are closed`,
      403,
    );
  }
}

/**
 * The binding a rule hangs on must be one the SERVER already fixed to this
 * company: an SSO provider row whose organizationId is the tenant (the JIT
 * binding) or a SCIM connection binding whose provisioningDomainId is the
 * tenant (the SCIM binding). A binding of another company is a 403, an
 * unknown binding a 404 — a rule never invents its binding.
 */
async function requireCompanyBinding(
  tx: DirectoryTx,
  tenantId: string,
  bindingId: string,
): Promise<void> {
  const [provider] = rowsOf<{ organization_id: string | null }>(
    await tx.execute(
      sql`SELECT organization_id FROM sso_providers WHERE provider_id = ${bindingId} LIMIT 1`,
    ),
  );
  if (provider) {
    if (provider.organization_id !== tenantId) {
      throw ruleRefusal(
        PROVISIONING_RULE_BINDING_FOREIGN,
        `binding ${bindingId} is a provider row fixed to company ${String(provider.organization_id)}, not ${tenantId}; a rule may only hang on this company's own binding`,
        403,
      );
    }
    return;
  }
  const [connection] = rowsOf<{ provisioning_domain_id: string }>(
    await tx.execute(
      sql`SELECT provisioning_domain_id FROM scim_connection_bindings
           WHERE connection_id = ${bindingId} AND decommission_status = 'active' LIMIT 1`,
    ),
  );
  if (connection) {
    if (String(connection.provisioning_domain_id) !== tenantId) {
      throw ruleRefusal(
        PROVISIONING_RULE_BINDING_FOREIGN,
        `binding ${bindingId} is a SCIM connection fixed to company ${String(connection.provisioning_domain_id)}, not ${tenantId}; a rule may only hang on this company's own binding`,
        403,
      );
    }
    return;
  }
  throw ruleRefusal(
    PROVISIONING_RULE_BINDING_UNKNOWN,
    `binding ${bindingId} is not a server-issued binding of company ${tenantId}; the provider↔company binding is the server's fixed row, and a rule never invents one`,
    404,
  );
}

/** One stable rule row by (binding, external group), or null. */
async function readRuleByIdentity(
  tx: DirectoryTx,
  bindingId: string,
  externalGroup: string | null,
): Promise<ProvisioningRuleRow | null> {
  const [row] = rowsOf<{
    rule_id: string;
    tenant_id: string;
    binding_id: string;
    external_group: string | null;
    workspace_ids: string[] | null;
    revision: number;
    status: string;
    minimum_role: string;
  }>(
    await tx.execute(
      externalGroup === null
        ? sql`SELECT rule_id, tenant_id, binding_id, external_group, workspace_ids,
                     revision::int AS revision, status, minimum_role
                FROM auth_provisioning_rules
               WHERE binding_id = ${bindingId} AND external_group IS NULL LIMIT 1`
        : sql`SELECT rule_id, tenant_id, binding_id, external_group, workspace_ids,
                     revision::int AS revision, status, minimum_role
                FROM auth_provisioning_rules
               WHERE binding_id = ${bindingId} AND external_group = ${externalGroup} LIMIT 1`,
    ),
  );
  if (!row) return null;
  return {
    ruleId: String(row.rule_id),
    tenantId: String(row.tenant_id),
    bindingId: String(row.binding_id),
    externalGroup:
      row.external_group === null ? null : String(row.external_group),
    workspaceIds: (row.workspace_ids ?? []).map(String),
    revision: Number(row.revision),
    status: String(row.status),
    minimumRole: String(row.minimum_role),
  };
}

/** Encodes a string list as a Postgres text[] literal (the SCIM recipe). */
function rulePgTextArray(values: readonly string[]): string {
  return `{${values
    .map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",")}}`;
}

/**
 * The T05.06 rule commands: `provisioning.rule.approve` (the first approval
 * inserts at revision 1; a re-approval re-targets the same stable row and
 * advances its revision, reviving a revoked one) and
 * `provisioning.rule.revoke` (a status, never a deletion, revision +1). The
 * 0221 guard holds the identity columns immutable and the revision step.
 */
export function createProvisioningRuleHandlers(): Partial<
  Record<DirectoryOperation, DirectoryCommandHandler>
> {
  const approveAuthorize: DirectoryCommandHandler["authorize"] = async (
    context,
  ) => {
    const payload = context.command.payload as {
      readonly bindingId?: string;
      readonly externalGroup?: string | null;
      readonly workspaceIds?: readonly string[];
    };
    if (
      typeof payload.bindingId !== "string" ||
      payload.bindingId.trim() === "" ||
      !Array.isArray(payload.workspaceIds) ||
      payload.workspaceIds.length === 0 ||
      !payload.workspaceIds.every(
        (id) => typeof id === "string" && id.trim() !== "",
      ) ||
      new Set(payload.workspaceIds).size !== payload.workspaceIds.length ||
      (payload.externalGroup !== undefined &&
        payload.externalGroup !== null &&
        (typeof payload.externalGroup !== "string" ||
          payload.externalGroup.trim() === ""))
    ) {
      throw ruleRefusal(
        PROVISIONING_RULE_BINDING_UNKNOWN,
        "provisioning.rule.approve requires a bindingId and a non-empty unique workspaceIds list (externalGroup optional)",
        400,
      );
    }
    await authorizeRuleCommand(
      context.tx,
      context.actor,
      context.command.tenantId,
    );
    await requireCompanyBinding(
      context.tx,
      context.command.tenantId,
      payload.bindingId,
    );
    for (const workspaceId of payload.workspaceIds) {
      const [workspace] = rowsOf<{ tenant_id: string }>(
        await context.tx.execute(
          sql`SELECT tenant_id FROM enterprise_workspaces
               WHERE tenant_id = ${context.command.tenantId} AND id = ${workspaceId} LIMIT 1`,
        ),
      );
      if (!workspace) {
        throw ruleRefusal(
          PROVISIONING_RULE_WORKSPACE_FOREIGN,
          `workspace ${workspaceId} is not a workspace of company ${context.command.tenantId}; a rule's fixed targets are the company's own`,
          404,
        );
      }
      const [binding] = rowsOf<{ team_id: string }>(
        await context.tx.execute(
          sql`SELECT team_id FROM auth_team_bindings
               WHERE tenant_id = ${context.command.tenantId}
                 AND workspace_id = ${workspaceId} LIMIT 1`,
        ),
      );
      if (!binding) {
        throw ruleRefusal(
          PROVISIONING_RULE_WORKSPACE_UNBOUND,
          `workspace ${workspaceId} has no team binding in company ${context.command.tenantId}; the rule's team grant is refused rather than granted narrower`,
          400,
        );
      }
    }
  };

  const approveSync: DirectoryCommandHandler["sync"] = async (context) => {
    const payload = context.command.payload as {
      readonly bindingId: string;
      readonly externalGroup?: string | null;
      readonly workspaceIds: readonly string[];
    };
    const externalGroup =
      payload.externalGroup === undefined ? null : payload.externalGroup;
    const existing = await readRuleByIdentity(
      context.tx,
      payload.bindingId,
      externalGroup,
    );
    const workspaceIds = [...payload.workspaceIds];
    let ruleId: string;
    let revision: number;
    if (existing) {
      ruleId = existing.ruleId;
      revision = existing.revision + 1;
      await context.tx.execute(
        sql`UPDATE auth_provisioning_rules
             SET workspace_ids = ${rulePgTextArray(workspaceIds)}::text[],
                 revision = ${revision},
                 status = 'approved',
                 revoked_at = NULL,
                 updated_at = now()
           WHERE rule_id = ${ruleId}`,
      );
    } else {
      ruleId = randomUUID();
      revision = 1;
      await context.tx.execute(
        sql`INSERT INTO auth_provisioning_rules
            (rule_id, tenant_id, binding_id, external_group, workspace_ids,
             minimum_role, revision, status, created_at, updated_at)
          VALUES
            (${ruleId}, ${context.command.tenantId}, ${payload.bindingId}, ${externalGroup},
             ${rulePgTextArray(workspaceIds)}::text[], 'member', ${revision}, 'approved', now(), now())`,
      );
    }
    return { resourceId: ruleId };
  };

  const revokeAuthorize: DirectoryCommandHandler["authorize"] = async (
    context,
  ) => {
    const payload = context.command.payload as { readonly ruleId?: string };
    if (typeof payload.ruleId !== "string" || payload.ruleId.trim() === "") {
      throw ruleRefusal(
        PROVISIONING_RULE_NOT_FOUND,
        "provisioning.rule.revoke requires a ruleId",
        400,
      );
    }
    await authorizeRuleCommand(
      context.tx,
      context.actor,
      context.command.tenantId,
    );
    const rule = await readRuleByEvent(context.tx, payload.ruleId);
    if (!rule || rule.tenantId !== context.command.tenantId) {
      throw ruleRefusal(
        PROVISIONING_RULE_NOT_FOUND,
        `rule ${payload.ruleId} does not exist in company ${context.command.tenantId}`,
        404,
      );
    }
    if (rule.status !== "approved") {
      throw ruleRefusal(
        PROVISIONING_RULE_ALREADY_REVOKED,
        `rule ${payload.ruleId} is already revoked; revocation is a status, never a second command`,
        409,
      );
    }
  };

  const revokeSync: DirectoryCommandHandler["sync"] = async (context) => {
    const payload = context.command.payload as { readonly ruleId: string };
    const rule = await readRuleByEvent(context.tx, payload.ruleId);
    if (!rule || rule.tenantId !== context.command.tenantId) {
      throw ruleRefusal(
        PROVISIONING_RULE_NOT_FOUND,
        `rule ${payload.ruleId} does not exist in company ${context.command.tenantId}`,
        404,
      );
    }
    const revision = rule.revision + 1;
    await context.tx.execute(
      sql`UPDATE auth_provisioning_rules
           SET revision = ${revision}, status = 'revoked', revoked_at = now(), updated_at = now()
         WHERE rule_id = ${payload.ruleId}`,
    );
    return { resourceId: payload.ruleId };
  };

  return {
    "provisioning.rule.approve": Object.freeze({
      authorize: approveAuthorize,
      sync: approveSync,
    }),
    "provisioning.rule.revoke": Object.freeze({
      authorize: revokeAuthorize,
      sync: revokeSync,
    }),
  };
}

/** The read-side view the company admin surface answers with. */
export type ProvisioningRuleView = Readonly<{
  ruleId: string;
  tenantId: string;
  bindingId: string;
  externalGroup: string | null;
  workspaceIds: readonly string[];
  minimumRole: string;
  revision: number;
  status: string;
}>;

/**
 * The HTTP port the company admin routes consume (T05.06): it runs the rule
 * commands inside the administrator's trusted server-issued platform actor.
 * The owner/admin authorization and the binding/workspace re-verification
 * live in the directory command the handlers execute (the same lock the
 * executor replays), so the port only builds the actor and translates
 * command results.
 */
export interface CompanyProvisioningRulePort {
  approve(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly actorPrincipalId: string;
    readonly bindingId: string;
    readonly externalGroup?: string | null;
    readonly workspaceIds: readonly string[];
    readonly idempotencyKey: string;
  }): Promise<ProvisioningRuleView>;
  revoke(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly actorPrincipalId: string;
    readonly ruleId: string;
    readonly reason: string;
  }): Promise<ProvisioningRuleView>;
}

export function createDirectoryProvisioningRulePort(
  directory: Directory,
  db: Pick<DirectoryTx, "execute">,
): CompanyProvisioningRulePort {
  const actorOf = (userId: string, principalId: string): DirectoryActor => ({
    // kind "platform" (the membership translation's precedent): the admin
    // context seam carries no session id, and the handler re-verifies the
    // live owner/admin role inside the lock, so no authority is assumed.
    userId,
    principalId,
    sessionId: null,
    kind: "platform",
    bindingId: null,
    provisioning: null,
  });

  /** The committed rule row after the command, for the route's answer. */
  const readRule = async (
    ruleId: string,
  ): Promise<ProvisioningRuleRow | null> => {
    const [row] = rowsOf<{
      rule_id: string;
      tenant_id: string;
      binding_id: string;
      external_group: string | null;
      workspace_ids: string[] | null;
      revision: number;
      status: string;
      minimum_role: string;
    }>(
      await db.execute(
        sql`SELECT rule_id, tenant_id, binding_id, external_group, workspace_ids,
                   revision::int AS revision, status, minimum_role
              FROM auth_provisioning_rules WHERE rule_id = ${ruleId} LIMIT 1`,
      ),
    );
    if (!row) return null;
    return {
      ruleId: String(row.rule_id),
      tenantId: String(row.tenant_id),
      bindingId: String(row.binding_id),
      externalGroup:
        row.external_group === null ? null : String(row.external_group),
      workspaceIds: (row.workspace_ids ?? []).map(String),
      revision: Number(row.revision),
      status: String(row.status),
      minimumRole: String(row.minimum_role),
    };
  };

  const answerOf = async (ruleId: string): Promise<ProvisioningRuleView> => {
    const row = await readRule(ruleId);
    if (!row) {
      throw ruleRefusal(
        PROVISIONING_RULE_NOT_FOUND,
        `rule ${ruleId} has no committed row; the command's own refusal is the report`,
        404,
      );
    }
    return {
      ruleId: row.ruleId,
      tenantId: row.tenantId,
      bindingId: row.bindingId,
      externalGroup: row.externalGroup,
      workspaceIds: row.workspaceIds,
      minimumRole: row.minimumRole,
      revision: row.revision,
      status: row.status,
    };
  };

  return {
    async approve(input) {
      const result = await directory.execute(
        actorOf(input.actorUserId, input.actorPrincipalId),
        {
          operation: "provisioning.rule.approve",
          tenantId: input.tenantId,
          idempotencyKey: input.idempotencyKey,
          payload: {
            bindingId: input.bindingId,
            ...(input.externalGroup === undefined
              ? {}
              : { externalGroup: input.externalGroup }),
            workspaceIds: [...input.workspaceIds],
          },
        },
      );
      return answerOf(result.resourceId ?? "");
    },
    async revoke(input) {
      // The per-revision key (the T04.07 revoke precedent): the pre-read
      // row's revision pins which revocation this command re-attempts, so a
      // revoke after a re-approval is a fresh command, never a no-op replay.
      const row = await readRule(input.ruleId);
      if (!row || row.tenantId !== input.tenantId) {
        throw ruleRefusal(
          PROVISIONING_RULE_NOT_FOUND,
          `rule ${input.ruleId} does not exist in company ${input.tenantId}`,
          404,
        );
      }
      await directory.execute(
        actorOf(input.actorUserId, input.actorPrincipalId),
        {
          operation: "provisioning.rule.revoke",
          tenantId: input.tenantId,
          idempotencyKey: `revoke-${input.ruleId}-${row.revision}`,
          payload: { ruleId: input.ruleId, reason: input.reason },
        },
      );
      return answerOf(input.ruleId);
    },
  };
}
