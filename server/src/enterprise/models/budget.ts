/**
 * The budget port: two-layer reservation, per-call allocation and settlement
 * over the E1-B budget tables, per plan 03 §8.2.
 *
 * Layering: `reserveInTx` (inside the run-creation transaction) holds the
 * approved run cap simultaneously on the FOUR layer accounts
 * (tenant/workspace/expert/principal) — four constraints on one spend, never
 * four amounts to add up — and inserts the reservation (held=cap,
 * allocated=0). Any layer refusing (missing, inactive, out of window, or
 * spent+held+cap past its limit) throws BUDGET_EXCEEDED and the caller's
 * whole transaction rolls back, run row included. `allocateCallInTx` moves
 * call_cap into the reservation's `allocated` only — account holds never
 * change — under `allocated+cap<=held`, so concurrent calls cannot spend one
 * balance twice. `settleCallInTx` applies the usage receipt:
 * succeeded charges the TRUE cost (never truncated to fit), a cost above the
 * call cap is a billing-profile violation that books `overage` for the
 * uncovered part and freezes the layer accounts; not_submitted/failed return
 * the allocation without recording a charge; unknown releases nothing.
 * `closeReservationInTx` releases only `held-allocated` and parks any
 * unknown remainder in `reconciliation` — never silently zero-cost.
 *
 * Tenant identity comes from the TRUSTED transaction context
 * (`app.tenant_id`, set by the caller via set_config) and is bound as a
 * parameter into every statement — never from a request body — and row-level
 * security pins the same value independently. Statement texts are module
 * constants with `$n` placeholders; values travel only as parameters.
 *
 * Derivation note: the settle/close account set is derived from the
 * reservation's period+currency and the run's immutable scope references
 * (workspace/release/owner principal), the same four tuples reserve bound.
 * The metering role (ob_ent_runtime_writer) holds no grant on
 * enterprise_budget_bindings — those rows are the reserve-time audit record,
 * not a settle-time lookup.
 *
 * Lock order inside these functions follows the plan's §8.2 global order
 * account → run → reservation → model_attempt, so any upper layer that takes
 * locks in the same fixed order can never close a cycle with these
 * statements. settle/close first locate their rows with LOCK-FREE reads
 * (attempt/reservation/run references and the derived account set are all
 * immutable), then lock: the four layer accounts FOR UPDATE in ascending id
 * order, then — on the over-cap path, which raises the run's reconciliation
 * flag — the run row, then the reservation and the attempt. Money math and
 * writes happen only after the locks, re-reading the authoritative values.
 * reserveInTx takes only account locks (first in the order); allocateCallInTx
 * touches a single reservation row. No function ever locks the run row AFTER
 * an account (the §8.2 prohibition), and the over-cap run update acquires
 * the run lock where the plan puts it: between accounts and reservation.
 */
import type { Tx } from "../contracts";
import { EnterpriseError } from "../errors";
import type { BudgetPort, ReserveInput } from "../runs/contracts";
import { firstRow } from "../tenancy/transaction";
import { ID } from "./contracts";
import { units } from "./money";

/**
 * The usage receipt settleCallInTx applies, per plan 03 §8.3's E4-C contract.
 * E4-C owns the wire shape; this module consumes it. `receipt_revision` is
 * the per-attempt settlement sequence: a revision at or below the stored one
 * is a replay, the same revision with a different evidence digest is a 409.
 */
export type UsageReceipt = {
  model_attempt_id: string;
  receipt_revision: string;
  evidence_digest: string;
  status: "not_submitted" | "succeeded" | "failed" | "unknown";
  input_tokens: string | null;
  output_tokens: string | null;
  cost_micros: string | null;
  provider_request_id: string | null;
  source: "proxy_response" | "provider_reconciliation";
};

const BUDGET_INPUT_INVALID = new EnterpriseError("BUDGET_INPUT_INVALID", 400);
/* 明确的配额拒绝（任一层 spent+held+cap 越限、账户冻结或周期关闭）：计划 03 §9.2
 * 把“明确配额/并发拒绝”分配为 429——不是 409 的幂等/版本冲突语义。 */
