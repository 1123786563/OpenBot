import { createHash, createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  mastraExecutionContinuations,
  mastraExecutionReceipts,
} from "../db/schema/mastra-execution-continuations";
import type { PlatformScope } from "../enterprise/contracts";
import type {
  ClaimedContinuation,
  ContinuationOutcome,
  ContinuationPayload,
  ExecutionBinding,
  ResumeDecision,
  ResumeRef,
} from "./execution-contracts";

/*
 * ME05 (#477) T6: the durable continuation store.
 *
 * The ONLY durable state a suspended execution's recovery stands on. Every
 * claim goes through a database CAS (revision compare-and-set), so two
 * concurrent resumers — in one process or across instances — cannot both hold
 * the claim, and every decision id is recorded on the row it won, so a crash
 * between the approval decision write and the claim is re-appliable
 * (idempotent on the decision id) instead of lost or doubled.
 *
 * Claim tokens are unforgeable: HMAC over the server secret plus fresh
 * randomness, only the SHA-256 hash stored, never logged. Finishing a claim
 * re-verifies the token hash AND the revision, so a stale winner cannot close
 * a row someone else's recovery rules now govern.
 *
 * Nothing in this module trusts its inputs for authorization: the scope is
 * compared field-wise against the stored binding, the fingerprint against the
 * current engine, and receipt evidence decides what an expired claim may do.
 */

/** A named refusal; `code` is the contract surface callers branch on. */
export class MastraContinuationRefusal extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "MastraContinuationRefusal";
  }
}

/** The refusal codes the migration contract freezes (plus named extras). */
export const MASTRA_CONTINUATION_REFUSALS = {
  notFound: "MASTRA_CONTINUATION_NOT_FOUND",
  argsMismatch: "MASTRA_CONTINUATION_ARGS_MISMATCH",
  revisionConflict: "MASTRA_CONTINUATION_REVISION_CONFLICT",
  claimExpired: "MASTRA_CONTINUATION_CLAIM_EXPIRED",
  fingerprintIncompatible: "MASTRA_CONTINUATION_FINGERPRINT_INCOMPATIBLE",
  grantRevoked: "MASTRA_CONTINUATION_GRANT_REVOKED",
  generationStale: "MASTRA_CONTINUATION_GENERATION_STALE",
  payloadInvalid: "MASTRA_CONTINUATION_PAYLOAD_INVALID",
  decisionIncompatible: "MASTRA_CONTINUATION_DECISION_INCOMPATIBLE",
  alreadyFinished: "MASTRA_CONTINUATION_ALREADY_FINISHED",
  /** Named extras (fix-round-1): the production drive's own refusals. */
  driveUnsupported: "MASTRA_CONTINUATION_DRIVE_UNSUPPORTED",
  storageMissing: "MASTRA_CONTINUATION_STORAGE_MISSING",
  /**
   * F1 fence: a driver whose started() did not record the receipt has lost
   * its claim (a takeover's driver recorded the operation first) — it may
   * not drive the engine.
   */
  claimLost: "MASTRA_CONTINUATION_CLAIM_LOST",
  /** F6: a suspension fact's operationId disagrees with the store's derivation. */
  operationIdMismatch: "MASTRA_CONTINUATION_OPERATION_ID_MISMATCH",
  /**
   * R3-11: a resume drive cannot host a SECOND durable pause — no save hook
   * wired, or the re-suspended run's pending call could not be identified —
   * so mounting (or recovering) would create "engine waiting, no recovery
   * data".
   */
  resuspensionUnsupported: "MASTRA_CONTINUATION_RESUSPENSION_UNSUPPORTED",
} as const;

export interface MastraContinuationStoreDeps {
  readonly database: Database;
  /**
   * Server-only secret the claim tokens are HMAC-bound to. Never logged,
   * never sent to any client.
   */
  readonly secret: string;
  /** How long one claim may be held before receipt evidence governs it. */
  readonly claimTtlMs?: number;
  readonly now?: () => Date;
  /** The current engine fingerprint; defaults to the pinned-package digest. */
  readonly fingerprint?: () => string;
}

