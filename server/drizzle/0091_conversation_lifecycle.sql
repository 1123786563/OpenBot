CREATE TABLE "conversation_evidence_withdrawals" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "channel_memberships" ADD COLUMN "archived_at" timestamp with time zone;