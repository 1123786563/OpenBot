CREATE TABLE "background_tool_results" (
  "account_id" uuid NOT NULL,
  "operation_id" text NOT NULL,
  "call_id" text NOT NULL,
  "tool_ref" text NOT NULL,
  "result" text,
  PRIMARY KEY ("account_id", "operation_id", "call_id"),
  FOREIGN KEY ("account_id", "operation_id")
    REFERENCES "test_credit_operations" ("account_id", "id") ON DELETE CASCADE
);
