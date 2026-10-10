/**
 * The atomic run-creation store, per plan 03 §4.3's seven-step algorithm.
 *
 * One `withTenant` transaction on the run-writer login (migration 0064 completed its read
 * catalog, so 02's canonical opener works again) does ALL of: the idempotency lookup and
 * its CURRENT-authorization re-check (a replay never bypasses a revocation), the RunPolicy
 * verdict, the plan's lock order (tenant→principal→membership shared locks, then the
 * release/route resource locks), the frozen version and cap, the queued Run row with its input
 * and initial turn, `budget.reserveInTx` on the SAME transaction (the full-run cap is held on
 * all four layer accounts or the whole transaction rolls back), and the redacted
 * `start_workflow` outbox row whose payload carries IDs only. A unique-conflict loser rolls its
 * ENTIRE transaction back and re-opens a fresh read-only authorization transaction to name the
 * winner — it never keeps using the aborted transaction.
 *
 * Lock-order note (plan §4.3): the run row is INSERTED before `reserveInTx` because the
 * reservation's RLS policy requires the run to exist (migration 0060's
 * `run_reservation_write` WITH CHECK) and the deferred composite FK settles at commit. A fresh
 * run row takes no lock any concurrent transaction can hold or wait on (its id is not known to
 * anyone yet), so the plan's "never lock the run row and then ask for the budget account"
 * prohibition — which targets EXISTING rows — is not violated by the create order: every
 * contended lock is still taken in the plan's order (resources first, then the account rows in
 * ascending id order inside `reserveInTx`). All network calls happen after commit; nothing in
 * this module dials out at all.
 *
 * AUDIT HAND-OFF (plan §4.3 step 6's audit half — explicit, greppable contract): the create
 * transaction does NOT write `enterprise_security_events`, and NO role available to this API
 * path may. `ob_ent_run_writer` holds no grant (verified live, 42501) — correctly, because
 * the acting principal must never write its own audit trail; INSERT is held only by
 * `ob_ent_operator` (the OFFLINE provisioning CLI, plan §4.4) and `ob_ent_run_maintenance`
 * (whose login the API is forbidden from switching to, plan §4.2). The hand-off is therefore
 * TO THE MAINTENANCE/OPERATOR PLANE, with the audit record already persisted in
 * tamper-evident ledger form: the committed run row (owner, actor_user_id, workspace,
 * release + digest, request_key/digest, frozen route/grant revision, admission-time
 * RUNS_ADMISSION_POLICY_REVISION) plus its redacted start_workflow outbox row and the
 * RUN_QUEUED platform event. Any maintenance command that surfaces or exports run-creation
 * audit (E2's maintenance plane / ops inspect-run) reads THOSE committed rows; no further
 * write is pending from this module.
 *
 * Role-contract note: the RUN_QUEUED durable event is appended on the runtime-writer pool
 * right after commit (see `appendQueuedEvent`) because `ob_ent_run_writer` cannot write
 * `enterprise_run_events` (migration 0060, live-probed 42501) — the event is deterministic
 * and idempotent by its platform source id, so the commit-to-append gap is a logged,
 * bounded degradation, never a second truth.
 *
 * Statement texts are module constants with `$n` placeholders; values travel only as
 * parameters. Every row read back is shape-checked — never `as`-cast into the contract.
 */
import type { Database } from "../../db/client";
import { getLogger } from "../../../../shared/logger";
import type { Scope } from "../contracts";
import { EnterpriseError } from "../errors";
import type { BudgetPort } from "./contracts";
import { runRequestDigest, sha256 } from "./digest";
import type { RunPolicy } from "./policy";
import {
  CreateRunSchema,
  Decimal,
  ID,
  RunViewSchema,
  type CreateRun,
  type RunEventView,
  type RunView,
} from "../../../../shared/enterprise/run-contracts";
import type { RunCommand, RunService } from "./contracts";
import {
  firstRow,
  lockExclusive,
  lockKey,
  withTenant,
} from "../tenancy/transaction";

