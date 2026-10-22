// server/tests/multitenancy/assembly-legacy.test.ts
// MT125（Issue #168）：旧 REST、Copilot 与移动聚合入口装配与兼容。
//
// 真实 PostgreSQL + 受限 ob_ent_* 角色 + 同一 DeploymentEntryContextFactory
// 与 MT066 真实聚合服务上钉死票面四条验收；缺 env 显式 skip、skipped 不
// 计通过：
//   AC1 逐入口：统一聚合入口对无权范围返回不可见语义（401/400/403/
//      跨范围子集合为空），不依赖部署级默认（工厂建立期拒绝）；
//   AC2 兼容：守卫开/关对既有入口同请求同响应（逐字节）；聚合 DTO =
//      MT066 白名单形状原样；
//   AC3 显式关闭不留隐式放行：closed 处置 → 503 稳定码；例外必带理由；
//   AC4 处置结果回写清单：三族入口全部 owned=MT125，未分类入口为零。
// 判定面：server/src/enterprise/tenancy/assembly-legacy.ts（装配 + 守卫 +
// LEGACY_ENTRY_DISPOSITIONS）与 scripts/multitenancy/inventory.ts 回写。

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
import { channels } from "../../src/db/schema";
import { users } from "../../src/db/schema/core";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
  enterpriseWorkspaces,
} from "../../src/db/schema/enterprise-tenancy";
import {
  createLegacyEntryGuard,
  createMobileAggregationEntryRoutes,
  LEGACY_ENTRANCE_CLOSED,
  LEGACY_ENTRY_DISPOSITIONS,
} from "../../src/enterprise/tenancy/assembly-legacy";
import {
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import { createDeploymentEntryContextFactory } from "../../src/enterprise/tenancy/entry-context";
import { createOpenMuseVoiceMobileTenancyService } from "../../src/enterprise/tenancy/openmuse-voice-mobile-tenancy";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseSetupDatabaseVariable,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";

/** 环境探针：调用方据此显式 skip（缺 env 绝不回退开发库）。 */
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
      reason: `MT125 requires ${enterpriseSetupDatabaseVariable()} and the directory/data/operator role URLs (dedicated openbot_enterprise_* test database) — no dev-database fallback`,
    };
  }
  return { ok: true };
}

const ENV = probeEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

const NO_DATABASE: Record<string, string | undefined> = {
  DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
};

type Identity = "a-member" | "b-member";

