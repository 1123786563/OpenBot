import {
  PRICE_DIMENSIONS,
  type PriceDimensionUnknownReason,
  type PriceSnapshotDims,
} from "../gateway/price-snapshot";
import type { ReservationBoundQuantities } from "./reserve-bound";
import {
  imageGenerationSpecOf,
  resolveImageTierPrice,
  type ImageGenerationSpec,
  type ImageTierPriceTable,
} from "./image-generation-pricing";

/*
 * The image-edit pricing boundary (Bifrost 12.3, #304): the input-image cost folded into
 * the edit ceiling, the input determinability gate, and the SHARED reserve semantics with
 * generation — built directly on 12.1's boundary, not beside it.
 *
 * WHAT AN EDIT BILLS THAT A GENERATION DOES NOT. The input images the request carries —
 * the images to edit and the mask, at the per-input-image price (`image`, the one image
 * field the v1 wire really carries) — ON TOP of the generated images at the request's
 * size × quality tier (`image_output`, through 12.1's tier table and overlay). The mask
 * counts as an input image: an input nobody can prove is unbilled is an input the
 * ceiling covers, the only direction strict billing allows.
 *
 * THE INPUT MUST BE DETERMINABLE BEFORE DISPATCH. "输入图像数量与规格在派发前可确定，
 * 否则拒绝" is the AC's own sentence, and the proof is the payload itself: every input
 * entry must be image DATA this server can read — a PNG's IHDR names its own width and
 * height, a JPEG's SOF frame names its own — so `probeImageSpec` reads the spec the
 * container states, in 14.1's measured-not-believed discipline. A dynamic mask that does
 * not exist yet, a URL where data should be, an unsupported container: each answers null
 * and the request refuses BEFORE any price is consulted — a spec nobody can name is a
 * ceiling nobody can certify. An edit with no input images at all is not an edit, and
 * refuses the same way.
 *
 * SHARED SEMANTICS, NOT A SECOND SYSTEM (AC3). The verdict's quantities are the
 * generation shape exactly — `image_output: count`, `image: inputImages`, every other
 * dimension 0 — priced by 06.5's own `computeReservationCeiling` through 12.1's own
 * `imageGenerationCeilingDims` overlay, and settled by the same 12.2 settlement path
 * whose line already carries `input_images` (0179). An edit admission and a generation
 * admission differ only in what the spec froze, never in how the hold is priced.
 *
 * FREE IS A PRICE, AND IT NEEDS EVIDENCE. When upstream charges nothing for input
 * images, the snapshot records `image` as a KNOWN "0" — the wire's own field carrying
 * the evidence — and the input side contributes zero while still enabling. A blank or
 * unreadable input price is `unknown`, and unknown never degrades to a zero cost: the
 * verdict refuses with `image_input_price_unknown` (the Resume hint's rule: 留空会被判
 * unknown), and the pure v1 basis with no generated-image field refuses the tier exactly
 * as generation does.
 */

/**
 * The dimensions an image edit bills. `image_output` per generated image, `image` per
 * input image (the images to edit and the mask).
 */
export const IMAGE_EDIT_BILLED_DIMENSIONS = [
  "image_output",
  "image",
] as const;

/** One input image's frozen spec, read from the payload's own container. */
export type InputImageSpec = {
  readonly format: "png" | "jpeg";
  readonly width: number;
  readonly height: number;
};

/** The frozen edit spec: the generation side plus every input's probed spec. */
export type ImageEditSpec = {
  readonly count: number;
  readonly size: string | null;
  readonly quality: string | null;
  /** The input images billed: the images to edit plus the mask, when one rides along. */
  readonly inputImages: number;
  /** Each input's own stated spec, in request order — the determinability evidence. */
  readonly inputSpecs: readonly InputImageSpec[];
};

/** Why an edit request could not be fixed. Closed vocabulary, displayable. */
export type ImageEditSpecIssue =
  | { code: "image_spec_indeterminable"; field: "image" | "mask" | "n" | "size" | "quality" };

