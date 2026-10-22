-- Hindsight 12 (#389): the person's review of derived judgment candidates, and the confirmed
-- judgment's path into use.
--
-- Two check widenings and one column:
--
--   - review_state gains 'expired': the spec's candidate rule (30 days unhandled → expired and
--     cleared) applies to judgment candidates too. Expiry is a STATE, not a tombstone, so the
--     review surface can tell "lapsed" from "rejected", and the lead index's partial predicate
--     (WHERE review_state = 'unreviewed') already excludes expired rows — a replayed lead after
--     expiry produces a FRESH candidate instead of folding into a dead one.
--   - reviewed_at records WHEN the person decided (confirm, edit, reject — or the expiry sweep
--     deciding for them). The evidence chain shows it as the adoption's evidence.
--   - hindsight_sync_work's subject type gains 'derived_judgment': a confirm hands the sync
--     queue (#384) durable work under the same one-pending-row-per-subject folding as
--     preferences and source-bound rows, and the queue drains it into the judgment's own bank
--     (the user bank for a general judgment, the restriction's bank otherwise).
--
-- No recall path change is needed for "rejected/expired never enter Bot context": every
-- judgment read path (#389's recall seam included) loads rows by document id and keeps only
-- confirmed-or-edited rows, so a rejected or expired hdj_ document that still hits in the index
-- resolves to a row that fails the review gate and is dropped before any Bot sees content.
ALTER TABLE "derived_judgment_candidates" DROP CONSTRAINT IF EXISTS "derived_judgment_review_state";
--> statement-breakpoint
ALTER TABLE "derived_judgment_candidates" ADD CONSTRAINT "derived_judgment_review_state" CHECK ("derived_judgment_candidates"."review_state" in ('unreviewed','confirmed','edited','rejected','expired'));
--> statement-breakpoint
ALTER TABLE "derived_judgment_candidates" ADD COLUMN "reviewed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "hindsight_sync_work" DROP CONSTRAINT "hindsight_sync_work_subject_type";
--> statement-breakpoint
ALTER TABLE "hindsight_sync_work" ADD CONSTRAINT "hindsight_sync_work_subject_type" CHECK ("hindsight_sync_work"."subject_type" in ('preference','source_bound','derived_judgment'));
