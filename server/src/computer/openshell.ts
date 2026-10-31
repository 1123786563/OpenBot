import type { OpenShellComputerConfig } from "../config";
import {
  createOpenShellGatewayClient,
  missingCapabilities,
  OPEN_SHELL_ENV,
  openShellDeploymentInputs,
} from "./openshell-client";
import {
  type ComputerLocation,
  type ComputerProvider,
  ProviderError,
} from "./provider";
import type { ComputerStatus } from "./schema";

/**
 * Who a sandbox belongs to.
 *
 * The Bot id alone is not an identity: two teams may use the same Bot id, and the same Bot has a
 * computer and a coding sandbox that must not share one. Everything the deployment can prove about
 * the ownership is in the scope, and nothing outside it is allowed to fill in a missing part.
 */
export type OpenShellScope = {
  tenantId: string;
  workspaceId: string;
  botId: string;
  environment: "computer" | "coding";
  generation: string;
};

/**
 * What a live probe proved about this substrate, named the way the probe reports it.
 *
 * A deployment that has not proven one of these cannot place a computer here: a policy that was never
 * seen to load, a workspace boundary never seen to hold, or a workload that could read the control
 * plane are all reasons to refuse before the first sandbox exists rather than after.
 */
export const OPEN_SHELL_REQUIRED_CAPABILITIES = [
  "default-deny-network",
  "policy-load-receipt",
  "cross-workspace-denial",
  "credential-boundary",
] as const;

export type OpenShellCapability =
  (typeof OPEN_SHELL_REQUIRED_CAPABILITIES)[number];

/**
 * What a live probe proved about one sandbox, named the way the probe found it.
 *
 * These are not configuration: the policy receipt comes from the gateway, and the other three from
 * the exec probes the acceptance run performs. Anything short of all four good is a sandbox that may
 * not be handed out.
 */
export type OpenShellSandboxEvidence = {
  policy: "loaded" | "pending" | "failed";
  isolation: "enforced" | "broken";
  credentials: "hidden" | "exposed";
  unauthorizedDestination: "denied" | "reachable";
};

/** One sandbox as the gateway reports it. */
export type OpenShellSandboxView = {
  name: string;
  state: "ready" | "stopped" | "missing" | "failed";
  url?: string;
  /** The runtime generation the sandbox itself reports; orders runs of the same sandbox. */
  generation?: string;
  /** Absent when nothing proved it: a view without evidence may not be used. */
  evidence?: OpenShellSandboxEvidence;
};

/**
 * The restricted gateway client the provider is allowed to use.
 *
 * Fixed to the operations the live probe exercised (OpenShell 0.1.6: CreateSandbox, StartSandbox,
 * GetSandbox, StopSandbox, DeleteSandbox, ListSandboxes). It holds no cluster credentials of its own
 * and cannot widen a sandbox's policy beyond what it was given at creation.
 */
export interface OpenShellAdminClient {
  /**
   * Whether this deployment has any address a computer could be reached on. A deployment without
   * one may still manage sandboxes, but it may not create any: there would be nothing to reach.
   */
  hasServiceAddress(): boolean;
  /** Ensure the sandbox exists and is running; returns it ready, or throws. */
  ensureSandbox(scope: OpenShellScope): Promise<OpenShellSandboxView>;
  /** Read the sandbox without starting it. */
  inspectSandbox(scope: OpenShellScope): Promise<OpenShellSandboxView>;
  stopSandbox(scope: OpenShellScope): Promise<{ wasRunning: boolean }>;
  resetSandbox(scope: OpenShellScope): Promise<{ cleared: boolean }>;
  listSandboxes(): Promise<
    { scope: OpenShellScope; view: OpenShellSandboxView }[]
  >;
}

export type OpenShellProviderOptions = {
  client: OpenShellAdminClient;
  /** The deployment's one answer for where a Bot runs, or null when it cannot place it. */
  scopeFor(botId: string): Promise<OpenShellScope | null>;
  /** Capability names a live probe actually proved; anything less than all of them is refused. */
  capabilities: readonly string[];
};

function isCompleteScope(scope: OpenShellScope): boolean {
  return (
    scope.tenantId.length > 0 &&
    scope.workspaceId.length > 0 &&
    scope.botId.length > 0 &&
    (scope.environment === "computer" || scope.environment === "coding") &&
    scope.generation.length > 0
  );
}

/**
 * The deployment's own scope facts bound whatever resolver the assembly hands the provider.
 *
 * T02: the resolver may come from an authenticated request path rather than the deployment's fixed
 * closure. The tenant and workspace this deployment was started for are the authoritative facts, so
 * a scope naming another team's tenant or workspace — a forwarded header, a stale cache row, a
 * mis-wired caller — resolves to nothing and the provider refuses before the gateway is dialed. The
 * Bot id check stays in `scopeOf`, which sees the request's own idea of the Bot.
 */
