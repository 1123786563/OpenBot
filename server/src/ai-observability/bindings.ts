import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  type AiObservationBindingCapability,
  aiObservationBindings,
} from "../db/schema/ai-observability-bindings";
import type { ObservationScope } from "./contracts";
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

export type RunBindingErrorCode = "BINDING_INPUT_INVALID" | "BINDING_NOT_FOUND";

export class RunBindingError extends Error {
  constructor(
    public code: RunBindingErrorCode,
    public status: 400 | 404,
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
   * divergent later id signals upstream duplication and changes nothing here.
   */
  reconcile(
    scope: ObservationScope,
    runId: string,
    attemptId: string,
    opikTraceId: string,
  ): Promise<{ binding: RunBinding; adopted: boolean }>;
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

/** A non-empty opaque reference. Values are stored as-is; only emptiness is refused. */
function reference(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RunBindingError("BINDING_INPUT_INVALID", 400);
  }
  return value;
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
        const updated = await tx
          .update(aiObservationBindings)
          .set({ opikTraceId, updatedAt: new Date() })
          .where(eq(aiObservationBindings.id, current.id))
          .returning();
        const adopted = updated[0];
        if (!adopted) {
          throw new Error("reconcile updated a row it cannot read back");
        }
        return { binding: adopted, adopted: true };
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
          ),
        )
        .orderBy(desc(aiObservationBindings.updatedAt))
        .limit(1);
      return rows[0] ?? null;
    },

    async attempt(scope, runId, attemptId) {
      assertObservationScope(scope);
      reference(runId);
      reference(attemptId);
      const rows = await db
        .select()
        .from(aiObservationBindings)
        .where(byAuthoritativeKey(scope, runId, attemptId));
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
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
  };
}
