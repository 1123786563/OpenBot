import type { AbstractAgent } from "@ag-ui/client";
import type { AuditInitiator } from "../audit";
import type { AgentFetch, StallGuard } from "../channels/stall-guard";
import type { RegisteredBuiltInAgent } from "../copilot";
import {
  type HandoffForRun,
  type LoadAgentsForActor,
  type LoadAttachment,
  type LoadInstructions,
  type LoadToolsForBot,
  type MarkAttachmentsSent,
  type RuntimeModel,
  resolveRuntimeAgents,
  type SignRun,
  type ToolSelection,
} from "../copilot";
import type { GovernedModelRequest } from "../enterprise/runs/governed-execution";
import type { AcquireLearnedSkills } from "../learning/runtime";
import type { LoadPersonalMemory } from "../memory/tools";
import type { SelectableSkill } from "../plugins/selection";
import type { AgentActor } from "./profile-types";

export type AgentResolutionContext = {
  initiator?: AuditInitiator;
  depth?: number;
  /**
   * The server-only governed model collaborator for one admitted run.
   *
   * Set only by the governed Runner admission for the Bot it is about to
   * execute; every other resolution surface (roster builds, hops, remote
   * deliveries) resolves without it and gets the ordinary provider-keyed
   * build. Never taken from a wire field or a global.
   */
  governedModel?: GovernedModelRequest;
  /**
   * PKG03B (T03-fix): the admitted run's pinned package skills, read through
   * `readPinnedSkills` by the Runner AFTER its own admission (pin ∩ active
   * grant ∩ membership revalidated per read, zero cache). Present only on the
   * re-resolution of a run that has pins; the build merges them after the
   * legacy `grantedSkills` catalogue — never replacing or downgrading legacy
   * grants, and never reachable from a wire field. A run without pins
   * re-resolves nothing and keeps the legacy contract untouched.
   */
  pinnedPackageSkills?: readonly SelectableSkill[];
};

export class CoworkerUnavailableError extends Error {}

export type ActorAgentResolver = {
  resolveAgentsForActor(
    actor: AgentActor,
  ): Promise<Record<string, AbstractAgent>>;
  resolveAgentForActor(
    actor: AgentActor,
    agentId: string,
    context?: AgentResolutionContext,
  ): Promise<AbstractAgent>;
  resolveBuiltInBotForActor(
    actor: AgentActor,
    agentId: string,
    context?: AgentResolutionContext,
  ): Promise<{
    agent: AbstractAgent;
    definitionFacts: {
      agentId: string;
      source: NonNullable<RegisteredBuiltInAgent["expertSource"]>;
      systemPrompt: string;
    };
  }>;
};

export type ActorAgentResolverDependencies = {
  loadAgents: LoadAgentsForActor;
  model: RuntimeModel;
  resolveModelApiKey: () => Promise<string | null>;
  stallGuard?: StallGuard;
  loadToolsForActor?: (
    actorId: string,
    initiator?: AuditInitiator,
  ) => LoadToolsForBot;
  signRunForActor?: (
    actorId: string,
    initiator?: AuditInitiator,
    depth?: number,
  ) => SignRun;
  computerGuidance?: string;
  loadVendors?: () => Promise<readonly string[]>;
  selectionForActor?: (actorId: string) => ToolSelection;
  agentFetch?: AgentFetch;
  /**
   * What a Bot may reach past itself for, resolved for whoever is asking.
   *
   * Per actor for the same reason the tools are: which Bots may be reached is decided against the
   * roster that person can see, so a Bot must never be able to address one they cannot.
   */
  handoffForActor?: (
    actorId: string,
    initiator?: AuditInitiator,
    depth?: number,
  ) => HandoffForRun;
  loadInstructionsForActor?: (actorId: string) => LoadInstructions;
  loadAttachmentForActor?: (actorId: string) => LoadAttachment;
  markAttachmentsSentForActor?: (actorId: string) => MarkAttachmentsSent;
  acquireLearnedSkills?: AcquireLearnedSkills;
  loadPersonalMemoryForActor?: (actorId: string) => LoadPersonalMemory;
  /**
   * The builtin run's trusted observation-scope resolver (T-final M1). Handed
   * through to the builtin agents, which ask it once per run; a null answer
   * keeps that run's facts scope-less. Absent means no threading at all — the
   * same inert footing the observation recorders keep when unregistered.
   */
  resolveRunObservationScope?: (
    actor: AgentActor,
    botId: string,
  ) => Promise<unknown>;
};

/**
 * Resolves the coworkers available to one OpenBot actor.
 *
 * Every surface enters through this boundary so it shares the same visibility, grants, assertions,
 * skill selection, and endpoint dial policy for a person.
 */
