import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType } from "@ag-ui/client";
import type {
  AgentRunnerConnectRequest,
  AgentRunnerIsRunningRequest,
  AgentRunnerRunRequest,
  AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
import { AgentRunner } from "@copilotkit/runtime/v2";
import type { Observable } from "rxjs";
import {
  catchError,
  concat,
  concatMap,
  defer,
  EMPTY,
  finalize,
  from,
  mergeMap,
} from "rxjs";
import type { ActorAgentResolver } from "../../agents/agent-resolver";
import type { AgentActor } from "../../agents/profile-types";
import type { ModelCredentialSecretReader } from "../../credentials";
import type {
  ConversationService,
  EventService,
  PlatformScope,
  RunFailureCode,
  RunnerRequestLease,
  RunService,
  ScopeResolver,
  TrustedRunAdmission,
} from "../contracts";
import { messageDigest } from "../conversations/store";
import { ExpertVersionCatalog } from "../experts/version-catalog";
import type { RuntimeModelRoute } from "../models/runtime-adapter";
import type {
  PinnedSkillSummary,
  PreparePackageRunInput,
} from "../plugin-packages/runtime";
import type { DataDatabase } from "../tenancy/connections";
import { createRevocationGuard } from "../tenancy/revocation";
import {
  createDrizzleRunnerEventRepository,
  createRunnerEventService,
} from "./events";
import {
  classifyGovernedRunFailure,
  createGovernedModelExecution,
  type GovernedModelExecution,
} from "./governed-execution";
import {
  ModelRouteCatalogStore,
  type ModelRouteSnapshotInput,
} from "./model-route-catalog";
import { runOutputCeilingFromInput } from "./output-ceiling";
import {
  createRunService,
  type RunModelRoute,
  type RunServiceDependencies,
} from "./service";
import { RunDomainError } from "./store";

/**
 * The deployment's effective model selection, reused from the tenant package
 * and environment rather than invented here. The snapshot fingerprints the
 * native base URL when one is configured, so two deployments that differ only
 * by a proxy route do not share a route ref.
 */
export interface ProductionModelSelection {
  readonly route: RuntimeModelRoute;
  readonly nativeBaseUrl?: string;
}

export interface ProductionRunnerDependencies {
  readonly scopeResolver: ScopeResolver;
  readonly conversations: ConversationService;
  readonly runs: RunService;
  readonly events: EventService;
  readonly expertVersions: Pick<ExpertVersionCatalog, "putOrGet">;
  readonly modelRoutes: Pick<ModelRouteCatalogStore, "put" | "get">;
  readonly resolveBuiltInBotForActor: ActorAgentResolver["resolveBuiltInBotForActor"];
  readonly identifyActor: (request: Request) => Promise<AgentActor>;
  readonly modelSelection: () => ProductionModelSelection;
  readonly now?: () => number;
  /**
   * How often the request lease is renewed while a stream is live.
   * Defaults to half of the configured lease window.
   */
  readonly renewalIntervalMilliseconds?: number;
  /** The lease window the default renewal interval derives from. */
  readonly leaseMilliseconds?: number;
  /**
   * The governed-execution collaborators. All three are present or none are:
   * the composition provides them together, and a Runner built without them
   * refuses model execution (the no-model refusal) rather than dialing a
   * provider directly.
   */
  readonly modelCapabilitySecret?: string | Uint8Array;
  readonly credentialEncryptionKey?: string;
  readonly credentialReader?: ModelCredentialSecretReader;
  /** Environment the gateway dial sees; defaults to the process environment. */
  readonly gatewayEnvironment?: Record<string, string | undefined>;
  /** Upstream fetch for the gateway dial; defaults to the runtime's fetch. */
  readonly modelFetch?: typeof fetch;
  /**
   * PKG03B (T03-fix): the package runtime's pinned Skill read. Present, the
   * Runner reads it for every admitted run — the run's (runId,
   * attemptGeneration) come from its own admission, never from a client
   * field — and a non-empty result re-resolves the executing agent with the
   * pinned package skills in its catalogue. Absent, runs keep the legacy
   * Skill contract untouched.
   */
  readonly readPinnedSkills?: (
    scope: PlatformScope,
    input: PreparePackageRunInput,
  ) => Promise<readonly PinnedSkillSummary[]>;
}

/** Server-issued Bot Expert identity, frozen for the governed executor slice. */
const BEHAVIOR_VERSION = "openbot-builtin-v1";
const MODEL_EXECUTION_UNAVAILABLE: RunFailureCode =
  "MODEL_EXECUTION_UNAVAILABLE";

interface BoundModelRoute {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly actorId: string;
  readonly threadId: string;
  readonly agentId: string;
  readonly routeRef: string;
  readonly maximumTokens: number;
}

/** Per-run relay state: the exact owner every event and settlement answers to. */
interface RelayedRunState {
  readonly scope: PlatformScope;
  /** Replaced wholesale on every successful renewal. */
  lease: RunnerRequestLease;
  readonly runId: string;
  readonly threadId: string;
  readonly carrier: GovernedModelExecution | null;
  /** A terminal event was persisted and the run settled (completed or failed). */
  terminalSettled: boolean;
  /** A best-effort failure settlement already terminalized this run. */
  failureSettled: boolean;
  /**
   * A fenced settlement was attempted (complete or fail), even when the
   * store refused it: the finalize fallback must never fire a second,
   * contradictory settlement after a refused one.
   */
  settlementAttempted: boolean;
  /** Renewal failed: no further events may be written under this claim. */
  leaseLost: boolean;
  /** The run was stopped/cancelled: the relay drops everything after it. */
  aborted: boolean;
  /** The renewal loop handle, cleared in every finalize path. */
  renewalTimer: ReturnType<typeof setInterval> | null;
}

/*
 * The route the RunService admission seam re-reads. One admission at a time
 * binds its exact scope/thread/Bot here — request-local propagation, not a
 * global mutable holder: nothing survives the admission that set it, and a
 * caller outside a governed admission gets a refusal rather than a route.
 */
const boundModelRouteContext = new AsyncLocalStorage<BoundModelRoute>();

/*
 * Live relayed streams by runId. Module-level because one HTTP request
 * builds its runner instance while a later stop() call may arrive on a
 * different instance: the runId is a server-issued UUID, so the registry
 * is globally addressable and every finalize path removes its entry.
 */
const activeStreams = new Map<string, AbortController>();

export async function requestBoundModelRouteFor(
  scope: PlatformScope,
  threadId: string,
): Promise<RunModelRoute> {
  const bound = boundModelRouteContext.getStore();
  if (!bound) throw new Error("MODEL_ROUTE_CONTEXT_UNAVAILABLE");
  if (
    bound.tenantId !== scope.tenantId ||
    bound.workspaceId !== scope.workspaceId ||
    bound.principalId !== scope.principalId ||
    bound.actorId !== scope.actorId ||
    bound.threadId !== threadId
  ) {
    throw new Error("MODEL_ROUTE_SCOPE_MISMATCH");
  }
  return { routeRef: bound.routeRef, maximumTokens: bound.maximumTokens };
}

/**
 * ME09 (#481): run one operation inside the request-local model-route
 * binding, the way every governed admission does. The headless (routine)
 * admission runs outside any HTTP request, so its wiring binds the SAME
 * request-local facts — the scope, thread, Bot, route ref and ceiling it
 * just resolved server-side — for the duration of the `start` call. Nothing
 * here reads a client field: the caller is the server assembly.
 */
export function runWithBoundModelRoute<T>(
  binding: BoundModelRoute,
  operation: () => Promise<T>,
): Promise<T> {
  return boundModelRouteContext.run(binding, operation);
}

function threadIdFrom(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error("RUNNER_THREAD_ID_INVALID");
  return value;
}

function submittedUserMessage(messages: unknown): {
  clientMessageKey: string;
  content: string;
} {
  if (!Array.isArray(messages) || messages.length === 0)
    throw new Error("RUNNER_SUBMITTED_MESSAGE_MISSING");
  const submitted = messages[messages.length - 1] as {
    id?: unknown;
    role?: unknown;
    content?: unknown;
  } | null;
  if (
    !submitted ||
    typeof submitted !== "object" ||
    submitted.role !== "user" ||
    typeof submitted.id !== "string" ||
    !submitted.id.trim()
  )
    throw new Error("RUNNER_SUBMITTED_MESSAGE_MISSING");
  if (typeof submitted.content !== "string")
    throw new Error("RUNNER_SUBMITTED_MESSAGE_UNSUPPORTED");
  return { clientMessageKey: submitted.id, content: submitted.content };
}

function attachmentRefsFrom(forwardedProps: Record<string, unknown>): string[] {
  const attachments = forwardedProps.attachments;
  if (attachments === undefined) return [];
  if (
    !Array.isArray(attachments) ||
    attachments.length > 32 ||
    attachments.some((id) => typeof id !== "string" || !id.trim())
  )
    throw new Error("RUNNER_ATTACHMENT_REFS_INVALID");
  return attachments as string[];
}

function forwardedPropsFrom(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("RUNNER_FORWARDED_PROPS_INVALID");
  return value as Record<string, unknown>;
}

class DurableProductionRunner extends AgentRunner {
  constructor(
    private readonly deps: ProductionRunnerDependencies,
    private readonly request: Request,
  ) {
    super();
  }

  override run(runRequest: AgentRunnerRunRequest): Observable<BaseEvent> {
    const captured: {
      scope: PlatformScope | null;
      lease: RunnerRequestLease | null;
      state: RelayedRunState | null;
    } = {
      scope: null,
      lease: null,
      state: null,
    };
    // Admission starts on subscription, so a stream nobody listens to admits nothing.
    return defer(() => from(this.admitAndExecute(runRequest, captured))).pipe(
      mergeMap((events) => events),
      finalize(() => this.finalizeRun(captured)),
    );
  }

  override connect(
    connectRequest: AgentRunnerConnectRequest,
  ): Observable<BaseEvent> {
    const abort = new AbortController();
    return from(this.connectEvents(connectRequest, abort.signal)).pipe(
      mergeMap((event) => from([event])),
      finalize(() => abort.abort()),
    );
  }

  override async isRunning(
    request: AgentRunnerIsRunningRequest,
  ): Promise<boolean> {
    const threadId = threadIdFrom(request?.threadId);
    const scope = await this.deps.scopeResolver.resolveForThread(
      this.request,
      threadId,
    );
    const active = await this.deps.runs.getActiveForThread(scope, threadId);
    return active !== null;
  }

  override async stop(
    request: AgentRunnerStopRequest,
  ): Promise<boolean | undefined> {
    const threadId = threadIdFrom(request?.threadId);
    const scope = await this.deps.scopeResolver.resolveForThread(
      this.request,
      threadId,
    );
    const active = await this.deps.runs.getActiveForThread(scope, threadId);
    if (!active) return false;
    if (request.runId && active.run.run_id !== request.runId) return false;
    try {
      await this.deps.runs.stop(scope, {
        runId: active.run.run_id,
        reason: "user_requested",
        attemptId: active.attemptId,
        generation: active.generation,
      });
    } catch (error) {
      // Only the structured stale code is a quiet no-op: an unrelated error
      // whose message merely contains "STALE" still propagates (M-h).
      if (error instanceof RunDomainError && error.code === "RUN_ATTEMPT_STALE")
        return false;
      throw error;
    }
    // The persisted run is cancelled: abort the in-flight relay so a still
    // emitting agent stream stops persisting under a run that no longer
    // exists (M-m).
    activeStreams.get(active.run.run_id)?.abort();
    return true;
  }

  /**
   * Admission, then governed execution of the admitted Bot.
   *
   * The route is pinned before the Bot is resolved, so the request-local
   * governed carrier can hand the resolver a model adapter bound to the exact
   * admitted {scope, routeRef, ceiling}; the run, attempt, and lease
   * identities are bound onto the carrier the moment the RunService hands
   * back the request lease. A Runner built without the governed
   * collaborators, or a resolver that did not consume them, gets the honest
   * no-model refusal instead: nothing dials a provider directly.
   */
  private async admitAndExecute(
    runRequest: AgentRunnerRunRequest,
    captured: {
      scope: PlatformScope | null;
      lease: RunnerRequestLease | null;
      state: RelayedRunState | null;
    },
  ): Promise<Observable<BaseEvent>> {
    const { deps, request } = this;
    const input = runRequest?.input;
    const threadId = threadIdFrom(input?.threadId);
    const agent = runRequest?.agent as { agentId?: unknown } | undefined;
    const agentId = agent?.agentId;
    if (typeof agentId !== "string" || !agentId.trim() || agentId.length > 512)
      throw new Error("RUNNER_AGENT_SELECTION_INVALID");

    const forwardedProps = forwardedPropsFrom(input?.forwardedProps);
    const ceiling = runOutputCeilingFromInput({ forwardedProps });
    const { clientMessageKey, content } = submittedUserMessage(input?.messages);
    const attachments = attachmentRefsFrom(forwardedProps);

    const scope = await deps.scopeResolver.resolveForThread(request, threadId);
    const actor = await deps.identifyActor(request);
    if (!actor || actor.id !== scope.actorId)
      throw new Error("RUNNER_ACTOR_SCOPE_MISMATCH");

    const selection = deps.modelSelection();
    const route = await deps.modelRoutes.put(scope, {
      agentId,
      route: selection.route,
      ...(selection.nativeBaseUrl !== undefined
        ? { nativeBaseUrl: selection.nativeBaseUrl }
        : {}),
    });

    const secret = deps.modelCapabilitySecret;
    const encryptionKey = deps.credentialEncryptionKey;
    const credentialReader = deps.credentialReader;
    const carrier =
      secret !== undefined &&
      encryptionKey !== undefined &&
      credentialReader !== undefined
        ? createGovernedModelExecution({
            scope,
            agentId,
            routeRef: route.routeRef,
            ceiling,
            runs: deps.runs,
            catalog: deps.modelRoutes,
            // Read the selection lazily on every rebind so a deployment whose
            // model drifted since admission fails closed instead of dialing it.
            currentRouteForAgent: (forAgentId) => {
              const current = deps.modelSelection();
              const snapshot: ModelRouteSnapshotInput = {
                agentId: forAgentId,
                route: current.route,
                ...(current.nativeBaseUrl !== undefined
                  ? { nativeBaseUrl: current.nativeBaseUrl }
                  : {}),
              };
              return Promise.resolve(snapshot);
            },
            modelCapabilitySecret: secret,
            encryptionKey,
            credentialReader,
            ...(deps.gatewayEnvironment !== undefined
              ? { environment: deps.gatewayEnvironment }
              : {}),
            ...(deps.modelFetch ? { fetch: deps.modelFetch } : {}),
          })
        : null;

    const { agent: resolvedAgent, definitionFacts } =
      await deps.resolveBuiltInBotForActor(
        actor,
        agentId,
        carrier ? { governedModel: carrier.governedModel } : undefined,
      );
    if (definitionFacts.agentId !== agentId)
      throw new Error("RUNNER_AGENT_IDENTITY_MISMATCH");

    await deps.conversations.append(scope, {
      threadId,
      clientMessageKey,
      content,
      attachments,
    });
    const { digest } = messageDigest(content, attachments);

    const expertVersionRef = await deps.expertVersions.putOrGet(scope, {
      schemaVersion: 1,
      agentId,
      source: definitionFacts.source,
      agentType: "built_in",
      systemPrompt: definitionFacts.systemPrompt,
      behaviorVersion: BEHAVIOR_VERSION,
    });

    const admission: TrustedRunAdmission = {
      input: {
        threadId,
        clientMessageKey,
        messageDigest: digest,
        attachmentRefs: attachments,
        entrypoint: scope.entrypoint,
        forwardedProps,
      },
      agentId,
      expertVersionRef,
      routeRef: route.routeRef,
    };
    const run = await boundModelRouteContext.run(
      {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        principalId: scope.principalId,
        actorId: scope.actorId,
        threadId,
        agentId,
        routeRef: route.routeRef,
        maximumTokens: ceiling,
      },
      () => deps.runs.start(scope, admission),
    );

    let lease: RunnerRequestLease;
    try {
      lease = await deps.runs.acquireRequestLease(scope, run.run_id);
    } catch (cause) {
      // The run was admitted but no lease owner could be established: the
      // model never executed, so terminalize the run (timeout-cancel
      // semantics — the fenced failure path needs a lease we do not hold)
      // instead of leaving a queued-active row behind.
      await deps.runs
        .cancel(scope, { runId: run.run_id, reason: "timeout" })
        .catch(() => undefined);
      throw cause;
    }
    captured.scope = scope;
    captured.lease = lease;

    const timestamp = deps.now?.() ?? Date.now();
    const startedEvent: BaseEvent = {
      type: EventType.RUN_STARTED,
      threadId,
      runId: run.run_id,
      timestamp,
    };
    const state: RelayedRunState = {
      scope,
      lease,
      runId: run.run_id,
      threadId,
      carrier,
      terminalSettled: false,
      failureSettled: false,
      settlementAttempted: false,
      leaseLost: false,
      aborted: false,
      renewalTimer: null,
    };
    captured.state = state;
    this.registerActiveStream(state);
    await this.appendEvent(state, startedEvent);

    if (!carrier?.wasModelConsumed()) {
      // Outside a governed admission the production SSE path refuses model
      // execution: the run is admitted and settled as failed, nothing dials.
      return this.refuseModelExecution(state, startedEvent);
    }
    carrier.bind({
      runId: run.run_id,
      attemptId: lease.attemptId,
      generation: lease.generation,
    });
    this.startLeaseRenewal(state, captured);

    // PKG03B (T03-fix): the run's pinned Skill read — the production call
    // site. The run identity comes from THIS admission, never from a wire
    // field, and every read revalidates pin ∩ active grant ∩ membership with
    // zero cache (a revoked grant or membership refuses the very next read).
    // A run with pins re-resolves its executing agent so the pinned package
    // skills join its catalogue; a run without pins keeps the already-built
    // agent exactly as it was — the legacy contract untouched, nothing
    // downgraded. A failed read fails closed to the empty set: skills narrow
    // the offer and never gate the run.
    let executing = resolvedAgent;
    if (deps.readPinnedSkills) {
      const pinned = await deps
        .readPinnedSkills(scope, {
          botId: agentId,
          runId: run.run_id,
          attemptGeneration: lease.generation,
        })
        .catch(() => []);
      if (pinned.length > 0) {
        const rebound = await deps.resolveBuiltInBotForActor(actor, agentId, {
          ...(carrier ? { governedModel: carrier.governedModel } : {}),
          pinnedPackageSkills: pinned,
        });
        if (rebound.definitionFacts.agentId === agentId) {
          executing = rebound.agent;
        }
      }
    }

    return concat(
      from([startedEvent]),
      executing.run(input).pipe(
        concatMap((event) => from(this.relayEvent(state, event))),
        catchError((error) => from(this.streamFailureEvent(state, error))),
        mergeMap((event) => (event ? from([event]) : EMPTY)),
      ),
    );
  }

  /** Track the live stream so a later stop() can abort its relay. */
  private registerActiveStream(state: RelayedRunState): void {
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => {
      state.aborted = true;
    });
    activeStreams.set(state.runId, controller);
  }

  /**
   * Keep every lease alive for as long as the stream is live: the renewal
   * extends the request claim AND the run/attempt main leases, and the
   * renewed lease is what later settlement answers to (HIGH-2). A renewal
   * the store refuses fails closed: no further events are written under a
   * claim that may belong to nobody.
   */
  private startLeaseRenewal(
    state: RelayedRunState,
    captured: {
      scope: PlatformScope | null;
      lease: RunnerRequestLease | null;
      state: RelayedRunState | null;
    },
  ): void {
    const leaseMilliseconds = this.deps.leaseMilliseconds ?? 30_000;
    // The default derives from the lease window (half of it, clamped to the
    // window): a fixed 15s would renew past expiry whenever the window is
    // shorter. An explicitly injected interval is an explicit instruction —
    // honored as-is down to 1ms (OCR R10).
    const interval =
      this.deps.renewalIntervalMilliseconds !== undefined
        ? Math.max(1, this.deps.renewalIntervalMilliseconds)
        : Math.min(
            Math.max(1_000, Math.floor(leaseMilliseconds / 2)),
            Math.max(leaseMilliseconds, 1_001),
          );
    const timer = setInterval(() => {
      void (async () => {
        if (
          state.leaseLost ||
          state.aborted ||
          state.terminalSettled ||
          state.failureSettled
        ) {
          if (state.renewalTimer) clearInterval(state.renewalTimer);
          return;
        }
        try {
          const renewed = await this.deps.runs.renewRequestLease(
            state.scope,
            state.lease,
          );
          state.lease = renewed;
          captured.lease = renewed;
        } catch {
          state.leaseLost = true;
          if (state.renewalTimer) clearInterval(state.renewalTimer);
        }
      })();
    }, interval);
    timer.unref?.();
    state.renewalTimer = timer;
  }

  /** The no-model refusal: persisted lifecycle events, then a failed attempt. */
  private async refuseModelExecution(
    state: RelayedRunState,
    startedEvent: BaseEvent,
  ): Promise<Observable<BaseEvent>> {
    const errorEvent: BaseEvent = {
      type: EventType.RUN_ERROR,
      message: "Model execution is not available for this Bot yet.",
      code: MODEL_EXECUTION_UNAVAILABLE,
    };
    await this.appendEvent(state, errorEvent);
    state.settlementAttempted = true;
    const settled = await this.deps.runs.fail(state.scope, {
      lease: state.lease,
      errorCode: MODEL_EXECUTION_UNAVAILABLE,
    });
    if (!settled) {
      // The fenced fail was refused (e.g. the lease already expired): the
      // cancel fallback still terminalizes, consistent with finalizeRun.
      await this.deps.runs
        .cancel(state.scope, { runId: state.runId, reason: "timeout" })
        .catch(() => undefined);
      throw new Error("RUN_FAILURE_SETTLEMENT_STALE");
    }
    state.terminalSettled = true;
    state.failureSettled = true;
    return from([startedEvent, errorEvent]);
  }

  /**
   * Persist one relayed event under the exact admitted owner before it is
   * published. An append failure best-effort fails the run — a stream whose
   * events cannot be persisted must never report success — and surfaces
   * either the append cause or, when even that settlement was stale, the
   * stale marker itself.
   */
  private async appendEvent(
    state: RelayedRunState,
    event: BaseEvent,
  ): Promise<void> {
    try {
      await this.deps.events.append(state.scope, {
        lease: state.lease,
        sourceEventId: randomUUID(),
        schemaVersion: 1,
        event,
      });
    } catch (cause) {
      if (!state.failureSettled && !state.terminalSettled) {
        state.failureSettled = true;
        state.settlementAttempted = true;
        const settled = await this.deps.runs
          .fail(state.scope, {
            lease: state.lease,
            errorCode: "MODEL_EXECUTION_FAILED",
          })
          .catch(() => false);
        if (!settled) throw new Error("RUN_EVENT_APPEND_SETTLEMENT_STALE");
      }
      throw cause;
    }
  }

  /**
   * Relay one agent event: persist it, then hand it back for publication.
   * Returns null for events that must not reach the wire — the agent's own
   * RUN_STARTED, which carries the client's run identity instead of the
   * persisted one, and any terminal after the run already settled.
   */
  private async relayEvent(
    state: RelayedRunState,
    event: BaseEvent,
  ): Promise<BaseEvent | null> {
    const type = (event as { type?: unknown }).type;
    if (type === EventType.RUN_STARTED) return null;
    if (state.terminalSettled || state.failureSettled) return null;
    // A stopped run drops everything after the cancel: the run no longer
    // exists, so its events must not be persisted either.
    if (state.aborted) return null;
    // A claim the store refused to renew may belong to nobody: surface the
    // loss through the stream failure path instead of writing more events.
    if (state.leaseLost) throw new Error("RUN_REQUEST_LEASE_STALE");

    if (type === EventType.RUN_ERROR) {
      const code = classifyGovernedRunFailure(state.carrier, event);
      const relayed = { ...event, code } as BaseEvent;
      await this.appendEvent(state, relayed);
      state.settlementAttempted = true;
      const settled = await this.deps.runs.fail(state.scope, {
        lease: state.lease,
        errorCode: code,
      });
      if (!settled) throw new Error("RUN_FAILURE_SETTLEMENT_STALE");
      state.terminalSettled = true;
      state.failureSettled = true;
      return relayed;
    }

    if (type === EventType.RUN_FINISHED) {
      const outcome = (event as { outcome?: unknown }).outcome;
      if (outcome !== undefined) {
        // A cancelled or interrupted run closes its stream but is never a
        // success: its own lifecycle (stop, resume) owns the outcome — so
        // verify that lifecycle terminalized it; an agent-emitted outcome
        // with no stop() must still settle, never linger active (OCR R10).
        const relayed = this.withServerRunIdentity(state, event);
        await this.appendEvent(state, relayed);
        state.settlementAttempted = true;
        state.terminalSettled = true;
        await this.deps.runs
          .stop(state.scope, {
            runId: state.runId,
            reason: "timeout",
            attemptId: state.lease.attemptId,
            generation: state.lease.generation,
          })
          .catch(async () => {
            await this.deps.runs
              .cancel(state.scope, { runId: state.runId, reason: "timeout" })
              .catch(() => undefined);
          });
        return relayed;
      }
      if (!state.carrier?.settlementClean()) {
        // A clean-looking finish without verified usage settlement fails
        // closed: no confirmed capability, no success.
        const code = classifyGovernedRunFailure(state.carrier, undefined);
        const relayed: BaseEvent = {
          type: EventType.RUN_ERROR,
          message:
            "Model usage could not be verified for this run, so it cannot be reported as succeeded.",
          code,
        };
        await this.appendEvent(state, relayed);
        state.settlementAttempted = true;
        const settled = await this.deps.runs.fail(state.scope, {
          lease: state.lease,
          errorCode: code,
        });
        if (!settled) throw new Error("RUN_FAILURE_SETTLEMENT_STALE");
        state.terminalSettled = true;
        state.failureSettled = true;
        return relayed;
      }
      const relayed = this.withServerRunIdentity(state, event);
      await this.appendEvent(state, relayed);
      state.settlementAttempted = true;
      const completed = await this.deps.runs.complete(state.scope, {
        lease: state.lease,
      });
      if (!completed) throw new Error("RUN_COMPLETION_SETTLEMENT_STALE");
      state.terminalSettled = true;
      return relayed;
    }

    await this.appendEvent(state, event);
    return event;
  }

  /** An errored stream with no agent terminal: fail it truthfully, once. */
  private async streamFailureEvent(
    state: RelayedRunState,
    error: unknown,
  ): Promise<BaseEvent | null> {
    if (state.terminalSettled) {
      // The agent already delivered a terminal we settled under; its
      // trailing error is redundant noise, not a second outcome.
      return null;
    }
    if (state.failureSettled) throw error;
    if (error instanceof Error && error.message.includes("SETTLEMENT_STALE")) {
      // A settlement the store refused is a delivery failure, not a run
      // failure: the marker must reach the subscriber unmolested and must
      // not trigger a second, contradictory settlement attempt.
      throw error;
    }
    const code = classifyGovernedRunFailure(state.carrier, error);
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown");
    const relayed: BaseEvent = {
      type: EventType.RUN_ERROR,
      message,
      code,
    };
    await this.appendEvent(state, relayed);
    state.settlementAttempted = true;
    const settled = await this.deps.runs.fail(state.scope, {
      lease: state.lease,
      errorCode: code,
    });
    if (!settled) throw new Error("RUN_FAILURE_SETTLEMENT_STALE");
    state.terminalSettled = true;
    state.failureSettled = true;
    return relayed;
  }

  /** Terminals publish under the persisted run identity, never the client's. */
  private withServerRunIdentity(
    state: RelayedRunState,
    event: BaseEvent,
  ): BaseEvent {
    return { ...event, threadId: state.threadId, runId: state.runId };
  }

  private async *connectEvents(
    connectRequest: AgentRunnerConnectRequest,
    signal: AbortSignal,
  ): AsyncGenerator<BaseEvent> {
    const threadId = threadIdFrom(connectRequest?.threadId);
    const scope = await this.deps.scopeResolver.resolveForThread(
      this.request,
      threadId,
    );
    const records = this.deps.events.subscribe(
      scope,
      { threadId, afterSeq: 0 },
      signal,
    );
    for await (const record of records) yield record.event;
  }

  /**
   * The single finalize path for every stream teardown — completion, error,
   * or client disconnect. No run may be left active: when no terminal ever
   * settled it, the fallback settlement closes it truthfully (never as
   * success), falling back to an unleassed timeout-cancel when the fenced
   * failure is refused. The renewal loop and stream registration are
   * cleaned up, then the latest lease is released (HIGH-3).
   */
  private finalizeRun(captured: {
    scope: PlatformScope | null;
    lease: RunnerRequestLease | null;
    state: RelayedRunState | null;
  }): void {
    const { scope, state } = captured;
    const lease = state?.lease ?? captured.lease;
    if (state) {
      if (state.renewalTimer) clearInterval(state.renewalTimer);
      activeStreams.delete(state.runId);
      if (
        scope &&
        lease &&
        !state.settlementAttempted &&
        !state.terminalSettled &&
        !state.failureSettled
      ) {
        state.settlementAttempted = true;
        state.failureSettled = true;
        void this.deps.runs
          .fail(scope, { lease, errorCode: "MODEL_EXECUTION_FAILED" })
          .catch(() => false)
          .then((settled) => {
            if (settled) return undefined;
            return this.deps.runs
              .cancel(scope, { runId: state.runId, reason: "timeout" })
              .catch(() => undefined);
          });
      }
    }
    if (scope && lease) {
      void this.deps.runs
        .releaseRequestLease(scope, lease)
        .catch(() => undefined);
    }
    captured.scope = null;
    captured.lease = null;
    captured.state = null;
  }
}

