import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * The step-level half of the OpenBot↔Opik id mapping (Issue #23/T17).
 *
 * Run↔trace lives on the binding table and dataset↔dataset on the dataset table —
 * both are already authoritative ownership rows, so this table mints no second copy
 * of either fact. What neither holds is the mapping a governed step span needs: the
 * local step id (a toolCallId) against the upstream span id this deployment chose
 * and the backend adopted verbatim (the explicit `opik.*` id strategy). A row here
 * is written only after the span's upstream write landed, so an id that Opik never
 * adopted can never appear.
 *
 * `observedTraceId` is the W3C trace id the segment actually carried — the evidence the
 * chain check reads: a step claiming a trace that is not its run's binding trace is a
 * broken link, refused before anything is stored. Ownership is copied from the trusted
 * scope (T06), never accepted from the caller; both unique keys participate in
 * `scope_key`, so the same ids under another scope are different subjects, never
 * collisions, and each direction answers at most one row — the mapping is unambiguous
 * by construction.
 */

export type AiObservationIdLinkLocalKind = "tool_step" | "retrieval_step";
export type AiObservationIdLinkUpstreamKind = "span";

export const aiObservationIdLinks = pgTable(
  "ai_observation_id_links",
  {
    id: text("id").primaryKey(),
    /** The trusted scope's key. Ownership resolution starts here, never from Opik metadata. */
    scopeKey: text("scope_key").notNull(),
    actorId: text("actor_id").notNull(),
    botId: text("bot_id").notNull(),
    localKind: text("local_kind")
      .$type<AiObservationIdLinkLocalKind>()
      .notNull(),
    localId: text("local_id").notNull(),
    upstreamKind: text("upstream_kind")
      .$type<AiObservationIdLinkUpstreamKind>()
      .notNull(),
    upstreamId: text("upstream_id").notNull(),
    /** The run the linked step belonged to, when known — context, not authority. */
    runId: text("run_id"),
    /** The W3C trace id the segment carried: the chain-check evidence. */
    observedTraceId: text("observed_trace_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "ai_observation_id_links_local_kind_check",
      sql`${table.localKind} IN ('tool_step', 'retrieval_step')`,
    ),
    check(
      "ai_observation_id_links_upstream_kind_check",
      sql`${table.upstreamKind} IN ('span')`,
    ),
    uniqueIndex("ai_observation_id_links_scope_local_uq").on(
      table.scopeKey,
      table.localKind,
      table.localId,
    ),
    uniqueIndex("ai_observation_id_links_scope_upstream_uq").on(
      table.scopeKey,
      table.upstreamKind,
      table.upstreamId,
    ),
  ],
);
