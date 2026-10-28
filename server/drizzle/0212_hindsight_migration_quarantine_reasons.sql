-- FIX-W7 RG6-1 (#394): quarantine reasons for permission shapes the new domain cannot reproduce.
--
-- The migration's classification is honest only if a row whose old-side restriction has no
-- counterpart in the new tables is held back (quarantined), never silently reclassified: a
-- Bot-formed row without an agent id, an import row without a source id, a formed_by value
-- outside the three mapped shapes, and a Bot-formed row whose source_ref narrowed recall to
-- "only while the forming Bot still holds the source app" — a clause the new domain has no
-- column to carry. Each lands in the isolation list with its own reason; the row stays in
-- personal_memories with its original reference intact, and content is still never copied.
ALTER TABLE "hindsight_migration_quarantine" DROP CONSTRAINT "hindsight_migration_quarantine_reason";
--> statement-breakpoint
ALTER TABLE "hindsight_migration_quarantine" ADD CONSTRAINT "hindsight_migration_quarantine_reason" CHECK ("hindsight_migration_quarantine"."reason" in ('no-principal', 'no-active-membership', 'ambiguous-company', 'unmappable-permission-shape', 'source-ref-narrowing'));