const BUDGET_EXCEEDED = new EnterpriseError("BUDGET_EXCEEDED", 429);
const MODEL_ATTEMPT_NOT_FOUND = new EnterpriseError(
  "MODEL_ATTEMPT_NOT_FOUND",
  404,
);
const BUDGET_RESERVATION_NOT_FOUND = new EnterpriseError(
  "BUDGET_RESERVATION_NOT_FOUND",
  404,
);
const SETTLEMENT_REVISION_CONFLICT = new EnterpriseError(
  "SETTLEMENT_REVISION_CONFLICT",
  409,
);
const BUDGET_STATE_INVALID = new EnterpriseError("BUDGET_STATE_INVALID", 503);

/** The trusted transaction tenant, read inside the caller's transaction. */
const SELECT_TENANT_CONTEXT = `
  select nullif(current_setting('app.tenant_id', true), '') as tenant_id`;

async function tenantOf(tx: Tx): Promise<string> {
  const row = await firstRow(tx, SELECT_TENANT_CONTEXT, []);
  const tenant = row?.tenant_id;
  if (typeof tenant !== "string" || tenant === "") {
    throw BUDGET_STATE_INVALID;
  }
  return tenant;
}

/** bigint columns arrive as strings on the raw client; decimal strings only. */
function decimal(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw BUDGET_STATE_INVALID;
  }
  return text;
}

/** Text columns (ids, currency, status) must be non-empty strings. */
function text(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw BUDGET_STATE_INVALID;
  }
  return value;
}

/** Runs one mutating statement and refuses an empty result with `refusal`. */
async function updatedRow(
  tx: Tx,
  text: string,
  values: ReadonlyArray<string | null>,
  refusal: EnterpriseError,
): Promise<Record<string, unknown>> {
  const rows = await tx.unsafe<Record<string, unknown>[]>(text, [...values]);
  if (rows.length === 0) {
    throw refusal;
  }
  return rows[0];
}

function requireId(value: string): string {
  if (!ID.safeParse(value).success) {
    throw BUDGET_INPUT_INVALID;
  }
  return value;
}

function requireCurrency(value: string): string {
  if (!/^[A-Z]{3}$/.test(value)) {
    throw BUDGET_INPUT_INVALID;
  }
  return value;
}

/**
 * The four layer accounts of one budget period, derived from the scope
 * references reserve bound (tenant scope_ref is the tenant id itself).
 * Ordered by id — the plan's stable per-account lock order.
 */
const SELECT_SCOPE_ACCOUNTS = `
  select a.id
  from enterprise_budget_accounts a
  where a.tenant_id = $1 and a.period_id = $2 and a.currency = $3
    and ((a.scope_kind = 'tenant' and a.scope_ref = $1)
      or (a.scope_kind = 'workspace' and a.scope_ref = $4)
      or (a.scope_kind = 'expert' and a.scope_ref = $5)
      or (a.scope_kind = 'principal' and a.scope_ref = $6))
  order by a.id`;

/** The same derivation, admitting only currently-open periods. */
const SELECT_RESERVE_ACCOUNTS = `
  select a.id
  from enterprise_budget_accounts a
  where a.tenant_id = $1 and a.period_id = $2 and a.currency = $3
    and ((a.scope_kind = 'tenant' and a.scope_ref = $1)
      or (a.scope_kind = 'workspace' and a.scope_ref = $4)
      or (a.scope_kind = 'expert' and a.scope_ref = $5)
      or (a.scope_kind = 'principal' and a.scope_ref = $6))
    and a.status = 'active'
    and a.starts_at <= clock_timestamp() and a.ends_at > clock_timestamp()
  order by a.id`;

/**
 * The plan's reserve condition (§8.2): any account whose counters would pass
 * its limit — or whose period has closed — returns no row and the whole
 * reservation rolls back.
 */
const RESERVE_ACCOUNT_TEXT = `
  update enterprise_budget_accounts
  set held_micros = held_micros + $3::bigint, revision = revision + 1
  where tenant_id = $1 and id = $2 and status = 'active'
    and currency = $4
    and starts_at <= clock_timestamp() and ends_at > clock_timestamp()
    and spent_micros + held_micros + $3::bigint <= limit_micros
  returning id`;

const INSERT_RESERVATION_TEXT = `
  insert into enterprise_budget_reservations
    (tenant_id, id, run_id, cap_micros, spent_micros, held_micros,
     allocated_micros, overage_micros, currency, period_id, status)
  values ($1, $2, $3, $4::bigint, 0, $4::bigint, 0, 0, $5, $6, 'open')
  returning id`;

