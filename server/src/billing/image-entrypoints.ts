import type { ModelRef } from "../gateway/catalog";
import type { ConversionRate } from "../gateway/conversion-rate";
import {
  assessImageEditEnablement,
  type ImageEditSpec,
  imageEditSpecOf,
} from "./image-edit-pricing";
import {
  assessImageGenerationEnablement,
  type ImageGenerationSpec,
  type ImageTierPriceTable,
  imageGenerationCeilingDims,
  imageGenerationSpecOf,
} from "./image-generation-pricing";
import type { PayerRef } from "./payer";
import {
  computeReservationCeiling,
  type ReservationCeilingIssue,
} from "./reserve-bound";

/*
 * The image entrypoint matrix (Bifrost 12.4, #305): every entrance the image wire carries
 * — generation, edits, variations — shares ONE admission, and an entrance the matrix does
 * not wire is hard-refused, because an unbudgeted image call is the one thing strict
 * billing may not produce (the group-12 stitching point: 生成/编辑/变体三类入口端到端
 * 可演示且账务一致).
 *
 * THE ENUMERATION IS THE EVIDENCE. The registry below is pinned to the pinned gateway's
 * own route tables — each row's source anchor names the provider file that serves the
 * route — so "全部图像入口" means the set the wire actually carries: /v1/images/generations
 * and /v1/images/edits with their stream variants, /v1/images/variations (no stream
 * variant exists upstream). Image-processing entrances that exist in the wild but are NOT
 * wired here — a provider-specific upscale path is the live example — refuse with
 * `image_entrypoint_not_admitted`, their own code, never a passthrough and never a
 * free pass: the day one is wired, its row arrives WITH its admission, never before
 * (功能准入 per slice, not a hold-your-breath list for 22.x to audit later).
 *
 * ONE ADMISSION, THREE ENTRANCES. Variations ARE generations, billing-wise: a variation
 * carries one input image and n generated outputs at a (size, —) tier, which is exactly
 * the generation enablement's own input-image case (12.1 prices input images for the
 * edits shape, and the same assessor prices a variation's input) — so the variation
 * entrance routes through `assessImageGenerationEnablement` and the hold it takes is
 * token-for-token the hold a generation carrying that input takes. Edits route through
 * 12.3's assessor (every input probed to its own stated spec, the mask counted). The
 * ceiling is 06.5's own conversion through 12.1's overlay for all three; the settlement
 * stage downstream is 12.2's one path whose line already carries `input_images`.
 *
 * DISPATCH HAPPENS ONLY AFTER A HOLD. The provider handle is injected and called exactly
 * once, only on the admitted path (enablement enabled → ceiling certified → reserve
 * held): every refusal world — an unpriced tier, a door refusal (balance above all), an
 * unwired entrance — leaves it uncalled, which is the caller-side half of 供应商调用数
 * 为 0; the account half is the reserve door's own zero-write guarantee.
 *
 * WHO CALLS THIS. The deployment's image entrances, with the production reserve being
 * 06.2's CreditReserveService and the production dispatch being the gateway call the
 * hold committed to. Both are injected: this module owns the matrix and the ordering,
 * never the money and never the wire.
 */

/** The image entrance kinds the matrix wires. A new member arrives with its admission. */
export const IMAGE_ENTRYPOINT_KINDS = [
  "generation",
  "edit",
  "variation",
] as const;

export type ImageEntrypointKind = (typeof IMAGE_ENTRYPOINT_KINDS)[number];

/** One wired entrance: the route it serves, its stream flag, and the anchor naming it. */
export type ImageEntrypoint = {
  /** The entrance kind, mapped to its assessor below. */
  kind: ImageEntrypointKind;
  /** The gateway route this entrance serves (OpenAI-compatible wire). */
  route: string;
  /** True when the entrance is the route's streaming variant. */
  stream: boolean;
  /** Where the pinned gateway serves this route — the enumeration's own evidence. */
  sourceAnchor: string;
};

/**
 * The registry: the gateway's actual image routes, nothing presumed from capability
 * names. 22.1's full-entrypoint enumeration reads exactly this list (with its anchors) as
 * the image family's evidence.
 */
