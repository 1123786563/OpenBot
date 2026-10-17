import { expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type {
  PlatformScope,
  RunFailureCode,
  RunnerRequestLease,
} from "../../src/enterprise/contracts";
import {
  failRunWithLease,
  validateStopInput,
} from "../../src/enterprise/runs/service";
import {
  createRunStore,
  runFailureRunLeaseFence,
  runSuccessRunLeaseFence,
} from "../../src/enterprise/runs/store";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
} from "../../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";

/**
 * Focused failure-code/lease cases for the widened execution failure
 * taxonomy: every fixed code must travel the exact reviewed leased failure
 * path (exact live owner attempt, cleared request claim, one failed outbox),
 * arbitrary codes must reject before the store, and the success fence must
 * stay untouched.
 */

const executionFailureCodes = [
  "MODEL_EXECUTION_FAILED",
  "MODEL_SETTLEMENT_FAILED",
  "MODEL_BUDGET_EXCEEDED",
] as const satisfies readonly RunFailureCode[];

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

// --- store-level synthetic transaction harness (success-contract pattern) ---

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

function coerceWrittenValue(value: unknown): unknown {
  if (value instanceof Date || value === null || typeof value === "string") {
    return value;
  }
  return new Date();
}

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

async function failureHarness(): Promise<{
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

function liveLease(state: FakeRunState): RunnerRequestLease {
  return makeLease({
    expiresAt: state.attempt.requestOwnerExpiresAt as Date,
  });
}

function attemptUpdateOf(
  state: FakeRunState,
): (Extract<FakeStatement, { kind: "update" }> | undefined)[] {
  return state.statements.filter(
    (statement) =>
      statement.kind === "update" &&
      statement.table === "enterprise_run_attempts",
  ) as (Extract<FakeStatement, { kind: "update" }> | undefined)[];
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

// --- each new execution failure code uses the exact leased failure path -----

for (const errorCode of executionFailureCodes) {
  test(`leased ${errorCode} fails only the exact live owner attempt`, async () => {
    const scope = await makeTrustedScope();
    const { store, state } = await failureHarness();
    await expect(
      store.transitionTerminal(scope, {
        runId: "run-a",
        attemptId: "attempt-a",
        generation: 3,
        status: "failed",
        errorCode,
        requestLease: liveLease(state),
      }),
    ).resolves.toBe(true);
    expect(state.run.status).toBe("failed");
    expect(state.run.errorCode).toBe(errorCode);
    expect(state.run.finishedAt).toBeInstanceOf(Date);
    expect(state.attempt.status).toBe("completed");
    // The request claim is cleared exactly once with the attempt completion.
    expect(state.attempt.requestOwnerToken).toBeNull();
    expect(state.attempt.requestOwnerExpiresAt).toBeNull();
    expect(state.outbox).toEqual([{ eventType: "run.failed" }]);

    const updates = attemptUpdateOf(state);
    expect(updates).toHaveLength(1);
    const attemptUpdate = updates[0];
    // The leased attempt-update fence matches the supplied allowed error code
    // plus the exact scope/run/attempt ownership.
    expect(attemptUpdate?.whereParams).toContain("failed");
    expect(attemptUpdate?.whereParams).toContain(errorCode);
    expect(attemptUpdate?.whereParams).toContain("tenant-a");
    expect(attemptUpdate?.whereParams).toContain("workspace-a");
    expect(attemptUpdate?.whereParams).toContain("principal-a");
    expect(attemptUpdate?.whereParams).toContain("run-a");
    expect(attemptUpdate?.whereParams).toContain("attempt-a");
    expect(attemptUpdate?.whereParams).toContain(3);
    // The success-specific fence never appears on a failure transition.
    expect(attemptUpdate?.whereSql).not.toContain('"error_code" is null');
  });

  test(`leased ${errorCode} is refused for every stale owner claim`, async () => {
    const scope = await makeTrustedScope();
    // Owner token replaced by another request's claim.
    const replaced = await failureHarness();
    replaced.state.attempt.requestOwnerToken = "owner-b";
    await expect(
      replaced.store.transitionTerminal(scope, {
        runId: "run-a",
        attemptId: "attempt-a",
        generation: 3,
        status: "failed",
        errorCode,
        requestLease: makeLease(),
      }),
    ).resolves.toBe(false);
    expect(replaced.state.run.status).toBe("running");
    expect(replaced.state.attempt.status).toBe("active");
    expect(replaced.state.attempt.requestOwnerToken).toBe("owner-b");
    expect(replaced.state.outbox).toEqual([]);

    // Heartbeat renewed the stored owner expiry; the held snapshot is stale.
    const renewed = await failureHarness();
    renewed.state.attempt.requestOwnerExpiresAt = new Date(
      (renewed.state.attempt.requestOwnerExpiresAt as Date).getTime() + 30_000,
    );
    await expect(
      renewed.store.transitionTerminal(scope, {
        runId: "run-a",
        attemptId: "attempt-a",
        generation: 3,
        status: "failed",
        errorCode,
        requestLease: makeLease(),
      }),
    ).resolves.toBe(false);
    expect(renewed.state.run.status).toBe("running");
    expect(renewed.state.outbox).toEqual([]);

    // Owner claim already released; no live owner to match.
    const released = await failureHarness();
    released.state.attempt.requestOwnerToken = null;
    released.state.attempt.requestOwnerExpiresAt = null;
    await expect(
      released.store.transitionTerminal(scope, {
        runId: "run-a",
        attemptId: "attempt-a",
        generation: 3,
        status: "failed",
        errorCode,
        requestLease: makeLease(),
      }),
    ).resolves.toBe(false);
    expect(released.state.run.status).toBe("running");
    expect(released.state.outbox).toEqual([]);
  });
}

// --- guard: arbitrary codes and success tuples --------------------------------

test("store guard rejects leased failures with codes outside the fixed taxonomy", async () => {
  const scope = await makeTrustedScope();
  const lease = makeLease();
  for (const invalidCode of [
    "arbitrary-error",
    "model_execution_failed",
    "MODEL_EXECUTION_UNAVAILABLE ",
    "",
  ]) {
    const harness = await failureHarness();
    const from = harness.state.statements.length;
    await expect(
      harness.store.transitionTerminal(scope, {
        runId: lease.runId,
        attemptId: lease.attemptId,
        generation: lease.generation,
        status: "failed",
        errorCode: invalidCode,
        requestLease: liveLease(harness.state),
      }),
    ).resolves.toBe(false);
    expect(statementsSince(harness.state, from)).toEqual([]);
    expect(harness.state.outbox).toEqual([]);
    expect(harness.state.run.status).toBe("running");
    expect(harness.state.attempt.status).toBe("active");
  }
});

test("store guard still rejects a leased success carrying any failure code", async () => {
  const scope = await makeTrustedScope();
  const lease = makeLease();
  for (const errorCode of [
    "MODEL_EXECUTION_UNAVAILABLE",
    ...executionFailureCodes,
  ] as const) {
    const harness = await failureHarness();
    const from = harness.state.statements.length;
    await expect(
      harness.store.transitionTerminal(scope, {
        runId: lease.runId,
        attemptId: lease.attemptId,
        generation: lease.generation,
        status: "succeeded",
        errorCode,
        requestLease: liveLease(harness.state),
      }),
    ).resolves.toBe(false);
    expect(statementsSince(harness.state, from)).toEqual([]);
    expect(harness.state.outbox).toEqual([]);
  }
});

test("leased success keeps the success-specific fence next to the widened failure fence", async () => {
  const scope = await makeTrustedScope();
  const { store, state } = await failureHarness();
  await expect(
    store.transitionTerminal(scope, {
      runId: "run-a",
      attemptId: "attempt-a",
      generation: 3,
      status: "succeeded",
      requestLease: liveLease(state),
    }),
  ).resolves.toBe(true);
  expect(state.run.status).toBe("succeeded");
  expect(state.run.errorCode).toBeNull();
  expect(state.outbox).toEqual([{ eventType: "run.succeeded" }]);
  const attemptUpdate = attemptUpdateOf(state)[0];
  expect(attemptUpdate?.whereParams).toContain("succeeded");
  expect(attemptUpdate?.whereSql).toContain('"error_code" is null');
  for (const errorCode of executionFailureCodes) {
    expect(attemptUpdate?.whereParams).not.toContain(errorCode);
    expect(attemptUpdate?.whereSql).not.toContain(errorCode);
  }
});

// --- fences stay code-specific and the refusal stays distinct ------------------

test("the failure and success fences are distinct per terminal outcome", () => {
  const scope: PlatformScope = {
    tenantId: "tenant-a",
    workspaceId: "workspace-a",
    principalId: "principal-a",
    actorId: "actor-a",
    memberEpoch: 1,
    aclEpoch: 1,
    entrypoint: "web",
  };
  const failureFence = new PgDialect().sqlToQuery(
    runFailureRunLeaseFence(scope, makeLease(), "MODEL_BUDGET_EXCEEDED"),
  );
  expect(failureFence.params).toContain("failed");
  expect(failureFence.params).toContain("MODEL_BUDGET_EXCEEDED");
  expect(failureFence.sql).toContain("clock_timestamp()");

  const successFence = new PgDialect().sqlToQuery(
    runSuccessRunLeaseFence(scope, makeLease()),
  );
  expect(successFence.params).toContain("succeeded");
  expect(successFence.sql).toContain('"error_code" is null');
  expect(successFence.params).not.toContain("failed");
  for (const code of [
    "MODEL_EXECUTION_UNAVAILABLE",
    ...executionFailureCodes,
  ] as const) {
    expect(successFence.params).not.toContain(code);
    expect(successFence.sql).not.toContain(code);
  }
});

// --- service-level: only fixed codes reach the store delegate ------------------

test("failRunWithLease rejects new-code lookalikes before the store delegate", async () => {
  const scope = await makeTrustedScope();
  const lease = makeLease();
  for (const invalidCode of ["MODEL_EXECUTION_FAIL", "MODEL_FAILED", "x"]) {
    let delegated = false;
    await expect(
      failRunWithLease(
        scope,
        { lease, errorCode: invalidCode as RunFailureCode },
        async () => {
          delegated = true;
          return true;
        },
      ),
    ).rejects.toThrow("INVALID_RUN_FAILURE_INPUT");
    expect(delegated).toBe(false);
  }
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

// --- OCR R3: lease renewal extends the run/attempt main leases (HIGH-2) ------

test("renewal_extends_run_and_attempt_main_leases", async () => {
  const scope = await makeTrustedScope();
  const { store, state } = await failureHarness();
  // Mirror the real creation shape: the run lease is one lease window from
  // admission (the harness default of 120s is longer than a real run lease).
  const now = Date.now();
  state.run.createdAt = new Date(now - 100);
  // A lease shorter than the renewal window, so the extension asserts with
  // clock-resolution headroom.
  state.run.leaseExpiresAt = new Date(now + 20_000);
  state.attempt.leaseExpiresAt = new Date(now + 20_000);

  const renewed = await store.renewRequestLease(scope, liveLease(state));

  const runUpdate = state.statements.find(
    (statement) =>
      statement.kind === "update" && statement.table === "enterprise_runs",
  ) as Extract<FakeStatement, { kind: "update" }> | undefined;
  // The renewal must extend the run's main lease, not only the request claim.
  const renewedLease = runUpdate?.values.leaseExpiresAt;
  expect(runUpdate).toBeDefined();
  expect(renewedLease).toBeInstanceOf(Date);
  expect((renewedLease as Date).getTime()).toBeGreaterThan(now + 20_000);
  // The active attempt's main lease rides the same extension.
  const attemptUpdate = attemptUpdateOf(state).at(-1);
  expect(attemptUpdate?.values.leaseExpiresAt).toBe(
    runUpdate?.values.leaseExpiresAt,
  );
  expect(attemptUpdate?.values.requestOwnerExpiresAt).toBeInstanceOf(Date);
  expect(renewed.expiresAt).toBe(attemptUpdate?.values.requestOwnerExpiresAt);
  expect(renewed.ownerToken).toBe("owner-a");
});

test("renewal_extends_run_lease_capped_by_maximum_run_duration", async () => {
  const scope = await makeTrustedScope();
  const { store, state } = await failureHarness();
  // A run near the maximum-duration cap: no renewal may extend past it.
  const now = Date.now();
  state.run.createdAt = new Date(now - 15 * 60_000 + 10_000);
  state.run.leaseExpiresAt = new Date(now + 5_000);
  state.attempt.leaseExpiresAt = new Date(now + 5_000);

  const renewed = await store.renewRequestLease(scope, liveLease(state));

  const runUpdate = state.statements.find(
    (statement) =>
      statement.kind === "update" && statement.table === "enterprise_runs",
  ) as Extract<FakeStatement, { kind: "update" }> | undefined;
  const renewedLease = runUpdate?.values.leaseExpiresAt;
  expect(renewedLease).toBeInstanceOf(Date);
  expect((renewedLease as Date).getTime()).toBeLessThanOrEqual(
    now + 15 * 60_000,
  );
  expect(renewed.expiresAt.getTime()).toBeLessThanOrEqual(now + 15 * 60_000);
});

// --- OCR R3: stop input validation is symmetric with fail/complete (M-i) ----

test("validateStopInput rejects malformed shapes before the store", async () => {
  const good = {
    runId: "run-a",
    reason: "user_requested",
    attemptId: "attempt-a",
    generation: 3,
  };
  expect(() => validateStopInput(good)).not.toThrow();
  for (const bad of [
    { ...good, runId: "" },
    { ...good, runId: 42 },
    { ...good, runId: { id: "run-a" } },
    { ...good, runId: ["run-a"] },
    { ...good, attemptId: "" },
    { ...good, attemptId: null },
    { ...good, generation: 0 },
    { ...good, generation: 1.5 },
    { ...good, generation: "3" },
    { ...good, reason: "because" },
    { ...good, reason: "" },
  ]) {
    expect(() => validateStopInput(bad)).toThrow("INVALID_STOP_INPUT");
  }
  expect(() => validateStopInput(undefined)).toThrow("INVALID_STOP_INPUT");
});
