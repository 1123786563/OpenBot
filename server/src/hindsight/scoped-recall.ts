/**
 * Hindsight 06 (#383): authorized recall of source-bound personal memories.
 *
 * A source-bound memory is a business fact the person confirmed out of a team conversation or
 * a connected source, and whose visibility STAYS bound to the scope that formed it — the
 * person's confirmation never lifts it into the general-preference bank (that is a different
 * seam, preference-recall.ts, over a different authority table, so team A's facts cannot reach
 * team B's Bots here even in principle). This module is the recall seam for that half of the
 * spec, and it inherits #382's division of labor whole: Hindsight ranks, OpenBot answers. Only
 * each bank's hit list of document ids is taken from the service; the content a Bot receives
 * is the confirmed original re-loaded from this principal's rows in this company.
 *
 * The bank set is not a property of the person; it is a property of the moment. A recall takes
 * a CURRENT authorization snapshot — an active membership in the ASKING workspace, enabled
 * connected sources, and the asking Bot's own standing — turns it into team/source/bot banks
 * through
 * `resolveScopedHindsightBankScope` (#381's derived-isolation seam; nothing client-supplied
 * can name a bank), recalls each bank under one short-lived assertion, and then re-reads the
 * authorization AFTER the remote has answered, before any hit becomes a Bot-visible fact. That
 * second read is the TOCTOU clause: a source disabled, a membership suspended, or a Bot's app
 * revoked between hit and load drops the hit the same as one revoked an hour ago. A revocation
 * landing before the recall shrinks the bank list itself — the service never sees the question.
 *
 * An administrator is not an exception: a trusted admin scope is still one principal, and the
 * rows this seam loads are pinned to (tenant, principal), so an admin asking about an
 * employee's memories gets the same answer any other non-owner gets — nothing. Tags are never
 * sent, and never consulted: the bank grant is the boundary (#381's validator enforces the
 * same on the service side).
 *
 * Sync follows #382's discipline: confirming retains into the row's restricted bank under a
 * stable document identity (an edit replaces the remote document in place); a retain failure
 * never fails the confirmation — the row awaits its sync, and the durable retry queue is #384
 * (this module accepts a work recorder so the queue can be attached without a route knowing
 * about it).
 */

import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  hindsightMemoryGrants,
  sourceBoundMemories,
} from "../db/schema/hindsight-source-bound";
import { enterpriseWorkspaceMemberships } from "../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../enterprise/contracts";
import {
  backgroundTaskBankScope,
  type HindsightBankGrant,
  type HindsightBankScope,
  botBankFor,
  mintBankScopeAssertion,
  resolveHindsightBankScope,
  resolveScopedHindsightBankScope,
  sourceBankFor,
  teamBankFor,
} from "./bank-scope";
import type { PreferenceRecallServiceConfig } from "./preference-recall";

/** The restriction that carves a memory's bank; exactly one target, spelled by the kind. */
export type SourceBoundRestriction =
  | { kind: "team"; workspaceId: string }
  | { kind: "source"; sourceId: string }
  | { kind: "bot"; agentId: string };

/** What a Bot receives: the confirmed original, its restriction, and nothing remote-derived. */
export type RecalledSourceBoundMemory = {
  /** The OpenBot record id — the only id this seam's contract carries. */
  id: string;
  content: string;
  provenance: string;
  /** Which scope's authorization still gates this fact: the forming team, source, or Bot. */
  restriction: SourceBoundRestriction;
  /** When the fact was formed — the evidence the person confirmed. */
  formedAt: Date;
};

