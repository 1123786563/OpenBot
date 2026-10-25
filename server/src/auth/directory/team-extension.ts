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
 */

import { getCurrentDBAdapterAsyncLocalStorage } from "@better-auth/core/context";
import { getOrgAdapter } from "better-auth/plugins/organization";
import { sql } from "drizzle-orm";
import type {
  DirectoryActor,
  DirectoryTx,
  ScopedTeamExtension,
  TeamCommandAuthority,
  TeamMutationCapability,
} from "./contracts";

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
