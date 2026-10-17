CREATE TABLE "openmuse_reviewed_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"canonical_payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"account_email" text NOT NULL,
	"connection_generation" integer NOT NULL,
	"target_id" text,
	"target_version" text,
	"attachment_version_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'awaiting_review' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"provider_ref" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "openmuse_reviewed_attempts" (
	"attempt_id" text PRIMARY KEY NOT NULL,
	"action_id" text NOT NULL,
	"fingerprint" text,
	"outcome" text,
	"provider_ref" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"reconciliation" jsonb
);
--> statement-breakpoint
ALTER TABLE "openmuse_reviewed_attempts" ADD CONSTRAINT "openmuse_reviewed_attempts_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."openmuse_reviewed_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "openmuse_reviewed_actions_owner_created_idx" ON "openmuse_reviewed_actions" USING btree ("owner_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "openmuse_reviewed_attempts_action_idx" ON "openmuse_reviewed_attempts" USING btree ("action_id");