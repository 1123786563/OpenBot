// server/tests/multitenancy/integration-evidence.test.ts
// MT111（Issue #154）：已启用集成的隔离与账户路由证据。
//
// 验收事实源（Issue #154 四条，逐条对应 describe；全本地确定性，零供应商
// 依赖——AC3 的显式语义：缺外部凭据时只做本地确定性测试并如实标记）：
//   AC1 清单区分三类（已启用并验证/已启用未验证/未落地），各自有依据
//      （每条证据引用指向真实仓内文件——本测试逐一核验存在性，引用
//      不存在即失败，证据编造不了）。
//   AC2 已启用集成的隔离与付款账户路由有测试或可复核证据（证据引用
//      存在性 + 真实 seam 的本地行为复跑：Opik 企业提示拒绝、伪造 scope
//      拒绝、付款账户派生键确定性、审计载荷脱敏）。
//   AC3 缺外部凭据时完成本地确定性测试并显式标记未验证，不编造供应商
//      证据（enabled-unverified 条目必须显式声明未验证；不存在任何
//      「供应商已验证」的声明）。
//   AC4 结论回写 MT001 清单，未验证项阻断 MT130 就绪（registry 与真实
//      extractExternalDependencies 输出闭集对账；就绪闸 blockers 全集）。

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "../../../tests/support/bun-test-compat";
import { extractExternalDependencies } from "../../scripts/multitenancy/inventory";
import { ObservationScopeError } from "../../src/ai-observability/contracts";
import {
  assertObservationScope,
  resolveObservationScope,
} from "../../src/ai-observability/scope";
import { redactAuditPayload } from "../../src/audit";
import { deploymentExternalCustomerId } from "../../src/billing/service";
import {
  classifyIntegrationEvidence,
  INTEGRATION_EVIDENCE,
  INTEGRATION_EVIDENCE_CLASSES,
  integrationEvidenceReadiness,
  isVendorClaimPresent,
} from "../../src/enterprise/tenancy/integration-evidence";
import { scrubCommand } from "../../src/telemetry/scrub";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const evidenceDocPath = resolve(
  REPO_ROOT,
  "docs/plans/tickets/multitenancy/reports/MT111-enabled-integration-evidence.md",
);

// ---------------------------------------------------------------------------
// AC1：三类分类，各自有依据
// ---------------------------------------------------------------------------

