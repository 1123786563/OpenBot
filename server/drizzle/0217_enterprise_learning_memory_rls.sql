-- OCR full-repo triage (2026-10-27, item 1): enable the RLS the schema always declared.
--
-- WHY THIS EXISTS. enterprise_personal_memories (MT039/#82) and enterprise_learning_containers /
-- enterprise_learning_records (MT040/#83) ship pgPolicy definitions in
-- server/src/db/schema/enterprise-personal-memory.ts and enterprise-learning.ts, but the tables
-- were created by the hand-written 0209 (migration-chain restore), which — by its own header —
-- carried no RLS markers, policies or CHECKs ("policies/checks stay an ops concern until a
-- dedicated RLS pass"). With no ENABLE ROW LEVEL SECURITY the declared policies never took
-- effect anywhere the drizzle journal is the source of truth. This migration is that dedicated
-- pass for these three tables, and adds the matching `.enableRLS()` markers on the schema side.
--
-- SOURCE OF TRUTH. Every statement below is transcribed verbatim from the authoritative island
-- DDL: server/scripts/multitenancy/migrate-test.ts, tasks MT039 (personal_memory_rls_policies)
-- and MT040 (learning_rls_policies). Island databases built by that harness already carry
-- exactly this shape; this migration converges journal-driven databases onto it.
--
-- SCOPE DISCIPLINE. Touches only the three MT039/MT040 tables: REVOKE defaults, ENABLE + FORCE
-- RLS (FORCE matches the sibling enterprise tables and the authority, closing the table-owner
-- bypass), the 13 declared CREATE POLICY statements, and the minimal role GRANTs the policies
-- are written against (data: personal memory full CRUD / learning SELECT+INSERT; operator:
-- tenant-pinned read, plus UPDATE on the learning tables). The CHECK constraints 0209 also
-- deferred stay deferred — separate drift, separate pass. No existing table, policy, grant or
-- role is modified; all statements are no-ops on a database already carrying this shape except
-- CREATE POLICY, which is guarded by the fact that no earlier journal migration creates them.

REVOKE ALL PRIVILEGES ON TABLE "enterprise_personal_memories" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;--> statement-breakpoint
ALTER TABLE "enterprise_personal_memories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_personal_memories" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "enterprise_personal_memory_data_read" ON "enterprise_personal_memories"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_personal_memories"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') AND "enterprise_personal_memories"."principal_id" = nullif(current_setting('app.principal_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_personal_memory_data_insert" ON "enterprise_personal_memories"
  FOR INSERT TO ob_ent_data
  WITH CHECK ("enterprise_personal_memories"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') AND "enterprise_personal_memories"."principal_id" = nullif(current_setting('app.principal_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_personal_memory_data_update" ON "enterprise_personal_memories"
  FOR UPDATE TO ob_ent_data
  USING ("enterprise_personal_memories"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') AND "enterprise_personal_memories"."principal_id" = nullif(current_setting('app.principal_id', true), ''))
  WITH CHECK ("enterprise_personal_memories"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') AND "enterprise_personal_memories"."principal_id" = nullif(current_setting('app.principal_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_personal_memory_data_delete" ON "enterprise_personal_memories"
  FOR DELETE TO ob_ent_data
  USING ("enterprise_personal_memories"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') AND "enterprise_personal_memories"."principal_id" = nullif(current_setting('app.principal_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_personal_memory_operator_read" ON "enterprise_personal_memories"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_personal_memories"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "enterprise_personal_memories" TO ob_ent_data;--> statement-breakpoint
GRANT SELECT ON TABLE "enterprise_personal_memories" TO ob_ent_operator;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_learning_containers" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;--> statement-breakpoint
ALTER TABLE "enterprise_learning_containers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_learning_containers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "enterprise_learning_container_data_read" ON "enterprise_learning_containers"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_learning_containers"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_learning_container_data_insert" ON "enterprise_learning_containers"
  FOR INSERT TO ob_ent_data
  WITH CHECK ("enterprise_learning_containers"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') AND "enterprise_learning_containers"."allocated_by_principal_id" = nullif(current_setting('app.principal_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_learning_container_operator_read" ON "enterprise_learning_containers"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_learning_containers"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_learning_container_operator_update" ON "enterprise_learning_containers"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_learning_containers"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("enterprise_learning_containers"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "enterprise_learning_containers" TO ob_ent_data;--> statement-breakpoint
GRANT SELECT, UPDATE ON TABLE "enterprise_learning_containers" TO ob_ent_operator;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "enterprise_learning_records" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;--> statement-breakpoint
ALTER TABLE "enterprise_learning_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enterprise_learning_records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "enterprise_learning_record_data_read" ON "enterprise_learning_records"
  FOR SELECT TO ob_ent_data
  USING ("enterprise_learning_records"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_learning_record_data_insert" ON "enterprise_learning_records"
  FOR INSERT TO ob_ent_data
  WITH CHECK ("enterprise_learning_records"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') AND "enterprise_learning_records"."principal_id" = nullif(current_setting('app.principal_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_learning_record_operator_read" ON "enterprise_learning_records"
  FOR SELECT TO ob_ent_operator
  USING ("enterprise_learning_records"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "enterprise_learning_record_operator_update" ON "enterprise_learning_records"
  FOR UPDATE TO ob_ent_operator
  USING ("enterprise_learning_records"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("enterprise_learning_records"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "enterprise_learning_records" TO ob_ent_data;--> statement-breakpoint
GRANT SELECT, UPDATE ON TABLE "enterprise_learning_records" TO ob_ent_operator;
