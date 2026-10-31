import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  type AbstractAgent,
  type BaseEvent,
  EventType,
  HttpAgent,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { createOpenAI } from "@ai-sdk/openai";
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
  type CopilotKitIntelligence,
  CopilotRuntime,
  CopilotSseRuntime,
} from "@copilotkit/runtime/v2";
import { createCopilotHonoHandler } from "@copilotkit/runtime/v2/hono";
import { PROVENANCE_GUIDANCE } from "@openbot/shared/bot-prompt";
import { getLogger } from "@openbot/shared/logger";
import { defaultModelFor } from "@openbot/shared/model-providers";
import { runRootSpanId } from "@openbot/shared/run-identity";
import {
  currentTraceContext,
  deriveTracesTarget,
  injectTraceHeaders,
  SERVER_TRACING_SERVICE_NAME,
} from "@openbot/shared/trace";
import {
  BuiltInAgentWithSaneHistory,
  CloningRemoteAgent,
  IntelligenceKnowingANewThread,
  RunBuiltAgent,
  UnavailableAgent,
} from "@openbot/toolkit/copilotkit/agents";
import { createIntelligenceThreadLock } from "@openbot/toolkit/copilotkit/thread-lock";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { parametersFor } from "@openbot/toolkit/granted-tool";
import {
  HeadlessToolSuspension,
  HeadlessToolsMiddleware,
} from "@openbot/toolkit/headless-tools";
import { sanitizeSeededHistory } from "@openbot/toolkit/history-sanitize";
import { executeNativeApprovalTool } from "@openbot/toolkit/native-approval";
import { historyOrEmpty } from "@openbot/toolkit/thread-history";
import { type Context, context, TraceFlags, trace } from "@opentelemetry/api";
import {
  defer,
  filter,
  finalize,
  from,
  map,
  Observable,
  switchMap,
  tap,
  throwError,
} from "rxjs";
import { z } from "zod";
import {
  type ActorAgentResolver,
  CoworkerUnavailableError,
} from "./agents/agent-resolver";
import {
  PlanModel,
  type PlanModelConfig,
  planModelForEnvironment,
} from "./agents/plan-model";
import type { AgentActor } from "./agents/profile-types";
import type { AuditInitiator } from "./audit";
import { CreditInsufficientError } from "./billing/payer-binding";
import {
  attachmentIdsIn,
  newInlineBudget,
  resolveAttachmentParts,
  type StoredAttachment,
} from "./channels/attachment-parts";
import type { AgentFetch, StallGuard } from "./channels/stall-guard";
import type { DeploymentConfig } from "./config";
import { observeModelConnection } from "./desktop-connection-failure";
import { desktopTelemetryProperties } from "./desktop-telemetry";
import type { PlatformScope } from "./enterprise/contracts";
import type { GovernedModelRequest } from "./enterprise/runs/governed-execution";
import {
  currentRunnerRequest,
  withRunnerRequestContext,
} from "./enterprise/runs/request-context";
import {
  type PersonalMemoryBasisPointer,
  parsePersonalMemoryBasis,
} from "./hindsight/personal-memory-context";
import { observeIntelligenceAuthentication } from "./intelligence-client";
import {
  IntelligenceUnconfiguredError,
  lazyIntelligenceClient,
} from "./intelligence-optional";
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
  createMastraAgUiAgent,
  observableToAsyncIterable,
} from "./mastra/ag-ui-agent";
import {
  type MastraContinuationInstall,
  MastraContinuationRefusal,
  type MastraContinuationResumeResult,
} from "./mastra/approvals";
import {
  createProducedMessageCollector,
  type MastraConversationRuntime,
} from "./mastra/conversation-runtime";
import type {
  ExecuteMastra,
  ExecutionBinding,
  FrontendToolDefinition,
  ResumeDecision,
} from "./mastra/execution-contracts";
import { executeGovernedMastra } from "./mastra/governed-agent";
import {
  type LoadPersonalMemory,
  PersonalMemoryMiddleware,
} from "./memory/tools";
import {
  memoryContextBlock,
  type MemoryContextBlock,
} from "./memory-service/context";
import type { RecallResult } from "./memory-service/client";
import {
  currentRunObservationScope,
  withRunObservationScope,
} from "./observation-run-scope";
import type { PackageToolRunContext } from "./plugins/package-tools";
import type { SelectableSkill, Selection } from "./plugins/public";
import {
  grantedToolGuidance,
  latestUserText,
  SELECTION_FLOOR,
  selectTools,
} from "./plugins/public";
import { parseHeaders } from "./telemetry/otel";
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
 * (remote_ag_ui / remote_mastra) dial through the per-run budget admission (F5E1-F2): a
 * deployment whose wiring can verify a budget — the same credit machinery the built-in path
 * admits through — dials them over AG-UI with the W3C chain propagated and the run's
 * observation kept; a deployment that cannot keeps them fail-closed as UnavailableAgent
 * (REMOTE_RUN_BUDGET_UNVERIFIED), because a dial nobody can budget is a dial nobody can
 * account for.
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

/**
 * The two billing methods a built-in Bot's model path can carry (09.4).
 *
 * `credit` is the ordinary path: gateway dial or legacy credential, admitted by the pre-call
 * credit gate, metered, settled into the usage outbox. `subscription` is the harness path
 * (Claude Code / Codex riding the deployment's own installed harness): billed by the
 * subscription credential itself — no reservation, no meter, no outbox fact — and never a
 * path a credit-exhausted call is re-resolved onto.
 */
export type ModelBillingMethod = "credit" | "subscription";

/**
 * The billing method of the path this model resolves to — the queryable half of the
 * subscription-harness marker (09.4). Derived from credential presence alone: a run's path
 * is chosen once, at build time, by which credentials the deployment carries, and never by
 * a balance state — so there is no balance at which this answer changes mid-flight.
 */
export function billingMethodForModel(model: RuntimeModel): ModelBillingMethod {
  return model.plan ? "subscription" : "credit";
}

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

/**
 * The OpenAI model the built-in Bot falls back to when someone switches it to OpenAI and names none.
 *
 * DELIBERATELY NOT `defaultModelFor("openai")`, which is `gpt-5.5`. That default is for the remote
 * Bots: `agent-bot` and several framework Bots speak `/v1/chat/completions`, where the 5.6 models
 * refuse function tools (`agent-bot/src/index.ts`, and `docker-compose.yml` on `AGENT_BOT_MODEL`).
 * The built-in Bot speaks the Responses API, so it can run the newer model, and matches the tenant
 * package's own default (`examples/fintech/model.yaml`). The Anthropic fallback has no such split and
 * is read from the shared spec.
 */
const BUILT_IN_OPENAI_FALLBACK_MODEL = "gpt-5.6-terra";

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
        ? defaultModelFor("anthropic")
        : BUILT_IN_OPENAI_FALLBACK_MODEL;
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
 * The legacy model dial, reached only when no gateway transport is wired: a named `OPENAI_BASE_URL`
 * gets the chat-completions model instance built here, and everything else keeps the runtime's own
 * string resolution (which a wired billing gate refuses — the string form is a provider endpoint
 * the admission wrapper cannot reach).
 */
function legacyRuntimeModel(model: RuntimeModel, apiKey: string | null) {
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
 * often absent. Since the reservation rework (b616ccaa) production wires the USAGE GATE at
 * assembly (`setModelUsageGate`, server/src/index.ts), not this meter: the gate both enforces the
 * pre-call reservation and — by riding the same metered wrapper — carries the model-span
 * observation bypass. This meter stays a separately-injectable sink (tests, e2e, and a deployment
 * that meters without gating); the default drops usage on the floor, which is exactly right for a
 * deployment that meters nowhere.
 */
let usageMeter: ((usage: ModelUsageReport) => void | Promise<void>) | undefined;

export function setModelUsageMeter(
  meter: ((usage: ModelUsageReport) => void | Promise<void>) | undefined,
) {
  usageMeter = meter;
}

/**
 * Where a built-in Bot's ordinary model call is dispatched, once this deployment has a model
 * gateway (09.1): the seam hands the dial — an OpenAI-compatible base URL and the credential to
 * present — and the runtime builds the model instance from it for BOTH providers, streaming and
 * not. A gateway deployment's workbench traffic never resolves a provider endpoint itself: the
 * provider-direct string forms and the `OPENAI_BASE_URL` dial are the legacy branches, reached
 * only when this seam is not installed at all.
 *
 * Same injection shape as the meter and the gate, for the same reason: the gateway transport is
 * optional (a deployment without one mounts none of it), and `copilot.ts` must not grow a
 * dependency on configuration a deployment may not have. `index.ts` wires the deployment's gateway
 * endpoint and readiness verdict in at assembly.
 *
 * THE REFUSAL IS FAIL-CLOSED. A wired seam that answers null — the gateway cannot serve this
 * model — refuses the run with the same `UnmeterableModelError` sentinel the unprovable wirings
 * raise; a wired seam that THROWS (the readiness gate's refusal, a config read that failed) fails
 * the run with THAT reason. Neither leaves a provider-direct branch to fall back to.
 */
export type WorkbenchGatewayModelDial = {
  /** The OpenAI-compatible base URL the gateway serves chat completions at. */
  baseURL: string;
  /** The credential presented to the gateway; null passes none. */
  apiKey: string | null;
};

let workbenchGatewayModel:
  | ((
      model: RuntimeModel,
      apiKey: string | null,
    ) => Promise<WorkbenchGatewayModelDial | null>)
  | undefined;

export function setWorkbenchGatewayModel(
  dial:
    | ((
        model: RuntimeModel,
        apiKey: string | null,
      ) => Promise<WorkbenchGatewayModelDial | null>)
    | undefined,
) {
  workbenchGatewayModel = dial;
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
  /**
   * The serialized provider request prompt, bounded AT CAPTURE (OCR R2-52, H9):
   * a prompt carrying media parts (images, files, inline base64 attachments) is
   * never serialized at all — `null`, metrics-only — and a text-only prompt is
   * serialized per message and cut at 64Ki characters with an in-band
   * truncation mark, so no attachment can be pinned alive from capture through
   * the billing check to settlement. Deny-pattern projection still happens ONLY
   * at the recorder — this value is never trusted, never stored, never logged.
   */
  input: string | null;
  /**
   * The accumulated output text, bounded AT CAPTURE (OCR R2-53) to the same
   * 2000-character ceiling the failure path applies to error messages: the
   * provider's full answer is its product, not the observation's payload.
   * Projection happens ONLY at the recorder (see `input`).
   */
  output: string | null;
  /**
   * The run's observation scope, captured at `doStream` entry beside `trace`
   * (OCR R2-58): by stream teardown the ambient context is not guaranteed, so
   * the fact carries the scope its entry captured instead of leaving the
   * settlement-path adapter to re-read an ambient store that may already be
   * gone. Structural `unknown`, like every cross-module field here — the only
   * possible writer is the boot wiring's own threading. Undefined — a run that
   * started scope-less — keeps the record an honest no-op upstream, exactly as
   * before.
   */
  scope: unknown;
  /**
   * The run's W3C trace coordinates captured when the model call began (OCR h6, the
   * T15 tool-step precedent) — the chain the span joins instead of rooting its own.
   * Captured at `doStream` entry, inside the request's context, because settlement
   * can land at stream teardown where the ambient context is no longer guaranteed.
   * Null when no valid span was active (no provider, outside a traced request).
   */
  trace: { traceId: string; spanId: string } | null;
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
 * What one built-in tool step's observation bypass saw (Issue #21): the proposal the run's
 * event stream emitted, whether an execute callback in THIS process actually ran, and
 * whether a result receipt ever arrived — three separately observed facts, never collapsed.
 * `window` is how the observation window closed: only an interrupted run (the answer may
 * still arrive) may honestly leave a step merely proposed; every terminal close without a
 * real execution is unobserved, never success. Structural on purpose — `copilot.ts` must
 * not depend on the observability module; `index.ts` adapts this fact into the recorder's
 * observation at assembly.
 */
export type BuiltinToolStepFact = {
  toolCallId: string;
  toolName: string | null;
  /** When the proposal was observed; null when only the execution was. */
  proposedAt: Date | null;
  endedAt: Date;
  proposalObserved: boolean;
  executionObserved: boolean;
  receiptObserved: boolean;
  /** What the real execute settled to; present only when executionObserved. */
  execution: {
    kind: "succeeded" | "failed" | "canceled";
    output: string | null;
  } | null;
  window: "interrupted" | "terminal";
  /**
   * The run's observation scope, captured when the cell opened beside `trace`
   * (OCR R3-39): by stream teardown — the finalize path settles outside the
   * ambient context — re-reading the ambient store silently no-op'd the
   * record, so the fact carries the scope its open saw instead (the model-span
   * fact's own OCR R2-58 discipline, now on the tool-step half). Structural
   * `unknown`, like every cross-module field here — the only possible writer
   * is the boot wiring's own threading. Undefined — a run that started
   * scope-less — keeps the record an honest no-op upstream, exactly as before.
   */
  scope: unknown;
  /**
   * The run's W3C trace coordinates captured when the cell opened (Issue #23/T17) —
   * the chain a step span recorded after the fact still parents under. Null when no
   * valid span was active (no provider, outside a traced request). Structural, like
   * every field here: the adapter threads it, the recorder decides what it means.
   */
  trace: { traceId: string; spanId: string } | null;
  /** The raw accumulated call arguments — BEFORE projection; the recorder projects.
   * Bounded AT CAPTURE (OCR R3-37): accumulation stops at 64Ki characters and the
   * cut is declared in-band, so an approval wait cannot pin a large call's full
   * arguments alive between capture and settlement.
   */
  input: string | null;
  /**
   * The execution output or error text, BEFORE projection (the recorder
   * projects) but bounded AT CAPTURE (OCR R2-53): both settlement sides keep
   * the same 2000-character ceiling, so a large result is excerpted, never
   * pinned whole.
   */
  output: string | null;
  /**
   * R4-03: which path observed the step. `builtin` (the default, and the only
   * value the built-in stream facts carry) saw the run's own event stream;
   * `remote-agui` saw the endpoint's stream THROUGH this server — a run whose
   * tools executed somewhere else entirely, so the fact's `executionObserved`
   * is always false there and the receipt is its own fact. The recorder names
   * the span's origin with it; absent reads as `builtin`.
   */
  origin?: "builtin" | "remote-agui";
  /**
   * R4-03: the run identity the fact's chain belongs to, when the observing
   * path knows it (the remote middleware always does — its run id IS the
   * binding's run id). Carried so the recorder's binding gate reuses the run's
   * authoritative binding instead of minting a second one for the same chain;
   * absent on the built-in path, whose binding is the chain itself.
   */
  runRef?: Readonly<{ runId: string; attemptId: string }> | null;
};

/**
 * The tool-step observer, wired at assembly exactly like the model-span one: absent means
 * no step observation happens at all — no argument accumulation, no execute bookkeeping.
 */
let builtinToolStepObserver: ((fact: BuiltinToolStepFact) => void) | undefined;

export function setBuiltinToolStepObserver(
  observer: ((fact: BuiltinToolStepFact) => void) | undefined,
) {
  builtinToolStepObserver = observer;
}

/**
 * The observed ending's own words — the event face never invents an outcome, it
 * keeps the words the protocol itself used.
 */
export type BuiltinRunEnding =
  | "success"
  | "error"
  | "canceled"
  | "interrupted"
  | "disconnected";

/**
 * The run's OWN lifecycle fact (R3-03): what the public event face observed about the run
 * as a whole, as opposed to any step inside it. `startedAt` is the first event's arrival —
 * the earliest moment this side can honestly call the run started, never the materialization
 * clock. `terminal` is null on the start observation and names the observed ending on the
 * close observation; `ending` keeps the event face's own words — a `RUN_FINISHED` outcome is
 * `success`/`interrupted`/`canceled` by what the protocol actually carried (absent outcome
 * IS success, the protocol's own rule), `RUN_ERROR` and a stream that errors are `error`,
 * and a window that closed with NO terminal event is `disconnected` — the person stopped
 * watching or the stream was torn down, which cannot be confirmed as any outcome and is
 * never upgraded into one here. Structural, like the tool-step fact: `copilot.ts` must not
 * depend on the observability module; `index.ts` adapts this fact into the binding gate.
 */
export type BuiltinRunLifecycleFact = {
  /** The run's observation scope, captured at the first event inside the run's context. */
  scope: unknown;
  /** The run's W3C trace coordinates, captured beside `scope`; null when none was active. */
  trace: { traceId: string; spanId: string } | null;
  /** When the run's first event arrived. */
  startedAt: Date;
  /** The observed ending; null when this fact is only the start observation. */
  terminal: {
    ending: BuiltinRunEnding;
    endedAt: Date;
  } | null;
};

/**
 * The run-lifecycle observer, wired beside the tool-step one: absent means no run
 * observation happens at all, and the observable keeps its exact prior shape.
 */
let builtinRunLifecycleObserver:
  | ((fact: BuiltinRunLifecycleFact) => void)
  | undefined;

export function setBuiltinRunLifecycleObserver(
  observer: ((fact: BuiltinRunLifecycleFact) => void) | undefined,
) {
  builtinRunLifecycleObserver = observer;
}

/**
 * One open tool step, shared by the two observation points that can see it: the run's
 * event stream (the proposal, any receipt) and the execute wrapper (the real execution).
 * Correlated by toolCallId in a module-level registry because the wrapper is built once
 * per agent configuration while the stream is per run — the runtime emits the call before
 * it executes it, which is what makes the correlation sound.
 */
type BuiltinToolStepCell = {
  toolCallId: string;
  toolName: string | null;
  proposedAt: Date | null;
  proposalObserved: boolean;
  executionObserved: boolean;
  receiptObserved: boolean;
  execution: BuiltinToolStepFact["execution"];
  /** The run's W3C coordinates at open time; the fact's `trace` comes from here. */
  trace: { traceId: string; spanId: string } | null;
  /** The run's trusted scope at open time; the fact's `scope` comes from here. */
  scope: unknown;
  /** Argument deltas, joined once at close — linear, never quadratic. */
  args: string[];
  /** Running length of `args.join("")`, so the capture-ceiling check stays O(1). */
  argsLength: number;
  /** Set once deltas past the capture ceiling were dropped (OCR R3-37). */
  argsTruncated: boolean;
  closed: boolean;
  /** When the cell opened; the stalled-cell sweep's age input (OCR R5-43). */
  openedAt: Date;
  /** The run registry this cell belongs to (OCR R5-41); settling retires it there. */
  registry: BuiltinToolStepCellRegistry;
};

/**
 * One run's isolated cell registry (OCR R5-41). Cells and settled-id tombstones
 * used to live in ONE module-level map keyed by the bare toolCallId, so two
 * concurrent runs emitting the same id (OpenAI-compatible providers have
 * historically handed out per-request incrementing ids) shared a single cell:
 * the second run's arguments merged into the first's captured input, the second
 * run's whole observation vanished, and its RUN_FINISHED settled the first
 * run's cell early. The stream subscription owns a registry; an execute the
 * runtime performs mid-run reaches it through the ambient carrier below.
 */
type BuiltinToolStepCellRegistry = {
  cells: Map<string, BuiltinToolStepCell>;
  /**
   * Settled ids WITH evidence (T15 review (b)), per run: an approval resume
   * replays the same toolCallId within ITS run, never across runs. FIFO-capped.
   */
  tombstones: Set<string>;
};

function newBuiltinToolStepCellRegistry(): BuiltinToolStepCellRegistry {
  return { cells: new Map(), tombstones: new Set() };
}

/*
 * The ambient carrier from a run's stream subscription to an execute the runtime
 * performs inside that run (the same footing as the observation-scope store: the
 * context is established at subscribe time and read deep inside the run, where
 * no parameter can carry it).
 */
const builtinToolStepCellRegistries =
  new AsyncLocalStorage<BuiltinToolStepCellRegistry>();

/**
 * Executes observed OUTSIDE any run's registry — no stream subscription is
 * above them, so no stream can ever correlate with them either. Kept in one
 * module-level registry with the historical shape; the only registry that can
 * outlive its run, and the one the stalled-cell sweep bounds (OCR R5-43).
 */
const bareExecuteCells = newBuiltinToolStepCellRegistry();

/*
 * The stalled-cell backstop (OCR R5-43): a cell whose run() never settles —
 * the hung-provider shape — would otherwise pin itself, its captured arguments
 * included, for as long as the process lives. Generous enough for any
 * human-in-the-loop wait that still has a live run above it (those cells are
 * settled by their run's own teardown); this ceiling is for the ones nothing
 * will ever come back for. Swept lazily on bare-registry use; per-run
 * registries need no sweep — they die with their run's async context.
 */
const TOOL_STEP_CELL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function sweepStalledCells(
  registry: BuiltinToolStepCellRegistry,
  now: Date,
): void {
  for (const cell of registry.cells.values()) {
    if (cell.closed) continue;
    if (now.getTime() - cell.openedAt.getTime() > TOOL_STEP_CELL_MAX_AGE_MS) {
      // A settlement with nothing observed: the honest fact is that a call
      // happened and this process saw nothing of it. Proposal-only, so the
      // R3-40 narrowing leaves the id reopenable for its next real call.
      settleBuiltinToolStep(cell, "terminal");
    }
  }
}

/**
 * Settled-id tombstones are PER RUN (OCR R5-41) — each registry carries its own
 * `tombstones` set, so a settled id can never reopen a cell within its run,
 * while a concurrent run emitting the same provider id keeps its own cell.
 */
const SETTLED_ID_CAP = 4096;

function builtinToolStepCell(
  registry: BuiltinToolStepCellRegistry,
  toolCallId: string,
  toolName: string | null,
): BuiltinToolStepCell {
  if (registry.tombstones.has(toolCallId)) {
    // A closed tombstone: every later event for this id is a no-op, by the same
    // `closed` check a settled-but-still-referenced cell gets.
    return {
      toolCallId,
      toolName,
      proposedAt: null,
      proposalObserved: false,
      executionObserved: false,
      receiptObserved: false,
      execution: null,
      trace: null,
      scope: undefined,
      args: [],
      argsLength: 0,
      argsTruncated: false,
      closed: true,
      openedAt: new Date(0),
      registry,
    };
  }
  const existing = registry.cells.get(toolCallId);
  if (existing) return existing;
  const cell: BuiltinToolStepCell = {
    toolCallId,
    toolName,
    proposedAt: null,
    proposalObserved: false,
    executionObserved: false,
    receiptObserved: false,
    execution: null,
    // Captured at open, inside the request's context, because settlement can land
    // at stream teardown where the ambient context is no longer guaranteed. The
    // scope rides the same discipline (OCR R3-39): the settlement-path adapter
    // reads what the fact carried, never an ambient store that may be gone.
    trace: currentTraceContext() ?? null,
    scope: currentRunObservationScope(),
    args: [],
    argsLength: 0,
    argsTruncated: false,
    closed: false,
    openedAt: new Date(),
    registry,
  };
  registry.cells.set(toolCallId, cell);
  return cell;
}

/**
 * Bounded accumulation for one tool call's argument deltas (OCR R3-37): past
 * the capture ceiling nothing is retained, only the fact of the cut.
 */
function appendToolStepArg(cell: BuiltinToolStepCell, delta: string): void {
  const capacity = TOOL_STEP_INPUT_CAPTURE_CHARS - cell.argsLength;
  if (capacity <= 0) {
    cell.argsTruncated = true;
    return;
  }
  if (delta.length > capacity) {
    cell.args.push(delta.slice(0, capacity));
    cell.argsLength = TOOL_STEP_INPUT_CAPTURE_CHARS;
    cell.argsTruncated = true;
    return;
  }
  cell.args.push(delta);
  cell.argsLength += delta.length;
}

/** Emits one fact and retires the cell; every creation path has exactly one of these. */
function settleBuiltinToolStep(
  cell: BuiltinToolStepCell,
  window: "interrupted" | "terminal",
): void {
  if (cell.closed) return;
  cell.closed = true;
  cell.registry.cells.delete(cell.toolCallId);
  /*
   * The tombstone exists so an out-of-order late proposal cannot open a SECOND
   * cell for a call that already produced its evidence. OCR R3-40: that guard
   * only makes sense when there IS evidence — a settlement that observed an
   * execution or a receipt. A proposal-only settlement (the approval first
   * leg: the call hung on a person and the window closed without either) must
   * NOT tombstone the id, because the approval resume legitimately replays the
   * SAME toolCallId — a tombstone here swallowed the resumed leg's real
   * execution whole. A tombstoned id stays bounded (FIFO, recency only).
   */
  if (cell.executionObserved || cell.receiptObserved) {
    const tombstones = cell.registry.tombstones;
    tombstones.add(cell.toolCallId);
    if (tombstones.size > SETTLED_ID_CAP) {
      tombstones.delete(tombstones.values().next().value as string);
    }
  }
  const observer = builtinToolStepObserver;
  if (observer === undefined) return;
  try {
    observer({
      toolCallId: cell.toolCallId,
      toolName: cell.toolName,
      proposedAt: cell.proposedAt,
      endedAt: new Date(),
      proposalObserved: cell.proposalObserved,
      executionObserved: cell.executionObserved,
      receiptObserved: cell.receiptObserved,
      execution: cell.execution,
      window,
      trace: cell.trace,
      scope: cell.scope,
      input:
        cell.args.length > 0
          ? cell.args.join("") +
            (cell.argsTruncated ? TOOL_STEP_INPUT_TRUNCATION_MARK : "")
          : null,
      output: cell.execution?.output ?? null,
    });
  } catch {
    // Observation never takes the product path down.
  }
}

/**
 * The two state tools the CopilotKit engine installs on EVERY classic run (it declares
 * `AGUISendStateSnapshot`/`AGUISendStateDelta` unconditionally and executes them in-engine as
 * inert echoes). They are the protocol's own plumbing, not business steps: R4-03 — recording
 * them as tool spans put state machinery in the business record while the real business call
 * vanished from governance. Both observation paths (built-in stream and remote middleware)
 * skip them by name. The same names live in `execution-seam.ts`'s own copy; this module cannot
 * import that one (it imports this module), and a shared home would drag the observability
 * module into a path that must not depend on it.
 */
const ENGINE_STATE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "AGUISendStateSnapshot",
  "AGUISendStateDelta",
]);

