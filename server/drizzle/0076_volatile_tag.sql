CREATE TABLE "usage_outbox" (
	"event_id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_customer_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"model" text NOT NULL,
	"client" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"lago_status" text DEFAULT 'pending' NOT NULL,
	"credits_status" text DEFAULT 'pending' NOT NULL,
	"lago_last_error_code" text,
	"credits_last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_outbox_source_check" CHECK ("usage_outbox"."source" IN ('llm', 'code_run')),
	CONSTRAINT "usage_outbox_input_tokens_check" CHECK ("usage_outbox"."input_tokens" >= 0),
	CONSTRAINT "usage_outbox_output_tokens_check" CHECK ("usage_outbox"."output_tokens" >= 0),
	CONSTRAINT "usage_outbox_lago_status_check" CHECK ("usage_outbox"."lago_status" IN ('pending', 'delivered')),
	CONSTRAINT "usage_outbox_credits_status_check" CHECK ("usage_outbox"."credits_status" IN ('pending', 'delivered'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_outbox_transaction_id_unique_idx" ON "usage_outbox" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "usage_outbox_lago_pending_created_idx" ON "usage_outbox" USING btree ("lago_status","created_at");--> statement-breakpoint
CREATE INDEX "usage_outbox_credits_pending_created_idx" ON "usage_outbox" USING btree ("credits_status","created_at");