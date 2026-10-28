// server/tests/multitenancy/package-lifecycle-boundary.test.ts
// MOD16（Issue #636，根 #620）：插件包安装版本与运行 pin 的边界钉。
//
// 本套件是 package 生命周期缝的源级/值级钉，native 形（e2e-compat、根入口
// 收集、manifest 零触碰）。行为底座仍是既有 package 族（install-routes/
// artifact/catalogue/…）与 marketplace-routes 9 用例，本套件不重复其行为，
// 只补计划 §1.D 的六组钉：
//
//   D1  A 出口等价：plugin-packages/public.ts 恰 5 符号、与 runtime.ts 源同
//       identity（re-export 同绑定）。
//   D2  门面委托恒等：BotCatalog.softDeleteBot + ToolAccess 四 delegate =
//       转发 + 参数透传 + 返回值/错误实例恒等。
//   D3  验收① 钉：重复安装收敛源级钉（幂等唯一索引名 + replay created:false
//       路径）+ 失败诚实性钉（changes 表写入点恰在事务成功路径；503
//       PACKAGE_STORAGE_UNAVAILABLE 合同）。
//   D4  验收② 钉：install 路径零写 skills/bots 表（insert 目标面源扫）+
//       links 仅存 id+revision（schema 形状钉）+ experts.ts 直建路径已知
//       缺口钉（恰 1 处 + 防扩散）。
//   D5  改道等价：runs/service.ts import 恰 1 处且经 public；marketplace/
//       routes.ts 零 profile-store/plugins-store 直 import；装配注入点经门面。
//   D6  （不在本文件）存量族两侧对照按计划 §3 验证门执行，读数落
//       reports/mod16-verification/commands.md 台账。
//
// 全部用例不落数据库：源扫描用 node:fs 读源文本，行为用合成 stub（同
// bot-catalog-public / tool-access-public 的替身形），DB 面由既有
// install.integration / package 族件覆盖。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../../tests/support/e2e-compat";
import { createBotCatalog } from "../../src/agents/public";
import * as publicModule from "../../src/enterprise/plugin-packages/public";
import * as runtimeModule from "../../src/enterprise/plugin-packages/runtime";

const srcDir = fileURLToPath(new URL("../../src", import.meta.url));
const readSrc = (rel: string) => readFileSync(`${srcDir}/${rel}`, "utf8");

const RUN_PIN_SYMBOLS = [
  "PackageRuntime",
  "PreparePackageRunInput",
  "PackageRunPinSnapshot",
  "PinnedSkillSummary",
] as const;

describe("MOD16 D1：plugin-packages/public.ts 出口等价（恰 5 符号、同 identity）", () => {
  test("值导出恰 createPackageRuntime 一个，且与 runtime.ts 原件同一绑定", () => {
    expect(Object.keys(publicModule).sort()).toEqual(["createPackageRuntime"]);
    expect(publicModule.createPackageRuntime).toBe(
      runtimeModule.createPackageRuntime,
    );
  });

  test("类型导出恰运行 pin 面 4 符号，无服务面/出口面外符号", () => {
    const source = readSrc("enterprise/plugin-packages/public.ts");
    const valueExports = [...source.matchAll(/export \{([^}]+)\} from/g)]
      .flatMap((m) => m[1].split(",").map((n) => n.trim()))
      .filter((n) => !n.startsWith("type "));
    const typeExports = [...source.matchAll(/export type \{([^}]+)\} from/g)]
      .flatMap((m) => m[1].split(",").map((n) => n.trim()))
      .filter(Boolean);
    expect(valueExports).toEqual(["createPackageRuntime"]);
    expect([...typeExports].sort()).toEqual([...RUN_PIN_SYMBOLS].sort());
    expect(source).not.toContain("export *"); // 恰 5 符号即服务面零出口（验收④）
  });
});

