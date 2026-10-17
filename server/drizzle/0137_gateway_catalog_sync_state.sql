-- Bifrost 03.4 (#226, AC10/Q17): the catalog sync's own singleton state row.
--
-- `gateway_catalog_sync_state` keeps what a sync run must remember between
-- runs: when the last fully successful sync (catalog AND prices) completed,
-- how many attempts failed in a row since then, and the fixed, displayable
-- reason the last failure carries. Every attempt's detail already has its own
-- append-only home — the fetch log (0129, 03.1) and the versioned price
-- snapshots (0133, 03.2) — so this table is a mutable pointer row by design,
-- not a log: one row per deployment, written by the same atomic upserts the
-- sync service runs after each attempt. A failure increments
-- `consecutive_failures` in the statement that records the reason (an atomic
-- `+1`, so two syncs racing the row cannot lose a count); a success zeroes
-- it, moves `last_successful_sync_at` and clears the failure columns. The
-- failure reason is a fixed `catalog_fetch_*` / `price_sync_*` code — never
-- upstream bytes, never an address — displayable on any screen.
CREATE TABLE "gateway_catalog_sync_state" (
	"id" text PRIMARY KEY NOT NULL,
	"last_successful_sync_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_failure_reason_code" text,
	"last_failure_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_attempt_status" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_catalog_sync_state_failures_nonnegative" CHECK ("gateway_catalog_sync_state"."consecutive_failures" >= 0),
	CONSTRAINT "gateway_catalog_sync_state_attempt_status_allowed" CHECK ("gateway_catalog_sync_state"."last_attempt_status" IS NULL OR "gateway_catalog_sync_state"."last_attempt_status" IN ('ok', 'failed')),
	CONSTRAINT "gateway_catalog_sync_state_failure_details_consistent" CHECK (("gateway_catalog_sync_state"."last_attempt_status" = 'failed') = ("gateway_catalog_sync_state"."last_failure_reason_code" IS NOT NULL) AND ("gateway_catalog_sync_state"."last_attempt_status" = 'failed') = ("gateway_catalog_sync_state"."last_failure_at" IS NOT NULL))
);
