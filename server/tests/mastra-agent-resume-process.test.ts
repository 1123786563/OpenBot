import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "../../tests/support/bun-test-compat";
import {
  buildMe01Stack,
  countReceipts,
  createMe01Database,
  ME01_CHILD_RESULT_PREFIX,
  startFakeProvider,
} from "./support/me01-fixture";

/*
 * ME01 (#473): prove the locked Mastra combination can (1) run a tool loop in
 * which the controlled LanguageModelV3 is the only model path and the tool
 * executes exactly once, and (2) suspend an agent run durably and resume the
 * exact pending operation from a different OS process. Cross-process resume is
 * the acceptance bar a same-process InMemoryStore workflow cannot satisfy.
 */

interface ChildResult {
  ok: boolean;
  pid?: number;
  answer?: string;
  finishReason?: string | null;
  chunkTypes?: string[];
  controlledModelCalls?: number;
  suspendedToolCalls?: unknown[];
  error?: string;
  discovered?: string[];
}

const workspaceRoot = join(fileURLToPath(import.meta.url), "../../..");

function runResumeChild(
  dbUrl: string,
  providerUrl: string,
  runId: string,
): Promise<{ pid: number; result: ChildResult }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bun",
      [
        join(workspaceRoot, "server/tests/support/me01-child.ts"),
        dbUrl,
        providerUrl,
        runId,
      ],
      { cwd: join(workspaceRoot, "server"), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => {
      const line = stdout
        .split("\n")
        .find((candidate) => candidate.startsWith(ME01_CHILD_RESULT_PREFIX));
      if (!line) {
        reject(
          new Error(
            `resume child exited ${code} without a result line; stderr: ${stderr.slice(-800)}`,
          ),
        );
        return;
      }
      resolve({
        pid: child.pid ?? -1,
        result: JSON.parse(
          line.slice(ME01_CHILD_RESULT_PREFIX.length),
        ) as ChildResult,
      });
    });
  });
}

test("me01 tool loop runs one tool call through the controlled model and answers from its result", async () => {
  const database = await createMe01Database();
  const provider = await startFakeProvider();
  process.env.ME01_RUN_ID = "me01-tool-loop";
  try {
    const { agent, store, controlled } = await buildMe01Stack({
      providerUrl: provider.url,
      dbUrl: database.runtimeUrl,
    });
    const output = await agent.stream(
      [{ role: "user", content: "Echo hi with the tool, then answer." }],
      { runId: "me01-tool-loop" },
    );
    const reader = output.fullStream.getReader();
    const types: string[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      types.push(String((next.value as { type?: string }).type));
    }
    const finishReason = await output.finishReason;
    const text = await output.text;

    expect(await countReceipts(database.dbName, "me01-tool-loop")).toBe(1);
    expect(finishReason).toBe("stop");
    expect(text).toContain("Second step used the tool result: hi");
    expect(types).toContain("text-delta");
    // The controlled wrapper is the only model path: two steps, two doStream calls.
    expect(controlled.doStreamCalls()).toBe(2);
    expect(provider.requests).toHaveLength(2);
    expect(
      provider.requests.every((request) => request.model === "me01-model"),
    ).toBe(true);
    await store.close();
  } finally {
    await provider.close();
    await database.drop();
  }
});

test("me01 suspended run persists and a fresh OS process resumes the exact operation once", async () => {
  const database = await createMe01Database();
  const provider = await startFakeProvider();
  process.env.ME01_RUN_ID = "me01-resume";
  try {
    const parent = await buildMe01Stack({
      providerUrl: provider.url,
      dbUrl: database.runtimeUrl,
      requireApproval: true,
    });
    const output = await parent.agent.stream(
      [{ role: "user", content: "Echo hi with the tool, then answer." }],
      { runId: "me01-resume" },
    );
    const reader = output.fullStream.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
    }
    const finishReason = await output.finishReason;
    // Suspension is not completion: no tool receipt may exist yet.
    expect(finishReason).toBe("suspended");
    const suspendPayload = (await output.suspendPayload) as unknown;
    expect(JSON.stringify(suspendPayload)).toContain("echo_tool");
    expect(await countReceipts(database.dbName, "me01-resume")).toBe(0);

    const { runs } = await parent.agent.listSuspendedRuns();
    const suspended = runs.find((run) => run.runId === "me01-resume");
    expect(suspended?.status).toBe("suspended");
    expect(suspended?.toolCalls[0]).toMatchObject({
      requiresApproval: true,
      toolName: "echo_tool",
      args: { value: "hi" },
    });
    await parent.store.close();

    const child = await runResumeChild(
      database.runtimeUrl,
      provider.url,
      "me01-resume",
    );
    expect(child.result.ok, child.result.error).toBe(true);
    expect(child.pid).not.toBe(process.pid);
    expect(child.result.finishReason).toBe("stop");
    expect(child.result.answer).toContain(
      "Second step used the tool result: hi",
    );
    // The child went through the controlled model for its resumed step, and
    // the parent saw exactly one model call before suspending.
    expect(child.result.controlledModelCalls).toBe(1);
    expect(parent.controlled.doStreamCalls()).toBe(1);
    expect(await countReceipts(database.dbName, "me01-resume")).toBe(1);
    // Nothing stays suspended after the resumed run completes.
    const childSideStack = await buildMe01Stack({
      providerUrl: provider.url,
      dbUrl: database.runtimeUrl,
    });
    const remaining = await childSideStack.agent.listSuspendedRuns();
    expect(
      remaining.runs.find((run) => run.runId === "me01-resume"),
    ).toBeUndefined();
    await childSideStack.store.close();
    await provider.close();
  } finally {
    await provider.close();
    await database.drop();
  }
});

test("me01 malformed provider stream surfaces an error terminal, never a fake success", async () => {
  const database = await createMe01Database();
  const provider = await startFakeProvider({ mode: "bad-frame" });
  process.env.ME01_RUN_ID = "me01-bad-frame";
  try {
    const { agent, store } = await buildMe01Stack({
      providerUrl: provider.url,
      dbUrl: database.runtimeUrl,
    });
    const output = await agent.stream(
      [{ role: "user", content: "Echo hi with the tool, then answer." }],
      { runId: "me01-bad-frame" },
    );
    const reader = output.fullStream.getReader();
    const types: string[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      types.push(String((next.value as { type?: string }).type));
    }
    const finishReason = await output.finishReason;
    expect(types).toContain("error");
    expect(typeof finishReason === "string" && finishReason !== "stop").toBe(
      true,
    );
    expect(await countReceipts(database.dbName, "me01-bad-frame")).toBe(0);
    await store.close();
  } finally {
    await provider.close();
    await database.drop();
  }
});
