import { expect, test } from "../../tests/support/bun-test-compat";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import {
  PRICE_DIMENSIONS,
  assertPriceSnapshotDims,
  type PriceDimState,
  type PriceSnapshotDims,
} from "../src/gateway/price-snapshot";
import { computeReservationCeiling } from "../src/billing/reserve-bound";
import {
  VIDEO_EDIT_BILLED_DIMENSIONS,
  VIDEO_INPUT_MAX_COUNT,
  VIDEO_INPUT_MAX_SECONDS,
  assessVideoEditEnablement,
  videoEditCeilingDims,
  videoEditSpecOf,
} from "../src/billing/video-edit-pricing";
import {
  assessVideoGenerationEnablement,
  videoGenerationCeilingDims,
  videoTierPriceTableFromSnapshot,
} from "../src/billing/video-generation-pricing";
import { summarizeVideoSpecAvailability } from "../src/billing/video-spec-availability";

/*
 * Ticket 19.3 (#339) — edit and variant pricing: the input cost folded into the ceiling,
 * the input determinability gate, and the SHARED semantics with generation.
 *
 *   AC-1  编辑与变体的上限包含输入成本（当上游收费时） — `video_input` × the inputs' own
 *         stated seconds, on top of the output tier's seconds × count;
 *   AC-2  输入规格不可确定时拒绝该请求 — an input whose duration nobody stated refuses
 *         BEFORE any price is read, never an estimate in its place;
 *   AC-3  编辑、变体与生成共用同一预留与结算语义 — the quantities are the generation
 *         shape plus the input side, priced by the same conversion, same submit path;
 *   AC-4  缺输入定价时标记 unknown 并拒绝 — the input rate is its own dimension: a
 *         known "0" is free WITH evidence, an unknown refuses with the dimension named.
 */

const RATE_100 = { numerator: 100n, denominator: 1n } as ConversionRate;

/** A fully-priced basis with both video sides at the given rates. */
function editDims(
  perSecondUsd: string,
  inputPerSecondUsd: string | "unknown" | "unreadable",
): PriceSnapshotDims {
  const dims = {} as Record<(typeof PRICE_DIMENSIONS)[number], PriceDimState>;
  for (const dimension of PRICE_DIMENSIONS) {
    if (dimension === "video") {
      dims[dimension] = { status: "known", amount: perSecondUsd };
    } else if (dimension === "video_input") {
      dims[dimension] =
        inputPerSecondUsd === "unknown"
          ? { status: "unknown", reason: "price_dim_no_source" }
          : inputPerSecondUsd === "unreadable"
            ? { status: "unknown", reason: "price_dim_unreadable" }
            : { status: "known", amount: inputPerSecondUsd };
    } else {
      dims[dimension] = { status: "known", amount: "0" };
    }
  }
  return assertPriceSnapshotDims(dims, "fixture");
}

test("the billed-dimension set is the two video sides — output second and input second", () => {
  expect([...VIDEO_EDIT_BILLED_DIMENSIONS]).toEqual(["video", "video_input"]);
});

// ── the input determinability gate (AC2) ──

test("an edit spec fixes both sides; inputs may ride a single object or an array", () => {
  const single = videoEditSpecOf({
    seconds: 8,
    input: { video: "clip-1", seconds: 10 },
  });
  expect(single).toEqual({
    ok: true,
    spec: {
      seconds: 8,
      size: null,
      quality: null,
      outputCount: 1,
      requestType: "edit",
      inputVideos: 1,
      inputSpecs: [{ seconds: 10 }],
    },
  });
  const many = videoEditSpecOf({
    seconds: 8,
    input: [
      { video: "clip-1", seconds: 10 },
      { video: "clip-2", seconds: 4 },
    ],
    requestType: "remix",
  });
  if (!many.ok) throw new Error("must fix");
  expect(many.spec.inputVideos).toBe(2);
  expect(many.spec.inputSpecs).toEqual([{ seconds: 10 }, { seconds: 4 }]);
});

test("an input whose duration nobody stated refuses before any price is read (AC2)", () => {
  for (const input of [
    undefined, // no inputs at all — an edit with nothing to edit
    null,
    [],
    { video: "clip-1" }, // referenced, duration unstated
    { video: "clip-1", seconds: 0 },
    { video: "clip-1", seconds: 4.5 },
    { video: "clip-1", seconds: "10" },
    { video: "clip-1", seconds: VIDEO_INPUT_MAX_SECONDS + 1 },
    "clip-1", // a bare string is not an entry this server can certify
    [{ video: "a", seconds: 5 }, { video: "b" }], // one indeterminable entry poisons all
    Array.from({ length: VIDEO_INPUT_MAX_COUNT + 1 }, (_, i) => ({
      video: `clip-${i}`,
      seconds: 1,
    })),
  ]) {
    expect(videoEditSpecOf({ seconds: 8, input })).toEqual({
      ok: false,
      issue: { code: "video_input_spec_indeterminable", field: "input" },
    });
  }
});

