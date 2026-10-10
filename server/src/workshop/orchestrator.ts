/**
 * The workshop turn's long-form brain: enqueue, lock, stream, settle, recover.
 *
 * THE INVARIANT THE WHOLE FILE SERVES: every turn reaches a terminal state exactly once, and
 * every state change has an audit row beside it. The store's guarded transitions (B2) settle
 * rows; the lock (B2/B13) makes two replicas safe — they race the same acquire and one runs.
 *
 * FAILURE POSTURE (plan §3.5.6): a lock that cannot be reached cannot vouch for exclusivity,
 * so `enqueue` FAILS CLOSED — the turn is refused and audited (`workshop.lock_unavailable`)
 * rather than run unguarded. A single-replica deployment runs the in-process lock and never
 * sees this path.
 *
 * `enqueue` RESOLVES WHEN THE TURN EXISTS, not when it finishes: the run is fire-and-forget,
 * and the caller's stream (B9) observes the events this run appends.
 */
import { recordAuditEvent, type AuditInitiator, type AuditStore } from "../audit";
import type { CodeRunGateway, StreamingRun } from "../codesandbox/gateway";
import type { TranslatedEvent, SandboxArtifact } from "../codesandbox/types";
import type { TurnLease, TurnLock } from "./locks";
import type { WorkshopStore } from "./store";
import { indexArtifacts } from "./artifacts";

/** Postgres's unique-violation: a lost race on a guarded insert. */
const UNIQUE_VIOLATION = "23505";

/** Streaming runs in flight, so `cancel` can reach the stream itself. */
const activeStreams = new Map<string, StreamingRun>();

export class TurnLockUnavailableError extends Error {
  constructor(turnId: string) {
    super(`The turn lock is unavailable; turn ${turnId} was refused.`);
    this.name = "TurnLockUnavailableError";
  }
}

export type TurnOrchestrator = {
  /** Create and start one turn; resolves when the turn row exists. */
  enqueue(input: {
    sessionId: string;
    prompt: string;
    initiator?: AuditInitiator;
    actorUserId: string;
    botId: string;
    ownerUserId: string;
  }): Promise<{ turnId: string }>;
  /** Ask a turn to stop. False when it already settled. */
  cancel(turnId: string): Promise<boolean>;
  /** Settle running turns whose heartbeat went quiet; each exactly once. */
  recoverStale(nowMs: number, staleAfterMs: number): Promise<string[]>;
  /** The runner is alive; both clocks (lease and DB row) get the beat. */
  heartbeat(turnId: string): Promise<void>;
};

export type TurnOrchestratorOptions = {
  store: WorkshopStore;
  lock: TurnLock;
  gateway: CodeRunGateway;
  auditStore?: AuditStore;
  /** The artifact indexer for the run's collected files (B4's pipeline, one layer up). */
  indexArtifactsFor?: (input: {
    sessionId: string;
    artifacts: SandboxArtifact[];
  }) => Promise<void>;
  /** Activity budget handed to the gateway's stream; default 300000. */
  activityTimeoutMs?: number;
  /** DB heartbeat cadence in ms; the lease renews on its own TTL/3 contract. */
  heartbeatIntervalMs?: number;
  /** Interval injection for tests. */
  interval?: (callback: () => void, ms: number) => () => void;
};

