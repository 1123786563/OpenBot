// server/tests/multitenancy/resource-policy.test.ts
// MT008（Issue #51）：资源可见性属性与 workspace-v1 策略版本。
//
// 验收事实源（Issue #51 四条，逐条对应 describe）：
//   (1) 资源具有 private/workspace 可见性；未标记的资源保持既有行为
//       （回归测试：grant 语义在 tenancy-v1 与 workspace-v1 下逐例不变）。
//   (2) 新策略版本独立注册；旧版本（tenancy-v1）判定结果在新版本注册
//       前后对同一输入集逐例完全一致（对照测试），且与生产 authz
//       （authz/service.ts createAuthz）在等价输入上判定相同。
//   (3) 把旧 public 资源迁移为团队公共必须经显式清单：无清单/空清单
//       零写入；迁移入口绝不扩大范围（private 不被翻转、清单外不被
//       触碰、跨租户 id 不被写入）。
//   (4) 跨公司资源引用在新策略下永远拒绝；拒绝语义与「资源不存在」
//       不可区分（403/404 语义不泄露存在性）。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_DATABASE_URL）
// 加三个受限角色 URL；缺配置时整套显式 skip（跳过原因写在用例名里，
// skipped 不计为通过），绝不回退开发库。裁决 #1：请求头仅作选择。
// MT008 迁移（enterprise_resources.visibility 列 + operator 列级 UPDATE
// 授权）经 MT003 工具（migrate-test.ts）真实执行，本文件不自己 DDL。

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
import { createAuthz } from "../../src/enterprise/authz/service";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  createResourcePolicyRegistry,
  createResourcePolicyService,
  createShippedResourcePolicyRegistry,
  type ResourcePolicyFacts,
  type ResourcePolicyVerdict,
  TENANCY_V1_POLICY_ID,
  tenancyV1ResourcePolicy,
  WORKSPACE_V1_POLICY_ID,
  workspaceV1ResourcePolicy,
} from "../../src/enterprise/tenancy/resource-policy";
import {
  migrateLegacyResourcesToWorkspaceVisibility,
  parseResourceVisibilityManifest,
} from "../../src/enterprise/tenancy/resource-visibility";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import { rejectionOf } from "../support/pg-errors";
import {
  createResourcePolicyFixture,
  type ResourcePolicyFixture,
} from "./support/resource-policy";

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
      reason: `MT008 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
// 判定断言助手：deny 只有一种对外形状（不泄露存在性），allow 同理
// ---------------------------------------------------------------------------

const ALLOW: ResourcePolicyVerdict = Object.freeze({ outcome: "allow" });
const DENY_NOT_FOUND: ResourcePolicyVerdict = Object.freeze({
  outcome: "deny",
  code: "RESOURCE_NOT_FOUND",
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

// ---------------------------------------------------------------------------
// 纯注册表对照矩阵（验收 2 的「同一输入集」：不含任何数据库状态）
// ---------------------------------------------------------------------------

type FactsOverrides = Partial<
  ResourcePolicyFacts["resource"] &
    ResourcePolicyFacts["grant"] &
    ResourcePolicyFacts["workspaceMembership"] & {
      scope: ResourcePolicyFacts["scope"];
    }
>;

function factsOf(overrides: FactsOverrides = {}): ResourcePolicyFacts {
  const {
    scope: scopeOverride,
    grant,
    workspaceMembership,
    ...resourceOverrides
  } = overrides;
  const scope = scopeOverride ?? {
    tenantId: "tenant-a",
    workspaceId: "workspace-a1",
    principalId: "principal-a1-other",
    actorId: "user-a1-other",
  };
  return {
    scope,
    resource: {
      tenantId: "tenant-a",
      workspaceId: "workspace-a1",
      id: "resource-a1",
      visibility: null,
      status: "active",
      revision: 1,
      aclEpoch: 1,
      policyRevision: "tenancy-v1",
      ...resourceOverrides,
    },
    grant: { read: true, ...grant },
    workspaceMembership: {
      status: "active",
      ...workspaceMembership,
    },
  };
}

/** The fixed comparison matrix: every decision-relevant fact shape. */
const COMPARISON_MATRIX: ReadonlyArray<
  readonly [string, () => ResourcePolicyFacts]
> = [
  ["same-team grantee, unmarked resource", () => factsOf()],
  [
    "same-team non-grantee, unmarked resource",
    () => factsOf({ grant: { read: false } }),
  ],
  [
    "same-team grantee, private resource",
    () => factsOf({ visibility: "private" }),
  ],
  [
    "same-team non-grantee, private resource",
    () => factsOf({ visibility: "private", grant: { read: false } }),
  ],
  [
    "same-team grantee, workspace resource",
    () => factsOf({ visibility: "workspace" }),
  ],
  [
    "same-team non-grantee active member, workspace resource",
    () => factsOf({ visibility: "workspace", grant: { read: false } }),
  ],
  [
    "same-team non-grantee suspended member, workspace resource",
    () =>
      factsOf({
        visibility: "workspace",
        grant: { read: false },
        workspaceMembership: { status: "suspended" },
      }),
  ],
  [
    "suspended member with grant, workspace resource (grant path survives)",
    () =>
      factsOf({
        visibility: "workspace",
        workspaceMembership: { status: "suspended" },
      }),
  ],
  [
    "no membership row, workspace resource",
    () =>
      factsOf({
        visibility: "workspace",
        grant: { read: false },
        workspaceMembership: { status: null },
      }),
  ],
  [
    "cross-company reference, granted and workspace-marked",
    () => factsOf({ visibility: "workspace", tenantId: "tenant-b" }),
  ],
  [
    "cross-workspace reference inside one company",
    () => factsOf({ workspaceId: "workspace-a2" }),
  ],
  ["row not visible (not found)", () => factsOf({ status: null })],
  ["deleted resource", () => factsOf({ status: "deleted" })],
  ["non-positive revision", () => factsOf({ revision: 0 })],
  ["non-positive aclEpoch", () => factsOf({ aclEpoch: 0 })],
];

// ---------------------------------------------------------------------------
// 共享夹具 + MT008 迁移（经 MT003 工具真实执行）
// ---------------------------------------------------------------------------

let fixture: ResourcePolicyFixture;
let dryRunOutcome: RunOutcome;
let applyOutcome: RunOutcome;

describeDb(
  "MT008 resource visibility and workspace-v1 policy (Issue #51)",
  () => {
    beforeAll(async () => {
      const resolved = resolveTestDatabaseTarget(process.env);
      if (!resolved.ok) {
        throw new Error(
          `MT008 resource-policy tests refuse to run: ${resolved.reason}`,
        );
      }
      dryRunOutcome = await runMigrateTest(["migrate", "MT008"], {
        environment: { TEST_DATABASE_URL: resolved.target.url },
        out: () => {},
      });
      const manifestPath = `/tmp/mt008-manifest-${randomUUID()}.json`;
      await Bun.write(
        manifestPath,
        `${JSON.stringify(manifestFor(buildPlan("MT008")), null, 2)}\n`,
      );
      try {
        applyOutcome = await runMigrateTest(
          ["migrate", "MT008", "--apply", "--manifest", manifestPath],
          {
            environment: { TEST_DATABASE_URL: resolved.target.url },
            out: () => {},
          },
        );
      } finally {
        await rm(manifestPath, { force: true });
      }
      fixture = await createResourcePolicyFixture();
    });

    afterAll(async () => {
      await fixture?.dispose();
    });

    // -----------------------------------------------------------------------
    // 迁移注册与 expand-only（票面约束：MT004/MT112 惯例）
    // -----------------------------------------------------------------------

    describe("the MT008 task migration is registered and expand-only", () => {
      itDb("MT008 is a registered task whose plan is deterministic", () => {
        const plan = buildPlan("MT008");
        expect(plan.taskId).toBe("MT008");
        expect(plan.steps.map((step) => step.name)).toEqual([
          "0001_mt008_resource_visibility_column.sql",
          "0002_mt008_visibility_operator_grant.sql",
        ]);
        expect(manifestFor(plan)).toEqual(manifestFor(buildPlan("MT008")));
      });

      itDb(
        "dry-run previews honestly and apply converges (fresh or up-to-date)",
        () => {
          expect(dryRunOutcome).toMatchObject({
            kind: "dry-run",
            taskId: "MT008",
          });
          expect(["applied", "up-to-date"]).toContain(applyOutcome.kind);
          if (
            dryRunOutcome.kind === "dry-run" &&
            applyOutcome.kind === "applied"
          ) {
            expect(dryRunOutcome.pending.map((step) => step.name)).toEqual([
              "0001_mt008_resource_visibility_column.sql",
              "0002_mt008_visibility_operator_grant.sql",
            ]);
          }
        },
      );

      itDb(
        "the plan only appends: no DROP/REVOKE/POLICY and no other table touched",
        () => {
          const statements = buildPlan("MT008").steps.flatMap(
            (step) => step.statements,
          );
          expect(statements.length).toBeGreaterThan(0);
          for (const statement of statements) {
            expect(statement).not.toMatch(/\bDROP\b/i);
            expect(statement).not.toMatch(/\bREVOKE\b/i);
            expect(statement).not.toMatch(/\bPOLICY\b/i);
            expect(statement).not.toMatch(/\bDELETE\b/i);
            for (const foreign of [
              "enterprise_workspaces",
              "enterprise_tenants",
              "enterprise_memberships",
              "enterprise_resource_grants",
              "enterprise_workspace_memberships",
            ]) {
              expect(statement).not.toContain(foreign);
            }
          }
          // The visibility column is live on enterprise_resources (read back
          // through the restricted data role below in criterion 1).
        },
      );
    });

    // -----------------------------------------------------------------------
    // 验收 (1)：可见性属性 + 未标记资源保持既有行为
    // -----------------------------------------------------------------------

    describe("issue #51 criterion 1: resources carry private/workspace visibility; unmarked resources keep existing behavior", () => {
      itDb(
        "the visibility attribute accepts private/workspace/null and refuses anything else at the database boundary",
        async () => {
          const tenantId = fixture.isolation.ids["company-a"];
          const resourceId = fixture.isolation.ids["resource-a1"];
          for (const value of ["workspace", "private", null] as const) {
            await fixture.markVisibility({
              tenantId,
              resourceId,
              visibility: value,
            });
            expect(await fixture.visibilityOf(tenantId, resourceId)).toBe(
              value,
            );
          }
          const rejection = await rejectionOf(() =>
            fixture.markVisibility({
              tenantId,
              resourceId,
              visibility: "public" as never,
            }),
          );
          expect(rejection.code).toBe("23514");
          expect(rejection.message).toContain("enterprise_resource_visibility");
          // Reset for the following tests.
          await fixture.markVisibility({
            tenantId,
            resourceId,
            visibility: null,
          });
        },
      );

      itDb(
        "unmarked resources keep grant-based behavior under tenancy-v1 (regression)",
        async () => {
          const team = fixture.teamOf("a1-member", "team-a1");
          const tenantId = fixture.isolation.ids["company-a"];
          const resourceId = fixture.isolation.ids["resource-a1"];
          await fixture.markVisibility({
            tenantId,
            resourceId,
            visibility: null,
          });

          const service = createResourcePolicyService(
            fixture.data,
            createShippedResourcePolicyRegistry(),
          );
          const grantee = await fixture.scopeFor("a1-member", team);
          expect(
            await service.decide(grantee, resourceId, {
              policyVersion: TENANCY_V1_POLICY_ID,
            }),
          ).toEqual(ALLOW);

          const nonGrantee = await fixture.scopeFor("a1-other", team);
          expect(
            await service.decide(nonGrantee, resourceId, {
              policyVersion: TENANCY_V1_POLICY_ID,
            }),
          ).toEqual(DENY_NOT_FOUND);
        },
      );

      itDb(
        "unmarked resources keep exactly the same grant-based behavior under workspace-v1 (no automatic widening)",
        async () => {
          const team = fixture.teamOf("a1-member", "team-a1");
          const tenantId = fixture.isolation.ids["company-a"];
          const resourceId = fixture.isolation.ids["resource-a1"];
          await fixture.markVisibility({
            tenantId,
            resourceId,
            visibility: null,
          });

          const service = createResourcePolicyService(
            fixture.data,
            createShippedResourcePolicyRegistry(),
          );
          const grantee = await fixture.scopeFor("a1-member", team);
          expect(
            await service.decide(grantee, resourceId, {
              policyVersion: WORKSPACE_V1_POLICY_ID,
            }),
          ).toEqual(ALLOW);
          // a1-other is an ACTIVE member of team-a1 but holds no read grant on
          // resource-a1: an unmarked resource must not become team-public just
          // because the new policy version is in effect.
          const activeMemberWithoutGrant = await fixture.scopeFor(
            "a1-other",
            team,
          );
          expect(
            await service.decide(activeMemberWithoutGrant, resourceId, {
              policyVersion: WORKSPACE_V1_POLICY_ID,
            }),
          ).toEqual(DENY_NOT_FOUND);
        },
      );

      itDb(
        "workspace-marked resources become readable by active team members without grants under workspace-v1",
        async () => {
          const team = fixture.teamOf("a1-other", "team-a1");
          const tenantId = fixture.isolation.ids["company-a"];
          const resourceId = fixture.isolation.ids["resource-a1"];
          await fixture.markVisibility({
            tenantId,
            resourceId,
            visibility: "workspace",
          });

          const service = createResourcePolicyService(
            fixture.data,
            createShippedResourcePolicyRegistry(),
          );
          const memberWithoutGrant = await fixture.scopeFor("a1-other", team);
          expect(
            await service.decide(memberWithoutGrant, resourceId, {
              policyVersion: WORKSPACE_V1_POLICY_ID,
            }),
          ).toEqual(ALLOW);
          // The old version ignores visibility entirely — same input stays
          // grant-only under tenancy-v1 (criterion 2 pins this generally).
          expect(
            await service.decide(memberWithoutGrant, resourceId, {
              policyVersion: TENANCY_V1_POLICY_ID,
            }),
          ).toEqual(DENY_NOT_FOUND);
        },
      );

      itDb(
        "suspended team members lose the team-public path but keep grant-based reads (existing behavior preserved)",
        async () => {
          const team = fixture.teamOf("a1-other", "team-a1");
          const tenantId = fixture.isolation.ids["company-a"];
          const sharedId = fixture.isolation.ids["resource-a1"];
          const ownId = fixture.isolation.ids["resource-a1-other"];
          await fixture.markVisibility({
            tenantId,
            resourceId: sharedId,
            visibility: "workspace",
          });

          const service = createResourcePolicyService(
            fixture.data,
            createShippedResourcePolicyRegistry(),
          );
          // The scope issues while the member is still active. decide() must
          // re-check the CURRENT membership facts under RLS at decision time —
          // a stale scope never freezes authority. (The MT005 seam refuses a
          // fresh scope for a suspended member outright, asserted below.)
          const suspended = await fixture.scopeFor("a1-other", team);
          try {
            await fixture.setTeamMembershipStatus(
              "a1-other",
              "team-a1",
              "suspended",
            );
            // A fresh scope resolution is refused (existing MT005 seam behavior).
            expect(
              await thrownMessage(fixture.scopeFor("a1-other", team)),
            ).toContain("WORKSPACE_FORBIDDEN");
            // Team-public path is gone…
            expect(
              await service.decide(suspended, sharedId, {
                policyVersion: WORKSPACE_V1_POLICY_ID,
              }),
            ).toEqual(DENY_NOT_FOUND);
            // …but the explicit grant on their own resource still works.
            expect(
              await service.decide(suspended, ownId, {
                policyVersion: WORKSPACE_V1_POLICY_ID,
              }),
            ).toEqual(ALLOW);
          } finally {
            await fixture.setTeamMembershipStatus(
              "a1-other",
              "team-a1",
              "active",
            );
          }
          const restored = await fixture.scopeFor("a1-other", team);
          expect(
            await service.decide(restored, sharedId, {
              policyVersion: WORKSPACE_V1_POLICY_ID,
            }),
          ).toEqual(ALLOW);
        },
      );

      itDb(
        "private-marked resources stay grant-based under workspace-v1",
        async () => {
          const team = fixture.teamOf("a1-other", "team-a1");
          const tenantId = fixture.isolation.ids["company-a"];
          const resourceId = fixture.isolation.ids["resource-a1"];
          await fixture.markVisibility({
            tenantId,
            resourceId,
            visibility: "private",
          });

          const service = createResourcePolicyService(
            fixture.data,
            createShippedResourcePolicyRegistry(),
          );
          const memberWithoutGrant = await fixture.scopeFor("a1-other", team);
          expect(
            await service.decide(memberWithoutGrant, resourceId, {
              policyVersion: WORKSPACE_V1_POLICY_ID,
            }),
          ).toEqual(DENY_NOT_FOUND);
          const grantee = await fixture.scopeFor("a1-member", team);
          expect(
            await service.decide(grantee, resourceId, {
              policyVersion: WORKSPACE_V1_POLICY_ID,
            }),
          ).toEqual(ALLOW);
          await fixture.markVisibility({
            tenantId,
            resourceId,
            visibility: null,
          });
        },
      );
    });

    // -----------------------------------------------------------------------
    // 验收 (2)：新策略版本独立注册；旧版本判定在注册前后逐例一致
    // -----------------------------------------------------------------------

    describe("issue #51 criterion 2: workspace-v1 registers independently; tenancy-v1 decisions are identical before and after", () => {
      itDb("an empty registry refuses every version", () => {
        const registry = createResourcePolicyRegistry();
        expect(registry.registeredVersions()).toEqual([]);
        expect(() =>
          registry.evaluate(TENANCY_V1_POLICY_ID, factsOf()),
        ).toThrow("POLICY_REVISION_UNSUPPORTED");
      });

      itDb(
        "tenancy-v1 and workspace-v1 register as independent entries (workspace-v1 is unresolvable until registered)",
        () => {
          const registry = createResourcePolicyRegistry();
          registry.register(tenancyV1ResourcePolicy);
          expect(registry.has(TENANCY_V1_POLICY_ID)).toBe(true);
          expect(registry.has(WORKSPACE_V1_POLICY_ID)).toBe(false);
          expect(registry.registeredVersions()).toEqual([TENANCY_V1_POLICY_ID]);
          expect(() =>
            registry.evaluate(WORKSPACE_V1_POLICY_ID, factsOf()),
          ).toThrow("POLICY_REVISION_UNSUPPORTED");

          registry.register(workspaceV1ResourcePolicy);
          expect(registry.registeredVersions().sort()).toEqual(
            [TENANCY_V1_POLICY_ID, WORKSPACE_V1_POLICY_ID].sort(),
          );
          expect(
            registry.evaluate(WORKSPACE_V1_POLICY_ID, factsOf()).outcome,
          ).toBe("allow");
        },
      );

      itDb(
        "registering workspace-v1 leaves every tenancy-v1 decision identical, case by case (before/after comparison)",
        () => {
          const before = createResourcePolicyRegistry();
          before.register(tenancyV1ResourcePolicy);
          const decisionsBefore = COMPARISON_MATRIX.map(([label, make]) => {
            const verdict = before.evaluate(TENANCY_V1_POLICY_ID, make());
            expect(["allow", "deny"]).toContain(verdict.outcome);
            return `${label} => ${JSON.stringify(verdict)}`;
          });

          // The upgrade step: the new policy version registers independently.
          before.register(workspaceV1ResourcePolicy);
          const decisionsAfter = COMPARISON_MATRIX.map(([, make]) =>
            JSON.stringify(before.evaluate(TENANCY_V1_POLICY_ID, make())),
          );

          // Per-case assertion: the same input must yield the identical verdict.
          COMPARISON_MATRIX.forEach(([label], index) => {
            const expected = decisionsBefore[index].split(" => ")[1];
            expect(decisionsAfter[index], label).toBe(expected);
          });
          // And the workspace-v1 column genuinely differs on the new facts —
          // the registry did not silently register a clone of the old version.
          const teamPublicCase = COMPARISON_MATRIX[5];
          expect(
            before.evaluate(WORKSPACE_V1_POLICY_ID, teamPublicCase[1]())
              .outcome,
          ).toBe("allow");
          expect(
            before.evaluate(TENANCY_V1_POLICY_ID, teamPublicCase[1]()).outcome,
          ).toBe("deny");
        },
      );

      itDb(
        "tenancy-v1 registry decisions equal the production authz decisions on the same facts",
        async () => {
          const registry = createResourcePolicyRegistry();
          registry.register(tenancyV1ResourcePolicy);
          const authz = createAuthz();
          for (const [label, make] of COMPARISON_MATRIX) {
            const facts = make();
            const scope = facts.scope as PlatformScope;
            const expected = await authz.check({
              scope,
              action: "read",
              resource: {
                id: facts.resource.id,
                tenantId: facts.resource.tenantId,
                workspaceId: facts.resource.workspaceId,
                principalId: facts.scope.principalId,
                revision: facts.resource.revision ?? 1,
                aclEpoch: facts.resource.aclEpoch ?? 1,
                policyRevision: TENANCY_V1_POLICY_ID,
                active: facts.resource.status === "active",
                locallyAllowed: facts.grant.read,
              },
            });
            const verdict = registry.evaluate(TENANCY_V1_POLICY_ID, facts);
            expect(
              verdict.outcome === "allow",
              `${label}: registry=${JSON.stringify(verdict)} authz=${expected}`,
            ).toBe(expected);
          }
        },
      );

      itDb(
        "a tenant on tenancy-v1 ignores visibility entirely (workspace-marked resource stays grant-only under the old version)",
        async () => {
          const team = fixture.teamOf("a1-other", "team-a1");
          const tenantId = fixture.isolation.ids["company-a"];
          const resourceId = fixture.isolation.ids["resource-a1"];
          await fixture.markVisibility({
            tenantId,
            resourceId,
            visibility: "workspace",
          });

          // No explicit policyVersion: decide() resolves the tenant's own
          // policy revision, which is tenancy-v1 — visibility must not matter.
          const service = createResourcePolicyService(
            fixture.data,
            createShippedResourcePolicyRegistry(),
          );
          const memberWithoutGrant = await fixture.scopeFor("a1-other", team);
          expect(await service.decide(memberWithoutGrant, resourceId)).toEqual(
            DENY_NOT_FOUND,
          );
          const grantee = await fixture.scopeFor("a1-member", team);
          expect(await service.decide(grantee, resourceId)).toEqual(ALLOW);
          await fixture.markVisibility({
            tenantId,
            resourceId,
            visibility: null,
          });
        },
      );

      itDb(
        "decide() refuses unknown policy revisions instead of guessing",
        async () => {
          const team = fixture.teamOf("a1-member", "team-a1");
          const scope = await fixture.scopeFor("a1-member", team);
          const service = createResourcePolicyService(
            fixture.data,
            createShippedResourcePolicyRegistry(),
          );
          const message = await thrownMessage(
            service.decide(scope, fixture.isolation.ids["resource-a1"], {
              policyVersion: "conversations-v9",
            }),
          );
          expect(message).toContain("POLICY_REVISION_UNSUPPORTED");
        },
      );
    });

    // -----------------------------------------------------------------------
    // 验收 (3)：显式清单迁移；无清单/空清单零写入
    // -----------------------------------------------------------------------

    describe("issue #51 criterion 3: legacy resources become team-public only through an explicit manifest", () => {
      itDb(
        "a missing manifest performs zero writes (pre-marked values survive untouched)",
        async () => {
          const tenantId = fixture.isolation.ids["company-a"];
          const a1 = fixture.isolation.ids["resource-a1"];
          // Arrange: a pre-existing marking that a zero-write run must NOT
          // touch (neither widen, nor reset, nor normalize).
          await fixture.markVisibility({
            tenantId,
            resourceId: a1,
            visibility: "workspace",
          });

          const report = await migrateLegacyResourcesToWorkspaceVisibility(
            fixture.operator,
            null,
          );
          expect(report.updatesExecuted).toBe(0);
          expect(report.migrated).toEqual([]);
          expect(report.requested).toBe(0);
          expect(await fixture.visibilityOf(tenantId, a1)).toBe("workspace");
        },
      );

      itDb("an empty manifest performs zero writes", async () => {
        const tenantId = fixture.isolation.ids["company-a"];
        const a1 = fixture.isolation.ids["resource-a1"];
        await fixture.markVisibility({
          tenantId,
          resourceId: a1,
          visibility: "private",
        });

        const report = await migrateLegacyResourcesToWorkspaceVisibility(
          fixture.operator,
          { tenantId, resourceIds: [] },
        );
        expect(report.updatesExecuted).toBe(0);
        expect(report.migrated).toEqual([]);
        expect(report.requested).toBe(0);
        expect(await fixture.visibilityOf(tenantId, a1)).toBe("private");
      });

      itDb(
        "an explicit manifest migrates exactly the listed resources and nothing else",
        async () => {
          const tenantId = fixture.isolation.ids["company-a"];
          const a1 = fixture.isolation.ids["resource-a1"];
          const a1Other = fixture.isolation.ids["resource-a1-other"];
          const a2 = fixture.isolation.ids["resource-a2"];
          for (const id of [a1, a1Other, a2]) {
            await fixture.markVisibility({
              tenantId,
              resourceId: id,
              visibility: null,
            });
          }

          const report = await migrateLegacyResourcesToWorkspaceVisibility(
            fixture.operator,
            { tenantId, resourceIds: [a1] },
          );
          expect(report.migrated).toEqual([a1]);
          expect(report.updatesExecuted).toBe(1);
          expect(report.privateKept).toEqual([]);
          expect(report.alreadyWorkspace).toEqual([]);
          expect(report.notFound).toEqual([]);
          // Listed → migrated; everything else untouched.
          expect(await fixture.visibilityOf(tenantId, a1)).toBe("workspace");
          expect(await fixture.visibilityOf(tenantId, a1Other)).toBeNull();
          expect(await fixture.visibilityOf(tenantId, a2)).toBeNull();
        },
      );

      itDb("already-workspace resources are idempotent no-ops", async () => {
        const tenantId = fixture.isolation.ids["company-a"];
        const a1 = fixture.isolation.ids["resource-a1"];
        await fixture.markVisibility({
          tenantId,
          resourceId: a1,
          visibility: "workspace",
        });

        const report = await migrateLegacyResourcesToWorkspaceVisibility(
          fixture.operator,
          { tenantId, resourceIds: [a1] },
        );
        expect(report.updatesExecuted).toBe(0);
        expect(report.migrated).toEqual([]);
        expect(report.alreadyWorkspace).toEqual([a1]);
        expect(await fixture.visibilityOf(tenantId, a1)).toBe("workspace");
      });

      itDb(
        "private resources are never widened by the migration (explicit personal choice outranks the manifest)",
        async () => {
          const tenantId = fixture.isolation.ids["company-a"];
          const a1 = fixture.isolation.ids["resource-a1"];
          await fixture.markVisibility({
            tenantId,
            resourceId: a1,
            visibility: "private",
          });

          const report = await migrateLegacyResourcesToWorkspaceVisibility(
            fixture.operator,
            { tenantId, resourceIds: [a1] },
          );
          expect(report.updatesExecuted).toBe(0);
          expect(report.migrated).toEqual([]);
          expect(report.privateKept).toEqual([a1]);
          expect(await fixture.visibilityOf(tenantId, a1)).toBe("private");
        },
      );

      itDb(
        "resource ids of another tenant are reported not-found and never written",
        async () => {
          const tenantA = fixture.isolation.ids["company-a"];
          const tenantB = fixture.isolation.ids["company-b"];
          const b1 = fixture.isolation.ids["resource-b1"];
          expect(await fixture.visibilityOf(tenantB, b1)).toBeNull();

          const report = await migrateLegacyResourcesToWorkspaceVisibility(
            fixture.operator,
            { tenantId: tenantA, resourceIds: [b1] },
          );
          expect(report.migrated).toEqual([]);
          expect(report.updatesExecuted).toBe(0);
          expect(report.notFound).toEqual([b1]);
          // The foreign row is untouched in its own tenant.
          expect(await fixture.visibilityOf(tenantB, b1)).toBeNull();
        },
      );

      itDb(
        "after explicit migration the resource is team-public under workspace-v1 while tenancy-v1 stays grant-only",
        async () => {
          const team = fixture.teamOf("a1-other", "team-a1");
          const tenantId = fixture.isolation.ids["company-a"];
          const a1 = fixture.isolation.ids["resource-a1"];
          await fixture.markVisibility({
            tenantId,
            resourceId: a1,
            visibility: null,
          });
          const report = await migrateLegacyResourcesToWorkspaceVisibility(
            fixture.operator,
            { tenantId, resourceIds: [a1] },
          );
          expect(report.migrated).toEqual([a1]);

          const service = createResourcePolicyService(
            fixture.data,
            createShippedResourcePolicyRegistry(),
          );
          const memberWithoutGrant = await fixture.scopeFor("a1-other", team);
          expect(
            await service.decide(memberWithoutGrant, a1, {
              policyVersion: WORKSPACE_V1_POLICY_ID,
            }),
          ).toEqual(ALLOW);
          expect(
            await service.decide(memberWithoutGrant, a1, {
              policyVersion: TENANCY_V1_POLICY_ID,
            }),
          ).toEqual(DENY_NOT_FOUND);
          await fixture.markVisibility({
            tenantId,
            resourceId: a1,
            visibility: null,
          });
        },
      );

      itDb("manifest parsing refuses junk and accepts valid manifests", () => {
        expect(parseResourceVisibilityManifest("not json").ok).toBe(false);
        expect(parseResourceVisibilityManifest("{}").ok).toBe(false);
        expect(
          parseResourceVisibilityManifest(
            JSON.stringify({ tenantId: "t", resourceIds: [42] }),
          ).ok,
        ).toBe(false);
        expect(
          parseResourceVisibilityManifest(
            JSON.stringify({ tenantId: "", resourceIds: ["r"] }),
          ).ok,
        ).toBe(false);
        const valid = parseResourceVisibilityManifest(
          JSON.stringify({ tenantId: "tenant-a", resourceIds: ["r1", "r2"] }),
        );
        expect(valid.ok).toBe(true);
        if (valid.ok) {
          expect(valid.manifest.tenantId).toBe("tenant-a");
          expect(valid.manifest.resourceIds).toEqual(["r1", "r2"]);
        }
      });
    });

    // -----------------------------------------------------------------------
    // 验收 (4)：跨公司引用永远拒绝；不泄露存在性
    // -----------------------------------------------------------------------

    describe("issue #51 criterion 4: cross-company references are always denied without leaking existence", () => {
      itDb(
        "workspace-v1 denies cross-company facts even with a grant and workspace visibility (policy level)",
        () => {
          const registry = createResourcePolicyRegistry();
          registry.register(workspaceV1ResourcePolicy);
          const crossCompany = factsOf({
            visibility: "workspace",
            tenantId: "tenant-b",
          });
          expect(
            registry.evaluate(WORKSPACE_V1_POLICY_ID, crossCompany),
          ).toEqual(DENY_NOT_FOUND);
        },
      );

      itDb("tenancy-v1 denies the same cross-company facts (unchanged)", () => {
        const registry = createResourcePolicyRegistry();
        registry.register(tenancyV1ResourcePolicy);
        const crossCompany = factsOf({ tenantId: "tenant-b" });
        expect(registry.evaluate(TENANCY_V1_POLICY_ID, crossCompany)).toEqual(
          DENY_NOT_FOUND,
        );
      });

      itDb(
        "a company B member cannot read a company A resource through the service",
        async () => {
          const teamB = fixture.teamOf("b1-member", "team-b1");
          const tenantA = fixture.isolation.ids["company-a"];
          const a1 = fixture.isolation.ids["resource-a1"];
          // Even with the resource explicitly published to ITS team.
          await fixture.markVisibility({
            tenantId: tenantA,
            resourceId: a1,
            visibility: "workspace",
          });

          const service = createResourcePolicyService(
            fixture.data,
            createShippedResourcePolicyRegistry(),
          );
          const bScope = await fixture.scopeFor("b1-member", teamB);
          for (const version of [
            TENANCY_V1_POLICY_ID,
            WORKSPACE_V1_POLICY_ID,
          ]) {
            expect(
              await service.decide(bScope, a1, { policyVersion: version }),
            ).toEqual(DENY_NOT_FOUND);
          }
          await fixture.markVisibility({
            tenantId: tenantA,
            resourceId: a1,
            visibility: null,
          });
        },
      );

      itDb(
        "denial for a foreign resource is indistinguishable from denial for a nonexistent resource",
        async () => {
          const teamA = fixture.teamOf("a1-member", "team-a1");
          const teamB = fixture.teamOf("b1-member", "team-b1");
          const a1 = fixture.isolation.ids["resource-a1"];
          const service = createResourcePolicyService(
            fixture.data,
            createShippedResourcePolicyRegistry(),
          );
          const aScope = await fixture.scopeFor("a1-member", teamA);
          const bScope = await fixture.scopeFor("b1-member", teamB);
          const foreign = await service.decide(bScope, a1, {
            policyVersion: WORKSPACE_V1_POLICY_ID,
          });
          const nonexistent = await service.decide(
            aScope,
            "mt008-no-such-resource",
            {
              policyVersion: WORKSPACE_V1_POLICY_ID,
            },
          );
          expect(foreign).toEqual(DENY_NOT_FOUND);
          expect(nonexistent).toEqual(DENY_NOT_FOUND);
          // Identical error surface: the verdict carries no existence signal.
          expect(JSON.stringify(foreign)).toBe(JSON.stringify(nonexistent));
        },
      );

      itDb(
        "the same multi-company person is allowed under their own company scope and denied under the other (the scope is the authority)",
        async () => {
          const teamA1 = fixture.teamOf("multi-company", "team-a1");
          const teamB1 = fixture.teamOf("multi-company", "team-b1");
          const b1 = fixture.isolation.ids["resource-b1"];
          const service = createResourcePolicyService(
            fixture.data,
            createShippedResourcePolicyRegistry(),
          );
          const inCompanyB = await fixture.scopeFor("multi-company", teamB1);
          const inCompanyA = await fixture.scopeFor("multi-company", teamA1);
          // multi-company holds a real read grant on resource-b1 in company B…
          expect(
            await service.decide(inCompanyB, b1, {
              policyVersion: TENANCY_V1_POLICY_ID,
            }),
          ).toEqual(ALLOW);
          // …and is still denied for it from company A's scope: cross-company
          // references are denied regardless of who the person is elsewhere.
          for (const version of [
            TENANCY_V1_POLICY_ID,
            WORKSPACE_V1_POLICY_ID,
          ]) {
            expect(
              await service.decide(inCompanyA, b1, { policyVersion: version }),
            ).toEqual(DENY_NOT_FOUND);
          }
        },
      );
    });

    // -----------------------------------------------------------------------
    // 收尾核对：受限角色全程在岗（判定都经真实 RLS 得出）
    // -----------------------------------------------------------------------

    itDb(
      "restricted roles were in play (capability identities, not superuser)",
      async () => {
        const rows = await fixture.data.execute(
          sql`select current_user as current_user`,
        );
        const row = (rows as unknown as Array<Record<string, unknown>>)[0];
        expect(String(row?.current_user)).toBe("ob_ent_data");
      },
    );
  },
);
