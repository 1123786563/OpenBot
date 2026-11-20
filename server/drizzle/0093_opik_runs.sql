CREATE TABLE "opik_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" text NOT NULL,
	"run_id" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"trace" text DEFAULT 'pending' NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"lease_id" uuid,
	"feedback_id" uuid,
	"score" integer,
	"comment" text,
	"feedback_delivered_at" timestamp with time zone,
	CONSTRAINT "opik_runs_thread_id_run_id_unique" UNIQUE("thread_id","run_id"),
	CONSTRAINT "opik_runs_feedback_check" CHECK (("opik_runs"."feedback_id" is null and "opik_runs"."score" is null) or ("opik_runs"."feedback_id" is not null and "opik_runs"."score" is not null and "opik_runs"."score" in (0, 1)))
);
--> statement-breakpoint
ALTER TABLE "opik_runs" ADD CONSTRAINT "opik_runs_thread_id_run_id_direct_chat_runs_thread_id_id_fk" FOREIGN KEY ("thread_id","run_id") REFERENCES "public"."direct_chat_runs"("thread_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opik_runs_due_idx" ON "opik_runs" USING btree ("due_at") WHERE "opik_runs"."trace" = 'pending' or ("opik_runs"."score" is not null and "opik_runs"."feedback_delivered_at" is null);--> statement-breakpoint
CREATE INDEX "opik_runs_expiry_idx" ON "opik_runs" USING btree ("finished_at") WHERE "opik_runs"."trace" = 'pending';