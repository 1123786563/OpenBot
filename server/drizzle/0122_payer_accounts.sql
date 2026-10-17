CREATE TABLE "payer_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payer_id" text NOT NULL,
	"external_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payer_accounts_kind_check" CHECK ("payer_accounts"."kind" IN ('personal', 'company', 'legacy_deployment', 'unknown_owner'))
);
--> statement-breakpoint
ALTER TABLE "payer_accounts" ADD CONSTRAINT "payer_accounts_external_customer_id_fk" FOREIGN KEY ("external_customer_id") REFERENCES "public"."billing_customers"("external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payer_accounts_subject_unique_idx" ON "payer_accounts" USING btree ("kind","payer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payer_accounts_external_customer_unique_idx" ON "payer_accounts" USING btree ("external_customer_id");
