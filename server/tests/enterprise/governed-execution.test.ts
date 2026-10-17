import { describe, expect, spyOn, test } from "bun:test";
import { getLogger } from "../../../shared/logger";
import type { ModelCredentialSecretReader } from "../../src/credentials";
import { encryptSecret } from "../../src/credentials";
import type { Database } from "../../src/db/client";
import type {
  ModelInvocationCapabilityInput,
  PlatformScope,
  RunService,
} from "../../src/enterprise/contracts";
import {
  classifyGovernedRunFailure,
  createGovernedModelExecution,
} from "../../src/enterprise/runs/governed-execution";
import { ModelInvocationError } from "../../src/enterprise/runs/model-capability";
import {
  type CanonicalModelRouteSnapshot,
  canonicalizeModelRouteSnapshot,
  type ModelRouteSnapshotInput,
} from "../../src/enterprise/runs/model-route-catalog";
import { verifyDirectoryDatabase } from "../../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";

const MODEL_CAPABILITY_SECRET =
  "test-only-model-capability-secret-000000000000000000000000000000";
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

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

/**
 * The real scope resolver over a synthetic directory: the only way to mint a
 * scope `assertTrustedScope` accepts, exactly as production admissions do.
 */
async function trustedScopeFor(actorId = "actor-a"): Promise<PlatformScope> {
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

type SyntheticRunsState = {
  issued: { scope: PlatformScope; input: ModelInvocationCapabilityInput }[];
  resolved: { scope: PlatformScope; capability: string }[];
  confirmed: { scope: PlatformScope; capability: string; usedTokens: number }[];
  unknown: { scope: PlatformScope; capability: string }[];
};

function syntheticRuns(
  options: {
    issueError?: Error;
    confirmError?: Error;
    /** The route ref the persisted run row would answer with. */
    modelRouteRef?: string;
    foreignContext?: (
      input: ModelInvocationCapabilityInput,
    ) => Record<string, unknown>;
  } = {},
) {
  const state: SyntheticRunsState = {
    issued: [],
    resolved: [],
    confirmed: [],
    unknown: [],
  };
  const minted = new Map<
    string,
    { scope: PlatformScope; input: ModelInvocationCapabilityInput }
  >();
  let next = 0;
  const service = {
    async issueModelInvocationCapability(
      scope: PlatformScope,
      input: ModelInvocationCapabilityInput,
    ) {
      state.issued.push({ scope, input });
      if (options.issueError) throw options.issueError;
      const capability = Buffer.alloc(32, ++next).toString("base64url");
      minted.set(capability, { scope, input });
      return {
        capability,
        model_request_id: input.modelRequestId,
        maximum_tokens: input.maximumTokens,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async resolveModelInvocationCapability(
      scope: PlatformScope,
      capability: string,
    ) {
      state.resolved.push({ scope, capability });
      const entry = minted.get(capability);
      if (!entry)
        throw new ModelInvocationError("MODEL_CAPABILITY_INVALID", 401);
      const foreign = options.foreignContext?.(entry.input) ?? {};
      return {
        tenantId: entry.scope.tenantId,
        workspaceId: entry.scope.workspaceId,
        principalId: entry.scope.principalId,
        runId: entry.input.runId,
        attemptId: entry.input.attemptId,
        generation: entry.input.generation,
        modelRouteRef: options.modelRouteRef ?? "route-registered",
        modelRequestId: entry.input.modelRequestId,
        maximumTokens: entry.input.maximumTokens,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...foreign,
      };
    },
    async confirmModelInvocationUsage(
      scope: PlatformScope,
      capability: string,
      usedTokens: number,
    ) {
      state.confirmed.push({ scope, capability, usedTokens });
      if (options.confirmError) throw options.confirmError;
    },
    async markModelInvocationUnknown(scope: PlatformScope, capability: string) {
      state.unknown.push({ scope, capability });
    },
  };
  return { service: service as unknown as RunService, state };
}

function syntheticCatalog(secret = MODEL_CAPABILITY_SECRET) {
  const store = new Map<string, CanonicalModelRouteSnapshot>();
  const catalog = {
    async put(scope: PlatformScope, input: ModelRouteSnapshotInput) {
      const canonical = canonicalizeModelRouteSnapshot(
        scope.tenantId,
        input,
        secret,
      );
      store.set(canonical.routeRef, canonical);
      return canonical;
    },
    async get(_scope: PlatformScope, routeRef: string) {
      return store.get(routeRef) ?? null;
    },
  };
  return { catalog, store };
}

/** The one selection every carrier fixture admits; drift tests mutate a copy. */
const FIXTURE_SELECTION: ModelRouteSnapshotInput = {
  agentId: "bot-a",
  route: {
    model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
    credentialSecretRef: "cred-1",
  },
  nativeBaseUrl: "https://provider.example/v1",
};
const FIXTURE_ADMITTED = canonicalizeModelRouteSnapshot(
  "tenant-actor-a",
  FIXTURE_SELECTION,
  MODEL_CAPABILITY_SECRET,
);

const happyJson = (text = "governed answer") =>
  Response.json({
    id: "upstream",
    object: "chat.completion",
    created: 123,
    model: "gpt-5.6-terra",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  });

const happySse = (text = "governed answer") =>
  new Response(
    [
      'data: {"id":"upstream","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      `data: ${JSON.stringify({
        id: "upstream",
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      })}\n\n`,
      'data: {"id":"upstream","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"upstream","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

const callOptions = {
  prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  maxOutputTokens: 100,
} as never;

type FixtureOptions = {
  fetch?: (request: Request) => Promise<Response> | Response;
  readerValue?: string | null;
  runs?: ReturnType<typeof syntheticRuns>;
};

async function carrierFixture(options: FixtureOptions = {}) {
  const scope = await trustedScopeFor();
  const { catalog, store } = syntheticCatalog();
  // The Runner admits the route into the catalog before building the carrier.
  store.set(FIXTURE_ADMITTED.routeRef, FIXTURE_ADMITTED);
  const selection: ModelRouteSnapshotInput = {
    agentId: FIXTURE_SELECTION.agentId,
    route: { ...FIXTURE_SELECTION.route },
    nativeBaseUrl: FIXTURE_SELECTION.nativeBaseUrl,
  };
  const runs =
    options.runs ?? syntheticRuns({ modelRouteRef: FIXTURE_ADMITTED.routeRef });
  const reads: { provider: string; keyId: string }[] = [];
  const credentialReader: ModelCredentialSecretReader = {
    readModelSecret: async (input) => {
      reads.push({ provider: input.provider, keyId: input.keyId });
      return options.readerValue === undefined
        ? null
        : { encryptedValue: options.readerValue };
    },
  };
  const fetchCalls: Request[] = [];
  const carrier = createGovernedModelExecution({
    scope,
    agentId: "bot-a",
    routeRef: FIXTURE_ADMITTED.routeRef,
    ceiling: 1024,
    runs: runs.service,
    catalog,
    currentRouteForAgent: async (agentId) => ({ ...selection, agentId }),
    modelCapabilitySecret: MODEL_CAPABILITY_SECRET,
    encryptionKey: ENCRYPTION_KEY,
    credentialReader,
    environment: {
      OPENAI_BASE_URL: "https://provider.example/v1",
      BOT_MODEL: "evil/model",
      BOT_PROVIDER: "anthropic",
      OPENAI_API_KEY: "sk-env-fallback",
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      fetchCalls.push(request);
      if (options.fetch) return await options.fetch(request);
      // The gateway announces streaming only in the payload: a stream call
      // gets SSE, a generate call gets a JSON chat completion.
      const streaming = String(init?.body ?? "").includes('"stream":true');
      return streaming
        ? happySse("governed answer")
        : happyJson("governed answer");
    }) as typeof fetch,
  });
  return { carrier, runs, catalog, store, selection, reads, fetchCalls };
}

const bind = (carrier: ReturnType<typeof createGovernedModelExecution>) =>
  carrier.bind({
    runId: "server-run-1",
    attemptId: "attempt-1",
    generation: 1,
  });

describe("governed model execution carrier", () => {
  test("refuses invocation before the admitted binding exists", async () => {
    const { carrier, runs } = await carrierFixture();
    await expect(
      carrier.governedModel.model.doGenerate(callOptions),
    ).rejects.toThrow("GOVERNED_EXECUTION_UNBOUND");
    expect(runs.state.issued).toHaveLength(0);
  });

  test("resolves only the bearer capability minted for this exact admission", async () => {
    const foreign = syntheticRuns({
      modelRouteRef: `mroute:v1:${"a".repeat(64)}`,
      foreignContext: () => ({ runId: "server-run-other" }),
    });
    const { carrier, runs, reads, fetchCalls } = await carrierFixture({
      runs: foreign,
    });
    bind(carrier);
    // The capability resolves, but for another run: the carrier must refuse
    // before any route selection, credential read, or network call.
    await expect(
      carrier.governedModel.model.doGenerate(callOptions),
    ).rejects.toThrow();
    expect(runs.state.resolved).toHaveLength(1);
    expect(reads).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
    expect(carrier.settlementClean()).toBe(false);
  });

  test("issues a fresh modelRequestId per invocation with distinct capabilities", async () => {
    const { carrier, runs } = await carrierFixture();
    bind(carrier);
    await carrier.governedModel.model.doGenerate(callOptions);
    await carrier.governedModel.model.doGenerate(callOptions);
    expect(runs.state.issued).toHaveLength(2);
    const ids = runs.state.issued.map((entry) => entry.input.modelRequestId);
    expect(new Set(ids).size).toBe(2);
    for (const entry of runs.state.issued) {
      expect(entry.input.runId).toBe("server-run-1");
      expect(entry.input.attemptId).toBe("attempt-1");
      expect(entry.input.generation).toBe(1);
    }
    const capabilities = runs.state.resolved.map((entry) => entry.capability);
    expect(new Set(capabilities).size).toBe(2);
  });

  test("narrows the next capability to the remaining run ceiling", async () => {
    const { carrier, runs } = await carrierFixture();
    bind(carrier);
    await carrier.governedModel.model.doGenerate({
      ...callOptions,
      maxOutputTokens: 1024,
    });
    await carrier.governedModel.model.doGenerate({
      ...callOptions,
      maxOutputTokens: 1024,
    });
    expect(runs.state.issued.map((entry) => entry.input.maximumTokens)).toEqual(
      [1024, 1018],
    );
  });

  test("a 402 capability issue is terminal and never retried", async () => {
    const budget = syntheticRuns({
      issueError: new ModelInvocationError("MODEL_BUDGET_EXCEEDED", 402),
    });
    const { carrier, runs } = await carrierFixture({ runs: budget });
    bind(carrier);
    await expect(
      carrier.governedModel.model.doGenerate(callOptions),
    ).rejects.toThrow("MODEL_BUDGET_EXCEEDED");
    expect(runs.state.issued).toHaveLength(1);
    expect(carrier.settlementClean()).toBe(false);
    expect(
      classifyGovernedRunFailure(
        carrier,
        new ModelInvocationError("MODEL_BUDGET_EXCEEDED", 402),
      ),
    ).toBe("MODEL_BUDGET_EXCEEDED");
  });

  test("route drift or absence fails closed before credential and network", async () => {
    const fixture = await carrierFixture();
    const { carrier, reads, fetchCalls } = fixture;
    bind(carrier);
    fixture.selection.route = {
      model: { provider: "openai", defaultModel: "gpt-drifted" },
      credentialSecretRef: "cred-1",
    };
    await expect(
      carrier.governedModel.model.doGenerate(callOptions),
    ).rejects.toThrow();
    expect(reads).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
    expect(carrier.settlementClean()).toBe(false);

    const absent = await carrierFixture();
    absent.store.clear();
    bind(absent.carrier);
    await expect(
      absent.carrier.governedModel.model.doGenerate(callOptions),
    ).rejects.toThrow();
    expect(absent.reads).toHaveLength(0);
    expect(absent.fetchCalls).toHaveLength(0);
  });

  test("credential drift on the current route fails closed too", async () => {
    const fixture = await carrierFixture();
    const { carrier, reads, fetchCalls } = fixture;
    bind(carrier);
    fixture.selection.route = {
      model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
      credentialSecretRef: "cred-rotated",
    };
    await expect(
      carrier.governedModel.model.doGenerate(callOptions),
    ).rejects.toThrow();
    expect(reads).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });

  test("strips BOT_MODEL and BOT_PROVIDER after route selection but keeps the native destination", async () => {
    const { carrier, fetchCalls } = await carrierFixture();
    bind(carrier);
    const result = await carrier.governedModel.model.doGenerate(callOptions);
    expect(result.content).toEqual([{ type: "text", text: "governed answer" }]);
    const upstream = fetchCalls[0];
    expect(upstream.url).toBe("https://provider.example/v1/chat/completions");
    expect(await upstream.clone().json()).toMatchObject({
      model: "gpt-5.6-terra",
    });
    expect(upstream.headers.get("authorization")).toBe(
      "Bearer sk-env-fallback",
    );
  });

  test("resolves the api key through the encrypted credential reader", async () => {
    const encrypted = await encryptSecret(ENCRYPTION_KEY, "sk-encrypted-1");
    const { carrier, reads, fetchCalls } = await carrierFixture({
      readerValue: encrypted,
    });
    bind(carrier);
    await carrier.governedModel.model.doGenerate(callOptions);
    expect(reads).toEqual([{ provider: "openai", keyId: "cred-1" }]);
    expect(fetchCalls[0].headers.get("authorization")).toBe(
      "Bearer sk-encrypted-1",
    );
  });

  test("settlement is clean only when every issued capability confirmed usage", async () => {
    const happy = await carrierFixture();
    bind(happy.carrier);
    await happy.carrier.governedModel.model.doGenerate(callOptions);
    expect(happy.carrier.settlementClean()).toBe(true);
    expect(happy.carrier.wasModelConsumed()).toBe(false);

    const failedConfirm = await carrierFixture({
      runs: syntheticRuns({
        modelRouteRef: FIXTURE_ADMITTED.routeRef,
        confirmError: new Error("settlement unavailable"),
      }),
    });
    bind(failedConfirm.carrier);
    const streamed =
      await failedConfirm.carrier.governedModel.model.doStream(callOptions);
    // The gateway surfaces the refused settlement as an errored stream; the
    // carrier's ledger is what classifies it, never the surfaced text.
    await expect(Array.fromAsync(streamed.stream)).rejects.toThrow(
      "MODEL_STREAM_FAILED",
    );
    expect(failedConfirm.carrier.settlementClean()).toBe(false);
    expect(
      classifyGovernedRunFailure(
        failedConfirm.carrier,
        new Error("MODEL_STREAM_FAILED"),
      ),
    ).toBe("MODEL_SETTLEMENT_FAILED");
  });

  test("malformed upstream stream type marks usage unknown and never succeeds", async () => {
    const { carrier, runs } = await carrierFixture({
      fetch: () =>
        new Response(
          'data: {"type":"unexpected","choices":[]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    bind(carrier);
    const streamed = await carrier.governedModel.model.doStream(callOptions);
    await expect(Array.fromAsync(streamed.stream)).rejects.toThrow();
    expect(runs.state.unknown).toHaveLength(1);
    expect(runs.state.confirmed).toHaveLength(0);
    expect(carrier.settlementClean()).toBe(false);
  });

  test("missing terminal usage errors the stream without a finish", async () => {
    const { carrier, runs } = await carrierFixture({
      fetch: () =>
        new Response(
          'data: {"id":"upstream","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
            'data: {"id":"upstream","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    bind(carrier);
    const streamed = await carrier.governedModel.model.doStream(callOptions);
    await expect(Array.fromAsync(streamed.stream)).rejects.toThrow();
    expect(runs.state.unknown).toHaveLength(1);
    expect(carrier.settlementClean()).toBe(false);
  });

  test("classifies settlement, budget, and execution failures into the fixed taxonomy", async () => {
    const { carrier } = await carrierFixture();
    expect(
      classifyGovernedRunFailure(carrier, new Error("MODEL_SETTLEMENT_FAILED")),
    ).toBe("MODEL_SETTLEMENT_FAILED");
    expect(
      classifyGovernedRunFailure(
        carrier,
        new Error("MODEL_GATEWAY_RUN_BUDGET_EXHAUSTED"),
      ),
    ).toBe("MODEL_BUDGET_EXCEEDED");
    expect(
      classifyGovernedRunFailure(carrier, new Error("upstream exploded")),
    ).toBe("MODEL_EXECUTION_FAILED");
    expect(classifyGovernedRunFailure(null, new Error("anything"))).toBe(
      "MODEL_EXECUTION_FAILED",
    );
  });
});

// --- OCR R4: structured-first classification, rebind observability ------------

test("classification_prefers_structured_code_with_text_fallback", () => {
  // A structured code decides even when the message carries no keyword.
  const structured = Object.assign(new Error("irrelevant text"), {
    code: "MODEL_GATEWAY_RUN_BUDGET_EXHAUSTED",
  });
  expect(classifyGovernedRunFailure(null, structured)).toBe(
    "MODEL_BUDGET_EXCEEDED",
  );
  // Text fallback still classifies code-less errors.
  expect(
    classifyGovernedRunFailure(
      null,
      new Error("upstream said MODEL_BUDGET_EXCEEDED"),
    ),
  ).toBe("MODEL_BUDGET_EXCEEDED");
  // An unrelated structured code with plain text stays execution-failed.
  expect(
    classifyGovernedRunFailure(
      null,
      Object.assign(new Error("irrelevant"), { code: "SOMETHING_ELSE" }),
    ),
  ).toBe("MODEL_EXECUTION_FAILED");
});

test("rebind_infrastructure_failure_is_logged_and_drift_is_not", async () => {
  const fixture = await carrierFixture();
  const { carrier, catalog } = fixture;
  const originalGet = catalog.get.bind(catalog);
  bind(carrier);
  const logs: unknown[][] = [];
  const logError = spyOn(getLogger("server"), "error").mockImplementation(
    (...args: unknown[]) => {
      logs.push(args);
      return undefined as never;
    },
  );
  try {
    (catalog as unknown as { get: unknown }).get = async () => {
      throw new Error("PG_CONNECTION_LOST");
    };
    await expect(
      carrier.governedModel.model.doGenerate(callOptions),
    ).rejects.toThrow();
    // Infrastructure faults are distinguishable from route drift in logs.
    expect(logs).toHaveLength(1);
    expect((logs[0]?.[0] as { error?: unknown })?.error).toBe(
      "MODEL_ROUTE_REBIND_INFRASTRUCTURE_FAILED",
    );

    logs.length = 0;
    (catalog as unknown as { get: unknown }).get = async () => {
      throw new Error("MODEL_ROUTE_SNAPSHOT_MISMATCH");
    };
    await expect(
      carrier.governedModel.model.doGenerate(callOptions),
    ).rejects.toThrow();
    // Drift is an expected fail-closed outcome: nothing to page anyone about.
    expect(logs).toHaveLength(0);
  } finally {
    logError.mockRestore();
    (catalog as unknown as { get: unknown }).get = originalGet;
  }
});
