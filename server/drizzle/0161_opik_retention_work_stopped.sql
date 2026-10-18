-- OpenBot r3fix-u2 (OCR round3 R3-34): the M1b stop-work pass — a run deletion cancels
-- the scope's queued/running exports before their data face changes — derived "already
-- stopped" from record.state = 'pending'. The first failing pass rewrites that state to
-- 'failed', so a gate refusal (CAPABILITY_MISSING) or a cancel that itself threw on pass
-- one left every retry believing the stop had run: the deletion advanced while the scope's
-- exports were still fetching the data being deleted. work_stopped_at is the durable fact
-- the retry derives from; state stays the retry machine.
ALTER TABLE "ai_observation_retention_deletions" ADD COLUMN "work_stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_observation_retention_deletions" ADD CONSTRAINT "ai_observation_retention_deletions_work_stopped_run_check" CHECK ("ai_observation_retention_deletions"."work_stopped_at" IS NULL OR "ai_observation_retention_deletions"."kind" = 'run');
