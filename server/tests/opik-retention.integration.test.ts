import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { createRunBindingStore } from "../src/ai-observability/bindings";
import type { OpikConfig } from "../src/ai-observability/config";
import { createObservationDatasetStore } from "../src/ai-observability/datasets";
import { createObservationExperimentStore } from "../src/ai-observability/experiments";
import {
  createObservationExportStore,
  ExportError,
} from "../src/ai-observability/exports";
import { createIdLinkStore } from "../src/ai-observability/id-links";
import type { OpikPort, OpikTraceRow } from "../src/ai-observability/opik-port";
import { createRunsQueryService } from "../src/ai-observability/queries/runs";
import {
  createObservationRetentionStore,
  createObservationRetentionWorker,
  type ObservationRetentionWorker,
  type RetentionDays,
  resolveRetentionDays,
} from "../src/ai-observability/retention";
import {
  resolveObservationScope,
  resolveStorageLocator,
} from "../src/ai-observability/scope";
import { createAuditStore } from "../src/audit";
import { aiObservationBindings } from "../src/db/schema/ai-observability-bindings";
import {
  aiObservationDatasets,
  aiObservationDatasetVersions,
} from "../src/db/schema/ai-observability-datasets";
import { aiObservationExperiments } from "../src/db/schema/ai-observability-experiments";
import { aiObservationExportJobs } from "../src/db/schema/ai-observability-exports";
import {
  aiObservationRetentionDeletions,
  aiObservationRetentionOverrides,
} from "../src/db/schema/ai-observability-retention";
import { workItems } from "../src/db/schema/work";
import { testDatabaseUrl } from "./support/database";
import { opikTestDatabase } from "./support/opik-test-db";
import { rejectionOf } from "./support/pg-errors";

/**
 * Behavioral proof of the retention pipeline against a real, dedicated PostgreSQL
 * database (Issue #41 / DAG T35): the expiry boundary, real deletion verified over a
 * fresh connection, the T20/0126 flag channels for dataset versions and experiments,
 * the upstream-deletion sync state machine that never fakes success, the lease that
 * keeps two replicas off one target, zero residue on every query surface, audit rows
 * that carry references and counts but never content, and the export enqueue cap.
 * There is no skip and no fallback database; a missing test database fails the run.
 */

const database = opikTestDatabase({ max: 6 });
const retentionStore = createObservationRetentionStore(database);
const bindingStore = createRunBindingStore(database);
const datasetStore = createObservationDatasetStore(database);
const exportStore = createObservationExportStore(database);

/** A genuinely separate connection: what a restarted process would see. */
const fresh = postgres(testDatabaseUrl(), { max: 1 });

