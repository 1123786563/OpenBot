CREATE TABLE "direct_chat_runs" (
	"thread_id" text NOT NULL,
	"id" text NOT NULL,
	"user_message_id" text NOT NULL,
	"prompt" text NOT NULL,
	"assistant_message_id" text,
	"reply" text,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "direct_chat_runs_thread_id_id_pk" PRIMARY KEY("thread_id","id"),
	CONSTRAINT "direct_chat_runs_status_check" CHECK ("direct_chat_runs"."status" in ('running', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "direct_chat_runs" ADD CONSTRAINT "direct_chat_runs_thread_id_intelligence_channel_mappings_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."intelligence_channel_mappings"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "direct_chat_runs_request_idx" ON "direct_chat_runs" USING btree ("thread_id","user_message_id");