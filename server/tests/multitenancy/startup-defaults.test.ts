// server/tests/multitenancy/startup-defaults.test.ts
// MT123（Issue #166）：启动装配净化域——默认公司/默认线程标识/单用户绕过
// 的移除与 API 兼容回归。
//
// 验收事实源（Issue #166 四条 AC，逐条落用例）：
//   AC1 启动后不存在进程级可变"当前公司/团队"状态（有测试断言）
//       ——净化输出 defaultCompanyTenantId=null、默认线程标识不回落租户包
//       默认公司、输出深冻结赋值抛错；per-scope 线程身份随 scope 走
//       （公司 A a1/a2、公司 B 指纹互异、同 scope 稳定、每次调用新实例）。
//   AC2 单用户与开发绕过在多租户模式下不可用；单租户部署行为不变（回归）
//       ——多租户 devBypassMounted 恒 false + readiness 残留判定（config 与
//       env 双面）；单租户输出与 legacy 启动表达式逐字节同义。
//   AC3 API 路径、状态码与 DTO 能力对照测试通过
//       ——真实 createApp 双模式（单租户 vs 多租户+entryContext）注册路径
//       集合逐项相同；代表性无选择头请求状态码与 DTO 键集逐项相同；
//       多租户对带选择头请求按 canonical 码拒绝（装配半边仍生效）。
//   AC4 装配缺口会被就绪校验发现（与 MT013 一致）
//       ——四类缺口一次列全（entryContext 缺席/显式 DEPLOYMENT_ID 缺席/
//       singleUser 残留/env 残留）；verdict 恰好一条结构化记录、拒绝 exit(1)。
//
// 环境契约：纯函数组零 DB；DB 组只认显式专用企业测试库 env（TEST/SETUP/
// DIRECTORY/DATA/OPERATOR），缺配置整套显式 skip（跳过原因写在用例名里，
// skipped 不计为通过），绝不回退开发库。真实 PostgreSQL（受限角色 + RLS），
// 零授权 mock。

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createApp } from "../../src/app";
import { loadConfig } from "../../src/config";
import type { ResolvedRuntimeConfig } from "../../src/enterprise/tenancy/runtime-config";
import {
  applyStartupDefaultsVerdict,
  buildStartupDefaultsRecord,
  evaluateStartupAssemblyReadiness,
  resolveStartupDefaults,
  type StartupDefaultsFacts,
  scopeThreadIdentity,
} from "../../src/enterprise/tenancy/startup-defaults";
import { enterpriseTestDatabaseUrlFrom } from "../support/enterprise-database";
import { testEnvironment } from "../support/environment";
import {
  createEntryContextFixture,
  type EntryContextFixture,
} from "./support/entry-context";

