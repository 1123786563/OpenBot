// server/tests/multitenancy/inventory.test.ts
// MT001（Issue #44）：入口清单生成器的契约、真实装配、漂移与数据库跳过行为。
//
// 这些测试同时是验收事实源：清单来自真实应用装配（createApp 的 bare/full
// 变体、企业入口两条装配线、kb 服务入口），缺口报告随入口增删变化，缺
// 少测试数据库配置时命令仍可运行且数据库阶段显式跳过。

import { describe, expect, test } from "bun:test";
import {
  buildInventory,
  classifyPath,
  classifyStream,
  type EntranceEntry,
  renderGapReport,
  SCHEMA_VERSION,
} from "../../scripts/multitenancy/inventory";

const NO_DATABASE: Record<string, string | undefined> = {
  // 只有开发库变量也绝不允许回退：TEST_DATABASE_URL 缺席即显式跳过。
  DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
};

const inventory = await buildInventory({ environment: NO_DATABASE });

function entrance(id: string): EntranceEntry | undefined {
  return inventory.entrances.find((entry) => entry.id === id);
}

const ENTRANCE_KEYS = [
  "id",
  "entrance",
  "method",
  "path",
  "kind",
  "type",
  "businessClosure",
  "ownerTicket",
  "status",
  "registration",
  "registeredIn",
  "registrations",
] as const;

