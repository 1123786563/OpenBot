import { createHash } from "node:crypto";
import { getLogger } from "../../../shared/logger";
import type { OpenMuseCalendarClient } from "../openmuse-calendar/client";
import type { OpenMuseGoogleOAuth } from "../openmuse-connectors/google-oauth";
import { OpenMuseVendorUnavailableError } from "../openmuse-connectors/google-oauth";
import {
  envelopeFieldOf,
  type ReviewedActionExecution,
  type ReviewedActionExecutor,
  settleDialFailure,
  vendorDetailOf,
} from "./executor";
import {
  canonicalJson,
  type ReviewedActionProposal,
  reviewedActionPayloadSchemas,
} from "./proposal";
import { type ClaimGuardedExecutor, ReviewedActionStaleError } from "./service";

const log = getLogger("server");

/**
 * The R05 Calendar create executor: the §6 provider attempt behind the seam
 * R01 proved with a fake and R02 first made real for mail. It dials the SAME
 * OpenConnector transport the Calendar reads use — the client's one generic
 * `callAction`, `POST /v1/actions/<actionId>` with `{ input }` in the owner's
 * googlecalendar connection via the `x-oo-connector-alias` header — and
 * answers the claim with R02's outcome mapping:
 *
 * - provider success → `succeeded` with providerRef = the provider event id;
 * - definite provider rejection (an HTTP 4xx answer, the create never
 *   happened) → `failed` with the vendor's detail;
 * - timeout (the executor's own create deadline), connection loss, or any
 *   answer this deployment cannot read after the request left →
 *   `outcome_unknown`; R04's reconciliation owns that tail, and nothing here
 *   ever retries.
 *
 * THE ACTION ID IS A PLACEHOLDER, A01's discipline: this repository pins no
 * gcalendar action ids, so `gcalendar.create` stands in as a documented name
 * and the live id is verified against the vendor's catalogue at O02
 * deployment (S20 records the live create/deny receipts).
 *
 * The pre-claim check (`preflight`) is what the service runs BEFORE the
 * atomic claim: a disconnected googlecalendar seat answers G01's stable 409
 * there (a Gmail grant never satisfies it, G03), and a proposal whose
 * accountEmail/connectionGeneration no longer match the connection row
 * answers 409/stale — both with the row still `awaiting_review` and zero
 * provider dials.
 */
export const GCAL_CREATE_ACTION_ID = "gcalendar.create";

/*
 * Round 6 (M40): the VENDOR CATALOGUE id this deployment dials — env
 * overridable (calendar's own client pattern), while the §6 KIND above
 * stays the API contract.
 */
export const GCAL_CREATE_DIAL_ACTION_ID =
  process.env.OPENCONNECTOR_GCAL_CREATE_ACTION_ID ?? GCAL_CREATE_ACTION_ID;

/**
 * R04's send deadline, carried over to the create: thirty seconds. A dial
 * that neither answers nor throws by then is the ambiguous case — the
 * request left, and whether the provider accepted it is unknown — so the
 * executor abandons its wait and settles outcome_unknown; a late answer is
 * ignored.
 */
const DEFAULT_CREATE_TIMEOUT_MS = 30_000;

