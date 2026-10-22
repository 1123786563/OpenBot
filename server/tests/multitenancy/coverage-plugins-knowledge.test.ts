// server/tests/multitenancy/coverage-plugins-knowledge.test.ts
// MT134（Issue #177）：覆盖证据——插件审批、知识与记忆。
//
// 用 MT132 身份矩阵 runner 为插件安装/卸载/调用、工具调用、共享审批与
// 个人记忆（写入/检索/候选来源）的逐入口正向与越权证据；检索候选范围
// 的证据在候选生成面（listMemorySources 的候选集本身不含无权资源——
// 不止结果过滤）。每条场景骑真实域夹具（MT031/MT032/MT034/MT039 的真实
// 服务 + 真实受限角色 + 真实 RLS）；覆盖状态在矩阵 runner 输出中标记为
// covered。夹具身份到 §11 矩阵类的等价在 ACTOR_CLASSES 表中逐条披露。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_
// DATABASE_URL）加三个受限角色 URL；缺配置时整套显式 skip（跳过原因写在
// 用例名里，skipped 不计为通过），绝不回退开发库。
//
// 证据可复现（票面 AC）：本套件即复现命令——
//   set +x; source /tmp/mt24-env.sh && bun --no-env-file test \
//     server/tests/multitenancy/coverage-plugins-knowledge.test.ts

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
import { isResourceNotFoundVerdict } from "../../src/enterprise/tenancy/not-found-semantics";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import {
  adapterFromScenarios,
  requireEntrance,
  type ScenarioMap,
} from "./support/coverage-matrix";
import {
  createPersonalMemoryFixture,
  type PersonalMemoryFixture,
} from "./support/personal-memory";
import type { IsolationObservation } from "./support/scenarios";
import { registerIsolationDomain } from "./support/scenarios";
import {
  createSharedApprovalsFixture,
  type SharedApprovalsFixture,
} from "./support/shared-approvals";
import { createToolFixture, type ToolFixture } from "./support/tool-invocation";

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
      reason: `MT134 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

/**
 * 夹具身份 → §11 矩阵类等价表（披露，非推导）。每个场景的真实 actor 在
 * 场景实现处注明；这里钉住等价关系，供计划声明与实现互相对账。
 */
const ACTOR_CLASSES = {
  "a1-owner": "company-a-team-a1-only",
  "a1-member": "company-a-team-a1-only",
  "a1-other": "same-team-other-person",
  "a2-member": "company-a-team-a2-only",
  "b1-member": "cross-company",
} as const;

let approvals: SharedApprovalsFixture;
let tools: ToolFixture;
let memory: PersonalMemoryFixture;
let companyA = "";
let companyB = "";
let teamA1 = "";
let teamB1 = "";
let botA1 = "";
let botB1 = "";
let installA1:
  | { installId: string; tenantId: string; workspaceId: string }
  | undefined;
let installB1:
  | { installId: string; tenantId: string; workspaceId: string }
  | undefined;
let catalogId = "";

const denyObservation = (
  denied: boolean,
  leaks: unknown[] = [],
): IsolationObservation => ({
  positiveControlPassed: false,
  denied,
  leakedRecords: leaks,
  forbiddenEffects: [],
});

// ---------------------------------------------------------------------------
// 场景（plugins-approvals 域）：插件安装/卸载/调用、工具调用、共享审批
// ---------------------------------------------------------------------------

const pluginsScenarios: ScenarioMap = {
  // POST /api/marketplace/skills/:slug/install —— 安装（真实 admin 服务；
  // 跨公司安装行被复合外键结构性拒绝）。
  "plugins.install.positive": async () => {
    const fact = await approvals.base.provisionInstall({
      identity: "a1-member",
      teamKey: "team-a1",
      catalogId,
      config: { region: "us" },
    });
    // 跨公司探针：B 的安装列表不含该安装（计数不泄露存在性）。
    const scopeB = await approvals.scopeAs("b1-member", companyB, teamB1);
    const leaked = (await approvals.base.decisions.listInstalls(scopeB)).filter(
      (row) => "installId" in row && row.installId === fact.installId,
    );
    return {
      positiveControlPassed: Boolean(fact.installId),
      denied: false,
      leakedRecords: leaked,
      forbiddenEffects: [],
    };
  },
  "plugins.install.denial": async () => {
    // 跨公司安装行结构性不可能：B 租户行 + A 公司主体被复合外键拒绝。
    const fact = approvals.base.base.teamOf("a1-member", "team-a1");
    let denied = false;
    let forbidden: unknown[] = [];
    try {
      await approvals.base.admin.install({
        tenantId: companyB,
        workspaceId: teamB1,
        installedBy: fact.principalId,
        catalogId,
        config: {},
      });
    } catch (error) {
      denied = /23503|PLUGIN_INSTALL|foreign key/i.test(
        error instanceof Error ? error.message : String(error),
      );
      if (!denied) forbidden = [String(error)];
    }
    return denyObservation(denied, forbidden);
  },

  // DELETE /api/marketplace/skills/:slug/install —— 卸载（只影响本范围）。
  "plugins.uninstall.positive": async () => {
    const target = await approvals.base.provisionInstall({
      identity: "a1-member",
      teamKey: "team-a1",
      catalogId,
      config: {},
    });
    const result = await approvals.base.admin.uninstall({
      tenantId: companyA,
      installId: target.installId,
    });
    return {
      positiveControlPassed: result.removed === true,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "plugins.uninstall.denial": async () => {
    const target = await approvals.base.provisionInstall({
      identity: "a1-member",
      teamKey: "team-a1",
      catalogId,
      config: {},
    });
    // 他司卸载 = removed:false 零效果；A 的安装原样可用。
    const result = await approvals.base.admin.uninstall({
      tenantId: companyB,
      installId: target.installId,
    });
    const scopeA = await approvals.scopeAs("a1-member", companyA, teamA1);
    const stillUsable = await approvals.base.decisions.authorizeInvoke(scopeA, {
      installId: target.installId,
    });
    const forbidden =
      result.removed === true
        ? [{ crossCompanyUninstall: target.installId }]
        : [];
    return denyObservation(
      result.removed === false && stillUsable.outcome === "allow",
      forbidden,
    );
  },

  // POST /api/plugins/call —— 业务调用判定（allow 独占触发供应商请求）。
  "plugins.invoke.positive": async () => {
    const scopeA = await approvals.scopeAs("a1-member", companyA, teamA1);
    const before = approvals.base.vendorProbe.calls();
    const resolution = await approvals.base.decisions.authorizeInvoke(scopeA, {
      installId: installA1?.installId ?? "",
    });
    const vendorCalled = approvals.base.vendorProbe.calls() === before + 1;
    return {
      positiveControlPassed: resolution.outcome === "allow" && vendorCalled,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "plugins.invoke.denial": async () => {
    // 他司安装 ID 调用被拒且不触发供应商请求（deny = canonical not-found）。
    const scopeB = await approvals.scopeAs("b1-member", companyB, teamB1);
    const before = approvals.base.vendorProbe.calls();
    const resolution = await approvals.base.decisions.authorizeInvoke(scopeB, {
      installId: installA1?.installId ?? "",
    });
    const vendorUntouched = approvals.base.vendorProbe.calls() === before;
    return denyObservation(
      isResourceNotFoundVerdict(resolution as object) && vendorUntouched,
    );
  },

  // POST /api/agent-tools/call —— 工具调用重验（连接与 Bot 授权）。
  "tools.call.positive": async () => {
    const agentId = `mt134-bot-${randomUUID().slice(0, 8)}`;
    const credentialId = `mt134-cred-${randomUUID().slice(0, 8)}`;
    const created = await tools.ownership.createBot(
      await tools.scopeAs("a1-owner", tools.companyA, tools.teamA1),
      { agentId, displayName: "MT134 tool bot", defaultConfig: {} },
    );
    if (created.outcome !== "allow") {
      return {
        positiveControlPassed: false,
        denied: false,
        leakedRecords: [{ created }],
        forbiddenEffects: [],
      };
    }
    await tools.seedConnection({
      tenantId: tools.companyA,
      ownerPrincipalId: tools.ids["principal-a1-owner"],
      credentialId,
    });
    const verdict = await tools.tools.authorizeToolInvocation(
      await tools.scopeAs("a1-owner", tools.companyA, tools.teamA1),
      { agentId, toolName: "web.search", credentialId },
    );
    return {
      positiveControlPassed: verdict.outcome === "allow",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "tools.call.denial": async () => {
    // 同团队他人不能用创建者的连接完成调用（含公共 Bot 场景的判定面）。
    const agentId = `mt134-bot-${randomUUID().slice(0, 8)}`;
    const credentialId = `mt134-cred-${randomUUID().slice(0, 8)}`;
    await tools.ownership.createBot(
      await tools.scopeAs("a1-owner", tools.companyA, tools.teamA1),
      { agentId, displayName: "MT134 tool bot deny", defaultConfig: {} },
    );
    await tools.seedConnection({
      tenantId: tools.companyA,
      ownerPrincipalId: tools.ids["principal-a1-owner"],
      credentialId,
    });
    const verdict = await tools.tools.authorizeToolInvocation(
      await tools.scopeAs("a1-other", tools.companyA, tools.teamA1),
      { agentId, toolName: "web.search", credentialId },
    );
    return denyObservation(verdict.outcome === "deny");
  },

  // POST /api/approvals/shared-use —— 共享使用申请。
  "approvals.request.positive": async () => {
    const requested = await approvals.approvals.request(
      await approvals.scopeAs("a1-member", companyA, teamA1),
      {
        agentId: botA1,
        installId: installA1?.installId ?? "",
        proposed: { audience: "team", outsideInput: false, members: [] },
        reason: "publish",
      },
    );
    return {
      positiveControlPassed: requested.outcome === "requested",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "approvals.request.denial": async () => {
    // 跨公司申请永远拒绝：B 的身份申请 A 的 Bot/安装 = canonical not-found。
    const verdict = await approvals.approvals.request(
      await approvals.scopeAs("b1-member", companyB, teamB1),
      {
        agentId: botA1,
        installId: installA1?.installId ?? "",
        proposed: { audience: "team", outsideInput: false, members: [] },
        reason: "publish",
      },
    );
    return denyObservation(isResourceNotFoundVerdict(verdict as object));
  },

  // POST /api/approvals/shared-use/:id/approve —— 批准（公司管理员）。
  "approvals.approve.positive": async () => {
    const requested = await approvals.approvals.request(
      await approvals.scopeAs("a1-member", companyA, teamA1),
      {
        agentId: botA1,
        installId: installA1?.installId ?? "",
        proposed: { audience: "team", outsideInput: false, members: [] },
        reason: "publish",
      },
    );
    if (requested.outcome !== "requested") {
      return {
        positiveControlPassed: false,
        denied: false,
        leakedRecords: [{ requested }],
        forbiddenEffects: [],
      };
    }
    const decided = await approvals.approvalAdmin.decide(
      await approvals.adminContextFor(companyA),
      { requestId: requested.requestId, decision: "approve" },
    );
    return {
      positiveControlPassed: decided.outcome === "approved",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "approvals.approve.denial": async () => {
    // 公司 B 内合法申请；公司 A 管理上下文对 B 的请求决定 = canonical 拒
    // （租户 pin 下不可见，MT034 AC3 同款判定面），行不被触碰。
    const requested = await approvals.approvals.request(
      await approvals.scopeAs("b1-member", companyB, teamB1),
      {
        agentId: botB1,
        installId: installB1?.installId ?? "",
        proposed: { audience: "team", outsideInput: false, members: [] },
        reason: "publish",
      },
    );
    if (requested.outcome !== "requested") {
      return denyObservation(false, [{ requested }]);
    }
    const decided = await approvals.approvalAdmin.decide(
      await approvals.adminContextFor(companyA),
      { requestId: requested.requestId, decision: "approve" },
    );
    const row = (await approvals.requestRows({ tenantId: companyB })).find(
      (entry) => entry.id === requested.requestId,
    );
    return denyObservation(
      isResourceNotFoundVerdict(decided as object) &&
        row?.status === "pending" &&
        row?.decidedBy === null,
    );
  },

  // POST /api/approvals/shared-use/:id/decline —— 拒绝（公司管理员）。
  "approvals.decline.positive": async () => {
    const requested = await approvals.approvals.request(
      await approvals.scopeAs("a1-member", companyA, teamA1),
      {
        agentId: botA1,
        installId: installA1?.installId ?? "",
        proposed: { audience: "team", outsideInput: false, members: [] },
        reason: "publish",
      },
    );
    if (requested.outcome !== "requested") {
      return {
        positiveControlPassed: false,
        denied: false,
        leakedRecords: [{ requested }],
        forbiddenEffects: [],
      };
    }
    const decided = await approvals.approvalAdmin.decide(
      await approvals.adminContextFor(companyA),
      { requestId: requested.requestId, decision: "decline" },
    );
    return {
      positiveControlPassed: decided.outcome === "declined",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "approvals.decline.denial": async () => {
    const requested = await approvals.approvals.request(
      await approvals.scopeAs("b1-member", companyB, teamB1),
      {
        agentId: botB1,
        installId: installB1?.installId ?? "",
        proposed: { audience: "team", outsideInput: false, members: [] },
        reason: "publish",
      },
    );
    if (requested.outcome !== "requested") {
      return denyObservation(false, [{ requested }]);
    }
    const decided = await approvals.approvalAdmin.decide(
      await approvals.adminContextFor(companyA),
      { requestId: requested.requestId, decision: "decline" },
    );
    return denyObservation(isResourceNotFoundVerdict(decided as object));
  },
};

// ---------------------------------------------------------------------------
// 场景（knowledge-memory 域）：个人记忆写入/检索 + 候选来源范围
// ---------------------------------------------------------------------------

/** 记忆夹具自己的公司/团队拓扑（各夹具宇宙独立，绝不跨夹具取 id）。 */
const memTopology = () => ({
  companyA: memory.base.isolation.ids["company-a"],
  companyB: memory.base.isolation.ids["company-b"],
  teamA1: memory.base.isolation.ids["team-a1"],
  teamA2: memory.base.isolation.ids["team-a2"],
  teamB1: memory.base.isolation.ids["team-b1"],
});
const memoryScenarios: ScenarioMap = {
  // POST /api/memory —— 写入个人记忆。
  "memory.write.positive": async () => {
    const topo = memTopology();
    const scope = await memory.scopeAs("a1-member", topo.companyA, topo.teamA1);
    const written = await memory.memory.writeMemory(scope, {
      memoryKey: `mt134-${randomUUID().slice(0, 8)}`,
      content: `mt134 secret ${randomUUID().slice(0, 8)}`,
    });
    return {
      positiveControlPassed: written.outcome === "allow",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "memory.write.denial": async () => {
    const topo = memTopology();
    // 跨公司身份对公司 A 团队的 scope 签发被资格门拒绝（TENANT_FORBIDDEN）。
    try {
      await memory.scopeAs("b1-member", topo.companyA, topo.teamA1);
      return denyObservation(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return denyObservation(/FORBIDDEN|REQUIRED/.test(message));
    }
  },

  // GET /api/memory —— 检索个人记忆（同团队他人与跨公司同形空页）。
  "memory.search.positive": async () => {
    const topo = memTopology();
    const secret = `mt134-secret-${randomUUID().slice(0, 8)}`;
    const scope = await memory.scopeAs("a1-member", topo.companyA, topo.teamA1);
    await memory.memory.writeMemory(scope, {
      memoryKey: `mt134-${randomUUID().slice(0, 8)}`,
      content: secret,
    });
    const hits = await memory.memory.searchMemories(scope, { query: secret });
    return {
      positiveControlPassed: hits.length === 1,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "memory.search.denial": async () => {
    const topo = memTopology();
    const secret = `mt134-secret-${randomUUID().slice(0, 8)}`;
    const owner = await memory.scopeAs("a1-member", topo.companyA, topo.teamA1);
    await memory.memory.writeMemory(owner, {
      memoryKey: `mt134-${randomUUID().slice(0, 8)}`,
      content: secret,
    });
    // 同团队另一人 + 跨公司：同内容查询全部空页（与"没有记忆"不可区分）。
    const otherHits = await memory.memory.searchMemories(
      await memory.scopeAs("a1-other", topo.companyA, topo.teamA1),
      { query: secret },
    );
    const crossHits = await memory.memory.searchMemories(
      await memory.scopeAs("b1-member", topo.companyB, topo.teamB1),
      { query: secret },
    );
    const leaked = [...otherHits, ...crossHits];
    return denyObservation(leaked.length === 0, leaked);
  },

  // GET /api/memory/sources/available/:botId —— 候选来源范围（候选面就不
  // 含无权资源——不止结果过滤）。
  "memory.sources.positive": async () => {
    const topo = memTopology();
    const publicKb = await memory.seedResource({
      tenantId: topo.companyA,
      workspaceId: topo.teamA1,
      kind: "knowledge_base",
      displayName: "MT134 public KB",
      visibility: "workspace",
    });
    const sources = await memory.memory.listMemorySources(
      await memory.scopeAs("a1-member", topo.companyA, topo.teamA1),
    );
    const ids = sources.map((row) => row.resourceId);
    return {
      positiveControlPassed: ids.includes(publicKb),
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "memory.sources.denial": async () => {
    const topo = memTopology();
    const publicKb = await memory.seedResource({
      tenantId: topo.companyA,
      workspaceId: topo.teamA1,
      kind: "knowledge_base",
      displayName: "MT134 public KB deny",
      visibility: "workspace",
    });
    const privateDoc = await memory.seedResource({
      tenantId: topo.companyA,
      workspaceId: topo.teamA1,
      kind: "document",
      displayName: "MT134 private doc",
    });
    // A2（同公司他团队）候选集不含 A1 的公共库；B（跨公司）一概不含；
    // A1 无授权成员的候选集不含私有文档（候选面即无权资源不进清单）。
    const a2Ids = (
      await memory.memory.listMemorySources(
        await memory.scopeAs("a2-member", topo.companyA, topo.teamA2),
      )
    ).map((row) => row.resourceId);
    const bIds = (
      await memory.memory.listMemorySources(
        await memory.scopeAs("b1-member", topo.companyB, topo.teamB1),
      )
    ).map((row) => row.resourceId);
    const a1Ids = (
      await memory.memory.listMemorySources(
        await memory.scopeAs("a1-member", topo.companyA, topo.teamA1),
      )
    ).map((row) => row.resourceId);
    const leaked = [publicKb, privateDoc].filter(
      (id) =>
        a2Ids.includes(id) || bIds.includes(id) || a1Ids.includes(privateDoc),
    );
    return denyObservation(leaked.length === 0, leaked);
  },
};

/** 入口 → 场景映射（每入口两侧都必须在位；identity 为 §11 矩阵声明）。 */
const PLAN: MatrixPlan = {
  "POST /api/marketplace/skills/:slug/install": {
    positive: {
      domain: "plugins-approvals",
      scenarioId: "plugins.install.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "plugins-approvals",
      scenarioId: "plugins.install.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "DELETE /api/marketplace/skills/:slug/install": {
    positive: {
      domain: "plugins-approvals",
      scenarioId: "plugins.uninstall.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "plugins-approvals",
      scenarioId: "plugins.uninstall.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/plugins/call": {
    positive: {
      domain: "plugins-approvals",
      scenarioId: "plugins.invoke.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "plugins-approvals",
      scenarioId: "plugins.invoke.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/agent-tools/call": {
    positive: {
      domain: "plugins-approvals",
      scenarioId: "tools.call.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "plugins-approvals",
      scenarioId: "tools.call.denial",
      identity: "a1-other",
      matrixClass: "same-team-other-person",
    },
  },
  "POST /api/approvals/shared-use": {
    positive: {
      domain: "plugins-approvals",
      scenarioId: "approvals.request.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "plugins-approvals",
      scenarioId: "approvals.request.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/approvals/shared-use/:id/approve": {
    positive: {
      domain: "plugins-approvals",
      scenarioId: "approvals.approve.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "plugins-approvals",
      scenarioId: "approvals.approve.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/approvals/shared-use/:id/decline": {
    positive: {
      domain: "plugins-approvals",
      scenarioId: "approvals.decline.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "plugins-approvals",
      scenarioId: "approvals.decline.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "GET /api/memory": {
    positive: {
      domain: "knowledge-memory",
      scenarioId: "memory.search.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "knowledge-memory",
      scenarioId: "memory.search.denial",
      identity: "a1-other",
      matrixClass: "same-team-other-person",
    },
  },
  "POST /api/memory": {
    positive: {
      domain: "knowledge-memory",
      scenarioId: "memory.write.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "knowledge-memory",
      scenarioId: "memory.write.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "GET /api/memory/sources/available/:botId": {
    positive: {
      domain: "knowledge-memory",
      scenarioId: "memory.sources.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "knowledge-memory",
      scenarioId: "memory.sources.denial",
      identity: "a2-member",
      matrixClass: "company-a-team-a2-only",
    },
  },
};

for (const entranceId of Object.keys(PLAN)) {
  requireEntrance(inventory, entranceId);
}

beforeAll(async () => {
  if (!ENV.ok) return;
  approvals = await createSharedApprovalsFixture();
  companyA = approvals.base.base.isolation.ids["company-a"];
  companyB = approvals.base.base.isolation.ids["company-b"];
  teamA1 = approvals.base.base.isolation.ids["team-a1"];
  teamB1 = approvals.base.base.isolation.ids["team-b1"];
  const cat = await approvals.base.seedCatalogEntry({
    catalogId: `cat-mcp-mt134-${randomUUID().slice(0, 8)}`,
    kind: "mcp",
    vendor: "github",
    source: "first-party",
    title: "GitHub MCP (MT134)",
    summary: "The catalog entry MT134 pins coverage to.",
  });
  catalogId = cat.catalogId;
  installA1 = await approvals.base.provisionInstall({
    identity: "a1-member",
    teamKey: "team-a1",
    catalogId,
    config: { region: "us" },
  });
  installB1 = await approvals.base.provisionInstall({
    identity: "b1-member",
    teamKey: "team-b1",
    catalogId,
    config: { region: "eu" },
  });
  // A1 的真实 Bot 归属行（真实 MT016 服务 + 真实 scope）。
  const created = await approvals.bots.createBot(
    await approvals.scopeAs("a1-member", companyA, teamA1),
    {
      agentId: `bot-mt134-${randomUUID()}`,
      displayName: "MT134 bot a1",
      defaultConfig: {},
    },
  );
  if (created.outcome !== "allow") {
    throw new Error(
      `MT134 arrangement createBot failed: ${JSON.stringify(created)}`,
    );
  }
  botA1 = created.bot.agentId;
  const createdB = await approvals.bots.createBot(
    await approvals.scopeAs("b1-member", companyB, teamB1),
    {
      agentId: `bot-mt134-${randomUUID()}`,
      displayName: "MT134 bot b1",
      defaultConfig: {},
    },
  );
  if (createdB.outcome !== "allow") {
    throw new Error(
      `MT134 arrangement createBot(B) failed: ${JSON.stringify(createdB)}`,
    );
  }
  botB1 = createdB.bot.agentId;
  tools = await createToolFixture();
  memory = await createPersonalMemoryFixture();
  registerIsolationDomain(
    "plugins-approvals",
    adapterFromScenarios(pluginsScenarios),
  );
  registerIsolationDomain(
    "knowledge-memory",
    adapterFromScenarios(memoryScenarios),
  );
}, 300000);

afterAll(async () => {
  if (memory) await memory.dispose();
  if (tools) await tools.dispose();
  if (approvals) await approvals.dispose();
}, 120000);

// ---------------------------------------------------------------------------

/** 一次矩阵运行，全部用例共享（场景与夹具在同一进程内只装配一次）。 */
let coveragePromise: Promise<ReturnType<typeof runMatrixCoverage>> | undefined;
const coverage = () =>
  (coveragePromise ??= runMatrixCoverage({
    environment: process.env,
    inventory,
    plan: PLAN,
    runId: "mt134",
  }));

describeDb("MT134 / Issue #177 — 覆盖证据：插件审批、知识与记忆", () => {
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
      // 覆盖状态机器可读：JSON 往返 + 矩阵类随报告走。
      expect(report.schemaVersion).toBe(1);
      expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();
      const classes = new Map(
        report.matrix.classes.map((entry) => [entry.id, entry]),
      );
      expect(
        classes.get("company-a-team-a1-only")?.entrancesCovered,
      ).toBeGreaterThan(0);
      expect(
        classes.get("same-team-other-person")?.entrancesCovered,
      ).toBeGreaterThan(0);
      expect(classes.get("cross-company")?.entrancesCovered).toBeGreaterThan(0);
      expect(
        classes.get("company-a-team-a2-only")?.entrancesCovered,
      ).toBeGreaterThan(0);
      // 整库覆盖不因本票完成（未映射入口保持诚实 uncovered）。
      expect(report.overall).toBe("coverage-incomplete");
    },
    300000,
  );

  itDb(
    "证据可复现：全程受限角色在场（决策路径不经过超级用户）",
    async () => {
      const calls = tools.restrictedCalls();
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.currentUser).toMatch(/^ob_ent_(data|operator|directory)$/);
      }
      // 记忆与审批夹具创建时已对活体目录核验过受限角色登录（capability
      // 形如 ob_ent_*；登录名不含连接串）。
      const roles = memory.base.isolation.restrictedRoles;
      for (const role of ["directory", "data", "operator"] as const) {
        expect(roles[role].capability).toMatch(/^ob_ent_/);
      }
    },
    60000,
  );

  itDb(
    "未映射的插件/审批/记忆闭环入口保留在缺口清单（漂移可见，不虚报覆盖）",
    async () => {
      const report = await coverage();
      const gapIds = new Set(report.gaps.map((gap) => gap.entranceId));
      // 本票未提供证据的入口保持 uncovered（例：组件调用、审批列表、
      // 记忆删除——见报告诚实边界）。
      expect(gapIds.has("POST /api/components/:name/call")).toBe(true);
      expect(gapIds.has("GET /api/approvals/shared-use")).toBe(true);
      expect(gapIds.has("DELETE /api/memory/:id")).toBe(true);
      for (const gap of report.gaps) {
        if (Object.hasOwn(PLAN, gap.entranceId)) {
          throw new Error(
            `planned entrance leaked into gap list: ${gap.entranceId}`,
          );
        }
      }
    },
    300000,
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
    300000,
  );
});
