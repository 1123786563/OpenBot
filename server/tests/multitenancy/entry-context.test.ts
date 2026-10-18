// server/tests/multitenancy/entry-context.test.ts
// MT122（Issue #165）：部署主入口请求上下文 + 作用域工厂。
//
// 验收事实源（brief 四条 AC，逐条落用例）：
//   AC1 每个入口建立上下文；缺上下文的业务请求拒绝而非落默认范围
//       （fail-closed，无 default tenant）——拒绝码矩阵 + 中间件显式选择
//       失败拒绝 + requireEntryBusiness 消费拒绝。
//   AC2 业务依赖来自作用域工厂，不来自启动时单份配置（每请求按上下文构造）
//       ——双上下文差异 + 每请求新实例 + 无配置行 RUNTIME_CONFIG_NOT_FOUND。
//   AC3 上下文建立方式与企业入口、流式入口一致（共享实现，非第三套复制）
//       ——同一 createScopeResolver 构造、同一签发 WeakSet、拒绝码同串。
//   AC4 普通业务事务不跨外部网络等待——globalThis.fetch 包装计数 = 0。
//
// 环境契约：只认显式专用企业测试库 env（TEST/SETUP/DIRECTORY/DATA/OPERATOR）；
// 缺配置整套显式 skip（跳过原因写在用例名里，skipped 不计为通过），绝不回退
// 开发库。真实 PostgreSQL（三受限角色 + RLS），零授权 mock。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  createDeploymentEntryContextFactory,
  createDeploymentEntryContextMiddleware,
  type DeploymentEntryBusiness,
  requireEntryBusiness,
} from "../../src/enterprise/tenancy/entry-context";
import {
  assertTrustedScope,
  createScopeResolver,
} from "../../src/enterprise/tenancy/store";
import {
  createEntryContextFixture,
  type EntryContextFixture,
} from "./support/entry-context";

