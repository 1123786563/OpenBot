// server/tests/multitenancy/routing-policy.test.ts
// MT077（Issue #120）：网络策略、能力开关、模型路由与模板按公司/团队归属
// 保存与生效；团队覆盖只收窄，不放大公司安全限制。
//
// 验收事实源（Issue #120 四条，逐条对应 describe）：
//   (1) 策略只对其归属范围生效；跨范围读取返回不可见语义（RLS 让别的
//       公司的行与不存在的行同为 0 行；团队行按复合键定位，跨团队读取
//       返回 null/空，存在性不可区分）。
//   (2) 团队覆盖不能放宽公司限制（专门测试）：capability 覆盖只能为
//       false；network 覆盖强度不得低于公司、rules 必须是公司清单子集；
//       路由覆盖必须是公司路由子集、默认路由必须落在有效面内。
//   (3) 模板更新只影响本范围安装，不回写平台模板（平台目录进程内深冻结
//       封闭清单；更新按 (tenant, workspace, ref) 复合键 CAS 定位）。
//   (4) 策略变更在下一个生效点立即体现，无跨范围缓存污染（cacheKey 由
//       归属 + 版本派生，纯入参函数，无进程级可变状态——MT014/MT015
//       缓存键规则）。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_DATABASE_URL）
// 加三个受限角色 URL；缺配置时整套显式 skip（跳过原因写在用例名里，
// skipped 不计为通过），绝不回退开发库。MT077 迁移（三张策略/安装表 +
// 最小 RLS）经 MT003 工具（migrate-test.ts）真实执行，本文件不自己 DDL。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  buildPlan,
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import { createDatabase } from "../../src/db/client";
import {
  type DataDatabase,
  verifyDataDatabase,
} from "../../src/enterprise/tenancy/connections";
import {
  createRoutingPolicyService,
  findPlatformTemplate,
  PLATFORM_TEMPLATES,
  parseCompanyGovernancePolicyDocument,
  parseTeamGovernanceOverridesDocument,
  resolveGovernancePolicy,
} from "../../src/enterprise/tenancy/routing-policy";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import {
  createRoutingPolicyFixture,
  type RoutingPolicyFixture,
} from "./support/routing-policy";

