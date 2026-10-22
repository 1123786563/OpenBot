-- Bifrost 11.5 (#300): the OCR capability joins the closed model-capability set, everywhere
-- the set is spelled as a database CHECK.
--
-- WHY A MEMBER ARRIVES THIS WAY. The capability vocabulary is closed on purpose — a ref's
-- capability is the third axis of its identity (03.1), and a price snapshot, an open scope, a
-- preference row, a locked reservation and an async job row all carry the same closed list
-- so nothing can drift between them. A new member therefore lands as one migration that
-- re-spells every CHECK to the SAME new list, never as a free-text value one table accepts
-- and another refuses. The OCR entrance is real on the pinned gateway (POST /v1/ocr and
-- /v1/async/ocr, handlers/inference.go / asyncinference.go; schemas.OCRRequest), so the
-- catalog can now carry OCR refs whose snapshots 03.2 prices and 11.5's own dimension
-- mapping (server/src/billing/ocr-pricing.ts) assesses.
--
-- WHAT DOES NOT CHANGE. Per-table RESTRICTED capability sets that are their own closed
-- vocabulary (credit_settlement_details 'image', credit_speech_settlement_details 'speech',
-- ai_observation_bindings' observability verbs) keep their own semantics: an OCR settlement
-- line is a later ticket's subject, not this one's. 'ocr' is inserted after 'rerank' — the
-- 11.x capability family — in every list, so the spelling is byte-identical in all six
-- places the migration touches and the drizzle schema mirrors.

ALTER TABLE "gateway_model_catalog_refs" DROP CONSTRAINT "gateway_model_catalog_refs_capability_allowed";--> statement-breakpoint
ALTER TABLE "gateway_model_catalog_refs" ADD CONSTRAINT "gateway_model_catalog_refs_capability_allowed" CHECK ("gateway_model_catalog_refs"."capability" IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'ocr', 'realtime', 'video', 'unknown'));--> statement-breakpoint
ALTER TABLE "gateway_price_snapshots" DROP CONSTRAINT "gateway_price_snapshots_capability_allowed";--> statement-breakpoint
ALTER TABLE "gateway_price_snapshots" ADD CONSTRAINT "gateway_price_snapshots_capability_allowed" CHECK ("gateway_price_snapshots"."capability" IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'ocr', 'realtime', 'video', 'unknown'));--> statement-breakpoint
ALTER TABLE "gateway_model_open_scopes" DROP CONSTRAINT "gateway_model_open_scopes_capability_allowed";--> statement-breakpoint
ALTER TABLE "gateway_model_open_scopes" ADD CONSTRAINT "gateway_model_open_scopes_capability_allowed" CHECK ("gateway_model_open_scopes"."capability" IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'ocr', 'realtime', 'video', 'unknown'));--> statement-breakpoint
ALTER TABLE "gateway_model_preferences" DROP CONSTRAINT "gateway_model_preferences_capability_allowed";--> statement-breakpoint
ALTER TABLE "gateway_model_preferences" ADD CONSTRAINT "gateway_model_preferences_capability_allowed" CHECK ("gateway_model_preferences"."capability" IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'ocr', 'realtime', 'video', 'unknown'));--> statement-breakpoint
ALTER TABLE "credit_reservations" DROP CONSTRAINT "credit_reservations_lock_completeness_check";--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_lock_completeness_check" CHECK ((("credit_reservations"."provider" IS NULL) = ("credit_reservations"."model" IS NULL) AND ("credit_reservations"."provider" IS NULL) = ("credit_reservations"."capability" IS NULL) AND ("credit_reservations"."provider" IS NULL) = ("credit_reservations"."snapshot_version" IS NULL) AND ("credit_reservations"."provider" IS NULL) = ("credit_reservations"."rate_version" IS NULL) AND ("credit_reservations"."provider" IS NULL OR ("credit_reservations"."provider" <> '' AND "credit_reservations"."model" <> '' AND "credit_reservations"."capability" IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'ocr', 'realtime', 'video', 'unknown') AND "credit_reservations"."snapshot_version" >= 1 AND "credit_reservations"."rate_version" >= 0))));--> statement-breakpoint
ALTER TABLE "async_jobs" DROP CONSTRAINT "async_jobs_capability_check";--> statement-breakpoint
ALTER TABLE "async_jobs" ADD CONSTRAINT "async_jobs_capability_check" CHECK ("async_jobs"."capability" IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'ocr', 'realtime', 'video', 'unknown'));
