import { eq } from "drizzle-orm";
import type { AuditStore } from "../audit";
import { DEPLOYMENT_INITIATOR, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { accessGrants } from "../db/schema";
import {
  asyncJobCancellations,
  asyncJobs,
  creditReservations,
} from "../db/schema/credit-reservations";
import { createCreditReleaseService, type CreditReleaseOutcome } from "./credit-release";
import { createCreditWriter } from "./credits-writer";
import { RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS } from "./credit-reserve";
import { findCompanyScopeIdentityField } from "./personal-key-isolation";

/*
 * The async job cancellation lane (Bifrost 17.7, #331): what a cancel request may and may
 * not do to a job's hold — asked to the PROVIDER, recorded with its conclusion, and never
 * mistaken for a no-charge proof.
 *
 * A CANCEL REQUEST IS NOT A NO-CHARGE PROOF. The provider's "cancel accepted" says the job
 * stops; it says nothing about what already ran. Only the provider's OWN unbilled
 * confirmation releases, and it releases the way the Release protocol (06.11) releases: as
 * a `no_usage` no-charge evidence — the provider reported the job's finish with zero
 * usage, the cancellation receipt as the reference. That mapping stays INSIDE 06.11's
 * closed evidence vocabulary (no new member is coined here); everything the vocabulary
 * forbids — a disconnect, a timeout, a bare cancellation — is exactly what it has always
 * forbidden, and this lane never routes them to a release.
 *
 * THE THREE MONEY REACTIONS, ONE PER CONCLUSION. `unsupported` and `failed` keep the hold
 * exactly as it was (still `reserved`, full capacity occupied) — the job may still produce
 * a billable terminal report, and 17.6's settle lane remains the one that settles it. A
 * cancel whose RESULT is unknown (the ask never answered) moves the hold to 06.8's unknown
 * with `async_cancel_result_unknown`: the provider may or may not have the job, full
 * capacity stays occupied, and recovery (08.x) is the only thing that may dispose of it —
 * a later evidenced cancel against an unknown hold still cannot release (06.11 refuses
 * `reservation_unknown`), and that refusal passes through as the conclusion `hold_unknown`.
 *
 * KEY EXPIRY AND CLIENT DEPARTURE ARE NOT CONCLUSIONS. Nothing in this lane watches a key
 * or a connection: the grant resolves the payer for OWNERSHIP the same way 17.4's read
 * does (a revoked grant still owns its job, because the job still occupies that account's
 * credit), and the handler runs to its conclusion whether or not the caller is still on
 * the line. There is no code path here that reacts to either event, on purpose — the tests
 * pin that nothing moves without a conclusion.
 *
 * THE JOB ID IS THE ROW; THE REQUEST KEY ANSWERS REPLAYS. One cancellation row per job,
 * ever (`async_job_cancellations`, 0207): a repeated request under the SAME key replays
 * the recorded conclusion without asking the provider again, and a NEW key (a genuine
 * retry) asks once more and moves the row — `released_on_evidence` is terminal, every
 * other conclusion may be superseded by a later evidenced one. The audit row lands when a
 * conclusion first arrives or changes, never twice for the same conclusion (取消动作与结论
 * 可审计, 重复通知不重复审计 — 18.4's rule).
 *
 * WHO CALLS THIS. The deployment's async supervision — the point a cancel request reaches
 * with a provider cancel client (injected: the closed outcome set below is the seam the
 * provider adapter answers). Production wires 06.11's release service and the credit
 * writer's unknown mark; both are injectable so the lane's own tests stay deterministic.
 */

/** The refusal vocabulary — the shape boundary's own closed set (17.4's discipline). */
export type AsyncCancelRefusalReasonCode = "request_invalid" | "payer_conflict";

/** One line, shown on every surface, per refusal code. */
export const ASYNC_CANCEL_REFUSAL_SENTENCES: Record<
  AsyncCancelRefusalReasonCode,
  string
> = {
  request_invalid: "The async cancel request is not a valid cancel request.",
  payer_conflict:
    "The request names a payment account; the account is resolved server-side from the scope grant and self-reported accounts are refused.",
};

/** What the provider's cancel endpoint answered — the closed outcome set, the whole seam. */
export type ProviderCancelOutcome =
  | {
      /** The provider cancelled AND confirmed nothing ran — the receipt is the evidence. */
      kind: "succeeded_unbilled_evidenced";
      /** The provider's own cancellation receipt — the verifiable trail id. */
      evidenceReference: string;
    }
  | {
      /** The provider accepted the cancel but confirmed nothing about billing. */
      kind: "succeeded_no_evidence";
    }
  | {
      /** The provider cannot cancel this kind of job at all. */
      kind: "unsupported";
    }
  | {
      /** The provider refused or errored the cancel — the job stands. */
      kind: "failed";
      detail: string;
    }
  | {
      /** The ask never answered — the job's fate at the provider is unknown. */
      kind: "result_unknown";
      detail: string;
    };

/** The row's own conclusion vocabulary — the money reaction, as 0207's CHECK owns it. */
export type AsyncCancelConclusion =
  | "released_on_evidence"
  | "hold_kept"
  | "hold_unknown";

/** What a cancel answers: the recorded or fresh conclusion, or a refusal that names why. */
export type AsyncCancelOutcome =
  | {
      status: "answered";
      /** True when this call asked the provider; false when a replay answered the record. */
      asked: boolean;
      jobId: string;
      providerCancelResult: ProviderCancelOutcome["kind"];
      conclusion: AsyncCancelConclusion;
      /** What the release handed back, when the conclusion released. */
      releasedCredits: number | null;
      /** The evidence receipt the release stood on, when it did. */
      evidenceReference: string | null;
    }
  | {
      /** The job is already terminal on the money's own terms — a cancel has nothing to do. */
      status: "nothing_to_cancel";
      /** The job when one was found; null for the uniform not-found answer. */
      jobId: string | null;
      reason: "reservation_settled" | "reservation_released" | "job_not_found";
    }
  | {
      status: "refused";
      reasonCode: AsyncCancelRefusalReasonCode;
      detail: Record<string, unknown>;
    };

export type AsyncCancelServiceDependencies = {
  database: Database;
  /**
   * The provider cancel client: asked at most once per NEW request key, never on a
   * replay. Production wires the deployment's provider adapter; tests answer the closed
   * outcome set deterministically.
   */
  cancelAtProvider: (input: {
    provider: string;
    model: string;
    providerJobId: string | null;
    submitIdempotencyKey: string;
  }) => Promise<ProviderCancelOutcome>;
  /** 06.11's release door; defaults to the real service over the same database. */
  release?: (request: {
    reservationId: string;
    reason: string;
    noChargeEvidence: { kind: "no_usage"; reference?: string };
  }) => Promise<CreditReleaseOutcome>;
  /** 06.8's unknown mark; defaults to the credit writer's own transition. */
  markUnknown?: (reservationId: string, reason: string) => Promise<void>;
  /** The audit store the cancellation trail writes to; wired in production. */
  audit?: AuditStore;
  now?: () => Date;
};

type CancelRequest = {
  grantId: string;
  cancelIdempotencyKey: string;
  jobId?: string;
  submitIdempotencyKey?: string;
  providerJobId?: string;
};

function isIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value
  );
}