export function createProductionRunner(
  deps: ProductionRunnerDependencies,
): (request: Request) => AgentRunner {
  return (request: Request) => new DurableProductionRunner(deps, request);
}

export interface ProductionRunnerCompositionDependencies {
  readonly data: DataDatabase;
  readonly scopeResolver: ScopeResolver;
  readonly conversations: ConversationService;
  readonly identifyActor: (request: Request) => Promise<AgentActor>;
  readonly resolver: Pick<ActorAgentResolver, "resolveBuiltInBotForActor">;
  readonly modelSelection: () => ProductionModelSelection;
  readonly modelCapabilitySecret: string | Uint8Array;
  /** Decrypts the admitted route's credential reference for the gateway dial. */
  readonly credentialEncryptionKey: string;
  /** The encrypted credential reader the gateway resolves api keys through. */
  readonly credentialReader: ModelCredentialSecretReader;
  readonly leaseMilliseconds?: number;
  readonly pollMilliseconds?: number;
  /** Environment the gateway dial sees; defaults to the process environment. */
  readonly gatewayEnvironment?: Record<string, string | undefined>;
  /** Upstream fetch for the gateway dial; defaults to the runtime's fetch. */
  readonly modelFetch?: typeof fetch;
  /**
   * PKG03B: package runtime `prepareWithin`, forwarded to the run service so
   * enterprise runs pin package grants in the run transaction (Spec §9).
   */
  readonly preparePackageRun?: RunServiceDependencies["preparePackageRun"];
  /**
   * PKG03B (T03-fix): package runtime `readPinnedSkills`, forwarded to the
   * Runner so every admitted run's Skill read goes through the pin ∩ active
   * grant ∩ membership revalidation. The composition passes BOTH seams from
   * the SAME `createPackageRuntime` instance.
   */
  readonly readPinnedSkills?: ProductionRunnerDependencies["readPinnedSkills"];
}

