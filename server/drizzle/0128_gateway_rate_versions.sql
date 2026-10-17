-- Bifrost 01.4 (AC12/Q14/Q19): the conversion rate becomes immutable version records.
--
-- Until now the rate lived as one mutable value in `enterprise_settings`
-- (`gateway_conversion_rate`). A mutable single value cannot answer "which rate was in effect
-- when this request was admitted?", so a change would silently re-price every request still
-- being settled. From this migration on, each administrator save appends one row here — the
-- version number, the exact rational as decimal strings, the moment it took effect and the
-- operator who recorded it — and updates the `enterprise_settings` row only as the marker of
-- which version is current. Requests resolve the version effective at their own time, so a
-- change reaches only requests admitted after it.
CREATE TABLE "gateway_rate_versions" (
	"rate_version" integer PRIMARY KEY,
	"numerator" text NOT NULL,
	"denominator" text NOT NULL,
	"effective_at" timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "gateway_rate_versions_effective_at_idx" ON "gateway_rate_versions" USING btree ("effective_at" DESC,"rate_version" DESC);
--> statement-breakpoint
-- Backfill the version a pre-01.4 deployment had already recorded. The `enterprise_settings` row
-- keeps its 01.3 shape (`{ value: { numerator, denominator }, rateVersion }`), and its auditor
-- columns (`updated_at`, `updated_by`) are exactly the effective time and operator this table
-- exists to remember. Only a well-formed row is promoted: terms must be plain digit strings and
-- the version a whole positive number, because a hand-tampered row is refused by the store's
-- reads and must not be laundered into history by a migration. `ON CONFLICT DO NOTHING` keeps
-- the statement idempotent, so a deployment that already ran a partially applied attempt (or a
-- future save that raced the migration window under the save lock) cannot create a second row
-- for one version.
INSERT INTO "gateway_rate_versions" ("rate_version", "numerator", "denominator", "effective_at", "recorded_by")
SELECT
	(s.value ->> 'rateVersion')::integer,
	s.value -> 'value' ->> 'numerator',
	s.value -> 'value' ->> 'denominator',
	s.updated_at,
	COALESCE(s.updated_by, 'migration:pre-version-pointer')
FROM "enterprise_settings" s
WHERE s.key = 'gateway_conversion_rate'
	AND jsonb_typeof(s.value) = 'object'
	AND jsonb_typeof(s.value -> 'value') = 'object'
	AND (s.value ->> 'rateVersion') ~ '^\d+$'
	AND (s.value ->> 'rateVersion')::integer > 0
	AND (s.value -> 'value' ->> 'numerator') ~ '^\d+$'
	AND (s.value -> 'value' ->> 'denominator') ~ '^\d+$'
ON CONFLICT ("rate_version") DO NOTHING;
--> statement-breakpoint
-- THE RATE HISTORY IS APPEND-ONLY, AND THIS IS WHAT MAKES THAT TRUE. A history anybody can edit
-- after the fact answers no question worth asking (the same reasoning migration 0000 recorded for
-- the audit trail, whose shape this follows). Enforced in the database rather than the
-- application, because the application is not the only thing that can reach this table.
CREATE OR REPLACE FUNCTION prevent_gateway_rate_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Gateway rate versions are append-only';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS gateway_rate_versions_append_only ON gateway_rate_versions;
CREATE TRIGGER gateway_rate_versions_append_only
BEFORE UPDATE OR DELETE ON gateway_rate_versions
FOR EACH ROW
EXECUTE FUNCTION prevent_gateway_rate_version_mutation();
--> statement-breakpoint
-- A row-level trigger cannot see TRUNCATE: migration 0012 caught the audit trail being emptied
-- by exactly that statement while every UPDATE and DELETE was refused. The statement trigger
-- closes it from day one here, so the refusal is not a patch that arrives after the first
-- incident.
DROP TRIGGER IF EXISTS gateway_rate_versions_no_truncate ON gateway_rate_versions;
CREATE TRIGGER gateway_rate_versions_no_truncate
BEFORE TRUNCATE ON gateway_rate_versions
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_gateway_rate_version_mutation();
