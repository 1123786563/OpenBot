import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { OpikConfig } from "../src/ai-observability/config";
import {
  createObservationExportStore,
  createObservationExportWorker,
  EXPORT_WORK_KIND,
  type ObservationExportWorker,
} from "../src/ai-observability/exports";
import type { OpikPort, OpikTraceRow } from "../src/ai-observability/opik-port";
import { projectRow } from "../src/ai-observability/queries/runs";
import {
  resolveObservationScope,
  resolveStorageLocator,
} from "../src/ai-observability/scope";
import { aiObservationExportJobs } from "../src/db/schema/ai-observability-exports";
import { workItems } from "../src/db/schema/work";
import { opikTestDatabase } from "./support/opik-test-db";
import { rejectionOf } from "./support/pg-errors";

/**
 * Behavioral proof of the bounded async export against a real, dedicated
 * PostgreSQL database (Issue #40 / DAG T34): the enqueue-only request path, the
 * concurrency bound that queues instead of backlog-parallelizing, the row cap
 * that fails rather than truncates, immediate revocation whose product never
 * lands, scope isolation, and the database facts that hold all of it up. There
 * is no skip and no fallback database; a missing test database fails the run.
 */

const database = opikTestDatabase({ max: 6 });
const store = createObservationExportStore(database);

const scopeA = resolveObservationScope({
  actorId: `t34-a-${randomUUID()}`,
  botId: "agent-1",
  ownership: "owner",
  epoch: 1,
});
const scopeB = resolveObservationScope({
  actorId: `t34-b-${randomUUID()}`,
  botId: "agent-1",
  ownership: "admin",
  epoch: 1,
});

const enabledConfig: OpikConfig = {
  enabled: true,
  baseUrl: "http://opik.test",
  apiKey: "held-for-port-wiring",
  workspaceName: "openbot",
  port: 5174,
  otlpHttpPort: 5418,
  otlpGrpcPort: 5417,
};

/**
 * The upstream, faked at the port seam. Rows are the untrusted shapes the real
 * port delivers; nothing here is trusted further than the projection. When
 * `gated`, every listTraces call parks until the test releases it, so a job can
 * be observed in flight and revoked underneath.
 */
function fakePort(options: {
  rows?: readonly OpikTraceRow[];
  total?: number;
  gated?: boolean;
  project?: Awaited<ReturnType<OpikPort["retrieveProject"]>>;
}) {
  const calls: {
    listTraces: number;
    retrieveProject: number;
    sizes: number[];
    pages: number[];
  } = { listTraces: 0, retrieveProject: 0, sizes: [], pages: [] };
  let inFlight = 0;
  let maxInFlight = 0;
  const waiting: Array<() => void> = [];
  const port: OpikPort = {
    healthCheck: async () => ({ outcome: "ok", value: { healthy: true } }),
    retrieveProject: async () => {
      calls.retrieveProject += 1;
      return options.project ?? { outcome: "ok", value: { id: "proj-1" } };
    },
    listTraces: async (_scope, input) => {
      calls.listTraces += 1;
      calls.sizes.push(input.size ?? -1);
      calls.pages.push(input.page ?? 0);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (options.gated) {
          await new Promise<void>((resolve) => waiting.push(resolve));
        }
        const rows = options.rows ?? [];
        const total = options.total ?? rows.length;
        const size = input.size ?? rows.length;
        const start = (input.page ?? 0) * size;
        return {
          outcome: "ok" as const,
          value: {
            page: input.page ?? 0,
            size,
            total,
            content: rows.slice(start, start + size),
          },
        };
      } finally {
        inFlight -= 1;
      }
    },
    createTrace: async () => {
      throw new Error("the export must never write");
    },
    writeSpans: async () => {
      throw new Error("the export must never write");
    },
  };
  return {
    port,
    calls,
    inFlight: () => inFlight,
    maxInFlight: () => maxInFlight,
    release: () => {
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}

/** The worker over one fake upstream. `revoked` answers null from live authorization. */
function workerFor(
  port: OpikPort | null,
  input: { revoked?: boolean; concurrency?: number } = {},
): ObservationExportWorker {
  return createObservationExportWorker({
    database,
    config: () => enabledConfig,
    port,
    // The test's stand-in for wiring's live ownership check: the scope this
    // process would issue for that actor and bot now, or null once the
    // actor's authorization ended.
    reauthorize: input.revoked
      ? async () => null
      : async ({ actorId }) =>
          actorId === scopeA.actorId
            ? scopeA
            : actorId === scopeB.actorId
              ? scopeB
              : null,
    concurrency: input.concurrency,
    owner: `t34-owner-${randomUUID()}`,
  });
}

async function until(
  predicate: () => Promise<boolean> | boolean,
  what: string,
  ms = 5_000,
) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`condition not reached: ${what}`);
}

