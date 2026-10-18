-- multitenancy migrate-test
CREATE OR REPLACE FUNCTION "public"."ob_ent_reset_business_context"() RETURNS void LANGUAGE sql AS $func$ SELECT set_config('app.tenant_id', '', false), set_config('app.principal_id', '', false), set_config('app.user_id', '', false), set_config('app.workspace_id', '', false), set_config('app.operation_id', '', false), set_config('app.resource_id', '', false), set_config('app.operator_principal_id', '', false) $func$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."ob_ent_reset_business_context"() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."ob_ent_reset_business_context"() TO ob_ent_directory, ob_ent_data, ob_ent_operator;
