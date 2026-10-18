-- multitenancy migrate-test
CREATE TABLE "billing_customer_mappings" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"external_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_customer_mappings_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "billing_customer_mappings_external_customer_id_billing_customers_external_id_fk" FOREIGN KEY ("external_customer_id") REFERENCES "public"."billing_customers"("external_id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customer_mappings_customer_unique" ON "billing_customer_mappings" ("external_customer_id");
--> statement-breakpoint
CREATE TABLE "billing_credit_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"external_customer_id" text NOT NULL,
	"account_type" text,
	"status" text NOT NULL,
	"tenant_id" text,
	"owner_user_id" text,
	"account_key" text,
	"quarantine_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_credit_accounts_type" CHECK ("billing_credit_accounts"."account_type" in ('company','personal')),
	CONSTRAINT "billing_credit_accounts_status" CHECK ("billing_credit_accounts"."status" in ('active','quarantined')),
	CONSTRAINT "billing_credit_accounts_row_shape" CHECK (("billing_credit_accounts"."status" = 'quarantined' AND "billing_credit_accounts"."account_type" is null AND "billing_credit_accounts"."tenant_id" is null AND "billing_credit_accounts"."owner_user_id" is null AND "billing_credit_accounts"."account_key" is null) OR ("billing_credit_accounts"."status" = 'active' AND "billing_credit_accounts"."account_type" = 'company' AND "billing_credit_accounts"."tenant_id" is not null AND "billing_credit_accounts"."owner_user_id" is null AND "billing_credit_accounts"."account_key" is not null) OR ("billing_credit_accounts"."status" = 'active' AND "billing_credit_accounts"."account_type" = 'personal' AND "billing_credit_accounts"."owner_user_id" is not null AND "billing_credit_accounts"."tenant_id" is null AND "billing_credit_accounts"."account_key" is not null)),
	CONSTRAINT "billing_credit_accounts_quarantine_reason" CHECK (("billing_credit_accounts"."status" = 'quarantined') = ("billing_credit_accounts"."quarantine_reason" is not null)),
	CONSTRAINT "billing_credit_accounts_key_derivation" CHECK ("billing_credit_accounts"."account_key" = CASE "billing_credit_accounts"."account_type" WHEN 'company' THEN 'company:' || "billing_credit_accounts"."tenant_id" WHEN 'personal' THEN 'personal:' || "billing_credit_accounts"."owner_user_id" ELSE null END),
	CONSTRAINT "billing_credit_accounts_external_customer_id_billing_customers_external_id_fk" FOREIGN KEY ("external_customer_id") REFERENCES "public"."billing_customers"("external_id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "billing_credit_accounts_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "billing_credit_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_credit_accounts_customer_unique" ON "billing_credit_accounts" ("external_customer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_credit_accounts_key_unique" ON "billing_credit_accounts" ("account_key") WHERE "billing_credit_accounts"."account_key" is not null;
--> statement-breakpoint
CREATE TABLE "billing_account_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"tenant_id" text,
	"external_customer_id" text,
	"account_id" text,
	"detail" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_account_audit_action" CHECK ("billing_account_audit"."action" in ('customer_mapping.bound','credit_account.registered','credit_account.quarantined')),
	CONSTRAINT "billing_account_audit_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "billing_account_audit_tenant_time_idx" ON "billing_account_audit" ("tenant_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "billing_account_audit_customer_time_idx" ON "billing_account_audit" ("external_customer_id","occurred_at");
