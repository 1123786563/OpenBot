// server/tests/multitenancy/coverage-governance.test.ts
// MT138（Issue #181）：覆盖证据——治理、审计与观测出口。
//
// 用 MT132 身份矩阵 runner 为平台管理与公司/团队管理分离（MT006 判定面
// authorizePlatformManagementAction / authorizeCompanyManagementAction：平台
// 哨兵、跨面显式授权、未分类入口 fail-closed）与租户审计查询
//（queryTenantAuditEvents：判定门先于行读取，跨范围哨兵拒绝）的逐入口
// 正向与越权证据，全部骑真实判定面与真实受限角色连接。
//
// 路径级直接钉住（无一对一 HTTP 入口映射，按 MT135 先例披露）：
//   - 观测后端（MT110）：公司查询门、导出三闸（范围 + 脱敏版本 + 审计）、
//     trace 链接整链重验、部署级 dashboard 平台身份独占；
//   - 已启用集成的隔离与账户路由证据（MT111）：证据清单闭集、enabled-*
//     条目 basisRefs 全部为仓内真实文件、未验证项显式分类标记。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_
// DATABASE_URL）加三个受限角色 URL；缺配置时整套显式 skip（跳过原因写在
// 用例名里，skipped 不计为通过），绝不回退开发库。
//
// 证据可复现（票面 Verification）：本套件即复现命令——
//   set +x; source /tmp/mt25-env.sh && bun --no-env-file test \
//     server/tests/multitenancy/coverage-governance.test.ts

