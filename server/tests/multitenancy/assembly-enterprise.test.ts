// server/tests/multitenancy/assembly-enterprise.test.ts
// MT124（Issue #167）：企业入口装配接入统一上下文与授权。
//
// 真实 PostgreSQL + 受限 ob_ent_* 角色 + 同一 DeploymentEntryContextFactory
// 上钉死票面四条验收；缺 env 显式 skip、skipped 不计通过：
//   AC1 缺上下文拒绝矩阵：无会话 401；缺公司/团队选择 400 canonical 码，
//       路由不再落任何默认范围；
//   AC2 统一上下文与部署主入口同一工厂：同一 authenticate 闭包、同一
//       成员资格 DB 重验（不是平行实现）；
//   AC3 与旧装配 DTO 逐字节兼容：同 service、同输入，两半 status+body 全等；
//   AC4 入口清单处置表如实登记且被 buildInventory 回写。
// 判定面：server/src/enterprise/tenancy/assembly-enterprise.ts（装配 +
// ENTERPRISE_ENTRY_DISPOSITIONS）与 scripts/multitenancy/inventory.ts 回写。

import { Hono } from "hono";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/e2e-compat";
import { buildInventory } from "../../scripts/multitenancy/inventory";
import { createConversationRoutes } from "../../src/enterprise/conversations/routes";
import {
  createEnterpriseConversationEntryRoutes,
  ENTERPRISE_ENTRY_DISPOSITIONS,
} from "../../src/enterprise/tenancy/assembly-enterprise";
import {
  type AssemblyFixture,
  createAssemblyFixture,
  probeAssemblyEnvironment,
} from "./support/assembly-enterprise";

const ENV = probeAssemblyEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

const THREAD_A = "mt124-thread-alpha";
const THREAD_B = "mt124-thread-beta";

let fixture: AssemblyFixture;

const NO_DATABASE: Record<string, string | undefined> = {
  // 只有开发库变量也绝不允许回退：测试数据库变量缺席即显式跳过数据库阶段。
  DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
};

