import { describe, expect, it } from "../../../tests/support/e2e-compat";
import { createHash } from "node:crypto";
import type { AbstractAgent, BaseEvent } from "@ag-ui/client";
import type {
  AgentRunnerRunRequest,
  AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import type { Observable } from "rxjs";
import {
  concat,
  concatMap,
  firstValueFrom,
  from as fromRx,
  take,
  throwError,
  toArray,
} from "rxjs";
import type { ActorAgentResolver } from "../../src/agents/agent-resolver";
import {
  CoworkerUnavailableError,
  createActorAgentResolver,
} from "../../src/agents/agent-resolver";
import type { AgentActor } from "../../src/agents/profile-types";
import type { DeploymentConfig } from "../../src/config";
import { mountCopilotRuntime } from "../../src/copilot";
import type { Database } from "../../src/db/client";
import type {
  ConversationService,
  EventService,
  ModelInvocationCapabilityInput,
  PlatformScope,
  RunnerEventRecord,
  RunnerRequestLease,
  RunService,
  TrustedRunAdmission,
} from "../../src/enterprise/contracts";
import { messageDigest } from "../../src/enterprise/conversations/store";
import { ModelInvocationError } from "../../src/enterprise/runs/model-capability";
import {
  type CanonicalModelRouteSnapshot,
  canonicalizeModelRouteSnapshot,
  type ModelRouteSnapshotInput,
} from "../../src/enterprise/runs/model-route-catalog";
import { withRunnerRequestContext } from "../../src/enterprise/runs/request-context";
import {
  createProductionRunner,
  createProductionRunnerComposition,
  type ProductionRunnerDependencies,
  requestBoundModelRouteFor,
} from "../../src/enterprise/runs/runner";
import { RunDomainError } from "../../src/enterprise/runs/store";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
} from "../../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";
import { type GrantedTool, parametersFor } from "../../src/plugins/tools";

const capabilityCheck = {
  current_user_matches: true,
  capability_attributes_ok: true,
  login_attributes_ok: true,
  login_has_expected_capability: true,
  capability_has_no_escalation_membership: true,
  login_has_no_other_memberships: true,
  no_protected_ownership: true,
  login_has_no_enterprise_privileges: true,
};

type Collected<T> = { values: T[]; error?: Error; complete: boolean };

function collect<T>(observable: Observable<T>): Promise<Collected<T>> {
  return new Promise((resolve) => {
    const values: T[] = [];
    let error: Error | undefined;
    observable.subscribe({
      next: (value) => values.push(value),
      error: (cause) => {
        error = cause instanceof Error ? cause : new Error(String(cause));
        resolve({ values, error, complete: false });
      },
      complete: () => resolve({ values, error, complete: true }),
    });
  });
}

function scopeFor(actorId: string): PlatformScope {
  return {
    tenantId: `tenant-${actorId}`,
    workspaceId: `workspace-${actorId}`,
    principalId: `principal-${actorId}`,
    actorId,
    memberEpoch: 1,
    aclEpoch: 1,
    entrypoint: "web",
  };
}

function requestFor(
  actorId: string,
  extraHeaders: Record<string, string> = {},
) {
  return new Request("https://example.invalid/api/copilotkit/agent/bot-a/run", {
    headers: { "x-test-actor": actorId, ...extraHeaders },
  });
}

/**
 * The real scope resolver over a synthetic directory: the only way to mint a
 * scope `assertTrustedScope` accepts, exactly as production admissions do.
 */
async function trustedScopeFor(actorId: string): Promise<PlatformScope> {
  const database = {
    execute: async () => [capabilityCheck],
    transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        execute: async () => [],
        select: () => {
          const query = {
            from: () => query,
            innerJoin: () => query,
            where: () => query,
            limit: async () => [
              {
                tenantId: `tenant-${actorId}`,
                principalId: `principal-${actorId}`,
                tenantStatus: "active",
                principalStatus: "active",
                memberStatus: "active",
                memberEpoch: 1,
              },
            ],
          };
          return query;
        },
      }),
  } as unknown as Database;
  const directory = await verifyDirectoryDatabase(database);
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId, entrypoint: "web" }),
    selectTenant: () => `tenant-${actorId}`,
    selectWorkspace: () => `workspace-${actorId}`,
  });
  return resolver.resolve(new Request("https://example.invalid"));
}

function syntheticScopeResolver() {
  const state: { request: Request; threadId: string }[] = [];
  const trusted = new Map<string, PlatformScope>();
  const resolver = {
    async resolve() {
      throw new Error("NOT_USED_IN_RUNNER_TESTS");
    },
    async resolveForThread(request: Request, threadId: string) {
      state.push({ request, threadId });
      // Authority is the authenticated actor. A tenant/workspace header may only
      // select among that actor's own memberships; the fixture answers with the
      // actor's single membership no matter what a foreign selector claims.
      const actorId = request.headers.get("x-test-actor") ?? "actor-a";
      let scope = trusted.get(actorId);
      if (!scope) {
        scope = await trustedScopeFor(actorId);
        trusted.set(actorId, scope);
      }
      return scope;
    },
  };
  return { resolver, state };
}

function syntheticConversations(behavior: { appendError?: Error } = {}) {
  const state: { scope: PlatformScope; input: unknown }[] = [];
  const service = {
    async append(
      scope: PlatformScope,
      input: {
        threadId: string;
        clientMessageKey: string;
        content: string;
        attachments: string[];
      },
    ) {
      state.push({ scope, input });
      if (behavior.appendError) throw behavior.appendError;
      return {
        messageId: `m-${state.length}`,
        threadId: input.threadId,
        seq: state.length,
        role: "user" as const,
        content: input.content,
        attachments: input.attachments,
        createdAt: new Date().toISOString(),
      };
    },
  };
  return { service: service as unknown as ConversationService, state };
}

function hashRef(prefix: string, value: string) {
  return `${prefix}:${createHash("sha256").update(value).digest("hex")}`;
}

type RunsOptions = {
  startError?: Error;
  failResult?: boolean;
  completeResult?: boolean;
  confirmUsageError?: Error;
  issueCapabilityError?: Error;
  active?: { runId: string; attemptId: string; generation: number } | null;
  stopError?: Error;
  modelRouteFor?: typeof requestBoundModelRouteFor;
  tamperTenantId?: string;
  tamperThreadId?: string;
  /** Optional production-shaped renewal: may throw to simulate lease loss. */
  renewalLease?: (
    lease: RunnerRequestLease,
    count: number,
  ) => RunnerRequestLease;
  acquireLeaseError?: Error;
};

