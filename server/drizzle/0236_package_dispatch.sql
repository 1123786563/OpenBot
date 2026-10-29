-- PKG05 (#464): managed connector-tool dispatch, absorbed into the production chain.
--
-- The declared schema (server/src/db/schema/enterprise-plugin-packages.ts) and the
-- reviewed task-track DDL (server/scripts/multitenancy/migrate-test.ts, task PKG05)
-- shipped while the chain never created them -- exactly the #436 drift the migrations
-- job gates on. The statements below are the task track's own, materialized with
-- `migrate-test.ts generate PKG05`; DDL only. RLS policies and the per-role grants
-- stay with the task track, which reconciles drizzle-restored objects and re-applies
-- them on the enterprise test databases (the same split 0163 set).
--
--   enterprise_package_dispatches -- dispatch state machine (prepared -> dispatched
--     -> succeeded/failed/unknown/cancelled; one dispatch per attempt+tool_call;
--     arguments stored as digest only).
--   enterprise_package_grants + schema_digest/effect/connector_install_id -- the
--     reviewed tool contract each grant was written against.
--   enterprise_run_package_pins + allowed_tool_bindings/install_generation -- the
--     pinned tool set of a run.
--   enterprise_plugin_connections + generation -- the connection generation the
--     dispatch CAS revalidates.
--   enterprise_package_dispatches + owner_incarnation/owner_lease_expires_at --
--     the dispatcher-process lease (PKG11, T13-fix-2): which process incarnation
--     took the dispatch and the window it promised to settle within.
CREATE TABLE "enterprise_package_dispatches" (
	"tenant_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt_generation" integer NOT NULL,
	"tool_call_id" text NOT NULL,
	"install_id" text NOT NULL,
	"revision" integer NOT NULL,
	"resource_id" text NOT NULL,
	"tool_ref" text NOT NULL,
	"connector_install_id" text NOT NULL,
	"connection_id" text,
	"connection_generation" integer NOT NULL,
	"args_digest" text NOT NULL,
	"effect" text NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"receipt_ref" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "enterprise_package_dispatch_pk" PRIMARY KEY("tenant_id","operation_id"),
	CONSTRAINT "enterprise_package_dispatch_state" CHECK ("enterprise_package_dispatches"."state" in ('prepared','dispatched','succeeded','failed','unknown','cancelled')),
	CONSTRAINT "enterprise_package_dispatch_counters" CHECK ("enterprise_package_dispatches"."attempt_generation" > 0 and "enterprise_package_dispatches"."revision" > 0 and "enterprise_package_dispatches"."connection_generation" > 0),
	CONSTRAINT "enterprise_package_dispatch_digest" CHECK ("enterprise_package_dispatches"."args_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "enterprise_package_dispatch_effect" CHECK ("enterprise_package_dispatches"."effect" in ('read','write'))
);
--> statement-breakpoint
ALTER TABLE "enterprise_package_dispatches" ADD CONSTRAINT "enterprise_package_dispatch_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_package_dispatches" ADD CONSTRAINT "enterprise_package_dispatch_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_package_dispatches" ADD CONSTRAINT "enterprise_package_dispatch_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."enterprise_runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "enterprise_package_dispatches" ADD CONSTRAINT "enterprise_package_dispatch_install_fk" FOREIGN KEY ("tenant_id","workspace_id","install_id") REFERENCES "public"."enterprise_package_installs"("tenant_id","workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_package_dispatch_call_uq" ON "enterprise_package_dispatches" ("tenant_id","run_id","attempt_generation","tool_call_id");
--> statement-breakpoint
CREATE INDEX "enterprise_package_dispatch_install_idx" ON "enterprise_package_dispatches" ("tenant_id","workspace_id","install_id");

ALTER TABLE "enterprise_package_grants" ADD COLUMN "schema_digest" text;
--> statement-breakpoint
ALTER TABLE "enterprise_package_grants" ADD COLUMN "effect" text;
--> statement-breakpoint
ALTER TABLE "enterprise_package_grants" ADD COLUMN "connector_install_id" text;
--> statement-breakpoint
ALTER TABLE "enterprise_package_grants" ADD CONSTRAINT "enterprise_package_grant_tool_contract" CHECK (("enterprise_package_grants"."resource_kind" = 'skill' and "enterprise_package_grants"."schema_digest" is null and "enterprise_package_grants"."effect" is null and "enterprise_package_grants"."connector_install_id" is null) or ("enterprise_package_grants"."resource_kind" = 'connectorTool' and "enterprise_package_grants"."schema_digest" ~ '^[0-9a-f]{64}$' and "enterprise_package_grants"."effect" in ('read','write') and "enterprise_package_grants"."connector_install_id" is not null));
--> statement-breakpoint
ALTER TABLE "enterprise_package_grants" ADD CONSTRAINT "enterprise_package_grant_connector_fk" FOREIGN KEY ("tenant_id","workspace_id","connector_install_id") REFERENCES "public"."enterprise_plugin_installs"("tenant_id","workspace_id","id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "enterprise_run_package_pins" ADD COLUMN "allowed_tool_bindings" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "enterprise_run_package_pins" ADD COLUMN "install_generation" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "enterprise_run_package_pins" ADD CONSTRAINT "enterprise_run_package_pin_tool_bindings_shape" CHECK (jsonb_typeof("enterprise_run_package_pins"."allowed_tool_bindings") = 'array' and jsonb_array_length("enterprise_run_package_pins"."allowed_tool_bindings") <= 256);
--> statement-breakpoint
ALTER TABLE "enterprise_run_package_pins" ADD CONSTRAINT "enterprise_run_package_pin_install_generation" CHECK ("enterprise_run_package_pins"."install_generation" > 0);

ALTER TABLE "enterprise_plugin_connections" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "enterprise_plugin_connections" ADD CONSTRAINT "enterprise_plugin_connection_generation" CHECK ("enterprise_plugin_connections"."generation" > 0);

REVOKE ALL PRIVILEGES ON TABLE "enterprise_package_dispatches" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator;
--> statement-breakpoint
ALTER TABLE "enterprise_package_dispatches" ADD COLUMN "owner_incarnation" text;
ALTER TABLE "enterprise_package_dispatches" ADD COLUMN "owner_lease_expires_at" timestamp with time zone;
ALTER TABLE "enterprise_package_dispatches" ADD CONSTRAINT "enterprise_package_dispatch_owner_lease_shape" CHECK (("owner_incarnation" is null) = ("owner_lease_expires_at" is null) and ("owner_incarnation" is null or char_length("owner_incarnation") between 1 and 64));
