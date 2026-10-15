import { createOpenAI } from "@ai-sdk/openai";
import { randomUUID } from "node:crypto";
import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/client";
import { AbstractAgent, HttpAgent } from "@ag-ui/client";
import type {
  AgentRunnerConnectRequest,
  AgentRunnerIsRunningRequest,
  AgentRunnerRunRequest,
  AgentRunnerStopRequest,
  AgentsConfig,
  BuiltInAgentConfiguration,
} from "@copilotkit/runtime/v2";
import {
  AgentRunner,
  BuiltInAgent,
  CopilotKitIntelligence,
  CopilotRuntime,
  CopilotSseRuntime,
} from "@copilotkit/runtime/v2";
import { createCopilotHonoHandler } from "@copilotkit/runtime/v2/hono";
import type { Observable } from "rxjs";
import {
  defer,
  finalize,
  from,
  fromEvent,
  switchMap,
  takeUntil,
  throwError,
} from "rxjs";
import { z } from "zod";
import { PROVENANCE_GUIDANCE } from "../../shared/bot-prompt";
import { getLogger } from "../../shared/logger";
import {
  type ActorAgentResolver,
  CoworkerUnavailableError,
} from "./agents/agent-resolver";
import { sanitizeSeededHistory } from "./agents/history-sanitize";
import {
  PLAN_RUN_COMPLETED,
  PlanModel,
  type PlanModelConfig,
  planModelForEnvironment,
} from "./agents/plan-model";
import type { AgentActor } from "./agents/profile-types";
import {
  executeNativeApprovalTool,
  nativeApprovalRun,
} from "./approvals/native-context";
import type { AuditInitiator } from "./audit";
import {
  attachmentIdsIn,
  newInlineBudget,
  resolveAttachmentParts,
  type StoredAttachment,
} from "./channels/attachment-parts";
import type { AgentFetch, StallGuard } from "./channels/stall-guard";
import { HeadlessToolsMiddleware } from "./computer/headless-tools";
import type { DeploymentConfig } from "./config";
import { observeModelConnection } from "./desktop-connection-failure";
import { desktopTelemetryProperties } from "./desktop-telemetry";
import type { GovernedModelRequest } from "./enterprise/runs/governed-execution";
import type { LoadKnowledgeForBot } from "./knowledge/retrieval";
import {
  currentRunnerRequest,
  withRunnerRequestContext,
} from "./enterprise/runs/request-context";
import { observeIntelligenceAuthentication } from "./intelligence-client";
import { RemoteLearnedSkillsMiddleware } from "./learning/remote";
import {
  type AcquireLearnedSkills,
  createLearningRuntime,
  LEARNED_SKILL_TOOL_NAMES,
  type LearnedSkillInvocation,
  type LearningRuntime,
} from "./learning/runtime";
import type { LearningSettingsStore } from "./learning/settings";
import {
  type LoadPersonalMemory,
  PersonalMemoryMiddleware,
} from "./memory/tools";
import type { SelectableSkill, Selection } from "./plugins/selection";
import {
  latestUserText,
  SELECTION_FLOOR,
  selectTools,
} from "./plugins/selection";
import type { GrantedTool } from "./plugins/tools";
import { grantedToolGuidance, parametersFor } from "./plugins/tools";
import { UNTRUSTED_GUIDANCE } from "./untrusted-content";
import { currentUsageOrigin, type UsageOrigin } from "./usage-origin";

export { currentRunnerRequest, withRunnerRequestContext };

export function createRequestBoundAgentRunner(
  runnerForRequest: (request: Request) => AgentRunner,
): AgentRunner {
  return new (class extends AgentRunner {
    override run(request: AgentRunnerRunRequest) {
      try {
        return runnerForRequest(currentRunnerRequest()).run(request);
      } catch (error) {
        return throwError(() => error);
      }
    }

    override connect(request: AgentRunnerConnectRequest) {
      try {
        return runnerForRequest(currentRunnerRequest()).connect(request);
      } catch (error) {
        return throwError(() => error);
      }
    }

    override async isRunning(request: AgentRunnerIsRunningRequest) {
      return runnerForRequest(currentRunnerRequest()).isRunning(request);
    }

    override async stop(request: AgentRunnerStopRequest) {
      return runnerForRequest(currentRunnerRequest()).stop(request);
    }
  })();
}

export function createCopilotSseRuntime(
  agents: AgentsConfig,
  runner: AgentRunner,
) {
  return new CopilotSseRuntime({ agents, runner });
}

/**
 * The CopilotKit runtime: Intelligence mode, or SSE mode once the durable enterprise Runner is
 * composed.
 *
 * Package-declared built-in Bots run as CopilotKit `BuiltInAgent` instances. External Bots
 * (remote_ag_ui / remote_mastra) currently fail closed: until the durable Runner can verify a
 * third-party endpoint against a per-run budget, they resolve to UnavailableAgent
 * (REMOTE_RUN_BUDGET_UNVERIFIED) instead of being dialled over AG-UI.
 */

/** Resolve the signed-in person for a request. Threads and memory are scoped to whoever this returns. */
export type IdentifyUser = (
  request: Request,
) => Promise<{ id: string; name: string }>;

export type RegisteredBuiltInAgent = {
  id: string;
  name: string;
  type: "built_in";
  systemPrompt: string;
  /** Trusted source classification carried from the actor-scoped runtime row. */
  expertSource?: "tenant_package" | "user_profile" | "team_bot";
};

type RegisteredRemoteAgentFacts = {
  id: string;
  name: string;
  endpoint: string;
  /** Which agent on the endpoint, for a server that serves a roster. See `remoteTransport`. */
  remoteAgentId?: string;
  standingMessage: StandingRoleMessage;
  /** The key this agent sits behind, resolved from the vault at load time. Never logged. */
  headers?: Record<string, string>;
};

/**
 * A Bot at somebody else's endpoint, in the two ways this deployment knows how to dial one.
 *
 * The kinds differ in transport and in nothing else: the difference ends at `remoteTransport`, which
 * returns an `AbstractAgent` either way, and every control after that is written against that
 * interface. What is deliberate here is the SHAPE. This is a union of two single-literal variants
 * rather than one type whose `type` is `"remote_ag_ui" | "remote_mastra"`, because TypeScript will
 * not eliminate a union member whose discriminant is itself a union: excluding both literals narrows
 * the property and keeps the member, so the built-in path below would silently stop being narrowed
 * to a built-in Bot. Verified against tsc 5.x; collapsing these two back into one costs that.
 */
type RegisteredRemoteAgent =
  | (RegisteredRemoteAgentFacts & { type: "remote_ag_ui" })
  | (RegisteredRemoteAgentFacts & { type: "remote_mastra" });

/**
 * A coworker the caller may see but may not run: its profile was deleted while a channel it worked
 * in still exists. It is registered so Intelligence can restore that thread and the person can read
 * what was said; every run is refused here, without contacting the endpoint.
 */
type RegisteredUnavailableAgent = {
  id: string;
  name: string;
  type: "unavailable";
  reason: string;
};

export type RegisteredAgent =
  | RegisteredBuiltInAgent
  | RegisteredRemoteAgent
  | RegisteredUnavailableAgent;

type AgentRunInput = Parameters<AbstractAgent["run"]>[0];
type AgentMessage = AgentRunInput["messages"][number];
type AgentContext = NonNullable<AgentRunInput["context"]>[number];
export type StandingRoleMessage = Extract<AgentMessage, { role: "system" }>;
type AgentHeaders = Record<string, string>;
type HeaderBearingAgent = AbstractAgent & { headers?: AgentHeaders };

/** The durable part of a coworker: who it is and what its standing job is. */
export type AgentStandingProfile = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
};

/**
 * The coworker's job, as one system message.
 *
 * It is an ordinary AG-UI system message rather than `forwardedProps` or framework-specific state
 * because the endpoint on the other side may be LangGraph, Mastra, ADK or a hand-written server, and
 * a system message is the only thing all of them already understand. The id is derived from the
 * agent so a run can recognise a copy of it and refuse to send a second.
 */
export function standingRoleMessage(
  profile: AgentStandingProfile,
): StandingRoleMessage {
  return {
    id: `standing-role:${profile.id}`,
    role: "system",
    content: [
      `You are ${profile.name}, ${profile.title}.`,
      profile.roleDescription,
      "This standing role applies in every channel. Treat channel messages as task-specific instructions within it.",
      /*
       * Here rather than in the package, because for a remote Bot the standing role is the only
       * instruction there is: `role_description` is one sentence somebody wrote about what it is
       * for, and nothing else reaches it. The compliance Bot that answered a filing question with
       * thresholds and deadlines and no source was a `remote-ag-ui` agent whose entire prompt was
       * "Investigate policies, transaction monitoring, and control evidence."
       */
      PROVENANCE_GUIDANCE,
      // And for the same reason, how to read the untrusted-content envelope its tool results carry.
      UNTRUSTED_GUIDANCE,
    ].join("\n\n"),
  };
}

export type RuntimeModel = {
  provider: "openai" | "anthropic";
  defaultModel: string;
  plan?: PlanModelConfig;
};

/** Optional desktop environment values may be present but blank; SDKs treat them as URLs. */
export function normalizeModelBaseUrls(
  environment: Record<string, string | undefined> = process.env,
): void {
  for (const key of ["OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"]) {
    const value = environment[key]?.trim();
    if (!value) {
      delete environment[key];
    } else if (key === "ANTHROPIC_BASE_URL") {
      // The SDK appends only /messages; match the selector's versioned-base contract.
      const base = value.replace(/\/+$/, "");
      environment[key] = /\/v\d+$/.test(base) ? base : `${base}/v1`;
    } else {
      environment[key] = value;
    }
  }
}

export function runtimeModelForEnvironment(
  packageModel: RuntimeModel,
  environment: Record<string, string | undefined> = process.env,
): RuntimeModel {
  const selectedModel = environment.BOT_MODEL?.trim();
  const selectedProvider = environment.BOT_PROVIDER?.trim().toLowerCase();
  // The desktop writes an empty provider when switching back to OpenAI. An absent
  // choice leaves the tenant package authoritative.
  const provider =
    selectedProvider === "anthropic"
      ? "anthropic"
      : selectedProvider === "openai" || selectedProvider === ""
        ? "openai"
        : packageModel.provider;
  const defaultModel =
    provider === packageModel.provider
      ? packageModel.defaultModel
      : provider === "anthropic"
        ? "claude-sonnet-4-5"
        : "gpt-5.6-terra";
  const selectedModelApplies =
    provider === "anthropic" ||
    ((!selectedProvider || selectedProvider === "openai") &&
      !!environment.OPENAI_BASE_URL?.trim());
  return {
    provider,
    plan: planModelForEnvironment(environment),
    defaultModel:
      selectedModelApplies && selectedModel ? selectedModel : defaultModel,
  };
}

type RuntimeAgentRow = {
  id: string;
  name: string;
  type: "built_in" | "remote_ag_ui" | "remote_mastra";
  configuration: unknown;
  title: string;
  roleDescription: string;
};

