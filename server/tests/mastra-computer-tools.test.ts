import type { BaseEvent } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { z } from "zod";
import { describe, expect, it } from "../../tests/support/bun-test-compat";
import {
  createMastraComputerTools,
  scopedComputerEnvironmentKey,
  scopedComputerGateway,
} from "../src/mastra/computer-scope";
import { statusForRefusal } from "../src/mastra/continuation-routes";
import { runMastraExecution } from "../src/mastra/execution";
import type {
  ExecutionRequest,
  MastraSuspensionFact,
} from "../src/mastra/execution-contracts";
import {
  createFrontendBridgeTools,
  type FrontendToolDefinition,
} from "../src/mastra/frontend-tools";
import {
  MastraStreamNormalizer,
  normalizeMastraChunks,
} from "../src/mastra/stream-events";
import { argsDigestFor } from "../src/mastra/tools";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import {
  ME06_TOOL_DEFINITION as NAVIGATE_DEFINITION,
  startFrontendProvider,
} from "./support/me06-fixture";

/*
 * ME06 (#478) unit slice: the frontend (client-participation) tool bridge and
 * the durable frontend_tool suspension.
 *
 * AC2: a tool that needs the browser is mounted as an INERT bridge — the
 * model's call suspends the engine (tool-call-suspended) after the
 * TOOL_CALL_START/ARGS events reached the client, and the server executes
 * nothing on the client's behalf (no fabricated result path). The real
 * client result enters only through the resume drive, which the integration
 * suite proves across processes.
 *
 * The engine here is the REAL pinned @mastra/core agent against a scripted
 * loopback provider (the ME01 probe geometry), not a chunk replay fixture —
 * the execute-context shape (context.agent.{toolCallId,suspend,resumeData})
 * is asserted against the locked engine (re-review O11).
 */

function frontendAgent(options: {
  providerUrl: string;
  definitions: readonly FrontendToolDefinition[];
  observedContexts?: Record<string, unknown>[];
  clientHandlerCalls?: unknown[];
}): { agent: Agent; mastra: Mastra } {
  const openai = createOpenAI({
    apiKey: "me06-synthetic-key",
    baseURL: `${options.providerUrl}/v1`,
  });
  const bridges = createFrontendBridgeTools(options.definitions, {
    ...(options.observedContexts
      ? {
          onExecuteContext: (context: unknown) => {
            options.observedContexts.push(context as Record<string, unknown>);
          },
        }
      : {}),
  });
  const agent = new Agent({
    id: "me06-agent",
    name: "ME06 Agent",
    instructions: "Use the computer when asked, then answer briefly.",
    model: openai.chat("me06-model") as never,
    ...(Object.keys(bridges).length > 0 ? { tools: bridges } : {}),
  });
  const mastra = new Mastra({ agents: { "me06-agent": agent } });
  return { agent, mastra };
}

function requestWith(input: {
  providerUrl: string;
  definitions: readonly FrontendToolDefinition[];
  durableToolNames?: readonly string[];
  suspensions: MastraSuspensionFact[];
  events: BaseEvent[];
  grantedTools?: readonly GrantedTool[];
}): ExecutionRequest {
  const openai = createOpenAI({
    apiKey: "me06-synthetic-key",
    baseURL: `${input.providerUrl}/v1`,
  });
  const { agent, mastra } = frontendAgent({
    providerUrl: input.providerUrl,
    definitions: input.definitions,
  });
  void mastra;
  const request: ExecutionRequest = {
    binding: {
      scope: {
        tenantId: "tenant-me06",
        workspaceId: "workspace-me06",
        principalId: "principal-me06",
        actorId: "actor-me06",
        memberEpoch: 1,
        aclEpoch: 1,
        entrypoint: "web",
      },
      botId: "bot-me06",
      runId: "run-me06",
      attemptId: "attempt-me06",
      generation: 1,
      executionKey: `exec-${Math.random().toString(36).slice(2, 10)}`,
      threadId: "thread-me06",
    },
    input: {
      threadId: "thread-me06",
      runId: "client-run-me06",
      messages: [{ id: "msg-1", role: "user", content: "open example.com" }],
      tools: [],
      context: [],
      forwardedProps: {},
    },
    instructions: ["You are the ME06 Bot."],
    tools: input.grantedTools ?? [],
    ...(input.definitions.length > 0
      ? { frontendTools: input.definitions }
      : {}),
    governedModel: {
      model: openai.chat("me06-model") as never,
      maxOutputTokens: 4096,
      markConsumed: () => undefined,
    },
    ...(input.durableToolNames || input.suspensions.length >= 0
      ? {
          continuations: {
            onSuspension: (suspension: MastraSuspensionFact) => {
              input.suspensions.push(suspension);
              return Promise.resolve();
            },
            ...(input.durableToolNames
              ? { durableToolNames: input.durableToolNames }
              : {}),
          },
        }
      : {}),
    signal: new AbortController().signal,
  };
  void agent;
  return request;
}

