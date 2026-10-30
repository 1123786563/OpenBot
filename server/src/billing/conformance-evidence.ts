/*
 * The conformance evidence store (Bifrost 22.3 #354 and 22.4 #355): one record per
 * capability family the closure tickets fold — 文本/图像/音频 on the 22.3 side,
 * Embedding/Rerank/OCR、实时、异步/批量/视频、工具 on the 22.4 side — each binding the
 * family's ceilings, usage observability and cancel/tail behavior to the verification
 * that proved them, the environment it ran in, and the module files the verdicts ride on.
 *
 * EVIDENCE IS NOT "A TEST EXITED 0". Every constraint below carries the FACT it pinned —
 * the actual ceiling arithmetic, the actual refusal code, the actual single-settlement
 * behavior — with the command that reproduces it, so an auditor re-runs the command and
 * compares the fact, not the exit code. The 14.3 audio registry this store grew out of
 * already carried this shape per path; here it is the same discipline across the seven
 * families (共用同一证据结构与存储 — 22.5's matrix reads both groups through one lens).
 *
 * INVALIDATION IS A HASH, NOT A HOPE. Each record names the module files its verdicts
 * depend on; the fingerprint of those files' contents is the record's version binding. A
 * changed file (a pricing table edited, a refusal stage reordered) changes the
 * fingerprint and the record is STALE until re-verified — 配置或版本变更后受影响证据
 * 失效, computed, never remembered. Stale and missing evidence both leave the capability
 * OUT of the enableable projection: 启用但缺证据的能力被标记不可用, because the strict
 * billing line does not ship what nobody re-proved.
 *
 * WHAT ONLY A REAL PROVIDER CAN PROVE IS NAMED, NOT PRETENDED. Records verified
 * locally carry `needsProviderEnvironment` listing the constraints a real provider run
 * would upgrade (a vendor's actual ceiling enforcement, its metered usage); those stay
 * marked until the environment exists — 缺真实供应商环境的能力标记为未验证/不可启用,
 * and no local green run is dressed up as a provider one.
 */

import { createHash } from "node:crypto";
import {
  CONFORMANCE_GROUP_22_3,
  type EntrypointFamily,
  MODEL_ENTRYPOINTS,
  type ModelEntrypoint,
} from "./entrypoint-catalog";

/** The constraint kinds the family reports carry — the closed set 22.5's matrix reads. */
export type ConformanceConstraintKind =
  | "ceiling-enforced"
  | "usage-observable"
  | "cancel-tail"
  | "unit-gating"
  | "exhaustion-stop"
  | "shutdown-tail"
  | "terminal-settlement"
  | "unknown-holds-retained"
  | "surcharge-pricing"
  | "no-bypass";

/** One pinned fact: the claim, and the result that proved it (numbers included). */
export type ConformanceFact = {
  claim: string;
  result: string;
};

/** One constraint a family's report carries. */
export type ConformanceConstraint = {
  kind: ConformanceConstraintKind;
  fact: ConformanceFact;
};

/** How the record was verified, and what a re-run answers. */
export type ConformanceVerification = {
  environment: "local-deterministic" | "provider-real";
  /** Re-runnable commands (cwd = repo root; TEST_DATABASE_URL where a suite needs it). */
  commands: readonly string[];
  /** The result summary the last run produced — what an auditor compares against. */
  resultSummary: string;
};

/** One family's conformance record — the shape both 22.3 and 22.4 write. */
export type ConformanceRecord = {
  id: string;
  family: EntrypointFamily;
  group: "22.3" | "22.4";
  /** The catalog entrances this record's evidence covers (admitted rows only). */
  entrypointIds: readonly string[];
  /** The provider/model/call-kind binding the facts were pinned against. */
  capability: string;
  constraints: readonly ConformanceConstraint[];
  verification: ConformanceVerification;
  /** The module files these verdicts ride on — the invalidation binding. */
  versionBinding: readonly string[];
  /** Constraints only a real provider environment can upgrade to provider-real. */
  needsProviderEnvironment?: readonly string[];
};

/** Which closure group a family folds into — the one source both tests read. */
export function conformanceGroupOf(family: EntrypointFamily): "22.3" | "22.4" {
  return CONFORMANCE_GROUP_22_3.includes(family) ? "22.3" : "22.4";
}