export function registeredAgentFromRow(
  row: RuntimeAgentRow,
): RegisteredAgent | null {
  if (!isPlainObject(row.configuration)) {
    return null;
  }
  const configuration = row.configuration;
  if (row.type === "built_in") {
    const systemPrompt = configuration?.systemPrompt;
    const trimmedSystemPrompt =
      typeof systemPrompt === "string" ? systemPrompt.trim() : "";
    return trimmedSystemPrompt.length > 0
      ? {
          id: row.id,
          name: row.name,
          type: "built_in",
          systemPrompt: trimmedSystemPrompt,
        }
      : null;
  }

  const endpoint = configuration?.endpoint;
  /*
   * Which agent on that endpoint, when the endpoint serves more than one.
   *
   * Mastra servers are rosters rather than single agents, so a Bot row has to say which one it is.
   * Absent falls back to this Bot's own id and then, on a single-agent server, to the only one
   * there: see `remoteTransport`.
   */
  const remoteAgentId = configuration?.remoteAgentId;
  return typeof endpoint === "string" && isHttpUrl(endpoint)
    ? {
        id: row.id,
        name: row.name,
        type: row.type === "remote_mastra" ? "remote_mastra" : "remote_ag_ui",
        endpoint,
        ...(typeof remoteAgentId === "string" && remoteAgentId.length > 0
          ? { remoteAgentId }
          : {}),
        standingMessage: standingRoleMessage(row),
      }
    : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isHttpUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * What the person asking has said they want, in every channel, from every coworker.
 *
 * The OpenBot equivalent of a CLAUDE.md, and the third instruction carrier beside the two that
 * already existed. A role is the coworker's and reads the same to everybody who talks to it; a skill
 * is pulled in for one task. This is the person's, and it is true of every task they ever ask for —
 * how they want to be written to, what their company is called, what it is not to be called.
 *
 * THE PRECEDENCE SENTENCE IS PART OF THE BLOCK, not decoration. Two standing instructions in one
 * prompt is a conflict waiting to be resolved by whichever the model read last, and the answer is
 * not symmetric: a person may say how they want things done, and must not be able to say what a
 * coworker is for. Without the sentence, "always answer in one line" quietly overrides a role that
 * exists to produce a filing with its sources in it.
 *
 * BUILT-IN COWORKERS ONLY. A remote AG-UI bot runs its own loop at somebody else's endpoint, and
 * everything this deployment sends it is a standing system message rather than a prompt it composes
 * — see `remoteAgentWithStandingRole`. Adding a third message there is a real change with its own
 * questions (whether an endpoint that ignores the role would honour this, and whether one
 * deployment's person may address another's server with their own prose), and it is deliberately not
 * made here.
 *
 * Null for anything blank, so the caller has one thing to test rather than an empty paragraph to
 * detect.
 */
export function standingInstructionsGuidance(
  instructions: string | null | undefined,
): string | null {
  const trimmed = instructions?.trim() ?? "";
  if (trimmed.length === 0) return null;

  return [
    `The person you are working with has standing instructions that apply in every channel and every task, alongside your role: ${trimmed}`,
    "Where the two conflict, the role decides what you do and these decide how you do it.",
  ].join("\n\n");
}

const log = getLogger("server");

/**
 * The model a built-in Bot runs on, as the runtime's agent config takes it.
 *
 * `OPENAI_BASE_URL` is documented as an endpoint speaking `/v1/chat/completions`, but the runtime's
 * own `openai/...` string resolution calls the Responses API on whatever base it was given, which
 * such endpoints do not implement — a gateway deployment fails every run with a 404 from
 * `/responses`. So a named base URL gets the chat-completions model instance built here (pinned to
 * the SDK version the runtime itself ships, so there is never a second AI SDK in the process);
 * official OpenAI, which has the Responses API, and Anthropic keep the runtime's string form.
 */
function runtimeModel(model: RuntimeModel, apiKey: string | null) {
  if (model.provider !== "openai")
    return `${model.provider}/${model.defaultModel}`;
  const baseURL = process.env.OPENAI_BASE_URL?.trim();
  if (!baseURL) return `openai/${model.defaultModel}`;
  return createOpenAI({
    apiKey: apiKey ?? undefined,
    baseURL,
  }).chat(model.defaultModel);
}

/**
 * Where every built-in Bot's token consumption lands, once this deployment has billing.
 *
 * A module-level setter rather than an import: the billing seam is optional — a deployment without
 * a provider mounts none of it — and `copilot.ts` must not grow a dependency on a module that is
 * often absent. `index.ts` wires the billing service's meter in at assembly; the default drops
 * usage on the floor, which is exactly right for a deployment that meters nowhere.
 */
let usageMeter:
  | ((usage: ModelUsageReport) => void | Promise<void>)
  | undefined;

export function setModelUsageMeter(
  meter: ((usage: ModelUsageReport) => void | Promise<void>) | undefined,
) {
  usageMeter = meter;
}

export type ModelUsageFailureReason =
  | "provider_error"
  | "stream_error"
  /** The stream ended before any finish part: we never learned the cost. Retained, not free. */
  | "usage_missing"
  /** The provider reported a finish with zero tokens: a confirmed no-cost. Released. */
  | "no_usage"
  | "cancelled"
  | "bound_refused";

/** One billed call's finished usage, the shape the meter and the lifecycle finish share. */
export type ModelUsageReport = {
  eventId: string;
  occurredAt: Date;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
};

/**
 * What one built-in model call's observation bypass saw: the verdict the metered path
 * already reached, read after the fact. Structural on purpose — `copilot.ts` must not
 * depend on the observability module a deployment may not have; `index.ts` adapts this
 * fact into the recorder's observation at assembly.
 */
export type BuiltinModelSpanFact = {
  eventId: string;
  startedAt: Date;
  endedAt: Date;
  provider: string | undefined;
  modelId: string | null;
  ending:
    | { kind: "succeeded"; inputTokens: number; outputTokens: number }
    | { kind: "refused"; code: string }
    | { kind: "settlement_failed"; code: string }
    | { kind: "failed"; code: "provider_error" | "stream_error" }
    | { kind: "canceled" }
    | { kind: "usage_missing" };
  /** The serialized provider request prompt; raw here, projected at the recorder. */
  input: string | null;
  /** The accumulated output text; raw here, projected at the recorder. */
  output: string | null;
};

/**
 * The model-span observer, wired at assembly exactly like the meter: absent means no
 * observation happens at all — no prompt serialization, no delta accumulation, nothing.
 */
let builtinModelSpanObserver:
  | ((fact: BuiltinModelSpanFact) => void)
  | undefined;

export function setBuiltinModelSpanObserver(
  observer: ((fact: BuiltinModelSpanFact) => void) | undefined,
) {
  builtinModelSpanObserver = observer;
}

/**
 * How the input side of one billed call is provably bounded BEFORE the provider is called.
 *
 * A reservation is not a provider limit: admission needs a proof that billable input cannot
 * exceed the configured maximum. `counted` is a conservative pre-call count of the effective
 * provider request — with an optional `fit` that self-enforces the ceiling by shrinking the
 * request before it is priced and sent (ADR-0001); a provider-side exact count, where one
 * exists, remains the ideal. `unsupported` names the capability this deployment cannot prove,
 * and a call that carries it is refused rather than approximated.
 */
export type ModelUsageInputBound =
  | {
      enforced: "counted";
      maximumTokens: bigint;
      countInputTokens: (params: unknown) => number | Promise<number>;
      /**
       * The self-enforcing side of a conservative bound: given the params admission is about
       * to price, return the request this call should actually send — truncated to the
       * bound's own ceiling when the original would be refused. Absent when the bound cannot
       * self-enforce; admission then refuses an over-limit request outright.
       */
      fit?: (params: unknown) => unknown;
    }
  | { enforced: "unsupported"; reason: string };

/** The output side: the cap this wrapper writes into the call and the provider enforces. */
export type ModelUsageOutputBound =
  | { enforced: "provider_cap"; maximumTokens: bigint }
  | { enforced: "unsupported"; reason: string };

/**
 * The provider-bound contract every admitted billed call must satisfy. The gate supplies the
 * exact limits enforced on `inner.doStream` or the call is refused before it; the same limits
 * price the finished usage (see `calculateExactModelUsageCharge`).
 */
export type ModelUsageProviderBounds = {
  input: ModelUsageInputBound;
  output: ModelUsageOutputBound;
};

export type ModelUsageGateLifecycle = {
  bounds?: ModelUsageProviderBounds;
  finish?: (usage: ModelUsageReport) => Promise<void> | void;
  /**
   * Durable evidence for work the provider produced that this deployment will not charge:
   * usage above a configured bound, or a charge the pricing refused. The hold is retained.
   */
  recordUnsettled?: (input: {
    eventId: string;
    occurredAt: Date;
    inputTokens: number;
    outputTokens: number;
    reason: string;
  }) => Promise<void> | void;
  fail?: (input: {
    eventId: string;
    occurredAt: Date;
    reason: ModelUsageFailureReason;
    /** What the stream had learned by the time it failed, when it had learned anything. */
    inputTokens?: number;
    outputTokens?: number;
  }) => Promise<void> | void;
};

export type ModelUsageRefusalCode =
  | "model_bounds_missing"
  | "input_bound_unsupported"
  | "input_over_limit"
  | "output_bound_unsupported";

/**
 * A billed call refused before the provider saw anything, because its configured reservation
 * bounds cannot be proven on the actual provider request. Distinct from `CreditGateError`
 * (the person's balance is fine; this deployment's model wiring is the limit). Release is
 * ATTEMPTED before throwing; if the release itself fails, the hold stays visible for
 * operator reconciliation rather than being silently dropped.
 */
export class ModelUsageRefusalError extends Error {
  override name = "ModelUsageRefusalError";
  constructor(readonly code: ModelUsageRefusalCode) {
    super(
      code === "input_over_limit"
        ? `Model call refused (${code}): the request exceeds this deployment's configured input token limit for this model. Shorten the request and try again.`
        : `Model call refused (${code}): this deployment cannot prove the configured billing bounds on the provider request. Ask an administrator to configure a provable bound for this model.`,
    );
  }
}

/**
 * A billed stream that completed at the provider but cannot be settled honestly: malformed
 * usage, usage above the advertised bound, or a usage fact that failed to persist. The
 * reservation is NOT released — the hold stays visible for operator reconciliation.
 */
export class ModelUsageSettlementError extends Error {
  override name = "ModelUsageSettlementError";
  constructor(readonly code: string) {
    super(`Model usage settlement failed (${code}).`);
  }
}

type ModelUsageGateInput = {
  eventId: string;
  occurredAt: Date;
  modelId: string | null;
  /**
   * The surface the call came from (the usage-origin vocabulary), read here at doStream time,
   * the one point where the request context still exists, so the gate's outbox write can
   * attribute the usage fact to its real caller instead of a hardcoded "web".
   */
  client: UsageOrigin;
};

/**
 * The pre-call credit gate, the meter's sibling: where the meter reports what a call COST after
 * it finished, the gate refuses the call BEFORE the first token when the deployment's credit
 * balance is gone. Same injection shape as the meter for the same reason — `copilot.ts` must
 * not depend on a billing module a deployment may not have; `index.ts` wires the gate at
 * assembly and the default (absent) lets every call through.
 *
 * Async on purpose (the gate reads the ledger), and a gate that THROWS is a gate that refuses
 * (fail-closed): a person with credits whose gate errored is told to retry rather than
 * silently given free tokens.
 */
let modelUsageGate:
  | ((input: ModelUsageGateInput) => Promise<ModelUsageGateLifecycle>)
  | undefined;

export function setModelUsageGate(
  gate:
    | ((input: ModelUsageGateInput) => Promise<ModelUsageGateLifecycle>)
    | undefined,
) {
  modelUsageGate = gate;
}

/**
 * A gate refusal as the stream spells it: a sentinel-code error the runtime's error handling
 * renders to the person. `credits_exhausted` is the one word the billing seam owns for this —
 * the surface (402 semantics) is the caller's to grade.
 */
export class CreditGateError extends Error {
  override name = "CreditGateError";
  readonly code = "credits_exhausted";
  constructor() {
    super(
      "This deployment has no credits left. Ask an administrator to grant credits or upgrade the plan.",
    );
  }
}

/**
 * This deployment has no credit PRICES (audit A4). Distinct from `CreditGateError`: the balance is
 * not the problem, `BILLING_MODEL_CREDIT_RATES` / `BILLING_MODEL_MAX_RESERVATION_TOKENS` /
 * `BILLING_CODE_RUN_*` are. Telling an administrator to buy credits would send them to the wrong
 * fix; the `issues` field carries the config keys to the log, never to a person-facing message.
 */
export class CreditPolicyUnconfiguredError extends Error {
  override name = "CreditPolicyUnconfiguredError";
  readonly code = "credit_policy_unconfigured";
  constructor(
    readonly issues: readonly { key: string; reason: string }[] = [],
  ) {
    super(
      "Billing credit prices are not configured on this deployment, so no metered call can be admitted. An administrator must supply the BILLING_* rate and maximum-reservation keys.",
    );
  }
}

/** This model has no price in an otherwise configured policy. */
export class ModelNotPricedError extends Error {
  override name = "ModelNotPricedError";
  readonly code = "model_not_priced";
  constructor(readonly modelId: string) {
    super(
      `This model has no configured credit price, so calls to it cannot be admitted. An administrator must add it to BILLING_MODEL_CREDIT_RATES and BILLING_MODEL_MAX_RESERVATION_TOKENS.`,
    );
  }
}

/**
 * The gate itself failed for a reason no sentinel names (a store error, a driver timeout).
 * Fail-closed like every other refusal, but under its own name: "the balance could not be read"
 * is a different repair from "the balance is empty", and the raw cause is logged, never rethrown.
 */
export class CreditGateFailureError extends Error {
  override name = "CreditGateFailureError";
  readonly code = "credit_gate_failed";
  constructor() {
    super(
      "Credit admission could not be completed. Try again; if it persists an administrator must check the billing ledger connection.",
    );
  }
}

/**
 * A model this billed deployment cannot meter in its current form: the runtime resolves
 * string-form models itself, where the admission wrapper — and with it any provable bound —
 * cannot reach. Deliberately NOT `CreditGateError`: the balance is not the problem, the
 * deployment's model wiring is, and telling an administrator to buy credits would be the
 * wrong instruction.
 */
export class UnmeterableModelError extends Error {
  override name = "UnmeterableModelError";
  readonly code = "model_unmeterable";
  constructor() {
    super(
      "This model cannot be metered in its current form. Ask an administrator to configure a gateway base URL (OPENAI_BASE_URL) or a plan model so billing admission can prove its bounds.",
    );
  }
}

/**
 * A model instance carrying the billing admission and settlement, hand-rolled to the same
 * shape AI SDK's own `wrapLanguageModel` produces: `doStream` delegates to the wrapped model
 * after the gate's bounds are proven (refusing before the provider otherwise), and the
 * result's ReadableStream is re-emitted from a hand-written pull loop so settlement is
 * DECISIVE — the finish chunk is forwarded only after the lifecycle's `finish` (the durable
 * usage fact) commits, and a failure path releases or retains the reservation by contract.
 * Every other property (provider, modelId, supportedUrls) passes through untouched.
 * Structural on purpose — the middleware types live in `@ai-sdk/provider`, which this workspace
 * does not depend on directly; the runtime carries them transitively, and pinning that into
 * `package.json` to record two field names is not the trade.
 */
function meteredModel<T>(model: T): T {
  const inner = model as {
    doStream: (params: unknown) => Promise<{
      stream: ReadableStream<Record<string, unknown>>;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  return {
    ...inner,
    async doStream(params: unknown) {
      const eventId = randomUUID();
      const occurredAt = new Date();
      let lifecycle: ModelUsageGateLifecycle | undefined;
      /*
       * The model-span observation bypass (Issue #20): reads this call's verdict AFTER
       * the metered path reaches it — never in front of a settlement decision, never a
       * second provider call. Wired at assembly like the meter; absent, none of the
       * capture below runs at all.
       */
      const spanObserver = builtinModelSpanObserver;
      let spanInput: string | null = null;
      let spanOutput = "";
      if (spanObserver !== undefined) {
        try {
          spanInput = JSON.stringify(
            (params as { prompt?: unknown })?.prompt ?? null,
          );
        } catch {
          // A prompt that cannot serialize is metrics-only for the span, never a failure.
        }
      }
      const reportSpan = (ending: BuiltinModelSpanFact["ending"]) => {
        if (spanObserver === undefined) return;
        try {
          spanObserver({
            eventId,
            startedAt: occurredAt,
            endedAt: new Date(),
            provider:
              typeof inner.provider === "string" ? inner.provider : undefined,
            modelId: typeof inner.modelId === "string" ? inner.modelId : null,
            ending,
            input: spanInput,
            output: spanOutput === "" ? null : spanOutput,
          });
        } catch {
          // Observation never takes the product path down.
        }
      };
      /*
       * The credit gate, BEFORE the first token: this is the one point every built-in Bot's
       * model call passes through (the same reason the meter lives here), and "before the
       * call" is the only place a refusal saves the cost. The gate itself is index.ts's — it
       * reads the credit ledger with a short TTL cache so a burst of calls costs one read, and
       * refuses (throws CreditGateError) when the live balance is zero. A gate that THROWS for
       * another reason is also refused: fail-closed — an unreadable balance is not a free pass.
       */
      if (modelUsageGate) {
        try {
          lifecycle = await modelUsageGate({
            eventId,
            occurredAt,
            modelId:
              typeof inner.modelId === "string" ? inner.modelId : null,
            client: currentUsageOrigin(),
          });
        } catch (error) {
          if (
            error instanceof CreditGateError ||
            error instanceof CreditPolicyUnconfiguredError ||
            error instanceof ModelNotPricedError ||
            error instanceof CreditGateFailureError
          ) {
            reportSpan({
              kind: "refused",
              code:
                typeof (error as { code?: unknown })?.code === "string"
                  ? (error as { code: string }).code
                  : "admission_refused",
            });
            throw error;
          }
          // The gate's own failure reason stays out of the person-facing sentinel; the
          // name alone is logged (a message could carry connection details from a store).
          log.error(
            {
              type: "billing-model-gate-failed",
              eventId,
              name: (error as Error | null | undefined)?.name,
            },
            "billing-model-gate-failed",
          );
          reportSpan({ kind: "refused", code: "credit_gate_failed" });
          throw new CreditGateFailureError();
        }
      }
      /*
       * The bound contract: admission reserved credits, but a reservation is not a provider
       * limit. Before the provider is called at all, the lifecycle must prove HOW the
       * configured input and output maxima are enforced on this invocation — and every
       * refusal here releases the reservation admission just created, because no chargeable
       * work has happened yet.
       */
      const providerBounds = lifecycle?.bounds;
      const refuse = async (code: ModelUsageRefusalCode): Promise<never> => {
        log.error(
          { type: "billing-model-admission-refused", eventId, code },
          "billing-model-admission-refused",
        );
        try {
          await lifecycle?.fail?.({
            eventId,
            occurredAt,
            reason: "bound_refused",
          });
        } catch {
          // Admission cleanup is contained: the refusal is the product failure.
        }
        reportSpan({ kind: "refused", code });
        throw new ModelUsageRefusalError(code);
      };
      let request = params;
      if (modelUsageGate) {
        if (!providerBounds) return refuse("model_bounds_missing");
        if (providerBounds.input.enforced === "unsupported")
          return refuse("input_bound_unsupported");
        if (providerBounds.output.enforced === "unsupported")
          return refuse("output_bound_unsupported");
        let counted: number;
        try {
          if (
            providerBounds.input.enforced === "counted" &&
            providerBounds.input.fit
          ) {
            request = providerBounds.input.fit(params);
          }
          counted = await providerBounds.input.countInputTokens(request);
        } catch (error) {
          // A count that THREW is a failed probe (dependency outage), not a missing
          // capability; the name alone is logged so the two stay distinguishable.
          log.error(
            {
              type: "billing-model-input-count-failed",
              eventId,
              name: (error as Error | null | undefined)?.name,
            },
            "billing-model-input-count-failed",
          );
          return refuse("input_bound_unsupported");
        }
        if (!Number.isSafeInteger(counted) || counted < 0)
          return refuse("input_bound_unsupported");
        if (BigInt(counted) > providerBounds.input.maximumTokens)
          return refuse("input_over_limit");
        /*
         * The cap comparison stays in the bigint domain: the settlement boundary later
         * compares the reported usage against the same bigint maximum, and a Number()
         * conversion of an out-of-safe-range ceiling could round — admitting an output the
         * settlement then rejects, or writing the provider a cap that is not the configured
         * one. A maximum that cannot survive the Number() write below unchanged is refused
         * outright. The caller's own request is honoured only when it is a whole, positive,
         * in-bound number — anything else (including 0, which providers reject or ignore)
         * gets the configured cap rather than a passthrough the provider contract never
         * promised.
         */
        const cap = providerBounds.output.maximumTokens;
        if (cap > BigInt(Number.MAX_SAFE_INTEGER)) {
          return refuse("output_bound_unsupported");
        }
        const requested = (
          params as { maxOutputTokens?: unknown }
        ).maxOutputTokens;
        const effective =
          typeof requested === "number" &&
          Number.isSafeInteger(requested) &&
          requested > 0 &&
          BigInt(requested) <= cap
            ? BigInt(requested)
            : cap;
        request = {
          ...(request as Record<string, unknown>),
          maxOutputTokens: Number(effective),
        };
      }
      let result: Awaited<ReturnType<typeof inner.doStream>>;
      try {
        result = await inner.doStream(request);
      } catch (error) {
        try {
          await lifecycle?.fail?.({
            eventId,
            occurredAt,
            reason: "provider_error",
          });
        } catch {
          // Admission cleanup is contained: the provider failure is the product failure.
        }
        // This exit predates the stream, so settleFail never runs here.
        reportSpan({ kind: "failed", code: "provider_error" });
        throw error;
      }

      const reader = result.stream.getReader();
      let settled = false;
      /*
       * Set the moment `settleFinish` hands the usage to the lifecycle's finish. That path's
       * owner has the REAL token counts and records its evidence before it rethrows, so a
       * second record from the failure path below could only be less accurate — a 0/0
       * duplicate the outbox's immutable-facts check rejects with a warn, or, when the outbox
       * write itself is what failed, a 0/0 row contradicting a real-but-unwritten fact the
       * `billing-usage-outbox-write-failed` log already names (final review, Minor 1).
       */
      let finishAttempted = false;
      const settleFinish = async (usage: {
        inputTokens: number;
        outputTokens: number;
      }) => {
        if (settled) return;
        settled = true;
        /*
         * The decisive boundary: `finish` resolves only after the immutable usage fact has
         * committed (or an identical event already exists). A rejection is NOT contained
         * here — it propagates to the pull below, which errors the stream instead of
         * reporting a successful answer whose usage was never durably recorded.
         */
        finishAttempted = true;
        await lifecycle?.finish?.({
          eventId,
          occurredAt,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
        try {
          await usageMeter?.({
            eventId,
            occurredAt,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          });
        } catch {
          // A meter that throws (or rejects) must not take the run's last chunk down with it.
        }
        // The bypass observes last: durable finish, then meter, then this fact — the
        // usage is the settlement's own committed number, copied, never recomputed.
        reportSpan({
          kind: "succeeded",
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
      };
      const settleFail = async (
        reason: ModelUsageFailureReason,
        reported?: { inputTokens?: number; outputTokens?: number },
      ) => {
        if (settled) return;
        settled = true;
        try {
          await lifecycle?.fail?.({
            eventId,
            occurredAt,
            reason,
            ...reported,
          });
        } catch {
          // Release failures stay contained: the hold's own expiry is the backstop.
        }
        // The bypass maps the failure verdict the metered path just reached. Half-
        // reported usage stays usage_missing — the observed half is billing evidence
        // above, never a span usage number (a reported half is not a known whole).
        switch (reason) {
          case "no_usage":
            // The provider confirmed a zero-cost completion: an actual 0/0, not missing.
            reportSpan({ kind: "succeeded", inputTokens: 0, outputTokens: 0 });
            break;
          case "usage_missing":
            reportSpan({ kind: "usage_missing" });
            break;
          case "cancelled":
            reportSpan({ kind: "canceled" });
            break;
          case "bound_refused":
            reportSpan({ kind: "refused", code: reason });
            break;
          case "provider_error":
          case "stream_error":
            reportSpan({ kind: "failed", code: reason });
            break;
        }
      };

      const stream = new ReadableStream<Record<string, unknown>>({
        async pull(controller) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch (error) {
            await settleFail("stream_error");
            reader.releaseLock();
            controller.error(error);
            return;
          }

          if (chunk.done) {
            await settleFail("usage_missing");
            reader.releaseLock();
            controller.close();
            return;
          }

          const part = chunk.value;
          // Read-only output accumulation for the observation bypass: the delta is
          // forwarded untouched below; this only remembers what already flowed past.
          if (
            spanObserver !== undefined &&
            part?.type === "text-delta" &&
            typeof (part as { delta?: unknown }).delta === "string"
          ) {
            spanOutput += (part as { delta: string }).delta;
          }
          /**
           * The one settlement-failure exit: mark settled, log by eventId, tear the
           * upstream down, error the stream. Cancel — not just `releaseLock` — so the
           * provider's HTTP body is torn down instead of holding its connection open.
           */
          const failSettlement = async (
            logType: string,
            error: ModelUsageSettlementError,
            detail?: Record<string, unknown>,
          ) => {
            settled = true;
            log.error({ type: logType, eventId, ...detail }, logType);
            /*
             * Evidence before the tear-down (audit A3): the provider already produced this work,
             * the hold is retained, and without a durable row the token counts existed only in
             * this log line — reconciliation would find an expired hold with no usage to reconcile.
             * Awaited, not fire-and-forget: a record a crash can drop is the exact defect class
             * this closes. Best-effort by contract: a failed evidence write must not mask the
             * settlement error.
             */
            const tokens = detail as
              | { inputTokens?: number; outputTokens?: number }
              | undefined;
            /*
             * Evidence before the tear-down (audit A3) — but not when the gate's own finish
             * was attempted: that path already recorded (or already failed to record) the
             * real tokens, so a second write here is the 0/0 duplicate `finishAttempted`
             * exists to skip. The over-bound and malformed-usage paths below never set the
             * flag, so their real tokens still leave as evidence.
             */
            if (!finishAttempted) {
              try {
                await lifecycle?.recordUnsettled?.({
                  eventId,
                  occurredAt,
                  inputTokens: tokens?.inputTokens ?? 0,
                  outputTokens: tokens?.outputTokens ?? 0,
                  reason: error.code,
                });
              } catch {
                // The settlement error stays the product failure; evidence is best-effort.
              }
            }
            reader.cancel("settlement_failed").catch(() => {
              // The upstream is already gone; nothing to recover.
            });
            // A settlement failure is never a success span: the verdict this call
            // reached is a failure-terminal fact, observed after the teardown decision.
            reportSpan({ kind: "settlement_failed", code: error.code });
            controller.error(error);
          };
          if (part?.type === "finish" && !settled) {
            const usage = part.usage as
              | {
                  inputTokens?: { total?: number };
                  outputTokens?: { total?: number };
                }
              | undefined;
            const reportedInput = usage?.inputTokens?.total;
            const reportedOutput = usage?.outputTokens?.total;
            /*
             * Absent usage numbers are NOT zero usage (audit A2): an OpenAI-compatible gateway
             * that ignores `stream_options.include_usage` reports nothing at all, and treating
             * that as a confirmed no-cost released the hold, metered nothing and charged nothing
             * — silently free. A HALF-reported usage is the same unknown: billing the number the
             * provider did name and treating the missing one as zero is a silent under-charge.
             * `CONTEXT.md` Pending Settlement: the hold stays until settlement or a confirmed
             * no-cost, so an incomplete report settles as an unknown outcome and the gate retains.
             */
            if (reportedInput === undefined || reportedOutput === undefined) {
              // No return: the person still sees this finish part, exactly as the old no_usage
              // path let it through (decision gate G4 owns any change to that). settleFail
              // claimed `settled`, so every settlement branch below is inert and the part
              // flows to the enqueue at the bottom. The half the provider DID name travels
              // with the failure, so the evidence row records what arrived, not zeros — with
              // keys only for what did arrive, absent like every other settleFail site.
              await settleFail("usage_missing", {
                ...(reportedInput !== undefined && { inputTokens: reportedInput }),
                ...(reportedOutput !== undefined && { outputTokens: reportedOutput }),
              });
            }
            const validInput =
              reportedInput === undefined ||
              (Number.isSafeInteger(reportedInput) && reportedInput >= 0);
            const validOutput =
              reportedOutput === undefined ||
              (Number.isSafeInteger(reportedOutput) && reportedOutput >= 0);

            /*
             * Malformed or over-bound usage is a DISTINCT settlement failure: no charge is
             * invented, no successful finish is emitted, and — unlike the cleanup paths
             * below — the reservation is NOT released. The provider already produced the
             * work; the hold stays visible for operator reconciliation.
             */
            const billedInput = reportedInput ?? 0;
            const billedOutput = reportedOutput ?? 0;
            if (!validInput || !validOutput) {
              await failSettlement(
                "billing-model-usage-invalid",
                new ModelUsageSettlementError("usage_invalid"),
                { inputTokens: billedInput, outputTokens: billedOutput },
              );
              return;
            }
            const inputBound = providerBounds?.input;
            const outputBound = providerBounds?.output;
            const overBound =
              (inputBound?.enforced === "counted" &&
                BigInt(billedInput) > inputBound.maximumTokens) ||
              (outputBound?.enforced === "provider_cap" &&
                BigInt(billedOutput) > outputBound.maximumTokens);
            if (overBound) {
              await failSettlement(
                "billing-model-usage-over-bound",
                new ModelUsageSettlementError("usage_over_bound"),
                { inputTokens: billedInput, outputTokens: billedOutput },
              );
              return;
            }

            if (billedInput > 0 || billedOutput > 0) {
              try {
                await settleFinish({
                  inputTokens: billedInput,
                  outputTokens: billedOutput,
                });
              } catch (error) {
                // A stable code when the rejection carries one. Only the settlement error
                // itself crosses into the person-visible stream: a gate implementation's
                // raw failure (a store error message can carry connection details) is
                // wrapped into the credential-free shape right here at the boundary.
                const code =
                  typeof (error as { code?: unknown })?.code === "string"
                    ? (error as { code: string }).code
                    : undefined;
                await failSettlement(
                  "billing-model-finish-failed",
                  error instanceof ModelUsageSettlementError
                    ? error
                    : new ModelUsageSettlementError(
                        code ?? "usage_persistence_failed",
                      ),
                  code ? { code } : undefined,
                );
                return;
              }
            } else {
              await settleFail("no_usage");
            }
          }

          try {
            controller.enqueue(part);
          } catch {
            // Enqueue throws for any closed/errored state (consumer cancellation included);
            // keep the dropped chunk diagnosable rather than silently discarded.
            log.debug(
              { type: "billing-model-chunk-dropped", eventId },
              "billing-model-chunk-dropped",
            );
          }
        },
        async cancel(reason) {
          // Claim the settled flag BEFORE tearing the upstream down: a pull still in
          // flight would otherwise win the race and record this cancellation as no_usage.
          await settleFail("cancelled");
          try {
            await reader.cancel(reason);
          } finally {
            reader.releaseLock();
          }
        },
      });

      return { ...result, stream };
    },
  } as T;
}

export const meteredModelForTests = meteredModel;

/**
 * Wrap the model instance in the usage meter when one is wired and the model is an instance (the
 * string form is resolved by the runtime itself, where this file cannot reach).
 */
function withUsageMeter<T>(model: T): T {
  // The gate rides the same wrapper as the meter: a deployment with neither wired (no billing)
  // gets the model untouched, and a deployment with only the meter still meters — the two are
  // independent injections on purpose.
  if (usageMeter === undefined && modelUsageGate === undefined) return model;
  const candidate = model as
    | (Record<string, unknown> & { doStream?: unknown })
    | string;
  if (
    typeof candidate === "string" ||
    typeof candidate.doStream !== "function"
  ) {
    return model;
  }
  return meteredModel(model);
}

export function builtInAgentConfiguration(
  agent: RegisteredBuiltInAgent,
  model: RuntimeModel,
  apiKey: string | null,
  /**
   * What this Bot may call, resolved for the person asking.
   *
   * Handed to the agent rather than registered by the surface, so a run needs no browser. These are
   * not raw MCP servers on purpose: each one executes through the plugin store, which checks the
   * grant, evaluates the policy and writes the audit row. Passing `mcpServers` here instead would
   * let the agent reach a vendor directly and walk around all three.
   */
  tools: GrantedTool[] = [],
  /**
   * What this Bot should know about the computer, when this deployment has one.
   *
   * Appended to the role rather than replacing it: the package says what the Bot is for, this says
   * what its hands are. Absent leaves the role alone, which is right for a deployment with no
   * computer configured, where the browser routes are not mounted and a Bot promised a browser would
   * be promising something that does not exist.
   */
  computerGuidance?: string,
  /**
   * Vendors this deployment connects to, whether or not this Bot holds any of their tools.
   *
   * A Bot holding nothing was told nothing, so it treated a connected vendor as an ordinary website
   * and browsed to it. See `grantedToolGuidance`.
   */
  connectedVendors: readonly string[] = [],
  /**
   * The standing instructions of the person this run belongs to. Absent means they have written
   * none, which is most people on most days and costs the prompt nothing.
   */
  standingInstructions?: string | null,
  planModel?: PlanModel,
  learnedSkills?: LearnedSkillInvocation,
  /**
   * The server-only governed model collaborator, present only inside a
   * governed admission.
   *
   * When present, the Bot's model is the gateway adapter this run was admitted
   * against: no provider SDK, no provider api key, and no field a client could
   * override — `overridableProperties` is deliberately absent so nothing in
   * the wire input can select the route, the credential, or the run identity.
   */
  governedModel?: GovernedModelRequest,
  loadKnowledge?: LoadKnowledgeForBot,
): BuiltInAgentConfiguration {
  if (!apiKey && !planModel && !governedModel) {
    return {
      type: "custom",
      // biome-ignore lint/correctness/useYield: this agent must fail when iteration starts.
      factory: async function* () {
        throw new Error(
          `Model credential is not configured for ${agent.name}. Add the package credential or set ${model.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}.`,
        );
      },
    };
  }

  const standing = standingInstructionsGuidance(standingInstructions);
  const allTools = [
    ...tools,
    ...(learnedSkills?.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: parametersFor(tool.parameters),
      execute: (args: unknown) => learnedSkills.execute(tool.name, args),
    })) ?? []),
  ];

  if (governedModel) {
    governedModel.markConsumed();
    return {
      model: governedModel.model,
      prompt: [
        agent.systemPrompt,
        ...(standing ? [standing] : []),
        PROVENANCE_GUIDANCE,
        UNTRUSTED_GUIDANCE,
        ...(grantedToolGuidance(tools, connectedVendors)
          ? [grantedToolGuidance(tools, connectedVendors)]
          : []),
        ...(computerGuidance ? [computerGuidance] : []),
        ...(learnedSkills?.catalog ? [learnedSkills.catalog] : []),
      ].join("\n\n"),
      // The admitted run ceiling, set by the server. The adapter narrows every
      // step's request to what remains of it.
      maxOutputTokens: governedModel.maxOutputTokens,
      /*
       * A retry would mint a fresh capability against the same run ceiling,
       * and a 402 budget refusal is terminal by contract, so the SDK's
       * retry loop is off for governed calls entirely.
       */
      maxRetries: 0,
      ...(allTools.length > 0
        ? {
            tools: allTools.map((tool) => ({
              ...tool,
              execute: (args: unknown, execution?: { toolCallId?: string }) =>
                executeNativeApprovalTool(
                  tool.name,
                  args,
                  execution?.toolCallId,
                  tools.find((granted) => granted.name === tool.name)
                    ?.initiator,
                  () => tool.execute(args),
                ),
            })),
            maxSteps: TOOL_STEPS,
          }
        : {}),
    };
  }

  const resolvedModel = planModel ?? runtimeModel(model, apiKey);
  if (
    modelUsageGate !== undefined &&
    typeof resolvedModel === "string"
  ) {
    return {
      type: "custom",
      // biome-ignore lint/correctness/useYield: this agent must fail when iteration starts.
      factory: async function* () {
        // Fail-closed: string-form models are resolved inside the runtime, where the
        // admission wrapper — and any provable bound — cannot reach them.
        throw new UnmeterableModelError();
      },
    };
  }

  return {
    model: withUsageMeter(resolvedModel),
    /*
     * The package's role, then the person's own standing instructions, then what this Bot actually
     * holds, then the computer.
     *
     * The grants go BEFORE the computer prose on purpose. That prose is long and emphatic about the
     * browser and mentions connectors nowhere, so a Bot that read it last reached for the browser
     * even when it held a tool for the exact system being asked about.
     *
     * The person's instructions go straight after the role and before all of it, because they are
     * the other half of the same question — who you are and who you are working for — and because
     * their precedence sentence only means anything next to the role it defers to.
     */
    prompt: [
      agent.systemPrompt,
      ...(standing ? [standing] : []),
      /*
       * Unconditional, unlike the two below it.
       *
       * Those describe things a deployment may or may not have. This describes how to answer at all,
       * and a Bot with no tools and no computer needs it most: it has nothing to read, so everything
       * it says comes from its own knowledge, and saying so is the only honest move available.
       */
      PROVENANCE_GUIDANCE,
      // How to read the untrusted-content envelope every outside result arrives in.
      UNTRUSTED_GUIDANCE,
      ...(grantedToolGuidance(tools, connectedVendors)
        ? [grantedToolGuidance(tools, connectedVendors)]
        : []),
      ...(computerGuidance ? [computerGuidance] : []),
      ...(learnedSkills?.catalog ? [learnedSkills.catalog] : []),
    ].join("\n\n"),
    ...(planModel ? {} : { apiKey: apiKey ?? undefined }),
    /*
     * A run stops after one step unless told otherwise, which for a Bot with tools means it calls
     * one and never speaks: the tool executes, the result arrives, and the run ends before the model
     * can say what it found. The person sees their own question and nothing else.
     *
     * Only set when there are tools, because a Bot with none has nothing to continue for. The cap
     * bounds a model that would otherwise call tools in a circle. Interrupt tools, if any are ever
     * added here, require the default of one and must not be mixed in.
     */
    ...(allTools.length > 0
      ? {
          tools: allTools.map((tool) => ({
            ...tool,
            execute: (args: unknown, execution?: { toolCallId?: string }) =>
              executeNativeApprovalTool(
                tool.name,
                args,
                execution?.toolCallId,
                tools.find((granted) => granted.name === tool.name)?.initiator,
                () => tool.execute(args),
              ),
          })),
          maxSteps: TOOL_STEPS,
        }
      : {}),
  };
}

/**
 * How many turns of the tool loop one run may take.
 *
 * Enough for a Bot to search, read what came back, search again on a better term, and answer.
 * Beyond that a model is not making progress, and every extra step is somebody's money.
 */
const TOOL_STEPS = 8;

/**
 * Build the built-in and remote AG-UI agent map the runtime serves.
 *
 * Keyed by the registry id, which is what the browser sends as the agent name, so the two cannot
 * drift apart without the lookup failing loudly rather than silently running the wrong Bot.
 */
export async function buildAgents(
  agents: RegisteredAgent[],
  model: RuntimeModel,
  apiKey: string | null,
  /** Absent leaves every stream unwatched, which is what an unconfigured timeout means. */
  stallGuard?: StallGuard,
  /** Absent leaves every Bot with no tools, which is the correct answer when nothing is granted. */
  loadTools: LoadToolsForBot = async () => [],
  signRun?: SignRun,
  /** What every built-in Bot is told about the computer. Absent means this deployment has none. */
  computerGuidance?: string,
  /**
   * Which vendors this deployment connects to. Asked once per build rather than per Bot, because it
   * is a fact about the deployment; what differs per Bot is which of them it holds.
   */
  loadVendors: () => Promise<readonly string[]> = async () => [],
  /** How a run's tools are narrowed to what it is about. Absent means they are not. */
  selection?: ToolSelection,
  /**
   * The fetch a remote agent is dialled with.
   *
   * Absent uses the runtime's own, which follows redirects wherever they point. A deployment passes
   * one that re-checks each hop, because the address a registration was validated against and the
   * address a run finally reaches are only the same address while nobody redirects.
   */
  agentFetch?: AgentFetch,
  /** How a run gets its tool for handing work on. Absent means no Bot is offered one. */
  handoff?: HandoffForRun,
  /**
   * What the person asking has told every coworker they run. Absent means this deployment does not
   * carry standing instructions, which is what every deployment did before they existed.
   */
  loadInstructions?: LoadInstructions,
  initiator?: AuditInitiator,
  /**
   * How a message's attached files are put in front of the model.
   *
   * Appended last on purpose, like the collaborators above it: these are positional, so inserting
   * one anywhere else silently shifts every existing call site's arguments by one.
   *
   * Absent means nothing is inlined and a Bot is shown the URL a file is stored behind rather than
   * the file, which is what every deployment did before this existed.
   */
  loadAttachment?: LoadAttachment,
  /**
   * How a run says the files on the message it is answering went out in a send. Appended after
   * `loadAttachment` for the positional reason it gives. Absent means nothing is recorded.
   */
  markAttachmentsSent?: MarkAttachmentsSent,
  acquireLearnedSkills?: AcquireLearnedSkills,
  loadPersonalMemory?: LoadPersonalMemory,
  /** Appended after `loadPersonalMemory`, for the positional reason it gives. */
  loadKnowledge?: LoadKnowledgeForBot,
  /** Present only inside a governed admission. See {@link builtInAgentConfiguration}. */
  governedModel?: GovernedModelRequest,
): Promise<Record<string, AbstractAgent>> {
  let vendors: readonly string[] = [];
  try {
    vendors = await loadVendors();
  } catch {
    // Vendor guidance is best-effort: losing it must not prevent a run or change its grants.
    // Report once per build here, including failures from the production plugin-store loader.
    // Never log the thrown value: database errors can contain connection details or row contents.
    console.error({
      error: "connected_vendor_lookup_failed",
      context: { operation: "loadVendors", agentCount: agents.length },
      timestamp: new Date().toISOString(),
    });
  }
  /*
   * Read once per build and only when somebody will be told it, like the vendors above and the model
   * key below: it is a fact about the person, not about a coworker, and asking per Bot would be the
   * same row fetched once for each of them. Skipped entirely when nothing built-in is being built,
   * because the remote path does not carry this at all.
   *
   * A failed read costs a paragraph, not a conversation. Report it once per build so operators can
   * distinguish a failed read from a person who has written no instructions.
   */
  let instructions: string | null = null;
  if (agents.some((agent) => agent.type === "built_in")) {
    try {
      instructions = (await loadInstructions?.()) ?? null;
    } catch {
      // Never log the thrown value: database errors can expose instructions or credentials.
      console.error({
        error: "standing_instruction_read_failed",
        context: { operation: "loadInstructions", agentCount: agents.length },
        timestamp: new Date().toISOString(),
      });
    }
  }
  return Object.fromEntries(
    await Promise.all(
      agents.map(async (agent) => {
        const built = await buildAgent(
          agent,
          model,
          apiKey,
          stallGuard,
          loadTools,
          signRun,
          computerGuidance,
          vendors,
          selection,
          agentFetch,
          handoff,
          instructions ?? null,
          initiator,
          loadAttachment,
          markAttachmentsSent,
          acquireLearnedSkills,
          governedModel,
        );
        if (loadPersonalMemory && !(built instanceof UnavailableAgent))
          built.use(new PersonalMemoryMiddleware(agent.id, loadPersonalMemory));
        return [agent.id, built];
      }),
    ),
  );
}

/**
 * The standing instructions of whoever this run belongs to, resolved when a run needs them.
 *
 * A closure rather than a string passed down, for the same reason `LoadToolsForBot` is one: it is a
 * per-person fact that a person can change between two runs, and a value captured at boot would
 * serve everybody the first person's preferences. Null means they have written none.
 */
export type LoadInstructions = () => Promise<string | null>;

/**
 * The bytes behind one stored attachment, fetched when a turn turns out to refer to it.
 *
 * A closure rather than the rows themselves, for the same reason {@link LoadInstructions} is one:
 * which files a turn names is decided by the message, and a request is earlier than a message. It is
 * ALSO bound to one person, like {@link LoadInstructions}: the ids reach it out of browser-supplied
 * message content, so which rows it may return is decided against the asker's channel memberships.
 * Null means this deployment no longer holds it OR it is not this person's to see, and on the
 * message the turn is answering `resolveAttachmentParts` turns either into a failed turn rather
 * than an answer about a file they never sent. Behind that message it becomes a note that the file
 * is gone; see {@link inlineAttachments} for why the two answers differ.
 *
 * TAKES THE RUN'S THREAD, AND TAKES IT AS A REQUIRED SECOND ARGUMENT. Which files a turn may reach
 * is decided by the conversation it is running in, not only by who is asking: an implementation
 * resolves the thread to its channel and refuses a file belonging to another one. Required rather
 * than optional, and second rather than curried in beside the actor, because those are the two
 * shapes that cannot be forgotten — `resolveAttachmentParts` accepts a `(id) => …`, so a
 * `LoadAttachment` is deliberately NOT assignable to it, and the binding that adapts one to the
 * other is the line where the thread id has to be named. A caller that omits it does not compile.
 * Mirrors {@link SignRun}, which takes the thread for the same class of reason.
 */
export type LoadAttachment = (
  id: string,
  threadId: string,
) => Promise<StoredAttachment | null>;

/**
 * Records that these attachments went out in a message somebody sent.
 *
 * A closure bound to one person, like {@link LoadAttachment}, and for a stricter reason: this one
 * WRITES. `attachedAt` is what the sweeper, the upload cap and the withdrawal route all read as
 * "this file rode in a message somebody sent", so only the person whose send it was may record it,
 * and only for rows they uploaded themselves — see `markAttachmentsSent` in
 * channels/attachments.ts, which puts `uploadedBy` in the WHERE for exactly that.
 *
 * Called with the ids on the message being asked about and nothing else. History is replayed on
 * every turn and by whoever runs it, so a message behind the send is not evidence of one.
 *
 * A FAILURE TO RECORD REFUSES THE TURN, AND THIS PARAGRAPH USED TO PROMISE THE OPPOSITE. It said a
 * failure was swallowed and logged, because a turn is somebody waiting for an answer. The waiting
 * is real; the conclusion was not. {@link inlineAttachments} calls this BEFORE it returns the
 * history, and the history is what the run is given afterwards, so nothing has reached a model when
 * this resolves. A rejection here therefore costs a turn that never started, while a silent one
 * costs the file itself — `attachedAt` is what stops the culler reclaiming it, so a send recorded
 * nowhere is a message that displays a file the sweeper deletes a day later. The long argument, and
 * the four things that still do NOT reject, are in `markAttachmentsSent` in channels/attachments.ts.
 *
 * SO AN IMPLEMENTATION MUST RESOLVE ONLY WHEN THE RECORD IS DURABLE. Resolving because a statement
 * was accepted is not enough: an UPDATE that matched no row is a successful command in Postgres, so
 * an implementation that cannot distinguish "stamped" from "matched nothing" is reporting a send
 * that did not happen. It must also treat a row that is ALREADY sent as recorded, because a replayed
 * message and a retried run are both ordinary and neither is an error.
 *
 * REJECT WITH A SENTENCE, NOT A SYMPTOM. There is no `app.onError` behind this server, and what an
 * implementation throws travels out of the run as an AG-UI error and is shown to the person who was
 * waiting. It is the same road `resolvePart`'s refusals take, and it wants the same kind of message:
 * what happened, and what they can do about it.
 *
 * Absent still means nothing is recorded, which is what every deployment did before this existed.
 */
export type MarkAttachmentsSent = (
  ids: readonly string[],
  /**
   * The conversation the send happened in, required for the reason {@link LoadAttachment} takes
   * one — and here it is the stronger of the two cases, because this WRITES. A stamp recorded
   * against the wrong conversation freezes a row in a channel that never saw the file: it can no
   * longer be withdrawn and the culler will no longer reclaim it.
   */
  threadId: string,
) => Promise<void>;

/**
 * The same history with every attached file put in front of the model.
 *
 * USER MESSAGES ONLY. A stored reference gets into a thread by somebody attaching a file to what
 * they said; rewriting an assistant or tool message would be rewriting what a model already
 * produced. A message that refers to no attachment comes back BY IDENTITY, which is almost all of
 * them, so this pass costs nothing on a thread with no files in it.
 *
 * NOTHING HERE CATCHES, FOR THE MESSAGE BEING ASKED ABOUT. An attachment this deployment cannot load
 * fails that turn, deliberately: see `resolvePart` in `channels/attachment-parts.ts` for why a Bot
 * answering confidently about an image it never received is the worse of the two outcomes.
 *
 * THE MESSAGE BEING ASKED ABOUT IS THE LAST USER MESSAGE. Everything after it in `input.messages` is
 * the Bot's own work on this turn, and everything before it is a turn already answered; the last
 * thing a person said is what the run is a reply to, and so the only message whose attachments the
 * answer is going to be about. It is also the only one whose attachments were just uploaded, which
 * is what makes failing there recoverable: the person is still there, and can re-attach and re-send.
 *
 * OLDER MESSAGES DEGRADE INSTEAD. This maps over the WHOLE history, and history is replayed on every
 * turn, so one vanished row failing here would fail this channel's every future turn for ever — the
 * same geometry as the dangling tool call in `agents/history-sanitize.ts`, which opens by recording
 * that exact failure found in production twice: a permanent failure grown out of transient damage,
 * and nothing the person did wrong. It is reachable the same way, too: a send whose run is stopped
 * before the load never stamps `attachedAt`, and the sweeper deletes the row a day later. So an
 * older part whose row is gone becomes text saying so, which keeps the property that matters — the
 * model is never left to answer as though a file it cannot see were in front of it — without the
 * permanence.
 *
 * AND IT WALKS BACKWARDS, WHICH IS WHAT MAKES THE BUDGET FAIR. `MAX_INLINED_BYTES_PER_RUN` bounds
 * what one turn may inline in total — nothing did, before, and a channel that had seen a few large
 * images made every later turn read and base64 all of them again. A budget is only defensible if
 * the person's own question is never what it cuts, so the walk starts at the newest message: the
 * one being asked about is charged first, and is never cut whatever it costs. What runs out is the
 * room left for the history behind it, and that history has already been in front of the model
 * once, in the turn it arrived.
 *
 * NEVER CUT IS NOT THE SAME AS NEVER BOUNDED, and reading the first as the second is what left the
 * asked message with no ceiling at all: `resolvePart` stopped spending only under
 * `onMissing: "note"`, so a message a browser had just written could name two hundred
 * previously-sent files and inline every one of them. It is still never cut — a person is never
 * told their own question's attachment was quietly left out — but a message past
 * `MAX_INLINED_BYTES_PER_RUN` now fails this turn with a sentence naming the file and the limit.
 * Refusing is an answer somebody can act on, since the message is still in front of them; silently
 * serving half of it is not.
 *
 * The walk is sequential for the same reason the parts within a message are: a budget spent by
 * whichever database read happened to settle first would cut a different message on each run over
 * the same thread. The concurrency given up is one round trip per message that carries a file,
 * which is very few messages in very few threads.
 */
async function inlineAttachments(
  messages: Message[],
  load: LoadAttachment,
  /**
   * The conversation this run is in, passed to every load and to the stamp.
   *
   * Taken as a parameter rather than read off anything reachable from here because this function
   * is handed a history, not a run — and it is the ONLY place that both knows which message is
   * being asked about and is called from every path that can send one. Both call sites below have
   * `input.threadId` in hand; neither can supply it by accident, since {@link LoadAttachment} does
   * not typecheck without it.
   */
  threadId: string,
  markSent?: MarkAttachmentsSent,
): Promise<Message[]> {
  const asked = messages.reduce(
    (latest, message, index) => (message.role === "user" ? index : latest),
    -1,
  );
  const budget = newInlineBudget();
  const inlined = [...messages];
  /**
   * The ids to stamp once the whole walk has come back, or none.
   *
   * Collected during the walk and spent after it, which is the whole of the fix described at the
   * `markSent` call below: the asked message is the FIRST thing this backward loop resolves, so a
   * stamp written where it is found is written before any older message has been looked at.
   */
  let sentIds: readonly string[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const content = await resolveAttachmentParts(
      message.content,
      /*
       * The seam narrows to `(id) => …` HERE, and this line is the whole reason the thread id is a
       * required parameter rather than something a wiring could forget. `resolveAttachmentParts`
       * asks about one id at a time and knows nothing about runs; a `LoadAttachment` is not
       * assignable to what it takes, so adapting one to the other cannot be done without naming
       * the conversation the ids are being resolved for.
       */
      (id) => load(id, threadId),
      index === asked ? "fail" : "note",
      budget,
    );
    /*
     * AND THIS IS WHERE `attachedAt` IS WRITTEN, for the asked message alone.
     *
     * The send that puts a file in front of a Bot goes out through AG-UI, so there is no request
     * handler in channels/attachments.ts to hook the write onto; this function is the first place
     * in the server that both knows the message and knows it is the one being asked about. Every
     * other message here is history, replayed in full on every turn and by whoever is running it,
     * which is why the write cannot live in `load`: a read happens for all of them.
     *
     * AFTER THE WHOLE HISTORY RESOLVES, NOT AFTER THIS MESSAGE DOES, which is why the ids are only
     * COLLECTED here and the write happens past the end of the loop. The strict `"fail"` above is
     * what refuses a turn that names a file the asker cannot see, and a send is not recorded for a
     * turn that never ran — but this loop walks BACKWARDS, so the asked message is the first thing
     * it resolves and every older message is still ahead of it. Stamping here meant stamping before
     * any of them had been looked at, and a history load that rejects (a pool error, a timeout;
     * `"note"` softens a MISSING row, not a failing read) then failed the turn with `attachedAt`
     * already written for it. The stamp's entire meaning is "this file reached a message somebody
     * actually sent", and three readers act on it — the sweeper's delete, the upload cap, the
     * withdrawal route — so a stamp for a turn that never ran is not a cosmetic inaccuracy.
     *
     * Past the end of the loop is as late as this function can put it, and no later: whether the
     * model ever answers is decided by things well downstream of here, and a stamp that waited for
     * that would be waiting on something this function does not observe. What it can promise is
     * that every message this turn was going to inline was inlined first.
     *
     * AND IT IS NO LONGER CAUGHT HERE, WHICH IS THE REVERSAL OF WHAT THIS SEAM USED TO DO. A
     * `try`/`catch` stood around the call, holding {@link MarkAttachmentsSent}'s old promise that a
     * failure to record would never fail an answer. The promise was kept and the outcome was still
     * wrong: the run carried on to a model with a file whose `attachedAt` was never written, the
     * culler reclaimed the row a day later, and the message went on displaying an attachment that no
     * longer existed. Nobody was told, on either side.
     *
     * THE POINT IS *WHERE* THIS LINE SITS, and it is the reason refusing is affordable at all.
     * Everything above has resolved into `inlined`, and `inlined` is RETURNED — the run is handed to
     * `super.run` / `next.run` by the caller, after this function comes back. So a rejection on this
     * line happens with no model called, no token spent, and the person's message still in front of
     * them, which is the same position `resolvePart`'s `"fail"` refusal leaves them in a few lines
     * above. The turn is not yet spent, so the trade is not "an answer for a file" — it is a retry
     * for a file, and it is only available here.
     *
     * The implementation logs the actor and the ids; what it throws is a sentence naming the files
     * and what to do about them, and that sentence is what leaves through the run as an AG-UI error.
     * Wrapping it again here would only put this seam's words in front of the ones that know which
     * rows are involved.
     */
    if (index === asked && markSent) {
      sentIds = attachmentIdsIn(message.content);
    }
    if (content !== message.content) {
      inlined[index] = { ...message, content } as Message;
    }
  }
  if (markSent && sentIds.length > 0) {
    await markSent(sentIds, threadId);
  }
  return inlined;
}

async function buildAgent(
  agent: RegisteredAgent,
  model: RuntimeModel,
  apiKey: string | null,
  stallGuard: StallGuard | undefined,
  loadTools: LoadToolsForBot,
  signRun?: SignRun,
  computerGuidance?: string,
  connectedVendors: readonly string[] = [],
  selection?: ToolSelection,
  agentFetch?: AgentFetch,
  handoff?: HandoffForRun,
  /** Already resolved by {@link buildAgents}, so one roster costs one read. */
  standingInstructions: string | null = null,
  initiator?: AuditInitiator,
  /** How this run's attached files are inlined. See {@link buildAgents}. */
  loadAttachment?: LoadAttachment,
  /** How this run records that those files were sent. See {@link buildAgents}. */
  markAttachmentsSent?: MarkAttachmentsSent,
  acquireLearnedSkills?: AcquireLearnedSkills,
  /** Present only inside a governed admission. See {@link builtInAgentConfiguration}. */
  governedModel?: GovernedModelRequest,
): Promise<AbstractAgent> {
  if (agent.type === "unavailable") {
    return new UnavailableAgent(agent);
  }
  if (agent.type === "remote_ag_ui" || agent.type === "remote_mastra") {
    return new UnavailableAgent({
      id: agent.id,
      name: agent.name,
      type: "unavailable",
      reason: "REMOTE_RUN_BUDGET_UNVERIFIED",
    });
  }

  const granted = await loadTools(agent.id);

  /*
   * Whether narrowing can do anything here at all.
   *
   * A skill that declares no tools is not a unit of retrieval, and a catalogue already small enough
   * to choose from has nothing to gain. In both cases the Bot is built exactly as it was before any
   * of this existed: no deferral, no per-run model call, nothing to go wrong. That is most
   * deployments on their first day, and they should not pay for a feature they are not using.
   */
  let skills: SelectableSkill[] = [];
  if (selection) {
    try {
      skills = await selection.loadSkills(agent.id);
    } catch {
      // Never log the thrown value: database errors can contain connection details or row contents.
      console.error({
        error: "tool_selection_skill_read_failed",
        context: { operation: "loadSkills", agentId: agent.id },
        timestamp: new Date().toISOString(),
      });
    }
  }
  const narrowing =
    selection &&
    skills.some((skill) => skill.tools.length > 0) &&
    granted.length > (selection.floor ?? SELECTION_FLOOR)
      ? selection
      : undefined;

  const diagnoseRecordFailure = (chosen: Selection<GrantedTool>) => {
    console.error({
      error: "tool_selection_record_failed",
      context: {
        operation: "record",
        agentId: agent.id,
        reason: chosen.reason,
        granted: chosen.granted,
        offered: chosen.offered.length,
        skills: chosen.skills,
      },
      timestamp: new Date().toISOString(),
    });
  };

  /** Pass one and pass two, for one run. Shared by both agent kinds; each applies it differently. */
  const offeredFor = async (
    input: RunAgentInput,
    signal?: AbortSignal,
  ): Promise<GrantedTool[]> => {
    if (!narrowing) return granted;
    const chosen = await selectTools({
      tools: granted,
      skills,
      text: latestUserText(input.messages),
      choose: narrowing.choose,
      signal,
      ...(narrowing.floor === undefined ? {} : { floor: narrowing.floor }),
    });
    signal?.throwIfAborted();
    // Awaited, so the row is on record before the model is handed the tools it names. A discovery
    // written afterwards would sit in the trail after the calls it explains.
    await narrowing.record?.(agent.id, chosen).catch(() => {
      diagnoseRecordFailure(chosen);
    });
    return chosen.offered;
  };

  /*
   * A built-in Bot takes its tools in its configuration, so narrowing means building it again once
   * the message is known. The guidance it is given is generated from the tools passed here, which is
   * what keeps a narrowed run from being told it holds something it was not offered.
   */
  const withTools = (
    tools: GrantedTool[],
    input?: RunAgentInput,
    signal?: AbortSignal,
    learnedSkills?: LearnedSkillInvocation,
  ) =>
    new BuiltInAgentWithSaneHistory(
      builtInAgentConfiguration(
        agent,
        model,
        apiKey,
        tools,
        computerGuidance,
        connectedVendors,
        standingInstructions,
        model.plan && input
          ? new PlanModel(
              model.plan,
              agent.id,
              input,
              new Set(input.tools.map((tool) => tool.name)),
              signal,
            )
          : undefined,
        learnedSkills,
        governedModel,
      ),
      loadAttachment,
      markAttachmentsSent,
    );

  const whole = withTools(granted);
  if (!narrowing && !handoff && !model.plan && !acquireLearnedSkills)
    return whole;

  return new RunBuiltAgent(
    { agentId: agent.id, description: agent.name },
    whole,
    async (input, signal) => {
      const learnedSkills = await acquireLearnedSkills?.(agent.id, signal);
      signal.throwIfAborted();
      if (
        learnedSkills &&
        [...granted, ...input.tools].some((tool) =>
          LEARNED_SKILL_TOOL_NAMES.has(tool.name),
        )
      ) {
        throw new Error(
          "Learned Skill tool names are reserved by Automatic Learning.",
        );
      }
      const offered = narrowing ? await offeredFor(input, signal) : granted;
      signal.throwIfAborted();
      /*
       * The tool for handing work to another Bot is made per run, not per request.
       *
       * It has to know which run is asking: how deep the chain already is, and which conversation an
       * answer belongs in. Both live on the run rather than on the request, and both have to be this
       * deployment's own statement rather than anything the model can edit. A request is earlier
       * than a run and knows neither.
       */
      const passing = (await handoff?.(agent.id, input)) ?? [];
      signal.throwIfAborted();
      const tools = passing.length > 0 ? [...offered, ...passing] : offered;
      // Nothing added and nothing narrowed means nothing to rebuild, and reusing the agent already
      // built for this request keeps that path allocation-for-allocation what it was.
      return !model.plan &&
        !learnedSkills &&
        tools.length === granted.length &&
        passing.length === 0
        ? whole
        : withTools(tools, input, signal, learnedSkills);
    },
  );
}

/**
 * The tools a run gets for reaching past itself: handing work to another Bot, and asking a person.
 *
 * Given the Bot and the run, because the answers depend on both: which Bots this one has been
 * granted, and how deep the chain it is already part of has gone. Empty means this run reaches
 * nobody, which is the right shape for a deployment with the capability switched off.
 *
 * The two arrive together because a model chooses between them. Offering the way to hand work
 * sideways without the way to stop and ask leaves the model one exit from a decision it cannot make,
 * and it takes it: it asks a Bot that cannot settle the question either.
 */
export type HandoffForRun = (
  botId: string,
  input: RunAgentInput,
) => Promise<readonly GrantedTool[]>;

/**
 * How a deployment narrows a Bot's tools to the ones a run is about. Absent means it does not.
 *
 * Three collaborators rather than one, because they fail differently and are configured in
 * different places: the skills come from the plugin store, the choosing is a model call on the
 * deployment's own key, and the record goes to the audit trail. A deployment missing any of them
 * should lose the narrowing and keep the Bot, which is why `record` is optional and the other two
 * are allowed to throw.
 */
export type ToolSelection = {
  /** What this Bot's granted skills declare. Failure is diagnosed and treated as "no skills". */
  loadSkills: (botId: string) => Promise<SelectableSkill[]>;
  /** Pass one. Ordinary failures skip narrowing; cancellation stops the run. */
  choose: (prompt: string, signal?: AbortSignal) => Promise<string | null>;
  /** Writes the discovery row. Never allowed to fail a run. */
  record?: (botId: string, selection: Selection<GrantedTool>) => Promise<void>;
  /** Overrides the default catalogue size below which nothing is narrowed. */
  floor?: number;
};

/**
 * A remote AG-UI agent that states its standing role on every run.
 *
 * This is standard AG-UI middleware rather than a request transformation on one provider's client,
 * so the same coworker works against any endpoint that speaks the protocol. Any copy of the standing
 * message already in the conversation is dropped: the endpoint must receive exactly one, first,
 * however many times the thread has been replayed.
 *
 * The stall watch is not here but in {@link remoteTransport}, on the fetch: this middleware works in
 * AG-UI events and a stall is the absence of one, so the thing that has to be watched is the
 * response body, and the fetch is where this deployment still holds it.
 */
/** The client `@ag-ui/mastra` asks for, taken from its own signature. See `remoteTransport`. */
type MastraClientForBridge = Parameters<
  typeof import("@ag-ui/mastra").getRemoteAgents
>[0]["mastraClient"];

/**
 * How this deployment dials a remote Bot's endpoint.
 *
 * Both kinds come back as an `AbstractAgent`, which is the whole point of putting them here. Every
 * control the wrapper below adds — the standing role, the holdings message, the offered tools, the
 * signed run assertion — is written against that interface, so a Mastra Bot is governed by exactly
 * the same code as an AG-UI one and cannot skip a control by being a different kind. A second
 * wrapper per transport is how that stops being true, silently, three months later.
 *
 * Mastra is reached through `@ag-ui/mastra`, the bridge Mastra and AG-UI maintain between them,
 * rather than through anything written here. A Mastra server speaks its own client protocol, and the
 * mapping from that protocol to AG-UI events belongs to the people who change both ends of it.
 * Imported dynamically so a deployment that registers no Mastra Bot never loads it.
 */
async function remoteTransport(
  agent: RegisteredRemoteAgent,
  stallGuard: StallGuard | undefined,
  agentFetch?: AgentFetch,
  /** Who or what started this run, so a stall is reported against them rather than nobody. */
  initiator?: AuditInitiator,
): Promise<AbstractAgent> {
  // The watch wraps whichever fetch is underneath, so a deployment gets both the stall timeout and
  // the redirect check rather than having to choose.
  const dial = stallGuard
    ? stallGuard.watch(
        { id: agent.id, name: agent.name, ...(initiator ? { initiator } : {}) },
        agentFetch,
      )
    : agentFetch;

  if (agent.type === "remote_ag_ui") {
    return new HttpAgent({
      url: agent.endpoint,
      agentId: agent.id,
      // The customer's own key, if their agent sits behind one. `HttpAgentConfig` is
      // `{ url, headers?, fetch? }`, verified against @ag-ui/client 0.0.57.
      ...(agent.headers ? { headers: agent.headers } : {}),
      ...(dial ? { fetch: dial } : {}),
    });
  }

  const [{ MastraClient }, { getRemoteAgents }] = await Promise.all([
    import("@mastra/client-js"),
    import("@ag-ui/mastra"),
  ]);

  const client = new MastraClient({
    baseUrl: agent.endpoint,
    ...(agent.headers ? { headers: agent.headers } : {}),
    // `MastraClient` types this as the global `fetch`, which carries `preconnect`; the watched fetch
    // is a call signature only, and is never used as anything but a fetch.
    ...(dial ? { fetch: dial as unknown as typeof fetch } : {}),
  });

  const roster = await getRemoteAgents({
    /*
     * The same class, twice, under two names.
     *
     * This server runs zod 4 and `@ag-ui/mastra` depends on zod 3, so the package manager resolves
     * two peer variants of `@mastra/client-js` — identical code at identical version 1.43.0, but
     * two nominal types to TypeScript, which tells them apart by a private field. The cast crosses
     * that and nothing else. It is deliberately written against the bridge's own parameter type, so
     * the day the two versions really do diverge this stops compiling instead of lying.
     *
     * The alternative, forcing zod 4 onto `@ag-ui/mastra` with an override, makes the type error go
     * away by risking a real one at runtime in somebody else's package. Not worth it for a private
     * field.
     */
    mastraClient: client as unknown as MastraClientForBridge,
    /*
     * Mastra scopes its memory by `resourceId`, and this deployment hands it the Bot rather than the
     * person deliberately. History here is ours: it is restored from Intelligence and sanitised
     * before every run, so nothing depends on the endpoint remembering anything. Sending the
     * person's identity would put it on a server this deployment does not run, to drive a feature it
     * does not use, which is the same reason standing instructions stop at the built-in path.
     */
    resourceId: agent.id,
  });

  const picked = pickFromRoster(Object.keys(roster), agent);
  return roster[picked] as AbstractAgent;
}

/**
 * Which agent on a Mastra server a Bot means.
 *
 * Pure and separate from the dialling so it can be tested without a server, because the failure it
 * prevents is not one a live test would show: picking the wrong agent produces a Bot that answers
 * confidently as somebody else, which reads as a bad model rather than as the misconfiguration it
 * is. Throws rather than guessing, and names what the endpoint does serve, because that is the one
 * fact whoever is reading the error does not have.
 */
export function pickFromRoster(
  served: readonly string[],
  agent: { id: string; remoteAgentId?: string },
): string {
  const wanted = agent.remoteAgentId ?? agent.id;
  if (served.includes(wanted)) {
    return wanted;
  }
  /*
   * One agent and no name asked for is the ordinary single-agent server, and taking it is what was
   * meant. A name that was asked for and is not there is never silently replaced by the only agent
   * present: that turns a typo into a Bot that works and is wrong.
   */
  const only = served.length === 1 ? served[0] : undefined;
  if (!agent.remoteAgentId && only) {
    return only;
  }
  throw new Error(
    `Mastra endpoint for Bot "${agent.id}" serves no agent named "${wanted}". It serves: ${
      served.join(", ") || "none"
    }.`,
  );
}

function remoteAgentWithStandingRole(
  agent: RegisteredRemoteAgent,
  /**
   * The dialled endpoint, already built. See {@link remoteTransport}.
   *
   * Passed in rather than constructed here because building a Mastra transport is asynchronous and
   * this function is not, but the better reason is that it makes the governance below indifferent
   * to the transport: there is one wrapper, and no kind of remote Bot has its own copy of it to
   * drift from.
   */
  remote: AbstractAgent,
  /**
   * What this Bot was granted. Governed vendor and host tools execute through the AG-UI client
   * lifecycle here, where the grant, policy and approval context are. Coordination tools use the
   * signed deployment callback to retain verified delegation and durable person-question routing.
   */
  tools: GrantedTool[] = [],
  signRun?: SignRun,
  /** As for the built-in path: what this deployment connects to, held or not. */
  connectedVendors: readonly string[] = [],
  /**
   * Which of those tools this run is about, decided once the message is known.
   *
   * NARROWED HERE RATHER THAN BY WRAPPING THE AGENT, and the difference is not cosmetic. Middleware
   * registered with `.use()` is applied by `runAgent`, not by `run`: an outer agent that delegated
   * to `remote.run(input)` would skip this whole function's work, and the endpoint would receive a
   * run with no standing role, no holdings message, no tools and no signed assertion. Every one of
   * those is silent — the Bot simply answers worse — so the narrowing goes inside the middleware
   * that is already here.
   *
   * Absent means no narrowing, which is the behaviour every deployment had before this existed.
   */
  narrow?: (input: RunAgentInput) => Promise<GrantedTool[]>,
  /*
   * No `agentFetch` and no `initiator` here any more, and they were not dropped: the transport this
   * function used to build itself is now built by `remoteTransport` and handed in as `next`, and
   * that is where both went. Passing them again would be two names for one wiring, and the second
   * one would be the one nothing reads.
   */
  /**
   * How this run's attached files are inlined, applied inside the middleware below for the reason
   * the sanitiser is: `run` skips `.use()`. Absent means nothing is inlined.
   */
  loadAttachment?: LoadAttachment,
  /** How this run records that those files were sent. See {@link buildAgents}. */
  markAttachmentsSent?: MarkAttachmentsSent,
  acquireLearnedSkills?: AcquireLearnedSkills,
  coordination?: HandoffForRun,
  initiator?: AuditInitiator,
) {
  /*
   * What this Bot holds, as a second standing message.
   *
   * Beside the role rather than inside it, because the role comes from the package and this comes
   * from the grants: they change for different reasons and at different times. Sent on every run for
   * the same reason the tools are, so switching a connector on reaches the next run.
   *
   * The remote path needs this more than the built-in one, not less. A framework Bot is handed the
   * tools as an offer and decides for itself what to call, with `COMPUTER_GUIDANCE` as its whole
   * prompt — a page about the browser that mentions connectors nowhere. That is the Bot that browsed
   * to drive.google.com holding four Drive tools.
   *
   * Built from the tools this run was offered rather than from everything granted, so a narrowed
   * run is never told it holds a system it cannot reach on this turn.
   */
  const holdingsMessageFor = (offered: GrantedTool[]) => {
    const holdings = grantedToolGuidance(offered, connectedVendors);
    return holdings
      ? {
          id: `granted-tools:${agent.id}`,
          role: "system" as const,
          content: holdings,
        }
      : null;
  };

  const runWith = (
    tools: GrantedTool[],
    input: RunAgentInput,
    next: AbstractAgent,
  ) => {
    const holdingsMessage = holdingsMessageFor(tools);
    const runAssertion = signRun
      ? signRun(
          agent.id,
          input.runId,
          input.threadId,
          input.forwardedProps?.openbotRun,
        )
      : undefined;
    // Governed vendor/host calls use the actual AG-UI client lifecycle, so approvals capture
    // the provider's toolCallId, messages and state. Coordination retains its signed callback.
    const clientTools = tools.filter(
      (tool) =>
        typeof tool.execute === "function" &&
        tool.name !== "message_bot" &&
        tool.name !== "ask_person",
    );
    const clientNames = new Set(clientTools.map((tool) => tool.name));
    const deploymentTools = tools
      .filter((tool) => !clientNames.has(tool.name))
      .map((tool) => tool.name);
    const forwardedProps = {
      ...(isPlainObject(input.forwardedProps) ? input.forwardedProps : {}),
      openbotBotId: agent.id,
      /*
       * Which of those tools this deployment runs, as opposed to the surface.
       *
       * `tools` mixes two kinds that a name cannot tell apart: the Bot's grants, which execute
       * here through the policy and the audit trail, and the components the browser draws. A Bot
       * that ran the second kind through this deployment asked it to execute a chart, was told it
       * could not, and then apologised to the person for not showing the chart that was on screen
       * in front of them. Only this side knows which is which, so only this side can say.
       */
      openbotDeploymentTools: deploymentTools,
      /*
       * This deployment's own statement of what this run is.
       *
       * Signed, short-lived, and naming the Bot and the person. The agent hands it back when it
       * calls a tool, and that is where the Bot and the actor come from: its own token says which
       * agent is calling, and this says who it is calling for. Neither is taken from the request
       * body any more, which is what used to make the audit trail forgeable by anything holding
       * one shared secret.
       */
      ...(runAssertion
        ? { openbotRun: runAssertion }
        : /*
           * Absent means this deployment cannot sign, so the agent is given nothing to hand back
           * and its tool calls will be refused. That is the right direction to fail: a Bot that
           * cannot prove whose run it is should not be spending anybody's grants.
           */
          {}),
    };
    /*
     * The same guard a built-in Bot gets in `BuiltInAgentWithSaneHistory`, applied here because a
     * remote Bot never passes through it: this middleware is the last thing between the browser's
     * `input.messages` and the endpoint. A framework at the other end that converts with the same
     * SDK refuses a dangling call for the same reason, and one that does not would still be
     * shown a call nothing is going to answer. Done inside the middleware rather than by wrapping
     * the agent, for the reason given above `remoteAgentWithStandingRole`: `run` skips `.use()`.
     */
    const answeredByResume = new Set(
      (input.resume ?? []).map((entry) => entry.interruptId),
    );
    const history = sanitizeSeededHistory(
      input.messages.filter(
        (message) =>
          message.id !== agent.standingMessage.id &&
          message.id !== holdingsMessage?.id,
      ),
      answeredByResume,
    );
    /*
     * And the attached files, inlined here for the same reason that guard is here: this middleware
     * is the last thing between the browser's `input.messages` and the endpoint, and `run` skips
     * `.use()`. Left alone, a file reaches the endpoint as an `/api/attachments/<id>` URL on a
     * server that holds no session here and cannot fetch it, so the Bot answers about a file it
     * never received.
     *
     * ALONGSIDE THE SANITISER, NOT INSTEAD OF IT. One drops what the provider is going to refuse;
     * this puts in front of the model what the person actually attached.
     */
    return from(
      loadAttachment
        ? inlineAttachments(
            history,
            loadAttachment,
            // The conversation this run is in, which is what decides whose files it may reach.
            input.threadId,
            markAttachmentsSent,
          )
        : Promise.resolve(history),
    ).pipe(
      switchMap((messages) => {
        const prepared: RunAgentInput = {
          ...input,
          messages: [
            agent.standingMessage,
            ...(holdingsMessage ? [holdingsMessage] : []),
            ...messages,
          ],
          /*
           * The Bot's own grants, added to whatever the surface offered.
           *
           * Sent on every run rather than configured once on the endpoint, because a grant an
           * administrator adds or revokes has to apply to the next run and the endpoint is somebody
           * else's process.
           */
          tools: [
            ...(input.tools ?? []),
            ...tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: z.toJSONSchema(tool.parameters) as Record<
                string,
                unknown
              >,
            })),
          ],
          context:
            agent.type === "remote_mastra"
              ? [
                  ...callerMastraContext(input.context ?? []),
                  ...mastraOpenBotContext({
                    standingMessage: agent.standingMessage,
                    holdingsMessage,
                    botId: agent.id,
                    deploymentTools,
                    runAssertion,
                  }),
                ]
              : input.context,
          // Who the Bot is calling back as, so the audit row names it rather than "an agent".
          forwardedProps,
        };
        if (clientTools.length === 0) return next.run(prepared);
        return new HeadlessToolsMiddleware(
          clientTools.map((tool) => ({
            definition: {
              name: tool.name,
              description: tool.description,
              parameters: z.toJSONSchema(tool.parameters) as Record<
                string,
                unknown
              >,
            },
            execute: (args) => tool.execute(args),
          })),
          initiator,
        ).run(prepared, next);
      }),
    );
  };

  /*
   * Deferred, because choosing the tools is a model call and middleware has to answer with a stream
   * straight away. `defer` puts the work on the subscription, which is where the run actually
   * begins, so nothing happens until somebody is listening and a retried run chooses again.
   */
  return new CloningRemoteAgent(remote, (target) => {
    target.use((input, next) => {
      const stream = defer(() =>
        from(
          Promise.all([
            narrow ? narrow(input) : Promise.resolve(tools),
            coordination?.(agent.id, input) ?? Promise.resolve([]),
          ]).then(([offered, coordinationTools]) => [
            ...offered,
            ...coordinationTools,
          ]),
        ).pipe(switchMap((offered) => runWith(offered, input, next))),
      );
      const owned =
        !!process.env.MANAGED_AGENT_TOKEN &&
        agent.headers?.["x-openbot-agent-token"] ===
          process.env.MANAGED_AGENT_TOKEN &&
        [
          process.env.PICKED_HARNESS_URL,
          process.env.MANAGED_AGENT_AG_UI_URL,
        ].some(
          (url) =>
            url?.replace(/\/$/, "") === agent.endpoint.replace(/\/$/, ""),
        );
      return owned ? observeModelConnection(stream) : stream;
    });
    if (acquireLearnedSkills)
      target.use(
        new RemoteLearnedSkillsMiddleware(agent.id, acquireLearnedSkills),
      );
  });
}

