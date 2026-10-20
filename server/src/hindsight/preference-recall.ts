/**
 * Hindsight 05 (#382): semantic recall of confirmed general personal preferences, across Bots
 * of the same company.
 *
 * This module is the recall seam the spec names as the personal memory module's ONLY public
 * entry for this behavior. Its contract is deliberately narrow: a Bot asks with a query and
 * receives confirmed originals — OpenBot record id, content, provenance, marking time. No bank
 * id and no remote document id ever appears in what it returns, and no caller-supplied
 * placement exists: the Hindsight bank comes from `resolveHindsightBankScope` (#381), the one
 * derived-isolation seam, which accepts nothing but a server-issued trusted scope. The same
 * global user holding principals in two companies therefore recalls from two different banks
 * in two different schemas, and another user's bank is not this caller's to name.
 *
 * Division of labor, per the parent spec (#376) and ADR 0005: Hindsight indexes and ranks; it
 * never answers content. A recall takes ONLY the hit list's `document_id`s (in rank order)
 * from the service — the extracted fact text, observations and any reflect output the response
 * also carries are read past, never surfaced — and re-loads each mapped row from the OpenBot
 * authority table, where the row must STILL be current: not forgotten, enabled, and confirmed
 * or edited. A hit with no row (orphan, or a document retained straight into the bank outside
 * this seam), a row whose review state no longer qualifies, or a document id this caller's
 * rows do not own is dropped before anything reaches the Bot. The confirmed original the Bot
 * receives is therefore always the bytes OpenBot holds, re-checked at read time.
 *
 * Sync is the same discipline in miniature: confirming a preference retains it under a stable
 * document identity derived once from the row (so an edit replaces the remote document in
 * place rather than leaving a stale twin), and the row records the digest of the content last
 * retained. A retain failure never fails the person's confirmation — the row simply stays
 * pending its first sync; the retry queue that drains such rows is #384, and safe degradation
 * when the whole service is down is #385, which is why recall here reports unavailability as
 * an error instead of quietly answering empty.
 */

import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { genericPersonalPreferences } from "../db/schema/hindsight-preferences";
import type { PlatformScope } from "../enterprise/contracts";
import {
  type HindsightBankScope,
  mintBankScopeAssertion,
  resolveHindsightBankScope,
} from "./bank-scope";

/** What a Bot receives: the confirmed original, and nothing remote-derived. */
export type RecalledGenericPreference = {
  /** The OpenBot record id — the only id this seam's contract carries. */
  id: string;
  /** The confirmed original text, re-loaded from OpenBot at recall time. */
  content: string;
  provenance: string;
  /** When the person explicitly marked this preference as general. */
  markedGenericAt: Date;
};

/** The authority row, in full; internal to the module and its tests. */
export type PreferenceAuthorityRow = {
  tenantId: string;
  id: string;
  principalId: string;
  content: string;
  provenance: string;
  reviewState: "unreviewed" | "confirmed" | "edited";
  enabled: boolean;
  deletedAt: Date | null;
  markedGenericAt: Date;
  hindsightDocumentId: string;
  syncedContentDigest: string | null;
  syncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The persistence port. All policy — review gates, tombstones, digests — lives in the service
 * above this interface, so the SQL-backed implementation below and the in-memory one the
 * real-instance contract test uses cannot drift apart on what a recall must still verify.
 */
export interface PreferenceRecordStore {
  create(row: PreferenceAuthorityRow): Promise<void>;
  load(tenantId: string, id: string): Promise<PreferenceAuthorityRow | null>;
  /** Full-row update by (tenantId, id); the id and document identity never change. */
  save(row: PreferenceAuthorityRow): Promise<void>;
  /** Rows of THIS principal in THIS company holding these document ids. */
  loadByDocumentIds(
    tenantId: string,
    principalId: string,
    documentIds: readonly string[],
  ): Promise<PreferenceAuthorityRow[]>;
}

/** How the service reaches the shared self-hosted Hindsight instance. */
export type PreferenceRecallServiceConfig = {
  /** Base origin of the Hindsight API, e.g. http://127.0.0.1:8888. No path, no credentials. */
  apiUrl: string;
  /** The deployment's shared service key (Bearer), paired with a per-request assertion. */
  serviceApiKey: string;
  /** The assertion secret shared with the service's tenant extension (bank-scope.ts). */
  assertionSecret: string;
  requestTimeoutMs?: number;
  /** Injectable for tests; the real calls use the platform's fetch with a timeout. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

/** The environment the service configuration is read from. */
export type PreferenceRecallEnv = Record<string, string | undefined>;

export class PreferenceRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreferenceRefusedError";
  }
}

