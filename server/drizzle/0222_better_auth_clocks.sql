-- T02.02 (#524, P03): the Principal identity generation and the durable
-- eligibility clocks (design §4.2/§4.2.1/§4.4, interfaces §2).
--
-- Expand only (M1): one new table and two additive changes, no existing column
-- type changes — enterprise_memberships.epoch and
-- enterprise_workspace_memberships.epoch stay integer; the new version columns
-- are bigint, bounded to the safe-integer range 0..9007199254740991 by CHECK
-- so a wrapped or negative Version is refused by the database. Legacy
-- principals deliberately keep NULL identity_generation: an unverified version
-- is never backfilled with a guessed 1. Roles, RLS policies and
-- controlled-function grants are T02.06's migration; this one grants nothing
-- and revokes nothing, so legacy authority keeps working.
ALTER TABLE "enterprise_tenants" DROP CONSTRAINT "enterprise_tenant_status";--> statement-breakpoint
ALTER TABLE "enterprise_tenants" ADD CONSTRAINT "enterprise_tenant_status" CHECK ("status" in ('active','suspended','provisioning'));--> statement-breakpoint
ALTER TABLE "enterprise_principals" ADD COLUMN "identity_generation" bigint;--> statement-breakpoint
ALTER TABLE "enterprise_principals" ADD CONSTRAINT "enterprise_principal_identity_generation_safe_integer" CHECK (("identity_generation" is null or ("identity_generation" >= 0 and "identity_generation" <= 9007199254740991)));--> statement-breakpoint
CREATE TABLE "auth_eligibility_clocks" (
	"tenant_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"epoch" bigint NOT NULL,
	"generation" bigint NOT NULL,
	"tombstone" boolean DEFAULT false NOT NULL,
	"last_command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_eligibility_clock_pk" PRIMARY KEY("tenant_id","principal_id","kind","scope_id")
);
--> statement-breakpoint
CREATE INDEX "auth_eligibility_clock_principal_idx" ON "auth_eligibility_clocks" USING btree ("principal_id");--> statement-breakpoint
ALTER TABLE "auth_eligibility_clocks" ADD CONSTRAINT "auth_eligibility_clock_kind" CHECK ("kind" in ('company','team'));--> statement-breakpoint
ALTER TABLE "auth_eligibility_clocks" ADD CONSTRAINT "auth_eligibility_clock_scope_matches_kind" CHECK (("kind" <> 'company' or "scope_id" = "tenant_id"));--> statement-breakpoint
ALTER TABLE "auth_eligibility_clocks" ADD CONSTRAINT "auth_eligibility_clock_epoch_safe_integer" CHECK ("epoch" >= 0 and "epoch" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "auth_eligibility_clocks" ADD CONSTRAINT "auth_eligibility_clock_generation_safe_integer" CHECK ("generation" >= 0 and "generation" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "auth_eligibility_clocks" ADD CONSTRAINT "auth_eligibility_clock_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_eligibility_clocks" ADD CONSTRAINT "auth_eligibility_clock_principal_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."enterprise_principals"("id") ON DELETE cascade ON UPDATE no action;
