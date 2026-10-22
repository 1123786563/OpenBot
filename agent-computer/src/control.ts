import type {
  ComputerControlState,
  HandoffRequest,
  HandoffSource,
  HandoffStatus,
} from "../../shared/computer-control";
import { createActionBarrier } from "./action-barrier";
import {
  type ControlStore,
  MAX_REQUEST_URL,
  type StoredControl,
} from "./control-store";
export type ControlState = ComputerControlState;
export class ControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlError";
  }
}
export class ControlRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "ControlRequestError";
  }
}
export class SnapshotRequiredError extends Error {
  constructor() {
    super("Take a fresh browser snapshot after handback before acting.");
    this.name = "SnapshotRequiredError";
  }
}
export const NO_SECRET_PENDING = "Nothing is waiting for a secret.";
export const HELP_REQUEST_TTL_MS = 10 * 60 * 1000;
export const SECRET_REQUEST_TTL_MS = HELP_REQUEST_TTL_MS;
export const HUMAN_HAS_CONTROL =
  "A person has control or has been asked to take control. Wait for them to hand it back before acting.";
export const TAKE_CONTROL_FIRST =
  "Take control before driving the computer yourself.";
/** Input the lease has already seen: the same number is a replay, a smaller one a reorder. */
const STALE_INPUT_SEQUENCE =
  "That input was already seen, so it was not delivered.";
const BAD_INPUT_SEQUENCE =
  "An input sequence must be a whole number of at least 1.";
/** The revocation reason when the caller did not give one worth reading. */
export const CONTROL_REVOKED = "The control request was revoked.";
type Options = {
  store?: ControlStore;
  invalidateSnapshot?: () => void;
  drainTimeoutMs?: number;
};

/**
 * A page worth sending a blank browser back to: a real http(s) address, short enough to keep.
 *
 * Cloudflare's `__cf_chl_*` parameters are dropped. They are one-time tokens for the challenge that
 * was on screen, which a restart has already lost, so the page kept is the one the Bot was opening.
 */
