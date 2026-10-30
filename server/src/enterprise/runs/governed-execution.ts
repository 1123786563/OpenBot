import { randomUUID } from "node:crypto";
import type { LanguageModel } from "ai";
import type { ModelCredentialSecretReader } from "../../credentials";
import type {
  ModelInvocationContext,
  PlatformScope,
  RunFailureCode,
  RunService,
} from "../contracts";
import { createAiSdkV3GatewayAdapter } from "../models/ai-sdk-v3-gateway-adapter";
import type { ModelGatewayDependencies } from "../models/gateway";
import { createModelGateway } from "../models/gateway";
import { createRuntimeModelAdapter } from "../models/runtime-adapter";
import type {
  ModelRouteCatalogStore,
  ModelRouteSnapshotInput,
} from "./model-route-catalog";
import { rebindModelRoute } from "./model-route-rebind";

type LanguageModelV3 = Extract<LanguageModel, { specificationVersion: "v3" }>;

/**
 * The server-only collaborator a governed admission hands the agent resolver.
 *
 * Carries everything `builtInAgentConfiguration` needs to build the Bot's
 * classic config around the governed gateway adapter instead of a provider
 * SDK: the model instance itself, the server-set output ceiling, and the
 * consumption mark the Runner checks to prove the collaborator actually
 * reached the per-run rebuild point. Never a wire field, never a global.
 *
 * `executionBinding` (ME02) publishes the server-issued execution facts the
 * Mastra engine binding consumes: the admitted scope and Bot, the run
 * identities the Runner bound post-start, and a server-generated execution
 * key. Absent on a collaborator built before `bind`, so a call that arrives
 * before the Runner bound the run fails closed rather than guessing identity.
 */
export interface GovernedModelRequest {
  readonly model: LanguageModelV3;
  readonly maxOutputTokens: number;
  markConsumed(): void;
  executionBinding?(): GovernedExecutionFacts | null;
}

/** The server-issued execution facts of one governed admission (ME02). */
export interface GovernedExecutionFacts {
  readonly scope: PlatformScope;
  readonly botId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly executionKey: string;
}

/** The admitted identity a carrier accepts invocations for, bound post-start. */
export interface GovernedExecutionBinding {
  readonly runId: string;
  readonly attemptId: string;
  readonly generation: number;
}

/**
 * One request-local governed model execution: the admitted {scope, runId,
 * attemptId, generation, routeRef, ceiling, lease} plus the gateway, adapter,
 * and settlement ledger built around them.
 */
export interface GovernedModelExecution {
  readonly governedModel: GovernedModelRequest;
  bind(binding: GovernedExecutionBinding): void;
  wasModelConsumed(): boolean;
  settlementClean(): boolean;
  /** Whether a capability issue came back as a terminal 402 budget refusal. */
  budgetExhausted(): boolean;
  /** Whether an authoritative usage confirmation was refused by the service. */
  settlementFailed(): boolean;
}

export type GovernedModelExecutionDependencies = {
  readonly scope: PlatformScope;
  readonly agentId: string;
  readonly routeRef: string;
  readonly ceiling: number;
  readonly runs: RunService;
  readonly catalog: Pick<ModelRouteCatalogStore, "get">;
  readonly currentRouteForAgent: (
    agentId: string,
  ) => Promise<ModelRouteSnapshotInput | null>;
  readonly modelCapabilitySecret: string | Uint8Array;
  readonly encryptionKey: string;
  readonly credentialReader: ModelCredentialSecretReader;
  readonly environment?: Record<string, string | undefined>;
  readonly fetch?: typeof fetch;
  /**
   * ME10: tokens this run has ALREADY settled before this carrier was
   * built (the resume drive). The adapter's settlement ledger starts
   * there, so the resumed dials ask for the run's REMAINING budget —
   * never the ceiling again on top of what earlier dials spent.
   */
  readonly alreadySettledTokens?: number;
};

const unauthorized = (code: string): never => {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  throw error;
};

const isBudgetExhaustion = (error: unknown): boolean => {
  const candidate = error as { status?: unknown; code?: unknown } | null;
  if (!candidate || typeof candidate !== "object") return false;
  if (candidate.status === 402) return true;
  return (
    candidate.code === "MODEL_BUDGET_EXCEEDED" ||
    candidate.code === "MODEL_ROUTE_BUDGET_EXCEEDED"
  );
};

/**
 * Classify a governed execution failure into the complete fixed taxonomy.
 * Budget exhaustion (a 402 capability issue or an exhausted remaining
 * ceiling) is MODEL_BUDGET_EXCEEDED, a failed authoritative usage
 * confirmation is MODEL_SETTLEMENT_FAILED, and everything else — upstream
 * faults, malformed streams, missing terminal usage — is
 * MODEL_EXECUTION_FAILED. Never a free-form code.
 */
