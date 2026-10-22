import type { AbstractAgent, BaseEvent } from "@ag-ui/client";
import type { Observable } from "rxjs";
import { Observable as RxObservable } from "rxjs";
import { PROVENANCE_GUIDANCE } from "../../shared/bot-prompt";
import { describe, expect, it } from "../../tests/support/bun-test-compat";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import type { DeploymentConfig } from "../src/config";
import {
  builtInAgentConfiguration,
  mountCopilotRuntime,
  setBuiltinExecutionEngine,
  setMastraConversationRuntime,
} from "../src/copilot";
import type {
  ConversationService,
  EventService,
  PlatformScope,
  RunService,
} from "../src/enterprise/contracts";
import {
  canonicalizeModelRouteSnapshot,
  type ModelRouteSnapshotInput,
} from "../src/enterprise/runs/model-route-catalog";
import { withRunnerRequestContext } from "../src/enterprise/runs/request-context";
import { createProductionRunner } from "../src/enterprise/runs/runner";
import { createMastraAgUiAgent } from "../src/mastra/ag-ui-agent";
import { tenantStorageKey } from "../src/mastra/contracts";
import { createMastraConversationRuntime } from "../src/mastra/conversation-runtime";
import type {
  ExecuteMastra,
  ExecutionBinding,
} from "../src/mastra/execution-contracts";

/*
 * ME02 (#474) T8: the existing browser entry — mounted Hono / CopilotSseRuntime
 * over the real durable production runner (admission, lease, persist-before-
 * publish, settle-then-complete, exact stop) — with the server-side engine
 * selection pointing the governed built-in Bot at the Mastra execution
 * adapter. The upstream provider is a stubbed dial; no external service.
 */

const SECRET =
  "test-only-model-capability-secret-000000000000000000000000000000";
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const ENVIRONMENT: Record<string, string | undefined> = {
  OPENAI_BASE_URL: "https://provider.example/v1",
  OPENAI_API_KEY: "sk-env-fallback",
};

const CONFIG = {
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

/** Trusted synthetic directory scope, the only shape assertTrustedScope accepts. */
async function trustedScopeFor(actorId: string): Promise<PlatformScope> {
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
                // The workspace-membership select projects only `status`;
                // the membership select ignores it, so one row answers both.
                status: "active",
              },
            ],
          };
          return query;
        },
      }),
  };
  const { verifyDirectoryDatabase } = await import(
    "../src/enterprise/tenancy/connections"
  );
  const { createScopeResolver } = await import(
    "../src/enterprise/tenancy/store"
  );
  const directory = await verifyDirectoryDatabase(database as never);
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId, entrypoint: "web" }),
    selectTenant: () => `tenant-${actorId}`,
    selectWorkspace: () => `workspace-${actorId}`,
  });
  return resolver.resolve(new Request("https://example.invalid"));
}

function syntheticScopeResolver() {
  const trusted = new Map<string, PlatformScope>();
  return {
    async resolve() {
      throw new Error("NOT_USED");
    },
    async resolveForThread(request: Request, _threadId: string) {
      const actorId = request.headers.get("x-test-actor") ?? "actor-a";
      let scope = trusted.get(actorId);
      if (!scope) {
        scope = await trustedScopeFor(actorId);
        trusted.set(actorId, scope);
      }
      return scope;
    },
  };
}

/**
 * The in-memory ConversationService + mastra storage the ME03 conversation
 * runtime runs against on this suite's Mastra-engine path (fix-round-1 wiring):
 * the runner's append, the runtime's server-rebuilt history read, and the
 * engine-output persistence all land here. The mastra-backend binding + fake
 * memory rows keep `loadExecutionInput` on its real rebuild path (identity
 * metadata, versioned full parts), so the SSE suite exercises the actual
 * production wiring, not a shortcut.
 */
