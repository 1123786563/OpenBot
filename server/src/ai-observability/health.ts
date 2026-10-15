/**
 * Unified Opik readiness and the bounded async-write entry (Issue #15 / DAG T09).
 *
 * Readiness is ONE explicit state machine, not scattered booleans: disabled,
 * unconfigured, capability_missing (no verified contract/operation),
 * authentication_failure (401/403 on the verified health probe) and unreachable
 * (timeout, transport failure, 5xx, malformed) each answer with their enumerated
 * reason, and every one of them prohibits observation writes — the write entry
 * fails closed until a probe has actually succeeded.
 *
 * The write entry is bounded and non-blocking by construction: a fixed capacity,
 * a synchronous submit that never touches the network, drop counters instead of
 * backpressure, and a single background pump that performs jobs against the port —
 * re-checking the gate as each waiting job starts, so a readiness flip after submit
 * still keeps a queued write from beginning (in-flight writes are not cancelled).
 * Slow, unreachable or saturated Opik therefore cannot delay or fail an ordinary
 * Agent result; the delay and the drops stay observable through the counters.
 *
 * Drift semantics live in the port (T08): a job that answers ownership_drift has
 * already suspended that scope's writes upstream — this queue only counts the
 * outcome, it never retries or re-enables anything.
 */

import type { OpikConfig } from "./config";
import { type OpikPort, OpikPortError, type OpikPortResult } from "./opik-port";

/** One enumerated reason per unavailable state. Nothing else is ever exposed. */
export type OpikReadinessReason =
  | "disabled"
  | "unconfigured"
  | "capability_missing"
  | "authentication_failure"
  | "unreachable";

export type OpikReadiness =
  | { ready: true }
  | { ready: false; reason: OpikReadinessReason };

/** Counters only. Safe to expose: no endpoint, credential, body or exception text. */
export type OpikWriteStats = Readonly<{
  capacity: number;
  depth: number;
  submitted: number;
  accepted: number;
  droppedFull: number;
  refusedNotReady: number;
  completed: number;
  failed: Readonly<{
    unavailable: number;
    upstream_error: number;
    malformed: number;
    ownership_drift: number;
    unexpected: number;
  }>;
  /**
   * The id-mapping outcomes the observation path produces (T17): a refused link
   * verdict is a detected fact (a broken chain, upstream duplication) and a
   * link-store failure is a swallowed-but-seen error. Labels only — never the
   * local or upstream ids, never the evidence.
   */
  idLinks: Readonly<{
    chain_broken: number;
    divergent: number;
    error: number;
  }>;
}>;

/** One id-mapping outcome label, the same enumeration `OpikWriteStats.idLinks` counts. */
export type OpikIdLinkOutcome = "chain_broken" | "divergent" | "error";

/** The safe projection the health route serves. */
export type OpikHealthSnapshot = Readonly<{
  readiness: OpikReadiness;
  writes: OpikWriteStats;
}>;

/**
 * One observation write. `perform` must go through the port — it is the only
 * sanctioned way to reach Opik — and its result outcome is counted, never
 * propagated to a caller. `scopeKey` and `operation` are safe labels for the
 * counters; neither carries business content.
 */
export type OpikObservationWrite = Readonly<{
  scopeKey: string;
  operation: string;
  perform: (port: OpikPort) => Promise<OpikPortResult<unknown>>;
}>;

export type OpikWriteSubmitResult =
  | "accepted"
  | "dropped_full"
  | "refused_not_ready";

export type OpikHealthService = {
  /** Probes now. Bounded by the port deadline; answers the unified state. */
  readiness(): Promise<OpikReadiness>;
  /**
   * The bounded, non-blocking write entry. Gated on the last probe: fails closed
   * (`refused_not_ready`) before any probe has succeeded, and after any probe that
   * answered not-ready. The same gate is re-checked when a queued write starts, so
   * a probe that flips not-ready after submit skips the waiting write (counted as
   * `failed.unavailable`) instead of performing it. Never awaits the network.
   */
  submit(write: OpikObservationWrite): OpikWriteSubmitResult;
  /**
   * Counts one id-mapping outcome from the observation path (T17): safe labels
   * only, so the refusals and failures of the mapping stay observable without
   * the ids or evidence ever leaving the store.
   */
  countIdLink(outcome: OpikIdLinkOutcome): void;
  writeStats(): OpikWriteStats;
  /** The safe health projection: a fresh probe plus the write counters. */
  snapshot(): Promise<OpikHealthSnapshot>;
  /**
   * Resolves when the queue is empty and no job is in flight. Determinism for
   * tests and shutdown wiring; callers never need it on the Agent path.
   */
  drain(): Promise<void>;
};

export type OpikHealthDeps = Readonly<{
  /** Config is read through a function so a boot-time snapshot stays immutable. */
  config: () => OpikConfig;
  /** The verified port, or null when no verified contract backs this deployment. */
  port: OpikPort | null;
  /** Fixed queue bound. Default 256; every overflow is a counted drop. */
  writeCapacity?: number;
}>;

