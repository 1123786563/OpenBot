/*
 * The all-entrance model-call inventory (Bifrost 22.1, #352): every path that can trigger
 * a provider model call, enumerated from the surfaces that actually carry calls — the
 * pinned gateway's own route tables and hook registrations, and OpenBot's own model-call
 * initiators — never from ticket titles or capability names.
 *
 * THE ENUMERATION IS THE RECONCILIATION. Three families carry machine-enumerable
 * registries of their own (12.4's `IMAGE_ENTRYPOINTS`, 14.3's `AUDIO_CAPABILITY_EVIDENCE`,
 * 20.x's `TOOL_SURCHARGE_ENTRIES`); for those the catalog is CROSS-CHECKED against the
 * registry on every test run, both directions — a registry row without a catalog row is
 * an unregistered entrance (the AC's own failure: 新增入口未登记到清单时自动化检查失败),
 * and a catalog row without its registry row is a stale annotation. The remaining
 * families are pinned to the pinned gateway's route registrations
 * (transports/bifrost-http/handlers/inference.go's own `r.POST(...)` block) and the
 * governance plugin's hook surface, each row carrying the anchor that names where the
 * pinned commit serves it.
 *
 * ADMISSION STATUS IS PER ROW, AND A BLOCKED ROW IS A FINDING, NOT A GAP. 未接入准入的
 * 入口被列为阻塞项，不放行: the audio translations row is the live example — a real wire
 * path the gateway carries as a passthrough billing reference, with no input meter and no
 * admission wiring, held unenabled with its missing items named (14.4's own verdict). A
 * future entrance someone wires without admission lands here the same way: blocked, with
 * its reason, never silently absent.
 *
 * WHO CALLS THIS. 22.2 audits every admitted row (gate/payer/refusal/bypass);
 * 22.3/22.4 fold the rows into the conformance evidence store; 22.5 maps the AC matrix's
 * scenarios onto the rows. Pure module: the same sources always answer the same catalog.
 */

import { AUDIO_CAPABILITY_EVIDENCE } from "./audio-capability-evidence";
import { IMAGE_ENTRYPOINTS } from "./image-entrypoints";
import { TOOL_SURCHARGE_ENTRIES } from "./tool-surcharge-pricing";

/** The families the seven-family conformance split (22.3/22.4) groups rows by. */
export type EntrypointFamily =
  | "text"
  | "image"
  | "audio"
  | "embedding"
  | "rerank"
  | "ocr"
  | "realtime"
  | "async"
  | "batch"
  | "video"
  | "tool"
  | "evaluation"
  | "runtime"
  | "harness";

/** Which closure ticket's conformance group a family folds into. */
export const CONFORMANCE_GROUP_22_3: readonly EntrypointFamily[] = [
  "text",
  "image",
  "audio",
  "runtime",
];

export const CONFORMANCE_GROUP_22_4: readonly EntrypointFamily[] = [
  "embedding",
  "rerank",
  "ocr",
  "realtime",
  "async",
  "batch",
  "video",
  "tool",
  "evaluation",
  "harness",
];

/**
 * How the paying account is decided for an entrance — AC13's own two mechanisms plus the
 * built-in runtimes' one. Every row names exactly one; admission resolves it
 * server-side, never from a client field (the presence-refusal vocabularies enforce that).
 */
export type PayerSource =
  /** The grant's own user, resolved inside the door (06.4's discipline) — personal lanes. */
  | "grant-resolution"
  /** The workbench scope's company account (09.x) — company surfaces, all the way through. */
  | "workbench-company"
  /** The deployment's own model selection (server/src/index.ts) — built-in runtimes. */
  | "deployment-selection";

