import {
  applyExecutionScopeHeaders,
  type ExecutionScope,
} from "@openbot/shared/execution-scope";
import type { ComputerConfig } from "../config";
import {
  createOpenShellComputerProvider,
  OPEN_SHELL_REQUIRED_CAPABILITIES,
  openShellProviderOptions,
  trustedOpenShellScopeFor,
} from "./openshell";
import { OPEN_SHELL_ENV, probeReceiptCapabilities } from "./openshell-client";
import {
  createSandboxComputerProvider,
  inClusterConfig,
  readSandboxTemplate,
} from "./sandbox";
import type { ComputerStatus } from "./schema";
import {
  createDockerSupervisorProvider,
  type SupervisorOptions,
} from "./supervisor";

/** The address and lifecycle details for one Bot's computer. */
export type ComputerLocation = {
  botId: string;
  status: "running" | "stopped";
  url?: string;
  startedAt?: string;
  egress?: string | null;
  /** Whether this computer runs an older image than a new one would get. Only a sandbox can tell. */
  updateAvailable?: boolean;
};

/** What moving a computer onto the current image did. */
export type ComputerUpdate = {
  /** False when it was already current, or there is no computer. */
  updated: boolean;
  /** Whether it was running, and is therefore restarting on the new image. */
  wasRunning: boolean;
  /** The images it ran and the ones it runs now, for the trail. */
  from?: string;
  to?: string;
};

/** A description of how a provider separates one Bot's computer from another. */
export type IsolationDescription = {
  isolation: "off" | "one computer per Bot" | "one shared computer";
  note: string;
  warning?: string;
};

/**
 * Which substrate a deployment's computers run on, and what a live probe proved about it.
 *
 * `verifiedCapabilities` is the probe's word, never the configuration's: it lists exactly what the
 * acceptance run signed off on, and an OpenShell deployment whose probe proved nothing lists nothing.
 * `verified` says whether that covers everything the substrate requires, which is what the admin
 * screen shows as verified or unverified. The legacy substrate needs no list; it is the mode the
 * deployment already ran.
 */
export type ComputerSubstrateStatus = {
  substrate: "legacy" | "openshell";
  verifiedCapabilities: readonly string[];
  verified: boolean;
};

/** An error from a computer provider. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Describe the isolation that this provider (or lack of provider) gives to Bots. */
export function describeComputerIsolation(
  provider?: ComputerProvider,
): IsolationDescription {
  if (!provider) {
    return {
      isolation: "off",
      note: "The computer feature is off. No computer provider is configured.",
    };
  }

  if (provider.isolation === "per-bot") {
    return {
      isolation: "one computer per Bot",
      note: "Each Bot gets its own isolated computer with its own /workspace and browser profile.",
    };
  }

  return {
    isolation: "one shared computer",
    note: "No supervisor is configured, so every Bot uses the same browser. Sessions, files and logins are shared between them. Set COMPUTER_SUPERVISOR_URL to give each Bot its own.",
    warning:
      "Every Bot shares one browser. Set COMPUTER_SUPERVISOR_URL for a computer each.",
  };
}

/**
 * A backend that gives Bots access to a computer.
 *
 * Implementations can use a computer for each Bot or one computer for all Bots.
 * Callers use this interface and do not need to know which backend is active.
 */
