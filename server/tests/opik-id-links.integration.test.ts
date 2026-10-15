/**
 * Issue #23 / DAG T17 — the id-mapping store and query seam against a real,
 * dedicated PostgreSQL database.
 *
 * Behavioral proof of the mapping contract: first-link-wins idempotency, both
 * unique directions, scope isolation, the chain check that detects a broken
 * cross-service link (a step claiming a trace that is not its run binding's),
 * the canary refusal, and the forged-scope refusal. There is no skip and no
 * fallback database; a missing test database fails the run.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  createRunBindingStore,
  type RunBindingStore,
} from "../src/ai-observability/bindings";
import { ObservationScopeError } from "../src/ai-observability/contracts";
import { createObservationDatasetStore } from "../src/ai-observability/datasets";
import {
  createIdLinkStore,
  IdLinkError,
} from "../src/ai-observability/id-links";
import { createIdLinkQueryService } from "../src/ai-observability/queries/links";
import { resolveObservationScope } from "../src/ai-observability/scope";
import { aiObservationBindings } from "../src/db/schema/ai-observability-bindings";
import { aiObservationDatasets } from "../src/db/schema/ai-observability-datasets";
import { aiObservationIdLinks } from "../src/db/schema/ai-observability-id-links";
import { opikTestDatabase } from "./support/opik-test-db";

const database = opikTestDatabase();
const bindings = createRunBindingStore(database);
const links = createIdLinkStore(database, { bindings });
const datasets = createObservationDatasetStore(database);
const seam = createIdLinkQueryService({ bindings, links, datasets });
const prefix = `t17-${randomUUID()}`;

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

/** A W3C-shaped trace id, because the chain check compares what runs really carry. */
function traceId(seed: string): string {
  const hex = Buffer.from(seed.padEnd(16, "0").slice(0, 16))
    .toString("hex")
    .padStart(32, "0");
  return hex.slice(0, 32);
}

const OP = (n: number) =>
  `0192f0c0-0000-7000-8000-${String(n).padStart(12, "0")}`;

async function beginBinding(
  store: RunBindingStore,
  scope: typeof scopeA,
  runId: string,
  attemptId: string,
  trace: string,
) {
  await store.begin(scope, {
    runId,
    attemptId,
    traceId: trace,
    capability: "basic",
    expiresAt: new Date("2026-10-23T00:00:00.000Z"),
  });
}

afterEach(async () => {
  await database
    .delete(aiObservationIdLinks)
    .where(sql`${aiObservationIdLinks.localId} LIKE ${`${prefix}%`}`);
  await database
    .delete(aiObservationBindings)
    .where(sql`${aiObservationBindings.runId} LIKE ${`${prefix}%`}`);
  // Dataset versions cascade with their subject; without this, a previous run's
  // synced opik dataset id collides with the next run's markSynced. The 0124
  // delete guard (T20, integrated after T17 branched) refuses version rows
  // leaving any way but dataset cleanup — the transaction-local flag is the one
  // sanctioned path (datasets suite's afterEach precedent).
  await database.$client.begin(async (tx) => {
    await tx`select set_config('ai_observation.dataset_cleanup', 'on', true)`;
    await tx`DELETE FROM ai_observation_datasets WHERE name LIKE ${`${prefix}%`}`;
  });
  // Return the pooled connection to a known session state (case-review suite
  // precedent: residue here once masked a guard hole).
  await database.$client`RESET ai_observation.dataset_cleanup`;
});

afterAll(async () => {
  await database.$client.close();
});

test("the dedicated test database carries the id-link uniqueness constraints", async () => {
  const indexes = await database.$client`
    SELECT indexname FROM pg_indexes WHERE tablename = 'ai_observation_id_links'
  `;
  const present = new Set(indexes.map((row) => row.indexname));
  for (const required of [
    "ai_observation_id_links_scope_local_uq",
    "ai_observation_id_links_scope_upstream_uq",
  ]) {
    if (!present.has(required)) {
      throw new Error(
        `The dedicated Opik test database lacks ${required}. Apply the migrations to the dedicated test database first (TEST_DATABASE_URL=... bun run db:migrate in server/); do not point these tests at the application database and do not record this as a pass.`,
      );
    }
  }
});

test("a link persists and both directions answer it", async () => {
  const verdict = await links.link(scopeA, {
    local: { kind: "tool_step", id: `${prefix}-call-1` },
    upstream: { kind: "span", id: OP(1) },
    observedTraceId: traceId("run-1"),
  });
  expect(verdict).toEqual({ linked: true, replayed: false });

  const forward = await links.byLocal(scopeA, "tool_step", `${prefix}-call-1`);
  expect(forward?.upstreamId).toBe(OP(1));
  const reverse = await links.byUpstream(scopeA, "span", OP(1));
  expect(reverse?.localId).toBe(`${prefix}-call-1`);
});

