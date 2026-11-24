CREATE TABLE "pilot_provider_cost_holds" (
	"path" text NOT NULL,
	"account_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"bound_microcredits" bigint NOT NULL,
	"cost_microcredits" bigint,
	"state" text DEFAULT 'held' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "pilot_provider_cost_holds_path_account_id_operation_id_pk" PRIMARY KEY("path","account_id","operation_id"),
	CONSTRAINT "pilot_provider_cost_holds_amounts" CHECK ("pilot_provider_cost_holds"."bound_microcredits" >= 0 AND ("pilot_provider_cost_holds"."cost_microcredits" IS NULL OR "pilot_provider_cost_holds"."cost_microcredits" >= 0))
);
--> statement-breakpoint
CREATE TABLE "pilot_provider_cost_limit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path" text NOT NULL,
	"from_limit_microcredits" bigint,
	"to_limit_microcredits" bigint NOT NULL,
	"by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pilot_provider_cost_limits" (
	"path" text PRIMARY KEY NOT NULL,
	"limit_microcredits" bigint NOT NULL,
	"updatedBy" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pilot_provider_cost_limits_nonnegative" CHECK ("pilot_provider_cost_limits"."limit_microcredits" >= 0)
);
--> statement-breakpoint
ALTER TABLE "pilot_provider_cost_holds" ADD CONSTRAINT "pilot_provider_cost_holds_account_id_test_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."test_credit_accounts"("id") ON DELETE no action ON UPDATE no action;