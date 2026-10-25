/**
 * F7B (R3-05) live-instance evidence — the materialization crash window's orphan is
 * cleaned by its DERIVED identity at retention time.
 *
 * Drives the production seams end to end against a real Opik instance and a real
 * PostgreSQL database:
 *
 *  1. begin + finish a run binding whose opik_trace_id stays NULL;
 *  2. reproduce the crash window exactly as the materializer would leave it — the
 *     derived trace is created upstream and the derived root span is written, and the
 *     reconcile that would have recorded the mapping never runs (no later fact retries);
 *  3. observe the orphan is real (trace-detail 200, span list non-empty) while the
 *     binding still records null;
 *  4. run the real retention worker (discovery + sweep) with the verified port;
 *  5. assert the record completed only through the observed absence of the derived
 *     trace AND its spans, and the local binding row is gone.
 *
 * Run from server/:
 *   TEST_DATABASE_URL=postgres://opik4:opik4@127.0.0.1:55433/openbot_f7b \
 *     bun scripts/f7b/real-orphan-cleanup.ts [http://127.0.0.1:5174/api]
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { SafeText } from "../../../shared/ai-observability";
import {
  createRunBindingStore,
  observerBindingRefForTests,
} from "../../src/ai-observability/bindings";
import type { OpikConfig } from "../../src/ai-observability/config";
import { runUpstreamIdentity } from "../../src/ai-observability/opik-http";
import type { OpikOtlpSpan } from "../../src/ai-observability/opik-port";
import {
  createObservationRetentionWorker,
  resolveRetentionDays,
} from "../../src/ai-observability/retention";
import {
  resolveObservationScope,
  resolveStorageLocator,
} from "../../src/ai-observability/scope";
import { loadVerifiedOpikPort } from "../../src/ai-observability/wiring";
import { createAuditStore } from "../../src/audit";
import { createDatabase } from "../../src/db/client";
import { workItems } from "../../src/db/schema";
import { aiObservationBindings } from "../../src/db/schema/ai-observability-bindings";
import { aiObservationRetentionDeletions } from "../../src/db/schema/ai-observability-retention";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("TEST_DATABASE_URL is required (a dedicated database).");
  process.exit(2);
}
const baseUrl = (process.argv[2] ?? "http://127.0.0.1:5174/api").replace(
  /\/$/,
  "",
);

const database = createDatabase(databaseUrl, { max: 4 });
const bindings = createRunBindingStore(database);

function fail(step: string, detail: unknown): never {
  console.error(JSON.stringify({ step, ok: false, detail }, null, 1));
  process.exit(1);
  throw new Error(step);
}

const getJson = async (path: string) => {
  const response = await fetch(`${baseUrl}${path}`);
  return {
    status: response.status,
    body: (await response.json().catch(() => null)) as {
      total?: number;
    } | null,
  };
};

const port = await loadVerifiedOpikPort(baseUrl, 5_000);
if (port === null) fail("verified-port", "loadVerifiedOpikPort answered null");

const scope = resolveObservationScope({
  actorId: `f7b-actor-${randomUUID()}`,
  botId: `f7b-bot-${randomUUID().slice(0, 8)}`,
  ownership: "owner",
  epoch: 1,
});
const locator = resolveStorageLocator(scope);
/** The run's W3C trace id — the chain the materializer derives every id from. */
const chain = randomBytes(16).toString("hex");
const identity = runUpstreamIdentity(chain);
const runId = `run-${randomUUID()}`;
const attemptId = `attempt-${randomUUID()}`;
const rootName: SafeText = { state: "projected", text: "run" };

// 1. The binding, exactly as the observer gate begins it: opik_trace_id NULL.
const { binding } = await bindings.begin(scope, {
  runId,
  attemptId,
  traceId: chain,
  capability: "detailed",
  expiresAt: new Date(Date.now() + 3_600_000),
});
await bindings.finish(scope, runId, attemptId, "completed");

// 2. The crash window: create + root succeed, the reconcile never lands.
const ref = observerBindingRefForTests(scope, { runId, attemptId });
const startedAt = new Date();
const created = await port.createTrace(scope, {
  traceId: identity.opikTraceId,
  name: rootName,
  startTime: startedAt,
  binding: ref,
});
if (created.outcome !== "ok") fail("createTrace", created);
const rootSpan: OpikOtlpSpan = {
  traceId: chain,
  spanId: identity.rootSpanId,
  name: rootName,
  startTimeUnixNano: String(BigInt(startedAt.getTime()) * 1_000_000n),
  opik: { traceId: identity.opikTraceId, spanId: identity.rootOpikSpanId },
};
const rooted = await port.writeSpans(scope, {
  spans: [rootSpan],
  binding: { ...ref, opikTraceId: identity.opikTraceId },
});
if (rooted.outcome !== "ok") fail("writeSpans", rooted);

