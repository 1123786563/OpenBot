/**
 * The bidirectional OpenBot↔Opik id-mapping query service (Issue #23 / DAG T17).
 *
 * T11's read-surface discipline, applied to the mapping instead of the trace rows:
 * every answer goes through a trusted ObservationScope and the authoritative
 * ownership tables — a subject this scope did not bind is simply not found before
 * any other work, so guessed ids learn nothing. The seam reads, never writes, and
 * touches no upstream: the mapping's authority is local by design.
 *
 * Three kinds of subject, three authoritative homes, one answer shape:
 *   - run_attempt ↔ trace: the binding table (T07). Unreconciled bindings answer
 *     an explicit null — begun locally, no upstream copy claimed — never a guess.
 *   - tool_step/retrieval_step ↔ span: the id-link table (this ticket), where a
 *     row exists only after the span's upstream write actually landed.
 *   - dataset ↔ dataset: the dataset table (T19). A pending or failed sync has
 *     no upstream id to answer, and says so as null.
 *
 * Both directions are unambiguous by construction: every underlying key carries
 * the scope key, and each (scope, subject) answers at most one upstream id.
 */

import type { RunBindingStore } from "../bindings";
import type { ObservationScope } from "../contracts";
import type { ObservationDatasetStore } from "../datasets";
import {
  type IdLinkLocalKind,
  type IdLinkStore,
  IdLinkError,
  type IdLinkUpstreamKind,
} from "../id-links";
import { validateLinkId } from "../id-links";

export type LocalSubjectRef =
  | { kind: "run_attempt"; runId: string; attemptId: string }
  | { kind: IdLinkLocalKind; id: string }
  | { kind: "dataset"; id: string };

export type UpstreamSubjectRef = {
  kind: "trace" | IdLinkUpstreamKind | "dataset";
  id: string;
};

export type IdLinkQueryErrorCode =
  | "ID_LINK_QUERY_INPUT_INVALID"
  | "SUBJECT_NOT_FOUND";

/** House convention: the code is the contract; nothing else rides along. */
export class IdLinkQueryError extends Error {
  constructor(
    public code: IdLinkQueryErrorCode,
    public status: 400 | 404,
  ) {
    super(code);
  }
}

export type IdLinkQueryService = {
  /**
   * The upstream reference one local subject maps to, or an explicit null when the
   * subject exists but has no upstream copy claimed. A subject this scope does not
   * own is SUBJECT_NOT_FOUND, never an empty answer. What "exists" means is per
   * home: a run attempt is its binding row, a dataset is its dataset row (a
   * pending/failed sync answers null), and a step is its id-link row — a step
   * without a link row was never bound here, so it is SUBJECT_NOT_FOUND, and a
   * linked step's upstream copy is guaranteed to have landed. `recordedAt` is the
   * subject's own last-touch on its home table (bindings and datasets refresh
   * `updatedAt`; a link row keeps `createdAt`) — when the mapping became what it
   * is, never a separate mapping ledger's stamp.
   */
  resolveByLocal(
    scope: ObservationScope,
    ref: LocalSubjectRef,
  ): Promise<{
    upstream: {
      kind: UpstreamSubjectRef["kind"];
      id: string;
      recordedAt: string;
    } | null;
  }>;
  /**
   * The local subject one upstream reference maps to, or null when this scope never
   * mapped it. A guessed upstream id learns nothing — not even whether it exists.
   */
  resolveByUpstream(
    scope: ObservationScope,
    ref: UpstreamSubjectRef,
  ): Promise<{ subject: { ref: LocalSubjectRef; recordedAt: string } | null }>;
};

export type IdLinkQueryServiceDeps = Readonly<{
  bindings: Pick<RunBindingStore, "attempt" | "byOpikTrace">;
  links: Pick<IdLinkStore, "byLocal" | "byUpstream">;
  datasets: Pick<ObservationDatasetStore, "getDataset" | "byOpikDatasetId">;
}>;