/**
 * The tool-step observation bypass on the built-in run's event stream: reads ONLY the
 * public event semantics (type + payload fields), never a framework internal. A proposal
 * opens a cell; a TOOL_CALL_RESULT marks the receipt without ever impersonating an
 * execution; the run's terminal event closes whatever is still open — an interrupt leaves
 * steps proposed, every other ending leaves them unobserved. The engine's own state tools
 * are skipped (`ENGINE_STATE_TOOL_NAMES`): a business record they are not.
 */
function observeBuiltinToolSteps(
  stream: Observable<BaseEvent>,
): Observable<BaseEvent> {
  const observer = builtinToolStepObserver;
  if (observer === undefined) return stream;
  return new Observable<BaseEvent>((subscriber) => {
    /*
     * One registry per subscription (OCR R5-41): this run's cells and settled-id
     * tombstones live and die with it, so a concurrent run emitting the same
     * provider toolCallId can neither merge into this run's facts nor settle
     * them early. The subscription itself is established inside the registry's
     * ambient carrier, so an execute the runtime performs mid-run resolves to
     * THIS registry — the run's own execution tree carries the context, exactly
     * like the observation-scope threading above it.
     */
    const registry = newBuiltinToolStepCellRegistry();
    const owned: BuiltinToolStepCell[] = [];
    const close = (window: "interrupted" | "terminal") => {
      for (const cell of owned) settleBuiltinToolStep(cell, window);
      owned.length = 0;
    };
    return builtinToolStepCellRegistries.run(registry, () =>
      stream
        .pipe(
          tap({
            next: (event) => {
              switch (event.type) {
                case "TOOL_CALL_START": {
                  const name =
                    typeof event.toolCallName === "string"
                      ? event.toolCallName
                      : null;
                  // R4-03: the engine's two state tools are protocol plumbing,
                  // not business steps — a state-delta call recorded as a tool
                  // span is a state tool masquerading as the run's business
                  // record, exactly the shape the finding rejected (the only
                  // tool spans on the real chain were AGUISendStateDelta while
                  // the real business call vanished). No cell, no fact, no span.
                  if (name !== null && ENGINE_STATE_TOOL_NAMES.has(name)) break;
                  const cell = builtinToolStepCell(
                    registry,
                    String(event.toolCallId),
                    name,
                  );
                  if (!cell.proposalObserved) {
                    cell.proposalObserved = true;
                    cell.proposedAt = new Date();
                  }
                  if (!owned.includes(cell)) owned.push(cell);
                  break;
                }
                case "TOOL_CALL_ARGS": {
                  const cell = registry.cells.get(String(event.toolCallId));
                  if (cell && !cell.closed && typeof event.delta === "string")
                    appendToolStepArg(cell, event.delta);
                  break;
                }
                case "TOOL_CALL_RESULT": {
                  const cell = registry.cells.get(String(event.toolCallId));
                  if (cell && !cell.closed) cell.receiptObserved = true;
                  break;
                }
                case "RUN_ERROR":
                  close("terminal");
                  break;
                case "RUN_FINISHED": {
                  const outcome = (event as { outcome?: { type?: unknown } })
                    .outcome?.type;
                  close(outcome === "interrupt" ? "interrupted" : "terminal");
                  break;
                }
                default:
                  break;
              }
            },
            error: () => close("terminal"),
            complete: () => close("terminal"),
          }),
          // T15 review (a): a teardown WITHOUT a terminal event — the consumer
          // unsubscribed mid-run — closes every open cell too. `finalize` is the one
          // hook that fires on unsubscribe as well as on complete and error; without
          // it, the module-level registry keeps those cells forever.
          finalize(() => close("terminal")),
        )
        .subscribe(subscriber),
    );
  });
}

/**
 * The run-lifecycle observation bypass (R3-03): the same public event semantics the
 * tool-step tap reads, watched for the RUN as a whole. The first event captures the
 * run's ambient scope and trace (the teardown paths run outside that context — the
 * tool-step cell's own OCR R3-39 discipline, held here from the run's very start)
 * and emits the start observation; RUN_FINISHED and RUN_ERROR name the ending the
 * protocol itself named, and a window that closes with neither keeps `disconnected`,
 * which no caller may read as an outcome. First observed ending wins — a straggler
 * after the run already ended, including the teardown that follows a normal finish,
 * changes nothing.
 */
function observeBuiltinRunLifecycle(
  stream: Observable<BaseEvent>,
): Observable<BaseEvent> {
  const observer = builtinRunLifecycleObserver;
  if (observer === undefined) return stream;
  return new Observable<BaseEvent>((subscriber) => {
    let startedAt: Date | null = null;
    let scope: unknown;
    let trace: { traceId: string; spanId: string } | null = null;
    let ending: BuiltinRunEnding | null = null;
    const observe = (): void => {
      try {
        observer({
          scope,
          trace,
          startedAt: startedAt ?? new Date(),
          terminal: ending === null ? null : { ending, endedAt: new Date() },
        });
      } catch {
        // Observation never takes the product path down.
      }
    };
    const settle = (observed: BuiltinRunEnding): void => {
      if (ending !== null) return; // first observed ending wins
      ending = observed;
      observe();
    };
    return stream
      .pipe(
        tap({
          next: (event) => {
            if (startedAt === null) {
              // The run's own context, captured at its first event — before any
              // model or tool observation could have opened a cell under it.
              startedAt = new Date();
              scope = currentRunObservationScope();
              trace = currentTraceContext() ?? null;
              observe();
            }
            switch (event.type) {
              case "RUN_FINISHED": {
                const outcome = (event as { outcome?: { type?: unknown } })
                  .outcome?.type;
                settle(
                  outcome === "interrupt"
                    ? "interrupted"
                    : outcome === "cancelled"
                      ? "canceled"
                      : "success",
                );
                break;
              }
              case "RUN_ERROR":
                settle("error");
                break;
              default:
                break;
            }
          },
          /*
           * A stream that errored never delivered a terminal event this side could
           * read: the transport or the run itself failed, and the record names it
           * as a failure rather than filing it under an unconfirmed ending — the
           * remote middleware's own precedent (T10's error branch).
           */
          error: () => settle("error"),
          // A window that closed with nothing terminal cannot confirm any ending.
          complete: () => settle("disconnected"),
        }),
        // The teardown WITHOUT complete or error — the consumer stopped watching —
        // is the same unconfirmable window; `finalize` is the one hook that sees it.
        finalize(() => settle("disconnected")),
      )
      .subscribe(subscriber);
  });
}

/**
 * The tool-step output capture ceiling (OCR R2-53): one bound, applied to BOTH
 * sides of the execution settlement — the success result and the failure
 * message — so a large answer cannot be pinned whole between capture and the
 * recorder's projection.
 */
const TOOL_STEP_OUTPUT_CAPTURE_CHARS = 2_000;

/**
 * The tool-step input capture ceiling (OCR R3-37), on the span-input precedent
 * (OCR R2-52): 64Ki UTF-16 code units. The streamed TOOL_CALL_ARGS deltas were
 * the one tool-step payload with no capture bound — every delta was retained
 * whole until settlement, pinning a large call's full arguments for as long as
 * the cell stayed open (an approval wait pins it longest). Accumulation stops
 * at the ceiling and the cut is declared in-band, so a bounded capture can
 * never be read as the whole call; projection still happens ONLY at the
 * recorder — this value is never trusted, never stored, never logged.
 */
const TOOL_STEP_INPUT_CAPTURE_CHARS = 64 * 1024;

/** The in-band declaration appended to a cut tool-step input capture (OCR R3-37). */
const TOOL_STEP_INPUT_TRUNCATION_MARK =
  "...[observation input truncated at capture]";

/**
 * Observes one REAL execute: the callback this process runs for a tool call. The
 * settlement IS the receipt for a server-side execution. A suspension (the tool is
 * waiting on a person or the browser) is not an ending — the cell stays open and the
 * run's interrupt outcome settles it as proposed. An AbortError is a cancellation;
 * anything else thrown is a failure. `toolCallId` absent (the runtime passed none) or
 * the cell already closed means nothing is recorded — the run() always happens bare.
 */
async function observeBuiltinToolExecution<T>(
  toolName: string,
  toolCallId: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const observer = builtinToolStepObserver;
  if (observer === undefined || toolCallId === undefined) return run();
  // The run this execute was performed inside owns the cell (OCR R5-41); a bare
  // execute — no observed run above it — falls back to the module registry,
  // which is where the stalled-cell sweep earns its keep (OCR R5-43).
  const registry = builtinToolStepCellRegistries.getStore() ?? bareExecuteCells;
  if (registry === bareExecuteCells) {
    sweepStalledCells(registry, new Date());
  }
  // OCR R5-43: the stream side keys every event by String(event.toolCallId);
  // the execute side normalizes too, so one call whose provider id is not a
  // string opens ONE cell, never a second one the proposal can never meet.
  const cell = builtinToolStepCell(registry, String(toolCallId), toolName);
  /*
   * The success path keeps the failure path's 2000-character precedent (OCR
   * R2-53): a bounded capture, aligned on both sides of the settlement — the
   * tool's full result is its product, not the observation's payload, and a
   * large one must not be pinned whole until the recorder projects it.
   */
  const outputOf = (value: unknown): string | null => {
    if (typeof value === "string") {
      return value.slice(0, TOOL_STEP_OUTPUT_CAPTURE_CHARS);
    }
    try {
      const serialized = JSON.stringify(value);
      return serialized === null
        ? null
        : serialized.slice(0, TOOL_STEP_OUTPUT_CAPTURE_CHARS);
    } catch {
      // A result that cannot serialize carries no observation payload.
      return null;
    }
  };
  try {
    const value = await run();
    cell.executionObserved = true;
    cell.receiptObserved = true;
    cell.execution = { kind: "succeeded", output: outputOf(value) };
    settleBuiltinToolStep(cell, "terminal");
    return value;
  } catch (error) {
    if (error instanceof HeadlessToolSuspension) {
      // Not an ending: the run's interrupt outcome settles this cell proposed.
      throw error;
    }
    cell.executionObserved = true;
    cell.receiptObserved = true;
    const canceled = (error as { name?: unknown })?.name === "AbortError";
    cell.execution = {
      kind: canceled ? "canceled" : "failed",
      // A cancellation needs no payload — the kind says everything. A failure keeps
      // its bounded message for the recorder to project.
      output: canceled
        ? null
        : error instanceof Error
          ? error.message.slice(0, TOOL_STEP_OUTPUT_CAPTURE_CHARS)
          : null,
    };
    settleBuiltinToolStep(cell, "terminal");
    throw error;
  }
}

/** Test-only surface for the T15 observation bypass, on the T14 `meteredModelForTests` pattern. */
export const toolStepObservationForTests = {
  observeStream: observeBuiltinToolSteps,
  observeExecution: observeBuiltinToolExecution,
  /** OCR R5-43 seam: runs the bare registry's stalled-cell sweep at a chosen time. */
  sweepStalledBareCellsForTests: (now: Date) =>
    sweepStalledCells(bareExecuteCells, now),
};

/** Test-only surface for the R3-03 run-lifecycle bypass, same pattern as above. */
export const runLifecycleObservationForTests = {
  observeStream: observeBuiltinRunLifecycle,
};

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
  /**
   * Who initiated the call and which Bot ran it (09.1's consumption attribution), read off the
   * agent configuration the wrapper was built from. Nulls when the build did not know — a named
   * absence, never a guess — so the usage fact can still name its real origin.
   */
  attribution: { userId: string | null; botId: string | null };
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
 * The per-run budget admission a remote Bot's dial passes through (F5E1-F2).
 *
 * A built-in Bot's spend is bounded at the model call: admission wraps `doStream`, so the
 * gate refuses before the provider and the bounds are proven on the request. A remote Bot's
 * model lives at somebody else's endpoint, so the one point this deployment controls is the
 * DIAL — and the dial is what this gate owns. It is asked once per run, before the endpoint
 * is contacted and before the standing-role middleware's narrowing model call, and it must
 * answer with a hold over the run's worst case in the SAME credit machinery the built-in
 * path uses: one writer, one ledger, no second book.
 *
 * Settlement is honest about what a remote endpoint can report: NOTHING. AG-UI carries no
 * usage receipt, so `finish` records an outcome, never a token count, and the wiring behind
 * it keeps the hold as an unknown-cost pending settlement rather than inventing a charge or
 * a release. A gate that THROWS is a gate that refuses, fail-closed, and must leave no live
 * hold behind — the same contract `modelUsageGate` keeps.
 */
export type RemoteRunAdmissionInput = Readonly<{
  /** The stable per-run identity; the wiring derives its idempotency key from it. */
  eventId: string;
  occurredAt: Date;
  botId: string;
  runId: string;
  threadId: string;
}>;

/** What the run's own event stream could honestly name at its end. */
export type RemoteRunAdmissionOutcome =
  | "succeeded"
  | "failed"
  | "interrupted"
  /** The endpoint itself confirmed the cancellation — a named ending, not an absent one. */
  | "canceled"
  /** The consumer stopped watching or the stream was torn down: the run may still be executing. */
  | "unknown";