export class PreferenceNotFoundError extends Error {
  constructor() {
    super("This general personal preference could not be found.");
    this.name = "PreferenceNotFoundError";
  }
}

/** The Hindsight service could not be asked; the safe-degradation path (#385) catches this. */
export class PreferenceRecallUnavailableError extends Error {
  constructor() {
    super(
      "The memory index is unreachable right now; confirmed preferences are unchanged and will recall once it is back.",
    );
    this.name = "PreferenceRecallUnavailableError";
  }
}

/** How long one minted assertion stays valid; fresh per request, so short is correct. */
const ASSERTION_TTL_MS = 60_000;
/** The pinned deployment is single-tenant on the service side; the segment is a constant. */
const HINDSIGHT_TENANT_SEGMENT = "default";
const CONTENT_MAX = 6000;
const PROVENANCE_MAX = 500;
const QUERY_MAX = 512;
/** Bot-context economy: recall answers at most this many confirmed originals. */
const RECALL_LIMIT = 20;

const digestOf = (content: string) =>
  createHash("sha256").update(content).digest("hex");

function hash16(namespace: string, value: string): string {
  return createHash("sha256")
    .update(`${namespace}:${value}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * The stable document identity of one preference row. Deterministic over the row's own
 * (tenant, id), so the same row always indexes as the same document and no derivation output
 * can collide with another subject's — the same discipline bank ids follow in bank-scope.ts.
 */
export function preferenceDocumentIdFor(
  tenantId: string,
  recordId: string,
): string {
  return `hgp_${hash16("generic-preference", `${tenantId}:${recordId}`)}`;
}

/**
 * Read the service configuration from the environment, refusing anything misdeclared rather
 * than defaulting it: a defaulted URL or key would send confirmed preferences to the wrong
 * service, and a defaulted secret would mint assertions the service rightly refuses.
 */
export function preferenceRecallConfigFromEnv(
  env: PreferenceRecallEnv = process.env,
): PreferenceRecallServiceConfig {
  const apiUrl = env.HINDSIGHT_API_URL?.trim();
  if (!apiUrl) throw new Error("HINDSIGHT_API_URL is required and is not configured.");
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error("HINDSIGHT_API_URL must be a valid http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("HINDSIGHT_API_URL must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("HINDSIGHT_API_URL must not carry credentials in the URL.");
  }
  const serviceApiKey = env.HINDSIGHT_API_TOKEN?.trim();
  if (!serviceApiKey) {
    throw new Error("HINDSIGHT_API_TOKEN is required and is not configured.");
  }
  const assertionSecret = env.HINDSIGHT_BANK_ASSERTION_SECRET?.trim();
  if (!assertionSecret) {
    throw new Error(
      "HINDSIGHT_BANK_ASSERTION_SECRET must declare the secret shared with the Hindsight service's tenant extension before preferences can be indexed or recalled.",
    );
  }
  const requestTimeoutMs = Number(env.HINDSIGHT_REQUEST_TIMEOUT_MS ?? 5000);
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error(
      "HINDSIGHT_REQUEST_TIMEOUT_MS must be a positive number of milliseconds.",
    );
  }
  return {
    apiUrl: parsed.origin,
    serviceApiKey,
    assertionSecret,
    requestTimeoutMs,
  };
}

function plainString(
  value: unknown,
  field: string,
  max: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max
  ) {
    throw new PreferenceRefusedError(
      `A general personal preference needs ${field} of 1..${max} characters.`,
    );
  }
  return value;
}

/** Map a database row to the contract a Bot sees: no bank, no document id, no sync state. */
const toView = (row: PreferenceAuthorityRow): RecalledGenericPreference => ({
  id: row.id,
  content: row.content,
  provenance: row.provenance,
  markedGenericAt: row.markedGenericAt,
});

/** A row a recall may still hand to a Bot: live, on, and confirmed or edited. */
const recallEligible = (row: PreferenceAuthorityRow) =>
  row.deletedAt === null &&
  row.enabled &&
  (row.reviewState === "confirmed" || row.reviewState === "edited") &&
  row.content !== "";

export function createPreferenceRecallService(
  store: PreferenceRecordStore,
  config: PreferenceRecallServiceConfig,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());
  const doFetch =
    config.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));

  /**
   * One authenticated call into the shared Hindsight service: the deployment's service key
   * paired with a freshly minted assertion carrying exactly this grant. Neither half alone
   * authenticates anything on memory routes (#381's contract).
   */
  async function hindsight(
    grant: HindsightBankScope,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Response> {
    const token = mintBankScopeAssertion(grant, {
      secret: config.assertionSecret,
      ttlMs: ASSERTION_TTL_MS,
      now: now(),
    });
    return doFetch(`${config.apiUrl}${path}`, {
      method: init.method ?? "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.serviceApiKey}`,
        "x-openbot-bank-scope": token,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(config.requestTimeoutMs ?? 5000),
    });
  }

  /**
   * Retain one row's confirmed content under its stable document identity. `replace` makes the
   * retain idempotent per document: an edit supersedes what the service held instead of
   * appending a second copy. A non-2xx answer is reported, never thrown — the authority row
   * stands on its own and simply stays pending its sync (#384 drains those).
   */
  async function retain(
    grant: HindsightBankScope,
    row: PreferenceAuthorityRow,
  ): Promise<boolean> {
    try {
      const response = await hindsight(
        grant,
        `/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${grant.banks[0].id}/memories`,
        {
          body: {
            items: [
              {
                content: row.content,
                document_id: row.hindsightDocumentId,
                update_mode: "replace",
              },
            ],
          },
        },
      );
      if (!response.ok) return false;
      row.syncedContentDigest = digestOf(row.content);
      row.syncedAt = now();
      return true;
    } catch {
      return false;
    }
  }

  return {
    /**
     * Confirm a preference and mark it general: the person's explicit double decision. The row
     * is created confirmed and retained to Hindsight under its derived document identity; the
     * marking time records the decision. `remoteSynced` tells the caller whether this content
     * is indexed yet — false never invalidates the confirmation.
     */
    async confirmGenericPreference(
      scope: PlatformScope,
      input: { content: unknown; provenance?: unknown },
    ): Promise<{
      record: RecalledGenericPreference;
      remoteSynced: boolean;
    }> {
      const grant = resolveHindsightBankScope(scope);
      const content = plainString(input.content, "content", CONTENT_MAX);
      const provenance = plainString(
        input.provenance ?? "You",
        "provenance",
        PROVENANCE_MAX,
      );
      // Authority first: the row exists before anything leaves for the service, so a retain
      // that never completes leaves a pending row, never an indexed orphan.
      const id = randomUUID();
      const row: PreferenceAuthorityRow = {
        tenantId: grant.tenantId,
        id,
        principalId: grant.principalId,
        content,
        provenance,
        reviewState: "confirmed",
        enabled: true,
        deletedAt: null,
        markedGenericAt: now(),
        hindsightDocumentId: preferenceDocumentIdFor(grant.tenantId, id),
        syncedContentDigest: null,
        syncedAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      await store.create(row);
      const remoteSynced = await retain(grant, row);
      if (remoteSynced) await store.save(row);
      return { record: toView(row), remoteSynced };
    },

    /**
     * Edit the confirmed original. The document identity stays put, so the retain replaces the
     * indexed document in place; an edit is itself a review act, so the row stays recallable
     * as `edited`.
     */
    async editGenericPreference(
      scope: PlatformScope,
      id: string,
      input: { content: unknown },
    ): Promise<{ record: RecalledGenericPreference; remoteSynced: boolean }> {
      const grant = resolveHindsightBankScope(scope);
      const content = plainString(input.content, "content", CONTENT_MAX);
      const row = await store.load(grant.tenantId, id);
      if (!row || row.principalId !== grant.principalId || row.deletedAt !== null)
        throw new PreferenceNotFoundError();
      row.content = content;
      row.reviewState = "edited";
      row.updatedAt = now();
      const remoteSynced = await retain(grant, row);
      await store.save(row);
      return { record: toView(row), remoteSynced };
    },

    /**
     * Forget a preference: tombstoned the way the personal memory store forgets (content
     * cleared, disabled), so no later recall of the same document can resurrect it, and the
     * remote document is deleted best-effort. A failed remote delete leaves a hit that recall
     * drops anyway — no current OpenBot row, no Bot-visible content; the durable deletion
     * ledger and its retries are the later tickets' (#384 and the deletion track).
     */
    async forgetGenericPreference(scope: PlatformScope, id: string) {
      const grant = resolveHindsightBankScope(scope);
      const row = await store.load(grant.tenantId, id);
      if (!row || row.principalId !== grant.principalId || row.deletedAt !== null)
        throw new PreferenceNotFoundError();
      row.deletedAt = now();
      row.enabled = false;
      row.content = "";
      row.syncedContentDigest = null;
      row.syncedAt = null;
      row.updatedAt = now();
      await store.save(row);
      try {
        await hindsight(
          grant,
          `/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${grant.banks[0].id}/documents/${encodeURIComponent(row.hindsightDocumentId)}`,
          { method: "DELETE" },
        );
      } catch {
        // Best effort by design; see the doc comment.
      }
    },

    /**
     * THE recall seam: Hindsight ranks, OpenBot answers. Only the hit list's document ids (in
     * rank order) are taken from the service; every extracted fact text, observation and
     * reflect output the response carries is read past. Each id is then resolved against this
     * principal's current rows in this company, and anything without a live, enabled,
     * confirmed-or-edited row is dropped. Cross-company and cross-user isolation ride the bank
     * derivation itself (#381): the answer below is defense in depth, not the boundary.
     */
    async recallGenericPreferences(
      scope: PlatformScope,
      input: { query: unknown; askingAgentId?: unknown },
    ): Promise<RecalledGenericPreference[]> {
      const grant = resolveHindsightBankScope(scope);
      const query = plainString(input.query, "a query", QUERY_MAX).trim();
      if (input.askingAgentId !== undefined) {
        plainString(input.askingAgentId, "an asking agent id", 128);
      }
      let response: Response;
      try {
        response = await hindsight(
          grant,
          `/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${grant.banks[0].id}/memories/recall`,
          { body: { query } },
        );
      } catch {
        throw new PreferenceRecallUnavailableError();
      }
      // A bank the service has never seen is a person who has confirmed nothing yet — that
      // is an empty recall, not an outage; the bank appears on the first retain.
      if (response.status === 404) return [];
      if (!response.ok) throw new PreferenceRecallUnavailableError();
      const payload = (await response.json().catch(() => null)) as {
        results?: { document_id?: unknown }[];
      } | null;
      // Document ids only, first-seen order: the service's ranking, nothing else.
      const ranked: string[] = [];
      const seen = new Set<string>();
      for (const hit of payload?.results ?? []) {
        const documentId = hit?.document_id;
        if (typeof documentId !== "string" || seen.has(documentId)) continue;
        seen.add(documentId);
        ranked.push(documentId);
      }
      if (!ranked.length) return [];
      const rows = await store.loadByDocumentIds(
        grant.tenantId,
        grant.principalId,
        ranked,
      );
      const byDocument = new Map(
        rows.map((row) => [row.hindsightDocumentId, row]),
      );
      return ranked
        .flatMap((documentId) => {
          const row = byDocument.get(documentId);
          return row && recallEligible(row) ? [toView(row)] : [];
        })
        .slice(0, RECALL_LIMIT);
    },
  };
}