/** A continuation row as the orchestrator sees it (never the token hash). */
export interface MastraContinuationRecord {
  readonly ref: ResumeRef;
  readonly binding: ExecutionBinding;
  readonly payload: ContinuationPayload;
  readonly operationId: string;
  readonly status: "waiting" | "claimed" | "finished";
  readonly decisionId: string | null;
  readonly outcome: ContinuationOutcome | null;
  readonly claimExpired: boolean;
}

export interface MastraOperationIdentity {
  readonly operationId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argsDigest: string;
}

export type MastraReceipt = {
  readonly receiptId: string;
  readonly status: "unknown" | "executed";
};

/**
 * F1 fence: the discriminated result of recording an operation start.
 * `started: true` — THIS caller recorded the receipt and is the operation's
 * driver. `started: false` — the receipt already existed (the takeover's
 * driver recorded it); the caller's claim is stale and it must not drive.
 */
export type MastraOperationStartedResult =
  | { readonly started: true }
  | { readonly started: false; readonly status: "unknown" | "executed" };

export interface MastraContinuationStore {
  /**
   * `expectedOperationId` (F6): when the caller carries a derived operationId
   * (the suspension fact's), the store asserts it equals its own derivation
   * instead of letting the two formulas drift silently.
   */
  saveContinuation(
    binding: ExecutionBinding,
    payload: ContinuationPayload,
    expectedOperationId?: string,
  ): Promise<ResumeRef>;
  getContinuation(
    scope: PlatformScope,
    continuationId: string,
  ): Promise<MastraContinuationRecord | null>;
  /**
   * ME06 (AC5): the workspace-level suspension list the participation UI
   * reads — the read path the 0164 migration reserved
   * `mastra_continuations_scope_status_idx` for. Scope-filtered by
   * tenant+workspace (the index's own predicate), newest first, bounded.
   */
  listContinuations(
    scope: PlatformScope,
    filter?: {
      status?: "waiting" | "claimed" | "finished";
      limit?: number;
    },
  ): Promise<MastraContinuationRecord[]>;
  claimContinuation(
    scope: PlatformScope,
    ref: ResumeRef,
    decision: ResumeDecision,
  ): Promise<ClaimedContinuation>;
  /**
   * The server-internal evidence-checkpoint claim: same CAS, same rules on
   * state and revision, but it carries the receipt-evidence checkpoint id
   * instead of an incoming user decision (a reuse/待处置 finish is not a
   * second approval and must not fail the approval-shape assert).
   */
  claimForReceiptEvidence(
    scope: PlatformScope,
    ref: ResumeRef,
    decisionId: string,
  ): Promise<ClaimedContinuation>;
  finishContinuation(
    claim: ClaimedContinuation,
    outcome: ContinuationOutcome,
  ): Promise<void>;
  /**
   * R3-11: release a drive's claim back to waiting WITHOUT a terminal
   * outcome — the re-suspended drive finished nothing (the replacement
   * continuation is saved through the wiring's hook), so the row stays live
   * waiting evidence. Same CAS discipline as claim/finish: token + revision.
   */
  releaseClaim(claim: ClaimedContinuation): Promise<void>;
  currentFingerprint(): string;
  findReceipt(
    scope: PlatformScope,
    operationId: string,
  ): Promise<MastraReceipt | null>;
  recordOperationStarted(
    scope: PlatformScope,
    operation: MastraOperationIdentity,
  ): Promise<MastraOperationStartedResult>;
  recordOperationExecuted(
    scope: PlatformScope,
    operationId: string,
  ): Promise<string | null>;
}

/** The pinned package set the fingerprint covers (the ME01 probe's core). */
const FINGERPRINT_PACKAGES = [
  "@mastra/core",
  "@mastra/pg",
  "@mastra/memory",
  "@ag-ui/client",
  "ai",
  "zod",
] as const;

const require = createRequire(import.meta.url);