export type RemoteRunAdmission = Readonly<{
  /**
   * Settles the hold from the observed ending. Never a release: an endpoint's cost is
   * unobservable.
   */
  finish: (input: {
    outcome: RemoteRunAdmissionOutcome;
  }) => Promise<void> | void;
}>;

let remoteRunBudgetGate:
  | ((input: RemoteRunAdmissionInput) => Promise<RemoteRunAdmission>)
  | undefined;

export function setRemoteRunBudgetGate(
  gate:
    | ((input: RemoteRunAdmissionInput) => Promise<RemoteRunAdmission>)
    | undefined,
) {
  remoteRunBudgetGate = gate;
}

/**
 * The enforceable budget contract a supported remote endpoint runs under (R3-02).
 *
 * THE FINDING THIS ANSWERS: a per-run hold is not a contract. F5E1-F2 restored the dial behind
 * a reservation whose ceiling the ENDPOINT was never told about, so any remote could spend past
 * the hold while this deployment marked the difference unknown. A hold bounds what is CHARGED;
 * something has to bound what is SPENT, and for a remote Bot the only place that can happen is
 * inside the run at the endpoint. So the dial carries caps, the endpoint enforces them at its
 * model call and reports what was spent, and this side checks the report against the contract
 * before the run's own ending is allowed through.
 *
 * WHAT "SUPPORTED" MEANS, and it is deliberately narrow: an endpoint this deployment runs — it
 * holds the deployment token — AND that an operator has explicitly declared speaks this contract
 * (see `createRemoteBudgetContractResolver`). Everything else keeps the refusal it has always
 * had, REMOTE_RUN_BUDGET_UNVERIFIED, before any request is made: a third-party AG-UI server that
 * cannot enforce caps must not be handed a run on the promise that it might.
 *
 * The verification is a real check, not a formality, and its limits are stated rather than
 * implied: the receipt is signed with the token both ends hold, so a receipt from anything that
 * does not hold it is not accepted, and the caps, run id and usage inside it are checked against
 * what this run was dialled with. That proves the ENFORCING PARTY is the one this deployment
 * provisioned for this run and that its arithmetic is inside the contract. It cannot prove a
 * first-party process told the truth, and nothing here pretends otherwise — the enforcement that
 * matters happens in code this repository owns, on the other side of this seam.
 */
export type RemoteBudgetContractCaps = Readonly<{
  modelSteps: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}>;

/** What one run spent, as its receipt reported it. */
export type RemoteBudgetUsage = Readonly<{
  modelSteps: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}>;

/**
 * What checking one receipt concluded.
 *
 * `overrun` and `invalid` are both refusals — the run is torn down rather than delivered — and
 * they are kept apart because they are different incidents: a receipt that proves its usage
 * past the caps is an enforcement failure at the endpoint, one that fails the signature or the
 * echo is not a receipt from this contract at all.
 */
export type RemoteBudgetReceiptCheck =
  | {
      state: "verified";
      status: "ok" | "budget_exceeded";
      usage: RemoteBudgetUsage;
    }
  | { state: "overrun"; reason: string }
  | { state: "invalid"; reason: string };

/** The contract one supported endpoint runs under, as the wiring composed it. */
export type RemoteBudgetContract = Readonly<{
  caps: RemoteBudgetContractCaps;
  /**
   * Checks one receipt against THIS run's contract; see {@link RemoteBudgetReceiptCheck}.
   *
   * The run id is an argument rather than a closure because the contract is composed at BUILD
   * time (one Bot, one endpoint, one policy) while a run's identity only exists at RUN time —
   * and a receipt is only meaningful bound to the run it claims to be about.
   */
  verifyReceipt: (
    value: unknown,
    expected: { runId: string },
  ) => RemoteBudgetReceiptCheck;
}>;

/** What the resolver is asked about one Bot's endpoint. */
export type RemoteBudgetContractRequest = Readonly<{
  type: "remote_ag_ui" | "remote_mastra";
  endpoint: string;
  /** The deployment token this Bot's endpoint is dialled with, when it carries one. */
  agentToken: string | undefined;
}>;

/**
 * Which remote endpoints this deployment can actually bound (R3-02).
 *
 * A seam rather than a module read, exactly like the gate: the wiring owns the deployment's
 * policy (which endpoints it runs, what its token is, what the per-run token ceiling is), and
 * this module owns the dial it must accompany. Absent, or answering `undefined` for an endpoint,
 * means that endpoint is not supported — and the Bot is refused with the same
 * REMOTE_RUN_BUDGET_UNVERIFIED it would get with no gate at all.
 */
let remoteBudgetContractResolver:
  | ((request: RemoteBudgetContractRequest) => RemoteBudgetContract | undefined)
  | undefined;

export function setRemoteBudgetContractResolver(
  resolver:
    | ((
        request: RemoteBudgetContractRequest,
      ) => RemoteBudgetContract | undefined)
    | undefined,
) {
  remoteBudgetContractResolver = resolver;
}

/**
 * The protocol event the endpoint's receipt travels in, and the version both ends speak.
 *
 * CUSTOM is the protocol's own extension point — a `{ type: "CUSTOM", name, value }` event, any
 * JSON value — so the receipt needs no second channel and no framework-specific field. The
 * named constants live here because the wiring that signs and the middleware that checks are
 * on this side of the wire; the endpoint's own copy is `agent-langgraph/src/budget.ts`.
 */
export const REMOTE_BUDGET_RECEIPT_EVENT = "openbot-budget-receipt";
export const REMOTE_BUDGET_CONTRACT_VERSION = 1;

/** A receipt event, recognised by its protocol kind and its name. */
function isRemoteBudgetReceipt(event: BaseEvent): boolean {
  const candidate = event as { type?: unknown; name?: unknown };
  return (
    candidate.type === "CUSTOM" &&
    candidate.name === REMOTE_BUDGET_RECEIPT_EVENT
  );
}

/**
 * What one remote run's event stream actually showed (F5E1-F2, T10's honesty rules).
 *
 * Structural on purpose, on the `BuiltinModelSpanFact` precedent: `copilot.ts` must not
 * depend on the observability module a deployment may not have, so the fact carries the
 * observed events in the run-lifecycle's own vocabulary and the wiring adapts them into the
 * recorder. `http_first_frame` is recorded once, for the first event of any kind: on the
 * remote path that first event is the evidence the endpoint spoke at all.
 */
export type RemoteRunEventFact =
  | {
      type:
        | "http_first_frame"
        | "run_started"
        | "disconnected"
        | "success"
        | "error"
        | "interrupted"
        | "canceled";
    }
  | { type: "tool_proposed" | "tool_executed"; toolCallId: string };

/** One mediated remote run, reported once when its observation window closed. */
export type RemoteRunFact = {
  botId: string;
  threadId: string;
  runId: string;
  /**
   * One middleware execution is one attempt: the attempt is named by the server-issued
   * nonce the run's chain and budget admission share, never the wire runId, so two runs
   * reusing one run id settle against separate bindings (OCR delta T-J #2).
   */
  attemptId: string;
  /** The run's W3C chain, captured when the run started; null means nothing provable to join. */
  traceId: string | null;
  /** The trusted scope the threading minted for this run, when it minted one. */
  scope: unknown;
  /**
   * The derived dial span's coordinates and window (F9A), when the chain was derived: the
   * recorder materializes this span under the binding's trace, so the run's governed record
   * carries the dial the endpoint's chain continued from — the same-source contract, one
   * derivation shared by the dial, the binding and the materialized span.
   */
  dial: { spanId: string; startedAt: Date; endedAt: Date } | null;
  events: readonly RemoteRunEventFact[];
  endedAt: Date;
};

/**
 * The remote run's observation exit, wired at assembly exactly like the model-span observer:
 * absent means no basic record is kept — the dial still runs, the budget gate still governs,
 * and nothing about the product path changes.
 */
let remoteRunObserver: ((fact: RemoteRunFact) => void) | undefined;

export function setRemoteRunObserver(
  observer: ((fact: RemoteRunFact) => void) | undefined,
) {
  remoteRunObserver = observer;
}

/**
 * What the billing boundary (09.4) hands the audit trail, as data. `copilot.ts` knows the
 * facts and nothing about where rows go; `index.ts` wires this to the audit store, the same
 * injection shape as the meter and the gate.
 *
 * - `subscription_path_used`: a run built on the subscription harness — the marked path,
 *   billed by the subscription credential, visible so an auditor can account for work that
 *   no usage fact will ever name.
 * - `credit_refused`: a credit-admission refusal, with `fallback: "none"` carried as data —
 *   the boundary this module enforces, recorded so the trail shows the refusal was final
 *   and no subscription path was switched to behind it.
 */
export type ModelBillingAuditEvent =
  | {
      kind: "subscription_path_used";
      billing: "subscription";
      /** The harness provider the run's model rode ("claude" | "chatgpt"). */
      provider: string;
      botId: string | null;
      userId: string | null;
    }
  | {
      kind: "credit_refused";
      /** The admission sentinel's stable code ("credits_exhausted" and siblings). */
      code: string;
      modelId: string | null;
      botId: string | null;
      userId: string | null;
      /** Always "none": a refusal re-resolves nothing and switches to nothing. */
      fallback: "none";
    };

let modelBillingAudit: ((event: ModelBillingAuditEvent) => void) | undefined;

export function setModelBillingAudit(
  audit: ((event: ModelBillingAuditEvent) => void) | undefined,
) {
  modelBillingAudit = audit;
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
      "This model cannot be metered in its current form. Ask an administrator to configure a gateway base URL (the model gateway endpoint this deployment dials, or OPENAI_BASE_URL where no gateway is wired) or a plan model so billing admission can prove its bounds.",
    );
  }
}

/*
 * The capture-side bounds on one model span's payload (OCR R2-52/R2-53). The
 * recorder downstream still owns redaction (deny patterns) and its own byte
 * caps; these bounds exist so the CAPTURE itself can never pin an attachment or
 * a whole answer alive from `doStream` entry, through the billing check, to
 * settlement.
 */

/**
 * The prompt capture ceiling, in UTF-16 code units (OCR R2-52): a text-only
 * prompt is serialized per message, walk stopped at this ceiling, and the cut
 * declared in-band. Media-bearing prompts never serialize at all.
 */
const SPAN_INPUT_CAPTURE_CHARS = 64 * 1024;

/** The in-band declaration appended to a cut prompt capture (OCR R2-52). */
const SPAN_INPUT_TRUNCATION_MARK =
  "...[observation input truncated at capture]";

/**
 * The output capture ceiling (OCR R2-53): the 2000-character precedent the
 * failure path already applies to error messages, now applied where successful
 * output is accumulated and merged at settlement too.
 */
const SPAN_OUTPUT_CAPTURE_CHARS = 2_000;

/**
 * Bounded accumulation for one model-span output delta (OCR R2-53, R4-33): the
 * delta that crosses the capture ceiling is sliced to the REMAINING capacity —
 * the same discipline as `appendToolStepArg` — so a whole non-streamed
 * completion emitted as one text-delta is never retained past the ceiling until
 * settlement's join. Past the ceiling nothing is retained at all.
 */
function appendSpanOutputDelta(
  deltas: string[],
  length: number,
  delta: string,
): number {
  const capacity = SPAN_OUTPUT_CAPTURE_CHARS - length;
  if (capacity <= 0) return length;
  if (delta.length > capacity) {
    deltas.push(delta.slice(0, capacity));
    return SPAN_OUTPUT_CAPTURE_CHARS;
  }
  deltas.push(delta);
  return length + delta.length;
}

/** The accumulator seam for tests, on the `meteredModelForTests` precedent. */
export const appendSpanOutputDeltaForTests = appendSpanOutputDelta;

/**
 * Whether one prompt message is provably text-only (OCR R2-52). A string, or an
 * array whose every part is a plain `{ type: "text", text }` shape, is text;
 * anything else — image, file, tool part, an unknown shape — means the prompt
 * may carry inline attachment bytes, and the capture goes metrics-only rather
 * than serialize what it cannot prove is text. Conservative by design: the
 * denial is per-prompt, and a span's usage metrics never depend on it.
 */
function spanPromptIsTextOnly(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return content.every(
    (part) =>
      part !== null &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string",
  );
}

/**
 * One message serialized within a character budget: the text is sliced BEFORE
 * serialization, so no transient allocation ever exceeds what the capture keeps
 * (OCR R2-52 — the point is that a 43MB attachment's neighbor, a 40MB single
 * text message, never materializes as a string either). `cut.value` reports
 * whether anything was left behind.
 */
function spanMessagePiece(
  message: unknown,
  remaining: number,
  cut: { value: boolean },
): string {
  const source = message as { role?: unknown; content?: unknown };
  if (typeof source.content === "string") {
    const kept = source.content.slice(0, remaining);
    if (kept.length < source.content.length) cut.value = true;
    return JSON.stringify({ role: source.role, content: kept });
  }
  let budget = remaining;
  const parts = (source.content as unknown[]).map((part) => {
    const text = (part as { text?: unknown })?.text;
    if (typeof text !== "string" || budget <= 0)
      return { type: "text", text: "" };
    const kept = text.slice(0, budget);
    budget -= kept.length;
    if (kept.length < text.length) cut.value = true;
    return { type: "text", text: kept };
  });
  return JSON.stringify({ role: source.role, content: parts });
}

/**
 * The capture-side view of one call's prompt (OCR R2-52): `null` for any prompt
 * that is not provably text-only (metrics-only — attachment bytes never enter
 * this module), and a per-message serialization cut at
 * `SPAN_INPUT_CAPTURE_CHARS` with an in-band truncation mark otherwise. The
 * reconstruction is bounded per message, so the walk's allocations stay within
 * the capture ceiling no matter how large the prompt is.
 */