function syntheticRuns(options: RunsOptions = {}) {
  const state: {
    started: {
      scope: PlatformScope;
      admission: TrustedRunAdmission;
      runId: string;
    }[];
    leases: { scope: PlatformScope; runId: string }[];
    failed: {
      scope: PlatformScope;
      lease: RunnerRequestLease;
      errorCode: string;
    }[];
    completions: { scope: PlatformScope; lease: RunnerRequestLease }[];
    released: { scope: PlatformScope; lease: RunnerRequestLease }[];
    renewed: {
      scope: PlatformScope;
      lease: RunnerRequestLease;
      count: number;
    }[];
    cancelled: { scope: PlatformScope; input: unknown }[];
    stopped: { scope: PlatformScope; input: unknown }[];
    activeLookups: { scope: PlatformScope; threadId: string }[];
    capabilitiesIssued: {
      scope: PlatformScope;
      input: ModelInvocationCapabilityInput;
    }[];
    capabilitiesResolved: { scope: PlatformScope; capability: string }[];
    capabilitiesConfirmed: {
      scope: PlatformScope;
      capability: string;
      usedTokens: number;
    }[];
    capabilitiesUnknown: { scope: PlatformScope; capability: string }[];
  } = {
    started: [],
    leases: [],
    failed: [],
    completions: [],
    released: [],
    renewed: [],
    cancelled: [],
    stopped: [],
    activeLookups: [],
    capabilitiesIssued: [],
    capabilitiesResolved: [],
    capabilitiesConfirmed: [],
    capabilitiesUnknown: [],
  };
  const minted = new Map<
    string,
    { scope: PlatformScope; input: ModelInvocationCapabilityInput }
  >();
  let capabilitySeed = 0;
  const service: RunService = {
    async start(scope, admission) {
      // Mirror the accepted RunService seam: the admission route ref must match
      // what the request-bound route producer issues for this exact scope/thread.
      const routeFor = options.modelRouteFor ?? requestBoundModelRouteFor;
      const route = await routeFor(
        options.tamperTenantId
          ? { ...scope, tenantId: options.tamperTenantId }
          : scope,
        options.tamperThreadId ?? admission.input.threadId,
      );
      if (route.routeRef !== admission.routeRef)
        throw new Error("RUN_ROUTE_MISMATCH");
      const runId = `server-run-${state.started.length + 1}`;
      state.started.push({ scope, admission, runId });
      if (options.startError) throw options.startError;
      return {
        run_id: runId,
        thread_id: admission.input.threadId,
        status: "queued",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    },
    async getActiveForThread(scope, threadId) {
      state.activeLookups.push({ scope, threadId });
      if (!options.active) return null;
      if (options.active.runId === "thread-mismatch") return null;
      return {
        run: {
          run_id: options.active.runId,
          thread_id: threadId,
          status: "running",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        attemptId: options.active.attemptId,
        generation: options.active.generation,
      };
    },
    async cancel(scope, input) {
      state.cancelled.push({ scope, input });
      return {
        run_id: input.runId,
        thread_id: "",
        status: "cancelled",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    },
    async stop(scope, input) {
      state.stopped.push({ scope, input });
      if (options.stopError) throw options.stopError;
      return {
        run_id: input.runId,
        thread_id: "",
        status: "cancelled",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    },
    async acquireRequestLease(scope, runId) {
      state.leases.push({ scope, runId });
      if (options.acquireLeaseError) throw options.acquireLeaseError;
      return {
        runId,
        attemptId: `attempt-${runId}`,
        generation: 1,
        ownerToken: `owner-${runId}-${state.leases.length}`,
        expiresAt: new Date(Date.now() + 60_000),
      };
    },
    async renewRequestLease(scope, lease) {
      state.renewed.push({ scope, lease, count: state.renewed.length + 1 });
      if (options.renewalLease)
        return options.renewalLease(lease, state.renewed.length);
      return lease;
    },
    async releaseRequestLease(scope, lease) {
      state.released.push({ scope, lease });
      return true;
    },
    async fail(scope, input) {
      state.failed.push({
        scope,
        lease: input.lease,
        errorCode: input.errorCode,
      });
      return options.failResult ?? true;
    },
    async complete(scope, input) {
      state.completions.push({ scope, lease: input.lease });
      return options.completeResult ?? true;
    },
    async get() {
      throw new Error("NOT_USED_IN_RUNNER_TESTS");
    },
    async getActiveAttemptGeneration() {
      throw new Error("NOT_USED_IN_RUNNER_TESTS");
    },
    async reserveModelBudget() {
      throw new Error("NOT_USED_IN_RUNNER_TESTS");
    },
    async issueModelInvocationCapability(scope, input) {
      state.capabilitiesIssued.push({ scope, input });
      if (options.issueCapabilityError) throw options.issueCapabilityError;
      const capability = Buffer.alloc(32, ++capabilitySeed).toString(
        "base64url",
      );
      minted.set(capability, { scope, input });
      return {
        capability,
        model_request_id: input.modelRequestId,
        maximum_tokens: input.maximumTokens,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async resolveModelInvocationCapability(scope, capability) {
      state.capabilitiesResolved.push({ scope, capability });
      const entry = minted.get(capability);
      if (!entry)
        throw new ModelInvocationError("MODEL_CAPABILITY_INVALID", 401);
      // The real service reads the run row: route ref and scope come from the
      // persisted run this capability was issued for, never the wire request.
      const started = [...state.started]
        .reverse()
        .find(
          (candidate) =>
            candidate.runId === entry.input.runId &&
            candidate.scope.tenantId === entry.scope.tenantId,
        );
      if (!started)
        throw new ModelInvocationError("MODEL_CAPABILITY_INVALID", 401);
      return {
        tenantId: entry.scope.tenantId,
        workspaceId: entry.scope.workspaceId,
        principalId: entry.scope.principalId,
        runId: entry.input.runId,
        attemptId: entry.input.attemptId,
        generation: entry.input.generation,
        modelRouteRef: started.admission.routeRef,
        modelRequestId: entry.input.modelRequestId,
        maximumTokens: entry.input.maximumTokens,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async confirmModelInvocationUsage(scope, capability, usedTokens) {
      state.capabilitiesConfirmed.push({ scope, capability, usedTokens });
      if (options.confirmUsageError) throw options.confirmUsageError;
    },
    async markModelInvocationUnknown(scope, capability) {
      state.capabilitiesUnknown.push({ scope, capability });
    },
    async releaseModelInvocation() {
      throw new Error("NOT_USED_IN_RUNNER_TESTS");
    },
  };
  return { service, state };
}

function eventRecord(
  threadId: string,
  seq: number,
  event: BaseEvent,
): RunnerEventRecord {
  return {
    eventId: `event-${seq}`,
    tenantId: `tenant-actor-a`,
    workspaceId: `workspace-actor-a`,
    principalId: `principal-actor-a`,
    threadId,
    runId: "server-run-1",
    attemptId: "attempt-1",
    generation: 1,
    sourceEventId: `source-${seq}`,
    seq,
    schemaVersion: 1,
    event,
    createdAt: new Date().toISOString(),
  };
}

function syntheticEvents(seed: RunnerEventRecord[] = []) {
  const state: {
    appends: {
      scope: PlatformScope;
      proposal: {
        lease: RunnerRequestLease;
        sourceEventId: string;
        event: BaseEvent;
      };
    }[];
    subscribes: { scope: PlatformScope; threadId: string; afterSeq: number }[];
  } = { appends: [], subscribes: [] };
  const service: EventService = {
    async append(scope, proposal) {
      state.appends.push({ scope, proposal });
      return {
        eventId: `event-${state.appends.length}`,
        seq: state.appends.length,
        duplicate: false,
      };
    },
    async replay() {
      throw new Error("NOT_USED_IN_RUNNER_TESTS");
    },
    subscribe(scope, input, signal) {
      state.subscribes.push({
        scope,
        threadId: input.threadId,
        afterSeq: input.afterSeq,
      });
      const records = seed.filter(
        (record) =>
          record.threadId === input.threadId && record.seq > input.afterSeq,
      );
      return (async function* () {
        for (const record of records) yield record;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve());
        });
      })();
    },
  };
  return { service, state };
}

function syntheticCatalogs(
  options: { modelCapabilitySecret?: string; onRouteGet?: () => void } = {},
) {
  const experts: { scope: PlatformScope; definition: { agentId: string } }[] =
    [];
  const routes: {
    scope: PlatformScope;
    input: { agentId: string; route: unknown };
  }[] = [];
  const routeStore = new Map<string, CanonicalModelRouteSnapshot>();
  const secret =
    options.modelCapabilitySecret ??
    "test-only-model-capability-secret-000000000000000000000000000000";
  return {
    expertVersions: {
      async putOrGet(scope: PlatformScope, definition: { agentId: string }) {
        experts.push({ scope, definition });
        return hashRef("expert:v1", `${scope.tenantId}:${definition.agentId}`);
      },
    },
    modelRoutes: {
      async put(
        scope: PlatformScope,
        input: ModelRouteSnapshotInput,
      ): Promise<CanonicalModelRouteSnapshot> {
        routes.push({ scope, input });
        const canonical = canonicalizeModelRouteSnapshot(
          scope.tenantId,
          input,
          secret,
        );
        routeStore.set(canonical.routeRef, canonical);
        return canonical;
      },
      async get(
        scope: PlatformScope,
        routeRef: string,
      ): Promise<CanonicalModelRouteSnapshot | null> {
        options.onRouteGet?.();
        void scope;
        return routeStore.get(routeRef) ?? null;
      },
    },
    experts,
    routes,
    routeStore,
  };
}

function agentRunsSpy() {
  const calls: unknown[] = [];
  const agent = {
    agentId: "bot-a",
    run(input: unknown) {
      calls.push(input);
      return { subscribe() {} } as never;
    },
  };
  return { agent: agent as unknown as AbstractAgent, calls };
}

function runRequest(
  overrides: {
    agentId?: string;
    messages?: unknown[];
    forwardedProps?: unknown;
    threadId?: string;
  } = {},
): AgentRunnerRunRequest {
  return {
    threadId: overrides.threadId ?? "thread-1",
    agent: {
      agentId: overrides.agentId ?? "bot-a",
    },
    input: {
      threadId: overrides.threadId ?? "thread-1",
      runId: "client-run-1",
      messages: overrides.messages ?? [
        { id: "msg-1", role: "user", content: "hello" },
      ],
      tools: [],
      context: [],
      forwardedProps: Object.hasOwn(overrides, "forwardedProps")
        ? overrides.forwardedProps
        : { maxOutputTokens: 1024 },
    },
  } as never as AgentRunnerRunRequest;
}

function runnerDeps(
  overrides: {
    conversations?: ReturnType<typeof syntheticConversations>;
    runs?: ReturnType<typeof syntheticRuns>;
    events?: ReturnType<typeof syntheticEvents>;
    catalogs?: ReturnType<typeof syntheticCatalogs>;
    identifyActor?: (request: Request) => Promise<AgentActor>;
    resolveBuiltInBotForActor?: ProductionRunnerDependencies["resolveBuiltInBotForActor"];
    renewalIntervalMilliseconds?: number;
  } = {},
) {
  const scopes = syntheticScopeResolver();
  const conversations = overrides.conversations ?? syntheticConversations();
  const runs = overrides.runs ?? syntheticRuns();
  const events = overrides.events ?? syntheticEvents();
  const catalogs = overrides.catalogs ?? syntheticCatalogs();
  const resolverCalls: { actor: AgentActor; agentId: string }[] = [];
  const identifyCalls: Request[] = [];
  const deps: ProductionRunnerDependencies = {
    scopeResolver: scopes.resolver as never,
    conversations: conversations.service,
    runs: runs.service,
    events: events.service,
    expertVersions: catalogs.expertVersions as never,
    modelRoutes: catalogs.modelRoutes as never,
    resolveBuiltInBotForActor:
      overrides.resolveBuiltInBotForActor ??
      (async (actor, agentId) => {
        resolverCalls.push({ actor, agentId });
        if (agentId !== "bot-a") {
          throw new CoworkerUnavailableError(
            `Coworker ${agentId} is unavailable to this user.`,
          );
        }
        return {
          agent: {} as AbstractAgent,
          definitionFacts: {
            agentId,
            source: "tenant_package",
            systemPrompt: "Follow the registered Bot instructions.",
          },
        };
      }),
    identifyActor:
      overrides.identifyActor ??
      (async (request) => {
        identifyCalls.push(request);
        return {
          id: request.headers.get("x-test-actor") ?? "actor-a",
          role: "user",
        };
      }),
    modelSelection: () => ({
      route: {
        model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
        credentialSecretRef: "cred-1",
      },
      maximumTokens: 4096,
    }),
    ...(overrides.renewalIntervalMilliseconds !== undefined
      ? { renewalIntervalMilliseconds: overrides.renewalIntervalMilliseconds }
      : {}),
  };
  return {
    deps,
    scopes,
    conversations,
    runs,
    events,
    catalogs,
    resolverCalls,
    identifyCalls,
  };
}

const eventTypes = (values: BaseEvent[]) => values.map((event) => event.type);

const GOVERNED_SECRET =
  "test-only-model-capability-secret-000000000000000000000000000000";
const GOVERNED_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const GOVERNED_ENVIRONMENT: Record<string, string | undefined> = {
  OPENAI_BASE_URL: "https://provider.example/v1",
  BOT_MODEL: "evil/model",
  BOT_PROVIDER: "anthropic",
  OPENAI_API_KEY: "sk-env-fallback",
};

function sseText(text: string, id = "upstream") {
  return new Response(
    [
      `data: ${JSON.stringify({
        id,
        choices: [
          { index: 0, delta: { role: "assistant" }, finish_reason: null },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        id,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id,
        choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function sseToolCall(id: string, callId: string) {
  return new Response(
    [
      `data: ${JSON.stringify({
        id,
        choices: [
          { index: 0, delta: { role: "assistant" }, finish_reason: null },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        id,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: callId,
                  type: "function",
                  function: {
                    name: "lookup",
                    arguments: '{"query":"x"}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        id,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id,
        choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

type GovernedFixtureOptions = {
  fetch?: (request: Request, call: number) => Promise<Response> | Response;
  runs?: ReturnType<typeof syntheticRuns>;
  tools?: GrantedTool[];
  onRouteGet?: () => void;
  /** Replaces the real resolver chain with an agent that consumes the collaborator itself. */
  cannedAgent?: AbstractAgent;
  forwardedProps?: unknown;
  renewalIntervalMilliseconds?: number;
};

function governedRunnerDeps(options: GovernedFixtureOptions = {}) {
  const scopes = syntheticScopeResolver();
  const conversations = syntheticConversations();
  const runs = options.runs ?? syntheticRuns();
  const events = syntheticEvents();
  const catalogs = syntheticCatalogs({
    modelCapabilitySecret: GOVERNED_SECRET,
    onRouteGet: options.onRouteGet,
  });
  const selection: ModelRouteSnapshotInput = {
    agentId: "bot-a",
    route: {
      model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
      credentialSecretRef: "cred-1",
    },
    nativeBaseUrl: "https://provider.example/v1",
  };
  const credentialReads: { provider: string; keyId: string }[] = [];
  const fetchCalls: { request: Request; body: unknown }[] = [];
  let fetchCallCount = 0;
  const resolver = createActorAgentResolver({
    loadAgents: async () => [
      {
        id: "bot-a",
        name: "Bot A",
        type: "built_in",
        systemPrompt: "Follow the registered Bot instructions.",
        expertSource: "tenant_package",
      },
    ],
    model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
    resolveModelApiKey: async () => {
      throw new Error("GOVERNED_ADMISSION_MUST_NOT_READ_MODEL_KEYS");
    },
    ...(options.tools
      ? {
          loadToolsForActor: () => async () => options.tools as GrantedTool[],
        }
      : {}),
  });
  const deps: ProductionRunnerDependencies = {
    scopeResolver: scopes.resolver as never,
    conversations: conversations.service,
    runs: runs.service,
    events: events.service,
    expertVersions: catalogs.expertVersions as never,
    modelRoutes: catalogs.modelRoutes as never,
    resolveBuiltInBotForActor: options.cannedAgent
      ? async (actor, agentId, context) => {
          context?.governedModel?.markConsumed();
          void actor;
          return {
            agent: options.cannedAgent,
            definitionFacts: {
              agentId,
              source: "tenant_package",
              systemPrompt: "Follow the registered Bot instructions.",
            },
          };
        }
      : (actor, agentId, context) =>
          resolver.resolveBuiltInBotForActor(actor, agentId, context),
    identifyActor: async (request) => ({
      id: request.headers.get("x-test-actor") ?? "actor-a",
      role: "user",
    }),
    modelSelection: () => ({
      route: selection.route,
      ...(selection.nativeBaseUrl !== undefined
        ? { nativeBaseUrl: selection.nativeBaseUrl }
        : {}),
    }),
    modelCapabilitySecret: GOVERNED_SECRET,
    credentialEncryptionKey: GOVERNED_ENCRYPTION_KEY,
    credentialReader: {
      readModelSecret: async (input) => {
        credentialReads.push({
          provider: input.provider,
          keyId: input.keyId,
        });
        return null;
      },
    },
    gatewayEnvironment: GOVERNED_ENVIRONMENT,
    ...(options.renewalIntervalMilliseconds !== undefined
      ? { renewalIntervalMilliseconds: options.renewalIntervalMilliseconds }
      : {}),
    modelFetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      fetchCallCount++;
      fetchCalls.push({
        request,
        body: await request
          .clone()
          .json()
          .catch(() => null),
      });
      return options.fetch
        ? await options.fetch(request, fetchCallCount)
        : sseText("governed answer");
    }) as typeof fetch,
  };
  return {
    deps,
    scopes,
    conversations,
    runs,
    events,
    catalogs,
    selection,
    credentialReads,
    fetchCalls,
  };
}

function collectOrdered<T>(
  observable: Observable<T>,
  order: string[],
  describe: (value: T) => string,
): Promise<Collected<T>> {
  return new Promise((resolve) => {
    const values: T[] = [];
    let error: Error | undefined;
    observable.subscribe({
      next: (value) => {
        values.push(value);
        order.push(describe(value));
      },
      error: (cause) => {
        error = cause instanceof Error ? cause : new Error(String(cause));
        resolve({ values, error, complete: false });
      },
      complete: () => resolve({ values, error, complete: true }),
    });
  });
}

function cannedAgent(events: BaseEvent[], error?: Error): AbstractAgent {
  return {
    agentId: "bot-a",
    run: () =>
      error
        ? concat(
            fromRx(events),
            throwError(() => error),
          )
        : fromRx(events),
  } as unknown as AbstractAgent;
}

describe("production runner run admission", () => {
  it("executes_finalized_intent_through_the_governed_gateway_and_completes_after_settlement", async () => {
    const order: string[] = [];
    const fixture = governedRunnerDeps();
    const baseAppend = fixture.events.service.append.bind(
      fixture.events.service,
    );
    fixture.events.service.append = async (scope, proposal) => {
      const ack = await baseAppend(scope, proposal);
      order.push(`append:${proposal.event.type}`);
      return ack;
    };
    const baseComplete = fixture.runs.service.complete.bind(
      fixture.runs.service,
    );
    fixture.runs.service.complete = async (scope, input) => {
      const result = await baseComplete(scope, input);
      order.push(`complete:${input.lease.runId}`);
      return result;
    };
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");

    const outcome = await withRunnerRequestContext(request, async () =>
      collectOrdered(
        runner(request).run(runRequest()),
        order,
        (event) => `emit:${event.type}`,
      ),
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.complete).toBe(true);
    const types = eventTypes(outcome.values);
    expect(types[0]).toBe("RUN_STARTED");
    expect(types.at(-1)).toBe("RUN_FINISHED");
    expect(types).not.toContain("RUN_ERROR");
    const started = outcome.values[0] as { threadId: string; runId: string };
    expect(started.threadId).toBe("thread-1");
    expect(started.runId).toBe("server-run-1");

    // RUN_STARTED is persisted before it is published; the final RUN_FINISHED
    // is persisted, then the run completed, and only then published.
    const firstAppend = order.indexOf("append:RUN_STARTED");
    const firstEmit = order.indexOf("emit:RUN_STARTED");
    const finalAppend = order.lastIndexOf("append:RUN_FINISHED");
    const completion = order.indexOf("complete:server-run-1");
    const finalEmit = order.lastIndexOf("emit:RUN_FINISHED");
    expect(firstAppend).toBeGreaterThanOrEqual(0);
    expect(firstAppend).toBeLessThan(firstEmit);
    expect(finalAppend).toBeGreaterThan(-1);
    expect(finalAppend).toBeLessThan(completion);
    expect(completion).toBeLessThan(finalEmit);

    // The client's runId never becomes the run identity on any terminal.
    const terminal = outcome.values.at(-1) as { runId?: string };
    expect(terminal.runId).toBe("server-run-1");

    // Message append used the submitted user message identity.
    expect(fixture.conversations.state).toHaveLength(1);
    expect(fixture.conversations.state[0].input).toEqual({
      threadId: "thread-1",
      clientMessageKey: "msg-1",
      content: "hello",
      attachments: [],
    });

    // Server-issued admission carries digest + both refs for the same Bot.
    const admission = fixture.runs.state.started[0].admission;
    const { digest } = messageDigest("hello", []);
    expect(admission).toEqual({
      input: {
        threadId: "thread-1",
        clientMessageKey: "msg-1",
        messageDigest: digest,
        attachmentRefs: [],
        entrypoint: "web",
        forwardedProps: { maxOutputTokens: 1024 },
      },
      agentId: "bot-a",
      expertVersionRef: hashRef("expert:v1", "tenant-actor-a:bot-a"),
      routeRef: canonicalizeModelRouteSnapshot(
        "tenant-actor-a",
        {
          agentId: "bot-a",
          route: {
            model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
            credentialSecretRef: "cred-1",
          },
          nativeBaseUrl: "https://provider.example/v1",
        },
        GOVERNED_SECRET,
      ).routeRef,
    });
    expect(fixture.catalogs.experts[0].definition).toEqual({
      schemaVersion: 1,
      agentId: "bot-a",
      source: "tenant_package",
      agentType: "built_in",
      systemPrompt: "Follow the registered Bot instructions.",
      behaviorVersion: "openbot-builtin-v1",
    });
    expect(fixture.catalogs.routes[0].input.agentId).toBe("bot-a");

    // One governed gateway call: capability issued, resolved, and confirmed
    // for exactly this run, with the upstream dial on the admitted route.
    expect(fixture.runs.state.capabilitiesIssued).toHaveLength(1);
    expect(fixture.runs.state.capabilitiesIssued[0].input.runId).toBe(
      "server-run-1",
    );
    expect(fixture.runs.state.capabilitiesIssued[0].input.maximumTokens).toBe(
      1024,
    );
    expect(fixture.runs.state.capabilitiesConfirmed).toHaveLength(1);
    expect(fixture.fetchCalls).toHaveLength(1);
    expect(fixture.fetchCalls[0].request.url).toBe(
      "https://provider.example/v1/chat/completions",
    );
    expect(fixture.fetchCalls[0].body).toMatchObject({
      model: "gpt-5.6-terra",
      max_tokens: 1024,
    });
    expect(fixture.fetchCalls[0].request.headers.get("authorization")).toBe(
      "Bearer sk-env-fallback",
    );

    // Completion happened exactly once under the exact admitted lease.
    expect(fixture.runs.state.completions).toHaveLength(1);
    expect(fixture.runs.state.completions[0].lease.runId).toBe("server-run-1");
    expect(fixture.runs.state.failed).toHaveLength(0);

    // Teardown released only this request's lease.
    expect(fixture.runs.state.released).toHaveLength(1);
    expect(fixture.runs.state.released[0].lease.runId).toBe("server-run-1");
  });

  it("two_tool_steps_issue_distinct_narrowed_capabilities_and_complete", async () => {
    const executions: unknown[] = [];
    const fixture = governedRunnerDeps({
      tools: [
        {
          name: "lookup",
          description: "Look things up",
          parameters: parametersFor({
            type: "object",
            properties: { query: { type: "string" } },
          }),
          execute: async (input: unknown) => {
            executions.push(input);
            return "found";
          },
          ref: "server/tool_0",
        },
      ],
      fetch: (_request, call) =>
        call === 1 ? sseToolCall("s1", "call-1") : sseText("done", "s2"),
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");

    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.complete).toBe(true);
    expect(eventTypes(outcome.values).at(-1)).toBe("RUN_FINISHED");
    expect(executions).toEqual([{ query: "x" }]);
    // Step 1 spends the whole ceiling; step 2 is narrowed by settled usage.
    expect(
      fixture.runs.state.capabilitiesIssued.map(
        (entry) => entry.input.maximumTokens,
      ),
    ).toEqual([1024, 1018]);
    const requestIds = fixture.runs.state.capabilitiesIssued.map(
      (entry) => entry.input.modelRequestId,
    );
    expect(new Set(requestIds).size).toBe(2);
    expect(fixture.runs.state.capabilitiesConfirmed).toHaveLength(2);
    expect(fixture.runs.state.completions).toHaveLength(1);
    expect(fixture.runs.state.failed).toHaveLength(0);
  });

  it("refuses_model_execution_when_the_governed_collaborator_was_not_consumed", async () => {
    // A resolver that ignored the server-only collaborator must not silently
    // run an ungoverned model: the admission fails closed, nothing executes.
    const fixture = runnerDeps();
    const governedDeps: ProductionRunnerDependencies = {
      ...fixture.deps,
      modelCapabilitySecret: GOVERNED_SECRET,
      credentialEncryptionKey: GOVERNED_ENCRYPTION_KEY,
      credentialReader: {
        readModelSecret: async () => null,
      },
    };
    const runner = createProductionRunner(governedDeps);
    const request = requestFor("actor-a");
    const spy = agentRunsSpy();

    const outcome = await withRunnerRequestContext(request, async () =>
      collect(
        runner(request).run({ ...runRequest(), agent: spy.agent } as never),
      ),
    );
    expect(outcome.error).toBeUndefined();
    expect(eventTypes(outcome.values)).toEqual(["RUN_STARTED", "RUN_ERROR"]);
    const errored = outcome.values[1] as { code?: string };
    expect(errored.code).toBe("MODEL_EXECUTION_UNAVAILABLE");
    expect(fixture.runs.state.failed).toHaveLength(1);
    expect(fixture.runs.state.failed[0].errorCode).toBe(
      "MODEL_EXECUTION_UNAVAILABLE",
    );
    expect(fixture.runs.state.completions).toHaveLength(0);
    expect(spy.calls).toHaveLength(0);
  });

  it("route_drift_between_admission_and_gateway_fails_closed_before_credential_and_network", async () => {
    const fixture = governedRunnerDeps({
      onRouteGet: () => {
        // The first catalog read happens inside the gateway's route rebind:
        // the server's selection has drifted since the admission pinned it.
        fixture.selection.route = {
          model: { provider: "openai", defaultModel: "gpt-drifted" },
          credentialSecretRef: "cred-1",
        };
      },
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");

    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    expect(outcome.error).toBeUndefined();
    expect(eventTypes(outcome.values).at(-1)).toBe("RUN_ERROR");
    const errored = outcome.values.at(-1) as { code?: string };
    expect(errored.code).toBe("MODEL_EXECUTION_FAILED");
    expect(fixture.fetchCalls).toHaveLength(0);
    expect(fixture.credentialReads).toHaveLength(0);
    expect(fixture.runs.state.completions).toHaveLength(0);
    expect(fixture.runs.state.failed).toHaveLength(1);
    expect(fixture.runs.state.failed[0].errorCode).toBe(
      "MODEL_EXECUTION_FAILED",
    );
  });

  it("client_route_model_and_provider_selectors_stay_inert_on_the_governed_dial", async () => {
    const fixture = governedRunnerDeps();
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a", {
      "x-openbot-tenant-id": "tenant-evil",
    });

    const outcome = await withRunnerRequestContext(request, async () =>
      collect(
        runner(request).run(
          runRequest({
            forwardedProps: {
              maxOutputTokens: 512,
              model: "gpt-evil",
              provider: "anthropic",
              routeRef: "mroute:v1:evil",
              credentialSecretRef: "cred-evil",
              runId: "run-evil",
            },
          }),
        ),
      ),
    );
    expect(outcome.error).toBeUndefined();
    expect(eventTypes(outcome.values).at(-1)).toBe("RUN_FINISHED");
    // The ceiling is the only honored field, validated before Run creation.
    expect(fixture.runs.state.capabilitiesIssued[0].input.maximumTokens).toBe(
      512,
    );
    expect(fixture.fetchCalls[0].body).toMatchObject({
      model: "gpt-5.6-terra",
      max_tokens: 512,
    });
    expect(fixture.fetchCalls[0].request.url).toBe(
      "https://provider.example/v1/chat/completions",
    );
    expect(fixture.runs.state.started[0].scope.tenantId).toBe("tenant-actor-a");
    const started = outcome.values[0] as { runId: string };
    expect(started.runId).toBe("server-run-1");
    expect(started.runId).not.toBe("run-evil");
  });

  it("a_stale_completion_lease_never_reports_success", async () => {
    const fixture = governedRunnerDeps({
      runs: syntheticRuns({ completeResult: false }),
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");

    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    expect(outcome.error?.message).toBe("RUN_COMPLETION_SETTLEMENT_STALE");
    expect(outcome.complete).toBe(false);
    expect(fixture.runs.state.completions).toHaveLength(1);
    expect(fixture.runs.state.failed).toHaveLength(0);
  });

  it("a_failed_event_append_fails_the_exact_owner_instead_of_reporting_success", async () => {
    const events = syntheticEvents();
    const baseAppend = events.service.append.bind(events.service);
    let appends = 0;
    events.service.append = async (scope, proposal) => {
      appends++;
      if (appends > 1) throw new Error("EVENT_APPEND_FAILED");
      return baseAppend(scope, proposal);
    };
    const fixture = governedRunnerDeps();
    const deps: ProductionRunnerDependencies = {
      ...fixture.deps,
      events: events.service,
    };
    const runner = createProductionRunner(deps);
    const request = requestFor("actor-a");

    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    expect(outcome.error?.message).toBe("EVENT_APPEND_FAILED");
    expect(outcome.complete).toBe(false);
    expect(fixture.runs.state.completions).toHaveLength(0);
    expect(fixture.runs.state.failed).toHaveLength(1);
    expect(fixture.runs.state.failed[0].lease.runId).toBe("server-run-1");
    expect(fixture.runs.state.failed[0].errorCode).toBe(
      "MODEL_EXECUTION_FAILED",
    );
  });

  it("a_failed_event_append_reports_a_stale_failure_settlement", async () => {
    const events = syntheticEvents();
    const baseAppend = events.service.append.bind(events.service);
    let appends = 0;
    events.service.append = async (scope, proposal) => {
      appends++;
      if (appends > 1) throw new Error("EVENT_APPEND_FAILED");
      return baseAppend(scope, proposal);
    };
    const fixture = governedRunnerDeps({
      runs: syntheticRuns({ failResult: false }),
    });
    const deps: ProductionRunnerDependencies = {
      ...fixture.deps,
      events: events.service,
    };
    const runner = createProductionRunner(deps);
    const request = requestFor("actor-a");

    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    expect(outcome.error?.message).toBe("RUN_EVENT_APPEND_SETTLEMENT_STALE");
    expect(fixture.runs.state.completions).toHaveLength(0);
  });

  it("a_stopped_run_prevents_success_when_the_agent_finishes_anyway", async () => {
    const events = syntheticEvents();
    const baseAppend = events.service.append.bind(events.service);
    let appends = 0;
    events.service.append = async (scope, proposal) => {
      appends++;
      // RUN_STARTED persists; everything after the stop is stale.
      if (appends > 1) throw new Error("RUN_ATTEMPT_STALE");
      return baseAppend(scope, proposal);
    };
    const fixture = governedRunnerDeps();
    const deps: ProductionRunnerDependencies = {
      ...fixture.deps,
      events: events.service,
    };
    const runner = createProductionRunner(deps);
    const request = requestFor("actor-a");

    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    expect(outcome.error?.message).toBe("RUN_ATTEMPT_STALE");
    expect(fixture.runs.state.completions).toHaveLength(0);
    expect(fixture.runs.state.failed).toHaveLength(1);
  });

  it("malformed_upstream_stream_type_fails_with_unknown_usage_and_never_succeeds", async () => {
    const fixture = governedRunnerDeps({
      fetch: () =>
        new Response(
          'data: {"type":"unexpected","choices":[]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");

    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    expect(outcome.error).toBeUndefined();
    expect(eventTypes(outcome.values).at(-1)).toBe("RUN_ERROR");
    const errored = outcome.values.at(-1) as { code?: string };
    expect(errored.code).toBe("MODEL_EXECUTION_FAILED");
    expect(fixture.runs.state.capabilitiesUnknown).toHaveLength(1);
    expect(fixture.runs.state.capabilitiesConfirmed).toHaveLength(0);
    expect(fixture.runs.state.completions).toHaveLength(0);
    expect(fixture.runs.state.failed[0].errorCode).toBe(
      "MODEL_EXECUTION_FAILED",
    );
  });

  it("missing_terminal_usage_fails_with_unknown_usage_and_never_succeeds", async () => {
    const fixture = governedRunnerDeps({
      fetch: () =>
        new Response(
          'data: {"id":"upstream","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
            'data: {"id":"upstream","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");

    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    expect(outcome.error).toBeUndefined();
    expect(eventTypes(outcome.values).at(-1)).toBe("RUN_ERROR");
    expect(fixture.runs.state.capabilitiesUnknown).toHaveLength(1);
    expect(fixture.runs.state.completions).toHaveLength(0);
  });

  it("a_failed_usage_confirmation_fails_as_MODEL_SETTLEMENT_FAILED", async () => {
    const fixture = governedRunnerDeps({
      runs: syntheticRuns({
        confirmUsageError: new Error("settlement unavailable"),
      }),
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");

    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    expect(outcome.error).toBeUndefined();
    expect(eventTypes(outcome.values).at(-1)).toBe("RUN_ERROR");
    const errored = outcome.values.at(-1) as { code?: string };
    expect(errored.code).toBe("MODEL_SETTLEMENT_FAILED");
    expect(fixture.runs.state.capabilitiesUnknown).toHaveLength(1);
    expect(fixture.runs.state.completions).toHaveLength(0);
    expect(fixture.runs.state.failed[0].errorCode).toBe(
      "MODEL_SETTLEMENT_FAILED",
    );
  });

  it("an_exhausted_run_budget_is_terminal_and_never_retried", async () => {
    const fixture = governedRunnerDeps({
      runs: syntheticRuns({
        issueCapabilityError: new ModelInvocationError(
          "MODEL_BUDGET_EXCEEDED",
          402,
        ),
      }),
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");

    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    expect(outcome.error).toBeUndefined();
    expect(eventTypes(outcome.values).at(-1)).toBe("RUN_ERROR");
    const errored = outcome.values.at(-1) as { code?: string };
    expect(errored.code).toBe("MODEL_BUDGET_EXCEEDED");
    expect(fixture.runs.state.capabilitiesIssued).toHaveLength(1);
    expect(fixture.fetchCalls).toHaveLength(0);
    expect(fixture.runs.state.completions).toHaveLength(0);
    expect(fixture.runs.state.failed[0].errorCode).toBe(
      "MODEL_BUDGET_EXCEEDED",
    );
  });

  it("transport_unsubscribe_cancels_the_stream_and_marks_usage_unknown_without_success", async () => {
    const fixture = governedRunnerDeps({
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"id":"upstream","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n' +
                    'data: {"id":"upstream","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
                ),
              );
              // The stream never terminates on its own: only an unsubscribe
              // can end this run.
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");

    await withRunnerRequestContext(request, async () => {
      const seen = await runner(request)
        .run(runRequest())
        .pipe(take(2), toArray())
        .toPromise();
      expect(seen[0]?.type).toBe("RUN_STARTED");
      // The unsubscribe lands mid-stream, after the model already dispatched.
      expect(seen[1]?.type).not.toBe("RUN_FINISHED");
    });
    // Cancellation must settle the dispatched capability as unknown usage and
    // never as a success. The gateway settles asynchronously after the abort.
    for (let attempt = 0; attempt < 40; attempt++) {
      if (fixture.runs.state.capabilitiesUnknown.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(
      fixture.runs.state.capabilitiesUnknown.length,
    ).toBeGreaterThanOrEqual(1);
    expect(fixture.runs.state.completions).toHaveLength(0);
    // HIGH-3: the disconnect finalize path terminalizes the run — never as
    // success — instead of leaving it active for the lease to expire.
    expect(fixture.runs.state.failed).toHaveLength(1);
    expect(fixture.runs.state.failed[0].errorCode).toBe(
      "MODEL_EXECUTION_FAILED",
    );
    expect(fixture.runs.state.released).toHaveLength(1);
  });

  it("a_cancelled_outcome_finishes_the_stream_but_never_completes_the_run", async () => {
    const fixture = governedRunnerDeps({
      cannedAgent: cannedAgent([
        {
          type: "RUN_STARTED",
          threadId: "thread-1",
          runId: "client-run-1",
        } as never as BaseEvent,
        {
          type: "RUN_FINISHED",
          threadId: "thread-1",
          runId: "client-run-1",
          outcome: { type: "cancelled" },
        } as never as BaseEvent,
      ]),
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");

    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.complete).toBe(true);
    // The agent's own RUN_STARTED is suppressed; ours carries the server id.
    const types = eventTypes(outcome.values);
    expect(types).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
    expect((outcome.values[0] as { runId: string }).runId).toBe("server-run-1");
    expect((outcome.values.at(-1) as { runId: string }).runId).toBe(
      "server-run-1",
    );
    expect(fixture.runs.state.completions).toHaveLength(0);
    expect(fixture.runs.state.failed).toHaveLength(0);
  });

  it("a_clean_finish_without_verified_settlement_fails_closed", async () => {
    const fixture = governedRunnerDeps({
      cannedAgent: cannedAgent([
        {
          type: "RUN_FINISHED",
          threadId: "thread-1",
          runId: "client-run-1",
        } as never as BaseEvent,
      ]),
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");

    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    expect(outcome.error).toBeUndefined();
    expect(eventTypes(outcome.values)).toEqual(["RUN_STARTED", "RUN_ERROR"]);
    const errored = outcome.values.at(-1) as { code?: string };
    expect(errored.code).toBe("MODEL_EXECUTION_FAILED");
    expect(fixture.runs.state.completions).toHaveLength(0);
    expect(fixture.runs.state.failed[0].errorCode).toBe(
      "MODEL_EXECUTION_FAILED",
    );
  });

  it("completion_without_a_terminal_event_never_completes_the_run", async () => {
    const fixture = governedRunnerDeps({
      cannedAgent: cannedAgent([]),
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");

    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.complete).toBe(true);
    expect(eventTypes(outcome.values)).toEqual(["RUN_STARTED"]);
    expect(fixture.runs.state.completions).toHaveLength(0);
    // HIGH-3: a stream that ends without a terminal is failed truthfully
    // by the finalize fallback — never completed, never left active.
    expect(fixture.runs.state.failed).toHaveLength(1);
    expect(fixture.runs.state.failed[0].errorCode).toBe(
      "MODEL_EXECUTION_FAILED",
    );
  });

  it("an_errored_agent_stream_fails_with_the_fixed_taxonomy", async () => {
    const fixture = governedRunnerDeps({
      cannedAgent: cannedAgent([], new Error("model exploded")),
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");

    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    expect(outcome.error).toBeUndefined();
    expect(eventTypes(outcome.values)).toEqual(["RUN_STARTED", "RUN_ERROR"]);
    const errored = outcome.values.at(-1) as { code?: string };
    expect(errored.code).toBe("MODEL_EXECUTION_FAILED");
    expect(fixture.runs.state.failed[0].errorCode).toBe(
      "MODEL_EXECUTION_FAILED",
    );
    expect(fixture.runs.state.completions).toHaveLength(0);
  });

  it("an_agent_RUN_ERROR_event_fails_the_run_once_with_the_fixed_code", async () => {
    const fixture = governedRunnerDeps({
      cannedAgent: cannedAgent([
        {
          type: "RUN_ERROR",
          message: "provider said no",
          code: "SOME_CLIENT_CODE",
          threadId: "thread-1",
          runId: "client-run-1",
        } as never as BaseEvent,
      ]),
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");

    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    expect(outcome.error).toBeUndefined();
    expect(eventTypes(outcome.values)).toEqual(["RUN_STARTED", "RUN_ERROR"]);
    const errored = outcome.values.at(-1) as {
      code?: string;
      message: string;
    };
    expect(errored.code).toBe("MODEL_EXECUTION_FAILED");
    expect(errored.message).toBe("provider said no");
    expect(fixture.runs.state.failed).toHaveLength(1);
    expect(fixture.runs.state.completions).toHaveLength(0);
  });

  it("two_concurrent_authenticated_requests_stay_isolated", async () => {
    const fixture = runnerDeps();
    const runner = createProductionRunner(fixture.deps);
    const requestA = requestFor("actor-a");
    const requestB = requestFor("actor-b");
    const [outcomeA, outcomeB] = await Promise.all([
      withRunnerRequestContext(requestA, async () =>
        collect(runner(requestA).run(runRequest())),
      ),
      withRunnerRequestContext(requestB, async () =>
        collect(runner(requestB).run(runRequest())),
      ),
    ]);
    expect(outcomeA.error).toBeUndefined();
    expect(outcomeB.error).toBeUndefined();
    expect(fixture.runs.state.started).toHaveLength(2);
    expect(fixture.runs.state.started[0].scope.actorId).toBe("actor-a");
    expect(fixture.runs.state.started[1].scope.actorId).toBe("actor-b");
    expect(fixture.runs.state.started[0].admission.expertVersionRef).not.toBe(
      fixture.runs.state.started[1].admission.expertVersionRef,
    );
    const leases = fixture.runs.state.failed.map(
      (entry) => entry.lease.ownerToken,
    );
    expect(leases[0]).not.toBe(leases[1]);
    for (const started of fixture.runs.state.started) {
      expect(started.admission.input.threadId).toBe("thread-1");
      expect(started.scope.tenantId).toBe(`tenant-${started.scope.actorId}`);
    }
  });

  it("client_selectors_and_run_id_are_not_authority", async () => {
    const fixture = runnerDeps();
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a", {
      "x-openbot-tenant-id": "tenant-evil",
    });
    const outcome = await withRunnerRequestContext(request, async () =>
      collect(
        runner(request).run(
          runRequest({
            forwardedProps: {
              maxOutputTokens: 512,
              tenantId: "tenant-evil",
              workspaceId: "workspace-evil",
              runId: "run-evil",
            },
          }),
        ),
      ),
    );
    expect(outcome.error).toBeUndefined();
    // Scope came from the authenticated request, never the wire fields.
    expect(fixture.scopes.state).toHaveLength(1);
    expect(fixture.scopes.state[0].request).toBe(request);
    const started = fixture.runs.state.started[0];
    expect(started.scope.tenantId).toBe("tenant-actor-a");
    expect(started.admission.input.entrypoint).toBe("web");
    expect(started.admission.input.clientMessageKey).toBe("msg-1");
    // The Run id is server-minted, never the client's runId.
    const emitted = outcome.values[0] as { runId: string };
    expect(emitted.runId).toBe("server-run-1");
    expect(emitted.runId).not.toBe("run-evil");
  });

  it("rejects_invalid_or_missing_cap_before_any_write", async () => {
    for (const forwardedProps of [
      {},
      { maxOutputTokens: 0 },
      { maxOutputTokens: -5 },
      { maxOutputTokens: 1.5 },
      { maxOutputTokens: 2_147_483_648 },
      { maxOutputTokens: "1024" },
      undefined,
    ]) {
      const fixture = runnerDeps();
      const runner = createProductionRunner(fixture.deps);
      const request = requestFor("actor-a");
      const outcome = await withRunnerRequestContext(request, async () =>
        collect(runner(request).run(runRequest({ forwardedProps }))),
      );
      expect(outcome.error?.message).toBe("RUN_OUTPUT_CEILING_REQUIRED");
      expect(outcome.values).toEqual([]);
      expect(fixture.conversations.state).toHaveLength(0);
      expect(fixture.runs.state.started).toHaveLength(0);
      expect(fixture.runs.state.leases).toHaveLength(0);
      expect(fixture.events.state.appends).toHaveLength(0);
      expect(fixture.runs.state.failed).toHaveLength(0);
      expect(fixture.catalogs.experts).toHaveLength(0);
      expect(fixture.catalogs.routes).toHaveLength(0);
    }
  });

  it("rejects_missing_pending_or_mismatched_finalized_intent_without_run_creation", async () => {
    // append refusal: the message never finalized.
    const refused = runnerDeps({
      conversations: syntheticConversations({
        appendError: new Error("RUN_INPUT_NOT_FINALIZED"),
      }),
    });
    const refusedRunner = createProductionRunner(refused.deps);
    const requestA = requestFor("actor-a");
    const outcomeRefused = await withRunnerRequestContext(requestA, async () =>
      collect(refusedRunner(requestA).run(runRequest())),
    );
    expect(outcomeRefused.error?.message).toBe("RUN_INPUT_NOT_FINALIZED");
    expect(refused.runs.state.started).toHaveLength(0);
    expect(refused.runs.state.leases).toHaveLength(0);
    expect(refused.events.state.appends).toHaveLength(0);
    expect(refused.runs.state.failed).toHaveLength(0);

    // start refusal inside Run admission (store-level atomic intent check).
    const rejected = runnerDeps({
      runs: syntheticRuns({ startError: new Error("RUN_INPUT_NOT_FINALIZED") }),
    });
    const rejectedRunner = createProductionRunner(rejected.deps);
    const requestB = requestFor("actor-a");
    const outcomeRejected = await withRunnerRequestContext(requestB, async () =>
      collect(rejectedRunner(requestB).run(runRequest())),
    );
    expect(outcomeRejected.error?.message).toBe("RUN_INPUT_NOT_FINALIZED");
    expect(rejected.runs.state.leases).toHaveLength(0);
    expect(rejected.events.state.appends).toHaveLength(0);
    expect(rejected.runs.state.failed).toHaveLength(0);
  });

  it("issues_expert_and_route_for_the_same_authorized_bot_only", async () => {
    const fixture = runnerDeps();
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");
    await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest({ agentId: "bot-a" }))),
    );
    expect(fixture.resolverCalls).toEqual([
      { actor: { id: "actor-a", role: "user" }, agentId: "bot-a" },
    ]);
    expect(fixture.catalogs.experts[0].definition.agentId).toBe("bot-a");
    expect(fixture.catalogs.routes[0].input.agentId).toBe("bot-a");
    expect(fixture.identifyCalls[0]).toBe(request);

    // An actor the Bot is refused for fails closed before any write.
    const denied = runnerDeps({
      resolveBuiltInBotForActor: async () => {
        throw new CoworkerUnavailableError(
          "Coworker bot-a is unavailable to this user.",
        );
      },
    });
    const deniedRunner = createProductionRunner(denied.deps);
    const requestDenied = requestFor("actor-a");
    const outcomeDenied = await withRunnerRequestContext(
      requestDenied,
      async () => collect(deniedRunner(requestDenied).run(runRequest())),
    );
    expect(outcomeDenied.error).toBeInstanceOf(CoworkerUnavailableError);
    expect(denied.conversations.state).toHaveLength(0);
    expect(denied.runs.state.started).toHaveLength(0);

    // A non-built-in/unknown selection is refused before writes.
    const unknown = runnerDeps();
    const unknownRunner = createProductionRunner(unknown.deps);
    const requestUnknown = requestFor("actor-a");
    const outcomeUnknown = await withRunnerRequestContext(
      requestUnknown,
      async () =>
        collect(
          unknownRunner(requestUnknown).run(runRequest({ agentId: "bot-z" })),
        ),
    );
    expect(outcomeUnknown.error).toBeInstanceOf(CoworkerUnavailableError);
    expect(unknown.conversations.state).toHaveLength(0);
  });

  it("rejects_scope_or_descriptor_identity_mismatch", async () => {
    // identifyActor disagrees with the scope resolver: refuse before writes.
    const mismatch = runnerDeps({
      identifyActor: async () => ({ id: "actor-b", role: "user" }),
    });
    const mismatchRunner = createProductionRunner(mismatch.deps);
    const requestA = requestFor("actor-a");
    const outcomeMismatch = await withRunnerRequestContext(requestA, async () =>
      collect(mismatchRunner(requestA).run(runRequest())),
    );
    expect(outcomeMismatch.error?.message).toBe("RUNNER_ACTOR_SCOPE_MISMATCH");
    expect(mismatch.conversations.state).toHaveLength(0);
    expect(mismatch.runs.state.started).toHaveLength(0);

    // The descriptor must describe the exact selected Bot.
    const wrongFacts = runnerDeps({
      resolveBuiltInBotForActor: async (_actor, agentId) => ({
        agent: {} as AbstractAgent,
        definitionFacts: {
          agentId: agentId === "bot-a" ? "bot-other" : agentId,
          source: "tenant_package",
          systemPrompt: "Different prompt.",
        },
      }),
    });
    const wrongFactsRunner = createProductionRunner(wrongFacts.deps);
    const requestB = requestFor("actor-a");
    const outcomeWrong = await withRunnerRequestContext(requestB, async () =>
      collect(wrongFactsRunner(requestB).run(runRequest())),
    );
    expect(outcomeWrong.error?.message).toBe("RUNNER_AGENT_IDENTITY_MISMATCH");
    expect(wrongFacts.conversations.state).toHaveLength(0);
  });

  it("rejects_unsupported_submitted_message_shapes", async () => {
    const shapes: unknown[][] = [
      [],
      [{ id: "msg-1", role: "assistant", content: "hi" }],
      [{ id: "msg-1", role: "user", content: [{ type: "text", text: "hi" }] }],
      [{ id: "", role: "user", content: "hi" }],
    ];
    for (const messages of shapes) {
      const fixture = runnerDeps();
      const runner = createProductionRunner(fixture.deps);
      const request = requestFor("actor-a");
      const outcome = await withRunnerRequestContext(request, async () =>
        collect(runner(request).run(runRequest({ messages }))),
      );
      expect(outcome.error?.message).toMatch(/^RUNNER_SUBMITTED_MESSAGE_/);
      expect(fixture.conversations.state).toHaveLength(0);
      expect(fixture.runs.state.started).toHaveLength(0);
    }
  });

  it("treats_stale_failure_settlement_as_failure", async () => {
    const fixture = runnerDeps({
      runs: syntheticRuns({ failResult: false }),
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");
    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    expect(outcome.error?.message).toBe("RUN_FAILURE_SETTLEMENT_STALE");
    expect(outcome.complete).toBe(false);
    expect(fixture.runs.state.failed).toHaveLength(1);
  });

  it("binds_model_route_to_exact_request_scope_thread_and_bot", async () => {
    // Outside a governed admission there is no route to return: fail closed.
    await expect(
      requestBoundModelRouteFor(scopeFor("actor-a"), "thread-1"),
    ).rejects.toThrow("MODEL_ROUTE_CONTEXT_UNAVAILABLE");

    // A tampered scope or thread inside the RunService seam is rejected.
    const tamperedScope = runnerDeps({
      runs: syntheticRuns({ tamperTenantId: "tenant-evil" }),
    });
    const tamperedScopeRunner = createProductionRunner(tamperedScope.deps);
    const requestA = requestFor("actor-a");
    const outcomeScope = await withRunnerRequestContext(requestA, async () =>
      collect(tamperedScopeRunner(requestA).run(runRequest())),
    );
    expect(outcomeScope.error?.message).toBe("MODEL_ROUTE_SCOPE_MISMATCH");
    expect(tamperedScope.runs.state.started).toHaveLength(0);

    const tamperedThread = runnerDeps({
      runs: syntheticRuns({ tamperThreadId: "thread-other" }),
    });
    const tamperedThreadRunner = createProductionRunner(tamperedThread.deps);
    const requestB = requestFor("actor-a");
    const outcomeThread = await withRunnerRequestContext(requestB, async () =>
      collect(tamperedThreadRunner(requestB).run(runRequest())),
    );
    expect(outcomeThread.error?.message).toBe("MODEL_ROUTE_SCOPE_MISMATCH");
  });
});

describe("production runner connect, isRunning, stop", () => {
  it("connect_replays_and_subscribes_with_revalidated_thread_scope", async () => {
    const seed = [
      eventRecord("thread-1", 1, {
        type: "RUN_STARTED",
        threadId: "thread-1",
        runId: "server-run-1",
      }),
      eventRecord("thread-1", 2, {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "m1",
        delta: "hi",
      }),
    ];
    const fixture = runnerDeps({ events: syntheticEvents(seed) });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");
    const values = await withRunnerRequestContext(request, async () =>
      firstValueFrom(
        runner(request)
          .connect({ threadId: "thread-1" })
          .pipe(take(2), toArray()),
      ),
    );
    expect(eventTypes(values)).toEqual(["RUN_STARTED", "TEXT_MESSAGE_CONTENT"]);
    expect(fixture.events.state.subscribes).toHaveLength(1);
    const subscribed = fixture.events.state.subscribes[0];
    expect(subscribed.threadId).toBe("thread-1");
    expect(subscribed.afterSeq).toBe(0);
    expect(subscribed.scope.tenantId).toBe("tenant-actor-a");
    expect(fixture.scopes.state[0].request).toBe(request);
  });

  it("isRunning_reports_only_authorized_persisted_active_run", async () => {
    const idle = runnerDeps({ runs: syntheticRuns({ active: null }) });
    const idleRunner = createProductionRunner(idle.deps);
    const requestIdle = requestFor("actor-a");
    await expect(
      withRunnerRequestContext(requestIdle, () =>
        idleRunner(requestIdle).isRunning({ threadId: "thread-1" }),
      ),
    ).resolves.toBe(false);

    const active = runnerDeps({
      runs: syntheticRuns({
        active: {
          runId: "server-run-9",
          attemptId: "attempt-9",
          generation: 3,
        },
      }),
    });
    const activeRunner = createProductionRunner(active.deps);
    const requestActive = requestFor("actor-a");
    await expect(
      withRunnerRequestContext(requestActive, () =>
        activeRunner(requestActive).isRunning({ threadId: "thread-1" }),
      ),
    ).resolves.toBe(true);
    expect(active.runs.state.activeLookups).toEqual([
      { scope: scopeFor("actor-a"), threadId: "thread-1" },
    ]);
  });

  it("stop_targets_only_the_exact_persisted_run", async () => {
    const fixture = runnerDeps({
      runs: syntheticRuns({
        active: {
          runId: "server-run-9",
          attemptId: "attempt-9",
          generation: 3,
        },
      }),
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");

    await expect(
      withRunnerRequestContext(request, () =>
        runner(request).stop({ threadId: "thread-1", runId: "server-run-9" }),
      ),
    ).resolves.toBe(true);
    expect(fixture.runs.state.stopped).toHaveLength(1);
    expect(fixture.runs.state.stopped[0].input).toEqual({
      runId: "server-run-9",
      reason: "user_requested",
      attemptId: "attempt-9",
      generation: 3,
    });

    // A client runId that names another run stops nothing.
    await expect(
      withRunnerRequestContext(request, () =>
        runner(request).stop({
          threadId: "thread-1",
          runId: "server-run-other",
        }),
      ),
    ).resolves.toBe(false);
    expect(fixture.runs.state.stopped).toHaveLength(1);

    // A stale attempt is not an error to the caller: nothing was stopped.
    const stale = runnerDeps({
      runs: syntheticRuns({
        active: {
          runId: "server-run-4",
          attemptId: "attempt-4",
          generation: 1,
        },
        stopError: new RunDomainError("RUN_ATTEMPT_STALE", 409),
      }),
    });
    const staleRunner = createProductionRunner(stale.deps);
    const requestStale = requestFor("actor-a");
    await expect(
      withRunnerRequestContext(requestStale, () =>
        staleRunner(requestStale).stop({
          threadId: "thread-1",
        } as AgentRunnerStopRequest),
      ),
    ).resolves.toBe(false);

    // No active run under this scope: false, no stop call.
    const none = runnerDeps({ runs: syntheticRuns({ active: null }) });
    const noneRunner = createProductionRunner(none.deps);
    const requestNone = requestFor("actor-a");
    await expect(
      withRunnerRequestContext(requestNone, () =>
        noneRunner(requestNone).stop({ threadId: "thread-1" }),
      ),
    ).resolves.toBe(false);
    expect(none.runs.state.stopped).toHaveLength(0);
  });
});

describe("mounted production SSE admission", () => {
  const config = {
    runtime: {
      intelligence: {
        apiUrl: "https://intelligence.invalid",
        gatewayWsUrl: "wss://intelligence.invalid",
        apiKey: "test-key",
        licenseToken: "test-token",
      },
    },
    accessibility: false,
    generativeUi: false,
  } as unknown as DeploymentConfig;

  function mountedFromDeps(deps: ProductionRunnerDependencies) {
    const factory = createProductionRunner(deps);
    const resolver = {
      async resolveAgentsForActor() {
        return { "bot-a": new BuiltInAgent({ model: "openai/gpt-4o-mini" }) };
      },
    } as unknown as ActorAgentResolver;
    return mountCopilotRuntime(
      config,
      resolver,
      async () => ({ id: "user-1", name: "Test User" }),
      async () => ({ id: "actor-a", role: "user" }),
      { enterpriseRunner: { runnerForRequest: factory } },
    );
  }

  function mountedFixture() {
    const fixture = runnerDeps();
    const mounted = mountedFromDeps(fixture.deps);
    return { mounted, fixture };
  }

  function mountedRunRequest(
    actorId = "actor-a",
    content = "hello",
    maxOutputTokens = 1024,
  ) {
    return new Request("http://localhost/api/copilotkit/agent/bot-a/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-actor": actorId,
      },
      body: JSON.stringify({
        threadId: "thread-1",
        runId: `client-run-${actorId}`,
        messages: [{ id: "msg-1", role: "user", content }],
        tools: [],
        context: [],
        forwardedProps: { maxOutputTokens },
      }),
    });
  }

  it("mounted_governed_post_run_executes_and_completes_over_sse", async () => {
    const fixture = governedRunnerDeps();
    const mounted = mountedFromDeps(fixture.deps);
    const request = mountedRunRequest();
    const response = await withRunnerRequestContext(request, () =>
      mounted.handler.fetch(request),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("RUN_STARTED");
    expect(body).toContain("RUN_FINISHED");
    expect(body).toContain("server-run-1");
    expect(body).not.toContain("client-run-1");
    // The governed execution actually ran through the production mount.
    expect(fixture.runs.state.started).toHaveLength(1);
    expect(fixture.runs.state.completions).toHaveLength(1);
    expect(fixture.runs.state.capabilitiesConfirmed).toHaveLength(1);
    expect(fixture.conversations.state).toHaveLength(1);
  });

  it("two_concurrent_governed_requests_execute_isolated_admissions", async () => {
    const fixture = governedRunnerDeps({
      fetch: async (request) => {
        const payload = (await request.clone().json()) as {
          messages: { role: string; content: { text?: string }[] }[];
        };
        const submitted =
          payload.messages.findLast((message) => message.role === "user")
            ?.content?.[0]?.text ?? "";
        const answer = submitted.includes("actor-b")
          ? "answer for actor b"
          : "answer for actor a";
        return sseText(answer);
      },
    });
    const mounted = mountedFromDeps(fixture.deps);
    const requestA = mountedRunRequest("actor-a", "hello actor-a");
    const requestB = mountedRunRequest("actor-b", "hello actor-b");

    const [responseA, responseB] = await Promise.all([
      withRunnerRequestContext(requestA, () => mounted.handler.fetch(requestA)),
      withRunnerRequestContext(requestB, () => mounted.handler.fetch(requestB)),
    ]);
    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);
    const [bodyA, bodyB] = await Promise.all([
      responseA.text(),
      responseB.text(),
    ]);
    expect(bodyA).toContain("answer for actor a");
    expect(bodyB).toContain("answer for actor b");
    expect(bodyA).not.toContain("answer for actor b");
    expect(bodyB).not.toContain("answer for actor a");

    // Each admission started, executed, and completed its own run with its
    // own capability set; nothing crossed the two request-local carriers.
    expect(fixture.runs.state.started).toHaveLength(2);
    expect(fixture.runs.state.completions).toHaveLength(2);
    expect(fixture.runs.state.started[0].scope.actorId).not.toBe(
      fixture.runs.state.started[1].scope.actorId,
    );
    for (const started of fixture.runs.state.started) {
      const capabilities = fixture.runs.state.capabilitiesIssued.filter(
        (issued) => issued.scope.actorId === started.scope.actorId,
      );
      expect(capabilities).toHaveLength(1);
      expect(capabilities[0].input.runId).toBe(started.runId);
    }
    const runIds = fixture.runs.state.completions.map(
      (completion) => completion.lease.runId,
    );
    expect(new Set(runIds).size).toBe(2);
  });

  it("mounted_run_with_a_remote_registered_agent_refuses_before_writes", async () => {
    const scopes = syntheticScopeResolver();
    const conversations = syntheticConversations();
    const runs = syntheticRuns();
    const events = syntheticEvents();
    const catalogs = syntheticCatalogs();
    const remoteResolver = createActorAgentResolver({
      loadAgents: async () => [
        {
          id: "bot-a",
          name: "Bot A",
          type: "remote_ag_ui",
          endpoint: "https://remote.invalid/agent",
        } as never,
      ],
      model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
      resolveModelApiKey: async () => null,
    });
    const deps: ProductionRunnerDependencies = {
      scopeResolver: scopes.resolver as never,
      conversations: conversations.service,
      runs: runs.service,
      events: events.service,
      expertVersions: catalogs.expertVersions as never,
      modelRoutes: catalogs.modelRoutes as never,
      resolveBuiltInBotForActor: (actor, agentId, context) =>
        remoteResolver.resolveBuiltInBotForActor(actor, agentId, context),
      identifyActor: async (request) => ({
        id: request.headers.get("x-test-actor") ?? "actor-a",
        role: "user",
      }),
      modelSelection: () => ({
        route: {
          model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
          credentialSecretRef: "cred-1",
        },
      }),
    };
    const mounted = mountedFromDeps(deps);
    const request = mountedRunRequest();
    const response = await withRunnerRequestContext(request, () =>
      mounted.handler.fetch(request),
    );
    await response.text();
    expect(conversations.state).toHaveLength(0);
    expect(runs.state.started).toHaveLength(0);
    expect(runs.state.completions).toHaveLength(0);
  });

  it("mounted_run_without_explicit_cap_refuses_before_writes", async () => {
    const { mounted, fixture } = mountedFixture();
    const request = new Request(
      "http://localhost/api/copilotkit/agent/bot-a/run",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-actor": "actor-a",
        },
        body: JSON.stringify({
          threadId: "thread-1",
          runId: "client-run-1",
          messages: [{ id: "msg-1", role: "user", content: "hello" }],
          tools: [],
          context: [],
          forwardedProps: {},
        }),
      },
    );
    const response = await withRunnerRequestContext(request, () =>
      mounted.handler.fetch(request),
    );
    expect(response.status).toBe(200);
    // The admission refusal errors the stream before any event is written:
    // the stream closes empty, and the console records the refusal cause.
    const body = await response.text();
    expect(body).toBe("");
    expect(fixture.conversations.state).toHaveLength(0);
    expect(fixture.runs.state.started).toHaveLength(0);
    expect(fixture.runs.state.leases).toHaveLength(0);
    expect(fixture.events.state.appends).toHaveLength(0);
  });

  it("composition_builds_run_service_and_event_service_around_shared_capabilities", async () => {
    // The composition export is the production wiring seam: build it against a
    // verified synthetic Data capability, exactly as index.ts does with the
    // boot-verified one.
    const data = await verifyDataDatabase({
      execute: async () => [
        {
          current_user_matches: true,
          capability_attributes_ok: true,
          login_attributes_ok: true,
          login_has_expected_capability: true,
          capability_has_no_escalation_membership: true,
          login_has_no_other_memberships: true,
          no_protected_ownership: true,
          login_has_no_enterprise_privileges: true,
        },
      ],
      transaction: async () => {
        throw new Error("NOT_USED_IN_CONSTRUCTION_TEST");
      },
    } as never);
    const composition = createProductionRunnerComposition({
      data,
      scopeResolver: syntheticScopeResolver().resolver as never,
      conversations: syntheticConversations().service,
      identifyActor: async () => ({ id: "actor-a", role: "user" }),
      resolver: {
        async resolveBuiltInBotForActor() {
          throw new CoworkerUnavailableError("unused");
        },
      },
      modelSelection: () => ({
        route: {
          model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
          credentialSecretRef: "cred-1",
        },
      }),
      modelCapabilitySecret:
        "test-only-model-capability-secret-000000000000000000000000000000",
      credentialEncryptionKey: GOVERNED_ENCRYPTION_KEY,
      credentialReader: { readModelSecret: async () => null },
    });
    expect(typeof composition.runnerForRequest).toBe("function");
    expect(typeof composition.runs.start).toBe("function");
    expect(typeof composition.runs.fail).toBe("function");
    expect(typeof composition.events.append).toBe("function");
    expect(typeof composition.events.subscribe).toBe("function");
    expect(typeof composition.expertVersions.putOrGet).toBe("function");
    expect(typeof composition.modelRoutes.put).toBe("function");
  });
});

describe("production runner lease renewal and terminal fallback (OCR R3)", () => {
  /** An agent that emits events with real delay between them. */
  function timedAgent(
    events: BaseEvent[],
    stepMilliseconds: number,
  ): AbstractAgent {
    return {
      agentId: "bot-a",
      run: () =>
        fromRx(events).pipe(
          concatMap(async (event) => {
            await new Promise((resolve) =>
              setTimeout(resolve, stepMilliseconds),
            );
            return event;
          }),
        ),
    } as unknown as AbstractAgent;
  }

  function contentEvent(delta: string): BaseEvent {
    return {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m1",
      delta,
    } as unknown as BaseEvent;
  }

  const errorEvent: BaseEvent = {
    type: "RUN_ERROR",
    message: "boom",
    code: "MODEL_EXECUTION_FAILED",
  } as unknown as BaseEvent;

  const finishedEvent: BaseEvent = {
    type: "RUN_FINISHED",
    threadId: "thread-1",
    runId: "server-run-1",
  } as unknown as BaseEvent;

  /** A governed SSE response whose chunks arrive with real delay. */
  function delayedSse(deltaCount: number, delayMs: number): Response {
    const id = "upstream";
    const chunks = [
      `data: ${JSON.stringify({
        id,
        choices: [
          { index: 0, delta: { role: "assistant" }, finish_reason: null },
        ],
      })}\n\n`,
    ];
    for (let i = 0; i < deltaCount; i += 1) {
      chunks.push(
        `data: ${JSON.stringify({
          id,
          choices: [
            {
              index: 0,
              delta: { content: `chunk-${i} ` },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
    }
    chunks.push(
      `data: ${JSON.stringify({
        id,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id,
        choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      })}\n\n`,
      "data: [DONE]\n\n",
    );
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });
  }

  it("long_stream_renews_leases_and_settles", async () => {
    const runs = syntheticRuns({
      renewalLease: (lease, count) => ({
        ...lease,
        expiresAt: new Date(lease.expiresAt.getTime() + count * 1000),
      }),
    });
    // Real governed chain: the gateway stream itself outlives several
    // renewal intervals before its usage-verified finish.
    const fixture = governedRunnerDeps({
      runs,
      renewalIntervalMilliseconds: 5,
      fetch: () => delayedSse(8, 8),
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");
    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.complete).toBe(true);
    // The stream outlived one renewal interval several times over: the
    // renewal loop must have kept the leases alive (HIGH-2).
    expect(runs.state.renewed.length).toBeGreaterThanOrEqual(2);
    // Every event persisted and the run settled completed, not failed.
    expect(runs.state.completions).toHaveLength(1);
    expect(runs.state.failed).toHaveLength(0);
  });

  it("renewed_lease_is_propagated_to_settlement", async () => {
    const renewedExpiry = () => new Date(Date.now() + 90_000);
    const runs = syntheticRuns({
      renewalLease: (lease) => ({ ...lease, expiresAt: renewedExpiry() }),
    });
    const fixture = governedRunnerDeps({
      runs,
      renewalIntervalMilliseconds: 5,
      cannedAgent: timedAgent([contentEvent("a"), errorEvent], 12),
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");
    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    expect(outcome.complete).toBe(true);
    expect(runs.state.renewed.length).toBeGreaterThanOrEqual(1);
    // The fenced settlement must carry the RENEWED lease: a settlement
    // under the pre-renewal snapshot is stale by definition.
    const settlementLease = runs.state.failed[0]?.lease as RunnerRequestLease;
    expect(runs.state.failed).toHaveLength(1);
    expect(runs.state.failed[0]?.errorCode).toBe("MODEL_EXECUTION_FAILED");
    expect(settlementLease.expiresAt.getTime()).toBeGreaterThanOrEqual(
      renewedExpiry().getTime() - 50,
    );
  });

  it("renewal_failure_fails_closed", async () => {
    const runs = syntheticRuns({
      renewalLease: (lease, count) => {
        if (count >= 2) throw new Error("RUN_REQUEST_LEASE_STALE");
        return { ...lease, expiresAt: new Date(Date.now() + 60_000) };
      },
    });
    const fixture = governedRunnerDeps({
      runs,
      renewalIntervalMilliseconds: 5,
      cannedAgent: timedAgent(
        [contentEvent("a"), contentEvent("b"), finishedEvent],
        10,
      ),
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");
    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    // Losing the lease never crashes the stream mid-event: it terminates
    // failed with usage unresolved, never succeeded. The failure must be
    // the renewal loop failing closed — which requires renewals to have
    // actually run first.
    expect(outcome.complete).toBe(true);
    expect(runs.state.renewed.length).toBeGreaterThanOrEqual(2);
    expect(eventTypes(outcome.values)).toContain("RUN_ERROR");
    expect(runs.state.failed).toHaveLength(1);
    expect(runs.state.completions).toHaveLength(0);
  });

  it("client_disconnect_before_terminal_settles_fallback", async () => {
    const runs = syntheticRuns();
    const fixture = governedRunnerDeps({
      runs,
      renewalIntervalMilliseconds: 10_000,
      cannedAgent: timedAgent(
        [contentEvent("a"), contentEvent("b"), finishedEvent],
        25,
      ),
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");
    await withRunnerRequestContext(request, async () => {
      await new Promise<void>((resolve) => {
        const values: BaseEvent[] = [];
        const subscription = runner(request)
          .run(runRequest())
          .subscribe({
            next: (event) => {
              values.push(event);
              if (values.length === 2) {
                subscription.unsubscribe();
                resolve();
              }
            },
            error: () => resolve(),
            complete: () => resolve(),
          });
      });
    });
    // Let in-flight appends and the finalize path settle.
    await new Promise((resolve) => setTimeout(resolve, 80));
    // A disconnected client must not leave the run active forever: the
    // finalize path settles it (never as success).
    expect(runs.state.failed.length + runs.state.completions.length).toBe(1);
    expect(runs.state.completions).toHaveLength(0);
  });

  it("stream_completes_without_terminal_event_settles_fallback", async () => {
    const runs = syntheticRuns();
    const fixture = governedRunnerDeps({
      runs,
      renewalIntervalMilliseconds: 10_000,
      cannedAgent: timedAgent([contentEvent("a"), contentEvent("b")], 8),
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");
    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    expect(outcome.complete).toBe(true);
    // A stream that ends with no RUN_FINISHED/RUN_ERROR is failed
    // truthfully — the model ran but never reported a terminal.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(runs.state.failed).toHaveLength(1);
    expect(runs.state.failed[0]?.errorCode).toBe("MODEL_EXECUTION_FAILED");
    expect(runs.state.completions).toHaveLength(0);
  });

  it("acquire_lease_failure_after_create_terminalizes_run", async () => {
    const runs = syntheticRuns({
      acquireLeaseError: new Error("RUN_NOT_ACTIVE"),
    });
    const fixture = runnerDeps({ runs });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");
    const outcome = await withRunnerRequestContext(request, async () =>
      collect(runner(request).run(runRequest())),
    );
    expect(outcome.error?.message).toBe("RUN_NOT_ACTIVE");
    // The admitted run must not stay queued-active: it is terminalized
    // (cancel/timeout semantics — the model never executed).
    expect(runs.state.cancelled).toHaveLength(1);
    expect(
      (runs.state.cancelled[0]?.input as { reason?: string })?.reason,
    ).toBe("timeout");
  });

  it("stale_matching_uses_structured_code", async () => {
    const stale = runnerDeps({
      runs: syntheticRuns({
        active: {
          runId: "server-run-1",
          attemptId: "attempt-1",
          generation: 1,
        },
        stopError: new RunDomainError("RUN_ATTEMPT_STALE", 409),
      }),
    });
    const staleRunner = createProductionRunner(stale.deps);
    const requestStale = requestFor("actor-a");
    await expect(
      withRunnerRequestContext(requestStale, () =>
        staleRunner(requestStale).stop({ threadId: "thread-1" }),
      ),
    ).resolves.toBe(false);

    // An unrelated error whose message merely contains "STALE" must
    // propagate, not be swallowed into a quiet false.
    const lookalike = runnerDeps({
      runs: syntheticRuns({
        active: {
          runId: "server-run-1",
          attemptId: "attempt-1",
          generation: 1,
        },
        stopError: new Error("HISTORY_SNAPSHOT_STALE"),
      }),
    });
    const lookalikeRunner = createProductionRunner(lookalike.deps);
    const requestLookalike = requestFor("actor-a");
    await expect(
      withRunnerRequestContext(requestLookalike, () =>
        lookalikeRunner(requestLookalike).stop({ threadId: "thread-1" }),
      ),
    ).rejects.toThrow("HISTORY_SNAPSHOT_STALE");
  });

  it("stop_aborts_active_stream_and_closes_cleanly", async () => {
    const runs = syntheticRuns({
      active: { runId: "server-run-1", attemptId: "attempt-1", generation: 1 },
    });
    const fixture = governedRunnerDeps({
      runs,
      renewalIntervalMilliseconds: 10_000,
      cannedAgent: timedAgent(
        [
          contentEvent("a"),
          contentEvent("b"),
          contentEvent("c"),
          finishedEvent,
        ],
        20,
      ),
    });
    const runner = createProductionRunner(fixture.deps);
    const request = requestFor("actor-a");
    const outcome = await withRunnerRequestContext(
      request,
      async () =>
        new Promise<{ values: BaseEvent[]; error?: Error; complete: boolean }>(
          (resolve) => {
            const values: BaseEvent[] = [];
            runner(request)
              .run(runRequest())
              .subscribe({
                next: (event) => {
                  values.push(event);
                  if (values.length === 2) {
                    void runner(request)
                      .stop({ threadId: "thread-1", runId: "server-run-1" })
                      .then(() => undefined);
                  }
                },
                error: (cause) =>
                  resolve({
                    values,
                    error:
                      cause instanceof Error ? cause : new Error(String(cause)),
                    complete: false,
                  }),
                complete: () => resolve({ values, complete: true }),
              });
          },
        ),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.complete).toBe(true);
    // After stop, the still-emitting agent stream is aborted at the relay:
    // no further appends (started + up to one in-flight event), no
    // settlement-stale marker to the client.
    const appends = fixture.events.state.appends;
    expect(appends.length).toBeGreaterThanOrEqual(1);
    expect(appends.length).toBeLessThan(5);
    expect(
      outcome.values.some(
        (event) =>
          (event as { message?: unknown }).message ===
          "RUN_EVENT_APPEND_SETTLEMENT_STALE",
      ),
    ).toBe(false);
  });
});

// --- OCR R10 (final full coverage): budget ceiling, outcome settlement, lease interval ---

it("caller_ceiling_is_capped_by_the_server_side_maximum", async () => {
  // Real governed chain: the gateway dial is what issues capabilities
  // under the admitted ceiling.
  const runs = syntheticRuns();
  const fixture = governedRunnerDeps({ runs });
  const runner = createProductionRunner(fixture.deps);
  const request = requestFor("actor-a");
  const outcome = await withRunnerRequestContext(request, async () =>
    collect(
      runner(request).run(
        runRequest({ forwardedProps: { maxOutputTokens: 2_147_483_647 } }),
      ),
    ),
  );
  expect(outcome.complete).toBe(true);
  // The admitted ceiling is the server-side maximum, never the raw caller
  // value: one run cannot reserve the entire 2^31 token space (OCR H1).
  const issued = runs.state.capabilitiesIssued[0]?.input;
  expect(issued?.maximumTokens).toBeLessThanOrEqual(8_000_000);
});

it("outcome_terminal_without_stop_settles_the_run", async () => {
  const runs = syntheticRuns();
  const fixture = governedRunnerDeps({
    runs,
    cannedAgent: cannedAgent([
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "a" },
      {
        type: "RUN_FINISHED",
        threadId: "thread-1",
        runId: "server-run-1",
        outcome: { type: "cancelled" },
      },
    ] as unknown as BaseEvent[]),
  });
  const runner = createProductionRunner(fixture.deps);
  const request = requestFor("actor-a");
  const outcome = await withRunnerRequestContext(request, async () =>
    collect(runner(request).run(runRequest())),
  );
  expect(outcome.complete).toBe(true);
  // An agent-emitted cancelled outcome without a stop() must not leave the
  // run active until lease expiry (OCR M): it settles truthfully (via stop,
  // falling back to cancel — both recorded by the synthetic service).
  expect(
    runs.state.stopped.length + runs.state.cancelled.length,
  ).toBeGreaterThanOrEqual(1);
  expect(runs.state.completions).toHaveLength(0);
});

it("refused_failure_settlement_falls_back_to_cancel_before_throwing", async () => {
  const runs = syntheticRuns({ failResult: false });
  const fixture = runnerDeps({ runs });
  const runner = createProductionRunner(fixture.deps);
  const request = requestFor("actor-a");
  const outcome = await withRunnerRequestContext(request, async () =>
    collect(runner(request).run(runRequest())),
  );
  expect(outcome.error?.message).toBe("RUN_FAILURE_SETTLEMENT_STALE");
  // The fenced fail was refused (e.g. expired lease): the cancel fallback
  // still terminalizes so the run cannot linger active (OCR M).
  expect(runs.state.cancelled).toHaveLength(1);
});
