CREATE TABLE "openmuse_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"kind" text NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"artifact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "openmuse_tasks_owner_key_uq" ON "openmuse_tasks" USING btree ("owner_user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "openmuse_tasks_owner_created_idx" ON "openmuse_tasks" USING btree ("owner_user_id","created_at","id");