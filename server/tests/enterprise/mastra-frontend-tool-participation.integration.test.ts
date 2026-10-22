import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BaseEvent } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { afterAll, expect, test } from "../../../tests/support/bun-test-compat";
import { createDatabase } from "../../src/db/client";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  createMastraContinuationInstall,
  resumeMastraContinuation,
} from "../../src/mastra/approvals";
import { createMastraContinuationRoutes } from "../../src/mastra/continuation-routes";
import {
  createMastraContinuationStore,
  MastraContinuationRefusal,
} from "../../src/mastra/continuation-store";
import { runMastraExecution } from "../../src/mastra/execution";
import type {
  MastraSuspensionFact,
  ResumeRef,
} from "../../src/mastra/execution-contracts";
import { createMastraResumeDriver } from "../../src/mastra/resume-driver";
import {
  createMe05Database,
  type Me05Database,
} from "../../tests/support/me05-fixture";
import {
  buildMe06FrontendStack,
  type FrontendProvider,
  ME06_CHILD_RESULT_PREFIX,
  ME06_INSTRUCTIONS,
  ME06_STORE_SECRET,
  ME06_TOOL_DEFINITION,
  ME06_TOOL_NAME,
  startFrontendProvider,
} from "../../tests/support/me06-fixture";

/*
 * ME06 (#478) integration: the frontend (client-participation) tool against
 * the REAL durable surfaces. The browser tool suspends as a frontend_tool
 * continuation (saved through the execution wiring into the REAL store on
 * the disposable database), a FRESH OS process applies the client's real
 * tool_result decision through the production resume path, the resumed loop
 * continues from the real client result, and a replayed reply is applied
 * exactly once (ME05 receipt reuse). Failure injections: a stale generation
 * (stop), a revoked grant, and an expired claim governed by receipt
 * evidence.
 */

interface ChildResult {
  ok: boolean;
  pid?: number;
  kind?: string;
  answer?: string;
  finishReason?: string;
  toolCallId?: string;
  argsDigest?: string;
  receiptStatuses?: string[];
  error?: string;
}

// This file sits four directories under repo root — the child script path is
// anchored to the workspace root.
const workspaceRoot = join(fileURLToPath(import.meta.url), "../../../..");

function runChild(
  args: string[],
): Promise<{ pid: number; result: ChildResult }> {
  return new Promise((resolve, reject) => {
    // process.execPath: the SAME bun binary running this suite.
    const child = spawn(
      process.execPath,
      [join(workspaceRoot, "server/tests/support/me06-child.ts"), ...args],
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
        .find((candidate) => candidate.startsWith(ME06_CHILD_RESULT_PREFIX));
      if (!line) {
        reject(
          new Error(
            `me06 child exited ${code} without a result line; stderr: ${stderr.slice(-800)}`,
          ),
        );
        return;
      }
      resolve({
        pid: child.pid ?? -1,
        result: JSON.parse(
          line.slice(ME06_CHILD_RESULT_PREFIX.length),
        ) as ChildResult,
      });
    });
  });
}

const SCOPE: PlatformScope = {
  tenantId: "tenant-me06-it",
  workspaceId: "workspace-me06-it",
  principalId: "principal-me06-it",
  actorId: "actor-me06-it",
  memberEpoch: 1,
  aclEpoch: 1,
  entrypoint: "web",
};

const CLIENT_RESULT = {
  ok: true,
  url: "https://example.com",
  title: "Example Domain",
};

function bindingFor(executionKey: string, runId: string) {
  return {
    scope: SCOPE,
    botId: "bot-me06",
    runId,
    attemptId: "attempt-1",
    generation: 1,
    executionKey,
    threadId: "thread-me06-it",
  };
}

/**
 * Run the frontend tool loop to its participation suspension through the
 * execution wiring (runMastraExecution + the REAL continuation store), and
 * return the saved continuation ref, the client-visible events and the
 * suspension facts.
 */