/**
 * Pure shape validation, before any database contact: exactly one selector, the cancel
 * key, and the account/company-scope vocabulary refused on presence (06.4 + 09.3) — the
 * account is resolved from the grant, never named.
 */
function validateCancelRequest(input: unknown):
  | { ok: true; request: CancelRequest }
  | {
      ok: false;
      reasonCode: AsyncCancelRefusalReasonCode;
      detail: Record<string, unknown>;
    } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reasonCode: "request_invalid", detail: { field: "body" } };
  }
  const raw = input as Record<string, unknown>;

  const forbidden = new Set(
    RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS.map((key) => key.toLowerCase()),
  );
  for (const key of Object.keys(raw)) {
    if (
      forbidden.has(key.toLowerCase()) ||
      findCompanyScopeIdentityField({ [key]: true })
    ) {
      return {
        ok: false,
        reasonCode: "payer_conflict",
        detail: { stage: "request_shape", field: key },
      };
    }
  }

  if (!isIdentifier(raw.grantId, 512)) {
    return { ok: false, reasonCode: "request_invalid", detail: { field: "grantId" } };
  }
  if (!isIdentifier(raw.cancelIdempotencyKey, 512)) {
    return {
      ok: false,
      reasonCode: "request_invalid",
      detail: { field: "cancelIdempotencyKey" },
    };
  }
  const selectors = ["jobId", "submitIdempotencyKey", "providerJobId"].filter(
    (key) => raw[key] !== undefined,
  );
  if (selectors.length !== 1) {
    return {
      ok: false,
      reasonCode: "request_invalid",
      detail: {
        field: selectors.length === 0 ? "jobId" : selectors[0],
        reason: "exactly_one_of_jobId_submitIdempotencyKey_providerJobId",
      },
    };
  }
  const selector = selectors[0];
  if (!isIdentifier(raw[selector], 512)) {
    return { ok: false, reasonCode: "request_invalid", detail: { field: selector } };
  }
  return {
    ok: true,
    request: {
      grantId: raw.grantId as string,
      cancelIdempotencyKey: raw.cancelIdempotencyKey as string,
      ...(raw.jobId !== undefined ? { jobId: raw.jobId as string } : {}),
      ...(raw.submitIdempotencyKey !== undefined
        ? { submitIdempotencyKey: raw.submitIdempotencyKey as string }
        : {}),
      ...(raw.providerJobId !== undefined
        ? { providerJobId: raw.providerJobId as string }
        : {}),
    },
  };
}

