-- OpenBot's per-case write-ahead outcomes for experiment executions (Issue #30/T24).
-- The billing promise as a database fact: in_flight BEFORE the call, one conditional flip after;
-- see src/db/schema/ai-observability-execution-case-outcomes.ts.
CREATE TABLE "ai_observation_execution_case_outcomes" (
	"execution_id" text NOT NULL,
	"case_index" integer NOT NULL,
	"status" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_observation_execution_case_outcomes_status_check" CHECK ("ai_observation_execution_case_outcomes"."status" IN ('in_flight', 'completed', 'failed', 'unknown')),
	CONSTRAINT "ai_observation_execution_case_outcomes_detail_final_check" CHECK ("ai_observation_execution_case_outcomes"."detail" IS NULL OR "ai_observation_execution_case_outcomes"."status" <> 'in_flight'),
	CONSTRAINT "ai_observation_execution_case_outcomes_execution_id_case_index_pk" PRIMARY KEY("execution_id","case_index")
);--> statement-breakpoint
ALTER TABLE "ai_observation_execution_case_outcomes" ADD CONSTRAINT "ai_observation_execution_case_outcomes_execution_id_ai_observation_experiment_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."ai_observation_experiment_executions"("id") ON DELETE cascade ON UPDATE no action;
