-- Bifrost 08.1 (#276): the unknown-dispatch recovery items — the durable discovery record
-- for holds whose provider result never reliably arrived.
--
-- The recovery scan (billing/recovery-scan.ts) finds holds the process left behind across a
-- restart — a reservation in `unknown` (06.8's explicit mark: the result never came back) or
-- a plain `reserved` hold whose expiry has passed (killed between the reserve and the
-- PostLLH settlement, so nothing ever marked it) — and writes ONE row here per such
-- reservation, fixing the attempt identity, the original reservation, the payment account
-- and the locked price-basis versions AT DETECTION TIME. The scan writes nothing else: no
-- release, no re-dispatch, no settlement — a row here is a discovery, never a money fact.
--
-- One item per reservation, ever (both unique indexes): a re-scan re-finds nothing to
-- create, and two racing passes cannot both win the insert. The claim columns carry the
-- one-worker-wins semantics downstream handlers (08.2/08.4/08.9) consume: `state` moves
-- pending→claimed in one atomic UPDATE, and the consistency CHECK keeps a claim's owner and
-- timestamp inseparable from the claimed state itself.
--
-- Deleting a reservation takes its recovery item with it (ON DELETE CASCADE, the 0145
-- attribution precedent): the item is derived evidence about that hold, not independent
-- history; grants/bots/accounts are status-lifecycle rows and are not referenced by id
-- here beyond the copied, non-FK snapshots.
CREATE TABLE "credit_recovery_items" (
	"id" text PRIMARY KEY NOT NULL,
	"attempt_id" text NOT NULL,
	"reservation_id" text NOT NULL,
	"external_customer_id" text NOT NULL,
	"payer_kind" text,
	"payer_id" text,
	"provider" text,
	"model" text,
	"capability" text,
	"snapshot_version" integer,
	"rate_version" integer,
	"maximum" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_reason" text,
	"detected_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_recovery_items_state_check" CHECK ("credit_recovery_items"."state" IN ('pending', 'claimed')),
	CONSTRAINT "credit_recovery_items_payer_kind_check" CHECK ("credit_recovery_items"."payer_kind" IS NULL OR "credit_recovery_items"."payer_kind" IN ('personal', 'company', 'legacy_deployment', 'unknown_owner')),
	CONSTRAINT "credit_recovery_items_failure_count_check" CHECK ("credit_recovery_items"."failure_count" >= 0),
	CONSTRAINT "credit_recovery_items_claim_consistency_check" CHECK (("credit_recovery_items"."state" = 'pending' AND "credit_recovery_items"."claimed_at" IS NULL AND "credit_recovery_items"."claimed_by" IS NULL) OR ("credit_recovery_items"."state" = 'claimed' AND "credit_recovery_items"."claimed_at" IS NOT NULL AND "credit_recovery_items"."claimed_by" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "credit_recovery_items" ADD CONSTRAINT "credit_recovery_items_reservation_id_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."credit_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_recovery_items_attempt_unique_idx" ON "credit_recovery_items" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_recovery_items_reservation_unique_idx" ON "credit_recovery_items" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "credit_recovery_items_state_detected_idx" ON "credit_recovery_items" USING btree ("state","detected_at");
