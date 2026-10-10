import { describe, expect, test } from "bun:test";
import { createCodeRunGateway, TASK_PREAMBLE } from "../src/codesandbox/gateway";
import type { SandboxClient } from "../src/codesandbox/client";
import type { CodeRunStore } from "../src/codesandbox/store";

function fakeClient(overrides: Partial<SandboxClient> = {}): SandboxClient {
  return {
    createSession: async () => "ses_x",
    sendMessage: async (_sessionId: string, text: string) => ({
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

function fakeAudit() {
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    store: {
      async insert(event: { eventType: string; payload: Record<string, unknown> }) {
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
  timeoutMs: 120_000,
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
    expect(row["status"]).toBe("completed");
    expect(row["inputTokens"]).toBe(9);
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
    expect(row["status"]).toBe("refused");
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
    expect(row["status"]).toBe("timeout");
    expect(audit.events.some((e) => e.eventType === "code.run_failed")).toBe(true);
  });

  test("artifacts are the files that appeared during the run, capped", async () => {
    const { store } = fakeStore();
    // Stateful listing: nothing exists before the run, six files exist after it — the gateway
    // only reports the difference, capped at maxArtifacts.
    let listed = 0;
    const client = fakeClient({
      listFiles: async () =>
        (listed += 1) > 1 ? ["a.py", "b.csv", "c.bin", "d.txt", "e.md", "f.log"] : [],
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
});
