ALTER TABLE "usage_outbox" ADD COLUMN "reservation_id" text;--> statement-breakpoint
ALTER TABLE "usage_outbox" ADD COLUMN "actual_cost_numerator" text;--> statement-breakpoint
ALTER TABLE "usage_outbox" ADD COLUMN "actual_cost_denominator" text;--> statement-breakpoint
ALTER TABLE "usage_outbox" ADD CONSTRAINT "usage_outbox_credit_identity_check" CHECK ((
        "usage_outbox"."reservation_id" IS NULL
        AND "usage_outbox"."actual_cost_numerator" IS NULL
        AND "usage_outbox"."actual_cost_denominator" IS NULL
      ) OR (
        "usage_outbox"."reservation_id" IS NOT NULL
        AND "usage_outbox"."actual_cost_numerator" ~ '^[0-9]+$'
        AND "usage_outbox"."actual_cost_denominator" ~ '^[1-9][0-9]*$'
      ));