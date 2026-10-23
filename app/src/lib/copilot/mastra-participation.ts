import { tryClient } from "@/lib/client";

/*
 * ME16 (#488): the browser half of a Mastra frontend_tool suspension.
 *
 * The legacy engine carries a frontend tool's result back in-band — the
 * runtime relays it and the run finishes. The Mastra engine does not: the
 * run suspends on the server (a durable waiting continuation row), the
 * stream ends without a terminal, and the ONLY way the run continues is a
 * client posting the real tool result to the participation route
 * (POST /api/mastra-continuations/:id/tool-result). This module is that
 * answer: after a `useFrontendTool` handler resolves, the browser looks for
 * the waiting suspension that names this tool call and hands the result
 * over.
 *
 * Honesties this module keeps:
 *   - It never answers an `approval` kind suspension — a parked approval is
 *     the approvals decision flow's to resume, and the route itself refuses
 *     a tool result for one anyway.
 *   - A suspension that is not waiting (already answered by another device,
 *     a replay, or a decision) reads as answered — the route's own gates own
 *     identity and idempotency, and 409 is convergence, not a failure.
 *   - The waiting row is persisted as the run's stream closes, which can
 *     land a beat after a fast handler finished, so the lookup retries
 *     briefly before giving up. A lookup that finds nothing means the legacy
 *     engine ran this call in-band: there is nothing to answer.
 */

/** One waiting suspension as the list endpoint answers it. */
type WaitingSuspension = {
  continuationId: string;
  status: string;
  kind: string;
  toolCallId: string;
};

/** How long a fast handler waits for the server's suspension save to land. */
const LOOKUP_ATTEMPTS = 5;
const LOOKUP_INTERVAL_MS = 250;

async function findWaitingSuspension(
  toolCallId: string,
  signal?: AbortSignal,
): Promise<WaitingSuspension | undefined> {
  for (let attempt = 0; attempt < LOOKUP_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) return undefined;
    const response = await tryClient(
      "/api/mastra-continuations?status=waiting",
      { signal },
    );
    // A 404 is a deployment without the participation route at all — the
    // legacy engine's assembly, where every result went back in-band. One
    // look, no retries: there is nothing this call could ever find.
    if (response.status === 404) return undefined;
    const body = (await response.json().catch(() => null)) as {
      suspensions?: WaitingSuspension[];
    } | null;
    const match = body?.suspensions?.find(
      (suspension) =>
        suspension.kind === "frontend_tool" &&
        suspension.toolCallId === toolCallId,
    );
    if (match) return match;
    // Only an answered-but-empty workspace list retries: that is the save
    // race. Anything else (an error body, an unexpected shape) ends the
    // lookup here.
    if (!Array.isArray(body?.suspensions)) return undefined;
    if (attempt < LOOKUP_ATTEMPTS - 1) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, LOOKUP_INTERVAL_MS);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }
  return undefined;
}

/**
 * Answer a Mastra frontend_tool suspension with a browser tool's real
 * result.
 *
 * Resolves `true` when a waiting suspension was found and answered (or had
 * already been answered — a replay converges), `false` when no suspension
 * names this tool call, which is the legacy engine's in-band flow. A real
 * refusal (the suspension is not this caller's, or the route refused the
 * shape) throws, so a run that cannot continue is never dressed up as one
 * that did.
 */
export async function answerMastraParticipation(input: {
  toolCallId: string | undefined;
  result: unknown;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (!input.toolCallId) return false;
  const suspension = await findWaitingSuspension(
    input.toolCallId,
    input.signal,
  );
  if (!suspension) return false;
  // The status is read here rather than thrown through `client` because 409
  // is the route's "already answered" — another device or a replay got
  // there first, and the run continues all the same. Every other refusal is
  // a real one and carries the server's own code.
  const response = await tryClient(
    `/api/mastra-continuations/${encodeURIComponent(suspension.continuationId)}/tool-result`,
    {
      method: "POST",
      body: { toolCallId: input.toolCallId, result: input.result ?? null },
      signal: input.signal,
    },
  );
  if (!response.ok && response.status !== 409) {
    const body = (await response.json().catch(() => null)) as {
      error?: unknown;
      message?: unknown;
    } | null;
    const named =
      typeof body?.error === "string"
        ? body.error
        : typeof body?.message === "string"
          ? body.message
          : undefined;
    throw new Error(
      named ??
        "The Bot is waiting for this tool's result, and answering it failed.",
    );
  }
  await response.body?.cancel().catch(() => undefined);
  return true;
}
