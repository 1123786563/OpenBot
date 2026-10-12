import { describe, expect, test } from "bun:test";
import { createCodeRunGateway, TASK_PREAMBLE } from "../src/codesandbox/gateway";
import type { SandboxClient } from "../src/codesandbox/client";
import type { CodeRunStore } from "../src/codesandbox/store";

function fakeClient(overrides: Partial<SandboxClient> = {}): SandboxClient {
  return {
    createSession: async () => "ses_x",
    sendMessage: async (_sessionId: string, _text: string) => ({
      sessionId: "ses_x",
      text: "算完了：答案是 42。",
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
    listFiles: async () => ["hello.py"],
    readFile: async (path: string) => ({
      path,
      size: 6,
      content: "print(1)",
      truncated: false,
    }),
    resetWorkspace: async () => undefined,
    ...overrides,
  } as SandboxClient;
}

function fakeStore() {
  const rows = new Map<string, Record<string, unknown>>();
  const store: CodeRunStore = {
    create: async (input) => {
      rows.set(input.id, { ...input, status: "running" });
    },
    finish: async (id, patch) => {
      rows.set(id, { ...rows.get(id), ...patch });
    },
    get: async (id) => rows.get(id) as never,
  };
  return { rows, store };
}

function fakeAudit(log?: string[]) {
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    store: {
      async insert(event: { eventType: string; payload: Record<string, unknown> }) {
        if (log) log.push(`audit:${event.eventType}`);
        events.push(event);
      },
    } as never,
  };
}

const baseOptions = {
  botId: "bot-1",
  ownerUserId: "user-1",
  initiator: { kind: "person" } as never,
  modelId: "GLM-5.3",
};

describe("code run gateway", () => {
  test("a run records started before the sandbox is called, completed after, and stores usage", async () => {
    const { rows, store } = fakeStore();
    const audit = fakeAudit();
    const seen: string[] = [];
    const client = fakeClient({
      sendMessage: async (sessionId, text) => {
        seen.push(`sandbox-called:${text.includes(TASK_PREAMBLE)}`);
        return { sessionId, text: "42", usage: { inputTokens: 9, outputTokens: 4 } };
      },
    });
    const gateway = createCodeRunGateway({
      ...baseOptions,
      client,
      store,
      auditStore: audit.store,
    });
    const outcome = await gateway.run("算 6*7");
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    expect(outcome.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
    expect(seen[0]).toBe("sandbox-called:true");
    const started = audit.events.findIndex((e) => e.eventType === "code.run_started");
    const completed = audit.events.findIndex((e) => e.eventType === "code.run_completed");
    expect(started).toBeGreaterThanOrEqual(0);
    expect(completed).toBeGreaterThan(started);
    const row = [...rows.values()][0] as Record<string, unknown>;
    expect(row.status).toBe("completed");
    expect(row.inputTokens).toBe(9);
  });

  test("the metering hook receives the same completion timestamp the row persists", async () => {
    const { rows, store } = fakeStore();
    let seenOccurredAt: Date | undefined;
    const gateway = createCodeRunGateway({
      ...baseOptions,
      client: fakeClient(),
      store,
      onUsage: async (input) => {
        seenOccurredAt = (input as { occurredAt?: Date }).occurredAt;
      },
    });
    const outcome = await gateway.run("算 6*7");
    expect(outcome.kind).toBe("completed");
    const row = [...rows.values()][0] as Record<string, unknown>;
    expect(seenOccurredAt).toBeInstanceOf(Date);
    expect(row.finishedAt).toBe(seenOccurredAt);
  });

  test("an unconfigured sandbox refuses, and the refusal is audited and stored", async () => {
    const { rows, store } = fakeStore();
    const audit = fakeAudit();
    const gateway = createCodeRunGateway({
      ...baseOptions,
      client: null,
      store,
      auditStore: audit.store,
    });
    const outcome = await gateway.run("anything");
    expect(outcome.kind).toBe("refused");
    expect(audit.events.some((e) => e.eventType === "code.run_refused")).toBe(true);
    const row = [...rows.values()][0] as Record<string, unknown>;
    expect(row.status).toBe("refused");
  });

  test("a sandbox timeout lands as a failed run with the budget in the message", async () => {
    const { rows, store } = fakeStore();
    const audit = fakeAudit();
    const client = fakeClient({
      sendMessage: async () => {
        throw new (await import("../src/codesandbox/client")).CodeSandboxTimeoutError(120_000);
      },
    });
    const gateway = createCodeRunGateway({
      ...baseOptions,
      client,
      store,
      auditStore: audit.store,
    });
    const outcome = await gateway.run("慢任务");
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toMatch(/exceeded|budget|120000/i);
    const row = [...rows.values()][0] as Record<string, unknown>;
    expect(row.status).toBe("timeout");
    expect(audit.events.some((e) => e.eventType === "code.run_failed")).toBe(true);
  });

  test("artifacts are the files that appeared during the run, capped", async () => {
    const { store } = fakeStore();
    // Stateful listing: nothing exists before the run, six files exist after it — the gateway
    // only reports the difference, capped at maxArtifacts.
    let listed = 0;
    const client = fakeClient({
      listFiles: async () => {
        listed += 1;
        return listed > 1
          ? ["a.py", "b.csv", "c.bin", "d.txt", "e.md", "f.log"]
          : [];
      },
      readFile: async (path: string) => ({
        path,
        size: 3,
        content: "abc",
        truncated: false,
      }),
    });
    const gateway = createCodeRunGateway({
      ...baseOptions,
      client,
      store,
      maxArtifacts: 3,
    });
    const outcome = await gateway.run("生成一批文件");
    if (outcome.kind !== "completed") throw new Error("expected completed");
    expect(outcome.artifacts.map((a) => a.path)).toEqual(["a.py", "b.csv", "c.bin"]);
  });

  test("run converts timeoutSeconds into the sandbox budget, clamped to 1-600", async () => {
    const { store } = fakeStore();
    const budgets: Array<number | undefined> = [];
    const client = fakeClient({
      sendMessage: async (_sessionId: string, _text: string, options) => {
        budgets.push(options.timeoutMs);
        return { sessionId: "ses_x", text: "ok", usage: undefined };
      },
    });
    const gateway = createCodeRunGateway({ ...baseOptions, client, store });
    await gateway.run("a", { timeoutSeconds: 5 });
    await gateway.run("b"); // 缺省 → 120 秒
    await gateway.run("c", { timeoutSeconds: 0 }); // 越下界按缺省处理
    await gateway.run("d", { timeoutSeconds: 601 }); // 越上界钳到 600
    expect(budgets).toEqual([5_000, 120_000, 120_000, 600_000]);
  });

  test("the run's audit row carries the timeout budget actually used", async () => {
    const { store } = fakeStore();
    const audit = fakeAudit();
    const gateway = createCodeRunGateway({
      ...baseOptions,
      client: fakeClient(),
      store,
      auditStore: audit.store,
    });
    await gateway.run("慢任务", { timeoutSeconds: 90 });
    const started = audit.events.find((e) => e.eventType === "code.run_started");
    expect(started?.payload.timeoutMs).toBe(90_000);
  });

  test("resetWorkspace writes the audit row before the sandbox is told", async () => {
    const { store } = fakeStore();
    const order: string[] = [];
    const audit = fakeAudit(order);
    let resets = 0;
    const client = fakeClient({
      resetWorkspace: async () => {
        order.push("client:reset");
        resets += 1;
      },
    });
    const gateway = createCodeRunGateway({
      ...baseOptions,
      client,
      store,
      auditStore: audit.store,
    });
    const result = await gateway.resetWorkspace();
    expect(result).toEqual({ ok: true });
    expect(resets).toBe(1);
    expect(order).toEqual(["audit:code.workspace_reset", "client:reset"]);
  });

  test("resetWorkspace without a configured sandbox reports not-configured and sends nothing", async () => {
    const { store } = fakeStore();
    const audit = fakeAudit();
    const gateway = createCodeRunGateway({
      ...baseOptions,
      client: null,
      store,
      auditStore: audit.store,
    });
    const result = await gateway.resetWorkspace();
    expect(result).toEqual({ ok: false, reason: "not-configured" });
    // 拒绝也是一次治理决策：留在审计里，但没有任何 sandbox 调用发生。
    const refused = audit.events.find((e) => e.eventType === "code.workspace_reset");
    expect(refused?.payload.reason).toBe("not-configured");
  });
});

/*
 * ── startStreaming (B8) ───────────────────────────────────────────────────────────────────
 *
 * The streaming form holds the same discipline `run` does — audit first, code_runs row first —
 * and adds two endings of its own: a silent stream past the activity budget, and a cancel.
 */
describe("code run gateway: startStreaming", () => {
  /** A client whose stream produces a script of families, optionally with a silent gap. */
  function streamingClient(script: Array<
    | { family: string; delayMs?: number }
    | "end"
  >) {
    const calls: string[] = [];
    const aborted: string[] = [];
    let finishScript: () => void = () => undefined;
    const scriptDone = new Promise<void>((resolve) => {
      finishScript = resolve;
    });
    const client = {
      calls,
      createSession: async () => "ses_s",
      sendMessage: async () => {
        // A real message resolves when the model finishes — long after the first events. The
        // fake holds it open until the script ends (or the test tears down), so the stream's
        // own endings (timeout, cancel) are what the iterator observes.
        await scriptDone;
        return {
          sessionId: "ses_s",
          text: "done",
          usage: { inputTokens: 2, outputTokens: 3 },
        };
      },
      listFiles: async () => [],
      readFile: async (path: string) => ({
        path,
        size: 0,
        content: "",
        truncated: false,
      }),
      writeFile: async (path: string) => ({ path, size: 0 }),
      resetWorkspace: async () => undefined,
      abortSession: async (sessionId: string) => {
        aborted.push(sessionId);
      },
      subscribeEvents: async (onEvent: (event: { family: string; eventId: string; payload: Record<string, unknown> }) => void) => {
        calls.push("subscribe");
        void (async () => {
          for (const step of script) {
            if (step === "end") {
              finishScript();
              break;
            }
            if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
            onEvent({
              family: step.family,
              eventId: `evt_${Math.random().toString(36).slice(2, 8)}`,
              payload: {},
            });
          }
        })();
        return { stop: () => calls.push("stop") };
      },
    };
    return { client: client as never as SandboxClient, calls, getAborted: () => aborted };
  }

  test("① unconfigured sandbox: refused audit and row BEFORE the stream answers", async () => {
    const { rows, store } = fakeStore();
    const audit = fakeAudit();
    const gateway = createCodeRunGateway({
      ...baseOptions,
      client: null,
      store,
      auditStore: audit.store,
    });
    const streaming = await gateway.startStreaming("做点什么");
    // The refusal is already on the trail and in code_runs before any iteration.
    expect(audit.events[0]?.eventType).toBe("code.run_refused");
    expect(rows.get(streaming.runId)).toMatchObject({ status: "refused" });
    const seen: string[] = [];
    for await (const event of streaming.events) seen.push(event.family);
    expect(seen).toEqual(["unknown"]);
  });

  test("② a silent stream past the activity budget: rows settled timeout, iteration throws", async () => {
    const { rows, store } = fakeStore();
    const audit = fakeAudit();
    // One event, then silence forever: the activity clock runs out.
    const { client, calls } = streamingClient([
      { family: "progress" },
      { family: "never", delayMs: 10_000 },
    ]);
    const gateway = createCodeRunGateway({
      ...baseOptions,
      client,
      store,
      auditStore: audit.store,
    });
    const streaming = await gateway.startStreaming("慢任务", {
      activityTimeoutMs: 50,
    });
    let thrown: unknown;
    const seen: string[] = [];
    try {
      for await (const event of streaming.events) seen.push(event.family);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).name).toBe("CodeSandboxActivityTimeoutError");
    expect(seen).toEqual(["progress"]);
    expect(rows.get(streaming.runId)).toMatchObject({ status: "timeout" });
    expect(
      audit.events.some(
        (e) => e.eventType === "code.run_failed" && e.payload.timedOut === true,
      ),
    ).toBe(true);
    expect(calls).toContain("stop");
  });

  test("③ cancel: upstream aborted, code_runs settled, code.run_cancelled audited", async () => {
    const { rows, store } = fakeStore();
    const audit = fakeAudit();
    const { client, getAborted } = streamingClient([
      { family: "progress" },
      { family: "message_chunk", delayMs: 10_000 },
    ]);
    const gateway = createCodeRunGateway({
      ...baseOptions,
      client,
      store,
      auditStore: audit.store,
    });
    const streaming = await gateway.startStreaming("可取消任务", { activityTimeoutMs: 60_000 });
    const iterate = (async () => {
      const seen: string[] = [];
      for await (const event of streaming.events) seen.push(event.family);
      return seen;
    })();
    // Let the first event land, then cancel.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await streaming.cancel();
    const seen = await iterate;
    expect(seen).toEqual(["progress"]);
    expect(getAborted()).toEqual(["ses_s"]);
    expect(rows.get(streaming.runId)).toMatchObject({ status: "failed" });
    expect(
      audit.events.some((e) => e.eventType === "code.run_cancelled"),
    ).toBe(true);
  });
});

describe("code run gateway: the artifact hook's failure containment (B4 pin)", () => {
  test("an onArtifacts throw must not rewrite a completed run's outcome", async () => {
    const { rows, store } = fakeStore();
    const audit = fakeAudit();
    const gateway = createCodeRunGateway({
      ...baseOptions,
      client: {
        ...fakeClient(),
      },
      store,
      auditStore: audit.store,
      onArtifacts: async () => {
        throw new Error("gallery write exploded");
      },
    });
    const outcome = await gateway.run("照常执行");
    // The run completed; the hook's failure is the gallery's problem, not the run's.
    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.runId.startsWith("cr-")).toBe(true);
    }
    expect(rows.get((outcome as { runId: string }).runId)).toMatchObject({
      status: "completed",
    });
    expect(audit.events.some((e) => e.eventType === "code.run_completed")).toBe(true);
  });
});