const scopeA = resolveObservationScope({
  actorId: `t35-a-${randomUUID()}`,
  botId: "agent-1",
  ownership: "owner",
  epoch: 1,
});
const scopeB = resolveObservationScope({
  actorId: `t35-b-${randomUUID()}`,
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
const disabledConfig: OpikConfig = { ...enabledConfig, enabled: false };

/**
 * The upstream, faked at the port seam. Trace deletion is observable: the ids
 * handed to deleteTraces leave `rows`, so the T11 query surface built on the same
 * fake cannot serve a deleted trace after the sweep. `gatedDelete` parks every
 * deletion call until released, so a lease can be observed being held.
 */
function fakePort(options: {
  rows?: OpikTraceRow[];
  gatedDelete?: boolean;
  failFirstTraceDelete?: boolean;
  failFirstDatasetDelete?: boolean;
}) {
  const rows = [...(options.rows ?? [])];
  const calls: {
    deleteTraces: { ids: string[]; project: string }[];
    deleteDatasets: string[];
    retrieveProject: number;
  } = { deleteTraces: [], deleteDatasets: [], retrieveProject: 0 };
  let traceDeleteCalls = 0;
  let datasetDeleteCalls = 0;
  const waiting: Array<() => void> = [];
  const port: OpikPort = {
    healthCheck: async () => ({ outcome: "ok", value: { healthy: true } }),
    retrieveProject: async () => {
      calls.retrieveProject += 1;
      return { outcome: "ok", value: { id: "proj-t35" } };
    },
    listTraces: async (_scope, input) => {
      const size = input.size ?? rows.length;
      const start = (input.page ?? 0) * size;
      return {
        outcome: "ok" as const,
        value: {
          page: input.page ?? 0,
          size,
          total: rows.length,
          content: rows.slice(start, start + size),
        },
      };
    },
    createTrace: async () => {
      throw new Error("retention must never create upstream data");
    },
    writeSpans: async () => {
      throw new Error("retention must never write upstream data");
    },
    deleteTraces: async (locator, input) => {
      calls.deleteTraces.push({
        ids: [...input.traceIds],
        project: locator.project,
      });
      traceDeleteCalls += 1;
      if (options.gatedDelete) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      if (options.failFirstTraceDelete && traceDeleteCalls === 1) {
        return {
          outcome: "unavailable" as const,
          operation: "deleteTraces" as const,
          code: "OPIK_TIMEOUT" as const,
        };
      }
      for (const id of input.traceIds) {
        const at = rows.findIndex((row) => row.id === id);
        if (at >= 0) rows.splice(at, 1);
      }
      return { outcome: "ok" as const, value: { deleted: true as const } };
    },
    deleteDataset: async (_locator, input) => {
      calls.deleteDatasets.push(input.datasetId);
      datasetDeleteCalls += 1;
      if (options.gatedDelete) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      if (options.failFirstDatasetDelete && datasetDeleteCalls === 1) {
        return {
          outcome: "upstream_error" as const,
          operation: "deleteDataset" as const,
          code: "OPIK_UPSTREAM_ERROR" as const,
          status: 503,
        };
      }
      return { outcome: "ok" as const, value: { deleted: true as const } };
    },
  };
  return {
    port,
    calls,
    rows,
    release: () => {
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}

function workerFor(
  input: {
    port?: OpikPort | null;
    disabled?: boolean;
    retention?: () => RetentionDays;
    owner?: string;
    concurrency?: number;
    invalidateReads?: (input: {
      scopeKey: string;
      kind: string;
    }) => Promise<void> | void;
  } = {},
): ObservationRetentionWorker {
  return createObservationRetentionWorker({
    database,
    config: () => (input.disabled ? disabledConfig : enabledConfig),
    port: input.port ?? null,
    retention: input.retention ?? (() => resolveRetentionDays({})),
    audit: createAuditStore(database),
    owner: input.owner ?? `t35-owner-${randomUUID()}`,
    concurrency: input.concurrency,
    invalidateReads: input.invalidateReads,
  });
}

/** One frozen dataset case, the minimum T19's freeze pipeline accepts. */
const oneCase = (runId: string) => ({
  input: "case input",
  referenceOutput: "reference",
  toolFixtures: {},
  sourceRunId: runId,
  sourceAttemptId: `attempt-${randomUUID()}`,
});

/**
 * One terminal binding — the terminal state written through the production `finish`
 * seam (the T37-registered G1 fix, never a raw state UPDATE) — optionally reconciled
 * upstream, backdated `days` days.
 */
async function expiredBinding(
  scope: typeof scopeA,
  input: { opikTraceId?: string | null; days?: number } = {},
) {
  const { binding } = await bindingStore.begin(scope, {
    runId: `run-${randomUUID()}`,
    attemptId: bindingAttemptId(),
    traceId: `trace-${randomUUID().replaceAll("-", "")}`,
    capability: "basic",
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  await bindingStore.finish(
    scope,
    binding.runId,
    binding.attemptId,
    "completed",
  );
  if (input.opikTraceId) {
    await bindingStore.reconcile(
      scope,
      binding.runId,
      binding.attemptId,
      input.opikTraceId,
    );
  }
  await database
    .update(aiObservationBindings)
    .set({
      createdAt: sql`now() - make_interval(secs => ${(input.days ?? 8) * 86_400})`,
    })
    .where(eq(aiObservationBindings.id, binding.id));
  return binding;
}

const bindingAttemptId = () => `attempt-${randomUUID()}`;

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

const deletionsFor = (scope: typeof scopeA) =>
  database
    .select()
    .from(aiObservationRetentionDeletions)
    .where(eq(aiObservationRetentionDeletions.scopeKey, scope.key));

/**
 * The trail is append-only (0007), so this suite never deletes audit rows: assertions
 * read back exactly their own target's rows and nothing else's.
 */
const auditRows = (targetId: string) =>
  database.$client<
    {
      id: string;
      actor_user_id: string | null;
      initiator_kind: string;
      target_id: string | null;
      payload: Record<string, unknown>;
    }[]
  >`SELECT id, actor_user_id, initiator_kind, target_id, payload
    FROM audit_events
    WHERE event_type = 'opik.retention_deleted' AND target_id = ${targetId}`;

afterEach(async () => {
  await database
    .delete(aiObservationBindings)
    .where(eq(aiObservationBindings.scopeKey, scopeA.key));
  await database
    .delete(aiObservationBindings)
    .where(eq(aiObservationBindings.scopeKey, scopeB.key));
  // Experiments first (their foreign key pins versions), then datasets: the guards
  // refuse every other route, this suite's own cleanup included, so the cleanup
  // runs through the same channels the tests are about. The dataset flag's cascade
  // takes the versions with it.
  await database.$client.begin(async (tx) => {
    await tx`select set_config('ai_observation.experiment_cleanup', 'on', true)`;
    await tx`select set_config('ai_observation.dataset_cleanup', 'on', true)`;
    await tx`DELETE FROM ai_observation_experiments WHERE scope_key IN (${scopeA.key}, ${scopeB.key})`;
    await tx`DELETE FROM ai_observation_datasets WHERE scope_key IN (${scopeA.key}, ${scopeB.key})`;
  });
  // Return the pooled connection to a known session state.
  await database.$client`RESET ai_observation.experiment_cleanup`;
  await database.$client`RESET ai_observation.dataset_cleanup`;
  await database
    .delete(aiObservationExportJobs)
    .where(eq(aiObservationExportJobs.scopeKey, scopeA.key));
  await database
    .delete(aiObservationExportJobs)
    .where(eq(aiObservationExportJobs.scopeKey, scopeB.key));
  await database
    .delete(aiObservationRetentionDeletions)
    .where(eq(aiObservationRetentionDeletions.scopeKey, scopeA.key));
  await database
    .delete(aiObservationRetentionDeletions)
    .where(eq(aiObservationRetentionDeletions.scopeKey, scopeB.key));
  await database
    .delete(aiObservationRetentionOverrides)
    .where(eq(aiObservationRetentionOverrides.scopeKey, scopeA.key));
  await database
    .delete(aiObservationRetentionOverrides)
    .where(eq(aiObservationRetentionOverrides.scopeKey, scopeB.key));
  // Audit rows stay: the trail is append-only, and every assertion below reads back
  // only its own target's rows.
  await database.delete(workItems).where(eq(workItems.kind, "opik.retention"));
});

afterAll(async () => {
  await fresh.end();
  await database.$client.close();
});

test("the dedicated test database carries the retention schema", async () => {
  const indexes = await database.$client`
    SELECT indexname FROM pg_indexes
    WHERE tablename IN ('ai_observation_retention_deletions', 'ai_observation_retention_overrides')
  `;
  const present = new Set(indexes.map((row) => row.indexname));
  for (const required of [
    "ai_observation_retention_deletions_kind_target_uq",
    "ai_observation_retention_deletions_state_updated_idx",
  ]) {
    if (!present.has(required)) {
      throw new Error(
        `The dedicated Opik test database lacks ${required}. Apply the migrations to the dedicated test database first (TEST_DATABASE_URL=... bun run db:migrate in server/); do not point these tests at the application database and do not record this as a pass.`,
      );
    }
  }
});

test("the expiry boundary: exactly-expired is offered, comfortably-newer and running never (AC1)", async () => {
  const exactly = await expiredBinding(scopeA, { opikTraceId: null, days: 7 });
  const newer = await expiredBinding(scopeA, { opikTraceId: null, days: 6 });

  const { binding: running } = await bindingStore.begin(scopeA, {
    runId: `run-${randomUUID()}`,
    attemptId: bindingAttemptId(),
    traceId: `trace-${randomUUID().replaceAll("-", "")}`,
    capability: "basic",
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  await database
    .update(aiObservationBindings)
    .set({ createdAt: sql`now() - interval '30 days'` })
    .where(eq(aiObservationBindings.id, running.id));

  await workerFor().discover();
  const records = await deletionsFor(scopeA);
  const targets = new Set(records.map((record) => record.targetId));
  expect(targets.has(exactly.id)).toBe(true);
  expect(targets.has(newer.id)).toBe(false);
  expect(targets.has(running.id)).toBe(false);
  expect(records.every((record) => record.kind === "run")).toBe(true);
  // The offer is exactly once: re-discovery of the same expired row is a no-op.
  await workerFor().discover();
  expect(await deletionsFor(scopeA)).toHaveLength(records.length);
});

test("discovery re-offers a purged ticket while the record is non-terminal (the purge precondition)", async () => {
  // The L2 forward pitfall, as the precondition it is: a purge that removes a
  // ticket parked on a pending/failed record must not wedge the target for good
  // — re-discovery rebuilds the ticket from the record that still exists.
  await expiredBinding(scopeA, { opikTraceId: null, days: 8 });
  const worker = workerFor();
  await worker.discover();
  const record = (await deletionsFor(scopeA))[0];
  const ticketFor = () =>
    database
      .select({ key: workItems.key })
      .from(workItems)
      .where(
        and(eq(workItems.kind, "opik.retention"), eq(workItems.key, record.id)),
      );
  expect(await ticketFor()).toHaveLength(1);

  // The reaper's removal, simulated exactly as purge would do it.
  await database
    .delete(workItems)
    .where(
      and(eq(workItems.kind, "opik.retention"), eq(workItems.key, record.id)),
    );
  expect(await ticketFor()).toHaveLength(0);

  await worker.discover();
  expect(await ticketFor()).toHaveLength(1);
});

test("a reconciled run is deleted for real: rows, upstream copy, audit — verified on a fresh connection (AC2/AC4)", async () => {
  const traceId = `01a1405b-f832-70cf-b204-f4dd51387${randomUUID().slice(0, 4)}`;
  const binding = await expiredBinding(scopeA, {
    opikTraceId: traceId,
    days: 8,
  });
  const upstream = fakePort({ rows: [{ id: traceId, status: "COMPLETED" }] });
  const worker = workerFor({ port: upstream.port });

  await worker.sweep();

  const records = await deletionsFor(scopeA);
  expect(records).toHaveLength(1);
  expect(records[0].state).toBe("deleted");
  expect(records[0].deletedAt).toBeInstanceOf(Date);
  expect(records[0].attempts).toBe(1);
  // Real deletion, seen by a connection this process never served from.
  expect(
    await fresh`select count(*)::int as n from ai_observation_bindings where id = ${binding.id}`,
  ).toEqual([{ n: 0 }]);
  // The upstream copy went too, on the locator frozen at discovery.
  expect(upstream.calls.deleteTraces).toEqual([
    { ids: [traceId], project: resolveStorageLocator(scopeA).project },
  ]);
  // The audit row: references and counts, deployment-initiated, no actor.
  const audits = await auditRows(binding.id);
  expect(audits).toHaveLength(1);
  expect(audits[0].initiator_kind).toBe("deployment");
  expect(audits[0].actor_user_id).toBeNull();
  expect(audits[0].target_id).toBe(binding.id);
  expect(audits[0].payload.kind).toBe("run");
  // The ticket is finished, not leased.
  const ticket = await database
    .select()
    .from(workItems)
    .where(eq(workItems.key, records[0].id));
  expect(ticket[0].finishedAt).not.toBeNull();
});

test("a run deletion takes its id-link mapping rows with it — zero residue (G2)", async () => {
  const traceId = `01a1405b-f832-70cf-b204-f4dd51387${randomUUID().slice(0, 4)}`;
  const binding = await expiredBinding(scopeA, {
    opikTraceId: traceId,
    days: 8,
  });

  // The run's governed steps chained to the binding's own W3C trace: exactly the
  // mapping rows the T37 probe found surviving a run deletion (its GAP-CHECK).
  const idLinks = createIdLinkStore(database, { bindings: bindingStore });
  for (const callId of [`call-${randomUUID()}`, `call-${randomUUID()}`]) {
    const verdict = await idLinks.link(scopeA, {
      local: { kind: "tool_step", id: callId },
      upstream: { kind: "span", id: `span-${randomUUID()}` },
      runRef: { runId: binding.runId, attemptId: binding.attemptId },
      observedTraceId: binding.traceId,
    });
    expect(verdict).toEqual({ linked: true, replayed: false });
  }
  // Another run's mapping, same scope, not expiring with this one: the cleanup is
  // the deleted run's own trace, never a scope-wide wipe.
  const other = await expiredBinding(scopeA, { opikTraceId: null, days: 1 });
  const otherVerdict = await idLinks.link(scopeA, {
    local: { kind: "tool_step", id: `call-${randomUUID()}` },
    upstream: { kind: "span", id: `span-${randomUUID()}` },
    runRef: { runId: other.runId, attemptId: other.attemptId },
    observedTraceId: other.traceId,
  });
  expect(otherVerdict).toEqual({ linked: true, replayed: false });

  const upstream = fakePort({ rows: [{ id: traceId, status: "COMPLETED" }] });
  await workerFor({ port: upstream.port }).sweep();

  const records = await deletionsFor(scopeA);
  expect(records).toHaveLength(1);
  expect(records[0].state).toBe("deleted");
  // Zero residue, on a connection this process never served from: the mapping rows
  // of the deleted run are gone with its binding, in the same deletion transaction.
  expect(
    await fresh`select count(*)::int as n from ai_observation_id_links where scope_key = ${scopeA.key}`,
  ).toEqual([{ n: 1 }]);
  // ...and the survivor is the other run's row, verifiably.
  expect(
    await fresh`select run_id from ai_observation_id_links where scope_key = ${scopeA.key}`,
  ).toEqual([{ run_id: other.runId }]);
});

test("zero residue on the query surfaces after a sweep (AC3)", async () => {
  const traceId = `01a1405b-f832-70cf-b204-f4dd51387${randomUUID().slice(0, 4)}`;
  const binding = await expiredBinding(scopeA, {
    opikTraceId: traceId,
    days: 8,
  });
  // The expiring dataset stays unpinned; a second, fresh dataset is what the
  // expiring experiment pins, so each deletion is independently runnable.
  const { dataset, version } = await datasetStore.saveVersion(scopeA, {
    datasetName: `t35-ds-${randomUUID()}`,
    cases: [oneCase(binding.runId)],
  });
  await database
    .update(aiObservationDatasets)
    .set({
      createdAt: sql`now() - interval '40 days'`,
      opikDatasetId: `ds-${randomUUID()}`,
      syncState: "synced",
    })
    .where(eq(aiObservationDatasets.id, dataset.id));
  const pinned = await datasetStore.saveVersion(scopeA, {
    datasetName: `t35-pin-${randomUUID()}`,
    cases: [oneCase(binding.runId)],
  });
  const experimentId = randomUUID();
  await database.insert(aiObservationExperiments).values({
    id: experimentId,
    scopeKey: scopeA.key,
    actorId: scopeA.actorId,
    botId: scopeA.botId,
    name: `t35-exp-${randomUUID()}`,
    datasetVersionId: pinned.version.id,
    datasetContentHash: pinned.version.contentHash,
    config: {},
    state: "draft",
    createdAt: sql`now() - interval '40 days'`,
  });
  const exportJob = await exportStore.enqueue(scopeA, 10);
  await database
    .update(aiObservationExportJobs)
    .set({
      state: "completed",
      artifact: [],
      rowCount: 0,
      settledAt: sql`now() - interval '40 days'`,
    })
    .where(eq(aiObservationExportJobs.id, exportJob.id));

  const upstream = fakePort({ rows: [{ id: traceId, status: "COMPLETED" }] });
  await workerFor({ port: upstream.port, concurrency: 8 }).sweep();

  // Every query surface this baseline serves answers empty or not-found.
  const runs = createRunsQueryService({
    bindings: bindingStore,
    config: () => enabledConfig,
    port: upstream.port,
    cacheTtlMs: 0,
  });
  await expect(runs.detail(scopeA, binding.runId)).rejects.toMatchObject({
    code: "RUN_NOT_FOUND",
  });
  expect((await runs.list(scopeA, {})).runs).toEqual([]);
  expect(await datasetStore.getVersion(scopeA, version.id)).toBeNull();
  expect(await datasetStore.listVersions(scopeA, dataset.id)).toEqual([]);
  expect(await exportStore.get(scopeA, exportJob.id)).toBeNull();
  expect(
    await fresh`select count(*)::int as n from ai_observation_experiments where id = ${experimentId}`,
  ).toEqual([{ n: 0 }]);
});

test("upstream failure parks in failed with the row intact, and a retry completes honestly (AC6)", async () => {
  const traceId = `01a1405b-f832-70cf-b204-f4dd51387${randomUUID().slice(0, 4)}`;
  const binding = await expiredBinding(scopeA, {
    opikTraceId: traceId,
    days: 8,
  });
  const upstream = fakePort({ failFirstTraceDelete: true });
  const worker = workerFor({ port: upstream.port });

  await worker.sweep();
  let records = await deletionsFor(scopeA);
  expect(records[0].state).toBe("failed");
  expect(records[0].lastError).toBe("OPIK_TIMEOUT");
  expect(records[0].attempts).toBe(1);
  // No fake success: the local row survives and no audit row was written.
  expect(
    await fresh`select count(*)::int as n from ai_observation_bindings where id = ${binding.id}`,
  ).toEqual([{ n: 1 }]);
  expect(await auditRows(binding.id)).toEqual([]);

  // The locator is retained on the record; the retry needs nothing else.
  await worker.sweep();
  records = await deletionsFor(scopeA);
  expect(records[0].state).toBe("deleted");
  expect(records[0].lastError).toBeNull();
  expect(records[0].attempts).toBe(2);
  expect(upstream.calls.deleteTraces).toHaveLength(2);
  expect(await auditRows(binding.id)).toHaveLength(1);
});

test("a missing capability fails upstream-carrying records without deleting them; purely local ones proceed (AC6)", async () => {
  const reconciled = await expiredBinding(scopeA, {
    opikTraceId: "trace-gone",
    days: 8,
  });
  const unreconciled = await expiredBinding(scopeA, {
    opikTraceId: null,
    days: 8,
  });

  await workerFor({ port: null }).sweep();

  const byTarget = new Map(
    (await deletionsFor(scopeA)).map((record) => [record.targetId, record]),
  );
  expect(byTarget.get(reconciled.id)?.state).toBe("failed");
  expect(byTarget.get(reconciled.id)?.lastError).toBe("CAPABILITY_MISSING");
  expect(
    await fresh`select count(*)::int as n from ai_observation_bindings where id = ${reconciled.id}`,
  ).toEqual([{ n: 1 }]);
  expect(byTarget.get(unreconciled.id)?.state).toBe("deleted");
  expect(
    await fresh`select count(*)::int as n from ai_observation_bindings where id = ${unreconciled.id}`,
  ).toEqual([{ n: 0 }]);
});

test("dataset deletion goes through the sanctioned channel: versions cascade, the guard still refuses everyone else (AC2)", async () => {
  const { dataset, version } = await datasetStore.saveVersion(scopeA, {
    datasetName: `t35-ds-${randomUUID()}`,
    cases: [oneCase(`run-${randomUUID()}`)],
  });
  const opikDatasetId = `ds-${randomUUID()}`;
  await database
    .update(aiObservationDatasets)
    .set({
      createdAt: sql`now() - interval '40 days'`,
      opikDatasetId,
      syncState: "synced",
    })
    .where(eq(aiObservationDatasets.id, dataset.id));

  // A second, live dataset whose direct version delete must stay refused: the
  // sweep cannot have weakened 0124's guard.
  const live = await datasetStore.saveVersion(scopeA, {
    datasetName: `t35-live-${randomUUID()}`,
    cases: [oneCase(`run-${randomUUID()}`)],
  });

  const upstream = fakePort({});
  await workerFor({ port: upstream.port }).sweep();

  expect(upstream.calls.deleteDatasets).toEqual([opikDatasetId]);
  expect(
    await fresh`select count(*)::int as n from ai_observation_datasets where id = ${dataset.id}`,
  ).toEqual([{ n: 0 }]);
  expect(
    await fresh`select count(*)::int as n from ai_observation_dataset_versions where dataset_id = ${dataset.id}`,
  ).toEqual([{ n: 0 }]);
  expect(
    (await deletionsFor(scopeA)).find((r) => r.kind === "dataset")?.state,
  ).toBe("deleted");

  // The database still refuses a direct version delete and a flagless subject
  // delete — restrict_violation, the 0124 channel is the only way through.
  const refusedVersion = await rejectionOf(() =>
    database
      .delete(aiObservationDatasetVersions)
      .where(eq(aiObservationDatasetVersions.id, live.version.id)),
  );
  expect(refusedVersion.code).toBe("23001");
  const refusedSubject = await rejectionOf(() =>
    database
      .delete(aiObservationDatasets)
      .where(eq(aiObservationDatasets.id, live.dataset.id)),
  );
  expect(refusedSubject.code).toBe("23001");
  void version;
});

test("experiment deletion uses the 0126 experiment_cleanup channel; a live dataset is left alone (AC2)", async () => {
  const { dataset, version } = await datasetStore.saveVersion(scopeA, {
    datasetName: `t35-ds-${randomUUID()}`,
    cases: [oneCase(`run-${randomUUID()}`)],
  });
  const experimentId = randomUUID();
  await database.insert(aiObservationExperiments).values({
    id: experimentId,
    scopeKey: scopeA.key,
    actorId: scopeA.actorId,
    botId: scopeA.botId,
    name: `t35-exp-${randomUUID()}`,
    datasetVersionId: version.id,
    datasetContentHash: version.contentHash,
    config: {},
    state: "draft",
    createdAt: sql`now() - interval '40 days'`,
  });

  // Experiments are purely local in this baseline: no port, no upstream phase.
  await workerFor().sweep();

  expect(
    await fresh`select count(*)::int as n from ai_observation_experiments where id = ${experimentId}`,
  ).toEqual([{ n: 0 }]);
  expect(
    (await deletionsFor(scopeA)).find((r) => r.kind === "experiment")?.state,
  ).toBe("deleted");
  // The dataset the experiment pinned is not itself expired, so it stands.
  expect(
    await fresh`select count(*)::int as n from ai_observation_datasets where id = ${dataset.id}`,
  ).toEqual([{ n: 1 }]);
  expect(
    await fresh`select count(*)::int as n from ai_observation_dataset_versions where id = ${version.id}`,
  ).toEqual([{ n: 1 }]);

  // A flagless direct delete of an experiment stays refused: the channel 0126
  // shipped for this ticket is the only way through.
  const { version: otherVersion } = await datasetStore.saveVersion(scopeA, {
    datasetName: `t35-guard-${randomUUID()}`,
    cases: [oneCase(`run-${randomUUID()}`)],
  });
  const guardExperiment = randomUUID();
  await database.insert(aiObservationExperiments).values({
    id: guardExperiment,
    scopeKey: scopeA.key,
    actorId: scopeA.actorId,
    botId: scopeA.botId,
    name: `t35-guard-exp-${randomUUID()}`,
    datasetVersionId: otherVersion.id,
    datasetContentHash: otherVersion.contentHash,
    config: {},
    state: "draft",
  });
  const refused = await rejectionOf(() =>
    database
      .delete(aiObservationExperiments)
      .where(eq(aiObservationExperiments.id, guardExperiment)),
  );
  expect(refused.code).toBe("23001");
});

test("a dataset pinned by a live experiment is refused by the foreign key, not silently deleted (AC2)", async () => {
  const { dataset, version } = await datasetStore.saveVersion(scopeA, {
    datasetName: `t35-pin-${randomUUID()}`,
    cases: [oneCase(`run-${randomUUID()}`)],
  });
  await database
    .update(aiObservationDatasets)
    .set({ createdAt: sql`now() - interval '40 days'` })
    .where(eq(aiObservationDatasets.id, dataset.id));
  await database.insert(aiObservationExperiments).values({
    id: randomUUID(),
    scopeKey: scopeA.key,
    actorId: scopeA.actorId,
    botId: scopeA.botId,
    name: `t35-pin-exp-${randomUUID()}`,
    datasetVersionId: version.id,
    datasetContentHash: version.contentHash,
    config: {},
    state: "draft",
  });

  // Force the record past discovery (the pin normally hides the dataset), so the
  // foreign key's refusal is proven as the backstop it is.
  const recordId = randomUUID();
  await database.insert(aiObservationRetentionDeletions).values({
    id: recordId,
    scopeKey: scopeA.key,
    actorId: scopeA.actorId,
    botId: scopeA.botId,
    kind: "dataset",
    targetId: dataset.id,
    retentionDays: 30,
    state: "pending",
  });
  await database
    .insert(workItems)
    .values({ kind: "opik.retention", key: recordId });

  await workerFor().sweep();

  const record = (await deletionsFor(scopeA)).find((r) => r.id === recordId);
  expect(record?.state).toBe("failed");
  expect(record?.lastError).toBe("RETENTION_TARGET_PINNED");
  expect(
    await fresh`select count(*)::int as n from ai_observation_datasets where id = ${dataset.id}`,
  ).toEqual([{ n: 1 }]);
});

test("an upstream-complete deletion is never downgraded back to failed by a local failure (OCR h7)", async () => {
  const opikDatasetId = `opik-ds-${randomUUID()}`;
  const { dataset, version } = await datasetStore.saveVersion(scopeA, {
    datasetName: `t35-h7-${randomUUID()}`,
    cases: [oneCase(`run-${randomUUID()}`)],
  });
  await datasetStore.markSynced(scopeA, dataset.id, opikDatasetId);
  await database
    .update(aiObservationDatasets)
    .set({ createdAt: sql`now() - interval '40 days'` })
    .where(eq(aiObservationDatasets.id, dataset.id));
  // A live experiment pins the local half: the version's FK refuses the dataset
  // delete with 23503, exactly the RETENTION_TARGET_PINNED path.
  await database.insert(aiObservationExperiments).values({
    id: randomUUID(),
    scopeKey: scopeA.key,
    actorId: scopeA.actorId,
    botId: scopeA.botId,
    name: `t35-h7-pin-${randomUUID()}`,
    datasetVersionId: version.id,
    datasetContentHash: version.contentHash,
    config: {},
    state: "draft",
  });

  // Force the record past discovery (the pin hides the dataset there), with the
  // upstream facts frozen the way the dataset discovery would have written them.
  const recordId = randomUUID();
  await database.insert(aiObservationRetentionDeletions).values({
    id: recordId,
    scopeKey: scopeA.key,
    actorId: scopeA.actorId,
    botId: scopeA.botId,
    kind: "dataset",
    targetId: dataset.id,
    upstreamKind: "dataset",
    upstreamId: opikDatasetId,
    retentionDays: 30,
    state: "pending",
  });
  await database
    .insert(workItems)
    .values({ kind: "opik.retention", key: recordId })
    .onConflictDoNothing();

  const upstream = fakePort({});
  await workerFor({ port: upstream.port }).sweep();

  // The upstream half ran and succeeded; the local half hit the pin.
  expect(upstream.calls.deleteDatasets).toEqual([opikDatasetId]);
  const afterFirst = (await deletionsFor(scopeA)).find((r) => r.id === recordId);
  // THE FIX under test: the completed upstream fact must not be erased — the record
  // carries "upstream deleted, local pending", never a plain "failed" that would
  // order the retry to delete upstream again (an operation with no verified
  // already-deleted semantics).
  expect(afterFirst?.state).toBe("upstream_done");
  expect(afterFirst?.lastError).toBeNull();

  // The retry pass (the re-offer the non-terminal record keeps earning) must NOT
  // replay the upstream delete — it goes straight to the local half. The queue
  // released the ticket with the retry backoff (OCR m163), so the test rewinds
  // runAt the way the wait itself would.
  await database
    .update(workItems)
    .set({ runAt: sql`now()` })
    .where(eq(workItems.key, recordId));
  await database
    .insert(workItems)
    .values({ kind: "opik.retention", key: recordId })
    .onConflictDoNothing();
  await workerFor({ port: upstream.port }).sweep();
  expect(upstream.calls.deleteDatasets).toEqual([opikDatasetId]);
  expect(
    (await deletionsFor(scopeA)).find((r) => r.id === recordId)?.state,
  ).toBe("upstream_done");

  // Pin lifted through the only sanctioned channel (0126's cleanup flag — the same
  // channel the retention worker itself uses; a flagless DELETE is refused): the
  // very same record finishes through the local half alone.
  await database.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('ai_observation.experiment_cleanup', 'on', true)`,
    );
    await tx.execute(
      sql`delete from ai_observation_experiments where dataset_version_id = ${version.id}`,
    );
  });
  await database
    .update(workItems)
    .set({ runAt: sql`now()` })
    .where(eq(workItems.key, recordId));
  await database
    .insert(workItems)
    .values({ kind: "opik.retention", key: recordId })
    .onConflictDoNothing();
  await database
    .insert(workItems)
    .values({ kind: "opik.retention", key: recordId })
    .onConflictDoNothing();
  await workerFor({ port: upstream.port }).sweep();
  expect(upstream.calls.deleteDatasets).toHaveLength(1);
  const final = (await deletionsFor(scopeA)).find((r) => r.id === recordId);
  expect(final?.state).toBe("deleted");
  expect(
    await fresh`select count(*)::int as n from ai_observation_datasets where id = ${dataset.id}`,
  ).toEqual([{ n: 0 }]);
});

test("expired export artifacts are deleted for real, and a canary never reaches the audit or the records (AC2/AC4)", async () => {
  const canary = "sk-live-abcdefghijklmnopqrst";
  const old = await exportStore.enqueue(scopeA, 10);
  await database
    .update(aiObservationExportJobs)
    .set({
      state: "completed",
      artifact: [
        {
          opikTraceId: "trace-1",
          state: "completed",
          createdAt: "2026-10-01T00:00:00.000Z",
          durationMs: 12,
          usage: { source: "unavailable" },
          capability: "unavailable",
          metadata: { model: canary },
        },
      ],
      rowCount: 1,
      settledAt: sql`now() - interval '40 days'`,
    })
    .where(eq(aiObservationExportJobs.id, old.id));
  // Young and unfinished jobs are never retention subjects.
  const young = await exportStore.enqueue(scopeA, 10);
  await database
    .update(aiObservationExportJobs)
    .set({
      state: "completed",
      artifact: [],
      rowCount: 0,
      settledAt: sql`now() - interval '1 day'`,
    })
    .where(eq(aiObservationExportJobs.id, young.id));
  const queued = await exportStore.enqueue(scopeA, 10);
  await database
    .update(aiObservationExportJobs)
    .set({ createdAt: sql`now() - interval '40 days'` })
    .where(eq(aiObservationExportJobs.id, queued.id));

  await workerFor().sweep();

  expect(
    await fresh`select count(*)::int as n from ai_observation_export_jobs where id = ${old.id}`,
  ).toEqual([{ n: 0 }]);
  expect(
    await fresh`select count(*)::int as n from ai_observation_export_jobs where id = ${young.id}`,
  ).toEqual([{ n: 1 }]);
  expect(
    await fresh`select count(*)::int as n from ai_observation_export_jobs where id = ${queued.id}`,
  ).toEqual([{ n: 1 }]);
  expect((await deletionsFor(scopeA)).map((r) => r.kind)).toEqual(["export"]);
  // The canary is nowhere the trail could read it from.
  const audits = await auditRows(old.id);
  expect(audits).toHaveLength(1);
  expect(JSON.stringify(audits[0].payload)).not.toContain(canary);
  expect(JSON.stringify(await deletionsFor(scopeA))).not.toContain(canary);
});

test("the scope override answers before the global default, per category (AC1)", async () => {
  const held = await expiredBinding(scopeA, { opikTraceId: null, days: 10 });
  await retentionStore.setOverride(scopeA, { runs: 60 });
  await workerFor().discover();
  expect(
    (await deletionsFor(scopeA)).some((record) => record.targetId === held.id),
  ).toBe(false);

  const datasetBackdated = await datasetStore.saveVersion(scopeA, {
    datasetName: `t35-ovr-${randomUUID()}`,
    cases: [oneCase(`run-${randomUUID()}`)],
  });
  await database
    .update(aiObservationDatasets)
    .set({ createdAt: sql`now() - interval '10 days'` })
    .where(eq(aiObservationDatasets.id, datasetBackdated.dataset.id));
  await retentionStore.setOverride(scopeA, { runs: 60, datasets: 1 });
  await workerFor().discover();
  const records = await deletionsFor(scopeA);
  expect(records.some((record) => record.targetId === held.id)).toBe(false);
  expect(
    records.some((record) => record.targetId === datasetBackdated.dataset.id),
  ).toBe(true);
});

test("the lease keeps a second replica off a deletion in flight (AC5)", async () => {
  const traceId = `01a1405b-f832-70cf-b204-f4dd51387${randomUUID().slice(0, 4)}`;
  const binding = await expiredBinding(scopeA, {
    opikTraceId: traceId,
    days: 8,
  });
  const upstream = fakePort({ gatedDelete: true });
  const workerOne = workerFor({
    port: upstream.port,
    owner: "t35-replica-one",
  });
  const workerTwo = workerFor({
    port: upstream.port,
    owner: "t35-replica-two",
  });

  const pass = workerOne.sweep();
  await until(
    () => upstream.calls.deleteTraces.length === 1,
    "the first replica holds the deletion",
  );

  // The second replica sweeps while the first is parked: nothing to claim, no
  // second upstream call, and the record's attempt count stays untouched.
  await workerTwo.sweep();
  expect(upstream.calls.deleteTraces).toHaveLength(1);

  upstream.release();
  await pass;
  expect(
    await fresh`select count(*)::int as n from ai_observation_bindings where id = ${binding.id}`,
  ).toEqual([{ n: 0 }]);
  const record = (await deletionsFor(scopeA))[0];
  expect(record.state).toBe("deleted");
  expect(record.attempts).toBe(1);

  // A second settle of the same record is refused: first terminal write wins.
  expect(await retentionStore.markUpstreamDone(record.id)).toBeNull();
});

test("governance counts answer per kind and state (AC4)", async () => {
  const done = await expiredBinding(scopeA, { opikTraceId: null, days: 8 });
  const stuck = await expiredBinding(scopeA, {
    opikTraceId: "trace-stuck",
    days: 8,
  });
  await workerFor({ port: null }).sweep();

  const counts = await retentionStore.deletionCounts();
  expect(counts.run.deleted).toBe(1);
  expect(counts.run.failed).toBe(1);
  expect(counts.dataset.pending).toBe(0);
  const records = await deletionsFor(scopeA);
  expect(records.find((r) => r.targetId === done.id)?.state).toBe("deleted");
  expect(records.find((r) => r.targetId === stuck.id)?.state).toBe("failed");
});

test("export enqueue is capped: over the limit is an explicit refusal, never a silent backlog (T34 hardening)", async () => {
  const capped = await Promise.resolve(createObservationExportStore(database));
  await capped.enqueue(scopeA, 10, { maxActive: 2 });
  await capped.enqueue(scopeA, 10, { maxActive: 2 });
  const refused = await capped.enqueue(scopeA, 10, { maxActive: 2 }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(ExportError);
  expect((refused as ExportError).code).toBe("EXPORT_ENQUEUE_LIMIT");
  expect((refused as ExportError).status).toBe(429);

  // Terminal jobs leave the count: the cap bounds work, not history.
  await capped.cancelForActor(scopeA.actorId);
  const after = await capped.enqueue(scopeA, 10, { maxActive: 2 });
  expect(after.state).toBe("queued");

  // Another actor's backlog is not this actor's refusal.
  const other = await capped.enqueue(scopeB, 10, { maxActive: 2 });
  expect(other.state).toBe("queued");
});

test("the deletion precondition: reader visibility revoked, the scope's affected exports stopped, read caches invalidated (M1)", async () => {
  const traceId = `01a1405b-f832-70cf-b204-f4dd51387${randomUUID().slice(0, 4)}`;
  const binding = await expiredBinding(scopeA, {
    opikTraceId: traceId,
    days: 8,
  });
  // The scope's own in-flight export, and another scope's that must not be touched.
  const own = await exportStore.enqueue(scopeA, 10);
  const untouched = await exportStore.enqueue(scopeB, 10);
  const invalidated: { scopeKey: string; kind: string }[] = [];

  const upstream = fakePort({
    rows: [{ id: traceId, status: "COMPLETED" }],
    failFirstTraceDelete: true,
  });
  await workerFor({
    port: upstream.port,
    invalidateReads: (input) => {
      invalidated.push(input);
    },
  }).sweep();

  // Parked in failed — the deletion is in flight, which is exactly the state
  // the precondition sequence exists for.
  expect((await deletionsFor(scopeA))[0].state).toBe("failed");

  // (a) Visibility revoked: the reader surface already answers not-found for the
  // target under deletion, before any row has actually gone.
  const runs = createRunsQueryService({
    bindings: bindingStore,
    config: () => enabledConfig,
    port: upstream.port,
  });
  await expect(runs.detail(scopeA, binding.runId)).rejects.toMatchObject({
    code: "RUN_NOT_FOUND",
  });

  // (b) The affected work is stopped: this scope's queued export is cancelled,
  // and another scope's queued export is untouched.
  expect((await exportStore.get(scopeA, own.id))?.state).toBe("cancelled");
  expect((await exportStore.get(scopeB, untouched.id))?.state).toBe("queued");

  // (c) The cache invalidation seam fired for the scope being deleted, only it.
  expect(invalidated).toContainEqual({ scopeKey: scopeA.key, kind: "run" });
  expect(invalidated.every((input) => input.scopeKey !== scopeB.key)).toBe(
    true,
  );

  // The honest retry still completes, and the reader stays not-found — now
  // because the row is truly gone.
  await workerFor({ port: upstream.port }).sweep();
  expect((await deletionsFor(scopeA))[0].state).toBe("deleted");
  await expect(runs.detail(scopeA, binding.runId)).rejects.toMatchObject({
    code: "RUN_NOT_FOUND",
  });
  expect(await auditRows(binding.id)).toHaveLength(1);
});

test("a deletion in flight hides its dataset and experiment from the readers (M1)", async () => {
  // A dataset whose upstream delete fails: parked in failed, the park window the
  // precondition sequence must cover. A fresh sibling stays fully readable.
  const binding = await expiredBinding(scopeA, { opikTraceId: null, days: 8 });
  const expiring = await datasetStore.saveVersion(scopeA, {
    datasetName: `t35-hide-${randomUUID()}`,
    cases: [oneCase(binding.runId)],
  });
  const fresh = await datasetStore.saveVersion(scopeA, {
    datasetName: `t35-keep-${randomUUID()}`,
    cases: [oneCase(binding.runId)],
  });
  for (const dataset of [expiring.dataset, fresh.dataset]) {
    await database
      .update(aiObservationDatasets)
      .set({
        opikDatasetId: `ds-${randomUUID()}`,
        syncState: "synced",
      })
      .where(eq(aiObservationDatasets.id, dataset.id));
  }
  await database
    .update(aiObservationDatasets)
    .set({ createdAt: sql`now() - interval '40 days'` })
    .where(eq(aiObservationDatasets.id, expiring.dataset.id));

  const upstream = fakePort({ failFirstDatasetDelete: true });
  await workerFor({ port: upstream.port, concurrency: 8 }).sweep();
  expect(
    (await deletionsFor(scopeA)).find((r) => r.targetId === expiring.dataset.id)
      ?.state,
  ).toBe("failed");

  // The readers answer not-found and empty for the target under deletion…
  expect(await datasetStore.getDataset(scopeA, expiring.dataset.id)).toBeNull();
  expect(await datasetStore.getVersion(scopeA, expiring.version.id)).toBeNull();
  expect(await datasetStore.listVersions(scopeA, expiring.dataset.id)).toEqual(
    [],
  );
  // …and stay whole for the sibling that is not.
  expect(
    await datasetStore.getDataset(scopeA, fresh.dataset.id),
  ).not.toBeNull();
  expect(
    await datasetStore.listVersions(scopeA, fresh.dataset.id),
  ).toHaveLength(1);

  // Experiments delete locally in one pass, so an in-flight experiment is staged
  // the way discovery always stages one: the deletion record itself. The reader
  // must respect it — the same hide-first rule, proven on the record.
  const pinned = await datasetStore.saveVersion(scopeA, {
    datasetName: `t35-ehide-${randomUUID()}`,
    cases: [oneCase(binding.runId)],
  });
  const hiding = randomUUID();
  const kept = randomUUID();
  for (const id of [hiding, kept]) {
    await database.insert(aiObservationExperiments).values({
      id,
      scopeKey: scopeA.key,
      actorId: scopeA.actorId,
      botId: scopeA.botId,
      name: `t35-ehide-${id.slice(0, 8)}`,
      datasetVersionId: pinned.version.id,
      datasetContentHash: pinned.version.contentHash,
      config: {},
      state: "draft",
      createdAt: sql`now() - interval '40 days'`,
    });
  }
  await database.insert(aiObservationRetentionDeletions).values({
    id: randomUUID(),
    scopeKey: scopeA.key,
    actorId: scopeA.actorId,
    botId: scopeA.botId,
    kind: "experiment",
    targetId: hiding,
    retentionDays: 30,
    state: "pending",
  });
  const experimentStore = createObservationExperimentStore(database);
  expect(await experimentStore.getExperiment(scopeA, hiding)).toBeNull();
  expect(await experimentStore.getExperiment(scopeA, kept)).not.toBeNull();
});
