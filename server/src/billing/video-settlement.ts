import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { accessGrants } from "../db/schema";
import { RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS } from "./credit-reserve";
import { findCompanyScopeIdentityField } from "./personal-key-isolation";
import { asyncJobs, creditReservations } from "../db/schema/credit-reservations";
import { PRICE_DIMENSIONS } from "../gateway/price-snapshot";
import type { ReservationBoundQuantities } from "./reserve-bound";
import {
  createAsyncTerminalSettleService,
  type AsyncTerminalReport,
  type AsyncTerminalSettleOutcome,
  type AsyncTerminalState,
} from "./async-terminal";

/*
 * The video settlement, recovery and artifact-query lane (Bifrost 19.4, #340 — group 19's
 * stitching point): what a video job's terminal costs, how a lost answer recovers, and
 * the read that hands artifacts back without ever moving money.
 *
 * SETTLEMENT FIRES ON THE TERMINAL LANE, AND ONLY THERE — 17.6's own rule, consumed not
 * duplicated. `submitVideoTerminal` converts the provider's terminal video report into
 * the closed vocabulary's usage map and hands it to 17.6's settle service: the
 * reservation's own fence is the exactly-once guarantee, the locked basis is the price,
 * the unused share of the hold hands back with the settle, and an over-cap terminal is
 * recorded in full with its audit row — every property this ticket's first AC names is
 * 17.6's delivered contract, so this module's whole job is the honest conversion.
 *
 * THE USAGE IS THE REPORT'S OWN NUMBERS, MERGED THE UPSTREAM WAY. A completed video
 * bills `seconds × outputCount` output seconds (the provider's terminal report says what
 * actually came back — fewer clips or a clamped duration than ordered settle at the real
 * number, and the ungenerated share of the hold releases) plus the input side the
 * SUBMISSION froze (the provider's retrieve never restates input durations; upstream's
 * own merge rule — the request is the fallback for what the response stays silent
 * about). A failed video settles at a REAL ZERO — the upstream Settler's own decision
 * (providers are explicit that an unsuccessful video is not billed), a final answer
 * about the money, never an unpriceable parked row. A completed report whose seconds or
 * clip count nobody can read is NOT a zero: the conversion refuses and the caller keeps
 * the hold in 06.8's unknown — an unverifiable outcome is not a free one (Q12).
 *
 * RECOVERY IS 17.3'S, VERBATIM. A dispatch whose answer was lost keeps the FULL cap
 * occupied and the row `dispatch_unconfirmed`; the sweep queries the provider under the
 * submit's own stable identity and attaches the provider job id it finds. This module
 * adds no recovery machinery of its own — it re-exports the lane so a video deployment
 * composes one seam, and its tests prove the composition (重启后不重复派发、不重复扣费:
 * the submit's idempotency key answers the existing job across process boundaries, and
 * the reservation fence answers every replayed terminal with the first settle's result).
 *
 * THE ARTIFACT QUERY IS A READ, PROVABLY. `createVideoArtifactQueryService` holds a
 * database and a provider artifact read — and structurally NO money seam at all: no
 * reserve, no settle, no mark, no writer (17.4's own discipline, stated in its source).
 * A repeated query therefore cannot settle anything: the answer reads the committed
 * rows verbatim and calls the provider's read-only retrieve, whose result the settle
 * lane never consults. The money view in the answer is the reservation's own state —
 * `unknown` reads as unknown, a settled hold as settled — so an owner polling a finished
 * job sees the settle the TERMINAL lane already made, never triggers one.
 */

/** The provider terminal report for one video job, as the poll or notification holds it. */
export type VideoTerminalReport =
  | {
      state: "completed";
      /** The billed duration of ONE output clip, in whole seconds, as reported. */
      seconds: number;
      /** How many clips actually came back — the report's own count, never the order's. */
      outputCount: number;
      /**
       * The input side the submission froze (19.3's own spec): the provider's terminal
       * report never restates input durations, so the caller hands the frozen Σ input
       * seconds (0 for a pure generation).
       */
      inputSeconds: number;
    }
  | { state: "failed" | "cancelled" };

/** Why a terminal report could not be converted. Closed vocabulary, displayable. */
export type VideoTerminalConversionIssue =
  | { code: "video_usage_indeterminable"; field: "seconds" | "outputCount" | "inputSeconds" };

/** The conversion's answer: the usage map, or the refusal that names the unreadable field. */
export type VideoTerminalUsage =
  | { ok: true; usage: ReservationBoundQuantities }
  | { ok: false; issue: VideoTerminalConversionIssue };

