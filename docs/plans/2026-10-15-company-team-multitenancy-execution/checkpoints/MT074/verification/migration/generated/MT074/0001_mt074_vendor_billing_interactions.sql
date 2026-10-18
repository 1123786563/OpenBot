-- multitenancy migrate-test
CREATE TABLE "billing_vendor_interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"direction" text NOT NULL,
	"tenant_id" text,
	"principal_id" text,
	"external_customer_id" text,
	"operation" text NOT NULL,
	"outcome" text NOT NULL,
	"denial_code" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_vendor_interactions_direction" CHECK ("billing_vendor_interactions"."direction" in ('call','callback')),
	CONSTRAINT "billing_vendor_interactions_outcome" CHECK ("billing_vendor_interactions"."outcome" in ('applied','refused')),
	CONSTRAINT "billing_vendor_interactions_denial_pair" CHECK (("billing_vendor_interactions"."outcome" = 'applied' AND "billing_vendor_interactions"."denial_code" IS NULL) OR ("billing_vendor_interactions"."outcome" = 'refused' AND "billing_vendor_interactions"."denial_code" IS NOT NULL AND "billing_vendor_interactions"."denial_code" <> '')),
	CONSTRAINT "billing_vendor_interactions_detail_shape" CHECK ("billing_vendor_interactions"."detail" IS NULL OR (jsonb_typeof("billing_vendor_interactions"."detail") = 'object' AND NOT "billing_vendor_interactions"."detail" ?| array['envelope','plaintext','secret','value','password','token','apiKey']))
);
--> statement-breakpoint
CREATE INDEX "billing_vendor_interactions_tenant_time_idx" ON "billing_vendor_interactions" ("tenant_id","created_at");
--> statement-breakpoint
CREATE INDEX "billing_vendor_interactions_customer_time_idx" ON "billing_vendor_interactions" ("external_customer_id","created_at");
