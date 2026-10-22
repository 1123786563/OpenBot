-- Bifrost 15.8 (#321): the realtime session consumption view's read index — the payer's
-- own sessions, newest first.
--
-- WHY AN INDEX AT ALL. 0193 indexed sessions by grant (the recovery's restore reads and the
-- unit door's identity lookups); 15.8 adds the person-facing read, which filters on the
-- FROZEN PAYER columns the establishment door copied (never a request parameter — 02.6's
-- rule), and sorts newest first. Without this index every page visit is a full scan of a
-- table whose only growth direction is "every realtime session ever established".
--
-- THE VIEW BOUNDS ITSELF (realtime-usage.ts's REALTIME_SESSION_VIEW_LIMIT); this index
-- bounds the work of finding those rows: (payer_kind, payer_id, started_at DESC) serves the
-- filter and the order together, mirroring the grant index's shape.

CREATE INDEX "realtime_sessions_payer_idx" ON "realtime_sessions" USING btree ("payer_kind", "payer_id", "started_at" DESC);
