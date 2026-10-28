-- FIX-F1 (#376, FR-1): company attribution for the old personal-memory face.
--
-- personal_memories was global-user-scoped: owner_user_id names a person across the whole
-- deployment, no company column, and every production read of the old face (the /api/memory
-- list, the recall tools, the Bot-context injection) filtered by that id alone — so one
-- global user's company-A memories were reachable from company B's Bot. This migration gives
-- the table the column the read paths now pin to, and fills it honestly:
--
--   - PROVEN attribution is backfilled: an owner with exactly ONE active enterprise
--     membership gets that company, on every row — the same rule hindsight/legacy-migration.ts
--     `attributionOf` uses for the #394 migration, expressed here as SQL so both derivations
--     are the same statement about the same directory.
--   - UNPROVEN rows stay NULL, and NULL is an ISOLATED row, not a global one: the read paths
--     of an enterprise deployment filter by tenant, so an unattributed row answers no
--     company. The confirmed-alive ones are recorded in the isolation list this deployment
--     already keeps (hindsight_migration_quarantine, the 0209 precedent — old id, owner and
--     reason only, never content), with the attribution reasons that table already defines.
--     A global user id never names a company here, and two active memberships are ambiguous,
--     never "the first one".
--   - Unreviewed and inactive rows of an unprovable owner stay NULL and unlisted: they are
--     invisible to every company-filtered read anyway, and putting them on the isolation
--     list would corrupt #394's reconciliation invariant (its `balanced` check counts
--     confirmed-alive rows only).
--
-- The run row below is the isolation list's own bookkeeping: a fixed, named run this script
-- owns, its counters set to what this pass decided — backfilled (tenant now set) plus
-- quarantined — so the audit trail reads like any other migration run.
ALTER TABLE "personal_memories" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "personal_memories" ADD CONSTRAINT "personal_memories_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;--> statement-breakpoint
CREATE INDEX "personal_memories_tenant_idx" ON "personal_memories" USING btree ("owner_user_id","tenant_id");--> statement-breakpoint
INSERT INTO "hindsight_migration_runs" ("id","state","finished_at")
VALUES ('0211-personal-memories-company-attribution','succeeded',now())
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
WITH "active_memberships" AS (
  SELECT "p"."user_id" AS "user_id", "m"."tenant_id" AS "tenant_id"
  FROM "enterprise_principals" "p"
  JOIN "enterprise_memberships" "m" ON "m"."principal_id" = "p"."id"
  WHERE "m"."status" = 'active'
), "membership_counts" AS (
  SELECT "user_id", count(*) AS "membership_count"
  FROM "active_memberships"
  GROUP BY "user_id"
)
UPDATE "personal_memories" AS "memory"
SET "tenant_id" = "active"."tenant_id"
FROM "active_memberships" "active"
JOIN "membership_counts" "counts"
  ON "counts"."user_id" = "active"."user_id" AND "counts"."membership_count" = 1
WHERE "memory"."owner_user_id" = "active"."user_id"
  AND "memory"."tenant_id" IS NULL;--> statement-breakpoint
INSERT INTO "hindsight_migration_quarantine" ("old_record_id","owner_user_id","reason","quarantined_at","run_id")
SELECT "memory"."id",
       "memory"."owner_user_id",
       CASE
         WHEN NOT EXISTS (
           SELECT 1 FROM "enterprise_principals" "p"
           WHERE "p"."user_id" = "memory"."owner_user_id"
         ) THEN 'no-principal'
         WHEN NOT EXISTS (
           SELECT 1 FROM "enterprise_principals" "p"
           JOIN "enterprise_memberships" "m" ON "m"."principal_id" = "p"."id"
           WHERE "p"."user_id" = "memory"."owner_user_id" AND "m"."status" = 'active'
         ) THEN 'no-active-membership'
         ELSE 'ambiguous-company'
       END,
       now(),
       '0211-personal-memories-company-attribution'
FROM "personal_memories" "memory"
WHERE "memory"."tenant_id" IS NULL
  AND NOT EXISTS (
    -- FIX-OCR3 (O3-M2): a record already in the map is migrated, never isolated. A #394
    -- pass that ran before this upgrade may have mapped a record whose owner has since
    -- drifted to unprovable; without this guard the INSERT would hold that same record on
    -- the isolation list too — reconcile's balanced check counts it on both sides forever
    -- and the isolation list keeps reporting a migrated record as quarantined.
    SELECT 1 FROM "hindsight_migration_map" "mm"
    WHERE "mm"."old_record_id" = "memory"."id"
  )
  AND "memory"."review_state" IN ('confirmed','edited')
  AND "memory"."enabled" = true
  AND "memory"."deleted_at" IS NULL
  AND "memory"."content" <> ''
ON CONFLICT ("old_record_id") DO NOTHING;--> statement-breakpoint
UPDATE "hindsight_migration_runs" AS "run"
SET "processed" = (SELECT count(*) FROM "personal_memories" WHERE "tenant_id" IS NOT NULL)
                + (SELECT count(*) FROM "hindsight_migration_quarantine" WHERE "run_id" = "run"."id"),
    "quarantined" = (SELECT count(*) FROM "hindsight_migration_quarantine" WHERE "run_id" = "run"."id"),
    "updated_at" = now()
WHERE "run"."id" = '0211-personal-memories-company-attribution';
