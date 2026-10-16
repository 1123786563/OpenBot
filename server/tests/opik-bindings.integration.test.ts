import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TransactionSQL } from "bun";
import { eq, sql } from "drizzle-orm";
import {
  createRunBindingStore,
  RunBindingError,
} from "../src/ai-observability/bindings";
import { ObservationScopeError } from "../src/ai-observability/contracts";
import { reportBasicRun } from "../src/ai-observability/routes/basic-run";
import { resolveObservationScope } from "../src/ai-observability/scope";
import { aiObservationBindings } from "../src/db/schema/ai-observability-bindings";
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

test("the same run id under two scopes stays two bindings, invisible to each other", async () => {
  const input = {
    runId: `${prefix}-run-2`,
    attemptId: "attempt-1",
    traceId: "trace-2",
    capability: "basic" as const,
    expiresAt: new Date("2026-10-22T00:00:00.000Z"),
  };

  const a = await store.begin(scopeA, input);
  const b = await store.begin(scopeB, input);

  expect(a.binding.id).not.toBe(b.binding.id);
  expect(await store.get(scopeA, b.binding.id)).toBeNull();
  expect(await store.get(scopeB, a.binding.id)).toBeNull();
  expect(await store.get(scopeA, a.binding.id)).toEqual(a.binding);

  const rows = await database
    .select({ scopeKey: aiObservationBindings.scopeKey })
    .from(aiObservationBindings)
    .where(eq(aiObservationBindings.runId, input.runId));
  expect(rows.map((row) => row.scopeKey).sort()).toEqual(
    [scopeA.key, scopeB.key].sort(),
  );
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

test("an ownership epoch bump fences the old scope's bindings away", async () => {
  const input = {
    runId: `${prefix}-run-7`,
    attemptId: "attempt-1",
    traceId: "trace-7",
    capability: "detailed" as const,
    expiresAt: new Date("2026-10-22T00:00:00.000Z"),
  };
  const before = await store.begin(scopeA, input);

  // Ownership was revoked and re-granted: the new epoch mints a different scope key, so the old
  // binding is invisible to the new authority rather than silently inherited.
  const after = resolveObservationScope({
    actorId: "user-a",
    botId: "agent-1",
    ownership: "owner",
    epoch: 2,
  });
  expect(after.key).not.toBe(scopeA.key);

  expect(await store.get(after, before.binding.id)).toBeNull();

  const regranted = await store.begin(after, input);
  expect(regranted.binding.id).not.toBe(before.binding.id);

  // The old binding is untouched underneath, not overwritten by the new epoch.
  expect(await store.get(scopeA, before.binding.id)).toEqual(before.binding);
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