async function suspendToContinuation(input: {
  databaseUrl: string;
  executionKey: string;
  runId: string;
  provider: FrontendProvider;
}): Promise<{
  ref: ResumeRef;
  record: Awaited<
    ReturnType<
      ReturnType<typeof createMastraContinuationStore>["getContinuation"]
    >
  >;
  events: BaseEvent[];
  suspensions: MastraSuspensionFact[];
}> {
  const database = createDatabase(input.databaseUrl, { max: 3 });
  const store = createMastraContinuationStore({
    database,
    secret: ME06_STORE_SECRET,
  });
  const binding = bindingFor(input.executionKey, input.runId);
  const stack = await buildMe06FrontendStack({
    providerUrl: input.provider.url,
    dbUrl: input.databaseUrl,
  });
  const suspensions: MastraSuspensionFact[] = [];
  const events: BaseEvent[] = [];
  let savedRef: ResumeRef | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      runMastraExecution({
        binding,
        input: {
          threadId: binding.threadId,
          runId: `client-${input.runId}`,
          messages: [
            { id: "msg-1", role: "user", content: "open example.com" },
          ],
          tools: [],
          context: [],
          forwardedProps: {},
        },
        instructions: [ME06_INSTRUCTIONS],
        tools: [],
        frontendTools: [ME06_TOOL_DEFINITION],
        governedModel: {
          model: stack.model as never,
          maxOutputTokens: 4096,
          markConsumed: () => undefined,
        },
        continuations: {
          // The suspension snapshot persists into the SAME tenant storage
          // surface the engine's durable toolCallStep wrote (the fixture's
          // PostgresStore over the disposable database).
          storage: stack.store,
          onSuspension: (fact) => {
            suspensions.push(fact);
            // The install's save formula: convergent save with the F6
            // operationId assertion, before any waiting publication.
            return store
              .saveContinuation(
                binding,
                {
                  schemaVersion: 1,
                  engine: "mastra",
                  kind: fact.kind,
                  packageFingerprint: store.currentFingerprint(),
                  toolCallId: fact.toolCallId,
                  toolName: fact.toolName,
                  argsDigest: fact.argsDigest,
                  snapshotRef: fact.snapshotRef,
                },
                fact.operationId,
              )
              .then((ref) => {
                savedRef = ref;
              });
          },
        },
        signal: new AbortController().signal,
      } as never).subscribe({
        next: (event) => events.push(event),
        error: reject,
        complete: () => resolve(),
      });
    });
    expect(suspensions).toHaveLength(1);
    expect(savedRef).toBeDefined();
    const record = await store.getContinuation(SCOPE, savedRef!.continuationId);
    return { ref: savedRef!, record, events, suspensions };
  } finally {
    await stack.store.close().catch(() => undefined);
    await database.$client.end({ timeout: 5 }).catch(() => undefined);
  }
}

/** The production driver over the fixture stack (the child's loop surface). */
async function driverFor(input: {
  databaseUrl: string;
  providerUrl: string;
  options?: {
    toolGrantCurrent?: () => Promise<boolean>;
    generationCurrent?: () => Promise<boolean>;
  };
}) {
  const stack = await buildMe06FrontendStack({
    providerUrl: input.providerUrl,
    dbUrl: input.databaseUrl,
    // The suspension was written under the execution path's agent id.
    agentId: `openbot-bot-me06`,
  });
  const driver = createMastraResumeDriver({
    storageFor: () => stack.store,
    loopFor: () => ({
      model: stack.model,
      tools: stack.tools,
      instructions: [ME06_INSTRUCTIONS],
    }),
  });
  const database = createDatabase(input.databaseUrl, { max: 2 });
  const store = createMastraContinuationStore({
    database,
    secret: ME06_STORE_SECRET,
  });
  const close = async () => {
    await stack.store.close().catch(() => undefined);
    await database.$client.end({ timeout: 5 }).catch(() => undefined);
  };
  return {
    stack,
    driver,
    close,
    deps: {
      store,
      toolGrantCurrent: input.options?.toolGrantCurrent ?? (async () => true),
      generationCurrent: input.options?.generationCurrent ?? (async () => true),
      driver,
    },
  };
}