const INSERT_BINDING_TEXT = `
  insert into enterprise_budget_bindings (tenant_id, reservation_id, account_id)
  values ($1, $2, $3)
  returning reservation_id`;

/** The run's immutable scope references: the settle/close account derivation. */
const SELECT_RUN_SCOPE = `
  select rn.workspace_id, rn.release_id, rn.owner_principal_id
  from enterprise_runs rn
  where rn.tenant_id = $1 and rn.id = $2`;

/** attempt → reservation → run scope, for the allocation admission check. */
const SELECT_ATTEMPT_FOR_ALLOCATE = `
  select ma.reservation_id, r.period_id, r.currency,
         rn.workspace_id, rn.release_id, rn.owner_principal_id
  from enterprise_model_attempts ma
  join enterprise_budget_reservations r
    on r.tenant_id = ma.tenant_id and r.id = ma.reservation_id
  join enterprise_runs rn on rn.tenant_id = ma.tenant_id and rn.id = ma.run_id
  where ma.tenant_id = $1 and ma.id = $2`;

/**
 * Allocation admission (§8.2): the reservation must be open with room under
 * its hold, AND every layer account of its period must still be active and
 * in-window — a closed budget period admits no new model step.
 */
const ALLOCATE_RESERVATION_TEXT = `
  update enterprise_budget_reservations v
  set allocated_micros = v.allocated_micros + $3::bigint
  where v.tenant_id = $1 and v.id = $2 and v.status = 'open'
    and v.allocated_micros + $3::bigint <= v.held_micros
    and (
      select count(*) from enterprise_budget_accounts a
      where a.tenant_id = $1 and a.period_id = v.period_id
        and a.currency = v.currency
        and ((a.scope_kind = 'tenant' and a.scope_ref = $1)
          or (a.scope_kind = 'workspace' and a.scope_ref = $4)
          or (a.scope_kind = 'expert' and a.scope_ref = $5)
          or (a.scope_kind = 'principal' and a.scope_ref = $6))
        and a.status = 'active'
        and a.starts_at <= clock_timestamp() and a.ends_at > clock_timestamp()
    ) = 4
  returning v.id`;

/**
 * Lock-free locate for settle: the attempt's run/reservation references and
 * cap are immutable, so the pre-lock pass only decides WHAT to lock (and
 * whether the over-cap run signal applies); every decision that moves money
 * re-reads the locked row.
 */
const SELECT_ATTEMPT_REF_TEXT = `
  select ma.run_id, ma.reservation_id, ma.cap_micros
  from enterprise_model_attempts ma
  where ma.tenant_id = $1 and ma.id = $2`;

/** Lock-free locate for settle/close: period and currency are immutable. */
const SELECT_RESERVATION_REF_TEXT = `
  select v.run_id, v.period_id, v.currency, v.status
  from enterprise_budget_reservations v
  where v.tenant_id = $1 and v.id = $2`;

/**
 * One layer account, locked in the plan's account-first order. Locked empty
 * means the account vanished between locate and lock — corrupted state, not
 * an admission refusal.
 */
const LOCK_ACCOUNT_TEXT = `
  select a.id
  from enterprise_budget_accounts a
  where a.tenant_id = $1 and a.id = $2
  for update`;

/**
 * The over-cap signal (§8.2「冻结账户和route、告警」): the run's
 * reconciliation flag and reason code name the billing-profile violation for
 * the maintenance/reconciliation plane, which owns the route disable and the
 * audit alert — the metering role (ob_ent_runtime_writer) holds no UPDATE on
 * enterprise_model_routes and no INSERT on enterprise_security_events, so
 * this flag is the budget module's authoritative hand-off. Taking the run
 * row lock here is also WHERE the plan puts it: after accounts, before the
 * reservation.
 */
const OVERAGE_RUN_SIGNAL_TEXT = `
  update enterprise_runs
  set reconciliation_required = true, reason_code = $3
  where tenant_id = $1 and id = $2
  returning id`;