/** The authority row, in full; internal to the module and its tests. */
export type SourceBoundRecordRow = {
  tenantId: string;
  id: string;
  principalId: string;
  restriction: "team" | "source" | "bot";
  workspaceId: string | null;
  sourceId: string | null;
  agentId: string | null;
  content: string;
  provenance: string;
  reviewState: "unreviewed" | "confirmed" | "edited";
  enabled: boolean;
  deletedAt: Date | null;
  formedAt: Date;
  hindsightDocumentId: string;
  syncedContentDigest: string | null;
  syncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** The persistence port; all policy lives in the service above it. */
export interface SourceBoundRecordStore {
  create(row: SourceBoundRecordRow): Promise<void>;
  load(tenantId: string, id: string): Promise<SourceBoundRecordRow | null>;
  /** Full-row update by (tenantId, id); the id and document identity never change. */
  save(row: SourceBoundRecordRow): Promise<void>;
  /** Rows of THIS principal in THIS company holding these document ids. */
  loadByDocumentIds(
    tenantId: string,
    principalId: string,
    documentIds: readonly string[],
  ): Promise<SourceBoundRecordRow[]>;
}

/**
 * The live authorization facts a recall (and a confirm) must read from current server state.
 * Implementations answer from the tenancy tables and the grant registry — never from the
 * request — so a snapshot is always a fresh read, which is what makes the post-hit re-read a
 * real check rather than a cached one.
 */
export interface SourceBoundAuthorizationStore {
  /** Whether the principal's membership in this workspace is currently active. */
  workspaceMembershipActive(
    tenantId: string,
    principalId: string,
    workspaceId: string,
  ): Promise<boolean>;
  enabledSourceIds(
    tenantId: string,
    principalId: string,
  ): Promise<readonly string[]>;
  botAuthorized(
    tenantId: string,
    principalId: string,
    agentId: string,
  ): Promise<boolean>;
}

/** The durable sync-work recorder #384 attaches; structural, so the queue satisfies it. */
export interface SourceBoundWorkRecorder {
  record(input: {
    subjectType: "source_bound";
    tenantId: string;
    subjectId: string;
    principalId: string;
    contentDigest: string;
  }): Promise<void>;
}

export class SourceBoundRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceBoundRefusedError";
  }
}

export class SourceBoundNotFoundError extends Error {
  constructor() {
    super("This source-bound memory could not be found.");
    this.name = "SourceBoundNotFoundError";
  }
}

/** The Hindsight service could not be asked; the safe-degradation path (#385) catches this. */
export class SourceBoundRecallUnavailableError extends Error {
  constructor() {
    super(
      "The memory index is unreachable right now; source-bound memories are unchanged and will recall once it is back.",
    );
    this.name = "SourceBoundRecallUnavailableError";
  }
}

/** How long one minted assertion stays valid; fresh per request, so short is correct. */
const ASSERTION_TTL_MS = 60_000;
/** The pinned deployment is single-tenant on the service side; the segment is a constant. */
const HINDSIGHT_TENANT_SEGMENT = "default";
const CONTENT_MAX = 6000;
const PROVENANCE_MAX = 500;
const QUERY_MAX = 512;
const AGENT_ID_MAX = 128;
const TARGET_ID_MAX = 256;
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
 * The stable document identity of one source-bound row: deterministic over the row's own
 * (tenant, id), the same discipline bank ids and preference documents follow.
 */
export function sourceBoundDocumentIdFor(
  tenantId: string,
  recordId: string,
): string {
  return `hsb_${hash16("source-bound", `${tenantId}:${recordId}`)}`;
}

function plainString(value: unknown, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max
  ) {
    throw new SourceBoundRefusedError(
      `A source-bound memory needs ${field} of 1..${max} characters.`,
    );
  }
  return value;
}

/** Parse and shape-check a caller's restriction claim; the target is authorization-checked next. */
function parseRestriction(input: unknown): SourceBoundRestriction {
  if (typeof input !== "object" || input === null) {
    throw new SourceBoundRefusedError(
      "A source-bound memory needs a restriction of { kind, workspaceId | sourceId | agentId }.",
    );
  }
  const record = input as Record<string, unknown>;
  if (record.kind === "team") {
    return {
      kind: "team",
      workspaceId: plainString(
        record.workspaceId,
        "a workspace id",
        TARGET_ID_MAX,
      ),
    };
  }
  if (record.kind === "source") {
    return {
      kind: "source",
      sourceId: plainString(record.sourceId, "a source id", TARGET_ID_MAX),
    };
  }
  if (record.kind === "bot") {
    return {
      kind: "bot",
      agentId: plainString(record.agentId, "an agent id", TARGET_ID_MAX),
    };
  }
  throw new SourceBoundRefusedError(
    "A restriction kind must be team, source, or bot.",
  );
}