export interface ProductionRunnerComposition {
  readonly runnerForRequest: (request: Request) => AgentRunner;
  readonly runs: RunService;
  readonly events: EventService;
  readonly expertVersions: ExpertVersionCatalog;
  readonly modelRoutes: ModelRouteCatalogStore;
}

/**
 * Build the durable Runner and every service it admits through, sharing the
 * already-verified Data capability with the conversation routes. The Run
 * service's route dependency is the request-bound producer above, so an
 * admission outside a governed Runner context cannot conjure a route.
 */
export function createProductionRunnerComposition(
  deps: ProductionRunnerCompositionDependencies,
): ProductionRunnerComposition {
  const expertVersions = new ExpertVersionCatalog(deps.data);
  const modelRoutes = new ModelRouteCatalogStore(
    deps.data,
    deps.modelCapabilitySecret,
  );
  const events = createRunnerEventService({
    repository: createDrizzleRunnerEventRepository(deps.data),
    // MT007（Issue #50）：生产装配总是带上撤权检查点——事件流面
    // （replay/subscribe）对已签发 Scope 在每次读取前重验两级成员资格。
    revocation: createRevocationGuard(deps.data),
    ...(deps.pollMilliseconds !== undefined
      ? { pollMilliseconds: deps.pollMilliseconds }
      : {}),
  });
  const runs = createRunService({
    data: deps.data,
    conversations: deps.conversations,
    expertVersions,
    modelRouteFor: requestBoundModelRouteFor,
    modelCapabilitySecret: deps.modelCapabilitySecret,
    ...(deps.preparePackageRun
      ? { preparePackageRun: deps.preparePackageRun }
      : {}),
    ...(deps.leaseMilliseconds !== undefined
      ? { leaseMilliseconds: deps.leaseMilliseconds }
      : {}),
  });
  const runnerForRequest = createProductionRunner({
    scopeResolver: deps.scopeResolver,
    conversations: deps.conversations,
    runs,
    events,
    expertVersions,
    modelRoutes,
    resolveBuiltInBotForActor: (actor, agentId, context) =>
      deps.resolver.resolveBuiltInBotForActor(actor, agentId, context),
    identifyActor: deps.identifyActor,
    modelSelection: deps.modelSelection,
    modelCapabilitySecret: deps.modelCapabilitySecret,
    credentialEncryptionKey: deps.credentialEncryptionKey,
    credentialReader: deps.credentialReader,
    ...(deps.gatewayEnvironment !== undefined
      ? { gatewayEnvironment: deps.gatewayEnvironment }
      : {}),
    ...(deps.modelFetch ? { modelFetch: deps.modelFetch } : {}),
    ...(deps.leaseMilliseconds !== undefined
      ? { leaseMilliseconds: deps.leaseMilliseconds }
      : {}),
    ...(deps.readPinnedSkills
      ? { readPinnedSkills: deps.readPinnedSkills }
      : {}),
  });
  return { runnerForRequest, runs, events, expertVersions, modelRoutes };
}