/** The settle-time attempt row, locked: the per-call serialization point. */
const SELECT_ATTEMPT_FOR_SETTLE = `
  select ma.id, ma.run_id, ma.reservation_id, ma.cap_micros, ma.usage_status,
         ma.receipt_revision, ma.response_digest
  from enterprise_model_attempts ma
  where ma.tenant_id = $1 and ma.id = $2
  for update`;

/** The reservation row, locked before any money math in settle/close. */
const SELECT_RESERVATION_FOR_UPDATE = `
  select v.id, v.run_id, v.period_id, v.currency, v.status,
         v.held_micros, v.allocated_micros
  from enterprise_budget_reservations v
  where v.tenant_id = $1 and v.id = $2
  for update`;

const SETTLE_RESERVATION_CHARGE_TEXT = `
  update enterprise_budget_reservations
  set spent_micros = spent_micros + $3::bigint,
      held_micros = held_micros - $4::bigint,
      allocated_micros = allocated_micros - $5::bigint
  where tenant_id = $1 and id = $2 and status in ('open', 'reconciliation')
    and held_micros >= $4::bigint and allocated_micros >= $5::bigint
  returning id`;

/**
 * The over-cap settlement: `covered` is what the reservation can pay without
 * touching the frozen allocations of OTHER unknown calls; the uncovered rest
 * is `overage`. True spend is recorded in full — never truncated to fit.
 */
const SETTLE_RESERVATION_OVERAGE_TEXT = `
  update enterprise_budget_reservations
  set spent_micros = spent_micros + $3::bigint,
      held_micros = held_micros - $4::bigint,
      allocated_micros = $6::bigint,
      overage_micros = overage_micros + $5::bigint
  where tenant_id = $1 and id = $2 and status in ('open', 'reconciliation')
    and held_micros >= $4::bigint + $6::bigint
    and allocated_micros >= $6::bigint
  returning id`;

const RELEASE_RESERVATION_TEXT = `
  update enterprise_budget_reservations
  set allocated_micros = allocated_micros - $3::bigint
  where tenant_id = $1 and id = $2 and status = 'open'
    and allocated_micros >= $3::bigint
  returning id`;

const CHARGE_ACCOUNT_TEXT = `
  update enterprise_budget_accounts
  set spent_micros = spent_micros + $3::bigint,
      held_micros = held_micros - $4::bigint,
      revision = revision + 1
  where tenant_id = $1 and id = $2 and held_micros >= $4::bigint
  returning id`;

/** Over-cap also freezes the layer account: admission refuses new calls. */
const OVERAGE_ACCOUNT_TEXT = `
  update enterprise_budget_accounts
  set spent_micros = spent_micros + $3::bigint,
      held_micros = held_micros - $4::bigint,
      overage_micros = overage_micros + $5::bigint,
      status = 'frozen',
      revision = revision + 1
  where tenant_id = $1 and id = $2 and held_micros >= $4::bigint
  returning id`;

const RELEASE_ACCOUNT_TEXT = `
  update enterprise_budget_accounts
  set held_micros = held_micros - $3::bigint, revision = revision + 1
  where tenant_id = $1 and id = $2 and held_micros >= $3::bigint
  returning id`;

/** The immutable charge entry; the (attempt, revision) unique index backstops
 * the replay guard below at the storage layer. */
const INSERT_USAGE_ENTRY_TEXT = `
  insert into enterprise_usage_entries
    (tenant_id, id, model_attempt_id, revision, input_tokens, output_tokens,
     cost_micros, kind, evidence_digest)
  values ($1, $2, $3, $4::bigint, $5::bigint, $6::bigint, $7::bigint, 'charge', $8)
  returning id`;

const SETTLE_ATTEMPT_CHARGED_TEXT = `
  update enterprise_model_attempts
  set status = 'succeeded', usage_status = 'confirmed',
      charged_micros = $3::bigint, receipt_revision = $4::bigint,
      usage_source = $5, provider_request_id = $6, response_digest = $7,
      settled_at = clock_timestamp()
  where tenant_id = $1 and id = $2 and run_id = $8
  returning id`;

const SETTLE_ATTEMPT_NO_CHARGE_TEXT = `
  update enterprise_model_attempts
  set status = 'failed', usage_status = 'confirmed', charged_micros = 0,
      receipt_revision = $3::bigint, usage_source = $4,
      provider_request_id = $5, response_digest = $6,
      settled_at = clock_timestamp()
  where tenant_id = $1 and id = $2 and run_id = $7
  returning id`;