let me06: Me05Database | undefined;
let databaseUrl: string | undefined;

afterAll(async () => {
  await me06?.drop();
});

test("headless_suspension_persists_then_a_fresh_process_completes_participation", async () => {
  me06 ??= await createMe05Database();
  databaseUrl = me06.runtimeUrl;
  const provider = await startFrontendProvider();
  const run = await suspendToContinuation({
    databaseUrl,
    executionKey: "me06-it-exec-1",
    runId: "me06-it-run-1",
    provider,
  });
  // Client-visible participation facts: the call announced with its
  // arguments, no server-fabricated result, terminal-less.
  expect(
    run.events.some(
      (event) =>
        event.type === EventType.TOOL_CALL_START &&
        (event as { toolCallName?: string }).toolCallName === ME06_TOOL_NAME,
    ),
  ).toBe(true);
  expect(
    run.events.some(
      (event) =>
        event.type === EventType.TOOL_CALL_ARGS &&
        (event as { delta?: string }).delta?.includes("example.com"),
    ),
  ).toBe(true);
  expect(
    run.events.some((event) => event.type === EventType.TOOL_CALL_RESULT),
  ).toBe(false);
  expect(
    run.events.some((event) => event.type === EventType.RUN_FINISHED),
  ).toBe(false);
  // The durable waiting state (what a refresh or another instance reads):
  // a frontend_tool row bound to the scope + run, still waiting, with the
  // engine snapshot reference and the exact argument digest.
  expect(run.record?.status).toBe("waiting");
  expect(run.record?.payload.kind).toBe("frontend_tool");
  expect(run.record?.payload.toolName).toBe(ME06_TOOL_NAME);
  expect(run.record?.binding.runId).toBe("me06-it-run-1");
  expect(run.record?.binding.threadId).toBe("thread-me06-it");
  expect(run.suspensions[0]?.kind).toBe("frontend_tool");

  // A FRESH OS process applies the client's real tool_result decision
  // through the production path (six gates + CAS claim + receipt ordering).
  const child = await runChild([
    databaseUrl,
    databaseUrl,
    provider.url,
    run.ref.continuationId,
    JSON.stringify(SCOPE),
    JSON.stringify(CLIENT_RESULT),
  ]);
  expect(child.result.ok, child.result.error).toBe(true);
  expect(child.pid).not.toBe(process.pid);
  expect(child.result.kind).toBe("resumed");
  expect(child.result.finishReason).toBe("stop");
  // The resumed loop continued from the REAL client result: the answer
  // names the participation outcome, and the client's own handler value is
  // what the bridge returned (no server-side rewording).
  expect(child.result.answer).toContain("answered from the client tool result");
  expect(child.result.toolCallId).toBe(run.suspensions[0]!.toolCallId);
  // Receipt ordering: the operation was recorded 'unknown' before the
  // engine could consume the client result, and confirmed afterwards.
  expect(child.result.receiptStatuses).toEqual(["executed"]);

  // The continuation is finished; the row records the resumed outcome.
  const verifyDatabase = createDatabase(databaseUrl, { max: 2 });
  const verifyStore = createMastraContinuationStore({
    database: verifyDatabase,
    secret: ME06_STORE_SECRET,
  });
  try {
    const record = await verifyStore.getContinuation(
      SCOPE,
      run.ref.continuationId,
    );
    expect(record?.status).toBe("finished");
    expect(record?.outcome).toBe("resumed");
    // A SECOND process applying the SAME reply cannot re-run the finished
    // participation: idempotent on the decision id — already applied, no
    // second drive.
    const again = await runChild([
      databaseUrl,
      databaseUrl,
      provider.url,
      run.ref.continuationId,
      JSON.stringify(SCOPE),
      JSON.stringify(CLIENT_RESULT),
    ]);
    expect(again.result.ok, again.result.error).toBe(true);
    expect(again.result.kind).toBe("already_applied");
    // The replayed reply triggered NO further engine round: the provider
    // saw the suspension turn and the single resumed answer turn.
    expect(provider.requests.length).toBe(2);
  } finally {
    await verifyStore.getContinuation(SCOPE, "probe").catch(() => undefined);
    await verifyDatabase.$client.end({ timeout: 5 }).catch(() => undefined);
    await provider.close();
  }
});

