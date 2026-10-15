CREATE TABLE "mastra_tenant_storage_registry" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"schema_name" text NOT NULL,
	"role_version" integer NOT NULL,
	"status" text NOT NULL,
	"claim_token" uuid,
	"credential_ref" text,
	"runtime_role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	CONSTRAINT "mastra_tenant_storage_role_version" CHECK ("mastra_tenant_storage_registry"."role_version" > 0),
	CONSTRAINT "mastra_tenant_storage_status" CHECK ("mastra_tenant_storage_registry"."status" in ('provisioning','ready')),
	CONSTRAINT "mastra_tenant_storage_state" CHECK (("mastra_tenant_storage_registry"."status" = 'provisioning' and "mastra_tenant_storage_registry"."claim_token" is not null and "mastra_tenant_storage_registry"."credential_ref" is null and "mastra_tenant_storage_registry"."runtime_role" is null and "mastra_tenant_storage_registry"."ready_at" is null) or ("mastra_tenant_storage_registry"."status" = 'ready' and "mastra_tenant_storage_registry"."claim_token" is null and "mastra_tenant_storage_registry"."credential_ref" is not null and "mastra_tenant_storage_registry"."runtime_role" is not null and "mastra_tenant_storage_registry"."ready_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mastra_tenant_storage_key_unique" ON "mastra_tenant_storage_registry" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "mastra_tenant_storage_schema_unique" ON "mastra_tenant_storage_registry" USING btree ("schema_name");