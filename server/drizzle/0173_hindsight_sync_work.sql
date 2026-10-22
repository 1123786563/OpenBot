-- The durable sync-work queue for confirmed personal memories (Hindsight 07 / #384), plus
-- the review-state index #398 adjudicated to this ticket.
--
-- One row = one unit of "this authority row's confirmed content should be in Hindsight":
-- enqueued at confirm/edit/correction with the digest of the content AS ENQUEUED, drained by
-- the background task the spec names as the second trusted identity source. The queue's three
-- safety properties live in the shape:
--
--   - Duplicate tasks collapse at the storage layer: the partial unique index allows at most
--     ONE pending row per (tenant, subject), so re-enqueuing what is already pending is a
--     no-op, not a second task.
--   - Stale tasks cannot win: the drain compares the work's expected_digest against the
--     row's CURRENT content; an edit that landed in between supersedes the old work (state
--     'superseded'), and only the newer content is ever retained — an old task never
--     overwrites a newer active version.
--   - Only confirmed, currently-authorized content is sent: the drain re-reads the row (and,
--     for source-bound rows, its authorization) before every retain, so a retry re-verifies
--     tenant and source ownership at task time, not enqueue time.
--
-- The #398 low-severity finding "store.ts (review_state, deleted_at, updated_at) index
-- missing (full scan)" was adjudicated to this ticket: candidate expiry filters
-- personal_memories by review state WITHOUT the owner pin, so the index below covers that
-- scan. Behavior is unchanged — this is the covering index only.
CREATE TABLE "hindsight_sync_work" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"expected_digest" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hindsight_sync_work_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "hindsight_sync_work_subject_type" CHECK ("hindsight_sync_work"."subject_type" in ('preference','source_bound')),
	CONSTRAINT "hindsight_sync_work_state" CHECK ("hindsight_sync_work"."state" in ('pending','done','superseded')),
	CONSTRAINT "hindsight_sync_work_attempts" CHECK ("hindsight_sync_work"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "hindsight_sync_work" ADD CONSTRAINT "hindsight_sync_work_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "hindsight_sync_work_one_pending" ON "hindsight_sync_work" ("tenant_id","subject_type","subject_id") WHERE state = 'pending';
--> statement-breakpoint
CREATE INDEX "hindsight_sync_work_due_idx" ON "hindsight_sync_work" ("state","created_at");
--> statement-breakpoint
CREATE INDEX "personal_memories_review_idx" ON "personal_memories" ("review_state","deleted_at","updated_at");
