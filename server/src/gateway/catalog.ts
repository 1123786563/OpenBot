/**
 * The gateway model catalog, normalized to ModelRef triples (Bifrost 03.1, AC06/Q4/Q17).
 *
 * ONE MANIFEST, ONE IDENTITY. `GET /v1/models` on the gateway's model surface is the one
 * management read this module dials (the same origin-only endpoint configuration 01.1 saves, the
 * same admin credential 01.2 resolves — the way the probe dials `/api/config` and the negotiation
 * dials `/api/plugins`). Every entry the gateway sends carries `id` as `"<provider>/<model>"`,
 * so the identity a catalog entry gets is the triple `ModelRef { provider, model, capability }`:
 * `openai/gpt-4o` and `azure/gpt-4o` are two models that happen to share a name, and this module
 * never merges them — the database's unique index on the triple is the same rule, stated twice.
 *
 * CAPABILITY IS DERIVED, NEVER GUESSED. The only upstream field that speaks capability is
 * `supported_methods` (each provider's own vocabulary — Gemini's `generateContent`, Cohere's
 * `embed`, a pipeline tag). A fixed vocabulary maps recognized method names to the closed
 * capability set (design Q20); one entry mapping to several capabilities produces one ModelRef
 * per capability. An entry whose hints map to nothing is kept as `capability: "unknown"` with the
 * fixed reason it is unknown — an entry with no hints at all gets the other reason — because the
 * one thing this ticket forbids is quietly relabeling an unjudgeable model as a text model. The
 * `architecture` modalities are deliberately not capability evidence; they ride along inside
 * `raw_entry` for 03.2/03.3 to re-check.
 *
 * THE GATE STANDS BEFORE THE DIAL. `fetchCatalog` calls `assertGatewayReadyForBilling()` first;
 * the thrown refusal *is* the outcome (a not-ready gateway is a fetch that never happens — no
 * request is opened, the dial spy in the tests stays silent). What the gate refuses is recorded
 * with its displayable reasons, and the last-good catalog is untouched.
 *
 * LAST-GOOD IS A PROMISE KEPT BY SUBTRACTION. A fetch that fails after the gate — unreachable,
 * timeout, unauthenticated, malformed, oversized, a pagination loop — writes nothing into the
 * catalog: the previous successful snapshot stays exactly as it was, and the failure is appended
 * to the fetch log with a fixed, displayable reason code (never upstream bytes, never the
 * address, never the credential). A fetch that succeeds replaces the whole snapshot in one
 * transaction — refs the gateway stopped listing are gone, because a delisted model must not stay
 * selectable (Q17) — and appends the `CatalogFetchRecord` audit row.
 *
 * WHO CALLS THIS. 03.2 maps prices per ModelRef (it re-reads `raw_entry`), 03.7 opens scopes over
 * `listModelRefs()`, 03.4 owns the five-minute cadence, 03.5 owns the administrator's manual
 * trigger — they call `fetchCatalog()` / `listModelRefs()` and treat a failed outcome as the end
 * of their path. No fallback, no provider direct connection, no guessing.
 */
import { randomUUID } from "node:crypto";
import { desc } from "drizzle-orm";
import type { Logger } from "../../../shared/logger";
import { getLogger } from "../../../shared/logger";
import { enterpriseControls } from "../admin/controls";
import type { Database } from "../db/client";
import { gatewayCatalogFetches, gatewayModelCatalogRefs } from "../db/schema";
import {
  GatewayAdminCredentialNotConfiguredError,
  gatewayAdminCredentialControls,
} from "./admin-credential";
import {
  type GatewayEndpointConfig,
  gatewayEndpointControls,
} from "./endpoint-config";
import {
  GatewayNotReadyError,
  type GatewayReadiness,
  type GatewayReadinessReasonCode,
  gatewayReadinessControls,
} from "./readiness";

/**
 * The management path the catalog fetches: the gateway's model manifest, the one endpoint whose
 * entries carry `"<provider>/<model>"` ids and capability hints. The endpoint configuration is an
 * origin only (01.1 refuses paths); each consumer owns the paths it calls, and this one is the
 * catalog's.
 */
export const GATEWAY_CATALOG_MODELS_PATH = "/v1/models";

/**
 * The `source` a fetch record carries: a fixed constant of this module, safe to show anywhere —
 * never a URL, never upstream bytes.
 */
export const GATEWAY_CATALOG_SOURCE = "gateway:/v1/models";

/**
 * How much of a response body one page of the manifest may occupy before the peer stops being
 * believed: a model listing is metadata, and a peer pushing megabytes-per-page is not the
 * configured gateway. Generous for a catalog of thousands of models; still a cap, so a
 * misbehaving endpoint cannot turn a sync into a memory event.
 */