const RESERVED_MASTRA_CONTEXT_DESCRIPTIONS = new Set([
  "OpenBot standing role",
  "OpenBot granted tools guidance",
  "OpenBot Bot id",
  "OpenBot deployment tools",
  "OpenBot signed run assertion",
  "OpenBot learned skills",
]);

function callerMastraContext(context: AgentContext[]): AgentContext[] {
  return context.filter(
    (entry) => !RESERVED_MASTRA_CONTEXT_DESCRIPTIONS.has(entry.description),
  );
}

function mastraOpenBotContext({
  standingMessage,
  holdingsMessage,
  botId,
  deploymentTools,
  runAssertion,
}: {
  standingMessage: StandingRoleMessage;
  holdingsMessage: StandingRoleMessage | null;
  botId: string;
  deploymentTools: string[];
  runAssertion: string | undefined;
}): AgentContext[] {
  return [
    {
      description: "OpenBot standing role",
      value: standingMessage.content,
    },
    ...(holdingsMessage
      ? [
          {
            description: "OpenBot granted tools guidance",
            value: holdingsMessage.content,
          },
        ]
      : []),
    {
      description: "OpenBot Bot id",
      value: botId,
    },
    {
      description: "OpenBot deployment tools",
      value: JSON.stringify(deploymentTools),
    },
    ...(runAssertion
      ? [
          {
            description: "OpenBot signed run assertion",
            value: runAssertion,
          },
        ]
      : []),
  ];
}

