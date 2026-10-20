// server/tests/multitenancy/host-access.test.ts
// MT035（Issue #78）：Host Access、签入帮助与危险动作审批的归属与既有
// 行为保持。
//
// 验收事实源（Issue #78 四条，逐条对应 describe；真实 PostgreSQL，全程受限
// ob_ent_* 角色 + 真实 RLS，绝不回退开发库、缺 env 显式 skip）：
//   验收 1：host access 与签入帮助只对本范围授权主体开放；跨范围请求被
//     拒绝（同团队他人 = HOST_ACCESS_FORBIDDEN；跨团队/跨公司 = canonical
//     not-found，与不存在逐字节同形）。
//   验收 2：危险动作仍按既有规则要求审批，且审批归属与执行归属一致
//     （审批行锁定四元组 + 摘要；切团队/换人/参数漂移全部拒绝）。
//   验收 3：既有审批交互回归（提问、恢复、原生确认）由既有 approvals
//     套件覆盖——本套件之外按票面 Verification 单独执行并记录退出码。
//   验收 4：执行过程中撤权（MT006 真实 suspendMembership 递增 epoch）让
//     后续敏感动作失败而不是继续（canonical not-found）。

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
import { notFoundVerdict } from "../../src/enterprise/tenancy/not-found-semantics";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import type { IsolationFixture } from "./support/fixture";
import {
  createHostAccessFixture,
  type HostAccessFixture,
} from "./support/host-access";

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
      reason: `MT035 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

const canonicalNotFound = notFoundVerdict();
const isNotFound = (value: unknown): boolean =>
  JSON.stringify(value) === JSON.stringify(canonicalNotFound);
const FORBIDDEN = Object.freeze({
  outcome: "deny",
  code: "HOST_ACCESS_FORBIDDEN",
});
const APPROVAL_REQUIRED = Object.freeze({
  outcome: "deny",
  code: "HOST_ACTION_APPROVAL_REQUIRED",
});

// ---------------------------------------------------------------------------
// 套件状态
// ---------------------------------------------------------------------------

let fixture: HostAccessFixture;
let isolation: IsolationFixture;
let companyA = "";
let teamA1 = "";
let teamA2 = "";
let teamB1 = "";
let companyB = "";
let agentId = "";
let grantId = "";
let approvalId = "";
let dryRunOutcome: RunOutcome | undefined;
let applyOutcome: RunOutcome | undefined;

describeDb(
  "MT035 host access, check-in help and dangerous-action approvals stay scoped (Issue #78)",
  () => {
    beforeAll(async () => {
      const resolved = resolveTestDatabaseTarget(process.env);
      if (!resolved.ok) {
        throw new Error(`MT035 tests refuse to run: ${resolved.reason}`);
      }
      // 三步配方之一：dry-run（默认 migrate 即计划展示，无副作用）。
      dryRunOutcome = await runMigrateTest(["migrate", "MT035"], {
        environment: { TEST_DATABASE_URL: resolved.target.url },
        out: () => {},
      });
      if (dryRunOutcome.kind === "refused") {
        throw new Error(`MT035 dry-run refused: ${dryRunOutcome.reason}`);
      }
      // 三步配方之二：manifest 由当前计划物化。
      const manifestPath = `/tmp/mt035-manifest-${randomUUID()}.json`;
      await Bun.write(
        manifestPath,
        `${JSON.stringify(manifestFor(buildPlan("MT035")), null, 2)}\n`,
      );
      // 三步配方之三：--apply 与 manifest 逐步骤核对后执行（已应用过的库
      // 返回 up-to-date，是合法的重复运行状态）。
      try {
        applyOutcome = await runMigrateTest(
          ["migrate", "MT035", "--apply", "--manifest", manifestPath],
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
          `MT035 apply did not land: ${JSON.stringify(applyOutcome).slice(0, 200)}`,
        );
      }

      fixture = await createHostAccessFixture();
      isolation = fixture.base.isolation;
      companyA = isolation.ids["company-a"];
      teamA1 = isolation.ids["team-a1"];
      teamA2 = isolation.ids["team-a2"];
      teamB1 = isolation.ids["team-b1"];
      companyB = isolation.ids["company-b"];

      // 真实 MT016 创建路径：Bot 归属行属于 (company-a, team-a1, a1-member)。
      agentId = `mt035-bot-${randomUUID().slice(0, 8)}`;
      const scope = await fixture.scopeAs("a1-member", companyA, teamA1);
      const created = await fixture.bots.createBot(scope, {
        agentId,
        displayName: "MT035 Host Bot",
        defaultConfig: {},
      });
      if (created.outcome !== "allow") {
        throw new Error(
          `fixture bot creation failed: ${JSON.stringify(created)}`,
        );
      }

      const granted = await fixture.host.requestHostAccess(scope, {
        agentId,
        displayName: "MT035 Host",
      });
      if (granted.outcome !== "allow") {
        throw new Error(`fixture grant failed: ${JSON.stringify(granted)}`);
      }
      grantId = granted.grantId;
    });

    test("AC1 · check-in help is open only to the authorizing subject", async () => {
      const owner = await fixture.scopeAs("a1-member", companyA, teamA1);
      const result = await fixture.host.checkInHelp(owner, { grantId });
      expect(result.outcome).toBe("allow");
      if (result.outcome === "allow") {
        expect(typeof result.credentialReference).toBe("string");
        expect((result.credentialReference as string).length).toBeGreaterThan(
          0,
        );
        // 引用是派生串：不含明文形态的租户/主体键。
        expect(result.credentialReference as string).not.toContain(companyA);
      }

      // 同团队他人：行可见（同团队）但不是授权主体 → 响亮 FORBIDDEN。
      const other = await fixture.scopeAs("a1-other", companyA, teamA1);
      expect(await fixture.host.checkInHelp(other, { grantId })).toEqual(
        FORBIDDEN,
      );

      // 跨团队 / 跨公司：不可见语义 = canonical not-found（逐字节同形）。
      const crossTeam = await fixture.scopeAs("a2-member", companyA, teamA2);
      expect(
        isNotFound(await fixture.host.checkInHelp(crossTeam, { grantId })),
      ).toBe(true);
      const crossCompany = await fixture.scopeAs("b1-member", companyB, teamB1);
      expect(
        isNotFound(await fixture.host.checkInHelp(crossCompany, { grantId })),
      ).toBe(true);

      // 不存在的 grant：与跨范围同形（不泄露存在性）。
      expect(
        isNotFound(
          await fixture.host.checkInHelp(owner, { grantId: `${grantId}-x` }),
        ),
      ).toBe(true);
    });

    test("AC1 · grants list only shows the caller's own rows in scope", async () => {
      const owner = await fixture.scopeAs("a1-member", companyA, teamA1);
      const own = await fixture.host.listGrants(owner);
      expect(own.some((row) => row.grantId === grantId)).toBe(true);

      const other = await fixture.scopeAs("a1-other", companyA, teamA1);
      const otherList = await fixture.host.listGrants(other);
      expect(otherList.some((row) => row.grantId === grantId)).toBe(false);
    });

    test("AC1 · requesting host access for an out-of-scope bot is invisible", async () => {
      const other = await fixture.scopeAs("a1-other", companyA, teamA1);
      const attempt = await fixture.host.requestHostAccess(other, {
        agentId: `${agentId}-invisible`,
        displayName: "ghost",
      });
      expect(isNotFound(attempt)).toBe(true);
    });

    test("AC2 · dangerous actions require an approval whose scope matches the executor", async () => {
      const owner = await fixture.scopeAs("a1-member", companyA, teamA1);
      const params = { command: "rm -rf /tmp/mt035-demo", writable: true };

      // 未发起审批：执行被拒绝（不静默放行）。
      expect(
        await fixture.host.executeDangerousAction(owner, {
          approvalId: "mt035-approval-none",
          params,
        }),
      ).toEqual(APPROVAL_REQUIRED);

      // 发起审批 → 未决定前执行仍拒绝。
      const requested = await fixture.host.requestDangerousAction(owner, {
        grantId,
        operation: "run_command",
        params,
      });
      expect(requested.outcome).toBe("allow");
      approvalId = (requested as { approvalId: string }).approvalId;
      expect(
        await fixture.host.executeDangerousAction(owner, {
          approvalId,
          params,
        }),
      ).toEqual(APPROVAL_REQUIRED);

      // 他人不能决定别人的审批（审批归属与执行归属一致）。
      const other = await fixture.scopeAs("a1-other", companyA, teamA1);
      expect(
        await fixture.host.decideDangerousAction(other, {
          approvalId,
          decision: "approve",
        }),
      ).toEqual(FORBIDDEN);

      // 本人批准后：同参数执行 allow；参数漂移 = 摘要不匹配 = 拒绝。
      const decided = await fixture.host.decideDangerousAction(owner, {
        approvalId,
        decision: "approve",
      });
      expect(decided.outcome).toBe("allow");
      const executed = await fixture.host.executeDangerousAction(owner, {
        approvalId,
        params,
      });
      expect(executed.outcome).toBe("allow");
      expect(
        await fixture.host.executeDangerousAction(owner, {
          approvalId,
          params: { ...params, command: "rm -rf /tmp/mt035-drifted" },
        }),
      ).toEqual(APPROVAL_REQUIRED);

      // 切换团队执行：审批行经 RLS + 谓词不可见 = canonical not-found，
      // 不存在跨范围复用通道。
      const crossTeam = await fixture.scopeAs("a2-member", companyA, teamA2);
      expect(
        isNotFound(
          await fixture.host.executeDangerousAction(crossTeam, {
            approvalId,
            params,
          }),
        ),
      ).toBe(true);
    });

    test("AC2 · client-declared attribution keys in params are loudly rejected", async () => {
      const owner = await fixture.scopeAs("a1-member", companyA, teamA1);
      await expect(
        fixture.host.requestDangerousAction(owner, {
          grantId,
          operation: "write_file",
          params: {
            relativePath: "a.txt",
            tenantId: companyA,
          } as never,
        }),
      ).rejects.toThrow("ATTRIBUTION_NOT_CLIENT_DECLARABLE");
    });

    test("AC4 · suspension kills further sensitive actions mid-run", async () => {
      const owner = await fixture.scopeAs("a1-member", companyA, teamA1);
      const params = { command: "echo mt035-suspended" };

      const requested = await fixture.host.requestDangerousAction(owner, {
        grantId,
        operation: "run_command",
        params,
      });
      expect(requested.outcome).toBe("allow");
      const suspendedApprovalId = (requested as { approvalId: string })
        .approvalId;
      const decided = await fixture.host.decideDangerousAction(owner, {
        approvalId: suspendedApprovalId,
        decision: "approve",
      });
      expect(decided.outcome).toBe("allow");

      // 真实 MT006 撤权：epoch 递增，已签发 scope 的判定立即失效。
      await fixture.suspendCompanyMembership("a1-member", companyA);

      // 后续敏感动作：签入帮助与危险动作执行都失败（canonical not-found）。
      expect(
        isNotFound(await fixture.host.checkInHelp(owner, { grantId })),
      ).toBe(true);
      expect(
        isNotFound(
          await fixture.host.executeDangerousAction(owner, {
            approvalId: suspendedApprovalId,
            params,
          }),
        ),
      ).toBe(true);
    });

    // 既有审批交互（提问、恢复、原生确认）由既有 approvals 套件回归——
    // 票面 Verification：bun test 本文件 + approvals 套件（见报告）。
  },
);
