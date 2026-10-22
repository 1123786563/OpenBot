// server/tests/multitenancy/marketplace-install.test.ts
// MT020（Issue #63）：专家/模板安装与安装回执的公司团队归属。
//
// 验收事实源（Issue #63 四条，逐条对应 describe）：
//   (1) 平台公共目录对已认证用户只读可见；其中不含任何公司私有内容。
//   (2) 安装产生的 Bot/技能/配置记录当前公司与团队；另一公司无法看到
//       或升级它。
//   (3) 升级与卸载按安装回执校验归属，不接受请求体指定的归属。
//   (4) 同一模板被两家公司分别安装时互不影响（含版本号与默认配置）。
//
// 判定事实源：enterprise_bot_ownership（MT016 归属面）+
// enterprise_resources kind='marketplace-install'（MT008 回执面）。安装与
// 升级/卸载全部经本票单一判定入口 createMarketplaceInstallService，
// 不各自实现归属判断。不可见对象按 MT011 canonical not-found 处理，
// 错误与计数不泄露存在性。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_
// DATABASE_URL）加三个受限角色 URL；缺配置时整套显式 skip（跳过原因
// 写在用例名里，skipped 不计为通过），绝不回退开发库。

import { afterAll, beforeAll, describe, expect, test } from "../../../tests/support/e2e-compat";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  MARKETPLACE_RECEIPT_KIND,
  MARKETPLACE_RECEIPT_PREFIX,
  type MarketplaceCatalogEntry,
} from "../../src/enterprise/tenancy/marketplace-install";
import {
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import {
  type MarketplaceFixture,
  type MarketplaceIdentity,
  createMarketplaceFixture,
} from "./support/marketplace-install";

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
      reason: `MT020 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
const itDb = ((name: string, fn: () => Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

const isCanonicalNotFound = (value: unknown): boolean =>
  JSON.stringify(value) === serializeNotFoundVerdict(notFoundVerdict());

/** 目录 v1（两条模板）；v2 只升 slug-expert-x，另一条保持不动。 */
const CATALOG_V1: readonly MarketplaceCatalogEntry[] = [
  {
    slug: "expert-x",
    kind: "expert",
    name: "MT020 Expert X",
    version: 1,
    defaultConfig: { tone: "concise", lang: "zh" },
  },
  {
    slug: "expert-y",
    kind: "expert",
    name: "MT020 Expert Y",
    version: 3,
    defaultConfig: { depth: "deep" },
  },
  {
    slug: "expert-z",
    kind: "expert",
    name: "MT020 Expert Z",
    version: 1,
    defaultConfig: { mode: "basic" },
  },
];
const CATALOG_V2: readonly MarketplaceCatalogEntry[] = [
  {
    slug: "expert-x",
    kind: "expert",
    name: "MT020 Expert X",
    version: 2,
    defaultConfig: { tone: "verbose", lang: "zh", citations: true },
  },
  {
    slug: "expert-y",
    kind: "expert",
    name: "MT020 Expert Y",
    version: 4,
    defaultConfig: { depth: "exhaustive" },
  },
  {
    slug: "expert-z",
    kind: "expert",
    name: "MT020 Expert Z",
    version: 2,
    defaultConfig: { mode: "pro" },
  },
];

const NEXT_ID = (() => {
  let n = 0;
  return () => {
    n += 1;
    return `mt020-agent-${String(n).padStart(3, "0")}`;
  };
})();

describeDb("MT020 / Issue #63 — 专家/模板安装与回执归属", () => {
  let fixture: MarketplaceFixture;
  const agentIds: string[] = [];

  const scopeAs = async (
    identity: MarketplaceIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<PlatformScope> => fixture.scopeAs(identity, tenantId, workspaceId);

  const installAs = async (
    identity: MarketplaceIdentity,
    tenantId: string,
    workspaceId: string,
    slug: string,
    proposedAgentId: string = NEXT_ID(),
  ) => {
    const scope = await scopeAs(identity, tenantId, workspaceId);
    const verdict = await fixture.marketplace.installFromCatalog(
      scope,
      slug,
      { proposedAgentId },
    );
    if (verdict.outcome === "allow" && !verdict.replay) {
      agentIds.push(proposedAgentId);
    }
    return { verdict, proposedAgentId };
  };

  beforeAll(async () => {
    fixture = await createMarketplaceFixture(CATALOG_V1);
  });

  afterAll(async () => {
    await fixture.dispose();
  });

  // -------------------------------------------------------------------------
  // AC1：公共目录只读可见；不含任何公司私有内容
  // -------------------------------------------------------------------------
  describeDb("AC1 平台公共目录对已认证用户只读可见", () => {
    itDb("两家公司成员看到同一只读投影（排序稳定、deepFrozen）", async () => {
      const viewA = await fixture.marketplace.readCatalog(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
      );
      const viewB = await fixture.marketplace.readCatalog(
        await scopeAs("b1-member", fixture.companyB, fixture.teamB1),
      );
      expect(viewA).toEqual(viewB);
      expect(viewA.map((e) => e.slug)).toEqual([
        "expert-x",
        "expert-y",
        "expert-z",
      ]);
      expect(viewA[1].version).toBe(3);
      // deepFrozen：消费方改不动目录（只读语义由对象图冻结兜底）。
      expect(Object.isFrozen(viewA)).toBe(true);
      expect(Object.isFrozen(viewA[0])).toBe(true);
      expect(() => {
        (viewA[0] as { version: number }).version = 99;
      }).toThrow();
    });

    itDb("目录投影不含任何租户键（AC1 形状断言）", async () => {
      const view = await fixture.marketplace.readCatalog(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
      );
      for (const entry of view) {
        expect(Object.keys(entry).sort()).toEqual([
          "kind",
          "name",
          "slug",
          "version",
        ]);
      }
    });

    itDb("毒目录条目在装配点响亮拒绝——目录不可能携带公司私有内容", () => {
      const poisoned: readonly MarketplaceCatalogEntry[] = [
        {
          slug: "expert-poison",
          kind: "expert",
          name: "Poison",
          version: 1,
          defaultConfig: {
            tenantId: "someone-elses-company",
            tone: "concise",
          },
        },
      ];
      expect(() => fixture.rebindCatalog(poisoned)).toThrow(
        /MARKETPLACE_CATALOG_LEAKS_TENANCY|ATTRIBUTION_NOT_CLIENT_DECLARABLE/,
      );
      // 下划线拼写同样拒绝。
      expect(() =>
        fixture.rebindCatalog([
          {
            slug: "expert-poison2",
            kind: "expert",
            name: "Poison2",
            version: 1,
            defaultConfig: { workspace_id: "x" },
          },
        ]),
      ).toThrow(/ATTRIBUTION_NOT_CLIENT_DECLARABLE/);
      // 恢复生产目录 v1，后续用例继续。
      fixture.rebindCatalog(CATALOG_V1);
    });
  });

  // -------------------------------------------------------------------------
  // AC2：安装归属；另一公司无法看到或升级它
  // -------------------------------------------------------------------------
  describeDb("AC2 安装归属当前公司与团队；另一公司看不到、不能升级", () => {
    let agentA: string;

    itDb("a1-owner 安装 expert-x：回执与产物归属 A/A1（RLS 探针）", async () => {
      const { verdict } = await installAs(
        "a1-owner",
        fixture.companyA,
        fixture.teamA1,
        "expert-x",
      );
      agentA = agentIds[agentIds.length - 1];
      expect(verdict).toEqual({
        outcome: "allow",
        replay: false,
        agentId: agentA,
      });

      const receipts = await fixture.readReceiptRowsAsData(fixture.companyA);
      expect(receipts.length).toBe(1);
      expect(receipts[0]).toEqual({
        id: agentA,
        displayName: `${MARKETPLACE_RECEIPT_PREFIX}expert-x`,
        revision: 1,
        status: "active",
      });
      const products = await fixture.readOwnershipRowsAsData(fixture.companyA);
      expect(products.length).toBe(1);
      expect(products[0].agentId).toBe(agentA);
      expect(products[0].revision).toBe(1);
      expect(products[0].config).toEqual({ tone: "concise", lang: "zh" });
    });

    itDb("listInstalls 按 RLS 租户过滤：B 公司视角为空，A 公司视角一条", async () => {
      const fromB = await fixture.marketplace.listInstalls(
        await scopeAs("b1-member", fixture.companyB, fixture.teamB1),
      );
      expect(fromB).toEqual([]);
      const fromA = await fixture.marketplace.listInstalls(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
      );
      expect(fromA.length).toBe(1);
      expect(fromA[0].agentId).toBe(agentA);
      expect(fromA[0].expertSlug).toBe("expert-x");
      expect(fromA[0].installedVersion).toBe(1);
      expect(fromA[0].workspaceId).toBe(fixture.teamA1);
    });

    itDb("B 公司直接升级 A 的回执 ref：canonical not-found（不可见，不泄露存在）", async () => {
      const verdict = await fixture.marketplace.executeMarketplaceAction(
        await scopeAs("b1-member", fixture.companyB, fixture.teamB1),
        agentA,
        "upgrade",
      );
      expect(isCanonicalNotFound(verdict)).toBe(true);
    });

    itDb("同公司另一团队（A2）升级 A1 的回执：canonical not-found", async () => {
      const verdict = await fixture.marketplace.executeMarketplaceAction(
        await scopeAs("a2-member", fixture.companyA, fixture.teamA2),
        agentA,
        "upgrade",
      );
      expect(isCanonicalNotFound(verdict)).toBe(true);
    });

    itDb("B 公司决定面（decideMarketplaceAction）同样 not-found", async () => {
      const decision = await fixture.marketplace.decideMarketplaceAction(
        await scopeAs("b1-member", fixture.companyB, fixture.teamB1),
        agentA,
        "uninstall",
      );
      expect(isCanonicalNotFound(decision)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // AC3：升级与卸载按回执校验归属，不接受请求体指定的归属
  // -------------------------------------------------------------------------
  describeDb("AC3 归属只来自回执行；请求体归属键一律拒绝", () => {
    let agentA: string;

    beforeAll(async () => {
      const { verdict } = await installAs(
        "a1-owner",
        fixture.companyA,
        fixture.teamA1,
        "expert-y",
      );
      expect(verdict.outcome).toBe("allow");
      agentA = agentIds[agentIds.length - 1];
    });

    itDb("升级请求体的 defaultConfig 带 tenantId → 响亮拒绝", async () => {
      await expect(
        fixture.marketplace.executeMarketplaceAction(
          await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
          agentA,
          "upgrade",
          { defaultConfig: { tenantId: fixture.companyB, tone: "x" } },
        ),
      ).rejects.toThrow("ATTRIBUTION_NOT_CLIENT_DECLARABLE");
    });

    itDb("升级请求体的 defaultConfig 带 workspace_id → 响亮拒绝", async () => {
      await expect(
        fixture.marketplace.executeMarketplaceAction(
          await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
          agentA,
          "upgrade",
          { defaultConfig: { workspace_id: fixture.teamB1 } },
        ),
      ).rejects.toThrow("ATTRIBUTION_NOT_CLIENT_DECLARABLE");
    });

    itDb("owner 升级正常放行（归属来自回执行，非请求体）", async () => {
      fixture.rebindCatalog(CATALOG_V2);
      const verdict = await fixture.marketplace.executeMarketplaceAction(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        agentA,
        "upgrade",
      );
      expect(verdict).toEqual({
        outcome: "allow",
        alreadyCurrent: false,
        agentId: agentA,
        version: 4,
      });
      fixture.rebindCatalog(CATALOG_V1);
    });

    itDb("已是最新版本 → alreadyCurrent 幂等", async () => {
      fixture.rebindCatalog(CATALOG_V2);
      const verdict = await fixture.marketplace.executeMarketplaceAction(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        agentA,
        "upgrade",
      );
      expect(verdict).toEqual({
        outcome: "allow",
        alreadyCurrent: true,
        agentId: agentA,
        version: 4,
      });
    });

    itDb("目录版本低于已装版本 → 降级拒绝", async () => {
      fixture.rebindCatalog([
        {
          slug: "expert-y",
          kind: "expert",
          name: "MT020 Expert Y",
          version: 2,
          defaultConfig: { depth: "shallow" },
        },
      ]);
      const verdict = await fixture.marketplace.executeMarketplaceAction(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        agentA,
        "upgrade",
      );
      expect(verdict).toEqual({
        outcome: "deny",
        code: "MARKETPLACE_DOWNGRADE_REFUSED",
      });
      fixture.rebindCatalog(CATALOG_V1);
    });

    itDb("可见但非管理（a1-other）：MARKETPLACE_FORBIDDEN，不泄露额外信息", async () => {
      const verdict = await fixture.marketplace.executeMarketplaceAction(
        await scopeAs("a1-other", fixture.companyA, fixture.teamA1),
        agentA,
        "upgrade",
      );
      expect(verdict).toEqual({ outcome: "deny", code: "MARKETPLACE_FORBIDDEN" });
    });

    itDb("公司 tenant_admin 按明确管理权限放行（每事务重验）", async () => {
      const decision = await fixture.marketplace.decideMarketplaceAction(
        await scopeAs("company-admin", fixture.companyA, fixture.teamA1),
        agentA,
        "uninstall",
      );
      expect(decision).toEqual({ outcome: "allow" });
    });
  });

  // -------------------------------------------------------------------------
  // AC4：同一模板两家公司分别安装互不影响（版本号与默认配置）
  // -------------------------------------------------------------------------
  describeDb("AC4 双公司安装同一模板互不影响", () => {
    let agentA: string;
    let agentB: string;

    beforeAll(async () => {
      await installAs(
        "a1-owner",
        fixture.companyA,
        fixture.teamA1,
        "expert-z",
      );
      agentA = agentIds[agentIds.length - 1];
      await installAs(
        "b1-member",
        fixture.companyB,
        fixture.teamB1,
        "expert-z",
      );
      agentB = agentIds[agentIds.length - 1];
      expect(agentA).not.toBe(agentB);
    });

    itDb("目录升到 v2 后只升 A：A 到 v2/config-v2，B 仍 v1/config-v1", async () => {
      fixture.rebindCatalog(CATALOG_V2);
      const upgraded = await fixture.marketplace.executeMarketplaceAction(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        agentA,
        "upgrade",
      );
      expect(upgraded).toEqual({
        outcome: "allow",
        alreadyCurrent: false,
        agentId: agentA,
        version: 2,
      });

      const productsA = await fixture.readOwnershipRowsAsData(fixture.companyA);
      const aRow = productsA.find((row) => row.agentId === agentA);
      expect(aRow?.revision).toBe(2);
      expect(aRow?.config).toEqual({ mode: "pro" });

      const productsB = await fixture.readOwnershipRowsAsData(fixture.companyB);
      const bRow = productsB.find((row) => row.agentId === agentB);
      expect(bRow?.revision).toBe(1);
      expect(bRow?.config).toEqual({ mode: "basic" });

      const receiptsB = await fixture.readReceiptRowsAsData(fixture.companyB);
      expect(
        receiptsB.find((row) => row.id === agentB)?.revision,
      ).toBe(1);
    });

    itDb("A 卸载不影响 B：B 回执与产物完好", async () => {
      const uninstalled = await fixture.marketplace.executeMarketplaceAction(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        agentA,
        "uninstall",
      );
      expect(uninstalled).toEqual({ outcome: "allow", agentId: agentA });

      const productsA = await fixture.readOwnershipRowsAsData(fixture.companyA);
      expect(productsA.find((row) => row.agentId === agentA)).toBeUndefined();

      const productsB = await fixture.readOwnershipRowsAsData(fixture.companyB);
      expect(productsB.find((row) => row.agentId === agentB)?.status).toBe(
        "active",
      );
      const fromB = await fixture.marketplace.listInstalls(
        await scopeAs("b1-member", fixture.companyB, fixture.teamB1),
      );
      expect(fromB.length).toBe(1);
      expect(fromB[0].agentId).toBe(agentB);
    });

    itDb("卸载后的回执不再出现在 listInstalls；再次升级 not-found", async () => {
      const fromA = await fixture.marketplace.listInstalls(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
      );
      expect(fromA.find((r) => r.agentId === agentA)).toBeUndefined();
      const verdict = await fixture.marketplace.executeMarketplaceAction(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        agentA,
        "upgrade",
      );
      expect(isCanonicalNotFound(verdict)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 业务回归：幂等回放、agentId 全局占用、未知 slug、受限角色通道
  // -------------------------------------------------------------------------
  describeDb("业务回归", () => {
    itDb("重复安装同 slug → 幂等回放既有回执，不双开 Bot", async () => {
      const first = await installAs(
        "a2-member",
        fixture.companyA,
        fixture.teamA2,
        "expert-x",
      );
      const firstAgent = agentIds[agentIds.length - 1];
      expect(first.verdict.replay).toBe(false);
      const second = await fixture.marketplace.installFromCatalog(
        await scopeAs("a2-member", fixture.companyA, fixture.teamA2),
        "expert-x",
        { proposedAgentId: NEXT_ID() },
      );
      expect(second).toEqual({
        outcome: "allow",
        replay: true,
        agentId: firstAgent,
      });
      // 幂等不双开：该回执的产物行只有一条（重复安装没有第二行）。
      const products = await fixture.readOwnershipRowsAsData(fixture.companyA);
      expect(
        products.filter((row) => row.agentId === firstAgent).length,
      ).toBe(1);
    });

    itDb("产物 agentId 被他公司占用 → BOT_ID_UNAVAILABLE（同码不泄露占用方）", async () => {
      const contested = NEXT_ID();
      await installAs(
        "b1-member",
        fixture.companyB,
        fixture.teamB1,
        "expert-y",
        contested,
      );
      await expect(
        fixture.marketplace.installFromCatalog(
          await scopeAs("a2-member", fixture.companyA, fixture.teamA2),
          "expert-y",
          { proposedAgentId: contested },
        ),
      ).rejects.toThrow("BOT_ID_UNAVAILABLE");
    });

    itDb("未知 slug：目录是公共常量，大方拒绝不装", async () => {
      const verdict = await fixture.marketplace.installFromCatalog(
        await scopeAs("a1-owner", fixture.companyA, fixture.teamA1),
        "expert-not-in-catalog",
        { proposedAgentId: NEXT_ID() },
      );
      expect(verdict).toEqual({ outcome: "deny", code: "MARKETPLACE_SLUG_UNKNOWN" });
    });

    itDb("受限角色全程在场（决策路径不经过超级用户）", async () => {
      const calls = fixture.restrictedCalls();
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.currentUser).toMatch(/^ob_ent_(data|operator|directory)$/);
      }
    });

    itDb("回执行 kind 固定为 marketplace-install（不与他域资源混同）", async () => {
      const receipts = await fixture.readReceiptRowsAsData(fixture.companyB);
      expect(receipts.length).toBeGreaterThan(0);
      expect(
        receipts.every((row) =>
          row.displayName.startsWith(MARKETPLACE_RECEIPT_PREFIX),
        ),
      ).toBe(true);
      expect(MARKETPLACE_RECEIPT_KIND).toBe("marketplace-install");
    });
  });
});