function syntheticConversations(behavior: { appendError?: Error } = {}) {
  const state: { actorId: string; content: string }[] = [];
  interface Row {
    id: string;
    threadId: string;
    resourceId: string;
    memoryRole: "user" | "assistant";
    text: string;
    seq: number;
    key?: string;
    full?: Record<string, unknown>;
  }
  const rows: Row[] = [];
  let seqCounter = 0;
  const resourceIdOf = (scope: PlatformScope) =>
    `private:${JSON.stringify([scope.tenantId, scope.principalId])}`;
  const dtoOf = (row: Row) => ({
    messageId: row.id,
    threadId: row.threadId,
    seq: row.seq,
    role: row.role,
    content: row.text,
    attachments: [],
    createdAt: new Date().toISOString(),
  });
  const service = {
    async append(
      scope: PlatformScope,
      input: { threadId: string; clientMessageKey: string; content: string },
    ) {
      state.push({ actorId: scope.actorId, content: input.content });
      if (behavior.appendError) throw behavior.appendError;
      seqCounter += 1;
      rows.push({
        id: `m-${seqCounter}`,
        threadId: input.threadId,
        resourceId: resourceIdOf(scope),
        memoryRole: "user",
        text: input.content,
        seq: seqCounter,
        key: input.clientMessageKey,
      });
      return dtoOf(rows.at(-1)!);
    },
    async appendEngineMessage(
      scope: PlatformScope,
      input: {
        threadId: string;
        role: "assistant" | "tool";
        parts: readonly { kind: string; text?: string }[];
        engineMessageId: string;
        toolCallId?: string;
      },
    ) {
      seqCounter += 1;
      rows.push({
        id: `m-${seqCounter}`,
        threadId: input.threadId,
        resourceId: resourceIdOf(scope),
        memoryRole: "assistant",
        text: input.parts
          .map((part) => (part.kind === "text" ? (part.text ?? "") : ""))
          .join(""),
        seq: seqCounter,
        full: {
          schemaVersion: 1,
          role: input.role,
          parts: input.parts,
          engineMessageId: input.engineMessageId,
          ...(input.toolCallId !== undefined
            ? { toolCallId: input.toolCallId }
            : {}),
        },
      });
      return dtoOf(rows.at(-1)!);
    },
    async history(
      _scope: PlatformScope,
      input: { threadId: string; beforeSeq: number | null; limit: number },
    ) {
      const all = rows
        .filter((row) => row.threadId === input.threadId)
        .filter((row) =>
          input.beforeSeq === null ? true : row.seq < input.beforeSeq,
        );
      const items = all.slice(-input.limit);
      return {
        items: items.map(dtoOf),
        nextBeforeSeq: null,
      };
    },
    async resolveMastraBinding(scope: PlatformScope, threadId: string) {
      return {
        tenantId: scope.tenantId,
        conversationId: `conv-${threadId}`,
        threadId,
        resourceId: resourceIdOf(scope),
        storageKey: tenantStorageKey(scope.tenantId),
        backend: "mastra" as const,
      };
    },
  };
  const storage = {
    async getStore(_scope: PlatformScope, binding: { threadId: string }) {
      return {
        async getStore(name: string) {
          if (name !== "memory")
            throw new Error("MASTRA_MEMORY_STORAGE_UNAVAILABLE");
          return {
            async listMessagesById({ messageIds }: { messageIds: string[] }) {
              const messages = [];
              for (const id of messageIds) {
                const row = rows.find(
                  (candidate) =>
                    candidate.id === id &&
                    candidate.threadId === binding.threadId,
                );
                if (!row) continue;
                messages.push({
                  id: row.id,
                  threadId: row.threadId,
                  resourceId: row.resourceId,
                  role: row.memoryRole,
                  type: "text",
                  createdAt: new Date(),
                  content: {
                    format: 2,
                    parts: [{ type: "text", text: row.text }],
                    metadata: {
                      openbotSeq: row.seq,
                      openbotDigest: `digest-${row.seq}`,
                      openbotClientMessageKey: row.key,
                      openbotAttachments: [],
                      ...(row.full ? { openbotParts: row.full } : {}),
                    },
                  },
                });
              }
              return { messages };
            },
          };
        },
      };
    },
  };
  return {
    service: service as unknown as ConversationService,
    state,
    rows,
    storage: storage as never,
  };
}

/**
 * Restore the legacy default and clear the runtime seam.
 */
function clearEngineSelection() {
  setBuiltinExecutionEngine(undefined);
  setMastraConversationRuntime(undefined);
}

