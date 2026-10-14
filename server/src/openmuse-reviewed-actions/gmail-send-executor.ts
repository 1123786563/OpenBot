import { createHash } from "node:crypto";
import { getLogger } from "../../../shared/logger";
import type { OpenMuseGoogleOAuth } from "../openmuse-connectors/google-oauth";
import { OpenMuseVendorUnavailableError } from "../openmuse-connectors/google-oauth";
import type { MailWireDial } from "../openmuse-mail/client";
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
 * The R02 Gmail send executor: the §6 provider attempt behind the seam R01
 * proved with a fake. It dials the SAME OpenConnector transport the mail
 * reads use — `POST /v1/actions/<actionId>` with `{ input }` in the owner's
 * connection via the `x-oo-connector-alias` header (the alias `requireConnection`
 * returns) — and answers the claim with the §6 outcome mapping:
 *
 * - provider success → `succeeded` with providerRef = the provider message id;
 * - definite provider rejection (an HTTP 4xx answer, the send never happened)
 *   → `failed` with the vendor's detail;
 * - timeout (R04: including the executor's own send deadline), connection
 *   loss, or any answer this deployment cannot read after the request left →
 *   `outcome_unknown`; R04 owns that reconciliation, and nothing here ever
 *   retries.
 *
 * THE ACTION ID IS A PLACEHOLDER, the same discipline M01 recorded: this
 * repository pins no gmail action ids, so `gmail.send` stands in as a
 * documented name and the live id is verified against the vendor's catalogue
 * at O02 deployment.
 *
 * The pre-claim check (`preflight`) is what the service runs BEFORE the atomic
 * claim: a disconnected account answers G01's stable 409 there, and a proposal
 * whose accountEmail/connectionGeneration no longer match the connection row
 * answers 409/stale — both with the row still `awaiting_review` and zero
 * provider dials.
 */
export const GMAIL_SEND_ACTION_ID = "gmail.send";

/*
 * Round 6 (M40): the VENDOR CATALOGUE id this deployment dials — env
 * overridable, the family pattern calendar's client set first, so an O02
 * catalogue mismatch is a deployment variable, not a re-release. The §6 KIND
 * above stays the API contract (dispatch, schemas, fingerprints all key on
 * it) and never moves.
 */
export const GMAIL_SEND_DIAL_ACTION_ID =
  process.env.OPENCONNECTOR_GMAIL_SEND_ACTION_ID ?? GMAIL_SEND_ACTION_ID;

/**
 * R04's send deadline: thirty seconds, the §6 provider timeout. A dial that
 * neither answers nor throws by then is the ambiguous case par excellence —
 * the request left, and whether the provider accepted it is unknown — so the
 * executor abandons its wait and settles outcome_unknown; a late answer is
 * ignored (the dial seam carries no AbortSignal to recall the request with).
 */
const DEFAULT_SEND_TIMEOUT_MS = 30_000;

export function createGmailSendExecutor(deps: {
  /**
   * The vendor dial; absent when the deployment cannot reach OpenConnector,
   * which preflight answers 503 for (the mail seam's own rule: a boot must
   * not die over a connector, but neither must it pretend to reach one).
   */
  dial?: MailWireDial;
  /** G01's guard: the owner's connected Gmail seat, or the stable 409. */
  requireConnection: OpenMuseGoogleOAuth["requireConnection"];
  /** R04: the send deadline; overridable so tests can shrink it. */
  timeoutMs?: number;
}): ClaimGuardedExecutor {
  const { requireConnection } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;

  /**
   * The §6 request fingerprint: action id + seat + canonical input. The seat
   * is the proposal's accountEmail on EVERY path — the alias a successful
   * guard returned would fingerprint the same logical send differently than
   * the early exits, and audit comparisons key on this value.
   */
  const fingerprintOf = (proposal: ReviewedActionProposal): string =>
    createHash("sha256")
      .update(
        `${GMAIL_SEND_ACTION_ID}:${proposal.accountEmail}:${canonicalJson(proposal.payload)}`,
        "utf8",
      )
      .digest("hex");

  const vendorDetail = (body: unknown, status: number | null): string =>
    vendorDetailOf(body, status, "Gmail", "send");

  /** The provider message id out of the runtime's `{ data: ... }` envelope. */
  const providerMessageId = (body: unknown): string | null =>
    envelopeFieldOf(body, "id");

  const readBody = async (wire: { json(): Promise<unknown> }) => {
    try {
      return await wire.json();
    } catch {
      return null;
    }
  };

  const executor: ReviewedActionExecutor = {
    async execute(
      proposal: ReviewedActionProposal,
    ): Promise<ReviewedActionExecution> {
      if (proposal.kind !== GMAIL_SEND_ACTION_ID) {
        return {
          outcome: "failed",
          error: `This deployment's reviewed action executor sends ${GMAIL_SEND_ACTION_ID} messages only; ${proposal.kind} is not executable here.`,
          fingerprint: fingerprintOf(proposal),
        };
      }
      // The input re-parsed from the stored payload: the dial carries exactly
      // the validated fields, whatever a malformed row might have smuggled in.
      const parsed = reviewedActionPayloadSchemas[
        GMAIL_SEND_ACTION_ID
      ].safeParse(proposal.payload);
      if (!parsed.success) {
        return {
          outcome: "failed",
          error:
            "The stored proposal's payload is not a sendable Gmail message.",
          fingerprint: fingerprintOf(proposal),
        };
      }
      const dial = deps.dial;
      if (dial === undefined) {
        return {
          outcome: "failed",
          error: new OpenMuseVendorUnavailableError().message,
          fingerprint: fingerprintOf(proposal),
        };
      }
      let deadline: ReturnType<typeof setTimeout> | undefined;
      // M39: whether the dial promise ever existed — the catch tail's
      // direction keys on it (pre-dial errors never left).
      let dialStarted = false;
      try {
        const connection = await requireConnection(
          proposal.ownerUserId,
          "gmail",
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
              "The Gmail account this proposal was bound to changed before the send.",
            fingerprint: fingerprintOf(proposal),
          };
        }
        const fingerprint = fingerprintOf(proposal);
        // R04: from here the request may have left, so the wait itself is
        // bounded — the deadline rejects and the catch below settles
        // outcome_unknown. The race abandons the WAIT, not the request.
        const expired = new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("the send deadline passed with no answer")),
            timeoutMs,
          );
        });
        const dialled = dial(
          `/v1/actions/${encodeURIComponent(GMAIL_SEND_DIAL_ACTION_ID)}`,
          {
            method: "POST",
            headers: { "x-oo-connector-alias": connection.alias },
            body: { input: parsed.data },
          },
        );
        dialStarted = true;
        // A late refusal after the deadline already settled must not crash
        // the loop; the race still surfaces a prompt one.
        dialled.catch(() => {});
        const wire = await Promise.race([dialled, expired]);
        const body = await Promise.race([readBody(wire), expired]);
        if (!wire.ok) {
          const status = wire.status ?? null;
          const detail = vendorDetail(body, status);
          log.warn(
            {
              type: "openmuse-gmail-send-vendor-failed",
              actionId: proposal.id,
              status,
            },
            "openmuse-gmail-send-vendor-failed",
          );
          // An HTTP 4xx is the provider refusing the send — it never happened.
          // Anything else (5xx, no status) may have been accepted internally.
          if (status !== null && status >= 400 && status < 500) {
            return { outcome: "failed", error: detail, fingerprint };
          }
          return { outcome: "outcome_unknown", error: detail, fingerprint };
        }
        const id = providerMessageId(body);
        if (id === null) {
          log.warn(
            {
              type: "openmuse-gmail-send-answer-unreadable",
              actionId: proposal.id,
            },
            "openmuse-gmail-send-answer-unreadable",
          );
          return {
            outcome: "outcome_unknown",
            error:
              "The Gmail service's send answer carried no message id this deployment could read.",
            fingerprint,
          };
        }
        return { outcome: "succeeded", providerRef: id, fingerprint };
      } catch (error) {
        // M41: the shared catch tail (executor.ts) — one copy of the
        // direction logic instead of four.
        return settleDialFailure({
          error,
          proposalId: proposal.id,
          fingerprint: fingerprintOf(proposal),
          ambiguousLog: "openmuse-gmail-send-ambiguous",
          ambiguousError:
            "The Gmail service did not answer this send; whether it was sent is unknown.",
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
      // Only a gmail.send has a Gmail seat to guard; other kinds settle in
      // execute with the executor's own refusal. Each drift names its binding
      // (R03's staleReason) so the client knows what changed.
      if (proposal.kind !== GMAIL_SEND_ACTION_ID) return;
      const connection = await requireConnection(proposal.ownerUserId, "gmail");
      if (connection.accountEmail !== proposal.accountEmail) {
        throw new ReviewedActionStaleError("account");
      }
      if (connection.generation !== proposal.connectionGeneration) {
        throw new ReviewedActionStaleError("generation");
      }
      if (deps.dial === undefined) {
        throw new OpenMuseVendorUnavailableError();
      }
    },
  };
}
