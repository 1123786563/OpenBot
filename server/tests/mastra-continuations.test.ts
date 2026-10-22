import { createServer } from "node:http";
import { PostgresStore } from "@mastra/pg";
import { sleep } from "bun";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { createDatabase } from "../src/db/client";
import { mastraExecutionContinuations } from "../src/db/schema/mastra-execution-continuations";
import type { PlatformScope } from "../src/enterprise/contracts";
import {
  type MastraResumeDriver,
  resumeMastraContinuation,
} from "../src/mastra/approvals";
import {
  continuationOperationId,
  createMastraContinuationStore,
  MastraContinuationRefusal,
} from "../src/mastra/continuation-store";
import { runMastraExecution } from "../src/mastra/execution";
import type {
  ClaimedContinuation,
  ContinuationPayload,
  ExecutionBinding,
  ResumeDecision,
} from "../src/mastra/execution-contracts";
import { createMastraResumeDriver } from "../src/mastra/resume-driver";
import { argsDigestFor } from "../src/mastra/tools";
import type { GrantedTool } from "../src/plugins/tools";
import {
  createCountingControlledModel,
  startFakeProvider,
} from "./support/me01-fixture";
import {
  buildMe05Stack,
  countMe05Receipts,
  createMe05Database,
  ME05_INSTRUCTIONS,
  ME05_TOOL_NAME,
  type Me05Database,
} from "./support/me05-fixture";

/*
 * ME05 (#477): the durable continuation store and the accurate-resume
 * orchestrator, on a REAL disposable Postgres (the repository's own 0164
 * migration applied) — no in-memory fake may stand in for the durable store.
 * Cross-process resume lives in
 * server/tests/enterprise/mastra-continuations.integration.test.ts.
 *
 * Every case uses its OWN run identity: the store converges one pending
 * continuation per (run, tool call), so a shared id would merge cases.
 */

const SECRET = "me05-unit-continuation-secret";
const ARGS = { value: "hi" };
const DIGEST = argsDigestFor(ARGS);

function scopeFor(actor = "actor-a"): PlatformScope {
  return {
    tenantId: `tenant-${actor}`,
    workspaceId: `workspace-${actor}`,
    principalId: `principal-${actor}`,
    actorId: `actor-${actor}`,
    memberEpoch: 1,
    aclEpoch: 1,
    entrypoint: "web",
  };
}

const SCOPE = scopeFor();

function bindingFor(
  label: string,
  overrides: Partial<ExecutionBinding> = {},
): ExecutionBinding {
  return {
    scope: SCOPE,
    botId: "bot-a",
    runId: `run-${label}`,
    attemptId: `attempt-${label}`,
    generation: 1,
    executionKey: `exec-${label}`,
    threadId: `thread-${label}`,
    ...overrides,
  };
}

function payloadFor(
  overrides: Partial<ContinuationPayload> = {},
): ContinuationPayload {
  return {
    schemaVersion: 1,
    engine: "mastra",
    packageFingerprint: "fp-unit-1",
    kind: "approval",
    toolCallId: "call_1",
    toolName: ME05_TOOL_NAME,
    argsDigest: DIGEST,
    snapshotRef: "suspended:snapshot:call_1",
    ...overrides,
  };
}

function approvedDecision(
  overrides: Partial<Extract<ResumeDecision, { kind: "approved" }>> = {},
): ResumeDecision {
  return {
    kind: "approved",
    approvalId: "approval-1",
    argsDigest: DIGEST,
    ...overrides,
  };
}

interface Harness {
  label: string;
  store: ReturnType<typeof createMastraContinuationStore>;
  database: ReturnType<typeof createDatabase>;
  executions: unknown[];
  operationId(): string;
  resume(input: {
    ref: { continuationId: string; revision: number };
    decision?: ResumeDecision;
    scope?: PlatformScope;
    toolGrantCurrent?: (input: unknown) => Promise<boolean>;
    generationCurrent?: (input: unknown) => Promise<boolean>;
    driver?: MastraResumeDriver;
    currentFingerprint?: string;
  }): Promise<
    | { kind: "resumed" }
    | { kind: "declined" }
    | { kind: "re_suspended"; answer?: string; finishReason?: string }
    | { kind: "reused_receipt"; receiptId: string }
    | { kind: "pending_unknown"; continuationId: string }
    | { kind: "already_applied" }
  >;
  save(
    bindingOverrides?: Partial<ExecutionBinding>,
    payloadOverrides?: Partial<ContinuationPayload>,
  ): Promise<{
    ref: Awaited<ReturnType<Harness["store"]["saveContinuation"]>>;
    binding: ExecutionBinding;
  }>;
  close(): Promise<void>;
}

async function harness(
  options: { label?: string; claimTtlMs?: number } = {},
): Promise<Harness> {
  const label = options.label ?? Math.random().toString(36).slice(2, 10);
  const database = createDatabase(databaseUrl!, { max: 4 });
  const store = createMastraContinuationStore({
    database,
    secret: SECRET,
    fingerprint: () => "fp-unit-1",
    ...(options.claimTtlMs ? { claimTtlMs: options.claimTtlMs } : {}),
  });
  openDatabases.push(database);
  const executions: unknown[] = [];
  const driver: MastraResumeDriver = {
    resume: async (input) => {
      executions.push(input.claim.payload.toolCallId);
      if (input.decision.kind === "declined") return "declined";
      return "resumed";
    },
  };
  return {
    label,
    store,
    database,
    executions,
    operationId: () =>
      continuationOperationId(`exec-${label}`, "call_1", DIGEST),
    resume: (input) =>
      resumeMastraContinuation(
        {
          store,
          ...(input.currentFingerprint
            ? { currentFingerprint: input.currentFingerprint }
            : {}),
          toolGrantCurrent: input.toolGrantCurrent ?? (async () => true),
          generationCurrent: input.generationCurrent ?? (async () => true),
          driver: input.driver ?? driver,
        },
        {
          scope: input.scope ?? SCOPE,
          ref: input.ref,
          decision: input.decision ?? approvedDecision(),
        },
      ),
    async save(bindingOverrides, payloadOverrides) {
      const binding = bindingFor(label, bindingOverrides);
      const ref = await store.saveContinuation(
        binding,
        payloadFor(payloadOverrides),
      );
      return { ref, binding };
    },
    close: async () => {
      await database.$client.end({ timeout: 5 }).catch(() => undefined);
    },
  };
}

let databaseUrl: string | undefined;
let me05: Me05Database | undefined;
const openDatabases: ReturnType<typeof createDatabase>[] = [];

beforeAll(async () => {
  // ONE disposable database per FILE: every case runs on its own run identity
  // (the store converges one pending continuation per (run, tool call)), so
  // cases stay independent while the bootstrap cost stays single.
  me05 = await createMe05Database();
  databaseUrl = me05.runtimeUrl;
});