export const GATEWAY_CATALOG_MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * How many manifest pages one fetch may follow before the pagination is judged broken. A bounded
 * guard, not a feature: an upstream that always answers `next_page_token` must fail loudly
 * (`catalog_fetch_pagination_exceeded`) instead of producing a silently truncated catalog.
 */
export const GATEWAY_CATALOG_MAX_PAGES = 100;

/**
 * The closed capability set a catalog entry can carry (CONTEXT.md: 能力; design Q20), plus
 * `unknown` — which is not a capability a model has, but the honest answer this module gives when
 * the upstream fields cannot say. A new member arrives with its own migration, the rule the
 * access-grant scope enum follows.
 */
export const MODEL_CAPABILITIES = [
  "chat",
  "embedding",
  "image",
  "speech",
  "transcription",
  "rerank",
  "ocr",
  "realtime",
  "video",
  "unknown",
] as const;

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/**
 * The unique identity of a catalog entry (and later of a price snapshot): same model name under
 * two providers is two refs, never one.
 */
export type ModelRef = {
  provider: string;
  model: string;
  capability: ModelCapability;
};

/** The display/dedupe key of a ref: the triple, in order, pipe-joined. */
export function modelRefKey(ref: ModelRef): string {
  return `${ref.provider}|${ref.model}|${ref.capability}`;
}

/** Why a ref's capability is `unknown`. Fixed codes; safe to show on any screen. */
export type CatalogCapabilityUnknownReason =
  | /** No capability field was present at all — nothing was claimed, so nothing is derived. */
  "catalog_capability_no_signal"
  /** A capability field was present, but none of its values maps to a known capability. */
  | "catalog_capability_unrecognized";

/** How the capability was derived — or that it was not. */
export type CatalogCapabilitySource = "supported_methods" | "none";

/**
 * One normalized catalog entry: the ModelRef it identifies, where its capability came from, the
 * reason it is unknown when it is, and the exact upstream entry it was derived from (audit, and
 * 03.2's price mapping re-check).
 */
export type CatalogEntry = {
  ref: ModelRef;
  capabilitySource: CatalogCapabilitySource;
  unknownReason?: CatalogCapabilityUnknownReason;
  /** The raw upstream entry, verbatim. Never logged; persisted for review only. */
  rawEntry: Record<string, unknown>;
};

/** Why one raw entry produced no ModelRef. Fixed codes; counted, never swallowed silently. */
export type CatalogEntryIssueReason =
  | "catalog_entry_not_object"
  | "catalog_entry_provider_missing";

/** One unnormalizable entry: where it sat in `data`, and why it was refused. */
export type CatalogEntryIssue = {
  index: number;
  reasonCode: CatalogEntryIssueReason;
};

/** What normalization produces: the refs, the refusals, the counts the record carries. */
export type NormalizedCatalog = {
  /** Whether the payload could not be read as a manifest at all (no `data` array). */
  invalid: boolean;
  entries: CatalogEntry[];
  issues: CatalogEntryIssue[];
  /** Identical triples seen again within one fetch, after the first. */
  duplicateCount: number;
  /** Every entry the gateway sent — the number an audit re-checks against upstream. */
  rawItemCount: number;
};

/**
 * The provider-dependent capability vocabulary, normalized (lowercased, non-alphanumerics
 * stripped) before lookup. Named per provider where the value is one provider's idiom; the
 * normalization is what lets `embedContent`, `embed_content` and `EMBED` land on one row. A
 * vocabulary entry is evidence a provider *claimed* the capability — pricing and enforceability
 * are later tickets' gates (03.2/03.3), never implied by listing here.
 */
const CAPABILITY_VOCABULARY: Readonly<Record<string, ModelCapability>> = {
  // chat / text generation, across provider idioms
  chat: "chat",
  chatcompletions: "chat",
  completions: "chat",
  messages: "chat",
  generatecontent: "chat",
  generatetext: "chat",
  textgeneration: "chat",
  converse: "chat",
  // embeddings
  embed: "embedding",
  embeds: "embedding",
  embedding: "embedding",
  embeddings: "embedding",
  embedcontent: "embedding",
  embeddingscontent: "embedding",
  // image generation
  image: "image",
  images: "image",
  imagegeneration: "image",
  generateimage: "image",
  generateimages: "image",
  // speech generation (tts)
  speech: "speech",
  tts: "speech",
  texttospeech: "speech",
  generatespeech: "speech",
  audiospeech: "speech",
  // transcription (stt)
  transcription: "transcription",
  transcriptions: "transcription",
  transcribe: "transcription",
  audiotranscription: "transcription",
  speechtotext: "transcription",
  stt: "transcription",
  // reranking
  rerank: "rerank",
  reranking: "rerank",
  rank: "rerank",
  // document OCR (the wire's own request-type token is "ocr")
  ocr: "ocr",
  documentocr: "ocr",
  // realtime voice / bidirectional sessions
  realtime: "realtime",
  livertc: "realtime",
  // video generation
  video: "video",
  videos: "video",
  videogeneration: "video",
  generatevideo: "video",
};

