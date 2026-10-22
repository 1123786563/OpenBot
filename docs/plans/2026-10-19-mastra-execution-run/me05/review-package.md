# ME05 review package — generated 2026-10-20T04:13Z by controller

Uncommitted tree vs BASE bf64d0f2. ME01-ME05 share the delta; this package covers the ME05 increment only.
ME05 seams in shared files: execution.ts durable tool mount ~L214-240 + onSuspension save-before-end ~L331-365; copilot.ts import ~L88 + setMastraContinuations seam ~L2178-2199 + per-execution merge ~L2367-2385.


=== NEW FILE (full content): server/drizzle/0164_mastra_execution_continuations.sql ===
```ts
-- ME05 (#477): 危险操作与用户问答的持久挂起 continuation 台账。
--
-- 一行 = 一个等待恢复的操作的完整恢复证据：scope 与 run 绑定（tenant/workspace/
-- principal/actor + bot/run/attempt/generation/executionKey）、引擎提出的精确
-- tool call 与参数摘要、写入快照时的引擎版本指纹、指向受限存储的不透明
-- snapshot 引用、CAS revision、带过期的认领状态与终态。绝不保存 provider key、
-- capability 明文、函数或实时 AbortSignal；快照本体只在受限租户引擎存储中，
-- 仅能经 snapshot_ref 定位。
--
-- (run_id, tool_call_id) 唯一：一次重复保存收敛到同一行，不会铸造第二个恢复
-- 身份（保存与发布 waiting 之间的崩溃可安全重放保存）。
CREATE TABLE "mastra_execution_continuations" (
	"continuation_id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"run_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"generation" integer NOT NULL,
	"execution_key" text NOT NULL,
	"thread_id" text,
	"kind" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"operation_id" text NOT NULL,
	"args_digest" text NOT NULL,
	"package_fingerprint" text NOT NULL,
	"snapshot_ref" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"claim_token_hash" text,
	"claim_expires_at" timestamp with time zone,
	"decision_id" text,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mastra_continuations_kind_check" CHECK ("mastra_execution_continuations"."kind" IN ('approval', 'question', 'frontend_tool')),
	CONSTRAINT "mastra_continuations_status_check" CHECK ("mastra_execution_continuations"."status" IN ('waiting', 'claimed', 'finished')),
	CONSTRAINT "mastra_continuations_outcome_check" CHECK ("mastra_execution_continuations"."outcome" IN ('resumed', 'declined', 'failed_unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mastra_continuations_run_call_idx" ON "mastra_execution_continuations" USING btree ("run_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "mastra_continuations_scope_status_idx" ON "mastra_execution_continuations" USING btree ("tenant_id","workspace_id","status");--> statement-breakpoint
CREATE INDEX "mastra_continuations_operation_idx" ON "mastra_execution_continuations" USING btree ("operation_id");--> statement-breakpoint
-- ME05 (#477): 外部效果 receipt 证据台账。恢复规则只认这里的状态：operation
-- 一经启动即记 unknown（效果可能已发生，绝不自动重放）；结果确认后升级为
-- executed（合法恢复复用，不再执行）。
CREATE TABLE "mastra_execution_receipts" (
	"receipt_id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"args_digest" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "mastra_receipts_status_check" CHECK ("mastra_execution_receipts"."status" IN ('unknown', 'executed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mastra_receipts_operation_idx" ON "mastra_execution_receipts" USING btree ("run_id","tool_call_id","operation_id");
```

=== NEW FILE (full content): server/src/db/schema/mastra-execution-continuations.ts ===
```ts
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/*
 * ME05 (#477): the durable continuation ledger for suspended executions.
 *
 * A row is the recovery evidence ONE pending operation waits on: the scope
 * and run identity it was suspended under, the exact tool call and argument
 * digest the model proposed, the engine fingerprint the snapshot was written
 * with, an opaque reference into restricted storage, a CAS revision, a claim
 * state with expiry, and the terminal outcome. Nothing here ever carries
 * provider keys, capability plaintext, functions or AbortSignals — the
 * snapshot itself lives in tenant-restricted engine storage and is reachable
 * only through `snapshot_ref`.
 *
 * `mastra_execution_receipts` is the receipt-evidence ledger the recovery
 * rules key on: an operation recorded as started (outcome unknown) must
 * never be auto-replayed, and one recorded as executed must be reused.
 */

export const mastraExecutionContinuations = pgTable(
  "mastra_execution_continuations",
  {
    continuationId: text("continuation_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    actorId: text("actor_id").notNull(),
    botId: text("bot_id").notNull(),
    runId: text("run_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    generation: integer("generation").notNull(),
    executionKey: text("execution_key").notNull(),
    threadId: text("thread_id"),
    /** What waits: an approval, a user answer, or a frontend tool result. */
    kind: text("kind")
      .$type<"approval" | "question" | "frontend_tool">()
      .notNull(),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    /** Stable across retries/recovery of one engine call (see tools.ts). */
    operationId: text("operation_id").notNull(),
    argsDigest: text("args_digest").notNull(),
    packageFingerprint: text("package_fingerprint").notNull(),
    /** Opaque pointer into restricted engine storage; never a payload. */
    snapshotRef: text("snapshot_ref").notNull(),
    /**
     * waiting → claimed → finished. The claim carries an HMAC-bound token
     * (only its hash is stored), an expiry, and the decision id that won it.
     */
    status: text("status")
      .$type<"waiting" | "claimed" | "finished">()
      .notNull()
      .default("waiting"),
    revision: integer("revision").notNull().default(1),
    claimTokenHash: text("claim_token_hash"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    decisionId: text("decision_id"),
    outcome: text("outcome").$type<"resumed" | "declined" | "failed_unknown">(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One pending continuation per (run, tool call): a replayed save converges
    // on the same row instead of minting a second recovery identity.
    uniqueIndex("mastra_continuations_run_call_idx").on(
      table.runId,
      table.toolCallId,
    ),
    index("mastra_continuations_scope_status_idx").on(
      table.tenantId,
      table.workspaceId,
      table.status,
    ),
    index("mastra_continuations_operation_idx").on(table.operationId),
    check(
      "mastra_continuations_kind_check",
      sql`${table.kind} IN ('approval', 'question', 'frontend_tool')`,
    ),
    check(
      "mastra_continuations_status_check",
      sql`${table.status} IN ('waiting', 'claimed', 'finished')`,
    ),
    check(
      "mastra_continuations_outcome_check",
      sql`${table.outcome} IN ('resumed', 'declined', 'failed_unknown')`,
    ),
  ],
);

export const mastraExecutionReceipts = pgTable(
  "mastra_execution_receipts",
  {
    receiptId: text("receipt_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    operationId: text("operation_id").notNull(),
    runId: text("run_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    argsDigest: text("args_digest").notNull(),
    /**
     * `unknown` is recorded the moment an operation starts (the effect may
     * land); `executed` upgrades it once the result is confirmed. Recovery
     * reads this column — unknown is never replayed.
     */
    status: text("status").$type<"unknown" | "executed">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("mastra_receipts_operation_idx").on(
      table.runId,
      table.toolCallId,
      table.operationId,
    ),
    check(
      "mastra_receipts_status_check",
      sql`${table.status} IN ('unknown', 'executed')`,
    ),
  ],
);
```

=== NEW FILE (full content): server/src/mastra/continuation-store.ts ===
```ts
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { and, eq, sql } from "drizzle-orm";
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

export interface MastraContinuationStore {
  saveContinuation(
    binding: ExecutionBinding,
    payload: ContinuationPayload,
  ): Promise<ResumeRef>;
  getContinuation(
    scope: PlatformScope,
    continuationId: string,
  ): Promise<MastraContinuationRecord | null>;
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
  currentFingerprint(): string;
  findReceipt(
    scope: PlatformScope,
    operationId: string,
  ): Promise<MastraReceipt | null>;
  recordOperationStarted(
    scope: PlatformScope,
    operation: MastraOperationIdentity,
  ): Promise<void>;
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

  return {
    async saveContinuation(binding, payloadValue) {
      const payload = parseContinuationPayload(payloadValue);
      const operationId = continuationOperationId(
        binding.executionKey,
        payload.toolCallId,
        payload.argsDigest,
      );
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
      return recordOf(row, now()).ref;
    },
    async getContinuation(scope, continuationId) {
      const row = await loadRow(scope, continuationId);
      return row ? recordOf(row, now()) : null;
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
    currentFingerprint: fingerprint,
    async findReceipt(scope, operationId) {
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
    },
    async recordOperationStarted(scope, operation) {
      await database
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
        .onConflictDoNothing();
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
```

