/**
 * The craft company-search relay — OpenBot's environment-equivalent of onyx's
 * egress-proxy search path (the contract's C3/C4 rulings, the kb-search shape).
 *
 * onyx's sandbox `onyx-cli search` dials the onyx search API with a credential
 * the egress proxy injects on the wire. OpenBot has no egress proxy; the
 * company-search skill's CLI ships with the session instead and dials THIS
 * route, which is the trusted side:
 *
 * - a call attributes itself with the session-tag header the mcp block stamps
 *   (`X-Onyx-Mcp-Session`); the tag must name an ACTIVE session — the same
 *   attribution contract the MCP relay applies;
 * - the search then runs with the session owner's reach into the knowledge
 *   domain: the deployment's knowledge bases, all of them, over the same
 *   service-to-service credential the knowledge routes use (OpenBot's KB
 *   domain is deployment-tenant, not per-user — recorded in port-parity).
 *
 * Every refusal answers the relay observable — HTTP 403 with
 * `{"error": "not_authorized"}` — and never dials the knowledge service on a
 * deny path.
 *
 * The response is onyx-cli's JSON contract verbatim: a single query returns a
 * top-level `results` array; multiple queries (≤3, concurrent) return a
 * `searches` array of `{query, results}` in argument order; a failed query
 * carries `error` and null `results` while the call still answers 200. Each
 * result has `title`, `url`, `source_type`, `content`, and `updated_at`.
 * Known divergences from onyx's server side (recorded in port-parity): no
 * LLM relevance filtering of results, and `--no-query-expansion` is accepted
 * for CLI compatibility but there is no query-rewriting step to skip.
 */

import { Hono } from "hono";
import { getLogger } from "../../../shared/logger";
import { MCP_SESSION_TAG_HEADER } from "./opencode-config";
import type { CraftStore } from "./store";
import type { KnowledgeSearchResult } from "../knowledge/types";

const logger = getLogger("server");

/** onyx-cli runs at most 3 queries in one invocation. */
const MAX_QUERIES = 3;

/**
 * Per-KB result ceiling. onyx's search runs an LLM relevance filter before
 * answering; OpenBot returns retrieval order unfiltered, so the cut is a
 * plain top-N instead.
 */
const TOP_RESULTS_PER_QUERY = 20;

/** One query's owner-scoped search (wired in the boot file over knowledgeRequest). */
export type CraftKbSearch = (input: {
  query: string;
  sourceTypes?: readonly string[];
  days?: number;
}) => Promise<
  { status: "ok"; results: CraftKbSearchResult[] } | { status: "unavailable" }
>;

/** The onyx-cli result shape (the SKILL.md Output contract). */
export type CraftKbSearchResult = {
  title: string;
  url: string;
  source_type: string;
  content: string;
  updated_at: string;
};

export type CraftKbSearchRelayDeps = {
  /** Session reads without the activity bump (relay polling must not feed the idle clock). */
  store: Pick<CraftStore, "findSessionById">;
  /** The knowledge-side search, owner-scoped by wiring. */
  search: CraftKbSearch;
};

/** The 403 body: the relay payload, verbatim shape. */
const notAuthorized = () =>
  Response.json({ error: "not_authorized" }, { status: 403 });

/**
 * The relay app. Mounted beside the MCP relay — BEFORE requireUser — because
 * its caller is the session's onyx-cli, which has no user session: its
 * credential is the session tag, validated per request above.
 */
