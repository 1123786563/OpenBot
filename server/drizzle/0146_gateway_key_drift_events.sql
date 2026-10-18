-- Bifrost 05.9 (#250, AC11/Q18): the field-drift events — ownership, scope and term
-- mismatches between the local record and the gateway's own answer, and the human
-- disposition of each.
--
-- The sibling of 05.8's availability list (`gateway_key_sync_drift`, 0144), for the drifts
-- that are NOT unavailability: a key moved to another Customer still works — it just bills
-- someone else, which is worse. The observation columns are written once when the sync
-- detects the drift and never change; the disposition columns start null and are filled
-- exactly once by a human decision. While `disposed_at` is null the event is OUTSTANDING,
-- and an outstanding event on a grant pauses that grant's issuance and renewal — the pause
-- is not a flag anywhere else, it IS the absence of a disposition.
--
-- The partial unique index on `(key_id, reason_code) WHERE disposed_at IS NULL` is the
-- one-outstanding-event rule: re-observations of the same mismatch do not stack rows, and
-- after a disposition a persisting mismatch re-detects on the next sync — the verdict
-- re-arms against a truth that did not change.
CREATE TABLE "gateway_key_drift_events" (
	"id" text PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"gateway_virtual_key_id" text NOT NULL,
	"local_customer_id" text NOT NULL,
	"reason_code" text NOT NULL,
	"remote_customer_id" text,
	"local_expires_at" timestamp with time zone,
	"remote_expires_at" timestamp with time zone,
	"detected_at" timestamp with time zone NOT NULL,
	"disposition" text,
	"disposed_at" timestamp with time zone,
	"disposed_by" text,
	"disposition_note" text,
	CONSTRAINT "gateway_key_drift_events_reason_code_check" CHECK ("gateway_key_drift_events"."reason_code" IN ('gateway_key_owner_changed', 'gateway_key_scope_changed', 'gateway_key_term_changed')),
	CONSTRAINT "gateway_key_drift_events_disposition_check" CHECK ("gateway_key_drift_events"."disposition" IS NULL OR "gateway_key_drift_events"."disposition" IN ('accepted', 'key_revoked')),
	CONSTRAINT "gateway_key_drift_events_disposition_consistent" CHECK (("gateway_key_drift_events"."disposition" IS NULL) = ("gateway_key_drift_events"."disposed_at" IS NULL) AND ("gateway_key_drift_events"."disposition" IS NULL) = ("gateway_key_drift_events"."disposed_by" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "gateway_key_drift_events_key_idx" ON "gateway_key_drift_events" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "gateway_key_drift_events_grant_idx" ON "gateway_key_drift_events" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "gateway_key_drift_events_detected_at_idx" ON "gateway_key_drift_events" USING btree ("detected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_key_drift_events_outstanding_unique_idx" ON "gateway_key_drift_events" USING btree ("key_id","reason_code") WHERE "gateway_key_drift_events"."disposed_at" IS NULL;
