-- Bifrost 05.3 (#244): the local ledger of short-lived virtual keys issued per (user × Bot)
-- authorization (CONTEXT.md: Virtual Key, credentialVersion). One row per issuance; the plaintext
-- key value never lands here — only its sha256 (`value_hash`, the same discipline
-- `bot_binding_offers.code_hash` keeps) — because the secret exists exactly once, in the issuance
-- response to the authenticated Bot, and only at the gateway. `credential_version` counts
-- issuances per grant from 1 (a secret that is never stored cannot be re-served, so re-claiming
-- is re-issuing), and the (grant_id, credential_version) unique index is the concurrency
-- arbiter. All of a person's keys carry the same `gateway_customer_id` (05.1's mapping): issuing
-- adds no budget, no credit grant and no ledger row — spending is governed by that customer at
-- the gateway. `expires_at` records the expiry the gateway was given (null until 05.5 ships the
-- configured default); `status` is what this deployment believes, and 05.8 keeps it true.
CREATE TABLE "gateway_virtual_keys" (
	"id" text PRIMARY KEY,
	"grant_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"gateway_customer_id" text NOT NULL,
	"gateway_virtual_key_id" text NOT NULL,
	"value_hash" text NOT NULL,
	"credential_version" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gateway_virtual_keys" ADD CONSTRAINT "gateway_virtual_keys_grant_id_access_grants_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."access_grants"("grant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_virtual_keys" ADD CONSTRAINT "gateway_virtual_keys_status_check" CHECK ("gateway_virtual_keys"."status" IN ('active', 'expired', 'revoked'));--> statement-breakpoint
ALTER TABLE "gateway_virtual_keys" ADD CONSTRAINT "gateway_virtual_keys_version_check" CHECK ("gateway_virtual_keys"."credential_version" >= 1);--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_virtual_keys_grant_version_unique_idx" ON "gateway_virtual_keys" USING btree ("grant_id","credential_version");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_virtual_keys_remote_id_unique_idx" ON "gateway_virtual_keys" USING btree ("gateway_virtual_key_id");--> statement-breakpoint
CREATE INDEX "gateway_virtual_keys_bot_idx" ON "gateway_virtual_keys" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "gateway_virtual_keys_customer_idx" ON "gateway_virtual_keys" USING btree ("gateway_customer_id");