/** unknown keeps allocated and held exactly where they are; no entry. */
const MARK_ATTEMPT_UNKNOWN_TEXT = `
  update enterprise_model_attempts
  set status = 'unknown', usage_status = 'unknown', charged_micros = null,
      receipt_revision = $3::bigint, usage_source = $4,
      provider_request_id = $5, response_digest = $6
  where tenant_id = $1 and id = $2 and run_id = $7
  returning id`;

const COUNT_UNKNOWN_ATTEMPTS_TEXT = `
  select count(*) as n
  from enterprise_model_attempts
  where tenant_id = $1 and reservation_id = $2 and usage_status = 'unknown'`;

const CLOSE_RESERVATION_FINAL_TEXT = `
  update enterprise_budget_reservations
  set held_micros = allocated_micros, status = 'closed',
      closed_at = clock_timestamp()
  where tenant_id = $1 and id = $2 and status in ('open', 'reconciliation')
  returning id`;

const CLOSE_RESERVATION_RECONCILE_TEXT = `
  update enterprise_budget_reservations
  set held_micros = allocated_micros, status = 'reconciliation'
  where tenant_id = $1 and id = $2 and status in ('open', 'reconciliation')
  returning id`;

type ParsedReceipt = {
  attemptId: string;
  revision: bigint;
  digest: string;
  status: UsageReceipt["status"];
  inputTokens: bigint | null;
  outputTokens: bigint | null;
  costMicros: bigint | null;
  providerRequestId: string | null;
  source: UsageReceipt["source"];
};

function parseReceipt(receipt: UsageReceipt): ParsedReceipt {
  const attemptId = requireId(receipt.model_attempt_id);
  const digest = requireId(receipt.evidence_digest);
  const status = receipt.status;
  if (
    status !== "not_submitted" &&
    status !== "succeeded" &&
    status !== "failed" &&
    status !== "unknown"
  ) {
    throw BUDGET_INPUT_INVALID;
  }
  const source = receipt.source;
  if (source !== "proxy_response" && source !== "provider_reconciliation") {
    throw BUDGET_INPUT_INVALID;
  }
  let revision: bigint;
  try {
    revision = units(receipt.receipt_revision);
  } catch {
    throw BUDGET_INPUT_INVALID;
  }
  const token = (value: string | null): bigint | null =>
    value === null ? null : units(value);
  if (status === "succeeded") {
    if (receipt.cost_micros === null) {
      throw BUDGET_INPUT_INVALID;
    }
    let costMicros: bigint;
    try {
      costMicros = units(receipt.cost_micros);
    } catch {
      throw BUDGET_INPUT_INVALID;
    }
    return {
      attemptId,
      revision,
      digest,
      status,
      inputTokens: token(receipt.input_tokens),
      outputTokens: token(receipt.output_tokens),
      costMicros,
      providerRequestId: receipt.provider_request_id,
      source,
    };
  }
  if (receipt.cost_micros !== null) {
    throw BUDGET_INPUT_INVALID;
  }
  return {
    attemptId,
    revision,
    digest,
    status,
    inputTokens: token(receipt.input_tokens),
    outputTokens: token(receipt.output_tokens),
    costMicros: null,
    providerRequestId: receipt.provider_request_id,
    source,
  };
}

/**
 * Reserves the approved run cap on all four layer accounts and inserts the
 * reservation + its account bindings, inside the caller's (run-creation)
 * transaction. Tenant, run and scope references come from the trusted
 * ReserveInput — never from a client body — and row-level security pins the
 * reservation to the run's owner on top.
 */
