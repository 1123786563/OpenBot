-- FIX-W8 (#392, RFW1-1): the person's attribution, stored on the pause row itself.
--
-- The legacy user gate (hindsight/pause-controls.ts createUserPauseGate) used to resolve
-- (tenant, principal) -> user by joining enterprise_principals on the main application
-- connection. That table carries FORCE ROW LEVEL SECURITY with policies only for the
-- ob_ent_* capability roles, so under the restricted application login the enterprise form
-- mandates (no superuser, no BYPASSRLS, no capability membership) the join answers zero rows
-- and both legacy gates silently fail open: a pause the person set is ignored. The test
-- topologies all run superuser connections, which is why no test saw it.
--
-- The fix stores the person's user id on the row at write time — the write path already holds
-- the server-issued PlatformScope, and the tenancy resolver selects the principal BY the
-- session actor's user id, so the stored value is the same server-side fact the join used to
-- derive, never a wire value. The gate then reads this table alone (an application-owned
-- table with no RLS) and never touches the directory's row-visibility rules again.
--
-- Backfill: every pause row's (tenant_id, principal_id) is pinned by foreign key to a live
-- enterprise_memberships row (NO ACTION), and that membership's principal cascades from a
-- live enterprise_principals row, so the UPDATE resolves every structurally valid row. The
-- ALTER ... SET NOT NULL that follows makes the migration fail loudly rather than leave an
-- unattributed row the single-table gate could not see — the fail-closed direction: if a
-- deployment's data does not resolve, the migration stops, it never ships a silent fail-open.
ALTER TABLE "hindsight_pause_controls" ADD COLUMN "user_id" text;--> statement-breakpoint
UPDATE "hindsight_pause_controls" AS "pause"
SET "user_id" = "principals"."user_id"
FROM "enterprise_principals" AS "principals"
WHERE "principals"."id" = "pause"."principal_id";--> statement-breakpoint
ALTER TABLE "hindsight_pause_controls" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "hindsight_pause_controls_user_id_idx" ON "hindsight_pause_controls" ("user_id");
