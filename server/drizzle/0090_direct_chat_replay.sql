CREATE TABLE "direct_chat_run_events" (
	"thread_id" text NOT NULL,
	"run_id" text NOT NULL,
	"cursor" integer NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "direct_chat_run_events_thread_id_run_id_cursor_pk" PRIMARY KEY("thread_id","run_id","cursor")
);
--> statement-breakpoint
ALTER TABLE "direct_chat_runs" ADD COLUMN "event_cursor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "direct_chat_runs" ADD COLUMN "partial_message_id" text;--> statement-breakpoint
ALTER TABLE "direct_chat_runs" ADD COLUMN "partial_reply" text;--> statement-breakpoint
ALTER TABLE "direct_chat_run_events" ADD CONSTRAINT "direct_chat_run_events_thread_id_run_id_direct_chat_runs_thread_id_id_fk" FOREIGN KEY ("thread_id","run_id") REFERENCES "public"."direct_chat_runs"("thread_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "direct_chat_run_events_created_idx" ON "direct_chat_run_events" USING btree ("created_at");