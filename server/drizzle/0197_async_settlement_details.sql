-- Bifrost 17.6 (#330): the async job's settlement line detail — the structured entry an
-- async settlement writes beside its ledger row, so a user's consumption detail shows WHAT
-- the charge was for (which job, which provider job, how many entries, which terminal
-- state, the real usage), and the charge is attributable BY TASK.
--
-- WHY ITS OWN TABLE. The image line (0179) states the image facts in its NOT NULLs and the
-- speech line (0181) the speech facts in its own — an async job's facts are neither: the
-- attribution anchor is the JOB (`job_id`, UNIQUE — the one key every surface and every
-- audit of an async charge names), the capability is the job's OWN (the closed vocabulary
-- async_jobs' CHECK owns, not a single literal), and the usage is the whole per-dimension
-- map the terminal report carried. The MONEY stays on the ledger row; this row carries the
-- line's own facts.
--
-- ONE LINE PER SETTLED RESERVATION. Written only inside the credit writer's settle
-- transaction — the ledger row, the terminal update and this detail land as ONE commit, so
-- a settled charge can never exist without the line that names its job. `ledger_id` joins
-- the consumption view to the ledger row.
--
-- THE USAGE IS THE TERMINAL REPORT'S OWN. `actual_usage` is the provider's real terminal
-- usage — one whole number per billing dimension of the closed vocabulary — stored as the
-- record it was, never an estimate and never re-derived. The price it was converted at
-- stays where the reservation locked it (snapshot_version/rate_version on the hold); the
-- settlement's numbers come from THAT basis by construction.

CREATE TABLE "credit_async_settlement_details" (
  "reservation_id" text PRIMARY KEY REFERENCES "credit_reservations"("id"),
  "ledger_id" text NOT NULL REFERENCES "credit_ledger"("id"),
  "capability" text NOT NULL,
  "job_id" text NOT NULL UNIQUE,
  "provider_job_id" text,
  "entry_count" integer NOT NULL,
  "terminal_state" text NOT NULL,
  "actual_usage" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "credit_async_settlement_details_capability_check" CHECK ("credit_async_settlement_details"."capability" IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'ocr', 'realtime', 'video', 'unknown')),
  CONSTRAINT "credit_async_settlement_details_terminal_state_check" CHECK ("credit_async_settlement_details"."terminal_state" IN ('completed', 'failed', 'cancelled')),
  CONSTRAINT "credit_async_settlement_details_entry_count_check" CHECK ("credit_async_settlement_details"."entry_count" > 0),
  CONSTRAINT "credit_async_settlement_details_usage_shape_check" CHECK (jsonb_typeof("credit_async_settlement_details"."actual_usage") = 'object')
);

CREATE INDEX "credit_async_settlement_details_ledger_idx" ON "credit_async_settlement_details" ("ledger_id");