export function createTurnOrchestrator(
  options: TurnOrchestratorOptions,
): TurnOrchestrator {
  const { store, lock, gateway } = options;

  const audit = (
    eventType:
      | "workshop.turn_started"
      | "workshop.turn_completed"
      | "workshop.turn_failed"
      | "workshop.turn_cancelled"
      | "workshop.turn_stale_recovered"
      | "workshop.lock_unavailable",
    payload: Record<string, unknown>,
    input: { actorUserId: string; initiator?: AuditInitiator },
  ) =>
    options.auditStore
      ? recordAuditEvent(options.auditStore, {
          eventType,
          targetType: "workshop_turn",
          targetId: String(payload.turnId ?? payload.sessionId ?? ""),
          actorUserId: input.actorUserId,
          initiator: input.initiator,
          payload,
        })
      : Promise.resolve();

  /** One guarded insert, retried once on a unique violation (two tabs, same instant). */
  const appendWithRetry = async (
    turnId: string,
    event: TranslatedEvent,
  ): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await store.appendEvent({
          turnId,
          type: event.family,
          payload: event.payload,
        });
        return;
      } catch (error) {
        const retryable =
          attempt === 0 &&
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: unknown }).code === UNIQUE_VIOLATION;
        if (!retryable) throw error;
      }
    }
  };

  const runTurn = async (input: {
    turnId: string;
    sessionId: string;
    prompt: string;
    actorUserId: string;
    initiator?: AuditInitiator;
  }): Promise<void> => {
    let lease: TurnLease | null = null;
    try {
      lease = await lock.acquire(input.turnId);
    } catch {
      // Fail closed: no lock, no exclusivity, no run. The row settles failed with the audit
      // beside it — the caller's 503-shape answer comes from the routes reading this state.
      await store.markFailed(input.turnId, "the turn lock is unavailable");
      await audit(
        "workshop.lock_unavailable",
        { turnId: input.turnId, sessionId: input.sessionId },
        input,
      );
      return;
    }
    if (!lease) {
      // Held elsewhere: not an error, an answer. The holder's run settles this row.
      return;
    }

    const stopHeartbeat = startHeartbeat(input.turnId, lease);
    let settledByStream = false;

    try {
      const running = await store.markRunning(input.turnId);
      if (!running) {
        // The turn settled while this replica waited (stale sweep, cancel): stand down.
        return;
      }

      let streaming: StreamingRun;
      try {
        streaming = await gateway.startStreaming(input.prompt, {
          activityTimeoutMs: options.activityTimeoutMs,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await store.markFailed(input.turnId, reason);
        await audit("workshop.turn_failed", { turnId: input.turnId, reason }, input);
        return;
      }
      activeStreams.set(input.turnId, streaming);

      try {
        for await (const event of streaming.events) {
          if (lease.lost) break;
          // The stream's own refusal event (unconfigured sandbox): the turn fails but stays
          // recorded, exactly the shape the gateway guarantees for the run row.
          if (
            event.family === "unknown" &&
            event.payload["refused"] !== undefined
          ) {
            break;
          }
          await appendWithRetry(input.turnId, event);
          if (event.family === "prompt_response") {
            // session.idle: the turn is assembled; the iterator ends on its own next tick.
            settledByStream = true;
          }
        }
      } finally {
        activeStreams.delete(input.turnId);
      }

      if (lease.lost) {
        // Unrenewed past its TTL: this replica is no longer the sanctioned runner. Settle its
        // own view; the stale sweep would catch it otherwise, but self-settling is kinder.
        await store.markFailed(input.turnId, "the turn lock was lost mid-run");
        await audit(
          "workshop.turn_failed",
          { turnId: input.turnId, reason: "lock-lost" },
          input,
        );
        return;
      }

      if (settledByStream) {
        const succeeded = await store.markSucceeded(input.turnId, {});
        if (succeeded) {
          await audit(
            "workshop.turn_completed",
            { turnId: input.turnId, sessionId: input.sessionId },
            input,
          );
        }
      } else {
        // Ended without idle: refused from the start, cancelled from under us (the store row
        // moved first), timed out, or failed. Every one of those has already settled the row
        // through its own path or is about to; a row still running here is the unsettled
        // failure shape, settled now.
        const turn = await store.getTurn(input.turnId);
        if (turn && turn.status === "running") {
          await store.markFailed(input.turnId, "the stream ended without completing");
          await audit(
            "workshop.turn_failed",
            { turnId: input.turnId, reason: "stream-ended-unsettled" },
            input,
          );
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await store.markFailed(input.turnId, reason);
      await audit("workshop.turn_failed", { turnId: input.turnId, reason }, input);
    } finally {
      stopHeartbeat();
      await lease.release().catch(() => undefined);
    }
  };

  const startHeartbeat = (
    turnId: string,
    lease: TurnLease,
  ): (() => void) => {
    const interval =
      options.interval ??
      ((callback: () => void, ms: number) => {
        const handle = setInterval(callback, ms);
        return () => clearInterval(handle);
      });
    return interval(() => {
      void (async () => {
        await lease.renew();
        await store.heartbeat(turnId).catch(() => undefined);
      })();
    }, options.heartbeatIntervalMs ?? 10_000);
  };

  return {
    async enqueue(input) {
      // AUDIT FIRST, ROW FIRST — one layer up from the gateway's own discipline.
      await audit(
        "workshop.turn_started",
        { sessionId: input.sessionId, bot: input.botId },
        input,
      );
      const row = await store.enqueueTurn({
        sessionId: input.sessionId,
        prompt: input.prompt,
      });
      // Fire-and-forget: enqueue resolves on existence; the stream (B9) shows the rest.
      void runTurn({
        turnId: row.id,
        sessionId: input.sessionId,
        prompt: input.prompt,
        actorUserId: input.actorUserId,
        initiator: input.initiator,
      });
      return { turnId: row.id };
    },

    async cancel(turnId) {
      const cancelled = await store.markCancelled(turnId);
      if (!cancelled) return false;
      await audit("workshop.turn_cancelled", { turnId }, { actorUserId: "" });
      const active = activeStreams.get(turnId);
      if (active) await active.cancel().catch(() => undefined);
      return true;
    },

    async recoverStale(nowMs, staleAfterMs) {
      const settled = await store.recoverStale(nowMs, staleAfterMs);
      for (const item of settled) {
        await audit(
          "workshop.turn_stale_recovered",
          { turnId: item.turnId, reason: item.error },
          { actorUserId: "" },
        );
        const active = activeStreams.get(item.turnId);
        if (active) await active.cancel().catch(() => undefined);
      }
      return settled.map((item) => item.turnId);
    },

    async heartbeat(turnId) {
      await store.heartbeat(turnId);
    },
  };
}
