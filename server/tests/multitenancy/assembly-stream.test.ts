// server/tests/multitenancy/assembly-stream.test.ts
// MT126（Issue #169）：流式与长连接入口的上下文与订阅授权装配。
//
// 真实 PostgreSQL + 受限 ob_ent_* 角色 + 同一 DeploymentEntryContextFactory
// 与 MT025 真实订阅服务上钉死票面四条验收；缺 env 显式 skip、skipped 不
// 计通过：
//   AC1 建连与重连都校验上下文与订阅权限；撤权后连接被终止（探针帧
//      强制重验 → 403 稳定码）；
//   AC2 事件正文 = MT025 白名单闭形（帧正文只有 {type,status,message}）；
//   AC3 长连接不持有数据库事务跨网络等待（事务探针工厂：任何
//      business.transaction 调用即抛——完整建连+开流+投递全程零调用）；
//   AC4 切换范围后旧连接不再推送（旧范围订阅被收旧 → 重连 404 canonical
//      与不存在同形，零帧投递）。
// 判定面：server/src/enterprise/tenancy/assembly-stream.ts + streams.ts。

import { randomUUID } from "node:crypto";
import { like, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { buildInventory } from "../../scripts/multitenancy/inventory";
import { createDatabase, type Database } from "../../src/db/client";
import { users } from "../../src/db/schema/core";
import { enterpriseConversations as conversationsTable } from "../../src/db/schema/enterprise-conversations";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
  enterpriseWorkspaces,
} from "../../src/db/schema/enterprise-tenancy";
import {
  createStreamEntryRoutes,
  STREAM_ENTRY_DISPOSITIONS,
} from "../../src/enterprise/tenancy/assembly-stream";
import {
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import { createDeploymentEntryContextFactory } from "../../src/enterprise/tenancy/entry-context";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";
import {
  createStreamSubscriptionService,
  type StreamEventBody,
} from "../../src/enterprise/tenancy/streams";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseSetupDatabaseVariable,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const required = [
    "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
    "ENTERPRISE_TEST_DATA_DATABASE_URL",
    "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (
    missing.length > 0 ||
    !process.env[enterpriseSetupDatabaseVariable()]?.trim()
  ) {
    return {
      ok: false,
      reason: `MT126 requires ${enterpriseSetupDatabaseVariable()} and the directory/data/operator role URLs (dedicated openbot_enterprise_* test database) — no dev-database fallback`,
    };
  }
  return { ok: true };
}

const ENV = probeEnvironment();
const itDb = ((
  name: string,
  fn: () => void | Promise<void>,
  timeout?: number,
) =>
  ENV.ok
    ? test(name, fn, timeout)
    : test.skip(
        `${name} [skipped: ${ENV.reason}]`,
        fn,
        timeout,
      )) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

type Identity = "a-member" | "b-member";

let setup: Database;
let data: DataDatabase;
let directory: DirectoryDatabase;
let operator: OperatorDatabase;
let runTag = "";
const ids: Record<string, string> = {};
let app: Hono;
/** 测试驱动的事件端口（真实投递路径：开流前预置事件即被投递）。 */
let pendingEvents: StreamEventBody[] = [];
/** 事件端口钩子：下一次取事件前执行一次（mid-stream 撤权的驱动器）。 */
let beforeNextEvent: (() => Promise<void>) | null = null;
/** fix2 回归钩子：取事件调用计数；置位时下一次取事件阻塞在该门上。 */
let portCalls = 0;
let nextGate: PromiseWithResolvers<StreamEventBody | null> | null = null;
/** fix2 回归钩子：pushEvent 调用计数（探针含在内）。 */
let pushCount = 0;
/** AC3 事务探针：装配层若调用 business.transaction 即置位并抛出。 */
let assemblyOpenedTransaction = false;

