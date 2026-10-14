CREATE TABLE "openmuse_ideas" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"title" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT '' NOT NULL,
	"input" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"task_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "openmuse_ideas_owner_created_idx" ON "openmuse_ideas" USING btree ("owner_user_id","created_at","id");