// ---------------------------------------------------------------------------
// 环境探针（DB 组）：缺 env 显式 skip（带理由），绝不静默回退
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
      reason: `MT123 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
// 工具
// ---------------------------------------------------------------------------

/** 净化域输入的最小事实构造器：多租户、全备装配。 */
function facts(
  overrides: Partial<StartupDefaultsFacts> = {},
): StartupDefaultsFacts {
  return {
    multitenancy: true,
    deploymentId: "mt123-explicit-deployment",
    tenantPackageTenantId: "pkg-default-company",
    singleUser: false,
    entryContextWired: true,
    ...overrides,
  };
}

/** 严格模式赋值探针：深冻结对象的属性写入必须抛 TypeError。 */
function assignmentThrows(candidate: object, key: string): boolean {
  try {
    (candidate as Record<string, unknown>)[key] = "mt123-tampered";
    return false;
  } catch (error) {
    return error instanceof TypeError;
  }
}

/** MT013 同款注入面：log 是带 .info 的 logger 对象（捕获首参记录）。 */
function recordingLogger(into: unknown[]): {
  info: (message: unknown) => void;
} {
  return {
    info: (message: unknown) => {
      into.push(message);
    },
  };
}

/** Resolves to the thrown error message ("" when it did not throw). */
async function thrownMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 多租户模式 createApp 的装配环境（显式开关 + 显式 DEPLOYMENT_ID）。 */
function multitenancyEnvironment(): Record<string, string | undefined> {
  return testEnvironment({
    OPENBOT_MULTITENANCY: "on",
    DEPLOYMENT_ID: "mt123-mt-deployment",
  });
}

// ---------------------------------------------------------------------------
// AC1/AC2 — resolveStartupDefaults：净化与单租户回归（纯函数组）
// ---------------------------------------------------------------------------

describe("MT123 resolveStartupDefaults：多租户净化", () => {
  test("AC1: 多租户不保留默认公司——租户包 tenantId 在场也不是当前公司", () => {
    const defaults = resolveStartupDefaults(
      facts({ tenantPackageTenantId: "pkg-default-company" }),
    );
    expect(defaults.mode).toBe("multitenancy");
    expect(defaults.defaultCompanyTenantId).toBeNull();
  });

  test("AC1: 多租户默认线程标识不回落租户包——缺显式 DEPLOYMENT_ID 即 null", () => {
    const withoutDeployment = resolveStartupDefaults(
      facts({ deploymentId: undefined }),
    );
    expect(withoutDeployment.threadIdentitySeed).toBeNull();
    const withDeployment = resolveStartupDefaults(facts());
    expect(withDeployment.threadIdentitySeed).toBe("mt123-explicit-deployment");
  });

  test("AC2: 多租户单用户绕过恒不装配——singleUser 请求也被拒绝挂载", () => {
    const defaults = resolveStartupDefaults(facts({ singleUser: true }));
    expect(defaults.devBypassMounted).toBe(false);
  });

  test("AC1: 净化输出深冻结——顶层与字段写入一律抛 TypeError", () => {
    const defaults = resolveStartupDefaults(facts());
    expect(Object.isFrozen(defaults)).toBe(true);
    expect(assignmentThrows(defaults, "defaultCompanyTenantId")).toBe(true);
    expect(assignmentThrows(defaults, "threadIdentitySeed")).toBe(true);
    expect(assignmentThrows(defaults, "devBypassMounted")).toBe(true);
  });

  test("AC1: 纯函数不突变入参——同一事实两次解析输出逐字段相同", () => {
    const input = facts();
    const first = resolveStartupDefaults(input);
    const second = resolveStartupDefaults(input);
    expect(first).toEqual(second);
  });
});

describe("MT123 resolveStartupDefaults：单租户回归（行为不变）", () => {
  test("回归: 线程种子与 legacy 表达式逐字节同义（deploymentId ?? 租户包 tenantId）", () => {
    const withBoth = resolveStartupDefaults(
      facts({
        multitenancy: false,
        deploymentId: "legacy-deployment",
        tenantPackageTenantId: "legacy-package-company",
      }),
    );
    expect(withBoth.mode).toBe("single-tenant");
    expect(withBoth.threadIdentitySeed).toBe("legacy-deployment");
    expect(withBoth.defaultCompanyTenantId).toBe("legacy-package-company");

    const fallbackOnly = resolveStartupDefaults(
      facts({
        multitenancy: false,
        deploymentId: undefined,
        tenantPackageTenantId: "legacy-package-company",
      }),
    );
    expect(fallbackOnly.threadIdentitySeed).toBe("legacy-package-company");
  });

  test("回归: 单租户 devBypassMounted 跟随 config.singleUser（true 案例原样保留）", () => {
    const enabled = resolveStartupDefaults(
      facts({ multitenancy: false, singleUser: true }),
    );
    expect(enabled.devBypassMounted).toBe(true);
    const disabled = resolveStartupDefaults(
      facts({ multitenancy: false, singleUser: false }),
    );
    expect(disabled.devBypassMounted).toBe(false);
  });

  test("回归: 单租户输出同样深冻结（净化域契约对两种模式一致）", () => {
    const defaults = resolveStartupDefaults(facts({ multitenancy: false }));
    expect(Object.isFrozen(defaults)).toBe(true);
    expect(assignmentThrows(defaults, "defaultCompanyTenantId")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC4 — evaluateStartupAssemblyReadiness：装配缺口一次列全（纯函数组）
// ---------------------------------------------------------------------------

describe("MT123 evaluateStartupAssemblyReadiness：缺口发现", () => {
  test("AC4: 多租户全备装配 → ok", () => {
    const f = facts();
    const readiness = evaluateStartupAssemblyReadiness(f);
    expect(readiness.ok).toBe(true);
  });

  test("AC4: 四类缺口一次列全——entryContext/DEPLOYMENT_ID/singleUser/env 残留", () => {
    const f = facts({
      deploymentId: undefined,
      entryContextWired: false,
      singleUser: true,
      singleUserEnvRaw: "true",
      devNoAuthEnvRaw: "1",
    });
    const readiness = evaluateStartupAssemblyReadiness(f);
    expect(readiness.ok).toBe(false);
    if (readiness.ok) return;
    const sources = readiness.findings.map((finding) => finding.source);
    expect(sources).toContain("assembly.entryContext");
    expect(sources).toContain("config.deploymentId");
    expect(sources).toContain("config.singleUser");
    expect(sources).toContain("OPENBOT_SINGLE_USER");
    expect(sources).toContain("OPENBOT_DEV_NO_AUTH");
    // 一次列全：五个缺口同批返回，不是发现第一个就停。
    expect(readiness.findings.length).toBe(5);
    // 每条缺口都有可审计 detail。
    for (const finding of readiness.findings) {
      expect(finding.detail.length).toBeGreaterThan(0);
    }
  });

  test("AC4: 显式关闭的绕过 env 不算残留（与 MT013 residueValue 同口径）", () => {
    const f = facts({
      singleUserEnvRaw: "false",
      devNoAuthEnvRaw: "0",
    });
    const readiness = evaluateStartupAssemblyReadiness(f);
    expect(readiness.ok).toBe(true);
  });

  test("AC4: 多租户缺 entryContext 是缺口，即使其余全备", () => {
    const f = facts({ entryContextWired: false });
    const readiness = evaluateStartupAssemblyReadiness(f);
    expect(readiness.ok).toBe(false);
    if (readiness.ok) return;
    expect(readiness.findings.map((x) => x.source)).toEqual([
      "assembly.entryContext",
    ]);
  });

  test("AC2/回归: 单租户无就绪诉求——绕过开启与 env 残留都不阻断", () => {
    const f = facts({
      multitenancy: false,
      singleUser: true,
      singleUserEnvRaw: "true",
      devNoAuthEnvRaw: "true",
      entryContextWired: false,
    });
    const readiness = evaluateStartupAssemblyReadiness(f);
    expect(readiness.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC4 — verdict：恰好一条结构化记录，拒绝非 0 退出（MT013 同纪律）
// ---------------------------------------------------------------------------

describe("MT123 applyStartupDefaultsVerdict：记录与退出纪律", () => {
  test("AC4: 通过时恰好一条结构化记录，不退出", () => {
    const logged: unknown[] = [];
    let exits = 0;
    const f = facts();
    const defaults = resolveStartupDefaults(f);
    const readiness = evaluateStartupAssemblyReadiness(f);
    const record = buildStartupDefaultsRecord(defaults, readiness);
    applyStartupDefaultsVerdict(record, {
      log: recordingLogger(logged),
      exit: () => {
        exits += 1;
      },
    } as never);
    expect(logged.length).toBe(1);
    expect(exits).toBe(0);
    const written = logged[0] as Record<string, unknown>;
    expect(written.type).toBe("multitenancy-startup-defaults-validation");
    expect(written.mode).toBe("on");
    expect(written.accepted).toBe(true);
  });

  test("AC4: 拒绝时 exit(1) 恰好一次，记录携带全部缺口", () => {
    const logged: unknown[] = [];
    const exitCodes: number[] = [];
    const f = facts({ entryContextWired: false, singleUser: true });
    const defaults = resolveStartupDefaults(f);
    const readiness = evaluateStartupAssemblyReadiness(f);
    const record = buildStartupDefaultsRecord(defaults, readiness);
    applyStartupDefaultsVerdict(record, {
      log: recordingLogger(logged),
      exit: (code: number) => {
        exitCodes.push(code);
      },
    } as never);
    expect(exitCodes).toEqual([1]);
    const written = logged[0] as Record<string, unknown>;
    expect(written.accepted).toBe(false);
    const checks = written.checks as { findings: unknown[] };
    expect(checks.findings.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC1 — scopeThreadIdentity：per-scope 线程身份（纯函数组）
// ---------------------------------------------------------------------------

describe("MT123 scopeThreadIdentity：身份随 scope 走，无进程级共享", () => {
  const resolvedOf = (tenantId: string, workspaceId: string) =>
    ({
      scope: { tenantId, workspaceId },
      threadIdentitySeed: JSON.stringify([tenantId, workspaceId]),
    }) as ResolvedRuntimeConfig;

  test("AC1: 不同公司/团队的线程身份指纹互异——跨 scope 互不认领", () => {
    const a1 = scopeThreadIdentity(resolvedOf("company-a", "team-a1"));
    const b1 = scopeThreadIdentity(resolvedOf("company-b", "team-b1"));
    const mintedA1 = a1.mint();
    const mintedB1 = b1.mint();
    expect(mintedA1).not.toBe(mintedB1);
    expect(a1.owns(mintedB1)).toBe(false);
    expect(b1.owns(mintedA1)).toBe(false);
    expect(a1.owns(mintedA1)).toBe(true);
  });

  test("AC1: 同公司不同团队身份互异（a1 vs a2）——团队也不共用一枚指纹", () => {
    const a1 = scopeThreadIdentity(resolvedOf("company-a", "team-a1"));
    const a2 = scopeThreadIdentity(resolvedOf("company-a", "team-a2"));
    const mintedA1 = a1.mint();
    const mintedA2 = a2.mint();
    expect(mintedA1).not.toBe(mintedA2);
    expect(a2.owns(mintedA1)).toBe(false);
  });

  test("AC1: 同 scope 指纹稳定——两次解析的种子铸造可互相认领", () => {
    const first = scopeThreadIdentity(resolvedOf("company-a", "team-a1"));
    const second = scopeThreadIdentity(resolvedOf("company-a", "team-a1"));
    const minted = first.mint();
    expect(second.owns(minted)).toBe(true);
  });

  test("AC1: 每次调用新实例——不存在进程级共享可变身份对象", () => {
    const rc = resolvedOf("company-a", "team-a1");
    const first = scopeThreadIdentity(rc);
    const second = scopeThreadIdentity(rc);
    expect(first).not.toBe(second);
    // 一个实例的铸造不影响另一个实例（无共享计数器/缓存可变面）。
    const mintedFirst = first.mint();
    expect(second.owns(mintedFirst)).toBe(true); // 稳定性来自种子，不来自共享对象
    expect(first.mint()).not.toBe(mintedFirst);
  });
});

// ---------------------------------------------------------------------------
// DB 组 — 运行时装配：AC1 运行时断言 + AC3 双模式对照
// ---------------------------------------------------------------------------

interface Mt123World {
  fixture: EntryContextFixture;
  dispose: () => Promise<void>;
}

describeDb("MT123 运行时装配（专用库 + 受限角色 + RLS）", () => {
  let world: Mt123World | undefined;

  beforeAll(async () => {
    const fixture = await createEntryContextFixture();
    world = { fixture, dispose: () => fixture.dispose() };
  }, 60000);

  afterAll(async () => {
    await world?.dispose();
  });

  itDb(
    "环境是专用企业测试库（企业 setup URL 派生 + 受限 data 角色）",
    async () => {
      const identity = await world?.fixture.probeIdentity();
      // 库名 = 企业 setup URL 派生。MT 组在专用 MT 库上跑（tests/bun-suites 把
      // TEST_DATABASE_URL 换成 MT_TEST_DATABASE_URL），而夹具的 data 通道由
      // enterpriseRuntimeDatabaseUrlFrom 校验为与企业 setup 同库——断言必须取
      // 同一个真源，否则比较的是两个库名。
      expect(identity?.database).toBe(
        new URL(enterpriseTestDatabaseUrlFrom(process.env)).pathname.replace(
          /^\//,
          "",
        ),
      );
      expect(identity?.currentUser).toBe("ob_ent_data");
    },
  );

  itDb(
    "AC1: 真实 MT122 工厂解析的三类 scope 身份互异；同 scope 稳定；每请求新业务实例",
    async () => {
      const fixture = world?.fixture;
      if (!fixture) throw new Error("fixture missing");
      const factory = (
        await import("../../src/enterprise/tenancy/entry-context")
      ).createDeploymentEntryContextFactory;

      const businessRequest = (
        session: string,
        tenant: string,
        workspace: string,
      ): Request =>
        new Request("http://openbot.test/api/any", {
          headers: {
            "x-mt122-session": session,
            "x-openbot-tenant": tenant,
            "x-openbot-workspace": workspace,
          },
        });

      const entry = factory({
        directory: fixture.directory,
        data: fixture.data,
        authenticate: fixture.authenticate,
      });

      const a1 = await entry.fromRequest(
        businessRequest(fixture.userA, fixture.tenantA, fixture.teamA1),
      );
      const a2 = await entry.fromRequest(
        businessRequest(fixture.userA, fixture.tenantA, fixture.teamA2),
      );
      const b1 = await entry.fromRequest(
        businessRequest(fixture.userB, fixture.tenantB, fixture.teamB1),
      );

      const rcA1 = await a1.runtimeConfig();
      const rcA2 = await a2.runtimeConfig();

      const a1Identity = scopeThreadIdentity(rcA1);
      const a2Identity = scopeThreadIdentity(rcA2);

      const mintedA1 = a1Identity.mint();
      const mintedA2 = a2Identity.mint();

      // 两类 scope（公司 A 团队甲/乙）指纹互异，跨 scope 互不认领。
      expect(mintedA1).not.toBe(mintedA2);
      expect(a2Identity.owns(mintedA1)).toBe(false);

      // 公司 B 刻意无配置行（夹具设计）：scope 照常签发，但 runtimeConfig
      // 按 canonical 码拒绝——绝不回退默认公司配置（MT014 fail-closed 契约
      // 在净化域消费面上同样成立）。
      expect(await thrownMessage(b1.runtimeConfig())).toBe(
        "RUNTIME_CONFIG_NOT_FOUND",
      );

      // 同 scope 再解析一次：身份稳定（可认领），业务对象是新实例。
      const a1Again = await entry.fromRequest(
        businessRequest(fixture.userA, fixture.tenantA, fixture.teamA1),
      );
      const rcA1Again = await a1Again.runtimeConfig();
      expect(scopeThreadIdentity(rcA1Again).owns(mintedA1)).toBe(true);
      expect(a1Again).not.toBe(a1);
      expect(rcA1Again).not.toBe(rcA1);
    },
    60000,
  );

  // -------------------------------------------------------------------------
  // AC3 — 双模式真实 createApp 对照：路径/状态码/DTO 能力
  // -------------------------------------------------------------------------

  /**
   * 与 global-exceptions.test 同款装配缝：真实 createApp + 假 auth 会话。
   * 多租户 app 通过 coworker.entryContext 挂载 MT122 入口中间件（工厂由
   * 专用库夹具真实构造）——与 index.ts 的装配形状一致。
   */
  function appFor(options: {
    multitenancy?: boolean;
    entryContext?: unknown;
    session?: {
      user: { id: string; email: string; name: string; image: null };
    } | null;
  }) {
    const session =
      options.session === undefined
        ? {
            user: {
              id: "person",
              email: "person@openbot.test",
              name: "Person",
              image: null,
            },
          }
        : options.session;
    const args: unknown[] = new Array(createApp.length).fill(undefined);
    args[0] = loadConfig(
      options.multitenancy ? multitenancyEnvironment() : testEnvironment(),
    );
    args[1] = {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => session },
    };
    args[2] = { rolesForUser: async () => ["user"] };
    const COWORKER_ARG = 34;
    if (options.multitenancy) {
      args[COWORKER_ARG] = { entryContext: options.entryContext };
    }
    return createApp(...(args as never[]));
  }

  itDb(
    "AC3: 双模式注册路径集合逐项相同（method+path 多重集）",
    async () => {
      const fixture = world?.fixture;
      if (!fixture) throw new Error("fixture missing");
      const { createDeploymentEntryContextFactory } = await import(
        "../../src/enterprise/tenancy/entry-context"
      );
      const entry = createDeploymentEntryContextFactory({
        directory: fixture.directory,
        data: fixture.data,
        authenticate: fixture.authenticate,
      });

      const singleTenant = appFor({ multitenancy: false });
      const multiTenant = appFor({ multitenancy: true, entryContext: entry });

      const routeLines = (app: {
        routes: { method: string; path: string }[];
      }) => app.routes.map((route) => `${route.method} ${route.path}`);

      // API 路径对照：业务路由面（method+path 多重集）逐项相同。多租户 app
      // 多出的注册是恰好两枚 `ALL /api/*`——MT122 入口中间件与 MT125 旧
      // 入口守卫的挂载（两枚中间件自身不回答任何常规 API 路径，不是
      // API 面），单列断言。（MT123 交付时为一枚；MT125（Issue #168）按
      // 波次先例把计数从 +1 修订为 +2，断言文件其余内容只读。）
      const withoutEntryMount = (lines: string[]) =>
        lines.filter((line) => line !== "ALL /api/*").sort();
      expect(withoutEntryMount(routeLines(multiTenant))).toEqual(
        withoutEntryMount(routeLines(singleTenant)),
      );
      const countOf = (lines: string[], needle: string) =>
        lines.filter((line) => line === needle).length;
      expect(countOf(routeLines(multiTenant), "ALL /api/*")).toBe(
        countOf(routeLines(singleTenant), "ALL /api/*") + 2,
      );
    },
    60000,
  );

  itDb(
    "AC3: 代表性无选择头请求状态码与 DTO 键集逐项相同（/health /ready /api/me）",
    async () => {
      const fixture = world?.fixture;
      if (!fixture) throw new Error("fixture missing");
      const { createDeploymentEntryContextFactory } = await import(
        "../../src/enterprise/tenancy/entry-context"
      );
      const entry = createDeploymentEntryContextFactory({
        directory: fixture.directory,
        data: fixture.data,
        authenticate: fixture.authenticate,
      });

      const singleTenant = appFor({ multitenancy: false });
      const multiTenant = appFor({ multitenancy: true, entryContext: entry });

      for (const target of [
        "http://openbot.test/health",
        "http://openbot.test/ready",
        "http://openbot.test/api/me",
      ]) {
        const left = await singleTenant.request(target);
        const right = await multiTenant.request(target);
        expect(right.status, `${target} status`).toBe(left.status);
        const leftBody = (await left.json()) as Record<string, unknown>;
        const rightBody = (await right.json()) as Record<string, unknown>;
        expect(
          Object.keys(rightBody).sort(),
          `${target} DTO capability keys`,
        ).toEqual(Object.keys(leftBody).sort());
        // DTO 能力对照到值：/health /ready 的标量体与 /api/me 的身份字段
        // 在两模式下逐字段相同（既有 API 兼容的字面含义）。
        expect(rightBody).toEqual(leftBody);
      }
    },
    60000,
  );

  itDb(
    "AC3/MT122 半边: 多租户 app 携带选择头无会话 → canonical 401 拒绝；单租户同请求不受影响",
    async () => {
      const fixture = world?.fixture;
      if (!fixture) throw new Error("fixture missing");
      const { createDeploymentEntryContextFactory } = await import(
        "../../src/enterprise/tenancy/entry-context"
      );
      const entry = createDeploymentEntryContextFactory({
        directory: fixture.directory,
        data: fixture.data,
        authenticate: fixture.authenticate,
      });

      const multiTenant = appFor({ multitenancy: true, entryContext: entry });
      const singleTenant = appFor({ multitenancy: false });

      // 探针路径不在 MT030 全局例外登记表（/api/me/* 等例外由设计放行），
      // 也非企业前缀：携带选择头 + 无会话是入口中间件的拒绝半边。
      const target = "http://openbot.test/api/mt123-absent-probe";
      const headers = {
        "x-openbot-tenant": fixture.tenantA,
        "x-openbot-workspace": fixture.teamA1,
      };

      const mtResponse = await multiTenant.request(target, { headers });
      expect(mtResponse.status).toBe(401);
      const mtBody = (await mtResponse.json()) as {
        error: { code: string; message: string };
      };
      expect(mtBody.error.message).toBe("AUTH_REQUIRED");

      // 单租户没有入口中间件：选择头是被忽略的选择器，不是拒绝理由；
      // 未注册路径照常回答 Hono 默认 404。
      const stResponse = await singleTenant.request(target, { headers });
      expect(stResponse.status).toBe(404);
    },
    60000,
  );
});