/** Fault-injection points for the §4.3 rollback tests; production callers never pass them. */
export type CreateFaultHooks = {
  afterRunInsert?: () => Promise<void>;
  afterReserve?: () => Promise<void>;
  afterOutboxInsert?: () => Promise<void>;
};

export type RunStoreDeps = {
  db: Database;
  policy: RunPolicy;
  budget: BudgetPort;
  /**
   * The runtime-writer pool (ob_ent_runtime_writer), when the deployment provides it: the
   * ONLY role the ledger's role contract allows to write `enterprise_run_events` (migration
   * 0060). When present, a fresh create appends the initial RUN_QUEUED event on this pool
   * AFTER the business transaction commits — the run-writer transaction itself cannot write
   * the events table (live-probed 42501), so plan §4.3 step 6's in-transaction write is
   * realized as an immediately-following, deterministic, idempotent-by-source append whose
   * failure degrades to a logged gap, never to a failed create (the run row, reservation and
   * outbox are the committed truth). Absent → the append is skipped (bare E1 deployments).
   */
  eventsDatabase?: Database;
  hooks?: CreateFaultHooks;
};

const INVALID_RUN_INPUT = new EnterpriseError("INVALID_RUN_INPUT", 400);
const IDEMPOTENCY_KEY_REQUIRED = new EnterpriseError(
  "IDEMPOTENCY_KEY_REQUIRED",
  400,
);
const IDEMPOTENCY_CONFLICT = new EnterpriseError("IDEMPOTENCY_CONFLICT", 409);
const RUN_NOT_FOUND = new EnterpriseError("RUN_NOT_FOUND", 404);
const RUN_MODEL_ROUTE_MISSING = new EnterpriseError("RUN_MODEL_ROUTE_MISSING", 404);
const RUN_MODEL_GRANT_MISSING = new EnterpriseError("RUN_MODEL_GRANT_MISSING", 403);
const RUN_THREAD_NOT_FOUND = new EnterpriseError("RUN_THREAD_NOT_FOUND", 404);
const RUN_THREAD_ARCHIVED = new EnterpriseError("RUN_THREAD_ARCHIVED", 409);
const RUN_THREAD_BUSY = new EnterpriseError("RUN_THREAD_BUSY", 409);
const RUN_STATE_INVALID = new EnterpriseError("RUN_STATE_INVALID", 503);
const COMMAND_NOT_AVAILABLE = new EnterpriseError("COMMAND_NOT_AVAILABLE", 503);
const EVENT_STREAM_UNAVAILABLE = new EnterpriseError(
  "EVENT_STREAM_UNAVAILABLE",
  503,
);
const INVALID_RUN_COMMAND = new EnterpriseError("INVALID_RUN_COMMAND", 400);

/**
 * The admission-policy revision frozen onto every run this store creates. The runs admission
 * rules ARE this module + runs/policy.ts; their identity is a module constant that bumps with
 * a rule change (the plan's "冻结...policy" step 4). The run-writer role cannot read the
 * tenants table's tenancy policy revision (migration 0060), and the tenancy chain it governs
 * is re-checked live at every admission anyway.
 */
const RUNS_ADMISSION_POLICY_REVISION = "runs-v1";

/* ---------------------------------------------------------------------------
 * Statements (module constants; `$n` placeholders only).
 * ------------------------------------------------------------------------- */

/** Step 2: the caller's existing record for this key — the idempotency anchor. */
const SELECT_RUN_BY_KEY_TEXT = `
  select id, request_digest, thread_id, status, revision, latest_seq,
         reconciliation_required, reason_code, release_id, model_route_ref
  from enterprise_runs
  where tenant_id = $1 and owner_principal_id = $2 and request_key = $3
  limit 1`;