/** One row's admission verdict. `blocked` rows are findings; `absent` rows are checked-for. */
export type EntrypointAdmission =
  | {
      status: "admitted";
      /**
       * The refusal stages that precede dispatch, in order — each one's suites assert the
       * provider dispatch count is ZERO when it refuses (22.2's gate/refusal audit reads this).
       */
      stagesBeforeDispatch: readonly string[];
    }
  | {
      status: "blocked";
      /** Why the entrance cannot be admitted today, in the blocking registry's own words. */
      blockingReasons: readonly string[];
      /** The ticket whose semantic boundary owns the unblocking — fixes go there, not here. */
      ownerTicket: string;
    }
  | {
      status: "absent";
      /** What someone checked for and did not find — the enumeration's negative evidence. */
      checkedAbsence: string;
    };

/** One model-call entrance: the whole inventory's row shape. */
export type ModelEntrypoint = {
  /** Stable identity, `<family>.<surface>`, the conformance store and AC matrix reference. */
  id: string;
  family: EntrypointFamily;
  /** What triggers the provider call (the wire route, the hook, the runtime seam). */
  surface: string;
  /** Where the pinned commit serves (or refuses) this entrance — the enumeration's evidence. */
  sourceAnchor: string;
  /** The admission seam that gates it: a module that must exist, and the export that is the door. */
  admissionSeam: { module: string; door: string };
  payerSource: PayerSource;
  admission: EntrypointAdmission;
};

/** The gateway's own LLM funnel — every governed text-family route rides these stages. */
const TEXT_STAGES = [
  "pre-request (auth + access resolution)",
  "pre-llm (evaluation + credit reserve)",
  "post-llm (settlement + usage evidence)",
] as const;

/** The personal-key doors' shared stages (the shape discipline 06.4/09.3 own). */
const ENTRY_DOOR_STAGES = ["entry (shape + enablement)", "reserve (hold before dispatch)"] as const;

