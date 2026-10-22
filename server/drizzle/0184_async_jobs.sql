-- Bifrost 17.2 (#326): the async job's own durable record — the submit-path identity the
-- idempotency key converges on, with the attribution facts fixed at creation.
--
-- WHAT THE TABLE IS. One row per accepted async submit: the local job identity, the
-- submit's stable idempotency key (UNIQUE — a replayed submit lands on this row and never
-- creates a second job or a second reservation), the grant/payer/model/versions the job
-- was born under (17.1's fixed-attribution face, built here because 17.1's own record is
-- still open — the columns are exactly its contract's members, so the dedicated ticket
-- adopts this row rather than growing a second one), and the full-cap reservation the
-- submit holds (17.2's own subject: the hold covering the worst-case cost of ALL entries
-- exists BEFORE any provider dispatch).
--
-- WHY provider_job_id IS NULLABLE. The provider's answer can be lost between dispatch and
-- this write (17.3's subject): the mapping is two-directional with the local side as the
-- anchor, and "not yet known" is a state the row must be able to hold while the
-- reservation stays occupied — a missing provider id is never evidence of no cost.
--
-- WHY NO TERMINAL STATES HERE. Settled/released live on the reservation (06.x owns the
-- money); this row's state names the DISPATCH's own outcome only: `submitted` (the
-- provider answered with a job id) or `dispatch_unconfirmed` (dispatch failed or its
-- answer was lost — the hold stays, 17.3/08.x own what happens next). The CHECK keeps the
-- pair honest: a `submitted` row without a provider job id, or an unconfirmed row holding
-- one, is a half-fact the database refuses.

CREATE TABLE "async_jobs" (
  "job_id" text PRIMARY KEY,
  "submit_idempotency_key" text NOT NULL,
  "grant_id" text NOT NULL REFERENCES "access_grants"("grant_id"),
  "payer_kind" text NOT NULL,
  "payer_id" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "capability" text NOT NULL,
  "snapshot_version" integer NOT NULL,
  "rate_version" integer NOT NULL,
  "provider_job_id" text,
  "reservation_id" text NOT NULL REFERENCES "credit_reservations"("id"),
  "maximum_credits" integer NOT NULL,
  "entry_count" integer NOT NULL,
  "state" text NOT NULL DEFAULT 'submitted',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "dispatched_at" timestamp with time zone,
  CONSTRAINT "async_jobs_submit_idempotency_key_unique_idx" UNIQUE ("submit_idempotency_key"),
  CONSTRAINT "async_jobs_payer_kind_check" CHECK ("payer_kind" IN ('personal', 'company', 'legacy_deployment', 'unknown_owner')),
  CONSTRAINT "async_jobs_capability_check" CHECK ("capability" IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'realtime', 'video', 'unknown')),
  CONSTRAINT "async_jobs_state_check" CHECK ("state" IN ('submitted', 'dispatch_unconfirmed')),
  CONSTRAINT "async_jobs_version_check" CHECK ("snapshot_version" >= 1 AND "rate_version" >= 0),
  CONSTRAINT "async_jobs_maximum_check" CHECK ("maximum_credits" > 0),
  CONSTRAINT "async_jobs_entry_count_check" CHECK ("entry_count" > 0),
  CONSTRAINT "async_jobs_dispatch_shape_check" CHECK (("state" = 'submitted' AND "provider_job_id" IS NOT NULL AND "dispatched_at" IS NOT NULL) OR ("state" = 'dispatch_unconfirmed' AND "provider_job_id" IS NULL))
);

-- The recovery sweeps (17.3) and status reads (17.4) arrive by grant and by provider job
-- id; both get an index now so the lookup pattern the row exists for stays cheap.
CREATE INDEX "async_jobs_grant_idx" ON "async_jobs" USING btree ("grant_id", "created_at");
CREATE UNIQUE INDEX "async_jobs_provider_job_id_idx" ON "async_jobs" ("provider_job_id") WHERE "provider_job_id" IS NOT NULL;
