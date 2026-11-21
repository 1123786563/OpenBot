CREATE TABLE "test_credit_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	CONSTRAINT "test_credit_accounts_issuer_subject_unique" UNIQUE("issuer","subject")
);
--> statement-breakpoint
CREATE TABLE "test_credit_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"amount" bigint NOT NULL,
	CONSTRAINT "test_credit_batch_positive" CHECK ("test_credit_batches"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "test_credit_enrollments" (
	"account_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone,
	CONSTRAINT "test_credit_enrollments_account_id_batch_id_pk" PRIMARY KEY("account_id","batch_id")
);
--> statement-breakpoint
CREATE TABLE "test_credit_operations" (
	"account_id" uuid NOT NULL,
	"id" text NOT NULL,
	"permit" uuid DEFAULT gen_random_uuid() NOT NULL,
	"price_version" uuid NOT NULL,
	"route" jsonb NOT NULL,
	"reserved" bigint NOT NULL,
	"charged" bigint,
	"state" text NOT NULL,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	CONSTRAINT "test_credit_operations_account_id_id_pk" PRIMARY KEY("account_id","id"),
	CONSTRAINT "test_credit_operation_amounts" CHECK (
    "test_credit_operations"."reserved" >= 0 AND
    ("test_credit_operations"."charged" IS NULL OR "test_credit_operations"."charged" BETWEEN 0 AND "test_credit_operations"."reserved")
  ),
	CONSTRAINT "test_credit_operation_state" CHECK (
    ("test_credit_operations"."state" IN ('reserved', 'released') AND "test_credit_operations"."dispatched_at" IS NULL
      AND "test_credit_operations"."charged" IS NULL AND "test_credit_operations"."input_tokens" IS NULL AND "test_credit_operations"."output_tokens" IS NULL)
    OR ("test_credit_operations"."state" = 'pending' AND "test_credit_operations"."dispatched_at" IS NOT NULL
      AND "test_credit_operations"."charged" IS NULL AND "test_credit_operations"."input_tokens" IS NULL AND "test_credit_operations"."output_tokens" IS NULL)
    OR ("test_credit_operations"."state" = 'settled' AND "test_credit_operations"."dispatched_at" IS NOT NULL
      AND "test_credit_operations"."charged" IS NOT NULL AND "test_credit_operations"."input_tokens" IS NOT NULL AND "test_credit_operations"."output_tokens" IS NOT NULL
      AND "test_credit_operations"."input_tokens" >= 0 AND "test_credit_operations"."output_tokens" >= 0)
  )
);
--> statement-breakpoint
ALTER TABLE "test_credit_enrollments" ADD CONSTRAINT "test_credit_enrollments_account_id_test_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."test_credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_credit_enrollments" ADD CONSTRAINT "test_credit_enrollments_batch_id_test_credit_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."test_credit_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD CONSTRAINT "test_credit_operations_account_id_test_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."test_credit_accounts"("id") ON DELETE no action ON UPDATE no action;