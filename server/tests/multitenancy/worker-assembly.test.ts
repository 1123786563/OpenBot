// server/tests/multitenancy/worker-assembly.test.ts
// MT130（Issue #173）：Worker 与后台装配去默认公司。
//
// 验收事实源（Issue #173 验收 1–4，逐条对应 describe）：
//   (1) Worker 启动不装配默认公司/团队；缺失归属的任务被隔离而非以默认
//       身份执行——就绪判定 + 执行通道的 isolated 改判（真实扫描执行器上：
//       删掉归属行 → isolated + 执行回调零调用 + 隔离缝收到事实）。
//   (2) 每项执行重建作用域并校验资格（复用扫描侧规则）——Lane 的唯一执行
//       引擎是 MT042 createScanExecutor（真实重建/租约/gate 事务）。
//   (3) 机器身份不能读取任意公司业务数据（越权测试）——签发入口/信任面/
//       Scope 注册表三向类型隔离 + 越权读取尝试拒绝。
//   (4) 后台程序的配置解析按记录归属，不读全局可变状态——真实 MT122 内部
//       半边 + MT014 配置：两公司各归各、缺配置行拒绝（无全局回退）、缺
//       归属记录拒绝。
//
// 环境契约：纯函数半边内存注入；DB 半边专用企业库（scan-executor 夹具 +
// entry-context 夹具，全部真实受限通道），缺显式 env 整套显式 skip，绝不
// 回退开发库，skipped 不计通过。

import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { jobOwnership } from "../../src/db/schema/job-ownership";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  createScanExecutor,
  createMachineScanIdentity as issueMachineIdentity,
  MACHINE_IDENTITY_INVALID,
  SCAN_RECORD_MISSING,
  type ScanExecutor,
} from "../../src/enterprise/runs/scan-executor";
import { createDeploymentEntryContextFactory } from "../../src/enterprise/tenancy/entry-context";
import { resolveStartupDefaults } from "../../src/enterprise/tenancy/startup-defaults";
import { assertTrustedScope } from "../../src/enterprise/tenancy/store";
import {
  BG_CONFIG_RECORD_UNATTRIBUTED,
  createWorkerExecutionLane,
  evaluateWorkerAssemblyReadiness,
  resolveBackgroundRuntimeConfig,
  type WorkerIsolationFact,
  workerAssemblyDefaults,
} from "../../src/enterprise/tenancy/worker-assembly";
import {
  createEntryContextFixture,
  type EntryContextFixture,
} from "./support/entry-context";
import {
  createScanExecutorFixture,
  type ScanFixture,
} from "./support/scan-executor";

