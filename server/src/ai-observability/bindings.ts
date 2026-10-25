import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import type { SafeText } from "../../../shared/ai-observability";
import { getLogger } from "../../../shared/logger";
import type { Database } from "../db/client";
import {
  type AiObservationBindingCapability,
  type AiObservationBindingState,
  aiObservationBindings,
} from "../db/schema/ai-observability-bindings";
import type { ObservationScope } from "./contracts";
import { runUpstreamIdentity } from "./opik-http";
import type { OpikOtlpSpan, OpikPort, OpikRunBindingRef } from "./opik-port";
import { notPendingDeletion } from "./retention";
import { assertObservationScope, resolveStorageLocator } from "./scope";
import { nanos, nowNs, W3C_TRACE_ID } from "./span-support";

/**
 * The trusted seam between T06's ObservationScope and the binding table.
 *
 * A binding's ownership fields are copied out of a scope this process issued — the caller
 * contributes run, attempt and trace references, never an actor, bot, scope or locator of its
 * own. `assertObservationScope` fails closed on anything else, so a forged scope cannot reach
 * the database even once. Opik metadata is never read here and never could assign ownership:
 * reconciliation is keyed by the authoritative local (scope, run, attempt) triple, and the
 * upstream trace id is a value it records, not an identity it derives from.
 *
 * FREV-03: the scope key a row carries is the Bot's STABLE data identity (scope.ts
 * `resourceScopeKey`), so every authorized holder of a scope for one Bot — its creator, a
 * managing administrator, a post-transfer owner — reads and writes the SAME rows. Who may hold
 * the scope at all is the live manage gate's answer upstream of this store; the row's own
 * `actor_id` remains the provenance of who recorded it.
 */

export type RunBindingErrorCode =
  | "BINDING_INPUT_INVALID"
  | "BINDING_NOT_FOUND"
  /**
   * R2-29: the (scope_key, opik_trace_id) unique index refused the reconcile —
   * another live binding of this scope already recorded that upstream id. The
   * first claim stands; this attempt stays unreconciled and the caller hears a
   * deterministic 409, never the driver's bare constraint violation as a 500.
   *
   * FREV-02: also the observer gate's replay refusal — the authoritative
   * (scope, run, attempt) row already exists and names a DIFFERENT W3C chain
   * than the one being exported. The first claim stands there too: the gate
   * refuses rather than exporting a run under a row that disagrees with it.
   */
  | "BINDING_TRACE_CONFLICT"
  /**
   * F5E1-F3: the run's upstream objects could not be materialized (the create or the
   * root-span write failed, or the verified read-back never observed the trace). A run
   * without its upstream trace/root is a run whose spans would land where nobody could map
   * them back to the binding, so the export fails closed instead — the write queue counts
   * the failure, and the chain's next fact retries the whole materialization (the ids are
   * derived, so the retry asks for the same objects).
   */
  | "BINDING_UPSTREAM_UNAVAILABLE";

export class RunBindingError extends Error {
  constructor(
    public code: RunBindingErrorCode,
    public status: 400 | 404 | 409 | 503,
  ) {
    super(code);
  }
}

export type BeginRunBindingInput = {
  runId: string;
  attemptId: string;
  /** OTel trace id — our own opaque reference, checked for shape and stored as-is. */
  traceId: string;
  capability: AiObservationBindingCapability;
  expiresAt: Date;
};

export type RunBinding = typeof aiObservationBindings.$inferSelect;