const SELECT_RELEASE_TEXT = `
  select id, resource_id, version_digest, max_run_micros, currency
  from enterprise_run_releases
  where tenant_id = $1 and id = $2`;

/**
 * The alias resolves to one active approved route revision inside the caller's transaction:
 * the deployment's default version first, then the latest revision (plan §4.1 — the run pins
 * the resolved route id; a later default switch never retargets existing runs).
 */
const SELECT_ROUTE_BY_ALIAS_TEXT = `
  select id, resource_id
  from enterprise_model_routes
  where tenant_id = $1 and alias = $2 and status = 'active'
  order by is_default_for_alias desc, revision desc
  limit 1`;

/** The frozen model-grant revision: the ACTIVE grant's revision, read under the locks. */
const SELECT_MODEL_GRANT_REVISION_TEXT = `
  select revision from enterprise_model_grants
  where tenant_id = $1 and route_id = $2 and principal_id = $3 and status = 'active'`;

const SELECT_THREAD_TEXT = `
  select id, owner_principal_id, status
  from enterprise_threads
  where tenant_id = $1 and id = $2`;

const INSERT_THREAD_TEXT = `
  insert into enterprise_threads (tenant_id, id, owner_principal_id, workspace_id)
  values ($1, $2, $3, $4)`;

/** Belt-and-braces pre-check; the partial unique index is the race-proof guarantee. */
const SELECT_ACTIVE_RUN_ON_THREAD_TEXT = `
  select 1 as ok
  from enterprise_runs
  where tenant_id = $1 and thread_id = $2
    and status not in ('succeeded','failed','cancelled','expired')
  limit 1`;

/**
 * The current budget period: anchored on the tenant-layer account of the release's currency.
 * No active in-window tenant account = no budget to reserve against at all (BUDGET_EXCEEDED).
 */
const SELECT_TENANT_PERIOD_TEXT = `
  select period_id
  from enterprise_budget_accounts
  where tenant_id = $1 and scope_kind = 'tenant' and scope_ref = $1
    and currency = $2 and status = 'active'
    and starts_at <= clock_timestamp() and ends_at > clock_timestamp()
  order by starts_at desc
  limit 1`;

/**
 * Step 5: the queued run with its input, initial turn and every frozen fact. attempt/fence
 * columns start at their lifecycle origins; no attempt exists until E2 claims a lease.
 */
const INSERT_RUN_TEXT = `
  insert into enterprise_runs (
    tenant_id, id, owner_principal_id, actor_user_id, workspace_id, thread_id,
    release_id, initiator_kind, request_key, request_digest, input_text,
    model_route_ref, model_grant_revision, release_digest, policy_revision,
    budget_reservation_id, status, revision, latest_seq, current_attempt_id,
    current_turn_id, current_fence
  ) values (
    $1, $2, $3, $4, $5, $6, $7, 'user', $8, $9, $10,
    $11, $12::bigint, $13, $14, $15, 'queued', 0, 0, null, $16, 1
  )`;

/** Step 6: the plan's exact outbox statement; the payload carries IDs only. */
const INSERT_OUTBOX_TEXT = `
  insert into enterprise_run_outbox
    (tenant_id, id, run_id, kind, payload_digest, payload, status, available_at, attempts, created_at)
  values ($1, $2, $3, 'start_workflow', $4, $5::jsonb, 'pending', clock_timestamp(), 0, clock_timestamp())`;

const SELECT_RUN_BY_ID_TEXT = `
  select id, thread_id, status, revision, latest_seq, reconciliation_required,
         reason_code, owner_principal_id, release_id, workspace_id
  from enterprise_runs
  where tenant_id = $1 and id = $2`;

/* ---------------------------------------------------------------------------
 * The initial RUN_QUEUED event (plan §4.3 step 6), appended on the runtime-writer pool right
 * after the create transaction commits. Deterministic: one fixed seq bump (latest_seq 0→1 on
 * a fresh run) and one platform-source event whose source_event_id is derived from the run id,
 * so the platform-source partial unique index (migration 0060) makes any re-append an
 * idempotent refusal rather than a duplicate.
 * ------------------------------------------------------------------------- */

