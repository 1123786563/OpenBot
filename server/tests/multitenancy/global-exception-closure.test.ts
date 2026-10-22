// server/tests/multitenancy/global-exception-closure.test.ts
// MT127（Issue #170）：全局登录、健康检查与平台静态目录例外登记闭合。
//
// 验收事实源（Issue #170 验收 1–4，逐条对应 describe）：
//   (1) 例外清单完整，每项有理由、责任人与验证方式——登记表与验证表互相
//       闭合（缺行/幽灵行/无效行/证据缺失都是缺口）。
//   (2) 未登记端点访问业务数据时被拒绝（反向测试）——真实 MT122 中间件 +
//       requireEntryBusiness 缝三方向钉死：未登记无选择头拒绝 / 未登记显式
//       选择建立（归属上下文是显式的）/ 登记项结构上永远拿不到业务上下文。
//   (3) 全局端点不返回任何公司私有内容——MT030 已钉 /health /ready
//       /api/capabilities /api/me 与匿名 401 形；本票补齐 settings 双面的
//       已认证形状（真实 createApp + 假 store 钉「只碰会话自己的行」）。
//   (4) 就绪校验在例外登记不完整时失败——评估器与启动编排两半。
//
// 环境契约：纯内存/内存 app，不触库（中间件半边用桩工厂——工厂的数据库
// 行为由 MT122 套件覆盖，此处钉的是中间件判定表）。

import { Hono } from "hono";
import { describe, expect, test } from "../../../tests/support/bun-test-compat";
import { createApp } from "../../src/app";
import { loadConfig } from "../../src/config";
import {
  createDeploymentEntryContextMiddleware,
  type DeploymentEntryBusiness,
  type DeploymentEntryContextFactory,
  requireEntryBusiness,
} from "../../src/enterprise/tenancy/entry-context";
import {
  evaluateGlobalExceptionClosure,
  GLOBAL_EXCEPTION_VERIFICATIONS,
  type GlobalExceptionVerification,
} from "../../src/enterprise/tenancy/global-exception-closure";
import {
  GLOBAL_EXCEPTION_ENTRIES,
  type GlobalExceptionEntrance,
  type GlobalExceptionEntry,
} from "../../src/enterprise/tenancy/global-exceptions";
import { runMultitenancyStartupChecks } from "../../src/enterprise/tenancy/startup-checks";
import { testEnvironment } from "../support/environment";

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

/** 业务清单（无平台/身份全局端点）：闭包评估应通过，供反例测试做基底。 */
const BUSINESS_ENTRANCES: readonly GlobalExceptionEntrance[] = [
  {
    method: "GET",
    path: "/api/agents",
    kind: "route",
    businessClosure: "agents",
  },
  {
    method: "POST",
    path: "/api/channels",
    kind: "route",
    businessClosure: "conversation",
  },
];

