-- Older Bun SQL writes wrapped the serialized values in a JSONB string.
UPDATE "personal_workspace_closures"
SET "cleanup" = ("cleanup" #>> '{}')::jsonb
WHERE CASE
  WHEN jsonb_typeof("cleanup") = 'string'
    AND pg_input_is_valid("cleanup" #>> '{}', 'jsonb')
  THEN jsonb_typeof(("cleanup" #>> '{}')::jsonb) = 'object'
  ELSE false
END;
--> statement-breakpoint
UPDATE "personal_workspace_closures"
SET "backup_schedule" = ("backup_schedule" #>> '{}')::jsonb
WHERE CASE
  WHEN jsonb_typeof("backup_schedule") = 'string'
    AND pg_input_is_valid("backup_schedule" #>> '{}', 'jsonb')
  THEN jsonb_typeof(("backup_schedule" #>> '{}')::jsonb) = 'array'
  ELSE false
END;