async function drainRun(
  request: ExecutionRequest,
): Promise<{ terminal: BaseEvent | undefined; events: BaseEvent[] }> {
  const events: BaseEvent[] = [];
  let terminal: BaseEvent | undefined;
  await new Promise<void>((resolve, reject) => {
    runMastraExecution(request).subscribe({
      next: (event) => {
        if (
          event.type === EventType.RUN_FINISHED ||
          event.type === EventType.RUN_ERROR
        ) {
          terminal = event;
        }
        events.push(event);
      },
      error: reject,
      complete: () => resolve(),
    });
  });
  return { terminal, events };
}

async function withProvider(
  run: (
    provider: Awaited<ReturnType<typeof startFrontendProvider>>,
  ) => Promise<void>,
): Promise<void> {
  const provider = await startFrontendProvider(NAVIGATE_DEFINITION.name);
  try {
    await run(provider);
  } finally {
    await provider.close();
  }
}

describe("ME06 frontend bridge tools", () => {
  it("frontend_tool_call_suspends_the_engine_and_announces_the_call_without_a_server_result", async () => {
    await withProvider(async (provider) => {
      const observed: Record<string, unknown>[] = [];
      const { agent } = frontendAgent({
        providerUrl: provider.url,
        definitions: [NAVIGATE_DEFINITION],
        observedContexts: observed,
      });
      const output = await agent.stream(
        [{ role: "user", content: "open example.com" }] as never,
        { runId: "me06-suspend-probe", maxSteps: 8 } as never,
      );
      const reader = output.fullStream.getReader();
      const chunkTypes: string[] = [];
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunkTypes.push(String((next.value as { type?: string }).type));
      }
      // The engine paused ON the frontend tool call — the client participation
      // wait, not a completion and not a tool error.
      expect(await output.finishReason).toBe("suspended");
      expect(chunkTypes).toContain("tool-call-suspended");
      // The model loop dialled exactly once (the tool call round); the answer
      // round never ran because no result was fabricated.
      expect(provider.requests).toHaveLength(1);

      // O11: the REAL engine's execute context carries the toolCallId the
      // operation identity keys on, plus the suspend/resumeData surface.
      expect(observed.length).toBeGreaterThan(0);
      const context = observed[0] as {
        agent?: {
          toolCallId?: unknown;
          suspend?: unknown;
          resumeData?: unknown;
        };
      };
      expect(context.agent?.toolCallId).toBe("call_fe_1");
      expect(typeof context.agent?.suspend).toBe("function");
      expect(context.agent?.resumeData).toBeUndefined();
    });
  });

  it("bridge_returns_the_real_client_result_on_resume_and_the_loop_continues", async () => {
    await withProvider(async (provider) => {
      const { agent } = frontendAgent({
        providerUrl: provider.url,
        definitions: [NAVIGATE_DEFINITION],
      });
      const first = await agent.stream(
        [{ role: "user", content: "open example.com" }] as never,
        { runId: "me06-resume-probe", maxSteps: 8 } as never,
      );
      const firstReader = first.fullStream.getReader();
      for (;;) {
        const next = await firstReader.read();
        if (next.done) break;
      }
      expect(await first.finishReason).toBe("suspended");

      // The client's REAL, authenticated result re-enters through the resume
      // drive surface (resumeStream(clientResult, { runId, toolCallId })).
      const clientResult = {
        ok: true,
        url: "https://example.com",
        title: "Example",
      };
      const resumed = await agent.resumeStream(
        clientResult as never,
        {
          runId: "me06-resume-probe",
          toolCallId: "call_fe_1",
          maxSteps: 8,
        } as never,
      );
      const reader = resumed.fullStream.getReader();
      const types: string[] = [];
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        types.push(String((next.value as { type?: string }).type));
      }
      expect(await resumed.finishReason).toBe("stop");
      expect(types).toContain("tool-result");
      expect(await resumed.text).toContain(
        "answered from the client tool result",
      );
      // The answer round really dialled: two provider turns total.
      expect(provider.requests).toHaveLength(2);
    });
  });

  it("bridge_mount_skips_a_client_declaration_that_collides_with_a_granted_tool", () => {
    const granted: GrantedTool = {
      name: "computer_navigate",
      description: "Server-executed navigation.",
      parameters: z.object({ url: z.string() }),
      execute: async () => "executed server-side",
      ref: "server/computer_navigate",
    };
    const bridges = createFrontendBridgeTools([NAVIGATE_DEFINITION], {
      grantedNames: ["computer_navigate"],
    });
    expect(Object.keys(bridges)).toHaveLength(0);
    void granted;
  });
});

