-- Orphaned owner rows first, so the foreign keys below can land: these tables predate their
-- user reference being enforced, and a deployment that already purged a user left rows behind.
DELETE FROM "openmuse_oauth_pending" WHERE "user_id" NOT IN (SELECT "id" FROM "users");--> statement-breakpoint
DELETE FROM "openmuse_google_connections" WHERE "user_id" NOT IN (SELECT "id" FROM "users");--> statement-breakpoint
DELETE FROM "openmuse_tasks" WHERE "owner_user_id" NOT IN (SELECT "id" FROM "users");--> statement-breakpoint
DELETE FROM "openmuse_goals" WHERE "owner_user_id" NOT IN (SELECT "id" FROM "users");--> statement-breakpoint
ALTER TABLE "openmuse_goals" ADD CONSTRAINT "openmuse_goals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openmuse_google_connections" ADD CONSTRAINT "openmuse_google_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openmuse_oauth_pending" ADD CONSTRAINT "openmuse_oauth_pending_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openmuse_tasks" ADD CONSTRAINT "openmuse_tasks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "openmuse_oauth_pending_open_idx" ON "openmuse_oauth_pending" USING btree ("expires_at") WHERE "openmuse_oauth_pending"."consumed_at" IS NULL AND "openmuse_oauth_pending"."outcome" IS NULL;--> statement-breakpoint
-- Before the unique index below: an environment that carried traffic between 0092 and this
-- migration may hold races' duplicates — several still-active rows per gate key. CREATE UNIQUE
-- INDEX validates existing rows, so the duplicates would abort the whole migration.
--
-- The key is the FULL four-column one the runtime gate and the index share (target rides the
-- key: two deletes of different events on one calendar are two logical sends, payload alone
-- hashes them alike). The survivor rule keeps uncertainty closed: per key, the earliest
-- UNCERTAIN row (executing/outcome_unknown) survives, else the earliest awaiting_review; only
-- the pure awaiting_review race duplicates land 'cancelled' and fall out of the partial
-- predicate. Flipping an executing/outcome_unknown row to 'cancelled' would re-open its
-- re-proposal gate and close reconcile's door on it — the two contracts R04 exists to hold.
UPDATE "openmuse_reviewed_actions" SET "status" = 'cancelled'
  WHERE "status" IN ('awaiting_review', 'executing', 'outcome_unknown')
    AND "id" NOT IN (
      SELECT DISTINCT ON ("owner_user_id", "kind", "payload_hash", coalesce("target_id", '')) "id"
        FROM "openmuse_reviewed_actions"
       WHERE "status" IN ('awaiting_review', 'executing', 'outcome_unknown')
       ORDER BY "owner_user_id", "kind", "payload_hash", coalesce("target_id", ''),
                CASE WHEN "status" IN ('executing', 'outcome_unknown') THEN 0 ELSE 1 END,
                "created_at", "id"
    );--> statement-breakpoint
CREATE UNIQUE INDEX "openmuse_reviewed_actions_active_send_uq" ON "openmuse_reviewed_actions" USING btree ("owner_user_id","kind","payload_hash",coalesce("target_id", '')) WHERE "openmuse_reviewed_actions"."status" IN ('awaiting_review', 'executing', 'outcome_unknown');
