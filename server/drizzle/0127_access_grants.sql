CREATE TABLE "access_grants" (
	"grant_id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"external_identity" text NOT NULL,
	"scope" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "access_grants_scope_check" CHECK ("access_grants"."scope" IN ('model-access')),
	CONSTRAINT "access_grants_status_check" CHECK ("access_grants"."status" IN ('active', 'revoked')),
	CONSTRAINT "access_grants_revoked_at_check" CHECK ((("access_grants"."status" = 'active' AND "access_grants"."revoked_at" IS NULL) OR ("access_grants"."status" = 'revoked' AND "access_grants"."revoked_at" IS NOT NULL))),
	CONSTRAINT "access_grants_bot_id_bot_services_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot_services"("bot_id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "access_grants_one_active_per_identity" ON "access_grants" USING btree ("user_id","bot_id","external_identity") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "access_grants_user_idx" ON "access_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "access_grants_bot_idx" ON "access_grants" USING btree ("bot_id");