=== NEW FILE (full content): server/src/mastra/approvals.ts ===
```ts
import type { PlatformScope } from "../enterprise/contracts";
import {
  MASTRA_CONTINUATION_REFUSALS,
  type MastraContinuationRecord,
  MastraContinuationRefusal,
  type MastraContinuationStore,
  type MastraOperationIdentity,
} from "./continuation-store";
import type {
  ClaimedContinuation,
  ExecutionBinding,
  MastraSuspensionFact,
  ResumeDecision,
  ResumeRef,
} from "./execution-contracts";

/*
 * ME05 (#477) T6: accurate recovery — the layer that consumes an EXISTING
 * approvals-subsystem decision (deny/expire/revoke semantics stay the product
 * authority; nothing here re-decides) and drives the pinned Mastra resume.
 *
 * Every resume re-verifies, in order, before anything executes:
 *   identity (the resumer IS the suspended scope's person, field-wise),
 *   → current ownership (the optional lease probe; T8/T9 slot in without a
 *     signature change),
 *   → generation currency,
 *   → decision/payload compatibility and the exact argument digest (a
 *     tampered digest refuses),
 *   → engine fingerprint compatibility (an incompatible snapshot isolates,
 *     never deserializes-and-guesses),
 *   → the tool grant is still valid (a revoked source blocks),
 * and only then takes the single CAS claim and drives the engine against the
 * STORED runId. Completed receipts are REUSED, never re-executed; an external
 * effect whose outcome cannot be proven ends pending_unknown — user-visible
 * 待处置, never auto-replayed.
 */

/** What one resume drive returns to the caller. */
export type MastraContinuationResumeResult =
  | {
      readonly kind: "resumed";
      /** The produced answer text, when the drive reports it. */
      readonly answer?: string;
      /** The engine finish reason, when the drive reports it. */
      readonly finishReason?: string;
    }
  | {
      readonly kind: "declined";
      readonly answer?: string;
      readonly finishReason?: string;
    }
  | { readonly kind: "reused_receipt"; readonly receiptId: string }
  | { readonly kind: "pending_unknown"; readonly continuationId: string }
  | { readonly kind: "already_applied" };

/**
 * The receipt-evidence sink one drive writes through: `started` records the
 * operation with outcome unknown BEFORE the engine can reach the external
 * call, `executed` upgrades it once the result is confirmed. Crash windows
 * leave `unknown` — which recovery refuses to replay.
 */
export interface MastraResumeReceiptSink {
  started(): Promise<void>;
  executed(): Promise<string | null>;
}

/**
 * What one drive returns. The bare string form is the minimum contract (the
 * CAS finish outcome); a production drive MAY return the produced facts —
 * the resumed loop's answer text and finish reason — so the approvals
 * consumer can surface what the user's decision actually produced.
 */
export type MastraResumeDrive =
  | "resumed"
  | "declined"
  | {
      readonly outcome: "resumed" | "declined";
      readonly answer?: string;
      readonly finishReason?: string;
    };

/** The engine-facing resume drive; `createMastraResumeDriver` is the production implementation. */
export interface MastraResumeDriver {
  resume(input: {
    claim: ClaimedContinuation;
    decision: ResumeDecision;
    receiptSink: MastraResumeReceiptSink;
  }): Promise<MastraResumeDrive>;
}

export interface ResumeMastraContinuationDeps {
  readonly store: MastraContinuationStore;
  /** The CURRENT engine fingerprint; defaults to the store's. */
  readonly currentFingerprint?: string;
  /** Is the tool grant this call rode on still valid NOW? */
  readonly toolGrantCurrent: (input: {
    scope: PlatformScope;
    botId: string;
    toolName: string;
  }) => Promise<boolean>;
  /** Is the run's generation still the one the continuation binds? */
  readonly generationCurrent: (input: {
    scope: PlatformScope;
    runId: string;
    generation: number;
  }) => Promise<boolean>;
  /**
   * Current-ownership probe (the runner's lease fencing). Optional TODAY so
   * the T8/T9 injection slots in without a signature change; a failed probe
   * refuses exactly as a stale generation does.
   */
  readonly leaseCurrent?: () => boolean | Promise<boolean>;
  readonly driver: MastraResumeDriver;
}

/**
 * Resume one durable continuation with an authenticated decision.
 *
 * Idempotent on the decision id: re-applying a decision that already finished
 * this continuation is `already_applied`, never a second run. A crash after
 * the claim but before the drive leaves the claim to expire, and the re-apply
 * is governed by receipt evidence (nothing recorded → safe to drive once;
 * started-unknown → 待处置; executed → reuse).
 */
export async function resumeMastraContinuation(
  deps: ResumeMastraContinuationDeps,
  input: {
    scope: PlatformScope;
    ref: ResumeRef;
    decision: ResumeDecision;
  },
): Promise<MastraContinuationResumeResult> {
  const { scope, ref, decision } = input;
  const record = await deps.store.getContinuation(scope, ref.continuationId);
  if (
    !record ||
    // Field-wise identity: another person's (or another tenant's) continuation
    // reads as absence — never "exists but not yours".
    !scopeIdentityMatches(scope, record.binding)
  ) {
    throw new MastraContinuationRefusal(MASTRA_CONTINUATION_REFUSALS.notFound);
  }
  // Idempotent re-apply: this exact decision already finished the row.
  if (
    record.status === "finished" &&
    record.decisionId === decisionIdOf(decision)
  ) {
    return { kind: "already_applied" };
  }
  // Current ownership first: the optional lease probe (T8/T9 slot-in) and the
  // generation currency fail the same way — a stale owner resumes nothing.
  if (deps.leaseCurrent && !(await deps.leaseCurrent())) {
    throw new MastraContinuationRefusal(
      MASTRA_CONTINUATION_REFUSALS.generationStale,
      "MASTRA_CONTINUATION_GENERATION_STALE: the run's lease/owner is no longer current.",
    );
  }
  if (
    !(await deps.generationCurrent({
      scope,
      runId: record.binding.runId,
      generation: record.binding.generation,
    }))
  ) {
    throw new MastraContinuationRefusal(
      MASTRA_CONTINUATION_REFUSALS.generationStale,
    );
  }
  // Compatibility BEFORE evidence: an engine fingerprint that no longer
  // matches isolates the continuation — refused, untouched, never executed
  // and never deserialized as a guess.
  const currentFingerprint =
    deps.currentFingerprint ?? deps.store.currentFingerprint();
  if (record.payload.packageFingerprint !== currentFingerprint) {
    throw new MastraContinuationRefusal(
      MASTRA_CONTINUATION_REFUSALS.fingerprintIncompatible,
    );
  }
  // The source's authority is re-checked NOW: a grant revoked since the
  // suspension blocks the resume (the product's own revoke semantics stay
  // authoritative; this is the continuation-layer enforcement).
  if (
    !(await deps.toolGrantCurrent({
      scope,
      botId: record.binding.botId,
      toolName: record.payload.toolName,
    }))
  ) {
    throw new MastraContinuationRefusal(
      MASTRA_CONTINUATION_REFUSALS.grantRevoked,
    );
  }
  // Tamper gate before any claim: an approved decision naming different
  // arguments than the pending call refuses outright.
  if (
    decision.kind === "approved" &&
    decision.argsDigest !== record.payload.argsDigest
  ) {
    throw new MastraContinuationRefusal(
      MASTRA_CONTINUATION_REFUSALS.argsMismatch,
    );
  }
  // Receipt evidence FIRST for a stale claim: what an expired claim may do is
  // decided by what provably happened to the external effect — never by a
  // retry heuristic.
  const receipt = await deps.store.findReceipt(scope, record.operationId);
  if (receipt) {
    if (receipt.status === "executed") {
      return finishWithReuse(deps, record, receipt.receiptId);
    }
    return finishPendingUnknown(deps, record);
  }
  // Single winner: the CAS claim. Concurrent resumers (clicks, webhooks,
  // instances) lose here with a named conflict, not a second execution. The
  // claim rides the JUST-READ record's revision — the caller's ref identifies
  // the continuation, the fresh read carries the current CAS revision.
  const claim = await deps.store.claimContinuation(scope, record.ref, decision);
  const operation: MastraOperationIdentity = {
    operationId: record.operationId,
    runId: record.binding.runId,
    toolCallId: record.payload.toolCallId,
    toolName: record.payload.toolName,
    argsDigest: record.payload.argsDigest,
  };
  const receiptSink: MastraResumeReceiptSink = {
    started: () => deps.store.recordOperationStarted(scope, operation),
    executed: () =>
      deps.store.recordOperationExecuted(scope, operation.operationId),
  };
  // The drive's own failure propagates as-is: the claim it won is left to
  // expire, and the re-apply is governed by receipt evidence. Nothing is
  // auto-retried inside this function.
  const driven = await deps.driver.resume({ claim, decision, receiptSink });
  const outcome = typeof driven === "string" ? driven : driven.outcome;
  await deps.store.finishContinuation(claim, outcome);
  const produced = producedFactsOf(driven);
  return outcome === "declined"
    ? { kind: "declined", ...produced }
    : { kind: "resumed", ...produced };
}

/** The produced answer/finish-reason facts a rich drive result carries. */
function producedFactsOf(
  driven: MastraResumeDrive,
): { answer?: string; finishReason?: string } {
  if (typeof driven === "string") return {};
  const facts: { answer?: string; finishReason?: string } = {};
  if (driven.answer !== undefined) facts.answer = driven.answer;
  if (driven.finishReason !== undefined) facts.finishReason = driven.finishReason;
  return facts;
}

async function finishWithReuse(
  deps: ResumeMastraContinuationDeps,
  record: MastraContinuationRecord,
  receiptId: string,
): Promise<MastraContinuationResumeResult> {
  const claim = await deps.store.claimForReceiptEvidence(
    record.binding.scope,
    record.ref,
    `receipt-checkpoint:${record.operationId}`,
  );
  await deps.store.finishContinuation(claim, "resumed");
  return { kind: "reused_receipt", receiptId };
}

async function finishPendingUnknown(
  deps: ResumeMastraContinuationDeps,
  record: MastraContinuationRecord,
): Promise<MastraContinuationResumeResult> {
  const claim = await deps.store.claimForReceiptEvidence(
    record.binding.scope,
    record.ref,
    `receipt-checkpoint:${record.operationId}`,
  );
  // The external effect may have landed but cannot be proven: the
  // continuation ends failed_unknown — the user-visible 待处置 state. It is
  // NEVER auto-replayed, by this process or a future one.
  await deps.store.finishContinuation(claim, "failed_unknown");
  return { kind: "pending_unknown", continuationId: record.ref.continuationId };
}

function decisionIdOf(decision: ResumeDecision): string {
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

function scopeIdentityMatches(
  scope: PlatformScope,
  binding: { scope: PlatformScope },
): boolean {
  return (
    scope.tenantId === binding.scope.tenantId &&
    scope.workspaceId === binding.scope.workspaceId &&
    scope.principalId === binding.scope.principalId &&
    scope.actorId === binding.scope.actorId
  );
}

/**
 * The server-assembled install the execution and resume seams consume (the
 * copilot assembly installs it; a test assembly installs its own). Everything
 * server-owned flows through here: which engine storage snapshots persist
 * into, which tool names mount the durable approval pause, and the save +
 * resume entry — the client can never supply any of it.
 */
export interface MastraContinuationInstall {
  /** The tenant-restricted engine storage one binding's snapshots live in. */
  storageFor(binding: ExecutionBinding): unknown | undefined;
  /** The granted tool names mounted with the durable approval pause. */
  readonly durableToolNames: readonly string[];
  /** Save one suspension's continuation (BEFORE any waiting publication). */
  saveSuspension(
    binding: ExecutionBinding,
    suspension: MastraSuspensionFact,
  ): Promise<ResumeRef>;
  /** The accurate-resume entry an approval decision consumes. */
  resume(input: {
    scope: PlatformScope;
    ref: ResumeRef;
    decision: ResumeDecision;
  }): Promise<MastraContinuationResumeResult>;
}

export function createMastraContinuationInstall(deps: {
  store: MastraContinuationStore;
  currentFingerprint?: string;
  storageFor(binding: ExecutionBinding): unknown | undefined;
  readonly durableToolNames?: readonly string[];
  toolGrantCurrent: (input: {
    scope: PlatformScope;
    botId: string;
    toolName: string;
  }) => Promise<boolean>;
  generationCurrent: (input: {
    scope: PlatformScope;
    runId: string;
    generation: number;
  }) => Promise<boolean>;
  leaseCurrent?: () => boolean | Promise<boolean>;
  driver: MastraResumeDriver;
}): MastraContinuationInstall {
  return {
    storageFor: (binding) => deps.storageFor(binding),
    durableToolNames: deps.durableToolNames ?? [],
    saveSuspension: (binding, suspension) =>
      deps.store.saveContinuation(binding, {
        schemaVersion: 1,
        engine: "mastra",
        kind: suspension.kind,
        packageFingerprint:
          deps.currentFingerprint ?? deps.store.currentFingerprint(),
        toolCallId: suspension.toolCallId,
        toolName: suspension.toolName,
        argsDigest: suspension.argsDigest,
        snapshotRef: suspension.snapshotRef,
      }),
    resume: (input) =>
      resumeMastraContinuation(
        {
          store: deps.store,
          ...(deps.currentFingerprint
            ? { currentFingerprint: deps.currentFingerprint }
            : {}),
          toolGrantCurrent: deps.toolGrantCurrent,
          generationCurrent: deps.generationCurrent,
          ...(deps.leaseCurrent ? { leaseCurrent: deps.leaseCurrent } : {}),
          driver: deps.driver,
        },
        input,
      ),
  };
}

export { MASTRA_CONTINUATION_REFUSALS, MastraContinuationRefusal };
```

