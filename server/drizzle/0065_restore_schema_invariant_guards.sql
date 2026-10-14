CREATE OR REPLACE FUNCTION pg_temp.try_parse_legacy_attachment_ids(value text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $function$
BEGIN
	RETURN value::jsonb;
EXCEPTION
	WHEN query_canceled THEN
		RAISE;
	-- Only JSON text parse faults count as malformed; infrastructure
	-- errors (memory, encoding) must surface, not inflate the count.
	WHEN invalid_text_representation OR invalid_binary_representation THEN
		RETURN NULL;
END
$function$;--> statement-breakpoint

DO $migration$
DECLARE
	invalid_run_count bigint;
	invalid_reservation_count bigint;
	non_array_count bigint := 0;
	malformed_json_count bigint := 0;
	invalid_uuid_or_duplicate_count bigint := 0;
	holder_mismatch_count bigint := 0;
BEGIN
	LOCK TABLE enterprise_runs IN SHARE ROW EXCLUSIVE MODE;
	LOCK TABLE enterprise_model_budget_reservations IN SHARE ROW EXCLUSIVE MODE;

	SELECT count(*) INTO invalid_run_count
	FROM enterprise_runs
	WHERE model_route_maximum_tokens <= 0;

	SELECT count(*) INTO invalid_reservation_count
	FROM enterprise_model_budget_reservations
	WHERE token_limit <= 0
		OR confirmed_tokens < 0
		OR confirmed_tokens > token_limit;

	LOCK TABLE mastra_message_intents IN SHARE ROW EXCLUSIVE MODE;
	LOCK TABLE mastra_message_intent_attachments IN SHARE ROW EXCLUSIVE MODE;

	WITH decoded AS MATERIALIZED (
		SELECT tenant_id, thread_id, client_message_key, attachment_ids,
			CASE WHEN jsonb_typeof(attachment_ids) = 'string'
				THEN pg_temp.try_parse_legacy_attachment_ids(attachment_ids #>> '{}')
				ELSE attachment_ids
			END AS parsed,
			jsonb_typeof(attachment_ids) = 'string' AS was_encoded
		FROM mastra_message_intents
	),
	intent_shape AS MATERIALIZED (
		SELECT *,
			was_encoded AND parsed IS NULL AS malformed,
			parsed IS NOT NULL AND jsonb_typeof(parsed) <> 'array' AS non_array
		FROM decoded
	),
	array_elements AS MATERIALIZED (
		SELECT s.tenant_id, s.thread_id, s.client_message_key, s.was_encoded,
			e.value #>> '{}' AS attachment_id,
			jsonb_typeof(e.value) = 'string'
				AND (e.value #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AS valid_uuid
		FROM intent_shape s
		CROSS JOIN LATERAL jsonb_array_elements(
			CASE WHEN jsonb_typeof(s.parsed) = 'array' THEN s.parsed ELSE '[]'::jsonb END
		) AS e(value)
		WHERE s.was_encoded
	),
	array_quality AS MATERIALIZED (
		SELECT tenant_id, thread_id, client_message_key,
			count(*) FILTER (WHERE NOT valid_uuid) > 0
				OR count(*) <> count(DISTINCT lower(attachment_id)) AS invalid_uuid_or_duplicate
		FROM array_elements
		GROUP BY tenant_id, thread_id, client_message_key
	),
	holder_counts AS MATERIALIZED (
		SELECT tenant_id, thread_id, client_message_key, count(*) AS holder_count
		FROM mastra_message_intent_attachments
		GROUP BY tenant_id, thread_id, client_message_key
	),
	matching_counts AS MATERIALIZED (
		SELECT e.tenant_id, e.thread_id, e.client_message_key, count(*) AS matching_count
		FROM array_elements e
		JOIN mastra_message_intent_attachments h
			ON h.tenant_id = e.tenant_id
			AND h.thread_id = e.thread_id
			AND h.client_message_key = e.client_message_key
			AND h.attachment_id = CASE
				WHEN e.valid_uuid THEN e.attachment_id::uuid
				ELSE NULL::uuid
			END
		WHERE e.valid_uuid
		GROUP BY e.tenant_id, e.thread_id, e.client_message_key
	),
    per_intent AS MATERIALIZED (
		SELECT s.tenant_id, s.thread_id, s.client_message_key, s.parsed, s.was_encoded,
			s.malformed, s.non_array,
			COALESCE(q.invalid_uuid_or_duplicate, false) AS invalid_uuid_or_duplicate,
			COALESCE(h.holder_count, 0) AS holder_count,
			COALESCE(m.matching_count, 0) AS matching_count
		FROM intent_shape s
		LEFT JOIN array_quality q USING (tenant_id, thread_id, client_message_key)
		LEFT JOIN holder_counts h USING (tenant_id, thread_id, client_message_key)
		LEFT JOIN matching_counts m USING (tenant_id, thread_id, client_message_key)
	)
	SELECT
		count(*) FILTER (WHERE non_array),
		count(*) FILTER (WHERE malformed),
		count(*) FILTER (WHERE invalid_uuid_or_duplicate),
		count(*) FILTER (WHERE was_encoded AND jsonb_typeof(parsed) = 'array'
			AND NOT invalid_uuid_or_duplicate
			AND (jsonb_array_length(parsed) <> holder_count OR holder_count <> matching_count))
	INTO non_array_count, malformed_json_count, invalid_uuid_or_duplicate_count, holder_mismatch_count
	FROM per_intent;

	IF invalid_run_count > 0
		OR invalid_reservation_count > 0
		OR non_array_count > 0
		OR malformed_json_count > 0
		OR invalid_uuid_or_duplicate_count > 0
		OR holder_mismatch_count > 0 THEN
		-- invalid_run_ceiling_count remains compatible with the 0063 diagnostic label.
		RAISE EXCEPTION '0065 preflight blocked: invalid_run_ceiling_count=%, invalid_reservation_count=%, non_array_intent_count=%, malformed_intent_json_count=%, invalid_uuid_or_duplicate_intent_count=%, holder_mismatch_intent_count=%',
			invalid_run_count, invalid_reservation_count, non_array_count,
			malformed_json_count, invalid_uuid_or_duplicate_count,
			holder_mismatch_count;
	END IF;
END
$migration$;--> statement-breakpoint

DROP FUNCTION pg_temp.try_parse_legacy_attachment_ids(text);--> statement-breakpoint

UPDATE mastra_message_intents
SET attachment_ids = (attachment_ids #>> '{}')::jsonb
WHERE jsonb_typeof(attachment_ids) = 'string';--> statement-breakpoint

DO $migration$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'mastra_message_intents'::regclass
			AND conname = 'mastra_message_intents_attachment_ids_array_check'
	) THEN
		ALTER TABLE "mastra_message_intents"
			ADD CONSTRAINT "mastra_message_intents_attachment_ids_array_check"
			CHECK (jsonb_typeof("attachment_ids") = 'array') NOT VALID;
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'enterprise_model_budget_reservations'::regclass
			AND conname = 'enterprise_budget_reservation_tokens_check'
	) THEN
		ALTER TABLE "enterprise_model_budget_reservations"
			ADD CONSTRAINT "enterprise_budget_reservation_tokens_check"
			CHECK ("enterprise_model_budget_reservations"."token_limit" > 0
				AND "enterprise_model_budget_reservations"."confirmed_tokens" >= 0
				AND "enterprise_model_budget_reservations"."confirmed_tokens" <= "enterprise_model_budget_reservations"."token_limit") NOT VALID;
	END IF;

	ALTER TABLE "enterprise_runs"
		ALTER COLUMN "model_route_maximum_tokens" DROP DEFAULT;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'enterprise_runs'::regclass
			AND conname = 'enterprise_runs_model_route_maximum_tokens_check'
	) THEN
		ALTER TABLE "enterprise_runs"
			ADD CONSTRAINT "enterprise_runs_model_route_maximum_tokens_check"
			CHECK ("enterprise_runs"."model_route_maximum_tokens" > 0) NOT VALID;
	END IF;
END
$migration$;
