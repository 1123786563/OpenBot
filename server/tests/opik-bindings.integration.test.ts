import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import {
  createObserverRunBindingGate,
  createRunBindingStore,
  RunBindingError,
} from "../src/ai-observability/bindings";
import { ObservationScopeError } from "../src/ai-observability/contracts";
import { runUpstreamIdentity } from "../src/ai-observability/opik-http";
import type { OpikPort } from "../src/ai-observability/opik-port";
import { reportBasicRun } from "../src/ai-observability/routes/basic-run";
import { resolveObservationScope } from "../src/ai-observability/scope";
import { aiObservationBindings } from "../src/db/schema/ai-observability-bindings";
import { aiObservationRetentionDeletions } from "../src/db/schema/ai-observability-retention";
import {
  assertBindingsSchemaPresent,
  opikTestDatabase,
} from "./support/opik-test-db";
import { rejectionOf } from "./support/pg-errors";

/**
 * Behavioral proof of the binding contract against a real, dedicated PostgreSQL database:
 * idempotency under replay and concurrency, scope isolation for identical run ids, lost local
 * acknowledgment reconciled without a second subject, and ownership epochs fencing revocation.
 * There is no skip and no fallback database; a missing test database fails the run.
 */

const database = opikTestDatabase();
const store = createRunBindingStore(database);
const prefix = `t07-${randomUUID()}`;

const scopeA = resolveObservationScope({
  actorId: "user-a",
  botId: "agent-1",
  ownership: "owner",
  epoch: 1,
});
const scopeB = resolveObservationScope({
  actorId: "user-b",
  botId: "agent-1",
  ownership: "admin",
  epoch: 1,
});

afterEach(async () => {
  await database
    .delete(aiObservationBindings)
    .where(sql`${aiObservationBindings.runId} LIKE ${`${prefix}%`}`);
  // The m105 test plants deletion records in this scope; the governance counts
  // downstream read every scope, so a test must leave none behind.
  await database
    .delete(aiObservationRetentionDeletions)
    .where(eq(aiObservationRetentionDeletions.scopeKey, scopeA.key));
});

afterAll(async () => {
  await database.$client.close();
});

test("the dedicated test database carries the binding uniqueness constraints", async () => {
  await assertBindingsSchemaPresent(database);
});

test("begin inserts exactly once and a replay returns the original binding", async () => {
  const input = {
    runId: `${prefix}-run-1`,
    attemptId: "attempt-1",
    traceId: "trace-1",
    capability: "detailed" as const,
    expiresAt: new Date("2026-10-22T00:00:00.000Z"),
  };

  const first = await store.begin(scopeA, input);
  const replay = await store.begin(scopeA, input);

  expect(first.replayed).toBe(false);
  expect(replay.replayed).toBe(true);
  expect(replay.binding).toEqual(first.binding);

  const rows = await database
    .select({ id: aiObservationBindings.id })
    .from(aiObservationBindings)
    .where(eq(aiObservationBindings.runId, input.runId));
  expect(rows).toHaveLength(1);

  // Authority is copied from the trusted scope, never accepted from the caller.
  expect(first.binding).toMatchObject({
    scopeKey: scopeA.key,
    actorId: "user-a",
    botId: "agent-1",
    state: "running",
    opikTraceId: null,
  });
});

test("one Bot is one binding range: a manager reads the creator's rows (FREV-03 a)", async () => {
  const input = {
    runId: `${prefix}-run-2`,
    attemptId: "attempt-1",
    traceId: "trace-2",
    capability: "basic" as const,
    expiresAt: new Date("2026-10-22T00:00:00.000Z"),
  };

  const a = await store.begin(scopeA, input);

  // The administrator's scope for the same Bot is a different actor over the
  // SAME data key — the creator's binding is visible, not a neighbour row in a
  // scope of its own.
  expect(scopeB.key).toBe(scopeA.key);
  expect(await store.get(scopeB, a.binding.id)).toEqual(a.binding);
  expect(await store.latestAttempt(scopeB, input.runId)).toEqual(a.binding);

  // Replaying the same run/attempt under the admin's scope is the SAME
  // authoritative subject: the first claim stands, nothing is minted twice.
  const replay = await store.begin(scopeB, input);
  expect(replay.replayed).toBe(true);
  expect(replay.binding.id).toBe(a.binding.id);
  // Provenance stays with whoever recorded it.
  expect(replay.binding.actorId).toBe(scopeA.actorId);

  const rows = await database
    .select({ scopeKey: aiObservationBindings.scopeKey })
    .from(aiObservationBindings)
    .where(eq(aiObservationBindings.runId, input.runId));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.scopeKey).toBe(scopeA.key);
});