=== NEW FILE (full content): server/tests/mastra-continuations.test.ts ===
```ts
import { PostgresStore } from "@mastra/pg";
import { sleep } from "bun";
import { z } from "zod";
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { createDatabase } from "../src/db/client";
import type { PlatformScope } from "../src/enterprise/contracts";
import {
  type MastraResumeDriver,
  resumeMastraContinuation,
} from "../src/mastra/approvals";
import {
  continuationOperationId,
  createMastraContinuationStore,
  MastraContinuationRefusal,
} from "../src/mastra/continuation-store";
import { runMastraExecution } from "../src/mastra/execution";
import type {
  ClaimedContinuation,
  ContinuationPayload,
  ExecutionBinding,
  ResumeDecision,
} from "../src/mastra/execution-contracts";
import { createMastraResumeDriver } from "../src/mastra/resume-driver";
import { argsDigestFor } from "../src/mastra/tools";
import type { GrantedTool } from "../src/plugins/tools";
import {
  createCountingControlledModel,
  startFakeProvider,
} from "./support/me01-fixture";
import {
  buildMe05Stack,
  createMe05Database,
  ME05_TOOL_NAME,
  type Me05Database,
} from "./support/me05-fixture";

/*
 * ME05 (#477): the durable continuation store and the accurate-resume
 * orchestrator, on a REAL disposable Postgres (the repository's own 0164
 * migration applied) — no in-memory fake may stand in for the durable store.
 * Cross-process resume lives in
 * server/tests/enterprise/mastra-continuations.integration.test.ts.
 *
 * Every case uses its OWN run identity: the store converges one pending
 * continuation per (run, tool call), so a shared id would merge cases.
 */

const SECRET = "me05-unit-continuation-secret";
const ARGS = { value: "hi" };
const DIGEST = argsDigestFor(ARGS);

function scopeFor(actor = "actor-a"): PlatformScope {
  return {
    tenantId: `tenant-${actor}`,
    workspaceId: `workspace-${actor}`,
    principalId: `principal-${actor}`,
    actorId: `actor-${actor}`,
    memberEpoch: 1,
    aclEpoch: 1,
    entrypoint: "web",
  };
}

const SCOPE = scopeFor();

function bindingFor(
  label: string,
  overrides: Partial<ExecutionBinding> = {},
): ExecutionBinding {
  return {
    scope: SCOPE,
    botId: "bot-a",
    runId: `run-${label}`,
    attemptId: `attempt-${label}`,
    generation: 1,
    executionKey: `exec-${label}`,
    threadId: `thread-${label}`,
    ...overrides,
  };
}

function payloadFor(
  overrides: Partial<ContinuationPayload> = {},
): ContinuationPayload {
  return {
    schemaVersion: 1,
    engine: "mastra",
    packageFingerprint: "fp-unit-1",
    kind: "approval",
    toolCallId: "call_1",
    toolName: ME05_TOOL_NAME,
    argsDigest: DIGEST,
    snapshotRef: "suspended:snapshot:call_1",
    ...overrides,
  };
}

function approvedDecision(
  overrides: Partial<Extract<ResumeDecision, { kind: "approved" }>> = {},
): ResumeDecision {
  return {
    kind: "approved",
    approvalId: "approval-1",
    argsDigest: DIGEST,
    ...overrides,
  };
}

interface Harness {
  label: string;
  store: ReturnType<typeof createMastraContinuationStore>;
  database: ReturnType<typeof createDatabase>;
  executions: unknown[];
  operationId(): string;
  resume(input: {
    ref: { continuationId: string; revision: number };
    decision?: ResumeDecision;
    scope?: PlatformScope;
    toolGrantCurrent?: (input: unknown) => Promise<boolean>;
    generationCurrent?: (input: unknown) => Promise<boolean>;
    driver?: MastraResumeDriver;
    currentFingerprint?: string;
  }): Promise<
    | { kind: "resumed" }
    | { kind: "declined" }
    | { kind: "reused_receipt"; receiptId: string }
    | { kind: "pending_unknown"; continuationId: string }
    | { kind: "already_applied" }
  >;
  save(
    bindingOverrides?: Partial<ExecutionBinding>,
    payloadOverrides?: Partial<ContinuationPayload>,
  ): Promise<{
    ref: Awaited<ReturnType<Harness["store"]["saveContinuation"]>>;
    binding: ExecutionBinding;
  }>;
  close(): Promise<void>;
}

async function harness(
  options: { label?: string; claimTtlMs?: number } = {},
): Promise<Harness> {
  const label = options.label ?? Math.random().toString(36).slice(2, 10);
  const database = createDatabase(databaseUrl!, { max: 4 });
  const store = createMastraContinuationStore({
    database,
    secret: SECRET,
    fingerprint: () => "fp-unit-1",
    ...(options.claimTtlMs ? { claimTtlMs: options.claimTtlMs } : {}),
  });
  openDatabases.push(database);
  const executions: unknown[] = [];
  const driver: MastraResumeDriver = {
    resume: async (input) => {
      executions.push(input.claim.payload.toolCallId);
      if (input.decision.kind === "declined") return "declined";
      return "resumed";
    },
  };
  return {
    label,
    store,
    database,
    executions,
    operationId: () =>
      continuationOperationId(`exec-${label}`, "call_1", DIGEST),
    resume: (input) =>
      resumeMastraContinuation(
        {
          store,
          ...(input.currentFingerprint
            ? { currentFingerprint: input.currentFingerprint }
            : {}),
          toolGrantCurrent: input.toolGrantCurrent ?? (async () => true),
          generationCurrent: input.generationCurrent ?? (async () => true),
          driver: input.driver ?? driver,
        },
        {
          scope: input.scope ?? SCOPE,
          ref: input.ref,
          decision: input.decision ?? approvedDecision(),
        },
      ),
    async save(bindingOverrides, payloadOverrides) {
      const binding = bindingFor(label, bindingOverrides);
      const ref = await store.saveContinuation(
        binding,
        payloadFor(payloadOverrides),
      );
      return { ref, binding };
    },
    close: async () => {
      await database.$client.end({ timeout: 5 }).catch(() => undefined);
    },
  };
}

let databaseUrl: string | undefined;
let me05: Me05Database | undefined;
const openDatabases: ReturnType<typeof createDatabase>[] = [];

beforeAll(async () => {
  // ONE disposable database per FILE: every case runs on its own run identity
  // (the store converges one pending continuation per (run, tool call)), so
  // cases stay independent while the bootstrap cost stays single.
  me05 = await createMe05Database();
  databaseUrl = me05.runtimeUrl;
});

afterAll(async () => {
  for (const database of openDatabases) {
    await database.$client.end({ timeout: 5 }).catch(() => undefined);
  }
  await me05?.drop();
});

test("me05 fixture database applies the 0164 migration and grants the restricted role", async () => {
  const h = await harness({ label: "fixture-probe" });
  const ref = await h.store.saveContinuation(bindingFor(h.label), payloadFor());
  expect(ref.continuationId).toBeTruthy();
  expect(ref.revision).toBe(1);
  await h.close();
});

test("approval_matches_exact_tool_and_args", async () => {
  const h = await harness({ label: "exact" });
  const { ref } = await h.save();
  const result = await h.resume({ ref, decision: approvedDecision() });
  expect(result).toMatchObject({ kind: "resumed" });
  // The driver drove EXACTLY the saved tool call, and the claimed payload is
  // the saved payload (tool name, digest, snapshot ref, version facts).
  expect(h.executions).toEqual(["call_1"]);
  const record = await h.store.getContinuation(SCOPE, ref.continuationId);
  expect(record?.status).toBe("finished");
  expect(record?.outcome).toBe("resumed");
  expect(record?.payload).toMatchObject({
    kind: "approval",
    toolCallId: "call_1",
    toolName: ME05_TOOL_NAME,
    argsDigest: DIGEST,
    snapshotRef: "suspended:snapshot:call_1",
    schemaVersion: 1,
    engine: "mastra",
  });
  expect(record?.operationId).toBe(
    continuationOperationId("exec-exact", "call_1", DIGEST),
  );
  await h.close();
});

test("two_resumers_only_one_claim", async () => {
  const h = await harness({ label: "race" });
  const { ref } = await h.save();
  // Two concurrent claimers on the real database: the CAS revision lets
  // exactly one through.
  const attempts = await Promise.allSettled([
    h.store.claimContinuation(
      SCOPE,
      ref,
      approvedDecision({ approvalId: "a1" }),
    ),
    h.store.claimContinuation(
      SCOPE,
      ref,
      approvedDecision({ approvalId: "a2" }),
    ),
  ]);
  const fulfilled = attempts.filter((a) => a.status === "fulfilled");
  const rejected = attempts.filter(
    (a) => a.status === "rejected",
  ) as PromiseRejectedResult[];
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(
    rejected[0].reason instanceof MastraContinuationRefusal &&
      rejected[0].reason.code === "MASTRA_CONTINUATION_REVISION_CONFLICT",
  ).toBe(true);
  await h.close();
});

test("revoked_source_blocks_resume", async () => {
  const h = await harness({ label: "revoked" });
  const { ref } = await h.save();
  await expect(
    h.resume({ ref, toolGrantCurrent: async () => false }),
  ).rejects.toMatchObject({ code: "MASTRA_CONTINUATION_GRANT_REVOKED" });
  expect(h.executions).toEqual([]);
  const record = await h.store.getContinuation(SCOPE, ref.continuationId);
  expect(record?.status).toBe("waiting");
  await h.close();
});

test("tampered_args_refused", async () => {
  const h = await harness({ label: "tamper" });
  const { ref } = await h.save();
  await expect(
    h.resume({
      ref,
      decision: approvedDecision({
        argsDigest: argsDigestFor({ value: "evil" }),
      }),
    }),
  ).rejects.toMatchObject({ code: "MASTRA_CONTINUATION_ARGS_MISMATCH" });
  expect(h.executions).toEqual([]);
  const record = await h.store.getContinuation(SCOPE, ref.continuationId);
  expect(record?.status).toBe("waiting");
  await h.close();
});

test("generation_stale_refused", async () => {
  const h = await harness({ label: "stale" });
  const { ref } = await h.save();
  await expect(
    h.resume({ ref, generationCurrent: async () => false }),
  ).rejects.toMatchObject({ code: "MASTRA_CONTINUATION_GENERATION_STALE" });
  expect(h.executions).toEqual([]);
  await h.close();
});

test("fingerprint_mismatch_isolates_not_executes", async () => {
  const h = await harness({ label: "fingerprint" });
  const { ref } = await h.save(undefined, {
    packageFingerprint: "fp-old-engine",
  });
  // The current engine carries a different fingerprint: the continuation is
  // isolated with a named refusal — never executed, never
  // deserialized-and-guessed, and the row stays put for human disposal.
  await expect(
    h.resume({ ref, currentFingerprint: "fp-current-engine" }),
  ).rejects.toMatchObject({
    code: "MASTRA_CONTINUATION_FINGERPRINT_INCOMPATIBLE",
  });
  expect(h.executions).toEqual([]);
  const record = await h.store.getContinuation(SCOPE, ref.continuationId);
  expect(record?.status).toBe("waiting");
  expect(record?.outcome).toBeNull();
  await h.close();
});

test("frontend_tool_waits_without_fake_result", async () => {
  const h = await harness({ label: "frontend" });
  const { ref } = await h.save(undefined, {
    kind: "frontend_tool",
    toolName: "ui_render_form",
  });
  const seenDecisions: ResumeDecision[] = [];
  const result = await resumeMastraContinuation(
    {
      store: h.store,
      toolGrantCurrent: async () => true,
      generationCurrent: async () => true,
      driver: {
        resume: async (input) => {
          seenDecisions.push(input.decision);
          // The engine-facing answer is built from the AUTHENTICATED decision
          // only — the store and orchestrator fabricate no tool result.
          return "resumed";
        },
      },
    },
    {
      scope: SCOPE,
      ref,
      decision: { kind: "tool_result", receiptId: "rcpt-1" },
    },
  );
  expect(result).toMatchObject({ kind: "resumed" });
  expect(seenDecisions).toEqual([{ kind: "tool_result", receiptId: "rcpt-1" }]);
  // An approval-shaped decision cannot resume a frontend_tool continuation.
  await expect(
    h.resume({ ref, decision: approvedDecision() }),
  ).rejects.toMatchObject({
    code: "MASTRA_CONTINUATION_DECISION_INCOMPATIBLE",
  });
  await h.close();
});

test("completed_receipt_reused_not_reexecuted", async () => {
  const h = await harness({ label: "reuse" });
  const { ref } = await h.save();
  await h.store.recordOperationStarted(SCOPE, {
    operationId: h.operationId(),
    runId: `run-${h.label}`,
    toolCallId: "call_1",
    toolName: ME05_TOOL_NAME,
    argsDigest: DIGEST,
  });
  const receiptId = await h.store.recordOperationExecuted(
    SCOPE,
    h.operationId(),
  );
  expect(receiptId).toBeTruthy();
  const result = await h.resume({ ref });
  expect(result).toMatchObject({ kind: "reused_receipt", receiptId });
  // The driver was never called: the completed external effect is reused.
  expect(h.executions).toEqual([]);
  const record = await h.store.getContinuation(SCOPE, ref.continuationId);
  expect(record?.status).toBe("finished");
  expect(record?.outcome).toBe("resumed");
  await h.close();
});

test("unknown_external_effect_is_not_replayed", async () => {
  const h = await harness({ label: "unknown" });
  const { ref } = await h.save();
  // The operation is recorded as STARTED with outcome unknown (the receipt
  // sink records before the external call): the external effect may have
  // landed, so the continuation ends pending_unknown — never auto-replayed.
  await h.store.recordOperationStarted(SCOPE, {
    operationId: h.operationId(),
    runId: `run-${h.label}`,
    toolCallId: "call_1",
    toolName: ME05_TOOL_NAME,
    argsDigest: DIGEST,
  });
  const result = await h.resume({ ref });
  expect(result).toMatchObject({ kind: "pending_unknown" });
  expect(h.executions).toEqual([]);
  const record = await h.store.getContinuation(SCOPE, ref.continuationId);
  expect(record?.status).toBe("finished");
  expect(record?.outcome).toBe("failed_unknown");
  await h.close();
});

test("claim_expiry_requires_receipt_evidence", async () => {
  const h = await harness({ label: "expiry", claimTtlMs: 50 });
  const operationIdFor = (key: string) =>
    continuationOperationId(key, "call_1", DIGEST);

  // (a) expired claim + EXECUTED receipt → reuse, never re-execute.
  const a = await h.save({ runId: "run-a", executionKey: "exec-a" });
  const claimA = await h.store.claimContinuation(
    SCOPE,
    a.ref,
    approvedDecision({ approvalId: "a-exp" }),
  );
  expect(claimA.claimToken).toBeTruthy();
  await h.store.recordOperationStarted(SCOPE, {
    operationId: operationIdFor("exec-a"),
    runId: "run-a",
    toolCallId: "call_1",
    toolName: ME05_TOOL_NAME,
    argsDigest: DIGEST,
  });
  await h.store.recordOperationExecuted(SCOPE, operationIdFor("exec-a"));
  await sleep(80);
  const reused = await h.resume({ ref: a.ref });
  expect(reused).toMatchObject({ kind: "reused_receipt" });

  // (b) expired claim + UNKNOWN receipt → pending_unknown, never replayed.
  const b = await h.save({ runId: "run-b", executionKey: "exec-b" });
  await h.store.claimContinuation(
    SCOPE,
    b.ref,
    approvedDecision({ approvalId: "b-exp" }),
  );
  await h.store.recordOperationStarted(SCOPE, {
    operationId: operationIdFor("exec-b"),
    runId: "run-b",
    toolCallId: "call_1",
    toolName: ME05_TOOL_NAME,
    argsDigest: DIGEST,
  });
  await sleep(80);
  const unknown = await h.resume({ ref: b.ref });
  expect(unknown).toMatchObject({ kind: "pending_unknown" });

  // (c) expired claim + NO receipt (the engine was never driven) → the claim
  // is re-taken and the resume completes exactly once.
  const c = await h.save({ runId: "run-c", executionKey: "exec-c" });
  const firstClaim = await h.store.claimContinuation(
    SCOPE,
    c.ref,
    approvedDecision({ approvalId: "c-exp" }),
  );
  await sleep(80);
  // The stale claim cannot be finished anymore — its token expired.
  await expect(
    h.store.finishContinuation(firstClaim, "resumed"),
  ).rejects.toMatchObject({ code: "MASTRA_CONTINUATION_CLAIM_EXPIRED" });
  const resumed = await h.resume({ ref: c.ref });
  expect(resumed).toMatchObject({ kind: "resumed" });
  expect(h.executions).toEqual(["call_1"]);
  await h.close();
});

test("crash_between_decision_and_claim_is_reappliable", async () => {
  const h = await harness({ label: "crash", claimTtlMs: 50 });
  const { ref } = await h.save();

  // First apply: the claim wins, then the process crashes before the engine
  // was driven (no receipt evidence, so nothing external can have run).
  const crashedDriver: MastraResumeDriver = {
    resume: async () => {
      throw new Error("SIMULATED_CRASH_AFTER_CLAIM");
    },
  };
  await expect(
    resumeMastraContinuation(
      {
        store: h.store,
        toolGrantCurrent: async () => true,
        generationCurrent: async () => true,
        driver: crashedDriver,
      },
      {
        scope: SCOPE,
        ref,
        decision: approvedDecision({ approvalId: "same-1" }),
      },
    ),
  ).rejects.toThrow("SIMULATED_CRASH_AFTER_CLAIM");
  await sleep(80);

  // Re-applying the SAME decision id recovers: the claim is idempotent on the
  // decision id and the resume drives exactly once.
  const reapplied = await resumeMastraContinuation(
    {
      store: h.store,
      toolGrantCurrent: async () => true,
      generationCurrent: async () => true,
      driver: {
        resume: async (input) => {
          h.executions.push(input.claim.payload.toolCallId);
          return "resumed";
        },
      },
    },
    {
      scope: SCOPE,
      ref,
      decision: approvedDecision({ approvalId: "same-1" }),
    },
  );
  expect(reapplied).toMatchObject({ kind: "resumed" });
  expect(h.executions).toEqual(["call_1"]);

  // Re-applying the SAME decision id after the continuation finished is an
  // idempotent no-op (repeated clicks / repeated webhooks), not a second run.
  const again = await resumeMastraContinuation(
    {
      store: h.store,
      toolGrantCurrent: async () => true,
      generationCurrent: async () => true,
      driver: {
        resume: async () => {
          h.executions.push("SECOND_RUN");
          return "resumed";
        },
      },
    },
    {
      scope: SCOPE,
      ref,
      decision: approvedDecision({ approvalId: "same-1" }),
    },
  );
  expect(again).toMatchObject({ kind: "already_applied" });
  expect(h.executions).toEqual(["call_1"]);
  await h.close();
});

test("continuation payload validation refuses non-v1 envelopes", async () => {
  const h = await harness({ label: "validation" });
  await expect(
    h.store.saveContinuation(
      bindingFor(h.label),
      payloadFor({ schemaVersion: 2 as never }),
    ),
  ).rejects.toMatchObject({ code: "MASTRA_CONTINUATION_PAYLOAD_INVALID" });
  await expect(
    h.store.saveContinuation(
      bindingFor(h.label),
      payloadFor({ engine: "langgraph" as never }),
    ),
  ).rejects.toMatchObject({ code: "MASTRA_CONTINUATION_PAYLOAD_INVALID" });
  await h.close();
});

function grantedEchoTool(): GrantedTool {
  return {
    name: ME05_TOOL_NAME,
    description: "Echo the value back.",
    parameters: z.object({ value: z.string() }),
    execute: async () => "echoed:hi",
    ref: `server/${ME05_TOOL_NAME}`,
  };
}

function wiringInput(label: string) {
  return {
    threadId: `thread-wiring-${label}`,
    runId: `client-${label}`,
    messages: [
      {
        id: "m1",
        role: "user" as const,
        content: "Echo hi with the tool, then answer.",
      },
    ],
    tools: [],
    context: [],
    forwardedProps: {},
  };
}

async function collect(
  observable: ReturnType<typeof runMastraExecution>,
): Promise<{ type: string; message?: unknown }[]> {
  const events: { type: string; message?: unknown }[] = [];
  await new Promise<void>((resolve) => {
    observable.subscribe({
      next: (event) =>
        events.push({
          type: event.type,
          message: (event as unknown as { message?: unknown }).message,
        }),
      error: (cause) => {
        events.push({ type: "STREAM_ERROR", message: String(cause) });
        resolve();
      },
      complete: () => resolve(),
    });
  });
  return events;
}

test(
  "suspension_saves_continuation_before_the_stream_ends",
  async () => {
    const database = createDatabase(databaseUrl!, { max: 3 });
    openDatabases.push(database);
    const store = createMastraContinuationStore({ database, secret: SECRET });
    const provider = await startFakeProvider();
    const mastraStorage = new PostgresStore({
      id: "me05-wiring",
      connectionString: databaseUrl!,
    });
    const binding = bindingFor("wiring", {
      runId: "wiring-run",
      executionKey: "wiring-exec",
    });
    const savedFacts: {
      fact: {
        kind: string;
        toolCallId: string;
        toolName: string;
        argsDigest: string;
        operationId: string;
      };
    }[] = [];
    let saveResolved = false;
    let events: { type: string; message?: unknown }[] = [];
    try {
      const observable = runMastraExecution({
        binding,
        input: wiringInput("wiring"),
        instructions: ["You are Bot A."],
        tools: [grantedEchoTool()],
        governedModel: {
          model: createCountingControlledModel(provider.url).model,
        } as never,
        continuations: {
          storage: mastraStorage,
          durableToolNames: [ME05_TOOL_NAME],
          onSuspension: async (fact) => {
            await store.saveContinuation(
              binding,
              payloadFor({
                toolCallId: fact.toolCallId,
                toolName: fact.toolName,
                argsDigest: fact.argsDigest,
                snapshotRef: fact.snapshotRef,
              }),
            );
            savedFacts.push({ fact });
            saveResolved = true;
          },
        },
        signal: new AbortController().signal,
      });
      events = await collect(observable);
      // The save completed BEFORE the observable completed: the recovery data
      // exists by the time any waiting state could be published downstream.
      expect(saveResolved).toBe(true);
      // A suspension is terminal-less: no success, no failure.
      expect(
        events.some((e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR"),
      ).toBe(false);
      expect(events.some((e) => e.type === "TOOL_CALL_START")).toBe(true);
      expect(savedFacts[0]?.fact).toMatchObject({
        kind: "approval",
        toolCallId: "call_me01_1",
        toolName: ME05_TOOL_NAME,
        argsDigest: DIGEST,
      });
      // The pending call never executed: no receipt evidence may exist.
      expect(
        await store.findReceipt(
          SCOPE,
          continuationOperationId("wiring-exec", "call_me01_1", DIGEST),
        ),
      ).toBeNull();
      // And the SAME durable state resumes from a fresh stack built on the
      // same storage (the snapshot the snapshotRef points at is real). The
      // engine keys suspended runs by the agent identity the suspension was
      // written under — the resume stack carries the SAME agent id
      // (`openbot-${binding.botId}`) as the execution.
      process.env.ME05_RUN_ID = "wiring-run";
      const stack = await buildMe05Stack({
        providerUrl: provider.url,
        dbUrl: databaseUrl!,
        requireApproval: true,
        agentId: "openbot-bot-a",
      });
      const suspended = await stack.agent.listSuspendedRuns();
      const run = suspended.runs.find((r) => r.runId === "wiring-exec");
      expect(run?.status).toBe("suspended");
      const output = await stack.agent.resumeStream(
        { approved: true },
        { runId: "wiring-exec", toolCallId: "call_me01_1" },
      );
      const reader = output.fullStream.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
      }
      expect(await output.finishReason).toBe("stop");
      await stack.store.close();
    } finally {
      await mastraStorage.close().catch(() => undefined);
      await provider.close();
    }
  },
  { timeout: 60_000 },
);

test(
  "save_failure_fails_run_instead_of_waiting",
  async () => {
    const provider = await startFakeProvider();
    const mastraStorage = new PostgresStore({
      id: "me05-wiring-fail",
      connectionString: databaseUrl!,
    });
    try {
      const observable = runMastraExecution({
        binding: bindingFor("wiring-fail", {
          runId: "wiring-fail-run",
          executionKey: "wiring-fail-exec",
        }),
        input: wiringInput("wiring-fail"),
        instructions: ["You are Bot A."],
        tools: [grantedEchoTool()],
        governedModel: {
          model: createCountingControlledModel(provider.url).model,
        } as never,
        continuations: {
          storage: mastraStorage,
          durableToolNames: [ME05_TOOL_NAME],
          onSuspension: async () => {
            throw new Error("STORAGE_DOWN");
          },
        },
        signal: new AbortController().signal,
      });
      const events = await collect(observable);
      // A suspension whose recovery data could not be saved must NEVER end as
      // a silent (waiting-publishable) stream: it fails with a named error.
      const runError = events.find((e) => e.type === "RUN_ERROR");
      expect(runError).toBeTruthy();
      expect(JSON.stringify(runError)).toContain(
        "MASTRA_CONTINUATION_SAVE_FAILED",
      );
      expect(events.some((e) => e.type === "RUN_FINISHED")).toBe(false);
    } finally {
      await mastraStorage.close().catch(() => undefined);
      await provider.close();
    }
  },
  { timeout: 60_000 },
);

/*
 * fix-round-1: the PRODUCTION resume driver's own refusal gates, exercised
 * directly (no database, no engine) — a drive may only start on an approval
 * continuation whose storage actually resolved.
 */
function claimFor(payload: ContinuationPayload): ClaimedContinuation {
  return {
    ref: { continuationId: "cont-driver", revision: 3 },
    binding: bindingFor("driver"),
    payload,
    claimToken: "token-driver",
  };
}

const NO_RECEIPTS = {
  started: async () => undefined,
  executed: async () => null,
};

test("production_driver_refuses_non_approval_continuations", async () => {
  const driver = createMastraResumeDriver({
    storageFor: () => {
      throw new Error("storage must not be touched for a foreign kind");
    },
  });
  let refusal: unknown;
  try {
    await driver.resume({
      claim: claimFor(payloadFor({ kind: "question" })),
      decision: { kind: "answered", responseId: "resp-1" },
      receiptSink: NO_RECEIPTS,
    });
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(MastraContinuationRefusal);
  expect((refusal as MastraContinuationRefusal).code).toBe(
    "MASTRA_CONTINUATION_DRIVE_UNSUPPORTED",
  );
});

test("production_driver_refuses_unresolved_storage", async () => {
  let loopForTouched = false;
  const driver = createMastraResumeDriver({
    storageFor: () => undefined,
    loopFor: () => {
      loopForTouched = true;
      return {};
    },
  });
  let refusal: unknown;
  try {
    await driver.resume({
      claim: claimFor(payloadFor()),
      decision: approvedDecision(),
      receiptSink: NO_RECEIPTS,
    });
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(MastraContinuationRefusal);
  expect((refusal as MastraContinuationRefusal).code).toBe(
    "MASTRA_CONTINUATION_STORAGE_MISSING",
  );
  // The loop surface is never assembled for a run whose snapshot storage did
  // not resolve — no guessed stack.
  expect(loopForTouched).toBe(false);
});

test("production_driver_refuses_decision_kind_mismatch", async () => {
  const driver = createMastraResumeDriver({
    storageFor: () => ({}),
  });
  let refusal: unknown;
  try {
    await driver.resume({
      claim: claimFor(payloadFor()),
      decision: { kind: "tool_result", receiptId: "receipt-1" },
      receiptSink: NO_RECEIPTS,
    });
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(MastraContinuationRefusal);
  expect((refusal as MastraContinuationRefusal).code).toBe(
    "MASTRA_CONTINUATION_DECISION_INCOMPATIBLE",
  );
});
```