test("the generation side keeps 19.1's own guard (an unfixed output duration refuses)", () => {
  expect(videoEditSpecOf({ input: { video: "c", seconds: 5 } }).ok).toBe(false);
});

// ── the ceiling: input cost included when the upstream charges (AC1) ──

function enable(input: {
  dims: PriceSnapshotDims;
  request: unknown;
  requestType?: "edit" | "remix";
}) {
  return assessVideoEditEnablement({
    dims: input.dims,
    tierTable: videoTierPriceTableFromSnapshot(input.dims),
    request: input.request,
    ...(input.requestType !== undefined
      ? { requestType: input.requestType }
      : {}),
  });
}

test("the ceiling covers output seconds AND input seconds — both sides priced (AC1)", () => {
  const dims = editDims("0.01", "0.002");
  const verdict = enable({
    dims,
    request: {
      seconds: 8,
      input: [
        { video: "a", seconds: 10 },
        { video: "b", seconds: 4 },
      ],
    },
  });
  if (!verdict.enabled) throw new Error("must enable");
  expect(verdict.quantities.video).toBe(8);
  expect(verdict.quantities.video_input).toBe(14);
  const ceiling = computeReservationCeiling({
    dims: videoEditCeilingDims(
      dims,
      verdict.perSecondUsd,
      verdict.inputPerSecondUsd,
    ),
    quantities: verdict.quantities,
    rate: RATE_100,
  });
  // 8 × $0.01 + 14 × $0.002 = $0.08 + $0.028 = $0.108 → 10.8 credits → 1080 scaled units exact.
  expect(ceiling).toMatchObject({ ok: true, maximumCredits: 1080 });
});

test("an upstream that charges nothing for inputs is EXPLICIT FREE, with evidence (Resume hint)", () => {
  const dims = editDims("0.01", "0");
  const verdict = enable({
    dims,
    request: { seconds: 8, input: { video: "a", seconds: 30 } },
  });
  if (!verdict.enabled) throw new Error("a known 0 is a price, not a gap");
  expect(verdict.inputPerSecondUsd).toBe("0");
  // The input side contributes zero seconds' cost; the ceiling is the output side alone.
  const ceiling = computeReservationCeiling({
    dims: videoEditCeilingDims(
      dims,
      verdict.perSecondUsd,
      verdict.inputPerSecondUsd,
    ),
    quantities: verdict.quantities,
    rate: RATE_100,
  });
  expect(ceiling).toMatchObject({ ok: true, maximumCredits: 800 });
});

test("a missing input rate refuses with the dimension named — never a silent free (AC4)", () => {
  const verdict = enable({
    dims: editDims("0.01", "unknown"),
    request: { seconds: 8, input: { video: "a", seconds: 10 } },
  });
  expect(verdict).toEqual({
    enabled: false,
    issue: {
      code: "video_input_price_unknown",
      dimension: "video_input",
      reason: "price_dim_no_source",
    },
  });
});

test("an unreadable input rate is named as unreadable, never laundered to free", () => {
  const verdict = enable({
    dims: editDims("0.01", "unreadable"),
    request: { seconds: 8, input: { video: "a", seconds: 10 } },
  });
  expect(verdict).toEqual({
    enabled: false,
    issue: {
      code: "video_input_price_unknown",
      dimension: "video_input",
      reason: "price_dim_unreadable",
    },
  });
});

test("the output tier keeps its own refusal — an unpriced output refuses even with inputs priced", () => {
  const withUnknownOutput = {
    ...editDims("0.01", "0.002"),
    video: { status: "unknown" as const, reason: "price_dim_no_source" as const },
  } as PriceSnapshotDims;
  const verdict = enable({
    dims: withUnknownOutput,
    request: { seconds: 8, input: { video: "a", seconds: 10 } },
  });
  expect(verdict).toEqual({
    enabled: false,
    issue: {
      code: "video_tier_price_unknown",
      dimension: "video",
      reason: "price_dim_no_source",
    },
  });
});

