-- Bifrost 03.1 (#223, AC06/Q4/Q17): the model catalog as ModelRef rows, plus the fetch log.
--
-- `gateway_model_catalog_refs` holds the LAST-GOOD normalized catalog: one row per
-- provider × model × capability cell, the unique index carrying the no-merge rule itself (the
-- same model name under two providers is two rows, never one). A model whose capability could
-- not be derived arrives as `unknown` with `unknown_reason` naming why; the closed CHECK makes
-- "quietly default it to chat" a database refusal, not a review finding. `raw_entry` keeps the
-- exact upstream JSON each ref came from, so the price mapping (03.2) and an auditor re-check the
-- same bytes the gateway sent. A failed fetch writes nothing here — the last-good snapshot
-- survives a broken gateway — and a successful fetch replaces the whole table in one transaction,
-- because a model the gateway stopped listing must not stay selectable (design Q17).
--
-- `gateway_catalog_fetches` is the display the ACs promise: one append-only row per completed
-- attempt, so a failed sync's reason stays readable (fixed `catalog_fetch_*` codes, never
-- upstream bytes) and every snapshot's provenance (`fetched_at`, `config_version`,
-- `raw_item_count`) survives for the audit the price snapshots re-check against.
CREATE TABLE "gateway_model_catalog_refs" (
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"capability" text NOT NULL,
	"capability_source" text NOT NULL,
	"unknown_reason" text,
	"raw_entry" jsonb NOT NULL,
	"config_version" integer NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gateway_model_catalog_refs_capability_allowed" CHECK ("gateway_model_catalog_refs"."capability" IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'realtime', 'video', 'unknown')),
	CONSTRAINT "gateway_model_catalog_refs_source_allowed" CHECK ("gateway_model_catalog_refs"."capability_source" IN ('supported_methods', 'none')),
	CONSTRAINT "gateway_model_catalog_refs_identity_uq" UNIQUE ("provider","model","capability")
);
--> statement-breakpoint
CREATE TABLE "gateway_catalog_fetches" (
	"fetch_id" text PRIMARY KEY,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"raw_item_count" integer,
	"config_version" integer,
	"failure_reason_code" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_catalog_fetches_status_allowed" CHECK ("gateway_catalog_fetches"."status" IN ('ok', 'failed'))
);
--> statement-breakpoint
-- The "latest attempt" read scans by completion time; the fetch id breaks any same-instant tie,
-- exactly the shape the rate versions' history index uses.
CREATE INDEX "gateway_catalog_fetches_fetched_at_idx" ON "gateway_catalog_fetches" USING btree ("fetched_at" DESC,"fetch_id" DESC);
--> statement-breakpoint
-- THE FETCH LOG IS APPEND-ONLY, AND THIS IS WHAT MAKES THAT TRUE. A log the application can
-- rewrite after the fact answers no question worth asking (the same reasoning migration 0128
-- recorded for the rate history, whose shape this follows). Enforced in the database rather than
-- the application, because the application is not the only thing that can reach this table.
CREATE OR REPLACE FUNCTION prevent_gateway_catalog_fetch_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Gateway catalog fetches are append-only';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS gateway_catalog_fetches_append_only ON gateway_catalog_fetches;
CREATE TRIGGER gateway_catalog_fetches_append_only
BEFORE UPDATE OR DELETE ON gateway_catalog_fetches
FOR EACH ROW
EXECUTE FUNCTION prevent_gateway_catalog_fetch_mutation();
--> statement-breakpoint
-- A row-level trigger cannot see TRUNCATE: migration 0012 caught the audit trail being emptied
-- by exactly that statement while every UPDATE and DELETE was refused. The statement trigger
-- closes it from day one here.
DROP TRIGGER IF EXISTS gateway_catalog_fetches_no_truncate ON gateway_catalog_fetches;
CREATE TRIGGER gateway_catalog_fetches_no_truncate
BEFORE TRUNCATE ON gateway_catalog_fetches
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_gateway_catalog_fetch_mutation();