function platformEntrance(
  overrides: Partial<GlobalExceptionEntrance> = {},
): GlobalExceptionEntrance {
  return {
    method: "GET",
    path: "/api/platform-new",
    kind: "route",
    businessClosure: "platform",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC1 — 登记表与验证表互相闭合（每项有理由、责任人与验证方式）
// ---------------------------------------------------------------------------

describe("MT127 例外登记闭合：登记与验证互相闭合", () => {
  test("真实两表对业务清单成立：ok，verified 覆盖全部登记项（13 项逐个在册）", () => {
    const evaluation = evaluateGlobalExceptionClosure({
      entries: GLOBAL_EXCEPTION_ENTRIES,
      verifications: GLOBAL_EXCEPTION_VERIFICATIONS,
      entrances: BUSINESS_ENTRANCES,
    });
    expect(evaluation.ok).toBe(true);
    expect(evaluation.findings).toEqual([]);
    expect([...evaluation.verified].sort()).toEqual(
      [...GLOBAL_EXCEPTION_ENTRIES.map((entry) => entry.id)].sort(),
    );
  });

  test("验证表缺一行 → VERIFICATION_MISSING，点名缺的登记项（AC4 前半）", () => {
    const evaluation = evaluateGlobalExceptionClosure({
      entries: GLOBAL_EXCEPTION_ENTRIES,
      verifications: GLOBAL_EXCEPTION_VERIFICATIONS.filter(
        (row) => row.entryId !== "health",
      ),
      entrances: BUSINESS_ENTRANCES,
    });
    expect(evaluation.ok).toBe(false);
    const missing = evaluation.findings.find(
      (finding) => finding.code === "VERIFICATION_MISSING",
    );
    expect(missing?.detail).toContain('"health"');
  });

  test("验证表幽灵行（引用不存在的登记项）→ VERIFICATION_GHOST", () => {
    const ghost: GlobalExceptionVerification = {
      entryId: "retired-endpoint",
      method: "bun test nowhere.test.ts",
      evidenceFiles: ["server/tests/multitenancy/nothing.test.ts"],
      pin: "stale",
    };
    const evaluation = evaluateGlobalExceptionClosure({
      entries: GLOBAL_EXCEPTION_ENTRIES,
      verifications: [...GLOBAL_EXCEPTION_VERIFICATIONS, ghost],
      entrances: BUSINESS_ENTRANCES,
    });
    expect(evaluation.ok).toBe(false);
    expect(
      evaluation.findings.some(
        (finding) =>
          finding.code === "VERIFICATION_GHOST" &&
          finding.detail.includes("retired-endpoint"),
      ),
    ).toBe(true);
  });

  test("验证行形状缺 method/pin/evidenceFiles → VERIFICATION_INVALID；重复行同码点名", () => {
    const invalid = [
      { entryId: "health", method: "  ", evidenceFiles: ["a.ts"], pin: "p" },
      {
        entryId: "ready",
        method: "bun test x",
        evidenceFiles: [],
        pin: "p",
      },
      { entryId: "me", method: "bun test x", evidenceFiles: ["a.ts"], pin: "" },
    ] as unknown as GlobalExceptionVerification[];
    const evaluation = evaluateGlobalExceptionClosure({
      entries: GLOBAL_EXCEPTION_ENTRIES.slice(0, 1),
      verifications: [
        ...invalid,
        // 重复行：同一登记项两行合法形状 → duplicate。
        {
          entryId: "health",
          method: "bun test x",
          evidenceFiles: ["a.ts"],
          pin: "p",
        },
        {
          entryId: "health",
          method: "bun test y",
          evidenceFiles: ["b.ts"],
          pin: "q",
        },
      ],
      entrances: BUSINESS_ENTRANCES,
    });
    const invalidFindings = evaluation.findings.filter(
      (finding) => finding.code === "VERIFICATION_INVALID",
    );
    // ready/me 缺验证行会同时报 MISSING，这里只数 INVALID 的三行形状 + 一行重复。
    expect(invalidFindings.length).toBe(4);
    expect(
      invalidFindings.some((finding) => finding.detail.includes("duplicate")),
    ).toBe(true);
  });

  test("证据文件谓词判缺 → VERIFICATION_EVIDENCE_MISSING（登记与验证不许漂移）", () => {
    const evaluation = evaluateGlobalExceptionClosure({
      entries: GLOBAL_EXCEPTION_ENTRIES,
      verifications: GLOBAL_EXCEPTION_VERIFICATIONS,
      entrances: BUSINESS_ENTRANCES,
      evidenceExists: (file) => !file.includes("global-exceptions.test.ts"),
    });
    expect(evaluation.ok).toBe(false);
    const missingEvidence = evaluation.findings.filter(
      (finding) => finding.code === "VERIFICATION_EVIDENCE_MISSING",
    );
    expect(missingEvidence.length).toBeGreaterThan(0);
    expect(missingEvidence[0].detail).toContain("global-exceptions.test.ts");
  });

  test("MT030 的闭包方向原样并入：平台闭包未登记入口 → UNREGISTERED_GLOBAL", () => {
    const evaluation = evaluateGlobalExceptionClosure({
      entries: GLOBAL_EXCEPTION_ENTRIES,
      verifications: GLOBAL_EXCEPTION_VERIFICATIONS,
      entrances: [...BUSINESS_ENTRANCES, platformEntrance()],
    });
    expect(evaluation.ok).toBe(false);
    expect(
      evaluation.findings.some(
        (finding) =>
          finding.code === "UNREGISTERED_GLOBAL" &&
          finding.detail.includes("/api/platform-new"),
      ),
    ).toBe(true);
  });

  test("登记项缺理由 → MT030 形状拒绝经闭合层透传（ENTRY_INVALID）", () => {
    const entryMissingReason = GLOBAL_EXCEPTION_ENTRIES.map((entry) =>
      entry.id === "health"
        ? ({ ...entry, reason: "" } as GlobalExceptionEntry)
        : entry,
    );
    const evaluation = evaluateGlobalExceptionClosure({
      entries: entryMissingReason,
      verifications: GLOBAL_EXCEPTION_VERIFICATIONS,
      entrances: BUSINESS_ENTRANCES,
    });
    expect(
      evaluation.findings.some(
        (finding) =>
          finding.code === "ENTRY_INVALID" && finding.detail.includes("health"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2 — 未登记端点访问业务数据时被拒绝（反向测试：真实中间件 + 真实缝）
// ---------------------------------------------------------------------------

/** 桩工厂：只服务于中间件判定表（工厂的数据库行为是 MT122 套件的事）。 */
function stubFactory(
  business: DeploymentEntryBusiness,
): DeploymentEntryContextFactory {
  return {
    fromRequest: async () => business,
    fromInternalIdentity: async () => business,
  };
}

describe("MT127 运行时反向：未登记端点访问业务数据被拒绝", () => {
  const business = {
    scope: { marker: "scoped" },
    runtimeConfig: async () => ({ marker: "runtime" }),
    transaction: async () => ({ marker: "tx" }),
  } as unknown as DeploymentEntryBusiness;

  function closureApp() {
    const app = new Hono();
    app.use(
      "/api/*",
      createDeploymentEntryContextMiddleware(stubFactory(business)),
    );
    // 一个未登记业务端点：经 requireEntryBusiness 读业务依赖，返回
    // {established, error}——中间件给了上下文才读得到。
    app.get("/api/unregistered-business", (context) => {
      try {
        requireEntryBusiness(
          context.get("entryBusiness") as DeploymentEntryBusiness | undefined,
        );
        return context.json({ established: true });
      } catch (error) {
        return context.json({
          established: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    // 登记项（/api/me）：回显是否被建立了业务上下文。
    app.get("/api/me", (context) =>
      context.json({ entryBusiness: context.get("entryBusiness") ?? null }),
    );
    return app;
  }

  test("未登记端点 + 无选择头：中间件放行但不建立上下文 → 业务读取 ENTRY_CONTEXT_REQUIRED", async () => {
    const response = await closureApp().request(
      "http://openbot.test/api/unregistered-business",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      established: boolean;
      error?: string;
    };
    expect(body.established).toBe(false);
    expect(body.error).toBe("ENTRY_CONTEXT_REQUIRED");
  });

  test("未登记端点 + 显式选择头：上下文建立，业务读取按显式归属进行（归属是显式输入，不是端点隐含）", async () => {
    const response = await closureApp().request(
      "http://openbot.test/api/unregistered-business",
      {
        headers: {
          "x-openbot-tenant": "company-a",
          "x-openbot-workspace": "team-a1",
        },
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { established: boolean };
    expect(body.established).toBe(true);
  });

  test("登记项（GET /api/me）：结构上永远拿不到业务上下文——全局例外与业务读取互斥", async () => {
    const plain = await closureApp().request("http://openbot.test/api/me");
    expect(
      ((await plain.json()) as { entryBusiness: unknown }).entryBusiness,
    ).toBeNull();
    // 即便带上选择头：全局例外先于选择判定放行，全局端点永远不是业务入口。
    const withHeaders = await closureApp().request(
      "http://openbot.test/api/me",
      {
        headers: { "x-openbot-tenant": "company-a" },
      },
    );
    expect(
      ((await withHeaders.json()) as { entryBusiness: unknown }).entryBusiness,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC3 — 全局端点不返回任何公司私有内容（MT030 之外的已认证形状补全）
// ---------------------------------------------------------------------------

const SESSION = {
  user: {
    id: "person",
    email: "person@openbot.test",
    name: "Person",
    image: null,
  },
};

/** 与 MT030 同款装配缝：真实 createApp + 假会话（+ 按探针定位的 store 槽）。 */
function appFor(
  options: {
    session?: typeof SESSION | null;
    userPreferences?: {
      read: (id: string) => Promise<unknown>;
      patch: (id: string, patch: unknown) => Promise<unknown>;
    };
    userInstructions?: {
      read: (id: string) => Promise<string | null>;
      write: (id: string, text: string) => Promise<string>;
    };
  } = {},
) {
  const session = options.session === undefined ? SESSION : options.session;
  const args: unknown[] = new Array(60).fill(undefined);
  args[0] = loadConfig(testEnvironment());
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: { getSession: async () => session },
  };
  args[2] = { rolesForUser: async () => ["user"] };
  if (options.userPreferences) args[31] = options.userPreferences;
  if (options.userInstructions) args[24] = options.userInstructions;
  return createApp(...(args as never[]));
}

describe("MT127 内容边界补全：settings 双面只碰会话自己的行", () => {
  test("GET /api/settings/preferences 只返回自己的偏好文档，store 收到的键就是会话 actor id", async () => {
    let readFor: string | null = null;
    const app = appFor({
      userPreferences: {
        read: async (id) => {
          readFor = id;
          return { messageListEmphasis: "agent" };
        },
        patch: async () => ({}),
      },
    });
    const response = await app.request(
      "http://openbot.test/api/settings/preferences",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      preferences: Record<string, unknown>;
    };
    expect(Object.keys(body)).toEqual(["preferences"]);
    expect(readFor).toBe("person");
    const serialized = JSON.stringify(body).toLowerCase();
    for (const banned of ["tenant", "workspace", "company", "membership"]) {
      expect(serialized.includes(banned)).toBe(false);
    }
  });

  test("PATCH /api/settings/preferences 只写自己的文档（strict 键集拒绝未知键）", async () => {
    let patchedFor: { id: string; patch: unknown } | null = null;
    const app = appFor({
      userPreferences: {
        read: async () => ({}),
        patch: async (id, patch) => {
          patchedFor = { id, patch };
          return { messageListEmphasis: "agent" };
        },
      },
    });
    const accepted = await app.request(
      "http://openbot.test/api/settings/preferences",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selfHostBannerDismissed: true }),
      },
    );
    expect(accepted.status).toBe(200);
    expect(patchedFor?.id).toBe("person");
    expect(patchedFor?.patch).toEqual({ selfHostBannerDismissed: true });
    // 未知键（包括任何公司/租户形态的键）是 400，不是静默存储。
    const refused = await app.request(
      "http://openbot.test/api/settings/preferences",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: "company-a" }),
      },
    );
    expect(refused.status).toBe(400);
  });

  test("GET /api/settings/instructions 只返回自己的常设指令文本；PUT 只写自己的行", async () => {
    let readFor: string | null = null;
    let writeFor: { id: string; text: string } | null = null;
    const app = appFor({
      userInstructions: {
        read: async (id) => {
          readFor = id;
          return "answer in the caller's own words";
        },
        write: async (id, text) => {
          writeFor = { id, text };
          return text;
        },
      },
    });
    const read = await app.request(
      "http://openbot.test/api/settings/instructions",
    );
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { instructions: string };
    expect(Object.keys(readBody)).toEqual(["instructions"]);
    expect(readFor).toBe("person");

    const write = await app.request(
      "http://openbot.test/api/settings/instructions",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instructions: "be terse" }),
      },
    );
    expect(write.status).toBe(200);
    expect(writeFor).toEqual({ id: "person", text: "be terse" });
  });

  test("无 store 的部署：settings 双面回答结构性 503 错误形状——不降级、不泄露", async () => {
    const app = appFor();
    const preferences = await app.request(
      "http://openbot.test/api/settings/preferences",
    );
    expect(preferences.status).toBe(503);
    expect(Object.keys((await preferences.json()) as object)).toEqual([
      "error",
    ]);
    const instructions = await app.request(
      "http://openbot.test/api/settings/instructions",
    );
    expect(instructions.status).toBe(503);
    expect(Object.keys((await instructions.json()) as object)).toEqual([
      "error",
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC4 — 就绪校验在例外登记不完整时失败（启动编排半边）
// ---------------------------------------------------------------------------

describe("MT127 就绪半边：globalExceptions 检查消费闭合评估器", () => {
  function inventoryJson(entrances: readonly GlobalExceptionEntrance[]) {
    return JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-10-22T00:00:00.000Z",
      entrances: entrances.map((entrance, _index) => ({
        id: `${entrance.method} ${entrance.path}`,
        entrance: `${entrance.method} ${entrance.path}`,
        method: entrance.method,
        path: entrance.path,
        kind: entrance.kind,
        type: "http",
        businessClosure: entrance.businessClosure,
        ownerTicket: "MT000",
        status: "owned",
      })),
      summary: { serveUpgradeBranches: 0, serveUpgradeEntrances: 0 },
      assemblies: [],
    });
  }

  test("业务清单 + 真实证据文件在库：globalExceptions 与 machinePersonalExceptions 双通过", async () => {
    const record = await runMultitenancyStartupChecks(
      {
        inventoryPath: "memory://inventory",
        singleUser: false,
      },
      {
        readTextFile: async () => inventoryJson(BUSINESS_ENTRANCES),
        createDatabase: (() => {
          throw new Error("no DB in this test");
        }) as never,
      },
    );
    expect(record.checks.globalExceptions.ok).toBe(true);
    if (record.checks.globalExceptions.ok) {
      expect(record.checks.globalExceptions.registered.length).toBe(
        GLOBAL_EXCEPTION_ENTRIES.length,
      );
    }
    expect(record.checks.machinePersonalExceptions.ok).toBe(true);
  });

  test("平台闭包出现未登记全局端点：globalExceptions 经闭合层拒绝并列出该入口（启动失败半边）", async () => {
    const record = await runMultitenancyStartupChecks(
      {
        inventoryPath: "memory://inventory",
        singleUser: false,
      },
      {
        readTextFile: async () =>
          inventoryJson([...BUSINESS_ENTRANCES, platformEntrance()]),
        createDatabase: (() => {
          throw new Error("no DB in this test");
        }) as never,
      },
    );
    expect(record.checks.globalExceptions.ok).toBe(false);
    if (!record.checks.globalExceptions.ok) {
      expect(record.checks.globalExceptions.reason).toContain(
        "global exception closure validation failed",
      );
      expect(
        record.checks.globalExceptions.findings.some(
          (finding) =>
            finding.code === "UNREGISTERED_GLOBAL" &&
            finding.detail.includes("/api/platform-new"),
        ),
      ).toBe(true);
    }
    expect(record.accepted).toBe(false);
  });
});