export type RunBindingStore = {
  /**
   * Create the binding for one run attempt, or return the one that already exists. Idempotency
   * is decided by the (scope, run, attempt) unique index: concurrent begins race in the
   * database and every winner and loser answers with the same row.
   */
  begin(
    scope: ObservationScope,
    input: BeginRunBindingInput,
  ): Promise<{ binding: RunBinding; replayed: boolean }>;
  /**
   * Record the upstream identifier for a binding that was already begun — the lost-acknowledgment
   * path, where Opik succeeded but the local write did not. The first recorded id stands: a
   * divergent later id signals upstream duplication and changes nothing here. A DIFFERENT
   * binding of this scope already holding that upstream id (the cross-row
   * (scope_key, opik_trace_id) unique index) refuses with 409 BINDING_TRACE_CONFLICT (R2-29):
   * the first claim stands, this row stays unreconciled, and a retry hears the same answer —
   * never the driver's constraint violation surfacing as a 500.
   *
   * WIRED (F5E1-F3, closing OCR R4-25's reservation): the observer binding gate
   * is the production caller — it materializes the run's upstream trace/root with
   * the verified port and records the derived id here, so a run's spans only ever
   * export under a binding that names the trace they attach to (the mapping is
   * authoritative before, not after, the export). The lost-acknowledgment path
   * the reservation described is the crash window between createTrace and this
   * call; the deterministic id derivation is what makes its retry safe (the
   * retry asks for the same objects). This remains the sole writer of
   * ai_observation_bindings.opik_trace_id, and begin/finish still never write it.
   */
  reconcile(
    scope: ObservationScope,
    runId: string,
    attemptId: string,
    opikTraceId: string,
  ): Promise<{ binding: RunBinding; adopted: boolean }>;
  /**
   * The binding terminal state's one production writer (the T37-registered G1 seam): the
   * run-termination event a terminal report carries moves the attempt's binding out of `running`
   * onto the state the lifecycle observed. The first terminal write wins — a replayed or
   * divergent later report changes nothing, exactly as the lifecycle refuses a straggler
   * terminal event — and a binding that is already gone (retention won the race) settles
   * nothing rather than resurrecting a row. This write is what makes the retention run
   * discovery (`state <> 'running'`) reachable for real production bindings.
   */
  finish(
    scope: ObservationScope,
    runId: string,
    attemptId: string,
    state: Exclude<AiObservationBindingState, "running">,
  ): Promise<{ binding: RunBinding | null; settled: boolean }>;
  /** Read one binding inside the caller's scope. Another scope's id is simply not found. */
  get(scope: ObservationScope, id: string): Promise<RunBinding | null>;
  /**
   * The most recent attempt of one run inside the caller's scope (T11's ownership
   * seam for reads). Another scope's run — same run id, different scope key — is
   * simply not found.
   */
  latestAttempt(
    scope: ObservationScope,
    runId: string,
  ): Promise<RunBinding | null>;
  /**
   * The capability verdicts for a page of upstream traces (Issue #18), joined on this
   * scope's own binding rows — the (scope, opik trace) unique index answers at most one
   * verdict per id, and a trace this scope never bound answers nothing at all, which the
   * caller renders as the honest "unavailable" rather than a guess.
   */
  capabilitiesByOpikTraceIds(
    scope: ObservationScope,
    opikTraceIds: readonly string[],
  ): Promise<ReadonlyMap<string, AiObservationBindingCapability>>;
  /**
   * How many of this scope's bindings began but never reconciled upstream (Issue #18) —
   * the positive evidence behind a list-level "still syncing" signal. Zero evidence is
   * zero, never a guess.
   */
  countUnreconciled(scope: ObservationScope): Promise<number>;
  /**
   * One exact attempt inside the caller's scope — the unambiguous run lookup the id
   * mapping's query seam reads (Issue #23/T17): run AND attempt, never a guess about
   * which attempt of several a reference meant.
   */
  attempt(
    scope: ObservationScope,
    runId: string,
    attemptId: string,
  ): Promise<RunBinding | null>;
  /**
   * The attempt an upstream trace id maps back to, inside the caller's scope — the
   * reverse direction of the run↔trace mapping. Another scope's trace id is simply
   * not found.
   */
  byOpikTrace(
    scope: ObservationScope,
    opikTraceId: string,
  ): Promise<RunBinding | null>;
};

const capabilities: readonly AiObservationBindingCapability[] = [
  "basic",
  "detailed",
  "unavailable",
];

/** The terminal vocabulary the schema's own CHECK admits beyond `running`. */
const terminalStates: readonly Exclude<AiObservationBindingState, "running">[] =
  ["completed", "failed", "canceled", "interrupted", "unknown"];

