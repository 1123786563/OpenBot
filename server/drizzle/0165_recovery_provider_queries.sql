-- Bifrost 08.5 (#280): the append-only evidence row every provider final-state query
-- leaves behind, one per query, on the recovery item it was run for. The item's
-- last_reason keeps only the newest fact; this table keeps the trail the evidenced
-- disposal (08.9) and the admin recovery views (08.8) stand on. Expand-only: no existing
-- table is touched.
CREATE TABLE "credit_recovery_queries" (
	"id" text NOT NULL,
	"item_id" text NOT NULL,
	"reservation_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"source" text NOT NULL,
	"conclusion" text NOT NULL,
	"summary" text NOT NULL,
	"usage_input" integer,
	"usage_output" integer,
	"queried_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_recovery_queries_conclusion_check" CHECK ("credit_recovery_queries"."conclusion" IN ('settled_evidence', 'no_charge_evidence', 'still_unknown')),
	CONSTRAINT "credit_recovery_queries_usage_pair_check" CHECK ((("credit_recovery_queries"."usage_input" IS NULL AND "credit_recovery_queries"."usage_output" IS NULL) OR ("credit_recovery_queries"."usage_input" IS NOT NULL AND "credit_recovery_queries"."usage_output" IS NOT NULL))),
	CONSTRAINT "credit_recovery_queries_pk" PRIMARY KEY("id")
);--> statement-breakpoint
ALTER TABLE "credit_recovery_queries" ADD CONSTRAINT "credit_recovery_queries_item_id_credit_recovery_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."credit_recovery_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_recovery_queries_item_queried_idx" ON "credit_recovery_queries" USING btree ("item_id","queried_at");
