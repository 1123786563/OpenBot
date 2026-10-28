/**
 * F6B — real-instance evidence driver (F5E1-F3 / FREV-07 / #13 #14 #17 #41).
 *
 * Drives the PRODUCTION materialization path — observer binding gate over the real
 * binding store, real port adapter, model/tool recorders — against a real,
 * self-hosted Opik instance and the dedicated test database, then reads the run
 * back through the production runs query service. No mock at any seam the fix
 * touched: the only inputs are the instance URL and the database URL.
 *
 * Commands (one invocation runs the whole ladder):
 *   bun scripts/f6b/real-materialize-readback.ts --opik=URL --database=URL --evidence=DIR
 *
 * The ladder, each step a recorded fact:
 *   1. materialize — a run's chain establishes its binding AND its upstream
 *      trace/root span/reconciled mapping (F5E1-F3's first half);
 *   2. read back   — run list names the run, detail is present, steps carry the
 *      run root's parentage (F5E1-F3's second half);
 *   3. delete      — deleteTraces completes only on observed absence, trace AND
 *      span rows (FREV-07's normal path);
 *   4. project 404 — the locator's project is deleted upstream while its rows
 *      survive; deleteTraces answers the failure it is, never complete-by-
 *      absence (FREV-07's counterexample, replayed on the real instance).
 *
 * The script never prints a secret value; env inputs are URLs only.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { createDatabase } from "../../server/src/db/client";
import { createRunBindingStore } from "../../server/src/ai-observability/bindings";
import { createObserverRunBindingGate } from "../../server/src/ai-observability/bindings";
import { createOpikHealthService } from "../../server/src/ai-observability/health";
import {
  createOpikHttpPort,
  runUpstreamIdentity,
} from "../../server/src/ai-observability/opik-http";
import { createRunsQueryService } from "../../server/src/ai-observability/queries/runs";
import { createModelSpanRecorder } from "../../server/src/ai-observability/model-span";
import { createToolStepRecorder } from "../../server/src/ai-observability/tool-steps";
import {
  resolveObservationScope,
  resolveStorageLocator,
} from "../../server/src/ai-observability/scope";
import type { VerifiedOpikContract } from "../../server/src/ai-observability/opik-port";

const hereDir = dirname(fileURLToPath(import.meta.url));

type Args = Record<string, string>;
function args(argv: string[]): Args {
  const out: Args = {};
  for (const entry of argv) {
    const match = entry.match(/^--([a-z-]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}
const need = (a: Args, name: string): string => {
  const value = a[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const input = args(process.argv.slice(2));
  const opikUrl = need(input, "opik").replace(/\/+$/, "");
  const evidenceDir = need(input, "evidence");
  const databaseUrl = input["database"];
  mkdirSync(evidenceDir, { recursive: true });

  const manifest = (await Bun.file(
    join(
      hereDir,
      "../../server/src/ai-observability/opik-contract/47-manifest.json",
    ),
  ).json()) as VerifiedOpikContract;
  const port = createOpikHttpPort({
    baseUrl: opikUrl,
    contract: manifest,
    timeoutMs: 10_000,
  });

  const evidence: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    opik: opikUrl,
    steps: {},
  };
  const step = (name: string, fact: unknown) => {
    (evidence.steps as Record<string, unknown>)[name] = fact;
    console.log(`[f6b] ${name}: ${JSON.stringify(fact)}`);
  };

  // The deployment shape: enabled config + the one verified port.
  const config = () =>
    ({
      enabled: true,
      baseUrl: opikUrl,
      apiKey: null,
      workspaceName: "openbot",
      port: Number(new URL(opikUrl).port || 80),
      otlpHttpPort: 5418,
      otlpGrpcPort: 5417,
    }) as never;

  // Wait for the instance's own health, bounded.
  let healthy = false;
  for (let attempt = 0; attempt < 120 && !healthy; attempt++) {
    const probe = await port.healthCheck();
    healthy = probe.outcome === "ok";
    if (!healthy) await sleep(1_000);
  }
  step("instance-health", { healthy });

  const scope = resolveObservationScope({
    actorId: `f6b-${randomUUID()}`,
    botId: `f6b-bot-${randomUUID().slice(0, 8)}`,
    ownership: "owner",
    epoch: 1,
  });
  const locator = resolveStorageLocator(scope);

  // The real local halves: the binding store (and its gate) on the real test
  // database, the runs query service over the same store and port.
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const bindingStore = database ? createRunBindingStore(database) : null;
  if (!database || !bindingStore)
    throw new Error(
      "--database is required (the real store is part of the fix)",
    );

  const gate = createObserverRunBindingGate(bindingStore, { port: () => port });
  const health = createOpikHealthService({ config, port });
  const runs = createRunsQueryService({ bindings: bindingStore, config, port });
  const models = createModelSpanRecorder({
    healthService: health,
    bindings: gate,
  });
  const toolSteps = createToolStepRecorder({
    healthService: health,
    bindings: gate,
  });

  const readiness = await health.readiness();
  step("readiness", readiness);

  // Step 1 — materialize. One chain, one model span, one tool step, the way the
  // builtin runtime would submit them (scope + ambient parent context).
  const chain = randomUUID().replaceAll("-", "");
  const identity = runUpstreamIdentity(chain);
  const ambientParent = "bc1752c6f4dc"; // the F5E1 evidence's dangling parent
  models.record({
    occurredAt: new Date(Date.now() - 4_000),
    endedAt: new Date(Date.now() - 3_000),
    ending: { kind: "succeeded", inputTokens: 2051, outputTokens: 32 },
    scope,
    trace: { traceId: chain },
  });
  toolSteps.record({
    toolCallId: `call-${randomUUID().slice(0, 8)}`,
    toolName: "report_environment",
    endedAt: new Date(Date.now() - 2_000),
    proposalObserved: true,
    executionObserved: false,
    receiptObserved: false,
    window: "terminal",
    scope,
    trace: { traceId: chain, parentSpanId: ambientParent },
  });
  await health.drain();

  const bindingRow = await bindingStore.latestAttempt(
    scope,
    `builtin:${chain}`,
  );
  step("materialize", {
    healthStats: health.writeStats(),
    derivedTraceId: identity.opikTraceId,
    derivedRootSpanId: identity.rootOpikSpanId,
    bindingOpikTraceId: bindingRow?.opikTraceId ?? null,
    bindingState: bindingRow?.state ?? null,
    reconciled: bindingRow?.opikTraceId === identity.opikTraceId,
  });

  // Step 2 — read back through the production query service.
  const runId = `builtin:${chain}`;
  const listed = await runs.list(scope, { limit: 10 });
  const detail = await runs.detail(scope, runId);
  const steps = await runs.steps(scope, runId);
  step("readback", {
    listTotal: listed.pagination.total,
    listRuns: listed.runs.map((row) => ({
      opikTraceId: row.opikTraceId,
      capability: row.capability,
      state: row.state,
    })),
    syncing: listed.syncing,
    detailStatus: detail.upstream.status,
    detailOpikTraceId: detail.run.opikTraceId,
    steps: steps.steps.map((s) => ({
      kind: s.kind,
      spanId: s.spanId,
      parentSpanId: s.parentSpanId,
      state: s.state,
    })),
    parentsAllRoot:
      steps.steps.length > 0 &&
      steps.steps.every((s) => s.parentSpanId === identity.rootOpikSpanId),
  });

  // Step 3 — FREV-07's normal path: delete by the frozen locator, completion on
  // observed absence (trace AND span rows).
  const deleted = await port.deleteTraces(locator, {
    traceIds: [identity.opikTraceId],
  });
  // The window cache holds a 5s page; the after-delete count reads the port
  // directly so it is the upstream's own answer, not a cached one.
  let listedAfterTotal: number | string = "unavailable";
  for (let attempt = 0; attempt < 6; attempt++) {
    const resolved = await port.retrieveProject(scope);
    if (resolved.outcome !== "ok" || resolved.value === null) break;
    const page = await port.listTraces(scope, {
      projectId: resolved.value.id,
      size: 100,
    });
    if (page.outcome !== "ok") break;
    listedAfterTotal = page.value.total;
    if (page.value.total === 0) break;
    await sleep(1_000);
  }
  step("delete-verified-absence", {
    outcome: deleted.outcome,
    value: deleted.outcome === "ok" ? deleted.value : undefined,
    listTotalAfter: listedAfterTotal,
  });

  // Step 4 — FREV-07's counterexample on the real instance: the project row is
  // deleted upstream while the trace/span rows survive it. A second chain under
  // the same scope (same locator project) feeds the rows; the project delete is
  // the raw verified REST call the E2E used.
  const chain2 = randomUUID().replaceAll("-", "");
  const identity2 = runUpstreamIdentity(chain2);
  models.record({
    occurredAt: new Date(Date.now() - 1_000),
    endedAt: new Date(),
    ending: { kind: "succeeded", inputTokens: 7, outputTokens: 3 },
    scope,
    trace: { traceId: chain2 },
  });
  await health.drain();
  const binding2 = await bindingStore.latestAttempt(scope, `builtin:${chain2}`);
  step("second-run-materialized", {
    derivedTraceId: identity2.opikTraceId,
    bindingOpikTraceId: binding2?.opikTraceId ?? null,
  });

  // Each raw REST call is status-checked before its body is trusted: a failed
  // retrieve must fail the step, not feed `undefined` into the delete payload.
  const resolveProject = await fetch(
    `${opikUrl}/v1/private/projects/retrieve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: locator.project }),
    },
  );
  const project = resolveProject.ok
    ? ((await resolveProject.json()) as { id: string })
    : null;
  const projectDeleted = project
    ? await fetch(`${opikUrl}/v1/private/projects/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [project.id] }),
      })
    : null;
  const goneCheck = project
    ? await fetch(`${opikUrl}/v1/private/projects/retrieve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: locator.project }),
      })
    : null;
  // The rows that survive the project delete are asserted through deleteTraces'
  // own outcome below: the project-scoped query path is gone with the project,
  // and the clickhouse residual check happens outside this script and lands in
  // the evidence directory.
  const deleteAfterProjectGone = await port.deleteTraces(locator, {
    traceIds: [identity2.opikTraceId],
  });
  step("project-404-residual", {
    projectResolved: project !== null,
    projectId: project?.id ?? null,
    projectDeleteStatus: projectDeleted?.status ?? null,
    projectRetrieveAfter: goneCheck?.status ?? null,
    deleteTracesOutcome: deleteAfterProjectGone.outcome,
    deleteTracesCode:
      deleteAfterProjectGone.outcome === "upstream_error"
        ? deleteAfterProjectGone.code
        : undefined,
    deleteTracesStatus:
      deleteAfterProjectGone.outcome === "upstream_error"
        ? deleteAfterProjectGone.status
        : undefined,
  });

  evidence.finishedAt = new Date().toISOString();
  const out = join(evidenceDir, "f6b-real-readback.json");
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`[f6b] evidence: ${out}`);

  // Hard verdict: every step's own contract must hold, or the exit code says so.
  const failures: string[] = [];
  const s = evidence.steps as Record<string, Record<string, unknown>>;
  if (s["instance-health"].healthy !== true)
    failures.push("instance-unhealthy");
  if (s["materialize"].reconciled !== true) failures.push("not-reconciled");
  // no-stats fails the run AND skips the dependent assertion: dereferencing a
  // missing stats object here would throw away every failure collected above.
  const stats = s["materialize"].healthStats as
    | { completed: number }
    | undefined;
  if (stats === undefined) failures.push("no-stats");
  else if (stats.completed !== 2) failures.push(`completed=${stats.completed}`);
  const rb = s["readback"];
  if (rb.detailStatus !== "present") failures.push(`detail=${rb.detailStatus}`);
  if (rb.syncing !== false) failures.push("still-syncing");
  if (Array.isArray(rb.steps) && (rb.steps as unknown[]).length !== 2)
    failures.push("steps-missing");
  if (rb.parentsAllRoot !== true) failures.push("parents-not-root");
  const del = s["delete-verified-absence"];
  if (del.outcome !== "ok") failures.push(`delete=${del.outcome}`);
  if (del.listTotalAfter !== 0) failures.push("still-listed");
  const p4 = s["project-404-residual"];
  if (p4.projectResolved !== true) failures.push("project-not-resolved");
  if (
    p4.deleteTracesOutcome !== "upstream_error" ||
    p4.deleteTracesStatus !== 404
  )
    failures.push(`project404=${p4.deleteTracesOutcome}`);

  if (failures.length > 0) {
    console.error(`[f6b] FAILED: ${failures.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("[f6b] all steps verified");
  }
  await database.$client.close();
}

await main();
