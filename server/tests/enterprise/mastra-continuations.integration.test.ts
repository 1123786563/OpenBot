import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgresStore } from "@mastra/pg";
import { afterAll, expect, test } from "../../../tests/support/bun-test-compat";
import { createDatabase } from "../../src/db/client";
import { createMastraContinuationStore } from "../../src/mastra/continuation-store";
import { argsDigestFor } from "../../src/mastra/tools";
import { startFakeProvider } from "../../tests/support/me01-fixture";
import {
  buildMe05Stack,
  countMe05Receipts,
  createMe05Database,
  ME05_CHILD_RESULT_PREFIX,
  ME05_STORE_SECRET,
  ME05_TOOL_NAME,
  type Me05Database,
} from "../../tests/support/me05-fixture";

/*
 * ME05 (#477) integration: the durable continuation against a REAL database,
 * across OS processes — a fresh process claims the pending continuation
 * (single CAS winner) and resumes the exact suspended operation, and two
 * racing processes cannot both hold the claim. Never executed twice: the
 * fixture's own receipt table is the exactly-once evidence.
 */

interface ChildResult {
  ok: boolean;
  pid?: number;
  mode?: string;
  claimed?: boolean;
  revision?: number;
  kind?: string;
  answer?: string;
  finishReason?: string;
  toolCallId?: string;
  argsDigest?: string;
  receiptStatusAtExecute?: string;
  error?: string;
  discovered?: string[];
}

// This file sits three directories under server/ — four ups reach the repo
// root the child script path is anchored to.
const workspaceRoot = join(fileURLToPath(import.meta.url), "../../../..");

function runChild(
  args: string[],
): Promise<{ pid: number; result: ChildResult }> {
  return new Promise((resolve, reject) => {
    // process.execPath: the SAME bun binary running this suite, not a PATH
    // lookup a spawned child may not inherit.
    const child = spawn(
      process.execPath,
      [join(workspaceRoot, "server/tests/support/me05-child.ts"), ...args],
      {
        cwd: join(workspaceRoot, "server"),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => {
      const line = stdout
        .split("\n")
        .find((candidate) => candidate.startsWith(ME05_CHILD_RESULT_PREFIX));
      if (!line) {
        reject(
          new Error(
            `me05 child exited ${code} without a result line; stderr: ${stderr.slice(-800)}`,
          ),
        );
        return;
      }
      resolve({
        pid: child.pid ?? -1,
        result: JSON.parse(
          line.slice(ME05_CHILD_RESULT_PREFIX.length),
        ) as ChildResult,
      });
    });
  });
}

const SCOPE = {
  tenantId: "tenant-x",
  workspaceId: "workspace-x",
  principalId: "principal-x",
  actorId: "actor-x",
  memberEpoch: 1,
  aclEpoch: 1,
  entrypoint: "web" as const,
};

let me05: Me05Database | undefined;
let databaseUrl: string | undefined;

afterAll(async () => {
  await me05?.drop();
});

test("new_process_can_resume", async () => {
  me05 = await createMe05Database();
  databaseUrl = me05.runtimeUrl;
  const provider = await startFakeProvider();
  const database = createDatabase(databaseUrl, { max: 3 });
  const store = createMastraContinuationStore({
    database,
    secret: ME05_STORE_SECRET,
  });
  const mastraStorage = new PostgresStore({
    id: "me05-integration",
    connectionString: databaseUrl,
  });
  process.env.ME05_RUN_ID = "integration-run";
  try {
    // 1. The original process runs the gated loop and suspends durably.
    const parent = await buildMe05Stack({
      providerUrl: provider.url,
      dbUrl: databaseUrl,
      requireApproval: true,
    });
    const output = await parent.agent.stream(
      [{ role: "user", content: "Echo hi with the tool, then answer." }],
      { runId: "integration-exec" },
    );
    const reader = output.fullStream.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
    }
    expect(await output.finishReason).toBe("suspended");
    expect(await countMe05Receipts(me05.dbName, "integration-run")).toBe(0);

    // 2. The suspension saves its continuation BEFORE the waiting state is
    // published (the execution wiring's contract — here exercised through the
    // same save the wiring calls).
    const binding = {
      scope: SCOPE,
      botId: "bot-integration",
      runId: "integration-run",
      attemptId: "attempt-1",
      generation: 1,
      executionKey: "integration-exec",
      threadId: "thread-integration",
    };
    const suspendedCalls = ((await parent.agent.listSuspendedRuns()).runs.find(
      (run) => run.runId === "integration-exec",
    )?.toolCalls ?? []) as {
      toolCallId?: string;
      toolName?: string;
      args?: unknown;
    }[];
    const pending = suspendedCalls[0];
    expect(pending?.toolCallId).toBeTruthy();
    const ref = await store.saveContinuation(binding, {
      schemaVersion: 1,
      engine: "mastra",
      packageFingerprint: store.currentFingerprint(),
      kind: "approval",
      toolCallId: String(pending.toolCallId),
      toolName: String(pending.toolName ?? ME05_TOOL_NAME),
      argsDigest: argsDigestFor(pending.args ?? { value: "hi" }),
      snapshotRef: `suspended:integration-exec:${String(pending.toolCallId)}`,
    });
    await parent.store.close();

    // 3. A FRESH OS process claims (CAS) and resumes the exact operation
    // through the PRODUCTION path: the six-gate orchestrator plus the
    // production resume driver (fix-round-1).
    const child = await runChild([
      databaseUrl,
      databaseUrl,
      provider.url,
      ref.continuationId,
      JSON.stringify(SCOPE),
    ]);
    expect(child.result.ok, child.result.error).toBe(true);
    expect(child.pid).not.toBe(process.pid);
    expect(child.result.kind).toBe("resumed");
    expect(child.result.answer?.length ?? 0).toBeGreaterThan(0);
    expect(child.result.finishReason).toBe("stop");
    expect(child.result.toolCallId).toBe(String(pending.toolCallId));
    // Receipt ordering held across processes: at the instant the tool's
    // external effect ran, the continuation-store receipt was already
    // 'unknown' (started recorded, not yet confirmed) — never absent.
    expect(child.result.receiptStatusAtExecute).toBe("unknown");
    // Exactly one external execution, in the resumed process only.
    expect(await countMe05Receipts(me05.dbName, "integration-run")).toBe(1);

    // 4. The continuation is finished; nothing stays suspended; a SECOND
    // process claiming the same continuation cannot re-run it.
    const record = await store.getContinuation(SCOPE, ref.continuationId);
    expect(record?.status).toBe("finished");
    expect(record?.outcome).toBe("resumed");
    const again = await runChild([
      databaseUrl,
      databaseUrl,
      provider.url,
      ref.continuationId,
      JSON.stringify(SCOPE),
      "claim",
    ]);
    expect(again.result.ok).toBe(false);
    expect(again.result.error).toContain(
      "MASTRA_CONTINUATION_ALREADY_FINISHED",
    );
    expect(await countMe05Receipts(me05.dbName, "integration-run")).toBe(1);
    const probe = await buildMe05Stack({
      providerUrl: provider.url,
      dbUrl: databaseUrl,
    });
    const remaining = await probe.agent.listSuspendedRuns();
    expect(
      remaining.runs.find((run) => run.runId === "integration-exec"),
    ).toBeUndefined();
    await probe.store.close();
  } finally {
    await mastraStorage.close().catch(() => undefined);
    await database.$client.end({ timeout: 5 }).catch(() => undefined);
    await provider.close();
  }
});