// ---------------------------------------------------------------------------
// 环境探针：缺 env 显式 skip（带理由），绝不静默回退
// ---------------------------------------------------------------------------

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const required = [
    "TEST_DATABASE_URL",
    "ENTERPRISE_TEST_SETUP_DATABASE_URL",
    "ENTERPRISE_TEST_DATA_DATABASE_URL",
    "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `MT077 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    enterpriseTestDatabaseUrlFrom(process.env);
    for (const role of ["data", "operator"] as const) {
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
// 两家公司的治理策略文档（网络 / 能力 / 路由）与团队收窄覆盖
// ---------------------------------------------------------------------------

const COMPANY_A_POLICY = Object.freeze({
  network: {
    mode: "allowlist_only",
    rules: [
      { type: "domain", value: "api.company-a.example" },
      { type: "cidr", value: "10.0.0.0/8", ports: "443" },
    ],
  },
  capabilities: {
    useBots: true,
    cloudBrowser: true,
    cloudNetwork: true,
    cloudComputer: false,
    localComputer: false,
    customRules: true,
    passwordManager: false,
    slackTeams: true,
    teamBots: true,
  },
  modelRouting: {
    allowedRoutes: ["route-a-primary", "route-a-fallback"],
    defaultRoute: "route-a-primary",
  },
});

const COMPANY_B_POLICY = Object.freeze({
  network: {
    mode: "deny_all",
    rules: [],
  },
  capabilities: {
    useBots: true,
    cloudBrowser: true,
    cloudNetwork: true,
    cloudComputer: true,
    localComputer: true,
    customRules: true,
    passwordManager: true,
    slackTeams: true,
    teamBots: true,
  },
  modelRouting: {
    allowedRoutes: ["route-b-eu"],
    defaultRoute: "route-b-eu",
  },
});

const TEAM_A1_OVERRIDE = Object.freeze({
  capabilities: { customRules: false },
});

const TEAM_A1_OVERRIDE_REV2 = Object.freeze({
  network: { mode: "deny_all" },
  capabilities: { customRules: false, slackTeams: false },
  modelRouting: {
    allowedRoutes: ["route-a-fallback"],
    defaultRoute: "route-a-fallback",
  },
});

const TEAM_A2_NARROW_OVERRIDE = Object.freeze({
  capabilities: { slackTeams: false },
  modelRouting: {
    allowedRoutes: ["route-a-fallback"],
    defaultRoute: "route-a-fallback",
  },
});

/** Resolves to the thrown error message ("" when it did not throw). */
async function thrownMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    const messages: string[] = [];
    for (let e: unknown = error; e instanceof Error; e = e.cause) {
      messages.push(e.message);
    }
    return messages.join(" | ");
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

/** Recursively checks Object.isFrozen on every nested object/array. */
function everyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every((child) => everyFrozen(child));
}

describeDb("MT077 / Issue #120 — 策略分层归属与收窄覆盖", () => {
  let fixture: RoutingPolicyFixture;
  let tenantA = "";
  let tenantB = "";
  let teamA1 = "";
  let teamA2 = "";
  let teamB1 = "";
  const generatedDirs: string[] = [];
  const extraClosables: Array<{ close(): void | Promise<void> }> = [];

  beforeAll(async () => {
    if (!ENV.ok) return;

    // MT077 migration through the real MT003 tool: generate → apply →
    // replay is convergent (applied on a fresh database, up-to-date on replay).
    if (!resolveTestDatabaseTarget(process.env).ok) {
      throw new Error(
        "MT077 migration target refused: TEST_DATABASE_URL invalid",
      );
    }
    const dir = join("/tmp", `mt077-migration-${randomUUID().slice(0, 8)}`);
    generatedDirs.push(dir);
    const generation = await runMigrateTest(
      ["generate", "MT077", "--out", dir],
      {
        environment: process.env,
        out: () => {},
      },
    );
    if (generation.kind !== "generated") {
      throw new Error(`MT077 generate failed: ${JSON.stringify(generation)}`);
    }
    const manifestPath = join(dir, "MT077", "manifest.json");
    const applied: RunOutcome = await runMigrateTest(
      ["migrate", "MT077", "--apply", "--manifest", manifestPath],
      { environment: process.env, out: () => {} },
    );
    if (!["applied", "up-to-date"].includes(applied.kind)) {
      throw new Error(`MT077 apply failed: ${JSON.stringify(applied)}`);
    }
    const replay = await runMigrateTest(
      ["migrate", "MT077", "--apply", "--manifest", manifestPath],
      { environment: process.env, out: () => {} },
    );
    if (replay.kind !== "up-to-date") {
      throw new Error(`MT077 replay not convergent: ${JSON.stringify(replay)}`);
    }

    fixture = await createRoutingPolicyFixture();
    tenantA = fixture.ids["company-a"];
    tenantB = fixture.ids["company-b"];
    teamA1 = fixture.ids["team-a1"];
    teamA2 = fixture.ids["team-a2"];
    teamB1 = fixture.ids["team-b1"];
    await fixture.writeCompanyPolicy(tenantA, COMPANY_A_POLICY, 3);
    await fixture.writeCompanyPolicy(tenantB, COMPANY_B_POLICY, 5);
    await fixture.writeTeamOverride(tenantA, teamA1, TEAM_A1_OVERRIDE, 1);
    await fixture.writeTeamOverride(
      tenantA,
      teamA2,
      TEAM_A2_NARROW_OVERRIDE,
      2,
    );
    // B has no team override: b1 resolves the company baseline verbatim.
  }, 60000);

  afterAll(async () => {
    for (const dir of generatedDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    await fixture?.dispose();
    for (const closeable of extraClosables.reverse()) {
      await closeable.close().catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // 验收 1：策略只对归属范围生效；跨范围读取返回不可见语义
  // -------------------------------------------------------------------------

  describe("验收 1 — 策略只对归属范围生效，跨范围不可见", () => {
    itDb(
      "company A resolves its own network, capability and routing policy end to end",
      async () => {
        const resolved = await fixture.policyService.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        expect(resolved.scope).toEqual({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        expect(resolved.network.mode).toBe("allowlist_only");
        expect(resolved.network.rules).toEqual([
          { type: "domain", value: "api.company-a.example" },
          { type: "cidr", value: "10.0.0.0/8", ports: "443" },
        ]);
        expect(resolved.capabilities.useBots).toBe(true);
        expect(resolved.capabilities.cloudComputer).toBe(false);
        expect(resolved.capabilities.passwordManager).toBe(false);
        expect(resolved.modelRouting.allowedRoutes).toEqual([
          "route-a-primary",
          "route-a-fallback",
        ]);
        expect(resolved.modelRouting.defaultRoute).toBe("route-a-primary");
        expect(resolved.revisions).toEqual({ company: 3, override: 1 });
      },
    );

    itDb(
      "company B resolves its own — different end to end from company A",
      async () => {
        const resolved = await fixture.policyService.resolve({
          tenantId: tenantB,
          workspaceId: teamB1,
        });
        expect(resolved.network.mode).toBe("deny_all");
        expect(resolved.capabilities.cloudComputer).toBe(true);
        expect(resolved.capabilities.passwordManager).toBe(true);
        expect(resolved.modelRouting.allowedRoutes).toEqual(["route-b-eu"]);
        expect(resolved.modelRouting.defaultRoute).toBe("route-b-eu");
        expect(resolved.revisions).toEqual({ company: 5, override: null });
      },
    );

    itDb(
      "switching scopes back and forth never cross-contaminates (A1 → B1 → A1 identical)",
      async () => {
        const first = await fixture.policyService.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        await fixture.policyService.resolve({
          tenantId: tenantB,
          workspaceId: teamB1,
        });
        const again = await fixture.policyService.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        expect(JSON.stringify(again)).toBe(JSON.stringify(first));
      },
    );

    itDb(
      "a resolution never carries another company's routes or teams' overrides (negative containment)",
      async () => {
        const a1 = await fixture.policyService.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        const a1Json = JSON.stringify(a1);
        expect(a1Json).not.toContain("route-b");
        // team-a2's narrowing override (slackTeams off, fallback route) must
        // not leak into team-a1's resolution.
        expect(a1.capabilities.slackTeams).toBe(true);
        expect(a1.modelRouting.defaultRoute).toBe("route-a-primary");
        expect(a1Json).not.toBe(
          JSON.stringify(
            await fixture.policyService.resolve({
              tenantId: tenantA,
              workspaceId: teamA2,
            }),
          ),
        );
      },
    );

    itDb(
      "the policy layer is tenant-scoped at the database: RLS hides other companies' rows under the restricted data role",
      async () => {
        const seenAsA = await fixture.readPolicyRowsAsData(tenantA);
        expect(seenAsA.map((row) => row.tenantId)).toEqual([tenantA]);
        const seenAsB = await fixture.readPolicyRowsAsData(tenantB);
        expect(seenAsB.map((row) => row.tenantId)).toEqual([tenantB]);
      },
    );

    itDb(
      "a company with no policy row resolves to GOVERNANCE_POLICY_NOT_FOUND — indistinguishable from a cross-company read, no fallback",
      async () => {
        // A tenant id that exists nowhere: RLS makes "another company's row"
        // and "no row" the same zero-row outcome, and neither falls back.
        const message = await thrownMessage(
          fixture.policyService.resolve({
            tenantId: `${fixture.idPrefix}-nowhere`,
            workspaceId: teamA1,
          }),
        );
        expect(message).toBe("GOVERNANCE_POLICY_NOT_FOUND");
      },
    );

    itDb(
      "install reads are team-scoped: team A1 sees neither team A2's nor company B's installs",
      async () => {
        await fixture.installWriter.install({
          tenantId: tenantA,
          workspaceId: teamA2,
          templateRef: "platform/research-daily",
        });
        await fixture.installWriter.install({
          tenantId: tenantB,
          workspaceId: teamB1,
          templateRef: "platform/research-daily",
        });
        const a1List = await fixture.installReader.list(tenantA, teamA1);
        expect(a1List).toEqual([]);
        const a1Read = await fixture.installReader.read(
          tenantA,
          teamA1,
          "platform/research-daily",
        );
        expect(a1Read).toBeNull();
        // The installs themselves exist for their own scopes.
        expect(
          (await fixture.installReader.list(tenantA, teamA2)).map(
            (install) => install.templateRef,
          ),
        ).toEqual(["platform/research-daily"]);
      },
    );

    itDb(
      "install writes cannot cross scopes: a company-A operator context sees and moves zero rows of company B's install",
      async () => {
        const before = await fixture.installReader.read(
          tenantB,
          teamB1,
          "platform/research-daily",
        );
        expect(before).not.toBeNull();
        // The operator channel pinned to company A cannot even see company B's
        // row (RLS), so the targeted update touches zero rows.
        const updated = await fixture.attemptCrossTenantInstallWrite({
          contextTenantId: tenantA,
          targetTenantId: tenantB,
          workspaceId: teamB1,
          templateRef: "platform/research-daily",
        });
        expect(updated).toBe(0);
        const after = await fixture.installReader.read(
          tenantB,
          teamB1,
          "platform/research-daily",
        );
        expect(after).toEqual(before);
        // A composite key that mixes one company's tenant with another
        // company's team cannot exist (composite FK) and updates nothing.
        const message = await thrownMessage(
          fixture.installWriter.updateInstall({
            tenantId: tenantB,
            workspaceId: teamA1,
            templateRef: "platform/research-daily",
            document: { mismatched: true },
            expectedRevision: 1,
          }),
        );
        expect(message).toBe("TEMPLATE_INSTALL_NOT_FOUND");
      },
    );
  });

  // -------------------------------------------------------------------------
  // 验收 2：团队覆盖不能放宽公司限制（专门测试）
  // -------------------------------------------------------------------------

  describe("验收 2 — 团队覆盖只收窄，不放大", () => {
    itDb(
      "a narrowing override takes effect end to end: capability off, network tightened, routes narrowed",
      async () => {
        const resolved = await fixture.policyService.resolve({
          tenantId: tenantA,
          workspaceId: teamA2,
        });
        expect(resolved.capabilities.customRules).toBe(true); // company on, untouched
        expect(resolved.capabilities.slackTeams).toBe(false); // narrowed by team
        expect(resolved.capabilities.cloudComputer).toBe(false); // company off stays off
        expect(resolved.network.mode).toBe("allowlist_only"); // team didn't touch network
        expect(resolved.modelRouting.allowedRoutes).toEqual([
          "route-a-fallback",
        ]);
        expect(resolved.modelRouting.defaultRoute).toBe("route-a-fallback");
        expect(resolved.revisions).toEqual({ company: 3, override: 2 });
      },
    );

    itDb(
      "override.capabilities true on a company-off capability is rejected (CAPABILITY_OVERRIDE_WIDENS_POLICY)",
      async () => {
        const company = parseCompanyGovernancePolicyDocument(COMPANY_A_POLICY);
        const override = parseTeamGovernanceOverridesDocument({
          capabilities: { cloudComputer: true },
        });
        const message = thrownMessageSync(() =>
          resolveGovernancePolicy({
            tenantId: tenantA,
            workspaceId: teamA1,
            company,
            companyRevision: 3,
            override,
            overrideRevision: 1,
          }),
        );
        expect(message).toContain("CAPABILITY_OVERRIDE_WIDENS_POLICY");
        expect(message).toContain("cloudComputer");
        // The widening entry never partially applies.
      },
    );

    itDb(
      "override.capabilities true is rejected even when the company already allows it — an override has no widening expression at all",
      async () => {
        const company = parseCompanyGovernancePolicyDocument(COMPANY_A_POLICY);
        const override = parseTeamGovernanceOverridesDocument({
          capabilities: { useBots: true },
        });
        const message = thrownMessageSync(() =>
          resolveGovernancePolicy({
            tenantId: tenantA,
            workspaceId: teamA1,
            company,
            companyRevision: 3,
            override,
            overrideRevision: 1,
          }),
        );
        expect(message).toContain("CAPABILITY_OVERRIDE_WIDENS_POLICY");
      },
    );

    itDb(
      "override.network.mode weaker than the company egress mode is rejected (NETWORK_OVERRIDE_WIDENS_POLICY)",
      async () => {
        const company = parseCompanyGovernancePolicyDocument(COMPANY_A_POLICY);
        const override = parseTeamGovernanceOverridesDocument({
          network: { mode: "allow_all" },
        });
        const message = thrownMessageSync(() =>
          resolveGovernancePolicy({
            tenantId: tenantA,
            workspaceId: teamA1,
            company,
            companyRevision: 3,
            override,
            overrideRevision: 1,
          }),
        );
        expect(message).toContain("NETWORK_OVERRIDE_WIDENS_POLICY");
      },
    );

    itDb(
      "override.network.rules outside the company egress rules are rejected with an index, never the value",
      async () => {
        const canary = "sk-mt077-egress-canary-evil.example";
        const company = parseCompanyGovernancePolicyDocument(COMPANY_A_POLICY);
        const override = parseTeamGovernanceOverridesDocument({
          network: { rules: [{ type: "domain", value: canary }] },
        });
        const message = thrownMessageSync(() =>
          resolveGovernancePolicy({
            tenantId: tenantA,
            workspaceId: teamA1,
            company,
            companyRevision: 3,
            override,
            overrideRevision: 1,
          }),
        );
        expect(message).toContain("NETWORK_OVERRIDE_WIDENS_POLICY");
        expect(message).toContain("index 0");
        expect(message).not.toContain(canary);
      },
    );

    itDb(
      "override.modelRouting routes outside the company allowlist are rejected (OVERRIDE_WIDENS_POLICY)",
      async () => {
        const company = parseCompanyGovernancePolicyDocument(COMPANY_A_POLICY);
        const override = parseTeamGovernanceOverridesDocument({
          modelRouting: { allowedRoutes: ["route-b-eu"] },
        });
        const message = thrownMessageSync(() =>
          resolveGovernancePolicy({
            tenantId: tenantA,
            workspaceId: teamA1,
            company,
            companyRevision: 3,
            override,
            overrideRevision: 1,
          }),
        );
        expect(message).toContain("OVERRIDE_WIDENS_POLICY");
        expect(message).toContain("index 0");
        expect(message).not.toContain("route-b-eu");
      },
    );

    itDb(
      "an override that narrows routes past the company default must supply its own default within the effective set",
      async () => {
        const company = parseCompanyGovernancePolicyDocument(COMPANY_A_POLICY);
        const override = parseTeamGovernanceOverridesDocument({
          modelRouting: { allowedRoutes: ["route-a-fallback"] },
        });
        const message = thrownMessageSync(() =>
          resolveGovernancePolicy({
            tenantId: tenantA,
            workspaceId: teamA1,
            company,
            companyRevision: 3,
            override,
            overrideRevision: 1,
          }),
        );
        expect(message).toContain("OVERRIDE_WIDENS_POLICY");
        expect(message).toContain("defaultRoute");
      },
    );

    itDb(
      "company-off capabilities stay off in every team resolution, even with an unrelated override present",
      async () => {
        for (const workspaceId of [teamA1, teamA2]) {
          const resolved = await fixture.policyService.resolve({
            tenantId: tenantA,
            workspaceId,
          });
          expect(resolved.capabilities.cloudComputer).toBe(false);
          expect(resolved.capabilities.localComputer).toBe(false);
          expect(resolved.capabilities.passwordManager).toBe(false);
        }
      },
    );

    itDb(
      "writing team A1's override never changes company B's resolution (no cross-scope effect)",
      async () => {
        const before = await fixture.policyService.resolve({
          tenantId: tenantB,
          workspaceId: teamB1,
        });
        await fixture.writeTeamOverride(
          tenantA,
          teamA1,
          { capabilities: { slackTeams: false } },
          9,
        );
        const after = await fixture.policyService.resolve({
          tenantId: tenantB,
          workspaceId: teamB1,
        });
        expect(JSON.stringify(after)).toBe(JSON.stringify(before));
        // restore for later tests
        await fixture.writeTeamOverride(tenantA, teamA1, TEAM_A1_OVERRIDE, 1);
      },
    );
  });

  // -------------------------------------------------------------------------
  // 验收 3：模板更新只影响本范围安装，不回写平台模板
  // -------------------------------------------------------------------------

  describe("验收 3 — 模板作用域：更新只落本范围安装，平台目录不可回写", () => {
    const CATALOG_SNAPSHOT = structuredClone(PLATFORM_TEMPLATES);

    itDb(
      "install copies the platform template into the owning scope with its source revision",
      async () => {
        const template = findPlatformTemplate("platform/welcome-playbook");
        expect(template).not.toBeNull();
        const view = await fixture.installWriter.install({
          tenantId: tenantA,
          workspaceId: teamA1,
          templateRef: "platform/welcome-playbook",
        });
        expect(view.tenantId).toBe(tenantA);
        expect(view.workspaceId).toBe(teamA1);
        expect(view.templateRef).toBe("platform/welcome-playbook");
        expect(view.sourceRevision).toBe(template?.revision);
        expect(view.revision).toBe(1);
        expect(view.document).toEqual(template?.document);
      },
    );

    itDb(
      "a second install of the same template in the same scope is refused (TEMPLATE_INSTALL_ALREADY_EXISTS)",
      async () => {
        const message = await thrownMessage(
          fixture.installWriter.install({
            tenantId: tenantA,
            workspaceId: teamA1,
            templateRef: "platform/welcome-playbook",
          }),
        );
        expect(message).toBe("TEMPLATE_INSTALL_ALREADY_EXISTS");
      },
    );

    itDb(
      "an unknown template ref is refused at install and sync (TEMPLATE_UNKNOWN)",
      async () => {
        const installMessage = await thrownMessage(
          fixture.installWriter.install({
            tenantId: tenantA,
            workspaceId: teamA1,
            templateRef: "platform/does-not-exist",
          }),
        );
        expect(installMessage).toBe("TEMPLATE_UNKNOWN");
        const syncMessage = await thrownMessage(
          fixture.installWriter.syncToCatalogRevision({
            tenantId: tenantA,
            workspaceId: teamA1,
            templateRef: "platform/does-not-exist",
            expectedRevision: 1,
          }),
        );
        expect(syncMessage).toBe("TEMPLATE_UNKNOWN");
      },
    );

    itDb(
      "updating an install changes only its own (tenant, workspace, ref) row — sibling team and other company byte-unchanged",
      async () => {
        const a2Before = await fixture.installReader.read(
          tenantA,
          teamA2,
          "platform/research-daily",
        );
        const b1Before = await fixture.installReader.read(
          tenantB,
          teamB1,
          "platform/research-daily",
        );
        expect(a2Before).not.toBeNull();
        expect(b1Before).not.toBeNull();

        const updated = await fixture.installWriter.updateInstall({
          tenantId: tenantA,
          workspaceId: teamA1,
          templateRef: "platform/welcome-playbook",
          document: { sections: ["custom-a1"], version: "team-local" },
          expectedRevision: 1,
        });
        expect(updated.revision).toBe(2);
        expect(updated.document).toEqual({
          sections: ["custom-a1"],
          version: "team-local",
        });
        expect(updated.sourceRevision).toBe(3);

        const a2After = await fixture.installReader.read(
          tenantA,
          teamA2,
          "platform/research-daily",
        );
        const b1After = await fixture.installReader.read(
          tenantB,
          teamB1,
          "platform/research-daily",
        );
        expect(a2After).toEqual(a2Before);
        expect(b1After).toEqual(b1Before);
      },
    );

    itDb(
      "a stale expectedRevision is a conflict, never a lost update (TEMPLATE_INSTALL_REVISION_CONFLICT)",
      async () => {
        const message = await thrownMessage(
          fixture.installWriter.updateInstall({
            tenantId: tenantA,
            workspaceId: teamA1,
            templateRef: "platform/welcome-playbook",
            document: { stale: true },
            expectedRevision: 1,
          }),
        );
        expect(message).toBe("TEMPLATE_INSTALL_REVISION_CONFLICT");
        const view = await fixture.installReader.read(
          tenantA,
          teamA1,
          "platform/welcome-playbook",
        );
        expect(view?.revision).toBe(2);
        expect(view?.document).toEqual({
          sections: ["custom-a1"],
          version: "team-local",
        });
      },
    );

    itDb(
      "a non-object install document is refused (TEMPLATE_INSTALL_DOCUMENT_INVALID)",
      async () => {
        const message = await thrownMessage(
          fixture.installWriter.updateInstall({
            tenantId: tenantA,
            workspaceId: teamA1,
            templateRef: "platform/welcome-playbook",
            document: "not-an-object",
            expectedRevision: 2,
          }),
        );
        expect(message).toContain("TEMPLATE_INSTALL_DOCUMENT_INVALID");
      },
    );

    itDb(
      "syncToCatalogRevision refreshes a stale install from the catalog, only for its own scope",
      async () => {
        const template = findPlatformTemplate("platform/welcome-playbook");
        // Simulate an install made when the catalog was older: stale document
        // and an old source revision.
        await fixture.writeInstallRow({
          tenantId: tenantA,
          workspaceId: teamA2,
          templateRef: "platform/welcome-playbook",
          sourceRevision: 1,
          document: { stale: "a2-copy" },
          revision: 4,
        });
        const synced = await fixture.installWriter.syncToCatalogRevision({
          tenantId: tenantA,
          workspaceId: teamA2,
          templateRef: "platform/welcome-playbook",
          expectedRevision: 4,
        });
        expect(synced.sourceRevision).toBe(template?.revision);
        expect(synced.document).toEqual(template?.document);
        expect(synced.revision).toBe(5);
        // The stale catalog content never reaches the platform template.
        const current = findPlatformTemplate("platform/welcome-playbook");
        expect(current?.document).not.toEqual({ stale: "a2-copy" });
      },
    );

    itDb(
      "syncing an install already at the catalog revision is refused (TEMPLATE_INSTALL_ALREADY_CURRENT)",
      async () => {
        const message = await thrownMessage(
          fixture.installWriter.syncToCatalogRevision({
            tenantId: tenantA,
            workspaceId: teamA1,
            templateRef: "platform/welcome-playbook",
            expectedRevision: 2,
          }),
        );
        expect(message).toBe("TEMPLATE_INSTALL_ALREADY_CURRENT");
      },
    );

    itDb(
      "a stale expectedRevision on sync is a conflict (TEMPLATE_INSTALL_REVISION_CONFLICT)",
      async () => {
        const message = await thrownMessage(
          fixture.installWriter.syncToCatalogRevision({
            tenantId: tenantA,
            workspaceId: teamA2,
            templateRef: "platform/welcome-playbook",
            expectedRevision: 1,
          }),
        );
        expect(message).toBe("TEMPLATE_INSTALL_REVISION_CONFLICT");
      },
    );

    itDb(
      "the platform template catalog is deep-frozen and byte-identical after every install, update and sync",
      async () => {
        expect(PLATFORM_TEMPLATES).toEqual(CATALOG_SNAPSHOT);
        for (const template of PLATFORM_TEMPLATES) {
          expect(Object.isFrozen(template)).toBe(true);
          expect(Object.isFrozen(template.document)).toBe(true);
        }
        expect(Object.isFrozen(PLATFORM_TEMPLATES)).toBe(true);
        expect(
          thrownMessageSync(() => {
            (PLATFORM_TEMPLATES as unknown as unknown[]).push({
              ref: "platform/rogue",
            });
          }),
        ).not.toBe("");
      },
    );

    itDb(
      "module source hygiene: no environment inputs, catalog freezing is structural, install writes never name the catalog",
      async () => {
        const source = readFileSync(
          join(
            import.meta.dir,
            "../../src/enterprise/tenancy/routing-policy.ts",
          ),
          "utf8",
        );
        expect(source).not.toContain("process.env");
        expect(source).not.toContain("Bun.env");
        expect(source).not.toContain("import.meta.env");
        // The catalog is a frozen module constant; the writer's statements
        // carry document parameters, never catalog references.
        const declaration = source
          .split("\n")
          .find((line) => line.includes("export const PLATFORM_TEMPLATES"));
        expect(declaration).toContain("deepFreeze(");
        expect(source).not.toContain("PLATFORM_TEMPLATES.push");
      },
    );
  });

  // -------------------------------------------------------------------------
  // 验收 4：变更在下一个生效点立即体现，无跨范围缓存污染
  // -------------------------------------------------------------------------

  describe("验收 4 — 生效点即时性与缓存键", () => {
    itDb(
      "a company policy revision bump is visible at the very next resolve and moves the cache key",
      async () => {
        const before = await fixture.policyService.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        expect(before.cacheKey).toContain("/c=3/");
        await fixture.writeCompanyPolicy(
          tenantA,
          {
            ...COMPANY_A_POLICY,
            network: { mode: "deny_all", rules: [] },
          },
          4,
        );
        const after = await fixture.policyService.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        expect(after.network.mode).toBe("deny_all");
        expect(after.cacheKey).toContain("/c=4/");
        expect(after.cacheKey).not.toBe(before.cacheKey);
        // restore for later tests
        await fixture.writeCompanyPolicy(tenantA, COMPANY_A_POLICY, 3);
      },
    );

    itDb(
      "a team override revision bump is visible at the very next resolve and moves the cache key",
      async () => {
        const before = await fixture.policyService.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        expect(before.cacheKey).toContain("/o=1");
        await fixture.writeTeamOverride(
          tenantA,
          teamA1,
          TEAM_A1_OVERRIDE_REV2,
          2,
        );
        const after = await fixture.policyService.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        expect(after.network.mode).toBe("deny_all");
        expect(after.capabilities.slackTeams).toBe(false);
        expect(after.cacheKey).toContain("/o=2");
        expect(after.cacheKey).not.toBe(before.cacheKey);
        // restore for later tests
        await fixture.writeTeamOverride(tenantA, teamA1, TEAM_A1_OVERRIDE, 1);
      },
    );

    itDb(
      "company A's revisions never move company B's cache key or resolution (no cross-scope cache pollution)",
      async () => {
        const before = await fixture.policyService.resolve({
          tenantId: tenantB,
          workspaceId: teamB1,
        });
        await fixture.writeCompanyPolicy(
          tenantA,
          { ...COMPANY_A_POLICY, network: { mode: "deny_all", rules: [] } },
          12,
        );
        await fixture.writeTeamOverride(
          tenantA,
          teamA1,
          TEAM_A1_OVERRIDE_REV2,
          7,
        );
        const after = await fixture.policyService.resolve({
          tenantId: tenantB,
          workspaceId: teamB1,
        });
        expect(JSON.stringify(after)).toBe(JSON.stringify(before));
        expect(after.cacheKey).toBe(before.cacheKey);
        // restore
        await fixture.writeCompanyPolicy(tenantA, COMPANY_A_POLICY, 3);
        await fixture.writeTeamOverride(tenantA, teamA1, TEAM_A1_OVERRIDE, 1);
      },
    );

    itDb(
      "the cache key is a pure function of ownership and revisions; resolution output is deep-frozen and inputs are never mutated",
      async () => {
        const company = parseCompanyGovernancePolicyDocument(COMPANY_A_POLICY);
        const override = parseTeamGovernanceOverridesDocument(TEAM_A1_OVERRIDE);
        const companyBefore = structuredClone(company);
        const overrideBefore = structuredClone(override);
        const resolved = resolveGovernancePolicy({
          tenantId: tenantA,
          workspaceId: teamA1,
          company,
          companyRevision: 3,
          override,
          overrideRevision: 1,
        });
        expect(resolved.cacheKey).toBe(
          `routing-policy/v1/t=${tenantA}/w=${teamA1}/c=3/o=1`,
        );
        const withoutOverride = resolveGovernancePolicy({
          tenantId: tenantA,
          workspaceId: teamA1,
          company,
          companyRevision: 3,
          override: null,
          overrideRevision: null,
        });
        expect(withoutOverride.cacheKey).toBe(
          `routing-policy/v1/t=${tenantA}/w=${teamA1}/c=3/o=-`,
        );
        expect(company).toEqual(companyBefore);
        expect(override).toEqual(overrideBefore);
        expect(everyFrozen(resolved)).toBe(true);
        expect(
          thrownMessageSync(() => {
            (resolved.capabilities as Record<string, boolean>).useBots = false;
          }),
        ).not.toBe("");
      },
    );

    itDb(
      "two independent services (separate verified channels) resolve identically — no process-level policy state",
      async () => {
        const dataUrl = enterpriseRuntimeDatabaseUrlFrom("data", process.env);
        const secondData = await verifyDataDatabase(
          createDatabase(dataUrl, { max: 1 }),
        );
        extraClosables.push(secondData.$client);
        const secondService = createRoutingPolicyService(secondData);
        const first = await fixture.policyService.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        const second = await secondService.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      },
    );
  });

  // -------------------------------------------------------------------------
  // 存储与迁移契约
  // -------------------------------------------------------------------------

  describeDb("存储与迁移契约", () => {
    itDb(
      "missing selectors are refused before any database read (TENANT_REQUIRED / WORKSPACE_REQUIRED)",
      async () => {
        expect(
          await thrownMessage(
            fixture.policyService.resolve({
              tenantId: "  ",
              workspaceId: teamA1,
            }),
          ),
        ).toBe("TENANT_REQUIRED");
        expect(
          await thrownMessage(
            fixture.policyService.resolve({
              tenantId: tenantA,
              workspaceId: "",
            }),
          ),
        ).toBe("WORKSPACE_REQUIRED");
      },
    );

    itDb(
      "an unverified database channel is refused at service creation",
      async () => {
        expect(
          thrownMessageSync(() =>
            createRoutingPolicyService({} as unknown as DataDatabase),
          ),
        ).toContain("UNVERIFIED_DATABASE_CAPABILITY");
      },
    );

    itDb(
      "every restricted query in this suite ran as an ob_ent_* capability role",
      () => {
        const calls = fixture.restrictedCalls();
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
          expect(call.currentUser.startsWith("ob_ent_")).toBe(true);
        }
      },
    );

    test("the MT077 plan is deterministic: fixed slugs, numbered from 0001, stable digests", () => {
      const first = buildPlan("MT077");
      const second = buildPlan("MT077");
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(first.steps.map((step) => step.name)).toEqual([
        "0001_mt077_governance_policy_tables.sql",
        "0002_mt077_governance_policy_rls.sql",
      ]);
      expect(first.steps[0]?.objects).toEqual([
        "enterprise_governance_policies",
        "enterprise_governance_overrides",
        "enterprise_template_installs",
      ]);
    });
  });
});
