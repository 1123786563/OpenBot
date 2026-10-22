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
  VIDEO_GENERATION_BILLED_DIMENSIONS,
  VIDEO_GENERATION_MAX_SECONDS,
  assessVideoGenerationEnablement,
  videoGenerationCeilingDims,
  videoGenerationSpecOf,
  videoTierPriceTableFromSnapshot,
  resolveVideoTierPrice,
} from "../src/billing/video-generation-pricing";
import {
  createVideoSubmitService,
  type VideoSubmitOutcome,
} from "../src/billing/video-submit";

/*
 * Ticket 19.1 (#337) — the video-generation pricing boundary: the full billing-dimension
 * mapping (duration × resolution tier × clip count), the worst-case ceiling conversion,
 * the missing-price refusal that names its dimension, and the version lock the hold
 * stands on.
 *
 *   AC-1  视频的全部上游计费维度进入价格快照 — every dimension a video generation bills
 *         (seconds at the requested resolution/quality tier, per clip) reads from the
 *         price snapshot's own `video` slot through a tier table, never an estimate;
 *   AC-2  按请求规格的最坏情况成本完成一次性预留 — seconds × clip count priced at the
 *         tier's per-second rate, one 足额 ceiling through 06.5's exact arithmetic;
 *   AC-3  缺任一规格维度价格时标记 unknown 并拒绝 — an unpriced tier (or an unknown
 *         `video` dim) refuses BEFORE any hold, naming the dimension it is missing;
 *   AC-4  预留锁定当时价格快照与比例版本 — the module prices the LOCKED dims/rate it is
 *         handed (tier resolution + overlay), never a price of its own.
 *
 * Plus the submit wiring's own ordering: a refused enablement never reaches the reserve
 * door or the provider (dispatch spy = 0, no ledger seam touched).
 */

const RATE_100 = { numerator: 100n, denominator: 1n } as ConversionRate;

/** The v1 wire shape: no video field exists, so `video` maps unknown with no source. */
function v1Dims(): PriceSnapshotDims {
  const dims = {} as Record<(typeof PRICE_DIMENSIONS)[number], PriceDimState>;
  for (const dimension of PRICE_DIMENSIONS) {
    dims[dimension] = { status: "unknown", reason: "price_dim_no_source" };
  }
  return assertPriceSnapshotDims(dims, "fixture");
}

/**
 * A fully-priced basis whose `video` dim is known at `perSecondUsd` — the shape a curated
 * cell (or a future wire field) produces. Every other dimension known too: 06.5's own
 * conversion refuses an unknown dimension whatever its quantity, so the ceiling fixtures
 * stand on a complete basis the way the reserve door's own tests do.
 */
function videoDims(perSecondUsd: string): PriceSnapshotDims {
  const dims = {} as Record<(typeof PRICE_DIMENSIONS)[number], PriceDimState>;
  for (const dimension of PRICE_DIMENSIONS) {
    dims[dimension] =
      dimension === "video"
        ? { status: "known", amount: perSecondUsd }
        : { status: "known", amount: "0" };
  }
  return assertPriceSnapshotDims(dims, "fixture");
}

test("the billed-dimension set is the video second alone (the vocabulary's own slot)", () => {
  expect([...VIDEO_GENERATION_BILLED_DIMENSIONS]).toEqual(["video"]);
});

// ── the spec: fixed before any price is read (AC3's own sentence) ──

test("a spec fixes seconds, tier and clip count; absent tier fields are the model's own defaults", () => {
  const spec = videoGenerationSpecOf({
    seconds: 8,
    size: "1280x720",
    n: 2,
  });
  expect(spec).toEqual({
    ok: true,
    spec: {
      seconds: 8,
      size: "1280x720",
      quality: null,
      outputCount: 2,
      requestType: "generation",
    },
  });
});

test("seconds has no default: a duration nobody can name is a ceiling nobody can certify", () => {
  for (const request of [
    {},
    { seconds: undefined },
    { seconds: "8" },
    { seconds: 8.5 },
    { seconds: 0 },
    { seconds: -8 },
    { seconds: VIDEO_GENERATION_MAX_SECONDS + 1 },
  ]) {
    const spec = videoGenerationSpecOf(request);
    expect(spec).toEqual({
      ok: false,
      issue: { code: "video_spec_indeterminable", field: "seconds" },
    });
  }
});