export async function reserveInTx(
  tx: Tx,
  input: ReserveInput,
): Promise<string> {
  for (const id of [
    input.tenantId,
    input.runId,
    input.principalId,
    input.workspaceId,
    input.expertReleaseId,
    input.reservationId,
    input.periodId,
  ]) {
    requireId(id);
  }
  requireCurrency(input.currency);
  const cap = units(input.capMicros).toString();

  const accountRows = await tx.unsafe<Record<string, unknown>[]>(
    SELECT_RESERVE_ACCOUNTS,
    [
      input.tenantId,
      input.periodId,
      input.currency,
      input.workspaceId,
      input.expertReleaseId,
      input.principalId,
    ],
  );
  const accountIds = accountRows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string")
    .sort();
  if (accountIds.length !== 4) {
    /* A missing, frozen or out-of-window layer is an exhausted budget. */
    throw BUDGET_EXCEEDED;
  }
  for (const accountId of accountIds) {
    await updatedRow(
      tx,
      RESERVE_ACCOUNT_TEXT,
      [input.tenantId, accountId, cap, input.currency],
      BUDGET_EXCEEDED,
    );
  }
  await updatedRow(
    tx,
    INSERT_RESERVATION_TEXT,
    [
      input.tenantId,
      input.reservationId,
      input.runId,
      cap,
      input.currency,
      input.periodId,
    ],
    BUDGET_INPUT_INVALID,
  );
  for (const accountId of accountIds) {
    await updatedRow(
      tx,
      INSERT_BINDING_TEXT,
      [input.tenantId, input.reservationId, accountId],
      BUDGET_INPUT_INVALID,
    );
  }
  return input.reservationId;
}

/**
 * Allocates `callCap` out of the reservation's hold for one model attempt —
 * the admission gate a caller must pass BEFORE any upstream dial: a refusal
 * here means the call is never submitted.
 */
export async function allocateCallInTx(
  tx: Tx,
  modelAttemptId: string,
  callCap: string,
): Promise<void> {
  const tenant = await tenantOf(tx);
  requireId(modelAttemptId);
  const cap = units(callCap).toString();
  const info = await firstRow(tx, SELECT_ATTEMPT_FOR_ALLOCATE, [
    tenant,
    modelAttemptId,
  ]);
  if (info === undefined) {
    throw MODEL_ATTEMPT_NOT_FOUND;
  }
  await updatedRow(
    tx,
    ALLOCATE_RESERVATION_TEXT,
    [
      tenant,
      text(info.reservation_id),
      cap,
      text(info.workspace_id),
      text(info.release_id),
      text(info.owner_principal_id),
    ],
    BUDGET_EXCEEDED,
  );
}

/**
 * Applies one usage receipt inside the caller's transaction. Idempotent by
 * (attempt, receipt_revision): the same revision with the same evidence
 * digest replays as a no-op, the same revision with a different digest is a
 * 409 and changes nothing, an older revision is superseded.
 *
 * Locking follows the plan's global order: lock-free locate → accounts (FOR
 * UPDATE, id order) → run (over-cap signal) → reservation → attempt; the
 * idempotency verdict is made against the LOCKED attempt row, never the
 * pre-lock snapshot.
 */
