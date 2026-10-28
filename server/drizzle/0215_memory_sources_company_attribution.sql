-- FIX-W13 (#376, FR2-2): company attribution for memory sources, fixed at binding.
--
-- memory_sources stayed owner-global after 0211 gave the memories themselves a company:
-- the manual sync resolved the REQUEST's trusted company and stamped the import with it, so
-- one global user holding companies A and B could sync an A-Bot source while selected into
-- B, and the source's new externalIds landed as B's candidates — recalled by B afterwards.
-- This migration gives every source the attribution the runtime now reads off the row, by
-- the source's own Bot rather than the momentary page selection:
--
--   - A source whose Bot holds an ACTIVE enterprise_bot_ownership row belongs to that
--     company — and only while the owner is still an ACTIVE member of it, the exact rule
--     memory/company.ts `resolveMemoryCompany` applies at runtime (a Bot of a company the
--     person no longer belongs to answers none, never the person's own). This is the same
--     statement about the same directory 0211 made for memories, so the migration's
--     backfill and the runtime's binding can never disagree.
--   - A source on a personal Bot (no ownership row) follows the person's provable
--     attribution: exactly ONE active membership, 0211's own rule. Zero, none, or several
--     name no company.
--   - UNPROVEN sources stay NULL, and NULL is an ISOLATED source, not a global one: no
--     company's scope lists, operates or syncs it (the server refuses before the connector
--     is read), and the background loop skips it. Per-row isolation-list entries are
--     deliberately NOT written into hindsight_migration_quarantine: that table feeds the
--     #394 reconciliation's `balanced` check (every confirmed-alive old MEMORY record is a
--     migration or a quarantine), and a source id is not a memory record — counting it
--     there would corrupt the invariant 0211 was careful to preserve. The run row below
--     carries the counters instead, 0211's own bookkeeping pattern.
--
-- Runtime stamping on existing rows is untouched by design: an attributed source keeps its
-- company through every later sync, and nothing here rewrites personal_memories.
ALTER TABLE "memory_sources" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;--> statement-breakpoint
CREATE INDEX "memory_sources_tenant_idx" ON "memory_sources" USING btree ("owner_user_id","tenant_id");--> statement-breakpoint
INSERT INTO "hindsight_migration_runs" ("id","state","finished_at")
VALUES ('0212-memory-sources-company-attribution','succeeded',now())
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
WITH "active_ownership" AS (
  SELECT "o"."agent_id" AS "agent_id", "o"."tenant_id" AS "tenant_id"
  FROM "enterprise_bot_ownership" "o"
  WHERE "o"."status" = 'active'
), "active_memberships" AS (
  SELECT "p"."user_id" AS "user_id", "m"."tenant_id" AS "tenant_id"
  FROM "enterprise_principals" "p"
  JOIN "enterprise_memberships" "m" ON "m"."principal_id" = "p"."id"
  WHERE "m"."status" = 'active'
), "membership_counts" AS (
  SELECT "user_id", count(*) AS "membership_count"
  FROM "active_memberships"
  GROUP BY "user_id"
), "resolved" AS (
  -- Rule 1: the Bot's company, while the owner is still a live member of it.
  SELECT "s"."id" AS "id", "o"."tenant_id" AS "tenant_id"
  FROM "memory_sources" "s"
  JOIN "active_ownership" "o" ON "o"."agent_id" = "s"."agent_id"
  JOIN "active_memberships" "am"
    ON "am"."user_id" = "s"."owner_user_id" AND "am"."tenant_id" = "o"."tenant_id"
  UNION
  -- Rule 2: a personal Bot — the person's one provable company.
  SELECT "s"."id", "am"."tenant_id"
  FROM "memory_sources" "s"
  JOIN "active_memberships" "am" ON "am"."user_id" = "s"."owner_user_id"
  JOIN "membership_counts" "c"
    ON "c"."user_id" = "am"."user_id" AND "c"."membership_count" = 1
  WHERE NOT EXISTS (
    SELECT 1 FROM "active_ownership" "o" WHERE "o"."agent_id" = "s"."agent_id"
  )
)
UPDATE "memory_sources" AS "source"
SET "tenant_id" = "resolved"."tenant_id"
FROM "resolved"
WHERE "source"."id" = "resolved"."id"
  AND "source"."tenant_id" IS NULL;--> statement-breakpoint
UPDATE "hindsight_migration_runs" AS "run"
SET "processed" = (SELECT count(*) FROM "memory_sources" WHERE "tenant_id" IS NOT NULL)
                + (SELECT count(*) FROM "memory_sources" WHERE "tenant_id" IS NULL),
    "quarantined" = (SELECT count(*) FROM "memory_sources" WHERE "tenant_id" IS NULL),
    "updated_at" = now()
WHERE "run"."id" = '0212-memory-sources-company-attribution';