describe("coverage inventory contract", () => {
  test("pins the schema version and stays JSON-serializable", () => {
    expect(inventory.schemaVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(1);
    expect(() => JSON.stringify(inventory)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(inventory));
    expect(parsed.entrances.length).toBe(inventory.entrances.length);
  });

  test("every entrance carries exactly the contract fields with valid values", () => {
    expect(inventory.entrances.length).toBeGreaterThan(300);
    const ids = new Set<string>();
    for (const entry of inventory.entrances) {
      expect(Object.keys(entry).sort()).toEqual([...ENTRANCE_KEYS].sort());
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
      expect(["http", "stream", "internal"]).toContain(entry.type);
      expect(["route", "catchall", "serve-upgrade"]).toContain(entry.kind);
      expect(["owned", "unowned"]).toContain(entry.status);
      expect(["always", "conditional", "serve-level"]).toContain(
        entry.registration,
      );
      expect(entry.businessClosure.length).toBeGreaterThan(0);
      expect(entry.entrance).toBe(entry.id);
      expect(entry.registeredIn.length).toBeGreaterThan(0);
    }
    const sorted = [...inventory.entrances].map((entry) => entry.id);
    expect([...sorted].sort()).toEqual(sorted);
  });

  test("summary counts agree with the entries", () => {
    const { summary } = inventory;
    expect(summary.totalEntrances).toBe(inventory.entrances.length);
    expect(summary.unownedEntrances).toBe(
      inventory.entrances.filter((entry) => entry.status === "unowned").length,
    );
    expect(summary.unclassifiedEntrances).toBe(
      inventory.entrances.filter(
        (entry) => entry.businessClosure === "unclassified",
      ).length,
    );
    expect(summary.dataTables).toBe(inventory.dataTables.length);
    expect(summary.backgroundPrograms).toBe(
      inventory.backgroundPrograms.length,
    );
    expect(summary.externalDependencies).toBe(
      inventory.externalDependencies.length,
    );
  });

  test("digest is deterministic and excludes the timestamp", async () => {
    const again = await buildInventory({
      environment: NO_DATABASE,
      now: () => new Date("2020-01-01T00:00:00Z"),
    });
    expect(again.digest).toBe(inventory.digest);
    expect(again.generatedAt).not.toBe(inventory.generatedAt);
  });
});

describe("entrances come from real application assembly", () => {
  test("assembles the deployment, enterprise and kb entrance faces", () => {
    const names = inventory.assemblies.map((assembly) => assembly.name);
    expect(names).toEqual([
      "deployment-bare",
      "deployment-full",
      "deployment-enterprise-unavailable",
      "kb-service",
    ]);
    for (const assembly of inventory.assemblies) {
      expect(assembly.status).toBe("assembled");
      expect(assembly.routeEntries).toBeGreaterThan(0);
    }
    // full 装配携带全部条件面，必然多于 bare 基线。
    const bare = inventory.assemblies.find(
      (assembly) => assembly.name === "deployment-bare",
    );
    const full = inventory.assemblies.find(
      (assembly) => assembly.name === "deployment-full",
    );
    expect(
      (full?.routeEntries ?? 0) - (bare?.routeEntries ?? 0),
    ).toBeGreaterThan(200);
  });

  test("always-mounted deployment routes are marked always", () => {
    const health = entrance("GET /health");
    expect(health).toBeDefined();
    expect(health?.registration).toBe("always");
    expect(health?.registeredIn).toContain("deployment-bare");
    expect(health?.businessClosure).toBe("platform");
  });

  test("dynamically and conditionally registered routes are captured", () => {
    // agents 路由只有装配了 agentProfileStore 才挂载（src/app.ts 的条件块）。
    const agents = entrance("GET /api/agents");
    expect(agents).toBeDefined();
    expect(agents?.registration).toBe("conditional");
    expect(agents?.registeredIn).toContain("deployment-full");
    expect(agents?.registeredIn).not.toContain("deployment-bare");
    expect(agents?.businessClosure).toBe("bot");

    // worker 内部入口不在 /api 之下，类型为 internal。
    const routines = entrance("POST /internal/routines/run");
    expect(routines?.type).toBe("internal");
    expect(routines?.businessClosure).toBe("internal-worker");

    // CopilotKit runtime 是 vendor 装配的动态面。
    expect(entrance("ALL /api/copilotkit/*")).toBeDefined();

    // 配置条件路由：WEB_BOT_AUTH=on 才出现的公钥目录。
    const directory = inventory.entrances.find((entry) =>
      entry.path.startsWith("/.well-known/"),
    );
    expect(directory?.registration).toBe("conditional");
    expect(directory?.businessClosure).toBe("bot");
  });

  test("captures the enterprise entrance in both assembly lines", () => {
    // 真实装配线：createConversationRoutes 的四条路由（经部署入口前缀挂载）。
    const list = entrance("GET /api/enterprise/conversations");
    expect(list).toBeDefined();
    expect(list?.registeredIn).toContain("deployment-full");
    expect(list?.registeredIn).not.toContain(
      "deployment-enterprise-unavailable",
    );
    expect(list?.businessClosure).toBe("conversation");
    expect(entrance("POST /api/enterprise/conversations")).toBeDefined();
    expect(
      entrance("GET /api/enterprise/conversations/:threadId/messages"),
    ).toBeDefined();

    // 降级装配线：unavailable 503 兜底接管同一前缀。
    const unavailable = entrance("ALL /api/enterprise/conversations/*");
    expect(unavailable).toBeDefined();
    expect(unavailable?.registeredIn).toEqual([
      "deployment-enterprise-unavailable",
    ]);
  });

  test("captures the kb service entrance", () => {
    const retrieve = entrance("POST /kb/:kbId/retrieve");
    expect(retrieve).toBeDefined();
    expect(retrieve?.registeredIn).toEqual(["kb-service"]);
    expect(retrieve?.businessClosure).toBe("knowledge");
    expect(retrieve?.registration).toBe("always");
  });

  test("classifies stream entrances and verifies serve() upgrades", () => {
    const events = entrance("GET /api/channels/events");
    expect(events?.type).toBe("stream");

    const computerStream = entrance("WS /api/computers/:botId/stream");
    expect(computerStream?.kind).toBe("serve-upgrade");
    expect(computerStream?.type).toBe("stream");

    // serve() 升级分支数与已登记 stream 入口一致：新增升级分支会立刻失衡。
    expect(inventory.summary.serveUpgradeBranches).toBe(
      inventory.summary.serveUpgradeEntrances,
    );
  });

  test("classification helpers stay honest about unknowns", () => {
    expect(classifyPath("/api/billing/credits/summary")).toBe("billing");
    expect(classifyPath("/api/mobile/openmuse-files")).toBe("openmuse");
    // 连字符族前缀不得被 /api/mobile 吞掉，也不得把 /api/memory 误判给 /api/me。
    expect(classifyPath("/api/mobile/openmuse-mail")).toBe("openmuse");
    expect(classifyPath("/api/memory")).toBe("memory");
    expect(classifyPath("/totally/new/surface")).toBe("unclassified");
    expect(classifyStream("/internal/routines/run")).toBe("internal");
    expect(classifyStream("/api/workshop/:id/events")).toBe("stream");
  });
});

describe("static candidate extraction", () => {
  test("background programs carry evidence from the deployment entry", () => {
    expect(inventory.backgroundPrograms.length).toBeGreaterThan(0);
    const retention = inventory.backgroundPrograms.find(
      (program) => program.name === "startRetentionSweeps",
    );
    expect(retention?.source).toBe("src/index.ts");
    expect(retention?.evidence).toMatch(/^src\/index\.ts:\d+:/);
    for (const program of inventory.backgroundPrograms) {
      expect(program.evidence).toMatch(/:\d+:/);
    }
  });

  test("data tables come from the real drizzle schemas", () => {
    expect(inventory.dataTables.length).toBeGreaterThan(140);
    expect(inventory.dataTables.map((table) => table.id)).toContain(
      "server.users",
    );
    expect(inventory.dataTables.some((table) => table.schema === "kb")).toBe(
      true,
    );
  });

  test("external dependencies map config keys to named systems", () => {
    const postgres = inventory.externalDependencies.find(
      (dependency) => dependency.id === "PostgreSQL（主库）",
    );
    expect(postgres?.configKeys).toContain("DATABASE_URL");
    expect(Array.isArray(inventory.unmappedConfigKeys)).toBe(true);
  });
});

describe("gap report and ownership", () => {
  test("lists unowned entrances grouped by business closure", () => {
    const report = renderGapReport(inventory);
    expect(report).toContain("# MT001 多租户覆盖清单 — 缺口报告");
    expect(report).toContain("## 未归属入口（按业务闭环）");
    expect(report).toContain("`GET /api/agents`");
    expect(report).toContain("### bot（");
  });

  test("ownership input flips entries to owned and shrinks the gap", async () => {
    const owned = await buildInventory({
      environment: NO_DATABASE,
      ownership: {
        MTTEST: { entrancePrefixes: ["/api/billing"] },
      },
    });
    const catalog = owned.entrances.find(
      (entry) => entry.entrance === "GET /api/billing/catalog",
    );
    expect(catalog?.ownerTicket).toBe("MTTEST");
    expect(catalog?.status).toBe("owned");
    expect(owned.summary.unownedEntrances).toBeLessThan(
      inventory.summary.unownedEntrances,
    );
    const report = renderGapReport(owned);
    expect(report).not.toContain("`GET /api/billing/catalog`");
  });

  test("exact entrance ownership wins over closure ownership", async () => {
    const owned = await buildInventory({
      environment: NO_DATABASE,
      ownership: {
        MTEXACT: { entrances: ["GET /api/billing/catalog"] },
        MTCLOSURE: { closures: ["billing"] },
      },
    });
    const catalog = owned.entrances.find(
      (entry) => entry.entrance === "GET /api/billing/catalog",
    );
    const entitlements = owned.entrances.find(
      (entry) => entry.entrance === "GET /api/billing/entitlements",
    );
    expect(catalog?.ownerTicket).toBe("MTEXACT");
    expect(entitlements?.ownerTicket).toBe("MTCLOSURE");
  });
});

describe("drift detection", () => {
  test("adding an entrance changes inventory, digest and gap report", async () => {
    const drifted = await buildInventory({
      environment: NO_DATABASE,
      mutateApp: (name, app) => {
        if (name !== "deployment-full") return;
        // 模拟开发者在部署装配上新增一个入口后重跑清单。
        app.routes.push({ method: "POST", path: "/api/drift-probe" });
      },
    });
    const probe = drifted.entrances.find(
      (entry) => entry.entrance === "POST /api/drift-probe",
    );
    expect(probe).toBeDefined();
    expect(probe?.registration).toBe("conditional");
    expect(probe?.registeredIn).toEqual(["deployment-full"]);
    // 未接入分类表的入口显式落入 unclassified，而不是被悄悄归入某个闭环。
    expect(probe?.businessClosure).toBe("unclassified");
    expect(drifted.digest).not.toBe(inventory.digest);
    expect(drifted.summary.totalEntrances).toBe(
      inventory.summary.totalEntrances + 1,
    );
    expect(drifted.summary.unclassifiedEntrances).toBe(
      inventory.summary.unclassifiedEntrances + 1,
    );
    const report = renderGapReport(drifted);
    expect(report).toContain("`POST /api/drift-probe`");
    expect(report).toContain("未分类");
  });

  test("removing an entrance source changes the inventory and digest", async () => {
    // 只保留 bare 装配 = 条件入口全部消失（等价于入口被删除后重跑）。
    const bare = await buildInventory({
      environment: NO_DATABASE,
      assemblies: ["deployment-bare"],
    });
    expect(bare.entrances.find((entry) => entry.id === "GET /api/agents")).toBe(
      undefined,
    );
    expect(bareReportStillListsAlwaysRoutes(bare)).toBe(true);
    expect(bare.summary.totalEntrances).toBeLessThan(
      inventory.summary.totalEntrances,
    );
    expect(bare.digest).not.toBe(inventory.digest);
  });
});

function bareReportStillListsAlwaysRoutes(
  bare: Awaited<ReturnType<typeof buildInventory>>,
) {
  const report = renderGapReport(bare);
  return report.includes("`GET /health`");
}

describe("database stages are explicit, never silent", () => {
  test("without TEST_DATABASE_URL both stages are skipped with reasons", () => {
    const stages = Object.fromEntries(
      inventory.stages.map((stage) => [stage.stage, stage]),
    );
    const crosscheck = stages["live-table-crosscheck"];
    expect(crosscheck?.status).toBe("skipped");
    expect(crosscheck?.reason).toContain("TEST_DATABASE_URL");
    expect(crosscheck?.reason).not.toContain("通过");
    const enterprise = stages["enterprise-capability-assembly"];
    expect(enterprise?.status).toBe("skipped");
    expect(enterprise?.requires).toContain("ENTERPRISE_DIRECTORY_DATABASE_URL");
  });

  test("a DATABASE_URL is never used as a fallback", () => {
    // NO_DATABASE 里带着开发库 DATABASE_URL：阶段仍然必须显式跳过。
    for (const stage of inventory.stages) {
      expect(stage.status).toBe("skipped");
      expect(stage.reason?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("refuses a test URL that names the development database", async () => {
    const refused = await buildInventory({
      environment: { TEST_DATABASE_URL: "postgres://x/openbot" },
    });
    const crosscheck = refused.stages.find(
      (stage) => stage.stage === "live-table-crosscheck",
    );
    expect(crosscheck?.status).toBe("skipped");
    expect(crosscheck?.reason).toContain("openbot");
  });

  test("a configured but unreachable test database fails loudly", async () => {
    const failed = await buildInventory({
      environment: {
        TEST_DATABASE_URL:
          "postgres://127.0.0.1:1/openbot_inventory_unreachable",
      },
    });
    const crosscheck = failed.stages.find(
      (stage) => stage.stage === "live-table-crosscheck",
    );
    expect(crosscheck?.status).toBe("failed");
    expect(crosscheck?.reason?.length ?? 0).toBeGreaterThan(0);
  });
});