=== NEW FILE (full content): server/tests/enterprise/mastra-continuations.integration.test.ts ===
```ts
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgresStore } from "@mastra/pg";
import { afterAll, expect, test } from "../../../tests/support/bun-test-compat";
import { createDatabase } from "../../src/db/client";
import { createMastraContinuationStore } from "../../src/mastra/continuation-store";
import { argsDigestFor } from "../../src/mastra/tools";
import { startFakeProvider } from "../../tests/support/me01-fixture";
import {
  buildMe05Stack,
  countMe05Receipts,
  createMe05Database,
  ME05_CHILD_RESULT_PREFIX,
  ME05_TOOL_NAME,
  type Me05Database,
} from "../../tests/support/me05-fixture";

/*
 * ME05 (#477) integration: the durable continuation against a REAL database,
 * across OS processes — a fresh process claims the pending continuation
 * (single CAS winner) and resumes the exact suspended operation, and two
 * racing processes cannot both hold the claim. Never executed twice: the
 * fixture's own receipt table is the exactly-once evidence.
 */

interface ChildResult {
  ok: boolean;
  pid?: number;
  mode?: string;
  claimed?: boolean;
  revision?: number;
  kind?: string;
  answer?: string;
  finishReason?: string;
  toolCallId?: string;
  argsDigest?: string;
  receiptStatusAtExecute?: string;
  error?: string;
  discovered?: string[];
}

// This file sits three directories under server/ — four ups reach the repo
// root the child script path is anchored to.
const workspaceRoot = join(fileURLToPath(import.meta.url), "../../../..");

function runChild(
  args: string[],
): Promise<{ pid: number; result: ChildResult }> {
  return new Promise((resolve, reject) => {
    // process.execPath: the SAME bun binary running this suite, not a PATH
    // lookup a spawned child may not inherit.
    const child = spawn(
      process.execPath,
      [join(workspaceRoot, "server/tests/support/me05-child.ts"), ...args],
      {
        cwd: join(workspaceRoot, "server"),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => {
      const line = stdout
        .split("\n")
        .find((candidate) => candidate.startsWith(ME05_CHILD_RESULT_PREFIX));
      if (!line) {
        reject(
          new Error(
            `me05 child exited ${code} without a result line; stderr: ${stderr.slice(-800)}`,
          ),
        );
        return;
      }
      resolve({
        pid: child.pid ?? -1,
        result: JSON.parse(
          line.slice(ME05_CHILD_RESULT_PREFIX.length),
        ) as ChildResult,
      });
    });
  });
}

const SCOPE = {
  tenantId: "tenant-x",
  workspaceId: "workspace-x",
  principalId: "principal-x",
  actorId: "actor-x",
  memberEpoch: 1,
  aclEpoch: 1,
  entrypoint: "web" as const,
};

let me05: Me05Database | undefined;
let databaseUrl: string | undefined;

afterAll(async () => {
  await me05?.drop();
});

test("new_process_can_resume", async () => {
  me05 = await createMe05Database();
  databaseUrl = me05.runtimeUrl;
  const provider = await startFakeProvider();
  const database = createDatabase(databaseUrl, { max: 3 });
  const store = createMastraContinuationStore({
    database,
    secret: "me05-integration-secret",
  });
  const mastraStorage = new PostgresStore({
    id: "me05-integration",
    connectionString: databaseUrl,
  });
  process.env.ME05_RUN_ID = "integration-run";
  try {
    // 1. The original process runs the gated loop and suspends durably.
    const parent = await buildMe05Stack({
      providerUrl: provider.url,
      dbUrl: databaseUrl,
      requireApproval: true,
    });
    const output = await parent.agent.stream(
      [{ role: "user", content: "Echo hi with the tool, then answer." }],
      { runId: "integration-exec" },
    );
    const reader = output.fullStream.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
    }
    expect(await output.finishReason).toBe("suspended");
    expect(await countMe05Receipts(me05.dbName, "integration-run")).toBe(0);

    // 2. The suspension saves its continuation BEFORE the waiting state is
    // published (the execution wiring's contract — here exercised through the
    // same save the wiring calls).
    const binding = {
      scope: SCOPE,
      botId: "bot-integration",
      runId: "integration-run",
      attemptId: "attempt-1",
      generation: 1,
      executionKey: "integration-exec",
      threadId: "thread-integration",
    };
    const suspendedCalls = ((await parent.agent.listSuspendedRuns()).runs.find(
      (run) => run.runId === "integration-exec",
    )?.toolCalls ?? []) as {
      toolCallId?: string;
      toolName?: string;
      args?: unknown;
    }[];
    const pending = suspendedCalls[0];
    expect(pending?.toolCallId).toBeTruthy();
    const ref = await store.saveContinuation(binding, {
      schemaVersion: 1,
      engine: "mastra",
      packageFingerprint: store.currentFingerprint(),
      kind: "approval",
      toolCallId: String(pending.toolCallId),
      toolName: String(pending.toolName ?? ME05_TOOL_NAME),
      argsDigest: argsDigestFor(pending.args ?? { value: "hi" }),
      snapshotRef: `suspended:integration-exec:${String(pending.toolCallId)}`,
    });
    await parent.store.close();

    // 3. A FRESH OS process claims (CAS) and resumes the exact operation
    // through the PRODUCTION path: the six-gate orchestrator plus the
    // production resume driver (fix-round-1).
    const child = await runChild([
      databaseUrl,
      databaseUrl,
      provider.url,
      ref.continuationId,
      JSON.stringify(SCOPE),
    ]);
    expect(child.result.ok, child.result.error).toBe(true);
    expect(child.pid).not.toBe(process.pid);
    expect(child.result.kind).toBe("resumed");
    expect(child.result.answer?.length ?? 0).toBeGreaterThan(0);
    expect(child.result.finishReason).toBe("stop");
    expect(child.result.toolCallId).toBe(String(pending.toolCallId));
    // Receipt ordering held across processes: at the instant the tool's
    // external effect ran, the continuation-store receipt was already
    // 'unknown' (started recorded, not yet confirmed) — never absent.
    expect(child.result.receiptStatusAtExecute).toBe("unknown");
    // Exactly one external execution, in the resumed process only.
    expect(await countMe05Receipts(me05.dbName, "integration-run")).toBe(1);

    // 4. The continuation is finished; nothing stays suspended; a SECOND
    // process claiming the same continuation cannot re-run it.
    const record = await store.getContinuation(SCOPE, ref.continuationId);
    expect(record?.status).toBe("finished");
    expect(record?.outcome).toBe("resumed");
    const again = await runChild([
      databaseUrl,
      databaseUrl,
      provider.url,
      ref.continuationId,
      JSON.stringify(SCOPE),
      "claim",
    ]);
    expect(again.result.ok).toBe(false);
    expect(again.result.error).toContain(
      "MASTRA_CONTINUATION_ALREADY_FINISHED",
    );
    expect(await countMe05Receipts(me05.dbName, "integration-run")).toBe(1);
    const probe = await buildMe05Stack({
      providerUrl: provider.url,
      dbUrl: databaseUrl,
    });
    const remaining = await probe.agent.listSuspendedRuns();
    expect(
      remaining.runs.find((run) => run.runId === "integration-exec"),
    ).toBeUndefined();
    await probe.store.close();
  } finally {
    await mastraStorage.close().catch(() => undefined);
    await database.$client.end({ timeout: 5 }).catch(() => undefined);
    await provider.close();
  }
});

test("two_resumers_only_one_claim", async () => {
  me05 ??= await createMe05Database();
  databaseUrl = databaseUrl ?? me05.runtimeUrl;
  const provider = await startFakeProvider();
  const database = createDatabase(databaseUrl, { max: 3 });
  const store = createMastraContinuationStore({
    database,
    secret: "me05-integration-secret",
  });
  const mastraStorage = new PostgresStore({
    id: "me05-integration-race",
    connectionString: databaseUrl,
  });
  process.env.ME05_RUN_ID = "race-run";
  try {
    const parent = await buildMe05Stack({
      providerUrl: provider.url,
      dbUrl: databaseUrl,
      requireApproval: true,
    });
    const output = await parent.agent.stream(
      [{ role: "user", content: "Echo hi with the tool, then answer." }],
      { runId: "race-exec" },
    );
    const reader = output.fullStream.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
    }
    const binding = {
      scope: SCOPE,
      botId: "bot-integration",
      runId: "race-run",
      attemptId: "attempt-1",
      generation: 1,
      executionKey: "race-exec",
      threadId: "thread-race",
    };
    const ref = await store.saveContinuation(binding, {
      schemaVersion: 1,
      engine: "mastra",
      packageFingerprint: store.currentFingerprint(),
      kind: "approval",
      toolCallId: "call_me01_1",
      toolName: ME05_TOOL_NAME,
      argsDigest: argsDigestFor({ value: "hi" }),
      snapshotRef: "suspended:race-exec:call_me01_1",
    });
    await parent.store.close();

    // Two real child processes race for the CAS claim: exactly one wins.
    const attempts = await Promise.all([
      runChild([
        databaseUrl,
        databaseUrl,
        provider.url,
        ref.continuationId,
        JSON.stringify(SCOPE),
        "claim",
      ]),
      runChild([
        databaseUrl,
        databaseUrl,
        provider.url,
        ref.continuationId,
        JSON.stringify(SCOPE),
        "claim",
      ]),
    ]);
    const winners = attempts.filter((a) => a.result.ok);
    const losers = attempts.filter((a) => !a.result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].result.error).toContain(
      "MASTRA_CONTINUATION_REVISION_CONFLICT",
    );
    expect(winners[0].result.claimed).toBe(true);
    // Nothing external executed: a claim is not an execution.
    expect(await countMe05Receipts(me05.dbName, "race-run")).toBe(0);
  } finally {
    await mastraStorage.close().catch(() => undefined);
    await database.$client.end({ timeout: 5 }).catch(() => undefined);
    await provider.close();
  }
});
```