/**
 * A granted (server-executed) tool that must never reach its execute in the
 * approval-pause test: if the durable pause fails to fire, the throw surfaces
 * as a terminal RUN_ERROR and the test fails loudly instead of passing on a
 * fabricated flow.
 */
const GRANTED_CLICK_TOOL: GrantedTool = {
  name: "computer_click",
  description: "Click a page element, server-side.",
  parameters: z.object({ selector: z.string() }),
  execute: async () => {
    throw new Error(
      "MASTRA_TEST_GRANTED_EXECUTE_REACHED: the approval pause did not fire.",
    );
  },
  ref: "server/computer_click",
};

describe("ME06 frontend_tool suspension kind (execution wiring)", () => {
  it("frontend_tool_suspension_saves_a_frontend_tool_continuation_fact", async () => {
    await withProvider(async (provider) => {
      const suspensions: MastraSuspensionFact[] = [];
      const request = requestWith({
        providerUrl: provider.url,
        definitions: [NAVIGATE_DEFINITION],
        suspensions,
      });
      const { terminal, events } = await drainRun(request);
      // Terminal-less suspension: no success, no error — the participation wait.
      expect(terminal).toBeUndefined();
      // The client saw the call announced with its arguments, and no result.
      expect(
        events.some(
          (event) =>
            event.type === EventType.TOOL_CALL_START &&
            (event as { toolCallName?: string }).toolCallName ===
              NAVIGATE_DEFINITION.name,
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === EventType.TOOL_CALL_ARGS &&
            (event as { delta?: string }).delta?.includes("example.com"),
        ),
      ).toBe(true);
      expect(
        events.some((event) => event.type === EventType.TOOL_CALL_RESULT),
      ).toBe(false);

      // The durable suspension names the EXACT call, digested server-side,
      // with the frontend_tool kind the continuation ledger reserved.
      expect(suspensions).toHaveLength(1);
      const fact = suspensions[0];
      expect(fact.kind).toBe("frontend_tool");
      expect(fact.toolName).toBe(NAVIGATE_DEFINITION.name);
      expect(fact.toolCallId).toBe("call_fe_1");
      expect(fact.argsDigest).toBe(
        argsDigestFor({ url: "https://example.com" }),
      );
      expect(fact.operationId.startsWith("op_")).toBe(true);
      expect(fact.snapshotRef).toContain(fact.toolCallId);
    });
  });

  it("approval_pause_still_saves_an_approval_fact_alongside_frontend_tools", async () => {
    // A granted connector tool carrying the ME05 durable approval pause,
    // mounted ALONGSIDE the frontend bridges, keeps its approval semantics.
    // The provider script names the GRANTED tool on turn 0 (the fixture's
    // toolName parameter), so the real engine's requireApproval pause fires
    // before the granted execute could run; the saved fact is the ME05
    // "approval" kind on the same ledger — not the frontend_tool kind the
    // mounted bridges produce. The granted execute throws if it is ever
    // reached, so a pause that fails to fire fails the test loudly.
    const provider = await startFrontendProvider(GRANTED_CLICK_TOOL.name);
    try {
      const suspensions: MastraSuspensionFact[] = [];
      const request = requestWith({
        providerUrl: provider.url,
        definitions: [NAVIGATE_DEFINITION],
        grantedTools: [GRANTED_CLICK_TOOL],
        durableToolNames: [GRANTED_CLICK_TOOL.name],
        suspensions,
      });
      const { terminal, events } = await drainRun(request);
      // The approval wait is terminal-less, exactly like the ME05 pause.
      expect(terminal).toBeUndefined();
      expect(
        events.some((event) => event.type === EventType.TOOL_CALL_START),
      ).toBe(true);
      expect(suspensions).toHaveLength(1);
      expect(suspensions[0]?.kind).toBe("approval");
      expect(suspensions[0]?.toolName).toBe(GRANTED_CLICK_TOOL.name);
    } finally {
      await provider.close();
    }
  });
});

