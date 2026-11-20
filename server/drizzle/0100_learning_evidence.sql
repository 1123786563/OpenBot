ALTER TABLE "channel_memberships" ADD COLUMN "learning_evidence_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "direct_chat_analyses" ADD COLUMN "evidence_sources" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "direct_chat_analyses" ADD COLUMN "revises_proposal_id" uuid;