describe("MOD16 D2：门面 delegate 恒等（转发 + 透传 + 恒等返回值）", () => {
  test("BotCatalog.softDeleteBot 恒等委托 profileStore.softDelete", async () => {
    const calls: unknown[][] = [];
    const actor = { id: "actor-1", role: "member" };
    const catalog = createBotCatalog({
      profileStore: {
        create: async () => {
          throw new Error("not driven");
        },
        softDelete: async (a, id) => {
          calls.push([a, id]);
        },
      },
      teamBots: { publish: async () => {}, unpublish: async () => {} },
    });
    await catalog.softDeleteBot(actor as never, "bot-9");
    expect(calls).toEqual([[actor, "bot-9"]]); // 同一 actor 对象透传，非拷贝
  });

  test("ToolAccess 四 delegate 恒等委托 store 同名函数（参数/返回值/错误实例）", async () => {
    const installInput = {
      slug: "s",
      title: "t",
      summary: "m",
      instructions: "i",
      by: "u",
    };
    const ownerAnswer = "owner-7";
    const grantError = new Error("GRANT_REFUSED");
    const seen: Record<string, unknown[]> = {};
    const store = {
      listServers: async () => [],
      connectionsFor: async () => [],
      brokeredConnectionsFor: async () => [],
      sharedConnections: async () => [],
      listForAgent: async () => ({ tools: [], skills: [] }),
      callTool: async () => ({ text: "", isError: false }),
      installSkill: async (input: unknown) => {
        seen.installSkill = [input];
      },
      uninstallSkill: async (slug: unknown, by: unknown) => {
        seen.uninstallSkill = [slug, by];
      },
      skillOwner: async (slug: unknown) => {
        seen.skillOwner = [slug];
        return ownerAnswer;
      },
      grant: async (...args: unknown[]) => {
        seen.grant = args;
        throw grantError;
      },
    };
    const { createToolAccess } = await import("../../src/plugins/public");
    const access = createToolAccess({ store });

    await access.installSkill(installInput);
    expect(seen.installSkill).toEqual([installInput]); // 同一对象透传

    await access.uninstallSkill("s", "someone@example.com");
    expect(seen.uninstallSkill).toEqual(["s", "someone@example.com"]);

    expect(await access.skillOwner("s")).toBe(ownerAnswer); // 返回值恒等
    expect(seen.skillOwner).toEqual(["s"]);

    await expect(
      access.grant("skill", "s", "bot-1", "someone@example.com"),
    ).rejects.toBe(grantError); // 错误实例原样上抛，非包装
    expect(seen.grant).toEqual(["skill", "s", "bot-1", "someone@example.com"]);
  });
});

describe("MOD16 D3：验收① 源级钉——重复安装收敛 + 失败诚实性", () => {
  test("幂等唯一索引名在 schema 上（DB 兜底收敛的源级事实）", () => {
    const schema = readSrc("db/schema/enterprise-plugin-packages.ts");
    expect(schema).toContain(
      'uniqueIndex("enterprise_package_install_scope_key_uq")',
    );
  });

  test("replay created:false 路径存在（HTTP 幂等键回放不二建）", () => {
    const service = readSrc("enterprise/plugin-packages/install-service.ts");
    const replays = [...service.matchAll(/created: false/g)];
    expect(replays.length).toBe(2); // 幂等回执回放 + 已消费 plan 换键回放
    expect(service).toContain("Idempotency receipt");
  });

  test("changes 操作记录写入点全部在事务域内（源扫：零域外写入；install 路径恰 2 处成功回执）", () => {
    const dir = "enterprise/plugin-packages";
    const files = [
      "contracts.ts",
      "experts.ts",
      "grants.ts",
      "install-service.ts",
      "mutation-context.ts",
      "plans.ts",
      "routes.ts",
      "runtime.ts",
      "store.ts",
      "public.ts",
    ];
    let installScoped = 0;
    for (const name of files) {
      const source = readSrc(`${dir}/${name}`);
      // 事务域外的 changes 写入（含假成功路径）一旦出现即红。
      expect(source).not.toMatch(/(?<!tx\.db)\.insert\(changeRows\)/);
      if (name === "install-service.ts") {
        installScoped = [...source.matchAll(/tx\.db\.insert\(changeRows\)/g)]
          .length;
      }
    }
    // install 路径恰 2 处：plan 幂等回执回放 + install 成功；另 2 处
    // （experts.ts:444 回执、grants.ts:333 周期回执）同属事务内成功路径。
    expect(installScoped).toBe(2);
  });

  test("503 PACKAGE_STORAGE_UNAVAILABLE 合同在 routes 错误面上", () => {
    const routes = readSrc("enterprise/plugin-packages/routes.ts");
    expect(routes).toContain("PACKAGE_STORAGE_UNAVAILABLE: 503");
    expect(routes).toContain("isPackageStorageFailure");
  });
});