class CloningRemoteAgent extends AbstractAgent {
  headers?: AgentHeaders;
  private readonly remote: HeaderBearingAgent;

  constructor(
    remote: AbstractAgent,
    private readonly attachOpenBotMiddleware: (target: AbstractAgent) => void,
  ) {
    super({
      agentId: remote.agentId,
      description: remote.description,
      threadId: remote.threadId,
      initialMessages: remote.messages,
      initialState: remote.state,
      debug: remote.debug,
    });
    this.remote = remote as HeaderBearingAgent;
    if (this.remote.headers) {
      this.headers = { ...this.remote.headers };
    }
    this.attachOpenBotMiddleware(this);
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    if (this.headers) {
      this.remote.headers = { ...this.headers };
    }
    return this.remote.run(input);
  }

  async getCapabilities() {
    return this.remote.getCapabilities?.() ?? {};
  }

  abortRun(): void {
    this.remote.abortRun();
    super.abortRun();
  }

  clone() {
    const clonedRemote = this.remote.clone() as AbstractAgent;
    const clone = new CloningRemoteAgent(
      clonedRemote,
      this.attachOpenBotMiddleware,
    );
    if (this.headers) {
      clone.headers = { ...this.headers };
    }
    return clone;
  }
}

/**
 * A built-in Bot that will not hand the model provider a conversation it is going to refuse.
 *
 * FOUND LIVE, ON CHAT. One person's next three messages each failed with
 * `AI_MissingToolResultsError: Tool result is missing for tool call chatcmpl-tool-8dd56dc7497c5ea9`,
 * thrown out of the AI SDK's `convertToLanguageModelPrompt`. A frontend tool handler had been torn
 * down while its call was open, so the agent's live messages in the browser carried an assistant
 * message whose tool call never got a result. The durable store did not have it, nothing was going
 * to answer it, and every retry sent it straight back up as `input.messages`. The conversation was
 * finished until the person worked out for themselves to start another one.
 *
 * The guard has to be on this side of `run`. `BuiltInAgent.run` converts `input.messages` itself,
 * with no seam in between, so wrapping the agent is the only place left to stand. The reasoning for
 * why a dangling call is DROPPED rather than repaired, and why ids are never changed, is in
 * `agents/history-sanitize.ts`, where the routines path found the same failure first.
 *
 * A RESUMED CALL IS NOT A DANGLE. `run` appends a tool result for each `input.resume` entry by
 * `interruptId` AFTER converting the messages, so a call that a resume is about to answer must
 * survive this pass or the appended result lands on nothing.
 */