const EVENTS_CONTEXT_TEXT =
  "select set_config('app.tenant_id', $1, true), set_config('app.run_id', $2, true)";

const EVENTS_NEXT_SEQ_TEXT = `
  update enterprise_runs set latest_seq = latest_seq + 1
  where tenant_id = $1 and id = $2
  returning latest_seq`;

const INSERT_RUN_QUEUED_TEXT = `
  insert into enterprise_run_events
    (tenant_id, run_id, event_id, seq, attempt_id, turn_id, source_event_id,
     source_digest, event_type, schema_version, payload, occurred_at)
  values ($1, $2, $3, $4::bigint, null, $5, $6, $7, 'RUN_QUEUED', '1', $8::jsonb,
          clock_timestamp())`;

type Row = Record<string, unknown>;

/** bigint columns arrive as strings; anything else is corrupted ledger state. */
function decimal(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw RUN_STATE_INVALID;
  }
  return text;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw RUN_STATE_INVALID;
  }
  return value;
}

function toRunView(row: Row): RunView {
  const candidate = {
    run_id: text(row.id),
    thread_id: text(row.thread_id),
    status: text(row.status),
    revision: decimal(row.revision),
    latest_seq: decimal(row.latest_seq),
    reconciliation_required: row.reconciliation_required === true,
    reason_code: (row.reason_code as string | null) ?? null,
  };
  const parsed = RunViewSchema.safeParse(candidate);
  if (!parsed.success) {
    throw RUN_STATE_INVALID;
  }
  return parsed.data;
}

/** The redacted dispatch payload: IDs only — never the input, never a secret. */
function outboxPayload(runId: string, threadId: string): {
  payload: string;
  digest: string;
} {
  const json = JSON.stringify({ run_id: runId, thread_id: threadId });
  return { payload: json, digest: sha256(json) };
}

/**
 * The 23505 winners this module resolves by re-reading; anything else propagates. Bun SQL
 * carries the SQLSTATE in `errno` (with `code` set to a driver-level class), so both fields —
 * and the cause chain a wrapped driver error may hide it behind — are checked.
 */
function uniqueViolation(error: unknown, constraint: string): boolean {
  for (
    let candidate: Record<string, unknown> | undefined | null =
      error as Record<string, unknown>;
    candidate !== undefined && candidate !== null;
    candidate = candidate.cause as Record<string, unknown> | undefined
  ) {
    const sqlstate = [candidate.errno, candidate.code].find(
      (value) => value === "23505",
    );
    if (
      sqlstate === "23505" &&
      typeof candidate.message === "string" &&
      candidate.message.includes(constraint)
    ) {
      return true;
    }
  }
  return false;
}

function mintId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;
}

