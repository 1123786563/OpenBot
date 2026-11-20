CREATE TABLE "direct_chat_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"evidence_run_ids" jsonb NOT NULL,
	"proposal" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "direct_chat_analyses_state_check" CHECK ("direct_chat_analyses"."state" in ('running', 'reconciling', 'proposed', 'skipped', 'failed', 'cancelled')),
	CONSTRAINT "direct_chat_analyses_proposal_check" CHECK (("direct_chat_analyses"."state" = 'proposed') = ("direct_chat_analyses"."proposal" is not null))
);
--> statement-breakpoint
ALTER TABLE "direct_chat_analyses" ADD CONSTRAINT "direct_chat_analyses_thread_id_intelligence_channel_mappings_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."intelligence_channel_mappings"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "direct_chat_analyses_history_idx" ON "direct_chat_analyses" USING btree ("thread_id","started_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "direct_chat_analyses_active_idx" ON "direct_chat_analyses" USING btree ("thread_id") WHERE "direct_chat_analyses"."state" in ('running', 'reconciling');