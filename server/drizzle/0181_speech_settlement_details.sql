-- Bifrost 13.2 (#307): the speech settlement line detail — the structured entry a speech
-- settlement writes beside its ledger row, so a user's consumption detail can show WHAT was
-- spoken (the characters in, the seconds out), not only what it cost.
--
-- WHY ITS OWN TABLE AND NOT A COLUMN SET ON credit_settlement_details. That table is the
-- IMAGE line's own shape: its NOT NULLs (requested_count > 0, generated_count <= requested,
-- a single unit_price_usd) state the image facts, and a speech row would have to fake them
-- to fit — a lie in the ledger's own audit face. 0179's own rule says a new capability
-- arrives with its own migration, and the closed vocabulary stays closed on each side:
-- capability = 'speech' here, never a free-text key a reader cannot reason about.
--
-- ONE LINE PER SETTLED RESERVATION, WRITTEN WITH THE MONEY. The unique key is the
-- reservation (one settlement is one terminal fact of one hold), and the writer inserts
-- this row inside the SAME transaction as the ledger row and the reservation's terminal
-- update — the charge, the release and the line land as one commit. The MONEY stays on the
-- ledger row; this table carries the line's own facts: the actual characters and seconds
-- (13.2's 实际用量), the cap the hold was certified against (the released share is the
-- difference), and the TWO locked tier prices the settlement priced at — the per-character
-- and per-second rates, each an exact decimal string under its own shape CHECK, because a
-- speech line's unit prices are two, not one.
--
-- ACTUAL SECONDS AS AN EXACT DECIMAL STRING. The produced audio's duration arrives as a
-- provider usage figure or the artifact container's own statement, and either can be
-- fractional; the settlement prices it in exact rationals, so the line stores the exact
-- decimal it priced (the same shape rule as every price column), never a float that has
-- already been through binary rounding.

CREATE TABLE "credit_speech_settlement_details" (
  "reservation_id" text PRIMARY KEY REFERENCES "credit_reservations"("id"),
  "ledger_id" text NOT NULL REFERENCES "credit_ledger"("id"),
  "capability" text NOT NULL,
  "input_characters" integer NOT NULL,
  "capped_seconds" integer NOT NULL,
  "actual_seconds" text NOT NULL,
  "per_input_character_usd" text NOT NULL,
  "per_output_second_usd" text NOT NULL,
  "voice_tier" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "credit_speech_settlement_details_capability_check" CHECK ("credit_speech_settlement_details"."capability" = 'speech'),
  CONSTRAINT "credit_speech_settlement_details_quantities_check" CHECK (
    "credit_speech_settlement_details"."input_characters" >= 0
    AND "credit_speech_settlement_details"."capped_seconds" > 0
  ),
  CONSTRAINT "credit_speech_settlement_details_actual_seconds_shape_check" CHECK ("credit_speech_settlement_details"."actual_seconds" ~ '^[0-9]+(\.[0-9]+)?$'),
  CONSTRAINT "credit_speech_settlement_details_per_input_character_shape_check" CHECK ("credit_speech_settlement_details"."per_input_character_usd" ~ '^[0-9]+(\.[0-9]+)?$'),
  CONSTRAINT "credit_speech_settlement_details_per_output_second_shape_check" CHECK ("credit_speech_settlement_details"."per_output_second_usd" ~ '^[0-9]+(\.[0-9]+)?$')
);

CREATE INDEX "credit_speech_settlement_details_ledger_idx" ON "credit_speech_settlement_details" ("ledger_id");