class BuiltInAgentWithSaneHistory extends BuiltInAgent {
  /**
   * The configuration, held a second time because the base class keeps its own copy private and
   * {@link clone} has to build another one of THIS class rather than of the base.
   */
  private readonly configuration: BuiltInAgentConfiguration;
  /**
   * How this Bot's attached files are inlined, or absent to leave them alone.
   *
   * Held for the same reason {@link configuration} is: {@link clone} builds another one of THIS
   * class and everything the run depends on has to survive that.
   */
  private readonly loadAttachment: LoadAttachment | undefined;
  /**
   * How this Bot records that the files on the message it is answering were sent, or absent to
   * record nothing. Held for the reason {@link loadAttachment} is: {@link clone} builds another one
   * of THIS class, and a seam lost in a clone is a seam that never runs.
   */
  private readonly markAttachmentsSent: MarkAttachmentsSent | undefined;

  constructor(
    configuration: BuiltInAgentConfiguration,
    loadAttachment?: LoadAttachment,
    markAttachmentsSent?: MarkAttachmentsSent,
  ) {
    super(configuration);
    this.configuration = configuration;
    this.loadAttachment = loadAttachment;
    this.markAttachmentsSent = markAttachmentsSent;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const answeredByResume = new Set(
      (input.resume ?? []).map((entry) => entry.interruptId),
    );
    const history = sanitizeSeededHistory(input.messages, answeredByResume);
    const load = this.loadAttachment;
    /*
     * ALONGSIDE THE GUARD ABOVE, NOT INSTEAD OF IT. One drops a conversation the model provider is
     * going to refuse; this replaces the stored reference a person's attachment arrives as with the
     * bytes themselves, because `BuiltInAgent.run` converts `input.messages` with no seam in
     * between and a `/api/attachments/<id>` URL is not something a model provider will go and fetch.
     *
     * Nothing to load means nothing to inline, and the run goes up exactly as it did before any of
     * this existed.
     */
    if (!load)
      return nativeApprovalRun({ ...input, messages: history }, () =>
        observeModelConnection(super.run({ ...input, messages: history })),
      );
    /*
     * Deferred, because `run` has to answer with a stream straight away and reading the bytes is a
     * database round trip. `defer` puts that read on the subscription, which is where the run
     * actually begins, so nothing is fetched until somebody is listening.
     */
    return defer(() =>
      from(
        inlineAttachments(
          history,
          load,
          // As above: the run's own conversation, not the actor's channels at large.
          input.threadId,
          this.markAttachmentsSent,
        ),
      ).pipe(
        switchMap((messages) =>
          nativeApprovalRun({ ...input, messages }, () =>
            observeModelConnection(super.run({ ...input, messages })),
          ),
        ),
      ),
    );
  }

