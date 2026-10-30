import { expect, test } from "../../../tests/support/e2e-compat";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BaseEvent } from "@ag-ui/client";
import type { RunnerEventRecord } from "../../src/enterprise/contracts";
import type {
  RunnerEventRepository,
  RunnerEventTransaction,
} from "../../src/enterprise/runs/events";
import {
  canonicalizeRunnerEvent,
  createDrizzleRunnerEventRepository,
  createRunnerEventService,
} from "../../src/enterprise/runs/events";
import type {
  DataDatabase,
  DirectoryDatabase,
} from "../../src/enterprise/tenancy/connections";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
} from "../../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";

const lease = {
  runId: "10000000-0000-4000-8000-000000000001",
  attemptId: "10000000-0000-4000-8000-000000000002",
  generation: 1,
  ownerToken: "10000000-0000-4000-8000-000000000003",
  expiresAt: new Date(Date.now() + 60_000),
};

test("event_append_is_durable_before_publish", async () => {
  const { repository, state, releaseCommit } = await memoryRepository();
  const service = createRunnerEventService({
    repository,
    pollMilliseconds: 10,
  });
  const scope = await makeScope();
  state.holdCommit = true;
  const stream = service
    .subscribe(
      scope,
      { threadId: "thread-a", afterSeq: 0 },
      new AbortController().signal,
    )
    [Symbol.asyncIterator]();
  const pendingAppend = service.append(
    scope,
    proposal("event-a", {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m1",
      delta: "x",
    }),
  );
  await Bun.sleep(30);
  expect(state.events).toHaveLength(0);
  releaseCommit();
  await pendingAppend;
  await expect(
    Promise.race([
      stream.next(),
      Bun.sleep(500).then(() => "timeout" as const),
    ]),
  ).resolves.toMatchObject({ value: { sourceEventId: "event-a" } });
  await stream.return?.();
});

test("event_retry_same_payload_is_idempotent", async () => {
  const { repository, state } = await memoryRepository();
  const service = createRunnerEventService({ repository });
  const scope = await makeScope();
  const item = proposal("event-a", {
    type: "RUN_STARTED",
    threadId: "thread-a",
    runId: lease.runId,
  });
  const first = await service.append(scope, item);
  const retry = await service.append(scope, item);
  expect(retry).toEqual({ ...first, duplicate: true });
  expect(state.events).toHaveLength(1);
});

test("event_retry_changed_payload_conflicts", async () => {
  const { repository } = await memoryRepository();
  const service = createRunnerEventService({ repository });
  const scope = await makeScope();
  await service.append(
    scope,
    proposal("event-a", {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m1",
      delta: "x",
    }),
  );
  await expect(
    service.append(
      scope,
      proposal("event-a", {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "m1",
        delta: "y",
      }),
    ),
  ).rejects.toThrow("RUNNER_EVENT_IDENTITY_CONFLICT");
});

test("restart_replays_authorized_events", async () => {
  const { repository } = await memoryRepository();
  const scope = await makeScope();
  await createRunnerEventService({ repository }).append(
    scope,
    proposal("event-a", {
      type: "RUN_FINISHED",
      threadId: "thread-a",
      runId: lease.runId,
    }),
  );
  const restarted = createRunnerEventService({ repository });
  await expect(
    restarted.replay(scope, { threadId: "thread-a", afterSeq: 0 }),
  ).resolves.toMatchObject({ items: [{ sourceEventId: "event-a" }] });
});

test("replay_live_handoff_has_no_gap_or_duplicate", async () => {
  const { repository } = await memoryRepository();
  const service = createRunnerEventService({
    repository,
    pollMilliseconds: 10,
  });
  const scope = await makeScope();
  await service.append(
    scope,
    proposal("event-a", {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m1",
      delta: "one",
    }),
  );
  const stream = service
    .subscribe(
      scope,
      { threadId: "thread-a", afterSeq: 0 },
      new AbortController().signal,
    )
    [Symbol.asyncIterator]();
  expect((await stream.next()).value?.sourceEventId).toBe("event-a");
  const append = await service.append(
    scope,
    proposal("event-b", {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m1",
      delta: "two",
    }),
  );
  expect((await stream.next()).value?.seq).toBe(append.seq);
  await stream.return?.();
});