test("clip count defaults to 1 and is guarded like the image line's own count", () => {
  expect(videoGenerationSpecOf({ seconds: 5 }).spec?.outputCount ?? 1).toBe(1);
  expect(videoGenerationSpecOf({ seconds: 5, n: 0 }).ok).toBe(false);
  expect(videoGenerationSpecOf({ seconds: 5, n: 101 }).ok).toBe(false);
  expect(videoGenerationSpecOf({ seconds: 5, n: "2" }).ok).toBe(false);
});

test("a tier field that is not a clean string refuses (never a guessed resolution)", () => {
  for (const field of ["size", "quality"]) {
    expect(
      videoGenerationSpecOf({ seconds: 5, [field]: " padded " }).ok,
    ).toBe(false);
    expect(videoGenerationSpecOf({ seconds: 5, [field]: 720 }).ok).toBe(false);
    // null/absent is the model's own default — a determined spec, not a guess.
    expect(videoGenerationSpecOf({ seconds: 5, [field]: null }).ok).toBe(true);
  }
});

// ── the tier table: per-(resolution, quality) rows, wildcard last (AC1) ──

test("a tier table resolves the exact (size, quality) row first, then the wildcard", () => {
  const table = [
    { size: "1280x720", quality: "standard", amount: "0.01" },
    { size: "1920x1080", quality: "premium", amount: "0.05" },
    { size: null, quality: null, amount: "0.03" },
  ];
  expect(
    resolveVideoTierPrice(table, { size: "1280x720", quality: "standard" }),
  ).toEqual({ ok: true, amount: "0.01" });
  // A tier with no exact row falls to the wildcard — never the nearest row's rate.
  expect(
    resolveVideoTierPrice(table, { size: "1280x720", quality: "premium" }),
  ).toEqual({ ok: true, amount: "0.03" });
  expect(
    resolveVideoTierPrice(table, { size: "1920x1080", quality: null }),
  ).toEqual({ ok: true, amount: "0.03" });
});

test("a known `video` amount fills exactly the wildcard row; an unknown dim leaves the table empty", () => {
  expect(videoTierPriceTableFromSnapshot(videoDims("0.04"))).toEqual([
    { size: null, quality: null, amount: "0.04" },
  ]);
  expect(videoTierPriceTableFromSnapshot(v1Dims())).toEqual([]);
});

// ── the enablement verdict and the worst-case conversion (AC2/AC3) ──

test("the worst case is seconds × clip count at the tier rate — one quantity on `video`", () => {
  const dims = videoDims("0.01");
  const verdict = assessVideoGenerationEnablement({
    dims,
    tierTable: videoTierPriceTableFromSnapshot(dims),
    request: { seconds: 8, size: "1280x720", quality: "standard", n: 3 },
  });
  expect(verdict.enabled).toBe(true);
  if (!verdict.enabled) return;
  expect(verdict.quantities.video).toBe(24);
  expect(verdict.free).toBe(false);
  expect(verdict.perSecondUsd).toBe("0.01");
  // The certified quantities price to exactly 24 × $0.01 × 100 = 24 scaled units, 足额.
  const ceiling = computeReservationCeiling({
    dims: videoGenerationCeilingDims(dims, verdict.perSecondUsd),
    quantities: verdict.quantities,
    rate: RATE_100,
  });
  expect(ceiling).toMatchObject({ ok: true, maximumCredits: 2400 });
});

test("per-tier prices convert exactly: two tiers, two ceilings, never one rate for all", () => {
  // The multi-tier fixture the Resume hint demands: 720p-standard and 1080p-premium at
  // different per-second rates price different worst cases for the same 10 seconds.
  const standard = assessVideoGenerationEnablement({
    dims: videoDims("0.02"),
    tierTable: [
      { size: "1280x720", quality: null, amount: "0.02" },
      { size: "1920x1080", quality: "premium", amount: "0.05" },
    ],
    request: { seconds: 10, size: "1280x720" },
  });
  const premium = assessVideoGenerationEnablement({
    dims: videoDims("0.05"),
    tierTable: [
      { size: "1280x720", quality: null, amount: "0.02" },
      { size: "1920x1080", quality: "premium", amount: "0.05" },
    ],
    request: { seconds: 10, size: "1920x1080", quality: "premium" },
  });
  if (!standard.enabled || !premium.enabled) throw new Error("tiers must enable");
  const standardCeiling = computeReservationCeiling({
    dims: videoGenerationCeilingDims(videoDims("0.02"), standard.perSecondUsd),
    quantities: standard.quantities,
    rate: RATE_100,
  });
  const premiumCeiling = computeReservationCeiling({
    dims: videoGenerationCeilingDims(videoDims("0.05"), premium.perSecondUsd),
    quantities: premium.quantities,
    rate: RATE_100,
  });
  expect(standardCeiling).toMatchObject({ ok: true, maximumCredits: 2000 });
  expect(premiumCeiling).toMatchObject({ ok: true, maximumCredits: 5000 });
});

