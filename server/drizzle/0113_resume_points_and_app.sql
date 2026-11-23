CREATE TABLE "test_credit_resume_points" (
	"account_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"application_id" text,
	"reason" text NOT NULL,
	"budget_id" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_credit_resume_points_account_id_operation_id_pk" PRIMARY KEY("account_id","operation_id"),
	CONSTRAINT "test_credit_resume_point_confirmation" CHECK (("test_credit_resume_points"."budget_id" is null) = ("test_credit_resume_points"."confirmed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "test_credit_operations" ADD COLUMN "application_id" text;--> statement-breakpoint
ALTER TABLE "test_credit_resume_points" ADD CONSTRAINT "test_credit_resume_points_account_id_test_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."test_credit_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_credit_resume_points" ADD CONSTRAINT "test_credit_resume_point_budget_fk" FOREIGN KEY ("account_id","budget_id") REFERENCES "public"."test_credit_budgets"("account_id","id") ON DELETE cascade ON UPDATE no action;