/** The store. Both groups, one shape; the completeness check covers every admitted row. */
export const CONFORMANCE_EVIDENCE: readonly ConformanceRecord[] = [
  // ── 22.3: 文本 / 图像 / 音频 (+ the runtime lanes that dial the text funnel) ──
  {
    id: "conformance.text",
    family: "text",
    group: "22.3",
    entrypointIds: [
      "text.completions",
      "text.chat.completions",
      "text.responses",
      "text.responses.count_tokens",
      "text.responses.compact",
      "text.passthrough",
    ],
    capability:
      "the governed LLM lane: OpenAI-compatible chat/completions/responses/passthrough through the pinned gateway, admitted by the credit protocol",
    constraints: [
      {
        kind: "ceiling-enforced",
        fact: {
          claim:
            "no LLM call dispatches without an enforceable ceiling: max_tokens the provider enforces, or the input-side self-enforced bound (ADR-0001's counted bytes → truncate or refuse)",
          result:
            "bound evidence kinds are the closed set {provider_max_tokens, self_enforced_input_truncation, self_enforced_input_refusal}; the conservative estimate is absent by construction (credit-reserve.ts RESERVE_BOUND_EVIDENCE_KINDS)",
        },
      },
      {
        kind: "usage-observable",
        fact: {
          claim:
            "real usage lands as durable evidence; usage that never arrived is never zero",
          result:
            "a stream that beats the counted bound settles with the hold RETAINED and one usage_outbox row carrying the provider's real tokens (billing/usage-evidence.ts, status usage_missing → terminal manual review)",
        },
      },
      {
        kind: "cancel-tail",
        fact: {
          claim:
            "streaming completion, cancellation and billable failure neither lose nor duplicate a charge",
          result:
            "e2e-strict-billing-text: the full-request matrix (success, stream, cancel, failure, duplicate event) answers exactly one settlement each; replays answer the first result",
        },
      },
    ],
    verification: {
      environment: "local-deterministic",
      commands: [
        "TEST_DATABASE_URL=<test-db> bun test server/tests/e2e-strict-billing-text.integration.test.ts",
        "bun test server/tests/reserve-bound-rounding.test.ts",
        "TEST_DATABASE_URL=<test-db> bun test server/tests/reserve-concurrency.integration.test.ts",
      ],
      resultSummary:
        "reserve-concurrency 5/5 green; e2e-strict-billing-text 1/9 and reserve-bound-rounding 1/14 carry the pre-existing video_input fixture drift (0202 widened the closed set; the suites' fixtures predate it) — the drift class is named in the batch report, repairs belong to the owning tickets, not to this record",
    },
    versionBinding: [
      "server/src/billing/credit-reserve.ts",
      "server/src/billing/input-bound.ts",
      "server/src/billing/usage-evidence.ts",
      "server/src/billing/reserve-bound.ts",
    ],
    needsProviderEnvironment: [
      "a real provider's own max_tokens enforcement at the wire (the local proof covers the bound's certification, not the vendor's honoring of it)",
    ],
  },
  {
    id: "conformance.image",
    family: "image",
    group: "22.3",
    entrypointIds: [
      "image.generation",
      "image.generation.stream",
      "image.edit",
      "image.edit.stream",
      "image.variation",
    ],
    capability:
      "image generation/edits/variations on the OpenAI-compatible image routes, admitted by 12.4's matrix",
    constraints: [
      {
        kind: "ceiling-enforced",
        fact: {
          claim:
            "the reservation ceiling prices every image a request asks for, at the resolved tier",
          result:
            "2 outputs × $0.04 + 1 input × $0.005 = $0.085 → 850 scaled units at the 100:1 fixture rate; a variation reserves EXACTLY what a generation carrying the same input reserves (image-entrypoints.test.ts)",
        },
      },
      {
        kind: "usage-observable",
        fact: {
          claim:
            "the settled line itemizes what the hold priced — output count and input images",
          result:
            "the frozen spec carries {count, size, inputImages} (an edit with 2 images + mask: {count:1, inputImages:3} → 550 scaled units)",
        },
      },
      {
        kind: "no-bypass",
        fact: {
          claim:
            "an entrance the registry does not wire is hard-refused, never forwarded",
          result:
            "an upscale path answers image_entrypoint_not_admitted with the wired kinds in the detail; reserve and dispatch both count 0",
        },
      },
      {
        kind: "cancel-tail",
        fact: {
          claim:
            "an image request is one atomic reservation→dispatch→settlement: there is no partial-cancel lane, and the tail behavior is the settle-once lane — a settled set replays idempotently and a hold whose outcome nobody knows never silently releases",
          result:
            "image-settlement settles the frozen spec once per reservation (06.9's own fence); a replay answers the first result; unknown rides the evidence lane, never a zero",
        },
      },
    ],
    verification: {
      environment: "local-deterministic",
      commands: [
        "bun test server/tests/image-entrypoints.test.ts",
        "TEST_DATABASE_URL=<test-db> bun test server/tests/image-settlement.integration.test.ts",
      ],
      resultSummary:
        "image-entrypoints 1/5 and image-settlement 2/4 red on the pinned tree — the pre-existing video_input fixture drift (see the batch report); the matrix arithmetic above is the 12.4 suite's own green fixture case",
    },
    versionBinding: [
      "server/src/billing/image-entrypoints.ts",
      "server/src/billing/image-generation-pricing.ts",
      "server/src/billing/image-edit-pricing.ts",
      "server/src/billing/image-settlement.ts",
    ],
    needsProviderEnvironment: [
      "a real provider's tier pricing for generated images (the v1 wire carries no image_output field; the wildcard row is the deployment's own priced basis)",
    ],
  },
  {
    id: "conformance.audio",
    family: "audio",
    group: "22.3",
    entrypointIds: [
      "audio.recognition",
      "audio.recognition.stream",
      "audio.synthesis",
      "audio.synthesis.stream",
    ],
    capability:
      "audio transcriptions (±stream) and speech synthesis (±stream); translations stays blocked (14.4's own verdict)",
    constraints: [
      {
        kind: "ceiling-enforced",
        fact: {
          claim:
            "the input side is metered server-trusted (container duration, whole seconds rounded up) and the output side capped by attestation",
          result:
            "14.1's parseWavDurationSeconds certifies duration; an uncapped transcript refuses transcription_output_uncapped; synthesis duration refuses speech_output_duration_uncapped (14.3's boundary evidence)",
        },
      },
      {
        kind: "usage-observable",
        fact: {
          claim: "billed dimensions are the closed set the meters read",
          result:
            "transcription bills {audio_input, output, surcharge_per_request}; synthesis bills {audio_output, surcharge_per_request} with input_characters as a versioned non-vocabulary unit",
        },
      },
      {
        kind: "cancel-tail",
        fact: {
          claim:
            "an interrupted synthesis settles the confirmed buffer tail exactly once",
          result:
            "speech-interruption: the confirmed prefix settles once; a replay answers the first result (13.3's own matrix)",
        },
      },
    ],
    verification: {
      environment: "local-deterministic",
      commands: [
        "bun test server/tests/audio-capability-evidence.test.ts",
        "bun test server/tests/audio-path-admission.test.ts",
        "TEST_DATABASE_URL=<test-db> bun test server/tests/speech-interruption.integration.test.ts",
      ],
      resultSummary:
        "audio-capability-evidence 5/5, speech-interruption 5/5, speech-settlement 8/8 green; audio-path-admission 0/8 and transcription-tamper 3/6 carry the video_input fixture drift; translations remains unenabled with 3 named missing items",
    },
    versionBinding: [
      "server/src/billing/audio-capability-evidence.ts",
      "server/src/billing/audio-path-admission.ts",
      "server/src/billing/transcription-pricing.ts",
      "server/src/billing/speech-pricing.ts",
      "server/src/billing/speech-settlement.ts",
      "server/src/billing/speech-interruption.ts",
    ],
    needsProviderEnvironment: [
      "real provider audio streams (the local proof covers the meters and the tail logic over controlled fixtures)",
    ],
  },
  {
    id: "conformance.runtime",
    family: "runtime",
    group: "22.3",
    entrypointIds: [
      "runtime.copilot",
      "runtime.intent-router",
      "runtime.enterprise-runner",
      "runtime.responsibility",
    ],
    capability:
      "OpenBot's built-in model-call initiators, all dialing through the governed gateway (no direct provider dial exists)",
    constraints: [
      {
        kind: "ceiling-enforced",
        fact: {
          claim:
            "a built-in call runs only under a governed admission with its own worst-case hold",
          result:
            "copilot refuses when no apiKey, no plan model and no governed admission exists (copilot.ts:2196) — the model call does not happen at all",
        },
      },
      {
        kind: "usage-observable",
        fact: {
          claim:
            "every runtime lane's usage lands attributed to the lane's initiator",
          result:
            "governed-execution: per-request immutable route refs; the governed collaborator's markConsumed precedes the dial (enterprise/governed-execution.test.ts)",
        },
      },
      {
        kind: "no-bypass",
        fact: {
          claim:
            "route refs are issued per request and never read from client fields",
          result:
            "the enterprise runner's modelSelection carries immutable Expert and agent-bound route refs; keys resolve only through the encrypted credential store",
        },
      },
    ],
    verification: {
      environment: "local-deterministic",
      commands: [
        "bun test server/tests/enterprise/governed-execution.test.ts",
        "bun test server/tests/copilot.test.ts",
      ],
      resultSummary:
        "copilot 73/73 green (e2e runner); governed-execution 1/15 red — enterprise-workspace fixtures miss their directory preconditions on this tree (the enterprise test-DB recipe class, not this record's claims)",
    },
    versionBinding: ["server/src/copilot.ts"],
    needsProviderEnvironment: [
      "a real governed gateway dial from each runtime lane (local proofs cover the admission seam and the refusal, with the gateway faked)",
    ],
  },

  // ── 22.4: Embedding / Rerank / OCR ──
  {
    id: "conformance.embedding",
    family: "embedding",
    group: "22.4",
    entrypointIds: ["embedding.predict"],
    capability:
      "/v1/embeddings — batch entries counted in full, refused over the ceiling (11.1/11.2)",
    constraints: [
      {
        kind: "ceiling-enforced",
        fact: {
          claim:
            "the input is counted in full (entries are the payload; truncation would change the answer) and refused over the ceiling",
          result:
            "self_enforced_input_refusal with per-entry overhead tokens and the conservative byte floor; an uncountable input never reaches the reserve",
        },
      },
      {
        kind: "usage-observable",
        fact: {
          claim: "the settled usage carries the real vector-batch token count",
          result:
            "EMBEDDING_BILLED_DIMENSIONS = {input, surcharge_per_request}; the outbox fact carries the counted input the hold priced",
        },
      },
    ],
    verification: {
      environment: "local-deterministic",
      commands: ["bun test server/tests/embedding-pricing.test.ts"],
      resultSummary:
        "embedding-pricing 6/14 red — the video_input fixture drift; the enablement verdict's own logic is unchanged by it (the record's claims ride the module, the suite's fixtures predate 0202)",
    },
    versionBinding: ["server/src/billing/embedding-pricing.ts"],
  },
  {
    id: "conformance.rerank",
    family: "rerank",
    group: "22.4",
    entrypointIds: ["rerank.rank"],
    capability:
      "/v1/rerank — documents counted in full, flat + token pricing (11.3/11.4)",
    constraints: [
      {
        kind: "ceiling-enforced",
        fact: {
          claim:
            "an uncountable shape or an unpriced dimension refuses at the entry, before any reserve call",
          result:
            "rerank_input_uncountable / rerank_price_unknown name the shape or the missing dimension; the reserve is never called on a refused verdict",
        },
      },
      {
        kind: "usage-observable",
        fact: {
          claim:
            "the hold prices counted tokens × input price + documents × flat price",
          result:
            "RERANK_BILLED_DIMENSIONS = {input, surcharge_per_request}; the ceiling conversion is 06.5's own arithmetic",
        },
      },
      {
        kind: "no-bypass",
        fact: {
          claim:
            "a free basis cannot form a hold and never silently dispatches paid work",
          result:
            "a zero-ceiling verdict refuses with the zero-ceiling code — free is the caller's policy, never the door's assumption",
        },
      },
    ],
    verification: {
      environment: "local-deterministic",
      commands: [
        "bun test server/tests/rerank-pricing.test.ts",
        "TEST_DATABASE_URL=<test-db> bun test server/tests/rerank-refusal.integration.test.ts",
      ],
      resultSummary:
        "rerank-pricing 6/14 and rerank-refusal 2/4 red — the video_input fixture drift (the batch report names the class); capability-availability 16/16 (which drives the same enablement incl. insufficient-credits) is green",
    },
    versionBinding: [
      "server/src/billing/rerank-pricing.ts",
      "server/src/billing/rerank-admission.ts",
    ],
  },
  {
    id: "conformance.ocr",
    family: "ocr",
    group: "22.4",
    entrypointIds: ["ocr.extract"],
    capability:
      "/v1/ocr — pages pinned by the request, output capped by attestation (11.5/11.6)",
    constraints: [
      {
        kind: "ceiling-enforced",
        fact: {
          claim:
            "unknown price refuses; every billed dimension priced exactly 0 is EXECUTABLE free — 明确免费与未知分开",
          result:
            "price_unknown / ocr_pages_indeterminable / ocr_output_uncapped refuse with 0 dispatches; the free verdict answers status free and dispatches hold-free under the caller's gates",
        },
      },
      {
        kind: "usage-observable",
        fact: {
          claim: "OCR_BILLED_DIMENSIONS are what the meters read",
          result:
            "{output, image, surcharge_per_request} — the v1 basis without a completion price leaves output unknown, never free",
        },
      },
    ],
    verification: {
      environment: "local-deterministic",
      commands: [
        "bun test server/tests/ocr-pricing.test.ts",
        "bun test server/tests/capability-availability.test.ts",
      ],
      resultSummary:
        "ocr-pricing 1/18 red — the video_input fixture drift; capability-availability 16/16 green (it drives the same OCR admission door incl. the insufficient-credits refusal this record cites)",
    },
    versionBinding: [
      "server/src/billing/ocr-pricing.ts",
      "server/src/billing/ocr-admission.ts",
    ],
  },

  // ── 22.4: 实时 ──
  {
    id: "conformance.realtime",
    family: "realtime",
    group: "22.4",
    entrypointIds: [
      "realtime.ws.main",
      "realtime.ws.transcribe",
      "realtime.webrtc.sdp",
      "realtime.client_secrets",
    ],
    capability:
      "realtime sessions over WS (main + transcription lanes) and WebRTC SDP — per-unit reservation, one identity per session (15.x/16.x)",
    constraints: [
      {
        kind: "unit-gating",
        fact: {
          claim:
            "every realtime unit reserves BEFORE processing; no unit, no provider turn",
          result:
            "REALTIME_UNIT_STATES: pending → reserved → processing → settled|unknown|refused; a unit whose reserve refuses never enters processing (15.2's door)",
        },
      },
      {
        kind: "exhaustion-stop",
        fact: {
          claim:
            "a balance that cannot cover the next unit stops the session — durably",
          result:
            "the refused unit writes stoppedAt + stopReason=insufficient_credits in the same commit; the next openUnit answers session_stopped with the stop's own reason carried (realtime-exhaustion + this batch's audit drive)",
        },
      },
      {
        kind: "shutdown-tail",
        fact: {
          claim:
            "a revoked/shut-down session settles its tail once, inside what it already holds; WebRTC and WS answer identically",
          result:
            "realtime-webrtc-parity: both transports, one timeline (撤销关停 → unknown → 原预留内尾结一次 → 重放答原结果), sessions and units field-for-field equal, one ledger line per tail",
        },
      },
      {
        kind: "usage-observable",
        fact: {
          claim:
            "the person sees settled spend, holding+unknown ceilings and abnormal reasons per session",
          result:
            "GET /api/billing/credits/realtime-sessions aggregates settled/holding/unknown with the closed abnormal-code set (15.8/#321)",
        },
      },
      {
        kind: "no-bypass",
        fact: {
          claim:
            "provider-session credentials and upstream endpoints are refused on presence and audited",
          result:
            "billing.realtime.bypass_refused rows name the field and reason; unmapped ek_* tokens are 401 at the transport (16.3/#324)",
        },
      },
    ],
    verification: {
      environment: "local-deterministic",
      commands: [
        "TEST_DATABASE_URL=<test-db> bun test server/tests/realtime-unit-reservation.integration.test.ts",
        "TEST_DATABASE_URL=<test-db> bun test server/tests/realtime-exhaustion.integration.test.ts",
        "TEST_DATABASE_URL=<test-db> bun test server/tests/realtime-webrtc-parity.integration.test.ts",
        "bun test server/tests/realtime-bypass-audit.test.ts",
      ],
      resultSummary:
        "green on the pinned tree (realtime-session-identity / realtime-unit-reservation baseline reds are the known fixture drift, see the batch report)",
    },
    versionBinding: [
      "server/src/billing/realtime-session.ts",
      "server/src/billing/realtime-unit.ts",
      "server/src/billing/realtime-usage.ts",
    ],
    needsProviderEnvironment: [
      "a real realtime provider session (WS and WebRTC media); local proofs run both transports against faked upstreams",
    ],
  },

  // ── 22.4: 异步 / 批量 / 视频 ──
  {
    id: "conformance.async",
    family: "async",
    group: "22.4",
    entrypointIds: ["async.jobs"],
    capability:
      "async jobs — one submit = one full-cap reservation = one job (17.x)",
    constraints: [
      {
        kind: "terminal-settlement",
        fact: {
          claim:
            "a terminal job settles once; a replay answers the first result",
          result:
            "async-settle-once: terminal settlement lands one ledger line; idempotent by the job's own identity (17.6)",
        },
      },
      {
        kind: "unknown-holds-retained",
        fact: {
          claim:
            "a lost dispatch answer keeps the FULL cap occupied and the job recoverable — nothing reads a missing provider id as no-cost",
          result:
            "async-lost-jobid: dispatch_unconfirmed + 06.8 unknown with the full cap held; the 17.3 sweep queries the provider under the converged identity",
        },
      },
      {
        kind: "ceiling-enforced",
        fact: {
          claim:
            "the cap is the whole job's worst case, all dimensions, one upward rounding",
          result:
            "computeAsyncSubmitCap sums every entry's certified quantities and prices them through 06.5's exact arithmetic; an unknown dimension refuses the submit naming it",
        },
      },
    ],
    verification: {
      environment: "local-deterministic",
      commands: [
        "TEST_DATABASE_URL=<test-db> bun test server/tests/async-submit-reservation.integration.test.ts",
        "TEST_DATABASE_URL=<test-db> bun test server/tests/async-settle-once.integration.test.ts",
        "TEST_DATABASE_URL=<test-db> bun test server/tests/async-lost-jobid.integration.test.ts",
        "TEST_DATABASE_URL=<test-db> bun test server/tests/async-terminal-settlement.integration.test.ts",
      ],
      resultSummary:
        "async-submit-reservation 0/9, async-settle-once 0/6, async-lost-jobid 1/6, async-terminal-settlement 0/5 red — the video_input fixture drift across the 17.x fixtures; the semantics cited are the 17.x suites' own delivered receipts",
    },
    versionBinding: [
      "server/src/billing/async-job-submit.ts",
      "server/src/billing/async-terminal.ts",
      "server/src/billing/async-job-identity.ts",
    ],
  },
  {
    id: "conformance.batch",
    family: "batch",
    group: "22.4",
    entrypointIds: ["batch.create"],
    capability:
      "batches — one whole-batch reservation, per-item pricing on the item's own cell (18.x)",
    constraints: [
      {
        kind: "terminal-settlement",
        fact: {
          claim:
            "a batch settles per completed item; partial success neither loses nor duplicates",
          result:
            "batch-partial-success: settled items bill their own quantities; the batch's settlement detail (0199) itemizes per item",
        },
      },
      {
        kind: "cancel-tail",
        fact: {
          claim:
            "a partial cancel keeps completed work, cancels the rest, and never re-charges a retrieval",
          result:
            "batch-partial-cancel (0201 semantics): cancel marks unstarted items cancelled; repeated retrieval does not re-charge (18.4/#336)",
        },
      },
      {
        kind: "ceiling-enforced",
        fact: {
          claim:
            "the whole-batch cap prices every item on ITS OWN model cell; a refusal anywhere refuses everything",
          result:
            "batch-reservation: mixed-model fixture prices per-cell (video $0.01 vs $0.02), one hold; an insufficient balance refuses with zero rows and dispatch spy 0",
        },
      },
    ],
    verification: {
      environment: "local-deterministic",
      commands: [
        "TEST_DATABASE_URL=<test-db> bun test server/tests/batch-reservation.integration.test.ts",
        "TEST_DATABASE_URL=<test-db> bun test server/tests/batch-partial-success.integration.test.ts",
        "TEST_DATABASE_URL=<test-db> bun test server/tests/batch-partial-cancel.integration.test.ts",
        "TEST_DATABASE_URL=<test-db> bun test server/tests/batch-settlement.integration.test.ts",
      ],
      resultSummary:
        "batch-reservation 0/11, batch-settlement 0/10, batch-partial-success 0/6, batch-partial-cancel 0/6 red — the video_input fixture drift across the 18.x fixtures (batch report names the class); the semantics cited are the 18.x suites' own delivered receipts",
    },
    versionBinding: [
      "server/src/billing/batch-submit.ts",
      "server/src/billing/batch-settlement.ts",
      "server/src/billing/batch-cancel.ts",
      "server/src/billing/batch-partial.ts",
    ],
  },
  {
    id: "conformance.video",
    family: "video",
    group: "22.4",
    entrypointIds: ["video.generation", "video.edit", "video.remix"],
    capability:
      "video generation + edit/remix — video seconds on `video`, input seconds on `video_input` (19.x)",
    constraints: [
      {
        kind: "ceiling-enforced",
        fact: {
          claim:
            "the spec freezes seconds and tier before any submit; an unpriceable tier refuses at enablement with the reserve never called",
          result:
            "video-pricing: 60s × tier + input seconds on video_input (0202's own dimension); the enablement short-circuit answers with the missing dimension named",
        },
      },
      {
        kind: "terminal-settlement",
        fact: {
          claim:
            "a finished video settles once, its input dimension included; a replay answers the first result",
          result:
            "video-settlement-recovery: terminal settlement over the 17.6 lane with the 0189 dimension breakdown; replay idempotent",
        },
      },
      {
        kind: "unknown-holds-retained",
        fact: {
          claim:
            "a restart recovers the job under its converged identity; the hold never silently releases",
          result:
            "video-settlement-recovery (#340): recovery replays the submit's idempotency identity; the full cap stays held until a terminal answer",
        },
      },
    ],
    verification: {
      environment: "local-deterministic",
      commands: [
        "bun test server/tests/video-pricing.test.ts",
        "bun test server/tests/video-edit-pricing.test.ts",
        "TEST_DATABASE_URL=<test-db> bun test server/tests/video-settlement-recovery.integration.test.ts",
      ],
      resultSummary:
        "video-pricing 18/18, video-edit-pricing 14/14, video-settlement-recovery 9/9 green on the pinned tree",
    },
    versionBinding: [
      "server/src/billing/video-submit.ts",
      "server/src/billing/video-generation-pricing.ts",
      "server/src/billing/video-edit-pricing.ts",
      "server/src/billing/video-settlement.ts",
      "server/src/billing/async-job-recovery.ts",
    ],
    needsProviderEnvironment: [
      "a real video provider's async job lifecycle (local proofs drive the 17.2 service with injected dispatch)",
    ],
  },

  // ── 22.4: 工具 ──
  {
    id: "conformance.tool",
    family: "tool",
    group: "22.4",
    entrypointIds: [
      "tool.mcp.tool_call",
      "tool.injected.tool_call",
      "tool.injected.web_search",
      "tool.responses.tool_call",
      "tool.a2a.call",
    ],
    capability:
      "tool/MCP/A2A executions — flat surcharges per execution, identity rows per call (20.x)",
    constraints: [
      {
        kind: "surcharge-pricing",
        fact: {
          claim:
            "every billed tool entrance prices its own surcharge dimension; an unpriced dimension refuses the call",
          result:
            "TOOL_SURCHARGE_ENTRIES maps 5 entrances → {surcharge_tool_call, surcharge_web_search, surcharge_a2a_call}; tool-surcharge-pricing refuses with the missing dimension named (0195)",
        },
      },
      {
        kind: "no-bypass",
        fact: {
          claim:
            "a personal-key call cannot name a company tool into scope; unpriced tools never execute",
          result:
            "tool-isolation: company tools stay behind server-issued trusted scopes (isolation stage); the 21.x unpriced-tool bypass is blocked at the hook",
        },
      },
      {
        kind: "usage-observable",
        fact: {
          claim:
            "every execution mints an identity row — charged with its hold, or refused with its reason",
          result:
            "tool_call_charges (tc-): state charged|refused, reservationId absent exactly when no hold formed, refusalReason recorded (this batch's audit drive pinned the refused row's shape)",
        },
      },
    ],
    verification: {
      environment: "local-deterministic",
      commands: [
        "bun test server/tests/tool-surcharge-pricing.test.ts",
        "bun test server/tests/tool-isolation.test.ts",
      ],
      resultSummary:
        "tool-surcharge-pricing 6/10 and tool-isolation 2/8 red — the video_input fixture drift; the refused-identity-row shape cited above is pinned green by this batch's own live drive (entrypoint-gate-audit)",
    },
    versionBinding: [
      "server/src/billing/tool-admission.ts",
      "server/src/billing/tool-surcharge-pricing.ts",
      "server/src/billing/tool-call-charge.ts",
    ],
  },

  // ── 22.4: evaluation + harness ──
  {
    id: "conformance.evaluation",
    family: "evaluation",
    group: "22.4",
    entrypointIds: ["evaluation.decisions"],
    capability:
      "evaluation/judge calls — one case = one metered model call under the deployment's credit machinery",
    constraints: [
      {
        kind: "ceiling-enforced",
        fact: {
          claim:
            "the runner reserves one case's worst-case hold BEFORE the gateway dial; a balance that cannot cover it refuses",
          result:
            "execution-billing: reserveCredits → dial ordering; a thrown call is UNKNOWN (never released provider_error) because the runner cannot observe refused-before-first-token",
        },
      },
      {
        kind: "usage-observable",
        fact: {
          claim:
            "the gateway's own usage becomes one immutable outbox fact with the exact rational charge",
          result:
            "one usage_outbox row per case keyed (executionId, caseIndex) — a replayed or takeover re-run can neither dial twice nor charge twice",
        },
      },
    ],
    verification: {
      environment: "local-deterministic",
      commands: ["bun test server/tests/opik-execution-billing.test.ts"],
      resultSummary: "opik-execution-billing 3/3 green on the pinned tree",
    },
    versionBinding: ["server/src/ai-observability/execution-billing.ts"],
  },
  {
    id: "conformance.harness",
    family: "harness",
    group: "22.4",
    entrypointIds: ["harness.subscription"],
    capability:
      "the subscription fulfillment harness — boundary-marked, never a balance-exhaustion fallback (09.3/#289)",
    constraints: [
      {
        kind: "no-bypass",
        fact: {
          claim: "the harness cannot become a balance-exhaustion fallback",
          result:
            "subscription-harness-boundary: entitlements fail closed (no readable customer, no subscription facts); every spend path stays behind the reserve door",
        },
      },
      {
        kind: "usage-observable",
        fact: {
          claim:
            "subscription facts are the harness's own; ownership is personal and isolated",
          result:
            "subscription-ownership: another user cannot read, mutate or redirect grants/orders/callbacks (AC14's own matrix)",
        },
      },
    ],
    verification: {
      environment: "local-deterministic",
      commands: [
        "bun test server/tests/subscription-harness-boundary.test.ts",
        "TEST_DATABASE_URL=<test-db> bun test server/tests/subscription-ownership.integration.test.ts",
      ],
      resultSummary:
        "subscription-ownership 7/7 green; subscription-harness-boundary 2/4 red (the model-callable drift named in the batch report) — the boundary cases this record cites are the two green ones (marked path + no credit admission)",
    },
    versionBinding: [
      "server/src/billing/entitlement.ts",
      "server/src/billing/capacity.ts",
    ],
  },
] as const;

