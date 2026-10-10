import { createHash, createHmac, randomUUID } from "node:crypto";
import type {
  CreateRun,
  RunEventView,
  RunView,
} from "../../../../shared/enterprise/run-contracts";
import type { Database } from "../../db/client";
import type { Scope } from "../contracts";
import { EnterpriseError } from "../errors";
import type { EnterpriseRuntimeConfig } from "../runtime/config";
import { invocationEnvelopeDigest } from "../runtime/envelope-digest";
import {
  parseRuntimeInvocation,
  type RuntimeInvocation,
} from "../runtime/wire";
import { assertScope } from "../tenancy/scope";
import type { TxClient } from "../tenancy/transaction";
import type { RunCommand, RunService } from "./contracts";
import { runRequestDigest } from "./digest";
import { runInputDigest } from "./input-digest";

/*
 * ---------------------------------------------------------------------------
 * The E1-lite run service: the frozen RunService contract against the real
 * ledger, candidate scope on the record.
 *
 * The role contract (server/drizzle/0060_enterprise_runs_rls.sql) splits the
 * ledger by login: the RUN WRITER owns threads/runs/reservations/budget
 * holds and can never read events, attempts or capabilities; the RUNTIME
 * WRITER owns attempts/capabilities/events, pinned to ONE bound run. So a
 * create is TWO transactions — the business transaction (owner-pinned) and
 * the internal transaction (run-pinned) — and events are only ever served
 * through the internal login. Provisioning (release, model route+grant,
 * budget account) is OFFLINE by the same contract (ob_ent_run_operator);
 * create verifies and references, it never provisions.
 *
 * Capability secrets are DERIVED, not stored: HMAC-SHA256 over the
 * deployment's keyEncryptionKey with an audience|tenant|run domain string.
 * The ledger keeps only the sha256 hash (enterprise_capabilities.token_hash),
 * a restart can re-derive the same secret for cancel, and no capability
 * plaintext is ever persisted anywhere.
 * ---------------------------------------------------------------------------
 */

const RUN_ID_PREFIX = "run_";
const THREAD_ID_PREFIX = "thr_";

const SET_RUN_CONTEXT_TEXT = `
  select set_config('app.tenant_id', $1, true),
         set_config('app.run_id', $2, true)`;

const SELECT_THREAD_TEXT = `select id from enterprise_threads where tenant_id = $1 and id = $2`;
const INSERT_THREAD_TEXT = `insert into enterprise_threads (tenant_id, id, owner_principal_id, workspace_id) values ($1, $2, $3, $4)`;

const SELECT_RELEASE_TEXT = `select id, expert_version, version_digest, model_route_ref, status from enterprise_run_releases where tenant_id = $1 and id = $2`;
const SELECT_RUN_GRANT_TEXT = `select action from enterprise_run_grants where tenant_id = $1 and release_id = $2 and principal_id = $3 and action = 'start'`;
const SELECT_ACCOUNT_TEXT = `select id, period_id, currency, limit_micros, held_micros, status from enterprise_budget_accounts where tenant_id = $1 and scope_kind = 'workspace' and scope_ref = $2 and currency = $3 and status = 'active' order by starts_at desc limit 1`;
const HOLD_ACCOUNT_TEXT = `update enterprise_budget_accounts set held_micros = held_micros + $3, revision = revision + 1 where tenant_id = $1 and id = $2 and held_micros + $3 <= limit_micros returning id`;
const INSERT_RESERVATION_TEXT = `insert into enterprise_budget_reservations (tenant_id, id, run_id, cap_micros, currency, period_id) values ($1, $2, $3, $4, $5, $6)`;
const INSERT_BINDING_TEXT = `insert into enterprise_budget_bindings (tenant_id, reservation_id, account_id) values ($1, $2, $3)`;