  /**
   * Carried by hand, for the same reason {@link RunBuiltAgent.clone} is.
   *
   * The runtime clones an agent before every run, and the base class's clone hard-codes
   * `new BuiltInAgent(this.config)`: inherited unchanged, the very first message anybody sends
   * would go through an agent that does none of the above. The middleware list is copied because
   * the base clone copies it, and it is reached through a cast because `AbstractAgent` declares it
   * private. Nothing registers middleware on a built-in Bot today, and this is here so that the day
   * something does, it is not lost in a clone.
   */
  clone(): BuiltInAgentWithSaneHistory {
    const cloned = new BuiltInAgentWithSaneHistory(
      this.configuration,
      this.loadAttachment,
      this.markAttachmentsSent,
    );
    type WithMiddlewares = { middlewares: unknown[] };
    (cloned as unknown as WithMiddlewares).middlewares = [
      ...(this as unknown as WithMiddlewares).middlewares,
    ];
    return cloned;
  }
}

/**
 * An agent whose tools are decided when the run starts, because that is the first moment anybody
 * knows what the run is about, and who is asking on whose behalf.
 *
 * WHY A WRAPPER AND NOT A NARROWER `loadTools`. Tools are resolved per request, and a request is
 * earlier than a run: at that point there is a Bot and a person and no message, so there is nothing
 * to select against. `run(input)` is the first place the message exists. Both underlying agents take
 * their tools at construction — a built-in one in its configuration, a remote one in the middleware
 * that sends them — so the only way to hand either a set chosen from the message is to build it
 * after the message arrives. That is all this does: it defers `build` to the first subscription and
 * then gets out of the way.
 *
 * The deferral is per subscription, so a retried run reselects rather than reusing a decision made
 * for a message that is no longer the last one.
 */
