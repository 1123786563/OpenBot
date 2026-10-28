import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  type AiObservationBindingCapability,
  type AiObservationBindingState,
  aiObservationBindings,
} from "../db/schema/ai-observability-bindings";
import type { ObservationScope } from "./contracts";
import { notPendingDeletion } from "./retention";
import { assertObservationScope, resolveStorageLocator } from "./scope";

/**
 * The trusted seam between T06's ObservationScope and the binding table.
 *
 * A binding's ownership fields are copied out of a scope this process issued — the caller
 * contributes run, attempt and trace references, never an actor, bot, scope or locator of its
 * own. `assertObservationScope` fails closed on anything else, so a forged scope cannot reach
 * the database even once. Opik metadata is never read here and never could assign ownership:
 * reconciliation is keyed by the authoritative local (scope, run, attempt) triple, and the
 * upstream trace id is a value it records, not an identity it derives from.
 */

export type RunBindingErrorCode =
  | "BINDING_INPUT_INVALID"
  | "BINDING_NOT_FOUND"
  /**
   * R2-29: the (scope_key, opik_trace_id) unique index refused the reconcile —
   * another live binding of this scope already recorded that upstream id. The
   * first claim stands; this attempt stays unreconciled and the caller hears a
   * deterministic 409, never the driver's bare constraint violation as a 500.
   */
  | "BINDING_TRACE_CONFLICT";

export class RunBindingError extends Error {
  constructor(
    public code: RunBindingErrorCode,
    public status: 400 | 404 | 409,
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
   * RESERVED — NOT WIRED (OCR R4-25): no production caller exists (full-tree
   * grep: only the test suites reach it; the run-report path stops at begin +
   * finish, and finish never writes opikTraceId). This method is therefore the
   * sole writer of ai_observation_bindings.opik_trace_id, so until it is wired
   * every reconciliation-dependent read is trivial rather than informative: the
   * unreconciled listing holds every binding, countUnreconciled counts them all,
   * and the 409 conflict branch is unreachable. Wiring
   * precondition: a production call site on the run-report/acknowledgment path
   * that can observe the upstream trace id after a lost local ack — do not
   * fake one, and do not widen begin/finish to write the id (that would
   * change begin/finish's recorded contract and the R2-51 pendingSync
   * semantics) without re-approving the behavior through a Spec first.
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
 * else null. Bun's driver puts the SQLSTATE in `errno` (some wrappers surface it as `code`)
 * and the constraint name in `constraint`; drizzle wraps the driver error as `cause`
 * (the same shape identity/store.ts classifies — every level of the cause chain is probed).
 */
function uniqueViolationConstraint(error: unknown): string | null {
  type Driver = { errno?: unknown; code?: unknown; constraint?: unknown };
  const candidates: Driver[] = [];
  for (
    let current: unknown = error;
    current !== null && typeof current === "object";
    current = (current as { cause?: unknown }).cause
  ) {
    candidates.push(current as Driver);
  }
  for (const candidate of candidates) {
    if (candidate?.errno === "23505" || candidate?.code === "23505") {
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