const restrictionOf = (row: SourceBoundRecordRow): SourceBoundRestriction =>
  row.restriction === "team"
    ? { kind: "team", workspaceId: row.workspaceId ?? "" }
    : row.restriction === "source"
      ? { kind: "source", sourceId: row.sourceId ?? "" }
      : { kind: "bot", agentId: row.agentId ?? "" };

/** The bank a row's restriction carves; the placement derivations stay in bank-scope.ts. */
export function bankGrantForRestriction(
  restriction: SourceBoundRestriction,
): HindsightBankGrant {
  return restriction.kind === "team"
    ? { id: teamBankFor(restriction.workspaceId), kind: "team" }
    : restriction.kind === "source"
      ? { id: sourceBankFor(restriction.sourceId), kind: "source" }
      : { id: botBankFor(restriction.agentId), kind: "bot" };
}

/** Map a database row to the contract a Bot sees: no bank, no document id, no sync state. */
const toView = (row: SourceBoundRecordRow): RecalledSourceBoundMemory => ({
  id: row.id,
  content: row.content,
  provenance: row.provenance,
  restriction: restrictionOf(row),
  formedAt: row.formedAt,
});

/** A row a recall may still hand to a Bot: live, on, and confirmed or edited. */
const recallEligible = (row: SourceBoundRecordRow) =>
  row.deletedAt === null &&
  row.enabled &&
  (row.reviewState === "confirmed" || row.reviewState === "edited") &&
  row.content !== "";

/** One authorization snapshot, as the recall and confirm paths read it. */
type AuthorizationSnapshot = {
  workspaceId: string;
  workspaceActive: boolean;
  sourceIds: readonly string[];
  agentId: string | undefined;
  agentAuthorized: boolean;
};

/**
 * Whether a row's restriction is still authorized under a snapshot (the load-time check). A
 * team row answers only the asking workspace's conversations, and only while membership there
 * is active — team A's facts cannot reach a team B recall even if the service hands the
 * document id over.
 */
function stillAuthorized(
  row: SourceBoundRecordRow,
  snapshot: AuthorizationSnapshot,
): boolean {
  if (row.restriction === "team") {
    return (
      snapshot.workspaceActive && row.workspaceId === snapshot.workspaceId
    );
  }
  if (row.restriction === "source") {
    return snapshot.sourceIds.includes(row.sourceId ?? "");
  }
  return (
    snapshot.agentId !== undefined &&
    snapshot.agentId === row.agentId &&
    snapshot.agentAuthorized
  );
}

/** Whether a claimed restriction is authorized for a CONFIRM (present authority, both sides). */
function restrictionAuthorized(
  restriction: SourceBoundRestriction,
  snapshot: AuthorizationSnapshot,
): boolean {
  return stillAuthorized(
    {
      restriction: restriction.kind,
      workspaceId: restriction.kind === "team" ? restriction.workspaceId : null,
      sourceId: restriction.kind === "source" ? restriction.sourceId : null,
      agentId: restriction.kind === "bot" ? restriction.agentId : null,
    } as SourceBoundRecordRow,
    snapshot,
  );
}