/** Normalize one upstream method token for vocabulary lookup. */
function normalizeMethodToken(method: unknown): string | undefined {
  if (typeof method !== "string") return undefined;
  const normalized = method.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized === "" ? undefined : normalized;
}

/**
 * Split one manifest entry's `id` into the provider/model halves of the ModelRef. The wire
 * contract is `"<provider>/<model>"` — the provider is the prefix before the first slash, the
 * model is everything after it (model names may themselves contain slashes). An id without a
 * provider prefix cannot be attributed and is refused, never guessed at.
 */
export function splitModelId(
  id: string,
): { ok: true; provider: string; model: string } | { ok: false } {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return { ok: false };
  const provider = id.slice(0, slash).trim();
  const model = id.slice(slash + 1).trim();
  if (!provider || !model) return { ok: false };
  return { ok: true, provider, model };
}

/**
 * Derive the capabilities one raw entry's `supported_methods` names. The array is the only
 * capability evidence this module accepts; anything it maps yields that capability, anything it
 * does not yields the reason the entry stays unknown instead.
 */
export function deriveCapabilitiesFromEntry(raw: Record<string, unknown>):
  | {
      ok: true;
      capabilities: ModelCapability[];
      source: "supported_methods";
    }
  | {
      ok: false;
      capability: "unknown";
      source: "none";
      reason: CatalogCapabilityUnknownReason;
    } {
  const methods = raw.supported_methods;
  if (!Array.isArray(methods)) {
    return {
      ok: false,
      capability: "unknown",
      source: "none",
      reason: "catalog_capability_no_signal",
    };
  }
  const capabilities = new Set<ModelCapability>();
  for (const method of methods) {
    // Own-property lookup only: a plain subscript walks the prototype chain, so a
    // method named "constructor" or "valueOf" would "resolve" to an inherited
    // function and never to a capability.
    const token = normalizeMethodToken(method) ?? "";
    const capability = Object.hasOwn(CAPABILITY_VOCABULARY, token)
      ? CAPABILITY_VOCABULARY[token]
      : undefined;
    if (capability && capability !== "unknown") capabilities.add(capability);
  }
  if (capabilities.size === 0) {
    return {
      ok: false,
      capability: "unknown",
      source: "none",
      reason: "catalog_capability_unrecognized",
    };
  }
  // Deterministic order: the closed set's own order, whatever order upstream listed them in.
  const ordered = MODEL_CAPABILITIES.filter((capability) =>
    capabilities.has(capability),
  );
  return { ok: true, capabilities: ordered, source: "supported_methods" };
}

/**
 * Normalize one manifest payload into catalog entries. Pure: no database, no network, no clock —
 * the fixture tests in `tests/catalog-model-ref.test.ts` pin every rule named here.
 */
export function normalizeGatewayModelCatalog(
  payload: unknown,
): NormalizedCatalog {
  const result: NormalizedCatalog = {
    invalid: false,
    entries: [],
    issues: [],
    duplicateCount: 0,
    rawItemCount: 0,
  };
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !Array.isArray((payload as Record<string, unknown>).data)
  ) {
    result.invalid = true;
    return result;
  }
  const data = (payload as Record<string, unknown>).data as unknown[];
  result.rawItemCount = data.length;

  const seen = new Set<string>();
  for (const [index, raw] of data.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      result.issues.push({ index, reasonCode: "catalog_entry_not_object" });
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const id = entry.id;
    if (typeof id !== "string" || id.trim() === "") {
      result.issues.push({
        index,
        reasonCode: "catalog_entry_provider_missing",
      });
      continue;
    }
    const split = splitModelId(id);
    if (!split.ok) {
      result.issues.push({
        index,
        reasonCode: "catalog_entry_provider_missing",
      });
      continue;
    }
    const derived = deriveCapabilitiesFromEntry(entry);
    const capabilities = derived.ok
      ? derived.capabilities
      : ([derived.capability] as const);
    for (const capability of capabilities) {
      const ref: ModelRef = {
        provider: split.provider,
        model: split.model,
        capability,
      };
      const key = modelRefKey(ref);
      if (seen.has(key)) {
        result.duplicateCount += 1;
        continue;
      }
      seen.add(key);
      result.entries.push({
        ref,
        capabilitySource: derived.source,
        ...(derived.ok ? {} : { unknownReason: derived.reason }),
        rawEntry: entry,
      });
    }
  }
  return result;
}