describeDb("MT124 unified entry assembly (Issue #167)", () => {
  beforeAll(async () => {
    fixture = await createAssemblyFixture();
    await fixture.seedConversation({
      tenantKey: "company-a",
      owner: "a-member",
      threadId: THREAD_A,
      title: "MT124 Alpha",
    });
    await fixture.seedConversation({
      tenantKey: "company-b",
      owner: "b-member",
      threadId: THREAD_B,
      title: "MT124 Beta",
    });
  });
  afterAll(async () => {
    await fixture.dispose();
  });

  // ---- AC1 缺上下文拒绝矩阵：建立期拒绝，路由不落默认范围 ----
  describeDb("AC1 missing context is refused before any default scope", () => {
    itDb(
      "no session (selection headers present) → 401 unauthenticated",
      async () => {
        const response = await fixture.requestAs("unified", {
          method: "GET",
          path: "/api/enterprise/conversations",
          tenantId: fixture.ids["company-a"],
          workspaceId: fixture.ids["team-a1"],
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
          error: { code: "unauthenticated", message: "AUTH_REQUIRED" },
        });
      },
    );

    itDb("unknown session identity → 401 unauthenticated", async () => {
      // 身份头换成不属于任何成员的裸 id：工厂同一 authenticate 闭包重验后拒绝。
      const response = await fixture.unified.request(
        "/api/enterprise/conversations",
        {
          method: "GET",
          headers: {
            "x-mt124-identity": "nobody",
            "x-openbot-tenant": fixture.ids["company-a"],
            "x-openbot-workspace": fixture.ids["team-a1"],
          },
        },
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { code: "unauthenticated", message: "AUTH_REQUIRED" },
      });
    });

    itDb("session without tenant selection → 400 TENANT_REQUIRED", async () => {
      const response = await fixture.requestAs("unified", {
        method: "GET",
        path: "/api/enterprise/conversations",
        session: "a-member",
        workspaceId: fixture.ids["team-a1"],
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "invalid_request", message: "TENANT_REQUIRED" },
      });
    });

    itDb(
      "tenant without workspace selection → 400 WORKSPACE_REQUIRED",
      async () => {
        const response = await fixture.requestAs("unified", {
          method: "GET",
          path: "/api/enterprise/conversations",
          session: "a-member",
          tenantId: fixture.ids["company-a"],
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: { code: "invalid_request", message: "WORKSPACE_REQUIRED" },
        });
      },
    );

    itDb(
      "selecting a company the session does not belong to → 403 forbidden",
      async () => {
        const response = await fixture.requestAs("unified", {
          method: "GET",
          path: "/api/enterprise/conversations",
          session: "a-member",
          tenantId: fixture.ids["company-b"],
          workspaceId: fixture.ids["team-b1"],
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: { code: "forbidden", message: "Access denied." },
        });
      },
    );
  });

  // ---- AC2 同一工厂（部署主入口的 DeploymentEntryContextFactory） ----
  describeDb("AC2 the entry shares the deployment's one factory", () => {
    itDb(
      "factory.fromRequest establishes the same scope the route served",
      async () => {
        const business = await fixture.factory.fromRequest(
          new Request("http://mt124.test/api/enterprise/conversations", {
            headers: {
              "x-mt124-identity": "a-member",
              "x-openbot-tenant": fixture.ids["company-a"],
              "x-openbot-workspace": fixture.ids["team-a1"],
            },
          }),
        );
        // 成员资格 DB 重验后的权威范围，不是头里的自由文本。
        expect(business.scope.tenantId).toBe(fixture.ids["company-a"]);
        expect(business.scope.workspaceId).toBe(fixture.ids["team-a1"]);

        const response = await fixture.requestAs("unified", {
          method: "GET",
          path: "/api/enterprise/conversations",
          session: "a-member",
          tenantId: fixture.ids["company-a"],
          workspaceId: fixture.ids["team-a1"],
        });
        const listed: Array<{ thread_id: string }> = await response.json();
        expect(listed.some((dto) => dto.thread_id === THREAD_A)).toBe(true);
      },
    );

    itDb(
      "the same factory refuses missing selection itself (no default scope)",
      async () => {
        await expect(
          fixture.factory.fromRequest(
            new Request("http://mt124.test/api/enterprise/conversations", {
              headers: { "x-mt124-identity": "a-member" },
            }),
          ),
        ).rejects.toThrow("TENANT_REQUIRED");
      },
    );

    itDb("the same authenticate closure serves both halves", async () => {
      // 同一身份头：统一装配 200；剥掉身份：同一闭包判 AUTH_REQUIRED。
      const ok = await fixture.requestAs("unified", {
        method: "GET",
        path: "/api/enterprise/conversations",
        session: "a-member",
        tenantId: fixture.ids["company-a"],
        workspaceId: fixture.ids["team-a1"],
      });
      const anonymous = await fixture.requestAs("legacy", {
        method: "GET",
        path: "/api/enterprise/conversations",
        tenantId: fixture.ids["company-a"],
        workspaceId: fixture.ids["team-a1"],
      });
      expect(ok.status).toBe(200);
      expect(anonymous.status).toBe(401);
    });
  });

  // ---- AC3 DTO 逐字节兼容（同 service、同输入，两半全等） ----
  describeDb("AC3 byte-for-byte DTO parity with the legacy assembly", () => {
    // 实参在注册期即求值（早于 beforeAll），必须惰性构造。
    const parityCase = (
      name: string,
      makeInput: () => Parameters<AssemblyFixture["requestAs"]>[1],
    ) =>
      itDb(name, async () => {
        const input = makeInput();
        const unified = await fixture.requestAs("unified", input);
        const legacy = await fixture.requestAs("legacy", input);
        expect(unified.status).toBe(legacy.status);
        expect(JSON.stringify(await unified.json())).toBe(
          JSON.stringify(await legacy.json()),
        );
      });

    parityCase("GET list", () => ({
      method: "GET",
      path: "/api/enterprise/conversations",
      session: "a-member",
      tenantId: fixture.ids["company-a"],
      workspaceId: fixture.ids["team-a1"],
    }));

    parityCase("GET history for an owned thread", () => ({
      method: "GET",
      path: `/api/enterprise/conversations/${THREAD_A}/messages`,
      session: "a-member",
      tenantId: fixture.ids["company-a"],
      workspaceId: fixture.ids["team-a1"],
    }));

    parityCase("POST create (no mastra storage in this fixture)", () => ({
      method: "POST",
      path: "/api/enterprise/conversations",
      session: "a-member",
      tenantId: fixture.ids["company-a"],
      workspaceId: fixture.ids["team-a1"],
      body: { title: "MT124 created" },
    }));

    parityCase(
      "POST append message (no mastra storage in this fixture)",
      () => ({
        method: "POST",
        path: `/api/enterprise/conversations/${THREAD_A}/messages`,
        session: "a-member",
        tenantId: fixture.ids["company-a"],
        workspaceId: fixture.ids["team-a1"],
        body: {
          clientMessageKey: "mt124-key-1",
          content: "hello",
          attachments: [],
        },
      }),
    );

    parityCase("POST append rejects an invalid body identically", () => ({
      method: "POST",
      path: `/api/enterprise/conversations/${THREAD_A}/messages`,
      session: "a-member",
      tenantId: fixture.ids["company-a"],
      workspaceId: fixture.ids["team-a1"],
      body: { content: "no key" },
    }));

    itDb(
      "a foreign company's thread is invisible, same shape as missing",
      async () => {
        const foreign = await fixture.requestAs("unified", {
          method: "GET",
          path: `/api/enterprise/conversations/${THREAD_B}/messages`,
          session: "a-member",
          tenantId: fixture.ids["company-a"],
          workspaceId: fixture.ids["team-a1"],
        });
        const missing = await fixture.requestAs("unified", {
          method: "GET",
          path: "/api/enterprise/conversations/mt124-no-such-thread/messages",
          session: "a-member",
          tenantId: fixture.ids["company-a"],
          workspaceId: fixture.ids["team-a1"],
        });
        // 服务自己的授权判定：跨公司与不存在同形，不泄露存在性。
        const foreignBody = await foreign.json();
        expect(foreign.status).toBe(404);
        expect(foreign.status).toBe(missing.status);
        expect(foreignBody).toEqual(await missing.json());
        // 旧装配同输入不产生不同的存在性泄露面。
        const legacyForeign = await fixture.requestAs("legacy", {
          method: "GET",
          path: `/api/enterprise/conversations/${THREAD_B}/messages`,
          session: "a-member",
          tenantId: fixture.ids["company-a"],
          workspaceId: fixture.ids["team-a1"],
        });
        expect(legacyForeign.status).toBe(404);
        expect(await legacyForeign.json()).toEqual(foreignBody);
      },
    );
  });
});