export function createSourceBoundRecallService(
  records: SourceBoundRecordStore,
  authorizations: SourceBoundAuthorizationStore,
  config: PreferenceRecallServiceConfig,
  options: { now?: () => Date; work?: SourceBoundWorkRecorder } = {},
) {
  const now = options.now ?? (() => new Date());
  const doFetch =
    config.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));

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

  /** Retain one row's confirmed content into its restricted bank; failure leaves the row pending. */
  async function retain(
    grant: HindsightBankScope,
    bankId: string,
    row: SourceBoundRecordRow,
  ): Promise<boolean> {
    try {
      const response = await hindsight(
        grant,
        `/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${bankId}/memories`,
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

  /** Read the authorization snapshot live; the recall reads it twice by design. */
  async function readAuthorization(
    tenantId: string,
    principalId: string,
    workspaceId: string,
    agentId: string | undefined,
  ): Promise<AuthorizationSnapshot> {
    const [workspaceActive, sourceIds] = await Promise.all([
      authorizations.workspaceMembershipActive(tenantId, principalId, workspaceId),
      authorizations.enabledSourceIds(tenantId, principalId),
    ]);
    const agentAuthorized =
      agentId === undefined
        ? false
        : await authorizations.botAuthorized(tenantId, principalId, agentId);
    return { workspaceId, workspaceActive, sourceIds, agentId, agentAuthorized };
  }

  return {
    /**
     * Confirm a source-bound memory. The restriction must be CURRENTLY authorized — the bank is
     * chosen by present authority, not by the claim — and the retain goes into that restriction's
     * bank, never the user bank: confirming a source-bound fact cannot make it a general
     * preference. A retain failure never fails the confirmation.
     */
    async confirmSourceBoundMemory(
      scope: PlatformScope,
      input: {
        content: unknown;
        provenance?: unknown;
        restriction: unknown;
      },
    ): Promise<{ record: RecalledSourceBoundMemory; remoteSynced: boolean }> {
      const identity = resolveHindsightBankScope(scope);
      const content = plainString(input.content, "content", CONTENT_MAX);
      const provenance = plainString(
        input.provenance ?? "You",
        "provenance",
        PROVENANCE_MAX,
      );
      const restriction = parseRestriction(input.restriction);
      const snapshot = await readAuthorization(
        identity.tenantId,
        identity.principalId,
        scope.workspaceId,
        restriction.kind === "bot" ? restriction.agentId : undefined,
      );
      if (!restrictionAuthorized(restriction, snapshot)) {
        throw new SourceBoundRefusedError(
          "This restriction is not currently authorized for you; the memory cannot be confirmed into it.",
        );
      }
      const bank = bankGrantForRestriction(restriction);
      // Authority first: the row exists before anything leaves for the service.
      const id = randomUUID();
      const row: SourceBoundRecordRow = {
        tenantId: identity.tenantId,
        id,
        principalId: identity.principalId,
        restriction: restriction.kind,
        workspaceId: restriction.kind === "team" ? restriction.workspaceId : null,
        sourceId: restriction.kind === "source" ? restriction.sourceId : null,
        agentId: restriction.kind === "bot" ? restriction.agentId : null,
        content,
        provenance,
        reviewState: "confirmed",
        enabled: true,
        deletedAt: null,
        formedAt: now(),
        hindsightDocumentId: sourceBoundDocumentIdFor(identity.tenantId, id),
        syncedContentDigest: null,
        syncedAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      await records.create(row);
      if (options.work) {
        await options.work.record({
          subjectType: "source_bound",
          tenantId: row.tenantId,
          subjectId: row.id,
          principalId: row.principalId,
          contentDigest: digestOf(row.content),
        });
      }
      const remoteSynced = await retain(
        backgroundTaskBankScope(identity, bank),
        bank.id,
        row,
      );
      if (remoteSynced) await records.save(row);
      return { record: toView(row), remoteSynced };
    },

    /**
     * THE source-bound recall: snapshot one resolves the bank set, one assertion covers them all,
     * each bank is asked in turn, and only the merged hit list's document ids survive — then the
     * authorization is re-read and every hit must still pass it, the tombstone rules, and this
     * principal's own rows. An empty snapshot answers empty; nothing is ever guessed into a bank.
     */
    async recallSourceBoundMemories(
      scope: PlatformScope,
      input: { query: unknown; askingAgentId?: unknown },
    ): Promise<RecalledSourceBoundMemory[]> {
      const identity = resolveHindsightBankScope(scope);
      const query = plainString(input.query, "a query", QUERY_MAX).trim();
      let askingAgentId: string | undefined;
      if (input.askingAgentId !== undefined) {
        askingAgentId = plainString(
          input.askingAgentId,
          "an asking agent id",
          AGENT_ID_MAX,
        );
      }
      const first = await readAuthorization(
        identity.tenantId,
        identity.principalId,
        scope.workspaceId,
        askingAgentId,
      );
      const grant = resolveScopedHindsightBankScope(scope, {
        workspaceActive: first.workspaceActive,
        sourceIds: first.sourceIds,
        agentId:
          askingAgentId !== undefined && first.agentAuthorized
            ? askingAgentId
            : undefined,
      });
      if (!grant.banks.length) return [];
      const ranked: string[] = [];
      const seen = new Set<string>();
      for (const bank of grant.banks) {
        let response: Response;
        try {
          response = await hindsight(
            grant,
            `/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${bank.id}/memories/recall`,
            { body: { query } },
          );
        } catch {
          throw new SourceBoundRecallUnavailableError();
        }
        // A bank the service has never seen is a scope that has confirmed nothing yet.
        if (response.status === 404) continue;
        if (!response.ok) throw new SourceBoundRecallUnavailableError();
        const payload = (await response.json().catch(() => null)) as {
          results?: { document_id?: unknown }[];
        } | null;
        for (const hit of payload?.results ?? []) {
          const documentId = hit?.document_id;
          if (typeof documentId !== "string" || seen.has(documentId)) continue;
          seen.add(documentId);
          ranked.push(documentId);
        }
      }
      if (!ranked.length) return [];
      const rows = await records.loadByDocumentIds(
        grant.tenantId,
        grant.principalId,
        ranked,
      );
      // The second read: what the authorization looks like NOW, after the remote answered —
      // a revocation that landed between hit and load is blocked exactly here.
      const current = await readAuthorization(
        grant.tenantId,
        grant.principalId,
        scope.workspaceId,
        askingAgentId,
      );
      const byDocument = new Map(
        rows.map((row) => [row.hindsightDocumentId, row]),
      );
      return ranked
        .flatMap((documentId) => {
          const row = byDocument.get(documentId);
          return row &&
            recallEligible(row) &&
            stillAuthorized(row, current)
            ? [toView(row)]
            : [];
        })
        .slice(0, RECALL_LIMIT);
    },
  };
}

export type SourceBoundRecallService = ReturnType<
  typeof createSourceBoundRecallService
>;

/** The SQL-backed record store: mechanical persistence only, all policy lives above it. */
export function createDrizzleSourceBoundRecords(
  database: Database,
): SourceBoundRecordStore {
  const table = sourceBoundMemories;
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

/**
 * The SQL-backed authorization store: workspace membership is read live from the tenancy
 * table; sources and Bots from the grant registry. Every call is a fresh read — the recall
 * seam's TOCTOU clause depends on it.
 */
export function createDrizzleSourceBoundAuthorizations(
  database: Database,
): SourceBoundAuthorizationStore {
  return {
    async workspaceMembershipActive(tenantId, principalId, workspaceId) {
      const [found] = await database
        .select({ status: enterpriseWorkspaceMemberships.status })
        .from(enterpriseWorkspaceMemberships)
        .where(
          and(
            eq(enterpriseWorkspaceMemberships.tenantId, tenantId),
            eq(enterpriseWorkspaceMemberships.workspaceId, workspaceId),
            eq(enterpriseWorkspaceMemberships.principalId, principalId),
          ),
        )
        .limit(1);
      return found?.status === "active";
    },
    async enabledSourceIds(tenantId, principalId) {
      const rows = await database
        .select({ targetId: hindsightMemoryGrants.targetId })
        .from(hindsightMemoryGrants)
        .where(
          and(
            eq(hindsightMemoryGrants.tenantId, tenantId),
            eq(hindsightMemoryGrants.principalId, principalId),
            eq(hindsightMemoryGrants.kind, "source"),
            eq(hindsightMemoryGrants.enabled, true),
          ),
        );
      return rows.map((row) => row.targetId);
    },
    async botAuthorized(tenantId, principalId, agentId) {
      const [found] = await database
        .select({ enabled: hindsightMemoryGrants.enabled })
        .from(hindsightMemoryGrants)
        .where(
          and(
            eq(hindsightMemoryGrants.tenantId, tenantId),
            eq(hindsightMemoryGrants.principalId, principalId),
            eq(hindsightMemoryGrants.kind, "bot"),
            eq(hindsightMemoryGrants.targetId, agentId),
          ),
        )
        .limit(1);
      return found?.enabled === true;
    },
  };
}