// ---------------------------------------------------------------------------
// 环境探针：缺 env 显式 skip（带理由），绝不静默回退
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
      reason: `MT122 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

// ---------------------------------------------------------------------------
// 工具：错误消息串、fetch 包装计数、探针应用
// ---------------------------------------------------------------------------

/** Resolves to the thrown error message ("" when it did not throw). */
async function thrownMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The error of a synchronous throw, or "" when it did not throw. */
function thrownMessageSync(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * AC4 证据（测试包装口径）：包装 globalThis.fetch 计数执行期间的外呼次数。
 * 计数期间任何拨号都被拒绝并计数，结束恢复原实现。
 */
async function countFetchDials(fn: () => Promise<void>): Promise<number> {
  const original = globalThis.fetch;
  let dials = 0;
  globalThis.fetch = ((_input, _init) => {
    dials += 1;
    return Promise.reject(new Error("NETWORK_DIAL_REFUSED_BY_TEST"));
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return dials;
}

/** 带命中探针的业务路由：中间件之后注册（装配同序），消费入口接缝。 */
function makeProbeApp(
  factory: ReturnType<typeof createDeploymentEntryContextFactory>,
) {
  const hits: string[] = [];
  const app = new Hono();
  app.use("/api/*", createDeploymentEntryContextMiddleware(factory));
  app.post("/api/business/probe", async (context) => {
    hits.push("business");
    try {
      const business = requireEntryBusiness(
        context.get("entryBusiness") as DeploymentEntryBusiness | undefined,
      );
      return context.json({ ok: true, scope: business.scope });
    } catch (error) {
      // 探针用 500 显式呈现拒绝码（Hono 默认 500 不携带错误文本）。
      return context.json(
        {
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        },
        500,
      );
    }
  });
  app.get("/api/capabilities", (context) => {
    hits.push("capabilities");
    return context.json({
      ok: true,
      entryBusiness: context.get("entryBusiness") ?? null,
    });
  });
  app.get("/api/enterprise/teams", (context) => {
    hits.push("enterprise");
    return context.json({
      ok: true,
      entryBusiness: context.get("entryBusiness") ?? null,
    });
  });
  return { app, hits };
}

/** 入口选择头 + 会话头的标准业务请求（同一路径，AC2 的"同一请求路径"）。 */
function businessRequest(options: {
  session?: string;
  tenant?: string;
  workspace?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (options.session) headers["x-mt122-session"] = options.session;
  if (options.tenant) headers["x-openbot-tenant"] = options.tenant;
  if (options.workspace) headers["x-openbot-workspace"] = options.workspace;
  return new Request("http://mt122.test/api/business/probe", { headers });
}

describeDb("MT122 deployment entry request context (issue #165)", () => {
  let fixture: EntryContextFixture;
  let factory: ReturnType<typeof createDeploymentEntryContextFactory>;

  beforeAll(async () => {
    if (!ENV.ok) return;
    fixture = await createEntryContextFixture();
    factory = createDeploymentEntryContextFactory({
      directory: fixture.directory,
      data: fixture.data,
      authenticate: fixture.authenticate,
    });
  }, 60000);

  afterAll(async () => {
    await fixture?.dispose();
  });

  // -------------------------------------------------------------------------
  // 环境：专用库 + 受限通道在位
  // -------------------------------------------------------------------------

  itDb("environment is the dedicated enterprise test database", async () => {
    const identity = await fixture.probeIdentity();
    // 库名带本树 brief 的 w15b 令牌（RECTIFIED 微修：波次 14 集成令牌
    // w14int → w15b_test，环境令牌语义不变——专库+受限 data 角色+绝不回
    // 退开发库；处置依据 wave14-integration §4-2 / MT073-brief 同款先例，
    // 双哈希披露于 checkpoints/MT060/verification/02-rectified-*.txt）。
    expect(identity.database).toBe("openbot_enterprise_w15b_test");
    expect(identity.currentUser).toBe("ob_ent_data");
  });

  // -------------------------------------------------------------------------
  // AC1：每入口建立上下文；缺上下文拒绝、无默认范围
  // -------------------------------------------------------------------------

  itDb(
    "AC1: a member selecting a real company and team gets a trusted scope and per-context business dependencies",
    async () => {
      const business = await factory.fromRequest(
        businessRequest({
          session: fixture.userA,
          tenant: fixture.tenantA,
          workspace: fixture.teamA1,
        }),
      );
      // 受信 scope：企业入口同一 assertTrustedScope 判定（AC3 共享签发）。
      expect(() => assertTrustedScope(business.scope)).not.toThrow();
      expect(business.scope.tenantId).toBe(fixture.tenantA);
      expect(business.scope.workspaceId).toBe(fixture.teamA1);
      expect(business.scope.actorId).toBe(fixture.userA);
      expect(business.scope.entrypoint).toBe("web");
      // 作用域工厂业务依赖：公司 A 配置解析成功（per-context，见 AC2 组）。
      const resolved = await business.runtimeConfig();
      expect(resolved.model.defaultModel).toBe("gpt-4o");
    },
  );

  itDb(
    "AC1: a signed-in user without a tenant selection is refused, never defaulted",
    async () => {
      const message = await thrownMessage(
        factory.fromRequest(businessRequest({ session: fixture.userA })),
      );
      expect(message).toBe("TENANT_REQUIRED");
    },
  );

  itDb(
    "AC1: a tenant selection without a workspace selection is refused, never defaulted",
    async () => {
      const message = await thrownMessage(
        factory.fromRequest(
          businessRequest({ session: fixture.userA, tenant: fixture.tenantA }),
        ),
      );
      expect(message).toBe("WORKSPACE_REQUIRED");
    },
  );

  itDb(
    "AC1: selecting a company the caller never joined is TENANT_FORBIDDEN",
    async () => {
      const message = await thrownMessage(
        factory.fromRequest(
          businessRequest({
            session: fixture.userA,
            tenant: fixture.tenantB,
            workspace: fixture.teamB1,
          }),
        ),
      );
      expect(message).toBe("TENANT_FORBIDDEN");
    },
  );

  itDb(
    "AC1: a company-a member selecting company B's team is WORKSPACE_FORBIDDEN",
    async () => {
      const message = await thrownMessage(
        factory.fromRequest(
          businessRequest({
            session: fixture.userA,
            tenant: fixture.tenantA,
            workspace: fixture.teamB1,
          }),
        ),
      );
      expect(message).toBe("WORKSPACE_FORBIDDEN");
    },
  );

  itDb(
    "AC1: the entry middleware refuses a request whose explicit selection fails and the business handler is never reached",
    async () => {
      const { app, hits } = makeProbeApp(factory);
      const response = await app.request("/api/business/probe", {
        method: "POST",
        headers: {
          "x-mt122-session": fixture.userA,
          "x-openbot-tenant": fixture.tenantB,
          "x-openbot-workspace": fixture.teamB1,
        },
      });
      // 显式选择失败 → canonical 码拒绝（*_FORBIDDEN → 403），绝不落默认处理。
      expect(response.status).toBe(403);
      const body = (await response.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.message).toBe("TENANT_FORBIDDEN");
      // 业务 handler 未达。
      expect(hits).toEqual([]);
    },
  );

  itDb(
    "AC1: a business consumer without an established context is refused (ENTRY_CONTEXT_REQUIRED), not served defaults",
    async () => {
      // 唯一读取面 fail-closed：未建立即拒，不存在默认依赖路径。
      expect(thrownMessageSync(() => requireEntryBusiness(undefined))).toBe(
        "ENTRY_CONTEXT_REQUIRED",
      );
      expect(thrownMessageSync(() => requireEntryBusiness(null))).toBe(
        "ENTRY_CONTEXT_REQUIRED",
      );
      // 结构证据：无选择头的请求穿过中间件（legacy 放行），业务路由此刻消费
      // 接缝只能拿到未建立上下文 → 拒绝，而非默认服务。
      const { app, hits } = makeProbeApp(factory);
      const response = await app.request("/api/business/probe", {
        method: "POST",
      });
      expect(response.status).toBe(500);
      expect(hits).toEqual(["business"]);
      const text = await response.text();
      expect(text).toContain("ENTRY_CONTEXT_REQUIRED");
    },
  );

  // -------------------------------------------------------------------------
  // AC2：业务依赖来自作用域工厂（每请求按上下文构造）
  // -------------------------------------------------------------------------

  itDb(
    "AC2: the same request path resolves different configuration for different scopes (company policy vs team override)",
    async () => {
      const onTeamA1 = await factory.fromRequest(
        businessRequest({
          session: fixture.userA,
          tenant: fixture.tenantA,
          workspace: fixture.teamA1,
        }),
      );
      const onTeamA2 = await factory.fromRequest(
        businessRequest({
          session: fixture.userA,
          tenant: fixture.tenantA,
          workspace: fixture.teamA2,
        }),
      );
      const companyPolicy = await onTeamA1.runtimeConfig();
      const teamOverride = await onTeamA2.runtimeConfig();
      // 公司默认模型 vs 团队收窄覆盖：同一请求路径、不同上下文、不同配置。
      expect(companyPolicy.model.defaultModel).toBe("gpt-4o");
      expect(teamOverride.model.defaultModel).toBe("gpt-4o-mini");
      expect(companyPolicy.botDefaults.defaultAgentId).toBe("agent-a-support");
      expect(teamOverride.botDefaults.defaultAgentId).toBe("agent-a-finance");
    },
  );

  itDb(
    "AC2: two requests for the same scope each construct their own dependency object (per-request, not a startup singleton)",
    async () => {
      const request = () =>
        factory.fromRequest(
          businessRequest({
            session: fixture.userA,
            tenant: fixture.tenantA,
            workspace: fixture.teamA1,
          }),
        );
      const first = await request();
      const second = await request();
      // 每请求新实例：依赖对象与签发 scope 都是新对象（值相等、身份不同）。
      expect(first).not.toBe(second);
      expect(first.scope).not.toBe(second.scope);
      expect(first.scope).toEqual(second.scope);
    },
  );

  itDb(
    "AC2: a scope with no company config row is refused (RUNTIME_CONFIG_NOT_FOUND), never defaulted",
    async () => {
      // 公司 B：真实成员、真实团队、刻意无配置行。
      const business = await factory.fromRequest(
        businessRequest({
          session: fixture.userB,
          tenant: fixture.tenantB,
          workspace: fixture.teamB1,
        }),
      );
      const message = await thrownMessage(business.runtimeConfig());
      expect(message).toBe("RUNTIME_CONFIG_NOT_FOUND");
    },
  );

  itDb(
    "AC2: a revoked team membership is refused by the next business transaction (in-transaction revalidation)",
    async () => {
      const business = await factory.fromRequest(
        businessRequest({
          session: fixture.userA,
          tenant: fixture.tenantA,
          workspace: fixture.teamA1,
        }),
      );
      // 上下文签发后团队资格被翻转：下一次业务事务（gate 内两级重验）拒绝。
      await fixture.setWorkspaceMembershipStatus(
        fixture.tenantA,
        fixture.teamA1,
        business.scope.principalId,
        "suspended",
      );
      const message = await thrownMessage(
        business.transaction(async (tx) => {
          await tx.execute(sql`select 1`);
        }),
      );
      expect(message).toBe("WORKSPACE_REVOKED");
      // 恢复资格：同一上下文的下一次事务重新可用（重验按当前数据库事实）。
      await fixture.setWorkspaceMembershipStatus(
        fixture.tenantA,
        fixture.teamA1,
        business.scope.principalId,
        "active",
      );
      const committed = await business.transaction(async (tx) => {
        const rows = (await tx.execute(sql`select 1 as one`)) as unknown;
        const list = Array.isArray(rows)
          ? rows
          : ((rows as { rows?: unknown[] })?.rows ?? []);
        return list.length;
      });
      expect(committed).toBe(1);
    },
  );

  // -------------------------------------------------------------------------
  // AC4：普通业务事务不跨外部网络等待（测试包装证据；静态扫描另有存档）
  // -------------------------------------------------------------------------

  itDb(
    "AC2/AC4: business transactions ride the MT005 gate and commit with zero external network dials",
    async () => {
      const business = await factory.fromRequest(
        businessRequest({
          session: fixture.userA,
          tenant: fixture.tenantA,
          workspace: fixture.teamA1,
        }),
      );
      let dials = 0;
      let committed = 0;
      dials = await countFetchDials(async () => {
        committed = await business.transaction(async (tx) => {
          const rows = (await tx.execute(sql`select 1 as one`)) as unknown;
          const list = Array.isArray(rows)
            ? rows
            : ((rows as { rows?: unknown[] })?.rows ?? []);
          return list.length;
        });
      });
      // 事务提交成功，且执行期间零外呼。
      expect(committed).toBe(1);
      expect(dials).toBe(0);
    },
  );

  itDb(
    "AC4: runtimeConfig() also performs no external network dials",
    async () => {
      const business = await factory.fromRequest(
        businessRequest({
          session: fixture.userA,
          tenant: fixture.tenantA,
          workspace: fixture.teamA1,
        }),
      );
      let dials = 0;
      let defaultModel = "";
      dials = await countFetchDials(async () => {
        const resolved = await business.runtimeConfig();
        defaultModel = resolved.model.defaultModel;
      });
      expect(defaultModel).toBe("gpt-4o");
      expect(dials).toBe(0);
    },
  );

  // -------------------------------------------------------------------------
  // AC3：上下文建立方式与企业入口一致（共享实现，非第三套复制）
  // -------------------------------------------------------------------------

  itDb(
    "AC3: factory scopes pass the enterprise entry's assertTrustedScope; forged scopes fail it",
    async () => {
      const business = await factory.fromRequest(
        businessRequest({
          session: fixture.userA,
          tenant: fixture.tenantA,
          workspace: fixture.teamA1,
        }),
      );
      // 同一签发 WeakSet：工厂 scope 过企业入口同一信任判定。
      expect(() => assertTrustedScope(business.scope)).not.toThrow();
      // 克隆脱离签发集合：同一判定即拒（UNVERIFIED_SCOPE，seam 自己的串）。
      const forged = { ...business.scope };
      expect(thrownMessageSync(() => assertTrustedScope(forged))).toBe(
        "UNVERIFIED_SCOPE",
      );
    },
  );

  itDb(
    "AC3: the refusal codes are the shared seam's own strings, identical to what the enterprise entry maps",
    async () => {
      // 企业入口自己的 resolver（同一构造函数、同一 authenticate 闭包、
      // 同一选择头语义）与工厂两半对同一批坏请求给出同一批码。
      const enterpriseScopes = createScopeResolver(fixture.directory, {
        authenticate: fixture.authenticate,
        selectTenant: (request) => request.headers.get("x-openbot-tenant"),
        selectWorkspace: (request) =>
          request.headers.get("x-openbot-workspace"),
      });
      const scenarios = [
        {
          name: "no session",
          request: businessRequest({
            tenant: fixture.tenantA,
            workspace: fixture.teamA1,
          }),
        },
        {
          name: "session without tenant",
          request: businessRequest({ session: fixture.userA }),
        },
        {
          name: "tenant without workspace",
          request: businessRequest({
            session: fixture.userA,
            tenant: fixture.tenantA,
          }),
        },
        {
          name: "company never joined",
          request: businessRequest({
            session: fixture.userA,
            tenant: fixture.tenantB,
            workspace: fixture.teamB1,
          }),
        },
        {
          name: "foreign team under own company",
          request: businessRequest({
            session: fixture.userA,
            tenant: fixture.tenantA,
            workspace: fixture.teamB1,
          }),
        },
      ];
      for (const scenario of scenarios) {
        const viaEnterprise = await thrownMessage(
          enterpriseScopes.resolve(scenario.request),
        );
        const viaFactoryHttp = await thrownMessage(
          factory.fromRequest(
            businessRequest({
              session:
                scenario.request.headers.get("x-mt122-session") ?? undefined,
              tenant:
                scenario.request.headers.get("x-openbot-tenant") ?? undefined,
              workspace:
                scenario.request.headers.get("x-openbot-workspace") ??
                undefined,
            }),
          ),
        );
        // 同一 seam 字符串：企业入口与部署主入口拒绝码逐字相同。
        expect(viaFactoryHttp).toBe(viaEnterprise);
        expect(viaEnterprise).not.toBe("");
      }
      // canonical 码 → 状态映射（与企业入口错误面同族：401/400/403）。
      // 注意中间件只在携选择头时建立：仅会话（无选择）不是显式选择，走
      // legacy 放行（AC1 的入口级拒绝只对显式选择生效）。
      const { app } = makeProbeApp(factory);
      const status = async (headers: Record<string, string>) => {
        const response = await app.request("/api/business/probe", {
          method: "POST",
          headers,
        });
        const body = (await response.json()) as {
          error: { message: string };
        };
        return { status: response.status, message: body.error.message };
      };
      expect(await status({ "x-openbot-tenant": fixture.tenantA })).toEqual({
        status: 401,
        message: "AUTH_REQUIRED",
      });
      expect(
        await status({
          "x-mt122-session": fixture.userA,
          "x-openbot-tenant": fixture.tenantA,
        }),
      ).toEqual({ status: 400, message: "WORKSPACE_REQUIRED" });
      expect(
        await status({
          "x-mt122-session": fixture.userA,
          "x-openbot-workspace": fixture.teamA1,
        }),
      ).toEqual({ status: 400, message: "TENANT_REQUIRED" });
      expect(
        await status({
          "x-mt122-session": fixture.userA,
          "x-openbot-tenant": fixture.tenantB,
          "x-openbot-workspace": fixture.teamB1,
        }),
      ).toEqual({ status: 403, message: "TENANT_FORBIDDEN" });
      expect(
        await status({
          "x-mt122-session": fixture.userA,
          "x-openbot-tenant": fixture.tenantA,
          "x-openbot-workspace": fixture.teamB1,
        }),
      ).toEqual({ status: 403, message: "WORKSPACE_FORBIDDEN" });
    },
  );

  // -------------------------------------------------------------------------
  // 内部入口：服务器持久化身份建立（entrypoint=schedule）；机器身份拒绝
  // -------------------------------------------------------------------------

  itDb(
    "internal entry: a server-persisted identity establishes context with entrypoint schedule and context-bound dependencies",
    async () => {
      const business = await factory.fromInternalIdentity({
        actorId: fixture.userA,
        tenantId: fixture.tenantA,
        workspaceId: fixture.teamA1,
      });
      expect(() => assertTrustedScope(business.scope)).not.toThrow();
      expect(business.scope.entrypoint).toBe("schedule");
      expect(business.scope.actorId).toBe(fixture.userA);
      // 上下文绑定的依赖：公司 A 配置随上下文解析。
      const resolved = await business.runtimeConfig();
      expect(resolved.model.defaultModel).toBe("gpt-4o");
    },
  );

  itDb(
    "internal entry: a machine identity without membership is refused (TENANT_FORBIDDEN), never granted a business scope",
    async () => {
      // 机器身份：持久化身份在库、无任何成员资格——每次建立仍走同一 DB 重验。
      const message = await thrownMessage(
        factory.fromInternalIdentity({
          actorId: fixture.machineUserId,
          tenantId: fixture.tenantA,
          workspaceId: fixture.teamA1,
        }),
      );
      expect(message).toBe("TENANT_FORBIDDEN");
    },
  );

  itDb(
    "internal entry: a persisted identity cannot select another company's tenant (membership re-verified against the database)",
    async () => {
      const message = await thrownMessage(
        factory.fromInternalIdentity({
          actorId: fixture.userA,
          tenantId: fixture.tenantB,
          workspaceId: fixture.teamB1,
        }),
      );
      expect(message).toBe("TENANT_FORBIDDEN");
    },
  );

  itDb(
    "machine context: a request without a user session is never mapped to a business scope over HTTP",
    async () => {
      // 无会话（authenticate → null）→ AUTH_REQUIRED，绝不映射到业务 scope。
      const message = await thrownMessage(
        factory.fromRequest(
          businessRequest({
            tenant: fixture.tenantA,
            workspace: fixture.teamA1,
          }),
        ),
      );
      expect(message).toBe("AUTH_REQUIRED");
    },
  );

  // -------------------------------------------------------------------------
  // 中间件放行面：全局例外 / 企业前缀 / 无选择头（legacy）
  // -------------------------------------------------------------------------

  itDb(
    "the middleware leaves the enterprise entry's own context establishment alone",
    async () => {
      const { app, hits } = makeProbeApp(factory);
      const selectionHeaders = {
        "x-mt122-session": fixture.userA,
        "x-openbot-tenant": fixture.tenantA,
        "x-openbot-workspace": fixture.teamA1,
      };
      // 全局例外登记面（MT030 R5）：显式例外放行，不建立上下文。
      const capabilities = await app.request("/api/capabilities", {
        headers: selectionHeaders,
      });
      expect(capabilities.status).toBe(200);
      expect(
        ((await capabilities.json()) as { entryBusiness: unknown })
          .entryBusiness,
      ).toBeNull();
      // 企业前缀：企业入口自建上下文（同一共享签发），中间件不插手。
      const enterprise = await app.request("/api/enterprise/teams", {
        headers: selectionHeaders,
      });
      expect(enterprise.status).toBe(200);
      expect(
        ((await enterprise.json()) as { entryBusiness: unknown }).entryBusiness,
      ).toBeNull();
      // 无选择头：legacy 业务面照旧放行（迁移属 MT125），不建立上下文。
      const legacy = await app.request("/api/business/probe", {
        method: "POST",
      });
      expect(legacy.status).toBe(500); // 探针消费接缝被 fail-closed 拒绝
      expect(hits).toEqual(["capabilities", "enterprise", "business"]);
    },
  );
});
