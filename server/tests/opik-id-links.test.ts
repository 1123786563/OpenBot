// Issue #23 / DAG T17 — the OpenBot↔Opik id mapping: link-id validation and the
// bidirectional query seam.
//
// Unit level, injected fakes only: no database and no network here (the store's
// database behaviour is proven in opik-id-links.integration.test.ts). What this
// file pins:
//   - an id that could carry a secret is REFUSED before anything is stored —
//     the mapping's canary discipline (acceptance 4);
//   - the query seam answers both directions for runs (bindings), steps (links)
//     and datasets, fail-closed on unknown subjects and invalid refs.

import { describe, expect, test } from "bun:test";
import type { RunBinding } from "../src/ai-observability/bindings";
import type { ObservationDataset } from "../src/ai-observability/datasets";
import {
  IdLinkError,
  type IdLinkRow,
  validateLinkId,
} from "../src/ai-observability/id-links";
import { createIdLinkQueryService } from "../src/ai-observability/queries/links";
import { resolveObservationScope } from "../src/ai-observability/scope";

const scope = resolveObservationScope({
  actorId: "user-1",
  botId: "bot-1",
  ownership: "owner",
  epoch: 1,
});

// Assembled, never literal, so a leak has to be matched by content, not grep-ability.
const CANARY_KEY = `sk-live-${"a".repeat(24)}`;
const CANARY_BEARER = `Bearer ${"B".repeat(24)}`;
const CANARY_GH = `ghp_${"c".repeat(24)}`;
const CANARY_AKIA = `AKIA${"0".repeat(16)}`;
const CANARY_PG = "postgres://user:secret@db.example.com/prod";
const CANARY_PEM = `-----BEGIN PRIVATE KEY-----${"d".repeat(40)}`;

describe("link id validation", () => {
  test("refuses empty and blank ids", () => {
    expect(() => validateLinkId("")).toThrow(IdLinkError);
    expect(() => validateLinkId("   ")).toThrow(IdLinkError);
  });

  test("refuses every credential class before anything could be stored", () => {
    for (const canary of [
      CANARY_KEY,
      CANARY_BEARER,
      CANARY_GH,
      CANARY_AKIA,
      CANARY_PG,
      CANARY_PEM,
    ]) {
      expect(() => validateLinkId(canary)).toThrow(IdLinkError);
    }
  });

  test("refuses oversized and control-character ids", () => {
    expect(() => validateLinkId("a".repeat(257))).toThrow(IdLinkError);
    expect(() => validateLinkId("call\nid")).toThrow(IdLinkError);
    expect(() => validateLinkId("call\u0000id")).toThrow(IdLinkError);
  });

  test("accepts the boring opaque ids the runtime actually mints", () => {
    expect(validateLinkId("call_1730102400_ab12cd34")).toBe(
      "call_1730102400_ab12cd34",
    );
    expect(validateLinkId("0192f0c0-a2b1-7c3d-8e4f-5a6b7c8d9e0f")).toBe(
      "0192f0c0-a2b1-7c3d-8e4f-5a6b7c8d9e0f",
    );
  });
});

// ---------------------------------------------------------------------------
// The query seam, over fakes that answer exactly what their tables would
// ---------------------------------------------------------------------------

function aBinding(overrides: Partial<RunBinding> = {}): RunBinding {
  return {
    id: "binding-1",
    scopeKey: scope.key,
    actorId: scope.actorId,
    botId: scope.botId,
    runId: "run-1",
    attemptId: "attempt-1",
    traceId: "f".repeat(32),
    opikTraceId: "0192f0c0-a2b1-7c3d-8e4f-5a6b7c8d9e0f",
    locatorWorkspace: "ws",
    locatorProject: "proj",
    capability: "basic",
    state: "completed",
    expiresAt: new Date("2026-10-23T00:00:00.000Z"),
    deletedAt: null,
    createdAt: new Date("2026-10-16T00:00:00.000Z"),
    updatedAt: new Date("2026-10-16T00:00:00.000Z"),
    ...overrides,
  } as RunBinding;
}

function aLink(overrides: Partial<IdLinkRow> = {}): IdLinkRow {
  return {
    id: "link-1",
    scopeKey: scope.key,
    actorId: scope.actorId,
    botId: scope.botId,
    localKind: "tool_step",
    localId: "call-1",
    upstreamKind: "span",
    upstreamId: "0192f0c1-0000-7000-8000-000000000001",
    runId: "run-1",
    observedTraceId: "f".repeat(32),
    createdAt: new Date("2026-10-16T00:00:00.000Z"),
    ...overrides,
  } as IdLinkRow;
}

function aDataset(overrides = {}): ObservationDataset {
  return {
    id: "dataset-1",
    scopeKey: scope.key,
    actorId: scope.actorId,
    botId: scope.botId,
    name: "golden",
    locatorWorkspace: "ws",
    locatorProject: "proj",
    opikDatasetId: "0192f0c2-0000-7000-8000-000000000002",
    syncState: "synced",
    createdAt: new Date("2026-10-16T00:00:00.000Z"),
    updatedAt: new Date("2026-10-16T00:00:00.000Z"),
    ...overrides,
  } as ObservationDataset;
}

