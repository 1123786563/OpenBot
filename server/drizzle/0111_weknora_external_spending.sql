CREATE TABLE "test_credit_external_authorizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"application" text NOT NULL,
	"resource_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_microcredits" bigint NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "test_credit_external_authorizations_account_id_id_unique" UNIQUE("account_id","id"),
	CONSTRAINT "test_credit_external_authorization_amount" CHECK ("test_credit_external_authorizations"."max_microcredits" > 0)
);
--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD COLUMN "external_authorization_id" uuid;--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD COLUMN "external_account_epoch" bigint;--> statement-breakpoint
ALTER TABLE "test_credit_external_authorizations" ADD CONSTRAINT "test_credit_external_authorizations_account_id_test_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."test_credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD CONSTRAINT "test_credit_operation_external_authorization_fk" FOREIGN KEY ("account_id","external_authorization_id") REFERENCES "public"."test_credit_external_authorizations"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "test_credit_operations_external_authorization_idx" ON "test_credit_operations" USING btree ("account_id","external_authorization_id") WHERE "test_credit_operations"."external_authorization_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD CONSTRAINT "test_credit_operation_external_binding" CHECK (("test_credit_operations"."external_authorization_id" IS NULL) = ("test_credit_operations"."external_account_epoch" IS NULL));