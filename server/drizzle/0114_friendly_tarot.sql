CREATE TABLE "payer_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"payer_kind" text NOT NULL,
	"external_ref" text NOT NULL,
	"external_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payer_accounts" ADD CONSTRAINT "payer_accounts_external_customer_id_billing_customers_external_id_fk" FOREIGN KEY ("external_customer_id") REFERENCES "public"."billing_customers"("external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payer_accounts_subject_unique" ON "payer_accounts" USING btree ("payer_kind","external_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "payer_accounts_customer_unique" ON "payer_accounts" USING btree ("external_customer_id");