const DATA_URL =
  /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;
const BARE_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function base64Bytes(text: string): Uint8Array | null {
  const buffer = Buffer.from(text, "base64");
  // Buffer.from is lenient about invalid characters; a payload whose round-trip length
  // disagrees with its spelling is not data this server can certify.
  if (buffer.length === 0) return null;
  return new Uint8Array(buffer);
}

function pngDimensions(bytes: Uint8Array): InputImageSpec | null {
  // The signature (8 bytes) then IHDR: length (4), "IHDR" (4), width, height — big-endian.
  if (bytes.length < 24) return null;
  if (
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a ||
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) return null;
  return { format: "png", width, height };
}

function jpegDimensions(bytes: Uint8Array): InputImageSpec | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Walk the markers to the first frame header; SOF2 (progressive) carries the same
  // dimension fields as SOF0.
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2; // standalone markers carry no length
      continue;
    }
    const length = view.getUint16(offset + 2);
    const isFrame =
      (marker >= 0xc0 && marker <= 0xcf) &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrame) {
      if (offset + 8 > bytes.length) return null;
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      if (width === 0 || height === 0) return null;
      return { format: "jpeg", width, height };
    }
    offset += 2 + length;
  }
  return null;
}

/**
 * Read one input image's own stated spec from its payload: a `data:image/(png|jpeg)`
 * base64 URL (or bare base64, sniffed by magic bytes), probed through the container's
 * own header — IHDR for PNG, the first SOF frame for JPEG. Anything else — a URL, an
 * unsupported container, bytes that are not an image — answers null: 输入不可确定, the
 * refusal the AC names, never a guess about data this server could not read.
 */
export function probeImageSpec(source: string): InputImageSpec | null {
  const dataUrl = DATA_URL.exec(source);
  let bytes: Uint8Array | null;
  let format: "png" | "jpeg" | null = null;
  if (dataUrl) {
    bytes = base64Bytes(dataUrl[2]);
    format = dataUrl[1] === "png" ? "png" : "jpeg";
  } else if (BARE_BASE64.test(source)) {
    bytes = base64Bytes(source);
  } else {
    return null;
  }
  if (bytes === null) return null;
  if (format === "png") return pngDimensions(bytes);
  if (format === "jpeg") return jpegDimensions(bytes);
  // Bare base64: the container's own magic names the format — PNG or JPEG, the two this
  // meter reads; anything else is indeterminable by this server, honestly.
  return pngDimensions(bytes) ?? jpegDimensions(bytes);
}

type EditSpecValidation =
  | { ok: true; spec: ImageEditSpec }
  | { ok: false; issue: ImageEditSpecIssue };

/**
 * Fix the edit spec (AC2): the generation side (count, size, quality — 12.1's own guard,
 * the shared semantics) plus the input side — every input image probed to its own stated
 * spec, the mask included, at least one input image present. Anything indeterminable
 * refuses before a price is read.
 */
export function imageEditSpecOf(request: unknown): EditSpecValidation {
  const base = imageGenerationSpecOf(request);
  if (!base.ok) return base;

  const body = request as { image?: unknown; mask?: unknown };
  const images: unknown[] =
    body.image === undefined || body.image === null
      ? []
      : Array.isArray(body.image)
        ? body.image
        : [body.image];
  if (images.length === 0) {
    // An edit with no input images is not an edit: nothing to edit, nothing to bill the
    // input side on — and no spec anyone could certify.
    return {
      ok: false,
      issue: { code: "image_spec_indeterminable", field: "image" },
    };
  }

  const inputSpecs: InputImageSpec[] = [];
  for (const entry of images) {
    if (typeof entry !== "string") {
      return {
        ok: false,
        issue: { code: "image_spec_indeterminable", field: "image" },
      };
    }
    const probed = probeImageSpec(entry);
    if (probed === null) {
      return {
        ok: false,
        issue: { code: "image_spec_indeterminable", field: "image" },
      };
    }
    inputSpecs.push(probed);
  }

  const hasMask = body.mask !== undefined && body.mask !== null;
  if (hasMask) {
    if (typeof body.mask !== "string") {
      return {
        ok: false,
        issue: { code: "image_spec_indeterminable", field: "mask" },
      };
    }
    const maskSpec = probeImageSpec(body.mask);
    if (maskSpec === null) {
      return {
        ok: false,
        issue: { code: "image_spec_indeterminable", field: "mask" },
      };
    }
    inputSpecs.push(maskSpec);
  }

  return {
    ok: true,
    spec: {
      count: base.spec.count,
      size: base.spec.size,
      quality: base.spec.quality,
      inputImages: inputSpecs.length,
      inputSpecs,
    },
  };
}