beforeAll(async () => {
  if (!ENV.ok) return;
  setup = createDatabase(enterpriseTestDatabaseUrlFrom(process.env), {
    max: 8,
  });
  data = (await verifyDataDatabase(
    createDatabase(enterpriseRuntimeDatabaseUrlFrom("data", process.env), {
      max: 1,
    }),
  )) as DataDatabase;
  directory = (await verifyDirectoryDatabase(
    createDatabase(enterpriseRuntimeDatabaseUrlFrom("directory", process.env), {
      max: 1,
    }),
  )) as DirectoryDatabase;
  operator = (await verifyOperatorDatabase(
    createDatabase(enterpriseRuntimeDatabaseUrlFrom("operator", process.env), {
      max: 1,
    }),
  )) as OperatorDatabase;

  runTag = `mt126-${randomUUID().slice(0, 8)}`;
  for (const key of [
    "company-a",
    "company-b",
    "team-a1",
    "team-a2",
    "team-b1",
  ]) {
    ids[key] = `${runTag}-${key}`;
  }
  for (const identity of ["a-member", "b-member"] as const) {
    ids[`user-${identity}`] = `${runTag}-user-${identity}`;
    ids[`principal-${identity}`] = `${runTag}-principal-${identity}`;
  }

  await setup.insert(users).values(
    (["a-member", "b-member"] as const).map((identity) => ({
      id: ids[`user-${identity}`],
      email: `${runTag}-${identity}@mt126.test`,
    })),
  );
  await setup.insert(enterprisePrincipals).values(
    (["a-member", "b-member"] as const).map((identity) => ({
      id: ids[`principal-${identity}`],
      userId: ids[`user-${identity}`],
    })),
  );
  await setup.insert(enterpriseTenants).values([
    { id: ids["company-a"], name: "MT126 Company A" },
    { id: ids["company-b"], name: "MT126 Company B" },
  ]);
  await setup.insert(enterpriseWorkspaces).values([
    { tenantId: ids["company-a"], id: ids["team-a1"], name: "MT126 A1" },
    { tenantId: ids["company-a"], id: ids["team-a2"], name: "MT126 A2" },
    { tenantId: ids["company-b"], id: ids["team-b1"], name: "MT126 B1" },
  ]);
  // a-member 同时在 A1/A2（切换范围的事实底座）；b-member 在 B1。
  await setup.insert(enterpriseMemberships).values([
    {
      tenantId: ids["company-a"],
      principalId: ids["principal-a-member"],
      role: "member",
    },
    {
      tenantId: ids["company-b"],
      principalId: ids["principal-b-member"],
      role: "member",
    },
  ]);
  await setup.insert(enterpriseWorkspaceMemberships).values([
    {
      tenantId: ids["company-a"],
      workspaceId: ids["team-a1"],
      principalId: ids["principal-a-member"],
    },
    {
      tenantId: ids["company-a"],
      workspaceId: ids["team-a2"],
      principalId: ids["principal-a-member"],
    },
    {
      tenantId: ids["company-b"],
      workspaceId: ids["team-b1"],
      principalId: ids["principal-b-member"],
    },
  ]);

  // 会话事实（开订阅的目标会话可见门）。
  await setup.insert(conversationsTable).values([
    {
      tenantId: ids["company-a"],
      workspaceId: ids["team-a1"],
      principalId: ids["principal-a-member"],
      threadId: `${runTag}-thread-a1`,
      title: "MT126 A1 thread",
      storageBackend: "platform",
    },
    {
      tenantId: ids["company-a"],
      workspaceId: ids["team-a2"],
      principalId: ids["principal-a-member"],
      threadId: `${runTag}-thread-a2`,
      title: "MT126 A2 thread",
      storageBackend: "platform",
    },
    {
      tenantId: ids["company-b"],
      workspaceId: ids["team-b1"],
      principalId: ids["principal-b-member"],
      threadId: `${runTag}-thread-b1`,
      title: "MT126 B1 thread",
      storageBackend: "platform",
    },
  ]);

  const authenticate = async (request: Request) => {
    const identity = request.headers.get("x-mt126-identity");
    if (!identity || !["a-member", "b-member"].includes(identity)) return null;
    return { actorId: ids[`user-${identity}`], entrypoint: "web" as const };
  };
  // AC3 探针工厂：真实工厂的业务面 + 会抛的事务半边（装配层任何
  // business.transaction 调用都被点名）。
  const realFactory = createDeploymentEntryContextFactory({
    directory,
    data,
    authenticate,
  });
  const probingFactory = {
    fromRequest: async (request: Request) => {
      const business = await realFactory.fromRequest(request);
      return {
        ...business,
        transaction: (() => {
          assemblyOpenedTransaction = true;
          throw new Error(
            "MT126_ASSEMBLY_OPENED_TRANSACTION: the stream entry must not hold a business transaction",
          );
        }) as typeof business.transaction,
      };
    },
  };
  void createScopeResolver; // resolver 由工厂内部共享（同一 authenticate 闭包）。

  const service = createStreamSubscriptionService({ data, operator });
  // fix2 回归面：端口与推送各带一个计数器（其余语义零变化）。
  const countingService = {
    ...service,
    pushEvent: ((
      scope: never,
      subscriptionId: string,
      body: StreamEventBody,
    ) => {
      pushCount += 1;
      return service.pushEvent(scope, subscriptionId, body);
    }) as typeof service.pushEvent,
  };
  app = new Hono().route(
    "/api/enterprise/streams",
    createStreamEntryRoutes({
      factory: probingFactory,
      service: countingService,
      events: {
        nextEvent: async () => {
          portCalls += 1;
          if (beforeNextEvent) {
            const hook = beforeNextEvent;
            beforeNextEvent = null;
            await hook();
          }
          if (nextGate) {
            const gate = nextGate;
            nextGate = null;
            return gate.promise;
          }
          return pendingEvents.shift() ?? null;
        },
      },
    }),
  );
});