// ── shared semantics with generation (AC3) ──

test("an edit's quantities are the generation shape plus the input side — same conversion, same path (AC3)", () => {
  const request = { seconds: 8, size: "1280x720", n: 2 };
  const generation = assessVideoGenerationEnablement({
    dims: editDims("0.01", "0.002"),
    tierTable: videoTierPriceTableFromSnapshot(editDims("0.01", "0.002")),
    request,
  });
  const edit = enable({
    dims: editDims("0.01", "0.002"),
    request: {
      ...request,
      input: [{ video: "a", seconds: 10 }],
    },
  });
  if (!generation.enabled || !edit.enabled) throw new Error("both must enable");
  // The output side is token-for-token the generation verdict's own quantities.
  expect(edit.quantities.video).toBe(generation.quantities.video);
  expect(edit.quantities.video_input).toBe(10);
  // Every other dimension: 0 in both — the shapes differ only by the input side.
  for (const dimension of PRICE_DIMENSIONS) {
    if (dimension !== "video" && dimension !== "video_input") {
      expect(edit.quantities[dimension]).toBe(0);
    }
  }
  // And the same 06.5 conversion prices the edit's whole quantity map in one call.
  const ceiling = computeReservationCeiling({
    dims: videoEditCeilingDims(
      editDims("0.01", "0.002"),
      edit.perSecondUsd,
      edit.inputPerSecondUsd,
    ),
    quantities: edit.quantities,
    rate: RATE_100,
  });
  expect(ceiling).toMatchObject({ ok: true, maximumCredits: 1800 });
});

test("remix prices through the same boundary — the quantities are identical for the same spec (AC3)", () => {
  const edit = enable({
    dims: editDims("0.01", "0.002"),
    request: { seconds: 8, input: { video: "a", seconds: 10 } },
    requestType: "edit",
  });
  const remix = enable({
    dims: editDims("0.01", "0.002"),
    request: { seconds: 8, input: { video: "a", seconds: 10 } },
    requestType: "remix",
  });
  if (!edit.enabled || !remix.enabled) throw new Error("both must enable");
  expect(remix.quantities).toEqual(edit.quantities);
  expect(remix.spec.requestType).toBe("remix");
});

// ── the availability surface: the edit methods join the registry (19.2's read) ──

test("a cell enables generation but not edit when only the output side is priced", () => {
  const summary = summarizeVideoSpecAvailability({
    snapshots: [
      {
        ref: { provider: "p", model: "veo", capability: "video" },
        dims: editDims("0.01", "unknown"),
      },
    ],
  });
  const methods = summary.cells[0].methods;
  expect(methods.find((m) => m.method === "generation")).toMatchObject({
    state: "enabled",
  });
  expect(methods.find((m) => m.method === "edit")).toMatchObject({
    state: "price_unknown",
    missingDimensions: [
      { dimension: "video_input", reasonCode: "price_dim_no_source" },
    ],
  });
  expect(methods.find((m) => m.method === "remix")).toMatchObject({
    state: "price_unknown",
  });
});

test("both sides priced enables every method; both priced zero answers free", () => {
  const priced = summarizeVideoSpecAvailability({
    snapshots: [
      {
        ref: { provider: "p", model: "veo", capability: "video" },
        dims: editDims("0.01", "0.002"),
      },
    ],
  });
  for (const method of priced.cells[0].methods) {
    expect(method.state).toBe("enabled");
  }
  const free = summarizeVideoSpecAvailability({
    snapshots: [
      {
        ref: { provider: "p", model: "veo", capability: "video" },
        dims: editDims("0", "0"),
      },
    ],
  });
  for (const method of free.cells[0].methods) {
    expect(method.state).toBe("free");
  }
});

test("the overlay writes both rates into the locked dims and nothing else", () => {
  const locked = editDims("0.01", "0.002");
  const overlaid = videoEditCeilingDims(locked, "0.05", "0.001");
  expect(overlaid.video).toEqual({ status: "known", amount: "0.05" });
  expect(overlaid.video_input).toEqual({ status: "known", amount: "0.001" });
  for (const dimension of PRICE_DIMENSIONS) {
    if (dimension !== "video" && dimension !== "video_input") {
      expect(overlaid[dimension]).toEqual(locked[dimension]);
    }
  }
  // Generation's own overlay leaves the input slot exactly as the basis held it.
  const generationOverlaid = videoGenerationCeilingDims(locked, "0.05");
  expect(generationOverlaid.video_input).toEqual(locked.video_input);
});