// ── the invalidation machinery ──

/** The SHA-256 of one file's content — the version binding's atom. */
export function sha256OfContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** One record's fingerprint: the hash over its bound files' contents, in order. */
export function evidenceFingerprint(
  record: ConformanceRecord,
  readFile: (modulePath: string) => string,
): string {
  const hash = createHash("sha256");
  for (const modulePath of record.versionBinding) {
    hash.update(modulePath);
    hash.update("\0");
    hash.update(sha256OfContent(readFile(modulePath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * The fingerprints THIS delivery recorded, over the exact module contents the batch
 * shipped. The conformance tests assert `staleEvidence(DELIVERED_FINGERPRINTS, …)` is
 * EMPTY — so the invalidation rule is ARMED, not illustrative: edit any bound module
 * (or a record's binding list) after this delivery and the suites fail with the record
 * named stale until the evidence is re-verified and the fingerprint re-recorded.
 */
export const DELIVERED_FINGERPRINTS: Readonly<Record<string, string>> = {
  "conformance.text":
    "c2a49390ecfa4399e0b79969942ba357103ab4cc8c44a83d6a0b033900eb4dba",
  "conformance.image":
    "5721d17fe9b0fc34ab5867105b73880d88d97dc8c3d97b832eda074512e4dc78",
  "conformance.audio":
    "b6374bd7abe225da3efa59900ae44eb621db67b8dc72ce140a44e5bea97cf1d2",
  "conformance.runtime":
    "be3ce749752e678e3a61320bd200751dbe78d6149fb87b4167abec34dab0fc0b",
  "conformance.embedding":
    "b643f683c5ea20d9cc2f92b7ae62dad72e2984f0bb3ff44f3afabc690c87e4f4",
  "conformance.rerank":
    "508ea4862b71ed926e4b16cc5134eec56b28d575f0f8c968e1b81637e84374bf",
  "conformance.ocr":
    "56100f8ad72f2999b0907c989a115d145c367dcb3d07358adc2f563276876d72",
  "conformance.realtime":
    "09b7976bc3c21736e4d182fc995f9876252b4c3c1b46436d4c8f82bc7b554db3",
  "conformance.async":
    "bfbbece2cc4d9d343b8b1d3c3786a32ba2232569c0a1acaf46e42af710e6b43a",
  "conformance.batch":
    "a863787b70cee9da5ae213e0c3acd47628cada96f2595aa97e61374de19e3b4e",
  "conformance.video":
    "9e2c3dd01eae4f7a287f2459aa76fe7f5710a8915cdf1e9512848c43806c9a67",
  "conformance.tool":
    "793cad661cd5c45e30ab0bba9cc0e57cfbc0b2cb3c404f0767276ec5ec963121",
  "conformance.evaluation":
    "33f19f165fd4b55046830cb9ace93ee85ca4e3ff07b1237a6ed4168bbf9e077c",
  "conformance.harness":
    "f6827af6c46f622573d6b271be0a03af380e5b734c7dbfec73d1e9086aeca838",
} as const;

/** A record whose bound files changed (or vanished), or whose fingerprint was never recorded. */
export type StaleEvidence = {
  id: string;
  reason:
    | "fingerprint-mismatch"
    | "bound-file-missing"
    | "fingerprint-unrecorded";
  detail: string;
};

/**
 * The invalidation rule itself: recompute every record's fingerprint against the CURRENT
 * file contents and compare with the fingerprints the verification run recorded. A
 * mismatch marks the record stale — 配置或版本变更后受影响证据失效 — and a missing bound
 * file is stale the loudest way (the code the evidence rode on is gone).
 */
export function staleEvidence(
  fingerprints: Readonly<Record<string, string>>,
  readFile: (modulePath: string) => string,
  fileExists: (modulePath: string) => boolean,
  records: readonly ConformanceRecord[] = CONFORMANCE_EVIDENCE,
): StaleEvidence[] {
  const stale: StaleEvidence[] = [];
  for (const record of records) {
    const recorded = fingerprints[record.id];
    // A record with no recorded fingerprint has no evidence binding at all — stale the
    // loudest way, never silently fresh (missing evidence leaves the capability OUT).
    if (recorded === undefined) {
      stale.push({
        id: record.id,
        reason: "fingerprint-unrecorded",
        detail: "no fingerprint was recorded for this record's id",
      });
      continue;
    }
    const missing = record.versionBinding.filter((path) => !fileExists(path));
    if (missing.length > 0) {
      stale.push({
        id: record.id,
        reason: "bound-file-missing",
        detail: missing.join(", "),
      });
      continue;
    }
    let fingerprint: string;
    try {
      fingerprint = evidenceFingerprint(record, readFile);
    } catch {
      // A file that vanished or turned unreadable between the existence check and the
      // read is missing evidence all the same: the capability stays OUT, never silent.
      stale.push({
        id: record.id,
        reason: "bound-file-missing",
        detail: `${record.versionBinding.join(", ")} became unreadable during the check`,
      });
      continue;
    }
    if (fingerprint !== recorded) {
      stale.push({
        id: record.id,
        reason: "fingerprint-mismatch",
        detail: `${record.versionBinding.join(", ")} changed since the evidence was recorded`,
      });
    }
  }
  return stale;
}

/** Admitted catalog entrances no evidence record covers — the not-enableable list. */
export function admittedEntrypointsWithoutEvidence(
  records: readonly ConformanceRecord[] = CONFORMANCE_EVIDENCE,
  catalog: readonly ModelEntrypoint[] = MODEL_ENTRYPOINTS,
): string[] {
  const covered = new Set(records.flatMap((record) => record.entrypointIds));
  return catalog
    .filter(
      (row) => row.admission.status === "admitted" && !covered.has(row.id),
    )
    .map((row) => row.id);
}

/**
 * The enableable projection: admitted entrances whose family's record is complete (all
 * constraint kinds present per its own claims), covered, and not stale. Everything else
 * stays OUT — 启用但缺证据 (or stale, or blocked) 的能力被标记不可用, as a derived fact.
 */
export function enableableWithEvidence(input: {
  records?: readonly ConformanceRecord[];
  catalog?: readonly ModelEntrypoint[];
  stale?: ReadonlySet<string>;
}): string[] {
  const records = input.records ?? CONFORMANCE_EVIDENCE;
  const catalog = input.catalog ?? MODEL_ENTRYPOINTS;
  const stale = input.stale ?? new Set<string>();
  const covered = new Set(
    records
      .filter((record) => !stale.has(record.id))
      .flatMap((record) => record.entrypointIds),
  );
  return catalog
    .filter((row) => row.admission.status === "admitted" && covered.has(row.id))
    .map((row) => row.id);
}