test("duplicate_tool_result_reply_is_applied_exactly_once", async () => {
  me06 ??= await createMe05Database();
  databaseUrl = databaseUrl ?? me06.runtimeUrl;
  const provider = await startFrontendProvider();
  const run = await suspendToContinuation({
    databaseUrl,
    executionKey: "me06-it-exec-2",
    runId: "me06-it-run-2",
    provider,
  });
  const { stack, deps, close } = await driverFor({
    databaseUrl,
    providerUrl: provider.url,
  });
  const decision = {
    kind: "tool_result" as const,
    receiptId: "me06-replay-decision-1",
    result: CLIENT_RESULT,
  };
  try {
    const first = await resumeMastraContinuation(deps, {
      scope: SCOPE,
      ref: run.ref,
      decision,
    });
    expect(first.kind).toBe("resumed");
    // The replayed SAME reply: idempotent on the decision id — already
    // applied, never a second drive.
    const replay = await resumeMastraContinuation(deps, {
      scope: SCOPE,
      ref: run.ref,
      decision,
    });
    expect(replay.kind).toBe("already_applied");
    // Exactly one suspension round + one resumed answer round.
    expect(provider.requests.length).toBe(2);
    // The receipt ledger holds one operation for the run, confirmed once.
    const receipts = await stack.store.pool.query(
      `SELECT status, count(*) FROM mastra_execution_receipts WHERE run_id = $1 GROUP BY status`,
      ["me06-it-run-2"],
    );
    expect(receipts.rows).toEqual([{ status: "executed", count: "1" }]);
  } finally {
    await close();
    await provider.close();
  }
});