export function createActorAgentResolver(
  deps: ActorAgentResolverDependencies,
): ActorAgentResolver {
  const resolveRegisteredAgents = (
    actor: AgentActor,
    registered: Awaited<ReturnType<LoadAgentsForActor>>,
    /**
     * Build only this Bot, when the caller already knows which one it wants.
     *
     * The roster is still read in full, so a Bot this person cannot see is still absent. The others
     * are simply neither built nor asked what they hold, which is a query per Bot a headless turn
     * or a Slack thread has no use for.
     */
    onlyAgentId?: string,
    context?: AgentResolutionContext,
  ) => {
    // The builtin run's observation-scope threading (T-final M1), forwarded
    // AT LAST: the resolver the boot assembly injected is closed over the
    // asking actor and handed down as the trailing observation argument, so
    // every builtin agent this build constructs asks it once per run, at
    // subscribe time. A refused resolution answers null and that run's facts
    // stay scope-less — the same inert footing a build without the injection
    // keeps. Captured in a local first so the narrowed type survives into the
    // closure the threading carries.
    const resolveRunObservationScope = deps.resolveRunObservationScope;
    const observation = resolveRunObservationScope
      ? {
          actorId: actor.id,
          resolveScope: (botId: string) =>
            resolveRunObservationScope(actor, botId),
        }
      : undefined;
    return resolveRuntimeAgents(
      () => Promise.resolve(registered),
      deps.model,
      deps.resolveModelApiKey,
      deps.stallGuard,
      deps.loadToolsForActor?.(actor.id, context?.initiator),
      deps.signRunForActor?.(actor.id, context?.initiator, context?.depth),
      deps.computerGuidance,
      deps.loadVendors,
      deps.selectionForActor?.(actor.id),
      deps.agentFetch,
      deps.handoffForActor?.(actor.id, context?.initiator, context?.depth),
      onlyAgentId,
      deps.loadInstructionsForActor?.(actor.id),
      context?.initiator,
      deps.loadAttachmentForActor?.(actor.id),
      deps.markAttachmentsSentForActor?.(actor.id),
      deps.acquireLearnedSkills,
      deps.loadPersonalMemoryForActor?.(actor.id),
      context?.governedModel,
      // The consumption attribution (09.1): who this build's runs are for. The Bot half is each
      // agent's own id, known where the model wrapper is built; the person is known here.
      { userId: actor.id },
      observation,
      // PKG03B (T03-fix): the admitted run's pinned package skills, threaded
      // to the builds so the run's Skill catalogue serves the pinned revision.
      context?.pinnedPackageSkills,
    );
  };

  const resolveAgentsForActor = async (actor: AgentActor) =>
    resolveRegisteredAgents(actor, await deps.loadAgents(actor));
  const unavailable = (id: string) =>
    new CoworkerUnavailableError(`Coworker ${id} is unavailable to this user.`);
  const resolveOneRegistered = async (
    actor: AgentActor,
    registered: Awaited<ReturnType<typeof deps.loadAgents>>,
    agentId: string,
    context?: AgentResolutionContext,
  ) => {
    const agents = await resolveRegisteredAgents(
      actor,
      registered,
      agentId,
      context,
    );
    const agent = Object.hasOwn(agents, agentId) ? agents[agentId] : undefined;
    if (!agent) throw unavailable(agentId);
    return agent;
  };

  return {
    resolveAgentsForActor,
    async resolveAgentForActor(actor, agentId, context) {
      const registered = await deps.loadAgents(actor);
      if (!registered.some((agent) => agent.id === agentId)) {
        throw unavailable(agentId);
      }
      return resolveOneRegistered(actor, registered, agentId, context);
    },
    async resolveBuiltInBotForActor(actor, agentId, context) {
      const registered = await deps.loadAgents(actor);
      const candidate = registered.find((agent) => agent.id === agentId);
      if (candidate?.type !== "built_in") {
        throw unavailable(agentId);
      }
      // The guard above narrows the discriminated union; no cast needed.
      const builtIn = candidate;
      if (
        (builtIn.expertSource !== "tenant_package" &&
          builtIn.expertSource !== "user_profile" &&
          builtIn.expertSource !== "team_bot") ||
        /* registeredAgentFromRow already guarantees a non-empty, trimmed
           prompt; these re-checks are defense in depth against persisted
           shape drift before the expert facts are persisted, not a
           reachable dirty-data path. */
        typeof builtIn.systemPrompt !== "string" ||
        !builtIn.systemPrompt.trim() ||
        builtIn.systemPrompt !== builtIn.systemPrompt.trim()
      ) {
        throw unavailable(agentId);
      }
      const resolved = await resolveOneRegistered(
        actor,
        registered,
        agentId,
        context,
      );
      return {
        agent: resolved,
        definitionFacts: {
          agentId: builtIn.id,
          source: builtIn.expertSource,
          systemPrompt: builtIn.systemPrompt,
        },
      };
    },
  };
}
