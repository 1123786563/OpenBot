-- Hindsight 15 (#393): budget caps and the admission ledger for background memory processing.
--
-- The platform bears the automatic-processing cost and caps it per company and per person
-- (parent spec #376). These two tables are the whole budget surface:
--
--   - hindsight_budget_caps is the platform's expressed control: one row per company, a
--     whole-company monthly ceiling and the per-person monthly ceiling applied to each
--     principal. NO row means no cap has been expressed — background processing runs, and the
--     ops view reports the cap as unset.
--   - hindsight_budget_reservations is the admission ledger: one row per admitted piece of
--     background work, unique on (tenant_id, work_key) so admission is idempotent — a retry
--     of budget-deferred work re-admits the SAME reservation and is charged once. The work
--     key carries the sync work row's id plus its attempt count: a deferred retry (attempts
--     unchanged) keeps the key, a genuinely new processing attempt (attempts bumped by a
--     failed retain) gets a fresh one.
--
-- Usage is aggregated from this ledger per calendar month: reserved+settled rows count,
-- released rows (nothing was processed) do not. A released row may be re-admitted under its
-- work key — the row flips back to reserved and counts once, never twice.
--
-- Reads of confirmed content never touch these tables: the budget gates background
-- processing only; authorized recall is unaffected by exhaustion.
CREATE TABLE "hindsight_budget_caps" (
	"tenant_id" text NOT NULL,
	"company_monthly_units" integer NOT NULL,
	"personal_monthly_units" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "hindsight_budget_caps_tenant_id_pk" PRIMARY KEY ("tenant_id")
);
--> statement-breakpoint
ALTER TABLE "hindsight_budget_caps" ADD CONSTRAINT "hindsight_budget_caps_company_positive" CHECK ("hindsight_budget_caps"."company_monthly_units" >= 0);
--> statement-breakpoint
ALTER TABLE "hindsight_budget_caps" ADD CONSTRAINT "hindsight_budget_caps_personal_positive" CHECK ("hindsight_budget_caps"."personal_monthly_units" >= 0);
--> statement-breakpoint
ALTER TABLE "hindsight_budget_caps" ADD CONSTRAINT "hindsight_budget_caps_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "hindsight_budget_reservations" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"work_key" text NOT NULL,
	"period" text NOT NULL,
	"units" integer NOT NULL,
	"state" text NOT NULL DEFAULT 'reserved',
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"settled_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"release_reason" text,
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "hindsight_budget_reservations" ADD CONSTRAINT "hindsight_budget_reservation_state" CHECK ("hindsight_budget_reservations"."state" in ('reserved', 'settled', 'released'));
--> statement-breakpoint
ALTER TABLE "hindsight_budget_reservations" ADD CONSTRAINT "hindsight_budget_reservation_units" CHECK ("hindsight_budget_reservations"."units" >= 1);
--> statement-breakpoint
ALTER TABLE "hindsight_budget_reservations" ADD CONSTRAINT "hindsight_budget_reservations_tenant_id_enterprise_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "enterprise_tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hindsight_budget_reservations" ADD CONSTRAINT "hindsight_budget_reservations_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "enterprise_memberships"("tenant_id","principal_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "hindsight_budget_reservation_work_key" ON "hindsight_budget_reservations" USING btree ("tenant_id","work_key");
--> statement-breakpoint
CREATE INDEX "hindsight_budget_reservation_usage_idx" ON "hindsight_budget_reservations" USING btree ("tenant_id","principal_id","period","state");
