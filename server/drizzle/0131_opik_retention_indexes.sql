-- OpenBot's retention-discovery support indexes (OCR round-1 m164/m195/m200; branch-local
-- number continues the hand-merge precedent — drizzle-kit generate is blocked by the
-- pre-existing journal chain breaks, tracked as separate infra debt).
-- Discovery scans four tables every poll on filter columns none of which had an index;
-- id_links is the step-level table and had no (scope_key, observed_trace_id) path for the
-- cleanup delete; dataset_version_id serves both the pin anti-join and the FK backstop.
CREATE INDEX "ai_observation_bindings_created_at_idx" ON "ai_observation_bindings" ("created_at");--> statement-breakpoint
CREATE INDEX "ai_observation_datasets_created_at_idx" ON "ai_observation_datasets" ("created_at");--> statement-breakpoint
CREATE INDEX "ai_observation_experiments_created_at_idx" ON "ai_observation_experiments" ("created_at");--> statement-breakpoint
CREATE INDEX "ai_observation_experiments_dataset_version_idx" ON "ai_observation_experiments" ("dataset_version_id");--> statement-breakpoint
CREATE INDEX "ai_observation_id_links_scope_observed_idx" ON "ai_observation_id_links" ("scope_key","observed_trace_id");--> statement-breakpoint
CREATE INDEX "ai_observation_export_jobs_settled_at_idx" ON "ai_observation_export_jobs" ("settled_at");