test("another Bot's binding stays out of reach (the boundary that remains)", async () => {
  const input = {
    runId: `${prefix}-run-2b`,
    attemptId: "attempt-1",
    traceId: "trace-2b",
    capability: "basic" as const,
    expiresAt: new Date("2026-10-22T00:00:00.000Z"),
  };
  const otherBot = resolveObservationScope({
    actorId: "user-a",
    botId: "agent-2",
    ownership: "owner",
    epoch: 1,
  });
  const begun = await store.begin(otherBot, input);
  expect(await store.get(scopeA, begun.binding.id)).toBeNull();
  expect(await store.latestAttempt(scopeA, input.runId)).toBeNull();
  expect(await store.get(otherBot, begun.binding.id)).toEqual(begun.binding);
});

test("a transferred Bot keeps its history for the new owner, and the row keeps its author (FREV-03 c)", async () => {
  const input = {
    runId: `${prefix}-run-2c`,
    attemptId: "attempt-1",
    traceId: "trace-2c",
    capability: "detailed" as const,
    expiresAt: new Date("2026-10-22T00:00:00.000Z"),
  };
  const recorded = await store.begin(scopeA, input);

  // The handover mints the new owner's scope; the data address is the Bot's,
  // so the history recorded before the transfer is reachable as it stands.
  const newOwner = resolveObservationScope({
    actorId: "user-new-owner",
    botId: "agent-1",
    ownership: "owner",
    epoch: 9,
  });
  expect(newOwner.key).toBe(scopeA.key);
  const history = await store.latestAttempt(newOwner, input.runId);
  expect(history?.id).toBe(recorded.binding.id);
  expect(history?.actorId).toBe(scopeA.actorId);
});

test("concurrent begin for one scope/run/attempt yields exactly one binding", async () => {
  const input = {
    runId: `${prefix}-run-3`,
    attemptId: "attempt-1",
    traceId: "trace-3",
    capability: "detailed" as const,
    expiresAt: new Date("2026-10-22T00:00:00.000Z"),
  };

  // Eight connections, so the inserts genuinely race instead of queueing behind one another.
  const wide = opikTestDatabase({ max: 8 });
  const racing = createRunBindingStore(wide);
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => racing.begin(scopeA, input)),
    );

    expect(new Set(results.map((result) => result.binding.id)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);

    const rows = await wide
      .select({ id: aiObservationBindings.id })
      .from(aiObservationBindings)
      .where(eq(aiObservationBindings.runId, input.runId));
    expect(rows).toHaveLength(1);
  } finally {
    await wide.$client.close();
  }
});

test("a lost local acknowledgment reconciles onto the original binding", async () => {
  const input = {
    runId: `${prefix}-run-4`,
    attemptId: "attempt-1",
    traceId: "trace-4",
    capability: "detailed" as const,
    expiresAt: new Date("2026-10-22T00:00:00.000Z"),
  };
  const begun = await store.begin(scopeA, input);

  // Upstream succeeded, the local write of the upstream id was lost: reconcile by the
  // authoritative local key, not by anything Opik metadata claims.
  const reconciled = await store.reconcile(
    scopeA,
    input.runId,
    input.attemptId,
    "opik-trace-4",
  );
  expect(reconciled.adopted).toBe(true);
  expect(reconciled.binding.id).toBe(begun.binding.id);
  expect(reconciled.binding.opikTraceId).toBe("opik-trace-4");

  // The same acknowledgment replayed changes nothing.
  const again = await store.reconcile(
    scopeA,
    input.runId,
    input.attemptId,
    "opik-trace-4",
  );
  expect(again.adopted).toBe(false);
  expect(again.binding.id).toBe(begun.binding.id);

  // A different upstream id for the same local subject does not mint a second binding: the
  // first recorded upstream id stands, exactly one row exists.
  const divergent = await store.reconcile(
    scopeA,
    input.runId,
    input.attemptId,
    "opik-trace-4-duplicate",
  );
  expect(divergent.adopted).toBe(false);
  expect(divergent.binding.opikTraceId).toBe("opik-trace-4");

  const rows = await database
    .select({ id: aiObservationBindings.id })
    .from(aiObservationBindings)
    .where(eq(aiObservationBindings.runId, input.runId));
  expect(rows).toHaveLength(1);

  // The database, not this store, holds the second uniqueness authority: two bindings in one
  // scope cannot claim the same upstream record.
  const clash = await rejectionOf(() =>
    database.insert(aiObservationBindings).values({
      ...reconciled.binding,
      id: `${prefix}-clash`,
      runId: `${prefix}-run-4b`,
    }),
  );
  expect(clash.code).toBe("23505");
});