/** The fake bindings reader: only this scope's rows answer, like the real store. */
function fakeBindings(rows: readonly RunBinding[]) {
  const calls: string[] = [];
  return {
    calls,
    bindings: {
      attempt: async (
        asked: { key: string },
        runId: string,
        attemptId: string,
      ) => {
        calls.push("attempt");
        expect(asked.key).toBe(scope.key);
        return (
          rows.find(
            (row) =>
              row.scopeKey === asked.key &&
              row.runId === runId &&
              row.attemptId === attemptId,
          ) ?? null
        );
      },
      byOpikTrace: async (asked: { key: string }, opikTraceId: string) => {
        calls.push("byOpikTrace");
        return (
          rows.find(
            (row) =>
              row.scopeKey === asked.key && row.opikTraceId === opikTraceId,
          ) ?? null
        );
      },
    },
  };
}

function fakeLinks(rows: readonly IdLinkRow[]) {
  return {
    byLocal: async (
      asked: { key: string },
      kind: string,
      id: string,
    ): Promise<IdLinkRow | null> =>
      rows.find(
        (row) =>
          row.scopeKey === asked.key &&
          row.localKind === kind &&
          row.localId === id,
      ) ?? null,
    byUpstream: async (
      asked: { key: string },
      kind: string,
      id: string,
    ): Promise<IdLinkRow | null> =>
      rows.find(
        (row) =>
          row.scopeKey === asked.key &&
          row.upstreamKind === kind &&
          row.upstreamId === id,
      ) ?? null,
  };
}

function fakeDatasets(rows: readonly ObservationDataset[]) {
  return {
    getDataset: async (asked: { key: string }, id: string) =>
      rows.find((row) => row.scopeKey === asked.key && row.id === id) ?? null,
    byOpikDatasetId: async (asked: { key: string }, opikDatasetId: string) =>
      rows.find(
        (row) =>
          row.scopeKey === asked.key && row.opikDatasetId === opikDatasetId,
      ) ?? null,
  };
}