afterAll(async () => {
  for (const database of openDatabases) {
    await database.$client.end({ timeout: 5 }).catch(() => undefined);
  }
  await me05?.drop();
});

test("me05 fixture database applies the 0164 migration and grants the restricted role", async () => {
  const h = await harness({ label: "fixture-probe" });
  const ref = await h.store.saveContinuation(bindingFor(h.label), payloadFor());
  expect(ref.continuationId).toBeTruthy();
  expect(ref.revision).toBe(1);
  await h.close();
});

test("approval_matches_exact_tool_and_args", async () => {
  const h = await harness({ label: "exact" });
  const { ref } = await h.save();
  const result = await h.resume({ ref, decision: approvedDecision() });
  expect(result).toMatchObject({ kind: "resumed" });
  // The driver drove EXACTLY the saved tool call, and the claimed payload is
  // the saved payload (tool name, digest, snapshot ref, version facts).
  expect(h.executions).toEqual(["call_1"]);
  const record = await h.store.getContinuation(SCOPE, ref.continuationId);
  expect(record?.status).toBe("finished");
  expect(record?.outcome).toBe("resumed");
  expect(record?.payload).toMatchObject({
    kind: "approval",
    toolCallId: "call_1",
    toolName: ME05_TOOL_NAME,
    argsDigest: DIGEST,
    snapshotRef: "suspended:snapshot:call_1",
    schemaVersion: 1,
    engine: "mastra",
  });
  expect(record?.operationId).toBe(
    continuationOperationId("exec-exact", "call_1", DIGEST),
  );
  await h.close();
});

test("two_resumers_only_one_claim", async () => {
  const h = await harness({ label: "race" });
  const { ref } = await h.save();
  // Two concurrent claimers on the real database: the CAS revision lets
  // exactly one through.
  const attempts = await Promise.allSettled([
    h.store.claimContinuation(
      SCOPE,
      ref,
      approvedDecision({ approvalId: "a1" }),
    ),
    h.store.claimContinuation(
      SCOPE,
      ref,
      approvedDecision({ approvalId: "a2" }),
    ),
  ]);
  const fulfilled = attempts.filter((a) => a.status === "fulfilled");
  const rejected = attempts.filter(
    (a) => a.status === "rejected",
  ) as PromiseRejectedResult[];
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(
    rejected[0].reason instanceof MastraContinuationRefusal &&
      rejected[0].reason.code === "MASTRA_CONTINUATION_REVISION_CONFLICT",
  ).toBe(true);
  await h.close();
});

test("revoked_source_blocks_resume", async () => {
  const h = await harness({ label: "revoked" });
  const { ref } = await h.save();
  await expect(
    h.resume({ ref, toolGrantCurrent: async () => false }),
  ).rejects.toMatchObject({ code: "MASTRA_CONTINUATION_GRANT_REVOKED" });
  expect(h.executions).toEqual([]);
  const record = await h.store.getContinuation(SCOPE, ref.continuationId);
  expect(record?.status).toBe("waiting");
  await h.close();
});

test("the_waiting_kind_reaches_the_grant_gate_for_kind_aware_reverification", async () => {
  // ME09 (#481): the gate a decision faces is the one that granted the KIND
  // of call that is waiting — an approval wait re-checks the plugin grant
  // ledger, a frontend_tool wait re-checks the participation surface's own
  // revocable authority. The orchestrator tells the gate WHICH kind it is.
  const h = await harness({ label: "kind-aware" });
  const { ref } = await h.save(undefined, { kind: "frontend_tool" });
  const seen: { toolName?: unknown; kind?: unknown }[] = [];
  await h.resume({
    ref,
    decision: { kind: "tool_result", receiptId: `receipt-${h.label}` },
    toolGrantCurrent: async (input) => {
      seen.push(input as { toolName?: unknown; kind?: unknown });
      return true;
    },
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]!.kind).toBe("frontend_tool");
  expect(seen[0]!.toolName).toBe(ME05_TOOL_NAME);
  await h.close();
});

test("tampered_args_refused", async () => {
  const h = await harness({ label: "tamper" });
  const { ref } = await h.save();
  await expect(
    h.resume({
      ref,
      decision: approvedDecision({
        argsDigest: argsDigestFor({ value: "evil" }),
      }),
    }),
  ).rejects.toMatchObject({ code: "MASTRA_CONTINUATION_ARGS_MISMATCH" });
  expect(h.executions).toEqual([]);
  const record = await h.store.getContinuation(SCOPE, ref.continuationId);
  expect(record?.status).toBe("waiting");
  await h.close();
});

test("generation_stale_refused", async () => {
  const h = await harness({ label: "stale" });
  const { ref } = await h.save();
  await expect(
    h.resume({ ref, generationCurrent: async () => false }),
  ).rejects.toMatchObject({ code: "MASTRA_CONTINUATION_GENERATION_STALE" });
  expect(h.executions).toEqual([]);
  await h.close();
});

test("fingerprint_mismatch_isolates_not_executes", async () => {
  const h = await harness({ label: "fingerprint" });
  const { ref } = await h.save(undefined, {
    packageFingerprint: "fp-old-engine",
  });
  // The current engine carries a different fingerprint: the continuation is
  // isolated with a named refusal — never executed, never
  // deserialized-and-guessed, and the row stays put for human disposal.
  await expect(
    h.resume({ ref, currentFingerprint: "fp-current-engine" }),
  ).rejects.toMatchObject({
    code: "MASTRA_CONTINUATION_FINGERPRINT_INCOMPATIBLE",
  });
  expect(h.executions).toEqual([]);
  const record = await h.store.getContinuation(SCOPE, ref.continuationId);
  expect(record?.status).toBe("waiting");
  expect(record?.outcome).toBeNull();
  await h.close();
});

test("frontend_tool_waits_without_fake_result", async () => {
  const h = await harness({ label: "frontend" });
  const { ref } = await h.save(undefined, {
    kind: "frontend_tool",
    toolName: "ui_render_form",
  });
  const seenDecisions: ResumeDecision[] = [];
  const result = await resumeMastraContinuation(
    {
      store: h.store,
      toolGrantCurrent: async () => true,
      generationCurrent: async () => true,
      driver: {
        resume: async (input) => {
          seenDecisions.push(input.decision);
          // The engine-facing answer is built from the AUTHENTICATED decision
          // only — the store and orchestrator fabricate no tool result.
          return "resumed";
        },
      },
    },
    {
      scope: SCOPE,
      ref,
      decision: { kind: "tool_result", receiptId: "rcpt-1" },
    },
  );
  expect(result).toMatchObject({ kind: "resumed" });
  expect(seenDecisions).toEqual([{ kind: "tool_result", receiptId: "rcpt-1" }]);
  // An approval-shaped decision cannot resume a frontend_tool continuation.
  await expect(
    h.resume({ ref, decision: approvedDecision() }),
  ).rejects.toMatchObject({
    code: "MASTRA_CONTINUATION_DECISION_INCOMPATIBLE",
  });
  await h.close();
});