export function trustedOpenShellScopeFor(
  resolve: (botId: string) => Promise<OpenShellScope | null>,
  deployment: { tenantId: string; workspaceId: string },
): (botId: string) => Promise<OpenShellScope | null> {
  return async (botId) => {
    const scope = await resolve(botId);
    if (!scope) return null;
    if (
      scope.tenantId !== deployment.tenantId ||
      scope.workspaceId !== deployment.workspaceId
    ) {
      return null;
    }
    return scope;
  };
}

/**
 * Why a sandbox may not be used, in the words of the evidence that failed.
 *
 * A missing receipt is itself a failure: nothing proved the policy loaded, so the answer is the same
 * as a policy that did not.
 */
function evidenceFailure(
  evidence: OpenShellSandboxEvidence | undefined,
): string | undefined {
  if (!evidence)
    return "the gateway reported no evidence that its policy, isolation and credential boundary hold";
  if (evidence.policy !== "loaded")
    return `its policy receipt is ${evidence.policy}, not loaded`;
  if (evidence.isolation !== "enforced")
    return "its isolation is reported broken";
  if (evidence.credentials !== "hidden")
    return "its workload can read the control-plane credentials";
  if (evidence.unauthorizedDestination !== "denied")
    return "an unauthorized destination was reachable from it";
  return undefined;
}

/**
 * Computers as OpenShell sandboxes, one per Bot.
 *
 * Everything that decides whether a sandbox may exist happens here, before the client is called: a
 * deployment that has not proven the substrate, or a Bot it cannot place in a complete scope, gets a
 * refusal and no sandbox.
 */
export function createOpenShellComputerProvider(
  options: OpenShellProviderOptions,
): ComputerProvider {
  const missing = OPEN_SHELL_REQUIRED_CAPABILITIES.filter(
    (capability) => !options.capabilities.includes(capability),
  );
  if (missing.length > 0) {
    throw new ProviderError(
      `The OpenShell substrate has not proven ${missing.join(", ")} in this deployment, so no computer can be placed on it.`,
    );
  }

  async function scopeOf(botId: string): Promise<OpenShellScope> {
    const scope = await options.scopeFor(botId);
    if (!scope) {
      throw new ProviderError(
        `There is no complete execution ownership for Bot ${JSON.stringify(botId)}, so no OpenShell sandbox can be created for it.`,
      );
    }
    if (!isCompleteScope(scope)) {
      throw new ProviderError(
        `The execution ownership for Bot ${JSON.stringify(botId)} is incomplete (tenant, workspace, Bot, environment and generation are all required), so no OpenShell sandbox can be created for it.`,
      );
    }
    if (scope.botId !== botId) {
      throw new ProviderError(
        `The execution ownership offered for Bot ${JSON.stringify(botId)} names another Bot (${JSON.stringify(scope.botId)}), so acting on it would reach a computer this request does not own.`,
      );
    }
    return scope;
  }

  /** Turn a gateway failure into a refusal that names the Bot and what was being done. */
  async function call<T>(
    botId: string,
    what: string,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        `The OpenShell sandbox for Bot ${JSON.stringify(botId)} ${what}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function location(
    scope: OpenShellScope,
    view: OpenShellSandboxView,
  ): ComputerLocation {
    return {
      botId: scope.botId,
      status: view.state === "ready" ? "running" : "stopped",
      ...(view.url ? { url: view.url } : {}),
    };
  }

  return {
    name: "OpenShell",
    isolation: "per-bot",

    async locate(botId: string): Promise<string> {
      const scope = await scopeOf(botId);
      /*
       * Refused before anything is created or woken: a deployment with no service address would
       * otherwise leave a running sandbox behind a refusal that has nothing to reach it through.
       */
      if (!options.client.hasServiceAddress()) {
        throw new ProviderError(
          `This deployment has no address to reach an OpenShell sandbox on (${OPEN_SHELL_ENV.servicePort} is unset), so no computer can be placed for Bot ${JSON.stringify(botId)}.`,
        );
      }
      const view = await call(botId, "could not be ensured", () =>
        options.client.ensureSandbox(scope),
      );
      if (view.state !== "ready" || !view.url) {
        throw new ProviderError(
          `The OpenShell sandbox ${view.name} for Bot ${JSON.stringify(botId)} is ${view.state}; it has no address to reach.`,
        );
      }
      const unusable = evidenceFailure(view.evidence);
      if (unusable) {
        /*
         * Fail closed: the sandbox that cannot prove its policy, isolation or credential boundary is
         * stopped before the refusal is raised, so it does not keep running unguarded behind a caller
         * that will only retry later. What the refusal says about the stop is what actually happened:
         * a stop that failed must not be dressed up as a successful one, because the caller is the
         * one left holding a sandbox that is still running.
         */
        let stopped = "It was stopped.";
        try {
          await options.client.stopSandbox(scope);
        } catch (error) {
          stopped = `It could not be stopped (${error instanceof Error ? error.message : String(error)}); treat it as still running.`;
        }
        throw new ProviderError(
          `The OpenShell sandbox ${view.name} for Bot ${JSON.stringify(botId)} may not be used: ${unusable}. ${stopped}`,
        );
      }
      return view.url;
    },

    async status(botId: string): Promise<ComputerStatus> {
      try {
        const scope = await scopeOf(botId);
        // Read only: a status check must never start a sandbox, so this is the inspect path.
        const view = await call(botId, "could not be read", () =>
          options.client.inspectSandbox(scope),
        );
        if (view.state === "ready") {
          const unusable = evidenceFailure(view.evidence);
          if (unusable) {
            return {
              botId,
              state: "unreachable",
              reason: `The OpenShell sandbox ${view.name} may not be used: ${unusable}.`,
            };
          }
          return { botId, state: "ready" };
        }
        // A sandbox that was never created, or whose computer is not running, is simply absent: it
        // has no evidence to fail. A failed phase is neither, and saying absent would invite a
        // start that cannot work.
        if (view.state === "failed") {
          return {
            botId,
            state: "unreachable",
            reason: `The OpenShell sandbox ${view.name} is in a failed phase.`,
          };
        }
        return { botId, state: "absent" };
      } catch (error) {
        return {
          botId,
          state: "unreachable",
          reason:
            error instanceof Error && error.message.length > 0
              ? error.message
              : "Unknown failure.",
        };
      }
    },

    async stop(botId: string): Promise<{ wasRunning: boolean }> {
      const scope = await scopeOf(botId);
      return call(botId, "could not be stopped", () =>
        options.client.stopSandbox(scope),
      );
    },

    async reset(botId: string): Promise<{ cleared: boolean }> {
      const scope = await scopeOf(botId);
      /*
       * Only a computer may be reset here. A coding sandbox keeps the files a Bot is working in, and
       * clearing it is a separate decision with its own ticket; refusing is the honest answer until
       * that exists.
       */
      if (scope.environment !== "computer") {
        throw new ProviderError(
          `Resetting a ${scope.environment} sandbox is not supported; only a computer can be reset.`,
        );
      }
      return call(botId, "could not be reset", () =>
        options.client.resetSandbox(scope),
      );
    },

    async list(): Promise<ComputerLocation[]> {
      const sandboxes = await options.client
        .listSandboxes()
        .catch((error: unknown) => {
          throw new ProviderError(
            `The OpenShell computers could not be listed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      return sandboxes.map(({ scope, view }) => location(scope, view));
    },

    async sessionOf(botId: string): Promise<string | undefined> {
      const scope = await scopeOf(botId);
      const view = await call(botId, "could not be read", () =>
        options.client.inspectSandbox(scope),
      );
      return view.generation;
    },
  };
}

