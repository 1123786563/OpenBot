-- multitenancy migrate-test
CREATE TABLE "billing_call_attributions" (
	"reservation_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"bot_ref" text NOT NULL,
	"call_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_call_attributions_reservation_id_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."credit_reservations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "billing_call_attributions_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "billing_call_attributions_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "billing_call_attributions_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "billing_call_attribution_refs_present" CHECK ("billing_call_attributions"."bot_ref" <> '' AND "billing_call_attributions"."call_key" <> '')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_call_attributions_tenant_call_key_unique" ON "billing_call_attributions" ("tenant_id","call_key");
--> statement-breakpoint
CREATE INDEX "billing_call_attributions_tenant_idx" ON "billing_call_attributions" ("tenant_id");
