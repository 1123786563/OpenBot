-- Bifrost 05.1 (AC01/Q6/Q7): the gateway customer mapping — one OpenBot personal user ↔ one
-- Bifrost governance Customer ("Bifrost Principal" in CONTEXT.md). Provisioning creates the
-- Customer at the gateway and records the mapping here; 05.3's key issuance and 05.8's status
-- sync read this row instead of asking the gateway.
--
-- The three unique indexes are the ticket's whole concurrency story: the subject index lets
-- exactly one mapping survive a racing provisioning burst (the database arbitrates which insert
-- wins; losers re-read the committed row and answer the winner's customer id), and the remote-id
-- / remote-name indexes hold "one-to-one" in the other two directions. The remote name is
-- deterministic per subject (`payerKey`), which is what makes a concurrent create converge on
-- one remote entity even before any local row exists, and what 05.2's crash recovery resolves
-- by. Like payer_accounts this table is a mapping and nothing more: no billing customer, no
-- grant, no ledger row, no balance.
CREATE TABLE "gateway_customers" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"payer_id" text NOT NULL,
	"gateway_customer_id" text NOT NULL,
	"gateway_customer_name" text NOT NULL,
	"provision_state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gateway_customers" ADD CONSTRAINT "gateway_customers_kind_check" CHECK ("gateway_customers"."kind" IN ('personal'));
--> statement-breakpoint
ALTER TABLE "gateway_customers" ADD CONSTRAINT "gateway_customers_provision_state_check" CHECK ("gateway_customers"."provision_state" IN ('active'));
--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_customers_subject_unique_idx" ON "gateway_customers" USING btree ("kind","payer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_customers_remote_id_unique_idx" ON "gateway_customers" USING btree ("gateway_customer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_customers_remote_name_unique_idx" ON "gateway_customers" USING btree ("gateway_customer_name");