/**
 * The options a deployment's OpenShell mode runs on, read from what the chart mounted.
 *
 * Every input is a deployment fact the acceptance probe produced: the PKI paths, the digest-pinned
 * sandbox image it verified, and the probe receipt naming what it actually proved on that gateway
 * and that image. Anything missing is a refusal naming what is missing, because a computer on an
 * unproven substrate is not a computer.
 */
export async function openShellProviderOptions(
  config: OpenShellComputerConfig,
  read: (name: string) => string | undefined = (name) => process.env[name],
): Promise<OpenShellProviderOptions> {
  const inputs = openShellDeploymentInputs(config, read);
  const missing = missingCapabilities(inputs.capabilities);
  if (missing.length > 0) {
    throw new ProviderError(
      `${OPEN_SHELL_ENV.receipt} must record every capability the live probe proved for this substrate; missing ${missing.join(", ")}.`,
    );
  }
  if (inputs.servicePort !== undefined && config.token === undefined) {
    // A computer service that cannot authenticate its caller is a sandbox nobody may drive: refuse
    // at assembly rather than hand out an address that answers nothing.
    throw new ProviderError(
      `${OPEN_SHELL_ENV.servicePort} is set, so each sandbox must start a computer service, but COMPUTER_TOKEN is not set; refusing to place a computer whose service could not authenticate its caller.`,
    );
  }
  return {
    client: createOpenShellGatewayClient({
      endpoint: config.gatewayEndpoint,
      workspace: config.executionScope.workspaceId,
      image: inputs.image,
      caPath: inputs.paths.caPath,
      certPath: inputs.paths.certPath,
      keyPath: inputs.paths.keyPath,
      ...(inputs.servicePort !== undefined
        ? { servicePort: inputs.servicePort }
        : {}),
      // The in-sandbox service authenticates its caller with the Bot-facing token; without one a
      // sandbox has no computer, and the client refuses rather than placing an unauthenticated one.
      ...(config.token !== undefined ? { computerToken: config.token } : {}),
    }),
    scopeFor: async (botId) => ({
      tenantId: config.executionScope.tenantId,
      workspaceId: config.executionScope.workspaceId,
      botId,
      environment: "computer",
      generation: inputs.generation,
    }),
    capabilities: inputs.capabilities,
  };
}