test("revoked_membership_blocks_event_delivery", async () => {
  const { repository, state } = await memoryRepository();
  const service = createRunnerEventService({
    repository,
    pollMilliseconds: 10,
  });
  const scope = await makeScope();
  await service.append(
    scope,
    proposal("event-a", {
      type: "RUN_FINISHED",
      threadId: "thread-a",
      runId: lease.runId,
    }),
  );
  state.authorized = false;
  await expect(
    service.replay(scope, { threadId: "thread-a", afterSeq: 0 }),
  ).rejects.toThrow("SCOPE_REVOKED");
});

test("subscribe_rechecks_membership_before_each_batch", async () => {
  const { repository, state } = await memoryRepository();
  const service = createRunnerEventService({
    repository,
    pollMilliseconds: 10,
  });
  const scope = await makeScope();
  await service.append(
    scope,
    proposal("event-a", {
      type: "RUN_STARTED",
      runId: lease.runId,
      threadId: "thread-a",
    }),
  );
  const stream = service
    .subscribe(
      scope,
      { threadId: "thread-a", afterSeq: 0 },
      new AbortController().signal,
    )
    [Symbol.asyncIterator]();
  await expect(stream.next()).resolves.toMatchObject({
    value: { sourceEventId: "event-a" },
  });
  state.authorized = false;
  await expect(stream.next()).rejects.toThrow("SCOPE_REVOKED");
});

test("replay_paginates_with_a_durable_thread_cursor", async () => {
  const { repository } = await memoryRepository();
  const service = createRunnerEventService({ repository });
  const scope = await makeScope();
  await service.append(
    scope,
    proposal("event-a", {
      type: "RUN_STARTED",
      runId: lease.runId,
      threadId: "thread-a",
    }),
  );
  await service.append(
    scope,
    proposal("event-b", {
      type: "RUN_FINISHED",
      runId: lease.runId,
      threadId: "thread-a",
    }),
  );
  const first = await service.replay(scope, {
    threadId: "thread-a",
    afterSeq: 0,
    limit: 1,
  });
  expect(first.items.map((item) => item.sourceEventId)).toEqual(["event-a"]);
  expect(first.nextCursor).toEqual({
    threadId: "thread-a",
    afterSeq: 1,
    limit: 1,
  });
  const cursor = first.nextCursor;
  if (!cursor) throw new Error("EXPECTED_NEXT_CURSOR");
  const second = await service.replay(scope, cursor);
  expect(second.items.map((item) => item.sourceEventId)).toEqual(["event-b"]);
  expect(second.nextCursor).toBeNull();
});

test("stale_attempt_cannot_append_event", async () => {
  const { repository, state } = await memoryRepository();
  const service = createRunnerEventService({ repository });
  const scope = await makeScope();
  state.active = false;
  await expect(
    service.append(
      scope,
      proposal("event-a", {
        type: "RUN_FINISHED",
        threadId: "thread-a",
        runId: lease.runId,
      }),
    ),
  ).rejects.toThrow("RUN_ATTEMPT_STALE");
});

test("event_payload_canonicalization_is_key_order_independent", () => {
  expect(
    canonicalizeRunnerEvent({
      type: "CUSTOM",
      z: 1,
      a: { y: 2, x: 1 },
    } as BaseEvent),
  ).toBe(
    canonicalizeRunnerEvent({
      type: "CUSTOM",
      a: { x: 1, y: 2 },
      z: 1,
    } as BaseEvent),
  );
});

test("event_fk_requires_preexisting_owner_unique_key", () => {
  const migration = readFileSync(
    join(import.meta.dir, "../../drizzle/0070_runner_event_attribution.sql"),
    "utf8",
  );
  const uniqueIndex = migration.indexOf(
    'CREATE UNIQUE INDEX "enterprise_runs_event_owner_binding"',
  );
  const ownerForeignKey = migration.indexOf(
    'ADD CONSTRAINT "enterprise_runner_events_runs_owner_fk"',
  );
  expect(uniqueIndex).toBeGreaterThanOrEqual(0);
  expect(ownerForeignKey).toBeGreaterThanOrEqual(0);
  expect(uniqueIndex).toBeLessThan(ownerForeignKey);
});