let setup: Database;
let data: DataDatabase;
let directory: DirectoryDatabase;
let operator: OperatorDatabase;
let runTag = "";
const ids: Record<string, string> = {};
let app: Hono;

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

  runTag = `mt125-${randomUUID().slice(0, 8)}`;
  for (const key of ["company-a", "company-b", "team-a1", "team-b1"]) {
    ids[key] = `${runTag}-${key}`;
  }
  const identities: readonly Identity[] = ["a-member", "b-member"];
  for (const identity of identities) {
    ids[`user-${identity}`] = `${runTag}-user-${identity}`;
    ids[`principal-${identity}`] = `${runTag}-principal-${identity}`;
  }
  const tenantOf = (identity: Identity) =>
    identity === "a-member" ? ids["company-a"] : ids["company-b"];
  const workspaceOf = (identity: Identity) =>
    identity === "a-member" ? ids["team-a1"] : ids["team-b1"];

  await setup.insert(users).values(
    identities.map((identity) => ({
      id: ids[`user-${identity}`],
      email: `${runTag}-${identity}@mt125.test`,
    })),
  );
  await setup.insert(enterprisePrincipals).values(
    identities.map((identity) => ({
      id: ids[`principal-${identity}`],
      userId: ids[`user-${identity}`],
    })),
  );
  await setup.insert(enterpriseTenants).values([
    { id: ids["company-a"], name: "MT125 Company A" },
    { id: ids["company-b"], name: "MT125 Company B" },
  ]);
  await setup.insert(enterpriseWorkspaces).values([
    { tenantId: ids["company-a"], id: ids["team-a1"], name: "MT125 A1" },
    { tenantId: ids["company-b"], id: ids["team-b1"], name: "MT125 B1" },
  ]);
  await setup.insert(enterpriseMemberships).values(
    identities.map((identity) => ({
      tenantId: tenantOf(identity),
      principalId: ids[`principal-${identity}`],
      role: "member",
    })),
  );
  await setup.insert(enterpriseWorkspaceMemberships).values(
    identities.map((identity) => ({
      tenantId: tenantOf(identity),
      workspaceId: workspaceOf(identity),
      principalId: ids[`principal-${identity}`],
    })),
  );

  // 语音会话根行 + 归属 pin（真实 MT066 服务写协会行——聚合读取的事实底座）。
  ids["channel-a"] = `${runTag}-channel-a`;
  ids["channel-b"] = `${runTag}-channel-b`;
  await setup.insert(channels).values([
    { id: ids["channel-a"], name: "MT125 Channel A", description: "mt125" },
    { id: ids["channel-b"], name: "MT125 Channel B", description: "mt125" },
  ]);
  await setup.execute(sql`
    insert into voice_sessions (id, channel_id, user_id, started_at, ended_at, duration_seconds, transcript)
    values
      (${`${runTag}-voice-a`}, ${ids["channel-a"]}, ${ids["user-a-member"]}, now(), now(), 61, '{"entries": []}'::jsonb),
      (${`${runTag}-voice-b`}, ${ids["channel-b"]}, ${ids["user-b-member"]}, now(), now(), 37, '{"entries": []}'::jsonb)
    on conflict (id) do nothing
  `);

  const authenticate = async (request: Request) => {
    const identity = request.headers.get("x-mt125-identity");
    if (!identity || !identities.includes(identity as Identity)) return null;
    return { actorId: ids[`user-${identity}`], entrypoint: "web" as const };
  };
  const factory = createDeploymentEntryContextFactory({
    directory,
    data,
    authenticate,
  });
  const resolver = createScopeResolver(directory, {
    data,
    authenticate,
    selectTenant: (request) => request.headers.get("x-openbot-tenant"),
    selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
  });

  const rows = {
    async findOwnedSession(ownerUserId: string, sessionId: string) {
      const found = (await setup.execute(sql`
        select id, channel_id, started_at, ended_at, duration_seconds
        from voice_sessions where id = ${sessionId} and user_id = ${ownerUserId} limit 1
      `)) as unknown as {
        id: string;
        channel_id: string;
        started_at: Date;
        ended_at: Date;
        duration_seconds: number;
      }[];
      const row = found[0];
      return row
        ? {
            id: row.id,
            channelId: row.channel_id,
            startedAt: row.started_at,
            endedAt: row.ended_at,
            durationSeconds: row.duration_seconds,
          }
        : null;
    },
    async listSessionsByIds(
      ownerUserId: string,
      sessionIds: readonly string[],
    ) {
      if (sessionIds.length === 0) return [];
      const found = (await setup.execute(sql`
        select id, channel_id, started_at, ended_at, duration_seconds
        from voice_sessions where user_id = ${ownerUserId}
      `)) as unknown as {
        id: string;
        channel_id: string;
        started_at: Date;
        ended_at: Date;
        duration_seconds: number;
      }[];
      return found
        .filter((row) => (sessionIds as readonly string[]).includes(row.id))
        .map((row) => ({
          id: row.id,
          channelId: row.channel_id,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          durationSeconds: row.duration_seconds,
        }));
    },
    async findOwnedDevice() {
      return null;
    },
  };
  const service = createOpenMuseVoiceMobileTenancyService({
    data,
    operator,
    rows,
  });

  // 归属 pin：各自公司的会话各自钉（真实服务调用，非直插协会行）。
  const scopeA = await resolver.resolve(
    new Request("https://mt125.test/pin", {
      headers: {
        "x-mt125-identity": "a-member",
        "x-openbot-tenant": ids["company-a"],
        "x-openbot-workspace": ids["team-a1"],
      },
    }),
  );
  const scopeB = await resolver.resolve(
    new Request("https://mt125.test/pin", {
      headers: {
        "x-mt125-identity": "b-member",
        "x-openbot-tenant": ids["company-b"],
        "x-openbot-workspace": ids["team-b1"],
      },
    }),
  );
  const pinA = await service.pinVoiceSessionScope(scopeA, {
    sessionId: `${runTag}-voice-a`,
  });
  const pinB = await service.pinVoiceSessionScope(scopeB, {
    sessionId: `${runTag}-voice-b`,
  });
  if (pinA.status === "deny" || pinB.status === "deny") {
    throw new Error("MT125 fixture: voice session pin refused");
  }

  app = new Hono().route(
    "/api/mobile",
    createMobileAggregationEntryRoutes({ factory, service }),
  );
});

