import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { deflateSync } from "node:zlib";
import {
  assessImageEditEnablement,
  IMAGE_EDIT_BILLED_DIMENSIONS,
  imageEditSpecOf,
  probeImageSpec,
} from "../src/billing/image-edit-pricing";
import {
  imageGenerationCeilingDims,
  imageTierPriceTableFromSnapshot,
} from "../src/billing/image-generation-pricing";
import { computeReservationCeiling } from "../src/billing/reserve-bound";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import {
  assertPriceSnapshotDims,
  PRICE_DIMENSIONS,
  type PriceDimension,
  type PriceDimState,
  type PriceSnapshotDims,
} from "../src/gateway/price-snapshot";

/*
 * Bifrost #304 (12.3): the image-edit pricing boundary — the input-image cost folded into
 * the ceiling, the input determinability gate, and the shared reserve/settle semantics —
 * built on 12.1's image-generation boundary and priced through the same conversion.
 *
 * WHAT THE ACs DEMAND OF THESE TESTS:
 *   编辑请求的上限包含输入图像成本（当上游收费时）— a fixture with real input images
 *     (built PNGs, one a mask) composes a ceiling that covers BOTH the generated images at
 *     the tier price AND every input image at the per-input-image price — and a KNOWN
 *     input price of "0" (explicit free, the snapshot's own evidence) contributes nothing
 *     while still enabling.
 *   输入图像数量与规格在派发前可确定，否则拒绝 — real PNG/JPEG payloads probe to exact
 *     dimensions; a dynamic-mask placeholder, a non-image payload, an empty image set, or
 *     a mask nobody can read each refuse BEFORE any price is consulted.
 *   编辑与生成共用同一预留与结算语义 — the verdict's quantities are the generation
 *     shape exactly (image_output = count, image = inputs), priced by the same
 *     computeReservationCeiling through the same tier overlay.
 *   缺输入定价时标记 unknown 并拒绝 — an unknown `image` price refuses with
 *     image_input_price_unknown and never degrades to a zero cost; the pure v1 basis
 *     (image_output unknown) refuses the tier as unpriced, exactly as generation does.
 */

/** 100 credits per USD — with the ledger's ×100 scale, 1 USD = 10 000 units. */
const RATE_100: ConversionRate = { numerator: 100n, denominator: 1n };

const FULL_AMOUNTS: Readonly<Record<PriceDimension, string>> = {
  input: "0.0000001",
  output: "0.0000002",
  reasoning: "0.0000003",
  image: "0.005",
  image_output: "0.04",
  audio_input: "0.0001",
  audio_output: "0.0002",
  cache_read: "0.00000001",
  cache_write: "0.000000015",
  video: "0.01",
  video_input: "0.0001",
  surcharge_web_search: "0.001",
  surcharge_per_request: "0.0001",
  surcharge_tool_call: "0.002",
  surcharge_a2a_call: "0.003",
};

function dims(
  overrides: Partial<Record<PriceDimension, PriceDimState>> = {},
): PriceSnapshotDims {
  const base = {} as Record<PriceDimension, PriceDimState>;
  for (const dimension of PRICE_DIMENSIONS) {
    base[dimension] = { status: "known", amount: FULL_AMOUNTS[dimension] };
  }
  return assertPriceSnapshotDims(
    { ...base, ...overrides },
    "image-edit-pricing fixture",
  );
}

function unknown(
  reason:
    | "price_dim_no_source"
    | "price_dim_unreadable" = "price_dim_no_source",
): PriceDimState {
  return { status: "unknown", reason };
}

/** The wildcard tier table a basis that CAN price the generated image fills (12.1). */
const TIER_TABLE = imageTierPriceTableFromSnapshot(
  dims({ image_output: { status: "known", amount: "0.04" } }),
);

// ── the payload fixtures: real image containers the probe can read ──

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A real 8-bit grayscale PNG of the given dimensions, as a base64 data URL. */
function pngDataUrl(width: number, height: number): string {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const rows = Array.from({ length: height }, () =>
    Buffer.concat([Buffer.from([0]), Buffer.alloc(width)]),
  );
  const idat = deflateSync(Buffer.concat(rows));
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** A JPEG-shaped payload (SOI + SOF0 carrying the dimensions + EOI), as a data URL. */
function jpegDataUrl(width: number, height: number): string {
  const sof = Buffer.alloc(17);
  sof.writeUInt16BE(17 - 2, 0); // SOF0 segment length
  sof[2] = 8; // precision
  sof.writeUInt16BE(height, 3);
  sof.writeUInt16BE(width, 5);
  sof[7] = 1; // one component
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xc0]),
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