const states = async () => {
  const rows = await database
    .select({ state: aiObservationExportJobs.state })
    .from(aiObservationExportJobs)
    .where(
      sql`${aiObservationExportJobs.scopeKey} IN (${scopeA.key}, ${scopeB.key})`,
    );
  const count = (state: string) =>
    rows.filter((row) => row.state === state).length;
  return { rows, count };
};

afterEach(async () => {
  await database
    .delete(aiObservationExportJobs)
    .where(
      sql`${aiObservationExportJobs.scopeKey} IN (${scopeA.key}, ${scopeB.key})`,
    );
  await database.delete(workItems).where(eq(workItems.kind, EXPORT_WORK_KIND));
});

afterAll(async () => {
  await database.$client.close();
});

test("the dedicated test database carries the export jobs schema", async () => {
  const indexes = await database.$client`
    SELECT indexname FROM pg_indexes WHERE tablename = 'ai_observation_export_jobs'
  `;
  const present = new Set(indexes.map((row) => row.indexname));
  for (const required of [
    "ai_observation_export_jobs_scope_created_idx",
    "ai_observation_export_jobs_active_actor_idx",
  ]) {
    if (!present.has(required)) {
      throw new Error(
        `The dedicated Opik test database lacks ${required}. Apply the migrations to the dedicated test database first (TEST_DATABASE_URL=... bun run db:migrate in server/); do not point these tests at the application database and do not record this as a pass.`,
      );
    }
  }
});

test("enqueue answers a queued job without touching upstream (AC1)", async () => {
  const upstream = fakePort({ rows: [] });
  const job = await store.enqueue(scopeA, 50);
  expect(job.state).toBe("queued");
  expect(job.artifact).toBeNull();
  expect(job.settledAt).toBeNull();
  expect(job.rowLimit).toBe(50);
  expect(job.errorCode).toBeNull();
  const locator = resolveStorageLocator(scopeA);
  expect(job.locatorWorkspace).toBe(locator.workspace);
  expect(job.locatorProject).toBe(locator.project);
  // The claim ticket landed with the job, atomically.
  const tickets = await database
    .select()
    .from(workItems)
    .where(eq(workItems.key, job.id));
  expect(tickets).toHaveLength(1);
  expect(tickets[0].kind).toBe(EXPORT_WORK_KIND);
  expect(upstream.calls.retrieveProject).toBe(0);
  expect(upstream.calls.listTraces).toBe(0);
});

test("a swept job completes with a projected artifact and no canary (AC2)", async () => {
  const rows: OpikTraceRow[] = [
    {
      id: "trace-1",
      status: "COMPLETED",
      metadata: { thread_id: "t-1", model: "gpt-test" },
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    },
    {
      id: "trace-2",
      status: "IN_PROGRESS",
      metadata: { model: "sk-live-abcdefghijklmnopqrst" },
    },
  ];
  const upstream = fakePort({ rows });
  const worker = workerFor(upstream.port);
  const job = await store.enqueue(scopeA, 100);
  await worker.sweep();
  const done = await store.get(scopeA, job.id);
  expect(done?.state).toBe("completed");
  expect(done?.rowCount).toBe(2);
  expect(done?.settledAt).toBeInstanceOf(Date);
  expect(done?.errorCode).toBeNull();
  expect(done?.artifact).toEqual(rows.map(projectRow));
  expect(JSON.stringify(done?.artifact)).not.toContain("sk-live-");
});

test("a scope whose project does not exist upstream exports a truthful empty (AC2)", async () => {
  const upstream = fakePort({
    rows: [],
    project: { outcome: "ok", value: null },
  });
  const worker = workerFor(upstream.port);
  const job = await store.enqueue(scopeA, 10);
  await worker.sweep();
  const done = await store.get(scopeA, job.id);
  expect(done?.state).toBe("completed");
  expect(done?.rowCount).toBe(0);
  expect(done?.artifact).toEqual([]);
  expect(upstream.calls.listTraces).toBe(0);
});

test("concurrency is bounded: jobs beyond the cap queue, never parallelize (AC1/AC5)", async () => {
  const rows: OpikTraceRow[] = Array.from({ length: 5 }, (_, i) => ({
    id: `trace-${i}`,
    status: "COMPLETED",
  }));
  const upstream = fakePort({ rows, gated: true });
  const worker = workerFor(upstream.port, { concurrency: 2 });
  for (let i = 0; i < 5; i += 1) {
    await store.enqueue(scopeA, 5);
  }

  // Round one: two run, three wait — the bound is the configuration, not the backlog.
  let pass = worker.sweep();
  await until(() => upstream.inFlight() === 2, "two in flight");
  expect((await states()).count("running")).toBe(2);
  expect((await states()).count("queued")).toBe(3);
  upstream.release();
  await pass;
  expect((await states()).count("completed")).toBe(2);

  // Round two: same shape again.
  pass = worker.sweep();
  await until(() => upstream.inFlight() === 2, "two in flight");
  expect((await states()).count("queued")).toBe(1);
  upstream.release();
  await pass;
  expect((await states()).count("completed")).toBe(4);

  // Round three: the last one.
  pass = worker.sweep();
  await until(async () => upstream.inFlight() === 1, "last job in flight");
  upstream.release();
  await pass;
  expect((await states()).count("completed")).toBe(5);
  expect(upstream.maxInFlight()).toBe(2);
});