export function createCraftKbSearchRelayApp(
  deps: CraftKbSearchRelayDeps,
): Hono {
  const app = new Hono();

  app.post("/kb-search", async (context) => {
    // ── attribution: the tag must name a live session ──────────────────────
    const sessionTag = context.req.header(MCP_SESSION_TAG_HEADER);
    if (!sessionTag) {
      return notAuthorized();
    }
    const session = await deps.store
      .findSessionById(sessionTag)
      .catch(() => undefined);
    if (session?.status !== "active") {
      logger.warn(
        { sessionTag: sessionTag.slice(0, 8) },
        "[craft] kb-search relay: unattributable session tag",
      );
      return notAuthorized();
    }

    // ── the request body ────────────────────────────────────────────────────
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }
    const parsed = parseCliBody(body);
    if (!parsed.ok) {
      return Response.json({ error: parsed.message }, { status: 400 });
    }
    const { queries, sourceTypes, days } = parsed.value;

    // ── the owner's searches (≤3, concurrent — onyx-cli's batching) ───────
    const answers = await Promise.all(
      queries.map(async (query) => {
        try {
          return {
            query,
            answer: await deps.search({ query, sourceTypes, days }),
          };
        } catch {
          return { query, answer: { status: "unavailable" } as const };
        }
      }),
    );

    // Single query: the top-level results array, or 503 when it failed.
    if (queries.length === 1) {
      // `answers` is 1:1 with `queries`, so `answers[0]` is always present
      // here; folding the impossible undefined into the 503 fails closed.
      const only = answers[0];
      if (only === undefined || only.answer.status === "unavailable") {
        return Response.json(
          { error: "knowledge service is unavailable. Try again." },
          { status: 503 },
        );
      }
      return Response.json({ results: only.answer.results });
    }

    // Multi-query: searches in argument order; a failed query carries error
    // and null results while the call still answers 200 (partial failures
    // exit 0 — the SKILL.md Output contract).
    return Response.json({
      searches: answers.map(({ query, answer }) =>
        answer.status === "unavailable"
          ? { query, error: "knowledge service is unavailable", results: null }
          : { query, results: answer.results },
      ),
    });
  });

  return app;
}

type ParsedCliBody =
  | {
      ok: true;
      value: {
        queries: string[];
        sourceTypes?: string[];
        days?: number;
      };
    }
  | { ok: false; message: string };

/** The onyx-cli wire form: `{"queries": [...], "source": [...], "days": N}`. */
function parseCliBody(body: unknown): ParsedCliBody {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "body must be a JSON object" };
  }
  const queries = (body as { queries?: unknown }).queries;
  if (!Array.isArray(queries) || queries.length === 0) {
    return { ok: false, message: "queries must be a non-empty array" };
  }
  if (queries.length > MAX_QUERIES) {
    return { ok: false, message: `at most ${MAX_QUERIES} queries per call` };
  }
  if (
    !queries.every((q): q is string => typeof q === "string" && q.trim() !== "")
  ) {
    return { ok: false, message: "every query must be a non-empty string" };
  }
  const source = (body as { source?: unknown }).source;
  if (source !== undefined) {
    if (
      !Array.isArray(source) ||
      !source.every((s): s is string => typeof s === "string")
    ) {
      return { ok: false, message: "source must be an array of strings" };
    }
  }
  const days = (body as { days?: unknown }).days;
  if (days !== undefined && (typeof days !== "number" || days < 1)) {
    return { ok: false, message: "days must be a positive number" };
  }
  return {
    ok: true,
    value: {
      queries: queries as string[],
      ...(source !== undefined ? { sourceTypes: source as string[] } : {}),
      ...(days !== undefined ? { days } : {}),
    },
  };
}

/**
 * Merge one query's per-KB retrieval answers into the onyx-cli result shape:
 * dedup on (doc, chunk), order by score, apply --days and --source filters,
 * cut to the top-N ceiling. Exposed for the boot file's wiring (the wiring
 * owns the per-KB fan-out; this owns the contract projection).
 */
export function projectKbSearchResults(
  perKb: readonly KnowledgeSearchResult[],
  filters: { days?: number; sourceTypes?: readonly string[] } = {},
): CraftKbSearchResult[] {
  const seen = new Set<string>();
  const rows: Array<{ score: number; result: KnowledgeSearchResult }> = [];
  for (const result of perKb) {
    const key = `${result.doc_id}/${result.chunk_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ score: result.score, result });
  }
  rows.sort((a, b) => b.score - a.score);
  const cutoff =
    filters.days !== undefined
      ? Date.now() - filters.days * 24 * 60 * 60 * 1000
      : null;
  const projected: CraftKbSearchResult[] = [];
  for (const { result } of rows) {
    const updatedAt = result.metadata?.updated_at ?? "";
    if (cutoff !== null) {
      const at = Date.parse(updatedAt);
      if (Number.isNaN(at) || at < cutoff) continue;
    }
    if (
      filters.sourceTypes !== undefined &&
      !filters.sourceTypes.includes(result.metadata?.source_type ?? "")
    ) {
      continue;
    }
    projected.push({
      title: result.metadata?.title ?? "",
      url: result.source,
      source_type: result.metadata?.source_type ?? "",
      content: result.content,
      updated_at: updatedAt,
    });
    if (projected.length >= TOP_RESULTS_PER_QUERY) break;
  }
  return projected;
}