test("a cross-row trace-id clash answers 409 BINDING_TRACE_CONFLICT, never a raw 23505 (R2-29)", async () => {
  const shared = `opik-${prefix}-shared-trace`;
  const first = {
    runId: `${prefix}-run-clash-1`,
    attemptId: "attempt-1",
    traceId: "trace-clash-1",
    capability: "detailed" as const,
    expiresAt: new Date("2026-10-22T00:00:00.000Z"),
  };
  const second = {
    ...first,
    runId: `${prefix}-run-clash-2`,
    traceId: "trace-clash-2",
  };
  await store.begin(scopeA, first);
  const begunSecond = await store.begin(scopeA, second);

  // Two local runs, one upstream trace (upstream duplication): the first reconcile claims
  // the (scope_key, opik_trace_id) unique index, so the second's UPDATE cannot land.
  await store.reconcile(scopeA, first.runId, first.attemptId, shared);

  // The mapped answer, not the driver's bare constraint error as a 500: the typed
  // house error, 409, code is the contract.
  const failure = await store
    .reconcile(scopeA, second.runId, second.attemptId, shared)
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RunBindingError);
  expect((failure as RunBindingError).code).toBe("BINDING_TRACE_CONFLICT");
  expect((failure as RunBindingError).status).toBe(409);

  // And the answer is deterministic: the retry hears the same refusal — the first
  // claim stands, this row simply stays unreconciled — never a constant 500.
  const retry = await store
    .reconcile(scopeA, second.runId, second.attemptId, shared)
    .catch((error: unknown) => error);
  expect((retry as RunBindingError).code).toBe("BINDING_TRACE_CONFLICT");

  const reread = await store.get(scopeA, begunSecond.binding.id);
  expect(reread?.opikTraceId).toBeNull();
  expect(reread?.state).toBe("running");

  // The first claimant is untouched.
  const winner = await store.latestAttempt(scopeA, first.runId);
  expect(winner?.opikTraceId).toBe(shared);
});

test("reconciliation never creates the binding Opik metadata refers to", async () => {
  await expect(
    store.reconcile(
      scopeA,
      `${prefix}-never-begun`,
      "attempt-1",
      "opik-trace-5",
    ),
  ).rejects.toThrow(new RunBindingError("BINDING_NOT_FOUND", 404));

  const rows = await database
    .select({ id: aiObservationBindings.id })
    .from(aiObservationBindings)
    .where(eq(aiObservationBindings.runId, `${prefix}-never-begun`));
  expect(rows).toHaveLength(0);
});

test("a forged scope is refused even against the real database", async () => {
  const forged = { ...scopeA };
  expect(() =>
    store.begin(forged, {
      runId: `${prefix}-run-6`,
      attemptId: "attempt-1",
      traceId: "trace-6",
      capability: "detailed",
      expiresAt: new Date("2026-10-22T00:00:00.000Z"),
    }),
  ).toThrow(new ObservationScopeError("OWNERSHIP_REQUIRED", 403));

  const rows = await database
    .select({ id: aiObservationBindings.id })
    .from(aiObservationBindings)
    .where(eq(aiObservationBindings.runId, `${prefix}-run-6`));
  expect(rows).toHaveLength(0);
});

test("an epoch bump (rename, profile update) keeps the history reachable (FREV-03 b)", async () => {
  const input = {
    runId: `${prefix}-run-7`,
    attemptId: "attempt-1",
    traceId: "trace-7",
    capability: "detailed" as const,
    expiresAt: new Date("2026-10-22T00:00:00.000Z"),
  };
  const before = await store.begin(scopeA, input);

  // A rename or profile update bumps the epoch. The data address is the Bot's
  // stable identity, so the new generation reaches the same records instead of
  // losing them to a rotated key space.
  const after = resolveObservationScope({
    actorId: "user-a",
    botId: "agent-1",
    ownership: "owner",
    epoch: 2,
  });
  expect(after.key).toBe(scopeA.key);
  expect(await store.get(after, before.binding.id)).toEqual(before.binding);
  expect(await store.latestAttempt(after, input.runId)).toEqual(before.binding);

  // The same run/attempt under the new generation is still one binding.
  const replay = await store.begin(after, input);
  expect(replay.replayed).toBe(true);
  expect(replay.binding.id).toBe(before.binding.id);
});

/*
 * G1 (T37 acceptance report) — the binding terminal state's production writer.
 *
 * A binding is born `running` and retention discovery excludes `running`, so a binding
 * that never leaves `running` can never be deleted: the terminal-state write is what makes
 * the deletion path reachable. `finish` is that writer's single seam, and the guard below
 * drives it through the exact production composition the reporting route runs.
 */