afterAll(async () => {
  if (!setup) return;
  await setup.execute(
    sql`delete from enterprise_resource_grants where tenant_id like ${`${runTag}%`}`,
  );
  await setup.execute(
    sql`delete from enterprise_resources where tenant_id like ${`${runTag}%`}`,
  );
  await setup
    .delete(conversationsTable)
    .where(like(conversationsTable.tenantId, `${runTag}%`));
  await setup
    .delete(enterpriseWorkspaceMemberships)
    .where(like(enterpriseWorkspaceMemberships.tenantId, `${runTag}%`));
  await setup
    .delete(enterpriseMemberships)
    .where(like(enterpriseMemberships.tenantId, `${runTag}%`));
  await setup
    .delete(enterpriseWorkspaces)
    .where(like(enterpriseWorkspaces.tenantId, `${runTag}%`));
  await setup
    .delete(enterpriseTenants)
    .where(like(enterpriseTenants.id, `${runTag}%`));
  await setup
    .delete(enterprisePrincipals)
    .where(like(enterprisePrincipals.id, `${runTag}%`));
  await setup.delete(users).where(like(users.id, `${runTag}%`));
  await Promise.all([
    data?.$client.close(),
    directory?.$client.close(),
    operator?.$client.close(),
    setup.$client.close(),
  ]);
});

function requestAs(input: {
  method: string;
  path: string;
  session?: Identity;
  tenantId?: string;
  workspaceId?: string;
}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (input.session) headers["x-mt126-identity"] = input.session;
  if (input.tenantId !== undefined)
    headers["x-openbot-tenant"] = input.tenantId;
  if (input.workspaceId !== undefined)
    headers["x-openbot-workspace"] = input.workspaceId;
  return app.request(input.path, { method: input.method, headers });
}

