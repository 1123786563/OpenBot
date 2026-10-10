/**
 * Public run-ledger DTOs and the strict public request schema, per plan 03 §3.1.
 *
 * What an unauthenticated or tenant-member caller may see and send: the run
 * states, the ID/decimal-string shapes, the create-run request, and the public
 * run/event views. No Scope, no capability, no internal address, no price —
 * those live server-side (`server/src/enterprise/runs/contracts.ts`) and are
 * re-exported as types only, never into shared.
 *
 * Every Zod object here is `.strict()`: a caller smuggling extra keys — a
 * tenant id, a resume object, a tool result — is probing, not configuring, so
 * the request is refused rather than silently trimmed.
 *
 * Database bigint values (revision, seq, amounts) travel as plain decimal
 * strings in JSON and are never parsed into JS numbers; `Decimal` is that
 * contract at the schema layer.
 */

import { z } from "zod";

/** The run lifecycle the ledger owns. Terminal: succeeded/failed/cancelled/expired. */
export const RunStates = [
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
  "suspended",
  "cancel_requested",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const;
export type RunStatus = (typeof RunStates)[number];

/**
 * The tenant-scoped identifier shape: URL-safe, bounded, no separators to
 * mis-parse. It locates; it never authorizes on its own.
 */
export const ID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/**
 * The Idempotency-Key contract (plan 03 §3.1): the SAME character limit as
 * ID. The value is caller-generated and carries deduplication meaning only —
 * it never authorizes anything, and a replay re-checks current authorization
 * in the run transaction instead of serving from a cache hit. E1-C's route
 * validates the header against this schema; the store re-verifies the grant
 * on every replay.
 */
export const IdempotencyKeySchema = ID;

/**
 * A bigint as JSON: plain decimal digits, no sign, no exponent, no padding.
 * `-1` and `1e5` are not amounts or revisions, whatever produces them.
 */
export const Decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);

/**
 * The whole create-run request. The client contributes business intent and
 * NEW USER TEXT, nothing else: tenant/principal are derived from the
 * authenticated session, attempt/fence/price/budget are server-owned, and
 * resume or tool results are platform decisions — none of them are fields
 * here, and strictness is what makes that a refusal instead of a trim.
 */
export const CreateRunSchema = z
  .object({
    thread_id: ID.optional(),
    workspace_id: ID,
    expert_release_id: ID,
    model_alias: ID,
    input: z.object({ text: z.string().min(1).max(32768) }).strict(),
  })
  .strict();
export type CreateRun = z.infer<typeof CreateRunSchema>;

/** The public projection of a run: coordinates and ledger facts, no input, no secrets. */
export const RunViewSchema = z
  .object({
    run_id: ID,
    thread_id: ID,
    status: z.enum(RunStates),
    revision: Decimal,
    latest_seq: Decimal,
    reconciliation_required: z.boolean(),
    reason_code: z.string().nullable(),
  })
  .strict();
export type RunView = z.infer<typeof RunViewSchema>;

/** One committed public event: replayable by seq, ordered per run. */
export const RunEventViewSchema = z
  .object({
    schema_version: z.literal("1"),
    event_id: ID,
    run_id: ID,
    turn_id: ID.nullable(),
    seq: Decimal,
    occurred_at: z.string(),
    type: z.string(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type RunEventView = z.infer<typeof RunEventViewSchema>;
