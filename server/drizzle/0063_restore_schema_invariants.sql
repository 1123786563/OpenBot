DO $migration$
DECLARE
	invalid_run_count bigint;
	invalid_reservation_count bigint;
	non_array_count bigint := 0;
	malformed_json_count bigint := 0;
	invalid_uuid_or_duplicate_count bigint := 0;
	holder_mismatch_count bigint := 0;
	intent record;
	decoded jsonb;
	decoded_text text;
	encoded_count bigint;
	holder_count bigint;
	matching_holder_count bigint;
BEGIN
	LOCK TABLE mastra_message_intents IN SHARE ROW EXCLUSIVE MODE;
	LOCK TABLE mastra_message_intent_attachments IN SHARE ROW EXCLUSIVE MODE;

	SELECT count(*) INTO invalid_run_count
	FROM enterprise_runs
	WHERE model_route_maximum_tokens <= 0;

	SELECT count(*) INTO invalid_reservation_count
	FROM enterprise_model_budget_reservations
	WHERE token_limit <= 0
		OR confirmed_tokens < 0
		OR confirmed_tokens > token_limit;

	FOR intent IN
		SELECT tenant_id, thread_id, client_message_key, attachment_ids
		FROM mastra_message_intents
	LOOP
		IF jsonb_typeof(intent.attachment_ids) = 'array' THEN
			CONTINUE;
		END IF;

		IF jsonb_typeof(intent.attachment_ids) <> 'string' THEN
			non_array_count := non_array_count + 1;
			CONTINUE;
		END IF;

		decoded_text := intent.attachment_ids #>> '{}';
		BEGIN
			decoded := decoded_text::jsonb;
		EXCEPTION WHEN others THEN
			malformed_json_count := malformed_json_count + 1;
			CONTINUE;
		END;

		IF jsonb_typeof(decoded) <> 'array' THEN
			non_array_count := non_array_count + 1;
			CONTINUE;
		END IF;

		IF EXISTS (
			SELECT 1
			FROM jsonb_array_elements(decoded) AS element(value)
			WHERE jsonb_typeof(element.value) <> 'string'
				OR (element.value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		) OR (
			SELECT count(*) <> count(DISTINCT lower(value))
			FROM jsonb_array_elements_text(decoded) AS element(value)
		) THEN
			invalid_uuid_or_duplicate_count := invalid_uuid_or_duplicate_count + 1;
			CONTINUE;
		END IF;

		SELECT count(*) INTO encoded_count
		FROM jsonb_array_elements(decoded);

		SELECT count(*) INTO holder_count
		FROM mastra_message_intent_attachments holder
		WHERE holder.tenant_id = intent.tenant_id
			AND holder.thread_id = intent.thread_id
			AND holder.client_message_key = intent.client_message_key;

		SELECT count(*) INTO matching_holder_count
		FROM mastra_message_intent_attachments holder
		JOIN LATERAL jsonb_array_elements_text(decoded) AS element(value)
			ON holder.attachment_id = element.value::uuid
		WHERE holder.tenant_id = intent.tenant_id
			AND holder.thread_id = intent.thread_id
			AND holder.client_message_key = intent.client_message_key;

		IF encoded_count <> holder_count OR holder_count <> matching_holder_count THEN
			holder_mismatch_count := holder_mismatch_count + 1;
		END IF;
	END LOOP;

	IF invalid_run_count > 0
		OR invalid_reservation_count > 0
		OR non_array_count > 0
		OR malformed_json_count > 0
		OR invalid_uuid_or_duplicate_count > 0
		OR holder_mismatch_count > 0 THEN
		RAISE EXCEPTION '0063 preflight blocked: invalid_run_ceiling_count=%, invalid_reservation_count=%, non_array_intent_count=%, malformed_intent_json_count=%, invalid_uuid_or_duplicate_intent_count=%, holder_mismatch_intent_count=%',
			invalid_run_count, invalid_reservation_count, non_array_count,
			malformed_json_count, invalid_uuid_or_duplicate_count,
			holder_mismatch_count;
	END IF;
END
$migration$;--> statement-breakpoint

UPDATE mastra_message_intents
SET attachment_ids = (attachment_ids #>> '{}')::jsonb
WHERE jsonb_typeof(attachment_ids) = 'string';--> statement-breakpoint

ALTER TABLE "mastra_message_intents" ADD CONSTRAINT "mastra_message_intents_attachment_ids_array_check" CHECK (jsonb_typeof("attachment_ids") = 'array');--> statement-breakpoint
ALTER TABLE "enterprise_model_budget_reservations" DROP CONSTRAINT "enterprise_budget_reservation_tokens_check";--> statement-breakpoint
ALTER TABLE "enterprise_runs" ALTER COLUMN "model_route_maximum_tokens" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "enterprise_model_budget_reservations" ADD CONSTRAINT "enterprise_budget_reservation_tokens_check" CHECK ("enterprise_model_budget_reservations"."token_limit" > 0 and "enterprise_model_budget_reservations"."confirmed_tokens" >= 0 and "enterprise_model_budget_reservations"."confirmed_tokens" <= "enterprise_model_budget_reservations"."token_limit");--> statement-breakpoint
ALTER TABLE "enterprise_runs" ADD CONSTRAINT "enterprise_runs_model_route_maximum_tokens_check" CHECK ("enterprise_runs"."model_route_maximum_tokens" > 0);