// ── AC2 (the probe): 规格 in the payload itself ──

describe("probeImageSpec", () => {
  test("reads a PNG's own stated dimensions from its IHDR", () => {
    expect(probeImageSpec(pngDataUrl(64, 32))).toEqual({
      format: "png",
      width: 64,
      height: 32,
    });
  });

  test("reads a JPEG's dimensions from its SOF frame header", () => {
    expect(probeImageSpec(jpegDataUrl(1536, 1024))).toEqual({
      format: "jpeg",
      width: 1536,
      height: 1024,
    });
  });

  test("unreadable payloads answer null — a say-so is not a spec", () => {
    expect(probeImageSpec("data:image/png;base64,aGVsbG8=")).toBeNull(); // "hello"
    expect(probeImageSpec("data:image/webp;base64,AAAA")).toBeNull(); // unsupported container
    expect(probeImageSpec("https://cdn.example/input.png")).toBeNull(); // a URL is not data
    expect(probeImageSpec("")).toBeNull();
  });

  test("legal data-URL spellings are not refused: MIME parameters and case", () => {
    const png = pngDataUrl(64, 32);
    const bare = png.slice("data:image/png;base64,".length);
    expect(probeImageSpec(`data:image/png;charset=utf-8;base64,${bare}`)).toEqual(
      { format: "png", width: 64, height: 32 },
    );
    expect(probeImageSpec(`data:image/PNG;base64,${bare}`)).toEqual({
      format: "png",
      width: 64,
      height: 32,
    });
  });

  test("a forged zero-length JPEG segment answers null instead of stalling the walk", () => {
    const forged = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xfe, 0x00, 0x00]), // COM marker declaring length 0
      Buffer.from([0xff, 0xd9]),
    ]).toString("base64");
    expect(probeImageSpec(`data:image/jpeg;base64,${forged}`)).toBeNull();
  });
});

// ── AC2 (the spec): determinable before dispatch, or refused ──

describe("imageEditSpecOf", () => {
  test("freezes the count, tier and every input's probed spec — mask included", () => {
    const spec = imageEditSpecOf({
      n: 2,
      size: "1024x1024",
      image: [pngDataUrl(64, 64), jpegDataUrl(512, 512)],
      mask: pngDataUrl(64, 64),
    });
    expect(spec).toMatchObject({
      ok: true,
      spec: {
        count: 2,
        size: "1024x1024",
        quality: null,
        inputImages: 3, // two inputs + the mask: an input nobody can prove is unbilled
        inputSpecs: [
          { format: "png", width: 64, height: 64 },
          { format: "jpeg", width: 512, height: 512 },
          { format: "png", width: 64, height: 64 },
        ],
      },
    });
  });

  test("a single string image is one input; n defaults to the wire's own 1", () => {
    const spec = imageEditSpecOf({ image: pngDataUrl(16, 16) });
    expect(spec).toMatchObject({
      ok: true,
      spec: { count: 1, inputImages: 1, size: null, quality: null },
    });
  });

  test("indeterminable inputs refuse before any price is consulted", () => {
    // A dynamic-mask placeholder: the bytes do not exist yet, so no spec can be named.
    expect(
      imageEditSpecOf({ image: pngDataUrl(16, 16), mask: { generate: true } }),
    ).toEqual({
      ok: false,
      issue: { code: "image_spec_indeterminable", field: "mask" },
    });
    // A payload that is not an image this server can read.
    expect(imageEditSpecOf({ image: "data:image/png;base64,aGVsbG8=" })).toEqual(
      {
        ok: false,
        issue: { code: "image_spec_indeterminable", field: "image" },
      },
    );
    // An edit with no input images at all is not an edit.
    expect(imageEditSpecOf({ n: 1 })).toEqual({
      ok: false,
      issue: { code: "image_spec_indeterminable", field: "image" },
    });
    // A mask that is a URL, not data.
    expect(
      imageEditSpecOf({ image: pngDataUrl(16, 16), mask: "https://x/m.png" }),
    ).toEqual({
      ok: false,
      issue: { code: "image_spec_indeterminable", field: "mask" },
    });
    // The generation side's own guard still applies to the edit's output count.
    expect(imageEditSpecOf({ image: pngDataUrl(16, 16), n: 0 })).toEqual({
      ok: false,
      issue: { code: "image_spec_indeterminable", field: "n" },
    });
  });
});