export interface ComputerProvider {
  /** The provider name for logs and status output. */
  readonly name: string;
  /** How the provider separates computers between Bots. */
  readonly isolation: "per-bot" | "shared";
  /** Return the base address of the computer for this Bot. */
  locate(botId: string): Promise<string>;
  /** Return the lifecycle state of the computer for this Bot. */
  status(botId: string): Promise<ComputerStatus>;
  /** Stop the computer for this Bot if it exists. */
  stop(botId: string): Promise<{ wasRunning: boolean }>;
  /** Remove the computer state for this Bot if it exists. */
  reset(botId: string): Promise<{ cleared: boolean }>;
  /** List the computers that this provider owns. */
  list(): Promise<ComputerLocation[]>;
  /**
   * Move this Bot's computer onto the current image, keeping its files and sign-ins.
   *
   * Only where a computer can be out of date with the deployment and the provider can replace it
   * in place: a Sandbox carries its pod template inline, so it keeps the one it was created with.
   */
  update?(botId: string): Promise<ComputerUpdate>;
  /** Prepare provider resources before the first computer request. */
  warm?(): Promise<void>;
  /**
   * The substrate this provider places computers on, when it can say. Absent on every provider
   * that runs the deployment's original mode: there is no second substrate to report. The
   * `verified` verdict is not for a provider to claim — `describeComputerSubstrate` derives it.
   */
  substrate?: Omit<ComputerSubstrateStatus, "verified">;
  /**
   * Which run of this Bot's computer is current, if the provider can tell.
   *
   * A snapshot's generation only orders snapshots within one run: a replaced container counts from
   * one again, so a ref from the run before it matches a row nothing has overwritten. This is what
   * tells the two apart.
   *
   * Every provider answers it, and where the answer comes from is the whole of the difference between
   * them: a container per Bot reads it off the container, a sandbox off the moment its browser last
   * became ready, and the one shared computer has to ask the computer, because that process serves
   * every Bot and outlives every reset. Optional in the type only for a provider that genuinely
   * cannot say; undefined then means unknown rather than mismatched, and the comparison is skipped
   * exactly as it was before any of this existed.
   */
  sessionOf?(botId: string): Promise<string | undefined>;
}

export type SharedComputerProviderOptions = {
  baseUrl: string;
  token?: string;
  /*
   * The execution ownership this deployment's computer calls state on the wire (MT050):
   * a scope injects the two headers, null refuses the dial (half-set configuration),
   * undefined skips injection — a deployment that wired no scope dials as it always did.
   */
  executionScope?: ExecutionScope | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};
type SharedComputerEntry = {
  botId: string;
  running?: boolean;
  status?: string;
  url?: string;
  startedAt?: string | null;
  egress?: string | null;
};
/**
 * Give every Bot the same computer.
 *
 * This adapter keeps shared deployments behind the same provider seam as the
 * Docker supervisor, and is the seam a remote backend plugs into.
 */
/** Printable ASCII, no control characters: what an HTTP header value may carry. */
const HEADER_SAFE = /^[\x20-\x7e]*$/;

export function createSharedComputerProvider(
  options: SharedComputerProviderOptions,
): ComputerProvider {
  const base = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  // A 0/negative timeout would abort every request instantly and read as "unreachable".
  const timeoutMs =
    options.timeoutMs === undefined ? 45_000 : Math.max(1, options.timeoutMs);

  function headers(botId?: string): Record<string, string> {
    // A header value must be printable ASCII without CR/LF; anything else makes fetch
    // throw a TypeError the caller would report as "unreachable".
    if (botId !== undefined && !HEADER_SAFE.test(botId))
      throw new ProviderError(
        `The shared computer cannot address a Bot id of ${JSON.stringify(botId)}.`,
      );
    return applyExecutionScopeHeaders(
      {
        ...(botId ? { "x-openbot-bot-id": botId } : {}),
        ...(options.token ? { "x-openbot-computer-token": options.token } : {}),
      },
      options.executionScope,
      () => {
        throw new ProviderError(
          "The shared computer requires execution ownership, and this deployment's scope is not usable: set both OPENBOT_COMPUTER_EXECUTION_TENANT_ID and OPENBOT_COMPUTER_EXECUTION_WORKSPACE_ID, or clear both.",
        );
      },
    );
  }

  async function call(
    path: string,
    method: "GET" | "POST",
    botId?: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: headers(botId),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ProviderError(
        `The shared computer at ${base} could not be reached (${error instanceof Error ? error.message : String(error)}).`,
      );
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new ProviderError(
        body?.error ?? `The shared computer answered ${response.status}.`,
      );
    }
    try {
      return await response.json();
    } catch {
      // A 2xx whose body is not JSON (a proxy page, an empty reply) used to read as
      // null, which stop/reset reported as wasRunning:false — say it is unreadable.
      throw new ProviderError(
        `The shared computer at ${base} answered ${response.status} with an unreadable body.`,
      );
    }
  }

  return {
    name: "shared",
    isolation: "shared",

    async locate(_botId: string): Promise<string> {
      return options.baseUrl;
    },

    /**
     * Which run of this Bot's browser is current, asked of the computer itself.
     *
     * NOTHING ELSE HERE KNOWS. A Bot with its own container gets a run from the container and a
     * sandbox gets one from the moment its browser last became ready; this deployment is one process
     * serving every Bot, and it outlives every reset, so the container says the same thing before and
     * after the browser it was asked about was replaced. The computer is the only party that can tell
     * a session apart from the one before it, so it is the one asked.
     *
     * NOT REMEMBERED, unlike the supervisor's, and the difference is `locate`: there it is an
     * `/ensure` that refreshes the answer before every action, while here it is a string and makes no
     * call at all. A cached run would then be the one this process first saw, for the life of the
     * process, which is exactly the stale answer this exists to stop giving.
     */
    async sessionOf(botId: string): Promise<string | undefined> {
      try {
        const body = (await call("/run", "GET", botId)) as {
          run?: unknown;
        } | null;
        return typeof body?.run === "string" && body.run.length > 0
          ? body.run
          : undefined;
      } catch {
        // Unknown, not mismatched. A computer that cannot be reached, or one from before this
        // endpoint existed, must not turn every ref into a refusal; the comparison goes back to
        // being skipped, which is where it started.
        return undefined;
      }
    },

    async status(botId: string): Promise<ComputerStatus> {
      try {
        await call("/health", "GET", botId);
        return { botId, state: "ready" };
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
      const body = (await call("/computers/stop", "POST", botId)) as {
        wasRunning?: boolean;
        stopped?: boolean;
      } | null;
      return {
        wasRunning: body?.wasRunning ?? body?.stopped ?? false,
      };
    },

    async reset(botId: string): Promise<{ cleared: boolean }> {
      const body = (await call("/computers/reset", "POST", botId)) as {
        cleared?: boolean;
        reset?: boolean;
      } | null;
      return {
        cleared: body?.cleared ?? body?.reset ?? false,
      };
    },

    async list(): Promise<ComputerLocation[]> {
      const body = (await call("/computers", "GET")) as {
        computers?: SharedComputerEntry[];
      };
      return (body?.computers ?? []).map((computer) => ({
        botId: computer.botId,
        status:
          computer.status === "running" || computer.running === true
            ? "running"
            : "stopped",
        url: computer.url ?? base,
        ...(computer.startedAt ? { startedAt: computer.startedAt } : {}),
        ...(computer.egress !== undefined ? { egress: computer.egress } : {}),
      }));
    },
  };
}