test("stop_after_suspension_blocks_the_resume_and_revoked_grant_refuses", async () => {
  me06 ??= await createMe05Database();
  databaseUrl = databaseUrl ?? me06.runtimeUrl;
  // One FRESH provider per suspension: the script's turn counter keys the
  // tool-call round, so a shared provider would answer the second run's
  // first turn as a final answer.
  const stoppedProvider = await startFrontendProvider();
  const stoppedRun = await suspendToContinuation({
    databaseUrl,
    executionKey: "me06-it-exec-3",
    runId: "me06-it-run-3",
    provider: stoppedProvider,
  });
  const revokedProvider = await startFrontendProvider();
  const revokedRun = await suspendToContinuation({
    databaseUrl,
    executionKey: "me06-it-exec-4",
    runId: "me06-it-run-4",
    provider: revokedProvider,
  });
  const database = createDatabase(databaseUrl, { max: 3 });
  const store = createMastraContinuationStore({
    database,
    secret: ME06_STORE_SECRET,
  });
  // STOP injection: the run's generation is stale (the runner cancelled
  // it) — the six-gate orchestrator refuses before any engine drive.
  const { close: stoppedClose, deps: stoppedDeps } = await driverFor({
    databaseUrl,
    providerUrl: stoppedProvider.url,
    options: { generationCurrent: async () => false },
  });
  // REVOKED injection: the tool grant no longer stands — the resume
  // refuses with the named revoke gate.
  const { close: revokedClose, deps: revokedDeps } = await driverFor({
    databaseUrl,
    providerUrl: revokedProvider.url,
    options: { toolGrantCurrent: async () => false },
  });
  try {
    try {
      await resumeMastraContinuation(stoppedDeps, {
        scope: SCOPE,
        ref: stoppedRun.ref,
        decision: {
          kind: "tool_result",
          receiptId: "me06-stopped-decision",
          result: CLIENT_RESULT,
        },
      });
      throw new Error("the stopped run's resume should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(MastraContinuationRefusal);
      expect((error as MastraContinuationRefusal).code).toBe(
        "MASTRA_CONTINUATION_GENERATION_STALE",
      );
    }

    try {
      await resumeMastraContinuation(revokedDeps, {
        scope: SCOPE,
        ref: revokedRun.ref,
        decision: {
          kind: "tool_result",
          receiptId: "me06-revoked-decision",
          result: CLIENT_RESULT,
        },
      });
      throw new Error("the revoked grant's resume should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(MastraContinuationRefusal);
      expect((error as MastraContinuationRefusal).code).toBe(
        "MASTRA_CONTINUATION_GRANT_REVOKED",
      );
    }
    // Neither refusal consumed a resumed answer round: only the two
    // suspension turns dialled.
    expect(stoppedProvider.requests.length).toBe(1);
    expect(revokedProvider.requests.length).toBe(1);
    // Both rows stay waiting — a refusal is not a terminal.
    const stoppedRecord = await store.getContinuation(
      SCOPE,
      stoppedRun.ref.continuationId,
    );
    expect(stoppedRecord?.status).toBe("waiting");
  } finally {
    await stoppedClose();
    await revokedClose();
    await database.$client.end({ timeout: 5 }).catch(() => undefined);
    await stoppedProvider.close();
    await revokedProvider.close();
  }
});

test("expired_frontend_tool_claim_follows_the_receipt_evidence_rules", async () => {
  me06 ??= await createMe05Database();
  databaseUrl = databaseUrl ?? me06.runtimeUrl;
  // A store whose claims expire immediately: the ME05 recovery rules must
  // govern a frontend_tool row by receipt evidence, never a retry heuristic.
  const provider = await startFrontendProvider();
  const run = await suspendToContinuation({
    databaseUrl,
    executionKey: "me06-it-exec-5",
    runId: "me06-it-run-5",
    provider,
  });
  const database = createDatabase(databaseUrl, { max: 3 });
  const shortStore = createMastraContinuationStore({
    database,
    secret: ME06_STORE_SECRET,
    claimTtlMs: 1,
  });
  const { stack, deps } = await driverFor({
    databaseUrl,
    providerUrl: provider.url,
  });
  try {
    // Claim with the short-TTL store and let it expire, recording the
    // operation as EXECUTED (a crashed drive that already confirmed).
    const claimed = await shortStore.claimContinuation(SCOPE, run.ref, {
      kind: "tool_result",
      receiptId: "me06-expired-decision",
      result: CLIENT_RESULT,
    });
    await shortStore.recordOperationStarted(SCOPE, {
      operationId: run.suspensions[0]!.operationId,
      runId: "me06-it-run-5",
      toolCallId: run.suspensions[0]!.toolCallId,
      toolName: ME06_TOOL_NAME,
      argsDigest: run.suspensions[0]!.argsDigest,
    });
    await shortStore.recordOperationExecuted(
      SCOPE,
      run.suspensions[0]!.operationId,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    void claimed;
    // The re-apply of ANY decision now reads the EXECUTED receipt: the
    // continuation reuses it — no second drive, no replay of the effect.
    const database2 = createDatabase(databaseUrl, { max: 2 });
    const freshStore = createMastraContinuationStore({
      database: database2,
      secret: ME06_STORE_SECRET,
    });
    try {
      const result = await resumeMastraContinuation(
        { ...deps, store: freshStore },
        {
          scope: SCOPE,
          ref: run.ref,
          decision: {
            kind: "tool_result",
            receiptId: "me06-expired-decision-2",
            result: CLIENT_RESULT,
          },
        },
      );
      expect(result.kind).toBe("reused_receipt");
      // No answer round dialled by the recovery: only the suspension turn.
      expect(provider.requests.length).toBe(1);
    } finally {
      await database2.$client.end({ timeout: 5 }).catch(() => undefined);
    }
  } finally {
    await stack.store.close().catch(() => undefined);
    await database.$client.end({ timeout: 5 }).catch(() => undefined);
    await provider.close();
  }
});

test("participation_route_list_get_and_tool_result_apply", async () => {
  me06 ??= await createMe05Database();
  databaseUrl = databaseUrl ?? me06.runtimeUrl;
  const provider = await startFrontendProvider();
  const run = await suspendToContinuation({
    databaseUrl,
    executionKey: "me06-it-exec-6",
    runId: "me06-it-run-6",
    provider,
  });
  const database = createDatabase(databaseUrl, { max: 3 });
  const store = createMastraContinuationStore({
    database,
    secret: ME06_STORE_SECRET,
  });
  const { deps, close } = await driverFor({
    databaseUrl,
    providerUrl: provider.url,
  });
  // The route over the REAL store + the production install shape (the
  // orchestrator as the resume entry — the route adds scope + shape only).
  const install = createMastraContinuationInstall({
    store,
    toolGrantCurrent: deps.toolGrantCurrent,
    generationCurrent: deps.generationCurrent,
    driver: deps.driver,
  });
  const foreignScope: PlatformScope = {
    ...SCOPE,
    tenantId: "tenant-foreign",
    workspaceId: "workspace-foreign",
  };
  const routes = createMastraContinuationRoutes({
    install,
    store,
    resolveScope: async (request) =>
      request.headers.get("x-test-actor") === "foreign" ? foreignScope : SCOPE,
    requireUser: async (_context, next) => {
      await next();
    },
  });
  try {
    // LIST: the waiting suspension is visible to a refresh (AC5).
    const listResponse = await routes.request("/");
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as {
      suspensions: { continuationId: string; status: string; kind: string }[];
    };
    const mine = listBody.suspensions.find(
      (suspension) => suspension.continuationId === run.ref.continuationId,
    );
    expect(mine?.status).toBe("waiting");
    expect(mine?.kind).toBe("frontend_tool");

    // GET: the one record, scope-checked.
    const one = await routes.request(`/${run.ref.continuationId}`);
    expect(one.status).toBe(200);
    const foreign = await routes.request(`/${run.ref.continuationId}`, {
      headers: { "x-test-actor": "foreign" },
    });
    // A foreign scope reads as absence.
    expect(foreign.status).toBe(404);

    // APPLY: the browser's real tool result resumes through the route.
    const applied = await routes.request(
      `/${run.ref.continuationId}/tool-result`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toolCallId: run.suspensions[0]!.toolCallId,
          result: CLIENT_RESULT,
        }),
      },
    );
    expect(applied.status).toBe(200);
    const appliedBody = (await applied.json()) as {
      result: { kind: string };
    };
    expect(appliedBody.result.kind).toBe("resumed");

    // REPLAY: the same reply is idempotent — already applied, one drive.
    const replay = await routes.request(
      `/${run.ref.continuationId}/tool-result`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toolCallId: run.suspensions[0]!.toolCallId,
          result: CLIENT_RESULT,
        }),
      },
    );
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      result: { kind: string };
    };
    expect(replayBody.result.kind).toBe("already_applied");

    // A mismatched toolCallId is the caller's mistake: 400, no drive.
    const mismatch = await routes.request(
      `/${run.ref.continuationId}/tool-result`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toolCallId: "call_other",
          result: CLIENT_RESULT,
        }),
      },
    );
    expect(mismatch.status).toBe(400);
    // Only the suspension round + one resumed answer round dialled.
    expect(provider.requests.length).toBe(2);
  } finally {
    await close();
    await database.$client.end({ timeout: 5 }).catch(() => undefined);
    await provider.close();
  }
});
