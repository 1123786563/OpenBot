-- OpenBot r2fix-t3b (OCR round2 R2-22≡R2-50, R2-23≡R2-27, R2-49, R2-21; branch-local
-- numbering continues the 0131 hand-merge precedent — drizzle-kit generate stays blocked
-- by the pre-existing journal chain breaks, tracked as separate infra debt).
--
-- R2-22≡R2-50: expireStaleLeases polls every 5s for bindings still `running` past
-- expires_at; with no supporting index that predicate ordered-scanned the whole table.
-- The partial index keeps the scan proportional to live zombies, not to history.
--
-- R2-49: scope_key filtering + created_at ordering/windowing (admin-summary window
-- aggregates, the bindings scope listing) had no composite path; this mirrors the
-- executions/exports scope_created_idx pair.
--
-- R2-23≡R2-27: the retention discovery pin anti-join and the FK CASCADE delete path
-- both reach dataset_versions by dataset_id alone; the composite uq leads with
-- scope_key and cannot serve that single-column lookup.
--
-- R2-21: enterprise_run_events has no schema definition, no runtime reader or writer,
-- and no migration SQL that ever created it (fresh databases never had it). Migration
-- 0131's snapshot dropped the table implicitly — real deployments that predate the
-- migration chain still hold the physical orphan, so the explicit DROP here is the SQL
-- support that drop was missing. IF EXISTS keeps fresh databases (table absent) clean.
CREATE INDEX "ai_observation_bindings_running_expires_idx" ON "ai_observation_bindings" ("expires_at") WHERE "ai_observation_bindings"."state" = 'running';--> statement-breakpoint
CREATE INDEX "ai_observation_dataset_versions_dataset_id_idx" ON "ai_observation_dataset_versions" ("dataset_id");--> statement-breakpoint
CREATE INDEX "ai_observation_bindings_scope_created_idx" ON "ai_observation_bindings" ("scope_key","created_at");--> statement-breakpoint
DROP TABLE IF EXISTS "enterprise_run_events";