const SELECT_ROUTE_RUNTIME_TEXT = `select id, alias, revision, status from enterprise_model_routes where tenant_id = $1 and alias = $2 and status = 'active' order by revision desc limit 1`;
const SELECT_MODEL_GRANT_RUNTIME_TEXT = `select status from enterprise_model_grants where tenant_id = $1 and route_id = $2 and principal_id = $3`;
const SELECT_RUN_BY_KEY_TEXT = `select id, thread_id, status, revision, latest_seq, reconciliation_required, reason_code, request_digest from enterprise_runs where tenant_id = $1 and owner_principal_id = $2 and request_key = $3 limit 1`;
const INSERT_RUN_TEXT = `insert into enterprise_runs (tenant_id, id, owner_principal_id, actor_user_id, workspace_id, thread_id, release_id, initiator_kind, request_key, request_digest, input_text, model_route_ref, model_grant_revision, release_digest, policy_revision, budget_reservation_id, status, revision, latest_seq, current_attempt_id, current_turn_id, current_fence) values ($1,$2,$3,$4,$5,$6,$7,'user',$8,$9,$10,$11,$12,$13,'0',$14,'queued',0,0,$15,$16,1)`;

const INSERT_ATTEMPT_TEXT = `insert into enterprise_run_attempts (tenant_id, run_id, id, turn_id, attempt_no, lease_id, lease_until, service_id, fencing_token, status, context_digest) values ($1,$2,$3,$4,1,$5,$6,$7,1,'active',$8)`;
const INSERT_CAPABILITY_TEXT = `insert into enterprise_capabilities (tenant_id, id, token_hash, service_id, audience, envelope_digest, run_id, attempt_id, lease_id, fencing_token, expires_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10)`;

const SELECT_RUN_TEXT = `select id, thread_id, status, revision, latest_seq, reconciliation_required, reason_code from enterprise_runs where tenant_id = $1 and id = $2`;
const CANCEL_RUN_TEXT = `update enterprise_runs set status = 'cancel_requested', cancel_requested_at = now(), revision = revision + 1 where tenant_id = $1 and id = $2 and status in ('queued','running','waiting_input','waiting_approval','cancel_requested') returning status, revision, latest_seq, reconciliation_required, reason_code`;

const NEXT_SEQ_TEXT = `update enterprise_runs set latest_seq = latest_seq + 1 where tenant_id = $1 and id = $2 returning latest_seq`;
const INSERT_EVENT_TEXT = `insert into enterprise_run_events (tenant_id, run_id, event_id, seq, attempt_id, turn_id, source_event_id, source_digest, event_type, schema_version, payload, occurred_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'1',$10::jsonb,now())`;
const SELECT_EVENTS_TEXT = `select event_id, run_id, turn_id, seq, occurred_at, event_type, payload from enterprise_run_events where tenant_id = $1 and run_id = $2 and seq > $3 order by seq asc limit $4`;

const TERMINAL_RUN_TEXT = `update enterprise_runs set status = $3, reason_code = $4, revision = revision + 1 where tenant_id = $1 and id = $2 and status not in ('succeeded','failed','cancelled','expired')`;

type Row = Record<string, unknown>;

function rowsToRunView(row: Row): RunView {
  return {
    run_id: row.id as string,
    thread_id: row.thread_id as string,
    status: row.status as RunView["status"],
    revision: String(row.revision ?? "0"),
    latest_seq: String(row.latest_seq ?? "0"),
    reconciliation_required: row.reconciliation_required === true,
    reason_code: (row.reason_code as string | null) ?? null,
  };
}

/** The derived capability secret for one audience of one run (never persisted). */
export function deriveCapabilitySecret(
  keyEncryptionKey: string,
  audience: "runtime" | "control",
  tenantId: string,
  runId: string,
): string {
  const digest = createHmac("sha256", keyEncryptionKey)
    .update(`enterprise-runtime-capability|${audience}|${tenantId}|${runId}`)
    .digest();
  return Buffer.from(digest).toString("base64url");
}

/** The service surface the gateway mounts: the frozen contract plus the E1-lite seams. */
export type RunServiceE1 = ReturnType<typeof createRunService>;

export type CreatedRun = {
  run: RunView;
  /** True when the Idempotency-Key replayed an existing run: no invocation was minted and the gateway must not dial the runtime again. */
  replayed: boolean;
  /** The minted wire-v1 invocation; the gateway forwards it verbatim on all three headers. */
  invocation?: RuntimeInvocation;
  /** The derived capability secrets; hashes are all the ledger holds. */
  capabilities: { runtime: string; control: string };
  /** The frozen input digest the invocation vouches for. */
  inputDigest: string;
  /** The AG-UI coordinates the execution body must carry. */
  execution: { runId: string; threadId: string; text: string };
};

export type RunServiceDeps = {
  runWriterDatabase: Database;
  runtimeWriterDatabase: Database;
  runtime: EnterpriseRuntimeConfig;
  keyEncryptionKey: string;
  now?: () => Date;
};

