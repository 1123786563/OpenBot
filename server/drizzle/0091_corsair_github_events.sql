CREATE TABLE "github_pilot_event_outcomes" (
	"receipt_id" uuid NOT NULL,
	"trigger_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" text,
	CONSTRAINT "github_pilot_event_outcomes_receipt_id_trigger_id_pk" PRIMARY KEY("receipt_id","trigger_id"),
	CONSTRAINT "github_pilot_event_outcomes_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "github_pilot_event_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"registration" text NOT NULL,
	"delivery_id" text NOT NULL,
	"body_hash" text NOT NULL,
	"event_type" text NOT NULL,
	"installation_id" text,
	"repository_id" text,
	"pilot_dispatch" boolean NOT NULL,
	"occurred_at" timestamp with time zone,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disposition" text,
	"fanout_at" timestamp with time zone,
	CONSTRAINT "github_pilot_event_receipts_workspace_id_registration_delivery_id_unique" UNIQUE("workspace_id","registration","delivery_id"),
	CONSTRAINT "github_pilot_event_receipts_workspace_id_registration_body_hash_unique" UNIQUE("workspace_id","registration","body_hash")
);
--> statement-breakpoint
CREATE TABLE "github_pilot_event_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"registration" text NOT NULL,
	"goal_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"connection_revision" uuid NOT NULL,
	"installation_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"repository_node_id" text NOT NULL,
	"event_types" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "github_pilot_event_outcomes" ADD CONSTRAINT "github_pilot_event_outcomes_receipt_id_github_pilot_event_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."github_pilot_event_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_pilot_event_outcomes" ADD CONSTRAINT "github_pilot_event_outcomes_run_id_responsibility_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."responsibility_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_pilot_event_triggers" ADD CONSTRAINT "github_pilot_event_triggers_goal_id_responsibilities_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."responsibilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_pilot_event_outcomes_pending_idx" ON "github_pilot_event_outcomes" USING btree ("next_attempt_at") WHERE "github_pilot_event_outcomes"."outcome" in ('pending', 'retry');--> statement-breakpoint
CREATE INDEX "github_pilot_receipts_pending_idx" ON "github_pilot_event_receipts" USING btree ("workspace_id","registration","received_at") WHERE "github_pilot_event_receipts"."fanout_at" is null;--> statement-breakpoint
CREATE INDEX "github_pilot_event_triggers_source_idx" ON "github_pilot_event_triggers" USING btree ("workspace_id","registration","installation_id","repository_id");--> statement-breakpoint
CREATE INDEX "github_pilot_event_triggers_goal_idx" ON "github_pilot_event_triggers" USING btree ("goal_id");