test("event_append_serializes_with_cancel_and_lease_takeover", async () => {
  const { repository, state } = await memoryRepository();
  const service = createRunnerEventService({ repository });
  await service.append(
    await makeScope(),
    proposal("event-lock-order", {
      type: "RUN_STARTED",
      runId: lease.runId,
      threadId: "thread-a",
    }),
  );
  expect(state.lockOrder).toEqual(["run", "attempt", "check"]);
});

test("event_append_expiry_is_sampled_after_row_locks", () => {
  const source = readFileSync(
    join(import.meta.dir, "../../src/enterprise/runs/events.ts"),
    "utf8",
  );
  expect(source).toContain("clock_timestamp()");
  expect(source.indexOf('.for("update")')).toBeLessThan(
    source.indexOf("clock_timestamp()"),
  );
});

test("stale_owner_cannot_append_after_takeover", async () => {
  const { repository, state } = await memoryRepository();
  state.takeoverBeforeLock = true;
  const service = createRunnerEventService({ repository });
  await expect(
    service.append(
      await makeScope(),
      proposal("stale-after-takeover", {
        type: "RUN_FINISHED",
        runId: lease.runId,
        threadId: "thread-a",
      }),
    ),
  ).rejects.toThrow("RUN_ATTEMPT_STALE");
  expect(state.events).toHaveLength(0);
});

function proposal(sourceEventId: string, event: BaseEvent) {
  return { lease, sourceEventId, schemaVersion: 1 as const, event };
}

async function memoryRepository() {
  const state: {
    events: RunnerEventRecord[];
    authorized: boolean;
    active: boolean;
    holdCommit: boolean;
    lockOrder: string[];
    takeoverBeforeLock: boolean;
  } = {
    events: [],
    authorized: true,
    active: true,
    holdCommit: false,
    lockOrder: [],
    takeoverBeforeLock: false,
  };
  let releaseCommit = () => {};
  const repository: RunnerEventRepository = {
    async transaction(_scope, operation) {
      if (!state.authorized) throw new Error("SCOPE_REVOKED");
      const pending = [...state.events];
      const tx: RunnerEventTransaction = {
        lockRunAndAttempt: async () => {
          state.lockOrder.push("run", "attempt");
          if (state.takeoverBeforeLock) state.active = false;
        },
        lockSourceIdentity: async () => {},
        findActiveRun: async (_scope, currentLease) => {
          state.lockOrder.push("check");
          return state.active && currentLease.ownerToken === lease.ownerToken
            ? { threadId: "thread-a" }
            : undefined;
        },
        findBySourceIdentity: async (_scope, currentLease, sourceEventId) =>
          pending.find(
            (row) =>
              row.runId === currentLease.runId &&
              row.sourceEventId === sourceEventId,
          ),
        lockThreadCursor: async () => {},
        nextThreadCursor: async (_scope, threadId) =>
          (pending.filter((row) => row.threadId === threadId).at(-1)?.seq ??
            0) + 1,
        insert: async (scope, proposal, threadId, seq) => {
          const record: RunnerEventRecord = {
            eventId: `event-row-${seq}`,
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
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
          pending.push(record);
          return record;
        },
        replay: async (scope, threadId, afterSeq, limit) =>
          pending
            .filter(
              (row) =>
                row.tenantId === scope.tenantId &&
                row.workspaceId === scope.workspaceId &&
                row.principalId === scope.principalId &&
                row.threadId === threadId &&
                row.seq > afterSeq,
            )
            .slice(0, limit),
      };
      const result = await operation(tx);
      if (state.holdCommit && pending.length > state.events.length) {
        await new Promise<void>((resolve) => {
          releaseCommit = resolve;
        });
      }
      state.events = pending;
      return result;
    },
  };
  return { repository, state, releaseCommit: () => releaseCommit() };
}

async function makeScope() {
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
  const queryDb = (rows: (table: unknown) => Record<string, unknown>[]) => ({
    execute: async () => [capabilityCheck],
    transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
      let table: unknown;
      const query = {
        from(value: unknown) {
          table = value;
          return this;
        },
        innerJoin() {
          return this;
        },
        where() {
          return this;
        },
        limit() {
          return Promise.resolve(rows(table));
        },
        // biome-ignore lint/suspicious/noThenProperty: Drizzle queries are awaitable thenables.
        then(
          resolve: (value: Record<string, unknown>[]) => unknown,
          reject: (error: unknown) => unknown,
        ) {
          return Promise.resolve(rows(table)).then(resolve, reject);
        },
      };
      return operation({ execute: async () => [], select: () => query });
    },
  });
  const directory = await verifyDirectoryDatabase(
    queryDb(() => [
      { tenantId: "tenant-a", principalId: "principal-a", memberEpoch: 3 },
    ]) as unknown as DirectoryDatabase,
  );
  const data = await verifyDataDatabase(
    queryDb(() => [
      {
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
        principalId: "principal-a",
        tenantStatus: "active",
      },
    ]) as unknown as DataDatabase,
  );
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId: "actor-a", entrypoint: "web" }),
    data,
  });
  return resolver.resolveForThread(
    new Request("https://example.invalid"),
    "thread-a",
  );
}