/**
 * The engine fingerprint a continuation is saved with: a digest over the
 * ACTUALLY-resolved pinned package versions. A snapshot written by another
 * fingerprint is isolated, never deserialized-and-guessed.
 */
export function mastraEngineFingerprint(): string {
  const versions = FINGERPRINT_PACKAGES.map((name) => {
    try {
      const pkg = require(`${name}/package.json`) as { version?: unknown };
      return `${name}@${typeof pkg.version === "string" ? pkg.version : "unknown"}`;
    } catch {
      return `${name}@unknown`;
    }
  });
  return createHash("sha256").update(versions.join("|")).digest("hex");
}

/**
 * The durable operation identity of one pending call: derived from the
 * execution key + call id + argument digest, so a legitimate retry or a
 * cross-process recovery of the SAME call keeps the SAME identity (the
 * in-process ME04 map cannot span processes; this digest can).
 */
export function continuationOperationId(
  executionKey: string,
  toolCallId: string,
  argsDigest: string,
): string {
  return `op_${createHash("sha256")
    .update(`${executionKey}\n${toolCallId}\n${argsDigest}`)
    .digest("hex")
    .slice(0, 32)}`;
}

/**
 * JSON-schema v1 validation on the envelope. Structural, explicit, and
 * closed: an envelope that is not exactly a v1 mastra payload of string facts
 * refuses — nothing is coerced, nothing is guessed.
 */
export function parseContinuationPayload(value: unknown): ContinuationPayload {
  const refusal = () =>
    new MastraContinuationRefusal(
      MASTRA_CONTINUATION_REFUSALS.payloadInvalid,
      "MASTRA_CONTINUATION_PAYLOAD_INVALID: the continuation envelope is not a v1 mastra payload.",
    );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw refusal();
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) throw refusal();
  if (candidate.engine !== "mastra") throw refusal();
  if (
    candidate.kind !== "approval" &&
    candidate.kind !== "question" &&
    candidate.kind !== "frontend_tool"
  ) {
    throw refusal();
  }
  for (const key of [
    "packageFingerprint",
    "toolCallId",
    "toolName",
    "argsDigest",
    "snapshotRef",
  ]) {
    const entry = candidate[key];
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 1024)
      throw refusal();
  }
  return {
    schemaVersion: 1,
    engine: "mastra",
    kind: candidate.kind as ContinuationPayload["kind"],
    packageFingerprint: candidate.packageFingerprint as string,
    toolCallId: candidate.toolCallId as string,
    toolName: candidate.toolName as string,
    argsDigest: candidate.argsDigest as string,
    snapshotRef: candidate.snapshotRef as string,
  };
}

/** The decision id a claim is idempotent on. */
export function decisionIdOf(decision: ResumeDecision): string {
  switch (decision.kind) {
    case "approved":
    case "declined":
      return decision.approvalId;
    case "answered":
      return decision.responseId;
    case "tool_result":
      return decision.receiptId;
  }
}

function scopeIdentityOf(binding: ExecutionBinding): {
  tenantId: string;
  workspaceId: string;
  principalId: string;
  actorId: string;
} {
  return {
    tenantId: binding.scope.tenantId,
    workspaceId: binding.scope.workspaceId,
    principalId: binding.scope.principalId,
    actorId: binding.scope.actorId,
  };
}

interface ContinuationRow {
  continuationId: string;
  tenantId: string;
  workspaceId: string;
  principalId: string;
  actorId: string;
  botId: string;
  runId: string;
  attemptId: string;
  generation: number;
  executionKey: string;
  threadId: string | null;
  kind: "approval" | "question" | "frontend_tool";
  toolCallId: string;
  toolName: string;
  operationId: string;
  argsDigest: string;
  packageFingerprint: string;
  snapshotRef: string;
  status: "waiting" | "claimed" | "finished";
  revision: number;
  claimExpiresAt: Date | null;
  decisionId: string | null;
  outcome: ContinuationOutcome | null;
}