function wholeSeconds(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

/**
 * Convert one provider terminal report to the closed vocabulary's usage map — pure, so
 * the poll lane and the notification lane holding the same report compute byte-identical
 * usage and 17.6's unified key converges them on one settlement.
 *
 * A FAILED or CANCELLED video settles at a real zero (the upstream Settler's own rule);
 * a COMPLETED one bills its reported seconds × clip count on `video` and the frozen input
 * seconds on `video_input`. A completed report whose numbers nobody can read refuses —
 * never a guessed zero, never a truncation.
 */
export function videoTerminalUsageOf(report: unknown): VideoTerminalUsage {
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    return {
      ok: false,
      issue: { code: "video_usage_indeterminable", field: "seconds" },
    };
  }
  const body = report as {
    state?: unknown;
    seconds?: unknown;
    outputCount?: unknown;
    inputSeconds?: unknown;
  };
  const state = body.state as AsyncTerminalState | undefined;
  if (state !== "completed" && state !== "failed" && state !== "cancelled") {
    return {
      ok: false,
      issue: { code: "video_usage_indeterminable", field: "seconds" },
    };
  }
  const zeroed = () =>
    Object.fromEntries(
      PRICE_DIMENSIONS.map((dimension) => [dimension, 0]),
    ) as ReservationBoundQuantities;

  if (state !== "completed") {
    // A real zero, not an absent one: the whole hold settles and releases on it.
    return { ok: true, usage: zeroed() };
  }

  if (
    !wholeSeconds(body.seconds) ||
    (body.seconds as number) < 1
  ) {
    return {
      ok: false,
      issue: { code: "video_usage_indeterminable", field: "seconds" },
    };
  }
  if (
    typeof body.outputCount !== "number" ||
    !Number.isSafeInteger(body.outputCount) ||
    body.outputCount < 1
  ) {
    return {
      ok: false,
      issue: { code: "video_usage_indeterminable", field: "outputCount" },
    };
  }
  if (!wholeSeconds(body.inputSeconds)) {
    return {
      ok: false,
      issue: { code: "video_usage_indeterminable", field: "inputSeconds" },
    };
  }

  const usage = zeroed();
  return {
    ok: true,
    usage: {
      ...usage,
      video: (body.seconds as number) * (body.outputCount as number),
      video_input: body.inputSeconds as number,
    },
  };
}

export type VideoSettlementDependencies = {
  database: Database;
  /** The deployment's validated environment rate — the value lock version 0 names (06.5). */
  environmentRate?: Parameters<
    typeof createAsyncTerminalSettleService
  >[0]["environmentRate"];
};

/**
 * The video terminal lane: convert the report, then settle through 17.6's service — the
 * poll lane and the provider's completion notification both land here, and 17.6's
 * unified idempotency key + reservation fence make however-many reports settle exactly
 * once. A report that cannot be named in whole numbers refuses BEFORE any settle, which
 * leaves the hold exactly as it was (the caller's unknown lane owns it).
 */
export function createVideoSettlementService(
  dependencies: VideoSettlementDependencies,
) {
  const terminal = createAsyncTerminalSettleService({
    database: dependencies.database,
    ...(dependencies.environmentRate !== undefined
      ? { environmentRate: dependencies.environmentRate }
      : {}),
  });

  return {
    async submitVideoTerminal(input: {
      jobId?: string;
      providerJobId?: string;
      report: unknown;
      source: "poll" | "notification";
    }): Promise<
      | AsyncTerminalSettleOutcome
      | {
          status: "refused";
          reasonCode: "video_usage_indeterminable";
          detail: Record<string, unknown>;
        }
    > {
      const converted = videoTerminalUsageOf(input.report);
      if (!converted.ok) {
        return {
          status: "refused",
          reasonCode: "video_usage_indeterminable",
          detail: { field: converted.issue.field },
        };
      }
      const state = (input.report as { state: AsyncTerminalState }).state;
      const terminalReport: AsyncTerminalReport = {
        state,
        usage: converted.usage,
        evidence: { kind: "provider_usage_report" },
      };
      return terminal.settleTerminal({
        ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
        ...(input.providerJobId !== undefined
          ? { providerJobId: input.providerJobId }
          : {}),
        terminal: terminalReport,
        source: input.source,
      });
    },
  };
}

export type VideoSettlementService = ReturnType<
  typeof createVideoSettlementService
>;

/** One artifact of a completed video, as the provider's read carries it. */
export type VideoArtifact = {
  /** The artifact's own id at the provider — the stable name a client downloads by. */
  artifactId: string;
  /** The URL the artifact downloads from; expires at the provider's own pace. */
  url: string;
};

/** The provider's read-only artifact retrieval — a read, never a dispatch. */
export type VideoArtifactRetriever = (input: {
  provider: string;
  providerJobId: string;
}) => Promise<VideoArtifact[]>;

/** Why an artifact query refused. Closed vocabulary, displayable. */
export type VideoArtifactQueryRefusalReasonCode =
  | "request_invalid"
  | "payer_conflict";

/** The money view read verbatim off the reservation row — the fields an owner may see. */
export type VideoArtifactMoneyView = {
  reservationId: string;
  status: "reserved" | "unknown" | "settled" | "released";
  maximumCredits: number;
  appliedCredits: number | null;
  releasedCredits: number | null;
};

