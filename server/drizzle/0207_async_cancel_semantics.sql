-- Bifrost 17.7 (#331): the async job's cancellation record — one row per job, the
-- provider's own cancel conclusion, the evidence an evidenced release stands on, and the
-- money reaction that conclusion produced.
--
-- A CANCEL REQUEST IS NOT A NO-CHARGE PROOF. The provider's acknowledgement that it
-- cancelled the job says nothing about billing unless it ALSO confirms nothing ran;
-- "取消已接受" is not "未产生费用". The only cancel that releases is the one carrying the
-- provider's own unbilled confirmation — mapped onto the Release protocol's `no_usage`
-- evidence kind (the provider reported the job's finish with zero usage), with the
-- cancellation receipt as the reference. Every other conclusion keeps the money exactly
-- where it was: `unsupported` and `failed` leave the hold held, and a cancel whose RESULT
-- is unknown moves the hold to 06.8's unknown — full capacity still occupied, recovery's
-- to dispose. Key expiry and client departure never appear in this table's vocabulary
-- because neither is a conclusion about the job at all.
--
-- THE JOB ID IS THE ROW'S IDENTITY; THE REQUEST KEY ANSWERS REPLAYS. One row per job,
-- ever: a repeated cancel of the same request key replays the recorded conclusion without
-- touching the provider again, and a NEW key (a genuine retry) asks the provider once
-- more and moves the row to the newer conclusion — `released_on_evidence` is terminal
-- (a second release cannot exist), every other conclusion may be superseded by a later,
-- evidenced one. The requests counter makes the retry storm visible as a count.
--
-- NO MONEY MOVES HERE. released_credits records what the Release protocol handed back
-- (the hold's whole ceiling, applied 0) so the trail reads without joining; the ledger
-- and the reservation row remain the only money truth.

CREATE TABLE "async_job_cancellations" (
  "job_id" text PRIMARY KEY REFERENCES "async_jobs"("job_id"),
  "last_request_key" text NOT NULL,
  "provider_cancel_result" text NOT NULL,
  "evidence_kind" text,
  "evidence_reference" text,
  "conclusion" text NOT NULL,
  "released_credits" integer,
  "requests" integer NOT NULL DEFAULT 1,
  "first_requested_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "async_job_cancel_result_check" CHECK ("async_job_cancellations"."provider_cancel_result" IN ('succeeded_unbilled_evidenced', 'succeeded_no_evidence', 'unsupported', 'failed', 'result_unknown')),
  CONSTRAINT "async_job_cancel_evidence_shape_check" CHECK (
    ("async_job_cancellations"."provider_cancel_result" = 'succeeded_unbilled_evidenced'
      AND "async_job_cancellations"."evidence_kind" IS NOT NULL
      AND "async_job_cancellations"."evidence_reference" IS NOT NULL)
    OR ("async_job_cancellations"."provider_cancel_result" <> 'succeeded_unbilled_evidenced'
      AND "async_job_cancellations"."evidence_kind" IS NULL
      AND "async_job_cancellations"."evidence_reference" IS NULL)
  ),
  CONSTRAINT "async_job_cancel_conclusion_check" CHECK ("async_job_cancellations"."conclusion" IN ('released_on_evidence', 'hold_kept', 'hold_unknown')),
  CONSTRAINT "async_job_cancel_released_shape_check" CHECK (
    ("async_job_cancellations"."conclusion" = 'released_on_evidence'
      AND "async_job_cancellations"."released_credits" IS NOT NULL
      AND "async_job_cancellations"."released_credits" >= 0)
    OR ("async_job_cancellations"."conclusion" <> 'released_on_evidence'
      AND "async_job_cancellations"."released_credits" IS NULL)
  ),
  CONSTRAINT "async_job_cancel_requests_check" CHECK ("async_job_cancellations"."requests" >= 1)
);

-- The operational read: recently cancelled jobs, newest first.
CREATE INDEX "async_job_cancel_last_idx" ON "async_job_cancellations" ("last_seen_at" DESC);