afterAll(async () => {
  if (!setup) return;
  await setup.execute(
    sql`delete from voice_session_scopes where session_id like ${`${runTag}%`}`,
  );
  await setup.execute(
    sql`delete from voice_sessions where id like ${`${runTag}%`}`,
  );
  await setup.delete(channels).where(like(channels.id, `${runTag}%`));
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
  if (input.session) headers["x-mt125-identity"] = input.session;
  if (input.tenantId !== undefined)
    headers["x-openbot-tenant"] = input.tenantId;
  if (input.workspaceId !== undefined)
    headers["x-openbot-workspace"] = input.workspaceId;
  return app.request(input.path, { method: input.method, headers });
}

describeDb("MT125 legacy entry assembly (Issue #168)", () => {
  // ---- AC1：逐入口不可见语义，不依赖部署级默认 ----
  describeDb(
    "AC1 the aggregate entrance refuses without a scope and filters by it",
    () => {
      itDb(
        "no session → 401 unauthenticated (no deployment default)",
        async () => {
          const response = await requestAs({
            method: "GET",
            path: "/api/mobile/openmuse-aggregate",
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
        "session without tenant selection → 400 TENANT_REQUIRED",
        async () => {
          const response = await requestAs({
            method: "GET",
            path: "/api/mobile/openmuse-aggregate",
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
        "tenant without workspace selection → 400 WORKSPACE_REQUIRED",
        async () => {
          const response = await requestAs({
            method: "GET",
            path: "/api/mobile/openmuse-aggregate",
            session: "a-member",
            tenantId: ids["company-a"],
          });
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({
            error: { code: "invalid_request", message: "WORKSPACE_REQUIRED" },
          });
        },
      );

      itDb(
        "selecting a company the session does not belong to → 403",
        async () => {
          const response = await requestAs({
            method: "GET",
            path: "/api/mobile/openmuse-aggregate",
            session: "a-member",
            tenantId: ids["company-b"],
            workspaceId: ids["team-b1"],
          });
          expect(response.status).toBe(403);
        },
      );

      itDb(
        "valid scope sees only its own in-scope aggregate (foreign invisible)",
        async () => {
          const response = await requestAs({
            method: "GET",
            path: "/api/mobile/openmuse-aggregate",
            session: "a-member",
            tenantId: ids["company-a"],
            workspaceId: ids["team-a1"],
          });
          expect(response.status).toBe(200);
          const aggregate = (await response.json()) as {
            voiceSessions: {
              ownership: { sessionId: string };
              session: { id: string };
            }[];
            dictationUsage: unknown[];
            pushDevices: unknown[];
          };
          // MT066 的协会门：只有本三元组钉过的会话进入聚合。
          expect(aggregate.voiceSessions).toHaveLength(1);
          expect(aggregate.voiceSessions[0]?.ownership.sessionId).toBe(
            `${runTag}-voice-a`,
          );
          expect(aggregate.dictationUsage).toEqual([]);
          expect(aggregate.pushDevices).toEqual([]);
        },
      );
    },
  );

  // ---- AC2：兼容（守卫开/关逐字节同响应；DTO 白名单形状） ----
  describeDb(
    "AC2 compatibility: guard on/off is byte-for-byte identical",
    () => {
      test("registered-exception entrances pass the guard unchanged", async () => {
        // 家族入口的代表：守卫开/关对同一请求同响应（例外放行不改字节）。
        const legacyApp = new Hono();
        legacyApp.get("/workspace", (context) =>
          context.json({ ok: true, entrance: "GET /api/mobile/workspace" }),
        );
        const guarded = new Hono();
        guarded.use(createLegacyEntryGuard());
        guarded.route("/", legacyApp);
        const plain = new Hono().route("/", legacyApp);
        const withGuard = await guarded.request("/workspace");
        const without = await plain.request("/workspace");
        expect(withGuard.status).toBe(without.status);
        expect(await withGuard.text()).toBe(await without.text());
      });

      test("the aggregate DTO is exactly the MT066 whitelist shape", async () => {
        const response = await requestAs({
          method: "GET",
          path: "/api/mobile/openmuse-aggregate",
          session: "a-member",
          tenantId: ids["company-a"],
          workspaceId: ids["team-a1"],
        });
        const aggregate = (await response.json()) as Record<string, unknown>;
        expect(Object.keys(aggregate).sort()).toEqual([
          "dictationUsage",
          "pushDevices",
          "voiceSessions",
        ]);
      });
    },
  );

  // ---- AC3：显式关闭不留隐式放行 ----
  describeDb(
    "AC3 explicitly closed entrances answer 503, exceptions carry reasons",
    () => {
      test("a closed disposition refuses with the stable code and its reason", async () => {
        const guard = createLegacyEntryGuard([
          {
            entrance: "GET /api/mobile/legacy-probe",
            family: "mobile-aggregation",
            establishment: "explicitly-closed",
            reason: "mt125 test closure — the entrance cannot isolate yet",
            ownerTicket: "MT125",
          },
        ]);
        const probeApp = new Hono();
        probeApp.use(guard);
        probeApp.get("/api/mobile/legacy-probe", (context) =>
          context.json({ leaked: true }),
        );
        const response = await probeApp.request("/api/mobile/legacy-probe");
        expect(response.status).toBe(503);
        const body = (await response.json()) as {
          error: { code: string; message: string };
        };
        expect(body.error.code).toBe(LEGACY_ENTRANCE_CLOSED);
        expect(body.error.message).toContain("mt125 test closure");
        // 参数路径也命中（:param 段通配）。
        const paramGuard = createLegacyEntryGuard([
          {
            entrance: "GET /api/mobile/legacy/:id",
            family: "mobile-aggregation",
            establishment: "explicitly-closed",
            reason: "mt125 test closure",
            ownerTicket: "MT125",
          },
        ]);
        const paramApp = new Hono();
        paramApp.use(paramGuard);
        paramApp.get("/api/mobile/legacy/:id", (context) =>
          context.json({ leaked: true }),
        );
        const paramResponse = await paramApp.request("/api/mobile/legacy/42");
        expect(paramResponse.status).toBe(503);
      });

      test("the disposition table is internally coherent (no implicit pass)", () => {
        const entranceIds = LEGACY_ENTRY_DISPOSITIONS.map(
          (row) => row.entrance,
        );
        expect(new Set(entranceIds).size).toBe(entranceIds.length);
        for (const row of LEGACY_ENTRY_DISPOSITIONS) {
          expect(row.ownerTicket).toBe("MT125");
          if (row.establishment !== "unified-entry-context") {
            // 例外与关闭必须带非空理由（无理由的例外 = 隐式放行）。
            expect(row.reason?.trim()).toBeTruthy();
          }
        }
        const unified = LEGACY_ENTRY_DISPOSITIONS.filter(
          (row) => row.establishment === "unified-entry-context",
        );
        expect(unified.map((row) => row.entrance)).toEqual([
          "GET /api/mobile/openmuse-aggregate",
        ]);
      });
    },
  );
});

// ---- AC4：处置结果回写清单，未分类入口为零（静态事实 + buildInventory） ----
describe("MT125 entrance dispositions and inventory (Issue #168 AC4)", () => {
  test("buildInventory stamps every legacy disposition entrance as owned", async () => {
    const inventory = await buildInventory({ environment: NO_DATABASE });
    for (const row of LEGACY_ENTRY_DISPOSITIONS) {
      const entrance = inventory.entrances.find(
        (entry) => entry.id === row.entrance,
      );
      expect(
        entrance,
        `entrance ${row.entrance} must exist in the inventory`,
      ).toBeDefined();
      expect(entrance?.ownerTicket).toBe("MT125");
      expect(entrance?.status).toBe("owned");
    }
  });

  test("every inventory entrance of the three families is dispositioned (no gap)", async () => {
    const inventory = await buildInventory({ environment: NO_DATABASE });
    const dispositioned = new Set(
      LEGACY_ENTRY_DISPOSITIONS.map((row) => row.entrance),
    );
    // GET /api/channels/events 是流式入口，归 MT126 的流式处置表。
    const streamDispositioned = new Set(["GET /api/channels/events"]);
    const familyPredicates: readonly ((path: string) => boolean)[] = [
      (path) => path.startsWith("/api/channels"),
      (path) => path.startsWith("/api/threads"),
      (path) => path.startsWith("/api/copilotkit"),
      (path) =>
        [
          "/api/mobile/workspace",
          "/api/mobile/conversations",
          "/api/mobile/openmuse-bot",
          "/api/mobile/activity",
          "/api/mobile/openmuse-aggregate",
        ].includes(path),
    ];
    const uncovered: string[] = [];
    for (const entry of inventory.entrances) {
      if (!familyPredicates.some((predicate) => predicate(entry.path)))
        continue;
      if (dispositioned.has(entry.id) || streamDispositioned.has(entry.id)) {
        continue;
      }
      uncovered.push(entry.id);
    }
    expect(
      uncovered,
      `family entrances without a disposition: ${uncovered.join(", ")}`,
    ).toEqual([]);
  });

  test("the inventory has zero unclassified entrances (AC4)", async () => {
    const inventory = await buildInventory({ environment: NO_DATABASE });
    const unclassified = inventory.entrances.filter(
      (entry) => entry.businessClosure === "unclassified",
    );
    expect(unclassified.map((entry) => entry.id)).toEqual([]);
  });
});
