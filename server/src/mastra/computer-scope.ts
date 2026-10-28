import type { AuditInitiator, AuditStore } from "../audit";
import type { ActionActor, ComputerGateway } from "../computer/gateway";
import type { HeadlessSignInRequester } from "../computer/headless-tools";
import { createHeadlessComputerTools } from "../computer/headless-tools";
import type { PlatformScope } from "../enterprise/contracts";
import type { ExecutionBinding } from "./execution-contracts";

/*
 * ME06 (#478) AC1: the computer environment resolution the Mastra path
 * assembles its computer tools through.
 *
 * ADR 0006: the logical Bot id is never the sole addressing basis of a
 * physical (stateful) computer. Business execution resolves the environment
 * from the admitted binding's scope — company/team/self (tenant, workspace,
 * principal, actor) PLUS the bot — so the same logical Bot running for two
 * scopes never shares one environment, and an environment address carries
 * every scope segment that binds it.
 *
 * Two layers, both mandatory at the assembly:
 *   1. `scopedComputerEnvironmentKey` — the ONE address the Mastra path
 *      derives for a binding (deterministic, injection-validated).
 *   2. `scopedComputerGateway` — the view around the deployment gateway that
 *      REFUSES every environment address other than the binding's own. The
 *      raw global bot id (the legacy shared-state addressing) is refused by
 *      name before the gateway can be touched — cross-scope and direct
 *      global addressing fail closed.
 *
 * `createMastraComputerTools` is the assembly: the SAME legacy headless
 * computer tools (semantic parity — the channel's tools, suspensions and
 * audit are unchanged), bound to the scoped view and the scope-derived
 * actor. The gateway/provider engines themselves are untouched (the ticket's
 * scope boundary).
 */

/** A scope-resolution refusal: named, thrown before anything executes. */
export class MastraComputerScopeRefusal extends Error {}

/** One validated identifier segment of the address. */
function requireSegment(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  ) {
    // Never echo the value: the refusal names the rule, not the input.
    throw new MastraComputerScopeRefusal(
      `MASTRA_COMPUTER_ENVIRONMENT_SCOPE_INVALID: the ${field} segment of the computer environment address must be a single-line identifier of at most 128 characters (letters, digits, dot, dash, underscore).`,
    );
  }
  return value;
}

/**
 * The environment address of one binding's computer: every scope segment and
 * the bot enter it, in a fixed readable form. Deterministic on purpose — a
 * resumed run (or another instance) re-deriving it must land on the SAME
 * environment.
 */
export function scopedComputerEnvironmentKey(
  scope: PlatformScope,
  botId: string,
): string {
  const tenantId = requireSegment(scope?.tenantId, "tenantId");
  const workspaceId = requireSegment(scope?.workspaceId, "workspaceId");
  const principalId = requireSegment(scope?.principalId, "principalId");
  const actorId = requireSegment(scope?.actorId, "actorId");
  const bot = requireSegment(botId, "botId");
  return `mastra-computer/v1/t=${tenantId}/w=${workspaceId}/p=${principalId}/a=${actorId}/b=${bot}`;
}

/**
 * The gateway view one binding may see: every method that carries an
 * environment address must present THIS binding's scoped key. The raw
 * global bot id and every foreign address are refused with
 * MASTRA_COMPUTER_ENVIRONMENT_SCOPE_REFUSED before the gateway executes —
 * the structural refusal that keeps two scopes (and the unscoped legacy
 * spelling) off one stateful environment.
 */
export function scopedComputerGateway(
  gateway: ComputerGateway,
  input: { scope: PlatformScope; botId: string },
): ComputerGateway {
  const owned = scopedComputerEnvironmentKey(input.scope, input.botId);
  const rawBotId = input.botId;
  return new Proxy(gateway, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (async (...args: unknown[]) => {
        const presented = args[0];
        if (presented !== owned) {
          throw new MastraComputerScopeRefusal(
            `MASTRA_COMPUTER_ENVIRONMENT_SCOPE_REFUSED: this binding may only address its own scope-resolved computer environment (${
              presented === rawBotId
                ? "the raw global bot id is not a valid environment address"
                : "the presented address belongs to another scope"
            }); the call was refused before the gateway executed.`,
          );
        }
        // Called on the gateway it was read from, not as a bare function: a gateway that is a
        // class instance (the interface allows it) must still see its own `this`.
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      }) as never;
    },
  });
}

export interface CreateMastraComputerToolsOptions {
  gateway: ComputerGateway;
  auditStore?: AuditStore;
  signIn?: HeadlessSignInRequester;
  /** What started this run; scheduled work must not inherit person initiation. */
  initiator?: AuditInitiator;
  /**
   * The users-table id the audit row's foreign key wants, when the caller
   * resolved one for this actor. Absent records a null, never a guess.
   */
  auditUserId?: string;
}

/**
 * The Mastra path's computer tool assembly: the legacy headless computer
 * tools (unchanged semantics), addressed through the binding's scope-resolved
 * environment. The actor is the binding's own scope actor — a Team Bot's
 * teammate-uses-the-Bot rule and the approval gates stay with the legacy
 * channel; the SCOPING here is the environment address and the control
 * identity, not a second policy engine.
 */
export function createMastraComputerTools(
  binding: Pick<ExecutionBinding, "scope" | "botId">,
  options: CreateMastraComputerToolsOptions,
): ReturnType<typeof createHeadlessComputerTools> {
  const environmentKey = scopedComputerEnvironmentKey(
    binding.scope,
    binding.botId,
  );
  const actor: ActionActor = {
    // The binding's actor IS the run's control identity; the audit row names
    // it through the caller-supplied users-table id, never a guess. An empty
    // string is a misconfiguration, not "no users row": it is refused by name
    // instead of silently recorded as a null foreign key.
    id: requireSegment(binding.scope.actorId, "actorId"),
    ...(options.auditUserId !== undefined
      ? { userId: requireSegment(options.auditUserId, "auditUserId") }
      : {}),
    ...(options.initiator ? { initiator: options.initiator } : {}),
  };
  return createHeadlessComputerTools({
    gateway: scopedComputerGateway(options.gateway, {
      scope: binding.scope,
      botId: binding.botId,
    }),
    botId: environmentKey,
    actor,
    ...(options.auditStore ? { auditStore: options.auditStore } : {}),
    ...(options.signIn ? { signIn: options.signIn } : {}),
  });
}
