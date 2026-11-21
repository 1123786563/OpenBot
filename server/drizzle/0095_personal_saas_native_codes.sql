CREATE TABLE "personal_saas_native_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"client" text NOT NULL,
	"state" text NOT NULL,
	"challenge" text NOT NULL,
	"identity" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "personal_saas_native_codes_expiry" ON "personal_saas_native_codes" USING btree ("expires_at");