test("completed_receipt_reused_not_reexecuted", async () => {
  const h = await harness({ label: "reuse" });
  const { ref } = await h.save();
  await h.store.recordOperationStarted(SCOPE, {
    operationId: h.operationId(),
    runId: `run-${h.label}`,
    toolCallId: "call_1",
    toolName: ME05_TOOL_NAME,
    argsDigest: DIGEST,
  });
  const receiptId = await h.store.recordOperationExecuted(
    SCOPE,
    h.operationId(),
  );
  expect(receiptId).toBeTruthy();
  const result = await h.resume({ ref });
  expect(result).toMatchObject({ kind: "reused_receipt", receiptId });
  // The driver was never called: the completed external effect is reused.
  expect(h.executions).toEqual([]);
  const record = await h.store.getContinuation(SCOPE, ref.continuationId);
  expect(record?.status).toBe("finished");
  expect(record?.outcome).toBe("resumed");
  await h.close();
});

test("unknown_external_effect_is_not_replayed", async () => {
  const h = await harness({ label: "unknown" });
  const { ref } = await h.save();
  // The operation is recorded as STARTED with outcome unknown (the receipt
  // sink records before the external call): the external effect may have
  // landed, so the continuation ends pending_unknown — never auto-replayed.
  await h.store.recordOperationStarted(SCOPE, {
    operationId: h.operationId(),
    runId: `run-${h.label}`,
    toolCallId: "call_1",
    toolName: ME05_TOOL_NAME,
    argsDigest: DIGEST,
  });
  const result = await h.resume({ ref });
  expect(result).toMatchObject({ kind: "pending_unknown" });
  expect(h.executions).toEqual([]);
  const record = await h.store.getContinuation(SCOPE, ref.continuationId);
  expect(record?.status).toBe("finished");
  expect(record?.outcome).toBe("failed_unknown");
  await h.close();
});

test("claim_expiry_requires_receipt_evidence", async () => {
  // The TTL pair (250ms TTL, 400ms sleeps) needs headroom on BOTH sides: a
  // re-claim grants a FRESH TTL that must comfortably exceed the re-claim ->
  // finish round trips (a load spike at 50ms failed the finish spuriously),
  // while the sleeps must still outrun the TTL so expiry precedes the resume.
  const h = await harness({ label: "expiry", claimTtlMs: 250 });
  const operationIdFor = (key: string) =>
    continuationOperationId(key, "call_1", DIGEST);

  // (a) expired claim + EXECUTED receipt → reuse, never re-execute.
  const a = await h.save({ runId: "run-a", executionKey: "exec-a" });
  const claimA = await h.store.claimContinuation(
    SCOPE,
    a.ref,
    approvedDecision({ approvalId: "a-exp" }),
  );
  expect(claimA.claimToken).toBeTruthy();
  await h.store.recordOperationStarted(SCOPE, {
    operationId: operationIdFor("exec-a"),
    runId: "run-a",
    toolCallId: "call_1",
    toolName: ME05_TOOL_NAME,
    argsDigest: DIGEST,
  });
  await h.store.recordOperationExecuted(SCOPE, operationIdFor("exec-a"));
  await sleep(400);
  const reused = await h.resume({ ref: a.ref });
  expect(reused).toMatchObject({ kind: "reused_receipt" });

  // (b) expired claim + UNKNOWN receipt → pending_unknown, never replayed.
  const b = await h.save({ runId: "run-b", executionKey: "exec-b" });
  await h.store.claimContinuation(
    SCOPE,
    b.ref,
    approvedDecision({ approvalId: "b-exp" }),
  );
  await h.store.recordOperationStarted(SCOPE, {
    operationId: operationIdFor("exec-b"),
    runId: "run-b",
    toolCallId: "call_1",
    toolName: ME05_TOOL_NAME,
    argsDigest: DIGEST,
  });
  await sleep(400);
  const unknown = await h.resume({ ref: b.ref });
  expect(unknown).toMatchObject({ kind: "pending_unknown" });

  // (c) expired claim + NO receipt (the engine was never driven) → the claim
  // is re-taken and the resume completes exactly once.
  const c = await h.save({ runId: "run-c", executionKey: "exec-c" });
  const firstClaim = await h.store.claimContinuation(
    SCOPE,
    c.ref,
    approvedDecision({ approvalId: "c-exp" }),
  );
  await sleep(400);
  // The stale claim cannot be finished anymore — its token expired.
  await expect(
    h.store.finishContinuation(firstClaim, "resumed"),
  ).rejects.toMatchObject({ code: "MASTRA_CONTINUATION_CLAIM_EXPIRED" });
  const resumed = await h.resume({ ref: c.ref });
  expect(resumed).toMatchObject({ kind: "resumed" });
  expect(h.executions).toEqual(["call_1"]);
  await h.close();
});

test("crash_between_decision_and_claim_is_reappliable", async () => {
  const h = await harness({ label: "crash", claimTtlMs: 250 });
  const { ref } = await h.save();

  // First apply: the claim wins, then the process crashes before the engine
  // was driven (no receipt evidence, so nothing external can have run).
  const crashedDriver: MastraResumeDriver = {
    resume: async () => {
      throw new Error("SIMULATED_CRASH_AFTER_CLAIM");
    },
  };
  await expect(
    resumeMastraContinuation(
      {
        store: h.store,
        toolGrantCurrent: async () => true,
        generationCurrent: async () => true,
        driver: crashedDriver,
      },
      {
        scope: SCOPE,
        ref,
        decision: approvedDecision({ approvalId: "same-1" }),
      },
    ),
  ).rejects.toThrow("SIMULATED_CRASH_AFTER_CLAIM");
  await sleep(400);

  // Re-applying the SAME decision id recovers: the claim is idempotent on the
  // decision id and the resume drives exactly once.
  const reapplied = await resumeMastraContinuation(
    {
      store: h.store,
      toolGrantCurrent: async () => true,
      generationCurrent: async () => true,
      driver: {
        resume: async (input) => {
          h.executions.push(input.claim.payload.toolCallId);
          return "resumed";
        },
      },
    },
    {
      scope: SCOPE,
      ref,
      decision: approvedDecision({ approvalId: "same-1" }),
    },
  );
  expect(reapplied).toMatchObject({ kind: "resumed" });
  expect(h.executions).toEqual(["call_1"]);

  // Re-applying the SAME decision id after the continuation finished is an
  // idempotent no-op (repeated clicks / repeated webhooks), not a second run.
  const again = await resumeMastraContinuation(
    {
      store: h.store,
      toolGrantCurrent: async () => true,
      generationCurrent: async () => true,
      driver: {
        resume: async () => {
          h.executions.push("SECOND_RUN");
          return "resumed";
        },
      },
    },
    {
      scope: SCOPE,
      ref,
      decision: approvedDecision({ approvalId: "same-1" }),
    },
  );
  expect(again).toMatchObject({ kind: "already_applied" });
  expect(h.executions).toEqual(["call_1"]);
  await h.close();
});