/** 建连（真实判定面）→ 订阅 id。 */
async function openSubscription(
  session: Identity,
  tenantKey: "company-a" | "company-b",
  workspaceKey: "team-a1" | "team-a2" | "team-b1",
  threadId: string,
): Promise<string> {
  const response = await requestAs({
    method: "POST",
    path: `/api/enterprise/streams/${threadId}/subscription`,
    session,
    tenantId: ids[tenantKey],
    workspaceId: ids[workspaceKey],
  });
  if (response.status !== 201) {
    throw new Error(
      `MT126 fixture: subscription open failed (${response.status}): ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { subscription_id: string };
  return body.subscription_id;
}

describeDb("MT126 stream entry assembly (Issue #169)", () => {
  // ---- AC1：建连与重连都校验当前上下文与订阅权限 ----
  describeDb(
    "AC1 connect and reconnect both validate context and subscription",
    () => {
      itDb(
        "connect without a session → 401 (no deployment default)",
        async () => {
          const response = await requestAs({
            method: "POST",
            path: `/api/enterprise/streams/${runTag}-thread-a1/subscription`,
            tenantId: ids["company-a"],
            workspaceId: ids["team-a1"],
          });
          expect(response.status).toBe(401);
          expect(await response.json()).toEqual({
            error: { code: "unauthenticated", message: "AUTH_REQUIRED" },
          });
        },
      );

      itDb(
        "connect without tenant selection → 400 TENANT_REQUIRED",
        async () => {
          const response = await requestAs({
            method: "POST",
            path: `/api/enterprise/streams/${runTag}-thread-a1/subscription`,
            session: "a-member",
            workspaceId: ids["team-a1"],
          });
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({
            error: { code: "invalid_request", message: "TENANT_REQUIRED" },
          });
        },
      );

      itDb(
        "a foreign company's thread is invisible, same shape as missing",
        async () => {
          const foreign = await requestAs({
            method: "POST",
            path: `/api/enterprise/streams/${runTag}-thread-b1/subscription`,
            session: "a-member",
            tenantId: ids["company-a"],
            workspaceId: ids["team-a1"],
          });
          const missing = await requestAs({
            method: "POST",
            path: `/api/enterprise/streams/${runTag}-no-such-thread/subscription`,
            session: "a-member",
            tenantId: ids["company-a"],
            workspaceId: ids["team-a1"],
          });
          expect(foreign.status).toBe(404);
          expect(foreign.status).toBe(missing.status);
          expect(await foreign.json()).toEqual(await missing.json());
        },
      );

      itDb(
        "reconnect re-validates: a foreign scope's SSE is 404 canonical",
        async () => {
          const subscriptionId = await openSubscription(
            "a-member",
            "company-a",
            "team-a1",
            `${runTag}-thread-a1`,
          );
          const foreign = await requestAs({
            method: "GET",
            path: `/api/enterprise/streams/subscriptions/${subscriptionId}/events`,
            session: "b-member",
            tenantId: ids["company-b"],
            workspaceId: ids["team-b1"],
          });
          expect(foreign.status).toBe(404);
          expect(await foreign.json()).toEqual({
            error: { code: "not_found", message: "RESOURCE_NOT_FOUND" },
          });
        },
      );

      itDb(
        "revocation terminates the connection mid-stream (closed stops all further frames)",
        async () => {
          const subscriptionId = await openSubscription(
            "a-member",
            "company-a",
            "team-a1",
            `${runTag}-thread-a1`,
          );
          const suspend = sql`
        update enterprise_memberships
        set status = 'suspended', epoch = epoch + 1
        where tenant_id = ${ids["company-a"]} and principal_id = ${ids["principal-a-member"]}
      `;
          const restore = sql`
        update enterprise_memberships
        set status = 'active', epoch = epoch + 1
        where tenant_id = ${ids["company-a"]} and principal_id = ${ids["principal-a-member"]}
      `;
          // 首帧（探针）已投递后，在取下一个事件前撤权——下一次判定必须
          // closed：流终止，事件不投递（撤权后连接被终止的流上半边）。
          beforeNextEvent = async () => {
            await setup.execute(suspend);
          };
          pendingEvents = [
            {
              type: "message",
              status: "ok",
              message: "must not deliver after revocation",
            },
          ];
          try {
            const response = await requestAs({
              method: "GET",
              path: `/api/enterprise/streams/subscriptions/${subscriptionId}/events`,
              session: "a-member",
              tenantId: ids["company-a"],
              workspaceId: ids["team-a1"],
            });
            expect(response.status).toBe(200);
            const text = await response.text();
            const frames = text
              .split("\n\n")
              .filter((frame) => frame.length > 0)
              .map((frame) =>
                JSON.parse(frame.replace("event: message\ndata: ", "")),
              );
            // 只有探针帧；撤权后的事件被 closed 终止，不投递。
            expect(frames).toEqual([
              { type: "status", status: "ok", message: "connected" },
            ]);
          } finally {
            await setup.execute(restore);
          }
        },
      );

      itDb(
        "a revoked member cannot even reconnect (establishment refuses)",
        async () => {
          const suspend = sql`
        update enterprise_memberships
        set status = 'suspended', epoch = epoch + 1
        where tenant_id = ${ids["company-a"]} and principal_id = ${ids["principal-a-member"]}
      `;
          const restore = sql`
        update enterprise_memberships
        set status = 'active', epoch = epoch + 1
        where tenant_id = ${ids["company-a"]} and principal_id = ${ids["principal-a-member"]}
      `;
          await setup.execute(suspend);
          try {
            const response = await requestAs({
              method: "GET",
              path: `/api/enterprise/streams/subscriptions/sub-does-not-matter/events`,
              session: "a-member",
              tenantId: ids["company-a"],
              workspaceId: ids["team-a1"],
            });
            expect(response.status).toBe(403);
            const body = (await response.json()) as {
              error: { code: string; message: string };
            };
            expect(body.error.message).toBe("TENANT_FORBIDDEN");
          } finally {
            await setup.execute(restore);
          }
        },
      );
    },
  );

  // ---- AC2/AC3：正文白名单 + 零跨网络事务 ----
  describeDb(
    "AC2+AC3 frames are the whitelist shape; no transaction crosses the network wait",
    () => {
      itDb(
        "the stream delivers the probe and queued events, whitelist-only bodies",
        async () => {
          const subscriptionId = await openSubscription(
            "a-member",
            "company-a",
            "team-a1",
            `${runTag}-thread-a1`,
          );
          pendingEvents = [
            { type: "message", status: "ok", message: "hello from mt126" },
          ];
          const response = await requestAs({
            method: "GET",
            path: `/api/enterprise/streams/subscriptions/${subscriptionId}/events`,
            session: "a-member",
            tenantId: ids["company-a"],
            workspaceId: ids["team-a1"],
          });
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toContain(
            "text/event-stream",
          );
          const text = await response.text();
          const frames = text
            .split("\n\n")
            .filter((frame) => frame.length > 0)
            .map((frame) =>
              JSON.parse(frame.replace("event: message\ndata: ", "")),
            );
          // 探针帧 + 预置事件帧；正文键恰好白名单三键。
          expect(frames).toHaveLength(2);
          expect(frames[0]).toEqual({
            type: "status",
            status: "ok",
            message: "connected",
          });
          expect(frames[1]).toEqual({
            type: "message",
            status: "ok",
            message: "hello from mt126",
          });
          for (const frame of frames) {
            expect(Object.keys(frame).sort()).toEqual([
              "message",
              "status",
              "type",
            ]);
          }
          // AC3：完整建连+开流+投递全程，装配层零 business.transaction。
          expect(assemblyOpenedTransaction).toBe(false);
        },
      );
    },
  );

  // ---- AC4：切换范围后旧连接不再推送 ----
  describeDb("AC4 switching scope stops the old connection", () => {
    itDb(
      "after switching to A2, the A1 subscription no longer streams (canonical 404, zero frames)",
      async () => {
        const oldSubscription = await openSubscription(
          "a-member",
          "company-a",
          "team-a1",
          `${runTag}-thread-a1`,
        );
        // 切换范围：在 A2 开新订阅（MT025 收旧——A1 的活跃订阅被关闭）。
        await openSubscription(
          "a-member",
          "company-a",
          "team-a2",
          `${runTag}-thread-a2`,
        );
        pendingEvents = [
          { type: "message", status: "ok", message: "must not deliver" },
        ];
        const response = await requestAs({
          method: "GET",
          path: `/api/enterprise/streams/subscriptions/${oldSubscription}/events`,
          session: "a-member",
          tenantId: ids["company-a"],
          workspaceId: ids["team-a1"],
        });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
          error: { code: "not_found", message: "RESOURCE_NOT_FOUND" },
        });
        // 预置事件未被投递（连接未开流）。
        expect(pendingEvents).toHaveLength(1);
        pendingEvents = [];
      },
    );

    itDb(
      "cancel terminates the subscription for later reconnects",
      async () => {
        const subscriptionId = await openSubscription(
          "a-member",
          "company-a",
          "team-a1",
          `${runTag}-thread-a1`,
        );
        const cancel = await requestAs({
          method: "DELETE",
          path: `/api/enterprise/streams/subscriptions/${subscriptionId}`,
          session: "a-member",
          tenantId: ids["company-a"],
          workspaceId: ids["team-a1"],
        });
        expect(cancel.status).toBe(200);
        const after = await requestAs({
          method: "GET",
          path: `/api/enterprise/streams/subscriptions/${subscriptionId}/events`,
          session: "a-member",
          tenantId: ids["company-a"],
          workspaceId: ids["team-a1"],
        });
        expect(after.status).toBe(404);
      },
    );
  });

  // ---- fix2：客户端取消与背压（MT126 SSE 长连接的回归面） ----
  describeDb(
    "client cancellation and backpressure release the SSE loop",
    () => {
      itDb(
        "a departed client releases the loop; a late event is never revalidated or delivered",
        async () => {
          const subscriptionId = await openSubscription(
            "a-member",
            "company-a",
            "team-a1",
            `${runTag}-thread-a1`,
          );
          portCalls = 0;
          pushCount = 0;
          // 取事件阻塞在门上：模拟「静默订阅」——客户端离开时没有任何在途事件。
          const gate = Promise.withResolvers<StreamEventBody | null>();
          nextGate = gate;
          try {
            const response = await requestAs({
              method: "GET",
              path: `/api/enterprise/streams/subscriptions/${subscriptionId}/events`,
              session: "a-member",
              tenantId: ids["company-a"],
              workspaceId: ids["team-a1"],
            });
            expect(response.status).toBe(200);
            expect(pushCount).toBe(1); // 探针帧的一次判定
            const reader = response.body!.getReader();
            const probe = await reader.read();
            expect(probe.value).toBeDefined(); // 探针帧可读
            // 探针帧被读走后，循环进入对下一事件的等待（阻塞在门上）。
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(portCalls).toBe(1);
            // 客户端离开（取消读端）；此刻没有任何在途事件可唤醒循环。
            await reader.cancel();
            // 事件在取消之后才迟到——迟到的正文绝不再过判定面、绝不再投递。
            gate.resolve({
              type: "message",
              status: "ok",
              message: "late event after departure",
            });
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect(pushCount).toBe(1); // 只有探针；迟到事件零判定
          } finally {
            nextGate = null;
          }
        },
        10_000,
      );

      itDb(
        "a full consumer queue pauses the pull (desiredSize backpressure), reading resumes it",
        async () => {
          const subscriptionId = await openSubscription(
            "a-member",
            "company-a",
            "team-a1",
            `${runTag}-thread-a1`,
          );
          portCalls = 0;
          pushCount = 0;
          pendingEvents = [
            { type: "message", status: "ok", message: "queued behind probe" },
          ];
          const response = await requestAs({
            method: "GET",
            path: `/api/enterprise/streams/subscriptions/${subscriptionId}/events`,
            session: "a-member",
            tenantId: ids["company-a"],
            workspaceId: ids["team-a1"],
          });
          expect(response.status).toBe(200);
          // 消费端一字未读：探针帧仍在队列里（desiredSize ≤ 0），循环不得
          // 拉取下一个事件把队列越堆越深。
          await new Promise((resolve) => setTimeout(resolve, 150));
          expect(portCalls).toBe(0);
          // 读走探针帧 → 队列腾出 → 循环恢复拉取并投递预置事件。
          const reader = response.body!.getReader();
          const probe = await reader.read();
          expect(probe.value).toBeDefined();
          const queued = await reader.read();
          expect(queued.value).toBeDefined();
          expect(portCalls).toBeGreaterThanOrEqual(1);
          await reader.cancel();
        },
        10_000,
      );
    },
  );
});

// ---- 处置表（静态事实 + buildInventory 回写） ----
describe("MT126 stream entrance dispositions (Issue #169)", () => {
  test("the disposition table is internally coherent", () => {
    const entranceIds = STREAM_ENTRY_DISPOSITIONS.map((row) => row.entrance);
    expect(new Set(entranceIds).size).toBe(entranceIds.length);
    for (const row of STREAM_ENTRY_DISPOSITIONS) {
      expect(row.ownerTicket).toBe("MT126");
      if (row.establishment === "registered-exception") {
        expect(row.reason?.trim()).toBeTruthy();
      }
    }
    const unified = STREAM_ENTRY_DISPOSITIONS.filter(
      (row) => row.establishment === "unified-entry-context",
    ).map((row) => row.entrance);
    expect(unified).toEqual([
      "POST /api/enterprise/streams/:threadId/subscription",
      "GET /api/enterprise/streams/subscriptions/:subscriptionId/events",
      "DELETE /api/enterprise/streams/subscriptions/:subscriptionId",
    ]);
  });

  test("buildInventory stamps every stream disposition entrance as owned", async () => {
    const inventory = await buildInventory({
      environment: {
        DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
      },
    });
    for (const row of STREAM_ENTRY_DISPOSITIONS) {
      const entrance = inventory.entrances.find(
        (entry) => entry.id === row.entrance,
      );
      expect(
        entrance,
        `entrance ${row.entrance} must exist in the inventory`,
      ).toBeDefined();
      expect(entrance?.ownerTicket).toBe("MT126");
      expect(entrance?.status).toBe("owned");
    }
    // 清单登记的全部 stream 型入口都被处置（零未处置流式入口）。
    const dispositioned = new Set(
      STREAM_ENTRY_DISPOSITIONS.map((row) => row.entrance),
    );
    const undispositioned = inventory.entrances
      .filter((entry) => entry.type === "stream")
      .filter((entry) => !dispositioned.has(entry.id))
      .map((entry) => entry.id);
    expect(undispositioned).toEqual([]);
  });
});
