-- multitenancy migrate-test
CREATE TABLE "enterprise_deployment_anchors" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"deployment_tenant_id" text NOT NULL,
	"billing_external_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_deployment_anchors_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_deployment_anchor_identity" ON "enterprise_deployment_anchors" USING btree ("deployment_tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_deployment_anchor_billing_customer" ON "enterprise_deployment_anchors" USING btree ("billing_external_customer_id");
--> statement-breakpoint
ALTER TABLE "enterprise_deployment_anchors" ADD CONSTRAINT "enterprise_deployment_anchor_billing_derivation" CHECK ("billing_external_customer_id" = 'openbot-deployment-' || "deployment_tenant_id");