export function pageWorthKeeping(url: unknown): string | undefined {
  if (typeof url !== "string" || url.length > MAX_REQUEST_URL) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return undefined;
    for (const name of [...parsed.searchParams.keys()])
      if (name.startsWith("__cf_chl_")) parsed.searchParams.delete(name);
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/** Request identity is durable; secret values never enter this state machine. */
export function createControl(
  now: () => string = () => new Date().toISOString(),
  options: Options = {},
) {
  const barrier = createActionBarrier();
  const restored = options.store?.load();
  const data: StoredControl = restored ?? {
    version: 1,
    holder: "bot",
    since: now(),
    resumeSnapshotRequired: false,
    recoveryRequired: false,
    requests: [],
    aliases: {},
  };
  let secret:
    | { label: string; ref: string; snapshotId?: number; requestedAt: string }
    | undefined;
  let storageError: Error | undefined;
  /**
   * The last input sequence a lease admitted. Belongs to the lease, not the process: taking a
   * fresh lease starts the numbering over, and no lease survives this process restarting.
   */
  let lastInputSeq: number | undefined;
  const current = () =>
    data.requests.find((r) => r.id === data.currentRequestId);
  const active = (request: HandoffRequest | undefined) =>
    request?.status === "waiting" || request?.status === "taken";
  /**
   * Whether a held lease belongs to somebody else. A taker that brings no identity joins the
   * lease as before (older callers, and the surfaces that predate identities); one that brings
   * a different identity than the holder's is refused, so the idempotent re-take cannot be a
   * second person's way in.
   */
  const heldByAnother = (
    request: HandoffRequest,
    holder?: { userId: string },
  ) =>
    holder !== undefined &&
    request.takenBy !== undefined &&
    request.takenBy !== holder.userId;
  function persist() {
    // Keep the current identity and the latest 32 terminal records. Their aliases expire together.
    const cutoff = Date.parse(now()) - 30 * 24 * 60 * 60 * 1000;
    const keep = data.requests
      .filter(
        (r) =>
          r.id === data.currentRequestId || Date.parse(r.updatedAt) >= cutoff,
      )
      .slice(-33);
    const ids = new Set(keep.map((r) => r.id));
    data.requests = keep;
    data.aliases = Object.fromEntries(
      Object.entries(data.aliases)
        .filter(([, id]) => ids.has(id))
        .slice(-256),
    );
    if (storageError) throw storageError;
    try {
      options.store?.save(structuredClone(data));
    } catch (error) {
      storageError = new Error(
        "The handoff state could not be saved. Computer actions are disabled until storage is repaired.",
        { cause: error },
      );
      barrier.close();
      throw storageError;
    }
  }
  /**
   * End a request.
   *
   * Its page goes with it unless a restart interrupted it. A page address can carry a one-time token
   * (a sign-in code, a reset or magic link), and the record is kept on disk for a month: the address
   * is only needed while the request is live, or so a request raised after a restart can reopen it.
   */
  function finish(
    request: HandoffRequest,
    status: HandoffStatus,
    interruption?: string,
    keepPage = false,
  ) {
    request.status = status;
    request.updatedAt = now();
    request.finishedAt = request.updatedAt;
    delete request.expiresAt;
    if (interruption) request.interruption = interruption;
    if (status === "interrupted" && keepPage && request.url)
      request.keepsPage = true;
    else {
      delete request.url;
      delete request.keepsPage;
    }
  }
  /**
   * Drop every page a finished request no longer needs: all of them, except the latest request's when
   * a restart interrupted it within the help TTL. Also cleans records written before pages were
   * dropped on finish. True when something changed.
   */
  function scrubPages(at: string): boolean {
    let changed = false;
    const latest = data.requests.at(-1);
    for (const request of data.requests) {
      if ((!request.url && !request.keepsPage) || active(request)) continue;
      const inheritable =
        request === latest &&
        request.status === "interrupted" &&
        request.keepsPage === true &&
        request.url !== undefined &&
        request.finishedAt !== undefined &&
        Date.parse(at) - Date.parse(request.finishedAt) <= HELP_REQUEST_TTL_MS;
      if (inheritable) continue;
      delete request.url;
      delete request.keepsPage;
      changed = true;
    }
    return changed;
  }
  function syncAdmission() {
    if (active(current()) || data.holder === "human" || data.recoveryRequired)
      barrier.close();
    else barrier.open();
  }
  function expire() {
    if (storageError) throw storageError;
    if (scrubPages(now())) persist();
    const request = current();
    if (
      request?.status === "waiting" &&
      request.expiresAt &&
      Date.parse(now()) > Date.parse(request.expiresAt)
    ) {
      finish(request, "expired");
      persist();
      syncAdmission();
    }
    if (
      secret &&
      Date.parse(now()) - Date.parse(secret.requestedAt) > SECRET_REQUEST_TTL_MS
    )
      secret = undefined;
  }
  function get(requestId?: string): ControlState {
    expire();
    const request = requestId
      ? data.requests.find((r) => r.id === requestId)
      : current();
    if (requestId && !request)
      throw new ControlRequestError("That handoff request was not found.", 404);
    const live = current();
    return {
      holder: data.holder,
      since: data.since,
      requested: live?.status === "waiting",
      reason: active(live) ? live?.reason : undefined,
      request: request ? { ...request } : undefined,
      transitioning:
        (active(live) || data.holder === "human" || data.recoveryRequired) &&
        barrier.pending() > 0,
      resumeSnapshotRequired: data.resumeSnapshotRequired,
      recoveryRequired: data.recoveryRequired,
      ...(secret
        ? {
            secretWanted: secret.label,
            secretRef: secret.ref,
            secretSnapshotId: secret.snapshotId,
          }
        : {}),
    };
  }
  function intended(id: string): HandoffRequest {
    expire();
    const request = current();
    if (!request || request.id !== id)
      throw new ControlRequestError(
        "That request is no longer the current handoff.",
        409,
      );
    return request;
  }
  /**
   * End whatever handover is in flight, from outside it.
   *
   * The outcome names who ended it: `interrupted` for the process and its browser lifecycle
   * (restarts, resets, replaced browsers), `refused` for a revocation asked of this process —
   * logout, disconnect policy, a policy refusal — where the §3 outcome the lease owes is that
   * it was refused, not that the computer hiccuped.
   *
   * `keepPage` only for a restart underneath the request (the process or the browser coming back up):
   * then a request raised from the blank browser that follows can reopen the page. A deliberate stop
   * or reset is someone moving on, and reset is meant to forget everything, so neither keeps it.
   */
  function interrupt(
    reason: string,
    outcome: "interrupted" | "refused" = "interrupted",
    keepPage = false,
  ): ControlState {
    const request = current();
    // Recovery is for a page a person was driving: what they left it as is unknown until someone
    // looks. A request nobody took left the page exactly as the Bot had it, and holding the Bot
    // until a person "checks" a page no person touched stranded it asking for control it had.
    const personHadIt = data.holder === "human" || request?.status === "taken";
    if (request && active(request)) finish(request, outcome, reason, keepPage);
    if (!keepPage) {
      // A restart may already have interrupted this request and kept its page (a stop closes the
      // browser first, which reports as a replacement). The stop or reset is the last word.
      const latest = data.requests.at(-1);
      if (latest?.status === "interrupted") {
        delete latest.url;
        delete latest.keepsPage;
      }
    }
    if (personHadIt) data.recoveryRequired = true;
    data.holder = "bot";
    data.since = now();
    data.resumeSnapshotRequired = true;
    secret = undefined;
    options.invalidateSnapshot?.();
    persist();
    syncAdmission();
    return get();
  }
  // A persisted active request names a page in a previous process. Never call that completion.
  if (restored && (active(current()) || data.holder === "human"))
    interrupt(
      "The computer process restarted; the previous page was interrupted. Request help again to continue.",
      "interrupted",
      true,
    );
  // Records saved before finished requests dropped their pages are cleaned on first read.
  if (restored && scrubPages(now())) persist();
  if (restored && !active(current()) && data.holder === "bot") {
    data.resumeSnapshotRequired = true;
    persist();
  }
  syncAdmission();

  /**
   * The page of the most recent request, when that request was interrupted recently.
   *
   * Only the most recent one: a request that finished, was cancelled or expired after an
   * interruption means the person or the Bot moved on, and an older page must not come back.
   */
  function interruptedPage(at: string): string | undefined {
    const latest = data.requests.at(-1);
    if (
      latest?.status !== "interrupted" ||
      latest.keepsPage !== true ||
      !latest.url ||
      !latest.finishedAt
    )
      return undefined;
    if (Date.parse(at) - Date.parse(latest.finishedAt) <= HELP_REQUEST_TTL_MS)
      return latest.url;
    // Past the TTL the address is only a liability; requestHelp persists right after.
    delete latest.url;
    delete latest.keepsPage;
    return undefined;
  }

  function rememberAlias(toolCallId: string, requestId: string) {
    Object.defineProperty(data.aliases, toolCallId, {
      value: requestId,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return {
    get,
    requestHelp(
      reason: unknown,
      toolCallId?: string,
      source: HandoffSource = "model",
      pageUrl?: string,
    ): ControlState {
      expire();
      if (
        toolCallId !== undefined &&
        (!toolCallId.trim() || toolCallId.length > 200)
      )
        throw new ControlRequestError(
          "The tool call id must be a nonempty string of at most 200 characters.",
        );
      const previous =
        toolCallId && Object.hasOwn(data.aliases, toolCallId)
          ? data.aliases[toolCallId]
          : undefined;
      if (previous) return get(previous);
      const existing = current();
      if (active(existing) || data.holder === "human") {
        if (toolCallId && existing) {
          rememberAlias(toolCallId, existing.id);
          persist();
        }
        return get();
      }
      barrier.close(); // Before any persistence or awaited browser operation.
      const at = now();
      /*
       * The page this request is about. A browser that restarted comes back blank, so a request
       * raised on a blank page inherits the page of the request a restart interrupted, if that was
       * recent: the Bot asking again after "the computer process restarted" is still asking about
       * the page it lost, and the person it hands control to needs that page in front of them.
       */
      const url = pageWorthKeeping(pageUrl) ?? interruptedPage(at);
      const request: HandoffRequest = {
        id: crypto.randomUUID(),
        toolCallId,
        reason:
          typeof reason === "string" && reason.trim()
            ? reason.trim().slice(0, 500)
            : "The assistant needs a person to continue.",
        source,
        status: "waiting",
        createdAt: at,
        updatedAt: at,
        expiresAt: new Date(Date.parse(at) + HELP_REQUEST_TTL_MS).toISOString(),
        ...(url ? { url } : {}),
      };
      data.currentRequestId = request.id;
      data.requests.push(request);
      if (toolCallId) rememberAlias(toolCallId, request.id);
      persist();
      return get();
    },
    async take(
      requestId: string,
      holder?: { userId: string },
    ): Promise<ControlState> {
      const request = intended(requestId);
      if (request.status === "taken" && data.holder === "human") {
        if (heldByAnother(request, holder))
          throw new ControlRequestError(
            "Another person already holds this control request.",
            409,
          );
        return get();
      }
      if (request.status !== "waiting")
        throw new ControlRequestError(
          "That request is no longer waiting for control.",
          409,
        );
      barrier.close();
      // Never await here from requestHelp: a navigation detector still owns its action lease.
      await barrier.drain(options.drainTimeoutMs);
      const after = intended(requestId);
      if (after.status === "taken" && data.holder === "human") {
        if (heldByAnother(after, holder))
          throw new ControlRequestError(
            "Another person already holds this control request.",
            409,
          );
        return get();
      }
      if (after.status !== "waiting")
        throw new ControlRequestError(
          "That request is no longer waiting for control.",
          409,
        );
      after.status = "taken";
      after.updatedAt = now();
      if (holder) after.takenBy = holder.userId;
      delete after.expiresAt;
      data.holder = "human";
      data.since = now();
      secret = undefined;
      // A fresh lease numbers its input from the start; the previous holder's last gesture is
      // not this holder's to have to out-number.
      lastInputSeq = undefined;
      persist();
      return get();
    },
    release(requestId: string, holder?: { userId: string }): ControlState {
      const request = intended(requestId);
      if (request.status === "completed" && data.holder === "bot") return get();
      if (
        data.holder !== "human" ||
        (request.status !== "taken" && request.status !== "cancelled")
      )
        throw new ControlRequestError(
          "That request is no longer held by a person.",
          409,
        );
      /*
       * Take refuses a second person's claim of a held lease; release must not be
       * their way around it — putting the holder off the wheel is the same
       * interference take's 409 exists to prevent, so the same check applies. A
       * caller that brings no identity joins the older, identity-less contract.
       */
      if (heldByAnother(request, holder))
        throw new ControlRequestError(
          "Another person holds this control request.",
          409,
        );
      if (request.status === "taken") finish(request, "completed");
      data.holder = "bot";
      data.since = now();
      data.resumeSnapshotRequired = true;
      data.recoveryRequired = false;
      secret = undefined;
      options.invalidateSnapshot?.();
      persist();
      syncAdmission();
      return get();
    },
    cancel(requestId: string, holder?: { userId: string }): ControlState {
      const request = intended(requestId);
      if (request.status === "cancelled") return get();
      if (!active(request))
        throw new ControlRequestError("That request is no longer active.", 409);
      /*
       * A taken lease is the holder's, so cancelling it is release's "put the
       * holder off the wheel" in another coat and carries the same identity
       * check. A waiting request is the Bot's own ask — any member may still
       * cancel it, exactly as before.
       */
      if (request.status === "taken" && heldByAnother(request, holder))
        throw new ControlRequestError(
          "Another person holds this control request.",
          409,
        );
      finish(request, "cancelled");
      persist();
      syncAdmission();
      return get();
    },
    interrupt,
    /**
     * Where a blank browser should be sent before a person works the current handoff.
     *
     * The live request's page, while one is waiting or held. Nothing otherwise: once the request
     * is over, whatever the browser shows is the Bot's business again.
     */
    pageToRestore(): string | undefined {
      expire();
      const request = current();
      return active(request) ? request?.url : undefined;
    },
    snapshotTaken() {
      if (
        data.holder === "bot" &&
        data.resumeSnapshotRequired &&
        !active(current())
      ) {
        data.resumeSnapshotRequired = false;
        persist();
      }
    },
    assertBotMayAct(browserMutation = false) {
      expire();
      if (data.holder === "human" || active(current()) || data.recoveryRequired)
        throw new ControlError(HUMAN_HAS_CONTROL);
      if (browserMutation && data.resumeSnapshotRequired)
        throw new SnapshotRequiredError();
    },
    admitBotAction(browserMutation = false): () => void {
      this.assertBotMayAct(browserMutation);
      return barrier.enter();
    },
    humanMayDrive(): boolean {
      return data.holder === "human" && barrier.pending() === 0;
    },
    /**
     * The gate a person's input passes: the lease, and the order the sender numbers it in.
     *
     * The HTTP gestures answer here before anything reaches a page, so a refusal is input that
     * was never delivered. The live screen (WS screencast input) is NOT gated here: it checks
     * `humanMayDrive` alone, because it carries no sequence numbers to judge — extending the
     * numbering to that path is deferred (k03 records "WS path unchanged"). A sender that brings
     * no number is admitted as before — numbering is the surface's choice, not a demand the
     * lease makes — and one that brings a number moves only forward: the same number is a
     * replay, a smaller one a reorder, and neither is delivered.
     */
    admitHumanInput(input?: {
      seq?: number;
    }): { ok: true } | { ok: false; error: string; status: 400 | 409 } {
      expire();
      if (!this.humanMayDrive())
        return { ok: false, error: TAKE_CONTROL_FIRST, status: 409 };
      const seq = input?.seq;
      if (seq === undefined) return { ok: true };
      if (!Number.isInteger(seq) || seq < 1)
        return { ok: false, error: BAD_INPUT_SEQUENCE, status: 400 };
      if (lastInputSeq !== undefined && seq <= lastInputSeq)
        return { ok: false, error: STALE_INPUT_SEQUENCE, status: 409 };
      lastInputSeq = seq;
      return { ok: true };
    },
    requestSecret(input: {
      label?: unknown;
      ref?: unknown;
      snapshotId?: unknown;
    }): ControlState {
      if (typeof input.ref !== "string" || !input.ref.trim())
        throw new ControlRequestError(
          "Say which field the value goes in, using a ref from your snapshot.",
        );
      secret = {
        label:
          typeof input.label === "string" && input.label.trim()
            ? input.label.trim().slice(0, 500)
            : "the value this page is asking for",
        ref: input.ref.trim(),
        snapshotId:
          typeof input.snapshotId === "number" ? input.snapshotId : undefined,
        requestedAt: now(),
      };
      return get();
    },
    pendingSecret(): { ref: string; snapshotId?: number } | null {
      expire();
      return secret ? { ref: secret.ref, snapshotId: secret.snapshotId } : null;
    },
    secretSupplied() {
      secret = undefined;
    },
  };
}
export type Control = ReturnType<typeof createControl>;
