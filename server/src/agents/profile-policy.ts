import type { AgentActor, AgentProfile } from "./profile-types";

export function canAccessAgent(
  actor: AgentActor,
  agent: AgentProfile,
): boolean {
  if (agent.deletedAt !== null) return false;

  return (
    agent.visibility === "public" ||
    agent.ownerUserId === actor.id ||
    actor.role === "admin"
  );
}

export function canManageAgent(
  actor: AgentActor,
  agent: AgentProfile,
): boolean {
  if (agent.systemOwned || agent.deletedAt !== null) return false;

  return agent.ownerUserId === actor.id || actor.role === "admin";
}

export const canRunAgent = canAccessAgent;

/**
 * Whether this person may observe this Bot: read its runs, steps, evaluation data and exports
 * through the observation domain (R4-02).
 *
 * This is the observation domain's own question, NOT `canManageAgent` asked a second time. The two
 * answers agree for every user-owned Bot — creator or global administrator — and diverge on exactly
 * one row: a system Bot. A system Bot has no personal creator (the tenant package provisions
 * `ownerUserId: null`), and the parent Spec's access contract hands creatorless system Bots'
 * observation data to the administrator ("系统 Bot 无个人创建者时，管理员管理观测数据"). Routing
 * observation through `canManageAgent` answered "no" for every role, which is how the deployment's
 * default LangGraph Bot executed, held billing and wrote traces upstream while its own query face
 * answered 404 and no binding ever existed: execution with no governance face.
 *
 * The divergence widens reading, never editing. An administrator gains the system Bot's observation
 * face; `canManageAgent` above keeps refusing `systemOwned` for every role, administrators included,
 * so the edit paths stay closed and nothing downstream may treat an observation scope as a step
 * toward a profile write. And a regular user earns nothing here, chat rights least of all:
 * `canAccessAgent` lets everyone talk to a public system Bot and `canRunAgent` lets everyone run it,
 * but the runs other people leave in it are not chat data — observing them is the administrator's
 * job alone, exactly as a stranger on someone's public Bot observes nothing.
 */
export function canObserveAgent(
  actor: AgentActor,
  agent: AgentProfile,
): boolean {
  if (agent.deletedAt !== null) return false;

  /*
   * The one divergence: a creatorless system Bot's observation data belongs to the deployment's
   * administrator. A system Bot with an owner would be a row the package provisioner never writes;
   * if one ever appears, nobody observes it until the access contract says who does — fail closed,
   * never assume the owner reads what the Spec only ever assigned to administrators. The ownerless
   * check is the code, not just this paragraph: an admin observing an owner-bearing system Bot
   * would hand it to them through the same divergence the paragraph below forbids widening.
   */
  if (agent.systemOwned && agent.ownerUserId === null) {
    return actor.role === "admin";
  }

  return canManageAgent(actor, agent);
}

/**
 * Whether this person may act as this Bot.
 *
 * Injected rather than imported, so a surface that acts as a Bot depends on the question and not on
 * the agents table. It also keeps the answer in one place: the store's read path already filters on
 * {@link canAccessAgent}, so asking it is the same rule the roster and the runtime already apply,
 * rather than a second copy that can drift from them.
 */
export type BotAccessCheck = (
  /** The whole actor, not just the id: an administrator reaches every Bot, and a role tells us. */
  actor: AgentActor,
  botId: string,
) => Promise<boolean>;