/** The inventory. Grounded per family; see the module header for the reconciliation rules. */
export const MODEL_ENTRYPOINTS: readonly ModelEntrypoint[] = [
  // ── text: the governed LLM lane (one funnel, every LLM-family route) ──
  {
    id: "text.completions",
    family: "text",
    surface: "POST /v1/completions",
    sourceAnchor:
      "bifrost/transports/bifrost-http/handlers/inference.go:871 (r.POST /v1/completions)",
    admissionSeam: { module: "server/src/billing/credit-reserve.ts", door: "creditProtocolEndpoints" },
    payerSource: "grant-resolution",
    admission: { status: "admitted", stagesBeforeDispatch: TEXT_STAGES },
  },
  {
    id: "text.chat.completions",
    family: "text",
    surface: "POST /v1/chat/completions",
    sourceAnchor:
      "bifrost/transports/bifrost-http/handlers/inference.go:872 (r.POST /v1/chat/completions); input bound ADR-0001 (server/src/billing/input-bound.ts)",
    admissionSeam: { module: "server/src/billing/credit-reserve.ts", door: "creditProtocolEndpoints" },
    payerSource: "grant-resolution",
    admission: { status: "admitted", stagesBeforeDispatch: TEXT_STAGES },
  },
  {
    id: "text.responses",
    family: "text",
    surface: "POST /v1/responses",
    sourceAnchor:
      "bifrost/transports/bifrost-http/handlers/inference.go:873 (r.POST /v1/responses); responsestools.go (hoisted request tools)",
    admissionSeam: { module: "server/src/billing/credit-reserve.ts", door: "creditProtocolEndpoints" },
    payerSource: "grant-resolution",
    admission: { status: "admitted", stagesBeforeDispatch: TEXT_STAGES },
  },
  {
    id: "text.responses.count_tokens",
    family: "text",
    surface: "POST /v1/responses/input_tokens",
    sourceAnchor:
      "bifrost/transports/bifrost-http/handlers/inference.go:892 (r.POST /v1/responses/input_tokens); core/schemas/bifrost.go (CountTokensRequest is a BifrostRequest member, so the same funnel sees it)",
    admissionSeam: { module: "server/src/billing/credit-reserve.ts", door: "creditProtocolEndpoints" },
    payerSource: "grant-resolution",
    admission: { status: "admitted", stagesBeforeDispatch: TEXT_STAGES },
  },
  {
    id: "text.responses.compact",
    family: "text",
    surface: "POST /v1/responses/compact — the compaction model call",
    sourceAnchor:
      "bifrost/transports/bifrost-http/handlers/inference.go:893 (r.POST /v1/responses/compact); core/schemas/bifrost.go (CompactionRequest rides the same funnel)",
    admissionSeam: { module: "server/src/billing/credit-reserve.ts", door: "creditProtocolEndpoints" },
    payerSource: "grant-resolution",
    admission: { status: "admitted", stagesBeforeDispatch: TEXT_STAGES },
  },
  {
    id: "text.passthrough",
    family: "text",
    surface: "Passthrough bodies forwarded as the provider reads them (body models evaluated per model)",
    sourceAnchor:
      "bifrost/plugins/governance/main.go:1256 (PreLLMHook — the passthrough branch evaluates every body model); core/providers/openai/passthrough_usage.go (billing classifier)",
    admissionSeam: { module: "server/src/billing/credit-reserve.ts", door: "creditProtocolEndpoints" },
    payerSource: "grant-resolution",
    admission: { status: "admitted", stagesBeforeDispatch: TEXT_STAGES },
  },

  // ── image: derived from 12.4's own registry (cross-checked, see reconcile below) ──
  ...IMAGE_ENTRYPOINTS.map<ModelEntrypoint>((entry) => ({
    id: `image.${entry.kind}${entry.stream ? ".stream" : ""}`,
    family: "image",
    surface: `${entry.route}${entry.stream ? " (stream)" : ""}`,
    sourceAnchor: entry.sourceAnchor,
    admissionSeam: { module: "server/src/billing/image-entrypoints.ts", door: "admitImageEntrypoint" },
    payerSource: "grant-resolution",
    admission: { status: "admitted", stagesBeforeDispatch: ENTRY_DOOR_STAGES },
  })),

  // ── audio: derived from 14.3's own evidence registry, verdicts included ──
  ...AUDIO_CAPABILITY_EVIDENCE.map<ModelEntrypoint>((record) => ({
    id: `audio.${record.family}${record.stream ? ".stream" : ""}`,
    family: "audio",
    surface: `${record.path}${record.stream ? " (stream)" : ""}`,
    sourceAnchor: record.sourceAnchor,
    admissionSeam: {
      module: "server/src/billing/audio-capability-evidence.ts",
      door: record.exists ? "enableableAudioPaths" : "audioPathsWithEvidenceGaps",
    },
    payerSource: "grant-resolution",
    admission: record.exists
      ? record.missingItems.length === 0
        ? { status: "admitted", stagesBeforeDispatch: ENTRY_DOOR_STAGES }
        : {
            status: "blocked",
            blockingReasons: record.missingItems.map((item) => `${item.code}: ${item.detail}`),
            ownerTicket: "#313 (14.4 未验证音频路径保持不可用)",
          }
      : {
          status: "absent",
          checkedAbsence: record.missingItems[0]?.detail ?? "no gateway entrypoint",
        },
  })),

  // ── embedding / rerank / ocr: the 11.x counted-input doors ──
  {
    id: "embedding.predict",
    family: "embedding",
    surface: "POST /v1/embeddings",
    sourceAnchor:
      "bifrost/transports/bifrost-http/handlers/inference.go:882 (r.POST /v1/embeddings)",
    admissionSeam: { module: "server/src/billing/embedding-pricing.ts", door: "assessEmbeddingEnablement" },
    payerSource: "grant-resolution",
    admission: { status: "admitted", stagesBeforeDispatch: ENTRY_DOOR_STAGES },
  },
  {
    id: "rerank.rank",
    family: "rerank",
    surface: "POST /v1/rerank",
    sourceAnchor:
      "bifrost/transports/bifrost-http/handlers/inference.go:883 (r.POST /v1/rerank)",
    admissionSeam: { module: "server/src/billing/rerank-admission.ts", door: "createRerankAdmission" },
    payerSource: "grant-resolution",
    admission: { status: "admitted", stagesBeforeDispatch: ENTRY_DOOR_STAGES },
  },
  {
    id: "ocr.extract",
    family: "ocr",
    surface: "POST /v1/ocr",
    sourceAnchor:
      "bifrost/transports/bifrost-http/handlers/inference.go:885 (r.POST /v1/ocr)",
    admissionSeam: { module: "server/src/billing/ocr-admission.ts", door: "createOcrAdmission" },
    payerSource: "grant-resolution",
    admission: { status: "admitted", stagesBeforeDispatch: ENTRY_DOOR_STAGES },
  },

  // ── realtime: the three transport entrances 15.x/16.x pinned ──
  {
    id: "realtime.ws.main",
    family: "realtime",
    surface: "GET /v1/realtime (+ OpenAI integration WS paths) — the main session upgrade",
    sourceAnchor:
      "bifrost/transports/bifrost-http/handlers/wsrealtime.go:66 (r.GET /v1/realtime + OpenAIRealtimePaths, in RegisterRoutes at :64); realtimeauthgate.go:12-14 (refuseUnauthenticatedRealtime — the admission gate for every realtime transport)",
    admissionSeam: { module: "server/src/billing/realtime-session.ts", door: "createRealtimeSessionService" },
    payerSource: "grant-resolution",
    admission: {
      status: "admitted",
      stagesBeforeDispatch: [
        "establish (posture/identity/reach/price)",
        "per-unit reserve (15.2's unit door)",
      ],
    },
  },
  {
    id: "realtime.ws.transcribe",
    family: "realtime",
    surface: "The transcription session lane of the same WS upgrade family",
    sourceAnchor:
      "bifrost/transports/bifrost-http/integrations/openai.go:3527-3530 (OpenAIRealtimePaths — the WS paths include the transcription lanes); webrtcrealtime.go (resolveRealtimeSDPTarget's transcriptionSession)",
    admissionSeam: { module: "server/src/billing/realtime-session.ts", door: "createRealtimeSessionService" },
    payerSource: "grant-resolution",
    admission: {
      status: "admitted",
      stagesBeforeDispatch: [
        "establish (posture/identity/reach/price)",
        "per-unit reserve (15.2's unit door)",
      ],
    },
  },
  {
    id: "realtime.webrtc.sdp",
    family: "realtime",
    surface: "POST the WebRTC SDP call routes (+ the legacy raw-SDP family)",
    sourceAnchor:
      "bifrost/transports/bifrost-http/handlers/webrtcrealtime.go:39-57 (RegisterRoutes: OpenAIRealtimeWebRTCCallsPaths as POST + legacy OpenAIRealtimePaths); integrations/openai.go:3560-3562",
    admissionSeam: { module: "server/src/billing/realtime-session.ts", door: "createRealtimeSessionService" },
    payerSource: "grant-resolution",
    admission: {
      status: "admitted",
      stagesBeforeDispatch: [
        "establish (posture/identity/reach/price)",
        "per-unit reserve (15.2's unit door)",
      ],
    },
  },

  {
    id: "realtime.client_secrets",
    family: "realtime",
    surface:
      "POST /v1/realtime/client_secrets (+ OpenAI integration paths) — the transport's provider call that MINTS a realtime client secret",
    sourceAnchor:
      "bifrost/transports/bifrost-http/handlers/realtime_client_secrets.go:156 (sessionProvider.CreateRealtimeClientSecret) and :210 (realtimeSessionRoutes); handlers/integrations.go:80 (the integration registration)",
    admissionSeam: { module: "server/src/billing/realtime-session.ts", door: "createRealtimeSessionService" },
    payerSource: "grant-resolution",
    admission: {
      status: "admitted",
      stagesBeforeDispatch: [
        "transport auth gate (refuseUnauthenticatedRealtime, the same gate every realtime transport mounts)",
        "single-use consumption at establishment (16.3/#324: an ek_bf_* secret is spent on first use; reuse is 401)",
      ],
    },
  },

  // ── async / batch / video: the full-cap reservation lanes ──
  {
    id: "async.jobs",
    family: "async",
    surface: "The async job lane — one submit = one full-cap reservation = one job",
    sourceAnchor:
      "server/src/billing/async-job-submit.ts (17.2's own service; the video line rides it); the dispatch seam is the gateway's async client, injected",
    admissionSeam: { module: "server/src/billing/async-job-submit.ts", door: "createAsyncSubmitService" },
    payerSource: "grant-resolution",
    admission: { status: "admitted", stagesBeforeDispatch: ["enablement (per-entry caps)", "reserve (hold before dispatch)"] },
  },
  {
    id: "batch.create",
    family: "batch",
    surface: "POST /v1/batches (whole-batch reservation; retrieve/cancel/results are its lifecycle)",
    sourceAnchor:
      "bifrost/transports/bifrost-http/handlers/inference.go:918 (r.POST /v1/batches); plugins/governance/main.go:1316 (PreLLMHook's BatchCreateRequest fan-out)",
    admissionSeam: { module: "server/src/billing/batch-submit.ts", door: "createBatchSubmitService" },
    payerSource: "grant-resolution",
    admission: { status: "admitted", stagesBeforeDispatch: ["per-cell admission", "reserve (one hold, whole batch)"] },
  },
  {
    id: "video.generation",
    family: "video",
    surface: "POST /v1/videos — generation",
    sourceAnchor:
      "bifrost/transports/bifrost-http/handlers/inference.go:896 (r.POST /v1/videos)",
    admissionSeam: { module: "server/src/billing/video-submit.ts", door: "createVideoSubmitService" },
    payerSource: "grant-resolution",
    admission: { status: "admitted", stagesBeforeDispatch: ["enablement (spec + tier)", "reserve (via 17.2's service)"] },
  },
  {
    id: "video.edit",
    family: "video",
    surface: "POST /v1/videos/edits — the edit shape (input seconds on video_input)",
    sourceAnchor:
      "bifrost/transports/bifrost-http/handlers/inference.go:897 (r.POST /v1/videos/edits); server/src/billing/video-edit-pricing.ts (VIDEO_EDIT_REQUEST_TYPES)",
    admissionSeam: { module: "server/src/billing/video-submit.ts", door: "createVideoSubmitService" },
    payerSource: "grant-resolution",
    admission: { status: "admitted", stagesBeforeDispatch: ["enablement (spec + tier)", "reserve (via 17.2's service)"] },
  },
  {
    id: "video.remix",
    family: "video",
    surface: "POST /v1/videos/{video_id}/remix — the remix shape (an edit request type)",
    sourceAnchor:
      "bifrost/transports/bifrost-http/handlers/inference.go:909 (r.POST /v1/videos/{video_id}/remix); video-edit-pricing.ts (VIDEO_EDIT_REQUEST_TYPES member)",
    admissionSeam: { module: "server/src/billing/video-submit.ts", door: "createVideoSubmitService" },
    payerSource: "grant-resolution",
    admission: { status: "admitted", stagesBeforeDispatch: ["enablement (spec + tier)", "reserve (via 17.2's service)"] },
  },

  // ── tool: derived from 20.x's own surcharge registry ──
  ...TOOL_SURCHARGE_ENTRIES.map<ModelEntrypoint>((entry) => ({
    id: `tool.${entry.id}`,
    family: "tool",
    surface: entry.surface,
    sourceAnchor: entry.anchor,
    admissionSeam: { module: "server/src/billing/tool-admission.ts", door: "createToolAdmissionService" },
    payerSource: "grant-resolution",
    admission:
      entry.dimension !== null
        ? { status: "admitted", stagesBeforeDispatch: ["shape + isolation", "enablement (surcharge dims)", "reserve (hold before dispatch)"] }
        : { status: "absent", checkedAbsence: entry.notAnEntranceReason ?? "not a billed entrance" },
  })),

  // ── evaluation: the judge lane, billed through its own execution-billing wiring ──
  {
    id: "evaluation.decisions",
    family: "evaluation",
    surface: "POST /v1/decisions — one evaluation case is one metered model call",
    sourceAnchor:
      "bifrost/transports/bifrost-http/handlers/inference.go:884 (r.POST /v1/decisions); plugins/governance/main.go:770 (Evaluate)",
    admissionSeam: {
      module: "server/src/ai-observability/execution-billing.ts",
      door: "createBilledEvaluationCaseRunner (reserveCredits before the gateway is dialed)",
    },
    payerSource: "workbench-company",
    admission: { status: "admitted", stagesBeforeDispatch: ["worst-case hold", "gateway dial"] },
  },

  // ── runtime: OpenBot's built-in model-call initiators, all through the governed dial ──
  {
    id: "runtime.copilot",
    family: "runtime",
    surface: "The copilot runtime's model calls (the server-only governed model collaborator)",
    sourceAnchor:
      "server/src/copilot.ts (governedModel collaborator; copilot.ts:2196 refuses when no apiKey, no plan model and no governed admission)",
    admissionSeam: { module: "server/src/copilot.ts", door: "governedModel admission" },
    payerSource: "deployment-selection",
    admission: { status: "admitted", stagesBeforeDispatch: ["governed admission (markConsumed)", "gateway dial"] },
  },
  {
    id: "runtime.intent-router",
    family: "runtime",
    surface: "The deployment's intent router (the same deployment model every runtime lane shares)",
    sourceAnchor:
      "server/src/index.ts (the intent router's route(question) seam — 'the deployment's own model and key, the same pair the intent router uses')",
    admissionSeam: { module: "server/src/index.ts", door: "intent-router model selection" },
    payerSource: "deployment-selection",
    admission: { status: "admitted", stagesBeforeDispatch: ["model selection (deployment-owned)", "governed dial"] },
  },
  {
    id: "runtime.enterprise-runner",
    family: "runtime",
    surface: "The browser mount's durable Runner — per-request immutable route refs",
    sourceAnchor:
      "server/src/index.ts (createProductionRunnerComposition's modelSelection — 'the governed gateway dial resolves the admitted route's api key through the same encrypted credential store')",
    admissionSeam: { module: "server/src/index.ts", door: "enterpriseRunner modelSelection" },
    payerSource: "workbench-company",
    admission: { status: "admitted", stagesBeforeDispatch: ["admitted route resolution", "credential-store dial"] },
  },
  {
    id: "runtime.responsibility",
    family: "runtime",
    surface: "The responsibility engine's turn runner (routines/proactive lanes)",
    sourceAnchor:
      "server/src/index.ts (createResponsibilityEngine's runTurn — the same routineIntelligence lane the engine runs)",
    admissionSeam: { module: "server/src/index.ts", door: "responsibility runTurn" },
    payerSource: "deployment-selection",
    admission: { status: "admitted", stagesBeforeDispatch: ["initiator attribution", "governed dial"] },
  },

  // ── harness: the subscription boundary 09.x marked ──
  {
    id: "harness.subscription",
    family: "harness",
    surface: "The subscription fulfillment harness — boundary-marked, never a balance-exhaustion fallback",
    sourceAnchor:
      "server/tests/subscription-harness-boundary.test.ts (09.x's own boundary suite); server/src/billing/entitlement.ts (fail-closed: no readable customer, no subscription facts)",
    admissionSeam: { module: "server/src/billing/entitlement.ts", door: "createBillingEntitlementReader" },
    payerSource: "workbench-company",
    admission: { status: "admitted", stagesBeforeDispatch: ["entitlement read (fail-closed)", "the same reserve door as every lane"] },
  },

  // ── checked absences: read-only or plumbing routes someone verified are NOT entrances ──
  {
    id: "absent.model-discovery",
    family: "text",
    surface: "GET /v1/models and /v1/models/{model} — the public read-only discovery surface",
    sourceAnchor:
      "bifrost/transports/bifrost-http/handlers/inference.go:865 (r.GET /v1/models + the model-retrieve catch-all; 03.x's public discovery carries no inference)",
    admissionSeam: { module: "server/src/gateway/model-discovery-routes.ts", door: "createModelDiscoveryRoutes" },
    payerSource: "grant-resolution",
    admission: { status: "absent", checkedAbsence: "read-only catalog discovery; no provider inference is dispatched" },
  },
  {
    id: "absent.files-containers",
    family: "text",
    surface: "The /v1/files and /v1/containers route families",
    sourceAnchor:
      "bifrost/transports/bifrost-http/handlers/inference.go:931 (r.POST /v1/files and the container registrations below — storage plumbing, no model call)",
    admissionSeam: {
      module: "server/src/billing/credit-reserve.ts",
      door: "the file/container route registrations carry no admission because they carry no model call",
    },
    payerSource: "grant-resolution",
    admission: { status: "absent", checkedAbsence: "file storage and container lifecycle; no provider model call" },
  },
] as const;

