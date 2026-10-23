import { randomUUID } from "node:crypto";
import { PostgresStore } from "@mastra/pg";
import { z } from "zod";
import { describe, expect, it } from "../../tests/support/bun-test-compat";
import type { RunnerRequestLease } from "../src/enterprise/contracts";
import { classifyGovernedRunFailure } from "../src/enterprise/runs/governed-execution";
import { ModelInvocationError } from "../src/enterprise/runs/model-capability";
import { isRunnerRequestLeaseCurrent } from "../src/enterprise/runs/store";
import {
  argsDigestFor,
  createMastraTools,
  type MastraToolOperation,
} from "../src/mastra/tools";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { createMe01Database } from "./support/me01-fixture";
import {
  buildRequest,
  carrier,
  collectEvents,
  collectRawEvents,
  grantedEchoTool,
  sse,
  syntheticRuns,
  twoStepToolUpstream,
} from "./support/me04-harness";

/*
 * ME04 (#476) T5: the governed multi-step tool loop. Every model step mints
 * its own capability against the admitted ceiling (100 -> 70 -> next <= 30),
 * the granted tool executes exactly once through the wrapped grant path, a
 * 402 budget refusal stays terminal, the 8-step loop cap lands as a truthful
 * non-success terminal, and a revoked grant blocks new external calls while
 * the run's receipt stays associated with one operation.
 */

// Shared with the wrapper suite (mastra-tools.test.ts): the moved lease-guard
// test drives the raw controlled wrapper directly, not the governed harness.
function tool(spec: Partial<GrantedTool> = {}): GrantedTool {
  const name = spec.name ?? "mcp__server__echo_tool";
  return {
    name,
    description: spec.description ?? "Echo the value back.",
    parameters: spec.parameters ?? z.object({ value: z.string() }),
    execute:
      spec.execute ??
      (async () => {
        throw new Error("test tool reached its default execute");
      }),
    ref: spec.ref ?? `server/${name}`,
    ...(spec.initiator ? { initiator: spec.initiator } : {}),
  };
}

/** Invokes the wrapped Mastra tool the way the engine does. */
async function callTool(
  wrapped: unknown,
  input: unknown,
  context: unknown = { agent: { toolCallId: "call_1" } },
): Promise<unknown> {
  const execute = (wrapped as { execute?: unknown }).execute;
  if (typeof execute !== "function") {
    throw new Error("wrapped tool exposes no execute");
  }
  return (execute as (input: unknown, context: unknown) => Promise<unknown>)(
    input,
    context,
  );
}

