import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CreateRun } from "../../../../shared/enterprise/run-contracts";
import { EnterpriseError } from "../../../src/enterprise/errors";
import {
  createRunHarness,
  probeRunsDatabase,
  type RunHarness,
} from "./support";

/*
 * E1-C 原子创建（03 分册 §4.3 测试步骤 910-920 行）。
 *
 * 真实库 + 真实 RunService + 真实 BudgetPort（E4-B）：并发同 key 只产生一个
 * Run/预留/Outbox；不同 digest 409；故障注入在“插 Run 后、预留后、插 Outbox 后”
 * 三个位置抛测试异常，确认整个事务回滚；额度不足不留半成品；撤权、他人 thread、
 * 路由权限、重放后撤权全部在受限登录上取证。count 是固定三条 SQL 的租户内增量，
 * 测试前后对比而不是写死绝对值。
 */

const probe = await probeRunsDatabase();
const describeDb = probe.ready ? describe : describe.skip;
if (!probe.ready) {
  console.warn(`[create.test.ts] real-database assertions skipped: ${probe.reason}`);
}

let h: RunHarness;

async function errorOf(run: () => Promise<unknown>): Promise<EnterpriseError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof EnterpriseError) {
      return error;
    }
    throw new Error(`expected an EnterpriseError, got: ${String(error)}`);
  }
  throw new Error("expected the call to be rejected, but it succeeded");
}

/** 故障注入抛的是测试自己的普通 Error：按消息取证即可。 */
async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the call to be rejected, but it succeeded");
}