test("a total above the row cap fails explicitly, never truncates (AC5)", async () => {
  const rows: OpikTraceRow[] = Array.from({ length: 5 }, (_, i) => ({
    id: `trace-${i}`,
    status: "COMPLETED",
  }));
  const upstream = fakePort({ rows, total: 5 });
  const worker = workerFor(upstream.port);
  const job = await store.enqueue(scopeA, 3);
  await worker.sweep();
  const done = await store.get(scopeA, job.id);
  expect(done?.state).toBe("failed");
  expect(done?.errorCode).toBe("EXPORT_ROW_LIMIT_EXCEEDED");
  expect(done?.artifact).toBeNull();
  expect(done?.rowCount).toBeNull();
  // The refusal happens on the first page: no second fetch for a doomed export.
  expect(upstream.calls.listTraces).toBe(1);
});

test("revocation mid-run cancels the job and the artifact never lands (AC3)", async () => {
  const rows: OpikTraceRow[] = [{ id: "trace-1", status: "COMPLETED" }];
  const upstream = fakePort({ rows, gated: true });
  const worker = workerFor(upstream.port);
  const job = await store.enqueue(scopeA, 10);

  const pass = worker.sweep();
  await until(async () => (await states()).count("running") === 1, "running");

  // The control-plane seam: the actor's authorization ended.
  const cancelled = await store.cancelForActor(scopeA.actorId);
  expect(cancelled).toBe(1);
  const mid = await store.get(scopeA, job.id);
  expect(mid?.state).toBe("cancelled");
  expect(mid?.settledAt).toBeInstanceOf(Date);

  // The fetch finishes anyway; its product must not land.
  upstream.release();
  await pass;
  const done = await store.get(scopeA, job.id);
  expect(done?.state).toBe("cancelled");
  expect(done?.artifact).toBeNull();
  expect(done?.rowCount).toBeNull();
});

test("the database itself refuses an artifact on a cancelled job (AC3)", async () => {
  const job = await store.enqueue(scopeA, 10);
  await store.cancelForActor(scopeA.actorId);
  const refused = await rejectionOf(() =>
    database
      .update(aiObservationExportJobs)
      .set({ artifact: [] })
      .where(eq(aiObservationExportJobs.id, job.id)),
  );
  expect(refused.code).toBe("23514"); // check_violation
});

test("a revoked actor's job cancels before any upstream call (AC3)", async () => {
  const upstream = fakePort({ rows: [{ id: "trace-1", status: "COMPLETED" }] });
  const worker = workerFor(upstream.port, { revoked: true });
  const job = await store.enqueue(scopeA, 10);
  await worker.sweep();
  const done = await store.get(scopeA, job.id);
  expect(done?.state).toBe("cancelled");
  expect(done?.artifact).toBeNull();
  expect(upstream.calls.retrieveProject).toBe(0);
  expect(upstream.calls.listTraces).toBe(0);
});

test("an unavailable upstream fails the job with the port's code (AC4)", async () => {
  const upstream = fakePort({
    rows: [],
    project: {
      outcome: "unavailable",
      operation: "retrieveProject",
      code: "OPIK_TIMEOUT",
    },
  });
  const worker = workerFor(upstream.port);
  const job = await store.enqueue(scopeA, 10);
  await worker.sweep();
  const done = await store.get(scopeA, job.id);
  expect(done?.state).toBe("failed");
  expect(done?.errorCode).toBe("OPIK_TIMEOUT");
  expect(done?.artifact).toBeNull();
});

test("jobs are invisible and uncancelable across scopes (AC2)", async () => {
  const upstream = fakePort({ rows: [] });
  const worker = workerFor(upstream.port);
  const jobA = await store.enqueue(scopeA, 10);
  const jobB = await store.enqueue(scopeB, 10);

  // Another scope's id is simply not found.
  expect(await store.get(scopeB, jobA.id)).toBeNull();
  expect(await store.get(scopeA, jobB.id)).toBeNull();
  expect((await store.list(scopeA)).map((job) => job.id)).toEqual([jobA.id]);
  expect((await store.list(scopeB)).map((job) => job.id)).toEqual([jobB.id]);

  // Revoking actor A leaves actor B's jobs exactly where they were.
  expect(await store.cancelForActor(scopeA.actorId)).toBe(1);
  expect((await store.get(scopeA, jobA.id))?.state).toBe("cancelled");
  expect((await store.get(scopeB, jobB.id))?.state).toBe("queued");

  // And B's job still runs to completion afterwards.
  await worker.sweep();
  expect((await store.get(scopeB, jobB.id))?.state).toBe("completed");
});
