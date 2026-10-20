// server/tests/multitenancy/learning-demonstrations.test.ts
// MT040（Issue #83）：学习容器、研究与演示记录隔离。
//
// 验收事实源（Issue #83 四条，逐条对应 describe；真实 PostgreSQL，全程受限
// ob_ent_* 角色 + 真实 RLS，绝不回退开发库、缺 env 显式 skip）：
//   验收 1：容器分配记录归属；回收后不复用给另一范围而不清理状态。
//   验收 2：研究与演示记录只对本范围授权主体可见（跨团队/跨公司空页，
//     不泄露存在性）。
//   验收 3：外部服务调用的命名空间/路径按归属隔离，且不含明文凭据
//     （namespace 工厂纯函数 + DB CHECK 形状钉死；真实外部学习服务联调
//     未验证——票面备注：不编造证据）。
//   验收 4：撤销访问后正在运行的学习任务在下一个敏感动作处失败或取消
//     （MT006 真实 suspendMembership 递增 epoch）。

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  buildPlan,
  manifestFor,
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import { learningNamespace } from "../../src/enterprise/tenancy/learning-demonstrations";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import type { IsolationFixture } from "./support/fixture";
import {
  createLearningDemonstrationFixture,
  type LearningDemonstrationFixture,
} from "./support/learning-demonstrations";

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
      reason: `MT040 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    enterpriseRuntimeDatabaseUrlFrom("directory", process.env);
    enterpriseRuntimeDatabaseUrlFrom("data", process.env);
    enterpriseRuntimeDatabaseUrlFrom("operator", process.env);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const ENV = probeEnvironment();
const describeDb = ENV.ok ? describe : describe.skip;

const isNotFound = (value: unknown): boolean =>
  JSON.stringify(value) ===
  JSON.stringify({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });

// ---------------------------------------------------------------------------
// 套件状态
// ---------------------------------------------------------------------------

let fixture: LearningDemonstrationFixture;
let isolation: IsolationFixture;
let companyA = "";
let teamA1 = "";
let teamA2 = "";
let companyB = "";
let teamB1 = "";
let firstContainerId = "";
let secondContainerId = "";
let researchRecordId = "";
let demoRecordId = "";

describeDb(
  "MT040 learning containers, research and demonstration records stay scoped (Issue #83)",
  () => {
    beforeAll(async () => {
      const resolved = resolveTestDatabaseTarget(process.env);
      if (!resolved.ok) {
        throw new Error(`MT040 tests refuse to run: ${resolved.reason}`);
      }
      // 三步配方（与 MT035/MT039 同款；已应用过的库返回 up-to-date 合法）。
      const dryRunOutcome = await runMigrateTest(["migrate", "MT040"], {
        environment: { TEST_DATABASE_URL: resolved.target.url },
        out: () => {},
      });
      if (dryRunOutcome.kind === "refused") {
        throw new Error(`MT040 dry-run refused: ${dryRunOutcome.reason}`);
      }
      const manifestPath = `/tmp/mt040-manifest-${randomUUID()}.json`;
      await Bun.write(
        manifestPath,
        `${JSON.stringify(manifestFor(buildPlan("MT040")), null, 2)}\n`,
      );
      let applyOutcome: RunOutcome | undefined;
      try {
        applyOutcome = await runMigrateTest(
          ["migrate", "MT040", "--apply", "--manifest", manifestPath],
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
          `MT040 apply did not land: ${JSON.stringify(applyOutcome).slice(0, 200)}`,
        );
      }

      fixture = await createLearningDemonstrationFixture();
      isolation = fixture.base.isolation;
      companyA = isolation.ids["company-a"];
      teamA1 = isolation.ids["team-a1"];
      teamA2 = isolation.ids["team-a2"];
      companyB = isolation.ids["company-b"];
      teamB1 = isolation.ids["team-b1"];
    });

    test("AC1 · containers record ownership and are never reused after release", async () => {
      const member = await fixture.scopeAs("a1-member", companyA, teamA1);

      const first = await fixture.learning.allocateContainer(member, {
        // 声明性输入：任何字段（含凭据字样）都进不了 namespace。
        note: "mt040-first",
      });
      expect(first.outcome).toBe("allow");
      firstContainerId = (first as { containerId: string }).containerId;

      const released = await fixture.learning.releaseContainer(member, {
        containerId: firstContainerId,
      });
      expect(released.outcome).toBe("allow");

      // 回收后：新分配必然是新行（新 id），旧行不复用。
      const second = await fixture.learning.allocateContainer(member);
      expect(second.outcome).toBe("allow");
      secondContainerId = (second as { containerId: string }).containerId;
      expect(secondContainerId).not.toBe(firstContainerId);

      // 已释放容器上不能再写记录（同范围本人 = canonical not-found）。
      expect(
        isNotFound(
          await fixture.learning.recordResearch(member, {
            containerId: firstContainerId,
            title: "mt040-on-released",
            payload: "x",
          }),
        ),
      ).toBe(true);

      // 另一范围拿旧容器 id：不可见（跨公司结构性不可达）。
      const b1 = await fixture.scopeAs("b1-member", companyB, teamB1);
      expect(
        isNotFound(
          await fixture.learning.recordResearch(b1, {
            containerId: firstContainerId,
            title: "mt040-cross-company",
            payload: "x",
          }),
        ),
      ).toBe(true);
    });

    test("AC2 · research and demonstration records are visible only in scope", async () => {
      const member = await fixture.scopeAs("a1-member", companyA, teamA1);
      const secret = `mt040-research-${randomUUID().slice(0, 8)}`;
      const research = await fixture.learning.recordResearch(member, {
        containerId: secondContainerId,
        title: secret,
        payload: "research payload",
      });
      expect(research.outcome).toBe("allow");
      researchRecordId = (research as { recordId: string }).recordId;
      const demo = await fixture.learning.recordDemonstration(member, {
        containerId: secondContainerId,
        title: `mt040-demo-${randomUUID().slice(0, 8)}`,
        payload: "demo payload",
      });
      expect(demo.outcome).toBe("allow");
      demoRecordId = (demo as { recordId: string }).recordId;

      // 本团队授权主体可见（同团队他人也是本范围主体）。
      const own = await fixture.learning.listRecords(member);
      expect(own.some((row) => row.recordId === researchRecordId)).toBe(true);
      expect(own.some((row) => row.recordId === demoRecordId)).toBe(true);
      const teammate = await fixture.scopeAs("a1-other", companyA, teamA1);
      const teammateList = await fixture.learning.listRecords(teammate);
      expect(
        teammateList.some((row) => row.recordId === researchRecordId),
      ).toBe(true);

      // 跨团队 / 跨公司：空页（不泄露存在性）。
      const crossTeam = await fixture.scopeAs("a2-member", companyA, teamA2);
      const crossTeamList = await fixture.learning.listRecords(crossTeam);
      expect(
        crossTeamList.some((row) => row.recordId === researchRecordId),
      ).toBe(false);
      expect(crossTeamList.some((row) => row.recordId === demoRecordId)).toBe(
        false,
      );
      const b1 = await fixture.scopeAs("b1-member", companyB, teamB1);
      const crossCompanyList = await fixture.learning.listRecords(b1);
      expect(
        crossCompanyList.some((row) => row.recordId === researchRecordId),
      ).toBe(false);
    });

    test("AC3 · namespaces derive from ownership and never carry credentials", async () => {
      // 纯函数：同归属稳定；范围任一维度变化即不同命名空间。
      const a1 = { tenantId: companyA, workspaceId: teamA1 };
      const a2 = { tenantId: companyA, workspaceId: teamA2 };
      const b1 = { tenantId: companyB, workspaceId: teamB1 };
      expect(learningNamespace(a1)).toBe(learningNamespace(a1));
      const namespaces = [a1, a2, b1].map(learningNamespace);
      expect(new Set(namespaces).size).toBe(3);
      for (const ns of namespaces) {
        expect(ns).toMatch(/^mt040-ns-[0-9a-f]{32}$/);
        // 不含明文凭据载体（命名空间只由归属派生）。
        expect(ns.toLowerCase()).not.toContain("secret");
        expect(ns.toLowerCase()).not.toContain("password");
        expect(ns.toLowerCase()).not.toContain("token");
      }

      // 带凭据字样的调用输入进不了 namespace：分配结果仍等于工厂值。
      const member = await fixture.scopeAs("a1-member", companyA, teamA1);
      const allocated = await fixture.learning.allocateContainer(member, {
        apiKey: "secret-password-token-mt040",
        password: "hunter2",
      } as Record<string, unknown>);
      expect(allocated.outcome).toBe("allow");
      expect((allocated as { namespace: string }).namespace).toBe(
        learningNamespace({
          tenantId: companyA,
          workspaceId: teamA1,
        }),
      );
    });

    test("AC4 · revocation fails the next sensitive action mid-run", async () => {
      const member = await fixture.scopeAs("a1-member", companyA, teamA1);
      const allocated = await fixture.learning.allocateContainer(member);
      expect(allocated.outcome).toBe("allow");
      const containerId = (allocated as { containerId: string }).containerId;

      // 真实 MT006 撤权：epoch 递增，已签发 scope 的判定立即失效。
      await fixture.suspendCompanyMembership("a1-member", companyA);

      // 正在运行的学习任务在下一个敏感动作处失败（canonical not-found）。
      expect(
        isNotFound(
          await fixture.learning.recordDemonstration(member, {
            containerId,
            title: "mt040-after-suspension",
            payload: "x",
          }),
        ),
      ).toBe(true);
      expect(isNotFound(await fixture.learning.allocateContainer(member))).toBe(
        true,
      );
    });
  },
);
