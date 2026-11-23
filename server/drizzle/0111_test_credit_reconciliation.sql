CREATE TABLE "test_credit_evidence" (
	"account_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"evidence_id" text NOT NULL,
	"outcome" text NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cost" numeric NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "test_credit_evidence_account_id_operation_id_evidence_id_pk" PRIMARY KEY("account_id","operation_id","evidence_id"),
	CONSTRAINT "test_credit_evidence_amounts" CHECK (
      "test_credit_evidence"."input_tokens" >= 0 AND "test_credit_evidence"."output_tokens" >= 0 AND "test_credit_evidence"."cost" >= 0
      AND ("test_credit_evidence"."outcome" <> 'zero_cost' OR "test_credit_evidence"."cost" = 0)
    )
);
--> statement-breakpoint
ALTER TABLE "test_credit_operations" DROP CONSTRAINT "test_credit_operation_state";--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD COLUMN "rerun_of_operation_id" text;--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD COLUMN "cutoff_hold" bigint;--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD COLUMN "eligible_evidence_id" text;--> statement-breakpoint
ALTER TABLE "test_credit_evidence" ADD CONSTRAINT "test_credit_evidence_operation_fk" FOREIGN KEY ("account_id","operation_id") REFERENCES "public"."test_credit_operations"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD CONSTRAINT "test_credit_rerun_original_fk" FOREIGN KEY ("account_id","rerun_of_operation_id") REFERENCES "public"."test_credit_operations"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD CONSTRAINT "test_credit_cutoff_hold_amount" CHECK ("test_credit_operations"."cutoff_hold" BETWEEN 0 AND "test_credit_operations"."reserved");--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD CONSTRAINT "test_credit_rerun_distinct" CHECK ("test_credit_operations"."rerun_of_operation_id" <> "test_credit_operations"."id");--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD CONSTRAINT "test_credit_operation_state" CHECK (
    (("test_credit_operations"."state" = 'released' OR ("test_credit_operations"."state" = 'reserved' AND "test_credit_operations"."dispatched_at" IS NULL))
      AND "test_credit_operations"."charged" IS NULL AND "test_credit_operations"."input_tokens" IS NULL AND "test_credit_operations"."output_tokens" IS NULL)
    OR ("test_credit_operations"."state" = 'pending' AND "test_credit_operations"."dispatched_at" IS NOT NULL
      AND "test_credit_operations"."charged" IS NULL AND "test_credit_operations"."input_tokens" IS NULL AND "test_credit_operations"."output_tokens" IS NULL)
    OR ("test_credit_operations"."state" = 'settled' AND "test_credit_operations"."dispatched_at" IS NOT NULL
      AND "test_credit_operations"."charged" IS NOT NULL AND "test_credit_operations"."input_tokens" IS NOT NULL AND "test_credit_operations"."output_tokens" IS NOT NULL
      AND "test_credit_operations"."input_tokens" >= 0 AND "test_credit_operations"."output_tokens" >= 0)
  );