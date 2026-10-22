import { deflateSync } from "node:zlib";
import { expect, test } from "../../tests/support/bun-test-compat";
import {
  IMAGE_ENTRYPOINTS,
  IMAGE_ENTRYPOINT_KINDS,
  admitImageEntrypoint,
  type ImageEntrypointKind,
} from "../src/billing/image-entrypoints";
import {
  PRICE_DIMENSIONS,
  assertPriceSnapshotDims,
  type PriceDimState,
  type PriceSnapshotDims,
} from "../src/gateway/price-snapshot";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import { computeReservationCeiling } from "../src/billing/reserve-bound";
import { imageTierPriceTableFromSnapshot } from "../src/billing/image-generation-pricing";

/*
 * Bifrost #305 (12.4): the image entrypoint matrix — generation, edits and variations
 * share ONE admission, and nothing that reached a provider did so unbudgeted.
 *
 * THE ENUMERATION IS THE EVIDENCE. The registry's entrypoints are pinned to the gateway's
 * own route tables (the source anchors name the provider file that serves the route), so
 * "全部图像入口" means the set the wire actually carries — generations and its stream,
 * edits and its stream, variations (no stream variant exists upstream) — never a list
 * presumed from capability names. An image-processing entrance the registry does not wire
 * (an upscale path, a provider-specific edit dialect) is HARD-REFUSED with its own code:
 * 未接入准入的入口被硬拒绝而不是放行, the group-12 stitching this ticket owns.
 *
 * 供应商调用数为 0, PROVED DETERMINISTICALLY. The dispatch handle is injected and
 * counted: admission calls it only after the enablement verdict enabled AND the reserve
 * door held — every refusal world in this file (unpriced tier, insufficient balance, an
 * unwired entrance) asserts the counter stayed at zero, which is the caller-side half of
 * the AC's own sentence, and the reserve door's zero-write guarantee is the account half
 * (proven on the real database by the reserve suite this matrix rides on).
 *
 * VARIATIONS ARE GENERATIONS, BILLING-WISE. A variation carries one input image and n
 * generated outputs at a (size, —) tier: the shared enablement certifies exactly the same
 * quantities a generation carrying that input certifies (image_output = n, image = 1),
 * the same ceiling prices them, and the frozen spec the settlement stage reads is the
 * same shape — 与生成语义一致 is structural, not aspirational.
 */

// ── the fixture world (pure; the admission seam is injected) ──

const RATE_100 = { numerator: 100n, denominator: 1n } as ConversionRate;

/** A real 8-bit grayscale PNG of the given dimensions, as a base64 data URL. */
function pngDataUrl(width: number, height: number): string {
  const crc32 = (buf: Buffer): number => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k += 1) {
        c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
      }
    }
    return ~c >>> 0;
  };
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

/** A priced basis: every dimension known (the reserved slots explicitly free), input images $0.005. */
function pricedDims(): PriceSnapshotDims {
  const amounts: Record<string, string> = {
    input: "0.00000002",
    output: "0.00000003",
    reasoning: "0",
    image: "0.005",
    image_output: "0.04", // overlaid at the resolved tier price regardless
    audio_input: "0",
    audio_output: "0",
    cache_read: "0",
    cache_write: "0",
    video: "0",
    surcharge_web_search: "0",
    surcharge_per_request: "0",
    surcharge_tool_call: "0.002",
    surcharge_a2a_call: "0.003",
  };
  const dims = Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => [
      dimension,
      { status: "known", amount: amounts[dimension] },
    ]),
  ) as Record<PriceDimension, PriceDimState>;
  return assertPriceSnapshotDims(dims, "image-entrypoints fixture");
}

/** The v1-wire basis: image_output has no wire field — the tier table it fills is empty. */
function v1Dims(): PriceSnapshotDims {
  return { ...pricedDims(), image_output: { status: "unknown", reason: "price_dim_no_source" } };
}


type Door = {
  reserveCalls: { request: unknown }[];
  dispatchCalls: { reservationId: string; request: unknown }[];
  reserve: (request: unknown) => Promise<unknown>;
  dispatch: (reservationId: string, request: unknown) => Promise<void>;
};

/** The injected doors, counting every call — the proof 供应商调用数为 0 hangs on. */
function doors(reserveOutcome: (request: unknown) => unknown): Door {
  const door: Door = {
    reserveCalls: [],
    dispatchCalls: [],
    reserve: undefined as unknown as Door["reserve"],
    dispatch: undefined as unknown as Door["dispatch"],
  };
  door.reserve = async (request) => {
    door.reserveCalls.push({ request });
    return reserveOutcome(request);
  };
  door.dispatch = async (reservationId, request) => {
    door.dispatchCalls.push({ reservationId, request });
  };
  return door;
}

