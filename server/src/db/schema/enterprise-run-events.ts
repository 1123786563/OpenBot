/**
 * Enterprise run event domain: committed messages, checkpoints, the durable event log, public
 * snapshots and the dispatch outbox. Plan 03 §4.1 (events domain).
 *
 * All five tables hang off a run through the composite (tenant_id, run_id) pair; the
 * attempt-scoped ones additionally reference (tenant_id, run_id, attempt_id). Platform-generated
 * events carry a NULL attempt — the unique (tenant, run, attempt, source) index does not bind
 * NULLs, so the partial unique index enterprise_platform_event_source (custom RLS migration)
 * covers exactly that case. JSON columns use the local single-serialisation jsonb.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { enterpriseRunAttempts, enterpriseRuns } from "./enterprise-runs";
// NOT drizzle's `jsonb`: that one serialises, and so does the driver, so the payload would land
// as a double-encoded string. See ./json.ts.
import { jsonb } from "./json";

const stamp = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

const counter = (name: string) => bigint(name, { mode: "bigint" });

export const enterpriseRunMessages = pgTable(
  "enterprise_run_messages",
  {
    tenantId: text("tenant_id").notNull(),
    runId: text("run_id").notNull(),
    id: text("id").notNull(),
    attemptId: text("attempt_id").notNull(),
    turnId: text("turn_id").notNull(),
    role: text("role").notNull(),
    /* Bounded encrypted-store reference resolved by the fixed content-store mapping, not a URI. */
    contentRef: text("content_ref").notNull(),
    contentDigest: text("content_digest").notNull(),
    status: text("status").notNull(),
    operationRef: text("operation_ref"),
    createdAt: stamp(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.runId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [enterpriseRuns.tenantId, enterpriseRuns.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.runId, t.attemptId],
      foreignColumns: [
        enterpriseRunAttempts.tenantId,
        enterpriseRunAttempts.runId,
        enterpriseRunAttempts.id,
      ],
    }),
    check(
      "enterprise_message_role",
      sql`${t.role} in ('user','assistant','tool')`,
    ),
    check(
      "enterprise_message_status",
      sql`${t.status} in ('partial','committed')`,
    ),
  ],
);

export const enterpriseRunCheckpoints = pgTable(
  "enterprise_run_checkpoints",
  {
    tenantId: text("tenant_id").notNull(),
    runId: text("run_id").notNull(),
    id: text("id").notNull(),
    attemptId: text("attempt_id").notNull(),
    stepId: text("step_id").notNull(),
    contentDigest: text("content_digest").notNull(),
    runtimeCompatibility: text("runtime_compatibility").notNull(),
    expertVersion: text("expert_version").notNull(),
    /* Recovery payload per §6; credentials never land here. */
    payload: jsonb("payload").notNull(),
    createdAt: stamp(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.runId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [enterpriseRuns.tenantId, enterpriseRuns.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.runId, t.attemptId],
      foreignColumns: [
        enterpriseRunAttempts.tenantId,
        enterpriseRunAttempts.runId,
        enterpriseRunAttempts.id,
      ],
    }),
  ],
);

export const enterpriseRunEvents = pgTable(
  "enterprise_run_events",
  {
    tenantId: text("tenant_id").notNull(),
    runId: text("run_id").notNull(),
    eventId: text("event_id").notNull(),
    seq: counter("seq").notNull(),
    attemptId: text("attempt_id"),
    turnId: text("turn_id"),
    sourceEventId: text("source_event_id").notNull(),
    sourceDigest: text("source_digest").notNull(),
    eventType: text("event_type").notNull(),
    schemaVersion: text("schema_version").notNull(),
    payload: jsonb("payload").notNull(),
    publicPayload: jsonb("public_payload"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.runId, t.seq] }),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [enterpriseRuns.tenantId, enterpriseRuns.id],
    }),
    uniqueIndex("enterprise_run_event_id").on(t.tenantId, t.runId, t.eventId),
    /*
     * attempt_id is nullable: a NULL attempt escapes this index, which is exactly why the
     * platform-source partial unique index exists in the custom RLS migration.
     */
    uniqueIndex("enterprise_run_event_source").on(
      t.tenantId,
      t.runId,
      t.attemptId,
      t.sourceEventId,
    ),
  ],
);

export const enterpriseRunSnapshots = pgTable(
  "enterprise_run_snapshots",
  {
    tenantId: text("tenant_id").notNull(),
    runId: text("run_id").notNull(),
    seq: counter("seq").notNull(),
    /* Public projection only — this is not an execution checkpoint. */
    payload: jsonb("payload").notNull(),
    contentDigest: text("content_digest").notNull(),
    createdAt: stamp(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.runId, t.seq] }),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [enterpriseRuns.tenantId, enterpriseRuns.id],
    }),
  ],
);

export const enterpriseRunOutbox = pgTable(
  "enterprise_run_outbox",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    runId: text("run_id").notNull(),
    kind: text("kind").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    /* Redacted dispatch payload: the dispatcher role may read this and nothing else. */
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    claimToken: text("claim_token"),
    claimUntil: timestamp("claim_until", { withTimezone: true }),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    attempts: counter("attempts").notNull().default(sql`0`),
    lastErrorCode: text("last_error_code"),
    receiptRef: text("receipt_ref"),
    createdAt: stamp(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [enterpriseRuns.tenantId, enterpriseRuns.id],
    }),
    uniqueIndex("enterprise_outbox_dedup").on(
      t.tenantId,
      t.runId,
      t.kind,
      t.payloadDigest,
    ),
    check(
      "enterprise_outbox_status",
      sql`${t.status} in ('pending','claimed','delivered','unknown','rejected')`,
    ),
  ],
);