type Tx = TxClient;

/*
 * The run-writer RLS policies pin on app.tenant_id + app.principal_id (the
 * T2-B reader context), NOT the operator lookup context — the writer owns
 * exactly its own threads and runs.
 */
const RUN_WRITER_CONTEXT_TEXT = `
  select set_config('app.tenant_id', $1, true),
         set_config('app.principal_id', $2, true),
         set_config('app.user_id', $3, true)`;

async function withRunWriter<T>(
  deps: RunServiceDeps,
  scope: Scope,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertScope(scope);
  return deps.runWriterDatabase.$client.begin(async (tx) => {
    await tx.unsafe("set transaction isolation level read committed");
    await tx.unsafe(RUN_WRITER_CONTEXT_TEXT, [
      scope.tenantId,
      scope.principalId,
      scope.userId,
    ]);
    return fn(tx);
  });
}

async function withRuntimeWriter<T>(
  deps: RunServiceDeps,
  tenantId: string,
  runId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return deps.runtimeWriterDatabase.$client.begin(async (tx) => {
    await tx.unsafe("set transaction isolation level read committed");
    await tx.unsafe(SET_RUN_CONTEXT_TEXT, [tenantId, runId]);
    return fn(tx);
  });
}

/**
 * The E1-lite service. Every create is one owner-pinned business transaction
 * plus one run-pinned internal transaction; every read goes through the RLS
 * policies with no application-side tenant filter to drift out of sync.
 */