test("a replay of the same link is a replay; a divergent upstream id changes nothing", async () => {
  const input = {
    local: { kind: "tool_step" as const, id: `${prefix}-call-2` },
    upstream: { kind: "span" as const, id: OP(2) },
    observedTraceId: traceId("run-2"),
  };
  expect(await links.link(scopeA, input)).toEqual({
    linked: true,
    replayed: false,
  });
  expect(await links.link(scopeA, input)).toEqual({
    linked: true,
    replayed: true,
  });
  // A second, different upstream id for the same subject: the first stands.
  expect(
    await links.link(scopeA, {
      ...input,
      upstream: { kind: "span", id: OP(3) },
    }),
  ).toEqual({ linked: false, reason: "divergent" });
  const standing = await links.byLocal(scopeA, "tool_step", `${prefix}-call-2`);
  expect(standing?.upstreamId).toBe(OP(2));

  const rows = await database
    .select({ id: aiObservationIdLinks.id })
    .from(aiObservationIdLinks)
    .where(eq(aiObservationIdLinks.localId, `${prefix}-call-2`));
  expect(rows).toHaveLength(1);
});

test("a DIFFERENT local subject claiming an already-claimed upstream id is divergent, not an error (T17 review L-1a)", async () => {
  await links.link(scopeA, {
    local: { kind: "tool_step", id: `${prefix}-call-claim-a` },
    upstream: { kind: "span", id: OP(11) },
    observedTraceId: traceId("claim"),
  });
  // Upstream duplication: the challenger is a different local subject carrying
  // the SAME upstream id. The store must answer the divergent verdict — an
  // ON CONFLICT that names only the local key lets the upstream unique key
  // throw a raw unique_violation instead.
  expect(
    await links.link(scopeA, {
      local: { kind: "tool_step", id: `${prefix}-call-claim-b` },
      upstream: { kind: "span", id: OP(11) },
      observedTraceId: traceId("claim"),
    }),
  ).toEqual({ linked: false, reason: "divergent" });
  // The standing mapping won; the challenger wrote nothing.
  expect(
    await links.byLocal(scopeA, "tool_step", `${prefix}-call-claim-b`),
  ).toBeNull();
  expect(await links.byUpstream(scopeA, "span", OP(11))).toMatchObject({
    localId: `${prefix}-call-claim-a`,
  });
});

test("the same local id under another scope is a different subject", async () => {
  await links.link(scopeA, {
    local: { kind: "tool_step", id: `${prefix}-call-3` },
    upstream: { kind: "span", id: OP(4) },
    observedTraceId: traceId("run-3"),
  });
  expect(
    await links.byLocal(scopeB, "tool_step", `${prefix}-call-3`),
  ).toBeNull();
  expect(await links.byUpstream(scopeB, "span", OP(4))).toBeNull();
  // Scope B can link the same local id to a different upstream id: its own subject.
  expect(
    await links.link(scopeB, {
      local: { kind: "tool_step", id: `${prefix}-call-3` },
      upstream: { kind: "span", id: OP(5) },
      observedTraceId: traceId("run-3b"),
    }),
  ).toEqual({ linked: true, replayed: false });
});

test("a forged scope cannot reach the database (acceptance 3)", async () => {
  const forged = {
    kind: "workbench",
    key: scopeA.key,
    actorId: "user-a",
    botId: "agent-1",
    epoch: 1,
  };
  await expect(
    links.link(forged as never, {
      local: { kind: "tool_step", id: `${prefix}-forged` },
      upstream: { kind: "span", id: OP(6) },
      observedTraceId: traceId("forged"),
    }),
  ).rejects.toBeInstanceOf(ObservationScopeError);
  const rows = await database
    .select({ id: aiObservationIdLinks.id })
    .from(aiObservationIdLinks)
    .where(eq(aiObservationIdLinks.localId, `${prefix}-forged`));
  expect(rows).toHaveLength(0);
});

test("a canary-shaped id is refused before anything is stored (acceptance 4)", async () => {
  const canary = `sk-live-${"a".repeat(24)}`;
  await expect(
    links.link(scopeA, {
      local: { kind: "tool_step", id: canary },
      upstream: { kind: "span", id: OP(7) },
      observedTraceId: traceId("canary"),
    }),
  ).rejects.toBeInstanceOf(IdLinkError);
  await expect(
    links.link(scopeA, {
      local: { kind: "tool_step", id: `${prefix}-ok` },
      upstream: { kind: "span", id: canary },
      observedTraceId: traceId("canary"),
    }),
  ).rejects.toBeInstanceOf(IdLinkError);
  const rows = await database
    .select({ id: aiObservationIdLinks.id })
    .from(aiObservationIdLinks)
    .where(eq(aiObservationIdLinks.observedTraceId, traceId("canary")));
  expect(rows).toHaveLength(0);
});