describe("ME06 continuation route refusal status map", () => {
  it("unwired_install_refusal_maps_to_503_not_500", () => {
    // F7 (ME10): the ONE UNWIRED composition refusal (no durable
    // continuation install) is a configuration boundary — the same request
    // succeeds on a fully wired deployment — so the route surfaces it as
    // 503, not a caller-mistake 4xx and not a generic 500. The stale
    // MASTRA_RESUME_LOOP_MODEL_UNWIRED mapping is gone with the placeholder
    // refusal itself (ME09 wired the resumed loop's governed re-binding);
    // an unknown code falls to the generic 500 like any other.
    expect(statusForRefusal("MASTRA_CONTINUATIONS_UNWIRED")).toBe(503);
    expect(statusForRefusal("MASTRA_RESUME_LOOP_MODEL_UNWIRED")).toBe(500);
    // Known and unknown named codes keep their existing mapping.
    expect(statusForRefusal("MASTRA_CONTINUATION_GRANT_REVOKED")).toBe(403);
    expect(statusForRefusal("MASTRA_CONTINUATION_NOT_FOUND")).toBe(404);
    expect(statusForRefusal("MASTRA_CONTINUATION_REVISION_CONFLICT")).toBe(409);
    expect(statusForRefusal("MASTRA_SOMETHING_ELSE")).toBe(500);
  });
});

describe("ME06 stream normalization of tool-call-suspended", () => {
  it("tool_call_suspended_chunk_is_a_known_suspension_naming_the_call", () => {
    const normalizer = new MastraStreamNormalizer({
      threadId: "thread-1",
      runId: "run-1",
    });
    normalizer.push({ type: "start" });
    normalizer.push({
      type: "tool-call",
      payload: {
        toolCallId: "call_9",
        toolName: "computer_navigate",
        args: {},
      },
    });
    normalizer.push({
      type: "tool-call-suspended",
      payload: { toolCallId: "call_9", toolName: "computer_navigate" },
    });
    normalizer.push({
      type: "finish",
      payload: { stepResult: { reason: "suspended" } },
    });
    const result = normalizer.result;
    expect(result.outcome).toBe("suspended");
    expect(result.suspendedToolCallId).toBe("call_9");
    // Terminal-less: no success and no error event may exist.
    const types = result.events.map((event) => event.type);
    expect(types).not.toContain(EventType.RUN_FINISHED);
    expect(types).not.toContain(EventType.RUN_ERROR);
  });

  it("suspend_pause_supersedes_an_earlier_tool_calls_step_end", () => {
    const normalized = normalizeMastraChunks(
      [
        { type: "start" },
        { type: "finish", payload: { stepResult: { reason: "tool-calls" } } },
        {
          type: "tool-call",
          payload: { toolCallId: "call_10", toolName: "t", args: {} },
        },
        {
          type: "tool-call-suspended",
          payload: { toolCallId: "call_10", toolName: "t" },
        },
      ],
      { threadId: "thread-1", runId: "run-1" },
    );
    // A real suspension is the resumable pause, never the loop cut.
    expect(normalized.outcome).toBe("suspended");
    expect(normalized.suspendedToolCallId).toBe("call_10");
  });
});