export type AsyncCancelService = {
  /** Ask the provider to cancel the job and land the conclusion the evidence supports. */
  cancelJob(request: unknown): Promise<AsyncCancelOutcome>;
};

/** The money reaction a provider conclusion produces on a HELD (reserved) hold. */
function conclusionForHeld(
  outcome: ProviderCancelOutcome,
): { conclusion: AsyncCancelConclusion; evidenceReference: string | null } {
  switch (outcome.kind) {
    case "succeeded_unbilled_evidenced":
      return { conclusion: "released_on_evidence", evidenceReference: outcome.evidenceReference };
    case "succeeded_no_evidence":
    case "unsupported":
    case "failed":
      return { conclusion: "hold_kept", evidenceReference: null };
    case "result_unknown":
      return { conclusion: "hold_unknown", evidenceReference: null };
  }
}

export function createAsyncCancelService(
  dependencies: AsyncCancelServiceDependencies,
): AsyncCancelService {
  const { database } = dependencies;
  const writer = createCreditWriter(database);
  const release =
    dependencies.release ??
    ((request: Parameters<NonNullable<AsyncCancelServiceDependencies["release"]>>[0]) =>
      createCreditReleaseService({ database }).release(request));
  const markUnknown = dependencies.markUnknown ?? ((id, reason) => writer.markReservationUnknown(id, reason));
  const now = dependencies.now ?? (() => new Date());

  /** The audit row — once per landed conclusion, never twice for the same one. */
  async function auditConclusion(
    input: {
      jobId: string;
      providerJobId: string | null;
      grantId: string;
      payer: { kind: string; id: string };
    } & { providerCancelResult: string; conclusion: AsyncCancelConclusion; evidenceReference: string | null; releasedCredits: number | null },
  ): Promise<void> {
    if (dependencies.audit === undefined) return;
    try {
      await recordAuditEvent(dependencies.audit, {
        eventType: "billing.async_job_cancelled",
        targetType: "async_job",
        targetId: input.jobId,
        initiator: DEPLOYMENT_INITIATOR,
        payload: {
          jobId: input.jobId,
          providerJobId: input.providerJobId,
          grantId: input.grantId,
          payerKind: input.payer.kind,
          payerId: input.payer.id,
          providerCancelResult: input.providerCancelResult,
          conclusion: input.conclusion,
          ...(input.evidenceReference !== null
            ? { evidenceReference: input.evidenceReference }
            : {}),
          ...(input.releasedCredits !== null
            ? { releasedCredits: input.releasedCredits }
            : {}),
        },
      });
    } catch {
      // The cancellation stands on its own row; the audit layer's own failures surface
      // there — the conclusion is not un-recorded by failing to re-record it.
    }
  }

  return {
    async cancelJob(request: unknown): Promise<AsyncCancelOutcome> {
      const validated = validateCancelRequest(request);
      if (!validated.ok) {
        return {
          status: "refused",
          reasonCode: validated.reasonCode,
          detail: validated.detail,
        };
      }
      const { grantId, cancelIdempotencyKey, jobId, submitIdempotencyKey, providerJobId } =
        validated.request;

      // Scope first, exactly 17.4's read: the payer is resolved from the grant row alone,
      // and a scope that resolves nothing owns nothing. Visibility is not admission — a
      // revoked grant still owns the job it admitted, because the job still occupies that
      // account's credit; key expiry never reaches the money from here.
      const [grant] = await database
        .select({ userId: accessGrants.userId, scope: accessGrants.scope })
        .from(accessGrants)
        .where(eq(accessGrants.grantId, grantId))
        .limit(1);
      if (grant?.scope !== "model-access") {
        return { status: "nothing_to_cancel", jobId: null, reason: "job_not_found" };
      }

      const [jobRow] = await database
        .select()
        .from(asyncJobs)
        .where(
          jobId !== undefined
            ? eq(asyncJobs.jobId, jobId)
            : submitIdempotencyKey !== undefined
              ? eq(asyncJobs.submitIdempotencyKey, submitIdempotencyKey)
              : eq(asyncJobs.providerJobId, providerJobId as string),
        )
        .limit(1);
      // The ownership check the whole lane exists for: another account's job, a job that
      // does not exist, and an unresolvable scope are one same answer — never a hint.
      if (
        jobRow === undefined ||
        jobRow.payerId !== grant.userId ||
        jobRow.payerKind !== "personal"
      ) {
        return { status: "nothing_to_cancel", jobId: null, reason: "job_not_found" };
      }

      const [hold] = await database
        .select()
        .from(creditReservations)
        .where(eq(creditReservations.id, jobRow.reservationId))
        .limit(1);
      if (hold === undefined) {
        return { status: "nothing_to_cancel", jobId: jobRow.jobId, reason: "job_not_found" };
      }
      if (hold.status === "settled") {
        return {
          status: "nothing_to_cancel",
          jobId: jobRow.jobId,
          reason: "reservation_settled",
        };
      }
      if (hold.status === "released") {
        return {
          status: "nothing_to_cancel",
          jobId: jobRow.jobId,
          reason: "reservation_released",
        };
      }

      const [existing] = await database
        .select()
        .from(asyncJobCancellations)
        .where(eq(asyncJobCancellations.jobId, jobRow.jobId))
        .limit(1);

      // A release is terminal: nothing below can produce a second one, and a replay of a
      // released conclusion answers the record without asking the provider again.
      if (
        existing !== undefined &&
        (existing.lastRequestKey === cancelIdempotencyKey ||
          existing.conclusion === "released_on_evidence")
      ) {
        await database
          .update(asyncJobCancellations)
          .set({ requests: existing.requests + 1, lastSeenAt: now() })
          .where(eq(asyncJobCancellations.jobId, jobRow.jobId));
        return {
          status: "answered",
          asked: false,
          jobId: jobRow.jobId,
          providerCancelResult: existing.providerCancelResult,
          conclusion: existing.conclusion,
          releasedCredits: existing.releasedCredits,
          evidenceReference: existing.evidenceReference,
        };
      }

      // The one provider ask per new request key — the conclusion everything below stands
      // on. The caller's connection state is not an input: the ask runs to its answer.
      const providerOutcome = await dependencies.cancelAtProvider({
        provider: jobRow.provider,
        model: jobRow.model,
        providerJobId: jobRow.providerJobId,
        submitIdempotencyKey: jobRow.submitIdempotencyKey,
      });

      let conclusion: AsyncCancelConclusion;
      let evidenceReference: string | null = null;
      let releasedCredits: number | null = null;
      if (providerOutcome.kind === "succeeded_unbilled_evidenced") {
        if (hold.status === "reserved") {
          // The evidenced release, through 06.11's own door: `no_usage` — the provider
          // reported the job's finish with zero usage — with the receipt as reference.
          const released = await release({
            reservationId: jobRow.reservationId,
            reason: `async cancel: provider confirmed nothing ran (${providerOutcome.evidenceReference})`,
            noChargeEvidence: {
              kind: "no_usage",
              reference: providerOutcome.evidenceReference,
            },
          });
          if (released.status === "released") {
            conclusion = "released_on_evidence";
            evidenceReference = providerOutcome.evidenceReference;
            releasedCredits = released.releasedCredits;
          } else {
            // 06.11 refused (e.g. the hold moved to unknown since the read): the money
            // stays where its own state machine put it, and the refusal is the conclusion
            // — never a second door invented to force the release.
            conclusion = "hold_unknown";
          }
        } else {
          // An evidenced cancel against an ALREADY-unknown hold: 06.11's own rule stands
          // (an unknown hold is recovery's to dispose, 08.9) — the evidence is recorded,
          // the release is not forced.
          conclusion = "hold_unknown";
          evidenceReference = providerOutcome.evidenceReference;
        }
      } else {
        const derived = conclusionForHeld(providerOutcome);
        conclusion = derived.conclusion;
        if (providerOutcome.kind === "result_unknown" && hold.status === "reserved") {
          // The ask never answered: the job's fate at the provider is unknown, and the
          // hold says so — full capacity still occupied (06.8), recovery's to dispose.
          await markUnknown(jobRow.reservationId, "async_cancel_result_unknown");
        }
      }

      const row = {
        jobId: jobRow.jobId,
        lastRequestKey: cancelIdempotencyKey,
        providerCancelResult: providerOutcome.kind,
        evidenceKind:
          providerOutcome.kind === "succeeded_unbilled_evidenced"
            ? ("no_usage" as const)
            : null,
        evidenceReference:
          providerOutcome.kind === "succeeded_unbilled_evidenced"
            ? providerOutcome.evidenceReference
            : null,
        conclusion,
        releasedCredits,
        ...(existing === undefined
          ? { requests: 1, firstRequestedAt: now(), lastSeenAt: now() }
          : { requests: existing.requests + 1, lastSeenAt: now() }),
      };
      await database
        .insert(asyncJobCancellations)
        .values(row)
        .onConflictDoUpdate({
          target: asyncJobCancellations.jobId,
          set: {
            lastRequestKey: row.lastRequestKey,
            providerCancelResult: row.providerCancelResult,
            evidenceKind: row.evidenceKind,
            evidenceReference: row.evidenceReference,
            conclusion: row.conclusion,
            releasedCredits: row.releasedCredits,
            requests: row.requests,
            lastSeenAt: row.lastSeenAt,
          },
        });

      const conclusionChanged =
        existing === undefined || existing.conclusion !== conclusion;
      if (conclusionChanged) {
        await auditConclusion({
          jobId: jobRow.jobId,
          providerJobId: jobRow.providerJobId,
          grantId: jobRow.grantId,
          payer: { kind: jobRow.payerKind, id: jobRow.payerId },
          providerCancelResult: providerOutcome.kind,
          conclusion,
          evidenceReference,
          releasedCredits,
        });
      }

      return {
        status: "answered",
        asked: true,
        jobId: jobRow.jobId,
        providerCancelResult: providerOutcome.kind,
        conclusion,
        releasedCredits,
        evidenceReference,
      };
    },
  };
}
