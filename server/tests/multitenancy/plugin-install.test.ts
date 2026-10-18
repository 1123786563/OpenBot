// server/tests/multitenancy/plugin-install.test.ts
// MT031（Issue #74）：插件目录与安装归属——目录只读，安装不全局。
//
// 验收事实源（Issue #74 四条，逐条对应 describe）：
//   (1) 目录只读可见且不含公司私有配置；安装记录固定公司与团队
//       （公共目录对每家公司一致可见，视图类型上没有 config/envelope 等
//       私有面；受限业务角色对目录零写授权、模块零目录写方法；安装行
//       company+team 双 NOT NULL 复合外键——跨公司安装行结构性不可能）。
//   (2) 用另一公司的安装/连接 ID 调用被拒绝且不触发供应商请求
//       （deny = MT011 canonical 与「不存在」逐字节同形；供应商探针注入在
//       判定模块 allow 分支内部计数——deny 后计数不变是模块自身效果的观测，
//       不是测试侧模拟；跨公司归属行被复合外键判 23503 结构性不可能）。
//   (3) 卸载/停用只影响本范围安装；共享目录条目不受影响
//       （他司卸载 = removed:false 零效果；本司卸载后共享目录条目仍在、
//       其他公司对同一目录条目的安装与连接照常可用；停用 = 状态闸门，
//       只关本行）。
//   (4) 安装配置中的秘密脱敏保存与展示（config 闭形：秘密载体键在模块
//       入口与存储 CHECK 两层被拒；秘密经 vault 密封进 envelope，明文永不
//       入库；脱敏视图类型上没有 envelope/plaintext 字段，hasSecret 只暴露
//       存在性布尔；canary 明文只在 allow 分支的 envelope 字段出现一次）。
//
// 存储契约（第五组）：三表 FORCE RLS、最小授权矩阵（目录只读、directory
// 零授权）、行形/闭形 CHECK、事务本地上下文提交后清空（连接池复用不沿用
// 范围）、未验证通道 fail-closed。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_DATABASE_URL）
// 加三个受限角色 URL；缺配置时整套显式 skip（跳过原因写在用例名里，
// skipped 不计为通过），绝不回退开发库。MT031 迁移（三张新表 + FORCE RLS +
// 最小授权）经 MT003 工具（migrate-test.ts）三步配方真实执行：套件内
// dry-run → manifest → --apply，本文件不自己 DDL。