=== NEW FILE (full content): server/tests/support/me05-fixture.ts ===
```ts
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { createTool } from "@mastra/core/tools";
import { PostgresStore } from "@mastra/pg";
import { z } from "zod";

/*
 * ME05 (#477) fixtures: ONE disposable database on the local test Postgres
 * (openbot-test-pg, host port ME01_TEST_PG_PORT) holding BOTH durable sides a
 * suspended execution touches —
 *
 *  1. the OpenBot continuation + receipt tables, created by applying the REAL
 *     drizzle migration `0164_mastra_execution_continuations.sql` (so the
 *     migration itself is what the tests exercise), granted to a restricted
 *     runtime login role, and
 *  2. the Mastra PostgresStore the durable toolCallStep persists suspension
 *     snapshots into, connected with the same restricted role.
 *
 * Everything is dropped in teardown. The dev DATABASE_URL is never read and
 * no .env is consulted.
 */

export const ME05_CHILD_RESULT_PREFIX = "ME05_CHILD_RESULT:";
export const ME05_TOOL_NAME = "echo_tool";
export const ME05_INSTRUCTIONS =
  "Use the echo tool when asked, then answer briefly from its result.";

const run = promisify(execFile);

function container(): string {
  return process.env.ME01_TEST_PG_CONTAINER ?? "openbot-test-pg";
}

function psql(database: string, sql: string): Promise<string> {
  return run(
    "docker",
    [
      "exec",
      container(),
      "psql",
      "-U",
      "postgres",
      "-d",
      database,
      "-tAc",
      sql,
    ],
    { timeout: 30_000 },
  ).then((result) => result.stdout.trim());
}

export interface Me05Database {
  runtimeUrl: string;
  dbName: string;
  roleName: string;
  drop(): Promise<void>;
}

/**
 * Disposable database + restricted runtime role (the me01 pattern), with the
 * repository's own 0164 continuation migration applied as the admin and then
 * granted to the runtime role. The store under test connects ONLY with the
 * restricted role, so ungranted access fails loudly instead of silently
 * running as a superuser.
 */
export async function createMe05Database(): Promise<Me05Database> {
  const dbName = `openbot_me05_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const roleName = `me05_rt_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const password = `me05_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const port = process.env.ME01_TEST_PG_PORT ?? "5433";
  try {
    await psql("postgres", `CREATE DATABASE "${dbName}"`);
    await psql(
      "postgres",
      `CREATE ROLE "${roleName}" LOGIN PASSWORD $$${password}$$ NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await psql(
      "postgres",
      `GRANT CONNECT ON DATABASE "${dbName}" TO "${roleName}"`,
    );
    // The Mastra store connects with this role and creates its own snapshot
    // tables at init (the me01 pattern): the restricted account owns what it
    // writes, so it needs USAGE+CREATE on the schema, nothing more.
    await psql(dbName, `GRANT USAGE, CREATE ON SCHEMA public TO "${roleName}"`);
    // The REAL migration file: split on the drizzle breakpoint marker and run
    // each statement with ON_ERROR_STOP, so a broken migration fails the
    // fixture instead of half-applying.
    const migration = await readFile(
      join(
        import.meta.dir,
        "..",
        "..",
        "drizzle",
        "0164_mastra_execution_continuations.sql",
      ),
      "utf8",
    );
    const statements = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await run(
        "docker",
        [
          "exec",
          container(),
          "psql",
          "-U",
          "postgres",
          "-d",
          dbName,
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          statement,
        ],
        { timeout: 30_000 },
      );
    }
    await psql(
      dbName,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "mastra_execution_continuations", "mastra_execution_receipts" TO "${roleName}"`,
    );
  } catch (error) {
    await psql(
      "postgres",
      `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`,
    ).catch(() => undefined);
    await psql("postgres", `DROP ROLE IF EXISTS "${roleName}"`).catch(
      () => undefined,
    );
    throw error;
  }
  const runtimeUrl = `postgresql://${roleName}:${encodeURIComponent(password)}@127.0.0.1:${port}/${dbName}`;
  return {
    runtimeUrl,
    dbName,
    roleName,
    async drop() {
      await psql(
        "postgres",
        `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`,
      ).catch(() => undefined);
      await psql("postgres", `DROP ROLE IF EXISTS "${roleName}"`).catch(
        () => undefined,
      );
    },
  };
}