function syntheticRuns() {
  const state = {
    started: { runIds: [] as string[] },
    leases: [] as { runId: string }[],
    failed: [] as { errorCode: string; runId: string }[],
    completions: { runIds: [] as string[] },
    stopped: { inputs: [] as { runId: string; reason: string }[] },
    cancelled: { inputs: [] as { runId: string; reason: string }[] },
    capabilitiesIssued: [] as { runIds: string[]; maximumTokens: number[] }[],
    capabilitiesConfirmed: [] as { usedTokens: number[] }[],
    capabilitiesUnknown: [] as string[],
    completeResult: true,
    /** The admitted route reference per tenant, recorded by modelRoutes.put. */
    routeRefByTenant: new Map<string, string>(),
  };
  const minted = new Map<string, { runId: string }>();
  let seed = 0;
  let runCounter = 0;
  const service: RunService = {
    async start(scope, admission) {
      runCounter += 1;
      const runId = `server-run-${runCounter}`;
      state.started.runIds.push(runId);
      void scope;
      void admission;
      return {
        run_id: runId,
        thread_id: admission.input.threadId,
        status: "queued",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    },
    async getActiveForThread() {
      return null;
    },
    async cancel(_scope, input) {
      state.cancelled.inputs.push({ runId: input.runId, reason: input.reason });
      return {
        run_id: input.runId,
        thread_id: "",
        status: "cancelled",
        created_at: "",
        updated_at: "",
      };
    },
    async stop(_scope, input) {
      state.stopped.inputs.push({ runId: input.runId, reason: input.reason });
      return {
        run_id: input.runId,
        thread_id: "",
        status: "cancelled",
        created_at: "",
        updated_at: "",
      };
    },
    async acquireRequestLease(_scope, runId) {
      state.leases.push({ runId });
      return {
        runId,
        attemptId: `attempt-${runId}`,
        generation: 1,
        ownerToken: `owner-${runId}`,
        expiresAt: new Date(Date.now() + 60_000),
      };
    },
    async renewRequestLease(_scope, lease) {
      return lease;
    },
    async releaseRequestLease() {
      return true;
    },
    async fail(_scope, input) {
      state.failed.push({
        errorCode: input.errorCode,
        runId: input.lease.runId,
      });
      return true;
    },
    async complete(_scope, input) {
      if (!state.completeResult) return false;
      state.completions.runIds.push(input.lease.runId);
      return true;
    },
    async get() {
      throw new Error("NOT_USED");
    },
    async getActiveAttemptGeneration() {
      throw new Error("NOT_USED");
    },
    async reserveModelBudget() {
      throw new Error("NOT_USED");
    },
    async issueModelInvocationCapability(_scope, input) {
      const capability = Buffer.alloc(32, ++seed).toString("base64url");
      // The real service stores the admission facts at issue time and hands
      // exactly those back at resolve time; the fixture must too, or every
      // resolve reads as a binding mismatch.
      minted.set(capability, {
        runId: input.runId,
        attemptId: input.attemptId,
        generation: input.generation,
        modelRequestId: input.modelRequestId,
        maximumTokens: input.maximumTokens,
      });
      state.capabilitiesIssued.push({
        runIds: [input.runId],
        maximumTokens: [input.maximumTokens],
      });
      return {
        capability,
        model_request_id: input.modelRequestId,
        maximum_tokens: input.maximumTokens,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async resolveModelInvocationCapability(scope, capability) {
      const entry = minted.get(capability);
      if (!entry)
        throw Object.assign(new Error("MODEL_CAPABILITY_INVALID"), {
          status: 401,
        });
      return {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        principalId: scope.principalId,
        runId: entry.runId,
        attemptId: entry.attemptId,
        generation: entry.generation,
        modelRouteRef: state.routeRefByTenant.get(scope.tenantId) ?? "",
        modelRequestId: entry.modelRequestId,
        maximumTokens: entry.maximumTokens,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async confirmModelInvocationUsage(_scope, _capability, usedTokens) {
      state.capabilitiesConfirmed.push({ usedTokens: [usedTokens] });
    },
    async markModelInvocationUnknown(_scope, capability) {
      state.capabilitiesUnknown.push(capability);
    },
    async releaseModelInvocation() {
      throw new Error("NOT_USED");
    },
  };
  return { service: service as unknown as RunService, state };
}

function syntheticEvents(
  behavior: { appendError?: Error; appendErrorAfterFirst?: Error } = {},
) {
  const state = {
    appends: { types: [] as string[] },
    appendError: behavior.appendError,
    appendErrorAfterFirst: behavior.appendErrorAfterFirst,
  };
  const service: EventService = {
    async append(scope, proposal) {
      if (state.appendError) throw state.appendError;
      if (state.appendErrorAfterFirst && state.appends.types.length >= 1)
        throw state.appendErrorAfterFirst;
      state.appends.types.push(proposal.event.type);
      void scope;
      return {
        eventId: `event-${state.appends.types.length}`,
        seq: state.appends.types.length,
        duplicate: false,
      };
    },
    async replay() {
      throw new Error("NOT_USED");
    },
    subscribe(scope, input, signal) {
      void scope;
      void input;
      const records: unknown[] = [];
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

interface ProviderDial {
  request: Request;
  body: {
    model?: string;
    messages?: { role: string; content: unknown }[];
    max_tokens?: number;
  };
}

type ProviderScript = (
  dial: { body: ProviderDial["body"] },
  call: number,
) => Response | Promise<Response>;

function sseText(
  text: string,
  usage: { prompt: number; completion: number } = { prompt: 4, completion: 2 },
): Response {
  const id = "upstream-1";
  const chunks = [
    {
      id,
      choices: [
        { index: 0, delta: { role: "assistant" }, finish_reason: null },
      ],
    },
    {
      id,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    },
    { id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    {
      id,
      choices: [],
      usage: {
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        total_tokens: usage.prompt + usage.completion,
      },
    },
  ];
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

interface HarnessOptions {
  provider?: ProviderScript;
  /** ME06: the legacy computer guidance the deployment composes for a Bot. */
  computerGuidance?: string;
  /** Thrown by every event append, including the run's own RUN_STARTED. */
  eventsAppendError?: Error;
  /**
   * Thrown by every event append AFTER the first (the run's RUN_STARTED
   * persists): the runner's append-failure contract — the stream errors, no
   * success terminal — stays observable on the wire.
   */
  eventsAppendErrorAfterFirst?: Error;
  conversationAppendError?: Error;
  completeResult?: boolean;
  standingInstructions?: (actorId: string) => string | null;
  /** Replaces the resolver chain's agent with this one (governedModel still consumed by the caller). */
  cannedAgent?: AbstractAgent;
}

function harness(options: HarnessOptions = {}) {
  const scopes = syntheticScopeResolver();
  const conversations = syntheticConversations({
    appendError: options.conversationAppendError,
  });
  const runs = syntheticRuns();
  if (options.completeResult !== undefined)
    runs.state.completeResult = options.completeResult;
  const events = syntheticEvents({
    appendError: options.eventsAppendError,
    appendErrorAfterFirst: options.eventsAppendErrorAfterFirst,
  });
  const catalogsRoute: ModelRouteSnapshotInput = {
    agentId: "bot-a",
    route: {
      model: { provider: "openai", defaultModel: "me01-model" },
      credentialSecretRef: "cred-1",
    },
    nativeBaseUrl: "https://provider.example/v1",
  };
  const dials: ProviderDial[] = [];
  const resolver = createActorAgentResolver({
    loadAgents: async () => [
      {
        id: "bot-a",
        name: "Bot A",
        type: "built_in" as const,
        systemPrompt: "Follow the registered Bot instructions.",
        expertSource: "tenant_package" as const,
      },
    ],
    model: { provider: "openai", defaultModel: "me01-model" },
    resolveModelApiKey: async () => {
      throw new Error("GOVERNED_ADMISSION_MUST_NOT_READ_MODEL_KEYS");
    },
    loadToolsForActor: () => async () => [],
    ...(options.computerGuidance
      ? { computerGuidance: options.computerGuidance }
      : {}),
    ...(options.standingInstructions
      ? {
          loadInstructionsForActor: (actorId: string) => async () =>
            options.standingInstructions?.(actorId) ?? null,
        }
      : {}),
  });
  const deps = {
    scopeResolver: scopes as never,
    conversations: conversations.service,
    runs: runs.service,
    events: events.service,
    expertVersions: {
      async putOrGet(_scope: PlatformScope, definition: { agentId: string }) {
        void definition;
        return "expert-ref";
      },
    } as never,
    modelRoutes: {
      async put(scope: PlatformScope, input: ModelRouteSnapshotInput) {
        const canonical = canonicalizeModelRouteSnapshot(
          scope.tenantId,
          input,
          SECRET,
        );
        runs.state.routeRefByTenant.set(scope.tenantId, canonical.routeRef);
        return canonical;
      },
      async get(scope: PlatformScope, routeRef: string) {
        const stored = canonicalizeModelRouteSnapshot(
          scope.tenantId,
          catalogsRoute,
          SECRET,
        );
        return stored.routeRef === routeRef ? stored : null;
      },
    } as never,
    resolveBuiltInBotForActor: options.cannedAgent
      ? async (
          _actor: unknown,
          agentId: string,
          context?: { governedModel?: { markConsumed(): void } },
        ) => {
          context?.governedModel?.markConsumed();
          return {
            agent: options.cannedAgent!,
            definitionFacts: {
              agentId,
              source: "tenant_package" as const,
              systemPrompt: "Follow the registered Bot instructions.",
            },
          };
        }
      : (actor: never, agentId: string, context?: never) =>
          resolver.resolveBuiltInBotForActor(actor, agentId, context),
    identifyActor: async (request: Request) => ({
      id: request.headers.get("x-test-actor") ?? "actor-a",
      role: "user" as const,
    }),
    modelSelection: () => ({
      route: catalogsRoute.route,
      ...(catalogsRoute.nativeBaseUrl !== undefined
        ? { nativeBaseUrl: catalogsRoute.nativeBaseUrl }
        : {}),
    }),
    modelCapabilitySecret: SECRET,
    credentialEncryptionKey: ENCRYPTION_KEY,
    credentialReader: { readModelSecret: async () => null },
    gatewayEnvironment: ENVIRONMENT,
    modelFetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = (await request
        .clone()
        .json()
        .catch(() => ({}))) as ProviderDial["body"];
      dials.push({ request, body });
      if (!options.provider) return sseText("governed answer");
      return options.provider({ body }, dials.length);
    }) as typeof fetch,
  };
  const runnerForRequest = createProductionRunner(deps as never);
  // ME03 fix-round-1: the Mastra engine path now REQUIRES a wired conversation
  // runtime (a Mastra-selected run without one refuses), so the harness always
  // installs the real runtime over this suite's in-memory conversations. The
  // legacy path never reads the seam, so legacy-control tests are unaffected.
  setMastraConversationRuntime(
    createMastraConversationRuntime({
      conversations: conversations.service as never,
      storage: conversations.storage as never,
      authorizeAttachment: async () => true,
    }),
  );
  const mounted = mountCopilotRuntime(
    CONFIG,
    {
      // The runtime's roster map: the browser asks for bot-a by name, and the
      // governed Runner resolves (and builds) the actual execution itself.
      async resolveAgentsForActor() {
        const { BuiltInAgent } = await import("@copilotkit/runtime/v2");
        return { "bot-a": new BuiltInAgent({ model: "openai/me01-model" }) };
      },
    } as never,
    async () => ({ id: "user-1", name: "Test User" }),
    async (request: Request) => ({
      id: request.headers.get("x-test-actor") ?? "actor-a",
      role: "user" as const,
    }),
    { enterpriseRunner: { runnerForRequest } },
  );
  return { mounted, runnerForRequest, runs, events, conversations, dials };
}

function runBodyFor(actorId: string, body: Record<string, unknown> = {}) {
  return {
    threadId: "thread-1",
    runId: `client-run-${actorId}`,
    messages: [{ id: "msg-1", role: "user", content: "hello" }],
    tools: [],
    context: [],
    forwardedProps: { maxOutputTokens: 777 },
    ...body,
  };
}

function runRequestFor(
  actorId: string,
  body: Record<string, unknown>,
): Request {
  return new Request("http://localhost/api/copilotkit/agent/bot-a/run", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-actor": actorId,
    },
    body: JSON.stringify(runBodyFor(actorId, body)),
  });
}

async function postSse(
  mounted: { handler: { fetch: (request: Request) => Promise<Response> } },
  request: Request,
): Promise<{ status: number; body: string }> {
  const response = await withRunnerRequestContext(request, () =>
    mounted.handler.fetch(request),
  );
  const body = await response.text();
  return { status: response.status, body };
}

/** A Mastra adapter agent driven by a scripted ExecuteMastra (for outcome contracts). */
function scriptedMastraAgent(
  events: BaseEvent[],
  mode: "complete" | "suspended" | "error",
): AbstractAgent {
  const binding: ExecutionBinding = {
    scope: scopeFor("actor-a"),
    botId: "bot-a",
    runId: "server-run-scripted",
    attemptId: "attempt-scripted",
    generation: 1,
    executionKey: "exec-key-scripted",
  };
  const execute: ExecuteMastra = () =>
    new RxObservable<BaseEvent>((subscriber) => {
      for (const event of events) subscriber.next(event);
      if (mode === "complete") subscriber.complete();
      else if (mode === "suspended") subscriber.complete();
      else subscriber.error(new Error("scripted failure"));
    });
  return createMastraAgUiAgent(execute, binding);
}

/** Polls until the predicate holds, or the budget expires (async finalize paths). */
async function until(
  predicate: () => boolean,
  budgetMilliseconds = 2_000,
): Promise<boolean> {
  const deadline = Date.now() + budgetMilliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

describe("browser entry over the Mastra execution path", () => {
  it("authorized_browser_run_uses_mastra", async () => {
    setBuiltinExecutionEngine(() => "mastra");
    try {
      const fixture = harness({
        provider: ({ body }) => {
          const system = (body.messages ?? []).find(
            (message) => message.role === "system",
          );
          const systemText =
            typeof system?.content === "string" ? system.content : "";
          return sseText(
            `mastra answer for: ${systemText.includes(PROVENANCE_GUIDANCE) ? "guided" : "unguided"}`,
          );
        },
      });
      const request = runRequestFor("actor-a", {
        context: [{ description: "Page", value: "the page says hello" }],
        state: { key: "value" },
      });
      const { status, body } = await postSse(fixture.mounted, request);
      expect(status).toBe(200);
      expect(body).toContain("RUN_STARTED");
      expect(body).toContain("RUN_FINISHED");
      expect(body).toContain("mastra answer for: guided");
      expect(body).toContain("server-run-1");
      expect(body).not.toContain("client-run-actor-a");
      // The Mastra path composes the trusted prompt server-side: the Bot
      // role and the provenance guidance are present, and the client's
      // context/state never leak into the instructions.
      expect(fixture.dials).toHaveLength(1);
      const system = fixture.dials[0]!.body.messages?.find(
        (message) => message.role === "system",
      );
      const systemText =
        typeof system?.content === "string" ? system.content : "";
      expect(systemText).toContain("Follow the registered Bot instructions.");
      expect(systemText).toContain(PROVENANCE_GUIDANCE);
      expect(systemText).not.toContain("Context from the application");
      expect(systemText).not.toContain("the page says hello");
      // Full governed lifecycle: admitted, leased, settled, completed once.
      expect(fixture.runs.state.started.runIds).toEqual(["server-run-1"]);
      expect(fixture.runs.state.completions.runIds).toEqual(["server-run-1"]);
      expect(fixture.runs.state.failed).toEqual([]);
      expect(fixture.runs.state.capabilitiesConfirmed).toHaveLength(1);
      expect(fixture.conversations.state).toEqual([
        { actorId: "actor-a", content: "hello" },
      ]);
      // The persisted event log received the terminal before publication.
      expect(fixture.events.state.appends.types).toContain("RUN_FINISHED");
      // ME03 fix-round-1 wiring: the engine's answer reached the conversation
      // store BEFORE the success terminal could settle the run — a refresh
      // reads this row back, never a client echo.
      expect(
        fixture.conversations.rows.filter((row) =>
          row.text.includes("mastra answer for: guided"),
        ),
      ).toHaveLength(1);

      // Control: with the selector absent the same request still completes,
      // through the legacy built-in path (which appends client context).
      setBuiltinExecutionEngine(undefined);
      const legacy = harness({
        provider: ({ body }) => {
          const system = (body.messages ?? []).find(
            (message) => message.role === "system",
          );
          const systemText =
            typeof system?.content === "string" ? system.content : "";
          return sseText(
            `legacy context: ${systemText.includes("Context from the application")}`,
          );
        },
      });
      const legacyOutcome = await postSse(
        legacy.mounted,
        runRequestFor("actor-a", {
          context: [{ description: "Page", value: "the page says hello" }],
        }),
      );
      expect(legacyOutcome.body).toContain("RUN_FINISHED");
      expect(legacyOutcome.body).toContain("legacy context: true");
    } finally {
      clearEngineSelection();
    }
  });

  it("forged_run_and_model_ignored", async () => {
    setBuiltinExecutionEngine(() => "mastra");
    try {
      const fixture = harness({
        provider: ({ body }) => sseText(`model=${body.model ?? "none"}`),
      });
      const { body } = await postSse(
        fixture.mounted,
        runRequestFor("actor-a", {
          runId: "run-evil",
          forwardedProps: {
            maxOutputTokens: 1024,
            model: "gpt-evil",
            provider: "anthropic",
            openbotRouteRef: "route-evil",
            runId: "run-evil",
          },
        }),
      );
      expect(body).toContain("RUN_FINISHED");
      // Server identity won everywhere visible: the relayed terminal carries
      // the persisted run id, and the dial used the admitted model.
      expect(body).toContain("server-run-1");
      expect(body).not.toContain("run-evil");
      expect(fixture.dials[0]!.body.model).toBe("me01-model");
      expect(fixture.runs.state.capabilitiesIssued[0]?.runIds[0]).toBe(
        "server-run-1",
      );
    } finally {
      clearEngineSelection();
    }
  });

  it("event_append_failure_prevents_success", async () => {
    setBuiltinExecutionEngine(() => "mastra");
    try {
      // The run's RUN_STARTED persists; every append after it is refused —
      // the runner's contract (runner-production: a failed event append
      // fails the run) is a stream ERROR after the start, never a success
      // terminal and never an untruthful completion.
      const fixture = harness({
        eventsAppendErrorAfterFirst: new Error("event store down"),
      });
      const { status, body } = await postSse(
        fixture.mounted,
        runRequestFor("actor-a", {}),
      );
      expect(status).toBe(200);
      expect(body).toContain("RUN_STARTED");
      // A stream whose events cannot be persisted must never report success.
      expect(body).not.toContain("RUN_FINISHED");
      expect(fixture.runs.state.completions.runIds).toEqual([]);
      expect(fixture.runs.state.failed).toHaveLength(1);
      expect(fixture.runs.state.failed[0]?.errorCode).toBe(
        "MODEL_EXECUTION_FAILED",
      );
    } finally {
      clearEngineSelection();
    }
  });

  it("suspended_run_not_completed", async () => {
    setBuiltinExecutionEngine(() => "mastra");
    try {
      const textMessage = (delta: string): BaseEvent =>
        ({
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "m1",
          delta,
        }) as unknown as BaseEvent;
      const fixture = harness({
        cannedAgent: scriptedMastraAgent(
          [textMessage("waiting state")],
          "suspended",
        ),
      });
      const { body } = await postSse(
        fixture.mounted,
        runRequestFor("actor-a", {}),
      );
      // Suspension is not completion: no success terminal reaches the wire
      // and the owner's fallback settles the run truthfully.
      expect(body).not.toContain("RUN_FINISHED");
      expect(await until(() => fixture.runs.state.failed.length >= 1)).toBe(
        true,
      );
      expect(fixture.runs.state.completions.runIds).toEqual([]);
    } finally {
      clearEngineSelection();
    }
  });

  it("stale_attempt_cannot_complete", async () => {
    setBuiltinExecutionEngine(() => "mastra");
    try {
      const fixture = harness({ completeResult: false });
      const { body } = await postSse(
        fixture.mounted,
        runRequestFor("actor-a", {}),
      );
      // The completion the store refused must never read as success: no
      // RUN_FINISHED is published, and exactly one completion was attempted.
      expect(body).not.toContain("RUN_FINISHED");
      expect(fixture.runs.state.completions.runIds).toEqual([]);
    } finally {
      clearEngineSelection();
    }
  });

  it("disconnect_does_not_product_cancel", async () => {
    setBuiltinExecutionEngine(() => "mastra");
    try {
      const fixture = harness({
        provider: () =>
          // A slow upstream: the stream is alive when the client leaves.
          new Promise<Response>((resolve) => {
            setTimeout(() => resolve(sseText("late answer")), 300);
          }),
      });
      const request = runRequestFor("actor-a", {});
      await withRunnerRequestContext(
        request,
        async () =>
          new Promise<void>((resolve) => {
            let seen = 0;
            const runRequestBody = {
              agent: { agentId: "bot-a" },
              input: runBodyFor("actor-a"),
            } as never;
            const subscription = (
              fixture.runnerForRequest(request) as {
                run: (input: never) => Observable<BaseEvent>;
              }
            )
              .run(runRequestBody)
              .subscribe({
                next: () => {
                  seen += 1;
                  if (seen >= 1) {
                    // The client walks away mid-stream (the provider has not
                    // answered yet) — a disconnect, not a stop.
                    subscription.unsubscribe();
                    resolve();
                  }
                },
                error: () => resolve(),
                complete: () => resolve(),
              });
          }),
      );
      // No product cancel was recorded for the disconnect: no stop with the
      // user-requested reason, no user cancel at all.
      const userRequested = [
        ...fixture.runs.state.stopped.inputs,
        ...fixture.runs.state.cancelled.inputs,
      ].filter((entry) => entry.reason === "user_requested");
      expect(userRequested).toEqual([]);
      // The owner settled the abandoned run truthfully (never as success).
      expect(
        await until(
          () =>
            fixture.runs.state.failed.length +
              fixture.runs.state.completions.runIds.length >=
            1,
        ),
      ).toBe(true);
      expect(fixture.runs.state.completions.runIds).toEqual([]);
    } finally {
      clearEngineSelection();
    }
  });

  it("two_users_no_context_cross_talk", async () => {
    setBuiltinExecutionEngine(() => "mastra");
    try {
      const fixture = harness({
        standingInstructions: (actorId) =>
          actorId === "actor-a"
            ? "Standing orders of A."
            : "Standing orders of B.",
        provider: ({ body }) => {
          // The governed adapter emits user content in OpenAI parts form.
          const lastUser = [...(body.messages ?? [])]
            .reverse()
            .find((message) => message.role === "user");
          const text =
            typeof lastUser?.content === "string"
              ? lastUser.content
              : Array.isArray(lastUser?.content)
                ? (lastUser.content as { text?: unknown }[])
                    .map((part) =>
                      typeof part?.text === "string" ? part.text : "",
                    )
                    .join("")
                : "";
          const system = (body.messages ?? []).find(
            (message) => message.role === "system",
          );
          const systemText =
            typeof system?.content === "string" ? system.content : "";
          return sseText(
            `answer[${text}] standing[${
              systemText.includes("Standing orders of A.")
                ? "A"
                : systemText.includes("Standing orders of B.")
                  ? "B"
                  : "none"
            }]`,
          );
        },
      });
      const [a, b] = await Promise.all([
        postSse(
          fixture.mounted,
          runRequestFor("actor-a", {
            threadId: "thread-a",
            runId: "client-run-a",
            messages: [
              { id: "msg-a", role: "user", content: "question from A" },
            ],
          }),
        ),
        postSse(
          fixture.mounted,
          runRequestFor("actor-b", {
            threadId: "thread-b",
            runId: "client-run-b",
            messages: [
              { id: "msg-b", role: "user", content: "question from B" },
            ],
          }),
        ),
      ]);
      expect(a.body).toContain("answer[question from A] standing[A]");
      expect(b.body).toContain("answer[question from B] standing[B]");
      expect(a.body).not.toContain("question from B");
      expect(b.body).not.toContain("question from A");
      expect(a.body).not.toContain("Standing orders of B.");
      expect(b.body).not.toContain("Standing orders of A.");
      // Each user's admission ran its own run with its own capabilities.
      const issued = fixture.runs.state.capabilitiesIssued.map(
        (entry) => entry.runIds[0],
      );
      expect(new Set(issued).size).toBe(2);
      expect(fixture.runs.state.completions.runIds.length).toBe(2);
    } finally {
      clearEngineSelection();
    }
  });

  it("computer_guided_bot_bridges_frontend_tool_participation", async () => {
    setBuiltinExecutionEngine(() => "mastra");
    try {
      const computerGuidance =
        "You have your own computer. Use its tools to browse the web the person asks about.";
      // The upstream scripts ONE round: the model calls the browser tool;
      // there is no second round because no result is fabricated.
      const fixture = harness({
        computerGuidance,
        provider: () => {
          const id = "upstream-fe";
          const chunks = [
            {
              id,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_web_1",
                        type: "function",
                        function: { name: "computer_navigate", arguments: "" },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: {
                          arguments: '{"url":"https://example.com"}',
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            },
          ];
          return new Response(
            `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      // The browser declares its frontend tool on the run input (the
      // `useFrontendTool` registrations ride every run as input.tools).
      const request = runRequestFor("actor-a", {
        tools: [
          {
            name: "computer_navigate",
            description: "Open a web page on your own computer.",
            parameters: {
              type: "object",
              properties: { url: { type: "string" } },
              required: ["url"],
            },
          },
        ],
      });
      const { body } = await postSse(fixture.mounted, request);
      // The composed trusted prompt carries the LEGACY computer guidance, in
      // the legacy position (after the two unconditional guidance blocks).
      const system = fixture.dials[0]!.body.messages?.find(
        (message) => message.role === "system",
      );
      const systemText =
        typeof system?.content === "string" ? system.content : "";
      expect(systemText).toContain(computerGuidance);
      expect(systemText.indexOf(PROVENANCE_GUIDANCE)).toBeLessThan(
        systemText.indexOf(computerGuidance),
      );
      // The participation protocol reached the wire: the call announced with
      // its arguments, and the server fabricated NO result.
      expect(body).toContain("TOOL_CALL_START");
      expect(body).toContain("computer_navigate");
      expect(body).toContain("TOOL_CALL_ARGS");
      expect(body).toContain("example.com");
      expect(body).not.toContain("TOOL_CALL_RESULT");
      // The suspension is terminal-less: no success is published for a run
      // whose tool still waits for the browser.
      expect(body).not.toContain("RUN_FINISHED");
      expect(fixture.dials).toHaveLength(1);
      // The owner settles the abandoned run truthfully (never as success).
      expect(await until(() => fixture.runs.state.failed.length >= 1)).toBe(
        true,
      );
      expect(fixture.runs.state.completions.runIds).toEqual([]);
    } finally {
      clearEngineSelection();
    }
  });

  it("learned_skills_reach_the_mastra_factory_like_computer_guidance_does", async () => {
    setBuiltinExecutionEngine(() => "mastra");
    try {
      const governedModel = {
        model: {} as never,
        maxOutputTokens: 100,
        markConsumed: () => undefined,
        executionBinding: () => null,
      };
      // Computer guidance no longer refuses at configuration time (ME06
      // wired it): the factory is reached, and its first failure is the
      // unbound-binding guard INSIDE the factory body — the old
      // MASTRA_TEXT_ONLY_SLICE refusal would have fired before any of this.
      const withComputer = builtInAgentConfiguration(
        {
          id: "bot-a",
          name: "Bot A",
          type: "built_in",
          systemPrompt: "Be helpful.",
        },
        { provider: "openai", defaultModel: "me01-model" },
        null,
        [],
        computerGuidanceText(),
        [],
        null,
        undefined,
        undefined,
        governedModel as never,
      );
      const generator = (
        withComputer.factory as (context: unknown) => AsyncGenerator
      )({ abortSignal: new AbortController().signal, input: {} });
      await expect(generator.next()).rejects.toThrow(
        "EXECUTION_BINDING_UNBOUND",
      );

      // Learned skills no longer refuse either (ME08 wired them): the
      // fail-closed slice refusal is gone, and the factory's first failure
      // is the same unbound-binding guard inside the body — the skills ride
      // the execution request through the ME04 controlled wrapper (covered
      // end to end in the mastra-learned-skills suite).
      const withSkills = builtInAgentConfiguration(
        {
          id: "bot-a",
          name: "Bot A",
          type: "built_in",
          systemPrompt: "Be helpful.",
        },
        { provider: "openai", defaultModel: "me01-model" },
        null,
        [],
        undefined,
        [],
        null,
        undefined,
        {
          tools: [
            {
              name: "recall_skill",
              description: "d",
              parameters: {} as never,
            },
          ],
          catalog: "c",
          execute: async () => "x",
        } as never,
        governedModel as never,
      );
      const skillsGenerator = (
        withSkills.factory as (context: unknown) => AsyncGenerator
      )({ abortSignal: new AbortController().signal, input: {} });
      await expect(skillsGenerator.next()).rejects.toThrow(
        "EXECUTION_BINDING_UNBOUND",
      );
    } finally {
      clearEngineSelection();
    }
  });
});

function computerGuidanceText(): string {
  return "You have your own computer. Use its tools to browse the web the person asks about.";
}
