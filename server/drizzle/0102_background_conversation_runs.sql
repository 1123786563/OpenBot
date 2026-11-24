ALTER TABLE "direct_chat_runs" DROP CONSTRAINT "direct_chat_runs_thread_id_intelligence_channel_mappings_thread_id_fk";
--> statement-breakpoint
ALTER TABLE "direct_chat_runs" ADD COLUMN "group_thread_id" text;--> statement-breakpoint
ALTER TABLE "direct_chat_runs" ADD COLUMN "direct_thread_id" text GENERATED ALWAYS AS (case when group_thread_id is null then thread_id end) STORED;--> statement-breakpoint
ALTER TABLE "direct_chat_runs" ADD COLUMN "waiting_approval_id" text;--> statement-breakpoint
ALTER TABLE "direct_chat_runs" ADD COLUMN "handoff_from_bot_id" text;--> statement-breakpoint
ALTER TABLE "direct_chat_runs" ADD CONSTRAINT "direct_chat_runs_group_thread_id_group_bot_threads_thread_id_fk" FOREIGN KEY ("group_thread_id") REFERENCES "public"."group_bot_threads"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_chat_runs" ADD CONSTRAINT "direct_chat_runs_direct_thread_id_intelligence_channel_mappings_thread_id_fk" FOREIGN KEY ("direct_thread_id") REFERENCES "public"."intelligence_channel_mappings"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_chat_runs" ADD CONSTRAINT "direct_chat_runs_group_thread_check" CHECK ("direct_chat_runs"."group_thread_id" is null or "direct_chat_runs"."group_thread_id" = "direct_chat_runs"."thread_id");