export async function settleCallInTx(
  tx: Tx,
  receipt: UsageReceipt,
): Promise<void> {
  const tenant = await tenantOf(tx);
  const parsed = parseReceipt(receipt);

  /* Lock-free locate: references and cap are immutable, this pass only
   * decides what to lock and whether the over-cap run signal applies. */
  const attemptRef = await firstRow(tx, SELECT_ATTEMPT_REF_TEXT, [
    tenant,
    parsed.attemptId,
  ]);
  if (attemptRef === undefined) {
    throw MODEL_ATTEMPT_NOT_FOUND;
  }
  const reservationId = text(attemptRef.reservation_id);
  const runId = text(attemptRef.run_id);
  const reservationRef = await firstRow(tx, SELECT_RESERVATION_REF_TEXT, [
    tenant,
    reservationId,
  ]);
  if (reservationRef === undefined) {
    throw BUDGET_STATE_INVALID;
  }
  const run = await firstRow(tx, SELECT_RUN_SCOPE, [tenant, runId]);
  if (run === undefined) {
    throw BUDGET_STATE_INVALID;
  }
  const accountIds = await locateAccounts(tx, tenant, reservationRef, run);

  /* Lock phase, in the plan's order: accounts first. */
  for (const accountId of accountIds) {
    const locked = await firstRow(tx, LOCK_ACCOUNT_TEXT, [tenant, accountId]);
    if (locked === undefined) {
      throw BUDGET_STATE_INVALID;
    }
  }
  /* The run row lock lands between accounts and reservation, exactly where
   * the plan puts it — and only when the receipt is an over-cap charge. */
  const cap = BigInt(decimal(attemptRef.cap_micros));
  if (parsed.status === "succeeded" && (parsed.costMicros as bigint) > cap) {
    await updatedRow(
      tx,
      OVERAGE_RUN_SIGNAL_TEXT,
      [tenant, runId, "MODEL_BILLING_OVERAGE"],
      BUDGET_STATE_INVALID,
    );
  }
  const reservation = await firstRow(tx, SELECT_RESERVATION_FOR_UPDATE, [
    tenant,
    reservationId,
  ]);
  if (reservation === undefined) {
    throw BUDGET_STATE_INVALID;
  }
  const attempt = await firstRow(tx, SELECT_ATTEMPT_FOR_SETTLE, [
    tenant,
    parsed.attemptId,
  ]);
  if (attempt === undefined) {
    throw MODEL_ATTEMPT_NOT_FOUND;
  }

  /* Idempotency verdict against the LOCKED row. */
  const storedRevision = BigInt(decimal(attempt.receipt_revision));
  if (parsed.revision < storedRevision) {
    return; /* superseded by a newer settlement */
  }
  if (parsed.revision === storedRevision) {
    if (attempt.response_digest === parsed.digest) {
      return; /* exact replay of the settled receipt */
    }
    throw SETTLEMENT_REVISION_CONFLICT;
  }

  if (parsed.status === "unknown") {
    await updatedRow(
      tx,
      MARK_ATTEMPT_UNKNOWN_TEXT,
      [
        tenant,
        parsed.attemptId,
        parsed.revision.toString(),
        parsed.source,
        parsed.providerRequestId,
        parsed.digest,
        runId,
      ],
      BUDGET_STATE_INVALID,
    );
    return;
  }

  if (parsed.status === "not_submitted" || parsed.status === "failed") {
    await updatedRow(
      tx,
      RELEASE_RESERVATION_TEXT,
      [tenant, reservationId, decimal(attempt.cap_micros)],
      BUDGET_EXCEEDED,
    );
    await updatedRow(
      tx,
      SETTLE_ATTEMPT_NO_CHARGE_TEXT,
      [
        tenant,
        parsed.attemptId,
        parsed.revision.toString(),
        parsed.source,
        parsed.providerRequestId,
        parsed.digest,
        runId,
      ],
      BUDGET_STATE_INVALID,
    );
    return;
  }

  /* succeeded: charge the true cost, never truncated. */
  const actual = parsed.costMicros as bigint;
  const revision = parsed.revision.toString();
  if (actual <= cap) {
    const actualText = actual.toString();
    await updatedRow(
      tx,
      SETTLE_RESERVATION_CHARGE_TEXT,
      [tenant, reservationId, actualText, actualText, decimal(attempt.cap_micros)],
      BUDGET_EXCEEDED,
    );
    for (const accountId of accountIds) {
      await updatedRow(
        tx,
        CHARGE_ACCOUNT_TEXT,
        [tenant, accountId, actualText, actualText],
        BUDGET_EXCEEDED,
      );
    }
  } else {
    const allocated = BigInt(decimal(reservation.allocated_micros));
    const held = BigInt(decimal(reservation.held_micros));
    const otherAllocated = allocated - cap;
    const spendable = held - otherAllocated;
    const covered = actual < spendable ? actual : spendable;
    const overage = actual - covered;
    await updatedRow(
      tx,
      SETTLE_RESERVATION_OVERAGE_TEXT,
      [
        tenant,
        reservationId,
        actual.toString(),
        covered.toString(),
        overage.toString(),
        otherAllocated.toString(),
      ],
      BUDGET_EXCEEDED,
    );
    for (const accountId of accountIds) {
      await updatedRow(
        tx,
        OVERAGE_ACCOUNT_TEXT,
        [
          tenant,
          accountId,
          actual.toString(),
          covered.toString(),
          overage.toString(),
        ],
        BUDGET_EXCEEDED,
      );
    }
  }
  await updatedRow(
    tx,
    INSERT_USAGE_ENTRY_TEXT,
    [
      tenant,
      crypto.randomUUID(),
      parsed.attemptId,
      revision,
      parsed.inputTokens?.toString() ?? null,
      parsed.outputTokens?.toString() ?? null,
      actual.toString(),
      parsed.digest,
    ],
    SETTLEMENT_REVISION_CONFLICT,
  );
  await updatedRow(
    tx,
    SETTLE_ATTEMPT_CHARGED_TEXT,
    [
      tenant,
      parsed.attemptId,
      actual.toString(),
      revision,
      parsed.source,
      parsed.providerRequestId,
      parsed.digest,
      runId,
    ],
    BUDGET_STATE_INVALID,
  );
}