test("continuation payload validation refuses non-v1 envelopes", async () => {
  const h = await harness({ label: "validation" });
  await expect(
    h.store.saveContinuation(
      bindingFor(h.label),
      payloadFor({ schemaVersion: 2 as never }),
    ),
  ).rejects.toMatchObject({ code: "MASTRA_CONTINUATION_PAYLOAD_INVALID" });
  await expect(
    h.store.saveContinuation(
      bindingFor(h.label),
      payloadFor({ engine: "langgraph" as never }),
    ),
  ).rejects.toMatchObject({ code: "MASTRA_CONTINUATION_PAYLOAD_INVALID" });
  await h.close();
});

function grantedEchoTool(): GrantedTool {
  return {
    name: ME05_TOOL_NAME,
    description: "Echo the value back.",
    parameters: z.object({ value: z.string() }),
    execute: async () => "echoed:hi",
    ref: `server/${ME05_TOOL_NAME}`,
  };
}

function wiringInput(label: string) {
  return {
    threadId: `thread-wiring-${label}`,
    runId: `client-${label}`,
    messages: [
      {
        id: "m1",
        role: "user" as const,
        content: "Echo hi with the tool, then answer.",
      },
    ],
    tools: [],
    context: [],
    forwardedProps: {},
  };
}

async function collect(
  observable: ReturnType<typeof runMastraExecution>,
): Promise<{ type: string; message?: unknown }[]> {
  const events: { type: string; message?: unknown }[] = [];
  await new Promise<void>((resolve) => {
    observable.subscribe({
      next: (event) =>
        events.push({
          type: event.type,
          message: (event as unknown as { message?: unknown }).message,
        }),
      error: (cause) => {
        events.push({ type: "STREAM_ERROR", message: String(cause) });
        resolve();
      },
      complete: () => resolve(),
    });
  });
  return events;
}