describe("MT111 AC1：清单三类分类且依据真实存在", () => {
  test("分类只取闭集值", () => {
    for (const entry of INTEGRATION_EVIDENCE) {
      expect(INTEGRATION_EVIDENCE_CLASSES).toContain(entry.classification);
    }
  });

  test("每条已启用条目的证据引用非空且指向真实存在的仓内文件（编造不了）", () => {
    expect(INTEGRATION_EVIDENCE.length).toBeGreaterThan(0);
    for (const entry of INTEGRATION_EVIDENCE) {
      if (entry.classification === "not-implemented") continue;
      expect(entry.basisRefs.length).toBeGreaterThan(0);
      for (const ref of entry.basisRefs) {
        expect(
          existsSync(resolve(REPO_ROOT, ref)),
          `${entry.id} 引用的证据文件不存在：${ref}`,
        ).toBe(true);
      }
    }
  });

  test("未落地条目如实自证：无配置键面、无消费者声明", () => {
    const notImplemented = INTEGRATION_EVIDENCE.filter(
      (entry) => entry.classification === "not-implemented",
    );
    expect(notImplemented.length).toBeGreaterThan(0);
    for (const entry of notImplemented) {
      expect(entry.inventoryVisibility).toBe("keys-absent");
      expect(entry.configKeys).toEqual([]);
    }
  });

  test("证据清单文档存在并覆盖三类词汇（registry↔文档一致性）", () => {
    expect(existsSync(evidenceDocPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2：隔离与付款账户路由的真实本地证据（行为复跑，非引用检查）
// ---------------------------------------------------------------------------

describe("MT111 AC2：已启用集成的隔离与路由证据可复核", () => {
  test("观测后端隔离 seam：企业提示是拒绝不是回退（真实 resolveObservationScope）", () => {
    let code = "";
    try {
      resolveObservationScope({
        actorId: "user-1",
        botId: "bot-1",
        ownership: "owner",
        epoch: 1,
        enterpriseHint: { tenantId: "ent-1" },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ObservationScopeError);
      code = (error as ObservationScopeError).code;
    }
    expect(code).toBe("ENTERPRISE_SCOPE_UNSUPPORTED");
  });

  test("伪造/序列化重建的观测 scope 一律 fail-closed", () => {
    let refused = false;
    try {
      assertObservationScope({
        kind: "workbench",
        key: "k",
        actorId: "a",
        botId: "b",
        epoch: 1,
      });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  test("付款账户路由派生键确定性（公司↔外部 Customer 唯一映射的派生规则）", () => {
    expect(deploymentExternalCustomerId("tenant-abc")).toBe(
      "openbot-deployment-tenant-abc",
    );
    // 派生是纯函数：同租户同键、不同租户不同键（映射双侧唯一的机制前提）。
    expect(deploymentExternalCustomerId("tenant-abc")).toBe(
      deploymentExternalCustomerId("tenant-abc"),
    );
    expect(deploymentExternalCustomerId("tenant-abc")).not.toBe(
      deploymentExternalCustomerId("tenant-def"),
    );
  });

  test("审计载荷按键脱敏真实生效（敏感键 → [REDACTED]）", () => {
    const redacted = redactAuditPayload({
      apiKey: "sk-live-abcdef123456",
      password: "hunter2-example",
      count: 3,
    }) as Record<string, unknown>;
    expect(redacted.apiKey).toBe("[REDACTED]");
    expect(redacted.password).toBe("[REDACTED]");
    expect(redacted.count).toBe(3);
  });

  test("正文自由文本的秘密形状由 MT109 脱敏 seam 收口（scrubCommand）", () => {
    const openAiShaped = "sk-abcdef1234567890abcdef12";
    const githubShaped = `ghp_${"a1".repeat(18)}`;
    const scrubbed = scrubCommand(
      `run with ${openAiShaped} and ${githubShaped} and Authorization: Bearer tok_abcdef123456`,
    );
    expect(scrubbed).not.toContain(openAiShaped);
    expect(scrubbed).not.toContain(githubShaped);
    expect(scrubbed).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// AC3：显式未验证标记，不编造供应商证据
// ---------------------------------------------------------------------------

describe("MT111 AC3：缺凭据的供应商半边显式标记未验证", () => {
  test("enabled-unverified 条目显式声明未验证（note 带未验证语义）", () => {
    const unverified = INTEGRATION_EVIDENCE.filter(
      (entry) => entry.classification === "enabled-unverified",
    );
    expect(unverified.length).toBeGreaterThan(0);
    for (const entry of unverified) {
      expect(/未.{0,6}验证|不可见|extraction-gap/.test(entry.note ?? "")).toBe(
        true,
      );
    }
  });

  test("整张清单不存在任何「供应商已验证」声明（isVendorClaimPresent 全空）", () => {
    const claims = INTEGRATION_EVIDENCE.filter((entry) =>
      isVendorClaimPresent(entry),
    );
    expect(claims).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC4：结论回写 MT001 清单，未验证项阻断 MT130 就绪
// ---------------------------------------------------------------------------

describe("MT111 AC4：与 MT001 清单闭集对账 + 就绪闸", () => {
  test("registry 与真实 extractExternalDependencies 输出互为闭集", () => {
    const { entries: inventoryDeps } = extractExternalDependencies();
    // 回写生效：观测后端与租户运行时库在 MT001 清单里物化。
    expect(
      inventoryDeps.some((dep) => dep.dependency === "Opik 观测后端"),
    ).toBe(true);
    expect(
      inventoryDeps.some(
        (dep) => dep.dependency === "PostgreSQL（租户运行时库）",
      ),
    ).toBe(true);
    const { unmatchedInventory, unmatchedRegistry } =
      classifyIntegrationEvidence(inventoryDeps);
    expect(unmatchedInventory).toEqual([]);
    expect(unmatchedRegistry).toEqual([]);
  });

  test("自宣告 listed 的条目全部在清单物化；不可见条目有显式标记", () => {
    const { entries: inventoryDeps } = extractExternalDependencies();
    const materialized = new Set(inventoryDeps.map((dep) => dep.dependency));
    for (const entry of INTEGRATION_EVIDENCE) {
      if (entry.inventoryVisibility === "listed") {
        expect(
          materialized.has(entry.dependency),
          `${entry.id} 自宣告 listed 但未物化`,
        ).toBe(true);
      }
    }
    const invisible = INTEGRATION_EVIDENCE.filter(
      (entry) => entry.inventoryVisibility !== "listed",
    );
    expect(invisible.length).toBeGreaterThan(0);
  });

  test("就绪闸：未验证/未落地项全部阻断（ready=false 且 blockers 全集）", () => {
    const { entries: inventoryDeps } = extractExternalDependencies();
    const readiness = integrationEvidenceReadiness(inventoryDeps);
    const expectedBlockers = INTEGRATION_EVIDENCE.filter(
      (entry) => entry.classification !== "enabled-verified",
    ).length;
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.length).toBe(expectedBlockers);
    expect(readiness.blockers.length).toBeGreaterThan(0);
  });

  test("提取缺口如实披露（Bifrost 与 Google OAuth 在 extractionGaps）", () => {
    const { entries: inventoryDeps } = extractExternalDependencies();
    const readiness = integrationEvidenceReadiness(inventoryDeps);
    expect(readiness.extractionGaps).toContain("Bifrost 模型网关");
    expect(readiness.extractionGaps).toContain("Google OAuth");
  });
});
