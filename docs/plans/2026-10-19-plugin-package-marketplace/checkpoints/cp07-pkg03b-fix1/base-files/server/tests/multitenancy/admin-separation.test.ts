// server/tests/multitenancy/admin-separation.test.ts
// MT075（Issue #118）：部署级平台管理与公司/团队管理动作分离。
//
// 验收事实源（Issue #118 四条，逐条对应 describe）：
//   (1) 公司管理员调用平台级管理入口被拒绝；平台身份调用公司管理入口需
//       显式授权并留审计——platform/company 两个授权判定 + 显式跨面授权
//       登记 + 真实审计落库（enterprise_security_events，受限 operator
//       角色与真实 RLS INSERT 策略）。
//   (2) 每个管理入口都被分类为平台级或公司/团队级（清单可核对）——封闭
//       分类规则表 × 真实 MT001 清单交叉核对（真实应用装配，非手写常量）。
//   (3) 管理动作不隐含业务内容读取权（专门越权测试）——公司管理员完成
//       管理动作后仍读不到成员私有业务内容；平台机器身份连业务会话都
//       无法签发；平台机器读角色对业务内容表零授权（目录证据）。
//   (4) 分类结果回写 MT001 清单——inventory.summary.managementPlanes 由
//       同一分类函数在真实装配上计算（结构保证一致，而非复制）。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_DATABASE_URL）
// 加三个受限角色 URL；缺配置时数据库用例显式 skip（理由写在用例名里），
// 绝不回退开发库，skipped 不计为通过。

import { afterAll, beforeAll, describe, expect, test } from "../../../tests/support/bun-test-compat";
import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { buildInventory } from "../../scripts/multitenancy/inventory";
import { requireAdmin } from "../../src/auth/guards";
import {
  assertClassifiedCompanyEntrance,
  authorizeCompanyManagementAction,
  authorizePlatformManagementAction,
  classifyManagementPlane,
  createManagementCrossGrantRegistry,
  MANAGEMENT_PLANE_RULES,
  type ManagementActor,
  type ManagementCrossGrant,
  recordManagementAuditEvent,
} from "../../src/enterprise/tenancy/admin-separation";
import { createWorkspaceScopeRoutes } from "../../src/enterprise/tenancy/workspace-scope-routes";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
  ROLE_DATABASE_VARIABLES,
} from "../support/enterprise-database";
import {
  type AdminSeparationFixture,
  createAdminSeparationFixture,
} from "./support/admin-separation";