test(
  "suspension_saves_continuation_before_the_stream_ends",
  async () => {
    const database = createDatabase(databaseUrl!, { max: 3 });
    openDatabases.push(database);
    const store = createMastraContinuationStore({ database, secret: SECRET });
    const provider = await startFakeProvider();
    const mastraStorage = new PostgresStore({
      id: "me05-wiring",
      connectionString: databaseUrl!,
    });
    const binding = bindingFor("wiring", {
      runId: "wiring-run",
      executionKey: "wiring-exec",
    });
    const savedFacts: {
      fact: {
        kind: string;
        toolCallId: string;
        toolName: string;
        argsDigest: string;
        operationId: string;
      };
    }[] = [];
    let saveResolved = false;
    let events: { type: string; message?: unknown }[] = [];
    try {
      const observable = runMastraExecution({
        binding,
        input: wiringInput("wiring"),
        instructions: ["You are Bot A."],
        tools: [grantedEchoTool()],
        governedModel: {
          model: createCountingControlledModel(provider.url).model,
        } as never,
        continuations: {
          storage: mastraStorage,
          durableToolNames: [ME05_TOOL_NAME],
          onSuspension: async (fact) => {
            // F6: the fact's own operationId is consumed — the store asserts
            // it equals its derivation, so the execution-side and store-side
            // formulas cannot drift silently on a REAL suspension.
            await store.saveContinuation(
              binding,
              payloadFor({
                toolCallId: fact.toolCallId,
                toolName: fact.toolName,
                argsDigest: fact.argsDigest,
                snapshotRef: fact.snapshotRef,
              }),
              fact.operationId,
            );
            savedFacts.push({ fact });
            saveResolved = true;
          },
        },
        signal: new AbortController().signal,
      });
      events = await collect(observable);
      // The save completed BEFORE the observable completed: the recovery data
      // exists by the time any waiting state could be published downstream.
      expect(saveResolved).toBe(true);
      // A suspension is terminal-less: no success, no failure.
      expect(
        events.some((e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR"),
      ).toBe(false);
      expect(events.some((e) => e.type === "TOOL_CALL_START")).toBe(true);
      expect(savedFacts[0]?.fact).toMatchObject({
        kind: "approval",
        toolCallId: "call_me01_1",
        toolName: ME05_TOOL_NAME,
        argsDigest: DIGEST,
      });
      // The pending call never executed: no receipt evidence may exist.
      expect(
        await store.findReceipt(
          SCOPE,
          continuationOperationId("wiring-exec", "call_me01_1", DIGEST),
        ),
      ).toBeNull();
      // And the SAME durable state resumes from a fresh stack built on the
      // same storage (the snapshot the snapshotRef points at is real). The
      // engine keys suspended runs by the agent identity the suspension was
      // written under — the resume stack carries the SAME agent id
      // (`openbot-${binding.botId}`) as the execution.
      process.env.ME05_RUN_ID = "wiring-run";
      const stack = await buildMe05Stack({
        providerUrl: provider.url,
        dbUrl: databaseUrl!,
        requireApproval: true,
        agentId: "openbot-bot-a",
      });
      const suspended = await stack.agent.listSuspendedRuns();
      const run = suspended.runs.find((r) => r.runId === "wiring-exec");
      expect(run?.status).toBe("suspended");
      const output = await stack.agent.resumeStream(
        { approved: true },
        { runId: "wiring-exec", toolCallId: "call_me01_1" },
      );
      const reader = output.fullStream.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
      }
      expect(await output.finishReason).toBe("stop");
      await stack.store.close();
    } finally {
      await mastraStorage.close().catch(() => undefined);
      await provider.close();
    }
  },
  { timeout: 60_000 },
);

test(
  "save_failure_fails_run_instead_of_waiting",
  async () => {
    const provider = await startFakeProvider();
    const mastraStorage = new PostgresStore({
      id: "me05-wiring-fail",
      connectionString: databaseUrl!,
    });
    try {
      const observable = runMastraExecution({
        binding: bindingFor("wiring-fail", {
          runId: "wiring-fail-run",
          executionKey: "wiring-fail-exec",
        }),
        input: wiringInput("wiring-fail"),
        instructions: ["You are Bot A."],
        tools: [grantedEchoTool()],
        governedModel: {
          model: createCountingControlledModel(provider.url).model,
        } as never,
        continuations: {
          storage: mastraStorage,
          durableToolNames: [ME05_TOOL_NAME],
          onSuspension: async () => {
            throw new Error("STORAGE_DOWN");
          },
        },
        signal: new AbortController().signal,
      });
      const events = await collect(observable);
      // A suspension whose recovery data could not be saved must NEVER end as
      // a silent (waiting-publishable) stream: it fails with a named error.
      const runError = events.find((e) => e.type === "RUN_ERROR");
      expect(runError).toBeTruthy();
      expect(JSON.stringify(runError)).toContain(
        "MASTRA_CONTINUATION_SAVE_FAILED",
      );
      expect(events.some((e) => e.type === "RUN_FINISHED")).toBe(false);
    } finally {
      await mastraStorage.close().catch(() => undefined);
      await provider.close();
    }
  },
  { timeout: 60_000 },
);

/*
 * OCR fix wave 3 (R3-10): the suspension save's fallback gaps. A scripted
 * provider (raw OpenAI chunks per turn) drives the real engine into the
 * suspension shapes the fixed fake provider cannot express.
 */
function scriptedProvider(
  turns: unknown[][],
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("error", () => response.destroy());
    request.on("end", () => {
      const parsed = JSON.parse(body) as { messages?: { role: string }[] };
      // Turn 0: the first proposal. Turn 1+: after tool history exists (the
      // resumed step, or the step after a result).
      const turn = (parsed.messages ?? []).some((m) => m.role === "tool")
        ? 1
        : 0;
      const chunks = turns[Math.min(turn, turns.length - 1)]!;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${(address as { port: number }).port}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

const probeChunk = (
  id: string,
  delta: unknown,
  finish: string | null,
): unknown => ({
  id,
  object: "chat.completion.chunk",
  created: 1,
  model: "me01-model",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const probeToolCall = (id: string, args: string): unknown[] => [
  probeChunk(
    "c1",
    {
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id,
          type: "function",
          function: { name: ME05_TOOL_NAME, arguments: args },
        },
      ],
    },
    null,
  ),
  probeChunk("c1", {}, "tool_calls"),
];

test("unparsable_suspension_args_fail_the_run_instead_of_saving", async () => {
  // R3-10(c): the engine pauses on the proposal BEFORE parsing its arguments,
  // so an unparsable args text reaches the save. Digesting the raw text would
  // mint a digest the approval side (canonicalJson of parsed args) can never
  // reproduce — a suspension locked out of a legitimate approval forever.
  // That is a save failure: named RUN_ERROR, no waiting publication, and the
  // hook never fires.
  const provider = await scriptedProvider([
    probeToolCall("call_bad", '{"value":'),
  ]);
  const mastraStorage = new PostgresStore({
    id: "me05-bad-args",
    connectionString: databaseUrl!,
  });
  const facts: unknown[] = [];
  try {
    const events = await collect(
      runMastraExecution({
        binding: bindingFor("bad-args", {
          runId: "bad-args-run",
          executionKey: "bad-args-exec",
        }),
        input: wiringInput("bad-args"),
        instructions: ["You are Bot A."],
        tools: [grantedEchoTool()],
        governedModel: {
          model: createCountingControlledModel(provider.url).model,
        } as never,
        continuations: {
          storage: mastraStorage,
          durableToolNames: [ME05_TOOL_NAME],
          onSuspension: async (fact) => {
            facts.push(fact);
          },
        },
        signal: new AbortController().signal,
      }),
    );
    const runError = events.find((e) => e.type === "RUN_ERROR");
    expect(runError).toBeTruthy();
    expect(JSON.stringify(runError)).toContain(
      "MASTRA_CONTINUATION_SAVE_FAILED",
    );
    expect(JSON.stringify(runError)).toContain("could not be parsed");
    expect(events.some((e) => e.type === "RUN_FINISHED")).toBe(false);
    expect(facts).toEqual([]);
  } finally {
    await mastraStorage.close().catch(() => undefined);
    await provider.close();
  }
});

test("two_pending_calls_suspend_the_engine_named_one", async () => {
  // R3-10(a) positive control: with SEVERAL result-less calls announced, the
  // engine's approval frame names the paused call — the save binds THAT call,
  // never a guessed first candidate. (The refuse-to-guess RUN_ERROR arm is
  // the drift defense for an engine that stops naming it.)
  const provider = await scriptedProvider([
    [
      ...probeToolCall("call_r310_1", '{"value":"a"}').slice(0, 1),
      probeChunk(
        "c1",
        {
          tool_calls: [
            {
              index: 1,
              id: "call_r310_2",
              type: "function",
              function: { name: ME05_TOOL_NAME, arguments: '{"value":"b"}' },
            },
          ],
        },
        null,
      ),
      probeChunk("c1", {}, "tool_calls"),
    ],
  ]);
  const mastraStorage = new PostgresStore({
    id: "me05-two-pending",
    connectionString: databaseUrl!,
  });
  const facts: {
    toolCallId: string;
    toolName: string;
    argsDigest: string;
  }[] = [];
  try {
    const events = await collect(
      runMastraExecution({
        binding: bindingFor("two-pending", {
          runId: "two-pending-run",
          executionKey: "two-pending-exec",
        }),
        input: wiringInput("two-pending"),
        instructions: ["You are Bot A."],
        tools: [grantedEchoTool()],
        governedModel: {
          model: createCountingControlledModel(provider.url).model,
        } as never,
        continuations: {
          storage: mastraStorage,
          durableToolNames: [ME05_TOOL_NAME],
          onSuspension: async (fact) => {
            facts.push({ ...fact });
          },
        },
        signal: new AbortController().signal,
      }),
    );
    expect(
      events.some((e) => e.type === "RUN_ERROR" || e.type === "RUN_FINISHED"),
    ).toBe(false);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.toolCallId).toBe("call_r310_1");
    expect(facts[0]!.argsDigest).toBe(argsDigestFor({ value: "a" }));
  } finally {
    await mastraStorage.close().catch(() => undefined);
    await provider.close();
  }
});

/*
 * OCR fix wave 3 (R3-11): the resume drive's re-suspension contract — the
 * drive saves the replacement continuation through the wired hook, the
 * original row is released back to waiting (never finished "resumed"), the
 * receipt is never upgraded, and an unwired hook with durable tools refuses
 * to mount.
 */
test("unwired_resuspension_hook_refuses_durable_mount", async () => {
  const driver = createMastraResumeDriver({
    storageFor: () => ({}),
    loopFor: () => ({ model: {}, durableToolNames: [ME05_TOOL_NAME] }),
  });
  let started = false;
  await expect(
    driver.resume({
      claim: claimFor(payloadFor()),
      decision: approvedDecision(),
      receiptSink: {
        started: async () => {
          started = true;
        },
        executed: async () => null,
      },
    }),
  ).rejects.toMatchObject({
    code: "MASTRA_CONTINUATION_RESUSPENSION_UNSUPPORTED",
  });
  // Fail-closed BEFORE any receipt: a refused mount never records evidence.
  expect(started).toBe(false);
});

test(
  "re_suspension_saves_new_continuation_and_keeps_original_row_waiting",
  async () => {
    const provider = await scriptedProvider([
      // Turn 0 (the original run): proposes the gated call — suspension #1.
      probeToolCall("call_me01_1", '{"value":"hi"}'),
      // Turn 1 (the resumed step, tool history present): proposes ANOTHER
      // gated call — the re-suspension under test.
      probeToolCall("call_me01_2", '{"value":"again"}'),
    ]);
    const mastraStorage = new PostgresStore({
      id: "me05-resuspend",
      connectionString: databaseUrl!,
    });
    const database = createDatabase(databaseUrl!, { max: 3 });
    openDatabases.push(database);
    const store = createMastraContinuationStore({
      database,
      secret: SECRET,
    });
    const binding = bindingFor("resuspend", {
      runId: "resusp-run",
      executionKey: "resusp-exec",
    });
    const originalDigest = argsDigestFor({ value: "hi" });
    try {
      // 1. The original run suspends durably and saves its continuation (the
      // execution wiring's contract, on the REAL fingerprint the orchestrator
      // will also save the replacement with).
      const events = await collect(
        runMastraExecution({
          binding,
          input: wiringInput("resuspend"),
          instructions: ["You are Bot A."],
          tools: [grantedEchoTool()],
          governedModel: {
            model: createCountingControlledModel(provider.url).model,
          } as never,
          continuations: {
            storage: mastraStorage,
            durableToolNames: [ME05_TOOL_NAME],
            onSuspension: async (fact) => {
              await store.saveContinuation(
                binding,
                {
                  schemaVersion: 1,
                  engine: "mastra",
                  packageFingerprint: store.currentFingerprint(),
                  kind: "approval",
                  toolCallId: fact.toolCallId,
                  toolName: fact.toolName,
                  argsDigest: fact.argsDigest,
                  snapshotRef: fact.snapshotRef,
                },
                fact.operationId,
              );
            },
          },
          signal: new AbortController().signal,
        }),
      );
      expect(
        events.some((e) => e.type === "RUN_ERROR" || e.type === "RUN_FINISHED"),
      ).toBe(false);
      const originalRow = (
        await database
          .select()
          .from(mastraExecutionContinuations)
          .where(eq(mastraExecutionContinuations.runId, binding.runId))
      )[0];
      expect(originalRow?.toolCallId).toBe("call_me01_1");
      const originalRef = {
        continuationId: originalRow!.continuationId,
        revision: originalRow!.revision,
      };

      // 2. The approved resume drives the engine through the PRODUCTION
      // driver with the six-gate orchestrator; the resumed step proposes
      // ANOTHER durable call and suspends again.
      process.env.ME05_RUN_ID = binding.runId;
      const stack = await buildMe05Stack({
        providerUrl: provider.url,
        dbUrl: databaseUrl!,
        requireApproval: true,
        agentId: "openbot-bot-a",
      });
      const driver = createMastraResumeDriver({
        storageFor: () => stack.store,
        loopFor: () => ({
          model: stack.model,
          tools: stack.tools,
          instructions: [ME05_INSTRUCTIONS],
          agentId: "openbot-bot-a",
          durableToolNames: [ME05_TOOL_NAME],
        }),
      });
      const result = await resumeMastraContinuation(
        {
          store,
          toolGrantCurrent: async () => true,
          generationCurrent: async () => true,
          driver,
        },
        {
          scope: SCOPE,
          ref: originalRef,
          decision: approvedDecision({ argsDigest: originalDigest }),
        },
      );
      // A distinct result — never "resumed": the drive ended suspended again.
      expect(result.kind).toBe("re_suspended");

      // 3. The ORIGINAL row is waiting again (claim released, no terminal
      // outcome), and its receipt was NEVER upgraded past started-unknown.
      const released = await store.getContinuation(
        SCOPE,
        originalRef.continuationId,
      );
      expect(released?.status).toBe("waiting");
      expect(released?.outcome).toBeNull();
      const receipt = await store.findReceipt(
        SCOPE,
        continuationOperationId("resusp-exec", "call_me01_1", originalDigest),
      );
      expect(receipt).toMatchObject({ status: "unknown" });

      // 4. The REPLACEMENT continuation exists and is a live waiting row.
      const replacement = (
        await database
          .select()
          .from(mastraExecutionContinuations)
          .where(
            and(
              eq(mastraExecutionContinuations.runId, binding.runId),
              eq(mastraExecutionContinuations.toolCallId, "call_me01_2"),
            ),
          )
      )[0];
      expect(replacement).toBeTruthy();
      expect(replacement!.status).toBe("waiting");
      expect(replacement!.argsDigest).toBe(argsDigestFor({ value: "again" }));
      expect(replacement!.snapshotRef).toBe(
        "suspended:resusp-exec:call_me01_2",
      );
      // 5. Exactly-once evidence: the approved call executed once in the
      // resumed stream before the second pause — nothing re-ran.
      expect(await countMe05Receipts(me05!.dbName, binding.runId)).toBe(1);
      await stack.store.close();
    } finally {
      await mastraStorage.close().catch(() => undefined);
      await provider.close();
    }
  },
  { timeout: 60_000 },
);

/*
 * fix-round-1: the PRODUCTION resume driver's own refusal gates, exercised
 * directly (no database, no engine) — a drive may only start on an approval
 * continuation whose storage actually resolved.
 */
function claimFor(payload: ContinuationPayload): ClaimedContinuation {
  return {
    ref: { continuationId: "cont-driver", revision: 3 },
    binding: bindingFor("driver"),
    payload,
    claimToken: "token-driver",
  };
}

const NO_RECEIPTS = {
  started: async () => undefined,
  executed: async () => null,
};

test("production_driver_refuses_non_approval_continuations", async () => {
  const driver = createMastraResumeDriver({
    storageFor: () => {
      throw new Error("storage must not be touched for a foreign kind");
    },
  });
  let refusal: unknown;
  try {
    await driver.resume({
      claim: claimFor(payloadFor({ kind: "question" })),
      decision: { kind: "answered", responseId: "resp-1" },
      receiptSink: NO_RECEIPTS,
    });
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(MastraContinuationRefusal);
  expect((refusal as MastraContinuationRefusal).code).toBe(
    "MASTRA_CONTINUATION_DRIVE_UNSUPPORTED",
  );
});

test("production_driver_refuses_unresolved_storage", async () => {
  let loopForTouched = false;
  const driver = createMastraResumeDriver({
    storageFor: () => undefined,
    loopFor: () => {
      loopForTouched = true;
      return {};
    },
  });
  let refusal: unknown;
  try {
    await driver.resume({
      claim: claimFor(payloadFor()),
      decision: approvedDecision(),
      receiptSink: NO_RECEIPTS,
    });
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(MastraContinuationRefusal);
  expect((refusal as MastraContinuationRefusal).code).toBe(
    "MASTRA_CONTINUATION_STORAGE_MISSING",
  );
  // The loop surface is never assembled for a run whose snapshot storage did
  // not resolve — no guessed stack.
  expect(loopForTouched).toBe(false);
});

test("production_driver_refuses_decision_kind_mismatch", async () => {
  const driver = createMastraResumeDriver({
    storageFor: () => ({}),
  });
  let refusal: unknown;
  try {
    await driver.resume({
      claim: claimFor(payloadFor()),
      decision: { kind: "tool_result", receiptId: "receipt-1" },
      receiptSink: NO_RECEIPTS,
    });
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(MastraContinuationRefusal);
  expect((refusal as MastraContinuationRefusal).code).toBe(
    "MASTRA_CONTINUATION_DECISION_INCOMPATIBLE",
  );
});

/*
 * fix-round-1: F1's claim-expiry ↔ late-driver fence, the F3 untested gates,
 * F4's convergent-save payload equality, and F6's operationId drift assert.
 * The fence tests model the production driver's RECEIPT ORDER (started()
 * strictly before any engine drive); the refusal itself comes from the
 * orchestrator's sink, so the harness carries no fence logic of its own.
 */

test("late_driver_after_takeover_refused_before_drive", async () => {
  const h = await harness({ label: "late", claimTtlMs: 250 });
  const { ref } = await h.save();
  const drives: string[] = [];
  let releaseStalledDriver: () => void = () => {};
  const stalled = new Promise<void>((resolve) => {
    releaseStalledDriver = resolve;
  });
  const stalledDriver: MastraResumeDriver = {
    resume: async (input) => {
      // The winner stalls past its gates and claim, before any receipt.
      await stalled;
      // The production RECEIPT ORDER: started() fences the drive.
      await input.receiptSink.started();
      drives.push(input.claim.payload.toolCallId);
      return "resumed";
    },
  };
  const firstApply = resumeMastraContinuation(
    {
      store: h.store,
      toolGrantCurrent: async () => true,
      generationCurrent: async () => true,
      driver: stalledDriver,
    },
    { scope: SCOPE, ref, decision: approvedDecision({ approvalId: "late-1" }) },
  );
  // Deterministically wait until the stalled winner holds the claim.
  for (;;) {
    const held = await h.store.getContinuation(SCOPE, ref.continuationId);
    if (held?.status === "claimed") break;
    await sleep(2);
  }
  // The stall outlives the claim TTL: a takeover resumer completes first.
  await sleep(400);
  const takeover = await resumeMastraContinuation(
    {
      store: h.store,
      toolGrantCurrent: async () => true,
      generationCurrent: async () => true,
      driver: {
        resume: async (input) => {
          await input.receiptSink.started();
          drives.push(input.claim.payload.toolCallId);
          // The production driver upgrades the receipt once the stream
          // drained; the mirror keeps that ordering too.
          await input.receiptSink.executed();
          return "resumed";
        },
      },
    },
    { scope: SCOPE, ref, decision: approvedDecision({ approvalId: "late-2" }) },
  );
  expect(takeover).toMatchObject({ kind: "resumed" });
  releaseStalledDriver();
  // The late driver is refused by the started() fence — BEFORE it could
  // drive the engine a second time on a run the takeover already drove.
  await expect(firstApply).rejects.toMatchObject({
    code: "MASTRA_CONTINUATION_CLAIM_LOST",
  });
  expect(drives).toEqual(["call_1"]);
  // The receipt evidence is the takeover's, unchanged; the row is finished.
  expect(await h.store.findReceipt(SCOPE, h.operationId())).toMatchObject({
    status: "executed",
  });
  const record = await h.store.getContinuation(SCOPE, ref.continuationId);
  expect(record?.status).toBe("finished");
  expect(record?.outcome).toBe("resumed");
  await h.close();
});

test("concurrent_started_fences_exactly_one_driver", async () => {
  const h = await harness({ label: "fence" });
  const { ref } = await h.save();
  const operation = {
    operationId: h.operationId(),
    runId: `run-${h.label}`,
    toolCallId: "call_1",
    toolName: ME05_TOOL_NAME,
    argsDigest: DIGEST,
  };
  // Two stalled-then-woken drivers race the started fence on the real
  // database: exactly one records the receipt (is the operation's driver).
  const attempts = await Promise.all([
    h.store.recordOperationStarted(SCOPE, operation),
    h.store.recordOperationStarted(SCOPE, operation),
  ]);
  const recorders = attempts.filter((attempt) => attempt.started);
  expect(recorders).toHaveLength(1);
  // The loser learns it from the discriminated result, with the winner's
  // current receipt status — its evidence is never erased.
  const loser = attempts.find((attempt) => !attempt.started);
  expect(loser).toMatchObject({ started: false, status: "unknown" });
  expect(await h.store.findReceipt(SCOPE, operation.operationId)).toMatchObject(
    {
      status: "unknown",
    },
  );
  // And the recorded (unknown) evidence closes the drive path: the next
  // resume ends pending_unknown — exactly one driver can ever emerge.
  const result = await h.resume({ ref });
  expect(result).toMatchObject({ kind: "pending_unknown" });
  expect(h.executions).toEqual([]);
  await h.close();
});

test("foreign_actor_cannot_approve", async () => {
  const h = await harness({ label: "foreign" });
  const { ref } = await h.save();
  // Another person (another scope identity) reads absence — doubly enforced
  // by the store's scope-filtered load and the field-wise identity gate.
  await expect(
    h.resume({ ref, scope: scopeFor("actor-b") }),
  ).rejects.toMatchObject({ code: "MASTRA_CONTINUATION_NOT_FOUND" });
  expect(h.executions).toEqual([]);
  const record = await h.store.getContinuation(SCOPE, ref.continuationId);
  expect(record?.status).toBe("waiting");
  expect(record?.outcome).toBeNull();
  await h.close();
});

test("declined_drive_never_records_receipt", async () => {
  const h = await harness({ label: "declined" });
  const { ref } = await h.save();
  const branches: string[] = [];
  const result = await resumeMastraContinuation(
    {
      store: h.store,
      toolGrantCurrent: async () => true,
      generationCurrent: async () => true,
      driver: {
        resume: async (input) => {
          if (input.decision.kind === "declined") {
            // Mirror of the production driver: declineToolCall, NO receipt.
            branches.push("declined");
            return "declined";
          }
          branches.push("resumed");
          await input.receiptSink.started();
          return "resumed";
        },
      },
    },
    {
      scope: SCOPE,
      ref,
      decision: {
        kind: "declined",
        approvalId: "decline-1",
        reason: "user refused",
      },
    },
  );
  expect(result).toMatchObject({ kind: "declined" });
  expect(branches).toEqual(["declined"]);
  // A decline has no external effect: no started/executed receipt may exist.
  expect(await h.store.findReceipt(SCOPE, h.operationId())).toBeNull();
  const record = await h.store.getContinuation(SCOPE, ref.continuationId);
  expect(record?.status).toBe("finished");
  expect(record?.outcome).toBe("declined");
  await h.close();
});

test("lease_not_current_blocks_resume", async () => {
  const h = await harness({ label: "lease" });
  const { ref } = await h.save();
  // The optional lease probe (the runner's fencing slot): a stale owner
  // resumes nothing, exactly as a stale generation would.
  await expect(
    resumeMastraContinuation(
      {
        store: h.store,
        toolGrantCurrent: async () => true,
        generationCurrent: async () => true,
        leaseCurrent: async () => false,
        driver: {
          resume: async () => {
            h.executions.push("LEASED_DRIVE");
            return "resumed";
          },
        },
      },
      { scope: SCOPE, ref, decision: approvedDecision() },
    ),
  ).rejects.toMatchObject({ code: "MASTRA_CONTINUATION_GENERATION_STALE" });
  expect(h.executions).toEqual([]);
  // Refused before any claim: the row stays waiting on its original revision.
  const record = await h.store.getContinuation(SCOPE, ref.continuationId);
  expect(record?.status).toBe("waiting");
  expect(record?.ref.revision).toBe(ref.revision);
  await h.close();
});

test("finished_row_does_not_block_a_new_suspension_for_the_same_call", async () => {
  // OCR fix wave 3 (R3-7): "one PENDING continuation per (run, tool call)" —
  // a FINISHED row is history, not a pending hold. The convergent save must
  // never return a finished row's ref as if it were the live suspension (its
  // recovery data would read alreadyFinished forever), and the unique index
  // is partial (WHERE status <> 'finished') so the new pending row can exist.
  const h = await harness({ label: "finished-block" });
  const first = await h.save();
  // Drive the first suspension to a real terminal outcome, the way an
  // approval would.
  await h.resume({ ref: first.ref });
  const finished = await h.store.getContinuation(
    SCOPE,
    first.ref.continuationId,
  );
  expect(finished?.status).toBe("finished");
  // The SAME run and call suspends again (a replayed approval round): the
  // save must converge on a NEW pending row, never the finished one.
  const second = await h.save();
  expect(second.ref.continuationId).not.toBe(first.ref.continuationId);
  const pending = await h.store.getContinuation(
    SCOPE,
    second.ref.continuationId,
  );
  expect(pending?.status).toBe("waiting");
  // And the new row is a live continuation: a fresh decision claims and
  // finishes it normally.
  const resumed = await h.resume({
    ref: second.ref,
    decision: approvedDecision({ approvalId: "approval-2" }),
  });
  expect(resumed).toMatchObject({ kind: "resumed" });
  const record = await h.store.getContinuation(
    SCOPE,
    second.ref.continuationId,
  );
  expect(record?.status).toBe("finished");
  expect(record?.outcome).toBe("resumed");
  await h.close();
});

test("save_replay_with_changed_args_refuses", async () => {
  const h = await harness({ label: "save-replay" });
  const binding = bindingFor(h.label);
  const changed = payloadFor({
    argsDigest: argsDigestFor({ value: "changed" }),
  });
  let releaseWinner: () => void = () => {};
  const winnerGate = new Promise<void>((resolve) => {
    releaseWinner = resolve;
  });
  let winnerInserted = false;
  // The concurrent-save race, made deterministic: an UNCOMMITTED winner
  // already holds the (run, tool_call) unique key while the replay's
  // pending-load still reads "no row" — so the replay reaches its INSERT,
  // loses the race, and must re-verify the winner's identity instead of
  // silently returning it.
  const winnerTransaction = h.database.transaction(async (tx) => {
    await tx.insert(mastraExecutionContinuations).values({
      continuationId: `cont-winner-${h.label}`,
      tenantId: binding.scope.tenantId,
      workspaceId: binding.scope.workspaceId,
      principalId: binding.scope.principalId,
      actorId: binding.scope.actorId,
      botId: binding.botId,
      runId: binding.runId,
      attemptId: binding.attemptId,
      generation: binding.generation,
      executionKey: binding.executionKey,
      threadId: binding.threadId ?? null,
      kind: "approval",
      toolCallId: "call_1",
      toolName: ME05_TOOL_NAME,
      operationId: continuationOperationId(
        binding.executionKey,
        "call_1",
        DIGEST,
      ),
      argsDigest: DIGEST,
      packageFingerprint: "fp-unit-1",
      snapshotRef: "suspended:snapshot:call_1",
    });
    winnerInserted = true;
    await winnerGate;
  });
  for (;;) {
    if (winnerInserted) break;
    await sleep(2);
  }
  const replay = h.store.saveContinuation(binding, changed);
  // The replay's pending-load ran on the uncommitted state; its INSERT is now
  // blocked on the winner's unique key. Commit the winner underneath it.
  await sleep(50);
  releaseWinner();
  await winnerTransaction;
  await expect(replay).rejects.toMatchObject({
    code: "MASTRA_CONTINUATION_REVISION_CONFLICT",
  });
  // The winner's payload stands: the changed replay replaced nothing.
  const record = await h.store.getContinuation(SCOPE, `cont-winner-${h.label}`);
  expect(record?.payload.argsDigest).toBe(DIGEST);
  await h.close();
});

test("save_with_drifted_operation_id_refuses", async () => {
  const h = await harness({ label: "op-drift" });
  // The suspension fact carries a derived operationId; if the fact's value
  // and the store's derivation ever drift apart, the save refuses instead of
  // silently splitting the recovery identity.
  await expect(
    h.store.saveContinuation(
      bindingFor(h.label),
      payloadFor(),
      "op_drifted_value",
    ),
  ).rejects.toMatchObject({
    code: "MASTRA_CONTINUATION_OPERATION_ID_MISMATCH",
  });
  // Matching values save exactly as before.
  const ref = await h.store.saveContinuation(
    bindingFor(`${h.label}-b`),
    payloadFor(),
    continuationOperationId(`exec-${h.label}-b`, "call_1", DIGEST),
  );
  expect(ref.continuationId).toBeTruthy();
  await h.close();
});