// ── the reconciliation: registries ↔ catalog, both directions ──

/** The entrance identities the machine-enumerable registries carry today. */
export function registryEntrypointIdentities(): {
  image: string[];
  audio: string[];
  tool: string[];
} {
  return {
    image: IMAGE_ENTRYPOINTS.map((entry) => `image.${entry.kind}${entry.stream ? ".stream" : ""}`),
    audio: AUDIO_CAPABILITY_EVIDENCE.map(
      (record) => `audio.${record.family}${record.stream ? ".stream" : ""}`,
    ),
    tool: TOOL_SURCHARGE_ENTRIES.map((entry) => `tool.${entry.id}`),
  };
}

/** The four-way reconciliation result 22.1's test pins. Empty on every field = consistent. */
export type CatalogReconciliation = {
  /** Registry rows with no catalog row — an unregistered entrance (the AC's failure case). */
  unregistered: string[];
  /** Catalog rows whose family registry no longer carries them — a stale annotation. */
  stale: string[];
  /** Rows whose admission seam module or anchor is not on disk — the code evidence broke. */
  seamMissing: string[];
  /** Admitted rows missing the annotation 22.2/22.3 consume (stages or payer source). */
  incomplete: string[];
};

/**
 * Reconcile the catalog against the family registries. The test calls this and asserts
 * every field empty; a registry that grows a row (a new image entrance, a new audio
 * path, a new tool surcharge entry) breaks `unregistered` until the catalog registers
 * it — which is 新增入口未登记到清单时自动化检查失败, as a derived fact, not a snapshot.
 * The optional catalog argument lets the audit demonstrate the failure modes against a
 * hypothetical list without touching production state.
 */
