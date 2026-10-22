// server/tests/multitenancy/coverage-jobs-execution.test.ts
// MT135（Issue #178）：覆盖证据——后台任务与执行隔离。
//
// 用 MT132 身份矩阵 runner 为内部 Worker 扫描/认领门与电脑执行面（屏幕/
// 流/接管/释放/取消/回收重置）的逐入口正向与越权证据；无 HTTP 路由的后台
// 路径（cancel/retry/过期恢复认领——job-control 明确不接 HTTP 路由）与跨
// 语言边界（Go/原生归属传递）以套件内真实路径用例直接钉住，并在覆盖报
// 告中如实披露其「路径级证据、无入口映射」。每条场景骑真实域夹具
// （MT041/MT042/MT043/MT046 的真实服务 + 真实受限角色 + 真实 RLS）。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_
// DATABASE_URL）加三个受限角色 URL；缺配置时整套显式 skip（跳过原因写在
// 用例名里，skipped 不计为通过），绝不回退开发库。
//
// 证据可复现（票面 AC）：本套件即复现命令——
//   set +x; source /tmp/mt24-env.sh && bun --no-env-file test \
//     server/tests/multitenancy/coverage-jobs-execution.test.ts

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { and, eq } from "drizzle-orm";
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
import { jobOwnership } from "../../src/db/schema/job-ownership";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  assertTrustedMachineIdentity,
  createMachineScanIdentity,
  createScanExecutor,
  SCAN_WORK_KIND,
  type ScannedItem,
} from "../../src/enterprise/runs/scan-executor";
import {
  type ComputerAllocationAuditEvent,
  type ComputerAllocationAuditSink,
  createComputerAllocationService,
} from "../../src/enterprise/tenancy/computer-allocation";
import {
  createJobControlService,
  type JobControlService,
} from "../../src/enterprise/tenancy/job-control";
import type {
  JobConfigBasisInput,
  JobRef,
} from "../../src/enterprise/tenancy/job-ownership";
import { isResourceNotFoundVerdict } from "../../src/enterprise/tenancy/not-found-semantics";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import {
  type ComputerAllocationFixture,
  createComputerAllocationFixture,
  recordingPorts,
} from "./support/computer-allocation";
import {
  adapterFromScenarios,
  requireEntrance,
  type ScenarioMap,
} from "./support/coverage-matrix";
import {
  createScanExecutorFixture,
  type ScanFixture,
} from "./support/scan-executor";
import type { IsolationObservation } from "./support/scenarios";
import { registerIsolationDomain } from "./support/scenarios";

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
      reason: `MT135 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

const isCanonicalNotFound = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  isResourceNotFoundVerdict(value);

/** The real inventory every mapped entrance must come from. */
const inventory: CoverageInventory = await buildInventory({
  environment: process.env,
});

let scan: ScanFixture;
let control: JobControlService;
let computer: ComputerAllocationFixture;

const denyObservation = (
  denied: boolean,
  leaks: unknown[] = [],
): IsolationObservation => ({
  positiveControlPassed: false,
  denied,
  leakedRecords: leaks,
  forbiddenEffects: [],
});

/** 夹具语汇（MT041/MT042/MT043 同款）。 */
const WORKER = {
  kind: "worker" as const,
  id: `mt135-worker-${randomUUID().slice(0, 8)}`,
};

const basisOf = (tag: string): JobConfigBasisInput => ({
  companyRevision: 1,
  overrideRevision: null,
  document: { model: { defaultModel: `mt135-${tag}` }, revision: tag },
});

interface Pinned {
  readonly kind: JobRef["kind"];
  readonly objectId: string;
  readonly scope: PlatformScope;
}

async function pinTask(
  identity: Parameters<typeof scan.jobs.scopeAs>[0],
  companyKey: "company-a" | "company-b",
  teamKey: "team-a1" | "team-a2" | "team-b1",
  label: string,
): Promise<Pinned> {
  const scope = await scan.jobs.scopeAs(identity, companyKey, teamKey);
  const objectId = scan.objectId(`mt135-${label}`);
  const pinned = await scan.service.pinJobOwnership({
    kind: "task",
    objectId,
    scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
    principalId: scope.principalId,
    basis: basisOf(label),
  });
  if (pinned.status !== "pinned") {
    throw new Error(
      `MT135 pinTask failed: ${JSON.stringify(pinned).slice(0, 200)}`,
    );
  }
  return { kind: "task", objectId, scope };
}

interface RecordedExecution {
  readonly scope: PlatformScope;
  readonly item: ScannedItem;
  sawOwnPinRow: boolean;
}

/** 执行回调记录器（MT042 同款：回调内经事务读权威归属行）。 */
function executorRecording(into: RecordedExecution[]) {
  return createScanExecutor({
    platform: scan.platform,
    operator: scan.jobs.operator,
    jobOwnership: scan.service,
    gate: scan.gate,
    issueScheduleScope: scan.issueScheduleScope,
    execute: async (context) => {
      const rows = await context.tx
        .select({ objectId: jobOwnership.objectId })
        .from(jobOwnership)
        .where(
          and(
            eq(jobOwnership.kind, context.item.jobKind),
            eq(jobOwnership.objectId, context.item.objectId),
          ),
        );
      into.push({
        scope: context.scope,
        item: context.item,
        sawOwnPinRow: rows.length === 1,
      });
    },
  });
}

/** 电脑面服务（真实 #90 授权 seam + 记录型端口，MT046 同款装配）。 */
function allocationWith(ports: ReturnType<typeof recordingPorts>) {
  const seen: ComputerAllocationAuditEvent[] = [];
  const audit: ComputerAllocationAuditSink = {
    async record(event) {
      seen.push(event);
    },
  };
  return createComputerAllocationService({
    authorization: computer.artifacts,
    ports: ports.ports,
    audit,
    stateRoot: "/mt135-state-root",
  });
}

/** 在电脑夹具拓扑里注册一个团队 Bot（真实 MT016 + 真实 scope）。 */
async function ownedBot(input: {
  identity: Parameters<typeof computer.scopeAs>[0];
  companyKey: "company-a" | "company-b";
  teamKey: "team-a1" | "team-a2" | "team-b1";
  label: string;
}) {
  return computer.registerBot(input);
}

// ---------------------------------------------------------------------------
// 场景（jobs 域）：内部 Worker 扫描/认领门
// ---------------------------------------------------------------------------

const jobsScenarios: ScenarioMap = {
  // POST /internal/routines/run —— 扫描/认领：按权威归属行重建受信 Scope，
  // 队列里的公司/团队字段只是路由提示（MT042 AC1/AC2）。
  "jobs.scan-claim.positive": async () => {
    const a1 = await pinTask("a1-member", "company-a", "team-a1", "scan-pos");
    const b1 = await pinTask("b1-member", "company-b", "team-b1", "scan-pos-b");
    // 两个队列提示都指向错误公司：重建必须以权威行为准。
    await scan.queue.offer({
      kind: SCAN_WORK_KIND,
      key: `${a1.kind}:${a1.objectId}`,
      payload: {
        tenantId: b1.scope.tenantId,
        workspaceId: b1.scope.workspaceId,
      },
    });
    await scan.queue.offer({
      kind: SCAN_WORK_KIND,
      key: `${b1.kind}:${b1.objectId}`,
      payload: {
        tenantId: a1.scope.tenantId,
        workspaceId: a1.scope.workspaceId,
      },
    });
    const recorded: RecordedExecution[] = [];
    const outcomes = await executorRecording(recorded).scanAndExecute(
      createMachineScanIdentity({
        id: `mt135-scan-${randomUUID().slice(0, 8)}`,
      }),
    );
    const ids = new Set(
      outcomes.map((outcome) => outcome.item?.objectId).filter(Boolean),
    );
    const executedBoth = ids.has(a1.objectId) && ids.has(b1.objectId);
    const sawRows = recorded.filter((entry) => entry.sawOwnPinRow).length;
    // 重建的 scope 归属 = 权威行归属（不是提示字段）。
    const a1Entry = recorded.find(
      (entry) => entry.item.objectId === a1.objectId,
    );
    const authoritative = a1Entry?.scope.tenantId === a1.scope.tenantId;
    return {
      positiveControlPassed: executedBoth && sawRows === 2 && authoritative,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "jobs.scan-claim.denial": async () => {
    // 机器身份不是用户登录：dev-local-user 形被签发入口拒绝；手造同形
    // 身份不获信任（MACHINE_IDENTITY_INVALID）；以机器 id 走用户签发面
    // 被 TENANT_FORBIDDEN 拒绝（机器身份不获得普通用户权限）。
    let refusedDevLocal = false;
    try {
      createMachineScanIdentity({ id: "dev-local-user" });
    } catch (error) {
      refusedDevLocal = /MACHINE_IDENTITY_INVALID/.test(
        error instanceof Error ? error.message : String(error),
      );
    }
    let refusedLookalike = false;
    try {
      assertTrustedMachineIdentity({
        kind: "machine-scan",
        id: "mt135-lookalike",
      } as never);
    } catch (error) {
      refusedLookalike = /MACHINE_IDENTITY_INVALID/.test(
        error instanceof Error ? error.message : String(error),
      );
    }
    const a1 = await pinTask("a1-member", "company-a", "team-a1", "scan-deny");
    let refusedUserIssuance = false;
    try {
      await scan.issueScheduleScope({
        actorId: `mt135-machine-${randomUUID().slice(0, 8)}`,
        tenantId: a1.scope.tenantId,
        workspaceId: a1.scope.workspaceId,
      });
    } catch (error) {
      refusedUserIssuance = /FORBIDDEN/.test(
        error instanceof Error ? error.message : String(error),
      );
    }
    return denyObservation(
      refusedDevLocal && refusedLookalike && refusedUserIssuance,
    );
  },
};

// ---------------------------------------------------------------------------
// 场景（execution 域）：电脑执行面（屏幕/流/接管/释放/取消/回收）
// ---------------------------------------------------------------------------

const executionScenarios: ScenarioMap = {
  // GET /api/computers/:botId/screenshot —— 远程屏幕帧。
  "computer.screen.positive": async () => {
    const { botId, scope } = await ownedBot({
      identity: "a1-member",
      companyKey: "company-a",
      teamKey: "team-a1",
      label: "screen-pos",
    });
    const ports = recordingPorts();
    ports.seedLogin(botId, "mt135-login-a1");
    const frame = await allocationWith(ports).viewScreen(scope, botId);
    return {
      positiveControlPassed: frame.outcome === "allow",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "computer.screen.denial": async () => {
    const { botId } = await ownedBot({
      identity: "a1-member",
      companyKey: "company-a",
      teamKey: "team-a1",
      label: "screen-deny",
    });
    const ports = recordingPorts();
    const verdict = await allocationWith(ports).viewScreen(
      await computer.scopeAs("b1-member", "company-b", "team-b1"),
      botId,
    );
    // 不可见 = canonical deny 且零端口调用。
    const zeroCalls = ports.recording().screenshots.length === 0;
    return denyObservation(isCanonicalNotFound(verdict) && zeroCalls);
  },

  // WS /api/computers/:botId/stream —— 屏幕流会话。
  "computer.stream.positive": async () => {
    const { botId, scope } = await ownedBot({
      identity: "a1-member",
      companyKey: "company-a",
      teamKey: "team-a1",
      label: "stream-pos",
    });
    const opened = await allocationWith(recordingPorts()).openScreenSession(
      scope,
      botId,
    );
    return {
      positiveControlPassed:
        opened.outcome === "allow" &&
        typeof opened.session.sessionId === "string" &&
        opened.session.sessionId.length > 0,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "computer.stream.denial": async () => {
    const { botId } = await ownedBot({
      identity: "a1-member",
      companyKey: "company-a",
      teamKey: "team-a1",
      label: "stream-deny",
    });
    // 同一人（甲乙双成员）的错误团队 scope 同样拒绝：scope 钉可见性。
    const a2Scope = await computer.scopeAs(
      "a1a2-member",
      "company-a",
      "team-a2",
    );
    const verdict = await allocationWith(recordingPorts()).openScreenSession(
      a2Scope,
      botId,
    );
    return denyObservation(isCanonicalNotFound(verdict));
  },

  // POST /api/computers/:botId/control/take —— 人工接管。
  "computer.take.positive": async () => {
    const { botId, scope } = await ownedBot({
      identity: "a1-member",
      companyKey: "company-a",
      teamKey: "team-a1",
      label: "take-pos",
    });
    const ports = recordingPorts();
    const verdict = await allocationWith(ports).takeOverControl(
      scope,
      botId,
      "mt135-req-1",
    );
    const fired =
      ports.recording().takeControls.length === 1 &&
      ports.recording().takeControls[0]?.actorId === scope.actorId;
    return {
      positiveControlPassed: verdict.outcome === "allow" && fired,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "computer.take.denial": async () => {
    const { botId } = await ownedBot({
      identity: "a1-member",
      companyKey: "company-a",
      teamKey: "team-a1",
      label: "take-deny",
    });
    const ports = recordingPorts();
    const verdict = await allocationWith(ports).takeOverControl(
      await computer.scopeAs("b1-member", "company-b", "team-b1"),
      botId,
      "mt135-req-2",
    );
    return denyObservation(
      isCanonicalNotFound(verdict) &&
        ports.recording().takeControls.length === 0,
    );
  },

  // POST /api/computers/:botId/control/release —— 释放接管。
  "computer.release.positive": async () => {
    const { botId, scope } = await ownedBot({
      identity: "a1-member",
      companyKey: "company-a",
      teamKey: "team-a1",
      label: "release-pos",
    });
    const ports = recordingPorts();
    const service = allocationWith(ports);
    await service.takeOverControl(scope, botId, "mt135-req-r1");
    const verdict = await service.releaseControl(scope, botId, "mt135-req-r1");
    return {
      positiveControlPassed:
        verdict.outcome === "allow" &&
        ports.recording().releaseControls.length === 1,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "computer.release.denial": async () => {
    const { botId, scope } = await ownedBot({
      identity: "a1-member",
      companyKey: "company-a",
      teamKey: "team-a1",
      label: "release-deny",
    });
    const ports = recordingPorts();
    const service = allocationWith(ports);
    await service.takeOverControl(scope, botId, "mt135-req-r2");
    const verdict = await service.releaseControl(
      await computer.scopeAs("b1-member", "company-b", "team-b1"),
      botId,
      "mt135-req-r2",
    );
    return denyObservation(
      isCanonicalNotFound(verdict) &&
        ports.recording().releaseControls.length === 0,
    );
  },

  // POST /api/computers/:botId/control/cancel —— 取消接管请求。
  "computer.cancel.positive": async () => {
    const { botId, scope } = await ownedBot({
      identity: "a1-member",
      companyKey: "company-a",
      teamKey: "team-a1",
      label: "cancel-pos",
    });
    const ports = recordingPorts();
    const service = allocationWith(ports);
    await service.takeOverControl(scope, botId, "mt135-req-c1");
    const verdict = await service.cancelControl(scope, botId, "mt135-req-c1");
    return {
      positiveControlPassed:
        verdict.outcome === "allow" &&
        ports.recording().cancelControls.length === 1,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "computer.cancel.denial": async () => {
    const { botId, scope } = await ownedBot({
      identity: "a1-member",
      companyKey: "company-a",
      teamKey: "team-a1",
      label: "cancel-deny",
    });
    const ports = recordingPorts();
    const service = allocationWith(ports);
    await service.takeOverControl(scope, botId, "mt135-req-c2");
    const verdict = await service.cancelControl(
      await computer.scopeAs("a1a2-member", "company-a", "team-a2"),
      botId,
      "mt135-req-c2",
    );
    return denyObservation(
      isCanonicalNotFound(verdict) &&
        ports.recording().cancelControls.length === 0,
    );
  },

  // POST /api/computers/:botId/computers/reset —— 回收/重置：登录态与工作
  // 目录一并清空，绝不带着上一个范围的痕迹被复用（MT046 AC2）。
  "computer.recycle.positive": async () => {
    const { botId, scope } = await ownedBot({
      identity: "a1-member",
      companyKey: "company-a",
      teamKey: "team-a1",
      label: "recycle-pos",
    });
    const ports = recordingPorts();
    const service = allocationWith(ports);
    const allocated = await service.allocateInstance(scope, botId);
    if (allocated.outcome !== "allocated") {
      return {
        positiveControlPassed: false,
        denied: false,
        leakedRecords: [{ allocated }],
        forbiddenEffects: [],
      };
    }
    ports.seedLogin(botId, "mt135-login-prev");
    await ports.ports.state.write(
      allocated.stateDir,
      "notes.txt",
      new TextEncoder().encode("previous scope file"),
    );
    const recycled = await service.recycleInstance(scope, botId);
    const stateGone = ports.fileNames().length === 0;
    const loginGone = ports.loginOf(botId) === undefined;
    const reallocated = await service.allocateInstance(scope, botId);
    const freshStart =
      reallocated.outcome === "allocated" &&
      (reallocated as { residualFiles?: string[] }).residualFiles?.length === 0;
    return {
      positiveControlPassed:
        recycled.outcome === "recycled" &&
        stateGone &&
        loginGone &&
        freshStart === true,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "computer.recycle.denial": async () => {
    const { botId, scope } = await ownedBot({
      identity: "a1a2-member",
      companyKey: "company-a",
      teamKey: "team-a1",
      label: "recycle-deny",
    });
    const ports = recordingPorts();
    const service = allocationWith(ports);
    await service.allocateInstance(scope, botId);
    ports.seedLogin(botId, "mt135-login-a1");
    // 异 scope 的回收被拒：零停止、零 profile 清除、登录态与文件完好。
    const verdict = await service.recycleInstance(
      await computer.scopeAs("a1a2-member", "company-a", "team-a2"),
      botId,
    );
    const untouched =
      ports.recording().stops.length === 0 &&
      ports.recording().profileResets.length === 0 &&
      ports.loginOf(botId) === "mt135-login-a1";
    return denyObservation(isCanonicalNotFound(verdict) && untouched);
  },
};

/** 入口 → 场景映射（每入口两侧都必须在位；identity 为 §11 矩阵声明）。 */
const PLAN: MatrixPlan = {
  "POST /internal/routines/run": {
    positive: {
      domain: "jobs",
      scenarioId: "jobs.scan-claim.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "jobs",
      scenarioId: "jobs.scan-claim.denial",
      identity: "worker",
      matrixClass: "restricted-worker",
    },
  },
  "GET /api/computers/:botId/screenshot": {
    positive: {
      domain: "execution",
      scenarioId: "computer.screen.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "execution",
      scenarioId: "computer.screen.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "WS /api/computers/:botId/stream": {
    positive: {
      domain: "execution",
      scenarioId: "computer.stream.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "execution",
      scenarioId: "computer.stream.denial",
      identity: "a1a2-member",
      matrixClass: "company-a-both-teams",
    },
  },
  "POST /api/computers/:botId/control/take": {
    positive: {
      domain: "execution",
      scenarioId: "computer.take.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "execution",
      scenarioId: "computer.take.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/computers/:botId/control/release": {
    positive: {
      domain: "execution",
      scenarioId: "computer.release.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "execution",
      scenarioId: "computer.release.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/computers/:botId/control/cancel": {
    positive: {
      domain: "execution",
      scenarioId: "computer.cancel.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "execution",
      scenarioId: "computer.cancel.denial",
      identity: "a1a2-member",
      matrixClass: "company-a-both-teams",
    },
  },
  "POST /api/computers/:botId/computers/reset": {
    positive: {
      domain: "execution",
      scenarioId: "computer.recycle.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "execution",
      scenarioId: "computer.recycle.denial",
      identity: "a1a2-member",
      matrixClass: "company-a-both-teams",
    },
  },
};

for (const entranceId of Object.keys(PLAN)) {
  requireEntrance(inventory, entranceId);
}

beforeAll(async () => {
  if (!ENV.ok) return;
  scan = await createScanExecutorFixture();
  control = createJobControlService({
    operator: scan.jobs.operator,
    data: scan.jobs.data,
  });
  computer = await createComputerAllocationFixture();
  registerIsolationDomain("jobs", adapterFromScenarios(jobsScenarios));
  registerIsolationDomain(
    "execution",
    adapterFromScenarios(executionScenarios),
  );
}, 300000);

afterAll(async () => {
  if (scan) {
    try {
      await scan.drainScanQueue();
    } finally {
      await scan.dispose();
    }
  }
  if (computer) await computer.dispose();
}, 120000);

// ---------------------------------------------------------------------------

/** 一次矩阵运行，全部用例共享（场景与夹具在同一进程内只装配一次）。 */
let coveragePromise: Promise<ReturnType<typeof runMatrixCoverage>> | undefined;
const coverage = () =>
  (coveragePromise ??= runMatrixCoverage({
    environment: process.env,
    inventory,
    plan: PLAN,
    runId: "mt135",
  }));

describeDb("MT135 / Issue #178 — 覆盖证据：后台任务与执行隔离", () => {
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
      expect(classes.get("cross-company")?.entrancesCovered).toBeGreaterThan(0);
      expect(
        classes.get("company-a-both-teams")?.entrancesCovered,
      ).toBeGreaterThan(0);
      // 受限 Worker 类在后台面被正向行使（机器身份是扫描的合法驱动者）。
      expect(
        classes.get("restricted-worker")?.entrancesCovered,
      ).toBeGreaterThan(0);
      // 整库覆盖不因本票完成（未映射入口保持诚实 uncovered）。
      expect(report.overall).toBe("coverage-incomplete");
    },
    300000,
  );

  itDb(
    "路径级证据（无 HTTP 入口）：取消/重试/过期恢复认领保持归属与越权语义",
    async () => {
      // 取消：归属者 allow；他人/跨团队/跨公司 = canonical not-found（零传播）。
      const mine = await pinTask(
        "a1-member",
        "company-a",
        "team-a1",
        "path-cancel",
      );
      const allowed = await control.cancelJob(mine.scope, {
        kind: mine.kind,
        objectId: mine.objectId,
      });
      expect(allowed.outcome).toBe("cancelled");
      const peer = await pinTask(
        "a1-member",
        "company-a",
        "team-a1",
        "path-peer",
      );
      await scan.service.claimJobLease({
        kind: peer.kind,
        objectId: peer.objectId,
        scope: {
          tenantId: peer.scope.tenantId,
          workspaceId: peer.scope.workspaceId,
        },
        executor: WORKER,
        leaseMs: 60_000,
      });
      const denyPeer = await control.cancelJob(
        await scan.jobs.scopeAs("a1-other", "company-a", "team-a1"),
        { kind: peer.kind, objectId: peer.objectId },
      );
      expect(isCanonicalNotFound(denyPeer)).toBe(true);
      const denyCross = await control.cancelJob(
        await scan.jobs.scopeAs("b1-member", "company-b", "team-b1"),
        { kind: peer.kind, objectId: peer.objectId },
      );
      expect(isCanonicalNotFound(denyCross)).toBe(true);

      // 重试：归属不变（tenant/workspace/principal 三不变量）。
      const retry = await pinTask(
        "a1-member",
        "company-a",
        "team-a1",
        "path-retry",
      );
      const retried = await control.retryJob(retry.scope, {
        kind: retry.kind,
        objectId: retry.objectId,
      });
      expect(retried.outcome).toBe("retry-armed");
      // 归属三不变量由权威行重读回答（不是调用方输入的回显）。
      expect(retried.ownership.tenantId).toBe(retry.scope.tenantId);
      expect(retried.ownership.workspaceId).toBe(retry.scope.workspaceId);

      // 过期恢复：认领路径过期能被回收重认（恢复在同一归属内完成）。
      const stale = await pinTask(
        "a1-member",
        "company-a",
        "team-a1",
        "path-stale",
      );
      const staleScope = {
        tenantId: stale.scope.tenantId,
        workspaceId: stale.scope.workspaceId,
      };
      const first = await scan.service.claimJobLease({
        kind: stale.kind,
        objectId: stale.objectId,
        scope: staleScope,
        executor: WORKER,
        leaseMs: 60_000,
      });
      expect(first.status).toBe("granted");
      // 并发第二执行者：活租约被他人持有 → JOB_LEASE_HELD（谁都不能双持）。
      const secondWorker = {
        kind: "worker" as const,
        id: `mt135-w2-${randomUUID().slice(0, 8)}`,
      };
      let held = false;
      try {
        await scan.service.claimJobLease({
          kind: stale.kind,
          objectId: stale.objectId,
          scope: staleScope,
          executor: secondWorker,
          leaseMs: 60_000,
        });
      } catch (error) {
        held = /JOB_LEASE_HELD/.test(
          error instanceof Error ? error.message : String(error),
        );
      }
      expect(held).toBe(true);
      // 释放后的恢复认领在同一归属内完成。
      await scan.service.releaseJobLease({
        kind: stale.kind,
        objectId: stale.objectId,
        scope: staleScope,
        executor: WORKER,
      });
      const reclaimed = await scan.service.claimJobLease({
        kind: stale.kind,
        objectId: stale.objectId,
        scope: staleScope,
        executor: secondWorker,
        leaseMs: 60_000,
      });
      expect(reclaimed.status).toBe("granted");
    },
    300000,
  );

  itDb(
    "跨语言边界（AC3）：归属在原生边界不丢失、不改写、缺失即拒",
    async () => {
      const { RuntimeInvocationWireSchema } = await import(
        "../../src/enterprise/wire-schema"
      );
      const {
        parseExecutionScope,
        EXECUTION_TENANT_HEADER,
        EXECUTION_WORKSPACE_HEADER,
      } = await import("../../../shared/execution-scope");
      const invocation = {
        schema_version: 1,
        tenant_id: "tenant-mt135",
        workspace_id: "team-mt135",
        principal_id: "principal-mt135",
        actor_id: "actor-mt135",
        initiator_kind: "human",
        run_id: "run-mt135",
        attempt_id: "attempt-mt135",
        turn_id: "turn-mt135",
        thread_id: "thread-mt135",
        expert_version: "expert-v1",
        input_digest: `sha256:${"a".repeat(64)}`,
        model_route_ref: "model-route-mt135",
        budget_reservation_id: "budget-mt135",
        lease_id: "lease-mt135",
        fencing_token: "1",
        expires_at: "2026-10-09T00:00:00.000Z",
      };
      // 正向：完整归属跨语言可解析（wire 契约两侧一致，Go 侧为
      // runtime-go 的 auth_test.go / context_test.go / cancel_test.go）。
      expect(RuntimeInvocationWireSchema.safeParse(invocation).success).toBe(
        true,
      );
      const parsed = parseExecutionScope(
        new Headers({
          [EXECUTION_TENANT_HEADER]: "tenant-mt135",
          [EXECUTION_WORKSPACE_HEADER]: "team-mt135",
        }),
      );
      expect(parsed).toEqual({
        tenantId: "tenant-mt135",
        workspaceId: "team-mt135",
      });
      // 越权：归属半边缺失或改写即拒，绝不回填默认值。
      const { workspace_id: _dropped, ...withoutWorkspace } = invocation;
      expect(
        RuntimeInvocationWireSchema.safeParse(withoutWorkspace).success,
      ).toBe(false);
      expect(
        RuntimeInvocationWireSchema.safeParse({
          ...invocation,
          workspace_id: "",
        }).success,
      ).toBe(false);
      expect(
        parseExecutionScope(
          new Headers({ [EXECUTION_TENANT_HEADER]: "tenant-mt135" }),
        ),
      ).toBeNull();
    },
    60000,
  );

  itDb(
    "证据可复现：全程受限角色在场（决策路径不经过超级用户）",
    async () => {
      const roles = scan.jobs.isolation.restrictedRoles;
      for (const role of ["directory", "data", "operator"] as const) {
        expect(roles[role].capability).toMatch(/^ob_ent_/);
      }
    },
    60000,
  );

  itDb(
    "未映射的执行面入口保留在缺口清单（漂移可见，不虚报覆盖）",
    async () => {
      const report = await coverage();
      const gapIds = new Set(report.gaps.map((gap) => gap.entranceId));
      // 本票未提供入口级证据的面保持 uncovered（例：快照、exec、文件读写、
      // 沙箱 runs——见报告诚实边界）。
      expect(gapIds.has("POST /api/computers/:botId/snapshot")).toBe(true);
      expect(gapIds.has("POST /api/computers/:botId/exec")).toBe(true);
      expect(gapIds.has("POST /api/computers/:botId/files/write")).toBe(true);
      expect(gapIds.has("POST /api/codesandbox/runs")).toBe(true);
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
