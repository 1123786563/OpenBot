-- Bifrost 06.12 (#263): who a reservation was admitted FOR — the consumption attribution.
--
-- `credit_reservation_attribution` names the model access grant a protocol reserve ran under
-- and the registered Bot that grant belongs to, one row per reservation (the primary key IS
-- the reservation id). The credit writer owns `credit_reservations` and stays untouched: the
-- attribution row is written by the protocol reserve (billing/credit-reserve.ts) inside the
-- SAME transaction that writes the hold, from the grant row revalidation already proved, so
-- the fact and the hold are one commit. The user view joins a settled hold's ledger row back
-- through `credit_reservations.ledger_id` to answer "which Bot and model spent this" — and a
-- reservation without a row here (a writer-direct hold, or a row from before this migration)
-- is answered as unattributed, never guessed.
--
-- Deleting a reservation takes its attribution with it (ON DELETE CASCADE); grants and bots
-- are status-lifecycle rows (revocation/retirement is a status, not a deletion), so their
-- FKs take no action and history keeps its names.
CREATE TABLE "credit_reservation_attribution" (
	"reservation_id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_reservation_attribution" ADD CONSTRAINT "credit_reservation_attribution_reservation_id_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."credit_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservation_attribution" ADD CONSTRAINT "credit_reservation_attribution_grant_id_access_grants_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."access_grants"("grant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservation_attribution" ADD CONSTRAINT "credit_reservation_attribution_bot_id_bot_services_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot_services"("bot_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_reservation_attribution_bot_idx" ON "credit_reservation_attribution" USING btree ("bot_id");
