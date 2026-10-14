import { expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type {
  PlatformScope,
  RunnerEventRecord,
  RunnerRequestLease,
} from "../../src/enterprise/contracts";
import {
  createRunnerEventService,
  type RunnerEventRepository,
  type RunnerEventTransaction,
} from "../../src/enterprise/runs/events";
import * as runService from "../../src/enterprise/runs/service";
import * as runStoreModule from "../../src/enterprise/runs/store";
import {
  createRunStore,
  isCurrentRunLeaseSnapshot,
} from "../../src/enterprise/runs/store";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
} from "../../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";

// The success surface this contract pins does not exist yet at RED time.
// Namespace access (run-active-lookup pattern) keeps the pre-implementation
// failures per-test instead of failing the whole file at import time.
const { validateRunSuccessInput, completeRunWithLease } =
  runService as unknown as {
    validateRunSuccessInput: (input: { lease: RunnerRequestLease }) => void;
    completeRunWithLease: (
      scope: PlatformScope,
      input: { lease: RunnerRequestLease },
      transition: (
        scope: PlatformScope,
        input: { lease: RunnerRequestLease },
      ) => Promise<boolean>,
    ) => Promise<boolean>;
  };
const { runSuccessRunLeaseFence } = runStoreModule as unknown as {
  runSuccessRunLeaseFence: (
    scope: PlatformScope,
    lease: RunnerRequestLease,
  ) => SQL;
};

const capabilityCheck = {
  current_user_matches: true,
  capability_attributes_ok: true,
  login_attributes_ok: true,
  login_has_expected_capability: true,
  capability_has_no_escalation_membership: true,
  login_has_no_other_memberships: true,
  no_protected_ownership: true,
  login_has_no_enterprise_privileges: true,
};

