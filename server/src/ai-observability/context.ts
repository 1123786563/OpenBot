/**
 * Who may observe a Bot.
 *
 * Observation access is MANAGEMENT access, not chat access. `canAccessAgent`
 * (server/src/agents/profile-policy.ts) answers yes for a `public` Bot, which is
 * exactly the widening the parent Spec forbids: public chat access must not become
 * access to another creator's traces. So this module asks the manage-level question
 * and nothing else, and the answer is injected the same way `BotAccessCheck` is —
 * a surface that observes a Bot depends on the question, not on the agents table.
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
 */
export type BotManagementCheck = (
  actor: AgentActor,
  botId: string,
) => Promise<AgentProfile | null>;

export const OBSERVATION_ACCESS_DENIED =
  "Observation access requires management rights on this Bot.";
export const OBSERVATION_BOT_REQUIRED = "A Bot id is required.";

export type ObservationBotAccess =
  | { ok: true; botId: string; profile: AgentProfile }
  | { ok: false; status: 403 | 404; error: string };

/**
 * The one place observation authorization happens. A missing Bot id is refused before
 * any lookup; an unknown Bot and a Bot the caller may not manage answer identically, so
 * probing ids cannot tell the two apart.
 */
export async function resolveObservationBot(
  check: BotManagementCheck,
  actor: AgentActor,
  botId: string | undefined,
): Promise<ObservationBotAccess> {
  if (!botId) return { ok: false, status: 404, error: OBSERVATION_BOT_REQUIRED };
  const profile = await check(actor, botId);
  if (!profile) return { ok: false, status: 403, error: OBSERVATION_ACCESS_DENIED };
  return { ok: true, botId, profile };
}
