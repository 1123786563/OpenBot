/**
 * Who may observe a Bot.
 *
 * Observation access is its own authorization question, not chat access and not
 * edit access. `canAccessAgent` (server/src/agents/profile-policy.ts) answers yes
 * for a `public` Bot, which is exactly the widening the parent Spec forbids: public
 * chat access must not become access to another creator's traces. But the manage
 * rule `canManageAgent` is not the answer either (R4-02): it refuses `systemOwned`
 * for every role, which is right for editing and wrong for reading — a system Bot
 * has no personal creator, and the parent Spec's access contract hands its
 * observation data to the administrator, so routing observation through the manage
 * question left the deployment's default LangGraph Bot executing and billing while
 * its own query face answered 404. The observe-level policy is
 * `canObserveAgent` in the same file: creator or administrator for a user-owned
 * Bot, administrator alone for a system Bot, nobody on chat rights. The answer is
 * injected the same way `BotAccessCheck` is — a surface that observes a Bot
 * depends on the question, not on the agents table.
 *
 * Deliberately absent: any tenant or enterprise scope. Unknown enterprise scope is
 * refused by the scope seam (ticket #12), not here; this file must not grow a
 * tenant header, a tenant table, or a fallback that widens access.
 */
import type { AgentActor, AgentProfile } from "../agents/profile-types";

/**
 * Resolves a Bot for observation. Returns the profile rather than a boolean because
 * downstream readers need the ownership and version references off the same row the
 * authorization decision was made on — a second lookup could observe a different Bot
 * after a transfer.
 *
 * The name predates R4-02: the production wiring backs this with the observe-level
 * policy (`canObserveAgent`), never the manage gate — for a user-owned Bot the two
 * agree, and for a system Bot the manage gate would refuse every role, which is the
 * defect this seam's injection had to stop reusing.
 */
export type BotManagementCheck = (
  actor: AgentActor,
  botId: string,
) => Promise<AgentProfile | null>;

export const OBSERVATION_BOT_NOT_FOUND = "Bot not found.";
export const OBSERVATION_BOT_REQUIRED = "A Bot id is required.";

/** The ownership an observation scope may be minted under. */
export type ObservationOwnership = "owner" | "admin";

/**
 * The explicit ownership answer, read off the same profile row the manage decision
 * was made on: the profile's owner is "owner", a global admin is "admin", and
 * anything else is a refusal — never an inference.
 *
 * Today's gate only lets an owner or a global admin through, so the refusal
 * branch is unreachable in production — and that is exactly the point: the scope
 * minting must not inherit the gate's implementation details. A future widening of
 * the gate (shared management, organization roles — the enterprise seam's reserved
 * direction) then fails closed here instead of silently granting observation scopes
 * to whoever the widened gate lets through (OCR round-1 h10/m182). For a system Bot
 * the owner arm is structurally dead — `ownerUserId` is null by provisioning — so
 * "admin" is the only answer a system Bot's observation scope is ever minted under.
 */
export function explicitObservationOwnership(
  actor: AgentActor,
  profile: AgentProfile,
): ObservationOwnership | null {
  if (profile.ownerUserId === actor.id) return "owner";
  if (actor.role === "admin") return "admin";
  return null;
}

export type ObservationBotAccess =
  | { ok: true; botId: string; profile: AgentProfile }
  | { ok: false; status: 404; error: string };

/**
 * The one place observation authorization happens. A missing Bot id is refused before
 * any lookup; an unknown Bot and a Bot the caller may not manage answer identically —
 * not found rather than forbidden, as the agents store answers everywhere else and the
 * parent Spec §7 requires ("统一不存在语义") — so probing ids cannot tell the two
 * apart and learns nothing about which Bots exist.
 */
export async function resolveObservationBot(
  check: BotManagementCheck,
  actor: AgentActor,
  botId: string | undefined,
): Promise<ObservationBotAccess> {
  if (!botId)
    return { ok: false, status: 404, error: OBSERVATION_BOT_REQUIRED };
  const profile = await check(actor, botId);
  if (!profile)
    return { ok: false, status: 404, error: OBSERVATION_BOT_NOT_FOUND };
  return { ok: true, botId, profile };
}