export type PreferenceRecallService = ReturnType<
  typeof createPreferenceRecallService
>;

/** The SQL-backed record store: mechanical persistence only, all policy lives above it. */
export function createDrizzlePreferenceRecords(
  database: Database,
): PreferenceRecordStore {
  const table = genericPersonalPreferences;
  return {
    async create(row) {
      await database.insert(table).values(row);
    },
    async load(tenantId, id) {
      const [found] = await database
        .select()
        .from(table)
        .where(and(eq(table.tenantId, tenantId), eq(table.id, id)))
        .limit(1);
      return found ?? null;
    },
    async save(row) {
      await database
        .update(table)
        .set({
          content: row.content,
          provenance: row.provenance,
          reviewState: row.reviewState,
          enabled: row.enabled,
          deletedAt: row.deletedAt,
          syncedContentDigest: row.syncedContentDigest,
          syncedAt: row.syncedAt,
          updatedAt: row.updatedAt,
        })
        .where(and(eq(table.tenantId, row.tenantId), eq(table.id, row.id)));
    },
    async loadByDocumentIds(tenantId, principalId, documentIds) {
      if (!documentIds.length) return [];
      return database
        .select()
        .from(table)
        .where(
          and(
            eq(table.tenantId, tenantId),
            eq(table.principalId, principalId),
            inArray(table.hindsightDocumentId, [...documentIds]),
          ),
        );
    },
  };
}