// --- OCR R4: replay fidelity, cursor validation, non-transactional polling ----

test("cursor_rejects_non_string_thread_id", async () => {
  const scope = await makeScope();
  const { repository } = await memoryRepository();
  const service = createRunnerEventService({ repository });
  for (const threadId of [undefined, 42, { id: "thread-a" }, ["thread-a"]]) {
    await expect(
      service.replay(scope, { threadId: threadId as never, afterSeq: 0 }),
    ).rejects.toThrow("RUNNER_EVENT_CURSOR_INVALID");
  }
});

test("drizzle_replay_reports_row_schema_version", async () => {
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
  const scope = await makeScope();
  const rows = [
    {
      id: "event-row-1",
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      principalId: scope.principalId,
      threadId: "thread-a",
      runId: "run-a",
      attemptId: "attempt-a",
      generation: 1,
      sourceEventId: "source-1",
      seq: 1,
      schemaVersion: 2,
      event: { type: "RUN_STARTED" },
      createdAt: new Date(0),
    },
  ];
  const memberQuery = {
    from() {
      return memberQuery;
    },
    innerJoin() {
      return memberQuery;
    },
    where() {
      return memberQuery;
    },
    limit: async () => [
      {
        memberStatus: "active",
        memberEpoch: 3,
        principalStatus: "active",
        tenantStatus: "active",
        workspaceId: "workspace-a",
      },
    ],
  };
  const replayQuery = {
    from() {
      return replayQuery;
    },
    where() {
      return replayQuery;
    },
    orderBy() {
      return replayQuery;
    },
    limit: async () => rows,
  };
  let selects = 0;
  const tx = {
    execute: async () => [],
    select: () => {
      selects += 1;
      return selects === 1 ? memberQuery : replayQuery;
    },
  };
  const database = {
    execute: async () => [capabilityCheck],
    transaction: async (operation: (txInner: unknown) => Promise<unknown>) =>
      operation(tx),
    select: () => replayQuery,
  };
  const data = await verifyDataDatabase(database as never);
  const repository = createDrizzleRunnerEventRepository(data);
  const page = await repository.transaction(scope, (tx) =>
    tx.replay(scope, "thread-a", 0, 10),
  );
  expect(page).toHaveLength(1);
  expect(page[0]?.schemaVersion).toBe(2);
});

test("append_rejects_malformed_proposal_shapes_with_the_domain_error", async () => {
  const scope = await makeScope();
  const service = createRunnerEventService({
    repository: await memoryRepository(),
  });
  for (const proposal of [null, undefined, { lease: null }]) {
    await expect(service.append(scope, proposal as never)).rejects.toThrow(
      "RUNNER_EVENT_INVALID",
    );
  }
});
