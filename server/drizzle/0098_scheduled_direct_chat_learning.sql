CREATE TABLE "direct_chat_learning_schedules" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	"interval_hours" integer NOT NULL,
	"next_at" timestamp with time zone,
	"evidence_after" timestamp with time zone,
	"last_analysis_id" uuid,
	"owns_last_analysis" boolean DEFAULT false NOT NULL,
	"pending_dispatch" boolean DEFAULT false NOT NULL,
	CONSTRAINT "direct_chat_learning_schedules_interval_check" CHECK ("direct_chat_learning_schedules"."interval_hours" between 1 and 168)
);
--> statement-breakpoint
ALTER TABLE "direct_chat_learning_schedules" ADD CONSTRAINT "direct_chat_learning_schedules_thread_id_intelligence_channel_mappings_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."intelligence_channel_mappings"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_chat_learning_schedules" ADD CONSTRAINT "direct_chat_learning_schedules_last_analysis_id_direct_chat_analyses_id_fk" FOREIGN KEY ("last_analysis_id") REFERENCES "public"."direct_chat_analyses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "direct_chat_learning_schedules_due_idx" ON "direct_chat_learning_schedules" USING btree ("next_at") WHERE "direct_chat_learning_schedules"."enabled";