/** The artifact query's answer for a job the scope owns. */
export type VideoArtifactQueryFound = {
  status: "found";
  job: {
    jobId: string;
    providerJobId: string | null;
    state: "submitted" | "dispatch_unconfirmed";
    model: { provider: string; model: string; capability: string };
    reservation: VideoArtifactMoneyView;
  };
  /** The provider's own artifacts for the job; empty until it completed them. */
  artifacts: VideoArtifact[];
};

export type VideoArtifactQueryAnswer =
  | { kind: "answered"; outcome: VideoArtifactQueryFound | { status: "not_found" } }
  | {
      kind: "refused";
      reasonCode: VideoArtifactQueryRefusalReasonCode;
      detail: Record<string, unknown>;
    };

export type VideoArtifactQueryDependencies = {
  database: Database;
  /** The provider's read-only artifact listing; injected so tests spy it deterministically. */
  retrieve: VideoArtifactRetriever;
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
 * The artifact query service — 17.4's own discipline for the video read: shape
 * validation, the scope grant, the job row, the reservation row, then the provider's
 * read-only artifact listing. Every statement is a SELECT or a provider read; the
 * service holds no money seam at all, so a query — however many, however often — cannot
 * reserve, settle, release or dispatch (重复查询产物不重复扣费 is structural, not
 * behavioral). An account-naming field refuses on presence exactly as every door here
 * does; a foreign or missing job answers the one uniform not_found.
 */
export function createVideoArtifactQueryService(
  dependencies: VideoArtifactQueryDependencies,
) {
  const { database, retrieve } = dependencies;
  return {
    async queryArtifacts(request: unknown): Promise<VideoArtifactQueryAnswer> {
      if (request === null || typeof request !== "object" || Array.isArray(request)) {
        return {
          kind: "refused",
          reasonCode: "request_invalid",
          detail: { field: "body" },
        };
      }
      const raw = request as Record<string, unknown>;
      if (!isIdentifier(raw.grantId, 512)) {
        return {
          kind: "refused",
          reasonCode: "request_invalid",
          detail: { field: "grantId" },
        };
      }
      if (!isIdentifier(raw.jobId, 512)) {
        return {
          kind: "refused",
          reasonCode: "request_invalid",
          detail: { field: "jobId" },
        };
      }
      const accountKeys = new Set(
        RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS.map((key) => key.toLowerCase()),
      );
      for (const key of Object.keys(raw)) {
        if (
          accountKeys.has(key.toLowerCase()) ||
          findCompanyScopeIdentityField({ [key]: true })
        ) {
          return {
            kind: "refused",
            reasonCode: "payer_conflict",
            detail: { stage: "request_shape", field: key },
          };
        }
      }

      // The scope resolves the payer server-side; a scope that resolves nothing answers
      // not_found, for anything, in the one word.
      const [grant] = await database
        .select({ userId: accessGrants.userId, scope: accessGrants.scope })
        .from(accessGrants)
        .where(eq(accessGrants.grantId, raw.grantId))
        .limit(1);
      if (grant?.scope !== "model-access") {
        return { kind: "answered", outcome: { status: "not_found" } };
      }

      const [jobRow] = await database
        .select()
        .from(asyncJobs)
        .where(eq(asyncJobs.jobId, raw.jobId))
        .limit(1);
      if (
        jobRow === undefined ||
        jobRow.payerId !== grant.userId ||
        jobRow.payerKind !== "personal"
      ) {
        return { kind: "answered", outcome: { status: "not_found" } };
      }

      const [hold] = await database
        .select()
        .from(creditReservations)
        .where(eq(creditReservations.id, jobRow.reservationId))
        .limit(1);
      if (hold === undefined) {
        return { kind: "answered", outcome: { status: "not_found" } };
      }

      // The one provider touch, and it is a read: the artifacts exist only when the
      // provider completed them, and listing them bills nothing (the settle lane never
      // consults this result). A job whose dispatch never confirmed has no provider id to
      // ask about — the artifacts answer empty, the honest state.
      const artifacts: VideoArtifact[] =
        jobRow.providerJobId !== null
          ? await retrieve({
              provider: jobRow.provider,
              providerJobId: jobRow.providerJobId,
            })
          : [];

      return {
        kind: "answered",
        outcome: {
          status: "found",
          job: {
            jobId: jobRow.jobId,
            providerJobId: jobRow.providerJobId,
            state: jobRow.state,
            model: {
              provider: jobRow.provider,
              model: jobRow.model,
              capability: jobRow.capability,
            },
            reservation: {
              reservationId: hold.id,
              status: hold.status,
              maximumCredits: hold.maximum,
              appliedCredits: hold.applied,
              releasedCredits: hold.released,
            },
          },
          artifacts,
        },
      };
    },
  };
}

export type VideoArtifactQueryService = ReturnType<
  typeof createVideoArtifactQueryService
>;
