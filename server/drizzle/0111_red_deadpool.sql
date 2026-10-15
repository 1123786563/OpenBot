CREATE TABLE "openmuse_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"text" text NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "openmuse_memories_owner_created_idx" ON "openmuse_memories" USING btree ("owner_user_id","created_at","id");