test("the chain check: a step whose trace is not its run binding's is a broken link (acceptance 1)", async () => {
  const runId = `${prefix}-run-broken`;
  const bound = traceId("chain-authoritative");
  await beginBinding(bindings, scopeA, runId, "attempt-1", bound);

  const verdict = await links.link(scopeA, {
    local: { kind: "tool_step", id: `${prefix}-call-broken` },
    upstream: { kind: "span", id: OP(8) },
    runRef: { runId, attemptId: "attempt-1" },
    observedTraceId: traceId("chain-divergent"),
  });
  expect(verdict).toEqual({ linked: false, reason: "chain_broken" });
  expect(
    await links.byLocal(scopeA, "tool_step", `${prefix}-call-broken`),
  ).toBeNull();

  // The continuous chain links: same trace, the binding's own.
  expect(
    await links.link(scopeA, {
      local: { kind: "tool_step", id: `${prefix}-call-broken` },
      upstream: { kind: "span", id: OP(9) },
      runRef: { runId, attemptId: "attempt-1" },
      observedTraceId: bound,
    }),
  ).toEqual({ linked: true, replayed: false });
});

test("a run this scope never bound has no chain to break: the step stands alone", async () => {
  expect(
    await links.link(scopeA, {
      local: { kind: "tool_step", id: `${prefix}-call-orphan` },
      upstream: { kind: "span", id: OP(10) },
      runRef: { runId: `${prefix}-run-unbound`, attemptId: "attempt-1" },
      observedTraceId: traceId("orphan"),
    }),
  ).toEqual({ linked: true, replayed: false });
});

test("the query seam answers end to end over the real stores (acceptance 2)", async () => {
  const runId = `${prefix}-run-seam`;
  const trace = traceId("seam-run");
  await beginBinding(bindings, scopeA, runId, "attempt-1", trace);
  await bindings.reconcile(scopeA, runId, "attempt-1", OP(20));
  await links.link(scopeA, {
    local: { kind: "tool_step", id: `${prefix}-call-seam` },
    upstream: { kind: "span", id: OP(21) },
    runRef: { runId, attemptId: "attempt-1" },
    observedTraceId: trace,
  });
  const { dataset } = await datasets.saveVersion(scopeA, {
    datasetName: `${prefix}-golden`,
    cases: [
      {
        input: "say hi",
        referenceOutput: "hi",
        toolFixtures: {},
        sourceRunId: `${prefix}-run-seam`,
        sourceAttemptId: "attempt-1",
      },
    ],
  });
  await datasets.markSyncing(scopeA, dataset.id);
  await datasets.markSynced(scopeA, dataset.id, OP(22));

  // Local → upstream, all three kinds.
  expect(
    await seam.resolveByLocal(scopeA, {
      kind: "run_attempt",
      runId,
      attemptId: "attempt-1",
    }),
  ).toMatchObject({ upstream: { kind: "trace", id: OP(20) } });
  expect(
    await seam.resolveByLocal(scopeA, {
      kind: "tool_step",
      id: `${prefix}-call-seam`,
    }),
  ).toMatchObject({ upstream: { kind: "span", id: OP(21) } });
  expect(
    await seam.resolveByLocal(scopeA, { kind: "dataset", id: dataset.id }),
  ).toMatchObject({ upstream: { kind: "dataset", id: OP(22) } });

  // Upstream → local, all three kinds.
  expect(
    await seam.resolveByUpstream(scopeA, { kind: "trace", id: OP(20) }),
  ).toMatchObject({
    subject: { ref: { kind: "run_attempt", runId, attemptId: "attempt-1" } },
  });
  expect(
    await seam.resolveByUpstream(scopeA, { kind: "span", id: OP(21) }),
  ).toMatchObject({
    subject: { ref: { kind: "tool_step", id: `${prefix}-call-seam` } },
  });
  expect(
    await seam.resolveByUpstream(scopeA, { kind: "dataset", id: OP(22) }),
  ).toMatchObject({ subject: { ref: { kind: "dataset", id: dataset.id } } });

  // Another scope sees nothing of any of it.
  expect(
    (await seam.resolveByUpstream(scopeB, { kind: "trace", id: OP(20) }))
      .subject,
  ).toBeNull();
  expect(
    (await seam.resolveByUpstream(scopeB, { kind: "span", id: OP(21) }))
      .subject,
  ).toBeNull();
  await expect(
    seam.resolveByLocal(scopeB, {
      kind: "run_attempt",
      runId,
      attemptId: "attempt-1",
    }),
  ).rejects.toMatchObject({ code: "SUBJECT_NOT_FOUND" });
});

test("the run read the chain check uses is exact, and works before reconcile", async () => {
  const runId = `${prefix}-run-unreconciled`;
  const trace = traceId("unreconciled");
  await beginBinding(bindings, scopeA, runId, "attempt-9", trace);
  expect(
    await seam.resolveByLocal(scopeA, {
      kind: "run_attempt",
      runId,
      attemptId: "attempt-9",
    }),
  ).toMatchObject({ upstream: null });
  // The exact-attempt read does not fall back to another attempt's binding.
  await expect(
    seam.resolveByLocal(scopeA, {
      kind: "run_attempt",
      runId,
      attemptId: "attempt-other",
    }),
  ).rejects.toMatchObject({ code: "SUBJECT_NOT_FOUND" });
});