export function createIdLinkQueryService(
  deps: IdLinkQueryServiceDeps,
): IdLinkQueryService {
  const localId = (value: string): string => {
    try {
      return validateLinkId(value);
    } catch (error) {
      // Only the validator's own refusals are a client input problem; anything else
      // (a bug, a config failure) must surface as the failure it is, not a 400.
      if (!(error instanceof IdLinkError)) throw error;
      throw new IdLinkQueryError("ID_LINK_QUERY_INPUT_INVALID", 400);
    }
  };

  const resolveByLocal: IdLinkQueryService["resolveByLocal"] = async (
    scope,
    ref,
  ) => {
    switch (ref.kind) {
      case "run_attempt": {
        const runId = localId(ref.runId);
        const attemptId = localId(ref.attemptId);
        const binding = await deps.bindings.attempt(scope, runId, attemptId);
        if (binding === null) {
          throw new IdLinkQueryError("SUBJECT_NOT_FOUND", 404);
        }
        return {
          upstream:
            binding.opikTraceId === null
              ? null
              : {
                  kind: "trace" as const,
                  id: binding.opikTraceId,
                  recordedAt: binding.updatedAt.toISOString(),
                },
        };
      }
      case "tool_step":
      case "retrieval_step": {
        const id = localId(ref.id);
        const link = await deps.links.byLocal(scope, ref.kind, id);
        if (link === null) {
          // The id-link row is the step's sole existence record (header): a step
          // this scope never linked has no subject to answer about, so the
          // contract's SUBJECT_NOT_FOUND is the honest shape. `upstream: null` is
          // reserved for a subject that exists but has not landed upstream — a
          // state the link table cannot represent for steps, since a row exists
          // only after the upstream write actually landed (OCR R5-17).
          throw new IdLinkQueryError("SUBJECT_NOT_FOUND", 404);
        }
        return {
          upstream: {
            kind: link.upstreamKind,
            id: link.upstreamId,
            recordedAt: link.createdAt.toISOString(),
          },
        };
      }
      case "dataset": {
        const id = localId(ref.id);
        const dataset = await deps.datasets.getDataset(scope, id);
        if (dataset === null) {
          throw new IdLinkQueryError("SUBJECT_NOT_FOUND", 404);
        }
        return {
          upstream:
            dataset.opikDatasetId === null
              ? null
              : {
                  kind: "dataset" as const,
                  id: dataset.opikDatasetId,
                  recordedAt: dataset.updatedAt.toISOString(),
                },
        };
      }
      default: {
        // A kind the type system does not know (raw deserialized input) must not
        // fall off the switch into an implicit undefined answer.
        throw new IdLinkQueryError("ID_LINK_QUERY_INPUT_INVALID", 400);
      }
    }
  };

  const resolveByUpstream: IdLinkQueryService["resolveByUpstream"] = async (
    scope,
    ref,
  ) => {
    const id = localId(ref.id);
    switch (ref.kind) {
      case "trace": {
        const binding = await deps.bindings.byOpikTrace(scope, id);
        return {
          subject:
            binding === null
              ? null
              : {
                  ref: {
                    kind: "run_attempt" as const,
                    runId: binding.runId,
                    attemptId: binding.attemptId,
                  },
                  recordedAt: binding.updatedAt.toISOString(),
                },
        };
      }
      case "span": {
        const link = await deps.links.byUpstream(scope, "span", id);
        return {
          subject:
            link === null
              ? null
              : {
                  ref: { kind: link.localKind, id: link.localId },
                  recordedAt: link.createdAt.toISOString(),
                },
        };
      }
      case "dataset": {
        const dataset = await deps.datasets.byOpikDatasetId(scope, id);
        return {
          subject:
            dataset === null
              ? null
              : {
                  ref: { kind: "dataset" as const, id: dataset.id },
                  recordedAt: dataset.updatedAt.toISOString(),
                },
        };
      }
      default: {
        // A kind the type system does not know (raw deserialized input) must not
        // fall off the switch into an implicit undefined answer.
        throw new IdLinkQueryError("ID_LINK_QUERY_INPUT_INVALID", 400);
      }
    }
  };

  return { resolveByLocal, resolveByUpstream };
}