import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  type MatrixPlan,
  runMatrixCoverage,
} from "../../scripts/multitenancy/identity-matrix-runner";
import {
  buildInventory,
  type CoverageInventory,
} from "../../scripts/multitenancy/inventory";
import { createDatabase, type Database } from "../../src/db/client";
import { aiObservationBindings } from "../../src/db/schema/ai-observability-bindings";
import {
  authorizeCompanyManagementAction,
  authorizePlatformManagementAction,
  createManagementCrossGrantRegistry,
  type ManagementActor,
  type ManagementCrossGrant,
} from "../../src/enterprise/tenancy/admin-separation";
import { queryTenantAuditEvents } from "../../src/enterprise/tenancy/audit-domains";
import {
  type DataDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import {
  INTEGRATION_EVIDENCE,
  integrationEvidenceReadiness,
} from "../../src/enterprise/tenancy/integration-evidence";
import {
  authorizeCompanyObservationExport,
  authorizeCompanyObservationSubject,
  authorizeTraceLinkOpen,
  OBSERVABILITY_EXPORT_REDACTION_POLICY,
  qualifiesForDeploymentObservation,
  type TraceBindingReader,
} from "../../src/enterprise/tenancy/observability-authz";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import {
  type AdminSeparationFixture,
  createAdminSeparationFixture,
} from "./support/admin-separation";
import {
  type AuditDomainsFixture,
  createAuditDomainsFixture,
  probeAuditDomainsEnvironment,
} from "./support/audit-domains";
import {
  createBotsOwnershipFixture,
  type BotsOwnershipFixture,
} from "./support/bots-ownership";
import {
  adapterFromScenarios,
  requireEntrance,
  type ScenarioMap,
} from "./support/coverage-matrix";
import type { IsolationObservation } from "./support/scenarios";
import { registerIsolationDomain } from "./support/scenarios";

// ---------------------------------------------------------------------------
// 环境探针：缺 env 显式 skip（带理由），绝不静默回退
// ---------------------------------------------------------------------------

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const probes = [probeAuditDomainsEnvironment()];
  const failed = probes.find((probe) => !probe.ok);
  if (failed && !failed.ok) return { ok: false, reason: failed.reason };
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
      reason: `MT138 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
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

/** The real inventory every mapped entrance must come from. */
const inventory: CoverageInventory = await buildInventory({
  environment: process.env,
});

/** 夹具身份 → §11 矩阵类等价表（披露，非推导）。 */
const ACTOR_CLASSES = {
  "a1-owner": "company-a-team-a1-only",
  "a1-member": "company-a-team-a1-only",
  "a1-other": "same-team-other-person",
  "a2-member": "company-a-team-a2-only",
  "b1-member": "cross-company",
} as const;

// ---------------------------------------------------------------------------
// 惰性夹具
// ---------------------------------------------------------------------------

const createdDisposables: Array<() => Promise<void>> = [];

function lazy<T extends { dispose(): Promise<void> }>(
  create: () => Promise<T>,
): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () =>
    (promise ??= create().then((fixture) => {
      createdDisposables.push(() => fixture.dispose());
      return fixture;
    }));
}

const auditDomains = lazy(() => createAuditDomainsFixture());
const botsOwnership = lazy(() => createBotsOwnershipFixture());
const adminSeparation = lazy(() => createAdminSeparationFixture());

const denyObservation = (
  denied: boolean,
  leaks: readonly unknown[] = [],
  effects: readonly unknown[] = [],
): IsolationObservation => ({
  positiveControlPassed: false,
  denied,
  leakedRecords: leaks,
  forbiddenEffects: effects,
});

const entranceOf = (id: string): { method: string; path: string } => {
  const separator = id.indexOf(" ");
  if (separator <= 0) throw new Error(`ENTRANCE_ID_MALFORMED:${id}`);
  return { method: id.slice(0, separator), path: id.slice(separator + 1) };
};

/** 平台判定用的三个真实身份（§11 类载体的判定面披露）。 */
const DEPLOYMENT_ADMIN: ManagementActor = {
  kind: "deployment_admin",
  userId: "mt138-deployment-admin",
};
const PLATFORM_OPERATOR: ManagementActor = {
  kind: "platform_operator",
  subject: "ob_ent_identity_operator",
};
const COMPANY_ADMIN_A: ManagementActor = {
  kind: "company_admin",
  context: {
    tenantId: "tenant-mt138-a",
    principalId: "principal-mt138-admin",
    actorId: "user-mt138-admin",
    memberEpoch: 1,
  },
};

// ---------------------------------------------------------------------------
// 场景（admin-audit 域）
// ---------------------------------------------------------------------------

const governanceScenarios: ScenarioMap = {
  // GET /api/admin/audit-events —— 租户审计查询（判定门先于行读取）。
  "governance.audit-query.positive": async () => {
    const fixture = await auditDomains();
    const rows = await queryTenantAuditEvents(
      fixture.operator,
      { kind: "company", principalId: fixture.caller("a-auditor").principalId },
      { tenantId: fixture.ids.companyA, domain: "business" },
    );
    return {
      positiveControlPassed: Array.isArray(rows),
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "governance.audit-query.denial": async () => {
    const fixture = await auditDomains();
    // 跨范围：A 公司审计员查 B 公司 → 哨兵拒绝（不区分原因、不泄存在性）。
    let forbidden = false;
    try {
      await queryTenantAuditEvents(
        fixture.operator,
        {
          kind: "company",
          principalId: fixture.caller("a-auditor").principalId,
        },
        { tenantId: fixture.ids.companyB, domain: "business" },
      );
    } catch (error) {
      forbidden = /AUDIT_SCOPE_FORBIDDEN/.test(
        error instanceof Error ? error.message : String(error),
      );
    }
    return denyObservation(forbidden);
  },

  // GET /api/admin/status —— 平台管理入口（公司管理员结构性拒绝）。
  "governance.platform-status.positive": async () => {
    const decision = authorizePlatformManagementAction(
      DEPLOYMENT_ADMIN,
      entranceOf("GET /api/admin/status"),
    );
    const operatorDecision = authorizePlatformManagementAction(
      PLATFORM_OPERATOR,
      entranceOf("GET /api/admin/status"),
    );
    return {
      positiveControlPassed:
        decision.outcome === "allow" && operatorDecision.outcome === "allow",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "governance.platform-status.denial": async () => {
    const decision = authorizePlatformManagementAction(
      COMPANY_ADMIN_A,
      entranceOf("GET /api/admin/status"),
    );
    return denyObservation(
      decision.outcome === "deny" && decision.code === "PLATFORM_ADMIN_REQUIRED",
    );
  },

  // POST /api/admin/people/:userId/role —— 平台人员管理（同判定面）。
  "governance.platform-people.positive": async () => {
    const decision = authorizePlatformManagementAction(
      PLATFORM_OPERATOR,
      entranceOf("POST /api/admin/people/:userId/role"),
    );
    return {
      positiveControlPassed: decision.outcome === "allow",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "governance.platform-people.denial": async () => {
    const decision = authorizePlatformManagementAction(
      COMPANY_ADMIN_A,
      entranceOf("POST /api/admin/people/:userId/role"),
    );
    // 未分类入口（业务面）同样 fail-closed。
    const unclassified = authorizePlatformManagementAction(DEPLOYMENT_ADMIN, {
      method: "GET",
      path: "/api/agents",
    });
    return denyObservation(
      decision.outcome === "deny" &&
        decision.code === "PLATFORM_ADMIN_REQUIRED" &&
        unclassified.outcome === "deny" &&
        unclassified.code === "MANAGEMENT_ENTRANCE_UNCLASSIFIED",
    );
  },

  // GET /api/admin/enterprise —— 平台对企业配置的管理面（同判定面）。
  "governance.platform-enterprise.positive": async () => {
    const decision = authorizePlatformManagementAction(
      DEPLOYMENT_ADMIN,
      entranceOf("GET /api/admin/enterprise"),
    );
    return {
      positiveControlPassed: decision.outcome === "allow",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "governance.platform-enterprise.denial": async () => {
    const decision = authorizePlatformManagementAction(
      COMPANY_ADMIN_A,
      entranceOf("GET /api/admin/enterprise"),
    );
    return denyObservation(decision.outcome === "deny");
  },

  // POST /api/enterprise/workspace-scope/admin/teams —— 公司管理
  //（平台身份需显式跨面授权；公司管理员上下文放行）。
  "governance.company-teams.positive": async () => {
    // 真实签发的公司管理员上下文（MT006 authorizer 经真实成员资格核验；
    // 手工构造的同形上下文会被 assertTrustedAdminContext 拒绝——见
    // denial 侧与 admin-separation 套件的伪造用例）。
    const fixture = await adminSeparation();
    const context = await fixture.scope.adminContextOf("company-admin");
    const decision = authorizeCompanyManagementAction({
      actor: { kind: "company_admin", context },
      entrance: entranceOf("POST /api/enterprise/workspace-scope/admin/teams"),
      tenantId: context.tenantId,
      grants: createManagementCrossGrantRegistry([]),
    });
    return {
      positiveControlPassed: decision.outcome === "allow",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "governance.company-teams.denial": async () => {
    // 平台操作身份无显式授权 → 拒绝。
    const noGrant = authorizeCompanyManagementAction({
      actor: PLATFORM_OPERATOR,
      entrance: entranceOf("POST /api/enterprise/workspace-scope/admin/teams"),
      tenantId: "tenant-mt138-a",
      grants: createManagementCrossGrantRegistry([]),
    });
    // 有显式授权（精确绑定本入口 + 本公司）→ 放行。
    const grant: ManagementCrossGrant = {
      grantId: "mt138-grant-1",
      subject: "ob_ent_identity_operator",
      tenantId: "tenant-mt138-a",
      entrance: "POST /api/enterprise/workspace-scope/admin/teams",
      grantedBy: "mt138-deployment-admin",
      reason: "mt138 coverage cross-plane probe",
    };
    const withGrant = authorizeCompanyManagementAction({
      actor: PLATFORM_OPERATOR,
      entrance: entranceOf("POST /api/enterprise/workspace-scope/admin/teams"),
      tenantId: "tenant-mt138-a",
      grants: createManagementCrossGrantRegistry([grant]),
    });
    // 跨租户授权不通用：同一授权行对另一公司无效。
    const otherTenant = authorizeCompanyManagementAction({
      actor: PLATFORM_OPERATOR,
      entrance: entranceOf("POST /api/enterprise/workspace-scope/admin/teams"),
      tenantId: "tenant-mt138-b",
      grants: createManagementCrossGrantRegistry([grant]),
    });
    return denyObservation(
      noGrant.outcome === "deny" &&
        noGrant.code === "MANAGEMENT_CROSS_AUTHORIZATION_REQUIRED" &&
        withGrant.outcome === "allow" &&
        otherTenant.outcome === "deny",
    );
  },

  // POST /api/enterprise/workspace-scope/admin/teams/:workspaceId/members
  // —— 公司团队管理（同判定面，入口级差异）。
  "governance.company-members.positive": async () => {
    const fixture = await adminSeparation();
    const context = await fixture.scope.adminContextOf("company-admin");
    const decision = authorizeCompanyManagementAction({
      actor: { kind: "company_admin", context },
      entrance: entranceOf(
        "POST /api/enterprise/workspace-scope/admin/teams/:workspaceId/members",
      ),
      tenantId: context.tenantId,
      grants: createManagementCrossGrantRegistry([]),
    });
    return {
      positiveControlPassed: decision.outcome === "allow",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "governance.company-members.denial": async () => {
    const decision = authorizeCompanyManagementAction({
      actor: PLATFORM_OPERATOR,
      entrance: entranceOf(
        "POST /api/enterprise/workspace-scope/admin/teams/:workspaceId/members",
      ),
      tenantId: "tenant-mt138-a",
      grants: createManagementCrossGrantRegistry([]),
    });
    return denyObservation(decision.outcome === "deny");
  },
};

/** 入口 → 场景映射。 */
const PLAN: MatrixPlan = {
  "GET /api/admin/audit-events": {
    positive: {
      domain: "admin-audit",
      scenarioId: "governance.audit-query.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-member"],
    },
    denial: {
      domain: "admin-audit",
      scenarioId: "governance.audit-query.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "GET /api/admin/status": {
    positive: {
      domain: "admin-audit",
      scenarioId: "governance.platform-status.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-member"],
    },
    denial: {
      domain: "admin-audit",
      scenarioId: "governance.platform-status.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/admin/people/:userId/role": {
    positive: {
      domain: "admin-audit",
      scenarioId: "governance.platform-people.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-member"],
    },
    denial: {
      domain: "admin-audit",
      scenarioId: "governance.platform-people.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "GET /api/admin/enterprise": {
    positive: {
      domain: "admin-audit",
      scenarioId: "governance.platform-enterprise.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-member"],
    },
    denial: {
      domain: "admin-audit",
      scenarioId: "governance.platform-enterprise.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/enterprise/workspace-scope/admin/teams": {
    positive: {
      domain: "admin-audit",
      scenarioId: "governance.company-teams.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-member"],
    },
    denial: {
      domain: "admin-audit",
      scenarioId: "governance.company-teams.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/enterprise/workspace-scope/admin/teams/:workspaceId/members": {
    positive: {
      domain: "admin-audit",
      scenarioId: "governance.company-members.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-member"],
    },
    denial: {
      domain: "admin-audit",
      scenarioId: "governance.company-members.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
};

for (const entranceId of Object.keys(PLAN)) {
  requireEntrance(inventory, entranceId);
}

beforeAll(async () => {
  if (!ENV.ok) return;
  registerIsolationDomain(
    "admin-audit",
    adapterFromScenarios(governanceScenarios),
  );
}, 30_000);

afterAll(async () => {
  for (const dispose of createdDisposables.splice(0)) {
    await dispose().catch(() => undefined);
  }
}, 240_000);

// ---------------------------------------------------------------------------

/** 一次矩阵运行，全部用例共享。 */
let coveragePromise: Promise<ReturnType<typeof runMatrixCoverage>> | undefined;
const coverage = () =>
  (coveragePromise ??= runMatrixCoverage({
    environment: process.env,
    inventory,
    plan: PLAN,
    runId: "mt138",
  }));

describeDb("MT138 / Issue #181 — 覆盖证据：治理、审计与观测出口", () => {
  itDb(
    "计划内全部入口在矩阵 runner 输出中 covered（正向与越权两侧都过）",
    async () => {
      const report = await coverage();
      const byId = new Map(report.entrances.map((entry) => [entry.id, entry]));
      const failures: string[] = [];
      for (const entranceId of Object.keys(PLAN)) {
        const entry = byId.get(entranceId);
        if (!entry) {
          failures.push(`${entranceId}: not in report`);
          continue;
        }
        if (entry.status !== "covered") {
          failures.push(
            `${entranceId}: ${entry.status} (positive=${entry.positive.status}/${entry.positive.reasons.join("|")}; denial=${entry.denial.status}/${entry.denial.reasons.join("|")})`,
          );
        }
      }
      expect(failures).toEqual([]);
      expect(report.schemaVersion).toBe(1);
      expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();
      const classes = new Map(
        report.matrix.classes.map((entry) => [entry.id, entry]),
      );
      expect(
        classes.get("company-a-team-a1-only")?.entrancesCovered,
      ).toBeGreaterThan(0);
      expect(classes.get("cross-company")?.entrancesCovered).toBeGreaterThan(0);
      expect(report.overall).toBe("coverage-incomplete");
    },
    600_000,
  );

  itDb(
    "观测后端：公司查询门、导出三闸、trace 链接整链重验、部署面独占（路径级钉住）",
    async () => {
      const fixture = await botsOwnership();
      const companyA = fixture.ids["company-a"];
      const companyB = fixture.ids["company-b"];
      const teamA1 = fixture.ids["team-a1"];
      const data = (await verifyDataDatabase(
        createDatabase(enterpriseRuntimeDatabaseUrlFrom("data", process.env), {
          max: 1,
        }),
      )) as DataDatabase;
      const operator = (await verifyOperatorDatabase(
        createDatabase(
          enterpriseRuntimeDatabaseUrlFrom("operator", process.env),
          { max: 1 },
        ),
      )) as OperatorDatabase;
      const appDatabase = createDatabase(process.env.TEST_DATABASE_URL!, {
        max: 1,
      });
      try {
        // 本域 Bot（真实 MT016 创建路径）。
        const agentId = `${fixture.idPrefix}-mt138-bot-${randomUUID().slice(0, 8)}`;
        const scope = await fixture.scopeAs("a1-member", companyA, teamA1);
        const created = await fixture.service.createBot(scope, {
          agentId,
          displayName: "MT138 observability bot",
          defaultConfig: { model: "gpt-4o" },
        });
        expect(created.outcome).toBe("allow");

        // 1) 公司查询门：本人公司 Bot allow；跨公司/不存在 = 同形 not-found。
        const own = await authorizeCompanyObservationSubject(data, scope, agentId);
        expect(own.outcome).toBe("allowed");
        const bScope = await fixture.scopeAs(
          "b1-member",
          companyB,
          fixture.ids["team-b1"],
        );
        const cross = await authorizeCompanyObservationSubject(
          data,
          bScope,
          agentId,
        );
        const missing = await authorizeCompanyObservationSubject(
          data,
          scope,
          "mt138-bot-does-not-exist",
        );
        expect(cross.outcome).toBe("deny");
        expect(missing.outcome).toBe("deny");
        expect(JSON.stringify(cross)).toBe(JSON.stringify(missing));

        // 2) 导出三闸：本人范围 + 当前脱敏版本 → allowed + 审计；跨范围
        //    → refused（零审计副作用）。
        const exported = await authorizeCompanyObservationExport(
          data,
          operator,
          scope,
          {
            botId: agentId,
            redactionPolicyVersion: OBSERVABILITY_EXPORT_REDACTION_POLICY,
          },
        );
        expect(exported.outcome).toBe("allowed");
        const refusedExport = await authorizeCompanyObservationExport(
          data,
          operator,
          bScope,
          {
            botId: agentId,
            redactionPolicyVersion: OBSERVABILITY_EXPORT_REDACTION_POLICY,
          },
        );
        expect(refusedExport.outcome).toBe("refused");

        // 3) trace 链接：真实绑定行 + 本人 → allow；跨公司持完整 id →
        //    与「trace 不存在」不可区分的 refused。
        const traceId = `mt138-trace-${randomUUID().slice(0, 8)}`;
        await appDatabase
          .insert(aiObservationBindings)
          .values({
            id: `mt138-bind-${traceId}`,
            scopeKey: `wb|${scope.actorId.length}:${scope.actorId}|${agentId.length}:${agentId}|1:0`,
            actorId: scope.actorId,
            botId: agentId,
            runId: `mt138-run-${traceId}`,
            attemptId: `mt138-attempt-${traceId}`,
            traceId: `mt138-otel-${traceId}`,
            opikTraceId: traceId,
            locatorWorkspace: "mt138-locator-ws",
            locatorProject: "mt138-locator-proj",
            capability: "detailed",
            state: "completed",
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          })
          .onConflictDoNothing();
        const bindingReader: TraceBindingReader = {
          async byUpstreamTrace(opikTraceId) {
            const rows = await appDatabase
              .select({
                botId: aiObservationBindings.botId,
                actorId: aiObservationBindings.actorId,
                scopeKey: aiObservationBindings.scopeKey,
              })
              .from(aiObservationBindings)
              .where(sql`${aiObservationBindings.opikTraceId} = ${opikTraceId}`);
            return rows;
          },
        };
        const opened = await authorizeTraceLinkOpen(data, bindingReader, scope, {
          opikTraceId: traceId,
        });
        expect(opened.outcome).toBe("allowed");
        const crossOpen = await authorizeTraceLinkOpen(
          data,
          bindingReader,
          bScope,
          { opikTraceId: traceId },
        );
        expect(crossOpen.outcome).toBe("refused");

        // 4) 部署级 dashboard：平台身份独占；公司上下文内任何身份
        //    （含 tenant_admin、角色名恰为 admin）结构性拒绝。
        expect(
          qualifiesForDeploymentObservation({
            kind: "platform",
            subject: "ob_ent_identity_operator",
          }),
        ).toBe(true);
        expect(
          qualifiesForDeploymentObservation({
            kind: "company",
            role: "tenant_admin",
            tenantId: companyA,
          }),
        ).toBe(false);
      } finally {
        await appDatabase
          .delete(aiObservationBindings)
          .where(sql`${aiObservationBindings.id} like 'mt138-bind-%'`)
          .catch(() => undefined);
        data.$client.close();
        operator.$client.close();
        appDatabase.$client.close();
      }
    },
    600_000,
  );

  itDb(
    "已启用集成的隔离与账户路由证据齐备，未验证项显式标记（MT111 路径级钉住）",
    async () => {
      // 就绪面以真实 MT001 清单的 externalDependencies 对账（闭集对齐：
      // 注册表与清单互相 unmatched 即阻塞项，显式可见）。
      const readiness = integrationEvidenceReadiness(
        inventory.externalDependencies.map((dep) => ({ dependency: dep.dependency })),
      );
      // 闭集分类：每个集成恰好一类；enabled-* 必须给出真实 basisRefs。
      for (const entry of INTEGRATION_EVIDENCE) {
        expect(["enabled-verified", "enabled-unverified", "not-implemented"])
          .toContain(entry.classification);
        if (entry.classification.startsWith("enabled-")) {
          expect(entry.basisRefs.length).toBeGreaterThan(0);
          for (const ref of entry.basisRefs) {
            expect(existsSync(ref)).toBe(true);
          }
          expect(["n/a", "per-company", "deployment-key"]).toContain(
            entry.payerRouting,
          );
        }
      }
      // 未验证项显式标记（不是静默缺失）。
      const unverified = INTEGRATION_EVIDENCE.filter(
        (entry) => entry.classification === "enabled-unverified",
      );
      expect(unverified.length).toBeGreaterThan(0);
      // 就绪面：unverified/not-implemented 全集是显式阻断项（非静默缺失）；
      // 清单与注册表互相 unmatched 即缺口。
      expect(readiness.blockers.length).toBe(
        INTEGRATION_EVIDENCE.filter(
          (entry) => entry.classification !== "enabled-verified",
        ).length,
      );
      expect(readiness.ready).toBe(false);
    },
    60_000,
  );

  itDb(
    "未映射的治理入口保留在缺口清单（漂移可见，不虚报覆盖）",
    async () => {
      const report = await coverage();
      const gapIds = new Set(report.gaps.map((gap) => gap.entranceId));
      expect(gapIds.has("PUT /api/admin/enterprise/capabilities")).toBe(true);
      expect(gapIds.has("GET /api/admin/gateway/key-drift")).toBe(true);
      for (const gap of report.gaps) {
        if (Object.hasOwn(PLAN, gap.entranceId)) {
          throw new Error(
            `planned entrance leaked into gap list: ${gap.entranceId}`,
          );
        }
      }
    },
    240_000,
  );

  itDb(
    "覆盖报告产物（可选写出：MT_COVERAGE_REPORT_OUT 指定路径）",
    async () => {
      const out = process.env.MT_COVERAGE_REPORT_OUT?.trim();
      const report = await coverage();
      if (!out) return;
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
      expect(report.summary.coveredEntrances).toBe(Object.keys(PLAN).length);
    },
    240_000,
  );
});