// 3. The orphan is real while the binding still records null.
const projectResolved = await port.retrieveProject(scope);
if (projectResolved.outcome !== "ok") fail("retrieveProject", projectResolved);
if (projectResolved.value === null)
  fail("retrieveProject", "project not found after createTrace");
const projectId = projectResolved.value.id;
const beforeTrace = await getJson(
  `/v1/private/traces/${identity.opikTraceId}?project_id=${projectId}`,
);
const beforeSpans = await getJson(
  `/v1/private/spans?project_id=${projectId}&trace_id=${identity.opikTraceId}&size=10`,
);
const recorded = await database
  .select({ opikTraceId: aiObservationBindings.opikTraceId })
  .from(aiObservationBindings)
  .where(eq(aiObservationBindings.id, binding.id));
if (recorded[0]?.opikTraceId !== null)
  fail("binding-null", recorded[0]?.opikTraceId ?? "missing row");
if (beforeTrace.status !== 200)
  fail("orphan-trace-present", beforeTrace.status);
const beforeSpanTotal = beforeSpans.body?.total ?? 0;
if (beforeSpanTotal < 1) fail("orphan-spans-present", beforeSpanTotal);

// The lease lapses and the retention window passes: backdate past the 7-day runs TTL.
await database
  .update(aiObservationBindings)
  .set({ createdAt: sql`now() - interval '8 days'` })
  .where(eq(aiObservationBindings.id, binding.id));

// 4. The real retention worker over the verified port.
const config: OpikConfig = {
  enabled: true,
  baseUrl,
  apiKey: null,
  workspaceName: "default",
  port: 5174,
  otlpHttpPort: 5418,
  otlpGrpcPort: 5417,
};
const worker = createObservationRetentionWorker({
  database,
  config: () => config,
  port,
  retention: () => resolveRetentionDays({}),
  audit: createAuditStore(database),
  owner: `f7b-owner-${randomUUID()}`,
  concurrency: 8,
});
await worker.sweep();

// 5. Completion rode the observed absence of the trace AND its spans.
const records = await database
  .select()
  .from(aiObservationRetentionDeletions)
  .where(
    and(
      eq(aiObservationRetentionDeletions.kind, "run"),
      eq(aiObservationRetentionDeletions.targetId, binding.id),
    ),
  );
const record = records[0];
if (record?.state !== "deleted") fail("record-state", record);
if (
  record.upstreamKind !== "trace" ||
  record.upstreamId !== identity.opikTraceId
)
  fail("record-derived-reference", {
    upstreamKind: record.upstreamKind,
    upstreamId: record.upstreamId,
  });
const surviving = await database
  .select({ id: aiObservationBindings.id })
  .from(aiObservationBindings)
  .where(eq(aiObservationBindings.id, binding.id));
if (surviving.length !== 0) fail("binding-deleted", surviving);
const afterTrace = await getJson(
  `/v1/private/traces/${identity.opikTraceId}?project_id=${projectId}`,
);
const afterSpans = await getJson(
  `/v1/private/spans?project_id=${projectId}&trace_id=${identity.opikTraceId}&size=10`,
);
if (afterTrace.status !== 404) fail("trace-absence", afterTrace.status);
const afterSpanTotal = afterSpans.body?.total ?? 0;
if (afterSpanTotal !== 0) fail("span-absence", afterSpanTotal);

// Leave the shared test database as this run found it: the evidence is this log and
// the JSON below, and a stray run-deletion row would skew the suite's global
// governance counts on its next run.
await database
  .delete(aiObservationRetentionDeletions)
  .where(eq(aiObservationRetentionDeletions.id, record.id));
await database
  .delete(workItems)
  .where(
    and(eq(workItems.kind, "opik.retention"), eq(workItems.key, record.id)),
  );

console.log(
  JSON.stringify(
    {
      ok: true,
      chain,
      derivedTraceId: identity.opikTraceId,
      locatorProject: locator.project,
      bindingRecordedNullBefore: true,
      orphanBefore: {
        traceDetailStatus: beforeTrace.status,
        spanTotal: beforeSpanTotal,
      },
      record: {
        state: record.state,
        upstreamKind: record.upstreamKind,
        upstreamId: record.upstreamId,
        attempts: record.attempts,
      },
      after: {
        bindingRows: surviving.length,
        traceDetailStatus: afterTrace.status,
        spanTotal: afterSpanTotal,
      },
    },
    null,
    1,
  ),
);
await database.$client.close();
