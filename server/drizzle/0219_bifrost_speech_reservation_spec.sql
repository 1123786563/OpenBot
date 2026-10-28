-- Bifrost 13.2 (#307): the reservation's frozen speech spec. 13.1's admission certified
-- quantities (characters in, voice tier, duration cap) and two tier prices; the hold kept
-- only the ceiling and the pricing-basis lock, so settlement had nothing to corroborate
-- the character side against — the settle surface could carry any characters and any
-- per-character price and be billed as-is. These columns freeze the certified spec WITH
-- the lock; all-or-nothing (keyed on spec_input_characters; spec_voice_tier may be null
-- AS A VALUE), shapes checked where present, mirroring the drizzle schema's
-- credit_reservations_speech_spec_check.
ALTER TABLE "credit_reservations" ADD COLUMN "spec_input_characters" integer;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD COLUMN "spec_voice_tier" text;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD COLUMN "spec_duration_cap_seconds" integer;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD COLUMN "spec_per_input_character_usd" text;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD COLUMN "spec_per_output_second_usd" text;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_speech_spec_check" CHECK (("spec_input_characters" IS NULL) = ("spec_duration_cap_seconds" IS NULL) AND ("spec_input_characters" IS NULL) = ("spec_per_input_character_usd" IS NULL) AND ("spec_input_characters" IS NULL) = ("spec_per_output_second_usd" IS NULL) AND ("spec_input_characters" IS NULL OR ("spec_input_characters" >= 0 AND "spec_duration_cap_seconds" >= 1 AND "spec_per_input_character_usd" ~ '^[0-9]+(\.[0-9]+)?$' AND "spec_per_output_second_usd" ~ '^[0-9]+(\.[0-9]+)?$')));
