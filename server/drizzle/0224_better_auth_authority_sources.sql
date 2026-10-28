-- T02.04 (#526, P03): source generations for long-lived authorities and
-- personal model credentials (design §4.2 "指定团队管理授权"/"Provisioning
-- 规则"/"凭据授权来源"/"个人模型授权与 Key", §4.4, §5.3, §5.4, §6.4;
-- interfaces §3, §5.3).
--
-- Expand only (M1): two new tables — the team management Grant and the
-- provisioning rule, the two delegated team-member-management authorities that
-- must carry the versions they were issued against — plus nullable
-- source-generation columns on the existing long-lived authority rows
-- (personal credentials, credential use/disclose actions, company finance
-- grants, personal model grants, virtual keys). Nothing is backfilled: a row
-- that predates this migration keeps NULL — an unverifiable generation stays
-- missing and can only be re-established by a controlled re-verification,
-- never guessed from the current active state (design §4.4/§5.3). No existing
-- payer, customer, grant, key or history reference changes.
--
-- New version columns are bigint, bounded to the safe-integer range
-- 0..9007199254740991 by CHECK; the new tables' generations are NOT NULL
-- because every row is written by a command that states its versions
-- explicitly (the clocks' no-defaults discipline).
--
-- Roles, RLS policies and the controlled write commands belong to
-- T02.06/T02.09/P09; this migration grants nothing and revokes nothing, so
-- the legacy authority path keeps working unchanged.
ALTER TABLE "enterprise_credentials" ADD COLUMN "owner_identity_generation" bigint;--> statement-breakpoint
ALTER TABLE "enterprise_credentials" ADD COLUMN "owner_company_generation" bigint;--> statement-breakpoint
ALTER TABLE "enterprise_credentials" ADD CONSTRAINT "enterprise_credential_owner_identity_generation_safe_integer" CHECK (("owner_identity_generation" is null or ("owner_identity_generation" >= 0 and "owner_identity_generation" <= 9007199254740991)));--> statement-breakpoint
ALTER TABLE "enterprise_credentials" ADD CONSTRAINT "enterprise_credential_owner_company_generation_safe_integer" CHECK (("owner_company_generation" is null or ("owner_company_generation" >= 0 and "owner_company_generation" <= 9007199254740991)));--> statement-breakpoint
ALTER TABLE "enterprise_credentials" ADD CONSTRAINT "enterprise_credential_owner_generation_pair" CHECK ((("owner_identity_generation" is null) = ("owner_company_generation" is null)));--> statement-breakpoint
ALTER TABLE "enterprise_credential_actions" ADD COLUMN "identity_generation" bigint;--> statement-breakpoint
ALTER TABLE "enterprise_credential_actions" ADD COLUMN "company_generation" bigint;--> statement-breakpoint
ALTER TABLE "enterprise_credential_actions" ADD COLUMN "source_team_generation" bigint;--> statement-breakpoint
ALTER TABLE "enterprise_credential_actions" ADD CONSTRAINT "enterprise_credential_action_identity_generation_safe_integer" CHECK (("identity_generation" is null or ("identity_generation" >= 0 and "identity_generation" <= 9007199254740991)));--> statement-breakpoint
ALTER TABLE "enterprise_credential_actions" ADD CONSTRAINT "enterprise_credential_action_company_generation_safe_integer" CHECK (("company_generation" is null or ("company_generation" >= 0 and "company_generation" <= 9007199254740991)));--> statement-breakpoint
ALTER TABLE "enterprise_credential_actions" ADD CONSTRAINT "enterprise_credential_action_source_team_generation_safe_integer" CHECK (("source_team_generation" is null or ("source_team_generation" >= 0 and "source_team_generation" <= 9007199254740991)));--> statement-breakpoint
ALTER TABLE "enterprise_credential_actions" ADD CONSTRAINT "enterprise_credential_action_generation_pair" CHECK ((("identity_generation" is null) = ("company_generation" is null)));--> statement-breakpoint
ALTER TABLE "billing_company_finance_grants" ADD COLUMN "identity_generation" bigint;--> statement-breakpoint
ALTER TABLE "billing_company_finance_grants" ADD COLUMN "company_generation" bigint;--> statement-breakpoint
ALTER TABLE "billing_company_finance_grants" ADD CONSTRAINT "billing_company_finance_grant_identity_generation_safe_integer" CHECK (("identity_generation" is null or ("identity_generation" >= 0 and "identity_generation" <= 9007199254740991)));--> statement-breakpoint
ALTER TABLE "billing_company_finance_grants" ADD CONSTRAINT "billing_company_finance_grant_company_generation_safe_integer" CHECK (("company_generation" is null or ("company_generation" >= 0 and "company_generation" <= 9007199254740991)));--> statement-breakpoint
ALTER TABLE "billing_company_finance_grants" ADD CONSTRAINT "billing_company_finance_grant_generation_pair" CHECK ((("identity_generation" is null) = ("company_generation" is null)));--> statement-breakpoint
ALTER TABLE "access_grants" ADD COLUMN "principal_id" text;--> statement-breakpoint
ALTER TABLE "access_grants" ADD COLUMN "identity_generation" bigint;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_identity_generation_safe_integer" CHECK (("identity_generation" is null or ("identity_generation" >= 0 and "identity_generation" <= 9007199254740991)));--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_principal_generation_pair" CHECK ((("principal_id" is null) = ("identity_generation" is null)));--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_principal_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."enterprise_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_virtual_keys" ADD COLUMN "source_identity_generation" bigint;--> statement-breakpoint
ALTER TABLE "gateway_virtual_keys" ADD CONSTRAINT "gateway_virtual_keys_source_identity_generation_check" CHECK (("source_identity_generation" is null or ("source_identity_generation" >= 0 and "source_identity_generation" <= 9007199254740991)));--> statement-breakpoint
CREATE TABLE "auth_team_management_grants" (
	"grant_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"team_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"actions" text[] NOT NULL,
	"generation" bigint NOT NULL,
	"identity_generation" bigint NOT NULL,
	"company_generation" bigint NOT NULL,
	"team_generation" bigint NOT NULL,
	"granted_by" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_team_management_grant_pk" PRIMARY KEY("grant_id")
);
--> statement-breakpoint
CREATE INDEX "auth_team_management_grant_workspace_idx" ON "auth_team_management_grants" USING btree ("tenant_id","workspace_id");--> statement-breakpoint
CREATE INDEX "auth_team_management_grant_principal_idx" ON "auth_team_management_grants" USING btree ("tenant_id","principal_id");--> statement-breakpoint
ALTER TABLE "auth_team_management_grants" ADD CONSTRAINT "auth_team_management_grant_actions" CHECK ("actions" <@ array['team.member.add','team.member.remove']::text[] and cardinality("actions") between 1 and 2 and cardinality("actions") = ((case when 'team.member.add' = any("actions") then 1 else 0 end) + (case when 'team.member.remove' = any("actions") then 1 else 0 end)));--> statement-breakpoint
ALTER TABLE "auth_team_management_grants" ADD CONSTRAINT "auth_team_management_grant_status" CHECK ("status" in ('active','revoked'));--> statement-breakpoint
ALTER TABLE "auth_team_management_grants" ADD CONSTRAINT "auth_team_management_grant_status_with_time" CHECK (("status" = 'active') = ("revoked_at" is null));--> statement-breakpoint
ALTER TABLE "auth_team_management_grants" ADD CONSTRAINT "auth_team_management_grant_generation_safe_integer" CHECK ("generation" >= 0 and "generation" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "auth_team_management_grants" ADD CONSTRAINT "auth_team_management_grant_identity_generation_safe_integer" CHECK ("identity_generation" >= 0 and "identity_generation" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "auth_team_management_grants" ADD CONSTRAINT "auth_team_management_grant_company_generation_safe_integer" CHECK ("company_generation" >= 0 and "company_generation" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "auth_team_management_grants" ADD CONSTRAINT "auth_team_management_grant_team_generation_safe_integer" CHECK ("team_generation" >= 0 and "team_generation" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "auth_team_management_grants" ADD CONSTRAINT "auth_team_management_grant_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_team_management_grants" ADD CONSTRAINT "auth_team_management_grant_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_team_management_grants" ADD CONSTRAINT "auth_team_management_grant_team_fk" FOREIGN KEY ("team_id","tenant_id") REFERENCES "public"."auth_teams"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_team_management_grants" ADD CONSTRAINT "auth_team_management_grant_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_team_management_grants" ADD CONSTRAINT "auth_team_management_grant_grantor_fk" FOREIGN KEY ("tenant_id","granted_by") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "auth_provisioning_rules" (
	"rule_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"binding_id" text NOT NULL,
	"external_group" text,
	"workspace_ids" text[] NOT NULL,
	"minimum_role" text DEFAULT 'member' NOT NULL,
	"revision" bigint NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_provisioning_rule_pk" PRIMARY KEY("rule_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_provisioning_rule_binding_group_uq" ON "auth_provisioning_rules" USING btree ("binding_id","external_group") WHERE "auth_provisioning_rules"."external_group" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_provisioning_rule_binding_wide_uq" ON "auth_provisioning_rules" USING btree ("binding_id") WHERE "auth_provisioning_rules"."external_group" is null;--> statement-breakpoint
CREATE INDEX "auth_provisioning_rule_tenant_idx" ON "auth_provisioning_rules" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "auth_provisioning_rules" ADD CONSTRAINT "auth_provisioning_rule_workspace_ids_nonempty" CHECK (cardinality("workspace_ids") >= 1);--> statement-breakpoint
ALTER TABLE "auth_provisioning_rules" ADD CONSTRAINT "auth_provisioning_rule_minimum_role" CHECK ("minimum_role" in ('owner','admin','member'));--> statement-breakpoint
ALTER TABLE "auth_provisioning_rules" ADD CONSTRAINT "auth_provisioning_rule_status" CHECK ("status" in ('approved','revoked'));--> statement-breakpoint
ALTER TABLE "auth_provisioning_rules" ADD CONSTRAINT "auth_provisioning_rule_status_with_time" CHECK (("status" = 'approved') = ("revoked_at" is null));--> statement-breakpoint
ALTER TABLE "auth_provisioning_rules" ADD CONSTRAINT "auth_provisioning_rule_revision_safe_integer" CHECK ("revision" >= 0 and "revision" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "auth_provisioning_rules" ADD CONSTRAINT "auth_provisioning_rule_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;