// ---------------------------------------------------------------------------
// 环境探针（与 workspace-scope.test.ts 同一契约）
// ---------------------------------------------------------------------------

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const required = [
    "TEST_DATABASE_URL",
    "ENTERPRISE_TEST_SETUP_DATABASE_URL",
    "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
    "ENTERPRISE_TEST_DATA_DATABASE_URL",
    "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `MT075 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    enterpriseTestDatabaseUrlFrom(process.env);
    for (const role of ["directory", "data", "operator"] as const) {
      enterpriseRuntimeDatabaseUrlFrom(role, process.env);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const ENV = probeEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

// 与 MT001 inventory.test.ts 相同的无数据库环境：清单来自真实应用装配，
// 数据库阶段显式跳过，绝不回退 DATABASE_URL。
const NO_DATABASE: Record<string, string | undefined> = {
  DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
};

// 真实清单一次装配、多组断言共享（与 inventory.test.ts 同一形态：模块
// 顶层 await，真实应用装配，非手写常量）。
const inventory = await buildInventory({ environment: NO_DATABASE });

// ---------------------------------------------------------------------------
// 固定入口形状（与 MT001 清单 id 同形："METHOD path"）
// ---------------------------------------------------------------------------

const PLATFORM_SENTINELS = [
  "GET /api/admin/status",
  "PUT /api/admin/enterprise/capabilities",
  "GET /api/admin/audit-events",
  "POST /api/admin/people/:userId/role",
  "DELETE /api/admin/identity-providers/:providerId",
  "ALL /api/admin/enterprise/*",
] as const;

const COMPANY_ENTRANCES = [
  "POST /api/enterprise/workspace-scope/admin/teams",
  "POST /api/enterprise/workspace-scope/admin/teams/:workspaceId/members",
  "POST /api/enterprise/workspace-scope/admin/teams/:workspaceId/members/:principalId/suspend",
  "DELETE /api/enterprise/workspace-scope/admin/teams/:workspaceId/members/:principalId",
] as const;

function entranceOf(id: string): { method: string; path: string } {
  const separator = id.indexOf(" ");
  if (separator <= 0) throw new Error(`ENTRANCE_ID_MALFORMED:${id}`);
  return { method: id.slice(0, separator), path: id.slice(separator + 1) };
}

function entranceId(entrance: { method: string; path: string }): string {
  return `${entrance.method} ${entrance.path}`;
}

// ---------------------------------------------------------------------------
// 共享夹具（真实 PostgreSQL 时才创建）
// ---------------------------------------------------------------------------

let fixture: AdminSeparationFixture | undefined;

// ---------------------------------------------------------------------------
// (2) 管理入口分类：封闭规则表与哨兵
// ---------------------------------------------------------------------------

describe("management plane classification (closed rule table)", () => {
  test("the rule table is closed and every rule declares exactly one plane", () => {
    expect(MANAGEMENT_PLANE_RULES.length).toBeGreaterThanOrEqual(3);
    for (const rule of MANAGEMENT_PLANE_RULES) {
      expect(["platform", "company"]).toContain(rule.plane);
      expect(rule.surface.length).toBeGreaterThan(0);
      expect(rule.prefix !== undefined || rule.pathPattern !== undefined).toBe(
        true,
      );
    }
  });

  test("platform sentinels classify platform", () => {
    for (const id of PLATFORM_SENTINELS) {
      expect(classifyManagementPlane(entranceOf(id))).toBe("platform");
    }
    // SCIM 写动词是管理员面（app.on(["PUT","PATCH","DELETE"], …)）。
    expect(
      classifyManagementPlane({ method: "PUT", path: "/api/auth/scim/*" }),
    ).toBe("platform");
    expect(
      classifyManagementPlane({ method: "PATCH", path: "/api/auth/scim/*" }),
    ).toBe("platform");
    // SSO 登记是管理员决定（ADMIN_ONLY_AUTH_ROUTES），按精确路径分类。
    expect(
      classifyManagementPlane({
        method: "POST",
        path: "/api/auth/sso/register",
      }),
    ).toBe("platform");
  });

  test("company sentinels classify company", () => {
    for (const id of COMPANY_ENTRANCES) {
      expect(classifyManagementPlane(entranceOf(id))).toBe("company");
    }
  });

  test("business and self-service entrances are not management entrances", () => {
    // 自服务工作范围列出不是管理动作（读的是自己的资格事实）。
    expect(
      classifyManagementPlane({
        method: "GET",
        path: "/api/enterprise/workspace-scope",
      }),
    ).toBeNull();
    expect(
      classifyManagementPlane({ method: "GET", path: "/api/agents" }),
    ).toBeNull();
    expect(
      classifyManagementPlane({
        method: "POST",
        path: "/api/enterprise/conversations",
      }),
    ).toBeNull();
    expect(
      classifyManagementPlane({ method: "GET", path: "/api/auth/session" }),
    ).toBeNull();
    // SCIM 读动词是身份面，不是管理面。
    expect(
      classifyManagementPlane({ method: "GET", path: "/api/auth/scim/*" }),
    ).toBeNull();
    // 前缀不越界：/api/administration 不得被 /api/admin/ 前缀吞掉。
    expect(
      classifyManagementPlane({ method: "GET", path: "/api/administration" }),
    ).toBeNull();
  });

  test("assertClassifiedCompanyEntrance passes company entrances and refuses everything else", () => {
    expect(() =>
      assertClassifiedCompanyEntrance(
        "POST",
        "/api/enterprise/workspace-scope/admin/teams",
      ),
    ).not.toThrow();
    for (const refused of [
      { method: "GET", path: "/api/admin/status" },
      { method: "GET", path: "/api/agents" },
      // 尚不存在分类规则的（假想）新管理面：fail-closed。
      { method: "POST", path: "/api/company-admin/teams" },
      {
        method: "POST",
        path: "/api/enterprise/workspace-scope/administration/teams",
      },
    ]) {
      try {
        assertClassifiedCompanyEntrance(refused.method, refused.path);
        throw new Error("EXPECTED_REFUSAL");
      } catch (error) {
        expect((error as Error).message).toBe(
          "MANAGEMENT_ENTRANCE_UNCLASSIFIED",
        );
      }
    }
  });

  test("every admin route the real workspace-scope surface registers is classified company, and the listing is not", () => {
    // 真实路由表 × 分类规则表的一致性：路由层接线（guard）与清单分类
    // 不许漂移。新增管理路由而没有分类规则 → 该用例失败。
    const routes = createWorkspaceScopeRoutes({
      authenticate: async () => null,
      lister: {} as never,
    });
    const mount = "/api/enterprise/workspace-scope";
    const registered = (
      routes.routes as ReadonlyArray<{ method: string; path: string }>
    ).filter((row) => row.method !== "ALL");
    expect(registered.length).toBe(5);
    for (const row of registered) {
      const full = `${mount}${row.path === "/" ? "" : row.path}`;
      const plane = classifyManagementPlane({
        method: row.method,
        path: full,
      });
      if (row.path.startsWith("/admin/")) {
        expect(plane).toBe("company");
      } else {
        expect(plane).toBeNull();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (2)/(4) 真实清单交叉核对与回写（真实应用装配，无数据库阶段）
// ---------------------------------------------------------------------------

describe("management plane classification against the real MT001 inventory", () => {
  test("the inventory assembly contains the workspace-scope surface (MT001 blind spot closed)", () => {
    const ids = new Set(inventory.entrances.map((entry) => entry.id));
    expect(ids.has("GET /api/enterprise/workspace-scope")).toBe(true);
    for (const id of COMPANY_ENTRANCES) {
      expect(ids.has(id)).toBe(true);
    }
    // 闭环归属：公司/团队管理是自己的业务闭环，不再是 unclassified。
    const workspaceAdmin = inventory.entrances.filter((entry) =>
      entry.path.startsWith("/api/enterprise/workspace-scope"),
    );
    expect(workspaceAdmin.length).toBe(5);
    for (const entry of workspaceAdmin) {
      expect(entry.businessClosure).toBe("workspace-admin");
    }
    expect(inventory.summary.unclassifiedEntrances).toBe(0);
  });

  test("every management entrance on the two surfaces is classified (zero missed)", () => {
    let platform = 0;
    let company = 0;
    for (const entry of inventory.entrances) {
      if (entry.path.startsWith("/api/admin/")) {
        expect(classifyManagementPlane(entry)).toBe("platform");
        platform += 1;
      }
      if (entry.path.startsWith("/api/enterprise/workspace-scope/admin/")) {
        expect(classifyManagementPlane(entry)).toBe("company");
        company += 1;
      }
    }
    expect(platform).toBeGreaterThanOrEqual(40);
    expect(company).toBe(COMPANY_ENTRANCES.length);
  });

  test("each prefix rule actually hits the assembled inventory (no typo prefixes)", () => {
    for (const rule of MANAGEMENT_PLANE_RULES) {
      if (!rule.prefix) continue;
      const hits = inventory.entrances.filter((entry) => {
        if (rule.methods && !rule.methods.includes(entry.method)) return false;
        return entry.path === rule.prefix || entry.path.startsWith(rule.prefix);
      });
      expect(hits.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("classification is written back into the inventory summary from the same function", () => {
    const expected = { platform: 0, company: 0 };
    for (const entry of inventory.entrances) {
      const plane = classifyManagementPlane(entry);
      if (plane === "platform") expected.platform += 1;
      if (plane === "company") expected.company += 1;
    }
    expect(inventory.summary.managementPlanes).toEqual(expected);
    expect(inventory.summary.managementPlanes.platform).toBeGreaterThan(0);
    expect(inventory.summary.managementPlanes.company).toBeGreaterThan(0);
    // 回写进入契约面：清单 JSON 携带管理面分类摘要。
    expect(JSON.stringify(inventory).includes("managementPlanes")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (1) 平台级管理判定：公司管理员被拒绝
// ---------------------------------------------------------------------------

type AdminGuardContext = Context<{
  Variables: { actor: { id: string; email: string; role: string } };
}>;

function fakeAdminContext(role: "admin" | "user"): AdminGuardContext {
  return {
    var: { actor: { id: "actor-user", email: "actor@openbot.test", role } },
    json: (body: unknown, status?: number) =>
      Response.json(body as Record<string, unknown>, { status }),
  } as unknown as AdminGuardContext;
}

describe("platform management authorization (deployment plane)", () => {
  test("the deployment guard refuses a company admin's deployment role (tenant_admin is not the platform key)", () => {
    const denied = requireAdmin(fakeAdminContext("user"));
    expect(denied).toBeInstanceOf(Response);
    expect(denied?.status).toBe(403);
    expect(requireAdmin(fakeAdminContext("admin"))).toBeUndefined();
  });

  test("deployment admin and platform operator pass; company admin is refused", () => {
    const entrance = entranceOf("GET /api/admin/status");
    const deploymentAdmin: ManagementActor = {
      kind: "deployment_admin",
      userId: "deployment-admin-user",
    };
    expect(
      authorizePlatformManagementAction(deploymentAdmin, entrance),
    ).toEqual({ outcome: "allow", plane: "platform", audit: null });
    const platformOperator: ManagementActor = {
      kind: "platform_operator",
      subject: "ob_ent_identity_operator",
    };
    expect(
      authorizePlatformManagementAction(platformOperator, entrance),
    ).toEqual({ outcome: "allow", plane: "platform", audit: null });

    // AC1 前半：公司管理员调用平台级管理入口被拒绝——tenant_admin 身份
    // 不携带任何平台管理权。
    const companyAdmin: ManagementActor = {
      kind: "company_admin",
      context: {
        tenantId: "tenant-a",
        principalId: "principal-admin",
        actorId: "admin-user",
        memberEpoch: 1,
      },
    };
    expect(authorizePlatformManagementAction(companyAdmin, entrance)).toEqual({
      outcome: "deny",
      code: "PLATFORM_ADMIN_REQUIRED",
      plane: "platform",
    });
  });

  test("unclassified entrances fail closed on the platform plane too", () => {
    const decision = authorizePlatformManagementAction(
      { kind: "deployment_admin", userId: "deployment-admin-user" },
      { method: "GET", path: "/api/agents" },
    );
    expect(decision).toEqual({
      outcome: "deny",
      code: "MANAGEMENT_ENTRANCE_UNCLASSIFIED",
      plane: null,
    });
  });
});

// ---------------------------------------------------------------------------
// (1) 公司/团队级管理判定：平台身份需显式授权
// ---------------------------------------------------------------------------

describe("company management authorization (explicit cross-plane grants)", () => {
  const entrance = entranceOf(
    "POST /api/enterprise/workspace-scope/admin/teams",
  );
  const tenantA = "tenant-a";
  const grant: ManagementCrossGrant = {
    grantId: "grant-1",
    subject: "platform-scanner",
    tenantId: tenantA,
    entrance: entranceId(entrance),
    grantedBy: "deployment-admin-user",
    reason: "platform governance sweep approved 2026-10",
  };
  const registry = createManagementCrossGrantRegistry([grant]);

  test("a platform operator without an explicit grant is refused", () => {
    const decision = authorizeCompanyManagementAction({
      actor: { kind: "platform_operator", subject: "platform-scanner" },
      entrance,
      tenantId: tenantA,
      grants: createManagementCrossGrantRegistry([]),
    });
    expect(decision).toEqual({
      outcome: "deny",
      code: "MANAGEMENT_CROSS_AUTHORIZATION_REQUIRED",
      plane: "company",
    });
  });

  test("the deployment admin is also not a company admin (planes are separate)", () => {
    const decision = authorizeCompanyManagementAction({
      actor: { kind: "deployment_admin", userId: "deployment-admin-user" },
      entrance,
      tenantId: tenantA,
      grants: registry,
    });
    expect(decision).toEqual({
      outcome: "deny",
      code: "MANAGEMENT_CROSS_AUTHORIZATION_REQUIRED",
      plane: "company",
    });
  });

  test("an exact grant allows the platform operator and emits the audit event", () => {
    const decision = authorizeCompanyManagementAction({
      actor: { kind: "platform_operator", subject: "platform-scanner" },
      entrance,
      tenantId: tenantA,
      grants: registry,
    });
    expect(decision.outcome).toBe("allow");
    if (decision.outcome !== "allow" || decision.audit === null) {
      throw new Error("EXPECTED_ALLOW_WITH_AUDIT");
    }
    expect(decision.plane).toBe("company");
    expect(decision.audit.eventType).toBe("management_action.cross_plane");
    expect(decision.audit.tenantId).toBe(tenantA);
    expect(decision.audit.entrance).toBe(entranceId(entrance));
    expect(decision.audit.actorKind).toBe("platform_operator");
    expect(decision.audit.actorSubject).toBe("platform-scanner");
    expect(decision.audit.grantId).toBe("grant-1");
    expect(decision.audit.grantedBy).toBe("deployment-admin-user");
    expect(decision.audit.reason.length).toBeGreaterThan(0);
    expect(decision.audit.eventId.length).toBeGreaterThan(0);
    // 决策不携带任何业务内容句柄：没有 scope/principal/workspace。
    const decisionJson = JSON.stringify(decision);
    expect(decisionJson.includes("principalId")).toBe(false);
    expect(decisionJson.includes("workspaceId")).toBe(false);
    expect(decisionJson.includes("memberEpoch")).toBe(false);
  });

  test("grants bind subject, tenant and entrance exactly (no wildcard reuse)", () => {
    for (const mismatch of [
      { subject: "other-machine" },
      { tenantId: "tenant-b" },
      {
        entrance: entranceOf(
          "DELETE /api/enterprise/workspace-scope/admin/teams/:workspaceId/members/:principalId",
        ),
      },
    ]) {
      const decision = authorizeCompanyManagementAction({
        actor: {
          kind: "platform_operator",
          subject: mismatch.subject ?? "platform-scanner",
        },
        entrance: mismatch.entrance ?? entrance,
        tenantId: mismatch.tenantId ?? tenantA,
        grants: registry,
      });
      expect(decision).toEqual({
        outcome: "deny",
        code: "MANAGEMENT_CROSS_AUTHORIZATION_REQUIRED",
        plane: "company",
      });
    }
  });

  test("an untrusted (hand-made) company admin context fails closed", () => {
    const decision = authorizeCompanyManagementAction({
      actor: {
        kind: "company_admin",
        context: {
          tenantId: tenantA,
          principalId: "principal-forged",
          actorId: "forged-user",
          memberEpoch: 1,
        },
      },
      entrance,
      tenantId: tenantA,
      grants: registry,
    });
    expect(decision).toEqual({
      outcome: "deny",
      code: "COMPANY_ADMIN_CONTEXT_REQUIRED",
      plane: "company",
    });
  });

  test("the company decision fails closed on unclassified entrances", () => {
    const decision = authorizeCompanyManagementAction({
      actor: { kind: "platform_operator", subject: "platform-scanner" },
      // 尚不存在分类规则的（假想）新管理面：fail-closed。
      entrance: {
        method: "POST",
        path: "/api/company-admin/teams",
      },
      tenantId: tenantA,
      grants: registry,
    });
    expect(decision).toEqual({
      outcome: "deny",
      code: "MANAGEMENT_ENTRANCE_UNCLASSIFIED",
      plane: null,
    });
  });

  test("the grant registry refuses malformed and misclassified grants loudly", () => {
    expect(() =>
      createManagementCrossGrantRegistry([
        { ...grant, entrance: "GET /api/admin/status" },
      ]),
    ).toThrow(); // 平台入口上的"公司授权"是分类错误
    expect(() =>
      createManagementCrossGrantRegistry([{ ...grant, subject: " " }]),
    ).toThrow();
    expect(() =>
      createManagementCrossGrantRegistry([{ ...grant, grantId: "" }]),
    ).toThrow();
    expect(() =>
      createManagementCrossGrantRegistry([{ ...grant, reason: "" }]),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 真实 PostgreSQL：受信上下文、审计落库、真实表面、越权
// ---------------------------------------------------------------------------

describeDb("admin separation on the real enterprise test database", () => {
  beforeAll(async () => {
    if (!ENV.ok) return;
    fixture = await createAdminSeparationFixture();
  });

  afterAll(async () => {
    await fixture?.dispose();
    fixture = undefined;
  });

  test("a trusted company admin context allows the company plane without audit; another company's context is refused", async () => {
    if (!fixture) throw new Error("FIXTURE_MISSING");
    const tenantA = fixture.scope.ids["company-a"];
    const context = await fixture.scope.adminContextOf("company-admin");
    const entrance = entranceOf(
      "POST /api/enterprise/workspace-scope/admin/teams",
    );
    const allowed = authorizeCompanyManagementAction({
      actor: { kind: "company_admin", context },
      entrance,
      tenantId: context.tenantId,
      grants: createManagementCrossGrantRegistry([]),
    });
    expect(allowed).toEqual({
      outcome: "allow",
      plane: "company",
      audit: null,
    });
    // 它公司上下文：租户绑定拒绝。
    const forged = authorizeCompanyManagementAction({
      actor: { kind: "company_admin", context },
      entrance,
      tenantId:
        tenantA === context.tenantId ? "tenant-other" : context.tenantId,
      grants: createManagementCrossGrantRegistry([]),
    });
    expect(forged).toEqual({
      outcome: "deny",
      code: "COMPANY_ADMIN_CONTEXT_REQUIRED",
      plane: "company",
    });
  });

  itDb(
    "AC1: the cross-plane audit event lands in enterprise_security_events through the restricted operator role",
    async () => {
      if (!fixture) throw new Error("FIXTURE_MISSING");
      const tenantA = fixture.scope.ids["company-a"];
      const entranceIdValue =
        "POST /api/enterprise/workspace-scope/admin/teams";
      const registry = createManagementCrossGrantRegistry([
        {
          grantId: "grant-e2e-1",
          subject: "platform-scanner",
          tenantId: tenantA,
          entrance: entranceIdValue,
          grantedBy: "deployment-admin-user",
          reason: "MT075 e2e: audited platform sweep",
        },
      ]);
      const decision = authorizeCompanyManagementAction({
        actor: { kind: "platform_operator", subject: "platform-scanner" },
        entrance: entranceOf(entranceIdValue),
        tenantId: tenantA,
        grants: registry,
      });
      if (decision.outcome !== "allow" || decision.audit === null) {
        throw new Error("EXPECTED_ALLOW_WITH_AUDIT");
      }
      // 写入：受限 operator 事务 + 事务本地租户 pin（与撤权审计同一
      // RLS INSERT 策略通道：app.tenant_id + app.operation_id）。
      const event = decision.audit;
      await fixture.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantA}, true)`,
        );
        await recordManagementAuditEvent(tx, event);
      });
      // 读回：operation pin 限定内恰好一条；无 pin 不可见（策略语义）。
      const pinned = await fixture.scope.isolation.queryRestricted(
        "operator",
        { tenantId: tenantA, operationId: event.eventId },
        "select event_type, actor_id, details from enterprise_security_events where id = $1",
        [event.eventId],
      );
      expect(pinned.length).toBe(1);
      expect(pinned[0].event_type).toBe("management_action.cross_plane");
      expect(pinned[0].actor_id).toBe("platform-scanner");
      const details = pinned[0].details as Record<string, unknown>;
      expect(details.entrance).toBe(entranceIdValue);
      expect(details.grant_id).toBe("grant-e2e-1");
      expect(details.granted_by).toBe("deployment-admin-user");
      expect(details.cross_plane_from).toBe("platform");
      const unpinned = await fixture.scope.isolation.queryRestricted(
        "operator",
        { tenantId: tenantA },
        "select id from enterprise_security_events where id = $1",
        [event.eventId],
      );
      expect(unpinned.length).toBe(0);
    },
  );

  itDb(
    "AC1: the real company surface serves the company admin and refuses the platform machine identity",
    async () => {
      if (!fixture) throw new Error("FIXTURE_MISSING");
      const tenantA = fixture.scope.ids["company-a"];
      // 正控：公司管理员的管理动作在真实表面可用。
      const workspaceId = fixture.scope.newTeamId();
      fixture.scope.registerCreatedTeam(workspaceId);
      const created = await fixture.scope.request("company-admin", {
        method: "POST",
        path: "/admin/teams",
        tenantId: tenantA,
        body: { name: "MT075 managed team", workspaceId },
      });
      expect(created.status).toBe(201);
      // 平台机器身份没有用户会话：公司管理入口拒绝（无隐式通过）。
      const machine = await fixture.scope.requestAnonymous({
        method: "POST",
        path: "/admin/teams",
        tenantId: tenantA,
        body: { name: "platform team" },
      });
      expect([401, 403]).toContain(machine.status);
    },
  );

  itDb(
    "AC3: completing a company management action grants no business-content read",
    async () => {
      if (!fixture) throw new Error("FIXTURE_MISSING");
      const tenantA = fixture.scope.ids["company-a"];
      const teamA1 = fixture.scope.ids["team-a1"];
      const targetPrincipal = fixture.scope.principalIdOf("a1-other");
      const adminService = fixture.scope.adminService();
      const adminContext = await fixture.scope.adminContextOf("company-admin");
      // 管理动作本身成功（管理权真实存在）。
      const suspended = await adminService.suspendTeamMember(adminContext, {
        workspaceId: teamA1,
        principalId: targetPrincipal,
      });
      expect(suspended.membership.status).toBe("suspended");
      expect(suspended.auditEventId.length).toBeGreaterThan(0);
      // 同一管理员经业务读通道（真实 resolver + reader）读不到被管理成员
      // 的私有资源：管理权不隐含内容读取权。
      const escalation = await fixture.scope.isolation.requestAs(
        "company-admin",
        {
          method: "GET",
          path: `/resources/${fixture.scope.ids["resource-a1-other"]}`,
          tenantId: tenantA,
          workspaceId: teamA1,
        },
      );
      expect([401, 403, 404]).toContain(escalation.status);
      // 正控：有资格的成员读团队共享资源仍然可用（拒绝是授权语义而非通道损坏）。
      const positive = await fixture.scope.isolation.requestAs("a1-member", {
        method: "GET",
        path: `/resources/${fixture.scope.ids["resource-a1"]}`,
        tenantId: tenantA,
        workspaceId: teamA1,
      });
      expect(positive.status).toBe(200);
    },
  );

  itDb(
    "AC3: the platform machine identity resolves no business session and holds no content grants",
    async () => {
      if (!fixture) throw new Error("FIXTURE_MISSING");
      const tenantA = fixture.scope.ids["company-a"];
      const teamA1 = fixture.scope.ids["team-a1"];
      // 平台操作身份没有业务会话：连范围都无法签发。
      const machine = await fixture.scope.isolation.requestAs(
        "platform-operator",
        {
          method: "GET",
          path: `/resources/${fixture.scope.ids["resource-a1"]}`,
          tenantId: tenantA,
          workspaceId: teamA1,
        },
      );
      expect([401, 403]).toContain(machine.status);
      // 目录证据：平台机器读角色对业务内容表零表级授权（对照：业务
      // operator 角色持有策略化授权）；运行时登录 URL 只登记三个业务角色。
      const catalog = await fixture.scope.isolation.queryRestricted(
        "operator",
        undefined,
        `select grantee, count(*)::int as grants
           from information_schema.role_table_grants
          where grantee in ('ob_ent_identity_operator', 'ob_ent_operator')
          group by grantee`,
        [],
      );
      const byGrantee = new Map(
        catalog.map((row) => [String(row.grantee), Number(row.grants)]),
      );
      expect(byGrantee.get("ob_ent_identity_operator") ?? 0).toBe(0);
      expect(byGrantee.get("ob_ent_operator") ?? 0).toBeGreaterThan(0);
      expect(Object.keys(ROLE_DATABASE_VARIABLES).sort()).toEqual([
        "data",
        "directory",
        "operator",
      ]);
    },
  );
});