function held(request: unknown): unknown {
  const maximum = (request as { maximumCredits: number }).maximumCredits;
  return {
    status: "reserved",
    reservationId: `cr-image-entry-${doorCounter}`,
    attemptId: `att-image-entry-${doorCounter}`,
    maximumCredits: maximum,
    snapshotVersion: (request as { snapshotVersion: number }).snapshotVersion,
    rateVersion: (request as { rateVersion: number }).rateVersion,
  };
}

function refusedByDoor(reasonCode: string): (request: unknown) => unknown {
  return () => ({ status: "refused", reasonCode, detail: {} });
}

let doorCounter = 0;

/** The admission input for one entry kind over one request and basis. */
function admissionInput(
  kind: ImageEntrypointKind,
  request: unknown,
  dims: PriceSnapshotDims,
) {
  doorCounter += 1;
  return {
    kind,
    request,
    dims,
    // The tier table THE BASIS fills — empty from a v1 snapshot (image_output has no
    // wire field), the wildcard row from a basis that prices generated images.
    tierTable: imageTierPriceTableFromSnapshot(dims),
    rate: RATE_100,
    grantId: `grant-entry-${doorCounter}`,
    payer: { kind: "personal" as const, id: `user-entry-${doorCounter}` },
    model: {
      provider: `prov-entry-${doorCounter}`,
      model: `img-entry-${doorCounter}`,
      capability: "image" as const,
    },
    snapshotVersion: 1,
    rateVersion: 0,
    idempotencyKey: `idem-entry-${doorCounter}`,
  };
}


// ── AC3: the entrypoint enumeration, grounded in the gateway's own routes ──

test("the entrypoint registry enumerates the gateway's actual image routes, each with its anchor", () => {
  // The three route families the pinned gateway serves (openai.go's own route tables),
  // generations and edits with stream variants, variations without one — and nothing
  // else: no entrypoint exists that the registry does not name.
  expect(
    IMAGE_ENTRYPOINTS.map((entry) => `${entry.route}${entry.stream ? " (stream)" : ""}`),
  ).toEqual([
    "/v1/images/generations",
    "/v1/images/generations (stream)",
    "/v1/images/edits",
    "/v1/images/edits (stream)",
    "/v1/images/variations",
  ]);
  // Every registry row is wired to an assessor and carries the source anchor that names
  // the route in the gateway — the enumeration's evidence, 22.1's input.
  for (const entry of IMAGE_ENTRYPOINTS) {
    expect(IMAGE_ENTRYPOINT_KINDS).toContain(entry.kind);
    expect(entry.route.startsWith("/v1/images/")).toBe(true);
    expect(entry.sourceAnchor).toMatch(/openai\.go:\d+/);
  }
  // No route appears twice with the same stream flag — a duplicate row would be an
  // enumeration bug exactly the way a missing row would be.
  const identities = new Set(
    IMAGE_ENTRYPOINTS.map((entry) => `${entry.route}:${entry.stream}`),
  );
  expect(identities.size).toBe(IMAGE_ENTRYPOINTS.length);
});

// ── AC1 + AC4: the per-entry refusal matrix — 供应商调用数为 0 in every refusal world ──

test("an unpriced tier refuses every entrypoint before the reserve and the provider", async () => {
  const requests: Record<ImageEntrypointKind, unknown> = {
    generation: { model: "m", prompt: "a cat", n: 2, size: "1024x1024" },
    edit: {
      model: "m",
      prompt: "a cat in a hat",
      image: pngDataUrl(64, 64),
      n: 1,
      size: "1024x1024",
    },
    variation: {
      model: "m",
      image: pngDataUrl(64, 64),
      n: 2,
      size: "1024x1024",
    },
  };
  // The v1 basis: no wire field can price image_output, so the tier table is empty and
  // EVERY entry — generation, edit, variation — refuses with the tier-unknown code.
  for (const kind of IMAGE_ENTRYPOINT_KINDS) {
    const door = doors(held);
    const outcome = await admitImageEntrypoint({
      ...admissionInput(kind, requests[kind], v1Dims()),
      reserve: door.reserve,
      dispatch: door.dispatch,
    });
    expect(outcome).toMatchObject({
      status: "refused",
      stage: "enablement",
      reasonCode: "image_tier_price_unknown",
    });
    expect(door.reserveCalls).toHaveLength(0);
    expect(door.dispatchCalls).toHaveLength(0);
  }
});

test("an enabled verdict that the door refuses still never dispatches", async () => {
  const door = doors(refusedByDoor("insufficient_credits"));
  const outcome = await admitImageEntrypoint({
    ...admissionInput(
      "generation",
      { model: "m", prompt: "a cat", n: 2, size: "1024x1024" },
      pricedDims(),
    ),
    reserve: door.reserve,
    dispatch: door.dispatch,
  });
  expect(outcome).toMatchObject({
    status: "refused",
    stage: "reserve",
    reasonCode: "insufficient_credits",
  });
  expect(door.reserveCalls).toHaveLength(1); // the door was reached — and said no
  expect(door.dispatchCalls).toHaveLength(0); // so the provider was not
});