const DEFAULT_WRITE_CAPACITY = 256;

export function createOpikHealthService(
  deps: OpikHealthDeps,
): OpikHealthService {
  const capacity = deps.writeCapacity ?? DEFAULT_WRITE_CAPACITY;
  const queue: OpikObservationWrite[] = [];
  let pumping = false;
  let lastProbed: OpikReadiness | null = null;
  const stats = {
    submitted: 0,
    accepted: 0,
    droppedFull: 0,
    refusedNotReady: 0,
    completed: 0,
    failed: {
      unavailable: 0,
      upstream_error: 0,
      malformed: 0,
      ownership_drift: 0,
      unexpected: 0,
    },
  };
  const idLinkStats: Record<OpikIdLinkOutcome, number> = {
    chain_broken: 0,
    divergent: 0,
    error: 0,
  };
  const idleWaiters = new Set<() => void>();

  const writeStats = (): OpikWriteStats => ({
    capacity,
    depth: queue.length,
    ...stats,
    failed: { ...stats.failed },
    idLinks: { ...idLinkStats },
  });

  const settleIdle = () => {
    if (queue.length === 0 && !pumping) {
      for (const waiter of idleWaiters) waiter();
    }
  };

  /** Remembers a probe outcome as the write gate, then answers it. */
  const record = (probed: OpikReadiness): OpikReadiness => {
    lastProbed = probed;
    return probed;
  };

  const readiness = async (): Promise<OpikReadiness> => {
    const config = deps.config();
    if (!config.enabled) return record({ ready: false, reason: "disabled" });
    if (config.baseUrl === null)
      return record({ ready: false, reason: "unconfigured" });
    const port = deps.port;
    if (port === null)
      return record({ ready: false, reason: "capability_missing" });
    try {
      const result = await port.healthCheck();
      if (result.outcome === "ok") {
        return record({ ready: true });
      }
      if (
        result.outcome === "upstream_error" &&
        (result.status === 401 || result.status === 403)
      ) {
        return record({ ready: false, reason: "authentication_failure" });
      }
      // Timeout, unreachable, 5xx, malformed: one explicit upstream-fault state.
      return record({ ready: false, reason: "unreachable" });
    } catch (error) {
      // Pre-I/O refusals (stale contract, unsupported operation) are a missing
      // verified capability; anything else fails closed as unreachable. The
      // error itself is never surfaced — only the enumerated reason is.
      return record({
        ready: false,
        reason:
          error instanceof OpikPortError ? "capability_missing" : "unreachable",
      });
    }
  };

  /** One job against the port; every way it can end is a counter, never a throw. */
  const perform = async (write: OpikObservationWrite) => {
    const port = deps.port;
    if (port === null) {
      // The port disappeared after a successful probe: count, do not guess.
      stats.failed.unexpected += 1;
      return;
    }
    try {
      const result = await write.perform(port);
      if (result.outcome === "ok") {
        stats.completed += 1;
      } else if (result.outcome === "ownership_drift") {
        stats.failed.ownership_drift += 1;
      } else {
        stats.failed[result.outcome] += 1;
      }
    } catch {
      stats.failed.unexpected += 1;
    }
  };

  const pump = async () => {
    pumping = true;
    try {
      while (queue.length > 0) {
        const write = queue.shift();
        if (write === undefined) continue;
        // The gate is checked again when a waiting write is about to start: a probe
        // that flipped not-ready after submit must keep queued writes from beginning
        // (review F1). In-flight writes are never cancelled — only waiting ones.
        if (lastProbed === null || !lastProbed.ready) {
          stats.failed.unavailable += 1;
          continue;
        }
        await perform(write);
      }
    } finally {
      pumping = false;
      settleIdle();
    }
  };

  const submit = (write: OpikObservationWrite): OpikWriteSubmitResult => {
    stats.submitted += 1;
    if (lastProbed === null || !lastProbed.ready) {
      stats.refusedNotReady += 1;
      return "refused_not_ready";
    }
    if (queue.length >= capacity) {
      stats.droppedFull += 1;
      return "dropped_full";
    }
    queue.push(write);
    stats.accepted += 1;
    if (!pumping) void pump();
    return "accepted";
  };

  const drain = async (): Promise<void> => {
    if (queue.length === 0 && !pumping) return;
    await new Promise<void>((resolve) => {
      const waiter = () => {
        idleWaiters.delete(waiter);
        resolve();
      };
      idleWaiters.add(waiter);
    });
  };

  return {
    readiness,
    submit,
    countIdLink: (outcome) => {
      idLinkStats[outcome] += 1;
    },
    writeStats,
    snapshot: async () => ({
      readiness: await readiness(),
      writes: writeStats(),
    }),
    drain,
  };
}
