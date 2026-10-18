-- multitenancy migrate-test
CREATE TABLE "billing_company_finance_grants" (
	"tenant_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_company_finance_grants_tenant_id_principal_id_pk" PRIMARY KEY("tenant_id","principal_id"),
	CONSTRAINT "billing_company_finance_grants_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "billing_company_finance_grants_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "billing_company_finance_grants_tenant_id_granted_by_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","granted_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "billing_company_finance_grants_tenant_idx" ON "billing_company_finance_grants" ("tenant_id");
