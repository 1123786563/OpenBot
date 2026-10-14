import { createHash } from "node:crypto";
import { getLogger } from "../../../shared/logger";
import type { OpenMuseCalendarClient } from "../openmuse-calendar/client";
import type { OpenMuseGoogleOAuth } from "../openmuse-connectors/google-oauth";
import { OpenMuseVendorUnavailableError } from "../openmuse-connectors/google-oauth";
import {
  readCurrentEtag,
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
 * The R06 Calendar update executor, R05's mirror with one new §6 duty: the
 * proposal binds its target FIRST-CLASS — `targetId` is the provider event
 * id and `targetVersion` the etag the decision was made against — and a
 * CHANGED etag at decision time must answer 409/staleReason "target" with
 * ZERO provider writes and the row still `awaiting_review`.
 *
 * TASK 0 (recorded): PRE-CHECK FETCH, not trust-provider-error. §6's fixed
 * failure matrix shapes the changed-etag answer as a 409/stale, and only a
 * pre-claim check can produce that shape — a provider conflict arriving
 * after the claim can settle nothing but `failed`. So `preflight` READS the
 * event's current etag over the same `callAction` seam the write rides
 * (`gcalendar.get`, another A01 placeholder O02 verifies against the
 * vendor's catalogue) and refuses a mismatch before any claim. The write
 * dial still carries the etag in its input — the provider's own conflict
 * check is the backstop for the pre-check-to-write race, and the fake's
 * §6 contract is exactly that: etag in, conflict out. Either way ZERO
 * writes land on staleness: the pre-check is a read, and a refused update
 * never happened.
 *
 * THE ACTION IDS ARE PLACEHOLDERS, A01's discipline: this repository pins
 * no gcalendar action ids, so `gcalendar.update` and `gcalendar.get` stand
 * in as documented names verified at O02 deployment (S20/S21 record the
 * live update/stale-etag receipts).
 */
export const GCAL_UPDATE_ACTION_ID = "gcalendar.update";

/*
 * Round 6 (M40): the VENDOR CATALOGUE id this deployment dials — env
 * overridable (calendar's own client pattern), while the §6 KIND above
 * stays the API contract.
 */
export const GCAL_UPDATE_DIAL_ACTION_ID =
  process.env.OPENCONNECTOR_GCAL_UPDATE_ACTION_ID ?? GCAL_UPDATE_ACTION_ID;

/** The etag pre-check read (Task 0): another O02-verified placeholder. */
export const GCAL_GET_ACTION_ID = "gcalendar.get";

/*
 * Round 6 (M40): the etag pre-read's vendor catalogue id, env overridable
 * alongside the write ids (the read and the write are verified together at
 * O02).
 */
export const GCAL_GET_DIAL_ACTION_ID =
  process.env.OPENCONNECTOR_GCAL_GET_ACTION_ID ?? GCAL_GET_ACTION_ID;

/**
 * R04's send deadline, carried over from the create: thirty seconds. A dial
 * that neither answers nor throws by then is the ambiguous case — the
 * request left, and whether the provider accepted it is unknown — so the
 * executor abandons its wait and settles outcome_unknown; a late answer is
 * ignored. The pre-check read rides the same bound so a hung connector
 * cannot hang the decision: an etag this deployment cannot read in time is
 * not proof of staleness, and the write dial's own deadline still guards
 * the tail.
 */
const DEFAULT_UPDATE_TIMEOUT_MS = 30_000;

export function createCalendarUpdateExecutor(deps: {
  /**
   * A01's Calendar client — the vendor dial; absent when the deployment
   * cannot reach OpenConnector, which preflight answers 503 for (the seam's
   * own rule: a boot must not die over a connector, but neither must it
   * pretend to reach one).
   */
  client?: OpenMuseCalendarClient;
  /** G01's guard: the owner's connected googlecalendar seat, or the 409. */
  requireConnection: OpenMuseGoogleOAuth["requireConnection"];
  /** R04: the update deadline; overridable so tests can shrink it. */
  timeoutMs?: number;
}): ClaimGuardedExecutor {
  const { requireConnection } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;

  /**
   * The §6 request fingerprint: action id + seat + BOTH target bindings +
   * canonical input. The etag the proposal bound IS part of the provider
   * request, so two approvals of the same content against two versions are
   * two different fingerprints. The seat is the proposal's accountEmail on
   * EVERY path, the same single identifier the other executors fingerprint.
   */
  const fingerprintOf = (proposal: ReviewedActionProposal): string =>
    createHash("sha256")
      .update(
        `${GCAL_UPDATE_ACTION_ID}:${proposal.accountEmail}:${proposal.targetId}:${proposal.targetVersion}:${canonicalJson(proposal.payload)}`,
        "utf8",
      )
      .digest("hex");

  const vendorDetail = (body: unknown, status: number | null): string =>
    vendorDetailOf(body, status, "Calendar", "update");

  const executor: ReviewedActionExecutor = {
    async execute(
      proposal: ReviewedActionProposal,
    ): Promise<ReviewedActionExecution> {
      if (proposal.kind !== GCAL_UPDATE_ACTION_ID) {
        return {
          outcome: "failed",
          error: `This deployment's reviewed action executor updates ${GCAL_UPDATE_ACTION_ID} events only; ${proposal.kind} is not executable here.`,
          fingerprint: fingerprintOf(proposal),
        };
      }
      // The input re-parsed from the stored payload: the dial carries exactly
      // the validated fields, whatever a malformed row might have smuggled in.
      const parsed = reviewedActionPayloadSchemas[
        GCAL_UPDATE_ACTION_ID
      ].safeParse(proposal.payload);
      if (!parsed.success) {
        return {
          outcome: "failed",
          error:
            "The stored proposal's payload is not an updatable Calendar event.",
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
      // §6: an update binds its target first-class; a row that somehow lacks
      // the binding has nothing to update and nothing left — definite.
      if (
        proposal.targetId === null ||
        proposal.targetVersion === null ||
        proposal.targetId === "" ||
        proposal.targetVersion === ""
      ) {
        return {
          outcome: "failed",
          error:
            "The stored proposal binds no Calendar event id and etag to update.",
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
              "The Calendar account this proposal was bound to changed before the update.",
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
              reject(new Error("the update deadline passed with no answer")),
            timeoutMs,
          );
        });
        // The §6 fake's contract — etag in: the provider conflict-checks the
        // update against the bound version, the backstop for the pre-check
        // read's race window (a conflict answer is a definite 4xx refusal).
        // The strict schema above already proved the fields, so the record
        // narrowing carries exactly them into the dial.
        const fields = parsed.data as Record<string, unknown>;
        const dialled = client.callAction(
          connection.alias,
          GCAL_UPDATE_DIAL_ACTION_ID,
          {
            id: proposal.targetId,
            etag: proposal.targetVersion,
            ...fields,
          },
        );
        // A late refusal after the deadline already settled must not crash
        // the loop; the race still surfaces a prompt one.
        dialStarted = true;
        dialled.catch(() => {});
        const answer = await Promise.race([dialled, expired]);
        if (!answer.ok) {
          const detail = vendorDetail(answer.body, answer.status);
          log.warn(
            {
              type: "openmuse-gcalendar-update-vendor-failed",
              actionId: proposal.id,
              status: answer.status,
            },
            "openmuse-gcalendar-update-vendor-failed",
          );
          // An HTTP 4xx is the provider refusing the update — it never
          // happened, target included. Anything else (5xx, no status) may
          // have been accepted internally.
          if (
            answer.status !== null &&
            answer.status >= 400 &&
            answer.status < 500
          ) {
            return { outcome: "failed", error: detail, fingerprint };
          }
          return { outcome: "outcome_unknown", error: detail, fingerprint };
        }
        // A 2xx means the update landed; the event it landed on is the one
        // the proposal bound, so that id is the receipt's providerRef — an
        // update's success is not made uncertain by an unreadable echo the
        // way R05's create answer is.
        return {
          outcome: "succeeded",
          providerRef: proposal.targetId,
          fingerprint,
        };
      } catch (error) {
        // M41: the shared catch tail (executor.ts).
        return settleDialFailure({
          error,
          proposalId: proposal.id,
          fingerprint: fingerprintOf(proposal),
          ambiguousLog: "openmuse-gcalendar-update-ambiguous",
          ambiguousError:
            "The Calendar service did not answer this update; whether it was applied is unknown.",
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
      // Only a gcalendar.update has a Calendar target to guard; other kinds
      // settle in execute with the executor's own refusal. Each drift names
      // its binding (R03's staleReason) so the client knows what changed.
      if (proposal.kind !== GCAL_UPDATE_ACTION_ID) return;
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
      const client = deps.client;
      if (client === undefined) {
        throw new OpenMuseVendorUnavailableError();
      }
      // Task 0's pre-check fetch (recorded above): the §6 etag read. A row
      // without its binding reaches execute, which refuses it definitively.
      if (
        proposal.targetId === null ||
        proposal.targetVersion === null ||
        proposal.targetId === "" ||
        proposal.targetVersion === ""
      ) {
        return;
      }
      // The shared pre-read: bounded, and a late, unreadable OR REJECTED
      // answer proves nothing — the write dial's own etag backstop owns the
      // tail (a rejected race promise must not 503 the approval).
      const etag = await readCurrentEtag({
        client,
        alias: connection.alias,
        actionId: GCAL_GET_DIAL_ACTION_ID,
        targetId: proposal.targetId,
        timeoutMs,
      });
      if (etag === null) return;
      if (etag !== proposal.targetVersion) {
        throw new ReviewedActionStaleError("target");
      }
    },
  };
}