test("an entrance the registry does not wire is hard-refused with its own code", async () => {
  const door = doors(held);
  // An upscale path exists in the wild (provider-specific image processing); it is NOT
  // one of the wired image entrypoints, so it refuses — hard, named, and unbudgeted
  // exactly because nothing after this point would have priced it.
  const outcome = await admitImageEntrypoint({
    ...admissionInput("upscale" as ImageEntrypointKind, { image: pngDataUrl(64, 64) }, pricedDims()),
    reserve: door.reserve,
    dispatch: door.dispatch,
  });
  expect(outcome).toEqual({
    status: "refused",
    stage: "entrypoint",
    reasonCode: "image_entrypoint_not_admitted",
    detail: {
      kind: "upscale",
      wiredKinds: [...IMAGE_ENTRYPOINT_KINDS],
    },
  });
  expect(door.reserveCalls).toHaveLength(0);
  expect(door.dispatchCalls).toHaveLength(0);
});

// ── AC2 + AC3: variations reserve and settle on the generation semantics ──

test("a variation reserves exactly what a generation carrying the same input reserves", async () => {
  const input = pngDataUrl(64, 64);
  const variationDoor = doors(held);
  const variation = await admitImageEntrypoint({
    ...admissionInput(
      "variation",
      { model: "m", image: input, n: 2, size: "1024x1024" },
      pricedDims(),
    ),
    reserve: variationDoor.reserve,
    dispatch: variationDoor.dispatch,
  });
  const generationDoor = doors(held);
  const generation = await admitImageEntrypoint({
    ...admissionInput(
      "generation",
      { model: "m", prompt: "a cat", image: input, n: 2, size: "1024x1024" },
      pricedDims(),
    ),
    reserve: generationDoor.reserve,
    dispatch: generationDoor.dispatch,
  });

  // Both admitted, both dispatched exactly once, under holds of the SAME size — the
  // same quantities (image_output = 2 at the tier, image = 1 input) priced by the same
  // conversion, never a second semantics for the second entrance.
  expect(variation.status).toBe("dispatched");
  expect(generation.status).toBe("dispatched");
  if (variation.status !== "dispatched" || generation.status !== "dispatched") return;
  expect(variationDoor.dispatchCalls).toHaveLength(1);
  expect(generationDoor.dispatchCalls).toHaveLength(1);
  expect(variation.maximumCredits).toBe(generation.maximumCredits);

  // The ceiling both holds locked: 2 × $0.04 + 1 × $0.005 = $0.085 → 850 scaled units
  // at the fixture rate — 足额, and identical between the two entrances.
  const expected = computeReservationCeiling({
    dims: { ...pricedDims(), image_output: { status: "known", amount: "0.04" } },
    quantities: {
      ...Object.fromEntries(PRICE_DIMENSIONS.map((d) => [d, 0])),
      image_output: 2,
      image: 1,
    } as Parameters<typeof computeReservationCeiling>[0]["quantities"],
    rate: RATE_100,
  });
  expect(expected).toMatchObject({ ok: true, maximumCredits: 850 });
  expect(variation.maximumCredits).toBe(850);

  // The frozen spec the settlement stage will read — a variation settles through the
  // generation path's own line (input_images included), because the shapes are the same.
  expect(variation.requestedSpec).toEqual(generation.requestedSpec);
  expect(variation.requestedSpec).toMatchObject({
    count: 2,
    size: "1024x1024",
    inputImages: 1,
  });

  // And the hold each one took: the same maximum, one bound-evidence entry each.
  const variationReserve = variationDoor.reserveCalls[0].request as {
    maximumCredits: number;
  };
  const generationReserve = generationDoor.reserveCalls[0].request as {
    maximumCredits: number;
  };
  expect(variationReserve.maximumCredits).toBe(generationReserve.maximumCredits);
});

test("an edit entrance prices its input images through the same shared ceiling", async () => {
  const door = doors(held);
  const outcome = await admitImageEntrypoint({
    ...admissionInput(
      "edit",
      {
        model: "m",
        prompt: "a cat in a hat",
        image: [pngDataUrl(64, 64), pngDataUrl(512, 512)],
        mask: pngDataUrl(64, 64),
        n: 1,
        size: "1024x1024",
      },
      pricedDims(),
    ),
    reserve: door.reserve,
    dispatch: door.dispatch,
  });
  expect(outcome.status).toBe("dispatched");
  if (outcome.status !== "dispatched") return;
  // 1 × $0.04 + 3 inputs (two images + the mask) × $0.005 = $0.055 → 550 scaled units:
  // the edit's input cost rides the same quantities shape the matrix shares.
  expect(outcome.maximumCredits).toBe(550);
  expect(outcome.requestedSpec).toMatchObject({ count: 1, inputImages: 3 });
  expect(door.dispatchCalls).toHaveLength(1);
});
