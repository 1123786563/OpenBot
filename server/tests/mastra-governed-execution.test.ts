import type { BaseEvent } from "@ag-ui/client";
import { z } from "zod";
import { PROVENANCE_GUIDANCE } from "../../shared/bot-prompt";
import { describe, expect, it } from "../../tests/support/bun-test-compat";
import {
  builtInAgentConfiguration,
  setBuiltinExecutionEngine,
  setMastraConversationRuntime,
} from "../src/copilot";
import type { PlatformScope, RunService } from "../src/enterprise/contracts";
import type { GovernedModelRequest } from "../src/enterprise/runs/governed-execution";
import {
  classifyGovernedRunFailure,
  createGovernedModelExecution,
} from "../src/enterprise/runs/governed-execution";
import { ModelInvocationError } from "../src/enterprise/runs/model-capability";
import {
  canonicalizeModelRouteSnapshot,
  type ModelRouteSnapshotInput,
} from "../src/enterprise/runs/model-route-catalog";
import { executeGovernedMastra } from "../src/mastra/governed-agent";
import { buildInstructions } from "../src/mastra/instructions";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { UNTRUSTED_GUIDANCE } from "../src/untrusted-content";

/*
 * ME02 (#474) T5: every Mastra model step flows through the existing governed
 * gateway adapter — per-call capabilities, the run-aggregated output ceiling,
 * the authoritative settlement — with no retry, no payer switch and no client
 * selector. The carrier is the real one (createGovernedModelExecution) around
 * a synthetic RunService and a stubbed upstream dial, exactly the governed
 * fixture the production runner tests use.
 */

const SECRET =
  "test-only-model-capability-secret-000000000000000000000000000000";
const ENVIRONMENT: Record<string, string | undefined> = {
  OPENAI_BASE_URL: "https://provider.example/v1",
  OPENAI_API_KEY: "sk-env-fallback",
};

/** The server-selected route every harness admission pins. */
const ROUTE: ModelRouteSnapshotInput = {
  agentId: "bot-a",
  route: {
    model: { provider: "openai", defaultModel: "me01-model" },
    credentialSecretRef: "cred-1",
  },
  nativeBaseUrl: "https://provider.example/v1",
};

/**
 * Trusted synthetic directory scope, the only shape assertTrustedScope
 * accepts — the production runner tests mint theirs the same way.
 */