/** Row count of the fixture's own executed-receipt table (exactly-once evidence). */
export async function countMe05Receipts(
  dbName: string,
  runId: string,
): Promise<number> {
  const escaped = runId.replace(/'/g, "''");
  const count = await psql(
    dbName,
    `SELECT count(*) FROM me05_tool_receipts WHERE run_id = '${escaped}'`,
  );
  return Number(count);
}

export interface Me05Stack {
  mastra: Mastra;
  agent: Agent;
  store: PostgresStore;
  /**
   * The loop surface the resume driver's `loopFor` reproduces (fix-round-1):
   * the counting model and the granted-tool record the suspension was written
   * under, so the production driver rebuilds the SAME loop shape.
   */
  model: unknown;
  tools: Record<string, unknown>;
}

/**
 * The durable stack every process uses for the gated tool loop: same agent
 * id, same requireApproval tool, storage-backed Mastra so a suspension
 * persists and a fresh process can resume (the ME01-proven surface). The
 * tool's execute writes one receipt row per execution — the exactly-once
 * evidence every resumers-race and replay test asserts against.
 */
export async function buildMe05Stack(options: {
  providerUrl: string;
  dbUrl: string;
  requireApproval?: boolean;
  /**
   * The engine's suspended-run listing is keyed by the agent identity the
   * suspension was written under, so a resume stack MUST carry the SAME agent
   * id as the stack that suspended (default: the fixture's own).
   */
  agentId?: string;
}): Promise<Me05Stack> {
  const agentId = options.agentId ?? "me05-agent";
  const store = new PostgresStore({
    id: `me05-${randomUUID().slice(0, 8)}`,
    connectionString: options.dbUrl,
  });
  try {
    await store.pool.query(`CREATE TABLE IF NOT EXISTS me05_tool_receipts (
         id serial PRIMARY KEY,
         run_id text NOT NULL,
         tool_call_id text NOT NULL,
         args_digest text NOT NULL,
         receipt_status_at_execute text NOT NULL DEFAULT 'not-probed',
         executed_at timestamptz NOT NULL DEFAULT now()
       )`);
    const gatedTool = createTool({
      id: ME05_TOOL_NAME,
      description: "Echo the given value back once.",
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ echo: z.string() }),
      suspendSchema: z.object({ question: z.string() }),
      resumeSchema: z.object({ approved: z.boolean() }),
      ...(options.requireApproval ? { requireApproval: true as const } : {}),
      execute: async (input, context) => {
        const value = (input as { value: string }).value;
        const runId = process.env.ME05_RUN_ID ?? "unknown";
        const toolCallId = String(
          (context as { toolCallId?: string } | undefined)?.toolCallId ??
            "missing",
        );
        // The ordering probe (fix-round-1): at the instant the external
        // effect runs, the continuation-store receipt for THIS run must
        // already exist as 'unknown' (started recorded, not yet confirmed).
        // 'absent' would mean the resume reached the tool before the receipt.
        // Keyed by run id only: the resumed engine's execute context may not
        // carry the payload's toolCallId spelling, and the run has exactly
        // one pending operation.
        const probe = await store.pool.query(
          `SELECT status FROM mastra_execution_receipts WHERE run_id = $1 LIMIT 1`,
          [runId],
        );
        const receiptStatusAtExecute = String(
          probe.rows[0]?.status ?? "absent",
        );
        await store.pool.query(
          `INSERT INTO me05_tool_receipts (run_id, tool_call_id, args_digest, receipt_status_at_execute) VALUES ($1, $2, $3, $4)`,
          [runId, toolCallId, value, receiptStatusAtExecute],
        );
        return { echo: value };
      },
    });
    const model = (
      await import("./me01-fixture")
    ).createCountingControlledModel(options.providerUrl).model;
    const agent = new Agent({
      id: agentId,
      name: "ME05 Agent",
      instructions: ME05_INSTRUCTIONS,
      model: model as never,
      tools: { [ME05_TOOL_NAME]: gatedTool },
    });
    const mastra = new Mastra({
      agents: { [agentId]: agent },
      storage: store,
    });
    return {
      mastra,
      agent,
      store,
      model,
      tools: { [ME05_TOOL_NAME]: gatedTool },
    };
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }
}
```

=== NEW FILE (full content): server/tests/support/me05-child.ts ===
```ts
import { createDatabase } from "../../src/db/client";
import { resumeMastraContinuation } from "../../src/mastra/approvals";
import { createMastraContinuationStore } from "../../src/mastra/continuation-store";
import { createMastraResumeDriver } from "../../src/mastra/resume-driver";
import {
  buildMe05Stack,
  ME05_CHILD_RESULT_PREFIX,
  ME05_INSTRUCTIONS,
  ME05_TOOL_NAME,
} from "./me05-fixture";