export function createCalendarCreateExecutor(deps: {
  /**
   * A01's Calendar client — the vendor dial; absent when the deployment
   * cannot reach OpenConnector, which preflight answers 503 for (the seam's
   * own rule: a boot must not die over a connector, but neither must it
   * pretend to reach one).
   */
  client?: OpenMuseCalendarClient;
  /** G01's guard: the owner's connected googlecalendar seat, or the 409. */
  requireConnection: OpenMuseGoogleOAuth["requireConnection"];
  /** R04: the create deadline; overridable so tests can shrink it. */
  timeoutMs?: number;
}): ClaimGuardedExecutor {
  const { requireConnection } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS;

  /**
   * The §6 request fingerprint: action id + seat + canonical input, the
   * seat the proposal's accountEmail on EVERY path (the same single
   * identifier the other executors fingerprint).
   */
  const fingerprintOf = (proposal: ReviewedActionProposal): string =>
    createHash("sha256")
      .update(
        `${GCAL_CREATE_ACTION_ID}:${proposal.accountEmail}:${canonicalJson(proposal.payload)}`,
        "utf8",
      )
      .digest("hex");

  const vendorDetail = (body: unknown, status: number | null): string =>
    vendorDetailOf(body, status, "Calendar", "create");

  /** The provider event id out of the runtime's `{ data: ... }` envelope. */
  const providerEventId = (body: unknown): string | null =>
    envelopeFieldOf(body, "id");

  const executor: ReviewedActionExecutor = {
    async execute(
      proposal: ReviewedActionProposal,
    ): Promise<ReviewedActionExecution> {
      if (proposal.kind !== GCAL_CREATE_ACTION_ID) {
        return {
          outcome: "failed",
          error: `This deployment's reviewed action executor creates ${GCAL_CREATE_ACTION_ID} events only; ${proposal.kind} is not executable here.`,
          fingerprint: fingerprintOf(proposal),
        };
      }
      // The input re-parsed from the stored payload: the dial carries exactly
      // the validated fields, whatever a malformed row might have smuggled in.
      const parsed = reviewedActionPayloadSchemas[
        GCAL_CREATE_ACTION_ID
      ].safeParse(proposal.payload);
      if (!parsed.success) {
        return {
          outcome: "failed",
          error:
            "The stored proposal's payload is not a creatable Calendar event.",
          fingerprint: fingerprintOf(proposal),
        };
      }
      const client = deps.client;
      if (client === undefined) {
        return {
          outcome: "failed",
          error: new OpenMuseVendorUnavailableError().message,
          fingerprint: fingerprintOf(proposal),
        };
      }
      let deadline: ReturnType<typeof setTimeout> | undefined;
      // M39: whether the dial promise ever existed.
      let dialStarted = false;
      try {
        const connection = await requireConnection(
          proposal.ownerUserId,
          "googlecalendar",
        );
        // Post-claim drift: preflight cleared this a moment ago; if the seat
        // moved between check and claim anyway, nothing left — definite.
        if (
          connection.accountEmail !== proposal.accountEmail ||
          connection.generation !== proposal.connectionGeneration
        ) {
          return {
            outcome: "failed",
            error:
              "The Calendar account this proposal was bound to changed before the create.",
            fingerprint: fingerprintOf(proposal),
          };
        }
        const fingerprint = fingerprintOf(proposal);
        // R04: from here the request may have left, so the wait itself is
        // bounded — the deadline rejects and the catch below settles
        // outcome_unknown. The race abandons the WAIT, not the request.
        const expired = new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () =>
              reject(new Error("the create deadline passed with no answer")),
            timeoutMs,
          );
        });
        const dialled = client.callAction(
          connection.alias,
          GCAL_CREATE_DIAL_ACTION_ID,
          parsed.data,
        );
        dialStarted = true;
        // A late refusal after the deadline already settled must not crash
        // the loop; the race still surfaces a prompt one.
        dialled.catch(() => {});
        const answer = await Promise.race([dialled, expired]);
        if (!answer.ok) {
          const detail = vendorDetail(answer.body, answer.status);
          log.warn(
            {
              type: "openmuse-gcalendar-create-vendor-failed",
              actionId: proposal.id,
              status: answer.status,
            },
            "openmuse-gcalendar-create-vendor-failed",
          );
          // An HTTP 4xx is the provider refusing the create — it never
          // happened. Anything else (5xx, no status) may have been accepted
          // internally.
          if (
            answer.status !== null &&
            answer.status >= 400 &&
            answer.status < 500
          ) {
            return { outcome: "failed", error: detail, fingerprint };
          }
          return { outcome: "outcome_unknown", error: detail, fingerprint };
        }
        const id = providerEventId(answer.body);
        if (id === null) {
          log.warn(
            {
              type: "openmuse-gcalendar-create-answer-unreadable",
              actionId: proposal.id,
            },
            "openmuse-gcalendar-create-answer-unreadable",
          );
          return {
            outcome: "outcome_unknown",
            error:
              "The Calendar service's create answer carried no event id this deployment could read.",
            fingerprint,
          };
        }
        return { outcome: "succeeded", providerRef: id, fingerprint };
      } catch (error) {
        // M41: the shared catch tail (executor.ts).
        return settleDialFailure({
          error,
          proposalId: proposal.id,
          fingerprint: fingerprintOf(proposal),
          ambiguousLog: "openmuse-gcalendar-create-ambiguous",
          ambiguousError:
            "The Calendar service did not answer this create; whether it was created is unknown.",
          dialStarted,
        });
      } finally {
        if (deadline !== undefined) clearTimeout(deadline);
      }
    },
  };

  return {
    ...executor,
    async preflight(proposal: ReviewedActionProposal) {
      // Only a gcalendar.create has a Calendar seat to guard; other kinds
      // settle in execute with the executor's own refusal. Each drift names
      // its binding (R03's staleReason) so the client knows what changed.
      if (proposal.kind !== GCAL_CREATE_ACTION_ID) return;
      const connection = await requireConnection(
        proposal.ownerUserId,
        "googlecalendar",
      );
      if (connection.accountEmail !== proposal.accountEmail) {
        throw new ReviewedActionStaleError("account");
      }
      if (connection.generation !== proposal.connectionGeneration) {
        throw new ReviewedActionStaleError("generation");
      }
      if (deps.client === undefined) {
        throw new OpenMuseVendorUnavailableError();
      }
    },
  };
}