export function createRunStore(deps: RunStoreDeps): RunService {
  const { db, policy, budget, hooks } = deps;

  /**
   * The step-6 RUN_QUEUED append, on the runtime-writer pool AFTER the create transaction
   * has committed. Best-effort by design: a failure here is a logged event-plane gap against
   * an already-committed run (the response must not turn a committed create into a 500, and
   * the plan's own retry rules forbid re-running committed work). Returns the run's new
   * latest_seq, or null when the append was skipped or failed.
   */
  async function appendQueuedEvent(
    scope: Scope,
    run: { runId: string; threadId: string; turnId: string },
  ): Promise<string | null> {
    if (deps.eventsDatabase === undefined) {
      return null;
    }
    try {
      return await deps.eventsDatabase.$client.begin(async (tx) => {
        await tx.unsafe("set transaction isolation level read committed");
        await tx.unsafe(EVENTS_CONTEXT_TEXT, [scope.tenantId, run.runId]);
        const bumped = await tx.unsafe<Row[]>(EVENTS_NEXT_SEQ_TEXT, [
          scope.tenantId,
          run.runId,
        ]);
        const seq = decimal(bumped[0]?.latest_seq);
        const payload = JSON.stringify({
          run_id: run.runId,
          thread_id: run.threadId,
          status: "queued",
        });
        await tx.unsafe(INSERT_RUN_QUEUED_TEXT, [
          scope.tenantId,
          run.runId,
          mintId("evt"),
          seq,
          run.turnId,
          `platform:run-queued:${run.runId}`,
          sha256(payload),
          payload,
        ]);
        return seq;
      });
    } catch (error) {
      getLogger("enterprise").error(
        {
          run_id: run.runId,
          code: "RUN_QUEUED_EVENT_APPEND_FAILED",
        },
        "run-queued-event-append-failed",
      );
      return null;
    }
  }

  /**
   * Steps 2-6 inside ONE withTenant transaction. Resolves to the created run and whether it
   * is FRESH (a replay returns the existing row); throws on any refusal (the whole
   * transaction rolls back with it — no half-written rows ever survive).
   */
  async function createInTx(
    scope: Scope,
    key: string,
    request: CreateRun,
    digest: string,
  ): Promise<{
    view: RunView;
    fresh: boolean;
    runId?: string;
    turnId?: string;
  }> {
    return withTenant(db, scope, async (tx) => {
      /* Step 2: the existing record for this key, re-authorized against CURRENT grants. */
      const existing = await firstRow(tx, SELECT_RUN_BY_KEY_TEXT, [
        scope.tenantId,
        scope.principalId,
        key,
      ]);
      if (existing !== undefined) {
        await policy.assertStart(
          tx,
          scope,
          text(existing.release_id),
          text(existing.model_route_ref),
        );
        if (text(existing.request_digest) !== digest) {
          throw IDEMPOTENCY_CONFLICT;
        }
        return { view: toRunView(existing), fresh: false };
      }

      /* The alias resolves to one approved route revision INSIDE this transaction (migration
       * 0064's read catalog); assertStart below re-makes the full verdict on the same tx. */
      const route = await firstRow(tx, SELECT_ROUTE_BY_ALIAS_TEXT, [
        scope.tenantId,
        request.model_alias,
      ]);
      if (route === undefined) {
        throw RUN_MODEL_ROUTE_MISSING;
      }
      const routeId = text(route.id);
      const routeResourceId = text(route.resource_id);

      /* Step 3: authorization inside the same transaction, then the release/route resource
       * locks (ascending resource id — the plan's resource order). */
      await policy.assertStart(tx, scope, request.expert_release_id, routeId);
      const release = await firstRow(tx, SELECT_RELEASE_TEXT, [
        scope.tenantId,
        request.expert_release_id,
      ]);
      if (release === undefined) {
        /* assertStart just verified it; a vanished row is corrupted state, not a refusal. */
        throw RUN_STATE_INVALID;
      }
      const releaseResourceId = text(release.resource_id);
      const resourceLockIds = [releaseResourceId, routeResourceId].sort();
      for (const resourceId of resourceLockIds) {
        /* The SAME advisory key family 02's revoke path locks — the create's freeze and a
         * concurrent grant change serialize on one key. Exclusive: create is a write. */
        await lockExclusive(tx, lockKey("resource", scope.tenantId, resourceId));
      }

      /* Step 3 (thread): an existing thread must be active and owned by the caller; a new one
       * is minted and recorded under the same owner. The single-active-run invariant is the
       * partial unique index's job; the pre-check only upgrades the error from 23505 to a
       * stable code. */
      let threadId = request.thread_id;
      if (threadId === undefined) {
        threadId = mintId("thr");
        await tx.unsafe(INSERT_THREAD_TEXT, [
          scope.tenantId,
          threadId,
          scope.principalId,
          request.workspace_id,
        ]);
      } else {
        const thread = await firstRow(tx, SELECT_THREAD_TEXT, [
          scope.tenantId,
          threadId,
        ]);
        if (thread === undefined) {
          throw RUN_THREAD_NOT_FOUND;
        }
        if (text(thread.owner_principal_id) !== scope.principalId) {
          throw RUN_THREAD_NOT_FOUND;
        }
        if (thread.status !== "active") {
          throw RUN_THREAD_ARCHIVED;
        }
      }
      const busy = await firstRow(tx, SELECT_ACTIVE_RUN_ON_THREAD_TEXT, [
        scope.tenantId,
        threadId,
      ]);
      if (busy !== undefined) {
        throw RUN_THREAD_BUSY;
      }

      /* Steps 4-5: server-side ids, the frozen version and cap, the queued run with its input
       * and initial turn, then the budget hold on the SAME transaction. The frozen model-grant
       * revision is re-read UNDER the resource locks, in this transaction: a grant that
       * vanished between assertStart and the freeze fails closed instead of freezing a stale
       * admission. */
      const admittedGrant = await firstRow(tx, SELECT_MODEL_GRANT_REVISION_TEXT, [
        scope.tenantId,
        routeId,
        scope.principalId,
      ]);
      if (admittedGrant === undefined) {
        throw RUN_MODEL_GRANT_MISSING;
      }
      const runId = mintId("run");
      const turnId = mintId("turn");
      const reservationId = mintId("res");
      await tx.unsafe(INSERT_RUN_TEXT, [
        scope.tenantId,
        runId,
        scope.principalId,
        scope.userId,
        request.workspace_id,
        threadId,
        request.expert_release_id,
        key,
        digest,
        request.input.text,
        routeId,
        decimal(admittedGrant.revision),
        text(release.version_digest),
        RUNS_ADMISSION_POLICY_REVISION,
        reservationId,
        turnId,
      ]);
      await hooks?.afterRunInsert?.();

      const period = await firstRow(tx, SELECT_TENANT_PERIOD_TEXT, [
        scope.tenantId,
        text(release.currency),
      ]);
      if (period === undefined || typeof period.period_id !== "string") {
        /* No live tenant-layer budget period: admission refuses — a clear quota refusal
         * (plan §9.2 assigns explicit quota/concurrency refusals 429), not a corrupted
         * ledger. */
        throw new EnterpriseError("BUDGET_EXCEEDED", 429);
      }
      await budget.reserveInTx(tx, {
        tenantId: scope.tenantId,
        runId,
        principalId: scope.principalId,
        workspaceId: request.workspace_id,
        expertReleaseId: request.expert_release_id,
        reservationId,
        capMicros: decimal(release.max_run_micros),
        currency: text(release.currency),
        periodId: period.period_id,
      });
      await hooks?.afterReserve?.();

      /* Step 6: the redacted start_workflow dispatch row. */
      const payload = outboxPayload(runId, threadId);
      await tx.unsafe(INSERT_OUTBOX_TEXT, [
        scope.tenantId,
        mintId("out"),
        runId,
        payload.digest,
        payload.payload,
      ]);
      await hooks?.afterOutboxInsert?.();

      return {
        view: {
          run_id: runId,
          thread_id: threadId,
          status: "queued",
          revision: "0",
          latest_seq: "0",
          reconciliation_required: false,
          reason_code: null,
        },
        fresh: true,
        runId,
        turnId,
      };
    });
  }

  /** Step 7's re-check: a fresh READ-ONLY authorization transaction over the winner. */
  async function recheckWinner(
    scope: Scope,
    key: string,
    digest: string,
  ): Promise<RunView> {
    return withTenant(db, scope, async (tx) => {
      const existing = await firstRow(tx, SELECT_RUN_BY_KEY_TEXT, [
        scope.tenantId,
        scope.principalId,
        key,
      ]);
      if (existing === undefined) {
        throw RUN_NOT_FOUND;
      }
      await policy.assertStart(
        tx,
        scope,
        text(existing.release_id),
        text(existing.model_route_ref),
      );
      if (text(existing.request_digest) !== digest) {
        throw IDEMPOTENCY_CONFLICT;
      }
      return toRunView(existing);
    });
  }

  return {
    async create(scope, key, request) {
      if (!ID.safeParse(key).success) {
        throw IDEMPOTENCY_KEY_REQUIRED;
      }
      const parsed = CreateRunSchema.safeParse(request);
      if (!parsed.success) {
        throw INVALID_RUN_INPUT;
      }
      /* Step 1: the digest is computed SERVER-SIDE over the strictly parsed request (the one
       * frozen algorithm in digest.ts, shared with the contract tests). */
      const digest = runRequestDigest(parsed.data);
      try {
        const { view, fresh, runId, turnId } = await createInTx(
          scope,
          key,
          parsed.data,
          digest,
        );
        if (!fresh || runId === undefined || turnId === undefined) {
          return view; /* replay: the queued event was appended at the first create */
        }
        /* Step 6's event half: the initial RUN_QUEUED record, appended after commit (the
         * role contract keeps the events table out of the run-writer transaction; see
         * deps.eventsDatabase). */
        const seq = await appendQueuedEvent(scope, {
          runId,
          threadId: view.thread_id,
          turnId,
        });
        return seq === null ? view : { ...view, latest_seq: seq };
      } catch (error) {
        if (uniqueViolation(error, "enterprise_run_request_key")) {
          /* Step 7: the whole transaction rolled back; a FRESH read-only authorization
           * transaction names the winner. The aborted transaction is never touched again. */
          return recheckWinner(scope, key, digest);
        }
        if (uniqueViolation(error, "enterprise_thread_single_active_run")) {
          throw RUN_THREAD_BUSY;
        }
        throw error;
      }
    },

    async get(scope, id) {
      if (!ID.safeParse(id).success) {
        throw RUN_NOT_FOUND;
      }
      return withTenant(db, scope, async (tx) => {
        const row = await firstRow(tx, SELECT_RUN_BY_ID_TEXT, [
          scope.tenantId,
          id,
        ]);
        if (row === undefined || text(row.owner_principal_id) !== scope.principalId) {
          throw RUN_NOT_FOUND;
        }
        /* read: the owner's own run AND the expert resource read still valid. */
        await policy.assertOwn(tx, scope, {
          ownerPrincipalId: text(row.owner_principal_id),
          releaseId: text(row.release_id),
          workspaceId: text(row.workspace_id),
          threadId: text(row.thread_id),
        }, "read");
        return toRunView(row);
      });
    },

    async command(_scope, id, command: RunCommand) {
      if (!ID.safeParse(id).success) {
        throw RUN_NOT_FOUND;
      }
      const kindOk =
        command.kind === "cancel" ||
        command.kind === "input" ||
        command.kind === "resume";
      const inputOk =
        command.input === undefined ||
        (typeof command.input.text === "string" &&
          command.input.text.length >= 1 &&
          command.input.text.length <= 32768);
      if (
        !kindOk ||
        !inputOk ||
        !ID.safeParse(command.command_id).success ||
        !Decimal.safeParse(command.expected_revision).success
      ) {
        throw INVALID_RUN_COMMAND;
      }
      /* The command state machine (CAS, receipts, turn creation) is E2's. This package freezes
       * the CONTRACT — strict shapes above — and refuses closed instead of pretending an
       * effect happened. */
      throw COMMAND_NOT_AVAILABLE;
    },

    async readEvents(): Promise<RunEventView[]> {
      /* The durable event stream is E3's (runtime-writer domain; this store's role cannot even
       * read the events table). Refuse closed rather than serve an empty lie. */
      throw EVENT_STREAM_UNAVAILABLE;
    },
  };
}