describe("the id-mapping query seam", () => {
  test("run → trace: a reconciled binding answers its upstream trace", async () => {
    const service = createIdLinkQueryService({
      bindings: fakeBindings([aBinding()]).bindings,
      links: fakeLinks([]),
      datasets: fakeDatasets([]),
    });
    const answer = await service.resolveByLocal(scope, {
      kind: "run_attempt",
      runId: "run-1",
      attemptId: "attempt-1",
    });
    expect(answer.upstream).toMatchObject({
      kind: "trace",
      id: "0192f0c0-a2b1-7c3d-8e4f-5a6b7c8d9e0f",
    });
  });

  test("run → null: a begun-but-unreconciled binding is honestly unlinked", async () => {
    const service = createIdLinkQueryService({
      bindings: fakeBindings([aBinding({ opikTraceId: null })]).bindings,
      links: fakeLinks([]),
      datasets: fakeDatasets([]),
    });
    const answer = await service.resolveByLocal(scope, {
      kind: "run_attempt",
      runId: "run-1",
      attemptId: "attempt-1",
    });
    expect(answer.upstream).toBeNull();
  });

  test("an unbound run id is not found, never a guess", async () => {
    const service = createIdLinkQueryService({
      bindings: fakeBindings([]).bindings,
      links: fakeLinks([]),
      datasets: fakeDatasets([]),
    });
    await expect(
      service.resolveByLocal(scope, {
        kind: "run_attempt",
        runId: "nope",
        attemptId: "nope",
      }),
    ).rejects.toMatchObject({ code: "SUBJECT_NOT_FOUND" });
  });

  test("step → span and back: both directions of one link", async () => {
    const link = aLink();
    const service = createIdLinkQueryService({
      bindings: fakeBindings([]).bindings,
      links: fakeLinks([link]),
      datasets: fakeDatasets([]),
    });
    const forward = await service.resolveByLocal(scope, {
      kind: "tool_step",
      id: "call-1",
    });
    expect(forward.upstream).toMatchObject({
      kind: "span",
      id: link.upstreamId,
    });
    const reverse = await service.resolveByUpstream(scope, {
      kind: "span",
      id: link.upstreamId,
    });
    expect(reverse.subject).toMatchObject({
      ref: { kind: "tool_step", id: "call-1" },
    });
  });

  test("an unlinked step is SUBJECT_NOT_FOUND — the link table is the step's sole existence record (OCR R5-17)", async () => {
    // The interface JSDoc promises "a subject this scope does not own is
    // SUBJECT_NOT_FOUND, never an empty answer". For steps the id-link table is
    // the only existence record this scope keeps (the file header says so), so a
    // missing row is an un-owned subject, not an honestly-unlinked one — there is
    // no state where a step exists here without its link. Answering
    // `{upstream: null}` would hand a guessed step id the same shape as a real,
    // linked one, which is exactly the empty answer the contract refuses.
    const service = createIdLinkQueryService({
      bindings: fakeBindings([]).bindings,
      links: fakeLinks([]),
      datasets: fakeDatasets([]),
    });
    await expect(
      service.resolveByLocal(scope, { kind: "tool_step", id: "call-unlinked" }),
    ).rejects.toMatchObject({ code: "SUBJECT_NOT_FOUND", status: 404 });
    await expect(
      service.resolveByLocal(scope, {
        kind: "retrieval_step",
        id: "retrieve-unlinked",
      }),
    ).rejects.toMatchObject({ code: "SUBJECT_NOT_FOUND", status: 404 });
  });

  test("dataset → upstream dataset and back", async () => {
    const service = createIdLinkQueryService({
      bindings: fakeBindings([]).bindings,
      links: fakeLinks([]),
      datasets: fakeDatasets([aDataset()]),
    });
    const forward = await service.resolveByLocal(scope, {
      kind: "dataset",
      id: "dataset-1",
    });
    expect(forward.upstream).toMatchObject({
      kind: "dataset",
      id: "0192f0c2-0000-7000-8000-000000000002",
    });
    const reverse = await service.resolveByUpstream(scope, {
      kind: "dataset",
      id: "0192f0c2-0000-7000-8000-000000000002",
    });
    expect(reverse.subject).toMatchObject({
      ref: { kind: "dataset", id: "dataset-1" },
    });
  });

  test("a pending dataset is honestly unlinked; an unknown one is not found", async () => {
    const service = createIdLinkQueryService({
      bindings: fakeBindings([]).bindings,
      links: fakeLinks([]),
      datasets: fakeDatasets([
        aDataset({ opikDatasetId: null, syncState: "pending" }),
      ]),
    });
    const pending = await service.resolveByLocal(scope, {
      kind: "dataset",
      id: "dataset-1",
    });
    expect(pending.upstream).toBeNull();
    await expect(
      service.resolveByLocal(scope, { kind: "dataset", id: "nope" }),
    ).rejects.toMatchObject({ code: "SUBJECT_NOT_FOUND" });
  });

  test("trace → run: the reverse direction over the binding table", async () => {
    const service = createIdLinkQueryService({
      bindings: fakeBindings([aBinding()]).bindings,
      links: fakeLinks([]),
      datasets: fakeDatasets([]),
    });
    const answer = await service.resolveByUpstream(scope, {
      kind: "trace",
      id: "0192f0c0-a2b1-7c3d-8e4f-5a6b7c8d9e0f",
    });
    expect(answer.subject).toMatchObject({
      ref: { kind: "run_attempt", runId: "run-1", attemptId: "attempt-1" },
    });
  });

  test("an upstream id this scope never mapped answers null, learning nothing", async () => {
    const service = createIdLinkQueryService({
      bindings: fakeBindings([aBinding()]).bindings,
      links: fakeLinks([aLink()]),
      datasets: fakeDatasets([aDataset()]),
    });
    for (const ref of [
      { kind: "trace" as const, id: "01929999-0000-7000-8000-000000000009" },
      { kind: "span" as const, id: "01929999-0000-7000-8000-00000000000a" },
      { kind: "dataset" as const, id: "01929999-0000-7000-8000-00000000000b" },
    ]) {
      const answer = await service.resolveByUpstream(scope, ref);
      expect(answer.subject).toBeNull();
    }
  });

  test("invalid refs fail closed before any store is asked", async () => {
    const bindings = fakeBindings([]);
    const service = createIdLinkQueryService({
      bindings: bindings.bindings,
      links: fakeLinks([]),
      datasets: fakeDatasets([]),
    });
    await expect(
      service.resolveByLocal(scope, { kind: "tool_step", id: "" }),
    ).rejects.toMatchObject({ code: "ID_LINK_QUERY_INPUT_INVALID" });
    await expect(
      service.resolveByLocal(scope, {
        kind: "run_attempt",
        runId: "",
        attemptId: "a",
      }),
    ).rejects.toMatchObject({ code: "ID_LINK_QUERY_INPUT_INVALID" });
    await expect(
      service.resolveByUpstream(scope, { kind: "span", id: " " }),
    ).rejects.toMatchObject({ code: "ID_LINK_QUERY_INPUT_INVALID" });
    expect(bindings.calls).toHaveLength(0);
  });

  test("a canary-shaped upstream id is refused, not resolved", async () => {
    const service = createIdLinkQueryService({
      bindings: fakeBindings([]).bindings,
      links: fakeLinks([]),
      datasets: fakeDatasets([]),
    });
    await expect(
      service.resolveByUpstream(scope, { kind: "span", id: CANARY_KEY }),
    ).rejects.toMatchObject({ code: "ID_LINK_QUERY_INPUT_INVALID" });
  });
});
