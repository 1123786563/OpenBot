-- Bifrost price status repair: the original 0134 backfill also needs to cover databases
-- that already recorded 0134 before this repair was shipped.
ALTER TABLE "gateway_price_snapshots" DISABLE TRIGGER "gateway_price_snapshots_append_only";
--> statement-breakpoint
WITH derived AS (
  SELECT
    snapshot."provider",
    snapshot."model",
    snapshot."capability",
    snapshot."snapshot_version",
    classify_gateway_price_status(snapshot."dims") AS "price_status",
    CASE
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
    END AS "price_status_reason",
    CASE
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
    END AS "price_status_missing_dims"
  FROM "gateway_price_snapshots" AS snapshot
)
UPDATE "gateway_price_snapshots" AS snapshot
SET
  "price_status" = derived."price_status",
  "price_status_reason" = derived."price_status_reason",
  "price_status_missing_dims" = derived."price_status_missing_dims"
FROM derived
WHERE snapshot."provider" = derived."provider"
  AND snapshot."model" = derived."model"
  AND snapshot."capability" = derived."capability"
  AND snapshot."snapshot_version" = derived."snapshot_version"
  AND (
    snapshot."price_status" IS DISTINCT FROM derived."price_status"
    OR snapshot."price_status_reason" IS DISTINCT FROM derived."price_status_reason"
    OR snapshot."price_status_missing_dims" IS DISTINCT FROM derived."price_status_missing_dims"
  );
--> statement-breakpoint
ALTER TABLE "gateway_price_snapshots" ENABLE TRIGGER "gateway_price_snapshots_append_only";