function spanInputOf(params: unknown): string | null {
  const prompt = (params as { prompt?: unknown })?.prompt;
  if (!Array.isArray(prompt)) {
    /*
     * Outside the message-array shape the only provably-text prompt is a bare
     * string: sliced BEFORE serialization (OCR R2-52's own rule — the fallback
     * used to stringify the whole prompt first, so a 40MB custom-provider
     * prompt materialized whole in a transient allocation the capture never
     * kept), then ceiling-checked against quoting overhead. Anything else —
     * an object, a number, an absent prompt — cannot be proven text-only, so
     * it is metrics-only null: this module never serializes what it cannot
     * bound first, exactly like every media-carrying message-array shape.
     */
    if (typeof prompt !== "string") return null;
    let body = JSON.stringify(prompt.slice(0, SPAN_INPUT_CAPTURE_CHARS));
    const cut =
      prompt.length > SPAN_INPUT_CAPTURE_CHARS ||
      body.length > SPAN_INPUT_CAPTURE_CHARS;
    if (body.length > SPAN_INPUT_CAPTURE_CHARS) {
      // Escaping overhead can push the serialized kept text past the ceiling;
      // the capture bound wins, and the mark declares the cut.
      body = body.slice(0, SPAN_INPUT_CAPTURE_CHARS);
    }
    return cut ? body + SPAN_INPUT_TRUNCATION_MARK : body;
  }
  const pieces: string[] = [];
  let length = 0;
  const cut = { value: false };
  for (const message of prompt) {
    if (!spanPromptIsTextOnly(message)) return null;
    const remaining = SPAN_INPUT_CAPTURE_CHARS - length;
    if (remaining <= 0) {
      cut.value = true;
      break;
    }
    const piece = spanMessagePiece(message, remaining, cut);
    pieces.push(piece);
    length += piece.length;
  }
  let body = `[${pieces.join(",")}]`;
  if (body.length > SPAN_INPUT_CAPTURE_CHARS) {
    // JSON quoting and escaping overhead can push a piece past its character
    // budget; the ceiling is enforced on the assembled capture, so the tail is
    // cut here and the mark declares it.
    body = body.slice(0, SPAN_INPUT_CAPTURE_CHARS);
    cut.value = true;
  }
  return cut.value ? body + SPAN_INPUT_TRUNCATION_MARK : body;
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
 *
 * TWO REASONS TO WRAP, ONE WRAPPER (F5E1-F1). The billing seam is one of them; the observation
 * bypass below is the other, and it is not billing's business: a deployment may enable Opik and
 * run no billing at all, and that legal stock shape used to produce zero observation facts for
 * every successful run because the model was handed back untouched. `observationOnly` says which
 * reason built this wrapper — no gate is consulted, no meter is called and no settlement is
 * decided, because there is none to decide: the wrapper records the call and must never change
 * what the person receives. The billing path is unchanged, branch for branch.
 */
function meteredModel<T>(
  model: T,
  attribution?: { userId: string | null; botId: string | null },
  options?: { observationOnly?: boolean },
): T {
  const observationOnly = options?.observationOnly === true;
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
      /*
       * F5E1-F1: an observation-only wrapper has no admission to consult. The MODE decides,
       * never the current presence of a gate — a gate wired after this build must not turn a
       * recording wrapper into an admitting one. `gate` is the only gate read below.
       */
      const gate = observationOnly ? undefined : modelUsageGate;
      /*
       * The meter is billing's sink exactly as the gate is: an observation-only wrapper must
       * never hand a usage fact to it, even if one is wired later in the same process.
       */
      const meter = observationOnly ? undefined : usageMeter;
      let spanInput: string | null = null;
      /*
       * OCR R5-47: the observation side's own "verdict on record" flag, set
       * INSIDE `reportSpan` the moment a span is actually emitted — never
       * borrowed from `settled`, which the settlement paths claim BEFORE their
       * awaitable work. settleFinish sets `settled`, then awaits
       * `lifecycle.finish`; when that await rejects, the settlement-failure
       * exit used to read the borrowed flag as "already reported" and the call
       * produced ZERO spans (the pre-V5 single settlement_failed span was
       * swallowed). First report wins: a second reportSpan call is the
       * contradiction the R4-32 guard exists to prevent, and the flag now
       * tells the truth about which one happened.
       */
      let spanReported = false;
      // Captured at entry, inside the request's context (the tool-step cell's own
      // discipline): by stream teardown the ambient context is not guaranteed.
      const spanTrace =
        spanObserver !== undefined ? (currentTraceContext() ?? null) : null;
      // Captured at entry for the same reason as the trace (OCR R2-58): the
      // settlement that reports this fact can land after teardown, where the
      // ambient scope is no longer guaranteed to exist — so the fact carries
      // what its entry saw, and the adapter reads the carried value.
      const spanScope =
        spanObserver !== undefined ? currentRunObservationScope() : undefined;
      /*
       * Output deltas accumulate into an array joined once at report time — linear,
       * where repeated string concatenation would re-copy on every delta (T14 review
       * minor b) — and the accumulation itself stops at the capture ceiling (OCR
       * R2-53): deltas past it are counted by the provider, not retained by us.
       */
      const spanOutputDeltas: string[] = [];
      let spanOutputLength = 0;
      if (spanObserver !== undefined) {
        spanInput = spanInputOf(params);
      }
      const reportSpan = (ending: BuiltinModelSpanFact["ending"]) => {
        if (spanObserver === undefined || spanReported) return;
        spanReported = true;
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
            output:
              spanOutputDeltas.length === 0
                ? null
                : spanOutputDeltas.join("").slice(0, SPAN_OUTPUT_CAPTURE_CHARS),
            scope: spanScope,
            trace: spanTrace,
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
      if (gate) {
        try {
          lifecycle = await gate({
            eventId,
            occurredAt,
            modelId: typeof inner.modelId === "string" ? inner.modelId : null,
            client: currentUsageOrigin(),
            attribution: {
              userId: attribution?.userId ?? null,
              botId: attribution?.botId ?? null,
            },
          });
        } catch (error) {
          if (
            error instanceof CreditGateError ||
            error instanceof CreditInsufficientError ||
            error instanceof CreditPolicyUnconfiguredError ||
            error instanceof ModelNotPricedError ||
            error instanceof CreditGateFailureError
          ) {
            // The refusal is the boundary (09.4): recorded with `fallback: "none"` as data
            // before it propagates, so the trail shows the admission answer was final and
            // no subscription harness or other path was switched to behind it.
            modelBillingAudit?.({
              kind: "credit_refused",
              code: error.code,
              modelId: typeof inner.modelId === "string" ? inner.modelId : null,
              botId: attribution?.botId ?? null,
              userId: attribution?.userId ?? null,
              fallback: "none",
            });
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
      if (gate) {
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
        const requested = (params as { maxOutputTokens?: unknown })
          .maxOutputTokens;
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
          await meter?.({
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
          // forwarded untouched below; this only remembers what already flowed past,
          // up to the capture ceiling (OCR R2-53, R4-33) — the delta that crosses
          // it is cut to the remaining capacity, and past it nothing is retained.
          if (
            spanObserver !== undefined &&
            part?.type === "text-delta" &&
            typeof (part as { delta?: unknown }).delta === "string"
          ) {
            spanOutputLength = appendSpanOutputDelta(
              spanOutputDeltas,
              spanOutputLength,
              (part as { delta: string }).delta,
            );
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
            /*
             * Captured BEFORE claiming the flag (OCR R4-32): a settlement path
             * that already reported this call's terminal fact — settleFinish or
             * settleFail, both of which report through `reportSpan` — must not be
             * contradicted by a second span from here. The readout is the span
             * flag itself (OCR R5-47), not `settled`: settleFinish claims
             * `settled` before awaiting a finish that can REJECT, and a rejected
             * finish has reported nothing — this exit is the only span that call
             * will ever have. The teardown below still runs in every case: a pull
             * that cannot settle must still tear the upstream down and error the
             * stream.
             */
            const alreadyReported = spanReported;
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
            // An already-settled call has its verdict on record (R4-32): this exit
            // adds only the teardown, never a second, contradicting report.
            if (!alreadyReported) {
              reportSpan({ kind: "settlement_failed", code: error.code });
            }
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
                ...(reportedInput !== undefined && {
                  inputTokens: reportedInput,
                }),
                ...(reportedOutput !== undefined && {
                  outputTokens: reportedOutput,
                }),
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
              /*
               * F5E1-F1: with no settlement there is nothing to fail. An observation-only
               * wrapper RECORDS the call, so a malformed usage report is the honest unknown
               * ending and the part still reaches the person — observation must never take
               * the product path down on its own account. The billing path's settlement
               * failure below is unchanged.
               */
              if (observationOnly) {
                log.warn(
                  {
                    type: "observation-usage-invalid",
                    eventId,
                    inputTokens: billedInput,
                    outputTokens: billedOutput,
                  },
                  "observation-usage-invalid",
                );
                await settleFail("usage_missing", {
                  inputTokens: billedInput,
                  outputTokens: billedOutput,
                });
              } else {
                await failSettlement(
                  "billing-model-usage-invalid",
                  new ModelUsageSettlementError("usage_invalid"),
                  { inputTokens: billedInput, outputTokens: billedOutput },
                );
                return;
              }
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
 * Which engine executes a governed built-in Bot's run (ME02, #474).
 *
 * A server-side seam, exactly like the meter and the gateway transport: the
 * composition (or a test assembly) installs a selector, and absent one every
 * Bot keeps the legacy built-in engine. The selector is consulted only inside
 * a governed admission — the Mastra path exists only where the Runner has
 * admitted the run, minted the governed model collaborator and bound its
 * identity, so no client field can choose it and no provider-keyed build can
 * reach it. ME16 (#488): the only value a selector can return is "mastra" —
 * the legacy engine is not something a selector selects, it is what runs when
 * no selector (or no governed admission) exists, so the unreachable "legacy"
 * member the seam was drafted with is gone.
 */
export type BuiltinExecutionEngine = "mastra";

let builtinExecutionEngineFor:
  | ((input: { botId: string; governed: boolean }) => BuiltinExecutionEngine)
  | undefined;

/**
 * Install (or clear) the server-side engine selector. Pass `undefined` to
 * restore the default: every Bot on the legacy engine.
 */
export function setBuiltinExecutionEngine(
  selector:
    | ((input: { botId: string; governed: boolean }) => BuiltinExecutionEngine)
    | undefined,
): void {
  builtinExecutionEngineFor = selector;
}

/**
 * The server-side conversation runtime the Mastra engine path runs against
 * (ME03 #475): `loadExecutionInput` rebuilds the model context from the
 * server's persisted, principal-authorized history, and
 * `persistExecutionMessages` records the engine's answer through the
 * ConversationService single-writer seam.
 *
 * A composition seam exactly like {@link setBuiltinExecutionEngine}: the
 * server assembly installs the production runtime; a test assembly may
 * install one over its own storage. Unlike the selector this is NOT optional
 * on the engine path — a Mastra-selected run without a wired runtime refuses
 * (`MASTRA_CONVERSATION_RUNTIME_UNWIRED`) instead of silently running on the
 * browser's echoed history: the spec's authority for a turn's history is the
 * server store, never the client.
 */
let mastraConversationRuntime: MastraConversationRuntime | undefined;

export function setMastraConversationRuntime(
  runtime: MastraConversationRuntime | undefined,
): void {
  mastraConversationRuntime = runtime;
}

/**
 * ME05 (#477): the durable-continuation install the Mastra engine path runs
 * with — tenant engine storage for suspension snapshots, the durable tool
 * names, the save-before-waiting hook and the accurate-resume entry. The same
 * composition-seam shape as the conversation runtime: the server assembly
 * installs the production install; a test assembly installs its own. UNWIRED
 * the engine behaves exactly as before ME05 (a suspension stays in-process
 * and terminal-less) — never half-wired.
 */
let mastraContinuations: MastraContinuationInstall | undefined;

export function setMastraContinuations(
  install: MastraContinuationInstall | undefined,
): void {
  mastraContinuations = install;
}

/**
 * ME07 (#479): the personal-memory loader the Mastra engine path composes its
 * context block from. The server assembly installs the ONE #395 consumer —
 * `createPersonalMemoryContext` over the production seams — wrapped so the
 * engine path receives only the RENDERED block (`renderPersonalMemoryContext`
 * already carries the untrusted-data discipline; this path never re-authors
 * it). Asked once per run, inside the factory, with the server-issued
 * admission facts (the trusted `PlatformScope` and the Bot id) — never a wire
 * field. UNWIRED the engine runs without a memory block, exactly like a
 * person with nothing confirmed: no block is assembled by any other means.
 *
 * A throw is a real failure of the read and fails the run before any model
 * call — the same discipline the legacy engine's `PersonalMemoryMiddleware`
 * set (its load error errored the run). The gates themselves (review,
 * tombstones, temporal validity, live authorizations, the pause switches, the
 * restore gate) stay inside the #395 seams; this path only relays the answer.
 */
export type MastraPersonalMemoryLoader = (
  scope: PlatformScope,
  botId: string,
) => Promise<string>;

let mastraPersonalMemoryContext: MastraPersonalMemoryLoader | undefined;

export function setMastraPersonalMemoryContext(
  loader: MastraPersonalMemoryLoader | undefined,
): void {
  mastraPersonalMemoryContext = loader;
}

/**
 * #729 the memory-service loader (the #730 client over the single memory
 * authority) and its degradation rules. Installed, it REPLACES the legacy
 * #395 seam above — the old store is never read, not even as a fallback when
 * the service is down. Uninstalled, the legacy seam keeps its behaviour.
 */
export type MastraMemoryContextLoader = (
  scope: PlatformScope,
  botId: string,
) => Promise<{ content: string; result: RecallResult }>;

let mastraMemoryContext: MastraMemoryContextLoader | undefined;

export function setMastraMemoryContext(
  loader: MastraMemoryContextLoader | undefined,
): void {
  mastraMemoryContext = loader;
}

/**
 * ME05 fix-round-1: the ONE named entry the approvals HTTP route consumes to
 * apply an authenticated decision to a durable continuation. The
 * approvals-integration slice calls exactly this function from its handler;
 * the routes themselves are untouched by the ME05 slice. Everything
 * server-owned (the store, the production resume driver, the six gates, the
 * CAS claim, the receipt ordering) flows from the installed
 * {@link MastraContinuationInstall} — the caller supplies only the
 * authenticated scope and decision.
 *
 * Unwired (no `setMastraContinuations` install) it refuses with a named
 * composition error instead of silently dropping the decision: a durable
 * approval must never read as "nothing to resume" merely because the
 * assembly did not run.
 */
export async function resumeFromApprovalDecision(input: {
  scope: PlatformScope;
  continuationId: string;
  revision: number;
  decision: ResumeDecision;
}): Promise<MastraContinuationResumeResult> {
  const install = mastraContinuations;
  if (!install) {
    throw new MastraContinuationRefusal(
      "MASTRA_CONTINUATIONS_UNWIRED",
      "MASTRA_CONTINUATIONS_UNWIRED: no durable-continuation install is wired; the approval decision cannot be applied.",
    );
  }
  return install.resume({
    scope: input.scope,
    ref: {
      continuationId: input.continuationId,
      revision: input.revision,
    },
    decision: input.decision,
  });
}

/**
 * FIX-W14 (FR3-1, #387): bind the answer's actual basis to the answer itself.
 *
 * The run's prompt carried the #395 block — the {id, kind} pointers of every memory and
 * judgment this run's answers may draw on — and this wrapper carries that same pointer set
 * out again on the run's assistant text messages, through the AG-UI event metadata the
 * client already reconstructs messages from. Server-composed only: the pointers come from
 * the block the loader rendered for THIS run's admitted scope, never from a client field,
 * and the client cannot widen, narrow or forge the set — the expansion re-verifies current
 * authorization anyway, and an id the person can no longer see answers unavailable there.
 *
 * Every assistant text message of the run carries the same set (one block per run, one read
 * of the authority), so live view and event-store replay agree on what an answer used. Since
 * FIX-OCR3 (O3-H1) the stamp also survives the store: the produced-message fold keeps the
 * START frame's metadata, the stored envelope carries the pointers, and a rebuilt history
 * (refresh included) re-attaches them — the person's basis rows no longer vanish on reload.
 *
 * SCOPE (O3-M7, disclosed): the wrap covers the FIRST-EXECUTION stream alone. A run that
 * pauses on a durable continuation and resumes goes through the resume driver's own event
 * drain, which never passes through this wrapper — its final answer carries no basis stamp,
 * on the live stream or in the store. The resume path would need the run's pointer set
 * persisted with the continuation and re-stamped at the drain's event exit; that seam is not
 * wired, and this comment says so rather than letting "replay agrees" be read wider than it
 * holds.
 *
 * An absent or empty basis wraps nothing: an answer with no memory behind it shows no basis.
 */
function withAnswerMemoryBasis(
  basis: readonly PersonalMemoryBasisPointer[] | undefined,
  execute: ExecuteMastra,
): ExecuteMastra {
  if (basis === undefined || basis.length === 0) return execute;
  return (request) =>
    execute(request).pipe(
      map((event) =>
        event.type === EventType.TEXT_MESSAGE_START &&
        (event.role === undefined || event.role === "assistant")
          ? {
              ...event,
              metadata: {
                ...event.metadata,
                openbot: { personalMemoryBasis: basis },
              },
            }
          : event,
      ),
    );
}

/**
 * Wrap one governed execution so its produced messages are PERSISTED before
 * the success terminal is forwarded.
 *
 * The runner settles completion when RUN_FINISHED reaches it, so holding that
 * terminal back until `persistExecutionMessages` resolved puts the answer in
 * the conversation store BEFORE settle-complete semantics can run: a refresh
 * or a pagination read shows the answer even before the completion is
 * published, and a persistence failure fails the run instead of completing a
 * turn whose answer the store would never show. The governed/settlement
 * contract itself is untouched — the runner's owner-complete rules still gate
 * completion exactly as before.
 */
function withPersistedOutput(
  execute: ExecuteMastra,
  runtime: MastraConversationRuntime,
  binding: ExecutionBinding,
): ExecuteMastra {
  return (request) =>
    new Observable<BaseEvent>((subscriber) => {
      const collector = createProducedMessageCollector();
      let terminal: BaseEvent | undefined;
      let tornDown = false;
      const subscription = execute(request).subscribe({
        next: (event) => {
          if (tornDown || terminal !== undefined) return;
          if (event.type === "RUN_FINISHED") {
            terminal = event;
            return;
          }
          collector.push(event);
          subscriber.next(event);
        },
        error: (cause) => {
          if (!tornDown) subscriber.error(cause);
        },
        complete: () => {
          if (tornDown) return;
          if (terminal === undefined) {
            // Terminal-less suspension: no success to persist behind.
            subscriber.complete();
            return;
          }
          runtime.persistExecutionMessages(binding, collector.snapshot()).then(
            () => {
              if (tornDown) return;
              subscriber.next(terminal);
              subscriber.complete();
            },
            (cause) => {
              if (!tornDown) subscriber.error(cause);
            },
          );
        },
      });
      return () => {
        tornDown = true;
        subscription.unsubscribe();
      };
    });
}

/**
 * The built-in configuration for a Bot the server selected onto the Mastra
 * engine (ME02).
 *
 * A factory config, so BuiltInAgent still owns the lifecycle while the
 * factory yields the Mastra execution's canonical events directly. The
 * binding is resolved at FACTORY time — after the governed Runner bound the
 * run identities — and fails closed before that. The trusted prompt parts
 * are the same composition the classic governed path builds; the execution
 * composes them server-side and never lets client context or forwardedProps
 * near them.
 *
 * ME04 (#476) wired the granted connector tools onto this path: the execution
 * request carries the Bot's held tools and the trusted prompt composes the
 * same held-tool/connected-vendor guidance the legacy prompt does. ME06 (#478)
 * wired the computer guidance and the browser participation tools; ME08 (#480)
 * wired the learned skills — the outer run's ALREADY-VALIDATED invocation
 * (acquired once per run by the same middleware the legacy engine uses) rides
 * the execution request through the ME04 controlled wrapper, and its catalog
 * composes into the trusted prompt at the legacy position. The execution
 * composes every trusted part server-side and never lets client context or
 * forwardedProps near them.
 *
 * ME03 (#475) wired the conversation contract onto this path: the run input
 * is rebuilt server-side by `loadExecutionInput` (the client-supplied history
 * never reaches the model) and the produced messages are persisted through
 * `persistExecutionMessages` before the success terminal reaches the runner.
 * ME07 (#479) wired the personal-memory context onto this path: the installed
 * #395 loader is asked once per run with the admitted scope and Bot, and the
 * rendered block composes into the trusted prompt at the legacy injection
 * position — the head of the message list the legacy engine used, which is
 * after every prompt part here. No bank ids or selectable scopes cross this
 * boundary; the block is server-composed only.
 */
function mastraAgentConfiguration(input: {
  agent: RegisteredBuiltInAgent;
  governedModel: GovernedModelRequest;
  standing: string | null;
  tools: GrantedTool[];
  learnedSkills?: LearnedSkillInvocation;
  computerGuidance?: string;
  /** Vendors this deployment connects to, held or not: prompt honesty. */
  connectedVendors: readonly string[];
}): BuiltInAgentConfiguration {
  const {
    agent,
    governedModel,
    standing,
    tools,
    learnedSkills,
    computerGuidance,
    connectedVendors,
  } = input;
  // ME04 wired the granted connector tools, ME06 wired the computer
  // guidance + the browser participation tools, and ME08 wired the learned
  // skills (below): every surface a built-in Bot holds is wired onto this
  // engine, so nothing fail-closed remains on the configuration path.
  // ME08: the held-tool guidance keeps the legacy composition; the learned
  // catalog rides the SAME tail in the legacy position — right AFTER the
  // computer paragraph, exactly where the legacy built-in prompt places it
  // (copilot.ts legacy branches). Never re-authored, never re-ordered.
  const grantedGuidanceText = grantedToolGuidance(tools, connectedVendors);
  const instructionParts = [
    agent.systemPrompt,
    ...(standing ? [standing] : []),
  ];
  return {
    type: "custom",
    factory: (factoryContext) => {
      const abortSignal = factoryContext.abortSignal;
      // Fail-closed guards (unbound execution binding, unwired conversation
      // runtime) live inside the generator so an unwired surface fails as a
      // structured RUN_ERROR at iteration time, never as a synchronous
      // throw out of the factory.
      return (async function* () {
        const facts = governedModel.executionBinding?.();
        if (!facts) throw new Error("EXECUTION_BINDING_UNBOUND");
        // ME07: the person's confirmed, currently-authorized memory — the
        // #395 single authority, asked with the server-issued admission facts
        // and rendered by the consumer module itself. Asked BEFORE anything
        // runs (the legacy middleware loaded memory before the agent too), so
        // a failed read fails the run instead of assembling an improvising
        // prompt. Unwired, no block is built at all.
        // #729: installed, the memory service owns the block and its failure
        // semantics — a plain conversation continues on an honest "no memory
        // used" notice, while a run whose tools are memory tools pauses
        // instead of improvising without memory.
        const memoryOutcome: MemoryContextBlock | undefined = mastraMemoryContext
          ? memoryContextBlock(await mastraMemoryContext(facts.scope, facts.botId), {
              required: tools.some(
                (tool) =>
                  tool.name === "recall_personal_memory" ||
                  tool.name === "forget_personal_memory",
              ),
            })
          : undefined;
        if (memoryOutcome?.blocked) throw new Error("MEMORY_UNAVAILABLE");
        const personalMemoryBlock =
          mastraMemoryContext !== undefined
            ? memoryOutcome?.block
            : mastraPersonalMemoryContext
              ? await mastraPersonalMemoryContext(facts.scope, facts.botId)
              : undefined;
        // FIX-W14 (FR3-1): the same block's own {id, kind} pointers, read back
        // out by the module that rendered it — the id set this run's answers
        // carry to the person (see withAnswerMemoryBasis). One authority read,
        // zero second reads: what the model saw is what the answer cites.
        //
        // #729 review: only the legacy #395 block is written in that format. A
        // memory-service block has no `kind` (MemoryView carries none) and its
        // ids are not #387 evidence ids, so this seam stamps NO basis rather
        // than a half-parse — an answer with no basis claims nothing, which is
        // the honest direction. Giving service memories a basis is #733's
        // decision (it needs a kind vocabulary and an evidence seam for them).
        const personalMemoryBasis =
          mastraMemoryContext === undefined && personalMemoryBlock
            ? parsePersonalMemoryBasis(personalMemoryBlock)
            : undefined;
        // ME03 production wiring: the engine path runs on the server-rebuilt
        // authorized history and persists its output through the conversation
        // runtime. Without one the run refuses rather than executing on the
        // browser's echoed transcript.
        const runtime = mastraConversationRuntime;
        if (!runtime) throw new Error("MASTRA_CONVERSATION_RUNTIME_UNWIRED");
        // The model context is the server's persisted history — the client's
        // system/tool/user echo is consumed only for the submitted-message
        // key and then dropped. A thread that does not resolve to this
        // principal (or history that fails verification) fails the turn.
        const rebuilt = await runtime.loadExecutionInput(
          facts.scope,
          factoryContext.input,
        );
        const binding: ExecutionBinding = {
          ...facts,
          // The wire threadId is authoritative only after the rebuild proved
          // it resolves to this principal's mastra conversation; persistence
          // refuses a binding without one.
          threadId: rebuilt.threadId,
        };
        // ME05: when the continuation install is wired, EVERY execution runs
        // with its durable context — tenant engine storage, the durable tool
        // names and the save-before-waiting hook — merged server-side into
        // the execution request. Unwired, the execute path is untouched.
        const install = mastraContinuations;
        const execute: ExecuteMastra = install
          ? (request) =>
              executeGovernedMastra({
                ...request,
                continuations: {
                  storage: install.storageFor(request.binding),
                  durableToolNames: install.durableToolNames,
                  onSuspension: (suspension) =>
                    install
                      .saveSuspension(request.binding, suspension)
                      .then(() => undefined),
                },
              })
          : executeGovernedMastra;
        // ME06: the run's client-declared participation tools (the browser's
        // `useFrontendTool` registrations, relayed on every run input) mount
        // as INERT bridges — the model's call suspends the engine for real
        // client participation; the server never executes them. The granted
        // connector tools keep winning any name collision (the mount drops a
        // bridged declaration that would shadow one).
        const frontendTools: FrontendToolDefinition[] = (
          rebuilt.tools ?? []
        ).flatMap((tool) =>
          typeof tool?.name === "string"
            ? [
                {
                  name: tool.name,
                  description:
                    typeof tool.description === "string"
                      ? tool.description
                      : "",
                  ...(tool.parameters !== undefined
                    ? { parameters: tool.parameters }
                    : {}),
                },
              ]
            : [],
        );
        const executionAgent = createMastraAgUiAgent(
          // FIX-W14 (FR3-1): the basis stamp rides INNERMOST, so persistence,
          // the runner's event store and the live relay all see the stamped
          // stream — the answer and its basis cannot disagree downstream.
          withPersistedOutput(
            withAnswerMemoryBasis(personalMemoryBasis, execute),
            runtime,
            binding,
          ),
          binding,
          {
            instructions: instructionParts,
            trailingInstructions: [
              ...(grantedGuidanceText ? [grantedGuidanceText] : []),
              ...(computerGuidance ? [computerGuidance] : []),
              ...(learnedSkills?.catalog ? [learnedSkills.catalog] : []),
            ],
            // ME04: the granted connector tools ride the execution request;
            // the controlled wrapper (mastra/tools.ts) mounts them per call
            // with this run's abort signal as the stop wire.
            // ME08: the outer run's validated learned-skill invocation rides
            // the SAME request — mounted through the SAME controlled wrapper
            // shape under its original reserved names, executing through the
            // SDK's own verified snapshot (never re-implemented here).
            tools,
            ...(learnedSkills ? { learnedSkills } : {}),
            ...(frontendTools.length > 0 ? { frontendTools } : {}),
            // ME07: the rendered personal-memory block, composed by the
            // execution at the legacy injection position (after every prompt
            // part, before the conversation). Server-assembled only.
            ...(personalMemoryBlock
              ? { personalMemoryContext: personalMemoryBlock }
              : {}),
            governedModel,
          },
        );
        yield* observableToAsyncIterable(
          executionAgent.run(rebuilt),
          abortSignal,
        );
      })();
    },
  };
}

/**
 * Wrap the model instance when this deployment has something to attach to it — billing's meter
 * or gate, or the observation bypass — and the model is an instance (the string form is resolved
 * by the runtime itself, where this file cannot reach). The build's attribution rides along, so
 * the gate's usage fact names the Bot that ran it and who for.
 */
function withUsageMeter<T>(
  model: T,
  attribution?: { userId: string | null; botId: string | null },
): T {
  /*
   * F5E1-F1: the observation bypass is a reason to wrap IN ITS OWN RIGHT. Billing is optional
   * and its absence is a legal deployment; an enabled observer is what a deployment without
   * billing actually asked for, and it used to ride the billing wrapper — so "Opik on, billing
   * off" ran every Bot unwrapped and the registered observer was never called, with no failure
   * count anywhere saying so. The two reasons stay independent: either one being wired installs
   * the wrapper, and only the billing one admits, meters or settles.
   */
  const billingWired = usageMeter !== undefined || modelUsageGate !== undefined;
  if (!billingWired && builtinModelSpanObserver === undefined) return model;
  const candidate = model as
    | (Record<string, unknown> & { doStream?: unknown })
    | string;
  if (
    typeof candidate === "string" ||
    typeof candidate.doStream !== "function"
  ) {
    return model;
  }
  return meteredModel(model, attribution, {
    observationOnly: !billingWired,
  });
}

/*
 * F5E1-F1's visible half: a run build whose model wiring cannot carry the observation wrapper
 * is COUNTED per reason and said out loud — a deployment that cannot observe says so instead of
 * looking healthy. Two shapes remain, both structural:
 *
 * - `string_model`: the runtime resolves "provider/model" strings itself (the legacy dial,
 *   reached when no gateway transport is wired), so this file never holds the instance the
 *   wrapper would have to hand back.
 * - `plan_model`: the subscription harness's model is a CLASS instance; the wrapper's `{...inner}`
 *   copy drops prototype methods (`doGenerate`), so the plan path is left exactly as built
 *   rather than half-wrapped.
 *
 * The map is process-local on purpose: an operator reads the warn lines, and each one carries
 * the running count for its reason. Nothing on the product path reads it.
 */
const unobservableRunShapes = new Map<string, number>();

function reportUnobservableRunShape(
  reason: "string_model" | "plan_model",
  botId: string,
) {
  const count = (unobservableRunShapes.get(reason) ?? 0) + 1;
  unobservableRunShapes.set(reason, count);
  log.warn(
    { type: "builtin-observation-unavailable", reason, botId, count },
    "builtin-observation-unavailable",
  );
}

/** Test-only read of that counter, on the `meteredModelForTests` precedent. */
export const builtinObservationGapForTests = {
  counts: (): ReadonlyMap<string, number> => new Map(unobservableRunShapes),
  reset: () => unobservableRunShapes.clear(),
};

/** Test-only surface for the wrapper's own decision (F5E1-F1). */
export const withUsageMeterForTests = withUsageMeter;

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
  /**
   * Who this build's runs are for, so the consumption fact names the initiator (09.1). The Bot
   * half is the agent's own id; this carries the person. Absent when the resolver had no actor —
   * the fact then names a null, never a guess.
   */
  attribution?: { userId: string | null },
  /**
   * The resolved gateway dial for this build (09.1), when the deployment wired the workbench's
   * gateway transport: the model instance the Bot runs on is built from it, for both providers.
   * Null means the transport refused the model — the run fails closed. Undefined means no
   * transport is wired, and the legacy dial below decides.
   */
  gatewayModel?: WorkbenchGatewayModelDial | null,
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
    if (
      builtinExecutionEngineFor?.({ botId: agent.id, governed: true }) ===
      "mastra"
    ) {
      return mastraAgentConfiguration({
        agent,
        governedModel,
        standing,
        tools,
        learnedSkills,
        computerGuidance,
        connectedVendors,
      });
    }
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
                observeBuiltinToolExecution(
                  tool.name,
                  execution?.toolCallId,
                  () =>
                    executeNativeApprovalTool(
                      tool.name,
                      args,
                      execution?.toolCallId,
                      tools.find((granted) => granted.name === tool.name)
                        ?.initiator,
                      () => tool.execute(args),
                    ),
                ),
            })),
            maxSteps: TOOL_STEPS,
          }
        : {}),
    };
  }

  /*
   * The model this Bot runs on, in order of authority: the plan model (the subscription harness's
   * own dial), then the gateway transport (09.1 — the one surface a gateway deployment's ordinary
   * calls take, both providers, streaming and not), then the legacy dial. The order is CREDENTIAL
   * PRESENCE, never balance: which path runs was fixed at build time by which credentials the
   * deployment carries, and a credit refusal below never re-reads this choice (09.4) — there is
   * no balance at which the plan model becomes reachable, and no refusal that falls through to it.
   *
   * A wired transport that answered null refuses the RUN here — the same fail-closed shape
   * the unprovable string-form wiring raises, and for the same reason: there is no provider-direct
   * branch to fall back to.
   */
  const dial = gatewayModel;
  if (dial === null && planModel === undefined) {
    return {
      type: "custom",
      // biome-ignore lint/correctness/useYield: this agent must fail when iteration starts.
      factory: async function* () {
        throw new UnmeterableModelError();
      },
    };
  }
  // A refused dial (null) never reaches the transport branch: a plan model bypasses the
  // transport entirely, and every other run was refused above.
  const transportDial: WorkbenchGatewayModelDial | undefined =
    dial ?? undefined;
  const resolvedModel =
    planModel ??
    (transportDial !== undefined
      ? createOpenAI({
          apiKey: transportDial.apiKey ?? undefined,
          baseURL: transportDial.baseURL,
        }).chat(model.defaultModel)
      : legacyRuntimeModel(model, apiKey));
  if (modelUsageGate !== undefined && typeof resolvedModel === "string") {
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
  /*
   * F5E1-F1: a string-form model with no admission to prove still runs — there is nothing to
   * refuse — but the observation wrapper cannot reach what the runtime resolves internally, so
   * this build is COUNTED and warned instead of quietly observing nothing.
   */
  if (
    modelUsageGate === undefined &&
    builtinModelSpanObserver !== undefined &&
    typeof resolvedModel === "string"
  ) {
    reportUnobservableRunShape("string_model", agent.id);
  }

  if (planModel) {
    // The marked path, per run (09.4): this run is billed by the subscription credential, so
    // the trail names it here — no usage fact will ever carry it, because nothing below
    // reserves, meters or settles credits for this call.
    modelBillingAudit?.({
      kind: "subscription_path_used",
      billing: "subscription",
      // The harness word the plan config resolved ("claude" | "chatgpt"): the instance's
      // `provider` is the namespaced transport id, not the plan.
      provider: planModel.modelId,
      botId: agent.id,
      userId: attribution?.userId ?? null,
    });
    /*
     * F5E1-F1: the plan path's model is handed over unwrapped (a class instance would lose its
     * prototype methods in the wrapper's copy), so an observation-enabled deployment running on
     * a subscription harness is COUNTED and warned, never left looking observed.
     */
    if (builtinModelSpanObserver !== undefined) {
      reportUnobservableRunShape("plan_model", agent.id);
    }
  }

  return {
    model: planModel
      ? // The subscription harness path (09.4): billed by the subscription credential, so it
        // never enters credit admission — no gate read, no meter write, no outbox fact that
        // would dress subscription work up as Bifrost credit consumption. The plan model is
        // handed to the runtime exactly as built; the boundary is the absence of a wrapper.
        resolvedModel
      : withUsageMeter(resolvedModel, {
          userId: attribution?.userId ?? null,
          botId: agent.id,
        }),
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
              observeBuiltinToolExecution(
                tool.name,
                execution?.toolCallId,
                () =>
                  executeNativeApprovalTool(
                    tool.name,
                    args,
                    execution?.toolCallId,
                    tools.find((granted) => granted.name === tool.name)
                      ?.initiator,
                    () => tool.execute(args),
                  ),
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
  /** Present only inside a governed admission. See {@link builtInAgentConfiguration}. */
  governedModel?: GovernedModelRequest,
  /** Who this build's runs are for. See {@link builtInAgentConfiguration}. */
  attribution?: { userId: string | null },
  /** The resolved gateway dial for this build. See {@link builtInAgentConfiguration}. */
  gatewayModel?: WorkbenchGatewayModelDial | null,
  /**
   * The run-scope threading for the builtin path (T-final M1), at the actor
   * level. Built per Bot below — each agent gets its own botId — and handed to
   * every construction of that Bot, so the threading survives the per-request
   * rebuilds and the runtime's clones. Absent means facts stay scope-less.
   */
  observation?: {
    actorId: string;
    resolveScope: (botId: string) => Promise<unknown>;
  },
  /**
   * PKG03B (T03-fix): the admitted run's pinned package skills, forwarded to
   * every built Bot. Appended last for the positional reason.
   */
  pinnedPackageSkills?: readonly SelectableSkill[],
  /** PKG05: forwarded from {@link resolveRuntimeAgents}. Appended last. */
  packageRun?: PackageToolRunContext,
): Promise<Record<string, AbstractAgent>> {
  let vendors: readonly string[] = [];
  try {
    vendors = await loadVendors();
  } catch {
    // Vendor guidance is best-effort: losing it must not prevent a run or change its grants.
    // Report once per build here, including failures from the production plugin-store loader.
    // Never log the thrown value: database errors can contain connection details or row contents.
    log.error({
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
      log.error({
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
          attribution,
          gatewayModel,
          // F5E1-F2: the threading serves the remote path too — the basic record a
          // governed remote run keeps is scope-keyed exactly like a built-in run's
          // spans, so both origins answer to the same authorization epoch. An
          // `unavailable` Bot still gets none: it never runs.
          observation &&
            (agent.type === "built_in" ||
              agent.type === "remote_ag_ui" ||
              agent.type === "remote_mastra")
            ? {
                actorId: observation.actorId,
                botId: agent.id,
                resolveScope: observation.resolveScope,
              }
            : undefined,
          pinnedPackageSkills,
          packageRun,
        );
        // ME14 (carried ME07 review F1): the middleware is the LEGACY engine's
        // personal-memory block. A build the selector routes to the Mastra
        // engine renders its memory block server-side from the #395 seams
        // (ME07) and never reads this loader — mounting it anyway left a dead
        // read wired to the legacy store's availability on every
        // Mastra-selected run. The mount is skipped exactly for that case; a
        // governed build that stays on the legacy engine keeps it.
        if (
          loadPersonalMemory &&
          !(built instanceof UnavailableAgent) &&
          !(
            governedModel !== undefined &&
            builtinExecutionEngineFor?.({
              botId: agent.id,
              governed: true,
            }) === "mastra"
          )
        )
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
 * same geometry as the dangling tool call in `toolkit/history-sanitize.ts`, which opens by recording
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
  /** Who this build's runs are for. See {@link builtInAgentConfiguration}. */
  attribution?: { userId: string | null },
  /** The resolved gateway dial for this build. See {@link builtInAgentConfiguration}. */
  gatewayModel?: WorkbenchGatewayModelDial | null,
  /**
   * The run-scope threading for the builtin path (T-final M1), built per Bot
   * by {@link buildAgents} from the actor-level threading it was handed.
   * Absent means facts stay scope-less — the recorders submit nothing. The
   * remote path asks the same threading (F5E1-F2): its basic record is
   * scope-keyed like any other observed run.
   */
  observation?: BuiltinRunObservationThreading,
  /** PKG03B (T03-fix): the admitted run's pinned package skills. Appended last. */
  pinnedPackageSkills?: readonly SelectableSkill[],
  /** PKG05: the admitted run's package context, handed to the tool offer. */
  packageRun?: PackageToolRunContext,
): Promise<AbstractAgent> {
  if (agent.type === "unavailable") {
    return new UnavailableAgent(agent);
  }
  /*
   * F5E1-F2 / R3-02: the remote dial exists only where the deployment can verify a budget
   * AND hand that budget to the endpoint as a contract it can enforce. The check sits
   * FIRST, before the tool read below, so a deployment (or an endpoint) that cannot be
   * verified pays for nothing — no grants query, no roster fetch, no transport — and the
   * refusal is the same one it has always been.
   */
  if (
    (agent.type === "remote_ag_ui" || agent.type === "remote_mastra") &&
    (remoteRunBudgetGate === undefined ||
      remoteBudgetContractResolver === undefined)
  ) {
    return new UnavailableAgent({
      id: agent.id,
      name: agent.name,
      reason: "REMOTE_RUN_BUDGET_UNVERIFIED",
    });
  }

  const granted = await loadTools(agent.id, packageRun);

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
      log.error(
        { operation: "loadSkills", agentId: agent.id },
        "tool_selection_skill_read_failed",
      );
    }
  }
  // PKG03B (T03-fix): the admitted run's pinned package skills join the
  // catalogue. They are pin ∩ active grant ∩ membership summaries revalidated
  // at every read, carried in the immutable artifact of the pinned revision;
  // they declare no tools (dispatch is a later slice), so narrowing behavior
  // is unchanged. Merged after — never instead of — the legacy grants.
  if (pinnedPackageSkills?.length) {
    skills = [...skills, ...pinnedPackageSkills];
  }
  const narrowing =
    selection &&
    skills.some((skill) => skill.tools.length > 0) &&
    granted.length > (selection.floor ?? SELECTION_FLOOR)
      ? selection
      : undefined;

  const diagnoseRecordFailure = (chosen: Selection<GrantedTool>) => {
    log.error(
      {
        operation: "record",
        agentId: agent.id,
        reason: chosen.reason,
        granted: chosen.granted,
        offered: chosen.offered.length,
        skills: chosen.skills,
      },
      "tool_selection_record_failed",
    );
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
   * The remote path (F5E1-F2), restored behind the budget admission.
   *
   * It narrows inside its own middleware rather than by being wrapped, for the reason the
   * middleware's own docblock gives: `.use()` is applied by `runAgent`, not `run`, so an outer
   * agent delegating to `remote.run(input)` would skip everything the wrapper adds.
   *
   * Coordination tools are resolved for this exact run by the same loader built-in Bots use.
   * Their executable half stays in the signed deployment callback, where current grants, source
   * ownership and handoff lease ownership are checked again.
   *
   * AND THE PERSON'S STANDING INSTRUCTIONS ARE NOT SENT HERE EITHER. `standingInstructions` is
   * built-in only, deliberately: a remote Bot composes its own prompt at somebody else's endpoint,
   * so this deployment would be sending one person's prose to a server it does not run, with no
   * way to know whether it is read or how it ranks against the role. See
   * `standingInstructionsGuidance`.
   */
  if (agent.type === "remote_ag_ui" || agent.type === "remote_mastra") {
    /*
     * Re-read rather than captured at the top: the tool and skill reads above awaited, so a
     * gate withdrawn mid-build must refuse here and not be carried into a Bot whose dial
     * nothing would admit. In a running deployment the wiring is fixed at boot and the two
     * reads answer the same seam.
     */
    const budgetGate = remoteRunBudgetGate;
    const resolveContract = remoteBudgetContractResolver;
    if (budgetGate === undefined || resolveContract === undefined) {
      return new UnavailableAgent({
        id: agent.id,
        name: agent.name,
        reason: "REMOTE_RUN_BUDGET_UNVERIFIED",
      });
    }
    /*
     * The endpoint's own question, asked before anything is fetched for it: is this an
     * endpoint this deployment runs AND has declared able to enforce the budget contract?
     * Anything else is refused here, as the finding requires — a third-party server cannot
     * be handed a run on the promise that it might bound itself.
     */
    const contract = resolveContract({
      type: agent.type,
      endpoint: agent.endpoint,
      agentToken: agent.headers?.["x-openbot-agent-token"],
    });
    if (contract === undefined) {
      return new UnavailableAgent({
        id: agent.id,
        name: agent.name,
        reason: "REMOTE_RUN_BUDGET_UNVERIFIED",
      });
    }
    return remoteAgentWithStandingRole(
      agent,
      await remoteTransport(agent, stallGuard, agentFetch, initiator),
      granted,
      signRun,
      connectedVendors,
      narrowing ? offeredFor : undefined,
      loadAttachment,
      markAttachmentsSent,
      acquireLearnedSkills,
      handoff,
      initiator,
      observation,
      budgetGate,
      contract,
    );
  }

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
        attribution,
        gatewayModel,
      ),
      {
        wrapChain: (input, run) =>
          builtinRunChainMiddleware(agent.id)(input, run),
        observe: (run) =>
          observeModelConnection(
            observeBuiltinRunLifecycle(observeBuiltinToolSteps(run)),
          ),
        ...(loadAttachment
          ? {
              inline: (messages: AgentRunInput["messages"], threadId: string) =>
                inlineAttachments(
                  messages,
                  loadAttachment,
                  threadId,
                  markAttachmentsSent,
                ),
            }
          : {}),
        ...(observation
          ? {
              wrapRun: (run: Observable<BaseEvent>) =>
                builtinRunUnderObservationScope(
                  observation,
                  observation.botId,
                  run,
                ),
            }
          : {}),
      },
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
  const watched = stallGuard
    ? stallGuard.watch(
        { id: agent.id, name: agent.name, ...(initiator ? { initiator } : {}) },
        agentFetch,
      )
    : agentFetch;
  /*
   * F5E1-F2: the run's W3C chain rides out with the dial.
   *
   * A cross-service chain only exists when the caller sends it: without `traceparent` on the
   * request, the endpoint roots a trace of its own and the remote half of the run is a separate
   * story upstream. The header is read from the ambient trace context AT FETCH TIME, so every
   * request this run makes carries the same chain its container's span belongs to, and a
   * deployment with no active span propagates nothing rather than inventing coordinates
   * (`injectTraceHeaders` is a no-op with an empty context).
   *
   * Deliberately the OUTERMOST layer: the stall guard relays the response body, and the guard
   * and the endpoint's own auth both want the request as the transport built it, with this
   * deployment's chain added on top.
   */
  const dial = watched === undefined ? undefined : withTraceparent(watched);

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
     * two peer variants of `@mastra/client-js` — identical code at identical version 1.57.0, but
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
 * A fetch that carries the active W3C trace to the endpoint it dials (F5E1-F2).
 *
 * The header is added to a COPY of whatever headers the transport built, so the endpoint's own
 * credentials and content type are exactly what they were. The ambient context is read per
 * request rather than captured once, because a fetch built at run start may serve a replayed
 * run and the chain it should carry is the one active when it is actually called. An empty
 * context injects nothing — no `traceparent` is ever synthesized.
 *
 * R4-01: for a governed run the "ambient context at fetch time" is no longer luck. The run
 * middleware ({@link governedRemoteRun}) decides the run's chain from the run's own identity
 * and binds it around the subscription ({@link subscribeWithin}), so this read is
 * deterministic wherever the runtime scheduled the run. A dial this layer makes with nothing
 * active — a transport built for a roster fetch, a `run()`-path delegation that skips
 * `.use()` — still propagates nothing, by the rule above.
 */
function withTraceparent(inner: AgentFetch): AgentFetch {
  return async (url, requestInit) => {
    const headers = injectTraceHeaders(
      Object.fromEntries(new Headers(requestInit.headers).entries()),
    );
    return inner(url, {
      ...requestInit,
      headers: new Headers(headers),
    });
  };
}

/*
 * R4-01: a run's W3C chain is DECIDED per run, not inherited from wherever the runtime
 * happened to schedule the run.
 *
 * The F7E evidence was 9 dials and 3 joins, split exactly by scheduling. The three that joined
 * were CopilotKit's thread-name generations (`runTitleGenerationAttempt`), which run a cloned
 * agent inline in the request handler, so the request's span was still the ambient context at
 * fetch time. The six that rooted a trace of their own were the person's runs: the Intelligence
 * runner executes those from a Phoenix channel-join callback (`IntelligenceAgentRunner`
 * `channel.join().receive("ok")` → `executeAgentRun` → `agent.runAgent`), a WebSocket
 * continuation the HTTP request's AsyncLocalStorage store does not survive into. So
 * `currentTraceContext()` read nothing, the dial carried no `traceparent`, and the run's basic
 * record had no chain to claim — safe, as designed, but not the product's contract (A2/A13,
 * #23): a run this deployment mediates hands the endpoint the chain of THAT run, every time.
 *
 * The run middleware — the one place that holds the run's authoritative identity — now decides
 * the chain before the dial and binds it around the subscription:
 *
 *   * AMBIENT, when a span IS active (inline execution, the thread-name path, an SSE
 *     deployment): the dial continues exactly what it continued before — an existing parent
 *     span on its own trace — and no span is invented;
 *   * DERIVED, when nothing is active: the trace id is derived from the run's identity
 *     (`botId` + `runId`, one derivation, idempotent across a re-dial or re-execution of the
 *     same run), and the dial span is a NON-RECORDING context with its own deterministic id
 *     (`derivedRemoteRunDialSpanId`) — written upstream through the two channels that can
 *     carry chosen ids: the W3C anchors ({@link postDialChainAnchors}) for the tracing
 *     channel the endpoint's continuation resolves against, and the governed record through
 *     the port, where the recorder materializes the dial span under the run-root id the
 *     binding store derives for that trace (`runUpstreamIdentity`) so the governed tree and
 *     the binding name one root (F9A — the F8A SDK span exported with a parent the backend
 *     dropped, which took the endpoint's whole continuation with it);
 *   * UNAVAILABLE, when not even a run identity is there: no header, ever — no context is
 *     synthesized — and the degradation is COUNTED and logged, not smoothed over.
 *
 * The counts are process-level and read by tests and ops (`remoteDialChainCounts`). A dial is
 * counted when it is BOUND, not when its chain is resolved: a run refused at the budget gate
 * never dials and never counts.
 */

/** Which way a run's dial got its W3C chain. `unavailable` never carries one. */
export type RemoteDialChainOrigin = "ambient" | "derived" | "unavailable";

/** The chain decision for one run: what the dial carries and the record claims. */
export type RemoteDialChain = Readonly<{
  origin: RemoteDialChainOrigin;
  /** The trace the dial and the run's basic record must agree on; null when unverifiable. */
  traceId: string | null;
  /** The ambient parent span the dial continues; set only for `ambient`. */
  parentSpanId?: string;
}>;

/**
 * The trace id a run with no ambient context runs its chain under: the first 32 hex of a
 * domain-separated digest of the run's SERVER-ISSUED attempt identity. Deterministic per
 * attempt on purpose — a re-dial of one attempt re-derives the chain it bound instead of
 * rooting a new one — and deliberately NOT deterministic across attempts: AG-UI runId is
 * wire input, and a chain derived from it let a client reusing one runId merge unrelated
 * runs into one trace tree, the exact threat the budget gate already answers with a
 * server-side nonce. Each subscription mints its own attempt id, so each roots its own
 * chain. An all-zero digest (an id the W3C format refuses) is remapped rather than shipped.
 */
export function derivedRemoteRunTraceId(
  botId: string,
  attemptId: string,
): string {
  const hex = createHash("sha256")
    .update(`openbot.remote.run:${botId}:${attemptId}`)
    .digest("hex");
  return /^0+$/.test(hex.slice(0, 32))
    ? `${"0".repeat(31)}1`
    : hex.slice(0, 32);
}

/**
 * The dial span's OWN span id (F9A / F8D-1): the first 16 hex of the same
 * domain-separated digest discipline as the trace id, over its own domain. Deterministic for
 * the same reason the trace id is — a re-dial of one attempt re-derives the same dial span
 * instead of minting a second one, so the chain's `traceparent` parent id and every upstream
 * copy of the dial span name one span per attempt.
 *
 * The dial span is NOT an SDK recording span (see {@link bindRemoteDialChain}): the SDK
 * cannot start a span with a chosen span id, and the F8D evidence proved the backend drops
 * SDK dial spans whose parent is the synthetic run-root id (Opik 2.2.100 silently drops an
 * OTLP span whose `parent_span_id` cannot be resolved within the receiving project — the
 * whole continuation tree under it goes with it, which is exactly the "server remote run
 * span and langgraph continuation both absent" of F8D-1). The dial span is therefore written
 * twice, deliberately, through the two channels that can carry a chosen id: the W3C anchors
 * below (the tracing channel, where the endpoint's continuation parents) and the governed
 * record through the port (where the run's trace the binding names is materialized).
 */
export function derivedRemoteRunDialSpanId(
  botId: string,
  attemptId: string,
): string {
  const hex = createHash("sha256")
    .update(`openbot.remote.run.dial:${botId}:${attemptId}`)
    .digest("hex");
  return /^0+$/.test(hex.slice(0, 16)) ? "0000000000000001" : hex.slice(0, 16);
}

/**
 * Decide a run's chain from the authoritative identity, ambient first. The wire runId only
 * GATES the derived chain — a run the client sent no identity for degrades visibly, as it
 * always has — while the chain itself is derived from the server-issued attempt identity, so
 * the client cannot choose two runs' shared coordinates (the runId is never a derivation
 * domain; the built-in path holds the same discipline). Pure: no span is started, nothing
 * counted — the decision is cheap, and a run refused at admission makes it for a dial it
 * never performs.
 */
export function resolveRemoteDialChain(
  botId: string,
  runId: string,
  attemptId: string,
): RemoteDialChain {
  const ambient = currentTraceContext();
  if (ambient !== undefined) {
    return {
      origin: "ambient",
      traceId: ambient.traceId,
      parentSpanId: ambient.spanId,
    };
  }
  if (runId.trim() !== "" && attemptId.trim() !== "") {
    return {
      origin: "derived",
      traceId: derivedRemoteRunTraceId(botId, attemptId),
    };
  }
  return { origin: "unavailable", traceId: null };
}

/** The dial-chain counts by origin — the visible half of the degradation contract. */
const dialChainCounts: Record<RemoteDialChainOrigin, number> = {
  ambient: 0,
  derived: 0,
  unavailable: 0,
};

/** Read the dial-chain counts (a copy: readers cannot reset what production counted). */
export function remoteDialChainCounts(): Readonly<
  Record<RemoteDialChainOrigin, number>
> {
  return { ...dialChainCounts };
}

/** One bound chain: the context the dial's fetch reads, and what closes it. */
type BoundRemoteDial = Readonly<{
  /** Set unless the chain is `unavailable`: the context active across the dial. */
  context?: Context;
  /** Ends the derived dial span, once; a no-op for the other origins. */
  close: () => void;
  /**
   * The derived dial span's own coordinates and window (F9A), for the governed record: the
   * recorder materializes this span under the binding's trace through the port. Null for the
   * other origins — an ambient dial continues a span the ambient pipeline already owns, and
   * `unavailable` carries no chain to record.
   */
  dial: { spanId: string; startedAt: Date; endedAt: Date } | null;
}>;

/**
 * The two W3C spans a derived dial chain needs in the tracing channel (F9A / F8D-1), written
 * as one raw OTLP post at dial-bind time:
 *
 *   * the CHAIN ROOT — trace id = the run's derived trace, span id =
 *     `runRootSpanId(traceId)` (the same root the binding's governance tree
 *     hangs from), NO parent — the span that roots the chain, so every span under it has a
 *     parent the receiving backend can resolve;
 *   * the DIAL SPAN — the deterministic dial id, parented at the chain root — the span the
 *     endpoint's whole continuation tree parents at through the `traceparent` this dial sent.
 *
 * WHY RAW, AND WHY AT BIND TIME. The F8D live evidence (10/10 derived dials, zero in Opik)
 * decomposed — on the pinned Opik 2.2.100 image, probed directly — into one backend rule:
 * an OTLP span whose parent id cannot be resolved WITHIN the receiving project is silently
 * dropped, and the drop cascades to everything parented under it. F8A's SDK dial span
 * exported parented at the run-root id, which no W3C-pure span in that pipeline ever
 * carried: the dial span dropped, and the endpoint's tree — parented at the dial span's id
 * — dropped with it. The OTel SDK cannot produce the two spans this chain needs (it cannot
 * start a span with a chosen span id, nor a span with a chosen trace id and no parent), so
 * they are written here in the OTLP/HTTP JSON shape the SDK's own exporter sends, to the
 * endpoint `initProcessTracing` exports to (unrouted: the deployment-wide default project,
 * the same place the SDK's spans land — so the endpoint's continuation, which exports the
 * same way, finds its parent already there). Posted BEFORE the fetch fires, so the parent
 * the endpoint's first span names is ingested seconds before that span's batch flushes.
 *
 * A chain that cannot resolve (no endpoint configured, tracing off) posts nothing — the
 * same honest nothing `initProcessTracing` exports. A repeat post of the same chain (a
 * re-dial of one attempt re-derives the same deterministic ids) is a duplicate the backend
 * refuses (409) and this side treats as done, never as a failure — the chain was already
 * anchored. This
 * is a tracing-channel write, not a governed one: no content rides on either span, only
 * structural ids, and the governed record of the dial (timing, binding attribution) is
 * materialized through the port by the recorder, not here.
 *
 * The bind post opens the two spans (startTime only); the run's finalize posts them AGAIN
 * with `endedAt`, closing them (L-H). No later batch ever re-sends these chosen ids — the
 * SDK cannot produce either span — so without the close post every derived dial left two
 * permanently open spans in the default project, growing with the dial count. The close
 * post re-sends the SAME trace and span ids with the dial window's end, which the backend
 * reads as the same span now ended; a 409 there is the already-closed answer, the same
 * idempotence the bind post holds.
 */
/**
 * The bound the anchor spans put on the wire runId attribute: the id is unbounded client
 * input, and an oversized one bloats the OTLP body past what a collector accepts (the
 * same 256 clamp tool-call ids hold). The governed budget paths carry the full id —
 * only this display/structure attribute is clamped.
 */
const MAX_RUN_ID_LENGTH = 256;

function postDialChainAnchors(
  traceId: string,
  dialSpanId: string,
  botId: string,
  runId: string,
  startedAt: Date,
  /** The dial window's end: present on the finalize post, which closes the two spans. */
  endedAt?: Date,
): void {
  const tracesEndpoint = deriveTracesTarget(process.env);
  if (
    tracesEndpoint === undefined ||
    process.env.OPENBOT_TRACES?.trim().toLowerCase() === "off"
  ) {
    return; // nothing exports from this process; the dial carries the header regardless
  }
  const rootSpanId = runRootSpanId(traceId);
  const startNanos = (BigInt(startedAt.getTime()) * 1_000_000n).toString();
  const endNanos =
    endedAt === undefined
      ? undefined
      : (BigInt(endedAt.getTime()) * 1_000_000n).toString();
  const span = (
    spanId: string,
    name: string,
    parentSpanId: string | undefined,
    extraAttributes: { key: string; value: { stringValue: string } }[],
  ) => ({
    traceId,
    spanId,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    name,
    kind: 1,
    startTimeUnixNano: startNanos,
    ...(endNanos === undefined ? {} : { endTimeUnixNano: endNanos }),
    attributes: [
      { key: "openbot.bot.id", value: { stringValue: botId } },
      {
        key: "openbot.run.id",
        // The wire runId is unbounded input; the attribute carries the same clamp the
        // tool-call ids hold, so one oversized id cannot bloat the post past what the
        // collector accepts (T-N#4-sub).
        value: { stringValue: runId.slice(0, MAX_RUN_ID_LENGTH) },
      },
      ...extraAttributes,
    ],
  });
  void fetch(tracesEndpoint, {
    method: "POST",
    // The exporter's own auth headers, read the way the installed exporter reads them:
    // the signal-level OTEL_EXPORTER_OTLP_TRACES_HEADERS first, the generic
    // OTEL_EXPORTER_OTLP_HEADERS as fallback (T-M#3).
    headers: {
      "content-type": "application/json",
      ...parseHeaders(
        process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ??
          process.env.OTEL_EXPORTER_OTLP_HEADERS,
      ),
    },
    // A collector that accepts the connection and never answers must not hold the post
    // open forever: the logs exporter's own 10s bound (T-M#3).
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                // The name the server process registered its tracer under, from the
                // same source initProcessTracing's boot call uses (T-M#3): one
                // service name for the whole trace tree, not a second one here.
                value: { stringValue: SERVER_TRACING_SERVICE_NAME },
              },
            ],
          },
          scopeSpans: [
            {
              spans: [
                span(rootSpanId, "run", undefined, []),
                span(dialSpanId, "remote run", rootSpanId, [
                  {
                    key: "openbot.dial.chain",
                    value: { stringValue: "derived" },
                  },
                ]),
              ],
            },
          ],
        },
      ],
    }),
  }).then(
    (response) => {
      // 409 is the duplicate a re-dial of the same run earns: the chain is already
      // anchored, which is the outcome this post exists to reach.
      if (!response.ok && response.status !== 409) {
        log.warn(
          { type: "remote-dial-chain-anchor-failed", status: response.status },
          "remote-dial-chain-anchor-failed",
        );
      }
    },
    () => {
      // The anchor is best-effort tracing plumbing: an unreachable collector must never
      // take the dial down, and the governed record does not depend on it.
    },
  );
}

/**
 * Bind a decided chain to the dial it was decided for: count it, say it in the log, and for a
 * derived chain post the chain's W3C anchors and open the dial window the governed record
 * measures. Bound here rather than at decision time because a span is a measurement — a run
 * refused at admission measured nothing.
 *
 * Exported for the one contract no product path can reach on purpose: the `unavailable`
 * binding, whose visible absence (no context, a counted degradation) is pinned by its suite.
 */
export function bindRemoteDialChain(
  chain: RemoteDialChain,
  botId: string,
  runId: string,
  attemptId: string,
): BoundRemoteDial {
  if (chain.origin === "ambient") {
    dialChainCounts.ambient += 1;
    log.info(
      {
        type: "remote-run-dial-chain",
        botId,
        runId,
        origin: "ambient",
        traceId: chain.traceId,
      },
      "remote-run-dial-chain",
    );
    // A non-recording stand-in for the ambient span, read at fetch time exactly as the span
    // itself would be: the dial names the parent that was active when the run began.
    return {
      context: trace.setSpan(
        context.active(),
        trace.wrapSpanContext({
          traceId: chain.traceId ?? "",
          spanId: chain.parentSpanId ?? "",
          traceFlags: TraceFlags.SAMPLED,
          isRemote: false,
          traceState: undefined,
        }),
      ),
      close: () => {},
      dial: null,
    };
  }
  if (chain.origin === "derived") {
    dialChainCounts.derived += 1;
    /*
     * F9A / F8D-1: the dial span is a NON-RECORDING span context with a DETERMINISTIC id
     * (`derivedRemoteRunDialSpanId`) rather than the SDK span F8A started here. Two reasons,
     * both proven on the real stack:
     *
     * 1. The SDK span this branch used to start exported through the generic OTLP pipeline
     *    parented under the run-root id — an id no W3C-pure span in that pipeline ever
     *    carries — and Opik 2.2.100 SILENTLY DROPS an OTLP span whose parent id cannot be
     *    resolved in the receiving project (probed on the pinned 2.2.100 image: same-batch
     *    and prior-batch parents resolve, cross-project and never-seen parents drop, and the
     *    drop cascades — every span parented under the dropped one drops too). That single
     *    rule is the whole of F8D-1's "server remote run span and agent-langgraph
     *    continuation both absent": the SDK dial span dropped, and the endpoint's tree,
     *    parented at the dial span's id, dropped with it.
     * 2. The SDK cannot start a span with a chosen span id or a chosen trace id and no
     *    parent, so the W3C chain's own root and dial can only be written with real, chosen
     *    ids through a channel this deployment addresses directly: the raw OTLP post below
     *    (the anchors) for the tracing channel, and the verified port for the governed
     *    record (the recorder in `remote-run.ts` materializes the dial span under the
     *    binding's trace at settle).
     *
     * The context the dial's fetch reads is therefore exactly the dial span: trace id = the
     * attempt's derived trace, span id = the deterministic dial id — so the `traceparent` the
     * endpoint receives names the dial span, whatever the runtime scheduling, and a re-dial
     * of one attempt re-derives the same coordinates instead of new ones.
     */
    const traceId = chain.traceId ?? "";
    const spanId = derivedRemoteRunDialSpanId(botId, attemptId);
    const startedAt = new Date();
    postDialChainAnchors(traceId, spanId, botId, runId, startedAt);
    log.info(
      {
        type: "remote-run-dial-chain",
        botId,
        runId,
        origin: "derived",
        traceId: chain.traceId,
        spanId,
      },
      "remote-run-dial-chain",
    );
    let endedAt: Date | null = null;
    return {
      context: trace.setSpan(
        context.active(),
        trace.wrapSpanContext({
          traceId,
          spanId,
          traceFlags: TraceFlags.SAMPLED,
          isRemote: false,
          traceState: undefined,
        }),
      ),
      /** The dial window's end, captured for the governed record; safe to call twice. */
      close: () => {
        if (endedAt === null) endedAt = new Date();
      },
      get dial() {
        return {
          spanId,
          startedAt,
          endedAt: endedAt ?? new Date(),
        };
      },
    };
  }
  dialChainCounts.unavailable += 1;
  log.warn(
    {
      type: "remote-run-dial-chain-unavailable",
      botId,
      runId: runId.trim() === "" ? null : runId,
    },
    "remote-run-dial-chain-unavailable: no active span and no run identity to derive a chain from; the dial carries no traceparent",
  );
  return { close: () => {}, dial: null };
}

/**
 * Subscribe INSIDE a context. `context.with(fn)` only covers `fn`'s synchronous body — an
 * observable returned from it is cold, and the fetch that fires at subscription runs in
 * whoever's context subscribes later, which is exactly the scheduling this fix cannot depend
 * on. Running the subscription itself under the context is what makes the dial's ambient read
 * deterministic: the middleware that knows the run hands the fetch the chain.
 */
function subscribeWithin<T>(
  ctx: Context,
  source: Observable<T>,
): Observable<T> {
  return new Observable((subscriber) =>
    context.with(ctx, () => source.subscribe(subscriber)),
  );
}

/*
 * R4-03, the built-in half. The F7E stock evidence: two real `report_environment` call ids in
 * the thread, no governance span carrying either — while the only tool spans on the chain were
 * the engine's state tools. The mechanism (R4-01's diagnosis, on this side of the wire): the
 * Intelligence runner executes a person's run from the Phoenix channel-join callback, where the
 * HTTP request's AsyncLocalStorage store does not survive, so every fact capture that reads the
 * ambient W3C context — the tool-step cell at open, the model span at doStream entry, the
 * run-lifecycle observer at the first event — read nothing, and FREV-02's honest chain check
 * refused the export. The runs that DID record were the lucky inline half (thread-name
 * generations). The remote dial got its determinism in R4-01; the built-in run gets the same
 * three-state discipline here, decided at the one seam that sees BOTH the run's own identity
 * and the whole subscription: an agent middleware, outside the hooks chain, where `input.runId`
 * is known before any event flows.
 */
/**
 * The builtin run chain's trace id: the same per-attempt derivation discipline the remote
 * dial holds — the SERVER-ISSUED attempt identity, never the wire runId, is the derivation
 * domain, so a client reusing one runId cannot merge two runs into one trace tree, while a
 * re-dial of one attempt re-derives the chain it bound.
 */
export function derivedBuiltinRunTraceId(
  botId: string,
  attemptId: string,
): string {
  const hex = createHash("sha256")
    .update(`openbot.builtin.run:${botId}:${attemptId}`)
    .digest("hex");
  return /^0+$/.test(hex.slice(0, 32))
    ? `${"0".repeat(31)}1`
    : hex.slice(0, 32);
}

/** The builtin run-chain decisions by origin — the visible half of the degradation contract. */
export type BuiltinRunChainOrigin = "ambient" | "derived" | "unavailable";

const builtinRunChainTally: Record<BuiltinRunChainOrigin, number> = {
  ambient: 0,
  derived: 0,
  unavailable: 0,
};

/** Read the run-chain counts (a copy: readers cannot reset what production counted). */
export function builtinRunChainCounts(): Readonly<
  Record<BuiltinRunChainOrigin, number>
> {
  return { ...builtinRunChainTally };
}

/**
 * The middleware itself. `ambient` keeps the run exactly as it was — an inline run continues
 * its parent chain and nothing is invented. `derived` names the chain from the
 * subscription's SERVER-ISSUED attempt identity (deterministic per attempt: a re-dial of the
 * subscription re-derives the same trace, while a re-driven run is a new attempt and roots
 * its own — the wire runId cannot merge two runs' trees, the same discipline the remote dial
 * holds), and the context it binds
 * is a NON-RECORDING stand-in for the run root the binding store derives for that trace
 * (`runUpstreamIdentity`, the same parent discipline the derived remote dial holds) — the
 * facts downstream read it as their trace, and the port completes every span's parent from
 * the authoritative binding, so no phantom span is exported and no parent is fabricated.
 * `unavailable` (no ambient, no run identity) runs bare and says so: counted, warned, and
 * honest — never a synthesized context the chain cannot prove.
 */
export function builtinRunChainMiddleware(
  botId: string,
): (input: RunAgentInput, run: Observable<BaseEvent>) => Observable<BaseEvent> {
  return (input, run) =>
    defer(() => {
      if (currentTraceContext() !== undefined) {
        builtinRunChainTally.ambient += 1;
        return run;
      }
      const runId = typeof input.runId === "string" ? input.runId.trim() : "";
      if (runId === "") {
        builtinRunChainTally.unavailable += 1;
        log.warn(
          { type: "builtin-run-chain-unavailable", botId },
          "builtin-run-chain-unavailable: no active span and no run identity; the run's facts stay chain-less and submit nothing upstream",
        );
        return run;
      }
      builtinRunChainTally.derived += 1;
      // The chain derives from a per-subscription nonce, not the wire runId (OCR delta T-J
      // #2): the runId is display, and this mint is the one identity two re-driven runs
      // cannot share.
      const attemptId = randomUUID();
      const traceId = derivedBuiltinRunTraceId(botId, attemptId);
      log.info(
        {
          type: "builtin-run-chain",
          botId,
          runId,
          origin: "derived",
          traceId,
        },
        "builtin-run-chain",
      );
      const ctx = trace.setSpan(
        context.active(),
        trace.wrapSpanContext({
          traceId,
          spanId: runRootSpanId(traceId),
          traceFlags: TraceFlags.SAMPLED,
          isRemote: false,
          traceState: undefined,
        }),
      );
      return subscribeWithin(ctx, run);
    });
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

/**
 * The governed remote run (F5E1-F2): the budget admission, the run's observation window and
 * its basic record, in that order — before anything reaches the endpoint.
 *
 * THREE THINGS, ONE MIDDLEWARE, because they share exactly one moment: the start of the run,
 * where this deployment still holds the request's authority, its trace, and the outcome of
 * the admission. Split into separate passes they would each re-derive what the others know,
 * and the derivation that matters — "was this run admitted?" — is the one a second pass could
 * get wrong.
 *
 * THE DIAL IS BEHIND THE ADMISSION. `next.run(input)` is not subscribed until the gate has
 * answered with a hold, so a refused run reaches no endpoint, sends no standing role, and
 * spends nothing on narrowing. A gate that throws is a refusal and propagates as the run's
 * error, the same way a built-in run surfaces a credit refusal.
 *
 * THE OBSERVATION IS THE EVENTS THE ENDPOINT ACTUALLY SENT. Nothing here reads a framework
 * internal: the fact carries what passed through this middleware, and the recorder behind
 * `remoteRunObserver` classifies it under T10's rules (a first frame or a vanished consumer
 * is an observation; only a terminal event is an outcome). A teardown with no terminal event
 * settles as `disconnected` and leaves the run's ending unknown, never invented.
 *
 * R4-03: the SAME stream feeds the tool-step fact face. The endpoint's business tool calls —
 * proposal (call id, name, streamed arguments) and, when the surface answered, the receipt —
 * become governance steps through the tool-step observer (origin `remote-agui`), with the
 * execution marked unobserved forever: this process never ran the tool, so nothing here may
 * claim it executed (#21's separation, held on the mediated path too). The engine's state
 * tools are not business steps and open no cell.
 *
 * AND THE HOLD FOLLOWS THE SAME HONESTY. AG-UI carries no usage receipt, so every admitted
 * run ends as an unknown cost — succeeded, failed, interrupted or torn down — and the wiring
 * behind `finish` keeps the hold pending rather than charging a number nobody reported or
 * releasing capacity for work that may have happened.
 *
 * THE RECEIPT IS THE ENFORCEMENT HALF (R3-02), and this middleware is where it is checked.
 * The contract's caps rode out with the dial; the endpoint enforces them at its own model
 * call and signs one CUSTOM receipt — what it was allowed, what it spent — sent as the LAST
 * event before its terminal. Three rules follow, and all three tear the run down:
 *
 * 1. A receipt that fails the check (wrong signature, caps or run id that are not this run's)
 *    is not a receipt from this contract, and the run it belongs to has no proven bound.
 * 2. A receipt whose usage is past its caps while claiming `ok` is an enforcement failure at
 *    the endpoint — the one thing the contract exists to prevent.
 * 3. A terminal event with no receipt in front of it breaks the ordering the contract
 *    requires, so the endpoint either did not enforce or did not report, and this deployment
 *    is not allowed to treat that run as one it could bound.
 *
 * The receipt itself never travels further: it is this deployment's control-plane fact, not
 * something for the person's surface to render, so it is filtered out of the stream here.
 */
function governedRemoteRun(
  agent: RegisteredRemoteAgent,
  /**
   * The budget admission this Bot was built behind. A parameter rather than a module read,
   * because it is the same fact `buildAgent` already required the dial on: reading the seam
   * again at run time would let a withdrawn gate turn a Built Bot into a silently
   * unbudgeted one, and would make two reads of one wiring disagree.
   */
  gate: (input: RemoteRunAdmissionInput) => Promise<RemoteRunAdmission>,
  /**
   * The contract this Bot's endpoint is held to, from the same build. See the docblock above
   * for what the run's receipt is checked against and what happens when it fails.
   */
  contract: RemoteBudgetContract,
  threading: BuiltinRunObservationThreading | undefined,
  input: RunAgentInput,
  next: AbstractAgent,
): Observable<BaseEvent> {
  const observer = remoteRunObserver;
  return defer(() => {
    const occurredAt = new Date();
    // Hygiene parity with the built-in path: the wire runId is read with the same
    // typeof+trim discipline everywhere, and from here on it is display and gate input
    // only — never a derivation domain.
    const runId = typeof input.runId === "string" ? input.runId.trim() : "";
    /*
     * One middleware execution is one attempt, and the attempt's identity is SERVER-ISSUED
     * (OCR delta T-J #2): this nonce keys the budget admission below AND derives the run's
     * observation chain, so a client reusing one runId can no longer merge unrelated runs
     * into one trace tree — the observation domain now holds the discipline the budget
     * gate's own comment below states. A re-dial of THIS attempt re-derives the chain and
     * the dial span it bound.
     */
    const attemptId = randomUUID();
    /*
     * R4-01: the run's chain is DECIDED here, from the run's own authoritative identity, not
     * read off whatever context the runtime scheduled this subscription in. Captured once so
     * the endpoint's dial, the basic record and the binding all claim ONE chain even when the
     * ambient context differs at each — and by teardown there is no context guaranteed at all.
     */
    const chain = resolveRemoteDialChain(agent.id, runId, attemptId);
    const traceId = chain.traceId;
    return from(
      Promise.all([
        admitRemoteRunBounded(gate, {
          /*
           * The idempotency key carries a SERVER-side nonce, not the client's runId: AG-UI
           * runId is wire input, and a key derived from it let a client reusing one runId
           * land concurrent runs on one shared hold — one reservation, many consumptions,
           * a ledger that under-counts by design. Each subscription is one admission (the
           * built-in model-call gate derives its eventId the same way), so each takes its
           * own hold; a legitimate re-dial pays for its own capacity instead of replaying
           * another subscription's. The nonce is the SAME `attemptId` the run's chain is
           * derived from, so admission and observation name one attempt with one identity.
           */
          eventId: `remote-run:${agent.id}:${attemptId}`,
          occurredAt,
          botId: agent.id,
          runId,
          threadId: input.threadId,
        }),
        threading
          ? resolveObservationScopeBounded(threading, agent.id)
          : Promise.resolve(null),
      ]),
    ).pipe(
      switchMap(([admission, scope]) => {
        const events: RemoteRunEventFact[] = [];
        let settled = false;
        /**
         * The run's verified receipt, once one has arrived. Null at settle means the contract
         * was never proven for this run — which a terminal event is not allowed to happen in
         * front of (see the docblock's third rule).
         */
        let receipt: Extract<
          RemoteBudgetReceiptCheck,
          { state: "verified" }
        > | null = null;
        /*
         * R4-03, the remote half: the endpoint's business tool calls as governance steps.
         * The endpoint's stream carries the PROPOSAL (name, id, streamed arguments) and, for a
         * call the surface answered, the RECEIPT — and never an execution this process ran.
         * The cell vocabulary mirrors the built-in tap's capture ceilings (OCR R3-37/R2-53):
         * arguments stop at the input cap with the cut declared in-band, the receipt's content
         * keeps the output cap. The engine's own state tools open no cell — protocol plumbing
         * is not a business step, the same rule the built-in tap holds.
         */
        const toolCells = new Map<
          string,
          {
            toolCallId: string;
            toolName: string | null;
            proposedAt: Date;
            args: string[];
            argsLength: number;
            argsTruncated: boolean;
            receiptObserved: boolean;
            output: string | null;
          }
        >();
        /** A defensive ceiling: an endpoint spamming proposals bounds this run's capture. */
        const REMOTE_TOOL_CELL_CAP = 128;
        let toolCellCapped = false;
        /**
         * A defensive ceiling for the whole run fact array (OCR R2 #14): cells were capped
         * above, but every protocol fact still landed here unbounded, so one hostile stream
         * could grow this run's resident memory without limit. Past the cap, non-terminal
         * facts are dropped with one bounded warn while protocol and budget processing run
         * unchanged; terminal facts still land by taking the final slot, so settle() and the
         * admission outcome read exactly what the endpoint said.
         */
        const REMOTE_EVENTS_CAP = 256;
        let eventsCappedWarned = false;
        const pushEvent = (event: RemoteRunEventFact): void => {
          if (events.length < REMOTE_EVENTS_CAP) {
            events.push(event);
            return;
          }
          switch (event.type) {
            case "success":
            case "error":
            case "interrupted":
            case "canceled":
              // The outcome is never a casualty of the bound: settle() reads the LAST
              // terminal fact, so this replaces whatever stands at the ceiling and the
              // newest terminal wins, exactly as it would uncapped.
              events[events.length - 1] = event;
              return;
            default:
              if (!eventsCappedWarned) {
                eventsCappedWarned = true;
                log.warn(
                  {
                    type: "remote-run-events-capped",
                    botId: agent.id,
                    runId,
                  },
                  "remote-run-events-capped: the endpoint's facts exceeded the capture ceiling; further facts are dropped, terminal facts still land",
                );
              }
              return;
          }
        };
        const appendRemoteToolArg = (
          cell: { args: string[]; argsLength: number; argsTruncated: boolean },
          delta: string,
        ): void => {
          const capacity = TOOL_STEP_INPUT_CAPTURE_CHARS - cell.argsLength;
          if (capacity <= 0) {
            cell.argsTruncated = true;
            return;
          }
          if (delta.length > capacity) {
            cell.args.push(delta.slice(0, capacity));
            cell.argsLength = TOOL_STEP_INPUT_CAPTURE_CHARS;
            cell.argsTruncated = true;
            return;
          }
          cell.args.push(delta);
          cell.argsLength += delta.length;
        };
        const emitRemoteToolSteps = (): void => {
          const stepObserver = builtinToolStepObserver;
          if (stepObserver === undefined) return;
          if (scope === null || scope === undefined) return;
          if (traceId === null) return;
          const parentSpanId = chain.parentSpanId ?? runRootSpanId(traceId);
          for (const cell of toolCells.values()) {
            try {
              stepObserver({
                toolCallId: cell.toolCallId,
                toolName: cell.toolName,
                proposedAt: cell.proposedAt,
                endedAt: new Date(),
                proposalObserved: true,
                // Never: this path cannot observe an execution, only a proposal and a
                // receipt. An executed step here would be exactly the fabrication
                // the finding refuses.
                executionObserved: false,
                receiptObserved: cell.receiptObserved,
                execution: null,
                window: "terminal",
                trace: { traceId, spanId: parentSpanId },
                scope,
                input:
                  cell.args.length > 0
                    ? cell.args.join("") +
                      (cell.argsTruncated
                        ? TOOL_STEP_INPUT_TRUNCATION_MARK
                        : "")
                    : null,
                output: cell.output,
                origin: "remote-agui",
                // The run's own binding identity: the recorder's gate must reuse the
                // binding this run's basic record began, never mint a second row for
                // the same chain.
                runRef: { runId, attemptId },
              });
            } catch {
              // Observation never takes the product path down.
            }
          }
        };
        /*
         * A broken contract ends the run HERE, before the event that broke it is delivered:
         * the person gets an error rather than an answer whose spending nobody bounded, and
         * the settlement below already has the unknown-cost answer this path owes. Thrown from
         * the observer's own `next`, so rxjs tears the upstream down and `finalize` settles.
         */
        const refuseContract = (reason: string): never => {
          pushEvent({ type: "error" });
          throw new Error(`REMOTE_RUN_BUDGET_CONTRACT_VIOLATION: ${reason}`);
        };
        const settle = () => {
          if (settled) return;
          settled = true;
          const terminal = [...events]
            .reverse()
            .find(
              (event) =>
                event.type === "success" ||
                event.type === "error" ||
                event.type === "interrupted" ||
                event.type === "canceled",
            );
          if (terminal === undefined) {
            // The window closed with nothing terminal: the consumer stopped watching, or the
            // stream was torn down. An observation, never an outcome (T10) — the run may still
            // be executing at the endpoint.
            pushEvent({ type: "disconnected" });
          }
          const outcomeByTerminal: Record<string, RemoteRunAdmissionOutcome> = {
            success: "succeeded",
            error: "failed",
            interrupted: "interrupted",
            canceled: "canceled",
          };
          const outcome: RemoteRunAdmissionOutcome =
            outcomeByTerminal[terminal?.type ?? ""] ?? "unknown";
          /*
           * Settlement is CONTAINED: the run's outcome is what the person receives, and a
           * ledger that failed to record an unknown cost must not turn a delivered answer into
           * an error. The hold stays reserved either way — it expires on its own clock, and
           * reconciliation reads what this line logged.
           */
          try {
            void Promise.resolve(admission.finish({ outcome })).catch(
              (error) => {
                log.error(
                  {
                    type: "remote-run-budget-settle-failed",
                    botId: agent.id,
                    runId,
                    outcome,
                    name: (error as Error | null | undefined)?.name,
                  },
                  "remote-run-budget-settle-failed",
                );
              },
            );
          } catch (error) {
            log.error(
              {
                type: "remote-run-budget-settle-failed",
                botId: agent.id,
                runId,
                outcome,
                name: (error as Error | null | undefined)?.name,
              },
              "remote-run-budget-settle-failed",
            );
          }
          if (observer !== undefined) {
            try {
              observer({
                botId: agent.id,
                threadId: input.threadId,
                runId,
                // One middleware execution is one attempt: a retry arrives as a new run,
                // and the attempt is named by the server nonce, never the wire runId.
                attemptId,
                traceId,
                scope,
                dial: dial.dial,
                events,
                endedAt: new Date(),
              });
            } catch {
              // Observation never takes the product path down.
            }
          }
          // R4-03: the run's business tool calls as governance steps — proposals
          // with their call ids, receipts as their own facts, executions never
          // claimed on a path that cannot observe one.
          emitRemoteToolSteps();
        };
        const observe = (event: BaseEvent) => {
          /*
           * The receipt is checked, then swallowed: it is the contract's own fact, not an
           * observation of the run, and the surface downstream has nothing to do with it.
           */
          if (isRemoteBudgetReceipt(event)) {
            const check = contract.verifyReceipt(
              (event as { value?: unknown }).value,
              { runId },
            );
            if (check.state !== "verified") {
              log.error(
                {
                  type: "remote-run-budget-receipt-refused",
                  botId: agent.id,
                  runId,
                  state: check.state,
                  reason: check.reason,
                },
                "remote-run-budget-receipt-refused",
              );
              return refuseContract(`${check.state}: ${check.reason}`);
            }
            if (receipt !== null) {
              /*
               * One contract, one receipt. A second one is a second claim about the same
               * run, and this side has no way to know which enforcement to believe.
               */
              return refuseContract("the endpoint sent more than one receipt");
            }
            receipt = check;
            return;
          }
          // The first event of any kind is the evidence the endpoint spoke at all.
          if (events.length === 0) pushEvent({ type: "http_first_frame" });
          switch (event.type) {
            case "RUN_STARTED":
              pushEvent({ type: "run_started" });
              break;
            case "RUN_FINISHED": {
              if (receipt === null) {
                return refuseContract(
                  "the endpoint ended the run without a budget receipt",
                );
              }
              /*
               * The protocol's own three endings, each named rather than defaulted: a
               * `cancelled` finish is a CONFIRMED cancellation, and classing it as success
               * would record a run that stopped as one that answered.
               */
              const outcome = (event as { outcome?: { type?: unknown } })
                .outcome?.type;
              pushEvent({
                type:
                  outcome === "interrupt"
                    ? "interrupted"
                    : outcome === "cancelled"
                      ? "canceled"
                      : "success",
              });
              break;
            }
            case "RUN_ERROR":
              if (receipt === null) {
                return refuseContract(
                  "the endpoint reported an error with no budget receipt",
                );
              }
              pushEvent({ type: "error" });
              break;
            case "TOOL_CALL_START": {
              const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
              if (typeof toolCallId === "string" && toolCallId.trim() !== "") {
                pushEvent({ type: "tool_proposed", toolCallId });
                // R4-03: the proposal as its own observable fact — see the cells above.
                const name = (event as { toolCallName?: unknown }).toolCallName;
                const toolName =
                  typeof name === "string" && name.trim() !== "" ? name : null;
                if (
                  toolName === null ||
                  !ENGINE_STATE_TOOL_NAMES.has(toolName)
                ) {
                  if (
                    toolCells.size >= REMOTE_TOOL_CELL_CAP &&
                    !toolCells.has(toolCallId)
                  ) {
                    if (!toolCellCapped) {
                      toolCellCapped = true;
                      log.warn(
                        {
                          type: "remote-tool-cells-capped",
                          botId: agent.id,
                          runId,
                        },
                        "remote-tool-cells-capped: the endpoint's proposals exceeded the capture ceiling; further calls are counted as events only",
                      );
                    }
                  } else if (!toolCells.has(toolCallId)) {
                    // A repeated START for a call this run already holds keeps the cell
                    // it built (the builtin registry's own reuse rule): resetting it
                    // here would let one duplicate event strip the run's input capture
                    // and truncation declaration (T-N#5).
                    toolCells.set(toolCallId, {
                      toolCallId,
                      toolName,
                      proposedAt: new Date(),
                      args: [],
                      argsLength: 0,
                      argsTruncated: false,
                      receiptObserved: false,
                      output: null,
                    });
                  }
                }
              }
              break;
            }
            case "TOOL_CALL_ARGS": {
              const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
              const cell =
                typeof toolCallId === "string"
                  ? toolCells.get(toolCallId)
                  : undefined;
              const delta = (event as { delta?: unknown }).delta;
              if (cell && typeof delta === "string") {
                appendRemoteToolArg(cell, delta);
              }
              break;
            }
            case "TOOL_CALL_RESULT": {
              // A receipt, which is the only evidence of an execution this path can observe.
              const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
              if (typeof toolCallId === "string" && toolCallId.trim() !== "") {
                pushEvent({ type: "tool_executed", toolCallId });
                const cell = toolCells.get(toolCallId);
                if (cell !== undefined) {
                  cell.receiptObserved = true;
                  const content = (event as { content?: unknown }).content;
                  if (cell.output === null) {
                    if (typeof content === "string") {
                      cell.output = content.slice(
                        0,
                        TOOL_STEP_OUTPUT_CAPTURE_CHARS,
                      );
                    } else if (content !== undefined && content !== null) {
                      try {
                        cell.output =
                          JSON.stringify(content)?.slice(
                            0,
                            TOOL_STEP_OUTPUT_CAPTURE_CHARS,
                          ) ?? null;
                      } catch {
                        // A receipt that cannot serialize carries no observation payload.
                      }
                    }
                  }
                }
              }
              break;
            }
            default:
              break;
          }
        };
        /*
         * R4-01: the decided chain is BOUND to this dial — the context the fetch reads, the
         * span it parents under when the chain is derived, the count and the log line that
         * make the binding visible. Bound here rather than at decision time so a run refused
         * at the admission above measures and counts nothing.
         */
        const dial = bindRemoteDialChain(chain, agent.id, runId, attemptId);
        const dialStream =
          dial.context === undefined
            ? next.run(input)
            : // The subscription runs under the chain's context, so the transport's fetch —
              // wherever the runtime scheduled this middleware — reads the run's chain.
              subscribeWithin(dial.context, next.run(input));
        return dialStream.pipe(
          tap({
            next: observe,
            /*
             * A stream that errored never delivered a terminal event this side could read: the
             * transport failed, which the run's record must name as a failure rather than let
             * `settle` file it as a consumer that merely stopped watching. The error itself
             * propagates untouched — this is a side effect, not a handler.
             */
            error: () => {
              if (
                !events.some(
                  (event) =>
                    event.type === "success" ||
                    event.type === "error" ||
                    event.type === "interrupted" ||
                    event.type === "canceled",
                )
              ) {
                pushEvent({ type: "error" });
              }
            },
          }),
          // The receipt was checked in `observe` above; it is control-plane, so it stops here
          // rather than being relayed to the person's surface as an unknown event.
          filter((event) => !isRemoteBudgetReceipt(event)),
          // The derived dial span measured the dial window; it closes with the stream.
          finalize(() => {
            dial.close();
            settle();
            // L-H: the anchors the derived dial opened are CLOSED here, in the same
            // window the governed record measures — the same two spans re-posted with
            // the dial's end time, so the default project holds no permanently open
            // anchor spans. A 409 is the already-closed answer, the same idempotence
            // the bind post holds.
            const window = dial.dial;
            if (window !== null && traceId !== null) {
              postDialChainAnchors(
                traceId,
                window.spanId,
                agent.id,
                runId,
                window.startedAt,
                window.endedAt,
              );
            }
          }),
        );
      }),
    );
  });
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
  /**
   * The run-scope threading (F5E1-F2), shared with the built-in path. Asked once per run,
   * before the dial, so the basic record this run keeps is keyed to a scope this process
   * issued for exactly this Bot. Absent means a scope-less run: the record is not kept, and
   * the run itself is unaffected.
   */
  observation?: BuiltinRunObservationThreading,
  /**
   * The per-run budget admission (F5E1-F2), required: `buildAgent` refuses to build this
   * wrapper without one, so there is no unbudgeted remote Bot to construct.
   */
  budgetGate?: (input: RemoteRunAdmissionInput) => Promise<RemoteRunAdmission>,
  /**
   * The enforceable contract this endpoint runs under (R3-02), required for the same reason
   * `budgetGate` is: the dial carries its caps and the run's ending is checked against its
   * receipt, so a Bot built without one would be a Bot whose spending nothing bounded. Typed
   * optional only because of where it sits in this signature; the middleware refuses to run
   * without both, exactly as it does a missing gate.
   */
  contract?: RemoteBudgetContract,
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
          // The same typeof+trim discipline the governed run reads the wire runId
          // with (:4909's own invariant): the run the assertion names is the run the
          // budget contract and the receipt check see (T-N#3).
          typeof input.runId === "string" ? input.runId.trim() : "",
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
       * The budget contract (R3-02), carried where the endpoint already reads this
       * deployment's run facts.
       *
       * LAST of the deployment's own keys and taking no input from the caller: the spread
       * above is whatever the surface sent, so a crafted `openbotBudget` in it is overwritten
       * here rather than trusted. The caps are the deployment policy's, and the run id is the
       * one this run is actually taking — the receipt that comes back is checked against both.
       */
      /*
       * Unreachable without a contract — the middleware below refuses first — but written as a
       * spread because the type says the parameter may be absent, and a silent `undefined.caps`
       * is exactly the failure this contract exists to prevent.
       */
      ...(contract === undefined
        ? {}
        : {
            openbotBudget: {
              v: REMOTE_BUDGET_CONTRACT_VERSION,
              // Trimmed like :4909 (inlined — the middleware assembly scope cannot see
              // the governed run's local): the receipt echoes this id back and is
              // checked against the trimmed one, so a wire runId with surrounding
              // whitespace used to fail its own honest endpoint (T-N#3).
              runId: typeof input.runId === "string" ? input.runId.trim() : "",
              caps: contract.caps,
            },
          }),
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
    /*
     * OUTERMOST, and that is the point of registering it first (registered order is applied
     * outermost-first): the budget admission has to run before the middleware below, whose
     * first act is the narrowing MODEL call — a billed request in its own right, but not the
     * request a remote run's hold is for. A run that cannot be admitted must not reach the
     * endpoint OR spend on choosing what to send it.
     */
    target.use((input, next) =>
      budgetGate === undefined || contract === undefined
        ? // The belt to `buildAgent`'s brace, in its words: no Bot reaches this wrapper
          // unbudgeted or uncontracted, and one constructed anyway (a future path, a wider
          // signature) refuses rather than dials.
          throwError(() => new Error("REMOTE_RUN_BUDGET_UNVERIFIED"))
        : governedRemoteRun(
            agent,
            budgetGate,
            contract,
            observation,
            input,
            next,
          ),
    );
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

/**
 * The trusted observation-scope threading for the builtin path (T-final M1).
 *
 * What the boot wiring hands each builtin agent when the deployment carries an
 * observation face: WHOSE run this is, and how to mint the trusted scope for a
 * bot at run start. Deliberately structural — the resolved scope stays
 * `unknown` here because this module must not depend on the observability
 * module a deployment may not have; the wiring that supplies the resolver is
 * the same wiring that reads the scope back at the recorders, so the two ends
 * agree without a type-level coupling.
 */
export type BuiltinRunObservationThreading = Readonly<{
  /** The authenticated actor whose run this is (never a wire value). */
  actorId: string;
  /** The Bot being threaded — carried because BuiltInAgent's own agentId is unset. */
  botId: string;
  /**
   * Mints the trusted scope for one bot, asked once per run so the epoch is
   * live. MUST answer null on any refusal — disabled, non-manager, failed read
   * — and never throw: a failed resolution is a scope-less run, not a failed
   * one. The production resolver is `createBuiltinRunScopeResolver`.
   */
  resolveScope: (botId: string) => Promise<unknown>;
}>;

let builtinScopeResolutionTimeoutMs = 5_000;

/** Test seam for the scope-resolution timeout (OCR R5-42). */
export function builtinScopeResolutionTimeoutForTests(ms: number): void {
  builtinScopeResolutionTimeoutMs = ms;
}

let remoteRunBudgetGateTimeoutMs = 5_000;

/** Test seam for the budget-gate timeout (OCR final #62), on the scope seam's footing. */
export function remoteRunBudgetGateTimeoutForTests(ms: number): void {
  remoteRunBudgetGateTimeoutMs = ms;
}

/**
 * The bounded scope resolution both run paths ask (F5E1-F2 lifted it out of the built-in
 * wrapper unchanged, so the remote path cannot grow a second, different discipline).
 *
 * OCR R4-34: the resolver's contract — "null on any refusal, never throw" —
 * was JSDoc only; a rejection or a synchronous throw used to error the whole
 * observable and end the builtin run, an observation failure taking the
 * product down. Contained here as structure (A10's discipline, which every
 * other observer call in this file already keeps): a failed resolution is a
 * scope-less run, logged with the actor and bot, never a failed one. The
 * async wrapper is what turns a synchronous throw into the same handled
 * rejection — the resolver's body never gets to unwind into the stream.
 *
 * OCR R5-42: rejection and null were contained, but a resolver whose promise
 * NEVER settles still held the defer pending forever — switchMap never
 * subscribed the inner and the run never started at all (the wiring's own
 * resolver chains two unbounded DB round trips). A resolution that cannot
 * answer in time is the same "failed resolution = a scope-less run" by
 * structure: the race below bounds the wait, then proceeds bare, logged like
 * every other resolution failure. The losing promise stays handled by the
 * race (no unhandled rejection), and the timer is cleared the moment the
 * race settles so a resolved scope never keeps the loop alive.
 */
async function resolveObservationScopeBounded(
  threading: BuiltinRunObservationThreading,
  botId: string,
): Promise<unknown | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(threading.resolveScope(botId)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          log.warn(
            {
              type: "builtin-run-scope-resolution-failed",
              actorId: threading.actorId,
              botId,
              timedOut: true,
            },
            "builtin-run-scope-resolution-failed",
          );
          resolve(null);
        }, builtinScopeResolutionTimeoutMs);
      }),
    ]);
  } catch (error) {
    log.warn(
      {
        type: "builtin-run-scope-resolution-failed",
        actorId: threading.actorId,
        botId,
        name: (error as Error | null | undefined)?.name,
      },
      "builtin-run-scope-resolution-failed",
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The gate half of the admission bound (OCR final #62). The scope resolver above
 * is raced because an unbounded dependency holds the defer pending forever; the
 * budget gate is the SAME class of dependency — a DB-backed hold reservation —
 * and it sat in the same Promise.all bare. A gate that never settles would leave
 * the run pending with no event and no error, so the race bounds the wait and a
 * timeout FAILS CLOSED: the rejection rides the budget refusal's own path (the
 * run errors before it dials), never a pass-through. The losing gate promise
 * stays handled by the race, and the timer is cleared the moment the race
 * settles. The hold a timed-out gate later takes, if any, is the plain
 * reservation the 15-minute acceptance matrix already releases.
 */
async function admitRemoteRunBounded(
  gate: (input: RemoteRunAdmissionInput) => Promise<RemoteRunAdmission>,
  input: RemoteRunAdmissionInput,
): Promise<RemoteRunAdmission> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(gate(input)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          log.warn(
            {
              type: "remote-run-budget-gate-timeout",
              botId: input.botId,
              runId: input.runId,
              timedOut: true,
            },
            "remote-run-budget-gate-timeout",
          );
          reject(new Error("REMOTE_RUN_BUDGET_GATE_TIMEOUT"));
        }, remoteRunBudgetGateTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function builtinRunUnderObservationScope(
  threading: BuiltinRunObservationThreading | undefined,
  botId: string,
  inner: Observable<BaseEvent>,
): Observable<BaseEvent> {
  if (!threading) return inner;
  return defer(() => resolveObservationScopeBounded(threading, botId)).pipe(
    switchMap((scope) =>
      scope === null || scope === undefined
        ? inner
        : new Observable<BaseEvent>((subscriber) =>
            withRunObservationScope(scope, () => inner.subscribe(subscriber)),
          ),
    ),
  );
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
  /**
   * The server-only governed model collaborator, present only inside a
   * governed admission.
   *
   * Its presence also suppresses the provider api-key read entirely: a
   * governed Bot dials the model gateway with a capability, never a provider
   * SDK key, so resolving one would be a credential read nothing consumes.
   */
  governedModel?: GovernedModelRequest,
  /**
   * Who this build's runs are for, so the consumption facts name the initiator (09.1). Handed to
   * every built-in Bot's model wrapper; absent when the caller had no actor, which the usage fact
   * then records as a named null rather than a guess.
   */
  attribution?: { userId: string | null },
  /**
   * The run-scope threading for the builtin path (T-final M1), at the actor
   * level — passed through to {@link buildAgents}, which narrows it per Bot.
   * Appended last for the positional reason every collaborator here carries.
   */
  observation?: {
    actorId: string;
    resolveScope: (botId: string) => Promise<unknown>;
  },
  /**
   * PKG03B (T03-fix): the admitted run's pinned package skills, read by the
   * Runner through `readPinnedSkills` after its own admission. Appended last
   * for the same positional reason. Absent leaves every build on the legacy
   * contract.
   */
  pinnedPackageSkills?: readonly SelectableSkill[],
  /**
   * PKG05: the admitted run's package execution context. Present, the build's
   * `loadTools` is handed it so the run's dispatchable package tools join its
   * offer beside — never instead of — the legacy grants. Absent leaves every
   * build on the legacy contract.
   */
  packageRun?: PackageToolRunContext,
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
  /*
   * One gateway dial per build (09.1), resolved only when a built-in Bot will actually run on it:
   * the transport is the deployment's gateway endpoint and readiness verdict, so the read is async
   * and belongs here — once per roster, not once per Bot, and never on a build that dials nothing.
   * A wired transport that throws (the readiness gate's refusal) fails the build; a null answer
   * reaches each Bot as its own fail-closed refusal.
   */
  const gatewayModelDial =
    workbenchGatewayModel &&
    !governedModel &&
    registered.some((agent) => agent.type === "built_in")
      ? await workbenchGatewayModel(model, apiKey)
      : undefined;
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
    governedModel,
    attribution,
    gatewayModelDial,
    observation,
    pinnedPackageSkills,
    packageRun,
  );
}

/** What one Bot may call, for the person whose request this is. */
export type LoadToolsForBot = (
  botId: string,
  /** PKG05: present only for a build the Runner re-resolved with a package run. */
  packageRun?: PackageToolRunContext,
) => Promise<GrantedTool[]>;

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

  /*
   * ME15 (#487): the client, resolved lazily.
   *
   * With the governed enterprise Runner mounted, the runtime itself never
   * asks for this client — the SSE branch below constructs nothing — and the
   * remaining consumers (learning, when a container is actually targeted; the
   * legacy delivery's history/lock/runner reads) each resolve it on their own
   * first use. A deployment that has not configured Intelligence boots here
   * with ZERO constructed clients; a consumer that runs anyway gets the named
   * refusal, never a silent in-memory stand-in.
   */
  const requireIntelligenceClient = lazyIntelligenceClient({
    settings: intelligence,
    feature: "the CopilotKit runtime mount's client",
    build: (settings) =>
      observeIntelligenceAuthentication(
        new IntelligenceKnowingANewThread({
          apiUrl: settings.apiUrl,
          wsUrl: settings.gatewayWsUrl,
          apiKey: settings.apiKey,
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
      ),
  });
  if (!intelligence && !options.enterpriseRunner) {
    // Unreachable through index.ts (the boot gate refuses the engine-less
    // deployment first) and refused here on its own terms: mounting the
    // Intelligence runtime without Intelligence would be exactly the degraded
    // runner the spec forbids.
    throw new IntelligenceUnconfiguredError(
      "the browser chat mount (no governed enterprise Runner is wired)",
    );
  }

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
   * history a person's run would read rather than a second view of it that could disagree. Handed
   * to the learning runtime as the same lazy accessor (ME15 #487): with learning disabled the
   * runtime never resolves it, so this mount constructs nothing.
   */
  const learning: LearningRuntime | undefined = learningSettings
    ? createLearningRuntime({
        store: learningSettings,
        client: requireIntelligenceClient,
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
    licenseToken: intelligence?.licenseToken,
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
        intelligence: requireIntelligenceClient(),
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
      url: requireIntelligenceClient().ɵgetRunnerWsUrl(),
      authToken: requireIntelligenceClient().ɵgetRunnerAuthToken(),
    }),
    threadLock: createIntelligenceThreadLock({
      client: requireIntelligenceClient,
      learning,
      onRunBusy,
    }),
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
          requireIntelligenceClient().getThreadMessages({
            threadId: input.threadId,
            userId: input.actorId,
          }),
        { messages: [] } as Read,
      );
      return read.messages;
    },
  };
}