export function reconcileEntrypointCatalog(
  fileExists: (modulePath: string) => boolean,
  catalog: readonly ModelEntrypoint[] = MODEL_ENTRYPOINTS,
): CatalogReconciliation {
  const byId = new Map(catalog.map((row) => [row.id, row]));
  const registries = registryEntrypointIdentities();
  const registered = new Set([
    ...registries.image,
    ...registries.audio,
    ...registries.tool,
  ]);

  const unregistered = [...registered].filter((id) => !byId.has(id));
  const stale = [...byId.keys()].filter(
    (id) =>
      (id.startsWith("image.") || id.startsWith("audio.") || id.startsWith("tool.")) &&
      !registered.has(id),
  );
  const seamMissing = catalog
    .filter((row) => !fileExists(row.admissionSeam.module))
    .map((row) => row.id);
  const incomplete = catalog
    .filter(
      (row) =>
        row.admission.status === "admitted" &&
        (row.admission.stagesBeforeDispatch.length === 0 || !row.payerSource),
    )
    .map((row) => row.id);

  return { unregistered, stale, seamMissing, incomplete };
}

/** The rows 22.2 audits: admitted entrances plus the blocked ones (findings, not gaps). */
export function auditedEntrypoints(): readonly ModelEntrypoint[] {
  return MODEL_ENTRYPOINTS.filter(
    (row) => row.admission.status === "admitted" || row.admission.status === "blocked",
  );
}