describe("ME06 computer scope resolution (AC1)", () => {
  const baseScope = {
    tenantId: "tenant-a",
    workspaceId: "workspace-a",
    principalId: "principal-a",
    actorId: "actor-a",
    memberEpoch: 1,
    aclEpoch: 1,
    entrypoint: "web" as const,
  };

  it("same_bot_across_two_scopes_resolves_two_different_environments", () => {
    const scopeB = {
      ...baseScope,
      tenantId: "tenant-b",
      workspaceId: "workspace-b",
      principalId: "principal-b",
      actorId: "actor-b",
    };
    // The SAME global bot id under two business scopes never resolves to one
    // shared environment: the scope-composed address is injective.
    const keyA = scopedComputerEnvironmentKey(baseScope, "bot-shared");
    const keyB = scopedComputerEnvironmentKey(scopeB, "bot-shared");
    expect(keyA).not.toBe(keyB);
    // Deterministic: the same binding resolves to the same address (the
    // stable operation identity a resumed run re-resolves).
    expect(scopedComputerEnvironmentKey(baseScope, "bot-shared")).toBe(keyA);
    // Every scope segment is IN the address: no silent coarsening to the
    // tenant or the bot alone.
    for (const segment of [
      baseScope.tenantId,
      baseScope.workspaceId,
      baseScope.principalId,
      baseScope.actorId,
    ]) {
      expect(keyA).toContain(segment);
    }
  });

  it("scoped_gateway_view_refuses_raw_global_bot_addressing", async () => {
    const calls: { method: string; botId: string }[] = [];
    const gateway = {
      async snapshot(botId: string) {
        calls.push({ method: "snapshot", botId });
        return { ok: true };
      },
      async navigate(botId: string) {
        calls.push({ method: "navigate", botId });
        return { ok: true };
      },
    };
    const scoped = scopedComputerGateway(gateway as never, {
      scope: baseScope,
      botId: "bot-shared",
    });
    // The scoped key goes through and reaches the gateway alone.
    const owned = scopedComputerEnvironmentKey(baseScope, "bot-shared");
    await scoped.snapshot(owned);
    expect(calls).toEqual([{ method: "snapshot", botId: owned }]);
    // The RAW global bot id — the shared-state addressing ADR 0006 forbids —
    // is refused by name, before the gateway can be touched.
    await expect(scoped.snapshot("bot-shared")).rejects.toThrow(
      "MASTRA_COMPUTER_ENVIRONMENT_SCOPE_REFUSED",
    );
    // A FOREIGN scope's key is equally refused: one binding addresses one
    // environment, never another's.
    const foreign = scopedComputerEnvironmentKey(
      { ...baseScope, actorId: "actor-other" },
      "bot-shared",
    );
    await expect(scoped.navigate(foreign)).rejects.toThrow(
      "MASTRA_COMPUTER_ENVIRONMENT_SCOPE_REFUSED",
    );
    expect(calls).toHaveLength(1);
    // Non-address arguments pass through untouched (the view wraps only the
    // environment addressing, not the payload).
    void gateway;
  });

  it("mastra_computer_tools_assembly_addresses_the_gateway_by_scoped_key", async () => {
    const calls: { method: string; botId: string }[] = [];
    const gateway = {
      async snapshot(botId: string) {
        calls.push({ method: "snapshot", botId });
        return {
          ok: true,
          fields: [],
          ref: "r1",
        };
      },
    };
    const binding = {
      scope: baseScope,
      botId: "bot-shared",
      runId: "run-1",
      attemptId: "attempt-1",
      generation: 1,
      executionKey: "exec-1",
    };
    const tools = createMastraComputerTools(binding as never, {
      gateway: gateway as never,
    });
    const snapshot = tools.find(
      (tool) => tool.definition.name === "computer_snapshot",
    );
    expect(snapshot).toBeDefined();
    // The tool executes the gateway with the SCOPE-COMPOSED address — the
    // raw global bot id never reaches the environment layer.
    await snapshot?.execute(
      {},
      { toolCallId: "call_1", signal: new AbortController().signal },
    );
    const scopedKey = scopedComputerEnvironmentKey(baseScope, "bot-shared");
    expect(calls).toEqual([{ method: "snapshot", botId: scopedKey }]);
    expect(calls[0]!.botId).not.toBe("bot-shared");
  });

  it("environment_address_rejects_injected_or_unshaped_ids", () => {
    for (const bad of ["tenant/a", "tenant b", "", "tenant=x", "line\nbreak"]) {
      expect(() =>
        scopedComputerEnvironmentKey(
          { ...baseScope, tenantId: bad },
          "bot-shared",
        ),
      ).toThrow("MASTRA_COMPUTER_ENVIRONMENT_SCOPE_INVALID");
    }
  });
});