test("a fractional exact cost rounds 足额 UP to the next whole unit", () => {
  const dims = videoDims("0.00015"); // 3 seconds × $0.00015 = $0.00045 → 4.5 scaled units → 5, 足额
  const verdict = assessVideoGenerationEnablement({
    dims,
    tierTable: videoTierPriceTableFromSnapshot(dims),
    request: { seconds: 3 },
  });
  if (!verdict.enabled) throw new Error("must enable");
  const ceiling = computeReservationCeiling({
    dims: videoGenerationCeilingDims(dims, verdict.perSecondUsd),
    quantities: verdict.quantities,
    rate: RATE_100,
  });
  if (!ceiling.ok) throw new Error("ceiling must certify");
  expect(ceiling.maximumCredits).toBe(5);
  expect(
    (ceiling.exactScaledUnits.numerator * 1n) / ceiling.exactScaledUnits.denominator,
    ).toBe(4n); // 4.5 exact: the ceiling is the next whole unit above it.
});

test("an unpriced tier (unknown `video` dim) refuses with the dimension named (AC3)", () => {
  const verdict = assessVideoGenerationEnablement({
    dims: v1Dims(),
    tierTable: videoTierPriceTableFromSnapshot(v1Dims()),
    request: { seconds: 8 },
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

test("an unreadable `video` amount is named as unreadable, never laundered to free", () => {
  const dims = { ...v1Dims(), video: { status: "unknown" as const, reason: "price_dim_unreadable" as const } };
  const verdict = assessVideoGenerationEnablement({
    dims,
    tierTable: [],
    request: { seconds: 8 },
  });
  expect(verdict).toEqual({
    enabled: false,
    issue: {
      code: "video_tier_price_unknown",
      dimension: "video",
      reason: "price_dim_unreadable",
    },
  });
});

test("an exactly-zero rate is FREE — a price, not a pass", () => {
  const dims = videoDims("0");
  const verdict = assessVideoGenerationEnablement({
    dims,
    tierTable: videoTierPriceTableFromSnapshot(dims),
    request: { seconds: 8 },
  });
  expect(verdict.enabled && verdict.free).toBe(true);
});

// ── the version lock (AC4): the module prices the basis it is HANDED ──

test("the overlay writes the tier's rate into the locked dims and nothing else (AC4)", () => {
  const locked = videoDims("0.02");
  const overlaid = videoGenerationCeilingDims(locked, "0.05");
  expect(overlaid.video).toEqual({ status: "known", amount: "0.05" });
  // A tier row priced above the dim's own wildcard rate is the price the hold locks.
  expect(locked.video).toEqual({ status: "known", amount: "0.02" });
  for (const dimension of PRICE_DIMENSIONS) {
    if (dimension !== "video") {
      expect(overlaid[dimension]).toEqual(locked[dimension]);
    }
  }
  // A second basis (the next snapshot version) resolves independently: the same spec
  // against v2's cheaper rate certifies a different ceiling without touching v1's.
  const v1ceiling = computeReservationCeiling({
    dims: videoGenerationCeilingDims(videoDims("0.02"), "0.02"),
    quantities: { ...zeroQuantities(), video: 10 },
    rate: RATE_100,
  });
  const v2ceiling = computeReservationCeiling({
    dims: videoGenerationCeilingDims(videoDims("0.01"), "0.01"),
    quantities: { ...zeroQuantities(), video: 10 },
    rate: RATE_100,
  });
  expect(v1ceiling).toMatchObject({ ok: true, maximumCredits: 2000 });
  expect(v2ceiling).toMatchObject({ ok: true, maximumCredits: 1000 });
});

function zeroQuantities() {
  return Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => [dimension, 0]),
  ) as Record<(typeof PRICE_DIMENSIONS)[number], number>;
}

// ── the submit wiring: refusal ordering, spy counts (AC2/AC3) ──

type SubmitSpy = {
  reserveCalls: number;
  dispatchCalls: number;
  submitted: (input: unknown) => Promise<VideoSubmitOutcome>;
};

function submitSpy(
  dims: PriceSnapshotDims,
  options: {
    reserveOutcome?: "reserved" | "refused";
    dispatchOutcome?: "answered" | "lost";
  } = {},
): SubmitSpy {
  let reserveCalls = 0;
  let dispatchCalls = 0;
  const tierTable = videoTierPriceTableFromSnapshot(dims);
  const service = createVideoSubmitService({
    resolveBasis: async () => ({ ok: true as const, dims, rate: RATE_100 }),
    asyncSubmit: async (input: unknown) => {
      reserveCalls += 1;
      const raw = input as { entries: unknown[] };
      if (options.reserveOutcome === "refused") {
        return {
          status: "refused" as const,
          reasonCode: "reserve_refused" as const,
          detail: {},
        };
      }
      dispatchCalls += raw.entries.length;
      return {
        status: "submitted" as const,
        created: true,
        jobId: "aj-video-1",
        reservationId: "cr-video-1",
        maximumCredits: 24,
        entryCount: 1,
        state: "submitted" as const,
        providerJobId: "prov-video-1",
      };
    },
    tierTableFor: async () => tierTable,
  });
  return {
    get reserveCalls() {
      return reserveCalls;
    },
    get dispatchCalls() {
      return dispatchCalls;
    },
    submitted: (input: unknown) =>
      service.submitVideo({
        submitIdempotencyKey: "video-submit-1",
        grantId: "grant-1",
        payer: { kind: "personal", id: "user-1" },
        model: { provider: "prov", model: "veo", capability: "video" },
        snapshotVersion: 3,
        rateVersion: 1,
        request: input,
      }),
  };
}

test("an unpriced spec refuses at the enablement stage: no submit, no dispatch (AC3)", async () => {
  const spy = submitSpy(v1Dims());
  const outcome = await spy.submitted({ seconds: 8 });
  expect(outcome).toEqual({
    status: "refused",
    stage: "enablement",
    reasonCode: "video_tier_price_unknown",
    detail: { code: "video_tier_price_unknown", dimension: "video", reason: "price_dim_no_source" },
  });
  expect(spy.reserveCalls).toBe(0);
  expect(spy.dispatchCalls).toBe(0);
});

test("an indeterminable spec refuses before any price is read", async () => {
  const spy = submitSpy(videoDims("0.01"));
  const outcome = await spy.submitted({ size: "1280x720" });
  expect(outlineStatus(outcome)).toBe("refused");
  if (outcome.status !== "refused") return;
  expect(outcome.reasonCode).toBe("video_spec_indeterminable");
  expect(spy.reserveCalls).toBe(0);
});

test("a priced spec submits exactly one entry carrying the worst-case seconds (AC2)", async () => {
  let seen: unknown;
  const service = createVideoSubmitService({
    resolveBasis: async () => ({ ok: true as const, dims: videoDims("0.01"), rate: RATE_100 }),
    asyncSubmit: async (input: unknown) => {
      seen = input;
      return {
        status: "submitted" as const,
        created: true,
        jobId: "aj-video-2",
        reservationId: "cr-video-2",
        maximumCredits: 24,
        entryCount: 1,
        state: "submitted" as const,
        providerJobId: "prov-video-2",
      };
    },
    tierTableFor: async () => [{ size: null, quality: null, amount: "0.01" }],
  });
  const outcome = await service.submitVideo({
    submitIdempotencyKey: "video-submit-2",
    grantId: "grant-1",
    payer: { kind: "personal", id: "user-1" },
    model: { provider: "prov", model: "veo", capability: "video" },
    snapshotVersion: 3,
    rateVersion: 1,
    request: { seconds: 8, n: 3 },
  });
  expect(outcome.status).toBe("submitted");
  const request = seen as { entries: { quantities: Record<string, number> }[] };
  expect(request.entries).toEqual([{ quantities: { video: 24 } }]);
});

test("a door refusal passes through as the submit's own refusal", async () => {
  const spy = submitSpy(videoDims("0.01"), { reserveOutcome: "refused" });
  const outcome = await spy.submitted({ seconds: 8 });
  expect(outcome).toEqual({
    status: "refused",
    stage: "submit",
    reasonCode: "reserve_refused",
    detail: {},
  });
  expect(spy.dispatchCalls).toBe(0);
});

function outlineStatus(outcome: VideoSubmitOutcome): string {
  return outcome.status;
}
