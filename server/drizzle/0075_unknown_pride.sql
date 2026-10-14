CREATE TABLE "credit_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"external_customer_id" text NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"total" integer NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_grants_source_check" CHECK ("credit_grants"."source" IN ('plan', 'promo', 'signin')),
	CONSTRAINT "credit_grants_status_check" CHECK ("credit_grants"."status" IN ('active', 'exhausted', 'expired')),
	CONSTRAINT "credit_grants_total_check" CHECK ("credit_grants"."total" >= 0),
	CONSTRAINT "credit_grants_used_check" CHECK ("credit_grants"."used" >= 0 AND "credit_grants"."used" <= "credit_grants"."total")
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"external_customer_id" text NOT NULL,
	"grant_id" text,
	"title" text NOT NULL,
	"request_id" text,
	"credits" integer NOT NULL,
	"model" text,
	"client" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ledger_credits_check" CHECK ("credit_ledger"."credits" >= 0)
);
--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_ext_customer_id_fk" FOREIGN KEY ("external_customer_id") REFERENCES "public"."billing_customers"("external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_ext_customer_id_fk" FOREIGN KEY ("external_customer_id") REFERENCES "public"."billing_customers"("external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_grant_id_credit_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."credit_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_grants_customer_idx" ON "credit_grants" USING btree ("external_customer_id");--> statement-breakpoint
CREATE INDEX "credit_grants_customer_expires_idx" ON "credit_grants" USING btree ("external_customer_id","expires_at");--> statement-breakpoint
CREATE INDEX "credit_ledger_customer_created_idx" ON "credit_ledger" USING btree ("external_customer_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_ledger_grant_idx" ON "credit_ledger" USING btree ("grant_id");