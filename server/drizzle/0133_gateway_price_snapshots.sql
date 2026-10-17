-- Bifrost 03.2 (#224, AC06/Q11/Q17): the multi-dimensional price snapshot, versioned and
-- immutable.
--
-- `gateway_price_snapshots` holds one versioned price basis per ModelRef cell: identity is the
-- catalog's own provider × model × capability triple plus a per-ref monotonic
-- `snapshot_version`, so the same model name under two providers runs two independent version
-- sequences and never merges. `dims` carries ALL billing dimensions of the closed vocabulary
-- the `valid_gateway_price_dims` function enforces below — input, output, reasoning, image in
-- and out, audio in and out, cache read/write, video and surcharges — and a dimension the
-- gateway's manifest does not price is recorded as `{"status":"unknown","reason":...}`, never
-- as 0: the CHECK refuses a dims object with a missing key, so "unknown" cannot quietly become
-- a free price. Amounts are decimal strings (no float ever touches them); only a known amount
-- of exactly "0" is a price of free.
--
-- The table is append-only in the database, not merely in the application (0128's rule): a
-- request locks `(ref, snapshot_version)` and admission and settlement must resolve that
-- version to the same dims forever, so any change appends the next version and UPDATE, DELETE
-- and TRUNCATE are all refused.
-- The full-dims validator must exist before the table, because the CHECK constraint below
-- calls it on every insert.
CREATE OR REPLACE FUNCTION valid_gateway_price_dims(dims jsonb)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  required text[] := ARRAY[
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
  key text;
  entry jsonb;
BEGIN
  IF jsonb_typeof(dims) IS DISTINCT FROM 'object' THEN
    RETURN FALSE;
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(dims)) <> array_length(required, 1) THEN
    RETURN FALSE;
  END IF;
  FOREACH key IN ARRAY required LOOP
    IF NOT (dims ? key) THEN
      RETURN FALSE;
    END IF;
    entry := dims -> key;
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object' THEN
      RETURN FALSE;
    END IF;
    IF NOT (entry ? 'status') THEN
      RETURN FALSE;
    END IF;
    IF entry ->> 'status' = 'known' THEN
      IF entry ? 'reason' THEN
        RETURN FALSE;
      END IF;
      IF NOT (entry ? 'amount') THEN
        RETURN FALSE;
      END IF;
      IF jsonb_typeof(entry -> 'amount') IS DISTINCT FROM 'string' THEN
        RETURN FALSE;
      END IF;
      IF (entry ->> 'amount') !~ '^\d+(\.\d+)?$' THEN
        RETURN FALSE;
      END IF;
    ELSIF entry ->> 'status' = 'unknown' THEN
      IF entry ? 'amount' THEN
        RETURN FALSE;
      END IF;
      IF NOT (entry ? 'reason') THEN
        RETURN FALSE;
      END IF;
      IF (
        entry ->> 'reason' NOT IN ('price_dim_no_source', 'price_dim_unreadable')
      ) THEN
        RETURN FALSE;
      END IF;
    ELSE
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;
--> statement-breakpoint
CREATE TABLE "gateway_price_snapshots" (
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"capability" text NOT NULL,
	"snapshot_version" integer NOT NULL,
	"dims" jsonb NOT NULL,
	"source" text NOT NULL,
	"config_version" integer NOT NULL,
	"rate_version" integer,
	"fetched_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_price_snapshots_identity_version_pk" PRIMARY KEY("provider","model","capability","snapshot_version"),
	CONSTRAINT "gateway_price_snapshots_capability_allowed" CHECK ("gateway_price_snapshots"."capability" IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'realtime', 'video', 'unknown')),
	CONSTRAINT "gateway_price_snapshots_version_positive" CHECK ("gateway_price_snapshots"."snapshot_version" >= 1),
	CONSTRAINT "gateway_price_snapshots_rate_version_nonnegative" CHECK ("gateway_price_snapshots"."rate_version" IS NULL OR "gateway_price_snapshots"."rate_version" >= 0),
	CONSTRAINT "gateway_price_snapshots_dims_valid" CHECK (valid_gateway_price_dims("gateway_price_snapshots"."dims"))
);
--> statement-breakpoint
-- THE PRICE HISTORY IS APPEND-ONLY, AND THIS IS WHAT MAKES THAT TRUE. A request locks
-- `(ref, snapshot_version)`; a history anybody can rewrite after the fact would let admission
-- and settlement disagree about what a request cost. Enforced in the database rather than the
-- application, because the application is not the only thing that can reach this table — the
-- same reasoning migrations 0128 and 0129 recorded for the rate history and the fetch log.
CREATE OR REPLACE FUNCTION prevent_gateway_price_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Gateway price snapshots are append-only';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS gateway_price_snapshots_append_only ON gateway_price_snapshots;
CREATE TRIGGER gateway_price_snapshots_append_only
BEFORE UPDATE OR DELETE ON gateway_price_snapshots
FOR EACH ROW
EXECUTE FUNCTION prevent_gateway_price_snapshot_mutation();
--> statement-breakpoint
-- A row-level trigger cannot see TRUNCATE: migration 0012 caught the audit trail being emptied
-- by exactly that statement while every UPDATE and DELETE was refused. The statement trigger
-- closes it from day one here.
DROP TRIGGER IF EXISTS gateway_price_snapshots_no_truncate ON gateway_price_snapshots;
CREATE TRIGGER gateway_price_snapshots_no_truncate
BEFORE TRUNCATE ON gateway_price_snapshots
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_gateway_price_snapshot_mutation();
