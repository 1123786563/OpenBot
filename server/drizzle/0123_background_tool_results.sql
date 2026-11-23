CREATE TABLE "background_tool_results" (
	"account_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"call_id" text NOT NULL,
	"tool_ref" text NOT NULL,
	"result" text,
	CONSTRAINT "background_tool_results_account_id_operation_id_call_id_pk" PRIMARY KEY("account_id","operation_id","call_id")
);
--> statement-breakpoint
ALTER TABLE "background_tool_results" ADD CONSTRAINT "background_tool_results_account_id_operation_id_test_credit_operations_account_id_id_fk" FOREIGN KEY ("account_id","operation_id") REFERENCES "public"."test_credit_operations"("account_id","id") ON DELETE cascade ON UPDATE no action;