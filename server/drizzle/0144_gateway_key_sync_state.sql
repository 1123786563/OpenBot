-- Bifrost 05.8 (#249, AC11/Q18): the key state sync's own persistence.
--
-- `gateway_key_sync_state` is the singleton pointer row between sync runs — the sibling of
-- the catalog sync's row (0137) — because "when did the key statuses last get proven against
-- the gateway, and what did the attempts since then fail with" must be one read away, not a
-- scan. A failed sync increments `consecutive_failures` in the same statement that records
-- the reason (an atomic `+1`); a success zeroes it, moves `last_successful_sync_at` and
-- clears the failure columns. The reason is a fixed `gateway_key_sync_*` code, never
-- upstream bytes — displayable on any surface.
--
-- `gateway_key_sync_drift` is the sync's drift list (the Produces contract's 差异清单), the
-- sibling of the catalog fetch log: one append-only row per flipped key per run, written in
-- the SAME transaction as the flip itself, so the list and the statuses can never disagree.
-- A sync can only move a key TOWARD unavailability (Q18: sync direction is gateway → local;
-- from a gateway state change no OpenBot authorization is derived), and the closed sets on
-- `from_status` / `to_status` / `reason_code` are the whole truth the writer can express.
CREATE TABLE "gateway_key_sync_state" (
	"id" text PRIMARY KEY NOT NULL,
	"last_successful_sync_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_failure_reason_code" text,
	"last_failure_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_attempt_status" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_key_sync_state_failures_nonnegative" CHECK ("gateway_key_sync_state"."consecutive_failures" >= 0),
	CONSTRAINT "gateway_key_sync_state_attempt_status_allowed" CHECK ("gateway_key_sync_state"."last_attempt_status" IS NULL OR "gateway_key_sync_state"."last_attempt_status" IN ('ok', 'failed')),
	CONSTRAINT "gateway_key_sync_state_failure_details_consistent" CHECK (("gateway_key_sync_state"."last_attempt_status" = 'failed') = ("gateway_key_sync_state"."last_failure_reason_code" IS NOT NULL) AND ("gateway_key_sync_state"."last_attempt_status" = 'failed') = ("gateway_key_sync_state"."last_failure_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "gateway_key_sync_drift" (
	"id" text PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"gateway_virtual_key_id" text NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"reason_code" text NOT NULL,
	"drifted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gateway_key_sync_drift_from_status_check" CHECK ("gateway_key_sync_drift"."from_status" = 'active'),
	CONSTRAINT "gateway_key_sync_drift_to_status_check" CHECK ("gateway_key_sync_drift"."to_status" IN ('revoked', 'expired')),
	CONSTRAINT "gateway_key_sync_drift_reason_code_check" CHECK ("gateway_key_sync_drift"."reason_code" IN ('gateway_key_deleted', 'gateway_key_disabled', 'gateway_key_expired'))
);
--> statement-breakpoint
CREATE INDEX "gateway_key_sync_drift_key_idx" ON "gateway_key_sync_drift" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "gateway_key_sync_drift_drifted_at_idx" ON "gateway_key_sync_drift" USING btree ("drifted_at");