async function trustedScopeFor(actorId: string): Promise<PlatformScope> {
  const database = {
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
                // The workspace-membership select projects only `status`.
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

interface RunsHarness {
  service: RunService;
  capabilitiesIssued: {
    runId: string;
    maximumTokens: number;
    modelRequestId: string;
  }[];
  capabilitiesConfirmed: { capability: string; usedTokens: number }[];
  /** Publishes the admitted route reference the resolve must echo. */
  bindModelRouteRef(modelRouteRef: string): void;
  issueError?: Error;
  confirmError?: Error;
}

function syntheticRuns(
  options: { issueError?: Error; confirmError?: Error } = {},
): RunsHarness {
  const capabilitiesIssued: RunsHarness["capabilitiesIssued"] = [];
  const capabilitiesConfirmed: RunsHarness["capabilitiesConfirmed"] = [];
  const minted = new Map<
    string,
    {
      runId: string;
      attemptId: string;
      generation: number;
      modelRequestId: string;
      maximumTokens: number;
    }
  >();
  // Set once the carrier publishes its admitted route: the resolve must echo
  // exactly the admitted reference, or the adapter fails closed.
  const routeRef: { current: string | null } = { current: null };
  let seed = 0;
  const service: RunService = {
    async issueModelInvocationCapability(_scope, input) {
      if (options.issueError) throw options.issueError;
      const capability = Buffer.alloc(32, ++seed).toString("base64url");
      minted.set(capability, {
        runId: input.runId,
        attemptId: input.attemptId,
        generation: input.generation,
        modelRequestId: input.modelRequestId,
        maximumTokens: input.maximumTokens,
      });
      capabilitiesIssued.push({
        runId: input.runId,
        maximumTokens: input.maximumTokens,
        modelRequestId: input.modelRequestId,
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
        throw new ModelInvocationError("MODEL_CAPABILITY_INVALID", 401);
      return {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        principalId: scope.principalId,
        runId: entry.runId,
        attemptId: entry.attemptId,
        generation: entry.generation,
        modelRouteRef: routeRef.current ?? "",
        modelRequestId: entry.modelRequestId,
        maximumTokens: entry.maximumTokens,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async confirmModelInvocationUsage(_scope, capability, usedTokens) {
      if (options.confirmError) throw options.confirmError;
      capabilitiesConfirmed.push({ capability, usedTokens });
    },
    async markModelInvocationUnknown() {},
  };
  return {
    service: service as unknown as RunService,
    capabilitiesIssued,
    capabilitiesConfirmed,
    bindModelRouteRef(modelRouteRef) {
      routeRef.current = modelRouteRef;
    },
  };
}

/** OpenAI SSE response built from raw chat-completion chunks. */
function sse(
  parts: {
    content?: string;
    finish?: string | null;
    usage?: Record<string, unknown>;
    toolCall?: { id: string; name: string; args: string };
  }[],
): Response {
  const chunks = parts.map((part, index) => {
    const delta: Record<string, unknown> = {};
    if (index === 0 && part.content !== undefined) delta.role = "assistant";
    if (part.toolCall) {
      delta.tool_calls = [
        {
          index: 0,
          ...(part.toolCall.id
            ? { id: part.toolCall.id, type: "function" }
            : {}),
          function: {
            ...(part.toolCall.name ? { name: part.toolCall.name } : {}),
            ...(part.toolCall.args ? { arguments: part.toolCall.args } : {}),
          },
        },
      ];
    }
    if (part.content !== undefined) delta.content = part.content;
    return {
      id: "upstream-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "me01-model",
      choices: part.usage
        ? []
        : [{ index: 0, delta, finish_reason: part.finish ?? null }],
      ...(part.usage ? { usage: part.usage } : {}),
    };
  });
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

const TEXT_TURN = sse([
  { content: "governed answer" },
  { finish: "stop" },
  { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
]);

interface CarrierHarness {
  scope: PlatformScope;
  governedModel: GovernedModelRequest;
  settlementClean(): boolean;
  budgetExhausted(): boolean;
  settlementFailed(): boolean;
}

async function carrier(options: {
  ceiling?: number;
  fetch: (request: Request, call: number) => Promise<Response> | Response;
  runs?: RunsHarness;
}): Promise<CarrierHarness> {
  const scope = await trustedScopeFor("actor-a");
  const admitted = canonicalizeModelRouteSnapshot(
    scope.tenantId,
    ROUTE,
    SECRET,
  );
  const runs = options.runs ?? syntheticRuns();
  runs.bindModelRouteRef(admitted.routeRef);
  const execution = createGovernedModelExecution({
    scope,
    agentId: "bot-a",
    routeRef: admitted.routeRef,
    ceiling: options.ceiling ?? 1024,
    runs: runs.service,
    catalog: {
      get: async (_scope, routeRef) =>
        routeRef === admitted.routeRef ? admitted : null,
    },
    currentRouteForAgent: async () => ROUTE,
    modelCapabilitySecret: SECRET,
    encryptionKey: Buffer.alloc(32, 7).toString("base64"),
    credentialReader: { readModelSecret: async () => null },
    environment: ENVIRONMENT,
    fetch: options.fetch as typeof fetch,
  });
  execution.bind({
    runId: "server-run-1",
    attemptId: "attempt-1",
    generation: 1,
  });
  return {
    scope,
    governedModel: execution.governedModel,
    settlementClean: () => execution.settlementClean(),
    budgetExhausted: () => execution.budgetExhausted(),
    settlementFailed: () => execution.settlementFailed(),
  };
}

function grantedEchoTool(executions: unknown[]): GrantedTool {
  return {
    name: "echo_tool",
    description: "Echo the value back.",
    parameters: z.object({ value: z.string() }),
    execute: async (args) => {
      executions.push(args);
      return "echoed:hi";
    },
    ref: "server/echo_tool",
  };
}

function collectEvents(
  request: Parameters<typeof executeGovernedMastra>[0],
): Promise<{ events: { type: string; message?: unknown }[]; error?: Error }> {
  return new Promise((resolve) => {
    const events: { type: string; message?: unknown }[] = [];
    executeGovernedMastra(request).subscribe({
      next: (event) =>
        events.push({
          type: event.type,
          message: (event as unknown as { message?: unknown }).message,
        }),
      error: (cause) =>
        resolve({
          events,
          error: cause instanceof Error ? cause : new Error(String(cause)),
        }),
      complete: () => resolve({ events }),
    });
  });
}

function buildRequest(
  harness: CarrierHarness,
  overrides: Record<string, unknown> = {},
) {
  const facts = harness.governedModel.executionBinding?.();
  if (!facts) throw new Error("carrier did not issue execution facts");
  return {
    binding: {
      scope: harness.scope,
      botId: facts.botId,
      runId: facts.runId,
      attemptId: facts.attemptId,
      generation: facts.generation,
      executionKey: facts.executionKey,
    },
    input: {
      threadId: "thread-1",
      runId: "client-run-1",
      messages: [{ id: "msg-1", role: "user" as const, content: "hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    },
    instructions: ["You are Bot A.", "The person's standing instructions."],
    tools: [] as GrantedTool[],
    governedModel: harness.governedModel,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("governed Mastra execution", () => {
  it("two_steps_issue_distinct_capabilities", async () => {
    const executions: unknown[] = [];
    let call = 0;
    const dials: Request[] = [];
    const harness = await carrier({
      ceiling: 4096,
      fetch: (request) => {
        call += 1;
        dials.push(request);
        return call === 1
          ? sse([
              {
                toolCall: { id: "call_1", name: "echo_tool", args: "" },
              },
              { toolCall: { args: '{"value":"hi"}' } },
              { finish: "tool_calls" },
              {
                usage: {
                  prompt_tokens: 70,
                  completion_tokens: 0,
                  total_tokens: 70,
                },
              },
            ])
          : sse([
              { content: "answered from tool result" },
              { finish: "stop" },
              {
                usage: {
                  prompt_tokens: 3,
                  completion_tokens: 1,
                  total_tokens: 4,
                },
              },
            ]);
      },
    });
    const outcome = await collectEvents(
      buildRequest(harness, { tools: [grantedEchoTool(executions)] }),
    );
    expect(outcome.error).toBeUndefined();
    expect(executions).toEqual([{ value: "hi" }]);
    const types = outcome.events.map((event) => event.type);
    expect(types.at(-1)).toBe("RUN_FINISHED");
    expect(types).toContain("TEXT_MESSAGE_CONTENT");
    // Two model steps, two capabilities, two authoritative confirmations —
    // each capability minted fresh per step and narrowed to what remained.
    expect(harness.governedModel.executionBinding?.()).not.toBeNull();
    expect(
      outcome.events.filter((event) => event.type === "RUN_ERROR").length,
    ).toBe(0);
    expect(dials).toHaveLength(2);
    expect(harness.settlementClean()).toBe(true);
  });

  it("spent_budget_narrows_next_capability", async () => {
    // Total run ceiling 100; step one settles 70 actual tokens; the next
    // step's capability can ask for no more than the remaining 30.
    const runs = syntheticRuns();
    let call = 0;
    const harness = await carrier({
      ceiling: 100,
      runs,
      fetch: () => {
        call += 1;
        return call === 1
          ? sse([
              {
                toolCall: {
                  id: "call_1",
                  name: "echo_tool",
                  args: '{"value":"hi"}',
                },
              },
              { finish: "tool_calls" },
              {
                usage: {
                  prompt_tokens: 70,
                  completion_tokens: 0,
                  total_tokens: 70,
                },
              },
            ])
          : sse([
              { content: "second step" },
              { finish: "stop" },
              {
                usage: {
                  prompt_tokens: 5,
                  completion_tokens: 2,
                  total_tokens: 7,
                },
              },
            ]);
      },
    });
    const outcome = await collectEvents(
      buildRequest(harness, {
        tools: [grantedEchoTool([])],
        governedModel: harness.governedModel,
      }),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.events.at(-1)?.type).toBe("RUN_FINISHED");
    expect(runs.capabilitiesIssued.map((entry) => entry.maximumTokens)).toEqual(
      [100, 30],
    );
    expect(
      new Set(runs.capabilitiesIssued.map((entry) => entry.modelRequestId))
        .size,
    ).toBe(2);
    expect(runs.capabilitiesConfirmed).toHaveLength(2);
    expect(harness.settlementClean()).toBe(true);
  });

  it("budget_402_no_retry", async () => {
    // A terminal 402 budget refusal must never be retried against the same
    // run ceiling: exactly one model call, an error terminal, and the
    // fixed MODEL_BUDGET_EXCEEDED classification.
    const runs = syntheticRuns({
      issueError: new ModelInvocationError("MODEL_BUDGET_EXCEEDED", 402),
    });
    const harness = await carrier({ runs, fetch: () => TEXT_TURN });
    // Count the model steps the execution loop dials: the 402 fires at
    // capability issue, before the upstream dial, so the step counter — not
    // the dial counter — is what proves "no retry".
    let modelCalls = 0;
    const inner = harness.governedModel.model as {
      doStream: (options: unknown) => unknown;
      specificationVersion: string;
      provider: string;
      modelId: string;
      supportedUrls: unknown;
    };
    const counted = {
      get specificationVersion() {
        return inner.specificationVersion;
      },
      get provider() {
        return inner.provider;
      },
      get modelId() {
        return inner.modelId;
      },
      get supportedUrls() {
        return inner.supportedUrls;
      },
      doStream: (options: unknown) => {
        modelCalls += 1;
        return inner.doStream(options);
      },
    };
    const outcome = await collectEvents(
      buildRequest(harness, {
        governedModel: {
          model: counted,
          maxOutputTokens: harness.governedModel.maxOutputTokens,
          markConsumed: () => harness.governedModel.markConsumed(),
          executionBinding: () =>
            harness.governedModel.executionBinding?.() ?? null,
        },
      }),
    );
    expect(modelCalls).toBe(1);
    const types = outcome.events.map((event) => event.type);
    expect(types).not.toContain("RUN_FINISHED");
    expect(types.at(-1)).toBe("RUN_ERROR");
    expect(harness.budgetExhausted()).toBe(true);
    expect(
      classifyGovernedRunFailure(
        {
          budgetExhausted: () => harness.budgetExhausted(),
          settlementFailed: () => harness.settlementFailed(),
        },
        new Error("MODEL_GATEWAY_HTTP_402 MODEL_BUDGET_EXCEEDED"),
      ),
    ).toBe("MODEL_BUDGET_EXCEEDED");
  });

  it("malformed_usage_no_clean_finish", async () => {
    // A terminal usage block that does not add up is protocol damage: the
    // adapter fails the stream, nothing is confirmed, and the carrier's
    // settlement can never read clean — no clean success is possible.
    const runs = syntheticRuns();
    const harness = await carrier({
      runs,
      fetch: () =>
        sse([
          { content: "looks done" },
          { finish: "stop" },
          {
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 5 },
          },
        ]),
    });
    const outcome = await collectEvents(buildRequest(harness));
    const types = outcome.events.map((event) => event.type);
    expect(types).not.toContain("RUN_FINISHED");
    expect(types.at(-1)).toBe("RUN_ERROR");
    expect(runs.capabilitiesConfirmed).toHaveLength(0);
    expect(harness.settlementClean()).toBe(false);
  });

  it("client_route_override_inert", async () => {
    const dials: Request[] = [];
    const runs = syntheticRuns();
    const harness = await carrier({
      runs,
      fetch: (input, init) => {
        // The gateway dials the upstream with (url, init): frame it as the
        // Request it represents so the wire payload is inspectable.
        const request = new Request(input, init);
        dials.push(request);
        return TEXT_TURN;
      },
    });
    const outcome = await collectEvents(
      buildRequest(harness, {
        input: {
          threadId: "thread-1",
          runId: "client-run-evil",
          messages: [{ id: "msg-1", role: "user" as const, content: "hello" }],
          tools: [],
          context: [],
          forwardedProps: {
            model: "gpt-evil",
            provider: "anthropic",
            openbotRouteRef: "route-evil",
            runId: "run-evil",
          },
        },
      }),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.events.at(-1)?.type).toBe("RUN_FINISHED");
    // The dial went to the server-selected route and model, with no client
    // field anywhere near it.
    expect(dials).toHaveLength(1);
    const body = (await dials[0]!.clone().json()) as {
      model: string;
      max_tokens: number;
    };
    expect(body.model).toBe("me01-model");
    expect(body.max_tokens).toBe(1024);
    // Capabilities are minted for the server-issued run identity, never the
    // client's forged one.
    expect(runs.capabilitiesIssued[0]!.runId).toBe("server-run-1");
  });

  it("subscription_never_falls_back_from_credit_refusal", async () => {
    // The governed Mastra configuration carries no model at all — there is no
    // PlanModel branch a credit refusal could fall back to, and the payer the
    // admission locked stays the only path.
    const harness = await carrier({ fetch: () => TEXT_TURN });
    const config = mastraConfigFor(harness.governedModel);
    expect(config.type).toBe("custom");
    expect(Object.hasOwn(config, "model")).toBe(false);
    expect(typeof config.factory).toBe("function");
    // And a credit refusal inside the governed execution is terminal: the
    // budget_402 contract above proves no second dial happens.
  });

  it("instructions_are_the_trusted_server_composition", async () => {
    const composed = buildInstructions(
      ["You are Bot A.", "The person's standing instructions."],
      ["The granted-tool guidance paragraph."],
    );
    // The legacy built-in prompt's exact sequence: role and standing
    // instructions, then the two unconditional guidance texts, then the
    // granted-tool paragraph — the same texts the legacy prompt carries,
    // never re-authored here, and the order is legacy-mandated (no
    // end-weighting).
    expect(
      composed.startsWith(
        "You are Bot A.\n\nThe person's standing instructions.",
      ),
    ).toBe(true);
    expect(composed).toContain(PROVENANCE_GUIDANCE);
    expect(composed).toContain(UNTRUSTED_GUIDANCE);
    expect(
      composed.indexOf(PROVENANCE_GUIDANCE) >
        composed.indexOf("The person's standing instructions."),
    ).toBe(true);
    expect(
      composed.indexOf("The granted-tool guidance paragraph.") >
        composed.indexOf(UNTRUSTED_GUIDANCE),
    ).toBe(true);
  });
});

/** Builds the built-in configuration the way the server wiring does. */
function mastraConfigFor(governedModel: GovernedModelRequest): {
  type: string;
  factory?: unknown;
  model?: unknown;
} {
  setBuiltinExecutionEngine(() => "mastra");
  try {
    return builtInAgentConfiguration(
      {
        id: "bot-a",
        name: "Bot A",
        type: "built_in",
        systemPrompt: "Follow the registered Bot instructions.",
        expertSource: "tenant_package",
      },
      { provider: "openai", defaultModel: "me01-model", plan: {} as never },
      null,
      [],
      undefined,
      [],
      null,
      undefined,
      undefined,
      governedModel,
      { userId: "actor-a" },
      undefined,
    ) as { type: string; factory?: unknown; model?: unknown };
  } finally {
    setBuiltinExecutionEngine(undefined);
  }
}

/**
 * A GovernedModelRequest double for the governance-gate tests: the gate only
 * reads `model`, `markConsumed` and `executionBinding()` — never dials.
 */
function stubGovernedModel(options: {
  executionBinding?: () => unknown;
}): GovernedModelRequest {
  return {
    model: {
      specificationVersion: "v3",
      provider: "stub",
      modelId: "stub-model",
      supportedUrls: () => ({}),
      // The probe marker: if the gate let this request through, the engine
      // dial starts and hits this throw — proof the validation passed.
      doStream: () => {
        throw new Error("PROBE_GATE_PASSED");
      },
    } as unknown as GovernedModelRequest["model"],
    maxOutputTokens: 128,
    markConsumed: () => {},
    ...(options.executionBinding
      ? { executionBinding: options.executionBinding as never }
      : {}),
  };
}

/** The binding copied field-by-field from the facts, as the factory does. */
function bindingFrom(harness: CarrierHarness): Record<string, unknown> {
  const facts = harness.governedModel.executionBinding?.();
  if (!facts) throw new Error("carrier did not issue execution facts");
  return {
    scope: facts.scope,
    botId: facts.botId,
    runId: facts.runId,
    attemptId: facts.attemptId,
    generation: facts.generation,
    executionKey: facts.executionKey,
  };
}

describe("governed execution refusal matrix", () => {
  it("missing_governed_model_refuses", async () => {
    const harness = await carrier({ fetch: () => TEXT_TURN });
    const withoutCollaborator = {
      ...buildRequest(harness),
      governedModel: undefined,
    };
    const outcome = await collectEvents(withoutCollaborator as never);
    expect(outcome.error?.message).toBe("EXECUTION_GOVERNED_MODEL_REQUIRED");
    // A malformed collaborator (no model, no consumption mark) is the same
    // refusal — never an improvised run.
    const malformed = {
      ...buildRequest(harness),
      governedModel: { maxOutputTokens: 10 },
    };
    const malformedOutcome = await collectEvents(malformed as never);
    expect(malformedOutcome.error?.message).toBe(
      "EXECUTION_GOVERNED_MODEL_REQUIRED",
    );
  });

  it("unbound_execution_binding_refuses", async () => {
    // The production carrier publishes facts only after bind; a collaborator
    // whose binding was never bound is out of contract and refuses.
    const harness = await carrier({ fetch: () => TEXT_TURN });
    const outcome = await collectEvents(
      buildRequest(harness, {
        governedModel: stubGovernedModel({ executionBinding: () => null }),
      }),
    );
    expect(outcome.error?.message).toBe("EXECUTION_BINDING_UNBOUND");
  });

  it("execution_binding_method_missing_refuses", async () => {
    // `executionBinding` is an optional interface method: a collaborator
    // without it publishes no facts at all — the same fail-closed refusal as
    // an explicit null. `request.binding` (which decides the Mastra run id,
    // the event runId and the botId) is never trusted just because the
    // method is absent.
    const harness = await carrier({ fetch: () => TEXT_TURN });
    const outcome = await collectEvents(
      buildRequest(harness, { governedModel: stubGovernedModel({}) }),
    );
    expect(outcome.error?.message).toBe("EXECUTION_BINDING_UNBOUND");
  });

  it("binding_mismatch_refuses_on_every_published_fact", async () => {
    const harness = await carrier({ fetch: () => TEXT_TURN });
    // run identity disagreement.
    const wrongRun = await collectEvents(
      buildRequest(harness, {
        binding: { ...bindingFrom(harness), runId: "run-evil" },
      }),
    );
    expect(wrongRun.error?.message).toBe("EXECUTION_BINDING_MISMATCH");
    // The engine execution identity: a forged executionKey would run the
    // engine under a foreign run id — refused.
    const wrongKey = await collectEvents(
      buildRequest(harness, {
        binding: { ...bindingFrom(harness), executionKey: "forged-key" },
      }),
    );
    expect(wrongKey.error?.message).toBe("EXECUTION_BINDING_MISMATCH");
    // Scope identity: a different tenant is a different tenancy.
    const facts = harness.governedModel.executionBinding?.();
    const wrongScope = await collectEvents(
      buildRequest(harness, {
        binding: {
          ...bindingFrom(harness),
          scope: { ...facts!.scope, tenantId: "tenant-evil" },
        },
      }),
    );
    expect(wrongScope.error?.message).toBe("EXECUTION_BINDING_MISMATCH");
    // The remaining PlatformScope identity fields: the actor, the two
    // authorization epochs and the entrypoint are identity too — a stale
    // epoch or a foreign actor passes no MISMATCH gate.
    for (const [field, value] of [
      ["actorId", "actor-evil"],
      ["memberEpoch", 99],
      ["aclEpoch", 99],
      ["entrypoint", "desktop"],
    ] as const) {
      const mismatched = await collectEvents(
        buildRequest(harness, {
          binding: {
            ...bindingFrom(harness),
            scope: { ...facts!.scope, [field]: value },
          },
        }),
      );
      expect(mismatched.error?.message).toBe("EXECUTION_BINDING_MISMATCH");
    }
  });

  it("consistent_binding_passes_the_gate_and_reaches_the_dial", async () => {
    // The consistent direction: field-for-field identical facts pass, and
    // the engine dial actually starts (the probe model throws its marker
    // from doStream — the refusal gate is behind us).
    const harness = await carrier({ fetch: () => TEXT_TURN });
    const outcome = await collectEvents(
      buildRequest(harness, {
        governedModel: stubGovernedModel({
          executionBinding: () =>
            harness.governedModel.executionBinding?.() ?? null,
        }),
      }),
    );
    const trace = `${JSON.stringify(outcome.events)} ${String(outcome.error ?? "")}`;
    expect(trace).toContain("PROBE_GATE_PASSED");
    expect(trace).not.toContain("EXECUTION_");
  });

  it("resume_requests_refuse", async () => {
    // Continuations are ME05's slice; a request claiming one today must not
    // start a fresh run under the governed gate.
    const harness = await carrier({ fetch: () => TEXT_TURN });
    const outcome = await collectEvents(
      buildRequest(harness, {
        resume: { continuationId: "cont-1", revision: 1 },
      }),
    );
    expect(outcome.error?.message).toBe("EXECUTION_RESUME_UNSUPPORTED");
  });
});

describe("mastra execution message-family refusals", () => {
  /*
   * The client-reachable fail-closed paths inside execution.ts's message
   * relay (`toModelMessages`): the inline-attachment Bot hits the parts
   * refusal on every run, so these are the most traffic-exposed refusals of
   * the slice — covered here through the same governed carrier the gate
   * tests use (the refusal throws before any model dial).
   */

  // A FRESH Response per dial: a Response body reads once, and the shared
  // module-level TEXT_TURN instance may already be consumed by an earlier
  // test in this file's single process.
  const freshTextTurn = () =>
    sse([
      { content: "governed answer" },
      { finish: "stop" },
      { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
    ]);

  it("non_text_content_parts_refuse", async () => {
    // File parts now DEGRADE to a text reference (an authorized attachment
    // must be runnable); a part shape nothing in the slice can model — an
    // inline image, say — still refuses the whole run rather than being
    // silently dropped from the model history.
    const harness = await carrier({ fetch: freshTextTurn });
    const outcome = await collectEvents(
      buildRequest(harness, {
        input: {
          ...buildRequest(harness).input,
          messages: [
            {
              id: "msg-1",
              role: "user",
              content: [{ type: "image", mimeType: "image/png", data: "aGk=" }],
            },
          ],
        },
      }),
    );
    expect(outcome.error?.message).toContain("ME03_MESSAGE_PARTS_UNSUPPORTED");
  });

  it("authorized_file_parts_degrade_to_text_reference", async () => {
    // The ME03 OCR HIGH finding: the runtime's authorized history rebuild
    // KEEPS file parts (source url `/api/attachments/<id>`), so refusing them
    // here made the AUTHORIZED state unrunnable while the revoked state
    // (stripped by the runtime's degrade) ran fine — safety semantics
    // inverted. The degrade mirrors the unauthorized path: a text reference
    // reaches the model, no bytes are read.
    const dials: { messages?: { role: string; content: unknown }[] }[] = [];
    const harness = await carrier({
      // The gateway dials fetch(url, { method, headers, body }): the recorded
      // body is the request the MODEL actually received.
      fetch: (async (_url: string, init: { body?: string }) => {
        dials.push(JSON.parse(init?.body ?? "{}"));
        return freshTextTurn();
      }) as unknown as (request: Request, call: number) => Promise<Response>,
    });
    const outcome = await collectEvents(
      buildRequest(harness, {
        input: {
          ...buildRequest(harness).input,
          messages: [
            {
              id: "msg-1",
              role: "user",
              content: [
                { type: "text", text: "summarize the attached file" },
                {
                  type: "file",
                  mimeType: "application/octet-stream",
                  source: { type: "url", value: "/api/attachments/abc-123" },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.events.at(-1)?.type).toBe("RUN_FINISHED");
    expect(harness.settlementClean()).toBe(true);
    // What the model actually received (the AI SDK's wire shape of the user
    // turn): the text reference replaced the file part — no URL part, no
    // refusal, both texts present.
    const wire = JSON.stringify(dials.at(-1));
    expect(wire).toContain("[attachment: /api/attachments/abc-123]");
    expect(wire).toContain("summarize the attached file");
    expect(wire).not.toContain('"type":"file"');
  });

  it("unknown_wire_role_refuses", async () => {
    const harness = await carrier({ fetch: () => TEXT_TURN });
    const outcome = await collectEvents(
      buildRequest(harness, {
        input: {
          ...buildRequest(harness).input,
          messages: [{ id: "msg-1", role: "developer", content: "hi" }],
        },
      }),
    );
    expect(outcome.error?.message).toContain("ME03_MESSAGE_PARTS_UNSUPPORTED");
  });

  it("system_and_tool_history_skipped_user_text_runs", async () => {
    // The trusted role is server-composed: client-supplied system/tool
    // history is skipped, and the run proceeds normally on the surviving
    // user text — a full governed dial with clean settlement. Raw events are
    // collected here so the relayed text delta itself is assertable.
    const harness = await carrier({ fetch: freshTextTurn });
    const request = buildRequest(harness, {
      input: {
        ...buildRequest(harness).input,
        messages: [
          { id: "sys-1", role: "system", content: "client system prompt" },
          { id: "tool-1", role: "tool", content: "client tool history" },
          { id: "msg-1", role: "user", content: "hello" },
        ],
      },
    });
    const events: { type: string }[] = [];
    let failure: unknown;
    await new Promise<void>((resolve) => {
      executeGovernedMastra(request).subscribe({
        next: (event) => events.push(event as { type: string }),
        error: (cause) => {
          failure = cause;
          resolve();
        },
        complete: () => resolve(),
      });
    });
    expect(failure).toBeUndefined();
    expect(JSON.stringify(events)).toContain("governed answer");
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    expect(harness.settlementClean()).toBe(true);
  });

  it("empty_relayed_history_refuses", async () => {
    // Nothing survived the relay (system skipped, the only user message
    // empty): refusing the empty model history, never streaming `[]` into
    // the engine.
    const harness = await carrier({ fetch: () => TEXT_TURN });
    const outcome = await collectEvents(
      buildRequest(harness, {
        input: {
          ...buildRequest(harness).input,
          messages: [
            { id: "sys-1", role: "system", content: "client system prompt" },
            { id: "msg-1", role: "user", content: "" },
          ],
        },
      }),
    );
    expect(outcome.error?.message).toContain("ME03_MESSAGE_PARTS_UNSUPPORTED");
    expect(outcome.error?.message).toContain("empty model history");
  });
});

describe("mastra text-only slice refusals", () => {
  it("bot_with_granted_tool_runs_the_mastra_tool_loop", async () => {
    // ME04 superseded the text-only refusal for connector tools: a Bot
    // holding granted tools now gets a working configuration that runs the
    // governed tool loop through the wrapped granted path. Learned skills
    // and computer guidance still refuse (the test below).
    const executions: unknown[] = [];
    let dials = 0;
    const harness = await carrier({
      fetch: () => {
        dials += 1;
        return dials === 1
          ? sse([
              {
                toolCall: { id: "call_cfg_1", name: "echo_tool", args: "" },
              },
              { toolCall: { args: '{"value":"hi"}' } },
              { finish: "tool_calls" },
              {
                usage: {
                  prompt_tokens: 5,
                  completion_tokens: 0,
                  total_tokens: 5,
                },
              },
            ])
          : sse([
              { content: "answered from tool result" },
              { finish: "stop" },
              {
                usage: {
                  prompt_tokens: 2,
                  completion_tokens: 1,
                  total_tokens: 3,
                },
              },
            ]);
      },
    });
    setBuiltinExecutionEngine(() => "mastra");
    setMastraConversationRuntime({
      // The engine-wiring integration test drives the real runtime; this
      // unit passes the rebuilt input through so the governed execution —
      // the same executeGovernedMastra the loop tests drive — runs.
      loadExecutionInput: async (_scope, input) => input,
      persistExecutionMessages: async () => {},
    } as never);
    try {
      const config = builtInAgentConfiguration(
        {
          id: "bot-a",
          name: "Bot A",
          type: "built_in",
          systemPrompt: "Follow the registered Bot instructions.",
          expertSource: "tenant_package",
        },
        { provider: "openai", defaultModel: "me01-model", plan: {} as never },
        null,
        [grantedEchoTool(executions)],
        undefined,
        [],
        null,
        undefined,
        undefined,
        harness.governedModel,
        { userId: "actor-a" },
        undefined,
      ) as {
        type: string;
        factory?: (context: {
          input: unknown;
          abortSignal: AbortSignal;
        }) => AsyncGenerator<BaseEvent>;
      };
      expect(config.type).toBe("custom");
      const events: { type: string }[] = [];
      for await (const event of config.factory({
        input: {
          threadId: "thread-1",
          runId: "client-run-1",
          messages: [{ id: "msg-1", role: "user", content: "use the tool" }],
          tools: [],
          context: [],
          forwardedProps: {},
        },
        abortSignal: new AbortController().signal,
      })) {
        events.push(event as { type: string });
      }
      // The tool loop ran end to end: exactly one granted execute, and the
      // MASTRA_TEXT_ONLY_SLICE refusal is gone for tool-carrying Bots.
      expect(executions).toEqual([{ value: "hi" }]);
      const types = events.map((event) => event.type);
      expect(types).toContain("TOOL_CALL_START");
      expect(types.at(-1)).toBe("RUN_FINISHED");
      expect(JSON.stringify(events)).not.toContain("MASTRA_TEXT_ONLY_SLICE");
    } finally {
      setBuiltinExecutionEngine(undefined);
      setMastraConversationRuntime(undefined);
    }
  });

  it("bot_with_computer_guidance_bridges_frontend_tools", async () => {
    // ME06 superseded the computer-guidance refusal: a computer-deployed Bot
    // keeps its guidance in the composed prompt, and the browser-declared
    // tool the run relays mounts as an INERT bridge — the model's call
    // suspends the engine for real client participation; the server never
    // fabricates the browser's result. (ME08 wired the learned skills the
    // same way — see the mastra-learned-skills suite.)
    const harness = await carrier({
      fetch: () =>
        sse([
          {
            toolCall: {
              id: "call_web_1",
              name: "computer_navigate",
              args: "",
            },
          },
          { toolCall: { args: '{"url":"https://example.com"}' } },
          { finish: "tool_calls" },
          {
            usage: {
              prompt_tokens: 5,
              completion_tokens: 0,
              total_tokens: 5,
            },
          },
        ]),
    });
    setBuiltinExecutionEngine(() => "mastra");
    setMastraConversationRuntime({
      loadExecutionInput: async (_scope, input) => input,
      persistExecutionMessages: async () => {},
    } as never);
    try {
      const config = builtInAgentConfiguration(
        {
          id: "bot-a",
          name: "Bot A",
          type: "built_in",
          systemPrompt: "Follow the registered Bot instructions.",
          expertSource: "tenant_package",
        },
        { provider: "openai", defaultModel: "me01-model", plan: {} as never },
        null,
        [],
        "The deployment has a computer; use the browser for live pages.",
        [],
        null,
        undefined,
        undefined,
        harness.governedModel,
        { userId: "actor-a" },
        undefined,
      ) as {
        type: string;
        factory?: (context: {
          input: unknown;
          abortSignal: AbortSignal;
        }) => AsyncGenerator<BaseEvent>;
      };
      expect(config.type).toBe("custom");
      const events: { type: string }[] = [];
      for await (const event of config.factory({
        input: {
          threadId: "thread-1",
          runId: "client-run-1",
          messages: [{ id: "msg-1", role: "user", content: "use the tool" }],
          // The browser's `useFrontendTool` registrations ride every run.
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
          context: [],
          forwardedProps: {},
        },
        abortSignal: new AbortController().signal,
      })) {
        events.push(event as { type: string });
      }
      const types = events.map((event) => event.type);
      // The participation protocol reached the client: the call announced
      // with its arguments, and the server fabricated NO result.
      expect(types).toContain("TOOL_CALL_START");
      expect(types).toContain("TOOL_CALL_ARGS");
      expect(types).not.toContain("TOOL_CALL_RESULT");
      // Terminal-less suspension: the wait is the outcome, never a success.
      expect(types).not.toContain("RUN_FINISHED");
      expect(types).not.toContain("RUN_ERROR");
      expect(JSON.stringify(events)).not.toContain("MASTRA_TEXT_ONLY_SLICE");
    } finally {
      setBuiltinExecutionEngine(undefined);
      setMastraConversationRuntime(undefined);
    }
  });
});