test("finish moves the running binding onto the observed terminal state", async () => {
  const runId = `${prefix}-run-fin-1`;
  await store.begin(scopeA, {
    runId,
    attemptId: "attempt-1",
    traceId: "trace-fin-1",
    capability: "basic",
    expiresAt: new Date("2026-10-22T00:00:00.000Z"),
  });

  const settled = await store.finish(scopeA, runId, "attempt-1", "completed");
  expect(settled.settled).toBe(true);
  expect(settled.binding).not.toBeNull();
  expect(settled.binding?.state).toBe("completed");

  const rows = await database
    .select({ state: aiObservationBindings.state })
    .from(aiObservationBindings)
    .where(eq(aiObservationBindings.runId, runId));
  expect(rows.map((row) => row.state)).toEqual(["completed"]);
});

test("the first terminal write wins: a later divergent finish changes nothing", async () => {
  const runId = `${prefix}-run-fin-2`;
  await store.begin(scopeA, {
    runId,
    attemptId: "attempt-1",
    traceId: "trace-fin-2",
    capability: "basic",
    expiresAt: new Date("2026-10-22T00:00:00.000Z"),
  });
  await store.finish(scopeA, runId, "attempt-1", "completed");

  // A straggler or replayed report naming a different ending is refused by the
  // same rule the lifecycle refuses divergent terminal events with.
  const divergent = await store.finish(scopeA, runId, "attempt-1", "failed");
  expect(divergent.settled).toBe(false);
  expect(divergent.binding?.state).toBe("completed");
});

test("concurrent finishes settle exactly once", async () => {
  const runId = `${prefix}-run-fin-3`;
  await store.begin(scopeA, {
    runId,
    attemptId: "attempt-1",
    traceId: "trace-fin-3",
    capability: "basic",
    expiresAt: new Date("2026-10-22T00:00:00.000Z"),
  });

  const outcomes = await Promise.all([
    store.finish(scopeA, runId, "attempt-1", "completed"),
    store.finish(scopeA, runId, "attempt-1", "failed"),
  ]);
  expect(outcomes.filter((outcome) => outcome.settled)).toHaveLength(1);
  const rows = await database
    .select({ state: aiObservationBindings.state })
    .from(aiObservationBindings)
    .where(eq(aiObservationBindings.runId, runId));
  expect(rows[0]?.state === "completed" || rows[0]?.state === "failed").toBe(
    true,
  );
});

test("finishing an attempt that was never begun settles nothing and creates no row", async () => {
  const runId = `${prefix}-run-fin-4`;
  const absent = await store.finish(scopeA, runId, "attempt-1", "completed");
  expect(absent.settled).toBe(false);
  expect(absent.binding).toBeNull();
  const rows = await database
    .select({ id: aiObservationBindings.id })
    .from(aiObservationBindings)
    .where(eq(aiObservationBindings.runId, runId));
  expect(rows).toHaveLength(0);
});

test("finish refuses a non-terminal state and a forged scope", async () => {
  // `running` is not an outcome; no event may write it.
  await expect(
    store.finish(
      scopeA,
      `${prefix}-run-fin-5`,
      "attempt-1",
      "running" as "completed",
    ),
  ).rejects.toThrow(new RunBindingError("BINDING_INPUT_INVALID", 400));

  const forged = { ...scopeA };
  expect(() =>
    store.finish(forged, `${prefix}-run-fin-5`, "attempt-1", "completed"),
  ).toThrow(new ObservationScopeError("OWNERSHIP_REQUIRED", 403));
});

test("GUARD: a real run termination moves the binding out of running (G1)", async () => {
  const runId = `${prefix}-run-fin-guard`;
  const attemptId = "attempt-1";
  const traceId = "trace-fin-guard";

  // The production composition the reporting route runs: a first-frame report begins
  // the binding and ends nothing.
  const firstFrame = await reportBasicRun({ bindings: store }, scopeA, {
    threadId: "thread-1",
    runId,
    attemptId,
    traceId,
    events: [{ type: "http_first_frame" }],
  });
  expect(firstFrame.attempt.state).toBe("running");
  const midRun = await database
    .select({ state: aiObservationBindings.state })
    .from(aiObservationBindings)
    .where(eq(aiObservationBindings.runId, runId));
  expect(midRun.map((row) => row.state)).toEqual(["running"]);

  // The run terminates for real: the same composition records the outcome —
  // and the binding can never answer `running` again.
  await reportBasicRun({ bindings: store }, scopeA, {
    threadId: "thread-1",
    runId,
    attemptId,
    traceId,
    events: [{ type: "success" }],
  });
  const ended = await database
    .select({ state: aiObservationBindings.state })
    .from(aiObservationBindings)
    .where(eq(aiObservationBindings.runId, runId));
  expect(ended.map((row) => row.state)).toEqual(["completed"]);
});

