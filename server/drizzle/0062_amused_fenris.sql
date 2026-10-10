CREATE TABLE "code_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"task" text NOT NULL,
	"model" text,
	"status" text DEFAULT 'running' NOT NULL,
	"session_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"artifact_paths" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "code_runs_bot_idx" ON "code_runs" USING btree ("bot_id");