/** Report which substrate a provider places computers on; absence is the legacy mode. */
export function describeComputerSubstrate(
  provider?: Pick<ComputerProvider, "substrate">,
): ComputerSubstrateStatus {
  if (provider?.substrate?.substrate === "openshell") {
    const verifiedCapabilities = provider.substrate.verifiedCapabilities;
    return {
      substrate: "openshell",
      verifiedCapabilities,
      // Configuration text cannot verify a substrate: only a probe that proved every required
      // capability can, and a partial list is an unverified one.
      verified: OPEN_SHELL_REQUIRED_CAPABILITIES.every((capability) =>
        verifiedCapabilities.includes(capability),
      ),
    };
  }
  return { substrate: "legacy", verifiedCapabilities: [], verified: false };
}

/** Build the one computer provider selected by deployment configuration. */
export function createComputerProvider(
  config: ComputerConfig,
): ComputerProvider {
  switch (config.provider) {
    case "docker": {
      const options: SupervisorOptions = {
        baseUrl: config.baseUrl,
        ...(config.supervisorToken ? { token: config.supervisorToken } : {}),
      };
      return createDockerSupervisorProvider(options);
    }
    case "shared":
      return createSharedComputerProvider({
        baseUrl: config.baseUrl,
        ...(config.token ? { token: config.token } : {}),
        ...(config.executionScope !== undefined
          ? { executionScope: config.executionScope }
          : {}),
      });
    case "sandbox":
      /*
       * Built lazily, because reading the service account is asynchronous and this factory is not.
       * Every method needs the same credentials, so the promise is created once and awaited by each
       * rather than the file being read on every call.
       */
      return createLazySandboxProvider(config);
    case "openshell":
      // Same reason as the sandbox branch: its credentials and the proven-capability report are read
      // asynchronously, and a failure there must refuse the computer, not take the deployment down.
      return createLazyOpenShellProvider(config);
    default:
      // Unreachable while the union above is exhaustive; a provider value added to
      // ComputerConfig before this build implements it must refuse, not fall through.
      throw new Error(
        `The computer provider ${JSON.stringify((config as ComputerConfig).provider)} is not supported by this build.`,
      );
  }
}

