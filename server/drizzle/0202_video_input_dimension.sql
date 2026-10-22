-- Bifrost 19.3 (#339): the input-video second joins the closed price-dimension vocabulary
-- as its own member — the slot an edit/variant's INPUT side prices on.
--
-- WHY ITS OWN DIMENSION, AND NOT A SECOND RATE ON `video`. A video edit or variant bills
-- two sides: the output clips (seconds × count, at the output tier's per-second rate —
-- `video`, 19.1's own mapping) and, WHEN THE UPSTREAM CHARGES FOR THEM, the input videos
-- it reads (per input second). Two facts about the input side make a shared slot
-- unworkable and a dedicated member the only honest shape:
--
-- 1. "Input is free" must be recordable AS EVIDENCE. Providers differ on whether an edit
--    bills its inputs, and the ticket's own rule is 上游不收输入费用时记为明确 free 并留
--    证据；留空判 unknown. On a shared `video` slot a known "0" would price every OUTPUT
--    second free too — an under-bill strict billing may never produce. A dedicated
--    `video_input` records known "0" as the input side's explicit price with the snapshot
--    field as its evidence, exactly the free/unknown distinction 03.3's classification
--    exists to carry.
-- 2. "Input pricing is missing" must be nameable. 缺输入定价时标记 unknown 并拒绝 — the
--    refusal has to point at the input side specifically (19.2's availability surface and
--    the submit gate name the dimension they are missing), which a shared slot cannot
--    distinguish from a missing output rate.
--
-- WHY UNKNOWN ON EVERY EXISTING BASIS. The v1 wire's Pricing struct (core/schemas/models.go
-- at the pin) carries no field for a per-input-second rate, so `video_input` arrives as
-- `not_on_wire_v1` — recorded `unknown` with `price_dim_no_source` on every snapshot,
-- never 0 — exactly the reserved dimensions' discipline (image_output, audio in/out,
-- video, the tool surcharges). Until the wire (or an administrator-priced curated cell)
-- prices input seconds, 19.3's gates refuse the edit/variant path on evidence, never on a
-- silent free pass.
--
-- WHY THE FUNCTION IS RE-SPELLED WHOLE. `valid_gateway_price_dims` states the closed
-- vocabulary twice for the database (exact key count + exact key set), so a new member
-- lands as one CREATE OR REPLACE re-spelling the full required array — never an ALTER
-- that would let two spellings coexist (0195's own rule, kept verbatim). The CHECK on
-- `gateway_price_snapshots` calls the function by name on every insert, so the new
-- vocabulary applies to the next appended version without touching the table. Snapshots
-- written before this migration keep their 14-key objects untouched (the append-only
-- triggers own that); every snapshot appended after carries all fifteen.

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
    'video_input',
    'surcharge_web_search',
    'surcharge_per_request',
    'surcharge_tool_call',
    'surcharge_a2a_call'
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
