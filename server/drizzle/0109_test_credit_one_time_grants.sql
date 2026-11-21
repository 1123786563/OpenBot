CREATE TABLE "test_credit_issuance_budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"total" bigint NOT NULL,
	"issued" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "test_credit_issuance_budget_total" CHECK ("test_credit_issuance_budgets"."total" >= 0),
	CONSTRAINT "test_credit_issuance_budget_issued" CHECK ("test_credit_issuance_budgets"."issued" >= 0 AND "test_credit_issuance_budgets"."issued" <= "test_credit_issuance_budgets"."total")
);
--> statement-breakpoint
CREATE TABLE "test_credit_issuances" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"budget_id" text NOT NULL,
	"batch_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"state" text NOT NULL,
	"issued_at" timestamp with time zone,
	CONSTRAINT "test_credit_issuance_amount_positive" CHECK ("test_credit_issuances"."amount" > 0),
	CONSTRAINT "test_credit_issuance_state" CHECK (("test_credit_issuances"."state" = 'pending' AND "test_credit_issuances"."issued_at" IS NULL) OR ("test_credit_issuances"."state" = 'issued' AND "test_credit_issuances"."issued_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "test_credit_issuances" ADD CONSTRAINT "test_credit_issuances_account_id_test_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."test_credit_accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "test_credit_issuances" ADD CONSTRAINT "test_credit_issuances_budget_id_test_credit_issuance_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."test_credit_issuance_budgets"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "test_credit_issuances" ADD CONSTRAINT "test_credit_issuances_batch_id_test_credit_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."test_credit_batches"("id") ON DELETE no action ON UPDATE no action;
