-- Bifrost 03.3 (#225, AC06/Q11): the known/free/unknown price status classification,
-- persisted beside the dims it classifies.
--
-- `classify_gateway_price_status` folds one row's dims into the one status the cell carries:
-- `known` when every NECESSARY dimension carries a known amount that is not exactly zero,
-- `free` when every necessary dimension is priced at exactly zero, `unknown` when any
-- necessary dimension lacks a usable price. The necessary set is the dimensions the v1 wire
-- can price — input, output, reasoning, image, cache read/write and the two surcharges; the
-- reserved dimensions (image output, audio in/out, video) have no wire field at all in v1,
-- for every model equally, so they are a protocol-level gap and do not block known/free.
--
-- UNKNOWN IS NEVER A ZERO COST, and this is stated twice: unknown wins over everything here
-- (a cell with one unpriced necessary dimension is `unknown`, never "known except"), and the
-- `valid_gateway_price_dims` CHECK from 0130 already forbids any dimension from being stored
-- as a silent 0. `free` is a PRICE, not an admission — nothing in this classification grants
-- access; grant, credit gate and admission still own every invocation.
--
-- The status columns are forced to agree with the dims by `gateway_price_snapshots_status_
-- matches_dims` below, so a status can never drift from its own price basis; the missing-
-- dimension list (which dimensions are unpriced, and each one's fixed reason) is what the
-- rejection paths display. The classification is bound to the row's `snapshot_version` like
-- every other column: a new version classifies from its own dims and the old version keeps
-- its own status forever.
--
-- The CHECK functions must exist before the constraints that call them.
CREATE OR REPLACE FUNCTION classify_gateway_price_status(dims jsonb)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  necessary text[] := ARRAY[
    'input',
    'output',
    'reasoning',
    'image',
    'cache_read',
    'cache_write',
    'surcharge_web_search',
    'surcharge_per_request'
  ];
  dimension text;
  entry jsonb;
  any_unknown boolean := FALSE;
  all_zero boolean := TRUE;
BEGIN
  IF jsonb_typeof(dims) IS DISTINCT FROM 'object' THEN
    RETURN 'unknown';
  END IF;
  FOREACH dimension IN ARRAY necessary LOOP
    entry := dims -> dimension;
    IF entry IS NULL
      OR jsonb_typeof(entry) IS DISTINCT FROM 'object'
      OR (entry ->> 'status') IS DISTINCT FROM 'known' THEN
      any_unknown := TRUE;
    ELSIF (entry ->> 'amount') !~ '^0+(\.0+)?$' THEN
      all_zero := FALSE;
    END IF;
  END LOOP;
  IF any_unknown THEN
    RETURN 'unknown';
  END IF;
  IF all_zero THEN
    RETURN 'free';
  END IF;
  RETURN 'known';
END;
$$;
--> statement-breakpoint
-- The missing-dimension list an unknown row carries: a non-empty JSON array of
-- {"dimension": <closed vocabulary>, "reason": <fixed dimension reason>} objects. An empty
-- list would be an unknown status that cannot answer "which dimensions, and why" — the one
-- thing AC06 requires of it — so it is refused.
CREATE OR REPLACE FUNCTION valid_gateway_price_missing_dims(list jsonb)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  dimensions text[] := ARRAY[
    'input',
    'output',
    'reasoning',
    'image',
    'image_output',
    'audio_input',
    'audio_output',
    'cache_read',
    'cache_write',
    'video',
    'surcharge_web_search',
    'surcharge_per_request'
  ];
  reasons text[] := ARRAY['price_dim_no_source', 'price_dim_unreadable'];
  entry jsonb;
BEGIN
  IF jsonb_typeof(list) IS DISTINCT FROM 'array' THEN
    RETURN FALSE;
  END IF;
  IF jsonb_array_length(list) = 0 THEN
    RETURN FALSE;
  END IF;
  FOR i IN 0 .. jsonb_array_length(list) - 1 LOOP
    entry := list -> i;
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object' THEN
      RETURN FALSE;
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(entry)) <> 2
      OR NOT (entry ? 'dimension')
      OR NOT (entry ? 'reason') THEN
      RETURN FALSE;
    END IF;
    IF NOT ((entry ->> 'dimension') = ANY(dimensions)) THEN
      RETURN FALSE;
    END IF;
    IF NOT ((entry ->> 'reason') = ANY(reasons)) THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;
--> statement-breakpoint
ALTER TABLE "gateway_price_snapshots" ADD COLUMN "price_status" text;
--> statement-breakpoint
ALTER TABLE "gateway_price_snapshots" ADD COLUMN "price_status_reason" text;
--> statement-breakpoint
ALTER TABLE "gateway_price_snapshots" ADD COLUMN "price_status_missing_dims" jsonb;
--> statement-breakpoint
-- Rows recorded between 0133 and 0134 classify from their own dims; the backfill is the same
-- rule the CHECK below enforces forever after.
-- This one-time derived-column backfill is the append-only exception; this migration runs in
-- one transaction, so any failure rolls the trigger state back as well.
ALTER TABLE "gateway_price_snapshots" DISABLE TRIGGER "gateway_price_snapshots_append_only";
--> statement-breakpoint
UPDATE "gateway_price_snapshots" AS snapshot
SET
  "price_status" = classify_gateway_price_status(snapshot."dims"),
  "price_status_reason" = CASE
    WHEN classify_gateway_price_status(snapshot."dims") <> 'unknown' THEN NULL
    WHEN EXISTS (
      SELECT 1
      FROM unnest(ARRAY[
        'input', 'output', 'reasoning', 'image', 'cache_read', 'cache_write',
        'surcharge_web_search', 'surcharge_per_request'
      ]) AS required(dimension)
      WHERE snapshot."dims" -> required.dimension ->> 'status' IS DISTINCT FROM 'known'
        AND snapshot."dims" -> required.dimension ->> 'reason' = 'price_dim_unreadable'
    ) THEN 'price_status_dims_unreadable'
    ELSE 'price_status_dims_missing'
  END,
  "price_status_missing_dims" = CASE
    WHEN classify_gateway_price_status(snapshot."dims") <> 'unknown' THEN NULL
    ELSE (
      SELECT jsonb_agg(
        jsonb_build_object(
          'dimension', required.dimension,
          'reason', snapshot."dims" -> required.dimension ->> 'reason'
        )
        ORDER BY required.ordinality
      )
      FROM unnest(ARRAY[
        'input', 'output', 'reasoning', 'image', 'cache_read', 'cache_write',
        'surcharge_web_search', 'surcharge_per_request'
      ]) WITH ORDINALITY AS required(dimension, ordinality)
      WHERE snapshot."dims" -> required.dimension ->> 'status' IS DISTINCT FROM 'known'
    )
  END;
--> statement-breakpoint
ALTER TABLE "gateway_price_snapshots" ENABLE TRIGGER "gateway_price_snapshots_append_only";
--> statement-breakpoint
ALTER TABLE "gateway_price_snapshots" ALTER COLUMN "price_status" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "gateway_price_snapshots" ADD CONSTRAINT "gateway_price_snapshots_status_allowed" CHECK ("gateway_price_snapshots"."price_status" IN ('known', 'free', 'unknown'));
--> statement-breakpoint
ALTER TABLE "gateway_price_snapshots" ADD CONSTRAINT "gateway_price_snapshots_status_reason_allowed" CHECK ("gateway_price_snapshots"."price_status_reason" IS NULL OR "gateway_price_snapshots"."price_status_reason" IN ('price_status_dims_missing', 'price_status_dims_unreadable'));
--> statement-breakpoint
ALTER TABLE "gateway_price_snapshots" ADD CONSTRAINT "gateway_price_snapshots_status_details_consistent" CHECK (("gateway_price_snapshots"."price_status" = 'unknown') = ("gateway_price_snapshots"."price_status_reason" IS NOT NULL) AND ("gateway_price_snapshots"."price_status" = 'unknown') = ("gateway_price_snapshots"."price_status_missing_dims" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "gateway_price_snapshots" ADD CONSTRAINT "gateway_price_snapshots_status_missing_dims_valid" CHECK ("gateway_price_snapshots"."price_status_missing_dims" IS NULL OR valid_gateway_price_missing_dims("gateway_price_snapshots"."price_status_missing_dims"));
--> statement-breakpoint
ALTER TABLE "gateway_price_snapshots" ADD CONSTRAINT "gateway_price_snapshots_status_matches_dims" CHECK ("gateway_price_snapshots"."price_status" = classify_gateway_price_status("gateway_price_snapshots"."dims"));