describe("governed Mastra tool loop", () => {
  it("granted_tool_executes_once", async () => {
    const executions: unknown[] = [];
    // OCR fix wave 3 (R3-3): the operation identity observed through the REAL
    // engine loop — the unit suite's synthetic context cannot prove the
    // locked engine carries the call id the identity keys on, so the
    // integration probe pins it here.
    const operations: MastraToolOperation[] = [];
    let dials = 0;
    const harness = await carrier({
      fetch: () => {
        dials += 1;
        return twoStepToolUpstream()(dials);
      },
    });
    const outcome = await collectEvents(
      buildRequest(harness, {
        tools: [grantedEchoTool({ executions })],
        onToolOperation: (operation) => operations.push(operation),
      }),
    );
    expect(outcome.error).toBeUndefined();
    const types = outcome.events.map((event) => event.type);
    // Two model steps (tool-call, then the answer), one granted execute.
    expect(dials).toBe(2);
    expect(executions).toEqual([{ value: "hi" }]);
    expect(types.at(-1)).toBe("RUN_FINISHED");
    // The proposal and the real result are both on the stream, keyed by the
    // engine's one call id — never a fabricated result.
    expect(
      outcome.events.filter((event) => event.type === "TOOL_CALL_START"),
    ).toHaveLength(1);
    expect(
      outcome.events.filter((event) => event.type === "TOOL_CALL_RESULT"),
    ).toHaveLength(1);
    // The one operation the engine drove carries a NON-EMPTY engine call id —
    // the exact id the stream proposed — so retries/recovery keep one
    // identity instead of silently degrading to unkeyed mints.
    expect(operations).toHaveLength(1);
    expect(operations[0]!.toolCallId).toBe("call_1");
    expect(operations[0]!.toolCallId.length).toBeGreaterThan(0);
    expect(operations[0]!.argsDigest).toBe(argsDigestFor({ value: "hi" }));
    expect(harness.settlementClean()).toBe(true);
  });

  it("each_step_issues_distinct_capability", async () => {
    const executions: unknown[] = [];
    const runs = syntheticRuns();
    let dials = 0;
    const harness = await carrier({
      runs,
      fetch: () => {
        dials += 1;
        return twoStepToolUpstream()(dials);
      },
    });
    const outcome = await collectEvents(
      buildRequest(harness, {
        tools: [grantedEchoTool({ executions })],
      }),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.events.at(-1)?.type).toBe("RUN_FINISHED");
    // Two steps, two freshly minted capabilities (distinct model request ids
    // and distinct capability tokens), each settled authoritatively once.
    expect(runs.capabilitiesIssued).toHaveLength(2);
    expect(
      new Set(runs.capabilitiesIssued.map((entry) => entry.modelRequestId))
        .size,
    ).toBe(2);
    expect(runs.capabilitiesConfirmed).toHaveLength(2);
    expect(
      new Set(runs.capabilitiesConfirmed.map((entry) => entry.capability)).size,
    ).toBe(2);
    expect(harness.settlementClean()).toBe(true);
  });

  it("budget_100_70_next_le_30", async () => {
    // The spec's own arithmetic: a 100-token run ceiling, step one settling
    // 70 actual tokens, the next step's capability asking for no more than
    // the remaining 30 — while the granted tool executes exactly once in
    // between.
    const executions: unknown[] = [];
    const runs = syntheticRuns();
    let dials = 0;
    const harness = await carrier({
      ceiling: 100,
      runs,
      fetch: () => {
        dials += 1;
        return twoStepToolUpstream()(dials);
      },
    });
    const outcome = await collectEvents(
      buildRequest(harness, {
        tools: [grantedEchoTool({ executions })],
      }),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.events.at(-1)?.type).toBe("RUN_FINISHED");
    expect(executions).toEqual([{ value: "hi" }]);
    expect(runs.capabilitiesIssued.map((entry) => entry.maximumTokens)).toEqual(
      [100, 30],
    );
    expect(runs.capabilitiesConfirmed).toHaveLength(2);
    expect(harness.settlementClean()).toBe(true);
  });

  it("budget_402_no_retry_no_route_switch", async () => {
    // A terminal 402 at capability issue: no retry against the same ceiling,
    // no second dial toward any other route or payer — one model step
    // attempt, an error terminal, the fixed classification.
    const runs = syntheticRuns({
      issueError: new ModelInvocationError("MODEL_BUDGET_EXCEEDED", 402),
    });
    let dials = 0;
    const harness = await carrier({
      runs,
      fetch: () => {
        dials += 1;
        return sse([
          { content: "should never be reached" },
          { finish: "stop" },
          {
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ]);
      },
    });
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
        tools: [grantedEchoTool({})],
        governedModel: {
          model: counted as unknown as typeof harness.governedModel.model,
          maxOutputTokens: harness.governedModel.maxOutputTokens,
          markConsumed: () => harness.governedModel.markConsumed(),
          executionBinding: () =>
            harness.governedModel.executionBinding?.() ?? null,
        },
      }),
    );
    // The 402 fires at capability issue, before any upstream dial: exactly
    // one model step attempt, zero upstream dials, zero capabilities issued.
    expect(modelCalls).toBe(1);
    expect(dials).toBe(0);
    expect(runs.capabilitiesIssued).toHaveLength(0);
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

  it("tool_loop_cap_eight_truthful_terminal", async () => {
    // The provider NEVER answers without requesting the tool: the loop must
    // stop at the existing 8-step cap, execute the granted tool at most once
    // per step, and end with a truthful terminal — never a fabricated
    // complete success.
    const executions: unknown[] = [];
    let dials = 0;
    const alwaysTool = () =>
      sse([
        {
          toolCall: {
            id: `call_${dials}`,
            name: "mcp__server__echo_tool",
            args: '{"value":"hi"}',
          },
        },
        { finish: "tool_calls" },
        {
          usage: { prompt_tokens: 2, completion_tokens: 0, total_tokens: 2 },
        },
      ]);
    const runs = syntheticRuns();
    const harness = await carrier({
      ceiling: 4096,
      runs,
      fetch: () => {
        dials += 1;
        return alwaysTool();
      },
    });
    const outcome = await collectEvents(
      buildRequest(harness, {
        tools: [grantedEchoTool({ executions })],
      }),
    );
    // The cap: exactly 8 model steps, 8 granted executions, then the loop
    // stops dialling.
    expect(dials).toBe(8);
    expect(executions).toHaveLength(8);
    const types = outcome.events.map((event) => event.type);
    expect(types).not.toContain("RUN_FINISHED");
    expect(types.at(-1)).toBe("RUN_ERROR");
    const terminal = outcome.events.at(-1) as { message?: unknown };
    expect(String(terminal.message)).toContain("tool-call step");
    // Every step still settled authoritatively: 8 capabilities, 8
    // confirmations — the run stops truthfully, not by leaking budget.
    expect(runs.capabilitiesIssued).toHaveLength(8);
    expect(runs.capabilitiesConfirmed).toHaveLength(8);
  });

  it("revoked_grant_blocks_new_external_call", async () => {
    // The granted execute path re-checks the grant at run time (the store
    // reads grants fresh per call). Revoke between the two model steps: the
    // second proposal's external call never goes out — the model receives
    // the refusal sentence instead, and the run completes truthfully on it.
    const executions: unknown[] = [];
    const revoked = { value: false };
    let dials = 0;
    const harness = await carrier({
      fetch: () => {
        dials += 1;
        if (dials === 2) revoked.value = true;
        return twoStepToolUpstream()(dials);
      },
    });
    const granted: GrantedTool = grantedEchoTool({ executions, revoked });
    const outcome = await collectEvents(
      buildRequest(harness, { tools: [granted] }),
    );
    expect(outcome.error).toBeUndefined();
    // Exactly ONE external execution: step 1's. The revoked step 2 call was
    // refused by the granted path — never executed, never silently dropped.
    expect(executions).toEqual([{ value: "hi" }]);
    expect(
      outcome.events.filter((event) => event.type === "TOOL_CALL_RESULT"),
    ).toHaveLength(1);
    const types = outcome.events.map((event) => event.type);
    expect(types.at(-1)).toBe("RUN_FINISHED");
    expect(harness.settlementClean()).toBe(true);
  });

  it("operation_receipt_associated_once", async () => {
    // A real disposable store: the whole two-step loop writes exactly ONE
    // receipt row, whose digest is the digest the wrapper associated with
    // the engine's one tool call id.
    const database = await createMe01Database();
    let store: PostgresStore | undefined;
    try {
      store = new PostgresStore({
        id: `me04-${randomUUID().slice(0, 8)}`,
        connectionString: database.runtimeUrl,
      });
      await store.pool.query(`CREATE TABLE IF NOT EXISTS me04_tool_receipts (
           id serial PRIMARY KEY,
           run_id text NOT NULL,
           args_digest text NOT NULL,
           executed_at timestamptz NOT NULL DEFAULT now()
         )`);
      const receipts: string[] = [];
      let dials = 0;
      const harness = await carrier({
        fetch: () => {
          dials += 1;
          return twoStepToolUpstream()(dials);
        },
      });
      const granted: GrantedTool = {
        name: "mcp__server__echo_tool",
        description: "Echo the value back.",
        parameters: z.object({ value: z.string() }),
        execute: async (args) => {
          const digest = argsDigestFor(args);
          await store!.pool.query(
            `INSERT INTO me04_tool_receipts (run_id, args_digest) VALUES ($1, $2)`,
            ["server-run-1", digest],
          );
          receipts.push(digest);
          return "echoed:hi";
        },
        ref: "server/mcp__server__echo_tool",
      };
      // The loop runs through the governed entry so the ENGINE drives the
      // granted tool through the production wrapper.
      const outcome = await collectRawEvents(
        buildRequest(harness, { tools: [granted] }),
      );
      expect(outcome.error).toBeUndefined();
      expect(outcome.events.at(-1)?.type).toBe("RUN_FINISHED");
      // Exactly one execute, one receipt row, one proposal — associated
      // once, under the engine's one call id and the same digest.
      expect(receipts).toHaveLength(1);
      const count = await store.pool.query(
        `SELECT count(*)::int AS n FROM me04_tool_receipts WHERE run_id = 'server-run-1'`,
      );
      expect(Number((count as { rows: { n: number }[] }).rows[0]!.n)).toBe(1);
      const proposals = outcome.events.filter(
        (event) => event.type === "TOOL_CALL_START",
      ) as unknown as { toolCallId: string }[];
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.toolCallId).toBe("call_1");
      expect(receipts[0]).toBe(argsDigestFor({ value: "hi" }));
    } finally {
      await store?.close().catch(() => undefined);
      await database.drop();
    }
  });

  it("lost_lease_blocks_new_external_call", async () => {
    // Before each external call the wrapper checks the run's stop wire and
    // the lease-current probe. The probe composes the RUNNER's own fencing
    // (isRunnerRequestLeaseCurrent over a RunnerRequestLease) — no second
    // fencing scheme is invented here.
    const lease: RunnerRequestLease = {
      runId: "server-run-1",
      attemptId: "attempt-1",
      generation: 1,
      ownerToken: "owner-1",
      expiresAt: new Date(Date.now() + 60_000),
    };
    const calls: unknown[] = [];
    const granted = tool({
      execute: async (args) => {
        calls.push(args);
        return "echoed:hi";
      },
    });
    // Lease current: the call goes out, exactly once.
    const live = createMastraTools([granted], {
      leaseCurrent: () =>
        isRunnerRequestLeaseCurrent(
          { ...lease, expiresAt: new Date(Date.now() + 60_000) },
          lease,
        ),
    });
    await callTool(live.mcp__server__echo_tool, { value: "hi" });
    expect(calls).toHaveLength(1);
    // A lost/re-owned lease blocks any NEW external call with a named
    // refusal, before the granted path runs.
    const lostLease: RunnerRequestLease = {
      ...lease,
      ownerToken: "owner-2",
      expiresAt: new Date(Date.now() + 60_000),
    };
    const stale = createMastraTools([granted], {
      leaseCurrent: () =>
        isRunnerRequestLeaseCurrent(
          { ...lease, expiresAt: new Date(Date.now() + 60_000) },
          lostLease,
        ),
    });
    await expect(
      callTool(stale.mcp__server__echo_tool, { value: "hi" }),
    ).rejects.toThrow(/MASTRA_TOOL_LEASE_NOT_CURRENT/);
    expect(calls).toHaveLength(1);
    // The same guard answers the existing abort signal: after a stop no new
    // external call may start.
    const controller = new AbortController();
    const stopped = createMastraTools([granted], {
      signal: controller.signal,
    });
    await callTool(stopped.mcp__server__echo_tool, { value: "hi" });
    expect(calls).toHaveLength(2);
    controller.abort();
    await expect(
      callTool(stopped.mcp__server__echo_tool, { value: "hi" }),
    ).rejects.toThrow(/MASTRA_TOOL_RUN_NOT_CURRENT/);
    expect(calls).toHaveLength(2);
  });
});