class RunBuiltAgent extends AbstractAgent {
  /**
   * Stop must reach the pending build as well as the eventual model. Keep both in one per-run
   * record so a late build or teardown cannot replace the next run's cancellation target.
   */
  private active?: { controller: AbortController; inner?: AbstractAgent };
  /** The same Bot with nothing narrowed, kept to answer questions that are not about one run. */
  private whole: AbstractAgent;
  private build: (
    input: RunAgentInput,
    signal: AbortSignal,
  ) => Promise<AbstractAgent>;

  constructor(
    identity: { agentId: string; description: string },
    whole: AbstractAgent,
    build: (
      input: RunAgentInput,
      signal: AbortSignal,
    ) => Promise<AbstractAgent>,
  ) {
    super(identity);
    this.whole = whole;
    this.build = build;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return defer(() => {
      const active: NonNullable<RunBuiltAgent["active"]> = {
        controller: new AbortController(),
      };
      this.active = active;
      const { signal } = active.controller;
      return defer(() => this.build(input, signal)).pipe(
        switchMap((agent) => {
          signal.throwIfAborted();
          active.inner = agent;
          return agent.run(input);
        }),
        // Settle Stop even if a collaborator ignores the signal or rejects after cancellation.
        takeUntil(fromEvent(signal, "abort")),
        finalize(() => {
          if (this.active === active) this.active = undefined;
          active.controller.abort(PLAN_RUN_COMPLETED);
        }),
      );
    });
  }

  /**
   * What the Bot can do, answered from the un-narrowed agent.
   *
   * Capabilities are asked for outside a run, where there is no message and so nothing to select
   * against. They are also a fact about the Bot rather than about one turn: a deployment that
   * narrowed this run to three tools has not stopped supporting whatever the underlying agent
   * supports.
   */
  getCapabilities() {
    return this.whole.getCapabilities?.() ?? Promise.resolve({});
  }

  /**
   * Carried by hand, because `AbstractAgent.clone` does not know this class exists.
   *
   * It builds a bare object on the prototype and copies a fixed list of base fields onto it, so
   * every field declared here arrives `undefined`. The runtime clones an agent before every run
   * (`agents[agentId].clone()`), which means the omission is not a corner case: without this, the
   * first message anybody sends fails on a `build` that is not a function.
   */
  clone(): RunBuiltAgent {
    const cloned = super.clone() as RunBuiltAgent;
    cloned.whole = this.whole;
    cloned.build = this.build;
    // A clone owns its cancellation state, including while its build is pending.
    cloned.active = undefined;
    return cloned;
  }

  abortRun(): void {
    const active = this.active;
    active?.controller.abort();
    active?.inner?.abortRun();
    super.abortRun();
  }
}

class UnavailableAgent extends AbstractAgent {
  private reason: string;

  constructor(agent: RegisteredUnavailableAgent) {
    super({ agentId: agent.id, description: agent.name });
    this.reason = agent.reason;
  }

  clone(): UnavailableAgent {
    const cloned = super.clone() as UnavailableAgent;
    // The runtime clones before running; the base clone only carries base-class fields.
    cloned.reason = this.reason;
    return cloned;
  }

  // Refused here rather than at the endpoint: a deleted coworker has no endpoint worth contacting,
  // and the person is owed the reason rather than a transport error.
  run(): never {
    throw new Error(this.reason);
  }
}

export async function resolveRuntimeAgents(
  loadAgents: () => Promise<RegisteredAgent[]>,
  model: RuntimeModel,
  resolveModelApiKey: () => Promise<string | null>,
  stallGuard?: StallGuard,
  loadTools?: LoadToolsForBot,
  signRun?: SignRun,
  computerGuidance?: string,
  loadVendors?: () => Promise<readonly string[]>,
  selection?: ToolSelection,
  agentFetch?: AgentFetch,
  /** How a run gets its tool for handing work on. Absent means no Bot is offered one. */
  handoff?: HandoffForRun,
  /**
   * Build only this one, when the caller wants only this one.
   *
   * A hop delivery and a routine's turn each want a single Bot, and both were resolving the whole
   * roster to reach it: every registered Bot constructed, and a granted-tools query for each, with
   * all but one thrown away. On a hop that is paid again on every retry. The roster is still LOADED
   * in full, because which Bots exist for this person is what decides whether the one asked for is
   * theirs to see at all; what narrows is what gets built.
   */
  onlyBotId?: string,
  /**
   * The standing instructions of the person this build is for.
   *
   * Appended after `onlyBotId` rather than beside the other per-person collaborators, because these
   * are positional and moving one shifts every existing call site by one.
   */
  loadInstructions?: LoadInstructions,
  /** Appended after `loadInstructions`, for the positional reason it gives. */
  initiator?: AuditInitiator,
  /**
   * How a message's attached files are put in front of the model. Appended after `initiator`, for
   * the same positional reason. Absent means nothing is inlined, which is what every deployment did
   * before this existed.
   */
  loadAttachment?: LoadAttachment,
  /**
   * How a send is recorded against the files it carried. Appended after `loadAttachment`, for the
   * same positional reason. Absent means nothing is recorded.
   */
  markAttachmentsSent?: MarkAttachmentsSent,
  acquireLearnedSkills?: AcquireLearnedSkills,
  loadPersonalMemory?: LoadPersonalMemory,
  /** Appended after `loadPersonalMemory`, for the positional reason it gives. */
  loadKnowledge?: LoadKnowledgeForBot,
  /**
   * The server-only governed model collaborator, present only inside a
   * governed admission.
   *
   * Its presence also suppresses the provider api-key read entirely: a
   * governed Bot dials the model gateway with a capability, never a provider
   * SDK key, so resolving one would be a credential read nothing consumes.
   */
  governedModel?: GovernedModelRequest,
): Promise<Record<string, AbstractAgent>> {
  const all = await loadAgents();
  if (all.length === 0) {
    throw new Error(
      "No agents are registered. Add one to the tenant package or the agents table.",
    );
  }
  const registered =
    onlyBotId === undefined
      ? all
      : all.filter((agent) => agent.id === onlyBotId);
  // Not an error: a caller asking for a Bot this person cannot see gets an empty result and decides
  // what that means, exactly as it would have from a roster that did not contain it.
  if (registered.length === 0) return {};

  const apiKey =
    !governedModel && registered.some((agent) => agent.type === "built_in")
      ? await resolveModelApiKey()
      : null;
  return buildAgents(
    registered,
    model,
    apiKey,
    stallGuard,
    loadTools,
    signRun,
    computerGuidance,
    loadVendors,
    selection,
    agentFetch,
    handoff,
    loadInstructions,
    initiator,
    loadAttachment,
    markAttachmentsSent,
    acquireLearnedSkills,
    loadPersonalMemory,
    loadKnowledge,
    governedModel,
  );
}

/** What one Bot may call, for the person whose request this is. */
export type LoadToolsForBot = (botId: string) => Promise<GrantedTool[]>;

