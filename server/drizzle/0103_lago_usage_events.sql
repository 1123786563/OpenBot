CREATE TABLE "lago_usage_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"resource" text NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"amount_microcredits" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lago_usage_events_account_id_operation_id_unique" UNIQUE("account_id","operation_id"),
	CONSTRAINT "lago_usage_events_amounts" CHECK ("lago_usage_events"."input_tokens" >= 0 AND "lago_usage_events"."output_tokens" >= 0 AND "lago_usage_events"."amount_microcredits" >= 0)
);
--> statement-breakpoint
ALTER TABLE "lago_usage_events" ADD CONSTRAINT "lago_usage_events_account_id_test_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."test_credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lago_usage_events_pending_idx" ON "lago_usage_events" USING btree ("state","created_at");