test("the migrated table exposes no column raw business content could land in", async () => {
  // The TypeScript schema is compile-time; this asks the migrated database what actually exists.
  const columns = await database.$client`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'ai_observation_bindings'
  `;
  const names = columns.map((column) => column.column_name);
  const forbidden =
    /prompt|output|body|message|content|attachment|argument|credential|secret|password|token|email|url/i;
  for (const name of names) {
    expect(name).not.toMatch(forbidden);
  }
});

test("rolling the bindings migration back drops only the bindings objects", async () => {
  const client = database.$client;
  const tablesBefore = await client`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `;
  const namesBefore = tablesBefore.map((row) => row.tablename);

  class Rollback extends Error {}
  try {
    await client.begin(async (transaction: TransactionSQL) => {
      await transaction`
        DROP INDEX IF EXISTS "ai_observation_bindings_scope_opik_trace_uq"
      `;
      await transaction`
        DROP INDEX IF EXISTS "ai_observation_bindings_scope_run_attempt_uq"
      `;
      await transaction`DROP TABLE IF EXISTS "ai_observation_bindings"`;
      const tablesAfter = await transaction`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
      `;
      // Exactly the bindings table left, every neighbour — including the journal — still there.
      expect(tablesAfter.map((row) => row.tablename)).toEqual(
        namesBefore.filter((name) => name !== "ai_observation_bindings"),
      );
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }

  // The rollback was itself rolled back: the suite's own table is still there for the cleanup.
  const restored = await client`
    SELECT to_regclass('ai_observation_bindings')::text AS present
  `;
  expect(restored[0]?.present).toBe("ai_observation_bindings");
});

// --- OCR round-1 fix: m104 (attempt order) + m105 (deletion-in-flight reads) ---

test("latestAttempt answers in creation order, not last-touched order (OCR m104)", async () => {
  const runId = `${prefix}-run-104`;
  await store.begin(scopeA, {
    runId,
    attemptId: "attempt-1",
    traceId: `trace-104-1`,
    capability: "basic",
    expiresAt: new Date("2026-10-22T00:00:00.000Z"),
  });
  await store.begin(scopeA, {
    runId,
    attemptId: "attempt-2",
    traceId: `trace-104-2`,
    capability: "basic",
    expiresAt: new Date("2026-10-22T00:00:00.000Z"),
  });
  // A late reconcile refreshes the superseded attempt's updatedAt — the exact race
  // the updatedAt-desc ordering used to lose.
  await store.reconcile(scopeA, runId, "attempt-1", `trace-opik-104-1`);
  const latest = await store.latestAttempt(scopeA, runId);
  expect(latest?.attemptId).toBe("attempt-2");
});

test("a deletion-in-flight binding is gone to every read seam (OCR m105)", async () => {
  const runId = `${prefix}-run-105`;
  const { binding } = await store.begin(scopeA, {
    runId,
    attemptId: "attempt-1",
    traceId: `trace-105-1`,
    capability: "detailed",
    expiresAt: new Date("2026-10-22T00:00:00.000Z"),
  });
  await store.reconcile(scopeA, runId, "attempt-1", `trace-opik-105-1`);
  // The retention record, exactly as discovery writes it.
  await database.insert(aiObservationRetentionDeletions).values({
    id: randomUUID(),
    scopeKey: scopeA.key,
    actorId: scopeA.actorId,
    botId: scopeA.botId,
    kind: "run",
    targetId: binding.id,
    upstreamKind: "trace",
    upstreamId: `trace-opik-105-1`,
    retentionDays: 7,
    state: "pending",
  });

  expect(await store.latestAttempt(scopeA, runId)).toBeNull();
  expect(await store.attempt(scopeA, runId, "attempt-1")).toBeNull();
  expect(await store.byOpikTrace(scopeA, `trace-opik-105-1`)).toBeNull();
  const verdicts = await store.capabilitiesByOpikTraceIds(scopeA, [
    `trace-opik-105-1`,
  ]);
  expect(verdicts.has(`trace-opik-105-1`)).toBe(false);
});

// ---------------------------------------------------------------------------
// FREV-02: the observer-path gate against the real store
// ---------------------------------------------------------------------------

const CHAIN_A = "0123456789abcdef0123456789abcdef";
const CHAIN_B = "fedcba9876543210fedcba9876543210";

describe("the observer run-binding gate (FREV-02)", () => {
  const gate = createObserverRunBindingGate(store);

  test("ensure begins the chain's authoritative binding before any export", async () => {
    const ref = await gate.ensure(scopeA, { traceId: CHAIN_A });
    expect(ref).toMatchObject({
      scopeKey: scopeA.key,
      runId: `builtin:${CHAIN_A}`,
      attemptId: `builtin:${CHAIN_A}`,
      opikTraceId: null,
    });
    // The row is really there, locatable by the read seam the detail route uses.
    const row = await store.latestAttempt(scopeA, `builtin:${CHAIN_A}`);
    expect(row?.traceId).toBe(CHAIN_A);
    expect(row?.capability).toBe("detailed");
    expect(row?.state).toBe("running");
  });

  test("a second ensure of the same chain replays the same row, not a second one", async () => {
    await gate.ensure(scopeA, { traceId: CHAIN_A });
    const rows = await database
      .select()
      .from(aiObservationBindings)
      .where(eq(aiObservationBindings.scopeKey, scopeA.key));
    const forChain = rows.filter((row) => row.traceId === CHAIN_A);
    expect(forChain).toHaveLength(1);
  });

  test("a carried runRef binds under the real run and attempt, and the chain check holds", async () => {
    await gate.ensure(scopeA, {
      traceId: CHAIN_B,
      runRef: { runId: `${prefix}gate-run`, attemptId: "attempt-9" },
    });
    const row = await store.attempt(scopeA, `${prefix}gate-run`, "attempt-9");
    expect(row?.traceId).toBe(CHAIN_B);
  });

  test("a divergent chain on the authoritative row refuses (the first claim stands)", async () => {
    // The same (scope, run, attempt) already bound a DIFFERENT chain — the
    // HTTP report path's row, say. The gate must refuse to export a run under
    // a row that disagrees with the chain being exported. A fresh gate: the
    // shared one memoizes chains it already established, by design.
    const runId = `${prefix}gate-divergent`;
    await store.begin(scopeA, {
      runId,
      attemptId: "attempt-1",
      traceId: "a".repeat(32),
      capability: "basic",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const fresh = createObserverRunBindingGate(store);
    await expect(
      fresh.ensure(scopeA, {
        traceId: CHAIN_A,
        runRef: { runId, attemptId: "attempt-1" },
      }),
    ).rejects.toThrow(RunBindingError);
  });

  test("an observed window settles the binding onto the honest state", async () => {
    const traceId = "e".repeat(32);
    await gate.ensure(scopeA, { traceId });
    gate.settleObservedWindow(scopeA, { traceId }, "terminal");
    // The settle rides a microtask chain; wait it out.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const row = await store.latestAttempt(scopeA, `builtin:${traceId}`);
    expect(row?.state).toBe("unknown");

    const interruptedChain = "d".repeat(32);
    await gate.ensure(scopeA, { traceId: interruptedChain });
    gate.settleObservedWindow(
      scopeA,
      { traceId: interruptedChain },
      "interrupted",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const interruptedRow = await store.latestAttempt(
      scopeA,
      `builtin:${interruptedChain}`,
    );
    expect(interruptedRow?.state).toBe("interrupted");
  });
});

// ---------------------------------------------------------------------------
// R3-03: the run's own observed ending settles the binding's real terminal
// state, and the list's lifecycle join reads it back by upstream trace id.
// ---------------------------------------------------------------------------

describe("the observer gate settles the run's observed ending (R3-03)", () => {
  const chain = () => randomUUID().replaceAll("-", "");

  test("a named ending persists the binding's real state, first ending wins", async () => {
    const gate = createObserverRunBindingGate(store);
    const a = chain();
    const b = chain();
    const c = chain();
    const d = chain();
    await gate.ensure(scopeA, { traceId: a });
    gate.settleObservedRun(
      scopeA,
      { traceId: a },
      {
        startedAt: new Date(),
        ending: "success",
        endedAt: new Date(),
      },
    );
    // A straggler window close (or a second, divergent ending) changes nothing.
    gate.settleObservedWindow(scopeA, { traceId: a }, "terminal");
    gate.settleObservedRun(
      scopeA,
      { traceId: a },
      {
        startedAt: new Date(),
        ending: "error",
        endedAt: new Date(),
      },
    );
    await gate.ensure(scopeA, { traceId: b });
    gate.settleObservedRun(
      scopeA,
      { traceId: b },
      {
        startedAt: new Date(),
        ending: "error",
        endedAt: new Date(),
      },
    );
    await gate.ensure(scopeA, { traceId: c });
    gate.settleObservedRun(
      scopeA,
      { traceId: c },
      {
        startedAt: new Date(),
        ending: "canceled",
        endedAt: new Date(),
      },
    );
    // A run nobody ever ensured still settles — the no-tool run's whole path.
    gate.settleObservedRun(
      scopeA,
      { traceId: d },
      {
        startedAt: new Date(),
        ending: "interrupted",
        endedAt: new Date(),
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await store.latestAttempt(scopeA, `builtin:${a}`))?.state).toBe(
      "completed",
    );
    expect((await store.latestAttempt(scopeA, `builtin:${b}`))?.state).toBe(
      "failed",
    );
    expect((await store.latestAttempt(scopeA, `builtin:${c}`))?.state).toBe(
      "canceled",
    );
    expect((await store.latestAttempt(scopeA, `builtin:${d}`))?.state).toBe(
      "interrupted",
    );
  });

  test("a disconnected window settles the honest unknown, only that", async () => {
    const gate = createObserverRunBindingGate(store);
    const a = chain();
    await gate.ensure(scopeA, { traceId: a });
    gate.settleObservedRun(
      scopeA,
      { traceId: a },
      {
        startedAt: new Date(),
        ending: "disconnected",
        endedAt: new Date(),
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await store.latestAttempt(scopeA, `builtin:${a}`))?.state).toBe(
      "unknown",
    );
  });

  test("statesByOpikTraceIds answers the settled states this scope bound", async () => {
    const gate = createObserverRunBindingGate(store);
    const a = chain();
    const b = chain();
    const foreign = chain();
    // FREV-03: the scope key is the Bot's stable data identity, so "another
    // scope" means another Bot (or epoch) — same-Bot admin scopes read the
    // same rows by design.
    const otherBot = resolveObservationScope({
      actorId: "user-a",
      botId: `agent-${randomUUID()}`,
      ownership: "owner",
      epoch: 1,
    });
    await gate.ensure(scopeA, { traceId: a });
    await gate.ensure(scopeA, { traceId: b });
    await gate.ensure(otherBot, { traceId: foreign });
    gate.settleObservedRun(
      scopeA,
      { traceId: a },
      {
        startedAt: new Date(),
        ending: "success",
        endedAt: new Date(),
      },
    );
    gate.settleObservedRun(
      otherBot,
      { traceId: foreign },
      {
        startedAt: new Date(),
        ending: "success",
        endedAt: new Date(),
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The upstream ids reconciliation would record, derived and recorded here.
    const opikA = runUpstreamIdentity(a).opikTraceId;
    const opikB = runUpstreamIdentity(b).opikTraceId;
    await store.reconcile(scopeA, `builtin:${a}`, `builtin:${a}`, opikA);
    await store.reconcile(scopeA, `builtin:${b}`, `builtin:${b}`, opikB);
    const states = await store.statesByOpikTraceIds(scopeA, [opikA, opikB]);
    expect(states.get(opikA)).toBe("completed");
    // B never settled: the join answers its LIVE state too — running is the
    // honest word for a run whose binding is still open.
    expect(states.get(opikB)).toBe("running");
    // The same trace id under another Bot's scope is simply not this scope's row.
    const fromOther = await store.statesByOpikTraceIds(otherBot, [opikA]);
    expect(fromOther.has(opikA)).toBe(false);
    // Empty list answers empty, never a query.
    expect(await store.statesByOpikTraceIds(scopeA, [])).toEqual(new Map());
  });
});

// ---------------------------------------------------------------------------
// F5E1-F3: the gate's materialization half against the real store — the
// authoritative mapping is persisted by the gate's own reconcile, and the
// query seams can answer from it.
// ---------------------------------------------------------------------------

describe("the observer gate materializes and reconciles upstream identity (F5E1-F3)", () => {
  // A scope of its own: the reconcile counts below are scope-wide, so the rows
  // other describes leave behind must not be part of the answer.
  const scope = resolveObservationScope({
    actorId: `f6b-owner-${randomUUID()}`,
    botId: `f6b-bot-${randomUUID()}`,
    ownership: "owner",
    epoch: 1,
  });
  const chain = () => randomUUID().replaceAll("-", "");

  afterEach(async () => {
    await database
      .delete(aiObservationBindings)
      .where(eq(aiObservationBindings.scopeKey, scope.key));
    await database
      .delete(aiObservationRetentionDeletions)
      .where(eq(aiObservationRetentionDeletions.scopeKey, scope.key));
  });

  const aPort = (
    onCreate: (traceId: string) =>
      | { outcome: "ok"; value: { traceId: string } }
      | {
          outcome: "unavailable";
          operation: "createTrace";
          code: "OPIK_TIMEOUT";
        },
  ) => {
    const created: string[] = [];
    const roots: string[] = [];
    const port = {
      healthCheck: async () => ({
        outcome: "ok" as const,
        value: { healthy: true as const },
      }),
      createTrace: async (_s: unknown, input: { traceId: string }) => {
        const answer = onCreate(input.traceId);
        if (answer.outcome === "ok") created.push(input.traceId);
        return answer;
      },
      writeSpans: async (
        _s: unknown,
        input: { spans: Array<{ spanId: string }> },
      ) => {
        for (const span of input.spans) roots.push(span.spanId);
        return { outcome: "ok" as const, value: { accepted: true as const } };
      },
    };
    return { created, roots, port: port as unknown as OpikPort };
  };

  test("ensure persists the derived upstream id on the authoritative row", async () => {
    const chainId = chain();
    const identity = runUpstreamIdentity(chainId);
    const { created, roots, port } = aPort((traceId) => ({
      outcome: "ok",
      value: { traceId },
    }));
    const gate = createObserverRunBindingGate(store, { port: () => port });

    const ref = await gate.ensure(scope, { traceId: chainId });

    expect(created).toEqual([identity.opikTraceId]);
    expect(roots).toEqual([identity.rootSpanId]);
    expect(ref.opikTraceId).toBe(identity.opikTraceId);
    // The authoritative row itself: persisted, and readable by the reverse seam
    // the query face's id mapping uses.
    const row = await store.latestAttempt(scope, `builtin:${chainId}`);
    expect(row?.opikTraceId).toBe(identity.opikTraceId);
    expect(await store.byOpikTrace(scope, identity.opikTraceId)).toMatchObject({
      runId: `builtin:${chainId}`,
    });
    expect(await store.countUnreconciled(scope)).toBe(0);

    // A replay of the same chain does not materialize twice.
    await gate.ensure(scope, { traceId: chainId });
    expect(created).toHaveLength(1);
    expect(roots).toHaveLength(1);
  });

  test("eviction defers an in-flight chain: the same chain never materializes twice (OCR R5-725)", async () => {
    const chainId = chain();
    const identity = runUpstreamIdentity(chainId);
    const created: string[] = [];
    let releaseA!: () => void;
    const hangA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    // A port whose createTrace HANGS for chain A: the begun entry stays in flight
    // while later chains arrive and force an eviction pass.
    const port: OpikPort = {
      healthCheck: async () => ({
        outcome: "ok" as const,
        value: { healthy: true as const },
      }),
      createTrace: async (_s, input: { traceId: string }) => {
        created.push(input.traceId);
        if (input.traceId === identity.opikTraceId) {
          await hangA; // chain A stays in flight across the eviction pass
        }
        return { outcome: "ok" as const, value: { traceId: input.traceId } };
      },
      writeSpans: async () => ({
        outcome: "ok" as const,
        value: { accepted: true as const },
      }),
    } as unknown as OpikPort;

    const gate = createObserverRunBindingGate(store, {
      port: () => port,
      maxChainsPerScope: 2, // the third chain forces an eviction
    });

    const first = gate.ensure(scope, { traceId: chainId }); // A: in flight
    for (let i = 0; i < 100 && created.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await gate.ensure(scope, { traceId: chain() }); // B: done, evictable
    await gate.ensure(scope, { traceId: chain() }); // C: eviction fires
    // A concurrent fact of the SAME chain while A is still in flight: the deferred
    // (not dropped) entry keeps the dedup alive — one createTrace, ever.
    const second = gate.ensure(scope, { traceId: chainId });
    releaseA();

    const [ref1, ref2] = await Promise.all([first, second]);
    // Chains B and C each materialize their own trace once; the pinned fact is
    // chain A's id appearing EXACTLY once across the eviction pass and the
    // concurrent second fact.
    expect(created.filter((id) => id === identity.opikTraceId)).toEqual([
      identity.opikTraceId,
    ]);
    expect(ref1.opikTraceId).toBe(identity.opikTraceId);
    expect(ref2.opikTraceId).toBe(identity.opikTraceId);
    expect(ref1).toBe(ref2);
  });

  test("a materialization failure leaves the row unreconciled and the retry converges", async () => {
    const chainId = chain();
    let down = true;
    const { created, port } = aPort((traceId) =>
      down
        ? {
            outcome: "unavailable",
            operation: "createTrace",
            code: "OPIK_TIMEOUT",
          }
        : { outcome: "ok", value: { traceId } },
    );
    const gate = createObserverRunBindingGate(store, { port: () => port });

    await expect(gate.ensure(scope, { traceId: chainId })).rejects.toThrow(
      RunBindingError,
    );
    expect(
      await store.latestAttempt(scope, `builtin:${chainId}`),
    ).toMatchObject({ opikTraceId: null });
    expect(await store.countUnreconciled(scope)).toBe(1);

    // The upstream answers now; the same chain converges onto the SAME derived
    // identity the failed attempt asked for — no second trace, ever.
    down = false;
    const ref = await gate.ensure(scope, { traceId: chainId });
    expect(created).toEqual([runUpstreamIdentity(chainId).opikTraceId]);
    expect(ref.opikTraceId).toBe(runUpstreamIdentity(chainId).opikTraceId);
    expect(await store.countUnreconciled(scope)).toBe(0);
  });
});