/** The audit record one completed fetch produces (the contract 03.2 re-checks against). */
export type CatalogFetchRecord = {
  /** When the fetch completed, ISO 8601. */
  fetchedAt: string;
  /** The fixed source constant — never a URL. */
  source: string;
  /** Every raw entry the gateway sent across all followed pages. */
  rawItemCount: number;
  /** The endpoint configuration version the gateway answered for. */
  configVersion: number;
};

/** Why a fetch failed. Fixed codes of this module — displayable anywhere, no upstream data. */
export type CatalogFetchFailureReasonCode =
  | "catalog_fetch_gate_not_ready"
  | "catalog_fetch_endpoint_not_configured"
  | "catalog_fetch_credential_not_configured"
  | "catalog_fetch_credential_unavailable"
  | "catalog_fetch_unreachable"
  | "catalog_fetch_timeout"
  | "catalog_fetch_unauthenticated"
  | "catalog_fetch_invalid_response"
  | "catalog_fetch_response_too_large"
  | "catalog_fetch_pagination_exceeded"
  | "catalog_fetch_persist_failed";

/** What {@link GatewayCatalogService.fetchCatalog} answers — never a throw, never a fallback. */
export type CatalogFetchOutcome =
  | {
      status: "ok";
      record: CatalogFetchRecord;
      /** The normalized entries the snapshot now holds. */
      entries: CatalogEntry[];
      /** Entries refused during normalization (counted in `record.rawItemCount`). */
      issueCount: number;
      /** Identical triples collapsed within this fetch. */
      duplicateCount: number;
    }
  | {
      status: "failed";
      reasonCode: CatalogFetchFailureReasonCode;
      /** When the failure was classified, ISO 8601. */
      failedAt: string;
      /** The configuration version on file, when one was. */
      configVersion?: number;
      /** The gate's own displayable reasons, when the gate is what refused. */
      readinessReasons?: readonly GatewayReadinessReasonCode[];
    };

/** The last attempt's outcome, read back for display — a status surface needs this after a restart. */
export type CatalogLastFetchOutcome =
  | { status: "ok"; record: CatalogFetchRecord }
  | {
      status: "failed";
      reasonCode: CatalogFetchFailureReasonCode;
      failedAt: string;
      configVersion?: number;
    };

/** One persisted last-good ref, read back with the metadata review needs. */
export type CatalogStoredRef = {
  ref: ModelRef;
  capabilitySource: CatalogCapabilitySource;
  unknownReason?: CatalogCapabilityUnknownReason;
  rawEntry: Record<string, unknown>;
  configVersion: number;
  fetchedAt: string;
};

/**
 * Where the catalog persists. The database implementation replaces the snapshot and appends the
 * log in transactions; tests may supply their own.
 */
export type GatewayCatalogStore = {
  /**
   * Replace the whole last-good snapshot with these entries, atomically, and record the
   * successful fetch. Refs the gateway stopped listing disappear with the transaction —
   * never a merge.
   */
  replaceCatalog(args: {
    entries: CatalogEntry[];
    record: CatalogFetchRecord;
  }): Promise<void>;
  /** Append one failure to the fetch log; the snapshot is never touched by this. */
  recordFetchFailure(args: {
    reasonCode: CatalogFetchFailureReasonCode;
    failedAt: string;
    configVersion?: number;
  }): Promise<void>;
  /** The last-good refs, with the metadata review and 03.2's mapping consume. */
  readCatalogRefs(): Promise<CatalogStoredRef[]>;
  /** The latest attempt's outcome by completion time, or undefined before the first one. */
  readLatestFetchOutcome(): Promise<CatalogLastFetchOutcome | undefined>;
};

/** Strict read of one stored ref row; a damaged row is skipped, not repaired. */
function catalogStoredRefFromRow(row: {
  provider: string;
  model: string;
  capability: string;
  capabilitySource: string;
  unknownReason: string | null;
  rawEntry: unknown;
  configVersion: number;
  fetchedAt: Date;
}): CatalogStoredRef | undefined {
  if (!MODEL_CAPABILITIES.includes(row.capability as ModelCapability)) {
    return undefined;
  }
  if (
    row.capabilitySource !== "supported_methods" &&
    row.capabilitySource !== "none"
  ) {
    return undefined;
  }
  if (
    row.rawEntry === null ||
    typeof row.rawEntry !== "object" ||
    Array.isArray(row.rawEntry)
  ) {
    return undefined;
  }
  return {
    ref: {
      provider: row.provider,
      model: row.model,
      capability: row.capability as ModelCapability,
    },
    capabilitySource: row.capabilitySource,
    ...(row.unknownReason !== null
      ? { unknownReason: row.unknownReason as CatalogCapabilityUnknownReason }
      : {}),
    rawEntry: row.rawEntry as Record<string, unknown>,
    configVersion: row.configVersion,
    fetchedAt: row.fetchedAt.toISOString(),
  };
}