/**
 * The sandbox provider, built on first use.
 *
 * Its credentials come off disk, which is asynchronous, and `createComputerProvider` is not. Rather
 * than make every caller await a factory, the work happens once behind a promise and each method
 * waits on the same one. A failure to read them surfaces on the first computer request, naming what
 * is missing, instead of taking the whole deployment down at boot over a feature it may not use.
 */
function createLazySandboxProvider(
  config: Extract<ComputerConfig, { provider: "sandbox" }>,
): ComputerProvider {
  let built: Promise<ComputerProvider> | undefined;

  const provider = async (): Promise<ComputerProvider> => {
    /*
     * A FAILURE IS NOT REMEMBERED, only a success.
     *
     * `??=` holds whatever the first call produced, and a rejected promise is something. One
     * unreadable token file or one blip reading the template at the wrong moment, and every computer
     * request for the rest of the pod's life failed with that same stale error: no probe notices,
     * because the pod is serving happily, and nothing recovers short of a restart. Clearing the memo
     * on rejection makes the next request try again, which is what a transient failure deserves.
     */
    built ??= (async () => {
      const [cluster, template] = await Promise.all([
        inClusterConfig(),
        readSandboxTemplate(config.templateFile),
      ]);
      return createSandboxComputerProvider({
        namespace: config.namespace,
        idleAfterMs: config.idleAfterMs,
        template,
        apiServer: cluster.apiServer,
        token: cluster.token,
        ca: cluster.ca,
      });
    })().catch((error: unknown) => {
      built = undefined;
      throw error;
    });
    return built;
  };

  return {
    name: "sandbox",
    isolation: "per-bot",
    locate: async (botId) => (await provider()).locate(botId),
    status: async (botId) => (await provider()).status(botId),
    stop: async (botId) => (await provider()).stop(botId),
    reset: async (botId) => (await provider()).reset(botId),
    list: async () => (await provider()).list(),
    // Forwarded like the rest, or the gateway sees no `update` and "Update computer" answers 503.
    update: async (botId) => {
      const built = await provider();
      if (!built.update)
        throw new Error("The sandbox computer provider cannot update.");
      return built.update(botId);
    },
    sessionOf: async (botId) => (await provider()).sessionOf?.(botId),
  };
}

/**
 * The OpenShell provider, built on first use for the same reason as the sandbox one: its
 * credentials are read asynchronously, and a failure is not remembered, so a deployment whose
 * credentials arrive late recovers on the next request instead of needing a restart. The probe
 * receipt is read once, when this wrapper is built, and one that arrives later changes nothing
 * until a restart.
 */
function createLazyOpenShellProvider(
  config: Extract<ComputerConfig, { provider: "openshell" }>,
): ComputerProvider {
  let built: Promise<ComputerProvider> | undefined;

  const provider = async (): Promise<ComputerProvider> => {
    built ??= openShellProviderOptions(config)
      .then((options) =>
        createOpenShellComputerProvider({
          ...options,
          /*
           * T02: whatever resolver the options carry is bounded by the deployment's own scope
           * facts here, at the assembly seam, so a resolver wired to an authenticated request path
           * cannot place a sandbox in another team's tenant or workspace.
           */
          scopeFor: trustedOpenShellScopeFor(
            options.scopeFor,
            config.executionScope,
          ),
        }),
      )
      .catch((error: unknown) => {
        built = undefined;
        throw error;
      });
    return built;
  };

  return {
    name: "OpenShell",
    isolation: "per-bot",
    // The capability list is the probe receipt's word, read here rather than after the lazy build:
    // the fleet must be able to report an unverified substrate even when the provider refuses to
    // place a computer on it. A receipt that does not parse, or belongs to another gateway or
    // image, proves nothing and reads as no capabilities.
    substrate: {
      substrate: "openshell",
      verifiedCapabilities: probeReceiptCapabilities(
        process.env[OPEN_SHELL_ENV.receipt],
        {
          gatewayEndpoint: config.gatewayEndpoint,
          sandboxImage: process.env[OPEN_SHELL_ENV.image] ?? "",
        },
      ),
    },
    locate: async (botId) => (await provider()).locate(botId),
    status: async (botId) => (await provider()).status(botId),
    stop: async (botId) => (await provider()).stop(botId),
    reset: async (botId) => (await provider()).reset(botId),
    list: async () => (await provider()).list(),
    sessionOf: async (botId) => (await provider()).sessionOf?.(botId),
  };
}