/** A non-empty opaque reference. Values are stored as-is; only emptiness is refused. */
function reference(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RunBindingError("BINDING_INPUT_INVALID", 400);
  }
  return value;
}

/**
 * The violated constraint's name when `error` is a Postgres unique_violation (SQLSTATE 23505),
 * else null. Bun's driver puts the SQLSTATE in `errno` and the constraint name in `constraint`;
 * drizzle wraps the driver error as `cause` (the same shape identity/store.ts classifies).
 */
function uniqueViolationConstraint(error: unknown): string | null {
  type Driver = { errno?: unknown; constraint?: unknown };
  const candidates = [
    error as Driver | null | undefined,
    (error as { cause?: Driver } | null | undefined)?.cause,
  ];
  for (const candidate of candidates) {
    if (candidate?.errno === "23505") {
      return typeof candidate.constraint === "string"
        ? candidate.constraint
        : "";
    }
  }
  return null;
}

export function createRunBindingStore(db: Database): RunBindingStore {
  const byAuthoritativeKey = (
    scope: ObservationScope,
    runId: string,
    attemptId: string,
  ) =>
    and(
      eq(aiObservationBindings.scopeKey, scope.key),
      eq(aiObservationBindings.runId, runId),
      eq(aiObservationBindings.attemptId, attemptId),
    );

  return {
    async begin(scope, input) {
      assertObservationScope(scope);
      const runId = reference(input.runId);
      const attemptId = reference(input.attemptId);
      reference(input.traceId);
      if (!capabilities.includes(input.capability)) {
        throw new RunBindingError("BINDING_INPUT_INVALID", 400);
      }
      if (
        !(input.expiresAt instanceof Date) ||
        Number.isNaN(input.expiresAt.getTime())
      ) {
        throw new RunBindingError("BINDING_INPUT_INVALID", 400);
      }

      const locator = resolveStorageLocator(scope);
      return db.transaction(async (tx) => {
        const inserted = await tx
          .insert(aiObservationBindings)
          .values({
            id: randomUUID(),
            scopeKey: scope.key,
            actorId: scope.actorId,
            botId: scope.botId,
            runId,
            attemptId,
            traceId: input.traceId,
            locatorWorkspace: locator.workspace,
            locatorProject: locator.project,
            capability: input.capability,
            state: "running",
            expiresAt: input.expiresAt,
          })
          .onConflictDoNothing({
            target: [
              aiObservationBindings.scopeKey,
              aiObservationBindings.runId,
              aiObservationBindings.attemptId,
            ],
          })
          .returning();
        if (inserted[0]) {
          return { binding: inserted[0], replayed: false };
        }

        // Someone else began this exact subject first: hand back their binding.
        const existing = await tx
          .select()
          .from(aiObservationBindings)
          .where(byAuthoritativeKey(scope, runId, attemptId));
        const replay = existing[0];
        if (!replay) {
          throw new Error(
            "begin conflicted but the conflicting binding is absent",
          );
        }
        return { binding: replay, replayed: true };
      });
    },

    async reconcile(scope, runId, attemptId, opikTraceId) {
      // OCR R4-25: RESERVED — NOT WIRED. This is opik_trace_id's only write site and
      // has zero production callers (tests only): the production run path is begin +
      // finish, and finish writes state only. Until a call site exists on the
      // lost-acknowledgment path (see the interface note above), every
      // reconciliation-dependent read answers its empty case by design. Deliberately
      // left unwired here — wiring it is a behavior change needing its own approved
      // Spec, not a defect fix.
      assertObservationScope(scope);
      reference(runId);
      reference(attemptId);
      reference(opikTraceId);

      return db.transaction(async (tx) => {
        // Lock the one row the authoritative key names, so a concurrent reconcile of the same
        // lost acknowledgment sees this call's outcome instead of racing it.
        const found = await tx
          .select()
          .from(aiObservationBindings)
          .where(byAuthoritativeKey(scope, runId, attemptId))
          .for("update");
        const current = found[0];
        if (!current) {
          // Reconciliation recovers a lost acknowledgment for a begun binding; it cannot create
          // one, because nothing upstream is allowed to assign local ownership.
          throw new RunBindingError("BINDING_NOT_FOUND", 404);
        }
        if (current.opikTraceId !== null) {
          // First recorded id wins: a replay of the same acknowledgment, or a divergent id
          // signalling upstream duplication, changes nothing here.
          return { binding: current, adopted: false };
        }
        let adoptedRow: RunBinding | undefined;
        try {
          const updated = await tx
            .update(aiObservationBindings)
            .set({ opikTraceId, updatedAt: new Date() })
            .where(eq(aiObservationBindings.id, current.id))
            .returning();
          adoptedRow = updated[0];
        } catch (error) {
          // R2-29: the (scope_key, opik_trace_id) unique index is the cross-row authority —
          // a DIFFERENT binding of this scope already recorded that upstream id (two local
          // runs reconciled onto one upstream trace). The first claim stands; this reconcile
          // is refused with a deterministic 409 instead of the driver's bare 23505 surfacing
          // as a 500 whose retry could never end differently. This row stays unreconciled.
          if (
            uniqueViolationConstraint(error) ===
            "ai_observation_bindings_scope_opik_trace_uq"
          ) {
            throw new RunBindingError("BINDING_TRACE_CONFLICT", 409);
          }
          throw error;
        }
        if (!adoptedRow) {
          throw new Error("reconcile updated a row it cannot read back");
        }
        return { binding: adoptedRow, adopted: true };
      });
    },

    async finish(scope, runId, attemptId, state) {
      assertObservationScope(scope);
      reference(runId);
      reference(attemptId);
      if (!terminalStates.includes(state)) {
        // `running` is not an outcome; nothing may write it back onto a binding.
        throw new RunBindingError("BINDING_INPUT_INVALID", 400);
      }

      return db.transaction(async (tx) => {
        // Lock the one row the authoritative key names, so two concurrent settles of
        // the same attempt race in the database and exactly one wins.
        const found = await tx
          .select()
          .from(aiObservationBindings)
          .where(byAuthoritativeKey(scope, runId, attemptId))
          .for("update");
        const current = found[0];
        if (!current) {
          // A settle can only move a binding that is there. One retention already
          // deleted is beyond settling — and never resurrected by a straggler report.
          return { binding: null, settled: false };
        }
        if (current.state !== "running") {
          // First terminal write wins; the standing outcome is the answer.
          return { binding: current, settled: false };
        }
        const updated = await tx
          .update(aiObservationBindings)
          .set({ state, updatedAt: new Date() })
          .where(eq(aiObservationBindings.id, current.id))
          .returning();
        const settled = updated[0];
        if (!settled) {
          throw new Error("finish updated a row it cannot read back");
        }
        return { binding: settled, settled: true };
      });
    },

    async get(scope, id) {
      assertObservationScope(scope);
      reference(id);
      const rows = await db
        .select()
        .from(aiObservationBindings)
        .where(
          and(
            eq(aiObservationBindings.id, id),
            eq(aiObservationBindings.scopeKey, scope.key),
          ),
        );
      return rows[0] ?? null;
    },

    async latestAttempt(scope, runId) {
      assertObservationScope(scope);
      reference(runId);
      const rows = await db
        .select()
        .from(aiObservationBindings)
        .where(
          and(
            eq(aiObservationBindings.scopeKey, scope.key),
            eq(aiObservationBindings.runId, runId),
            // The M1a visibility rule: a binding under retention deletion is gone
            // to readers from discovery on — the latest attempt falls back to the
            // next one that is not being deleted.
            notPendingDeletion("run", aiObservationBindings.id),
          ),
        )
        // Attempt order is CREATION order (OCR m104): reconcile and finish both
        // bump updatedAt, so an old attempt refreshed by a late reconcile must
        // never outrank the attempt that actually superseded it.
        .orderBy(
          desc(aiObservationBindings.createdAt),
          desc(aiObservationBindings.updatedAt),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async capabilitiesByOpikTraceIds(scope, opikTraceIds) {
      assertObservationScope(scope);
      // inArray with an empty list is not a query anyone can answer; it is no rows.
      if (opikTraceIds.length === 0) return new Map();
      const rows = await db
        .select({
          opikTraceId: aiObservationBindings.opikTraceId,
          capability: aiObservationBindings.capability,
        })
        .from(aiObservationBindings)
        .where(
          and(
            eq(aiObservationBindings.scopeKey, scope.key),
            inArray(aiObservationBindings.opikTraceId, [
              ...new Set(opikTraceIds),
            ]),
            // The M1a visibility rule, capability-shaped (OCR m105): a run whose
            // deletion is in flight is gone to readers, its capability verdict
            // included — same answer window as latestAttempt.
            notPendingDeletion("run", aiObservationBindings.id),
          ),
        );
      const verdicts = new Map<string, AiObservationBindingCapability>();
      for (const row of rows) {
        if (row.opikTraceId !== null)
          verdicts.set(row.opikTraceId, row.capability);
      }
      return verdicts;
    },

    async countUnreconciled(scope) {
      assertObservationScope(scope);
      // Soft-deleted rows stop being evidence here — unlike the reads above, which
      // do not filter on deletedAt; an expired-but-live binding is still an
      // unconfirmed record and still counts.
      const rows = await db
        .select({ value: count() })
        .from(aiObservationBindings)
        .where(
          and(
            eq(aiObservationBindings.scopeKey, scope.key),
            isNull(aiObservationBindings.opikTraceId),
            isNull(aiObservationBindings.deletedAt),
          ),
        );
      return rows[0]?.value ?? 0;
    },

    async attempt(scope, runId, attemptId) {
      assertObservationScope(scope);
      reference(runId);
      reference(attemptId);
      const rows = await db
        .select()
        .from(aiObservationBindings)
        .where(
          and(
            byAuthoritativeKey(scope, runId, attemptId),
            // The M1a visibility rule, authoritative-key-shaped (OCR m105): a
            // deletion-in-flight attempt answers not-found like any other reader.
            notPendingDeletion("run", aiObservationBindings.id),
          ),
        );
      return rows[0] ?? null;
    },

    async byOpikTrace(scope, opikTraceId) {
      assertObservationScope(scope);
      reference(opikTraceId);
      const rows = await db
        .select()
        .from(aiObservationBindings)
        .where(
          and(
            eq(aiObservationBindings.scopeKey, scope.key),
            eq(aiObservationBindings.opikTraceId, opikTraceId),
            // The M1a visibility rule, id-mapping-shaped (OCR m105): the private
            // API's reverse lookup cannot resolve a run that is being deleted —
            // the same answer the detail reads give, no operator-only side door.
            notPendingDeletion("run", aiObservationBindings.id),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
  };
}

/*
 * ---------------------------------------------------------------------------
 * The observer-path binding gate (FREV-02)
 * ---------------------------------------------------------------------------
 */

/**
 * The chain id when provable — a W3C 32-hex trace id — else null. This is the
 * binding gate's identity test: the run's chain is the one identity every
 * builtin fact already carries, and an observation whose chain cannot be
 * proven has no local authority to export under.
 */
export function observerChainId(traceId: string | undefined): string | null {
  return traceId !== undefined && W3C_TRACE_ID.test(traceId) ? traceId : null;
}

/** The run a builtin observation binds as, keyed by what the fact face carries. */
export type ObserverRunChain = Readonly<{
  /** The run's W3C trace id — the chain every span of the run joins. */
  traceId: string;
  /**
   * The run/attempt identity, when the fact honestly carried one (the
   * tool-step seam's run association, when that threading lands). Absent —
   * every wiring today — binds the chain itself as the run: one attempt per
   * chain, origin stated in the id.
   */
  runRef?: Readonly<{ runId: string; attemptId: string }>;
}>;

export type ObserverRunBindingGate = Readonly<{
  /**
   * The chain's local authoritative binding, established (begin, idempotent)
   * or replayed, BEFORE any business span of the run is exported. A store or
   * constraint failure rejects; the caller fails the write closed on it — the
   * span is not exported, and the drop is counted where the write queue
   * counts every failure, never silent, never a faked success.
   *
   * F5E1-F3: when the deployment has a verified port, this same call materializes
   * the chain's upstream trace and run root and records the authoritative mapping
   * (see `materialize`) — the ref it answers carries the upstream trace id, which is
   * what the port completes the business spans with.
   */
  ensure(
    scope: ObservationScope,
    chain: ObserverRunChain,
  ): Promise<OpikRunBindingRef>;
  /**
   * Settle the chain's binding from an observed run close — the tool-step
   * window is the one run-close signal the fact face observes. An interrupted
   * close settles `interrupted`; a terminal close without an outcome the fact
   * could name settles the explicitly-unlearned `unknown` (RUN_ERROR and
   * RUN_FINISHED both close terminal there, and the difference is not carried
   * — claiming completed or failed would invent it). First settle wins per
   * chain; a settle that fails leaves the row running and the lease sweeper's
   * `unknown` is the net, exactly as for a reporter that died mid-run.
   */
  settleObservedWindow(
    scope: ObservationScope,
    chain: ObserverRunChain,
    window: "interrupted" | "terminal",
  ): void;
}>;

/** One binding row as the port's write guard reads it. */
function observerBindingRef(row: RunBinding): OpikRunBindingRef {
  return {
    scopeKey: row.scopeKey,
    runId: row.runId,
    attemptId: row.attemptId,
    locatorWorkspace: row.locatorWorkspace,
    locatorProject: row.locatorProject,
    opikTraceId: row.opikTraceId,
  };
}

/** A non-empty carried reference; `null` when the fact carried none usable. */
function carriedRef(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** The safe label a gate failure logs and nothing else — no ids, no content. */
function gateReason(error: unknown): string {
  return error instanceof RunBindingError ? error.code : "error";
}

/** The builtin path observes its own internal steps, so its capability is detailed. */
const OBSERVER_CAPABILITY: AiObservationBindingCapability = "detailed";
/** The same seven-day lease the HTTP report path writes (routes/basic-run.ts). */
const DEFAULT_OBSERVER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * The run root span's name — the tree's own word for the run, never projected text (the
 * port refuses a withheld name because the read-back locates spans by name).
 */
const RUN_ROOT_SPAN_NAME: SafeText = { state: "projected", text: "run" };
/** Bounded memory: recent chains per scope, and scopes, before FIFO eviction. */
const DEFAULT_MAX_CHAINS_PER_SCOPE = 2048;
const DEFAULT_MAX_SCOPES = 4096;

type ScopeChains = {
  begun: Map<string, Promise<OpikRunBindingRef>>;
  settled: Set<string>;
  /** Insertion order of `begun`, the FIFO the bound evicts by. */
  order: string[];
};

export function createObserverRunBindingGate(
  store: Pick<RunBindingStore, "begin" | "finish"> &
    Partial<Pick<RunBindingStore, "reconcile">>,
  options: Readonly<{
    now?: () => Date;
    ttlMs?: number;
    maxChainsPerScope?: number;
    maxScopes?: number;
    /**
     * F5E1-F3: the verified port behind this deployment, asked for at the moment a
     * chain's upstream objects are materialized. Absent (or answering null — an
     * Opik-disabled or unverified deployment) keeps the gate's earlier shape: bindings
     * only, no upstream identity, the write completing without it (the tests' seam).
     */
    port?: () => OpikPort | null;
  }> = {},
): ObserverRunBindingGate {
  const log = getLogger("server");
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? DEFAULT_OBSERVER_TTL_MS;
  const maxChains = options.maxChainsPerScope ?? DEFAULT_MAX_CHAINS_PER_SCOPE;
  const maxScopes = options.maxScopes ?? DEFAULT_MAX_SCOPES;
  const scopes = new Map<string, ScopeChains>();

  /*
   * F5E1-F3's first half: materialize the run's upstream objects at the one confirmed
   * execution-lifecycle point this path has — the moment the chain's authoritative binding
   * is established, which is before the run's first business span may be exported. The
   * trace row is what makes the run listable upstream; the root span is the parent every
   * business span of the chain names; the reconcile is what makes the mapping authoritative
   * (and what the query face and retention read). A run whose upstream objects cannot be
   * established exports nothing — the failure is closed, not degraded, because a span that
   * lands where the binding cannot name it is exactly the unattributable write the port
   * refuses elsewhere.
   *
   * Ordering on the crash path: create, root, THEN reconcile. A crash between the create
   * and the reconcile leaves upstream objects the deterministic derivation finds again on
   * the retry; a reconcile written first could claim a tree nobody wrote.
   */
  const materialize = async (
    scope: ObservationScope,
    ref: OpikRunBindingRef,
    traceId: string,
  ): Promise<OpikRunBindingRef> => {
    const port = options.port?.() ?? null;
    if (port === null) return ref;
    if (ref.opikTraceId !== null) return ref; // already materialized by an earlier pass
    const reconcile = store.reconcile;
    if (reconcile === undefined) {
      // A port without the authoritative store's mapping write is a wiring defect: fail
      // loudly rather than export under an identity nobody records.
      throw new RunBindingError("BINDING_UPSTREAM_UNAVAILABLE", 503);
    }
    const identity = runUpstreamIdentity(traceId);
    const startedAt = now();
    const created = await port.createTrace(scope, {
      traceId: identity.opikTraceId,
      name: RUN_ROOT_SPAN_NAME,
      startTime: startedAt,
      binding: ref,
    });
    if (created.outcome !== "ok") {
      throw new RunBindingError("BINDING_UPSTREAM_UNAVAILABLE", 503);
    }
    const rootSpan: OpikOtlpSpan = {
      traceId,
      spanId: identity.rootSpanId,
      name: RUN_ROOT_SPAN_NAME,
      startTimeUnixNano: nanos(startedAt) ?? nowNs(),
      // The root's close is not observed here — an end time would be a duration nobody
      // measured, so the row stays open and the query face reports what it knows.
      opik: {
        traceId: identity.opikTraceId,
        spanId: identity.rootOpikSpanId,
      },
    };
    const rooted = await port.writeSpans(scope, {
      spans: [rootSpan],
      binding: { ...ref, opikTraceId: identity.opikTraceId },
    });
    if (rooted.outcome !== "ok") {
      throw new RunBindingError("BINDING_UPSTREAM_UNAVAILABLE", 503);
    }
    // The authoritative mapping: the binding now names the trace its spans attach to.
    const reconciled = await reconcile(
      scope,
      ref.runId,
      ref.attemptId,
      identity.opikTraceId,
    );
    return observerBindingRef(reconciled.binding);
  };

  const chainsOf = (scope: ObservationScope): ScopeChains => {
    const existing = scopes.get(scope.key);
    if (existing !== undefined) return existing;
    // Bound the scope map itself the same way each scope's chains are bounded:
    // an evicted scope re-begins on its next fact, idempotently.
    if (scopes.size >= maxScopes) {
      const oldest = scopes.keys().next().value;
      if (oldest !== undefined) scopes.delete(oldest);
    }
    const fresh: ScopeChains = {
      begun: new Map(),
      settled: new Set(),
      order: [],
    };
    scopes.set(scope.key, fresh);
    return fresh;
  };

  const ensure = async (
    scope: ObservationScope,
    chain: ObserverRunChain,
  ): Promise<OpikRunBindingRef> => {
    const traceId = observerChainId(chain.traceId);
    if (traceId === null) {
      throw new RunBindingError("BINDING_INPUT_INVALID", 400);
    }
    const carriedRunId = carriedRef(chain.runRef?.runId);
    const carriedAttemptId = carriedRef(chain.runRef?.attemptId);
    if (
      chain.runRef !== undefined &&
      (carriedRunId === null || carriedAttemptId === null)
    ) {
      // A runRef was carried but unusable: an association that names the run
      // half-honestly is worse than none — refuse rather than bind the chain
      // under an id the caller thought it had overridden.
      throw new RunBindingError("BINDING_INPUT_INVALID", 400);
    }
    // No carried runRef — the default — binds the chain itself as the run:
    // one attempt per chain, origin stated in the id.
    const runId = carriedRunId ?? `builtin:${traceId}`;
    const attemptId = carriedAttemptId ?? `builtin:${traceId}`;
    const chains = chainsOf(scope);
    const pending = chains.begun.get(traceId);
    if (pending !== undefined) return pending;

    const attempt = (async () => {
      const { binding } = await store.begin(scope, {
        runId,
        attemptId,
        traceId,
        capability: OBSERVER_CAPABILITY,
        expiresAt: new Date(now().getTime() + ttlMs),
      });
      if (binding.traceId !== traceId) {
        // The authoritative row exists and names a different chain: the first
        // claim stands (the reconcile discipline), and a run whose spans would
        // export under a row that disagrees with them exports nothing.
        throw new RunBindingError("BINDING_TRACE_CONFLICT", 409);
      }
      // F5E1-F3: the binding is established, so the run's upstream trace/root and its
      // authoritative mapping are established here too — before any business span of the
      // chain may be exported under it.
      return materialize(scope, observerBindingRef(binding), traceId);
    })();
    chains.begun.set(traceId, attempt);
    chains.order.push(traceId);
    if (chains.order.length > maxChains) {
      const oldest = chains.order.shift();
      if (oldest !== undefined) {
        chains.begun.delete(oldest);
        chains.settled.delete(oldest);
      }
    }
    try {
      return await attempt;
    } catch (error) {
      // A failed establishment is not cached: the database may come back, and
      // the next fact of the run asks again — each failure fails only the
      // facts whose write it gated.
      chains.begun.delete(traceId);
      const at = chains.order.indexOf(traceId);
      if (at >= 0) chains.order.splice(at, 1);
      log.warn(
        {
          type: "opik-observer-binding-begin-failed",
          reason: gateReason(error),
        },
        "opik-observer-binding-begin-failed",
      );
      throw error;
    }
  };

  return {
    ensure,
    settleObservedWindow(scope, chain, window) {
      const traceId = observerChainId(chain.traceId);
      if (traceId === null) return; // nothing provable to settle
      const chains = chainsOf(scope);
      if (chains.settled.has(traceId)) return; // first settle wins
      chains.settled.add(traceId);
      const state = window === "interrupted" ? "interrupted" : "unknown";
      void ensure(scope, chain)
        .then((binding) =>
          store.finish(scope, binding.runId, binding.attemptId, state),
        )
        .catch((error) => {
          // Undo the once-mark so a later observed close retries; until one
          // lands, the row stays running and the lease sweeper is the net.
          chains.settled.delete(traceId);
          log.warn(
            {
              type: "opik-observer-binding-settle-failed",
              reason: gateReason(error),
            },
            "opik-observer-binding-settle-failed",
          );
        });
    },
  };
}

/** A binding ref consistent with `scope`, for suites driving the recorders
 * without a store (the meteredModelForTests pattern: a test seam, never wired
 * in production). */
export function observerBindingRefForTests(
  scope: ObservationScope,
  run: Readonly<{
    runId?: string;
    attemptId?: string;
    opikTraceId?: string | null;
  }> = {},
): OpikRunBindingRef {
  const locator = resolveStorageLocator(scope);
  return {
    scopeKey: scope.key,
    runId: run.runId ?? "run-test",
    attemptId: run.attemptId ?? "attempt-test",
    locatorWorkspace: locator.workspace,
    locatorProject: locator.project,
    opikTraceId: run.opikTraceId ?? null,
  };
}

/** Test-only: a gate over no store — ensure always answers the consistent ref
 * for the scope it is asked about, settle is a no-op. The binding loop itself
 * is proven against the real store in the bindings suites. */
export function observerRunBindingGateForTests(): ObserverRunBindingGate {
  return {
    ensure: async (scope) => observerBindingRefForTests(scope),
    settleObservedWindow: () => {},
  };
}