// ---- AC4 处置表（不依赖数据库连接的静态事实 + buildInventory 回写） ----
describe("MT124 entrance dispositions (Issue #167 AC4)", () => {
  test("the disposition table is internally coherent", () => {
    const ids = ENTERPRISE_ENTRY_DISPOSITIONS.map((row) => row.entrance);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(9);
    for (const row of ENTERPRISE_ENTRY_DISPOSITIONS) {
      expect(["MT124", "MT075"]).toContain(row.ownerTicket);
      // entrance 形如 "METHOD path"：先剥 method 再看路径前缀。
      const path = row.entrance.split(" ", 2)[1];
      if (path === "/api/enterprise/conversations") {
        expect(row.establishment).toBe("unified-entry-context");
        expect(row.visibility).toBe("service-authorized");
        expect(row.ownerTicket).toBe("MT124");
      }
      if (path?.startsWith("/api/enterprise/conversations/")) {
        expect(row.establishment).toBe("unified-entry-context");
        expect(row.visibility).toBe("service-authorized");
        expect(row.ownerTicket).toBe("MT124");
      }
      if (path?.startsWith("/api/enterprise/workspace-scope/admin/")) {
        expect(row.establishment).toBe("company-admin-context");
        expect(row.visibility).toBe("plane-classified");
        expect(row.ownerTicket).toBe("MT075");
      }
    }
  });

  test("the disposition ids match both real route constructors exactly", () => {
    // 真实挂载读扁平路由表（与 buildInventory 的枚举同一路径形状）。
    const routeIds = (routes: Hono) =>
      new Hono()
        .route("/api/enterprise/conversations", routes)
        .routes.map((route) => `${route.method} ${route.path}`)
        .sort();
    const stubFactory = {
      fromRequest: async () => {
        throw new Error("ENTERPRISE_ENTRY_CONTEXT_REQUIRED");
      },
    };
    const stubService = {
      list: async () => [],
      getOrCreate: async () => ({}),
      history: async () => ({ messages: [] }),
      append: async () => ({}),
    } as never;
    const stubScopes = {
      resolve: async () => {
        throw new Error("AUTH_REQUIRED");
      },
      resolveForThread: async () => {
        throw new Error("AUTH_REQUIRED");
      },
    } as never;
    const unified = routeIds(
      createEnterpriseConversationEntryRoutes({
        factory: stubFactory,
        service: stubService,
      }),
    );
    const legacy = routeIds(createConversationRoutes(stubService, stubScopes));
    const dispositionIds = ENTERPRISE_ENTRY_DISPOSITIONS.filter(
      (row) =>
        row.entrance
          .split(" ", 2)[1]
          ?.startsWith("/api/enterprise/conversations") === true,
    )
      .map((row) => row.entrance)
      .sort();
    expect(unified).toEqual(dispositionIds);
    expect(legacy).toEqual(dispositionIds);
  });

  test("buildInventory stamps every disposition entrance as owned", async () => {
    const inventory = await buildInventory({ environment: NO_DATABASE });
    for (const row of ENTERPRISE_ENTRY_DISPOSITIONS) {
      const entrance = inventory.entrances.find(
        (entry) => entry.id === row.entrance,
      );
      expect(
        entrance,
        `entrance ${row.entrance} must exist in the inventory`,
      ).toBeDefined();
      expect(entrance?.ownerTicket).toBe(row.ownerTicket);
      expect(entrance?.status).toBe("owned");
    }
  });
});