// ── AC1/AC3/AC4: the enablement verdict ──

describe("assessImageEditEnablement", () => {
  const REQUEST = {
    n: 2,
    size: "1024x1024",
    quality: "standard",
    image: [pngDataUrl(64, 64), pngDataUrl(32, 32)],
    mask: pngDataUrl(64, 64),
  };

  test("bills the generated side and the input side — both, always", () => {
    expect([...IMAGE_EDIT_BILLED_DIMENSIONS]).toEqual([
      "image_output",
      "image",
    ]);
  });

  test("the ceiling includes the input image cost and covers the worst case", () => {
    const verdict = assessImageEditEnablement({
      dims: dims(),
      tierTable: TIER_TABLE,
      request: REQUEST,
    });
    expect(verdict.enabled).toBe(true);
    if (!verdict.enabled) return;

    // Shared semantics (AC3): the generation quantities shape exactly.
    expect(verdict.quantities.image_output).toBe(2);
    expect(verdict.quantities.image).toBe(3);
    for (const dimension of PRICE_DIMENSIONS) {
      if (dimension === "image_output" || dimension === "image") continue;
      expect(verdict.quantities[dimension]).toBe(0);
    }

    const priced = computeReservationCeiling({
      dims: imageGenerationCeilingDims(dims(), verdict.perImageUsd),
      quantities: verdict.quantities,
      rate: RATE_100,
    });
    expect(priced.ok).toBe(true);
    if (!priced.ok) return;
    // 2 × $0.04 (generated) + 3 × $0.005 (inputs, mask included) = $0.095 → exactly 950
    // scaled units at the fixture rate — 足额, and never below the worst case.
    expect(priced.maximumCredits).toBeGreaterThanOrEqual(950 - 1e-6);
    expect(priced.maximumCredits).toBe(950);
  });

  test("an explicitly free input price enables and contributes nothing — free is a price", () => {
    const verdict = assessImageEditEnablement({
      dims: dims({
        image: { status: "known", amount: "0" },
        image_output: { status: "known", amount: "0" },
      }),
      tierTable: imageTierPriceTableFromSnapshot(
        dims({
          image: { status: "known", amount: "0" },
          image_output: { status: "known", amount: "0" },
        }),
      ),
      request: REQUEST,
    });
    expect(verdict).toMatchObject({ enabled: true, free: true });
    if (!verdict.enabled) return;
    const priced = computeReservationCeiling({
      dims: imageGenerationCeilingDims(
        dims({
          image: { status: "known", amount: "0" },
          image_output: { status: "known", amount: "0" },
        }),
        verdict.perImageUsd,
      ),
      quantities: verdict.quantities,
      rate: RATE_100,
    });
    expect(priced).toMatchObject({ ok: true, maximumCredits: 0 });
  });

  test("an unknown input price refuses — never a zero cost (AC4)", () => {
    const verdict = assessImageEditEnablement({
      dims: dims({ image: unknown() }),
      tierTable: TIER_TABLE,
      request: REQUEST,
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: {
        code: "image_input_price_unknown",
        reason: "price_dim_no_source",
      },
    });
    const unreadable = assessImageEditEnablement({
      dims: dims({ image: unknown("price_dim_unreadable") }),
      tierTable: TIER_TABLE,
      request: REQUEST,
    });
    expect(unreadable).toEqual({
      enabled: false,
      issue: {
        code: "image_input_price_unknown",
        reason: "price_dim_unreadable",
      },
    });
  });

  test("a pure v1 basis (no generated-image price) refuses the tier as unpriced", () => {
    const verdict = assessImageEditEnablement({
      dims: dims(),
      tierTable: [], // the v1 snapshot's own answer: no field prices the generated image
      request: REQUEST,
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: { code: "image_tier_price_unknown" },
    });
  });

  test("an indeterminable input refuses regardless of the prices", () => {
    const verdict = assessImageEditEnablement({
      dims: dims(),
      tierTable: TIER_TABLE,
      request: { n: 1, image: [pngDataUrl(16, 16)], mask: { later: true } },
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: { code: "image_spec_indeterminable", field: "mask" },
    });
  });
});