function makeLease(
  overrides: Partial<RunnerRequestLease> = {},
): RunnerRequestLease {
  return {
    runId: "run-a",
    attemptId: "attempt-a",
    generation: 3,
    ownerToken: "owner-a",
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

test("complete accepts only a complete live lease tuple", () => {
  expect(typeof validateRunSuccessInput).toBe("function");
  expect(() => validateRunSuccessInput({ lease: makeLease() })).not.toThrow();
  const lease = makeLease();
  for (const invalidLease of [
    { ...lease, runId: " " },
    { ...lease, attemptId: "" },
    { ...lease, generation: 0 },
    { ...lease, generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...lease, ownerToken: " " },
    { ...lease, expiresAt: new Date(Number.NaN) },
    { ...lease, expiresAt: new Date(Date.now() - 1) },
  ]) {
    expect(() => validateRunSuccessInput({ lease: invalidLease })).toThrow(
      "INVALID_RUN_SUCCESS_INPUT",
    );
  }
  expect(() => validateRunSuccessInput({ lease: undefined as never })).toThrow(
    "INVALID_RUN_SUCCESS_INPUT",
  );
});

test("forged scope is rejected before the success transition delegate is called", async () => {
  expect(typeof completeRunWithLease).toBe("function");
  const lease = makeLease();
  let delegated = false;
  await expect(
    completeRunWithLease(
      { tenantId: "forged" } as never,
      { lease },
      async () => {
        delegated = true;
        return true;
      },
    ),
  ).rejects.toThrow("UNVERIFIED_SCOPE");
  expect(delegated).toBe(false);
});

test("complete forwards the exact lease and preserves a false fencing result", async () => {
  const scope = await makeTrustedScope();
  const lease = makeLease();
  let forwarded: unknown;
  const outcome = await completeRunWithLease(
    scope,
    { lease },
    async (_scope, input) => {
      forwarded = input;
      return false;
    },
  );
  expect(outcome).toBe(false);
  expect(forwarded).toEqual({ lease });
  const truthy = await completeRunWithLease(scope, { lease }, async () => true);
  expect(truthy).toBe(true);
});

test("old_renewed_lease_is_stale", () => {
  const lease = makeLease();
  // Renewal wrote a later owner expiry; the pre-renewal lease snapshot no
  // longer matches the stored owner state exactly.
  expect(
    isCurrentRunLeaseSnapshot(
      lease,
      lease.ownerToken,
      new Date(lease.expiresAt.getTime() + 5_000),
    ),
  ).toBe(false);
});

// --- store-level synthetic transaction harness ------------------------------

type FakeStatement =
  | { kind: "select"; table: string }
  | {
      kind: "update";
      table: string;
      values: Record<string, unknown>;
      whereSql: string;
      whereParams: unknown[];
    }
  | { kind: "insert"; table: string; values: Record<string, unknown> };

interface FakeRunState {
  run: Record<string, unknown>;
  attempt: Record<string, unknown>;
  outbox: { eventType: string }[];
  statements: FakeStatement[];
}

const tableName = Symbol.for("drizzle:Name");

// sql`now()` timestamps arrive as SQL chunks; a committed value is now().
// Strings (status/error codes), Dates, and explicit nulls pass through.
function coerceWrittenValue(value: unknown): unknown {
  if (value instanceof Date || value === null || typeof value === "string") {
    return value;
  }
  return new Date();
}

/**
 * Mirrors the canned-row trust split of expert-run-admission.test.ts: the real
 * store code runs against per-table rows keyed by state, and the SQL fences
 * are pinned separately via PgDialect below. The 'active'-attempt visibility
 * rule plus the real in-JS re-checks (generation, exact owner snapshot)
 * decide every fencing outcome in these tests.
 */
class TerminalFakeTx {
  constructor(private readonly state: FakeRunState) {}

  async execute(_statement: SQL): Promise<unknown> {
    return [];
  }

  select(_selection: unknown) {
    const query = {
      table: null as string | null,
      from(table: unknown) {
        query.table = (table as Record<symbol, string>)[tableName];
        return query;
      },
      innerJoin() {
        return query;
      },
      where() {
        return query;
      },
      for() {
        return query;
      },
      limit: async () => {
        this.state.statements.push({
          kind: "select",
          table: query.table ?? "",
        });
        return this.rowsForSelect(query.table);
      },
    };
    return query;
  }

  private rowsForSelect(table: string | null): unknown[] {
    switch (table) {
      case "enterprise_memberships":
        return [
          {
            memberStatus: "active",
            memberEpoch: 1,
            principalStatus: "active",
            tenantStatus: "active",
            workspaceId: "workspace-a",
          },
        ];
      case "enterprise_runs":
        return [{ ...this.state.run }];
      case "enterprise_run_attempts":
        return this.state.attempt.status === "active"
          ? [{ ...this.state.attempt }]
          : [];
      default:
        return [];
    }
  }

  update(table: unknown) {
    const name = (table as Record<symbol, string>)[tableName];
    let values: Record<string, unknown> = {};
    let where: SQL | null = null;
    const self = this;
    const builder = {
      set(next: Record<string, unknown>) {
        values = next;
        return builder;
      },
      where(condition: SQL) {
        where = condition;
        return builder;
      },
      returning: async () => self.applyUpdate(name, values, where),
      // biome-ignore lint/suspicious/noThenProperty: mirrors drizzle update builders being awaitable with or without .returning()
      then(
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        return Promise.resolve(self.applyUpdate(name, values, where)).then(
          onFulfilled,
          onRejected,
        );
      },
    };
    return builder;
  }

  private applyUpdate(
    name: string,
    values: Record<string, unknown>,
    where: SQL | null,
  ): unknown[] {
    const query = where ? new PgDialect().sqlToQuery(where) : null;
    this.state.statements.push({
      kind: "update",
      table: name,
      values: { ...values },
      whereSql: query?.sql ?? "",
      whereParams: query?.params ?? [],
    });
    const target =
      name === "enterprise_runs" ? this.state.run : this.state.attempt;
    for (const [key, value] of Object.entries(values)) {
      target[key] = coerceWrittenValue(value);
    }
    return [{ ...target }];
  }

  insert(table: unknown) {
    const name = (table as Record<symbol, string>)[tableName];
    let values: Record<string, unknown> = {};
    const self = this;
    const builder = {
      values(next: Record<string, unknown>) {
        values = next;
        return builder;
      },
      returning: async () => self.applyInsert(name, values),
      // biome-ignore lint/suspicious/noThenProperty: mirrors drizzle insert builders being awaitable with or without .returning()
      then(
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        return Promise.resolve(self.applyInsert(name, values)).then(
          onFulfilled,
          onRejected,
        );
      },
    };
    return builder;
  }

  private applyInsert(
    name: string,
    values: Record<string, unknown>,
  ): unknown[] {
    this.state.statements.push({ kind: "insert", table: name, values });
    if (name === "enterprise_run_outbox") {
      this.state.outbox.push({ eventType: String(values.eventType) });
    }
    return [{}];
  }
}

async function terminalHarness(): Promise<{
  store: ReturnType<typeof createRunStore>;
  state: FakeRunState;
}> {
  const now = Date.now();
  const state: FakeRunState = {
    run: {
      id: "run-a",
      tenantId: "tenant-a",
      workspaceId: "workspace-a",
      principalId: "principal-a",
      threadId: "thread-a",
      status: "running",
      attemptGeneration: 3,
      leaseExpiresAt: new Date(now + 120_000),
      createdAt: new Date(now),
      updatedAt: new Date(now),
      finishedAt: null,
      errorCode: null,
    },
    attempt: {
      id: "attempt-a",
      tenantId: "tenant-a",
      runId: "run-a",
      generation: 3,
      status: "active",
      leaseExpiresAt: new Date(now + 120_000),
      requestOwnerToken: "owner-a",
      requestOwnerExpiresAt: new Date(now + 60_000),
      turnId: "turn-a",
      fencingToken: 1,
      startedAt: new Date(now),
      finishedAt: null,
    },
    outbox: [],
    statements: [],
  };
  const database = {
    execute: async () => [capabilityCheck],
    transaction: async (operation: (tx: TerminalFakeTx) => Promise<unknown>) =>
      operation(new TerminalFakeTx(state)),
  } as never;
  const data = await verifyDataDatabase(database);
  const store = createRunStore(data, { leaseMilliseconds: 30_000 });
  return { store, state };
}

function statementsSince(state: FakeRunState, from: number): FakeStatement[] {
  return state.statements
    .slice(from)
    .filter(
      (statement) =>
        statement.kind !== "select" ||
        statement.table !== "enterprise_memberships",
    );
}

const scopeLiteral: PlatformScope = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  principalId: "principal-a",
  actorId: "actor-a",
  memberEpoch: 1,
  aclEpoch: 1,
  entrypoint: "web",
};

test("complete_requires_live_exact_owner", async () => {
  const scope = await makeTrustedScope();
  const lease = makeLease();
  // Owner token replaced by another request's claim.
  const replaced = await terminalHarness();
  replaced.state.attempt.requestOwnerToken = "owner-b";
  await expect(
    replaced.store.transitionTerminal(scope, {
      runId: lease.runId,
      attemptId: lease.attemptId,
      generation: lease.generation,
      status: "succeeded",
      requestLease: lease,
    }),
  ).resolves.toBe(false);
  expect(replaced.state.outbox).toEqual([]);
  expect(replaced.state.run.status).toBe("running");
  expect(replaced.state.attempt.status).toBe("active");
  // Owner claim released (finalize path) — no live owner to match.
  const released = await terminalHarness();
  released.state.attempt.requestOwnerToken = null;
  released.state.attempt.requestOwnerExpiresAt = null;
  await expect(
    released.store.transitionTerminal(scope, {
      runId: lease.runId,
      attemptId: lease.attemptId,
      generation: lease.generation,
      status: "succeeded",
      requestLease: lease,
    }),
  ).resolves.toBe(false);
  expect(released.state.outbox).toEqual([]);
  // Owner expiry lapsed; the exact-expiry equality cannot hold for a past date.
  const expired = await terminalHarness();
  expired.state.attempt.requestOwnerExpiresAt = new Date(Date.now() - 1_000);
  const expiredLease = makeLease({
    expiresAt: expired.state.attempt.requestOwnerExpiresAt as Date,
  });
  await expect(
    expired.store.transitionTerminal(scope, {
      runId: expiredLease.runId,
      attemptId: expiredLease.attemptId,
      generation: expiredLease.generation,
      status: "succeeded",
      requestLease: expiredLease,
    }),
  ).resolves.toBe(false);
  expect(expired.state.outbox).toEqual([]);
  expect(expired.state.run.status).toBe("running");
});

test("old_renewed_lease_is_stale at the fenced store transition", async () => {
  const scope = await makeTrustedScope();
  const { store, state } = await terminalHarness();
  // Heartbeat renewed the stored owner expiry; the executor still holds the
  // pre-renewal lease object, whose expiresAt no longer equals the row.
  state.attempt.requestOwnerExpiresAt = new Date(
    (state.attempt.requestOwnerExpiresAt as Date).getTime() + 30_000,
  );
  await expect(
    store.transitionTerminal(scope, {
      runId: "run-a",
      attemptId: "attempt-a",
      generation: 3,
      status: "succeeded",
      requestLease: makeLease(),
    }),
  ).resolves.toBe(false);
  expect(state.outbox).toEqual([]);
  expect(state.run.status).toBe("running");
  expect(state.attempt.status).toBe("active");
  expect(state.attempt.requestOwnerToken).toBe("owner-a");
  // Terminalizing with the renewed copy (the stored expiry) succeeds.
  await expect(
    store.transitionTerminal(scope, {
      runId: "run-a",
      attemptId: "attempt-a",
      generation: 3,
      status: "succeeded",
      requestLease: makeLease({
        expiresAt: state.attempt.requestOwnerExpiresAt as Date,
      }),
    }),
  ).resolves.toBe(true);
  expect(state.outbox.map((event) => event.eventType)).toEqual([
    "run.succeeded",
  ]);
});

test("stop_then_complete_is_false", async () => {
  const scope = await makeTrustedScope();
  const { store, state } = await terminalHarness();
  const cancelled = await store.cancel(
    scope,
    "run-a",
    "CANCELLED_USER_REQUESTED",
    { attemptId: "attempt-a", generation: 3 },
  );
  expect(cancelled).toMatchObject({ run_id: "run-a", status: "cancelled" });
  expect(state.attempt.status).toBe("cancelled");

  const from = state.statements.length;
  await expect(
    store.transitionTerminal(scope, {
      runId: "run-a",
      attemptId: "attempt-a",
      generation: 3,
      status: "succeeded",
      requestLease: makeLease(),
    }),
  ).resolves.toBe(false);
  // The terminal attempt is invisible to the fenced transition: no run
  // update, no attempt update, no success outbox.
  expect(
    statementsSince(state, from).filter(
      (statement) => statement.kind !== "select",
    ),
  ).toEqual([]);
  expect(state.run.status).toBe("cancelled");
  expect(state.outbox.map((event) => event.eventType)).toEqual(["run.cancel"]);
});

test("complete_then_stop_remains_succeeded", async () => {
  const scope = await makeTrustedScope();
  const { store, state } = await terminalHarness();
  // Exact owner-expiry equality: the lease must carry the stored instant.
  const liveLease = makeLease({
    expiresAt: state.attempt.requestOwnerExpiresAt as Date,
  });
  await expect(
    store.transitionTerminal(scope, {
      runId: "run-a",
      attemptId: "attempt-a",
      generation: 3,
      status: "succeeded",
      requestLease: liveLease,
    }),
  ).resolves.toBe(true);
  expect(state.run.status).toBe("succeeded");
  expect(state.run.errorCode).toBeNull();
  expect(state.attempt.status).toBe("completed");
  expect(state.attempt.requestOwnerToken).toBeNull();
  expect(state.attempt.requestOwnerExpiresAt).toBeNull();
  expect(state.outbox.map((event) => event.eventType)).toEqual([
    "run.succeeded",
  ]);

  // Cancel (no attempt pin) sees the terminal run and returns it unchanged.
  const from = state.statements.length;
  const afterCancel = await store.cancel(
    scope,
    "run-a",
    "CANCELLED_USER_REQUESTED",
  );
  expect(afterCancel).toMatchObject({ run_id: "run-a", status: "succeeded" });
  expect(
    statementsSince(state, from).filter(
      (statement) => statement.kind !== "select",
    ),
  ).toEqual([]);
  // Stop pins the attempt; a completed attempt is stale, never re-terminalized.
  await expect(
    store.cancel(scope, "run-a", "CANCELLED_USER_REQUESTED", {
      attemptId: "attempt-a",
      generation: 3,
    }),
  ).rejects.toThrow("RUN_ATTEMPT_STALE");
  expect(state.outbox.map((event) => event.eventType)).toEqual([
    "run.succeeded",
  ]);
  expect(state.run.status).toBe("succeeded");
});

test("success_attempt_update_has_status_fence", () => {
  expect(typeof runSuccessRunLeaseFence).toBe("function");
  const query = new PgDialect().sqlToQuery(
    runSuccessRunLeaseFence(scopeLiteral, makeLease()),
  );
  expect(query.sql).toContain("clock_timestamp()");
  expect(query.sql).toContain("tenant_id");
  expect(query.sql).toContain("workspace_id");
  expect(query.sql).toContain("principal_id");
  expect(query.sql).toContain("attempt_generation");
  expect(query.sql).toContain('"enterprise_runs"."status" =');
  expect(query.sql).toContain('"error_code" is null');
  expect(query.params).toContain("tenant-a");
  expect(query.params).toContain("workspace-a");
  expect(query.params).toContain("principal-a");
  expect(query.params).toContain("run-a");
  expect(query.params).toContain(3);
  expect(query.params).toContain("succeeded");
  expect(query.params).not.toContain("MODEL_EXECUTION_UNAVAILABLE");
  expect(query.sql).not.toContain("MODEL_EXECUTION_UNAVAILABLE");
});

test("leased success attempt update carries the succeeded fence, failure keeps its own", async () => {
  const scope = await makeTrustedScope();
  const success = await terminalHarness();
  await success.store.transitionTerminal(scope, {
    runId: "run-a",
    attemptId: "attempt-a",
    generation: 3,
    status: "succeeded",
    requestLease: makeLease({
      expiresAt: success.state.attempt.requestOwnerExpiresAt as Date,
    }),
  });
  const successAttemptUpdate = success.state.statements.find(
    (statement) =>
      statement.kind === "update" &&
      statement.table === "enterprise_run_attempts",
  ) as Extract<FakeStatement, { kind: "update" }> | undefined;
  expect(successAttemptUpdate).toBeDefined();
  expect(successAttemptUpdate?.whereParams).toContain("succeeded");
  expect(successAttemptUpdate?.whereSql).toContain('"error_code" is null');
  expect(successAttemptUpdate?.whereSql).not.toContain(
    "MODEL_EXECUTION_UNAVAILABLE",
  );

  const failure = await terminalHarness();
  await failure.store.transitionTerminal(scope, {
    runId: "run-a",
    attemptId: "attempt-a",
    generation: 3,
    status: "failed",
    errorCode: "MODEL_EXECUTION_UNAVAILABLE",
    requestLease: makeLease({
      expiresAt: failure.state.attempt.requestOwnerExpiresAt as Date,
    }),
  });
  const failureAttemptUpdate = failure.state.statements.find(
    (statement) =>
      statement.kind === "update" &&
      statement.table === "enterprise_run_attempts",
  ) as Extract<FakeStatement, { kind: "update" }> | undefined;
  expect(failureAttemptUpdate).toBeDefined();
  expect(failureAttemptUpdate?.whereParams).toContain("failed");
  expect(failureAttemptUpdate?.whereParams).toContain(
    "MODEL_EXECUTION_UNAVAILABLE",
  );
});

test("store guard admits only the fixed failure tuple and lease-less success", async () => {
  const scope = await makeTrustedScope();
  const lease = makeLease();
  // A success lease may never carry an error code.
  const withCode = await terminalHarness();
  const fromWithCode = withCode.state.statements.length;
  await expect(
    withCode.store.transitionTerminal(scope, {
      runId: lease.runId,
      attemptId: lease.attemptId,
      generation: lease.generation,
      status: "succeeded",
      errorCode: "MODEL_EXECUTION_UNAVAILABLE",
      requestLease: lease,
    }),
  ).resolves.toBe(false);
  expect(statementsSince(withCode.state, fromWithCode)).toEqual([]);
  // A failure lease may carry only the reviewed fixed codes
  // (Task 2 widened the taxonomy; MODEL_SETTLEMENT_FAILED is now admitted).
  const wrongCode = await terminalHarness();
  const fromWrongCode = wrongCode.state.statements.length;
  await expect(
    wrongCode.store.transitionTerminal(scope, {
      runId: lease.runId,
      attemptId: lease.attemptId,
      generation: lease.generation,
      status: "failed",
      errorCode: "arbitrary-error",
      requestLease: lease,
    }),
  ).resolves.toBe(false);
  expect(statementsSince(wrongCode.state, fromWrongCode)).toEqual([]);
  // The reviewed fixed-code failure tuple is still admitted end to end.
  const fixedCode = await terminalHarness();
  await expect(
    fixedCode.store.transitionTerminal(scope, {
      runId: lease.runId,
      attemptId: lease.attemptId,
      generation: lease.generation,
      status: "failed",
      errorCode: "MODEL_EXECUTION_UNAVAILABLE",
      requestLease: makeLease({
        expiresAt: fixedCode.state.attempt.requestOwnerExpiresAt as Date,
      }),
    }),
  ).resolves.toBe(true);
  expect(fixedCode.state.outbox.map((event) => event.eventType)).toEqual([
    "run.failed",
  ]);
});

test("unfenced store success remains available and keeps the owner claim", async () => {
  const scope = await makeTrustedScope();
  const { store, state } = await terminalHarness();
  await expect(
    store.transitionTerminal(scope, {
      runId: "run-a",
      attemptId: "attempt-a",
      generation: 3,
      status: "succeeded",
    }),
  ).resolves.toBe(true);
  expect(state.run.status).toBe("succeeded");
  expect(state.attempt.status).toBe("completed");
  // Owner clearing is exclusive to the leased path; the unfenced store-level
  // path (reachable only outside the service surface) keeps the claim.
  expect(state.attempt.requestOwnerToken).toBe("owner-a");
  expect(state.outbox.map((event) => event.eventType)).toEqual([
    "run.succeeded",
  ]);
});

// --- event append ordering ---------------------------------------------------

test("event_append_after_complete_is_stale", async () => {
  const scope = await makeTrustedScope();
  const lease = makeLease();
  const state = {
    // Mirror of complete's committed effect on the attempt row.
    attemptStatus: "active",
    requestOwnerToken: "owner-a" as string | null,
  };
  const events: RunnerEventRecord[] = [];
  const repository: RunnerEventRepository = {
    async transaction(_scope, operation) {
      const tx: RunnerEventTransaction = {
        lockRunAndAttempt: async () => {},
        lockSourceIdentity: async () => {},
        findActiveRun: async () =>
          state.attemptStatus === "active" &&
          state.requestOwnerToken === lease.ownerToken
            ? { threadId: "thread-a" }
            : undefined,
        findBySourceIdentity: async () => undefined,
        lockThreadCursor: async () => {},
        nextThreadCursor: async () => events.length + 1,
        insert: async (eventScope, proposal, threadId, seq) => {
          const record: RunnerEventRecord = {
            eventId: `event-row-${seq}`,
            tenantId: eventScope.tenantId,
            workspaceId: eventScope.workspaceId,
            principalId: eventScope.principalId,
            threadId,
            runId: proposal.lease.runId,
            attemptId: proposal.lease.attemptId,
            generation: proposal.lease.generation,
            sourceEventId: proposal.sourceEventId,
            seq,
            schemaVersion: proposal.schemaVersion,
            event: proposal.event,
            createdAt: new Date(0),
          };
          events.push(record);
          return record;
        },
        replay: async () => [],
      };
      return operation(tx);
    },
  };
  const service = createRunnerEventService({ repository });
  const proposal = (sourceEventId: string, event: BaseEvent) => ({
    lease,
    sourceEventId,
    schemaVersion: 1 as const,
    event,
  });
  // While the attempt is active and owned, final events append fine.
  await service.append(
    scope,
    proposal("event-a", {
      type: "RUN_FINISHED",
      threadId: "thread-a",
      runId: lease.runId,
    }),
  );
  expect(events).toHaveLength(1);
  // After complete the attempt is completed and the owner claim is cleared,
  // so any further append is stale — events must precede terminalization.
  state.attemptStatus = "completed";
  state.requestOwnerToken = null;
  await expect(
    service.append(
      scope,
      proposal("event-b", {
        type: "RUN_FINISHED",
        threadId: "thread-a",
        runId: lease.runId,
      }),
    ),
  ).rejects.toThrow("RUN_ATTEMPT_STALE");
  expect(events).toHaveLength(1);
});

async function makeTrustedScope(): Promise<PlatformScope> {
  const database = {
    execute: async () => [capabilityCheck],
    transaction: async (
      operation: (transaction: unknown) => Promise<unknown>,
    ) =>
      operation({
        execute: async () => [],
        select: () => {
          const query = {
            from: () => query,
            innerJoin: () => query,
            where: () => query,
            limit: async () => [
              {
                tenantId: "tenant-a",
                principalId: "principal-a",
                tenantStatus: "active",
                principalStatus: "active",
                memberStatus: "active",
                memberEpoch: 1,
              },
            ],
          };
          return query;
        },
      }),
  } as never;
  const directory = await verifyDirectoryDatabase(database);
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId: "actor-a", entrypoint: "web" }),
    selectTenant: () => "tenant-a",
    selectWorkspace: () => "workspace-a",
  });
  return resolver.resolve(new Request("https://example.invalid"));
}