describeDb("E1-C run creation", () => {
  beforeAll(async () => {
    h = await createRunHarness();
  });
  afterAll(async () => {
    /* 只清理本夹具的 r1c- 行（dispatcher 等跨租户断言按全表取数，必须不留我的行），
     * 再关闭连接；不碰其他测试的数据。 */
    await h?.cleanup();
    await h?.close();
  });

  const request = (overrides: Partial<CreateRun> = {}): CreateRun => ({
    workspace_id: h.workspaceId,
    expert_release_id: h.releaseId,
    model_alias: h.alias,
    input: { text: "hello" },
    ...overrides,
  });

  test("concurrent same key produce one run, one reservation, one outbox row", async () => {
    const before = {
      runs: await h.count("runs"),
      reservations: await h.count("reservations"),
      outbox: await h.count("start_outbox"),
    };
    const req = request();
    const [a, b] = await Promise.all([
      h.runs.create(h.scope, "r1c-key-concurrent", req),
      h.runs.create(h.scope, "r1c-key-concurrent", req),
    ]);
    expect(a.run_id).toBe(b.run_id);
    expect(a.status).toBe("queued");
    expect(await h.count("runs")).toBe(before.runs + 1);
    expect(await h.count("reservations")).toBe(before.reservations + 1);
    expect(await h.count("start_outbox")).toBe(before.outbox + 1);
  });

  test("same key with a different digest is 409 IDEMPOTENCY_CONFLICT", async () => {
    await h.runs.create(h.scope, "r1c-key-conflict", request());
    const error = await errorOf(() =>
      h.runs.create(h.scope, "r1c-key-conflict", request({ input: { text: "other" } })),
    );
    expect(error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(error.status).toBe(409);
  });

  test("a fault after the run insert rolls the whole transaction back", async () => {
    const before = {
      runs: await h.count("runs"),
      reservations: await h.count("reservations"),
      outbox: await h.count("start_outbox"),
    };
    const store = h.storeWithHooks({
      afterRunInsert: async () => {
        throw new Error("INJECT_AFTER_RUN_INSERT");
      },
    });
    expect(
      await messageOf(() =>
        store.create(h.scope, "r1c-key-fault-1", request()),
      ),
    ).toContain("INJECT_AFTER_RUN_INSERT");
    expect(await h.count("runs")).toBe(before.runs);
    expect(await h.count("reservations")).toBe(before.reservations);
    expect(await h.count("start_outbox")).toBe(before.outbox);
  });

  test("a fault after the reserve rolls the whole transaction back", async () => {
    const before = {
      runs: await h.count("runs"),
      reservations: await h.count("reservations"),
      outbox: await h.count("start_outbox"),
    };
    const store = h.storeWithHooks({
      afterReserve: async () => {
        throw new Error("INJECT_AFTER_RESERVE");
      },
    });
    expect(
      await messageOf(() =>
        store.create(h.scope, "r1c-key-fault-2", request()),
      ),
    ).toContain("INJECT_AFTER_RESERVE");
    expect(await h.count("runs")).toBe(before.runs);
    expect(await h.count("reservations")).toBe(before.reservations);
    expect(await h.count("start_outbox")).toBe(before.outbox);
  });

  test("a fault after the outbox insert rolls the whole transaction back", async () => {
    const before = {
      runs: await h.count("runs"),
      reservations: await h.count("reservations"),
      outbox: await h.count("start_outbox"),
    };
    const store = h.storeWithHooks({
      afterOutboxInsert: async () => {
        throw new Error("INJECT_AFTER_OUTBOX");
      },
    });
    expect(
      await messageOf(() =>
        store.create(h.scope, "r1c-key-fault-3", request()),
      ),
    ).toContain("INJECT_AFTER_OUTBOX");
    expect(await h.count("runs")).toBe(before.runs);
    expect(await h.count("reservations")).toBe(before.reservations);
    expect(await h.count("start_outbox")).toBe(before.outbox);
  });

  test("insufficient budget leaves no half-written rows", async () => {
    await h.setBudgetLimitMicros("10");
    try {
      const before = {
        runs: await h.count("runs"),
        reservations: await h.count("reservations"),
        outbox: await h.count("start_outbox"),
      };
      const error = await errorOf(() =>
        h.runs.create(h.scope, "r1c-key-poor", request()),
      );
      expect(error.code).toBe("BUDGET_EXCEEDED");
      expect(error.status).toBe(429);
      expect(await h.count("runs")).toBe(before.runs);
      expect(await h.count("reservations")).toBe(before.reservations);
      expect(await h.count("start_outbox")).toBe(before.outbox);
    } finally {
      await h.setBudgetLimitMicros("10000000");
    }
  });

  test("a revoked start grant refuses new creates", async () => {
    await h.setRunGrant("start", false);
    try {
      const before = await h.count("runs");
      const error = await errorOf(() =>
        h.runs.create(h.scope, "r1c-key-revoked", request()),
      );
      expect(error.code).toBe("RUN_START_NOT_GRANTED");
      expect(error.status).toBe(403);
      expect(await h.count("runs")).toBe(before);
    } finally {
      await h.setRunGrant("start", true);
    }
  });

  test("a revoked model grant refuses new creates", async () => {
    await h.setModelGrant("revoked");
    try {
      const before = await h.count("runs");
      const error = await errorOf(() =>
        h.runs.create(h.scope, "r1c-key-model", request()),
      );
      expect(error.code).toBe("RUN_MODEL_GRANT_MISSING");
      expect(error.status).toBe(403);
      expect(await h.count("runs")).toBe(before);
    } finally {
      await h.setModelGrant("active");
    }
  });

  test("a disabled release refuses new creates; a disabled route has no approval", async () => {
    await h.setReleaseStatus("disabled");
    try {
      const error = await errorOf(() =>
        h.runs.create(h.scope, "r1c-key-release", request()),
      );
      expect(error.code).toBe("RUN_RELEASE_DISABLED");
      expect(error.status).toBe(403);
    } finally {
      await h.setReleaseStatus("published");
    }
    await h.setRouteStatus("disabled");
    try {
      const error = await errorOf(() =>
        h.runs.create(h.scope, "r1c-key-route", request()),
      );
      expect(error.code).toBe("RUN_MODEL_ROUTE_MISSING");
      expect(error.status).toBe(404);
    } finally {
      await h.setRouteStatus("active");
    }
  });

  test("another principal's thread is invisible and their run unreadable", async () => {
    /* 同租户第二成员 C（已获 start 授权）：A 的 thread 在 C 的 RLS 上下文里不可见。 */
    const error = await errorOf(() =>
      h.runs.create(
        h.scopeC,
        "r1c-key-foreign-thread",
        request({ thread_id: h.threadId }),
      ),
    );
    expect(error.code).toBe("RUN_THREAD_NOT_FOUND");
    expect(error.status).toBe(404);

    const run = await h.runs.create(h.scope, "r1c-key-owned", request());
    const read = await errorOf(() => h.runs.get(h.scopeC, run.run_id));
    expect(read.code).toBe("RUN_NOT_FOUND");
    expect(read.status).toBe(404);
  });

  test("a replay after revocation re-verifies current authorization", async () => {
    await h.runs.create(h.scope, "r1c-key-replay", request());
    await h.setRunGrant("start", false);
    try {
      const error = await errorOf(() =>
        h.runs.create(h.scope, "r1c-key-replay", request()),
      );
      expect(error.code).toBe("RUN_START_NOT_GRANTED");
      expect(error.status).toBe(403);
    } finally {
      await h.setRunGrant("start", true);
    }
  });

  test("a fresh create appends the initial RUN_QUEUED event after commit", async () => {
    const run = await h.runs.create(h.scope, "r1c-key-queued-event", request());
    const event = await h.queuedEvent(run.run_id);
    expect(event).toBeDefined();
    expect(event?.event_type).toBe("RUN_QUEUED");
    expect(event?.seq).toBe("1");
    expect(event?.attempt_id).toBeNull();
    expect(event?.source_event_id).toBe(`platform:run-queued:${run.run_id}`);
    expect(event?.latest_seq).toBe("1");
    /* payload 只含 ID 与状态，不含输入正文。 */
    expect(event?.payload).toEqual({
      run_id: run.run_id,
      thread_id: run.thread_id,
      status: "queued",
    });
    /* 重放同 key 不再追加第二条 RUN_QUEUED（确定性 source 幂等）。 */
    await h.runs.create(h.scope, "r1c-key-queued-event", request());
    const afterReplay = await h.queuedEvent(run.run_id);
    expect(afterReplay?.seq).toBe("1");
  });

  test("get returns the owner's RunView; unknown ids are 404", async () => {
    const created = await h.runs.create(h.scope, "r1c-key-get", request());
    expect(created.latest_seq).toBe("1");
    const view = await h.runs.get(h.scope, created.run_id);
    expect(view.run_id).toBe(created.run_id);
    expect(view.status).toBe("queued");
    expect(view.revision).toBe("0");
    expect(view.latest_seq).toBe("1");
    expect(view.reconciliation_required).toBe(false);
    expect(view.reason_code).toBeNull();

    const missing = await errorOf(() => h.runs.get(h.scope, "r1c-no-such-run"));
    expect(missing.code).toBe("RUN_NOT_FOUND");
  });

  test("command exists as a contract only; the state machine is E2", async () => {
    const run = await h.runs.create(h.scope, "r1c-key-command", request());
    const unavailable = await errorOf(() =>
      h.runs.command(h.scope, run.run_id, {
        command_id: "r1c-cmd-1",
        expected_revision: "0",
        kind: "cancel",
      }),
    );
    expect(unavailable.code).toBe("COMMAND_NOT_AVAILABLE");
    expect(unavailable.status).toBe(503);

    const malformed = await errorOf(() =>
      h.runs.command(h.scope, run.run_id, {
        command_id: "r1c-cmd-2",
        expected_revision: "-1",
        kind: "cancel",
      }),
    );
    expect(malformed.code).toBe("INVALID_RUN_COMMAND");
    expect(malformed.status).toBe(400);
  });

  test("malformed requests are refused before any row is written", async () => {
    const before = await h.count("runs");
    await expect(
      h.runs.create(h.scope, "r1c-key-bad", {
        ...(request() as unknown as Record<string, unknown>),
        tenant_id: "smuggled",
      } as unknown as CreateRun),
    ).rejects.toThrow("INVALID_RUN_INPUT");
    expect(await h.count("runs")).toBe(before);
  });
});