export function createRunService(deps: RunServiceDeps): RunService & {
  createE1(input: {
    scope: Scope;
    key: string;
    request: CreateRun;
  }): Promise<CreatedRun>;
  appendEvent(input: {
    tenantId: string;
    runId: string;
    attemptId: string | null;
    turnId: string | null;
    sourceEventId: string;
    sourceDigest: string;
    eventType: string;
    payload: unknown;
  }): Promise<number>;
  markTerminal(input: {
    tenantId: string;
    runId: string;
    status:
      | "succeeded"
      | "failed"
      | "cancelled"
      | "waiting_approval"
      | "waiting_input";
    reasonCode?: string;
  }): Promise<void>;
  readEventsPinned(input: {
    tenantId: string;
    runId: string;
    after: number;
    limit: number;
  }): Promise<RunEventView[]>;
} {
  async function createE1(input: {
    scope: Scope;
    key: string;
    request: CreateRun;
  }): Promise<CreatedRun> {
    const { scope, key, request } = input;
    const now = deps.now ?? (() => new Date());
    const requestDigest = runRequestDigest(request);
    const inputDigest = runInputDigest(request.input);

    /*
     * The model route and the principal's model grant live behind the
     * RUNTIME-WRITER read policies (the writer catalog never sees the model
     * ledger), so that one preflight read crosses pools before the business
     * transaction — reads are non-transactional anyway, and the run row
     * records the revision it pinned.
     */
    const route = (await deps.runtimeWriterDatabase.$client.begin(
      async (tx) => {
        await tx.unsafe("set transaction isolation level read committed");
        await tx.unsafe("select set_config('app.tenant_id', $1, true)", [
          scope.tenantId,
        ]);
        const found = (
          await tx.unsafe<Row[]>(SELECT_ROUTE_RUNTIME_TEXT, [
            scope.tenantId,
            request.model_alias,
          ])
        )[0];
        if (found === undefined) {
          throw new EnterpriseError("RUN_MODEL_ROUTE_MISSING", 404);
        }
        const modelGrant = (
          await tx.unsafe<Row[]>(SELECT_MODEL_GRANT_RUNTIME_TEXT, [
            scope.tenantId,
            found.id as string,
            scope.principalId,
          ])
        )[0];
        if (modelGrant === undefined || modelGrant.status !== "active") {
          throw new EnterpriseError("RUN_MODEL_GRANT_MISSING", 403);
        }
        return found;
      },
    )) as Row;

    type BusinessOutcome =
      | { replayed: true; view: RunView; threadId: string; runId: string }
      | {
          replayed: false;
          view: RunView;
          threadId: string;
          runId: string;
          turnId: string;
          attemptId: string;
          releaseVersion: string;
          reservationId: string;
        };

    const created = await withRunWriter(
      deps,
      scope,
      async (tx): Promise<BusinessOutcome> => {
        // Idempotency first: the same key with the same content is the SAME run
        // (replayed authorization, not a cached bypass); the same key with
        // different content is a caller error.
        const existing = (
          await tx.unsafe<Row[]>(SELECT_RUN_BY_KEY_TEXT, [
            scope.tenantId,
            scope.principalId,
            key,
          ])
        )[0];
        if (existing !== undefined) {
          if (existing.request_digest !== requestDigest) {
            throw new EnterpriseError("REQUEST_KEY_REUSED", 409);
          }
          return {
            replayed: true,
            view: rowsToRunView(existing),
            threadId: existing.thread_id as string,
            runId: existing.id as string,
          };
        }

        // The thread the run lives in: reuse or mint under the same owner.
        let threadId = request.thread_id;
        if (threadId === undefined) {
          threadId = `${THREAD_ID_PREFIX}${randomUUID().replaceAll("-", "")}`;
        }
        const thread = (
          await tx.unsafe<Row[]>(SELECT_THREAD_TEXT, [scope.tenantId, threadId])
        )[0];
        if (thread === undefined) {
          await tx.unsafe(INSERT_THREAD_TEXT, [
            scope.tenantId,
            threadId,
            scope.principalId,
            request.workspace_id,
          ]);
        }

        // Offline-provisioned catalog: release, its start grant, the model
        // route for the requested alias, and the principal's model grant.
        const release = (
          await tx.unsafe<Row[]>(SELECT_RELEASE_TEXT, [
            scope.tenantId,
            request.expert_release_id,
          ])
        )[0];
        if (release === undefined) {
          throw new EnterpriseError("RUN_RELEASE_MISSING", 404);
        }
        if (release.status !== "published") {
          throw new EnterpriseError("RUN_RELEASE_DISABLED", 403);
        }
        const granted = (
          await tx.unsafe<Row[]>(SELECT_RUN_GRANT_TEXT, [
            scope.tenantId,
            release.id as string,
            scope.principalId,
          ])
        )[0];
        if (granted === undefined) {
          throw new EnterpriseError("RUN_START_NOT_GRANTED", 403);
        }

        // The budget hold: one workspace-scoped account, capped by what it
        // still holds. The conditional UPDATE refuses the hold past the limit
        // inside the same statement — no read-then-write race.
        const account = (
          await tx.unsafe<Row[]>(SELECT_ACCOUNT_TEXT, [
            scope.tenantId,
            request.workspace_id,
            deps.runtime.budgetCurrency,
          ])
        )[0];
        if (account === undefined) {
          throw new EnterpriseError("BUDGET_ACCOUNT_MISSING", 404);
        }
        const cap = BigInt(deps.runtime.budgetCapMicros);
        const held = await tx.unsafe(HOLD_ACCOUNT_TEXT, [
          scope.tenantId,
          account.id as string,
          cap.toString(),
        ]);
        if (held.length === 0) {
          throw new EnterpriseError("BUDGET_EXHAUSTED", 403);
        }

        // The run↔reservation cycle: BOTH foreign keys are deferred and settle
        // at commit, but the reservation's RLS policy checks the run EXISTS —
        // so the run row lands first, naming the reservation id it will pair
        // with, and the reservation lands second, naming the real run.
        const runId = `${RUN_ID_PREFIX}${randomUUID().replaceAll("-", "")}`;
        const turnId = `turn_${randomUUID().replaceAll("-", "")}`;
        const attemptId = `att_${randomUUID().replaceAll("-", "")}`;
        const reservationId = `res_${randomUUID().replaceAll("-", "")}`;
        await tx.unsafe(INSERT_RUN_TEXT, [
          scope.tenantId,
          runId,
          scope.principalId,
          scope.userId,
          request.workspace_id,
          threadId,
          release.id as string,
          key,
          requestDigest,
          request.input.text,
          deps.runtime.modelRouteRef,
          String(route.revision ?? "0"),
          release.version_digest as string,
          reservationId,
          attemptId,
          turnId,
        ]);
        await tx.unsafe(INSERT_RESERVATION_TEXT, [
          scope.tenantId,
          reservationId,
          runId,
          cap.toString(),
          deps.runtime.budgetCurrency,
          account.period_id as string,
        ]);
        await tx.unsafe(INSERT_BINDING_TEXT, [
          scope.tenantId,
          reservationId,
          account.id as string,
        ]);

        return {
          replayed: false,
          view: {
            run_id: runId,
            thread_id: threadId,
            status: "queued" as const,
            revision: "0",
            latest_seq: "0",
            reconciliation_required: false,
            reason_code: null,
          },
          threadId,
          runId,
          turnId,
          attemptId,
          releaseVersion: release.expert_version as string,
          reservationId,
        };
      },
    );

    if (created.replayed) {
      // A replay returns the view; the gateway recognizes a replayed run and
      // does not dial the runtime a second time.
      return {
        run: created.view,
        replayed: true,
        capabilities: {
          runtime: deriveCapabilitySecret(
            deps.keyEncryptionKey,
            "runtime",
            scope.tenantId,
            created.runId,
          ),
          control: deriveCapabilitySecret(
            deps.keyEncryptionKey,
            "control",
            scope.tenantId,
            created.runId,
          ),
        },
        inputDigest,
        execution: {
          runId: "",
          threadId: created.threadId,
          text: request.input.text,
        },
      };
    }

    // The internal transaction: the attempt and the two capability rows, on
    // the runtime-writer login pinned to this exact run. The lease id is
    // minted ONCE and travels into the attempt row, the capability rows and
    // the invocation — three records of the same lease, never three leases.
    const leaseId = `lease_${randomUUID().replaceAll("-", "")}`;
    const expiresAt = new Date(now().getTime() + deps.runtime.capabilityTtlMs);
    const invocation = mintInvocation({
      deps,
      scope,
      runId: created.runId,
      threadId: created.threadId,
      turnId: created.turnId,
      attemptId: created.attemptId,
      leaseId,
      expertVersion: created.releaseVersion,
      reservationId: created.reservationId,
      inputDigest,
      now,
    });
    const envelopeDigest = invocationEnvelopeDigest(invocation);
    await withRuntimeWriter(deps, scope.tenantId, created.runId, async (tx) => {
      await tx.unsafe(INSERT_ATTEMPT_TEXT, [
        scope.tenantId,
        created.runId,
        created.attemptId,
        created.turnId,
        leaseId,
        new Date(now().getTime() + deps.runtime.leaseTtlMs),
        deps.runtime.serviceId,
        inputDigest,
      ]);
      for (const audience of ["runtime", "control"] as const) {
        const secret = deriveCapabilitySecret(
          deps.keyEncryptionKey,
          audience,
          scope.tenantId,
          created.runId,
        );
        await tx.unsafe(INSERT_CAPABILITY_TEXT, [
          scope.tenantId,
          `cap_${randomUUID().replaceAll("-", "")}`,
          createHash("sha256").update(secret, "utf8").digest("hex"),
          deps.runtime.serviceId,
          audience,
          envelopeDigest,
          created.runId,
          created.attemptId,
          leaseId,
          expiresAt,
        ]);
      }
    });

    return {
      run: created.view,
      replayed: false,
      invocation,
      capabilities: {
        runtime: deriveCapabilitySecret(
          deps.keyEncryptionKey,
          "runtime",
          scope.tenantId,
          created.runId,
        ),
        control: deriveCapabilitySecret(
          deps.keyEncryptionKey,
          "control",
          scope.tenantId,
          created.runId,
        ),
      },
      inputDigest,
      execution: {
        runId: created.turnId,
        threadId: created.threadId,
        text: request.input.text,
      },
    };
  }

  return {
    createE1,

    async create(scope, key, request) {
      return (await createE1({ scope, key, request })).run;
    },

    async get(scope, id) {
      const row = (
        await withRunWriter(deps, scope, async (tx) =>
          tx.unsafe<Row[]>(SELECT_RUN_TEXT, [scope.tenantId, id]),
        )
      )[0];
      if (row === undefined) {
        throw new EnterpriseError("RUN_NOT_FOUND", 404);
      }
      return rowsToRunView(row);
    },

    async command(scope, id, command: RunCommand) {
      if (command.kind !== "cancel") {
        throw new EnterpriseError("COMMAND_KIND_UNSUPPORTED", 400);
      }
      const row = await withRunWriter(deps, scope, async (tx) => {
        const updated = await tx.unsafe<Row[]>(CANCEL_RUN_TEXT, [
          scope.tenantId,
          id,
        ]);
        if (updated[0] !== undefined) return updated[0];
        const existing = await tx.unsafe<Row[]>(SELECT_RUN_TEXT, [
          scope.tenantId,
          id,
        ]);
        return existing[0];
      });
      if (row === undefined) {
        throw new EnterpriseError("RUN_NOT_FOUND", 404);
      }
      return rowsToRunView(row);
    },

    async readEvents(scope, id, after, limit) {
      return this.readEventsPinned({
        tenantId: scope.tenantId,
        runId: id,
        after: Number(after),
        limit,
      });
    },

    async readEventsPinned({ tenantId, runId, after, limit }) {
      const rows = await deps.runtimeWriterDatabase.$client.begin(
        async (tx) => {
          await tx.unsafe("set transaction isolation level read committed");
          await tx.unsafe(SET_RUN_CONTEXT_TEXT, [tenantId, runId]);
          return tx.unsafe<Row[]>(SELECT_EVENTS_TEXT, [
            tenantId,
            runId,
            String(after),
            String(limit),
          ]);
        },
      );
      return rows.map((row) => {
        const rawPayload = row.payload;
        const payload =
          typeof rawPayload === "string"
            ? (JSON.parse(rawPayload) as Record<string, unknown>)
            : ((rawPayload ?? {}) as Record<string, unknown>);
        return {
          schema_version: "1" as const,
          event_id: row.event_id as string,
          run_id: row.run_id as string,
          turn_id: (row.turn_id as string | null) ?? null,
          seq: String(row.seq ?? "0"),
          occurred_at: (row.occurred_at as Date).toISOString(),
          type: row.event_type as string,
          payload,
        };
      });
    },

    async appendEvent({
      tenantId,
      runId,
      attemptId,
      turnId,
      sourceEventId,
      sourceDigest,
      eventType,
      payload,
    }) {
      const seq = await deps.runtimeWriterDatabase.$client.begin(async (tx) => {
        await tx.unsafe("set transaction isolation level read committed");
        await tx.unsafe(SET_RUN_CONTEXT_TEXT, [tenantId, runId]);
        const next = await tx.unsafe<Row[]>(NEXT_SEQ_TEXT, [tenantId, runId]);
        const value = Number(next[0]?.latest_seq ?? "0");
        await tx.unsafe(INSERT_EVENT_TEXT, [
          tenantId,
          runId,
          `evt_${randomUUID().replaceAll("-", "")}`,
          String(value),
          attemptId,
          turnId,
          sourceEventId,
          sourceDigest,
          eventType,
          JSON.stringify(payload ?? {}),
        ]);
        return value;
      });
      return seq;
    },

    async markTerminal({ tenantId, runId, status, reasonCode }) {
      await deps.runtimeWriterDatabase.$client.begin(async (tx) => {
        await tx.unsafe("set transaction isolation level read committed");
        await tx.unsafe(SET_RUN_CONTEXT_TEXT, [tenantId, runId]);
        await tx.unsafe(TERMINAL_RUN_TEXT, [
          tenantId,
          runId,
          status,
          reasonCode ?? null,
        ]);
      });
    },
  };
}

function mintInvocation(input: {
  deps: RunServiceDeps;
  scope: Scope;
  runId: string;
  threadId: string;
  turnId: string;
  attemptId: string;
  leaseId: string;
  expertVersion: string;
  reservationId: string;
  inputDigest: string;
  now: () => Date;
}): RuntimeInvocation {
  const expiresAt = new Date(
    input.now().getTime() + input.deps.runtime.capabilityTtlMs,
  );
  const candidate = {
    schema_version: "1",
    tenant_id: input.scope.tenantId,
    principal_id: input.scope.principalId,
    actor_id: input.scope.userId,
    initiator_kind: "user",
    run_id: input.runId,
    attempt_id: input.attemptId,
    turn_id: input.turnId,
    thread_id: input.threadId,
    expert_version: input.expertVersion,
    input_digest: input.inputDigest,
    model_route_ref: input.deps.runtime.modelRouteRef,
    budget_reservation_id: input.reservationId,
    lease_id: input.leaseId,
    fencing_token: "1",
    expires_at: expiresAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
  } as const;
  const parsed = parseRuntimeInvocation(candidate);
  if (!parsed.ok) {
    throw new EnterpriseError("INVOCATION_MINT_FAILED", 500);
  }
  return parsed.invocation;
}
