-- Bifrost 17.5 (#329): the async job's settle-trigger observability row — one per job,
-- counting every trigger by its source and recording the ONE idempotency key the
-- notification and polling lanes converged on.
--
-- WHY A TABLE. Settlement itself is fenced by the reservation (06.9: one settle per
-- reservation, same actual replays the first result, a different actual is a conflict) —
-- so this row is not the fence. It is the OBSERVABILITY the ticket asks for: how many
-- times settlement was triggered, by which lane (poll or completion notification), and
-- which unified key (jobId + terminal version) the two lanes computed — so a duplicate
-- trigger is visible as a count, not discovered as a double charge.
--
-- ONE ROW PER JOB, KEYED BY THE FIRST TRIGGER. The upsert increments the counters on
-- every trigger; the idempotency_key, terminal_state and first_triggered_at are written
-- by the first trigger and never move (the key of the first report stands; a later
-- differently-keyed report is visible in the counters and refused by the settle fence,
-- never silently re-keyed here).
--
-- NO MONEY HERE. Charged/applied/released live on the reservation and the ledger; this
-- row carries no amounts on purpose — a counter row that carried money would be a second
-- ledger, and the ledger is one.

CREATE TABLE "async_settle_triggers" (
  "job_id" text PRIMARY KEY REFERENCES "async_jobs"("job_id"),
  "idempotency_key" text NOT NULL UNIQUE,
  "terminal_state" text NOT NULL,
  "total_triggers" integer NOT NULL DEFAULT 1,
  "poll_triggers" integer NOT NULL DEFAULT 0,
  "notification_triggers" integer NOT NULL DEFAULT 0,
  "first_triggered_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_triggered_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_source" text NOT NULL,
  CONSTRAINT "async_settle_triggers_terminal_state_check" CHECK ("async_settle_triggers"."terminal_state" IN ('completed', 'failed', 'cancelled')),
  CONSTRAINT "async_settle_triggers_source_check" CHECK ("async_settle_triggers"."last_source" IN ('poll', 'notification')),
  CONSTRAINT "async_settle_triggers_counts_check" CHECK (
    "async_settle_triggers"."total_triggers" >= 1
    AND "async_settle_triggers"."poll_triggers" >= 0
    AND "async_settle_triggers"."notification_triggers" >= 0
    AND "async_settle_triggers"."total_triggers" >= "async_settle_triggers"."poll_triggers" + "async_settle_triggers"."notification_triggers"
  )
);

-- The operational read: recently triggered jobs, newest first — the sweep 22.3 audits.
CREATE INDEX "async_settle_triggers_last_idx" ON "async_settle_triggers" ("last_triggered_at" DESC);