import { afterAll, beforeAll, describe, expect, test } from "../../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import {
  buildPlan,
  manifestFor,
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import { createDatabase } from "../../src/db/client";
import {
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import {
  createPluginCatalogAdminService,
  createPluginCatalogDecisionService,
} from "../../src/enterprise/tenancy/plugin-catalog";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import {
  createPluginInstallFixture,
  type PluginInstallFixture,
  scopeOf,
  thrownMessage,
} from "./support/plugin-install";

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
      reason: `MT031 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

// ---------------------------------------------------------------------------
// 判定断言助手：deny 只有一种对外形状（不泄露存在性）
// ---------------------------------------------------------------------------

const CANONICAL_DENY = Object.freeze({
  outcome: "deny",
  code: "RESOURCE_NOT_FOUND",
});

/** Any key that would carry secret material through a redacted surface. */
const SECRET_CARRIER_KEYS = [
  "envelope",
  "plaintext",
  "encryptedValue",
  "encrypted_value",
  "secret",
  "secretRef",
] as const;

function assertRedactedShape(value: unknown): void {
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    for (const key of Object.keys(node as Record<string, unknown>)) {
      expect(SECRET_CARRIER_KEYS).not.toContain(key);
      walk((node as Record<string, unknown>)[key]);
    }
  };
  walk(value);
}

function assertCanonicalDeny(verdict: {
  readonly outcome: string;
  readonly code?: string;
}): void {
  expect(verdict).toEqual(CANONICAL_DENY);
  expect(serializeNotFoundVerdict(verdict as never)).toBe(
    serializeNotFoundVerdict(notFoundVerdict()),
  );
}

// ---------------------------------------------------------------------------
// 共享夹具 + MT031 迁移（经 MT003 工具三步配方真实执行）
// ---------------------------------------------------------------------------

let fixture: PluginInstallFixture;
let dryRunOutcome: RunOutcome;
let applyOutcome: RunOutcome;

// 目录平面：三条公共条目（三种 kind 各一），跨公司共享。
let catMcp: { catalogId: string };
let catComposio: { catalogId: string };
let catOpenConnector: { catalogId: string };

// 安装平面：公司 A 团队 A1（带秘密）、A 团队 A2（无秘密）、公司 B 团队 B1
// （与 A1 同一条目录条目——共享目录不被卸载影响的对照面）。
let insA1: { installId: string; tenantId: string; workspaceId: string };
let insA2: { installId: string; tenantId: string; workspaceId: string };
let insB1: { installId: string; tenantId: string; workspaceId: string };

// 连接平面：A1 与 B1 各一条（连接 ID 也是 AC2 的调用面）。
let connA1: { connectionId: string; installId: string; tenantId: string };
let connB1: { connectionId: string; installId: string; tenantId: string };

const CANARY_SECRET_A1 = "mt031-canary-install-a1-7d3c91ab";
const CATALOG_IDS = [
  "cat-mcp-github",
  "cat-composio-slack",
  "cat-openconn-erp",
];

describeDb(
  "MT031 plugin catalog & install ownership: catalog is read-only, installs are not global (Issue #74)",
  () => {
    beforeAll(async () => {
      const resolved = resolveTestDatabaseTarget(process.env);
      if (!resolved.ok) {
        throw new Error(`MT031 plugin tests refuse to run: ${resolved.reason}`);
      }
      // 三步配方之一：dry-run（默认 migrate 即计划展示，无副作用）。
      // 拒绝即响亮失败（绝不静默继续）；已应用过的库返回 0 待应用步骤，
      // 是合法的重复运行状态。
      dryRunOutcome = await runMigrateTest(["migrate", "MT031"], {
        environment: { TEST_DATABASE_URL: resolved.target.url },
        out: () => {},
      });
      if (dryRunOutcome.kind === "refused") {
        throw new Error(`MT031 dry-run refused: ${dryRunOutcome.reason}`);
      }
      // 三步配方之二：manifest 由当前计划物化。
      const manifestPath = `/tmp/mt031-manifest-${randomUUID()}.json`;
      await Bun.write(
        manifestPath,
        `${JSON.stringify(manifestFor(buildPlan("MT031")), null, 2)}\n`,
      );
      // 三步配方之三：--apply 与 manifest 逐步骤核对后执行。
      try {
        applyOutcome = await runMigrateTest(
          ["migrate", "MT031", "--apply", "--manifest", manifestPath],
          {
            environment: { TEST_DATABASE_URL: resolved.target.url },
            out: () => {},
          },
        );
      } finally {
        await rm(manifestPath, { force: true });
      }
      if (
        applyOutcome.kind !== "applied" &&
        applyOutcome.kind !== "up-to-date"
      ) {
        throw new Error(
          `MT031 apply did not land: ${JSON.stringify(applyOutcome).slice(0, 200)}`,
        );
      }
      fixture = await createPluginInstallFixture();
      // 公共目录（部署侧策展，超户 stand-in）：业务通道对目录零写授权，
      // 种子只能走这个披露过的安排面。
      catMcp = await fixture.seedCatalogEntry({
        catalogId: "cat-mcp-github",
        kind: "mcp",
        vendor: "github",
        source: "first-party",
        title: "GitHub MCP",
        summary: "Issues, pulls and repos over MCP.",
      });
      catComposio = await fixture.seedCatalogEntry({
        catalogId: "cat-composio-slack",
        kind: "composio",
        vendor: "slack",
        source: "first-party",
        title: "Slack via Composio",
        summary: "Slack toolkit through the Composio broker.",
      });
      catOpenConnector = await fixture.seedCatalogEntry({
        catalogId: "cat-openconn-erp",
        kind: "open-connector",
        vendor: "acme-erp",
        source: "custom",
        title: "Acme ERP (OpenConnector)",
        summary: "Custom OpenConnector listing for the Acme ERP.",
      });
      insA1 = await fixture.provisionInstall({
        identity: "a1-member",
        teamKey: "team-a1",
        catalogId: catMcp.catalogId,
        config: { region: "us", channel: "bot-pipeline" },
        secret: CANARY_SECRET_A1,
      });
      insA2 = await fixture.provisionInstall({
        identity: "a2-member",
        teamKey: "team-a2",
        catalogId: catComposio.catalogId,
        config: { defaultChannel: "general" },
      });
      // 公司 B 安装同一条 MCP 目录条目：共享目录、各自安装。
      insB1 = await fixture.provisionInstall({
        identity: "b1-member",
        teamKey: "team-b1",
        catalogId: catMcp.catalogId,
        config: { region: "eu" },
      });
      connA1 = await fixture.bindConnection({
        identity: "a1-member",
        teamKey: "team-a1",
        install: insA1,
        vendorRef: "alias-a1-github",
      });
      connB1 = await fixture.bindConnection({
        identity: "b1-member",
        teamKey: "team-b1",
        install: insB1,
        vendorRef: "alias-b1-github",
      });
    });

    afterAll(async () => {
      if (fixture) await fixture.dispose();
    });

    // -----------------------------------------------------------------------
    // AC1：目录只读全局可见且不含公司私有配置；安装记录固定公司与团队
    // -----------------------------------------------------------------------
    describeDb(
      "AC1 catalog is globally readable, read-only, and private-free",
      () => {
        itDb(
          "the catalog lists the same entries for both companies (global visibility)",
          async () => {
            const scopeA = await scopeOf(fixture, "a1-member", "team-a1");
            const scopeB = await scopeOf(fixture, "b1-member", "team-b1");
            const listA = await fixture.decisions.listCatalog(scopeA);
            const listB = await fixture.decisions.listCatalog(scopeB);
            expect(listA.map((entry) => entry.catalogId).sort()).toEqual(
              [...CATALOG_IDS].sort(),
            );
            expect(listB.map((entry) => entry.catalogId).sort()).toEqual(
              [...CATALOG_IDS].sort(),
            );
            // 视图只含公共面：无任何秘密载体键、无 config/workspace 归属面。
            assertRedactedShape(listA);
            assertRedactedShape(listB);
            const view = listA.find(
              (entry) => entry.catalogId === catMcp.catalogId,
            );
            expect(view).toMatchObject({
              catalogId: catMcp.catalogId,
              kind: "mcp",
              vendor: "github",
              source: "first-party",
            });
            expect(Object.keys(view as object)).not.toContain("config");
            expect(Object.keys(view as object)).not.toContain("workspaceId");
            expect(Object.keys(view as object)).not.toContain("tenantId");
          },
        );

        itDb(
          "every restricted business role has zero write privilege on the catalog",
          async () => {
            for (const role of [
              "ob_ent_directory",
              "ob_ent_data",
              "ob_ent_operator",
            ] as const) {
              expect(
                await fixture.catalog.hasPrivilege(
                  "enterprise_plugin_catalog",
                  role,
                  "INSERT",
                ),
              ).toBe(false);
              expect(
                await fixture.catalog.hasPrivilege(
                  "enterprise_plugin_catalog",
                  role,
                  "UPDATE",
                ),
              ).toBe(false);
              expect(
                await fixture.catalog.hasPrivilege(
                  "enterprise_plugin_catalog",
                  role,
                  "DELETE",
                ),
              ).toBe(false);
            }
            // 只读的两条读通道：data 与 operator 可 SELECT；directory 零授权。
            expect(
              await fixture.catalog.hasPrivilege(
                "enterprise_plugin_catalog",
                "ob_ent_data",
                "SELECT",
              ),
            ).toBe(true);
            expect(
              await fixture.catalog.hasPrivilege(
                "enterprise_plugin_catalog",
                "ob_ent_operator",
                "SELECT",
              ),
            ).toBe(true);
            expect(
              await fixture.catalog.hasPrivilege(
                "enterprise_plugin_catalog",
                "ob_ent_directory",
                "SELECT",
              ),
            ).toBe(false);
          },
        );

        itDb(
          "the module exposes no catalog writer at all (read-only by construction)",
          () => {
            expect(Object.keys(fixture.admin).sort()).toEqual([
              "bindConnection",
              "install",
              "setEnabled",
              "unbindConnection",
              "uninstall",
            ]);
            expect(Object.keys(fixture.decisions).sort()).toEqual([
              "authorizeInvoke",
              "describeInstall",
              "listCatalog",
              "listConnections",
              "listInstalls",
            ]);
          },
        );

        itDb(
          "an install row pins company and team (both NOT NULL, composite FKs)",
          async () => {
            const row = await fixture.installRow({
              tenantId: insA1.tenantId,
              installId: insA1.installId,
            });
            expect(row).not.toBeNull();
            expect(row?.tenant_id).toBe(insA1.tenantId);
            expect(row?.workspace_id).toBe(insA1.workspaceId);
            expect(row?.catalog_id).toBe(catMcp.catalogId);
            expect(row?.status).toBe("active");
          },
        );

        itDb(
          "the catalog table has no tenant column at all (global by storage shape)",
          async () => {
            expect(
              await fixture.catalog.columnsOf("enterprise_plugin_catalog"),
            ).not.toContain("tenant_id");
            expect(
              await fixture.catalog.columnsOf("enterprise_plugin_installs"),
            ).toContain("tenant_id");
            expect(
              await fixture.catalog.columnsOf("enterprise_plugin_connections"),
            ).toContain("tenant_id");
          },
        );

        itDb(
          "a cross-company install row is structurally impossible (23503)",
          async () => {
            const aTenant = insA1.tenantId;
            const bTeam = insB1.workspaceId;
            const bPrincipal = fixture.principalOf("b1-member", "company-b");
            // 团队属于另一家公司：复合外键拒绝。
            expect(
              await fixture.rawInstallInsert({
                tenantId: aTenant,
                catalogId: catMcp.catalogId,
                workspaceId: bTeam,
                installedBy: fixture.principalOf("a1-member", "company-a"),
              }),
            ).toBe("23503");
            // 安装人属于另一家公司：复合外键拒绝。
            expect(
              await fixture.rawInstallInsert({
                tenantId: aTenant,
                catalogId: catMcp.catalogId,
                workspaceId: insA1.workspaceId,
                installedBy: bPrincipal,
              }),
            ).toBe("23503");
            // 目录条目不存在：外键拒绝（目录是安装的引用完整性来源）。
            expect(
              await fixture.rawInstallInsert({
                tenantId: aTenant,
                catalogId: "cat-missing",
                workspaceId: insA1.workspaceId,
                installedBy: fixture.principalOf("a1-member", "company-a"),
              }),
            ).toBe("23503");
          },
        );

        itDb(
          "an install without a team is refused at the module boundary",
          async () => {
            const fact = fixture.base.teamOf("a1-member", "team-a1");
            const message = await thrownMessage(
              fixture.admin.install({
                tenantId: fact.tenantId,
                workspaceId: "",
                installedBy: fact.principalId,
                catalogId: catMcp.catalogId,
                config: {},
              }),
            );
            expect(message).toContain("PLUGIN_INSTALL_INVALID: workspaceId");
          },
        );
      },
    );

    // -----------------------------------------------------------------------
    // AC2：另一公司的安装/连接 ID 调用被拒且不触发供应商请求
    // -----------------------------------------------------------------------
    describeDb(
      "AC2 cross-company invocation is denied and never reaches the vendor",
      () => {
        itDb(
          "owner invocation is allowed and the injected probe counts the module's own allow branch",
          async () => {
            const scope = await scopeOf(fixture, "a1-member", "team-a1");
            const before = fixture.vendorProbe.calls();
            const resolution = await fixture.decisions.authorizeInvoke(scope, {
              installId: insA1.installId,
            });
            expect(resolution.outcome).toBe("allow");
            if (resolution.outcome !== "allow") return;
            // allow 独占携带密封材料（给执行面），绝不携带明文字段。
            expect(resolution.envelope).toBe(`v1:${CANARY_SECRET_A1}`);
            expect(resolution.install).toMatchObject({
              installId: insA1.installId,
              workspaceId: insA1.workspaceId,
              status: "active",
            });
            assertRedactedShape(resolution.install);
            // 计数发生在判定模块 allow 分支内部（注入 seam），不是测试模拟。
            expect(fixture.vendorProbe.calls()).toBe(before + 1);
          },
        );

        itDb(
          "an install without a secret still allows invocation with envelope null (probe counts)",
          async () => {
            const scope = await scopeOf(fixture, "a2-member", "team-a2");
            const before = fixture.vendorProbe.calls();
            const resolution = await fixture.decisions.authorizeInvoke(scope, {
              installId: insA2.installId,
            });
            expect(resolution.outcome).toBe("allow");
            if (resolution.outcome !== "allow") return;
            expect(resolution.envelope).toBeNull();
            expect(fixture.vendorProbe.calls()).toBe(before + 1);
          },
        );

        itDb(
          "the cross-company identity (multi-company, company-B scope) is denied on install ID with probe unmoved",
          async () => {
            const scopeB = await scopeOf(fixture, "multi-company", "team-b1");
            const before = fixture.vendorProbe.calls();
            const resolution = await fixture.decisions.authorizeInvoke(scopeB, {
              installId: insA1.installId,
            });
            assertCanonicalDeny(resolution);
            expect(fixture.vendorProbe.calls()).toBe(before);
            // deny 变体在类型与序列化上都没有任何可执行物。
            expect(JSON.stringify(resolution)).not.toContain("envelope");
            expect(JSON.stringify(resolution)).not.toContain(CANARY_SECRET_A1);
          },
        );

        itDb(
          "the pure cross-company identity (b1-member) is denied on install ID and connection ID with probe unmoved",
          async () => {
            const scopeB = await scopeOf(fixture, "b1-member", "team-b1");
            const before = fixture.vendorProbe.calls();
            assertCanonicalDeny(
              await fixture.decisions.authorizeInvoke(scopeB, {
                installId: insA1.installId,
              }),
            );
            assertCanonicalDeny(
              await fixture.decisions.authorizeInvoke(scopeB, {
                installId: insA2.installId,
              }),
            );
            // 连接 ID 同样是调用面：B 的成员拿 A 的连接 ID 调用被拒。
            assertCanonicalDeny(
              await fixture.decisions.authorizeInvoke(scopeB, {
                connectionId: connA1.connectionId,
              }),
            );
            expect(fixture.vendorProbe.calls()).toBe(before);
          },
        );

        itDb(
          "a same-company non-team-member is denied on the other team's install (A2 spec, probe unmoved)",
          async () => {
            const scope = await scopeOf(fixture, "a2-member", "team-a2");
            const before = fixture.vendorProbe.calls();
            assertCanonicalDeny(
              await fixture.decisions.authorizeInvoke(scope, {
                installId: insA1.installId,
              }),
            );
            assertCanonicalDeny(
              await fixture.decisions.describeInstall(scope, insA1.installId),
            );
            expect(fixture.vendorProbe.calls()).toBe(before);
          },
        );

        itDb(
          "cross-company listing and description leak nothing (counts equal own scope)",
          async () => {
            const scopeB = await scopeOf(fixture, "b1-member", "team-b1");
            const listB = await fixture.decisions.listInstalls(scopeB);
            expect(listB.map((install) => install.installId)).toEqual([
              insB1.installId,
            ]);
            assertRedactedShape(listB);
            assertCanonicalDeny(
              await fixture.decisions.describeInstall(scopeB, insA1.installId),
            );
            // 连接列表同样只含本范围安装的连接；对他司安装的连接查询是
            // 空列表（与「没有连接的安装」同形——计数不泄露存在性）。
            expect(
              await fixture.decisions.listConnections(scopeB, insB1.installId),
            ).toHaveLength(1);
            expect(
              await fixture.decisions.listConnections(scopeB, insA1.installId),
            ).toHaveLength(0);
          },
        );

        itDb(
          "invocation by connection ID rides the owning install's gates (allow for owner, deny cross-company)",
          async () => {
            const scopeA = await scopeOf(fixture, "a1-member", "team-a1");
            const before = fixture.vendorProbe.calls();
            const resolution = await fixture.decisions.authorizeInvoke(scopeA, {
              connectionId: connA1.connectionId,
            });
            expect(resolution.outcome).toBe("allow");
            if (resolution.outcome !== "allow") return;
            expect(resolution.connection).toMatchObject({
              connectionId: connA1.connectionId,
              installId: insA1.installId,
              vendorRef: "alias-a1-github",
            });
            expect(resolution.envelope).toBe(`v1:${CANARY_SECRET_A1}`);
            expect(fixture.vendorProbe.calls()).toBe(before + 1);
            assertRedactedShape(resolution.connection);
            assertRedactedShape(resolution.install);
          },
        );

        itDb(
          "a malformed reference is the same canonical deny (no existence signal)",
          async () => {
            const scope = await scopeOf(fixture, "a1-member", "team-a1");
            const before = fixture.vendorProbe.calls();
            assertCanonicalDeny(
              await fixture.decisions.authorizeInvoke(scope, {
                installId: "missing-install",
              }),
            );
            assertCanonicalDeny(
              await fixture.decisions.authorizeInvoke(scope, {
                connectionId: "missing-connection",
              }),
            );
            assertCanonicalDeny(
              await fixture.decisions.authorizeInvoke(scope, {} as never),
            );
            expect(fixture.vendorProbe.calls()).toBe(before);
          },
        );
      },
    );

    // -----------------------------------------------------------------
    // AC3：卸载/停用只影响本范围安装；共享目录条目不受影响
    // -----------------------------------------------------------------
    describeDb(
      "AC3 uninstall and disable are scope-local, the shared catalog stands",
      () => {
        itDb(
          "another company's uninstall is a no-op (removed:false, nothing changes)",
          async () => {
            // 专属安装：破坏性用例不触碰其他组依赖的共享行。
            const target = await fixture.provisionInstall({
              identity: "a1-member",
              teamKey: "team-a1",
              catalogId: catOpenConnector.catalogId,
              config: {},
            });
            const scopeB = await scopeOf(fixture, "b1-member", "team-b1");
            const result = await fixture.admin.uninstall({
              tenantId: scopeB.tenantId,
              installId: target.installId,
            });
            expect(result.removed).toBe(false);
            // A 的安装原样健在（allow + probe 计数），列表不少。
            const scopeA = await scopeOf(fixture, "a1-member", "team-a1");
            const before = fixture.vendorProbe.calls();
            const resolution = await fixture.decisions.authorizeInvoke(scopeA, {
              installId: target.installId,
            });
            expect(resolution.outcome).toBe("allow");
            expect(fixture.vendorProbe.calls()).toBe(before + 1);
          },
        );

        itDb(
          "own uninstall removes only the own-scope install; the shared catalog entry stands for the other company",
          async () => {
            const target = await fixture.provisionInstall({
              identity: "a1-member",
              teamKey: "team-a1",
              catalogId: catOpenConnector.catalogId,
              config: {},
            });
            const targetConn = await fixture.bindConnection({
              identity: "a1-member",
              teamKey: "team-a1",
              install: target,
              vendorRef: "alias-a1-erp",
            });
            const scopeA = await scopeOf(fixture, "a1-member", "team-a1");
            const result = await fixture.admin.uninstall({
              tenantId: scopeA.tenantId,
              installId: target.installId,
            });
            expect(result.removed).toBe(true);
            // 本范围：调用被拒、详情不可见、连接级联消失。
            assertCanonicalDeny(
              await fixture.decisions.authorizeInvoke(scopeA, {
                installId: target.installId,
              }),
            );
            assertCanonicalDeny(
              await fixture.decisions.authorizeInvoke(scopeA, {
                connectionId: targetConn.connectionId,
              }),
            );
            assertCanonicalDeny(
              await fixture.decisions.describeInstall(scopeA, target.installId),
            );
            expect(
              await fixture.decisions.listConnections(scopeA, target.installId),
            ).toHaveLength(0);
            // 共享目录条目仍在（两家公司都能看到）。
            const scopeB = await scopeOf(fixture, "b1-member", "team-b1");
            expect(
              (await fixture.decisions.listCatalog(scopeB)).map(
                (entry) => entry.catalogId,
              ),
            ).toContain(catOpenConnector.catalogId);
            expect(
              (await fixture.decisions.listCatalog(scopeA)).map(
                (entry) => entry.catalogId,
              ),
            ).toContain(catOpenConnector.catalogId);
            // 其他公司对共享目录的安装与连接不受影响（allow + probe 计数）。
            const before = fixture.vendorProbe.calls();
            const bResolution = await fixture.decisions.authorizeInvoke(
              scopeB,
              {
                installId: insB1.installId,
              },
            );
            expect(bResolution.outcome).toBe("allow");
            expect(fixture.vendorProbe.calls()).toBe(before + 1);
            const bConnection = await fixture.decisions.authorizeInvoke(
              scopeB,
              {
                connectionId: connB1.connectionId,
              },
            );
            expect(bConnection.outcome).toBe("allow");
          },
        );

        itDb(
          "disable is a status gate on the own row only; re-enable restores invocation",
          async () => {
            const target = await fixture.provisionInstall({
              identity: "a2-member",
              teamKey: "team-a2",
              catalogId: catOpenConnector.catalogId,
              config: {},
            });
            const scopeA = await scopeOf(fixture, "a2-member", "team-a2");
            const disabled = await fixture.admin.setEnabled({
              tenantId: scopeA.tenantId,
              installId: target.installId,
              status: "disabled",
            });
            expect(disabled.updated).toBe(true);
            assertCanonicalDeny(
              await fixture.decisions.authorizeInvoke(scopeA, {
                installId: target.installId,
              }),
            );
            // 本范围详情如实显示 disabled（own-scope 事实，不跨范围泄露）。
            const described = await fixture.decisions.describeInstall(
              scopeA,
              target.installId,
            );
            expect(described.outcome).toBe("allow");
            if (described.outcome === "allow") {
              expect(described.install.status).toBe("disabled");
            }
            // 其他公司安装不受影响（对照面：B1 仍 allow + probe 计数）。
            const scopeB = await scopeOf(fixture, "b1-member", "team-b1");
            const before = fixture.vendorProbe.calls();
            expect(
              (
                await fixture.decisions.authorizeInvoke(scopeB, {
                  installId: insB1.installId,
                })
              ).outcome,
            ).toBe("allow");
            expect(fixture.vendorProbe.calls()).toBe(before + 1);
            // 重新启用后本范围恢复。
            const enabled = await fixture.admin.setEnabled({
              tenantId: scopeA.tenantId,
              installId: target.installId,
              status: "active",
            });
            expect(enabled.updated).toBe(true);
            expect(
              (
                await fixture.decisions.authorizeInvoke(scopeA, {
                  installId: target.installId,
                })
              ).outcome,
            ).toBe("allow");
          },
        );

        itDb(
          "cross-company setEnabled is an honest no-op (updated:false) and changes nothing",
          async () => {
            const scopeB = await scopeOf(fixture, "b1-member", "team-b1");
            // setEnabled 以 tenant 定界：他司 install id 不在本司租户臂内，
            // UPDATE 命中 0 行，如实返回 updated:false。
            const result = await fixture.admin.setEnabled({
              tenantId: scopeB.tenantId,
              installId: insA2.installId,
              status: "disabled",
            });
            expect(result.updated).toBe(false);
            const scopeA = await scopeOf(fixture, "a2-member", "team-a2");
            expect(
              (
                await fixture.decisions.authorizeInvoke(scopeA, {
                  installId: insA2.installId,
                })
              ).outcome,
            ).toBe("allow");
          },
        );
      },
    );

    // -----------------------------------------------------------------
    // AC4：安装配置中的秘密脱敏保存与展示
    // -----------------------------------------------------------------
    describeDb(
      "AC4 install secrets are sealed at rest and redacted on display",
      () => {
        itDb(
          "the stored row carries only the sealed envelope, never a plaintext column",
          async () => {
            const row = await fixture.installRow({
              tenantId: insA1.tenantId,
              installId: insA1.installId,
            });
            expect(row?.envelope).toBe(`v1:${CANARY_SECRET_A1}`);
            // 明文列不存在：存储形状里秘密只有一个密封去处。
            expect(Object.keys(row as object)).not.toContain("plaintext");
          },
        );

        itDb(
          "config keys that would carry secrets are refused at the module boundary (nothing stored)",
          async () => {
            const fact = fixture.base.teamOf("a1-member", "team-a1");
            for (const carrierKey of [
              "envelope",
              "plaintext",
              "secret",
              "token",
              "password",
              "apiKey",
            ]) {
              const message = await thrownMessage(
                fixture.admin.install({
                  tenantId: fact.tenantId,
                  workspaceId: fact.workspaceId,
                  installedBy: fact.principalId,
                  catalogId: catMcp.catalogId,
                  config: { [carrierKey]: "x" },
                }),
              );
              expect(message).toContain("PLUGIN_INSTALL_INVALID: config");
            }
          },
        );

        itDb(
          "the storage CHECK independently refuses secret-carrier config keys (23514)",
          async () => {
            expect(
              await fixture.rawInstallInsert({
                tenantId: insA1.tenantId,
                catalogId: catMcp.catalogId,
                workspaceId: insA1.workspaceId,
                installedBy: fixture.principalOf("a1-member", "company-a"),
                config: { secret: "bypass" },
              }),
            ).toBe("23514");
          },
        );

        itDb(
          "the catalog metadata closed shape refuses company-private surfaces in storage (23514)",
          async () => {
            expect(
              await fixture.rawCatalogInsert({
                metadata: { envelope: "x" },
              }),
            ).toBe("23514");
            expect(
              await fixture.rawCatalogInsert({
                metadata: { config: { tenant: "a" } },
              }),
            ).toBe("23514");
          },
        );

        itDb(
          "redacted views expose hasSecret, never the material (canary scan)",
          async () => {
            const scope = await scopeOf(fixture, "a1-member", "team-a1");
            const described = await fixture.decisions.describeInstall(
              scope,
              insA1.installId,
            );
            expect(described.outcome).toBe("allow");
            if (described.outcome !== "allow") return;
            expect(described.install.hasSecret).toBe(true);
            assertRedactedShape(described.install);
            expect(JSON.stringify(described)).not.toContain(CANARY_SECRET_A1);
            expect(JSON.stringify(described)).not.toContain("v1:");
            // 列表同样无载体：A 公司列表里带秘密的安装只暴露布尔。
            const list = await fixture.decisions.listInstalls(scope);
            assertRedactedShape(list);
            expect(JSON.stringify(list)).not.toContain(CANARY_SECRET_A1);
            // allow 判定的安装视图同样无载体（材料只在 envelope 字段）。
            const resolution = await fixture.decisions.authorizeInvoke(scope, {
              installId: insA1.installId,
            });
            if (resolution.outcome === "allow") {
              assertRedactedShape(resolution.install);
              expect(resolution.envelope).toBe(`v1:${CANARY_SECRET_A1}`);
              expect(JSON.stringify(resolution.install)).not.toContain(
                CANARY_SECRET_A1,
              );
            }
          },
        );

        itDb(
          "denied outputs carry neither envelope nor config (structural: deny has no material field)",
          async () => {
            const scopeB = await scopeOf(fixture, "b1-member", "team-b1");
            const verdict = await fixture.decisions.authorizeInvoke(scopeB, {
              installId: insA1.installId,
            });
            assertCanonicalDeny(verdict);
            expect(JSON.stringify(verdict)).not.toContain(CANARY_SECRET_A1);
            expect(JSON.stringify(verdict)).not.toContain("envelope");
          },
        );
      },
    );

    // -----------------------------------------------------------------
    // 成员资格生命周期闸门（纵深防御的第二道独立防线）：scope 是受信对象，
    // 判定层在真实 RLS 下独立重核公司/团队成员资格与 epoch——成员停用对
    // 已发出的 scope 立即关闭后续调用与读取。
    // -----------------------------------------------------------------
    describeDb(
      "membership lifecycle gates re-verified inside the decision layer",
      () => {
        itDb(
          "a suspended company membership stops invocation and description immediately",
          async () => {
            const target = await fixture.provisionInstall({
              identity: "a1-member",
              teamKey: "team-a1",
              catalogId: catOpenConnector.catalogId,
              config: {},
            });
            // scope 是签发时的受信对象；判定层在真实 RLS 下独立重核成员资格。
            const scope = await scopeOf(fixture, "a1-member", "team-a1");
            await fixture.setCompanyMembershipStatus(
              "a1-member",
              "company-a",
              "suspended",
            );
            const before = fixture.vendorProbe.calls();
            assertCanonicalDeny(
              await fixture.decisions.authorizeInvoke(scope, {
                installId: target.installId,
              }),
            );
            assertCanonicalDeny(
              await fixture.decisions.describeInstall(scope, target.installId),
            );
            expect(fixture.vendorProbe.calls()).toBe(before);
            // 恢复，避免影响后续用例的夹具共享状态。
            await fixture.setCompanyMembershipStatus(
              "a1-member",
              "company-a",
              "active",
            );
          },
        );

        itDb(
          "a suspension without an epoch bump still stops invocation (status enforced, not just epoch)",
          async () => {
            const target = await fixture.provisionInstall({
              identity: "a1-member",
              teamKey: "team-a1",
              catalogId: catOpenConnector.catalogId,
              config: {},
            });
            const scope = await scopeOf(fixture, "a1-member", "team-a1");
            await fixture.setCompanyMembershipStatusWithoutEpochBump(
              "a1-member",
              "company-a",
              "suspended",
            );
            const before = fixture.vendorProbe.calls();
            assertCanonicalDeny(
              await fixture.decisions.authorizeInvoke(scope, {
                installId: target.installId,
              }),
            );
            expect(fixture.vendorProbe.calls()).toBe(before);
            // 恢复（同样不动 epoch）。
            await fixture.setCompanyMembershipStatusWithoutEpochBump(
              "a1-member",
              "company-a",
              "active",
            );
            expect(
              (
                await fixture.decisions.authorizeInvoke(scope, {
                  installId: target.installId,
                })
              ).outcome,
            ).toBe("allow");
          },
        );

        itDb(
          "a scope issued before a suspension is still refused after re-activation (epoch gate)",
          async () => {
            const target = await fixture.provisionInstall({
              identity: "a1-member",
              teamKey: "team-a1",
              catalogId: catOpenConnector.catalogId,
              config: {},
            });
            // 先发 scope（旧 epoch），再停用 + 恢复（epoch 两跳）。
            const staleScope = await scopeOf(fixture, "a1-member", "team-a1");
            await fixture.setCompanyMembershipStatus(
              "a1-member",
              "company-a",
              "suspended",
            );
            await fixture.setCompanyMembershipStatus(
              "a1-member",
              "company-a",
              "active",
            );
            const before = fixture.vendorProbe.calls();
            // 成员资格现为 active，但 stale scope 的 epoch 已过期：仍拒。
            assertCanonicalDeny(
              await fixture.decisions.authorizeInvoke(staleScope, {
                installId: target.installId,
              }),
            );
            expect(fixture.vendorProbe.calls()).toBe(before);
            // 新 scope（当前 epoch）放行。
            const freshScope = await scopeOf(fixture, "a1-member", "team-a1");
            expect(
              (
                await fixture.decisions.authorizeInvoke(freshScope, {
                  installId: target.installId,
                })
              ).outcome,
            ).toBe("allow");
          },
        );

        itDb(
          "a suspended team membership stops invocation and removes the install from listing",
          async () => {
            const target = await fixture.provisionInstall({
              identity: "a2-member",
              teamKey: "team-a2",
              catalogId: catOpenConnector.catalogId,
              config: {},
            });
            const scope = await scopeOf(fixture, "a2-member", "team-a2");
            await fixture.base.setTeamMembershipStatus(
              "a2-member",
              "team-a2",
              "suspended",
            );
            const before = fixture.vendorProbe.calls();
            assertCanonicalDeny(
              await fixture.decisions.authorizeInvoke(scope, {
                installId: target.installId,
              }),
            );
            expect(
              (await fixture.decisions.listInstalls(scope)).map(
                (install) => install.installId,
              ),
            ).not.toContain(target.installId);
            expect(fixture.vendorProbe.calls()).toBe(before);
            // 恢复。
            await fixture.base.setTeamMembershipStatus(
              "a2-member",
              "team-a2",
              "active",
            );
          },
        );

        itDb(
          "a dual-team member lists installs from both of their teams (visibility = membership)",
          async () => {
            const scope = await scopeOf(fixture, "a1a2-member", "team-a1");
            const listed = (await fixture.decisions.listInstalls(scope)).map(
              (install) => install.installId,
            );
            expect(listed).toContain(insA1.installId);
            expect(listed).toContain(insA2.installId);
            expect(listed).not.toContain(insB1.installId);
          },
        );
      },
    );

    // -----------------------------------------------------------------
    // 存储契约：FORCE RLS、最小授权、事务上下文、fail-closed
    // -----------------------------------------------------------------
    describeDb("storage contract for the three plugin tables", () => {
      itDb("all three tables run under FORCE ROW LEVEL SECURITY", async () => {
        for (const table of [
          "enterprise_plugin_catalog",
          "enterprise_plugin_installs",
          "enterprise_plugin_connections",
        ]) {
          const flags = await fixture.catalog.rlsFlags(table);
          expect(flags.relrowsecurity).toBe(true);
          expect(flags.relforcerowsecurity).toBe(true);
        }
      });

      itDb(
        "the grant matrix is minimal (installs/connections tenant-scoped, directory zero)",
        async () => {
          expect(
            await fixture.catalog.hasPrivilege(
              "enterprise_plugin_installs",
              "ob_ent_data",
              "SELECT",
            ),
          ).toBe(true);
          expect(
            await fixture.catalog.hasPrivilege(
              "enterprise_plugin_installs",
              "ob_ent_operator",
              "DELETE",
            ),
          ).toBe(true);
          expect(
            await fixture.catalog.hasPrivilege(
              "enterprise_plugin_installs",
              "ob_ent_directory",
              "SELECT",
            ),
          ).toBe(false);
          expect(
            await fixture.catalog.hasPrivilege(
              "enterprise_plugin_connections",
              "ob_ent_data",
              "SELECT",
            ),
          ).toBe(true);
          expect(
            await fixture.catalog.hasPrivilege(
              "enterprise_plugin_connections",
              "ob_ent_operator",
              "INSERT",
            ),
          ).toBe(true);
          expect(
            await fixture.catalog.hasPrivilege(
              "enterprise_plugin_connections",
              "ob_ent_directory",
              "SELECT",
            ),
          ).toBe(false);
        },
      );

      itDb(
        "RLS is real: the data role pinned to company B cannot read company A's install row",
        async () => {
          const rows = (await fixture.base.data.transaction(async (tx) => {
            await tx.execute(
              sql`select set_config('app.tenant_id', ${insB1.tenantId}, true)`,
            );
            return tx.execute(
              sql`select count(*)::int as n from enterprise_plugin_installs
                  where tenant_id = ${insA1.tenantId}`,
            );
          })) as unknown as Record<string, unknown>[];
          expect(Number(rows[0]?.n)).toBe(0);
        },
      );

      itDb(
        "transaction-local context is gone after commit on the pooled connection",
        async () => {
          await fixture.base.data.transaction(async (tx) => {
            await tx.execute(
              sql`select set_config('app.tenant_id', ${insA1.tenantId}, true), set_config('app.principal_id', ${fixture.principalOf("a1-member", "company-a")}, true)`,
            );
          });
          const result = (await fixture.base.data.execute(
            sql`select nullif(current_setting('app.tenant_id', true), '') as tenant, nullif(current_setting('app.principal_id', true), '') as principal`,
          )) as unknown as Record<string, unknown>[];
          expect(result[0]?.tenant).toBeNull();
          expect(result[0]?.principal).toBeNull();
        },
      );

      itDb(
        "unverified database channels are fail-closed at construction",
        async () => {
          const unverified = createDatabase(enterpriseTestDatabaseUrlFrom(), {
            max: 1,
          });
          try {
            const vaultStub = {
              seal: async (plaintext: string) => `v1:${plaintext}`,
              open: async (envelope: string) => envelope.slice(3),
            };
            expect(() =>
              createPluginCatalogDecisionService(unverified as never),
            ).toThrow("UNVERIFIED_DATABASE_CAPABILITY");
            expect(() =>
              createPluginCatalogAdminService(unverified as never, vaultStub),
            ).toThrow("UNVERIFIED_DATABASE_CAPABILITY");
          } finally {
            await unverified.$client.close().catch(() => {});
          }
        },
      );
    });
  },
);