/**
 * Resolves the four layer accounts of one budget period from the
 * reservation's immutable period/currency and the run's immutable scope
 * references, in the plan's ascending-id order.
 */
async function locateAccounts(
  tx: Tx,
  tenant: string,
  reservationRef: Record<string, unknown>,
  run: Record<string, unknown>,
): Promise<string[]> {
  const accountRows = await tx.unsafe<Record<string, unknown>[]>(
    SELECT_SCOPE_ACCOUNTS,
    [
      tenant,
      text(reservationRef.period_id),
      text(reservationRef.currency),
      text(run.workspace_id),
      text(run.release_id),
      text(run.owner_principal_id),
    ],
  );
  const accountIds = accountRows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string");
  if (accountIds.length !== 4) {
    throw BUDGET_STATE_INVALID;
  }
  return accountIds;
}

/**
 * Closes a reservation: releases only `held-allocated` back to the layer
 * accounts (in id order). Attempts still usage-unknown keep their allocation
 * and park the reservation in `reconciliation` — the unknown remainder is
 * never treated as zero cost; reconciliation (E4-E) settles or adjusts it
 * and a re-close then finishes the job. Closing a closed reservation is a
 * no-op. Lock order: accounts (FOR UPDATE, id order) → reservation.
 */
export async function closeReservationInTx(
  tx: Tx,
  reservationId: string,
): Promise<void> {
  const tenant = await tenantOf(tx);
  requireId(reservationId);
  const reservationRef = await firstRow(tx, SELECT_RESERVATION_REF_TEXT, [
    tenant,
    reservationId,
  ]);
  if (reservationRef === undefined) {
    throw BUDGET_RESERVATION_NOT_FOUND;
  }
  if (text(reservationRef.status) === "closed") {
    return; /* closed is terminal — idempotent no-op without taking locks */
  }
  const runId = text(reservationRef.run_id);
  const run = await firstRow(tx, SELECT_RUN_SCOPE, [tenant, runId]);
  if (run === undefined) {
    throw BUDGET_STATE_INVALID;
  }
  const accountIds = await locateAccounts(tx, tenant, reservationRef, run);

  for (const accountId of accountIds) {
    const locked = await firstRow(tx, LOCK_ACCOUNT_TEXT, [tenant, accountId]);
    if (locked === undefined) {
      throw BUDGET_STATE_INVALID;
    }
  }
  const reservation = await firstRow(tx, SELECT_RESERVATION_FOR_UPDATE, [
    tenant,
    reservationId,
  ]);
  if (reservation === undefined) {
    throw BUDGET_RESERVATION_NOT_FOUND;
  }
  if (reservation.status === "closed") {
    return;
  }
  const held = BigInt(decimal(reservation.held_micros));
  const allocated = BigInt(decimal(reservation.allocated_micros));
  const release = held - allocated;
  if (release > 0n) {
    for (const accountId of accountIds) {
      await updatedRow(
        tx,
        RELEASE_ACCOUNT_TEXT,
        [tenant, accountId, release.toString()],
        BUDGET_EXCEEDED,
      );
    }
  }
  const unknown = await firstRow(tx, COUNT_UNKNOWN_ATTEMPTS_TEXT, [
    tenant,
    reservationId,
  ]);
  if (unknown === undefined) {
    throw BUDGET_STATE_INVALID;
  }
  if (BigInt(decimal(unknown.n)) > 0n) {
    await updatedRow(
      tx,
      CLOSE_RESERVATION_RECONCILE_TEXT,
      [tenant, reservationId],
      BUDGET_STATE_INVALID,
    );
    return;
  }
  await updatedRow(
    tx,
    CLOSE_RESERVATION_FINAL_TEXT,
    [tenant, reservationId],
    BUDGET_STATE_INVALID,
  );
}

/** The seam E1's run-creation transaction codes against (plan 03 §3.2). */
export const budgetPort: BudgetPort = { reserveInTx };
