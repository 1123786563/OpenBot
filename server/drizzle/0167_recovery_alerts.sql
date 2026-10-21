-- Bifrost 08.6 (#281): the per-item alert state that makes recovery alerting durable —
-- one row per recovery item (the unique index IS the dedup), carrying the masked disposal
-- facts (account ref masked at write time, never credentials or other accounts' data),
-- the level ladder first → repeat → escalated, and the anchors dedup and escalation
-- decide on. Expand-only: no existing table is touched.
CREATE TABLE "credit_recovery_alerts" (
	"id" text NOT NULL,
	"item_id" text NOT NULL,
	"reservation_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"account_masked" text NOT NULL,
	"maximum_credits" integer NOT NULL,
	"failure_count" integer NOT NULL,
	"reason_code" text,
	"level" text NOT NULL,
	"last_trigger" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"first_alerted_at" timestamp with time zone NOT NULL,
	"last_alerted_at" timestamp with time zone NOT NULL,
	"escalated_at" timestamp with time zone,
	"alert_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_recovery_alerts_level_check" CHECK ("credit_recovery_alerts"."level" IN ('first', 'repeat', 'escalated')),
	CONSTRAINT "credit_recovery_alerts_trigger_check" CHECK ("credit_recovery_alerts"."last_trigger" IN ('failure_threshold', 'dwell_limit')),
	CONSTRAINT "credit_recovery_alerts_maximum_check" CHECK ("credit_recovery_alerts"."maximum_credits" > 0),
	CONSTRAINT "credit_recovery_alerts_failure_count_check" CHECK ("credit_recovery_alerts"."failure_count" >= 0),
	CONSTRAINT "credit_recovery_alerts_alert_count_check" CHECK ("credit_recovery_alerts"."alert_count" >= 1),
	CONSTRAINT "credit_recovery_alerts_escalation_check" CHECK ((("credit_recovery_alerts"."level" <> 'escalated' AND "credit_recovery_alerts"."escalated_at" IS NULL) OR ("credit_recovery_alerts"."level" = 'escalated' AND "credit_recovery_alerts"."escalated_at" IS NOT NULL))),
	CONSTRAINT "credit_recovery_alerts_ordering_check" CHECK ("credit_recovery_alerts"."last_alerted_at" >= "credit_recovery_alerts"."first_alerted_at"),
	CONSTRAINT "credit_recovery_alerts_pk" PRIMARY KEY("id")
);--> statement-breakpoint
ALTER TABLE "credit_recovery_alerts" ADD CONSTRAINT "credit_recovery_alerts_item_id_credit_recovery_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."credit_recovery_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_recovery_alerts_item_unique_idx" ON "credit_recovery_alerts" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "credit_recovery_alerts_level_last_idx" ON "credit_recovery_alerts" USING btree ("level","last_alerted_at");