export function classifyGovernedRunFailure(
  carrier: Pick<
    GovernedModelExecution,
    "budgetExhausted" | "settlementFailed"
  > | null,
  error?: unknown,
): RunFailureCode {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  // A structured code is preferred over text matching; the text scan stays
  // as the fallback for errors that never carried one (M-k).
  const structured =
    error instanceof Error ? (error as { code?: unknown }).code : undefined;
  const codeText = typeof structured === "string" ? structured : "";
  const budgetMarkers = [
    "MODEL_GATEWAY_RUN_BUDGET_EXHAUSTED",
    "MODEL_BUDGET_EXCEEDED",
    "MODEL_ROUTE_BUDGET_EXHAUSTED",
  ];
  if (
    carrier?.budgetExhausted() ||
    budgetMarkers.some(
      (marker) => text.includes(marker) || codeText.includes(marker),
    )
  ) {
    return "MODEL_BUDGET_EXCEEDED";
  }
  // The carrier's own settlement ledger is authoritative: a refused usage
  // confirmation is MODEL_SETTLEMENT_FAILED whatever error text surfaced.
  if (
    carrier?.settlementFailed() ||
    codeText.includes("MODEL_SETTLEMENT_FAILED") ||
    text.includes("MODEL_SETTLEMENT_FAILED")
  )
    return "MODEL_SETTLEMENT_FAILED";
  return "MODEL_EXECUTION_FAILED";
}

/**
 * Build the request-local governed model execution for one admitted run.
 *
 * The route reference, ceiling, and scope are known at admission start; the
 * run, attempt, and lease identities are bound the moment the RunService
 * hands back the request lease, and any invocation attempt before that
 * binding fails closed. Every collaborator the model gateway needs — the
 * capability service, the route catalog, the encrypted credential reader —
 * is the same server authority that admitted the run; nothing here reads a
 * client selector.
 */