test("two_resumers_only_one_claim", async () => {
  me05 ??= await createMe05Database();
  databaseUrl = databaseUrl ?? me05.runtimeUrl;
  const provider = await startFakeProvider();
  const database = createDatabase(databaseUrl, { max: 3 });
  const store = createMastraContinuationStore({
    database,
    secret: ME05_STORE_SECRET,
  });
  const mastraStorage = new PostgresStore({
    id: "me05-integration-race",
    connectionString: databaseUrl,
  });
  process.env.ME05_RUN_ID = "race-run";
  try {
    const parent = await buildMe05Stack({
      providerUrl: provider.url,
      dbUrl: databaseUrl,
      requireApproval: true,
    });
    const output = await parent.agent.stream(
      [{ role: "user", content: "Echo hi with the tool, then answer." }],
      { runId: "race-exec" },
    );
    const reader = output.fullStream.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
    }
    const binding = {
      scope: SCOPE,
      botId: "bot-integration",
      runId: "race-run",
      attemptId: "attempt-1",
      generation: 1,
      executionKey: "race-exec",
      threadId: "thread-race",
    };
    const ref = await store.saveContinuation(binding, {
      schemaVersion: 1,
      engine: "mastra",
      packageFingerprint: store.currentFingerprint(),
      kind: "approval",
      toolCallId: "call_me01_1",
      toolName: ME05_TOOL_NAME,
      argsDigest: argsDigestFor({ value: "hi" }),
      snapshotRef: "suspended:race-exec:call_me01_1",
    });
    await parent.store.close();

    // Two real child processes race for the CAS claim: exactly one wins.
    const attempts = await Promise.all([
      runChild([
        databaseUrl,
        databaseUrl,
        provider.url,
        ref.continuationId,
        JSON.stringify(SCOPE),
        "claim",
      ]),
      runChild([
        databaseUrl,
        databaseUrl,
        provider.url,
        ref.continuationId,
        JSON.stringify(SCOPE),
        "claim",
      ]),
    ]);
    const winners = attempts.filter((a) => a.result.ok);
    const losers = attempts.filter((a) => !a.result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].result.error).toContain(
      "MASTRA_CONTINUATION_REVISION_CONFLICT",
    );
    expect(winners[0].result.claimed).toBe(true);
    // Nothing external executed: a claim is not an execution.
    expect(await countMe05Receipts(me05.dbName, "race-run")).toBe(0);
  } finally {
    await mastraStorage.close().catch(() => undefined);
    await database.$client.end({ timeout: 5 }).catch(() => undefined);
    await provider.close();
  }
});