/**
 * ME05 resume child: a separate OS process that opens the SAME durable state
 * from the same databases — the OpenBot continuation store and the Mastra
 * snapshot storage — and applies an approved decision through the PRODUCTION
 * path (fix-round-1): the six-gate orchestrator `resumeMastraContinuation`
 * with the single CAS claim, and the production `createMastraResumeDriver`
 * (receipt `started` strictly before the engine can reach the external call).
 * Prints one JSON line prefixed with ME05_CHILD_RESULT.
 *
 * argv: [continuationDbUrl, mastraDbUrl, providerUrl, continuationId, scopeJson, mode?]
 *
 * mode "claim" (default "resume"): claim only, then exit — the concurrency
 * race entry, where exactly one of two processes may win the CAS. It targets
 * the raw store claim deliberately: the race subject IS the CAS primitive the
 * orchestrator rides.
 */
async function main(): Promise<void> {
  const [
    continuationDbUrl,
    mastraDbUrl,
    providerUrl,
    continuationId,
    scopeJson,
  ] = process.argv.slice(2, 7);
  const mode = process.argv[7] === "claim" ? "claim" : "resume";
  if (
    !continuationDbUrl ||
    !mastraDbUrl ||
    !providerUrl ||
    !continuationId ||
    !scopeJson
  ) {
    console.error(
      "usage: me05-child.ts <continuationDbUrl> <mastraDbUrl> <providerUrl> <continuationId> <scopeJson>",
    );
    process.exit(2);
  }
  const database = createDatabase(continuationDbUrl, { max: 2 });
  let stack: Awaited<ReturnType<typeof buildMe05Stack>> | undefined;
  try {
    const store = createMastraContinuationStore({
      database,
      secret: "me05-child-claim-secret",
    });
    const scope = JSON.parse(scopeJson) as Parameters<
      ReturnType<typeof createMastraContinuationStore>["getContinuation"]
    >[0];
    const record = await store.getContinuation(scope, continuationId);
    if (!record) {
      console.log(
        `${ME05_CHILD_RESULT_PREFIX}${JSON.stringify({
          ok: false,
          error: "CONTINUATION_NOT_FOUND",
        })}`,
      );
      process.exitCode = 1;
      return;
    }
    // The tool's receipt rows key on the BUSINESS run identity the
    // continuation binds — the exactly-once evidence the parent asserts on.
    process.env.ME05_RUN_ID = record.binding.runId;
    if (mode === "claim") {
      const claim = await store.claimContinuation(scope, record.ref, {
        kind: "approved",
        approvalId: `child-approval-${continuationId}`,
        argsDigest: record.payload.argsDigest,
      });
      console.log(
        `${ME05_CHILD_RESULT_PREFIX}${JSON.stringify({
          ok: true,
          pid: process.pid,
          mode,
          claimed: true,
          revision: claim.ref.revision,
        })}`,
      );
      return;
    }
    stack = await buildMe05Stack({
      providerUrl,
      dbUrl: mastraDbUrl,
      requireApproval: true,
    });
    // The production resume: same six gates, same CAS, same receipt
    // ordering as the wired copilot install — the loop surface (model,
    // tools, agent id) is re-resolved server-side from the fixture stack,
    // never from the continuation payload.
    const driver = createMastraResumeDriver({
      storageFor: () => stack!.store,
      loopFor: () => ({
        model: stack!.model,
        tools: stack!.tools,
        instructions: [ME05_INSTRUCTIONS],
        agentId: "me05-agent",
        durableToolNames: [ME05_TOOL_NAME],
      }),
    });
    const result = await resumeMastraContinuation(
      {
        store,
        toolGrantCurrent: async () => true,
        generationCurrent: async () => true,
        driver,
      },
      {
        scope,
        ref: record.ref,
        decision: {
          kind: "approved",
          approvalId: `child-approval-${continuationId}`,
          argsDigest: record.payload.argsDigest,
        },
      },
    );
    const probe = await stack.store.pool.query(
      `SELECT receipt_status_at_execute FROM me05_tool_receipts WHERE run_id = $1`,
      [record.binding.runId],
    );
    console.log(
      `${ME05_CHILD_RESULT_PREFIX}${JSON.stringify({
        ok: true,
        pid: process.pid,
        mode,
        kind: result.kind,
        answer: "answer" in result ? result.answer : undefined,
        finishReason: "finishReason" in result ? result.finishReason : undefined,
        toolCallId: record.payload.toolCallId,
        argsDigest: record.payload.argsDigest,
        receiptStatusAtExecute: probe.rows[0]?.receipt_status_at_execute,
      })}`,
    );
  } finally {
    await stack?.store.close();
    await database.$client.end({ timeout: 5 }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.log(
    `${ME05_CHILD_RESULT_PREFIX}${JSON.stringify({
      ok: false,
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    })}`,
  );
  process.exitCode = 1;
});
```

=== SHARED FILES cumulative diff vs BASE (ME02+ME03+ME05 mixed; review ONLY the ME05 seams above) ===
```diff
diff --git a/server/src/copilot.ts b/server/src/copilot.ts
index d6b6dc4b..d8790e94 100644
--- a/server/src/copilot.ts
+++ b/server/src/copilot.ts
@@ -39,6 +39,7 @@ import {
   CoworkerUnavailableError,
 } from "./agents/agent-resolver";
 import { sanitizeSeededHistory } from "./agents/history-sanitize";
+import type { PlatformScope } from "./enterprise/contracts";
 import {
   PLAN_RUN_COMPLETED,
   PlanModel,
@@ -51,6 +52,7 @@ import {
   nativeApprovalRun,
 } from "./approvals/native-context";
 import type { AuditInitiator } from "./audit";
+import { CreditInsufficientError } from "./billing/payer-binding";
 import {
   attachmentIdsIn,
   newInlineBudget,
@@ -80,6 +82,25 @@ import {
   type LearningRuntime,
 } from "./learning/runtime";
 import type { LearningSettingsStore } from "./learning/settings";
+import {
+  createMastraAgUiAgent,
+  observableToAsyncIterable,
+} from "./mastra/ag-ui-agent";
+import {
+  type MastraContinuationInstall,
+  type MastraContinuationResumeResult,
+  MastraContinuationRefusal,
+} from "./mastra/approvals";
+import {
+  createProducedMessageCollector,
+  type MastraConversationRuntime,
+} from "./mastra/conversation-runtime";
+import type {
+  ExecuteMastra,
+  ExecutionBinding,
+  ResumeDecision,
+} from "./mastra/execution-contracts";
+import { executeGovernedMastra } from "./mastra/governed-agent";
 import {
   type LoadPersonalMemory,
   PersonalMemoryMiddleware,
@@ -98,7 +119,6 @@ import type { GrantedTool } from "./plugins/tools";
 import { grantedToolGuidance, parametersFor } from "./plugins/tools";
 import { UNTRUSTED_GUIDANCE } from "./untrusted-content";
 import { currentUsageOrigin, type UsageOrigin } from "./usage-origin";
-import { CreditInsufficientError } from "./billing/payer-binding";
 
 export { currentRunnerRequest, withRunnerRequestContext };
 
@@ -2108,6 +2128,326 @@ function meteredModel<T>(
 
 export const meteredModelForTests = meteredModel;
 
+/**
+ * Which engine executes a governed built-in Bot's run (ME02, #474).
+ *
+ * A server-side seam, exactly like the meter and the gateway transport: the
+ * composition (or a test assembly) installs a selector, and absent one every
+ * Bot keeps the legacy built-in engine. The selector is consulted only inside
+ * a governed admission — the Mastra path exists only where the Runner has
+ * admitted the run, minted the governed model collaborator and bound its
+ * identity, so no client field can choose it and no provider-keyed build can
+ * reach it. This ticket does not flip any default.
+ */
+export type BuiltinExecutionEngine = "legacy" | "mastra";
+
+let builtinExecutionEngineFor:
+  | ((input: { botId: string; governed: boolean }) => BuiltinExecutionEngine)
+  | undefined;
+
+/**
+ * Install (or clear) the server-side engine selector. Pass `undefined` to
+ * restore the default: every Bot on the legacy engine.
+ */
+export function setBuiltinExecutionEngine(
+  selector:
+    | ((input: { botId: string; governed: boolean }) => BuiltinExecutionEngine)
+    | undefined,
+): void {
+  builtinExecutionEngineFor = selector;
+}
+
+/**
+ * The server-side conversation runtime the Mastra engine path runs against
+ * (ME03 #475): `loadExecutionInput` rebuilds the model context from the
+ * server's persisted, principal-authorized history, and
+ * `persistExecutionMessages` records the engine's answer through the
+ * ConversationService single-writer seam.
+ *
+ * A composition seam exactly like {@link setBuiltinExecutionEngine}: the
+ * server assembly installs the production runtime; a test assembly may
+ * install one over its own storage. Unlike the selector this is NOT optional
+ * on the engine path — a Mastra-selected run without a wired runtime refuses
+ * (`MASTRA_CONVERSATION_RUNTIME_UNWIRED`) instead of silently running on the
+ * browser's echoed history: the spec's authority for a turn's history is the
+ * server store, never the client.
+ */
+let mastraConversationRuntime: MastraConversationRuntime | undefined;
+
+export function setMastraConversationRuntime(
+  runtime: MastraConversationRuntime | undefined,
+): void {
+  mastraConversationRuntime = runtime;
+}
+
+/**
+ * ME05 (#477): the durable-continuation install the Mastra engine path runs
+ * with — tenant engine storage for suspension snapshots, the durable tool
+ * names, the save-before-waiting hook and the accurate-resume entry. The same
+ * composition-seam shape as the conversation runtime: the server assembly
+ * installs the production install; a test assembly installs its own. UNWIRED
+ * the engine behaves exactly as before ME05 (a suspension stays in-process
+ * and terminal-less) — never half-wired.
+ */
+let mastraContinuations: MastraContinuationInstall | undefined;
+
+export function setMastraContinuations(
+  install: MastraContinuationInstall | undefined,
+): void {
+  mastraContinuations = install;
+}
+
+export function mastraContinuationInstall():
+  | MastraContinuationInstall
+  | undefined {
+  return mastraContinuations;
+}
+
+/**
+ * ME05 fix-round-1: the ONE named entry the approvals HTTP route consumes to
+ * apply an authenticated decision to a durable continuation. The
+ * approvals-integration slice calls exactly this function from its handler;
+ * the routes themselves are untouched by the ME05 slice. Everything
+ * server-owned (the store, the production resume driver, the six gates, the
+ * CAS claim, the receipt ordering) flows from the installed
+ * {@link MastraContinuationInstall} — the caller supplies only the
+ * authenticated scope and decision.
+ *
+ * Unwired (no `setMastraContinuations` install) it refuses with a named
+ * composition error instead of silently dropping the decision: a durable
+ * approval must never read as "nothing to resume" merely because the
+ * assembly did not run.
+ */
+export async function resumeFromApprovalDecision(input: {
+  scope: PlatformScope;
+  continuationId: string;
+  revision: number;
+  decision: ResumeDecision;
+}): Promise<MastraContinuationResumeResult> {
+  const install = mastraContinuations;
+  if (!install) {
+    throw new MastraContinuationRefusal(
+      "MASTRA_CONTINUATIONS_UNWIRED",
+      "MASTRA_CONTINUATIONS_UNWIRED: no durable-continuation install is wired; the approval decision cannot be applied.",
+    );
+  }
+  return install.resume({
+    scope: input.scope,
+    ref: {
+      continuationId: input.continuationId,
+      revision: input.revision,
+    },
+    decision: input.decision,
+  });
+}
+
+/**
+ * Wrap one governed execution so its produced messages are PERSISTED before
+ * the success terminal is forwarded.
+ *
+ * The runner settles completion when RUN_FINISHED reaches it, so holding that
+ * terminal back until `persistExecutionMessages` resolved puts the answer in
+ * the conversation store BEFORE settle-complete semantics can run: a refresh
+ * or a pagination read shows the answer even before the completion is
+ * published, and a persistence failure fails the run instead of completing a
+ * turn whose answer the store would never show. The governed/settlement
+ * contract itself is untouched — the runner's owner-complete rules still gate
+ * completion exactly as before.
+ */
+function withPersistedOutput(
+  execute: ExecuteMastra,
+  runtime: MastraConversationRuntime,
+  binding: ExecutionBinding,
+): ExecuteMastra {
+  return (request) =>
+    new Observable<BaseEvent>((subscriber) => {
+      const collector = createProducedMessageCollector();
+      let terminal: BaseEvent | undefined;
+      let tornDown = false;
+      const subscription = execute(request).subscribe({
+        next: (event) => {
+          if (tornDown || terminal !== undefined) return;
+          if (event.type === "RUN_FINISHED") {
+            terminal = event;
+            return;
+          }
+          collector.push(event);
+          subscriber.next(event);
+        },
+        error: (cause) => {
+          if (!tornDown) subscriber.error(cause);
+        },
+        complete: () => {
+          if (tornDown) return;
+          if (terminal === undefined) {
+            // Terminal-less suspension: no success to persist behind.
+            subscriber.complete();
+            return;
+          }
+          runtime.persistExecutionMessages(binding, collector.snapshot()).then(
+            () => {
+              if (tornDown) return;
+              subscriber.next(terminal);
+              subscriber.complete();
+            },
+            (cause) => {
+              if (!tornDown) subscriber.error(cause);
+            },
+          );
+        },
+      });
+      return () => {
+        tornDown = true;
+        subscription.unsubscribe();
+      };
+    });
+}
+
+/**
+ * The built-in configuration for a Bot the server selected onto the Mastra
+ * engine (ME02).
+ *
+ * A factory config, so BuiltInAgent still owns the lifecycle while the
+ * factory yields the Mastra execution's canonical events directly. The
+ * binding is resolved at FACTORY time — after the governed Runner bound the
+ * run identities — and fails closed before that. The trusted prompt parts
+ * are the same composition the classic governed path builds; the execution
+ * composes them server-side and never lets client context or forwardedProps
+ * near them.
+ *
+ * ME04 (#476) wired the granted connector tools onto this path: the execution
+ * request carries the Bot's held tools and the trusted prompt composes the
+ * same held-tool/connected-vendor guidance the legacy prompt does. A Bot
+ * holding learned skills or computer guidance is still not wired — the
+ * configuration refuses rather than running those outside the governed
+ * approval wrapper (ME06/ME08 wire them).
+ *
+ * ME03 (#475) wired the conversation contract onto this path: the run input
+ * is rebuilt server-side by `loadExecutionInput` (the client-supplied history
+ * never reaches the model) and the produced messages are persisted through
+ * `persistExecutionMessages` before the success terminal reaches the runner.
+ */
+function mastraAgentConfiguration(input: {
+  agent: RegisteredBuiltInAgent;
+  governedModel: GovernedModelRequest;
+  standing: string | null;
+  tools: GrantedTool[];
+  learnedSkills?: LearnedSkillInvocation;
+  computerGuidance?: string;
+  /** Vendors this deployment connects to, held or not: prompt honesty. */
+  connectedVendors: readonly string[];
+}): BuiltInAgentConfiguration {
+  const {
+    agent,
+    governedModel,
+    standing,
+    tools,
+    learnedSkills,
+    computerGuidance,
+    connectedVendors,
+  } = input;
+  // ME04 wired the granted connector tools onto this engine (below), so the
+  // remaining genuinely-unsupported surfaces still fail closed: learned
+  // skills (ME08) and the computer guidance (ME06 wires the browser tools) —
+  // computer-deployed Bots carry it on every run, and without the guard they
+  // would silently lose the hands the legacy path gave them.
+  if (
+    (learnedSkills?.tools.length ?? 0) > 0 ||
+    computerGuidance !== undefined
+  ) {
+    return {
+      type: "custom",
+      // biome-ignore lint/correctness/useYield: this agent must fail when iteration starts.
+      factory: async function* () {
+        throw new Error(
+          "MASTRA_TEXT_ONLY_SLICE: this engine selection does not wire learned skills or computer guidance yet; they are wired by the later migration tickets.",
+        );
+      },
+    };
+  }
+  const instructionParts = [
+    agent.systemPrompt,
+    ...(standing ? [standing] : []),
+    // ME04: the held-tool guidance the legacy prompt composes from the same
+    // grants, including the connected-but-not-held vendor paragraph. With
+    // tools attached the Bot must be told about the hands it has — and about
+    // the connectors it does not hold — in the legacy wording, never re-authored.
+    ...(grantedToolGuidance(tools, connectedVendors)
+      ? [grantedToolGuidance(tools, connectedVendors)]
+      : []),
+    // Deliberately no computer guidance: still refused above until ME06.
+  ];
+  return {
+    type: "custom",
+    factory: (factoryContext) => {
+      const abortSignal = factoryContext.abortSignal;
+      // MASTRA_TEXT_ONLY_SLICE contract: fail-closed guards live inside the
+      // generator so an unwired surface fails as a structured RUN_ERROR at
+      // iteration time, never as a synchronous throw out of the factory.
+      return (async function* () {
+        const facts = governedModel.executionBinding?.();
+        if (!facts) throw new Error("EXECUTION_BINDING_UNBOUND");
+        // ME03 production wiring: the engine path runs on the server-rebuilt
+        // authorized history and persists its output through the conversation
+        // runtime. Without one the run refuses rather than executing on the
+        // browser's echoed transcript.
+        const runtime = mastraConversationRuntime;
+        if (!runtime) throw new Error("MASTRA_CONVERSATION_RUNTIME_UNWIRED");
+        // The model context is the server's persisted history — the client's
+        // system/tool/user echo is consumed only for the submitted-message
+        // key and then dropped. A thread that does not resolve to this
+        // principal (or history that fails verification) fails the turn.
+        const rebuilt = await runtime.loadExecutionInput(
+          facts.scope,
+          factoryContext.input,
+        );
+        const binding: ExecutionBinding = {
+          ...facts,
+          // The wire threadId is authoritative only after the rebuild proved
+          // it resolves to this principal's mastra conversation; persistence
+          // refuses a binding without one.
+          threadId: rebuilt.threadId,
+        };
+        // ME05: when the continuation install is wired, EVERY execution runs
+        // with its durable context — tenant engine storage, the durable tool
+        // names and the save-before-waiting hook — merged server-side into
+        // the execution request. Unwired, the execute path is untouched.
+        const install = mastraContinuations;
+        const execute: ExecuteMastra = install
+          ? (request) =>
+              executeGovernedMastra({
+                ...request,
+                continuations: {
+                  storage: install.storageFor(request.binding),
+                  durableToolNames: install.durableToolNames,
+                  onSuspension: (suspension) =>
+                    install
+                      .saveSuspension(request.binding, suspension)
+                      .then(() => undefined),
+                },
+              })
+          : executeGovernedMastra;
+        const executionAgent = createMastraAgUiAgent(
+          withPersistedOutput(execute, runtime, binding),
+          binding,
+          {
+            instructions: instructionParts,
+            // ME04: the granted connector tools ride the execution request;
+            // the controlled wrapper (mastra/tools.ts) mounts them per call
+            // with this run's abort signal as the stop wire.
+            tools,
+            governedModel,
+          },
+        );
+        yield* observableToAsyncIterable(
+          executionAgent.run(rebuilt),
+          abortSignal,
+        );
+      })();
+    },
+  };
+}
+
 /**
  * Wrap the model instance in the usage meter when one is wired and the model is an instance (the
  * string form is resolved by the runtime itself, where this file cannot reach). The build's
@@ -2218,6 +2558,20 @@ export function builtInAgentConfiguration(
 
   if (governedModel) {
     governedModel.markConsumed();
+    if (
+      builtinExecutionEngineFor?.({ botId: agent.id, governed: true }) ===
+      "mastra"
+    ) {
+      return mastraAgentConfiguration({
+        agent,
+        governedModel,
+        standing,
+        tools,
+        learnedSkills,
+        computerGuidance,
+        connectedVendors,
+      });
+    }
     return {
       model: governedModel.model,
       prompt: [
```