function recordOf(row: ContinuationRow, now: Date): MastraContinuationRecord {
  const binding: ExecutionBinding = {
    scope: {
      tenantId: row.tenantId,
      workspaceId: row.workspaceId,
      principalId: row.principalId,
      actorId: row.actorId,
      // Epochs/entrypoint are re-established from the CURRENT admission at
      // claim time; the stored ones are history, not authority. The zeros are
      // PLACEHOLDERS, and the binding carries the typed marker below so no
      // consumer can mistake them for observed values.
      memberEpoch: 0,
      aclEpoch: 0,
      entrypoint: "web",
    },
    // Fix-round-1 review note (a): the fabricated epoch/entrypoint values are
    // marked explicitly. Scope IDENTITY (tenant/workspace/principal/actor) is
    // authoritative — the store compares it field-wise — but re-derived
    // bindings carry placeholder epochs until the current admission re-establishes them.
    reDerivedScope: true,
    botId: row.botId,
    runId: row.runId,
    attemptId: row.attemptId,
    generation: row.generation,
    executionKey: row.executionKey,
    ...(row.threadId ? { threadId: row.threadId } : {}),
  };
  return {
    ref: { continuationId: row.continuationId, revision: row.revision },
    binding,
    payload: {
      schemaVersion: 1,
      engine: "mastra",
      kind: row.kind,
      packageFingerprint: row.packageFingerprint,
      toolCallId: row.toolCallId,
      toolName: row.toolName,
      argsDigest: row.argsDigest,
      snapshotRef: row.snapshotRef,
    },
    operationId: row.operationId,
    status: row.status,
    decisionId: row.decisionId,
    outcome: row.outcome,
    claimExpired:
      row.status === "claimed" &&
      row.claimExpiresAt !== null &&
      row.claimExpiresAt.getTime() <= now.getTime(),
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Default claim hold: long enough for a resume drive, short enough to recover. */
const DEFAULT_CLAIM_TTL_MS = 15 * 60_000;

export function createMastraContinuationStore(
  deps: MastraContinuationStoreDeps,
): MastraContinuationStore {
  const { database } = deps;
  const now = () => deps.now?.() ?? new Date();
  const fingerprint = () => deps.fingerprint?.() ?? mastraEngineFingerprint();
  const claimTtlMs = () => deps.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;

  async function loadRow(
    scope: PlatformScope,
    continuationId: string,
  ): Promise<ContinuationRow | null> {
    const [row] = await database
      .select()
      .from(mastraExecutionContinuations)
      .where(
        and(
          eq(mastraExecutionContinuations.continuationId, continuationId),
          eq(mastraExecutionContinuations.tenantId, scope.tenantId),
          eq(mastraExecutionContinuations.workspaceId, scope.workspaceId),
          eq(mastraExecutionContinuations.principalId, scope.principalId),
          eq(mastraExecutionContinuations.actorId, scope.actorId),
        ),
      )
      .limit(1);
    return (row as ContinuationRow | undefined) ?? null;
  }

  async function loadPendingRow(
    scope: PlatformScope,
    runId: string,
    toolCallId: string,
  ): Promise<ContinuationRow | null> {
    const [row] = await database
      .select()
      .from(mastraExecutionContinuations)
      .where(
        and(
          eq(mastraExecutionContinuations.runId, runId),
          eq(mastraExecutionContinuations.toolCallId, toolCallId),
          // "Pending" means NOT finished: a finished row is history, not a
          // live suspension. Converging on it would hand back a ref whose
          // every future claim reads alreadyFinished — the recovery data of a
          // NEW suspension for the same call would be silently lost. The
          // partial unique index (WHERE status <> 'finished') lets that new
          // pending row exist; the finished one never blocks it.
          ne(mastraExecutionContinuations.status, "finished"),
          eq(mastraExecutionContinuations.tenantId, scope.tenantId),
          eq(mastraExecutionContinuations.workspaceId, scope.workspaceId),
          eq(mastraExecutionContinuations.principalId, scope.principalId),
          eq(mastraExecutionContinuations.actorId, scope.actorId),
        ),
      )
      .limit(1);
    return (row as ContinuationRow | undefined) ?? null;
  }

  /**
   * The single CAS claim, shared by the public decision path and the
   * receipt-evidence finish paths. A fresh claim comes off `waiting`; a
   * re-claim may take over ONLY an expired hold — what an expired claim may
   * do next is governed by receipt evidence at the orchestrator, never by
   * this store.
   */
  async function claimInternal(
    row: ContinuationRow,
    decisionId: string,
  ): Promise<ClaimedContinuation> {
    const record = recordOf(row, now());
    if (record.status === "claimed" && !record.claimExpired) {
      throw new MastraContinuationRefusal(
        MASTRA_CONTINUATION_REFUSALS.revisionConflict,
        "MASTRA_CONTINUATION_REVISION_CONFLICT: another resumer holds the claim.",
      );
    }
    // Unforgeable claim token: HMAC over the server secret + fresh
    // randomness. Only the SHA-256 hash is stored; the token never logs.
    const token = createHmac("sha256", deps.secret)
      .update(`${row.continuationId}:${row.revision}:${randomUUID()}`)
      .digest("base64url");
    // Fix-round-1 review note (b): the expiry predicate uses THIS store's own
    // clock, passed as a parameter — the SAME clock the in-process pre-check
    // (`record.claimExpired`) and `finishContinuation`'s expiry guard read.
    // The previous DB-side now() made the CAS window a second clock whose
    // skew against the module's clock could disagree with both; one
    // authoritative clock (the injected `now`, defaulting to the process
    // clock) keeps the pre-check, the CAS takeover and the finish guard on
    // the SAME timeline, and fake-clock tests stay deterministic.
    const expiryGuard = now().toISOString();
    const expiry = new Date(now().getTime() + claimTtlMs());
    const [claimed] = await database
      .update(mastraExecutionContinuations)
      .set({
        status: "claimed",
        revision: sql`${mastraExecutionContinuations.revision} + 1`,
        claimTokenHash: hashToken(token),
        claimExpiresAt: expiry,
        decisionId,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(mastraExecutionContinuations.continuationId, row.continuationId),
          eq(mastraExecutionContinuations.revision, row.revision),
          sql`(${mastraExecutionContinuations.status} = 'waiting' OR (${
            mastraExecutionContinuations.status
          } = 'claimed' AND ${
            mastraExecutionContinuations.claimExpiresAt
          } < ${expiryGuard}))`,
        ),
      )
      .returning({ revision: mastraExecutionContinuations.revision });
    if (!claimed) {
      throw new MastraContinuationRefusal(
        MASTRA_CONTINUATION_REFUSALS.revisionConflict,
        "MASTRA_CONTINUATION_REVISION_CONFLICT: another resumer holds the claim.",
      );
    }
    return {
      ref: { continuationId: row.continuationId, revision: claimed.revision },
      binding: record.binding,
      payload: record.payload,
      claimToken: token,
    };
  }

  async function findReceiptRow(scope: PlatformScope, operationId: string) {
    const [row] = await database
      .select({
        receiptId: mastraExecutionReceipts.receiptId,
        status: mastraExecutionReceipts.status,
      })
      .from(mastraExecutionReceipts)
      .where(
        and(
          eq(mastraExecutionReceipts.operationId, operationId),
          eq(mastraExecutionReceipts.tenantId, scope.tenantId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  return {
    async saveContinuation(binding, payloadValue, expectedOperationId) {
      const payload = parseContinuationPayload(payloadValue);
      const operationId = continuationOperationId(
        binding.executionKey,
        payload.toolCallId,
        payload.argsDigest,
      );
      // F6: the suspension fact already carries its derived operationId; a
      // drift between the fact's derivation and the store's is a named
      // refusal, never a silently split recovery identity.
      if (
        expectedOperationId !== undefined &&
        expectedOperationId !== operationId
      ) {
        throw new MastraContinuationRefusal(
          MASTRA_CONTINUATION_REFUSALS.operationIdMismatch,
          "MASTRA_CONTINUATION_OPERATION_ID_MISMATCH: the suspension fact's operationId disagrees with the store's derivation.",
        );
      }
      const identity = scopeIdentityOf(binding);
      // Convergent save: one pending continuation per (run, tool call). A
      // replayed save (crash between save and the waiting publication, or a
      // re-run of the same suspension) converges on the SAME row and returns
      // the SAME ref — the recovery data is never duplicated. A DIFFERENT
      // payload arriving for one (run, call) identity is a new operation, not
      // a retry (the ME04 identity semantics), and refuses instead of
      // silently replacing the pending call the user may already see.
      const existing = await loadPendingRow(
        binding.scope,
        binding.runId,
        payload.toolCallId,
      );
      if (existing) {
        if (
          existing.argsDigest !== payload.argsDigest ||
          existing.kind !== payload.kind ||
          existing.toolName !== payload.toolName
        ) {
          throw new MastraContinuationRefusal(
            MASTRA_CONTINUATION_REFUSALS.revisionConflict,
            "MASTRA_CONTINUATION_REVISION_CONFLICT: a different payload is already pending for this run and tool call.",
          );
        }
        return recordOf(existing, now()).ref;
      }
      const continuationId = randomUUID();
      await database
        .insert(mastraExecutionContinuations)
        .values({
          continuationId,
          ...identity,
          botId: binding.botId,
          runId: binding.runId,
          attemptId: binding.attemptId,
          generation: binding.generation,
          executionKey: binding.executionKey,
          ...(binding.threadId ? { threadId: binding.threadId } : {}),
          kind: payload.kind,
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          operationId,
          argsDigest: payload.argsDigest,
          packageFingerprint: payload.packageFingerprint,
          snapshotRef: payload.snapshotRef,
        })
        .onConflictDoNothing();
      const row =
        (await loadRow(binding.scope, continuationId)) ??
        (await loadPendingRow(
          binding.scope,
          binding.runId,
          payload.toolCallId,
        ));
      if (!row) throw new Error("MASTRA_CONTINUATION_SAVE_LOST");
      if (row.continuationId !== continuationId) {
        // F4: our INSERT lost the concurrent-save race and the row above is
        // the WINNER's — re-verify its identity against ours, the SAME gate
        // the pre-insert replay check applies (argsDigest, kind, toolName —
        // plus the store's own operationId and fingerprint derivations). An
        // args- or kind-changed replay must not leave the stored snapshot and
        // the new payload diverging.
        //
        // snapshotRef is deliberately not compared: it is an OPAQUE pointer
        // into engine storage, not part of the operation identity (which is
        // executionKey + toolCallId + argsDigest, plus kind/toolName). Two
        // racing saves of the same suspension may spell the engine-side blob
        // reference differently; what must not diverge is the recovery
        // identity, and the winner's snapshot is the one its row already
        // points at.
        if (
          row.operationId !== operationId ||
          row.argsDigest !== payload.argsDigest ||
          row.kind !== payload.kind ||
          row.toolName !== payload.toolName ||
          row.packageFingerprint !== payload.packageFingerprint
        ) {
          throw new MastraContinuationRefusal(
            MASTRA_CONTINUATION_REFUSALS.revisionConflict,
            "MASTRA_CONTINUATION_REVISION_CONFLICT: a different payload was saved concurrently for this run and tool call.",
          );
        }
      }
      return recordOf(row, now()).ref;
    },
    async getContinuation(scope, continuationId) {
      const row = await loadRow(scope, continuationId);
      return row ? recordOf(row, now()) : null;
    },
    async listContinuations(scope, filter) {
      const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 200);
      const predicates = [
        eq(mastraExecutionContinuations.tenantId, scope.tenantId),
        eq(mastraExecutionContinuations.workspaceId, scope.workspaceId),
        // F4 (fix-round-1): the list is the viewer's OWN waiting todo list —
        // personal scope, not a team board. A suspension is actable only by
        // its own principal (every resume re-verifies the binding field-wise),
        // so listing colleagues' suspensions would advertise rows the viewer
        // can never resume. getContinuation/claim keep the tenant+workspace
        // identity check (a foreign row reads as absence, never enumeration);
        // only the LIST surface narrows to the principal.
        eq(mastraExecutionContinuations.principalId, scope.principalId),
      ];
      if (filter?.status) {
        predicates.push(eq(mastraExecutionContinuations.status, filter.status));
      }
      const rows = await database
        .select()
        .from(mastraExecutionContinuations)
        .where(and(...predicates))
        .orderBy(desc(mastraExecutionContinuations.updatedAt))
        .limit(limit);
      return rows.map((row) => recordOf(row as ContinuationRow, now()));
    },
    async claimContinuation(scope, ref, decision) {
      const row = await loadRow(scope, ref.continuationId);
      if (!row) {
        // A foreign scope reads as absence — the same denial shape as every
        // other foreign-resource read, never "exists but not yours".
        throw new MastraContinuationRefusal(
          MASTRA_CONTINUATION_REFUSALS.notFound,
        );
      }
      if (row.revision !== ref.revision) {
        throw new MastraContinuationRefusal(
          MASTRA_CONTINUATION_REFUSALS.revisionConflict,
        );
      }
      const record = recordOf(row, now());
      // Decision-shape compatibility is reported precisely, ahead of every
      // state outcome.
      assertDecisionFitsPayload(decision, record.payload);
      if (record.status === "finished") {
        throw new MastraContinuationRefusal(
          MASTRA_CONTINUATION_REFUSALS.alreadyFinished,
        );
      }
      // Tamper gate: an approved decision naming arguments other than the
      // pending call's refuses without taking the claim.
      if (
        decision.kind === "approved" &&
        decision.argsDigest !== record.payload.argsDigest
      ) {
        throw new MastraContinuationRefusal(
          MASTRA_CONTINUATION_REFUSALS.argsMismatch,
          "MASTRA_CONTINUATION_ARGS_MISMATCH: the approved arguments are not the pending call's arguments.",
        );
      }
      return claimInternal(row, decisionIdOf(decision));
    },
    async claimForReceiptEvidence(scope, ref, decisionId) {
      const row = await loadRow(scope, ref.continuationId);
      if (!row) {
        throw new MastraContinuationRefusal(
          MASTRA_CONTINUATION_REFUSALS.notFound,
        );
      }
      if (row.revision !== ref.revision) {
        throw new MastraContinuationRefusal(
          MASTRA_CONTINUATION_REFUSALS.revisionConflict,
        );
      }
      if (row.status === "finished") {
        throw new MastraContinuationRefusal(
          MASTRA_CONTINUATION_REFUSALS.alreadyFinished,
        );
      }
      return claimInternal(row, decisionId);
    },
    async finishContinuation(claim, outcome) {
      const expiryGuard = now();
      const [finished] = await database
        .update(mastraExecutionContinuations)
        .set({
          status: "finished",
          outcome,
          claimTokenHash: null,
          claimExpiresAt: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(
              mastraExecutionContinuations.continuationId,
              claim.ref.continuationId,
            ),
            eq(mastraExecutionContinuations.revision, claim.ref.revision),
            eq(mastraExecutionContinuations.status, "claimed"),
            eq(
              mastraExecutionContinuations.claimTokenHash,
              hashToken(claim.claimToken),
            ),
            // An expired claim may not be finished: recovery goes back
            // through the receipt-evidence rules instead.
            sql`(${mastraExecutionContinuations.claimExpiresAt} IS NULL OR ${
              mastraExecutionContinuations.claimExpiresAt
            } >= ${expiryGuard.toISOString()})`,
          ),
        )
        .returning({ revision: mastraExecutionContinuations.revision });
      if (!finished) {
        const row = await loadRow(
          claim.binding.scope,
          claim.ref.continuationId,
        );
        const record = row ? recordOf(row, now()) : null;
        throw new MastraContinuationRefusal(
          record?.claimExpired
            ? MASTRA_CONTINUATION_REFUSALS.claimExpired
            : MASTRA_CONTINUATION_REFUSALS.revisionConflict,
        );
      }
    },
    async releaseClaim(claim) {
      const [released] = await database
        .update(mastraExecutionContinuations)
        .set({
          status: "waiting",
          claimTokenHash: null,
          claimExpiresAt: null,
          revision: sql`${mastraExecutionContinuations.revision} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(
              mastraExecutionContinuations.continuationId,
              claim.ref.continuationId,
            ),
            eq(mastraExecutionContinuations.revision, claim.ref.revision),
            eq(mastraExecutionContinuations.status, "claimed"),
            eq(
              mastraExecutionContinuations.claimTokenHash,
              hashToken(claim.claimToken),
            ),
          ),
        )
        .returning({ revision: mastraExecutionContinuations.revision });
      if (!released) {
        // The claim is no longer ours (expired and taken over mid-drive): the
        // row's fate is its receipt evidence now, and releasing over whatever
        // the takeover wrote would erase a winner. Named conflict, loud.
        throw new MastraContinuationRefusal(
          MASTRA_CONTINUATION_REFUSALS.revisionConflict,
          "MASTRA_CONTINUATION_REVISION_CONFLICT: the re-suspended drive's claim is no longer current; the row's fate is governed by its receipt evidence.",
        );
      }
    },
    currentFingerprint: fingerprint,
    findReceipt: findReceiptRow,
    async recordOperationStarted(scope, operation) {
      const [inserted] = await database
        .insert(mastraExecutionReceipts)
        .values({
          receiptId: randomUUID(),
          operationId: operation.operationId,
          runId: operation.runId,
          toolCallId: operation.toolCallId,
          toolName: operation.toolName,
          argsDigest: operation.argsDigest,
          tenantId: scope.tenantId,
          status: "unknown",
        })
        .onConflictDoNothing()
        .returning({ receiptId: mastraExecutionReceipts.receiptId });
      if (inserted) return { started: true };
      // F1 fence: the receipt pre-exists, so THIS caller is not the driver —
      // a takeover (or the completed run) recorded the operation first.
      // Surface the current status so the drive path can refuse without
      // erasing the other driver's evidence.
      const existing = await findReceiptRow(scope, operation.operationId);
      if (!existing) {
        // Receipts are never deleted; a conflict with no readable row is a
        // ledger anomaly, not a recoverable state.
        throw new Error("MASTRA_CONTINUATION_RECEIPT_LOST");
      }
      return { started: false, status: existing.status };
    },
    async recordOperationExecuted(scope, operationId) {
      const [confirmed] = await database
        .update(mastraExecutionReceipts)
        .set({ status: "executed", confirmedAt: sql`now()` })
        .where(
          and(
            eq(mastraExecutionReceipts.operationId, operationId),
            eq(mastraExecutionReceipts.tenantId, scope.tenantId),
            eq(mastraExecutionReceipts.status, "unknown"),
          ),
        )
        .returning({ receiptId: mastraExecutionReceipts.receiptId });
      return confirmed?.receiptId ?? null;
    },
  };
}

/** Which decision shapes may resume which payload kind. */
function assertDecisionFitsPayload(
  decision: ResumeDecision,
  payload: ContinuationPayload,
): void {
  const fits =
    (payload.kind === "approval" &&
      (decision.kind === "approved" || decision.kind === "declined")) ||
    (payload.kind === "question" && decision.kind === "answered") ||
    (payload.kind === "frontend_tool" && decision.kind === "tool_result");
  if (!fits) {
    throw new MastraContinuationRefusal(
      MASTRA_CONTINUATION_REFUSALS.decisionIncompatible,
      `MASTRA_CONTINUATION_DECISION_INCOMPATIBLE: a ${decision.kind} decision cannot resume a ${payload.kind} continuation.`,
    );
  }
}
