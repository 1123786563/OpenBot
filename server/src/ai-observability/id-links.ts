/**
 * The OpenBot↔Opik id-mapping seam for step-level subjects (Issue #23 / DAG T17).
 *
 * The trusted-store half, on the T07 bindings pattern: a link's ownership fields are
 * copied out of a scope this process issued, the caller contributes only the local and
 * upstream references, and `assertObservationScope` fails closed on anything else — a
 * forged scope cannot reach the database even once. Run↔trace and dataset↔dataset are
 * NOT re-minted here: the binding and dataset tables already own those facts, and a
 * second copy could only diverge from them. This table holds what neither has: the
 * local step id against the upstream span id this deployment chose and the backend
 * adopted verbatim.
 *
 * Chain integrity is the ticket's broken-link detection, made a database-adjacent
 * fact rather than a log line: a link that names a run whose binding carries a
 * DIFFERENT W3C trace id than the one the segment observed is `chain_broken`, and
 * nothing is written. A divergent upstream id for an already-linked step — upstream
 * duplication — changes nothing either, exactly as T07's reconcile treats a divergent
 * trace acknowledgment.
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { aiObservationIdLinks } from "../db/schema/ai-observability-id-links";
import type { RunBindingStore } from "./bindings";
import type { ObservationScope } from "./contracts";
import { denyReason } from "./redaction";
import { assertObservationScope } from "./scope";

export type IdLinkLocalKind = "tool_step" | "retrieval_step";
export type IdLinkUpstreamKind = "span";

export type IdLinkRow = typeof aiObservationIdLinks.$inferSelect;

export type IdLinkInput = Readonly<{
  local: Readonly<{ kind: IdLinkLocalKind; id: string }>;
  upstream: Readonly<{ kind: IdLinkUpstreamKind; id: string }>;
  /** The run/attempt the linked step belonged to, when known — the chain-check key. */
  runRef?: Readonly<{ runId: string; attemptId: string }>;
  /** The W3C trace id the segment actually carried: the chain-check evidence. */
  observedTraceId: string;
}>;

export type IdLinkVerdict =
  | { linked: true; replayed: boolean }
  /** The segment's trace is not the run binding's trace: a broken chain, nothing written. */
  | { linked: false; reason: "chain_broken" }
  /** A divergent upstream id for an already-linked subject signals upstream duplication. */
  | { linked: false; reason: "divergent" };

export type IdLinkErrorCode = "ID_LINK_INPUT_INVALID";

export class IdLinkError extends Error {
  constructor(
    public code: IdLinkErrorCode,
    public status: 400,
  ) {
    super(code);
  }
}

const LOCAL_KINDS: readonly IdLinkLocalKind[] = ["tool_step", "retrieval_step"];
const UPSTREAM_KINDS: readonly IdLinkUpstreamKind[] = ["span"];

/** Ids are long but not unbounded; a mapping row is a locator, not a payload. */
const MAX_ID_CHARS = 256;

/**
 * A control character makes an id ambiguous to every later consumer of the row.
 * Scanned by code point rather than a regex, so the pattern itself carries no
 * control characters to lint.
 */