export function createGovernedModelExecution(
  deps: GovernedModelExecutionDependencies,
): GovernedModelExecution {
  let binding: GovernedExecutionBinding | null = null;
  let consumed = false;
  let settlementFailed = false;
  let budgetExhausted = false;
  const issued = new Set<string>();
  const confirmed = new Set<string>();
  const unknown = new Set<string>();
  // ME02: the engine execution identity — the client never names it. Minted
  // at bind (not admission) so the engine run id stays 1:1 with the bound
  // {attemptId, generation} even if a carrier is ever rebound: execution.ts
  // uses it directly as the Mastra run id. Lazy (`undefined` until bind) so
  // the type itself carries the invariant: no key exists before bind() minted
  // one, and an admission without a bound key publishes no facts at all.
  let executionKey: string | undefined;

  /*
   * The gateway's environment copy strips the deployment's BOT_MODEL and
   * BOT_PROVIDER overrides AFTER the effective route was selected: route
   * selection reads the catalog, never the environment, so removing them
   * here cannot change the route — it only stops runtimeModelForEnvironment
   * from silently re-pointing the dial at a different model. The native
   * destination variables stay, because the native base URL fingerprint is
   * part of drift checking.
   */
  const environment: Record<string, string | undefined> = {
    ...(deps.environment ?? process.env),
  };
  delete environment.BOT_MODEL;
  delete environment.BOT_PROVIDER;

  const issueCapability = async (maximumTokens: number): Promise<string> => {
    if (!binding) throw new Error("GOVERNED_EXECUTION_UNBOUND");
    // Mint-point defense: never cast a capability above the admitted ceiling;
    // resolveInvocation re-checks the minted context with the same code.
    if (maximumTokens > deps.ceiling)
      throw unauthorized("MODEL_INVOCATION_BINDING_MISMATCH");
    // Fresh modelRequestId per invocation: a retry mints a new capability
    // rather than replaying one, and a 402 is terminal, never retried.
    const modelRequestId = randomUUID();
    try {
      const minted = await deps.runs.issueModelInvocationCapability(
        deps.scope,
        {
          runId: binding.runId,
          attemptId: binding.attemptId,
          generation: binding.generation,
          modelRequestId,
          maximumTokens,
        },
      );
      issued.add(minted.capability);
      return minted.capability;
    } catch (error) {
      if (isBudgetExhaustion(error)) budgetExhausted = true;
      throw error;
    }
  };

  const resolveInvocation: ModelGatewayDependencies["resolveInvocation"] =
    async (request) => {
      if (!binding) throw unauthorized("GOVERNED_EXECUTION_UNBOUND");
      const header = request.headers.get("authorization") ?? "";
      const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
      if (!bearer) throw unauthorized("MODEL_CAPABILITY_INVALID");
      const capability = bearer[1];
      const context: ModelInvocationContext =
        await deps.runs.resolveModelInvocationCapability(
          deps.scope,
          capability,
        );
      // The capability must be exactly this admission's: same scope, run,
      // attempt, generation, and admitted route, within the admitted ceiling.
      if (
        context.tenantId !== deps.scope.tenantId ||
        context.workspaceId !== deps.scope.workspaceId ||
        context.principalId !== deps.scope.principalId ||
        context.runId !== binding.runId ||
        context.attemptId !== binding.attemptId ||
        context.generation !== binding.generation ||
        context.modelRouteRef !== deps.routeRef ||
        context.maximumTokens > deps.ceiling
      ) {
        throw unauthorized("MODEL_INVOCATION_BINDING_MISMATCH");
      }
      return {
        context,
        confirmUsage: async (usedTokens: number) => {
          try {
            await deps.runs.confirmModelInvocationUsage(
              deps.scope,
              capability,
              usedTokens,
            );
            confirmed.add(capability);
          } catch (error) {
            settlementFailed = true;
            throw error;
          }
        },
        markUnknown: async () => {
          unknown.add(capability);
          await deps.runs.markModelInvocationUnknown(deps.scope, capability);
        },
      };
    };

  const selectModel: ModelGatewayDependencies["selectModel"] = async (
    routeRef,
  ) => {
    // Absence or drift fails closed before any credential read or network
    // call: the gateway turns null into a 400 MODEL_ROUTE_UNAVAILABLE.
    if (routeRef !== deps.routeRef) return null;
    try {
      return await rebindModelRoute({
        scope: deps.scope,
        routeRef,
        catalog: deps.catalog,
        currentRouteForAgent: deps.currentRouteForAgent,
        modelCapabilitySecret: deps.modelCapabilitySecret,
      });
    } catch (cause) {
      // Route drift is an expected fail-closed outcome; an infrastructure
      // fault is not, and must be distinguishable in logs (M-j).
      if (
        !(cause instanceof Error && cause.message.startsWith("MODEL_ROUTE_"))
      ) {
        // biome-ignore lint/suspicious/noConsole: stable-code operational log
        console.error({
          error: "MODEL_ROUTE_REBIND_INFRASTRUCTURE_FAILED",
          context: { routeRef, agentId: deps.agentId },
          cause: cause instanceof Error ? cause.message : String(cause),
        });
      }
      return null;
    }
  };

  const runtimeAdapter = createRuntimeModelAdapter({
    encryptionKey: deps.encryptionKey,
    reader: deps.credentialReader,
    selectModel,
  });
  const gateway = createModelGateway({
    resolveInvocation,
    selectModel,
    resolveApiKey: (provider, route, environment) =>
      runtimeAdapter.resolveApiKey(route, provider, environment),
    environment,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  const adapter = createAiSdkV3GatewayAdapter({
    gateway,
    routeRef: deps.routeRef,
    runTokenCeiling: deps.ceiling,
    issueCapability,
    // ME10: a resumed drive's carrier starts its ledger at what the run has
    // already settled, so the resumed dials ask for the REMAINING budget.
    ...(deps.alreadySettledTokens !== undefined
      ? { alreadySettledTokens: deps.alreadySettledTokens }
      : {}),
  });

  const governedModel: GovernedModelRequest = {
    model: adapter,
    maxOutputTokens: deps.ceiling,
    markConsumed: () => {
      consumed = true;
    },
    // ME02: the server-issued execution facts for the Mastra engine binding.
    // Null until the Runner binds the run identities — never guessed. A
    // binding without its minted key (unreachable today: bind() always mints
    // one) reports null too, so the consumer's UNBOUND refusal covers it
    // instead of an `undefined` key slipping through as an identity.
    executionBinding: () => {
      if (!binding || executionKey === undefined) return null;
      return {
        scope: deps.scope,
        botId: deps.agentId,
        runId: binding.runId,
        attemptId: binding.attemptId,
        generation: binding.generation,
        executionKey,
      };
    },
  };

  return {
    governedModel,
    bind(next) {
      binding = next;
      // Fresh engine identity per binding: the Mastra run id is minted with
      // the {attemptId, generation} it maps back to, never reused across a
      // rebinding.
      executionKey = randomUUID();
    },
    wasModelConsumed: () => consumed,
    settlementClean: () =>
      issued.size > 0 &&
      confirmed.size === issued.size &&
      unknown.size === 0 &&
      !settlementFailed &&
      !budgetExhausted,
    budgetExhausted: () => budgetExhausted,
    settlementFailed: () => settlementFailed,
  };
}