export const IMAGE_ENTRYPOINTS: readonly ImageEntrypoint[] = [
  {
    kind: "generation",
    route: "/v1/images/generations",
    stream: false,
    sourceAnchor: "bifrost core/providers/openai/openai.go:3759",
  },
  {
    kind: "generation",
    route: "/v1/images/generations",
    stream: true,
    sourceAnchor: "bifrost core/providers/openai/openai.go:3924",
  },
  {
    kind: "edit",
    route: "/v1/images/edits",
    stream: false,
    sourceAnchor: "bifrost core/providers/openai/openai.go:5489",
  },
  {
    kind: "edit",
    route: "/v1/images/edits",
    stream: true,
    sourceAnchor: "bifrost core/providers/openai/openai.go:5650",
  },
  {
    kind: "variation",
    route: "/v1/images/variations",
    stream: false,
    sourceAnchor: "bifrost core/providers/openai/openai.go:6070",
  },
] as const;

/** The frozen spec an admitted entrance hands its settlement stage (12.2's own shape). */
export type ImageEntrypointSpec = {
  count: number;
  size: string | null;
  quality: string | null;
  inputImages: number;
};

/** Why the matrix refused. Closed stages, one code vocabulary per stage. Displayable. */
export type ImageEntrypointRefusal =
  | {
      status: "refused";
      /** The entrance is not wired into admission — the hard refusal, never a pass. */
      stage: "entrypoint";
      reasonCode: "image_entrypoint_not_admitted";
      detail: { kind: string; wiredKinds: readonly ImageEntrypointKind[] };
    }
  | {
      status: "refused";
      /** The entrance's assessor refused before any price could form a hold. */
      stage: "enablement";
      reasonCode: string;
      detail: Record<string, unknown>;
    }
  | {
      status: "refused";
      /** The ceiling could not certify a hold over the enabled verdict. */
      stage: "ceiling";
      reasonCode: ReservationCeilingIssue["code"] | "free_basis_zero_ceiling";
      detail: Record<string, unknown>;
    }
  | {
      status: "refused";
      /** The reserve door refused — its own reason codes pass through unchanged. */
      stage: "reserve";
      reasonCode: string;
      detail: Record<string, unknown>;
    };

/** The dispatched answer: the hold taken, the spec frozen, the provider called once. */
export type ImageEntrypointDispatch = {
  status: "dispatched";
  reservationId: string;
  attemptId: string;
  /** The certified ceiling the hold locked — never below the exact worst case. */
  maximumCredits: number;
  /** The frozen spec the settlement stage (12.2) prices the result against. */
  requestedSpec: ImageEntrypointSpec;
  /** The entrance this dispatch came through — the matrix's own record. */
  entrypoint: ImageEntrypointKind;
};

export type ImageEntrypointOutcome =
  | ImageEntrypointDispatch
  | ImageEntrypointRefusal;

/** The environment the matrix runs in: the two doors, injected so tests count them. */
export type ImageEntrypointDependencies = {
  /** The reserve caller — 06.2's CreditReserveService in production. */
  reserve: (request: unknown) => Promise<{
    status: "reserved" | "refused";
    [field: string]: unknown;
  }>;
  /**
   * The provider dispatch — called exactly once per admitted request, ONLY after the
   * hold committed. In production this is the gateway call the hold committed to.
   */
  dispatch: (reservationId: string, request: unknown) => Promise<void>;
};

/** One admission request: the entrance, the wire request, and the locked basis. */
export type ImageEntrypointAdmissionInput = ImageEntrypointDependencies & {
  kind: ImageEntrypointKind;
  /** The image request as it will be sent (the entrance's own wire shape). */
  request: unknown;
  /** The locked basis's dims — the same version the reserve request will name. */
  dims: Parameters<typeof computeReservationCeiling>[0]["dims"];
  /** The tier table resolved FOR THE LOCKED BASIS (empty from a v1 snapshot). */
  tierTable: ImageTierPriceTable;
  /** The locked USD→credits conversion rate. */
  rate: ConversionRate;
  /** The authorization the dispatch runs under — the door re-proves it live. */
  grantId: string;
  /** The payment account claim — a claim; the door resolves the account server-side. */
  payer: PayerRef;
  /** The image model cell being admitted. */
  model: ModelRef;
  /** The price basis version the request locks. */
  snapshotVersion: number;
  /** The conversion-rate version the request locks. */
  rateVersion: number;
  /** The caller's retry identity; a replay answers the original reservation. */
  idempotencyKey: string;
};

/**
 * Admit one image entrance: unwired → hard refusal; wired → the entrance's assessor, the
 * shared ceiling, one reserve request, and only then the single dispatch. A refusal at
 * any stage leaves both doors untouched at that stage and answers with that stage's own
 * reason — the ordering is the guarantee the matrix exists for.
 */