/** The catalog store over the two gateway catalog tables — the sibling pattern of the probe store. */
export function createEnterpriseGatewayCatalogStore(
  database: Database,
): GatewayCatalogStore {
  return {
    async replaceCatalog({ entries, record }) {
      await database.transaction(async (tx) => {
        // The whole snapshot, replaced: a model the gateway stopped listing must not survive as a
        // selectable row (Q17). One transaction, so a reader sees either the old snapshot in
        // full or the new one in full — never a tear.
        await tx.delete(gatewayModelCatalogRefs);
        if (entries.length > 0) {
          await tx.insert(gatewayModelCatalogRefs).values(
            entries.map((entry) => ({
              provider: entry.ref.provider,
              model: entry.ref.model,
              capability: entry.ref.capability,
              capabilitySource: entry.capabilitySource,
              unknownReason: entry.unknownReason ?? null,
              rawEntry: entry.rawEntry,
              configVersion: record.configVersion,
              fetchedAt: new Date(record.fetchedAt),
            })),
          );
        }
        await tx.insert(gatewayCatalogFetches).values({
          fetchId: randomUUID(),
          status: "ok",
          source: record.source,
          rawItemCount: record.rawItemCount,
          configVersion: record.configVersion,
          fetchedAt: new Date(record.fetchedAt),
        });
      });
    },

    async recordFetchFailure({ reasonCode, failedAt, configVersion }) {
      await database.insert(gatewayCatalogFetches).values({
        fetchId: randomUUID(),
        status: "failed",
        source: GATEWAY_CATALOG_SOURCE,
        rawItemCount: null,
        ...(configVersion === undefined ? {} : { configVersion }),
        failureReasonCode: reasonCode,
        fetchedAt: new Date(failedAt),
      });
    },

    async readCatalogRefs() {
      const rows = await database
        .select({
          provider: gatewayModelCatalogRefs.provider,
          model: gatewayModelCatalogRefs.model,
          capability: gatewayModelCatalogRefs.capability,
          capabilitySource: gatewayModelCatalogRefs.capabilitySource,
          unknownReason: gatewayModelCatalogRefs.unknownReason,
          rawEntry: gatewayModelCatalogRefs.rawEntry,
          configVersion: gatewayModelCatalogRefs.configVersion,
          fetchedAt: gatewayModelCatalogRefs.fetchedAt,
        })
        .from(gatewayModelCatalogRefs)
        .orderBy(
          gatewayModelCatalogRefs.provider,
          gatewayModelCatalogRefs.model,
          gatewayModelCatalogRefs.capability,
        );
      return rows
        .map(catalogStoredRefFromRow)
        .filter((ref): ref is CatalogStoredRef => ref !== undefined);
    },

    async readLatestFetchOutcome() {
      const [row] = await database
        .select()
        .from(gatewayCatalogFetches)
        .orderBy(
          desc(gatewayCatalogFetches.fetchedAt),
          desc(gatewayCatalogFetches.fetchId),
        )
        .limit(1);
      if (row === undefined) return undefined;
      const configVersion = row.configVersion ?? undefined;
      if (row.status === "ok") {
        return {
          status: "ok" as const,
          record: {
            fetchedAt: row.fetchedAt.toISOString(),
            source: row.source,
            rawItemCount: row.rawItemCount ?? 0,
            configVersion: row.configVersion ?? 0,
          },
        };
      }
      if (
        row.failureReasonCode === null ||
        !row.failureReasonCode.startsWith("catalog_fetch_")
      ) {
        return undefined;
      }
      return {
        status: "failed" as const,
        reasonCode: row.failureReasonCode as CatalogFetchFailureReasonCode,
        failedAt: row.fetchedAt.toISOString(),
        ...(configVersion === undefined ? {} : { configVersion }),
      };
    },
  };
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/** Drop the response's body without reading it into memory. */
function discardBody(response: Response): Promise<void> {
  return response.body
    ? response.body.cancel().then(() => undefined)
    : Promise.resolve();
}

/**
 * Read at most `cap` bytes of one manifest page, refusing more. Reading is the only thing the
 * fetcher ever does with an upstream body: the bytes are validated below and never logged.
 */
async function readBodyCapped(
  response: Response,
  cap: number,
): Promise<
  { ok: true; text: string } | { ok: false; reason: "too_large" | "unreadable" }
> {
  if (!response.body) return { ok: true, text: "" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

/** Reject with the same shape `AbortSignal.timeout` produces, so classification stays one branch. */
function timeoutError(): Error {
  const error = new Error("The gateway catalog fetch timed out.");
  error.name = "TimeoutError";
  return error;
}

/** One authenticated GET of one manifest page: bytes in, JSON out — or the reason it failed. */
async function fetchManifestPage(options: {
  config: GatewayEndpointConfig;
  adminKey: string;
  pageToken?: string;
  fetchImpl: typeof fetch;
}): Promise<
  | { ok: true; payload: unknown; nextPageToken?: string }
  | { ok: false; reasonCode: CatalogFetchFailureReasonCode }
> {
  const { config, adminKey, pageToken, fetchImpl } = options;
  const startedAt = Date.now();
  const url = new URL(
    `${config.baseUrl.replace(/\/+$/, "")}${GATEWAY_CATALOG_MODELS_PATH}`,
  );
  if (pageToken !== undefined) url.searchParams.set("page_token", pageToken);

  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${adminKey}`,
      accept: "application/json",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  }).catch((error: unknown) => {
    if (isTimeoutError(error)) return "timeout" as const;
    // The error object is deliberately dropped: its message names the address and could carry
    // anything else the network layer saw. The classification needs only the class.
    return "unreachable" as const;
  });

  if (response === "timeout" || response === "unreachable") {
    return {
      ok: false,
      reasonCode:
        response === "timeout"
          ? "catalog_fetch_timeout"
          : "catalog_fetch_unreachable",
    };
  }
  if (response.status === 401 || response.status === 403) {
    await discardBody(response);
    return { ok: false, reasonCode: "catalog_fetch_unauthenticated" };
  }
  if (response.status < 200 || response.status > 299) {
    await discardBody(response);
    return { ok: false, reasonCode: "catalog_fetch_invalid_response" };
  }

  // The deadline covers the body read too: a peer that sends headers and then trickles or
  // stalls forever is a timeout, not a hung sync. The signal bound to the fetch does not reach
  // every stream read on every runtime, so the budget is enforced here as well (the probe's
  // rule, for the same reason).
  const remainingMs = config.requestTimeoutMs - (Date.now() - startedAt);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  // The race's losing timer must not keep spinning for the rest of the budget after
  // the body promise settles: cleared the moment either side wins.
  const body = await Promise.race([
    readBodyCapped(response, GATEWAY_CATALOG_MAX_BODY_BYTES),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(timeoutError()),
        Math.max(1, remainingMs),
      );
    }),
  ])
    .catch(
      (
        error: unknown,
      ):
        | "timeout"
        | { ok: true; text: string }
        | { ok: false; reason: "too_large" | "unreadable" } => {
        if (isTimeoutError(error)) return "timeout";
        void response.body?.cancel().catch(() => {});
        return { ok: false, reason: "unreadable" };
      },
    )
    .finally(() => clearTimeout(timeout));
  if (body === "timeout") {
    return { ok: false, reasonCode: "catalog_fetch_timeout" };
  }
  if (!body.ok) {
    await response.body?.cancel().catch(() => {});
    return {
      ok: false,
      reasonCode:
        body.reason === "too_large"
          ? "catalog_fetch_response_too_large"
          : "catalog_fetch_invalid_response",
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body.text);
  } catch {
    return { ok: false, reasonCode: "catalog_fetch_invalid_response" };
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return { ok: false, reasonCode: "catalog_fetch_invalid_response" };
  }
  const token = (payload as Record<string, unknown>).next_page_token;
  return {
    ok: true,
    payload,
    ...(typeof token === "string" && token.trim() !== ""
      ? { nextPageToken: token }
      : {}),
  };
}

export type GatewayCatalogDeps = {
  /**
   * The single gate, consulted before any dial. Production passes
   * `assertGatewayReadyForBilling` (the installed gate); the thrown refusal is the outcome.
   */
  assertGatewayReady: () => Promise<GatewayReadiness>;
  /** The current endpoint snapshot to dial, or undefined when none is configured. */
  readGatewayEndpoint: () => Promise<GatewayEndpointConfig | undefined>;
  /** 01.2's internal resolve — the only place the admin key's plaintext may come from. */
  resolveGatewayAdminCredential: () => Promise<{ adminKey: string }>;
  store: GatewayCatalogStore;
  /** Injectable for tests; the real deployment dials the network. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Page-following cap override for tests; production uses the module constant. */
  maxPages?: number;
  log?: Logger;
};

export type GatewayCatalogService = {
  /**
   * Fetch once, now: gate, dial, normalize, replace. Answers an outcome — a failed fetch
   * (including a refusing gate) is recorded with a displayable reason and leaves the last-good
   * snapshot exactly as it was. Persistence failure of the *failure record* is logged; the
   * outcome already in hand is not unmade (the probe's rule).
   */
  fetchCatalog: () => Promise<CatalogFetchOutcome>;
  /** The last-good ModelRefs — what 03.7's open scope and 03.8's filter consume. */
  listModelRefs: () => Promise<ModelRef[]>;
  /**
   * The last-good refs with review metadata (capability source, unknown reason, raw entry) —
   * what 03.2's price mapping re-checks the upstream bytes against.
   */
  listCatalogEntries: () => Promise<CatalogStoredRef[]>;
  /** The latest attempt's outcome, for a status surface after a restart. */
  readLastFetchOutcome: () => Promise<CatalogLastFetchOutcome | undefined>;
};

export function createGatewayCatalogService(
  deps: GatewayCatalogDeps,
): GatewayCatalogService {
  const log = deps.log ?? getLogger("server");
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());
  const maxPages = deps.maxPages ?? GATEWAY_CATALOG_MAX_PAGES;

  const fail = async (
    reasonCode: CatalogFetchFailureReasonCode,
    extra: {
      configVersion?: number;
      readinessReasons?: readonly GatewayReadinessReasonCode[];
    } = {},
  ): Promise<CatalogFetchOutcome> => {
    const failedAt = now().toISOString();
    try {
      await deps.store.recordFetchFailure({
        reasonCode,
        failedAt,
        ...(extra.configVersion === undefined
          ? {}
          : { configVersion: extra.configVersion }),
      });
    } catch (error) {
      // The outcome is already in hand; a broken log must not unmake it. The next successful
      // fetch repairs the display (the probe's persist rule).
      log.error(
        {
          type: "gateway-catalog-failure-persist-failed",
          reasonCode,
          errorName: error instanceof Error ? error.name : String(typeof error),
        },
        "The catalog fetch failure could not be persisted.",
      );
      return {
        status: "failed",
        reasonCode,
        failedAt,
        ...(extra.configVersion === undefined
          ? {}
          : { configVersion: extra.configVersion }),
        ...(extra.readinessReasons === undefined
          ? {}
          : { readinessReasons: extra.readinessReasons }),
      };
    }
    return {
      status: "failed",
      reasonCode,
      failedAt,
      ...(extra.configVersion === undefined
        ? {}
        : { configVersion: extra.configVersion }),
      ...(extra.readinessReasons === undefined
        ? {}
        : { readinessReasons: extra.readinessReasons }),
    };
  };

  const service: GatewayCatalogService & {
    /** The dial, normalize and replace, past the gate; `configVersion` is the gate's verdict. */
    runFetch(configVersion: number): Promise<CatalogFetchOutcome>;
  } = {
    async fetchCatalog(): Promise<CatalogFetchOutcome> {
      // STEP 1: the gate, before anything else. A not-ready gateway is a fetch that never
      // happens — the thrown refusal carries the displayable reasons, and no dial is opened.
      let readiness: GatewayReadiness;
      try {
        readiness = await deps.assertGatewayReady();
      } catch (error) {
        if (error instanceof GatewayNotReadyError) {
          return fail("catalog_fetch_gate_not_ready", {
            configVersion: error.readiness.configVersion,
            readinessReasons: error.readiness.blockingReasons,
          });
        }
        // The gate itself broke (a condition source threw under it): refuse the same way, with
        // the class of the break — never its message, which could carry configuration.
        log.warn(
          {
            type: "gateway-catalog-gate-error",
            errorName:
              error instanceof Error ? error.name : String(typeof error),
          },
          "The gateway readiness gate could not be consulted, so the catalog was not fetched.",
        );
        return fail("catalog_fetch_gate_not_ready");
      }

      // The gate answered ready; what it answered for is the configuration the dial speaks of.
      const configVersion = readiness.configVersion;

      // Everything past the gate is wrapped once more: the dial and its classification are
      // total, so anything escaping here is a defect — but the service's promise is that a
      // fetch never throws and never writes a partial snapshot. Classify, log the error's
      // class (never its message), keep last-good.
      try {
        return await service.runFetch(configVersion);
      } catch (error) {
        log.error(
          {
            type: "gateway-catalog-fetch-unexpected-error",
            errorName:
              error instanceof Error ? error.name : String(typeof error),
          },
          "The catalog fetch failed unexpectedly; the previous snapshot is kept.",
        );
        return fail("catalog_fetch_invalid_response", { configVersion });
      }
    },

    /** The dial, normalize and replace, past the gate. */
    async runFetch(configVersion: number): Promise<CatalogFetchOutcome> {
      // Defensive re-reads after the gate: the gate verified both on its pass, but the dial
      // needs its own snapshot and its own plaintext, and each refusal names its own gap.
      const config = await deps
        .readGatewayEndpoint()
        .catch((): GatewayEndpointConfig | undefined => undefined);
      if (!config) {
        return fail("catalog_fetch_endpoint_not_configured", { configVersion });
      }
      let adminKey: string;
      try {
        adminKey = (await deps.resolveGatewayAdminCredential()).adminKey;
      } catch (error) {
        if (error instanceof GatewayAdminCredentialNotConfiguredError) {
          return fail("catalog_fetch_credential_not_configured", {
            configVersion,
          });
        }
        // The resolver's own words may carry key material; the log gets the class, never the
        // message.
        log.warn(
          {
            type: "gateway-catalog-credential-unavailable",
            errorName:
              error instanceof Error ? error.name : String(typeof error),
          },
          "The gateway admin credential could not be resolved, so the catalog was not fetched.",
        );
        return fail("catalog_fetch_credential_unavailable", { configVersion });
      }

      // STEP 2: dial the manifest, following the pagination token, every page classified.
      const rawEntries: unknown[] = [];
      let pageToken: string | undefined;
      let exhausted = false;
      for (let page = 0; page < maxPages; page += 1) {
        const pageResult = await fetchManifestPage({
          config,
          adminKey,
          ...(pageToken === undefined ? {} : { pageToken }),
          fetchImpl,
        });
        if (!pageResult.ok) {
          return fail(pageResult.reasonCode, { configVersion });
        }
        const normalized = normalizeGatewayModelCatalog(pageResult.payload);
        if (normalized.invalid) {
          return fail("catalog_fetch_invalid_response", { configVersion });
        }
        for (const raw of (pageResult.payload as { data: unknown[] }).data)
          rawEntries.push(raw);
        if (pageResult.nextPageToken === undefined) {
          exhausted = true;
          break;
        }
        pageToken = pageResult.nextPageToken;
      }
      if (!exhausted) {
        // Every page budget was consumed and the token never ran out: a broken pagination.
        // A silently truncated catalog is worse than a failed sync, so this fails whole.
        return fail("catalog_fetch_pagination_exceeded", { configVersion });
      }

      // STEP 3: normalize the manifest the gateway actually sent, all pages together.
      const normalized = normalizeGatewayModelCatalog({ data: rawEntries });
      const record: CatalogFetchRecord = {
        fetchedAt: now().toISOString(),
        source: GATEWAY_CATALOG_SOURCE,
        rawItemCount: normalized.rawItemCount,
        configVersion,
      };

      // STEP 4: replace last-good in one transaction, or keep it — a failed replacement is a
      // failed fetch, never a half-written snapshot.
      try {
        await deps.store.replaceCatalog({
          entries: normalized.entries,
          record,
        });
      } catch (error) {
        log.error(
          {
            type: "gateway-catalog-persist-failed",
            errorName:
              error instanceof Error ? error.name : String(typeof error),
          },
          "The fetched catalog could not be persisted; the previous snapshot is kept.",
        );
        return fail("catalog_fetch_persist_failed", { configVersion });
      }

      if (normalized.issues.length > 0 || normalized.duplicateCount > 0) {
        // Counts only — never the entries themselves, whose bytes are upstream's.
        log.warn(
          {
            type: "gateway-catalog-normalization-issues",
            issueCount: normalized.issues.length,
            duplicateCount: normalized.duplicateCount,
            configVersion,
          },
          "The gateway manifest carried entries that could not be normalized; the snapshot holds the rest.",
        );
      }
      return {
        status: "ok",
        record,
        entries: normalized.entries,
        issueCount: normalized.issues.length,
        duplicateCount: normalized.duplicateCount,
      };
    },

    async listModelRefs() {
      const stored = await deps.store.readCatalogRefs();
      return stored.map((entry) => entry.ref);
    },

    async listCatalogEntries() {
      return deps.store.readCatalogRefs();
    },

    async readLastFetchOutcome() {
      return deps.store.readLatestFetchOutcome();
    },
  };
  return service;
}

/**
 * The running catalog service, resolved through the installed enterprise controls so 03.4/03.5
 * need no wiring of their own: the gate from 01.7's installed service, the endpoint from 01.1's,
 * the credential from 01.2's, and both stores over the shared database. Undefined in a test or
 * script that never installed the controls — the same answer the sibling accessors give.
 */
export function gatewayCatalogControls(): GatewayCatalogService | undefined {
  const controls = enterpriseControls();
  if (!controls) return undefined;
  const endpoint = gatewayEndpointControls();
  const credential = gatewayAdminCredentialControls();
  const gate = gatewayReadinessControls();
  if (!endpoint || !credential || !gate) return undefined;
  return createGatewayCatalogService({
    assertGatewayReady: () => gate.assertGatewayReadyForBilling(),
    readGatewayEndpoint: () => endpoint.readGatewayEndpoint(),
    resolveGatewayAdminCredential: () =>
      credential.resolveGatewayAdminCredential(),
    store: createEnterpriseGatewayCatalogStore(controls.deps.database),
    log: getLogger("server"),
  });
}
