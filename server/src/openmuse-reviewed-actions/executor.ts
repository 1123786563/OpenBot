import { createHash } from "node:crypto";
import { getLogger } from "../../../shared/logger";
import type { OpenMuseCalendarClient } from "../openmuse-calendar/client";
import { OpenMuseConnectionRefusedError } from "../openmuse-connectors/google-oauth";
import { canonicalJson, type ReviewedActionProposal } from "./proposal";

const log = getLogger("server");


/**
 * The executor seam (§6 provider attempt). R01 shipped a FAKE that touched no
 * vendor to prove the claim/receipt contract; R02 replaced it at the call
 * site with the Gmail provider executor (`gmail-send-executor.ts`), whose
 * pre-claim guard the service runs before the atomic claim. The interface and
 * the store's attempt bookkeeping stayed exactly as they are; the fake stays
 * as the seam's reference implementation.
 */

export type ReviewedActionOutcome = "succeeded" | "failed" | "outcome_unknown";

/** What one claimed proposal's execution answers. */
export type ReviewedActionExecution = {
  outcome: ReviewedActionOutcome;
  /** The provider message/event id when one is known (§6 receipt). */
  providerRef?: string;
  /** The provider request fingerprint, stored on the attempt (§6). */
  fingerprint: string;
  /** Definite-rejection detail; the receipt surfaces it with a `failed` status. */
  error?: string;
};

export type ReviewedActionExecutor = {
  execute(proposal: ReviewedActionProposal): Promise<ReviewedActionExecution>;
};

/**
 * Round 6 (M39+M41): the catch tail all four executors share — one copy in
 * place of four that had to stay in lockstep. The direction it settles is
 * the whole of R02's classification:
 *
 * - a ConnectionRefused raised before the dial: the pre-claim guard's race
 *   lost, the request never left — definite;
 * - an error raised BEFORE the dial existed (the requireConnection row read,
 *   the drift check): a local failure, the request provably never left —
 *   definite, with a fixed sentence (the raw driver message stays in the
 *   log, never on the row);
 * - anything after the dial was created: the ambiguous tail, R04's to own.
 */
export async function settleDialFailure(deps: {
  error: unknown;
  proposalId: string;
  fingerprint: string;
  /** The log type this executor's ambiguity reports under. */
  ambiguousLog: string;
  /** The fixed ambiguous sentence this executor answers. */
  ambiguousError: string;
  /** Whether the dial promise existed when the error raised. */
  dialStarted: boolean;
}): Promise<ReviewedActionExecution> {
  const { error } = deps;
  if (error instanceof OpenMuseConnectionRefusedError) {
    // The pre-claim check passed a moment ago and the race lost: the
    // request never left, so this is definite.
    return { outcome: "failed", error: error.message, fingerprint: deps.fingerprint };
  }
  if (!deps.dialStarted) {
    // Before the dial existed, nothing could have left (M39): a definite
    // failure with the reason logged server-side and a fixed sentence on
    // the row — the driver's message may quote infrastructure a receipt
    // should not carry.
    log.warn(
      {
        type: deps.ambiguousLog,
        actionId: deps.proposalId,
        preDial: true,
        error: error instanceof Error ? error.message : String(error),
      },
      deps.ambiguousLog,
    );
    return {
      outcome: "failed",
      error: "The request could not be prepared; it never left this deployment.",
      fingerprint: deps.fingerprint,
    };
  }
  log.warn(
    {
      type: deps.ambiguousLog,
      actionId: deps.proposalId,
      error: error instanceof Error ? error.message : String(error),
    },
    deps.ambiguousLog,
  );
  return {
    outcome: "outcome_unknown",
    error: deps.ambiguousError,
    fingerprint: deps.fingerprint,
  };
}

/**
 * The default fake: every execution succeeds with a deterministic providerRef
 * and a fingerprint of what would have been sent. Counting and outcome
 * scripting in tests is their own closure over the same interface.
 */
export function createFakeReviewedActionExecutor(): ReviewedActionExecutor {
  return {
    execute: async (proposal) => ({
      outcome: "succeeded" as const,
      providerRef: `fake-${createHash("sha256")
        .update(proposal.id)
        .digest("hex")
        .slice(0, 12)}`,
      fingerprint: createHash("sha256")
        .update(
          `fake:${proposal.accountEmail}:${canonicalJson(proposal.payload)}`,
          "utf8",
        )
        .digest("hex"),
    }),
  };
}

/*
 * The four executors' shared scaffolding (the §6 outcome matrix's single
 * source for the pieces every dial repeats): the runtime-face envelope read,
 * the vendor failure sentence, and the bounded etag pre-read the update and
 * delete preflights share — one copy each, so a fix lands everywhere at once
 * instead of four times in step.
 */

/**
 * One field out of the runtime's `{ data: ... }` envelope: the same unwrap
 * every executor's answer read needs. A body that is not the envelope reads
 * as its own top level; a missing or empty field reads as null.
 */
export function envelopeFieldOf(body: unknown, field: string): string | null {
  const record =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : null;
  const answer =
    record !== null &&
    "data" in record &&
    record.data !== null &&
    typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : record;
  const value = answer === null ? undefined : answer[field];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The vendor's failure detail: its own message when it sent a readable one,
 * otherwise the fixed sentence naming the service and the noun of the dial
 * that failed (`"send"`, `"update"`, …) — the exact sentences the four
 * executors each used to spell on their own.
 */
export function vendorDetailOf(
  body: unknown,
  status: number | null,
  service: string,
  noun: string,
): string {
  const record =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : null;
  if (typeof record?.message === "string" && record.message !== "") {
    return record.message;
  }
  return `The ${service} service answered this deployment's ${noun} with a failure (${status ?? "an unreadable status"}).`;
}

/**
 * The §6 etag pre-read the update and delete preflights share: bounded like
 * the write, and a transport failure reads the same as a late or unreadable
 * answer — null, proving nothing, leaving the write dial's own etag conflict
 * check to own the tail. The race consumes an ALREADY-CAUGHT promise, so a
 * dial that rejects outright (bare-fetch transport semantics) falls through
 * to that backstop instead of hard-refusing the approval with a 503.
 */
export async function readCurrentEtag(deps: {
  client: Pick<OpenMuseCalendarClient, "callAction">;
  alias: string;
  actionId: string;
  targetId: string;
  timeoutMs: number;
}): Promise<string | null> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<null>((resolve) => {
      deadline = setTimeout(() => resolve(null), deps.timeoutMs);
    });
    const dialled = deps.client.callAction(deps.alias, deps.actionId, {
      id: deps.targetId,
    });
    const answer = await Promise.race([dialled.catch(() => null), late]);
    if (answer === null || !answer.ok) return null;
    return envelopeFieldOf(answer.body, "etag");
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}
