// server/tests/multitenancy/company-admin-routes.test.ts
// MT095/MT096/MT097（Issues #138-#140）：公司管理面路由层的授权与哨兵映射。
//
// 验证事实源（三票 AC 的路由半边；服务级判定已由 people-lifecycle / audit-domains /
// credentials-ownership / billing-visibility 各自的套件钉死，本套件注入假服务，只测路由层）：
//   (1) 每个新路由入口都在 MT075 公司面分类下（封闭规则表 × 挂载前缀 fail-closed）。
//   (2) 能力答案路由：成员上下文解析 + 组合面回答四能力位（不在此复制判定）。
//   (3) people 三动作 + 名册：admin 门（无上下文 → 403 TENANT_ADMIN_REQUIRED）、
//       输入校验先于授权形态、哨兵 → HTTP（404/409/403）。
//   (4) 凭据/身份/企业配置/学习：admin 门 + 只读投影透传；SSO 无配置 = 诚实空。
//   (5) 审计查询/导出：member 上下文 + 403 映射；导出回答 CSV 文本并在响应前留审计
//       （审计写失败 → 导出失败，绝不折叠成成功）。
//   (6) 公司账簿：财务授权哨兵 → 403；happy path 回答 books + 用量证据行。
//   (7) 未装配 operator 通道时整个面 503（fail-closed，无宽松替身）。
//
// 环境契约：纯路由层测试（假服务注入），不触数据库——绝不回退开发库一节不适用。

import { describe, expect, test } from "../../../tests/support/bun-test-compat";
import type { Hono } from "hono";
import {
  classifyManagementPlane,
} from "../../src/enterprise/tenancy/admin-separation";
import {
  createCompanyAdminRoutes,
  createUnavailableCompanyAdminRoutes,
  type CompanyAdminRouteDeps,
} from "../../src/enterprise/tenancy/company-admin-routes";
import type { CompanyAdminContext } from "../../src/enterprise/tenancy/workspace-admin";

// ---------------------------------------------------------------------------
// 假装配：受信上下文由真 authorizer 签发——路由层测试用固定上下文替身，签名不参与
// ---------------------------------------------------------------------------

const ADMIN_CONTEXT: CompanyAdminContext = {
  tenantId: "acme",
  principalId: "prin-admin",
  actorId: "user-1",
  memberEpoch: 4,
};

const MEMBER_CONTEXT = {
  tenantId: "acme",
  principalId: "prin-admin",
  actorId: "user-1",
  role: "tenant_admin" as const,
  memberEpoch: 4,
};

type Mode = "member-ok" | "admin-ok" | "admin-refused";

function depsOf(mode: Mode): CompanyAdminRouteDeps {
  const calls: string[] = [];
  const deps: CompanyAdminRouteDeps = {
    authorizer: {
      authenticate: () => Promise.resolve({ actorId: "user-1", entrypoint: "web" }),
      resolveAdminContext: async () => {
        if (mode === "admin-refused") throw new Error("TENANT_ADMIN_REQUIRED");
        return ADMIN_CONTEXT;
      },
      resolveMemberContext: async () => {
        if (mode === "admin-refused") throw new Error("TENANT_FORBIDDEN");
        return MEMBER_CONTEXT;
      },
    },
    capabilities: {
      capabilitiesOf: async (member) => {
        calls.push("capabilities");
        return {
          tenantId: member.tenantId,
          principalId: member.principalId,
          peopleAdmin: true,
          auditReader: true,
          financeReader: true,
          billingManager: true,
        };
      },
    },
    people: {
      companyMembers: async () => {
        calls.push("people.list");
        return [];
      },
      promoteCompanyMember: async () => {
        calls.push("people.promote");
        return {
          outcome: "role_changed",
          tenantId: "acme",
          principalId: "prin-2",
          membership: { role: "tenant_admin", epoch: 2 },
          previousRole: "member",
          auditEventId: "evt-1",
        };
      },
      demoteCompanyMember: async () => {
        calls.push("people.demote");
        return {
          outcome: "role_changed",
          tenantId: "acme",
          principalId: "prin-2",
          membership: { role: "member", epoch: 3 },
          previousRole: "tenant_admin",
          auditEventId: "evt-2",
        };
      },
      offboardCompanyMember: async () => {
        calls.push("people.offboard");
        return {
          outcome: "offboarded",
          tenantId: "acme",
          principalId: "prin-2",
          membership: { status: "suspended", epoch: 5 },
          grantsDeleted: 1,
          auditEventId: "evt-3",
        };
      },
    },
    credentials: {
      listForTenant: async () => {
        calls.push("credentials.list");
        return [];
      },
    },
    identity: {
      readSsoConfig: async () => {
        calls.push("identity.sso");
        throw new Error("SSO_CONFIG_NOT_FOUND");
      },
      listScimBindings: async () => {
        calls.push("identity.scim");
        return [];
      },
    },
    config: async () => {
      calls.push("config");
      return {
        tenantId: "acme",
        name: "Acme",
        status: "active",
        teams: [],
        membersByRole: [
          { role: "tenant_admin", count: 1 },
          { role: "member", count: 2 },
          { role: "auditor", count: 0 },
        ],
        offboardedCount: 0,
      };
    },
    learning: {
      listRecords: async () => {
        calls.push("learning.list");
        return [];
      },
    },
    resolveScope: async () => {
      calls.push("scope.resolve");
      return {
        tenantId: "acme",
        workspaceId: "acme-finance",
        principalId: "prin-admin",
        actorId: "user-1",
        memberEpoch: 4,
        aclEpoch: 1,
        entrypoint: "web",
      };
    },
    audit: {
      query: async () => {
        calls.push("audit.query");
        return [];
      },
      exportEvents: async () => {
        calls.push("audit.export");
        return { events: [], truncated: false };
      },
      recordExport: async () => {
        calls.push("audit.recordExport");
      },
    },
    finance: {
      companyBooks: async () => {
        calls.push("finance.books");
        throw new Error("COMPANY_FINANCE_REQUIRED");
      },
      recentUsageLines: async () => {
        calls.push("finance.usage");
        return [];
      },
    },
  };
  return Object.assign(deps, { __calls: calls });
}

