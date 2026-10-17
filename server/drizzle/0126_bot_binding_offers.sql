CREATE TABLE "bot_binding_offers" (
	"code_hash" text PRIMARY KEY,
	"bot_id" text NOT NULL,
	"external_identity_hint" text NOT NULL,
	"single_use" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "bot_binding_offers_status_check" CHECK ("bot_binding_offers"."status" IN ('pending', 'redeemed', 'revoked')),
	CONSTRAINT "bot_binding_offers_bot_id_bot_services_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot_services"("bot_id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "bot_binding_offers_bot_idx" ON "bot_binding_offers" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "bot_binding_offers_expiry_idx" ON "bot_binding_offers" USING btree ("expires_at");
