-- Bifrost 20.1 (#341): the tool/route surcharge dimensions join the closed price-dimension
-- vocabulary, and every real tool call gets its own billing identity row.
--
-- WHY TWO NEW DIMENSIONS, AND WHY THEY ARE UNKNOWN ON EVERY EXISTING BASIS. The vendor
-- tool families the hooks can execute are: MCP tool calls (governance PreMCPHook), the
-- tools Bifrost itself injects and executes (core/injectedtools.go), the tools a Responses
-- request declares (core/responsestools.go), and A2A agent calls (PreA2AHook). The v1 wire
-- already prices exactly one tool family — server-side web search (`pricing.web_search`,
-- the `surcharge_web_search` dimension) and one request-level flat fee (`pricing.request`,
-- `surcharge_per_request`); the Pricing struct (core/schemas/models.go at the pin) carries
-- NO field for a per-execution tool fee or an A2A call fee. So the two new members
-- (`surcharge_tool_call`, `surcharge_a2a_call`) arrive as `not_on_wire_v1` — recorded
-- `unknown` with `price_dim_no_source` on every snapshot, never 0 — exactly the reserved
-- dimensions' discipline (image_output, audio in/out, video). Unknown is the honest state:
-- until the wire (or an administrator-priced override) prices tool calls, group 20's own
-- gates refuse to enable them (Q20: 另外收费的供应商工具第一版默认禁用).
--
-- WHY THE FUNCTION IS RE-SPELLED WHOLE. `valid_gateway_price_dims` states the closed
-- vocabulary twice for the database (exact key count + exact key set), so a new member
-- lands as one CREATE OR REPLACE re-spelling the full required array — never an ALTER
-- that would let two spellings coexist. The CHECK constraint on `gateway_price_snapshots`
-- calls the function by name on every insert, so the new vocabulary applies to the next
-- appended version without touching the table. Snapshots written before this migration
-- keep their 12-key objects untouched (the append-only triggers own that); every snapshot
-- appended after carries all fourteen.
--
-- THE IDENTITY TABLE. `tool_call_charges` is one row per REAL tool call — the 07.x
-- attempt semantics applied to tool executions: an `att-` attempt id unique per call, the
-- entry it arrived through (the closed registry of tool-execution entrances), the
-- surcharge dimension it bills on, and the attribution facts frozen at creation exactly
-- like `async_jobs` freezes its own (grant, resolved payer — server-side, never the
-- request's spelling). Tool fees and model fees are distinguishable BY CONSTRUCTION here
-- and in the settlement breakdown (0189): a tool charge's dimension is always a
-- `surcharge_*` member, and the breakdown's surcharge group is where the user-facing
-- detail reads it from.
--
-- STATE SHAPES mirror the outcome discipline: `refused` rows never hold a reservation or
-- an attempt (拒绝不产生任何账务写入 — the refusal reason and the audit trail carry the
-- attempt, not a hold); `charged` rows hold the reservation the call settled against —
-- with the `att-` attempt id that reservation mints, the 07.x bijection — or carry
-- `priced_free` when the basis priced the call exactly zero (free is a price, executable
-- hold-free; a hold of zero is not a hold). One row per idempotency key: a replayed tool
-- call converges on the row its hold already minted, and the unique reservation index
-- says one hold names exactly one tool-call identity. The routing-attached embedding call
-- (routingembedcost.go) is deliberately NOT an entry here: it is a model call the router
-- makes, priced on the attached model's own token dimensions through the request's
-- reservation — enumerated in the registry module for 22.1, never minted a surcharge
-- identity row.

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
--> statement-breakpoint
CREATE TABLE "tool_call_charges" (
  "charge_id" text PRIMARY KEY,
  "idempotency_key" text NOT NULL,
  "entry" text NOT NULL,
  "tool" text NOT NULL,
  "dimension" text NOT NULL,
  "grant_id" text NOT NULL REFERENCES "access_grants"("grant_id"),
  "payer_kind" text NOT NULL,
  "payer_id" text NOT NULL,
  "state" text NOT NULL,
  "reservation_id" text REFERENCES "credit_reservations"("id"),
  "priced_free" boolean NOT NULL DEFAULT false,
  "refusal_reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "tool_call_charges_idempotency_key_unique_idx" UNIQUE ("idempotency_key"),
  CONSTRAINT "tool_call_charges_entry_check" CHECK ("entry" IN ('mcp.tool_call', 'injected.tool_call', 'injected.web_search', 'responses.tool_call', 'a2a.call')),
  CONSTRAINT "tool_call_charges_dimension_check" CHECK ("dimension" IN ('surcharge_web_search', 'surcharge_tool_call', 'surcharge_a2a_call')),
  CONSTRAINT "tool_call_charges_payer_kind_check" CHECK ("payer_kind" IN ('personal', 'company', 'legacy_deployment', 'unknown_owner')),
  CONSTRAINT "tool_call_charges_state_check" CHECK ("state" IN ('charged', 'refused')),
  CONSTRAINT "tool_call_charges_state_shape_check" CHECK (
    ("state" = 'charged' AND "refusal_reason" IS NULL AND ("reservation_id" IS NOT NULL OR "priced_free" = true)) OR
    ("state" = 'refused' AND "reservation_id" IS NULL AND "refusal_reason" IS NOT NULL AND "priced_free" = false)
  )
);
--> statement-breakpoint
CREATE INDEX "tool_call_charges_grant_idx" ON "tool_call_charges" USING btree ("grant_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_charges_reservation_idx" ON "tool_call_charges" ("reservation_id") WHERE "reservation_id" IS NOT NULL;
