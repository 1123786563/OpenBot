/**
 * Server-internal run-ledger contracts, per plan 03 §3.2.
 *
 * These are process-internal types on purpose: they live next to Scope and Tx
 * so shared/web code cannot import them by accident. The public surface a
 * client may see is `shared/enterprise/run-contracts.ts`; this file is the
 * seam the store (E1), the leases/checkpoints (E2), the streams (E3), the
 * budget port (E4) and the 04 effects ledger all code against.
 *
 * Nothing here is implemented yet — E1-A freezes the contracts so the later
 * work packages converge on one shape instead of growing parallel ones.
 */

import type {
  CreateRun,
  RunEventView,
  RunView,
} from "../../../../shared/enterprise/run-contracts";
import type { Scope, Tx } from "../contracts";

/**
 * A caller command on an existing run. `expected_revision` is the CAS
 * precondition; a stale one is a 409, never an overwrite. The kinds are the
 * three intents a principal may express — the store maps them to fixed
 * transitions, so "resume" is a request the server re-authorizes, not a
 * framework object the client replays.
 */
export type RunCommand = {
  command_id: string;
  expected_revision: string;
  kind: "cancel" | "input" | "resume";
  input?: { text: string };
};

/** The run service the public routes consume; every call runs inside a Scope. */
export interface RunService {
  /**
   * `key` is the caller's Idempotency-Key, already validated by the route
   * against `IdempotencyKeySchema` (shared/enterprise/run-contracts.ts — the
   * ID character limit, plan 03 §3.1). It has deduplication meaning only:
   * every replay re-runs authorization inside the create transaction, so a
   * cache hit can never bypass a revocation.
   */
  create(scope: Scope, key: string, request: CreateRun): Promise<RunView>;
  get(scope: Scope, id: string): Promise<RunView>;
  command(scope: Scope, id: string, command: RunCommand): Promise<RunView>;
  readEvents(
    scope: Scope,
    id: string,
    after: string,
    limit: number,
  ): Promise<RunEventView[]>;
}

/**
 * The full execution tuple a verified runtime holds for one attempt: the
 * lease-fenced identity an internal callback must present, field for field.
 * Tenant identity comes from the capability's bound run, never from a body.
 */
export type AttemptBinding = {
  tenant_id: string;
  run_id: string;
  attempt_id: string;
  turn_id: string;
  lease_id: string;
  fencing_token: string;
  service_id: string;
};

/**
 * One dispatch claim from the outbox: the claim token is server-generated and
 * changes on every claim, so an expired claimant cannot ACK a takeover.
 */
export type DispatchJob = {
  job_id: string;
  claim_token: string;
  workflow_id: string;
  run_id: string;
  tenant_id: string;
};

/**
 * The only way the run domain starts orchestration. `already_started` is a
 * real answer (idempotent re-delivery), `unknown` is neither yes nor no and
 * must be reconciled by workflow id — never retried into a second workflow.
 */
export interface WorkflowStarter {
  start(job: DispatchJob): Promise<{
    status: "started" | "already_started" | "unknown" | "rejected";
    receipt_ref: string | null;
  }>;
}

/**
 * The effect barrier's summary, read at a barrier revision: what is settled,
 * what is pending, and what is UNKNOWN. An unknown effect is not a completed
 * one; emptiness of this list is never read as "nothing happened" — the
 * production reader is 04's ledger, not a guess.
 */
export type EffectSummary = {
  revision: string;
  pending: number;
  unknown: number;
  active: number;
  completed_operation_refs: string[];
};

/** Reads the effect summary for a run. Production implementation is owned by 04. */
export interface EffectsReader {
  read(scope: Scope, runId: string): Promise<EffectSummary>;
}

/**
 * The trusted recovery context the runtime pulls over the internal channel for
 * a new attempt: confirmed checkpoint reference, the digest binding it, and
 * the operation refs already settled. Client history never becomes this.
 */
export type RecoveryContext = {
  schema_version: "1";
  checkpoint_id: string | null;
  context_digest: string;
  message_refs: string[];
  completed_operation_refs: string[];
  pending_approval_ref: string | null;
};

/** The control plane's receipt for a cancellation call: "exited" is proven exit, not hope. */
export type RuntimeControlReceipt = {
  status: "accepted" | "exited" | "not_found" | "unknown";
  receipt_ref: string | null;
};

/** Cancels a bound attempt. `not_found` is not proof a run stopped. */
export interface RuntimeControl {
  cancel(binding: AttemptBinding): Promise<RuntimeControlReceipt>;
}

/**
 * The budget seam the run-creation transaction calls. Implementations (E4-B)
 * must reserve inside the SAME `Tx` — a reservation that can outlive the run's
 * transaction is an orphan, and a port that always succeeds is not a port.
 */
export type BudgetPort = {
  reserveInTx(tx: Tx, input: ReserveInput): Promise<string>;
};

/** Everything the reservation needs; tenant comes from the trusted tx context, not a request. */
export type ReserveInput = {
  tenantId: string;
  runId: string;
  principalId: string;
  workspaceId: string;
  expertReleaseId: string;
  reservationId: string;
  capMicros: string;
  currency: string;
  periodId: string;
};

/**
 * The run-domain services the PUBLIC entry mounts, per plan 03 §9.3's optional `runServices`
 * dependency object: present only when the run feature is explicitly enabled. Without it the
 * app registers no run implementation at all — POST /runs answers an explicit 503 instead of
 * an empty success.
 */
export type RunServices = { runs: RunService };