/** Why an image edit cannot be enabled. Closed vocabulary, displayable. */
export type ImageEditEnablementIssue =
  | ImageEditSpecIssue
  /** The requested tier has no price on the basis — unknown is never a zero cost. */
  | { code: "image_tier_price_unknown" }
  /** Input images are billed and the input-image price is unknown (缺输入定价). */
  | {
      code: "image_input_price_unknown";
      reason: PriceDimensionUnknownReason;
    };

/** The verdict: enabled carries the quantities; refused carries the reason. */
export type ImageEditEnablement =
  | {
      enabled: true;
      /** True when both sides resolve to exactly "0": free is a price, not a pass. */
      free: boolean;
      /** The frozen edit spec, every input's own stated spec included. */
      spec: ImageEditSpec;
      /** The worst-case per-dimension quantities, in the generation shape (shared semantics). */
      quantities: ReservationBoundQuantities;
      /** The USD per generated image the tier resolved to — the basis the hold locks. */
      perImageUsd: string;
    }
  | { enabled: false; issue: ImageEditEnablementIssue };

/**
 * The image-edit enablement predicate (AC1–AC4): the spec fixed with every input
 * determinable, the tier priced, and the input-image price KNOWN — an explicitly free "0"
 * passes (free is a price with the snapshot field as its evidence), an unknown never
 * degrades to a zero cost. The dims handed in are the LOCKED basis's (06.5); this
 * function never reads a price of its own.
 */
export function assessImageEditEnablement(input: {
  dims: PriceSnapshotDims;
  /** The tier table resolved FOR THE LOCKED BASIS (empty from a v1 snapshot). */
  tierTable: ImageTierPriceTable;
  request: unknown;
}): ImageEditEnablement {
  const spec = imageEditSpecOf(input.request);
  if (!spec.ok) return { enabled: false, issue: spec.issue };

  const tier = resolveImageTierPrice(input.tierTable, spec.spec);
  if (!tier.ok) {
    return { enabled: false, issue: { code: "image_tier_price_unknown" } };
  }

  // An edit always carries inputs, so the input price is always a billed dimension here.
  const inputImage = input.dims.image;
  if (inputImage.status === "unknown") {
    return {
      enabled: false,
      issue: { code: "image_input_price_unknown", reason: inputImage.reason },
    };
  }

  const free = tier.amount === "0" && inputImage.amount === "0";

  // The certified worst-case quantities, in the generation shape exactly (AC3): the
  // count's generated images at the tier price and the request's input images (mask
  // included) — priced by the same 06.5 conversion through the same overlay, settled by
  // the same 12.2 path whose line carries `input_images`.
  const quantities = Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => [
      dimension,
      dimension === "image_output"
        ? spec.spec.count
        : dimension === "image"
          ? spec.spec.inputImages
          : 0,
    ]),
  ) as ReservationBoundQuantities;

  return {
    enabled: true,
    free,
    spec: spec.spec,
    quantities,
    perImageUsd: tier.amount,
  };
}

// The generation spec type is re-exported so callers of the edit boundary spell the
// frozen spec the way the shared settlement does.
export type { ImageGenerationSpec };