export async function admitImageEntrypoint(
  input: ImageEntrypointAdmissionInput,
): Promise<ImageEntrypointOutcome> {
  if (!IMAGE_ENTRYPOINT_KINDS.includes(input.kind)) {
    // The hard refusal the AC names: an entrance without admission never reaches a
    // price, a hold, or a provider — it is refused AS an unwired entrance.
    return {
      status: "refused",
      stage: "entrypoint",
      reasonCode: "image_entrypoint_not_admitted",
      detail: {
        kind: input.kind as string,
        wiredKinds: IMAGE_ENTRYPOINT_KINDS,
      },
    };
  }

  // The entrance's own assessor: generation and variation share 12.1's (a variation is
  // the generation shape carrying an input image), edit uses 12.3's (probed inputs).
  const verdict =
    input.kind === "edit"
      ? assessImageEditEnablement({
          dims: input.dims,
          tierTable: input.tierTable,
          request: input.request,
        })
      : assessImageGenerationEnablement({
          dims: input.dims,
          tierTable: input.tierTable,
          request: input.request,
        });
  if (!verdict.enabled) {
    return {
      status: "refused",
      stage: "enablement",
      reasonCode: verdict.issue.code,
      detail: { ...verdict.issue },
    };
  }

  // The frozen spec the settlement stage prices against — the assessor's own extraction
  // (an enabled verdict already ran it), never re-derived here.
  const specValidation =
    input.kind === "edit"
      ? imageEditSpecOf(input.request)
      : imageGenerationSpecOf(input.request);
  if (!specValidation.ok) {
    // Unreachable behind the enabled verdict; kept so a spec nobody extracted can never
    // reach a settlement stage that would price a shape it never froze.
    return {
      status: "refused",
      stage: "enablement",
      reasonCode: "image_spec_indeterminable",
      detail: { field: "request" },
    };
  }
  const spec = specValidation.spec;

  // The shared ceiling: 06.5's conversion over the locked basis with the tier's price
  // riding `image_output` (12.1's overlay) — one arithmetic for all three entrances.
  const ceiling = computeReservationCeiling({
    dims: imageGenerationCeilingDims(input.dims, verdict.perImageUsd),
    quantities: verdict.quantities,
    rate: input.rate,
  });
  if (!ceiling.ok) {
    return {
      status: "refused",
      stage: "ceiling",
      reasonCode: ceiling.issue.code,
      detail: { ...ceiling.issue },
    };
  }
  if (ceiling.maximumCredits === 0) {
    // A free basis certifies a hold of zero, and the Reserve contract requires a
    // positive one — free is the caller's policy, never a silent pass.
    return {
      status: "refused",
      stage: "ceiling",
      reasonCode: "free_basis_zero_ceiling",
      detail: { requestedSpec: settlementSpec(spec) },
    };
  }

  const reserved = await input.reserve({
    grantId: input.grantId,
    payer: input.payer,
    model: input.model,
    snapshotVersion: input.snapshotVersion,
    rateVersion: input.rateVersion,
    // The image bound: the spec is frozen (count, size, quality, probed inputs) before
    // dispatch, so the certified quantities ARE the enforceable ceiling — the image
    // entrances' own mechanism, in the vocabulary's refusal-kind shape.
    boundEvidence: [
      { kind: "self_enforced_input_truncation", maximumTokens: 1 },
    ],
    maximumCredits: ceiling.maximumCredits,
    idempotencyKey: input.idempotencyKey,
  });
  if (reserved.status === "refused") {
    return {
      status: "refused",
      stage: "reserve",
      reasonCode: reserved.reasonCode as string,
      detail: (reserved.detail ?? {}) as Record<string, unknown>,
    };
  }

  // The one place a provider is reached — after the hold committed, once, under it.
  await input.dispatch(reserved.reservationId as string, input.request);

  return {
    status: "dispatched",
    reservationId: reserved.reservationId as string,
    attemptId: reserved.attemptId as string,
    maximumCredits: reserved.maximumCredits as number,
    requestedSpec: settlementSpec(spec),
    entrypoint: input.kind,
  };
}

/** The settlement-stage spec off the assessor's frozen spec (the edit's extra evidence stays admission-side). */
function settlementSpec(
  spec: ImageGenerationSpec | ImageEditSpec,
): ImageEntrypointSpec {
  return {
    count: spec.count,
    size: spec.size,
    quality: spec.quality,
    inputImages: spec.inputImages,
  };
}
