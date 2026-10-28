import { getLogger } from "../../../shared/logger";
import type { AgentProfileStore } from "./profile-store";
import type { AgentActor } from "./profile-types";

const log = getLogger("server");

/**
 * Who may watch, drive or take over a Bot's computer.
 *
 * Seeing a Bot is not enough. A Team Bot reaches teammates through its owner's publication, but its
 * computer is one per Bot and carries the owner's browser: the sites the owner signed into, through
 * the password manager or by hand. A teammate chats with the Team Bot and it still acts for them
 * through its own governed tools; only the owner (or an administrator) sees the screen or takes
 * control. Public Bots are shared by everyone who can sign in, so their computer is too.
 */
export function canUseComputer(
  profile: { visibility: string; ownerUserId: string | null } | null,
  actor: Pick<AgentActor, "id" | "role">,
): boolean {
  if (!profile) return false;
  return (
    actor.role === "admin" ||
    profile.visibility === "public" ||
    profile.ownerUserId === actor.id
  );
}

/** The access check the computer routes and the live screen use, read from the profile store. */
export function computerAccessCheck(store: Pick<AgentProfileStore, "get">) {
  return async (actor: AgentActor, botId: string) =>
    canUseComputer(
      // Fail closed, but say why: a store outage must not read as an ordinary refusal.
      await store.get(actor, botId).catch((error: unknown) => {
        log.warn(
          { err: error, botId, actorId: actor.id },
          "Could not read the Bot profile; refusing computer access.",
        );
        return null;
      }),
      actor,
    );
}
