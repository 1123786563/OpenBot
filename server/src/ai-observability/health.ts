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
 * The entry also establishes its own gate (R2-45): the first submit on an unprobed
 * deployment triggers one background probe and waits in the queue for its verdict,
 * so a production assembly no longer refuses every observation write from boot
 * merely because no read route has ever asked for readiness. Slow, unreachable or
 * saturated Opik therefore cannot delay or fail an ordinary
 * Agent result; the delay and the drops stay observable through the counters.
 *
 * Drift semantics live in the port (T08): a job that answers ownership_drift has
 * already suspended that scope's writes upstream — this queue only counts the
 * outcome, it never retries or re-enables anything.
 */

import type { OpikConfig } from "./config";
import { modelSpanChainGateDrops } from "./model-span";
import { type OpikPort, OpikPortError, type OpikPortResult } from "./opik-port";
import { toolStepChainGateDrops } from "./tool-steps";

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
  /**
   * The FREV-02 chain-gate drops (T-M #2): the recorders refuse a chain-less
   * observation BEFORE any submit, so those refusals are invisible in the
   * submit counters above. Steps and model spans land in the same projection —
   * a twin without an outlet would keep the gap. Counters only, same safety
   * as `idLinks`: no ids, no content, no chain values.
   */
  chainGateDrops: Readonly<{
    steps: number;
    modelSpans: number;
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
   *
   * The entry also establishes its own gate (R2-45): a deployment assembled with
   * no probe at all — production boots with no readiness caller until somebody
   * opens a read route — used to refuse every write for the life of the process.
   * Now the first submit that finds the gate unprobed triggers exactly one
   * background probe; the write itself waits in the queue for that probe's
   * verdict and faces the same re-checked gate as every write (a not-ready
   * answer counts it `failed.unavailable`, never lets it begin). A probe that
   * answers synchronously (disabled, unconfigured, no port) gates the submit
   * immediately, exactly as before. Everything after the first probe answers is
   * refused or accepted by that verdict — and, since R5-20, a not-ready verdict
   * no longer holds for the life of the process: once the cooldown
   * (`reArmAfterMs`, default 30s) has passed, a submit that finds the gate
   * not-ready re-probes in the background, so a headless deployment whose first
   * probe landed while Opik was down recovers without a restart. The cooldown
   * lifts the LATCH, never the gate: the triggering write is still refused
   * fail-closed, and later writes run only after a verdict that actually
   * answers ready. The assembly-fact reasons (disabled, unconfigured,
   * capability_missing) never re-arm — they derive from the immutable boot
   * config/port and cannot flip without reassembly; the upstream-answered ones
   * (unreachable, authentication_failure) are what a later probe may overturn.
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
  /**
   * R5-20: how long a not-ready verdict holds before a submit may re-arm the
   * gate with a background re-probe. Default 30_000.
   */
  reArmAfterMs?: number;
  /** The cooldown clock. Default Date.now; tests inject a fake. */
  now?: () => number;
}>;

const DEFAULT_WRITE_CAPACITY = 256;
/** R5-20: the not-ready latch's re-arm cooldown. */
const DEFAULT_REARM_AFTER_MS = 30_000;

export function createOpikHealthService(
  deps: OpikHealthDeps,
): OpikHealthService {
  const capacity = deps.writeCapacity ?? DEFAULT_WRITE_CAPACITY;
  const reArmAfterMs = deps.reArmAfterMs ?? DEFAULT_REARM_AFTER_MS;
  const now = deps.now ?? Date.now;
  const queue: OpikObservationWrite[] = [];
  let pumping = false;
  let lastProbed: OpikReadiness | null = null;
  /** When the gate's current verdict was recorded — the cooldown's zero. */
  let lastProbedAt = 0;
  /**
   * The one in-flight bootstrap probe, from the first unprobed submit (R2-45). Its
   * value is only ever awaited as a barrier (the verdict is read through
   * `lastProbed`), so a probe whose injected seams throw collapses to undefined
   * instead of rejecting into the submit path or the pump.
   */
  let bootstrapProbe: Promise<OpikReadiness | undefined> | null = null;
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
    chainGateDrops: {
      steps: toolStepChainGateDrops().missingChain,
      modelSpans: modelSpanChainGateDrops().missingChain,
    },
  });

  const settleIdle = () => {
    if (queue.length === 0 && !pumping) {
      for (const waiter of idleWaiters) waiter();
    }
  };

  /** Remembers a probe outcome as the write gate, then answers it. */
  const record = (probed: OpikReadiness): OpikReadiness => {
    lastProbed = probed;
    lastProbedAt = now();
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
        // A write queued before the gate had any answer waits for exactly the
        // bootstrap probe it triggered (R2-45), then faces the same re-checked
        // gate as every write (review F1): a not-ready verdict keeps it from
        // beginning, counted, never performed against an unproven upstream.
        if (lastProbed === null && bootstrapProbe !== null) {
          await bootstrapProbe;
        }
        // The gate is checked again when a waiting write is about to start: a probe
        // that flipped not-ready after submit must keep queued writes from beginning
        // (review F1). In-flight writes are never cancelled — only waiting ones.
        if (lastProbed === null || !lastProbed.ready) {
          // Counted here in addition to the submit-time `accepted`: the write was
          // admitted, then the gate refused it before it began. accepted is an
          // admission count, not a completion ledger, and never balances.
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
    if (lastProbed === null) {
      // R2-45: the first submit an assembled deployment makes triggers the ONE
      // probe that establishes the gate. Probes that answer synchronously
      // (disabled / unconfigured / no port) record their verdict right here;
      // an in-flight one leaves the gate unknown for this submit, and the
      // write waits in the queue for the pump's post-probe re-check below.
      if (bootstrapProbe === null) {
        // The injected seams ahead of the port call can throw synchronously; a probe
        // that rejects must not take the submit path or the pump down with it. The
        // gate re-check below still sees no verdict and refuses.
        bootstrapProbe = readiness()
          .catch(() => undefined)
          .finally(() => {
            bootstrapProbe = null;
          });
      }
    } else if (
      !lastProbed.ready &&
      bootstrapProbe === null &&
      // R5-20: a not-ready verdict latched for the life of the process used to
      // mean a headless deployment whose first probe hit an outage refused
      // every write until restart. Once the cooldown has passed, this submit
      // re-probes in the background. The latch lifts, the gate does not: this
      // write is still refused below, and only a fresh ready verdict lets the
      // next ones through. Assembly facts (disabled / unconfigured /
      // capability_missing) cannot flip without reassembly and never re-arm.
      (lastProbed.reason === "unreachable" ||
        lastProbed.reason === "authentication_failure") &&
      now() - lastProbedAt >= reArmAfterMs
    ) {
      bootstrapProbe = readiness()
        .catch(() => undefined)
        .finally(() => {
          bootstrapProbe = null;
        });
    }
    if (lastProbed !== null && !lastProbed.ready) {
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