describe("MOD16 D4：验收② 钉——包只存链接，实体由所有者创建", () => {
  test("install 路径零写 skills/bots/agents 表（insert 目标面源扫）", () => {
    const service = readSrc("enterprise/plugin-packages/install-service.ts");
    const targets = [...service.matchAll(/\.insert\((\w+)\)/g)].map(
      (m) => m[1],
    );
    expect(new Set(targets)).toEqual(
      new Set([
        "planRows",
        "installRows",
        "revisionRows",
        "linkRows",
        "changeRows",
      ]),
    ); // 全部 enterprise_package_* 行别名，无 skills/bots/agents 写入点
    for (const target of targets) {
      expect(target).not.toMatch(/skill|bot|agent/i);
    }
  });

  test("resource links 仅存 id+revision，不复制实体内容（schema 形状钉）", () => {
    const schema = readSrc("db/schema/enterprise-plugin-packages.ts");
    const def = schema.match(
      /export const enterprisePackageResourceLinks = pgTable\(/,
    );
    expect(def).not.toBeNull();
    const start = schema.indexOf(
      "enterprise_package_resource_links",
      def!.index!,
    );
    const block = schema.slice(start, schema.indexOf(").enableRLS()", start));
    for (const column of [
      "resourceId",
      "revision",
      "existingSkillId",
      "connectorInstallId",
      "expertTemplateRef",
    ]) {
      expect(block).toContain(column);
    }
    expect(block).not.toMatch(/instructions|systemPrompt|secret|content/); // 引用不复制
  });

  test("experts.ts 直建 Bot 已知缺口钉：恰 1 处真实调用 + 域内防扩散", () => {
    const dir = "enterprise/plugin-packages";
    const files = [
      "contracts.ts",
      "experts.ts",
      "grants.ts",
      "install-service.ts",
      "mutation-context.ts",
      "plans.ts",
      "routes.ts",
      "runtime.ts",
      "store.ts",
      "public.ts",
    ];
    let realCalls = 0;
    for (const name of files) {
      const source = readSrc(`${dir}/${name}`);
      // SQL 模板里的真实调用（注释/文档提及不计：它们不在 sql` 模板内）。
      const calls = [
        ...source.matchAll(/select public\.openbot_create_package_expert/g),
      ];
      realCalls += calls.length;
      if (name !== "experts.ts") expect(calls.length).toBe(0);
    }
    expect(realCalls).toBe(1); // 新增直建即红；事务语义改道 defer（见报告登记节）
  });

  test("marketplace 经门面建 Bot，无第二直建路径", () => {
    const routes = readSrc("marketplace/routes.ts");
    expect(routes).toContain("deps.agents.createBot");
    expect(routes).not.toMatch(
      /openbot_create|profile-store|createAgentProfileStore/,
    );
  });
});

describe("MOD16 D5：改道等价（runs 经 public、marketplace 零内件直 import、装配经门面）", () => {
  test("runs/service.ts 对 plugin-packages 的 import 恰 1 处且经 public 出口", () => {
    const service = readSrc("enterprise/runs/service.ts");
    const imports = [
      ...service.matchAll(/from "\.\.\/plugin-packages\/(\w+)"/g),
    ];
    expect(imports).toHaveLength(1);
    expect(imports[0][1]).toBe("public");
    expect(service).toContain(
      'import type { PreparePackageRunInput } from "../plugin-packages/public"',
    );
  });

  test("marketplace/routes.ts 零 profile-store/plugins-store 直 import，改道两门面", () => {
    const routes = readSrc("marketplace/routes.ts");
    expect(routes).not.toContain("../agents/profile-store");
    expect(routes).not.toContain("../plugins/store");
    expect(routes).toContain(
      'import type { BotCatalog } from "../agents/public"',
    );
    expect(routes).toContain(
      'import type { ToolAccess } from "../plugins/public"',
    );
    expect(routes).toMatch(
      /agents\?: Pick<BotCatalog, "createBot" \| "softDeleteBot">/,
    );
    expect(routes).toMatch(/grants\?: Pick<ToolAccess, "grant">/);
    expect(routes).toMatch(
      /skillWrites\?: Pick<\s*ToolAccess,\s*"installSkill" \| "uninstallSkill" \| "skillOwner"/,
    );
  });

  test("装配注入点经门面实例（botCatalog 同源、ToolAccess 就地包装同一 store）", () => {
    const http = readSrc("assembly/http.ts");
    expect(http).toContain("agents: coworker.botCatalog");
    expect(http).toContain("createToolAccess({ store: pluginStore })");
    // 旧直注形态不得回流
    expect(http).not.toMatch(/agents: agentProfileStore,/);
    expect(http).not.toMatch(/grants: pluginStore/);
  });
});