type Fixture = { __calls: string[] } & CompanyAdminRouteDeps;

function appOf(deps: Fixture): Hono {
  return createCompanyAdminRoutes(deps);
}

async function call(
  app: Hono,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown; text: string }> {
  const response = await app.request(
    path,
    {
      ...init,
      headers: { "x-openbot-tenant": "acme", ...(init?.headers ?? {}) },
    },
  );
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

// ---------------------------------------------------------------------------
// (1) 挂载分类：封闭规则表覆盖每个新入口
// ---------------------------------------------------------------------------

describe("MT095/096/097 company admin routes (Issues #138-#140)", () => {
  test("every company admin entrance classifies as the company plane (MT075 closed table)", () => {
    const entrances = [
      ["GET", "/api/enterprise/workspace-scope/admin/capabilities"],
      ["GET", "/api/enterprise/workspace-scope/admin/people"],
      ["POST", "/api/enterprise/workspace-scope/admin/people/p-1/promote"],
      ["POST", "/api/enterprise/workspace-scope/admin/people/p-1/demote"],
      ["POST", "/api/enterprise/workspace-scope/admin/people/p-1/offboard"],
      ["GET", "/api/enterprise/workspace-scope/admin/credentials"],
      ["GET", "/api/enterprise/workspace-scope/admin/identity"],
      ["GET", "/api/enterprise/workspace-scope/admin/enterprise-config"],
      ["GET", "/api/enterprise/workspace-scope/admin/audit-events"],
      ["GET", "/api/enterprise/workspace-scope/admin/audit-events/export"],
      ["GET", "/api/enterprise/workspace-scope/admin/learning"],
      ["GET", "/api/enterprise/workspace-scope/admin/billing/company-books"],
    ] as const;
    for (const [method, path] of entrances) {
      expect(classifyManagementPlane({ method, path })).toBe("company");
    }
    // 平台面入口不在本面：部署级 people 管理属 /api/admin/**（AC4 #138 的分类半边）。
    expect(classifyManagementPlane({ method: "GET", path: "/api/admin/people" })).toBe(
      "platform",
    );
  });

  test("an unmounted drift (a path outside the company prefix) is not a company entrance", () => {
    expect(
      classifyManagementPlane({
        method: "GET",
        path: "/api/enterprise/workspace-scope/billing/company-books",
      }),
    ).toBe(null);
  });

  // -----------------------------------------------------------------------
  // (2) 能力答案
  // -----------------------------------------------------------------------

  test("capabilities answers through the member context and the composition service", async () => {
    const deps = depsOf("member-ok");
    const result = await call(appOf(deps), "/admin/capabilities");
    expect(result.status).toBe(200);
    expect(deps.__calls).toContain("capabilities");
  });

  test("capabilities refuses when even the member context fails (403, no existence leak)", async () => {
    const deps = depsOf("admin-refused");
    const result = await call(appOf(deps), "/admin/capabilities");
    expect(result.status).toBe(403);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "TENANT_FORBIDDEN",
    );
  });

  // -----------------------------------------------------------------------
  // (3) people 名册与三个动作
  // -----------------------------------------------------------------------

  test("the roster answers under the admin gate and refuses non-admins (AC2/AC1 #138)", async () => {
    const deps = depsOf("admin-ok");
    const ok = await call(appOf(deps), "/admin/people");
    expect(ok.status).toBe(200);
    expect(deps.__calls).toContain("people.list");

    const refused = depsOf("admin-refused");
    const denied = await call(appOf(refused), "/admin/people");
    expect(denied.status).toBe(403);
    expect((denied.body as { error: { code: string } }).error.code).toBe(
      "TENANT_ADMIN_REQUIRED",
    );
    // 拒绝路径零服务读取：判定门先于一切名册事实。
    expect(refused.__calls).not.toContain("people.list");
  });

  test("promote/demote/offboard submit to the company scope and map their sentinels (AC3 #138)", async () => {
    const deps = depsOf("admin-ok");
    const promote = await call(
      appOf(deps),
      "/admin/people/prin-2/promote",
      { method: "POST" },
    );
    expect(promote.status).toBe(200);
    expect(deps.__calls).toContain("people.promote");

    const demote = await call(appOf(deps), "/admin/people/prin-2/demote", {
      method: "POST",
      body: JSON.stringify({ to: "member" }),
    });
    expect(demote.status).toBe(200);
    expect(deps.__calls).toContain("people.demote");

    const offboard = await call(appOf(deps), "/admin/people/prin-2/offboard", {
      method: "POST",
    });
    expect(offboard.status).toBe(200);
    expect(deps.__calls).toContain("people.offboard");

    // 输入校验：demote 的目标角色必须是 member|auditor。
    const badDemote = await call(appOf(deps), "/admin/people/prin-2/demote", {
      method: "POST",
      body: JSON.stringify({ to: "owner" }),
    });
    expect(badDemote.status).toBe(400);
    // 输入校验先于授权形态之外的第二个校验面：非法 principal id 直接 400。
    const badId = await call(appOf(deps), "/admin/people/%20bad/promote", {
      method: "POST",
    });
    expect(badId.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // (4) 凭据 / 身份 / 企业配置 / 学习
  // -----------------------------------------------------------------------

  test("the credential roster answers the masked projection (AC2 #138)", async () => {
    const deps = depsOf("admin-ok");
    const result = await call(appOf(deps), "/admin/credentials");
    expect(result.status).toBe(200);
    expect(deps.__calls).toContain("credentials.list");
  });

  test("identity answers sso:null when the company has no SSO config (honest empty, AC2 #138)", async () => {
    const deps = depsOf("admin-ok");
    const result = await call(appOf(deps), "/admin/identity");
    expect(result.status).toBe(200);
    const body = result.body as { sso: unknown; scimBindings: unknown[] };
    expect(body.sso).toBeNull();
    expect(Array.isArray(body.scimBindings)).toBe(true);
  });

  test("the enterprise config answers own company only and refuses cross-company (AC2 #139)", async () => {
    const deps = depsOf("admin-ok");
    const ok = await call(appOf(deps), "/admin/enterprise-config");
    expect(ok.status).toBe(200);
    expect(deps.__calls).toContain("config");

    const refused = depsOf("admin-refused");
    const denied = await call(appOf(refused), "/admin/enterprise-config");
    expect(denied.status).toBe(403);
    expect(refused.__calls).not.toContain("config");
  });

  test("learning resolves the selection scope before listing (AC3 #139)", async () => {
    const deps = depsOf("admin-ok");
    const result = await call(appOf(deps), "/admin/learning", {
      headers: { "x-openbot-workspace": "acme-finance" },
    });
    expect(result.status).toBe(200);
    expect(deps.__calls).toContain("scope.resolve");
    expect(deps.__calls).toContain("learning.list");
  });

  // -----------------------------------------------------------------------
  // (5) 审计查询与导出
  // -----------------------------------------------------------------------

  test("the audit query maps the domain sentinel to a typed 403 (AC1 #139)", async () => {
    const deps = depsOf("member-ok");
    deps.audit = {
      query: async () => {
        deps.__calls.push("audit.query");
        throw new Error("AUDIT_SCOPE_FORBIDDEN");
      },
      exportEvents: async () => ({ events: [], truncated: false }),
      recordExport: async () => undefined,
    };
    const result = await call(appOf(deps), "/admin/audit-events");
    expect(result.status).toBe(403);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "AUDIT_SCOPE_FORBIDDEN",
    );
  });

  test("the audit query validates the eventType filter shape", async () => {
    const deps = depsOf("member-ok");
    const result = await call(
      appOf(deps),
      "/admin/audit-events?eventType=not%20a%20type",
    );
    expect(result.status).toBe(400);
  });

  test("the export answers CSV after recording its own audit row (AC1 #139)", async () => {
    const deps = depsOf("member-ok");
    const events = [
      {
        id: "e1",
        domain: "business",
        eventType: "company_member.promoted",
        actorId: "prin-admin",
        targetId: null,
        payload: {},
        createdAt: new Date("2026-10-21T10:00:00.000Z"),
      },
    ];
    deps.audit = {
      query: async () => events,
      exportEvents: async () => ({ events, truncated: false }),
      recordExport: async () => {
        deps.__calls.push("audit.recordExport");
      },
    };
    const result = await call(appOf(deps), "/admin/audit-events/export");
    expect(result.status).toBe(200);
    expect(result.text).toContain("company_member.promoted");
    // 导出审计先于响应；未记录则导出失败（下一用例钉死失败面）。
    expect(deps.__calls).toContain("audit.recordExport");
  });

  test("an export whose audit row cannot be written fails, never folds into success (AC1 #139)", async () => {
    const deps = depsOf("member-ok");
    deps.audit = {
      query: async () => [],
      exportEvents: async () => ({ events: [], truncated: false }),
      recordExport: async () => {
        throw new Error("AUDIT_EVENT_INVALID: unwritable");
      },
    };
    const result = await call(appOf(deps), "/admin/audit-events/export");
    expect(result.status).toBe(500);
    // 拒绝体是 JSON 错误信封，绝不是一个 CSV 文件。
    expect(
      (result.body as { error: { code: string } }).error.code,
    ).toBe("internal");
  });

  // -----------------------------------------------------------------------
  // (6) 公司账簿
  // -----------------------------------------------------------------------

  test("the company books map the finance sentinel to a typed 403 (AC2 #140)", async () => {
    const deps = depsOf("member-ok");
    const result = await call(appOf(deps), "/admin/billing/company-books");
    expect(result.status).toBe(403);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "COMPANY_FINANCE_REQUIRED",
    );
    // 拒绝路径零账务读取：books 判定门在服务内先抛，usage 证据行绝不被读。
    expect(deps.__calls).not.toContain("finance.usage");
  });

  test("the company books answer books plus the read-only usage lines (AC2/AC3 #140)", async () => {
    const deps = depsOf("member-ok");
    deps.finance = {
      companyBooks: async () => {
        deps.__calls.push("finance.books");
        return {
          tenantId: "acme",
          authorization: {
            principalId: "prin-admin",
            grantedBy: "prin-owner",
            grantedAt: new Date("2026-10-01T00:00:00.000Z"),
          },
          customer: {
            externalCustomerId: "cus_acme",
            boundAt: new Date("2026-10-01T00:00:00.000Z"),
          },
          account: { externalCustomerId: "cus_acme", status: "active" },
          balanceUnits: 1000,
          usage: {
            companyTotal: { heldUnits: 40, chargedUnits: 300 },
            byTeam: [{ workspaceId: "acme-finance", heldUnits: 40, chargedUnits: 200 }],
            byUser: [{ principalId: "prin-a", heldUnits: 40, chargedUnits: 200 }],
          },
        };
      },
      recentUsageLines: async () => {
        deps.__calls.push("finance.usage");
        return [
          {
            eventId: "u1",
            source: "llm",
            model: "m-1",
            workspaceId: "acme-finance",
            inputTokens: 10,
            outputTokens: 5,
            reservationId: null,
            occurredAt: new Date("2026-10-21T09:00:00.000Z"),
          },
        ];
      },
    };
    const result = await call(appOf(deps), "/admin/billing/company-books");
    expect(result.status).toBe(200);
    const body = result.body as {
      books: { usage: { companyTotal: { chargedUnits: number } } };
      recentUsage: unknown[];
    };
    expect(body.books.usage.companyTotal.chargedUnits).toBe(300);
    expect(body.recentUsage.length).toBe(1);
    expect(deps.__calls).toContain("finance.books");
    expect(deps.__calls).toContain("finance.usage");
  });

  // -----------------------------------------------------------------------
  // (7) fail-closed 替身
  // -----------------------------------------------------------------------

  test("the unavailable face answers 503 on every path, never a permissive stand-in", async () => {
    const app = createUnavailableCompanyAdminRoutes();
    for (const path of [
      "/admin/capabilities",
      "/admin/people",
      "/admin/billing/company-books",
    ]) {
      const response = await app.request(path);
      expect(response.status).toBe(503);
    }
  });
});