/**
 * The deployment's signed statement of what a run is, for the agent that will run it.
 *
 * A closure rather than a key passed down, so the encryption key stays in the module that owns
 * configuration and this one never holds a secret. Shaped like `LoadToolsForBot` on purpose: both are
 * per-actor facts resolved once per request and asked per Bot.
 */
export type SignRun = (
  botId: string,
  runId: string,
  /** Which conversation, so a Bot handing work on cannot choose where the answer lands. */
  threadId: string,
  /** A prior signed delegation, verified by the deployment signer before being preserved. */
  previousAssertion?: unknown,
) => string;

/** Who is asking. Agent visibility is decided per person, so a run has to know this first. */
export type IdentifyActor = (request: Request) => Promise<AgentActor>;

/** Loads exactly the agents one person may see, already carrying their standing roles. */
export type LoadAgentsForActor = (
  actor: AgentActor,
) => Promise<RegisteredAgent[]>;

/**
 * Build the runtime's per-request agent factory.
 *
 * Resolution is per request, not per boot, because who may run a coworker is a property of the
 * person asking: a private coworker must be absent for everybody else, and a role edited a moment
 * ago must apply to the next run without a restart. Both fall out of rebuilding the map here.
 */
export function createRequestAgents(
  identifyActor: IdentifyActor,
  resolver: ActorAgentResolver,
) {
  return async ({ request }: { request: Request }) =>
    resolver.resolveAgentsForActor(await identifyActor(request));
}

/**
 * Mount the CopilotKit endpoint onto the host Hono app.
 *
 * `agents` is a factory rather than a fixed map so a Bot registered while the server is running is
 * reachable on the next request. Resolving once at boot would mean every new Bot needed a restart,
 * which is not a property you can explain to somebody who just created one.
 */
/**
 * Whether this failure means "the platform has never heard of that thread".
 *
 * A thread id is minted before the thread exists — the platform creates it on the first run — so
 * reading history on a brand-new conversation is the normal opening move, and the platform answers
 * `THREAD_NOT_FOUND` with a 404. The runtime's own handler catches everything and returns a bare 500,
 * so every new chat produced one, with a stack trace behind it.
 *
 * Matched on the shape rather than with `instanceof`. The class is `PlatformRequestError` and it
 * carries `.status` for exactly this — its own documentation gives `error.status === 404` as the
 * example — but it is not re-exported from `@copilotkit/runtime/v2`, and the package's `exports` map
 * offers no subpath that reaches it, so there is no type to test against. The name is set by the
 * constructor and the status is a number on the instance; both are checked, so an unrelated error
 * carrying a `status` of 404 does not qualify.
 *
 * 404 ONLY, and nothing wider. A 500 from the platform means an outage or a bad key, and answering
 * that with an empty history would tell the browser the conversation is gone and invite somebody to
 * start it over. That is the failure this must not introduce while removing the noisy one.
 */
export function isMissingThread(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "PlatformRequestError" &&
    (error as { status?: unknown }).status === 404
  );
}

/**
 * Read a thread's history, treating a thread the platform does not know about as having none.
 *
 * Takes the read as a function rather than being folded into the class below, so the decision can be
 * exercised against a function that really throws. The previous attempt at this fix
 * (#71) was tested by re-implementing its middleware inside the test file, which passes with the real
 * code deleted; this is the actual code path in both places.
 */
export async function historyOrEmpty<T>(
  read: () => Promise<T>,
  whenMissing: T,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isMissingThread(error)) return whenMissing;
    throw error;
  }
}

/**
 * The platform client, with one answer corrected.
 *
 * A subclass rather than a wrapper. The runtime is handed this object and calls many methods on it,
 * and the base class keeps its state in `#private` fields. Extending keeps every other method on
 * the instance that owns those fields. The authentication observer separately binds methods to
 * that original instance, so it preserves this override and its private-field receiver.
 *
 * `getThreadMessages` is the only override. `handleGetThreadMessages` in the runtime calls it and
 * returns `Response.json` of whatever comes back, so an empty history here is the `{ messages: [] }`
 * the browser expects and a 200 instead of a 500.
 */
class IntelligenceKnowingANewThread extends CopilotKitIntelligence {
  override getThreadMessages(
    params: Parameters<CopilotKitIntelligence["getThreadMessages"]>[0],
  ) {
    return historyOrEmpty(() => super.getThreadMessages(params), {
      messages: [],
    });
  }
}

/**
 * How long a conversation's lock is held before it lapses on its own.
 *
 * Matches the platform's own default rather than picking a number: this is renewed while a Bot works,
 * so what it really sets is how long a conversation stays stuck after a process dies mid-run.
 */
const THREAD_LOCK_TTL_SECONDS = 120;

export function mountCopilotRuntime(
  config: DeploymentConfig,
  resolver: ActorAgentResolver,
  identifyUser: IdentifyUser,
  identifyActor: IdentifyActor,
  options: {
    basePath?: string;
    onRunBusy?: (input: { threadId: string; busy: boolean }) => void;
    learningSettings?: LearningSettingsStore;
    /**
     * The durable enterprise Runner, present only when the verified Directory/Data capabilities
     * composed at boot. Present, the browser mount speaks CopilotKit SSE with OpenBot's own
     * admission; absent, the Intelligence runtime stays mounted as today.
     */
    enterpriseRunner?: {
      runnerForRequest: (request: Request) => AgentRunner;
    };
  } = {},
) {
  const { intelligence } = config.runtime;
  const { basePath = "/api/copilotkit", onRunBusy, learningSettings } = options;

  /**
   * The same Bot a person's run would get, built without a request.
   *
   * Handed out from here rather than assembled again elsewhere, because "built exactly the way a
   * person's run builds it" is a property worth guaranteeing structurally. A hop delivering to a Bot
   * assembled by parallel wiring would drift the first time one of these arguments changed, and the
   * drift would be invisible: the Bot would run, and quietly hold different tools or a different
   * role from the one the person talks to.
   */
  const agentFor = async (input: {
    /**
     * The person, WITH THEIR ROLE, rather than an id this rebuilds a role for.
     *
     * An administrator sees Bots a user does not. Assumed to be a user here while the desk resolved
     * the real role, the two disagreed in the worst direction: the desk accepted an administrator's
     * hop to a Bot only they can see, the model was told it had been handed over, and then every
     * delivery attempt failed to build that Bot and the person was told it never answered. A
     * refusal that failed closed became a lie that failed slowly.
     */
    actor: AgentActor;
    botId: string;
    initiator?: AuditInitiator;
  }): Promise<AbstractAgent | null> => {
    try {
      return await resolver.resolveAgentForActor(input.actor, input.botId, {
        initiator: input.initiator,
      });
    } catch (error) {
      if (error instanceof CoworkerUnavailableError) return null;
      throw error;
    }
  };

  /*
   * One client, used by the runtime and by anything reading a thread beside it, so a hop reads the
   * history a person's run would read rather than a second view of it that could disagree.
   */
  const intelligenceClient: CopilotKitIntelligence =
    observeIntelligenceAuthentication(
      new IntelligenceKnowingANewThread({
        apiUrl: intelligence.apiUrl,
        wsUrl: intelligence.gatewayWsUrl,
        apiKey: intelligence.apiKey,
        getLearningContainerId: async ({
          agentId,
          input,
          user,
        }): Promise<string | undefined> => {
          if (!user)
            throw new Error(
              "Learning Thread assignment requires a verified user.",
            );
          return learning?.containerForThread({
            agentId,
            threadId: input.threadId,
            userId: user.id,
          });
        },
      }),
    );

  const learning: LearningRuntime | undefined = learningSettings
    ? createLearningRuntime({
        store: learningSettings,
        client: intelligenceClient,
      })
    : undefined;

  /*
   * Which transport the browser mount speaks is decided by what the deployment composed, not by a
   * mode flag: the durable enterprise Runner is handed in only when the verified Directory/Data
   * capabilities exist at boot, and without them this stays the Intelligence runtime that headless
   * consumers already use. An SSE runtime without the durable Runner would answer every admission
   * question with nobody's authority, so a missing capability keeps today's mode instead of
   * inventing a permissive in-between.
   */
  const commonRuntimeOptions = {
    // identifyUser is NOT optional in practice. Threads and memory are scoped to the user it
    // returns, so omitting it puts every person in the deployment in the same thread space and one
    // person's conversations become another's.
    identifyUser,
    licenseToken: intelligence.licenseToken,
    // Carried on the events the runtime already sends, so OpenBot's traffic is separable from any
    // other deployment's. Adds no events of its own.
    telemetryProperties: {
      ...(config.accessibility ? { accessibility_title: "OpenBot" } : {}),
      ...desktopTelemetryProperties(),
    },
    /*
     * What lets a Bot answer with an interface it wrote itself.
     *
     * This one flag is the whole difference between a Bot that draws and a Bot that describes
     * markup it cannot show. The middleware it turns on does not give the model the tool — the
     * browser does that — it reads the arguments of the `generateSandboxedUi` call as they stream
     * and re-emits them as `open-generative-ui` activity events. Those events are the only thing
     * that paints: the tool's own renderer shows the waiting message and then returns nothing. So a
     * deployment with the browser half and not this one has Bots generating whole interfaces that
     * never appear, which is the shape this capability arrived in.
     *
     * `true` rather than a list of Bots. The list narrows only the event transform, and the tool
     * stays offered to every Bot regardless, so naming some Bots here would leave the others able to
     * call it and draw nothing. Whether the capability exists at all is the switch this deployment
     * has; see DeploymentConfig.generativeUi.
     */
    ...(config.generativeUi ? { openGenerativeUI: true } : {}),
    // A browser catalog enables the public A2UI middleware/tool. Explicitly disable it on the
    // server too, so stale clients cannot reactivate a deployment's generative UI opt-out.
    a2ui: { enabled: config.generativeUi },
    // `identifyUser` is the Intelligence projection of the same person `identifyActor` returns:
    // one resolver decides both whose threads these are and whose coworkers exist.
    agents: createRequestAgents(identifyActor, resolver) as never,
  };

  const runtime = options.enterpriseRunner
    ? // SSE, with admission and lifecycle answered by OpenBot's own durable Runner. The Hono
      // middleware in app.ts captures the live request; the factory binds scope, thread and lease
      // to that request alone, so no client field or cross-request state can choose authority.
      new CopilotSseRuntime({
        ...commonRuntimeOptions,
        runner: createRequestBoundAgentRunner(
          options.enterpriseRunner.runnerForRequest,
        ),
      })
    : // The subclass, not the base: a thread nobody has run yet reads as empty rather than as a
      // 500. See IntelligenceKnowingANewThread.
      new CopilotRuntime({
        ...commonRuntimeOptions,
        intelligence: intelligenceClient,
      });

  return {
    handler: createCopilotHonoHandler({ runtime, basePath }),
    learning,
    /**
     * How to reach the platform's runner, exactly as the runtime reaches it.
     *
     * TAKEN FROM THE CLIENT, NOT FROM CONFIGURATION, and this is the whole of a bug that only a real
     * gateway could show. Built from `gatewayWsUrl` and the deployment's API key, every join was
     * refused with `active_lock_mismatch`: a thread's active run is a lock the platform issues, and
     * the token that holds it is not the API key. The runtime asks the client for both, so anything
     * else driving a run has to ask the same client the same way.
     */
    runnerConnection: () => ({
      url: intelligenceClient.ɵgetRunnerWsUrl(),
      authToken: intelligenceClient.ɵgetRunnerAuthToken(),
    }),
    /**
     * The conversation's run lock, as the platform issues it.
     *
     * ONE RUN AT A TIME PER CONVERSATION. Taken before anything is streamed, because the gateway
     * checks every event against the run the lock names: a run that skips this is claiming to be one
     * nobody was told about, and every event is refused. That refusal reads like a platform
     * limitation and is a missing step.
     *
     * A conversation somebody else is already running in refuses rather than queues, which is right:
     * the caller waits and tries again rather than two Bots writing over each other.
     */
    threadLock: {
      acquire: async (input: {
        threadId: string;
        runId: string;
        userId: string;
        agentId: string;
      }) => {
        try {
          const learningContainerId = await learning?.containerForThread(input);
          await intelligenceClient.getOrCreateThread({
            ...input,
            ...(learningContainerId ? { learningContainerId } : {}),
          });
          const held = await intelligenceClient.ɵacquireThreadLock({
            ...input,
            ...(learningContainerId ? { learningContainerId } : {}),
          });
          // A run started on this thread. Side effect only, never awaited: a channel showing it is
          // working is worth nothing next to the lock the run depends on.
          try {
            onRunBusy?.({ threadId: input.threadId, busy: true });
          } catch {}
          /*
           * The run id only. The lock also hands back a join token, which is what a browser presents
           * to watch the conversation; the runner's socket has its own credential and passing this
           * one in place of it means a socket that is refused and a run that never starts. See the
           * note on `runner.run` in handoff-delivery.ts.
           */
          return { runId: held.runId };
        } catch (error) {
          /*
           * ONLY A CONFLICT MEANS "NOT NOW". Everything else is raised.
           *
           * A conversation somebody is already running in answers 409, and that is ordinary: the hop
           * waits and is tried again. Anything else is not — a platform that cannot be reached, a
           * token that stopped working, or one of the underscored APIs below being renamed by a
           * routine version bump. Returned as `null` those all read as contention: every hop retries
           * to exhaustion, every person is told their question was never answered, and the only
           * evidence is a warning line that looks like a busy conversation.
           *
           * Raised, the runner writes the real reason onto `agent.handoff_failed`, and the sentence
           * the person eventually gets names it.
           */
          const status =
            error instanceof Error && "status" in error
              ? (error as { status?: unknown }).status
              : undefined;
          if (status === 409) return null;
          throw error;
        }
      },
      renew: async (input: { threadId: string; runId: string }) => {
        await intelligenceClient.ɵrenewThreadLock({
          ...input,
          ttlSeconds: THREAD_LOCK_TTL_SECONDS,
        });
      },
      release: async (input: { threadId: string; runId: string }) => {
        // The run on this thread is over. Cleared here rather than trusting a browser: the run may
        // have outlived the tab that started it, and this is where the platform is told it ended.
        try {
          onRunBusy?.({ threadId: input.threadId, busy: false });
        } catch {}
        await intelligenceClient.ɵcleanupThreadLock(input);
      },
    },
    agentFor,
    /**
     * A thread's messages, as the platform holds them.
     *
     * The same client the runtime uses, so a hop reads the history a person's run would read rather
     * than a second view of it that could disagree.
     */
    history: async (input: { threadId: string; actorId: string }) => {
      /*
       * The platform's own message type rather than AG-UI's, inferred rather than named: the two are
       * compatible where it matters and naming the wrong one here would mean converting a history
       * that does not need converting.
       */
      type Read = Awaited<
        ReturnType<CopilotKitIntelligence["getThreadMessages"]>
      >;
      const read = await historyOrEmpty<Read>(
        () =>
          intelligenceClient.getThreadMessages({
            threadId: input.threadId,
            userId: input.actorId,
          }),
        { messages: [] } as Read,
      );
      return read.messages;
    },
  };
}