function hasControlCharacter(value: string): boolean {
  for (let position = 0; position < value.length; position += 1) {
    const code = value.charCodeAt(position);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * One id safe to store as a mapping endpoint. The credential deny patterns refuse the
 * canary classes verbatim — an identifier that carries a secret leaks it into every
 * query answer, so it is refused, never stored and never projected.
 */
export function validateLinkId(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new IdLinkError("ID_LINK_INPUT_INVALID", 400);
  }
  if (value.length > MAX_ID_CHARS || hasControlCharacter(value)) {
    throw new IdLinkError("ID_LINK_INPUT_INVALID", 400);
  }
  if (denyReason(value) !== undefined) {
    throw new IdLinkError("ID_LINK_INPUT_INVALID", 400);
  }
  return value;
}

/** The chain-check evidence: same refusal discipline, one opaque reference. */
export function validateTraceRef(value: string): string {
  // One implementation, no drift: the rules are the local link id's, exactly.
  return validateLinkId(value);
}

export type IdLinkStore = {
  /**
   * Records one mapping, or refuses it. Refusals are verdicts, not errors: a broken
   * chain is a detected fact (acceptance 1's detection half), and a divergent id is
   * upstream duplication. Only malformed input and forged scopes throw.
   */
  link(scope: ObservationScope, input: IdLinkInput): Promise<IdLinkVerdict>;
  /** The upstream reference one local subject maps to, inside the caller's scope. */
  byLocal(
    scope: ObservationScope,
    kind: IdLinkLocalKind,
    id: string,
  ): Promise<IdLinkRow | null>;
  /** The local subject one upstream reference maps to, inside the caller's scope. */
  byUpstream(
    scope: ObservationScope,
    kind: IdLinkUpstreamKind,
    id: string,
  ): Promise<IdLinkRow | null>;
};

export function createIdLinkStore(
  db: Database,
  deps: Readonly<{
    /** The authoritative run bindings, for the chain check. Optional for tests. */
    bindings?: Pick<RunBindingStore, "attempt">;
  }> = {},
): IdLinkStore {
  const byLocalKey = (
    scope: ObservationScope,
    kind: IdLinkLocalKind,
    id: string,
  ) =>
    and(
      eq(aiObservationIdLinks.scopeKey, scope.key),
      eq(aiObservationIdLinks.localKind, kind),
      eq(aiObservationIdLinks.localId, id),
    );

  return {
    async link(scope, input) {
      assertObservationScope(scope);
      if (!LOCAL_KINDS.includes(input.local.kind)) {
        throw new IdLinkError("ID_LINK_INPUT_INVALID", 400);
      }
      if (!UPSTREAM_KINDS.includes(input.upstream.kind)) {
        throw new IdLinkError("ID_LINK_INPUT_INVALID", 400);
      }
      const localId = validateLinkId(input.local.id);
      const upstreamId = validateLinkId(input.upstream.id);
      const observedTraceId = validateTraceRef(input.observedTraceId);
      const runId = input.runRef ? validateLinkId(input.runRef.runId) : null;
      const attemptId = input.runRef
        ? validateLinkId(input.runRef.attemptId)
        : null;

      // The chain check: a step claiming a run whose binding carries a different
      // W3C trace id than the segment observed is a broken link. The binding is
      // read through the same scope-asserted seam everything else here is.
      if (runId !== null && attemptId !== null && deps.bindings !== undefined) {
        const binding = await deps.bindings.attempt(scope, runId, attemptId);
        if (binding !== null && binding.traceId !== observedTraceId) {
          return { linked: false, reason: "chain_broken" };
        }
        // No binding: nothing authoritative to disagree with; the step id stands
        // on its own and the link proceeds without a verified chain.
      }

      return db.transaction(async (tx) => {
        const inserted = await tx
          .insert(aiObservationIdLinks)
          .values({
            id: randomUUID(),
            scopeKey: scope.key,
            actorId: scope.actorId,
            botId: scope.botId,
            localKind: input.local.kind,
            localId,
            upstreamKind: input.upstream.kind,
            upstreamId,
            runId,
            observedTraceId,
          })
          // No conflict target: EITHER unique key firing means "the standing
          // mapping wins", which the selects below turn into a verdict. Naming
          // only the local key would let the upstream key surface as a raw
          // unique_violation instead of the divergent verdict (T17 review L-1a).
          .onConflictDoNothing()
          .returning();
        if (inserted[0]) {
          return { linked: true, replayed: false };
        }

        // The subject is already linked, or the upstream id is already claimed by
        // another subject: the standing mapping wins either way.
        const existing = await tx
          .select()
          .from(aiObservationIdLinks)
          .where(byLocalKey(scope, input.local.kind, localId));
        const current = existing[0];
        if (current) {
          return current.upstreamId === upstreamId
            ? { linked: true, replayed: true }
            : { linked: false, reason: "divergent" };
        }
        const claimed = await tx
          .select()
          .from(aiObservationIdLinks)
          .where(
            and(
              eq(aiObservationIdLinks.scopeKey, scope.key),
              eq(aiObservationIdLinks.upstreamKind, input.upstream.kind),
              eq(aiObservationIdLinks.upstreamId, upstreamId),
            ),
          );
        if (claimed[0]) {
          return { linked: false, reason: "divergent" };
        }
        throw new Error("link conflicted but the conflicting row is absent");
      });
    },

    async byLocal(scope, kind, id) {
      assertObservationScope(scope);
      const localId = validateLinkId(id);
      if (!LOCAL_KINDS.includes(kind)) {
        throw new IdLinkError("ID_LINK_INPUT_INVALID", 400);
      }
      const rows = await db
        .select()
        .from(aiObservationIdLinks)
        .where(byLocalKey(scope, kind, localId));
      return rows[0] ?? null;
    },

    async byUpstream(scope, kind, id) {
      assertObservationScope(scope);
      const upstreamId = validateLinkId(id);
      if (!UPSTREAM_KINDS.includes(kind)) {
        throw new IdLinkError("ID_LINK_INPUT_INVALID", 400);
      }
      const rows = await db
        .select()
        .from(aiObservationIdLinks)
        .where(
          and(
            eq(aiObservationIdLinks.scopeKey, scope.key),
            eq(aiObservationIdLinks.upstreamKind, kind),
            eq(aiObservationIdLinks.upstreamId, upstreamId),
          ),
        );
      return rows[0] ?? null;
    },
  };
}