// ---------------------------------------------------------------------------
// 环境探针（缺 env 整套显式 skip，绝不回退开发库）
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
      reason: `MT130 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  return { ok: true };
}

const ENV = probeEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

// ---------------------------------------------------------------------------
// AC1 前半（纯函数）：Worker 启动就绪——无默认公司/团队，机器执行身份
// ---------------------------------------------------------------------------

describe("MT130 Worker 启动就绪：无默认公司/团队（纯函数半边）", () => {
  const multitenancyDefaults = resolveStartupDefaults({
    multitenancy: true,
    deploymentId: "deployment-named",
    tenantPackageTenantId: "tenant-package-company",
    singleUser: false,
    entryContextWired: true,
  });
  const machine = issueMachineIdentity({ id: "mt130-worker-1" });

  test("净化域正常输出：多租户 Worker 装配就绪，保留状态再断言无默认公司", () => {
    const readiness = evaluateWorkerAssemblyReadiness({
      multitenancy: true,
      defaults: multitenancyDefaults,
      machineIdentity: machine,
    });
    expect(readiness.ok).toBe(true);
    const kept = workerAssemblyDefaults(multitenancyDefaults);
    expect(kept.defaultCompanyTenantId).toBeNull();
    expect(kept.devBypassMounted).toBe(false);
    expect(kept.threadIdentitySeed).toBe("deployment-named");
  });

  test("装配事实回退出默认公司（净化域被绕过的形状）→ 就绪失败并列出缺口源", () => {
    const drifty = resolveStartupDefaults({
      multitenancy: false,
      tenantPackageTenantId: "tenant-package-company",
      singleUser: false,
      entryContextWired: true,
    });
    // 单租户解析输出被误喂给多租户 Worker：defaultCompanyTenantId 非空。
    const readiness = evaluateWorkerAssemblyReadiness({
      multitenancy: true,
      defaults: drifty,
      machineIdentity: machine,
    });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      const sources = readiness.findings.map((finding) => finding.source);
      expect(sources).toContain("defaults.defaultCompanyTenantId");
    }
  });

  test("未签发机器身份（手造同形对象 / JSON 往返）→ 就绪失败点名 machineIdentity", () => {
    const handMade = {
      kind: "machine-scan",
      id: "mt130-worker-1",
    } as ReturnType<typeof issueMachineIdentity>;
    const roundTripped = JSON.parse(JSON.stringify(machine)) as ReturnType<
      typeof issueMachineIdentity
    >;
    for (const identity of [handMade, roundTripped]) {
      const readiness = evaluateWorkerAssemblyReadiness({
        multitenancy: true,
        defaults: multitenancyDefaults,
        machineIdentity: identity,
      });
      expect(readiness.ok).toBe(false);
      if (!readiness.ok) {
        expect(readiness.findings[0]?.source).toBe("machineIdentity");
      }
    }
  });

  test("单租户模式无就绪诉求（MT123 同款：legacy 启动原样）", () => {
    const singleTenant = resolveStartupDefaults({
      multitenancy: false,
      tenantPackageTenantId: "tenant-package-company",
      singleUser: true,
      entryContextWired: true,
    });
    expect(
      evaluateWorkerAssemblyReadiness({
        multitenancy: false,
        defaults: singleTenant,
        machineIdentity: machine,
      }).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC1 后半 + AC2 + AC3（执行通道）：真实扫描执行器上的隔离与重建
// ---------------------------------------------------------------------------

let scanFixture: ScanFixture;

beforeAll(async () => {
  if (!ENV.ok) return;
  scanFixture = await createScanExecutorFixture();
  await scanFixture.drainScanQueue();
}, 60000);

afterAll(async () => {
  await scanFixture?.dispose();
});

describeDb("MT130 执行通道：隔离而非默认身份执行（真实库）", () => {
  /** 真实执行器（MT042 全套规则）+ 记录执行回调。 */
  function realExecutor(
    executed: { objectId: string; scope: PlatformScope }[],
  ): ScanExecutor {
    return createScanExecutor({
      platform: scanFixture.platform,
      operator: scanFixture.jobs.operator,
      jobOwnership: scanFixture.service,
      gate: scanFixture.gate,
      issueScheduleScope: scanFixture.issueScheduleScope,
      execute: async (context) => {
        executed.push({
          objectId: context.item.objectId,
          scope: context.scope,
        });
      },
    });
  }

  itDb(
    "AC2: 归属在册的任务按权威记录重建作用域执行（Lane 只包不换——执行回调见到的是真实受信 Scope）",
    async () => {
      const scope = await scanFixture.jobs.scopeAs(
        "a1-member",
        "company-a",
        "team-a1",
      );
      const objectId = scanFixture.objectId("mt130-exec-ok");
      await scanFixture.service.pinJobOwnership({
        kind: "task",
        objectId,
        scope: {
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
        },
        principalId: scope.principalId,
        basis: {
          companyRevision: 1,
          overrideRevision: null,
          document: { model: { defaultModel: "mt130" }, revision: "r1" },
        },
      });
      await scanFixture.queue.offer({
        kind: "enterprise.job.due",
        key: `task:${objectId}`,
      });
      const executed: { objectId: string; scope: PlatformScope }[] = [];
      const lane = createWorkerExecutionLane({
        scanExecutor: realExecutor(executed),
      });
      const outcomes = await lane.runDue(
        issueMachineIdentity({ id: "mt130-lane-1" }),
      );
      const mine = outcomes.filter(
        (outcome) => outcome.item?.objectId === objectId,
      );
      expect(mine.map((outcome) => outcome.status)).toEqual(["executed"]);
      expect(executed).toHaveLength(1);
      // 重建出的受信 Scope：真实签发入口产物（MT005 注册表在册）。
      expect(() => assertTrustedScope(executed[0].scope)).not.toThrow();
      expect(executed[0].scope.tenantId).toBe(scope.tenantId);
    },
  );

  itDb(
    "AC1: 缺失归属的任务被隔离而非以默认身份执行——执行回调零调用，隔离缝收到事实",
    async () => {
      // 一个没有任何 job_ownership 权威行的到期条目：队列里有活、归属缺失。
      const objectId = scanFixture.objectId("mt130-orphan");
      await scanFixture.queue.offer({
        kind: "enterprise.job.due",
        key: `task:${objectId}`,
      });
      const executed: { objectId: string; scope: PlatformScope }[] = [];
      const isolated: WorkerIsolationFact[] = [];
      const lane = createWorkerExecutionLane({
        scanExecutor: realExecutor(executed),
        onIsolated: (fact) => isolated.push(fact),
      });
      const outcomes = await lane.runDue(
        issueMachineIdentity({ id: "mt130-lane-2" }),
      );
      const mine = outcomes.filter(
        (outcome) => outcome.item?.objectId === objectId,
      );
      expect(mine.map((outcome) => outcome.status)).toEqual(["isolated"]);
      if (mine[0]?.status === "isolated") {
        expect(mine[0].code).toBe(SCAN_RECORD_MISSING);
      }
      // 隔离不是执行：该条目从未进入执行回调，也没有任何默认身份兜底。
      expect(executed.filter((row) => row.objectId === objectId)).toEqual([]);
      // 隔离事实交缝：确定性码 + 条目 + 时间戳。
      expect(isolated.length).toBe(1);
      expect(isolated[0]?.code).toBe(SCAN_RECORD_MISSING);
      expect(isolated[0]?.item?.objectId).toBe(objectId);
      expect(typeof isolated[0]?.isolatedAt).toBe("string");
    },
  );

  itDb(
    "AC1: 在册任务的归属行在执行前被撤销（删权威行）→ 到期改判 isolated，仍不执行",
    async () => {
      const scope = await scanFixture.jobs.scopeAs(
        "b1-member",
        "company-b",
        "team-b1",
      );
      const objectId = scanFixture.objectId("mt130-revoked");
      await scanFixture.service.pinJobOwnership({
        kind: "task",
        objectId,
        scope: {
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
        },
        principalId: scope.principalId,
        basis: {
          companyRevision: 1,
          overrideRevision: null,
          document: { model: { defaultModel: "mt130" }, revision: "r1" },
        },
      });
      await scanFixture.queue.offer({
        kind: "enterprise.job.due",
        key: `task:${objectId}`,
      });
      // 撤销归属：权威行删除发生在到期条目认领之前（在册→缺失的中间态）。
      await scanFixture.platform
        .delete(jobOwnership)
        .where(eq(jobOwnership.objectId, objectId));

      const executed: { objectId: string; scope: PlatformScope }[] = [];
      const isolated: WorkerIsolationFact[] = [];
      const outcomes = await createWorkerExecutionLane({
        scanExecutor: realExecutor(executed),
        onIsolated: (fact) => isolated.push(fact),
      }).runDue(issueMachineIdentity({ id: "mt130-lane-3" }));
      const mine = outcomes.filter(
        (outcome) => outcome.item?.objectId === objectId,
      );
      expect(mine.map((outcome) => outcome.status)).toEqual(["isolated"]);
      // 从未执行：撤销归属不是默认身份的入场券。
      expect(executed).toEqual([]);
      expect(isolated[0]?.item?.objectId).toBe(objectId);
      expect(isolated[0]?.code).toBe(SCAN_RECORD_MISSING);
    },
  );

  itDb(
    "AC3: 机器身份不能读取任意公司业务数据——手造/往返身份被 Lane 入口拒绝；机器身份进不了 Scope 注册表",
    async () => {
      const lane = createWorkerExecutionLane({
        scanExecutor: realExecutor([]),
      });
      const handMade = {
        kind: "machine-scan",
        id: "mt130-forged",
      } as ReturnType<typeof issueMachineIdentity>;
      await expect(lane.runDue(handMade)).rejects.toThrow(
        MACHINE_IDENTITY_INVALID,
      );
      const roundTripped = JSON.parse(
        JSON.stringify(issueMachineIdentity({ id: "mt130-worker-x" })),
      ) as ReturnType<typeof issueMachineIdentity>;
      await expect(lane.runDue(roundTripped)).rejects.toThrow(
        MACHINE_IDENTITY_INVALID,
      );
      // 用户形 id 在签发入口就死掉（AC3 的「不获得普通用户权限」半边）。
      expect(() => issueMachineIdentity({ id: "dev-local-user" })).toThrow();
      // 机器身份对象不是 PlatformScope：信任注册表拒绝（业务读取只认受信
      // Scope——机器身份结构上进不了任何 gate 事务）。
      const machine = issueMachineIdentity({ id: "mt130-worker-y" });
      expect(() =>
        assertTrustedScope(machine as unknown as PlatformScope),
      ).toThrow("UNVERIFIED_SCOPE");
    },
  );
});

// ---------------------------------------------------------------------------
// AC4：后台程序配置解析按记录归属（真实 MT122 内部半边 + MT014 配置）
// ---------------------------------------------------------------------------

let entryFixture: EntryContextFixture;
let entryFactory: ReturnType<typeof createDeploymentEntryContextFactory>;

beforeAll(async () => {
  if (!ENV.ok) return;
  entryFixture = await createEntryContextFixture();
  entryFactory = createDeploymentEntryContextFactory({
    directory: entryFixture.directory,
    data: entryFixture.data,
    authenticate: entryFixture.authenticate,
  });
}, 60000);

afterAll(async () => {
  await entryFixture?.dispose();
});

describeDb("MT130 后台配置解析：按记录归属，不读全局可变状态", () => {
  itDb(
    "同一 Worker 对两家公司的后台记录各解析各的配置（公司 A 配置行 vs 公司 B 缺配置行拒绝）",
    async () => {
      const forA = await resolveBackgroundRuntimeConfig(entryFactory, {
        actorId: entryFixture.userA,
        tenantId: entryFixture.tenantA,
        workspaceId: entryFixture.teamA1,
      });
      expect(forA.threadIdentitySeed).toBeDefined();
      // 公司 B 没有配置行：按记录解析 = RUNTIME_CONFIG_NOT_FOUND，绝不回退
      // 到「进程当前配置」（不存在那样的输入面）。
      const forB = resolveBackgroundRuntimeConfig(entryFactory, {
        actorId: entryFixture.userB,
        tenantId: entryFixture.tenantB,
        workspaceId: entryFixture.teamB1,
      });
      await expect(forB).rejects.toThrow("RUNTIME_CONFIG_NOT_FOUND");
    },
  );

  itDb(
    "记录缺归属（无 tenant/workspace）→ BG_CONFIG_RECORD_UNATTRIBUTED，无全局回退",
    async () => {
      await expect(
        resolveBackgroundRuntimeConfig(entryFactory, {
          actorId: entryFixture.userA,
        }),
      ).rejects.toThrow(BG_CONFIG_RECORD_UNATTRIBUTED);
      await expect(
        resolveBackgroundRuntimeConfig(entryFactory, {
          tenantId: entryFixture.tenantA,
        }),
      ).rejects.toThrow(BG_CONFIG_RECORD_UNATTRIBUTED);
      await expect(
        resolveBackgroundRuntimeConfig(entryFactory, {}),
      ).rejects.toThrow(BG_CONFIG_RECORD_UNATTRIBUTED);
    },
  );

  itDb(
    "机器身份记录（无成员资格）建立失败：TENANT_FORBIDDEN——机器 pin 不自动获得用户范围",
    async () => {
      await expect(
        resolveBackgroundRuntimeConfig(entryFactory, {
          actorId: entryFixture.machineUserId,
          tenantId: entryFixture.tenantA,
          workspaceId: entryFixture.teamA1,
        }),
      ).rejects.toThrow(/FORBIDDEN/);
    },
  );
});
