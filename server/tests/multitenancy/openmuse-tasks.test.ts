// server/tests/multitenancy/openmuse-tasks.test.ts
// MT060（Issue #103）：OpenMuse 任务/计划/监控/租约归属域的作用域。
//
// 验收事实源（Issue #103 四条，逐条对应 describe；真实 PostgreSQL，全程受限
// ob_ent_* 角色 + 真实 RLS + 真实 MT041 租约/MT059 私有 Bot/MT005 gate，绝不
// 回退开发库、缺 env 显式 skip）：
//   AC1 列表、详情、更新与取消只作用于当前范围；跨范围 ID 返回不可见语义
//     ——协会行三元组（租户臂 RLS + 应用层第二道防线）先于一切任务行读写；
//     一切不可见 = MT011 canonical RESOURCE_NOT_FOUND 逐字节同形。
//   AC2 任务锁与租约按范围隔离：公司 A 的锁不阻塞也不被公司 B 复用
//     ——MT041 租约（claim/renew/finish/release）跨范围拒绝；归属写入锁
//     键 = 作用域限定，跨公司键结构性不相交、实测并行不阻塞。
//   AC3 只有 user_id 的旧根记录被补上公司与团队关联（迁移可 dry-run 预览）
//     ——迁移第三步幂等回填（唯一归属才回填，歧义/无归属保持隔离零行）；
//     preview 只读预览与注册迁移语句的执行结果逐行一致，零写入。
//   AC4 后台触发遵守 MT042 的作用域重建规则——机器身份 → 权威协会行
//     （app.scan_sweep 臂）→ 真实签发入口（entrypoint="schedule"）→ MT041
//     租约 → MT005 gate；消息 payload 提示从不参与判定，零回显。
//
// 结构（新文件优先；既有文件只动三处授权窄缝：migrate-test.ts 追加任务 /
// migration-tool.test.ts 断言行+裁决 / schema barrel 追加 1 行；另有一处
// RECTIFIED 冻结面微修见 checkpoints/MT060/verification/02–03 披露）。

import { afterAll, beforeAll, describe, expect, test } from "../../../tests/support/bun-test-compat";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  buildPlan,
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  createMachineScanIdentity,
  MACHINE_IDENTITY_INVALID,
} from "../../src/enterprise/runs/scan-executor";
import {
  JOB_LEASE_HELD,
  JOB_LEASE_SCOPE_MISMATCH,
} from "../../src/enterprise/tenancy/job-ownership";
import {
  isResourceNotFoundVerdict,
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import {
  OPENMUSE_TASK_CURSOR_INVALID,
  OPENMUSE_TASK_RECORD_MISSING,
  OPENMUSE_TASK_SCOPE_REVOKED,
  scopeTaskLockKey,
} from "../../src/enterprise/tenancy/openmuse-task-tenancy";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import {
  createOpenMuseTasksFixture,
  type OpenMuseTasksFixture,
} from "./support/openmuse-tasks";

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
      reason: `MT060 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
const itDb = ((name, fn) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

// ---------------------------------------------------------------------------
// 断言形状助手
// ---------------------------------------------------------------------------

const canonicalNotFoundJson = serializeNotFoundVerdict(notFoundVerdict());

const isCanonicalNotFound = (value: unknown): boolean =>
  isResourceNotFoundVerdict(value) &&
  JSON.stringify(value) === canonicalNotFoundJson;

const thrownMessage = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to be rejected, but it succeeded");
};

/** 创建期配置依据（测试钉死常量；生产由装配经 MT014 解析后传入）。 */
const CREATION_BASIS = {
  companyRevision: 1,
  overrideRevision: null,
  document: { surface: "openmuse-task", revision: 1 },
} as const;

// ---------------------------------------------------------------------------
// 套件状态
// ---------------------------------------------------------------------------

let fixture: OpenMuseTasksFixture;
let companyA = "";
let companyB = "";
let teamA1 = "";
let teamA2 = "";
let teamB1 = "";
const suiteGeneratedDirs: string[] = [];
const randomSuiteToken = () => Math.random().toString(36).slice(2, 10);

/** 共享任务图：每条 = {id, ownerIdentity, botId, scope}。 */
const tasks: Record<
  string,
  { id: string; botId: string; ownerUserId: string }
> = {};

const scopeAs = (
  identity: Parameters<OpenMuseTasksFixture["scopeAs"]>[0],
  tenantId: string,
  workspaceId: string,
): Promise<PlatformScope> => fixture.scopeAs(identity, tenantId, workspaceId);

const botOf = async (
  identity: Parameters<OpenMuseTasksFixture["scopeAs"]>[0],
  tenantId: string,
  workspaceId: string,
): Promise<string> => {
  const scope = await scopeAs(identity, tenantId, workspaceId);
  const outcome = await fixture.personalBots.ensurePersonalBot(scope, {
    displayName: `MT060 private bot ${identity}`,
  });
  if (outcome.outcome !== "allow") {
    throw new Error(`private bot ensure failed: ${JSON.stringify(outcome)}`);
  }
  return outcome.bot.agentId;
};

const pinTask = async (
  identity: Parameters<OpenMuseTasksFixture["scopeAs"]>[0],
  tenantId: string,
  workspaceId: string,
  taskId: string,
  botId: string,
) => {
  const scope = await scopeAs(identity, tenantId, workspaceId);
  const result = await fixture.service.pinTaskScope(scope, {
    taskId,
    botId,
    basis: CREATION_BASIS,
  });
  if (result.outcome === "deny") {
    throw new Error(`pin failed: ${JSON.stringify(result)}`);
  }
  return result;
};

const seedAndPin = async (
  key: string,
  identity: Parameters<OpenMuseTasksFixture["scopeAs"]>[0],
  tenantId: string,
  workspaceId: string,
  botId: string,
  input?: {
    kind?: "agent" | "document" | "monitor" | "finance" | "plan";
    status?: "queued" | "running" | "failed" | "succeeded";
    attempts?: number;
  },
) => {
  const ownerUserId = fixture.ids[`user-${identity}`];
  const taskId = await fixture.seedLegacyTask({
    ownerUserId,
    botId,
    ...(input?.kind ? { kind: input.kind } : {}),
    ...(input?.status ? { status: input.status } : {}),
    ...(input?.attempts !== undefined ? { attempts: input.attempts } : {}),
  });
  await pinTask(identity, tenantId, workspaceId, taskId, botId);
  tasks[key] = { id: taskId, botId, ownerUserId };
  return taskId;
};

beforeAll(async () => {
  if (!ENV.ok) return;

  // MT060 migration through the real MT003 tool: generate → apply → replay
  // is convergent (applied on a fresh database, up-to-date on replay).
  if (!resolveTestDatabaseTarget(process.env).ok) {
    throw new Error(
      "MT060 migration target refused: TEST_DATABASE_URL invalid",
    );
  }
  const dir = join("/tmp", `mt060-migration-${randomSuiteToken()}`);
  suiteGeneratedDirs.push(dir);
  const generation = await runMigrateTest(["generate", "MT060", "--out", dir], {
    environment: process.env,
    out: () => {},
  });
  if (generation.kind !== "generated") {
    throw new Error(`MT060 generate failed: ${JSON.stringify(generation)}`);
  }
  const manifestPath = join(dir, "MT060", "manifest.json");
  const applied: RunOutcome = await runMigrateTest(
    ["migrate", "MT060", "--apply", "--manifest", manifestPath],
    { environment: process.env, out: () => {} },
  );
  if (!["applied", "up-to-date"].includes(applied.kind)) {
    throw new Error(`MT060 apply failed: ${JSON.stringify(applied)}`);
  }
  const replay = await runMigrateTest(
    ["migrate", "MT060", "--apply", "--manifest", manifestPath],
    { environment: process.env, out: () => {} },
  );
  if (replay.kind !== "up-to-date") {
    throw new Error(`MT060 replay not convergent: ${JSON.stringify(replay)}`);
  }

  fixture = await createOpenMuseTasksFixture();
  companyA = fixture.ids["company-a"];
  companyB = fixture.ids["company-b"];
  teamA1 = fixture.ids["team-a1"];
  teamA2 = fixture.ids["team-a2"];
  teamB1 = fixture.ids["team-b1"];

  // Private bots (MT059 consumption): one per (identity, scope) the shared
  // graph pins tasks for.
  const botA1 = await botOf("a1-member", companyA, teamA1);
  const botA2 = await botOf("a2-member", companyA, teamA2);
  const botB1 = await botOf("b1-member", companyB, teamB1);
  const botOther = await botOf("a1-other", companyA, teamA1);
  const botMultiA = await botOf("multi-company", companyA, teamA1);
  const botMultiB = await botOf("multi-company", companyB, teamB1);

  // Shared task graph: every kind, several scopes, one foreign-person task.
  await seedAndPin("a1", "a1-member", companyA, teamA1, botA1);
  await seedAndPin("a1Plan", "a1-member", companyA, teamA1, botA1, {
    kind: "plan",
  });
  await seedAndPin("a1Monitor", "a1-member", companyA, teamA1, botA1, {
    kind: "monitor",
  });
  await seedAndPin("other", "a1-other", companyA, teamA1, botOther);
  await seedAndPin("a2", "a2-member", companyA, teamA2, botA2);
  await seedAndPin("b1", "b1-member", companyB, teamB1, botB1);
  await seedAndPin("multiA", "multi-company", companyA, teamA1, botMultiA);
  await seedAndPin("multiB", "multi-company", companyB, teamB1, botMultiB);
}, 120_000);

afterAll(async () => {
  for (const dir of suiteGeneratedDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  if (fixture) {
    await fixture.dispose();
  }
}, 60_000);

// ---------------------------------------------------------------------------
// AC1：列表、详情、更新与取消只作用于当前范围；跨范围 ID 返回不可见语义
// ---------------------------------------------------------------------------

describeDb("MT060 AC1：范围化列表/详情/更新/取消", () => {
  itDb("列表只返回本人、所选团队范围内的任务（跨人零泄漏）", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const { tasks: listed } = await fixture.service.listTasks(scope, {
      limit: 100,
    });
    const ids = listed.map((entry) => entry.ownership.taskId).sort();
    expect(ids).toEqual(
      [tasks.a1.id, tasks.a1Plan.id, tasks.a1Monitor.id].sort(),
    );
    for (const entry of listed) {
      expect(entry.ownership.tenantId).toBe(companyA);
      expect(entry.ownership.workspaceId).toBe(teamA1);
      expect(entry.ownership.principalId).toBe(
        fixture.ids["principal-a1-member"],
      );
      expect(entry.ownership.userId).toBe(fixture.ids["user-a1-member"]);
      expect(entry.ownership.attribution).toBe("created");
    }
    // 同团队另一人的任务从不出现在别人的列表里。
    expect(ids).not.toContain(tasks.other.id);
  });

  itDb(
    "多团队成员按所选团队切换视野：另一团队上下文看不到本团队任务",
    async () => {
      // a1a2-member 在 A1/A2 都有成员资格，但没有 pin 过任何任务。
      const scopeA2 = await scopeAs("a1a2-member", companyA, teamA2);
      const { tasks: a2Listed } = await fixture.service.listTasks(scopeA2, {
        limit: 100,
      });
      expect(a2Listed.map((entry) => entry.ownership.taskId)).toEqual([]);
      // 视野钉在 scope 上：同一个人切回 A1 也不会看到 a1-member 的任务。
      const scopeA1 = await scopeAs("a1a2-member", companyA, teamA1);
      const { tasks: a1Listed } = await fixture.service.listTasks(scopeA1, {
        limit: 100,
      });
      expect(a1Listed.map((entry) => entry.ownership.taskId)).toEqual([]);
    },
  );

  itDb(
    "同一人的跨团队上下文不可见：A1 pin 的任务从 A2 读取/取消零触达",
    async () => {
      // RLS 主体自读臂对同一人的全公司协会行可见（tenant+principal 两臂都
      // 匹配），跨团队隔离只能由协会行三元组第二道防线独立承担——本用例让
      // MUT-1（拔第二道防线）必须在这里响亮失败。
      const bot = await botOf("a1a2-member", companyA, teamA1);
      const taskId = await seedAndPin(
        "a1a2pinned",
        "a1a2-member",
        companyA,
        teamA1,
        bot,
      );
      const scopeA2 = await scopeAs("a1a2-member", companyA, teamA2);
      const readOutcome = await fixture.service.readTask(scopeA2, taskId);
      expect(isCanonicalNotFound(readOutcome)).toBe(true);
      const cancelOutcome = await fixture.service.cancelTask(scopeA2, taskId);
      expect(cancelOutcome.outcome).toBe("missing");
      // 零副作用：任务行原样，且本人在归属团队上下文仍然可见。
      expect(await fixture.taskStatusOf(taskId)).toBe("queued");
      const ownOutcome = await fixture.service.readTask(
        await scopeAs("a1a2-member", companyA, teamA1),
        taskId,
      );
      expect(ownOutcome.outcome).toBe("allow");
    },
  );

  itDb(
    "跨公司与他人的详情一致隐藏在 canonical not-found 后（四态同形）",
    async () => {
      const absent = `openmuse-task-${randomSuiteToken()}`;
      const crossTeam = await fixture.service.readTask(
        await scopeAs("a1a2-member", companyA, teamA2),
        tasks.a1.id,
      );
      const crossCompany = await fixture.service.readTask(
        await scopeAs("b1-member", companyB, teamB1),
        tasks.a1.id,
      );
      const otherPerson = await fixture.service.readTask(
        await scopeAs("a1-other", companyA, teamA1),
        tasks.a1.id,
      );
      const missing = await fixture.service.readTask(
        await scopeAs("a1-member", companyA, teamA1),
        absent,
      );
      for (const outcome of [crossTeam, crossCompany, otherPerson, missing]) {
        expect(isCanonicalNotFound(outcome)).toBe(true);
      }
      expect(
        new Set([
          JSON.stringify(crossTeam),
          JSON.stringify(crossCompany),
          JSON.stringify(otherPerson),
          JSON.stringify(missing),
        ]).size,
      ).toBe(1);
    },
  );

  itDb(
    "详情正向：可见任务返回任务行与归属三元组（plan/monitor kind 全过）",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const planRead = await fixture.service.readTask(scope, tasks.a1Plan.id);
      expect(planRead.outcome).toBe("allow");
      if (planRead.outcome === "allow") {
        expect(planRead.task.kind).toBe("plan");
        expect(planRead.task.botId).toBe(tasks.a1Plan.botId);
        expect(planRead.ownership.taskId).toBe(tasks.a1Plan.id);
      }
      const monitorRead = await fixture.service.readTask(
        scope,
        tasks.a1Monitor.id,
      );
      expect(monitorRead.outcome).toBe("allow");
      if (monitorRead.outcome === "allow") {
        expect(monitorRead.task.kind).toBe("monitor");
      }
    },
  );

  itDb("列表分页：limit/cursor 稳定翻页，坏游标响亮拒绝", async () => {
    const bot = await botOf("a1-member", companyA, teamA1);
    const extra: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      extra.push(
        await seedAndPin(`page${index}`, "a1-member", companyA, teamA1, bot),
      );
    }
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const page1 = await fixture.service.listTasks(scope, { limit: 3 });
    expect(page1.tasks).toHaveLength(3);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await fixture.service.listTasks(scope, {
      limit: 3,
      ...(page1.nextCursor ? { cursor: page1.nextCursor } : {}),
    });
    expect(page2.tasks).toHaveLength(3);
    const page1Ids = page1.tasks.map((entry) => entry.ownership.taskId);
    const page2Ids = page2.tasks.map((entry) => entry.ownership.taskId);
    expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
    const all = new Set([...page1Ids, ...page2Ids]);
    for (const id of extra) expect(all.has(id)).toBe(true);
    await expect(
      thrownMessage(() =>
        fixture.service.listTasks(scope, { limit: 3, cursor: "not-a-cursor" }),
      ),
    ).resolves.toBe(OPENMUSE_TASK_CURSOR_INVALID);
  });

  itDb("跨范围取消是 missing 且零副作用（真实行状态原样）", async () => {
    const before = await fixture.taskStatusOf(tasks.a1.id);
    const cancelOutcome = await fixture.service.cancelTask(
      await scopeAs("b1-member", companyB, teamB1),
      tasks.a1.id,
    );
    expect(cancelOutcome.outcome).toBe("missing");
    expect(await fixture.taskStatusOf(tasks.a1.id)).toBe(before);
    // 每个控制动作都同一语义：missing、零写入。
    const pauseOutcome = await fixture.service.pauseTask(
      await scopeAs("a1a2-member", companyA, teamA2),
      tasks.a1.id,
    );
    expect(pauseOutcome.outcome).toBe("missing");
    const retryOutcome = await fixture.service.retryTask(
      await scopeAs("a1-other", companyA, teamA1),
      tasks.a1.id,
      "foreign-retry-key",
    );
    expect(retryOutcome.outcome).toBe("missing");
    const resumeOutcome = await fixture.service.resumeTask(
      await scopeAs("b1-member", companyB, teamB1),
      tasks.a1.id,
    );
    expect(resumeOutcome.outcome).toBe("missing");
    expect(await fixture.taskStatusOf(tasks.a1.id)).toBe(before);
  });

  itDb("范围内取消走真实 CAS：queued 直接取消", async () => {
    const bot = await botOf("a1-member", companyA, teamA1);
    const taskId = await seedAndPin(
      "cancelQueued",
      "a1-member",
      companyA,
      teamA1,
      bot,
    );
    const outcome = await fixture.service.cancelTask(
      await scopeAs("a1-member", companyA, teamA1),
      taskId,
    );
    expect(outcome.outcome).toBe("cancelled");
    if (outcome.outcome === "cancelled") {
      expect(outcome.task.status).toBe("cancelled");
    }
    expect(await fixture.taskStatusOf(taskId)).toBe("cancelled");
  });

  itDb(
    "范围内 pause/retry/resume 沿既有状态矩阵：requested 与终态 409 形状",
    async () => {
      const bot = await botOf("a1-member", companyA, teamA1);
      // running → pause = requested（公开状态保持 running，内部旗标置位）。
      const runningId = await seedAndPin(
        "ctlRunning",
        "a1-member",
        companyA,
        teamA1,
        bot,
        { status: "running" },
      );
      const pauseOutcome = await fixture.service.pauseTask(
        await scopeAs("a1-member", companyA, teamA1),
        runningId,
      );
      expect(pauseOutcome.outcome).toBe("requested");
      if (pauseOutcome.outcome === "requested") {
        expect(pauseOutcome.task.pauseRequested).toBe(true);
        expect(pauseOutcome.task.status).toBe("running");
      }
      // failed → retry（带幂等键）= retried / attempts+1 / 重复键 replayed。
      const failedId = await seedAndPin(
        "ctlFailed",
        "a1-member",
        companyA,
        teamA1,
        bot,
        { status: "failed" },
      );
      const retryOutcome = await fixture.service.retryTask(
        await scopeAs("a1-member", companyA, teamA1),
        failedId,
        "mt060-retry-key-1",
      );
      expect(retryOutcome.outcome).toBe("retried");
      if (retryOutcome.outcome === "retried") {
        expect(retryOutcome.task.status).toBe("queued");
        expect(retryOutcome.task.attempts).toBe(2);
      }
      const replayOutcome = await fixture.service.retryTask(
        await scopeAs("a1-member", companyA, teamA1),
        failedId,
        "mt060-retry-key-1",
      );
      expect(replayOutcome.outcome).toBe("replayed");
      // paused → resume = resumed（回到 queued）。
      const pausedId = await seedAndPin(
        "ctlPaused",
        "a1-member",
        companyA,
        teamA1,
        bot,
        { status: "paused" },
      );
      const resumeOutcome = await fixture.service.resumeTask(
        await scopeAs("a1-member", companyA, teamA1),
        pausedId,
      );
      expect(resumeOutcome.outcome).toBe("resumed");
      if (resumeOutcome.outcome === "resumed") {
        expect(resumeOutcome.task.status).toBe("queued");
      }
      // 终态任务不可再操作：succeeded → terminal + 当前状态。
      const doneId = await seedAndPin(
        "ctlDone",
        "a1-member",
        companyA,
        teamA1,
        bot,
        { status: "succeeded" },
      );
      const terminal = await fixture.service.cancelTask(
        await scopeAs("a1-member", companyA, teamA1),
        doneId,
      );
      expect(terminal.outcome).toBe("terminal");
    },
  );

  itDb(
    "范围内 answerWait 消费确切 wait；错 waitId 与跨范围同为 missing",
    async () => {
      const bot = await botOf("a1-member", companyA, teamA1);
      const waitTaskId = await seedAndPin(
        "ctlWait",
        "a1-member",
        companyA,
        teamA1,
        bot,
        { status: "running" },
      );
      const opened = await fixture.taskStore.openWait(waitTaskId, {
        question: "Proceed?",
        ifAttempts: 1,
      });
      expect(opened).not.toBeNull();
      const openedWaitId = opened?.wait?.waitId;
      expect(openedWaitId).toBeTruthy();
      // 错 waitId：missing（与跨范围同形，不泄露 wait 存在性）。
      const wrongWait = await fixture.service.answerWait(
        await scopeAs("a1-member", companyA, teamA1),
        waitTaskId,
        `openmuse-wait-${randomSuiteToken()}`,
        { answer: "yes" },
      );
      expect(wrongWait.outcome).toBe("missing");
      // 跨范围主体答他人的 wait：missing 且 wait 未被消费。
      const foreign = await fixture.service.answerWait(
        await scopeAs("a1-other", companyA, teamA1),
        waitTaskId,
        openedWaitId as string,
        { answer: "yes" },
      );
      expect(foreign.outcome).toBe("missing");
      // 本人正确消费：answered，行回 queued。
      const answered = await fixture.service.answerWait(
        await scopeAs("a1-member", companyA, teamA1),
        waitTaskId,
        openedWaitId as string,
        { answer: "yes" },
      );
      expect(answered.outcome).toBe("answered");
      if (answered.outcome === "answered") {
        expect(answered.task.status).toBe("queued");
      }
    },
  );

  itDb(
    "撤权立即失效：列表 SCOPE_REVOKED、读/取消 fail-closed 不可见且零副作用",
    async () => {
      const bot = await botOf("a1-other", companyA, teamA1);
      const taskId = await seedAndPin(
        "revoked",
        "a1-other",
        companyA,
        teamA1,
        bot,
      );
      // 撤权前签发的 scope：业务事务内重验失效。
      const staleScope = await scopeAs("a1-other", companyA, teamA1);
      await fixture.suspendCompanyMembership(
        companyA,
        fixture.ids["principal-a1-other"],
      );
      await expect(
        thrownMessage(() =>
          fixture.service.listTasks(staleScope, { limit: 10 }),
        ),
      ).resolves.toBe(OPENMUSE_TASK_SCOPE_REVOKED);
      const readOutcome = await fixture.service.readTask(staleScope, taskId);
      expect(isCanonicalNotFound(readOutcome)).toBe(true);
      const cancelOutcome = await fixture.service.cancelTask(
        staleScope,
        taskId,
      );
      expect(cancelOutcome.outcome).toBe("missing");
      expect(await fixture.taskStatusOf(taskId)).toBe("queued");
    },
  );
});

// ---------------------------------------------------------------------------
// AC2：任务锁与租约按范围隔离——公司 A 的锁不阻塞也不被公司 B 复用
// ---------------------------------------------------------------------------

describeDb("MT060 AC2：锁与租约按范围隔离", () => {
  const workerA = { kind: "worker" as const, id: "mt060-worker-a" };
  const workerB = { kind: "worker" as const, id: "mt060-worker-b" };
  const scopeA1 = { tenantId: "", workspaceId: "" };
  const scopeB1 = { tenantId: "", workspaceId: "" };

  beforeAll(() => {
    scopeA1.tenantId = companyA;
    scopeA1.workspaceId = teamA1;
    scopeB1.tenantId = companyB;
    scopeB1.workspaceId = teamB1;
  });

  itDb("归属范围内认领租约成功（MT041 租约消费）", async () => {
    const grant = await fixture.jobs.claimJobLease({
      kind: "task",
      objectId: tasks.a1.id,
      scope: scopeA1,
      executor: workerA,
      leaseMs: 60_000,
    });
    expect(grant.status).toBe("granted");
    const row = await fixture.leaseRowOf(tasks.a1.id);
    expect(row?.claimedBy).toBe(workerA.id);
    expect(row?.claimedByKind).toBe("worker");
    expect(row?.attempts).toBe(1);
  });

  itDb("跨公司认领被拒：公司 B 拿不到也复用不了公司 A 的租约", async () => {
    const message = await thrownMessage(() =>
      fixture.jobs.claimJobLease({
        kind: "task",
        objectId: tasks.a1.id,
        scope: scopeB1,
        executor: workerB,
        leaseMs: 60_000,
      }),
    );
    expect(message.startsWith(JOB_LEASE_SCOPE_MISMATCH)).toBe(true);
    // 持有人行零变化：holder 不变、attempts 不变、租约未被动过。
    const row = await fixture.leaseRowOf(tasks.a1.id);
    expect(row?.claimedBy).toBe(workerA.id);
    expect(row?.attempts).toBe(1);
  });

  itDb("同公司跨团队认领被拒（workspace 逐字比对）", async () => {
    const message = await thrownMessage(() =>
      fixture.jobs.claimJobLease({
        kind: "task",
        objectId: tasks.a1.id,
        scope: { tenantId: companyA, workspaceId: teamA2 },
        executor: { kind: "principal", id: fixture.ids["principal-a2-member"] },
        leaseMs: 60_000,
      }),
    );
    expect(message.startsWith(JOB_LEASE_SCOPE_MISMATCH)).toBe(true);
    const row = await fixture.leaseRowOf(tasks.a1.id);
    expect(row?.claimedBy).toBe(workerA.id);
  });

  itDb("公司 A 的活租约不阻塞公司 B：B 立即拿到自己任务的租约", async () => {
    // tA1 的租约仍由 workerA 持有（前两个用例的现场）。
    const grant = await fixture.jobs.claimJobLease({
      kind: "task",
      objectId: tasks.b1.id,
      scope: scopeB1,
      executor: workerB,
      leaseMs: 60_000,
    });
    expect(grant.status).toBe("granted");
    const rowB = await fixture.leaseRowOf(tasks.b1.id);
    expect(rowB?.claimedBy).toBe(workerB.id);
    // A 的租约原样。
    const rowA = await fixture.leaseRowOf(tasks.a1.id);
    expect(rowA?.claimedBy).toBe(workerA.id);
    // 清理：释放 B 的租约——b1 现场归零（AC4 的 lease-held 用例需要由它自
    // 己的 holder 重新持锁，60s 租约跨 describe 残留会污染其前置）。本用例
    // 断言已全部先行，释放不弱化任何验证。
    await fixture.jobs.releaseJobLease({
      kind: "task",
      objectId: tasks.b1.id,
      scope: scopeB1,
      executor: workerB,
      reason: "mt060-lease-cleanup",
    });
  });

  itDb(
    "释放后跨范围仍不可认领；renew/finish/release 全部拒绝且零写入",
    async () => {
      await fixture.jobs.releaseJobLease({
        kind: "task",
        objectId: tasks.a1.id,
        scope: scopeA1,
        executor: workerA,
        reason: "mt060-lease-test",
      });
      const rowAfterRelease = await fixture.leaseRowOf(tasks.a1.id);
      expect(rowAfterRelease?.claimedBy).toBeNull();
      // 可用 ≠ 可跨范围认领：B 仍然被拒。
      await expect(
        thrownMessage(() =>
          fixture.jobs.claimJobLease({
            kind: "task",
            objectId: tasks.a1.id,
            scope: scopeB1,
            executor: workerB,
            leaseMs: 60_000,
          }),
        ),
      ).resolves.toStartWith(JOB_LEASE_SCOPE_MISMATCH);
      // B 的 renew/finish/release 对 A 的任务全部拒绝。
      await expect(
        thrownMessage(() =>
          fixture.jobs.renewJobLease({
            kind: "task",
            objectId: tasks.a1.id,
            scope: scopeB1,
            executor: workerB,
            leaseMs: 60_000,
          }),
        ),
      ).resolves.toStartWith(JOB_LEASE_SCOPE_MISMATCH);
      await expect(
        thrownMessage(() =>
          fixture.jobs.finishJobLease({
            kind: "task",
            objectId: tasks.a1.id,
            scope: scopeB1,
            executor: workerB,
          }),
        ),
      ).resolves.toStartWith(JOB_LEASE_SCOPE_MISMATCH);
      await expect(
        thrownMessage(() =>
          fixture.jobs.releaseJobLease({
            kind: "task",
            objectId: tasks.a1.id,
            scope: scopeB1,
            executor: workerB,
            reason: "foreign",
          }),
        ),
      ).resolves.toStartWith(JOB_LEASE_SCOPE_MISMATCH);
      const row = await fixture.leaseRowOf(tasks.a1.id);
      expect(row?.claimedBy).toBeNull();
      expect(row?.attempts).toBe(1);
    },
  );

  itDb("他人活租约 → JOB_LEASE_HELD；同持有人幂等 held", async () => {
    const first = await fixture.jobs.claimJobLease({
      kind: "task",
      objectId: tasks.multiA.id,
      scope: scopeA1,
      executor: workerA,
      leaseMs: 60_000,
    });
    expect(first.status).toBe("granted");
    const second = await fixture.jobs.claimJobLease({
      kind: "task",
      objectId: tasks.multiA.id,
      scope: scopeA1,
      executor: workerA,
      leaseMs: 60_000,
    });
    expect(second.status).toBe("held");
    const held = await thrownMessage(() =>
      fixture.jobs.claimJobLease({
        kind: "task",
        objectId: tasks.multiA.id,
        scope: scopeA1,
        executor: { kind: "worker", id: "mt060-worker-c" },
        leaseMs: 60_000,
      }),
    );
    expect(held.startsWith(JOB_LEASE_HELD)).toBe(true);
    await fixture.jobs.releaseJobLease({
      kind: "task",
      objectId: tasks.multiA.id,
      scope: scopeA1,
      executor: workerA,
      reason: "mt060-lease-test",
    });
  });

  itDb("作用域锁键结构性互异；实测跨公司 pin 不被 A 的锁阻塞", async () => {
    const keyA = scopeTaskLockKey(
      companyA,
      teamA1,
      fixture.ids["principal-a1-member"],
    );
    const keyB = scopeTaskLockKey(
      companyB,
      teamB1,
      fixture.ids["principal-b1-member"],
    );
    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe(
      scopeTaskLockKey(companyA, teamA1, fixture.ids["principal-a1-member"]),
    );
    // 实测：A 作用域锁被持有时，B 的归属写入照常完成（同键才会互相阻塞）。
    const botB = await botOf("b1-member", companyB, teamB1);
    const newBTask = await fixture.seedLegacyTask({
      ownerUserId: fixture.ids["user-b1-member"],
      botId: botB,
    });
    await fixture.platform
      .transaction(async (tx) => {
        await tx.execute(
          // 持有 A 作用域的归属写锁（读共享锁族的主键）。
          sql.raw(
            `select pg_advisory_xact_lock(hashtextextended('${keyA.replace(/'/g, "''")}', 0))`,
          ),
        );
        const pinned = await pinTask(
          "b1-member",
          companyB,
          teamB1,
          newBTask,
          botB,
        );
        expect(pinned.status).toBe("pinned");
        // 对照：同键（A 作用域）的写入被阻塞到 lock_timeout —— 证明锁真实生效。
        const botA = await botOf("a1-member", companyA, teamA1);
        const newATask = await fixture.seedLegacyTask({
          ownerUserId: fixture.ids["user-a1-member"],
          botId: botA,
        });
        const blocked = await thrownMessage(async () =>
          fixture.service.pinTaskScope(
            await scopeAs("a1-member", companyA, teamA1),
            {
              taskId: newATask,
              botId: botA,
              basis: CREATION_BASIS,
            },
          ),
        );
        expect(blocked.length).toBeGreaterThan(0);
        throw new Error("ROLLBACK_MARKER");
      })
      .catch((error) => {
        expect(String(error)).toContain("ROLLBACK_MARKER");
      });
  });
});

// ---------------------------------------------------------------------------
// AC3：只有 user_id 的旧根记录被补上公司与团队关联（迁移可 dry-run 预览）
// ---------------------------------------------------------------------------

describeDb("MT060 AC3：旧根记录回填与 dry-run 预览", () => {
  const backfillStatements = () =>
    buildPlan("MT060").steps.find(
      (step) => step.slug === "legacy_task_backfill",
    )?.statements ?? [];

  let soloTask1 = "";
  let soloTask2 = "";
  let ambiguousTask = "";
  let orphanTask = "";

  beforeAll(async () => {
    // 回填候选：solo=唯一归属（应回填）、ambiguous=双团队（隔离）、
    // orphan=无成员（隔离）。bot id 用旧 agents 命名空间形状。
    const soloUser = fixture.ids["user-backfill-solo"];
    const ambiguousUser = fixture.ids["user-a1a2-member"];
    const orphanUser = fixture.ids["user-backfill-orphan"];
    soloTask1 = await fixture.seedLegacyTask({
      ownerUserId: soloUser,
      botId: `agent-legacy-${randomSuiteToken()}`,
    });
    soloTask2 = await fixture.seedLegacyTask({
      ownerUserId: soloUser,
      botId: `agent-legacy-${randomSuiteToken()}`,
      kind: "monitor",
    });
    ambiguousTask = await fixture.seedLegacyTask({
      ownerUserId: ambiguousUser,
      botId: `agent-legacy-${randomSuiteToken()}`,
    });
    orphanTask = await fixture.seedLegacyTask({
      ownerUserId: orphanUser,
      botId: `agent-legacy-${randomSuiteToken()}`,
    });
  });

  itDb("preview 只读分类：唯一归属可回填；歧义与无归属进隔离清单", async () => {
    const preview = await fixture.service.previewLegacyBackfill(
      fixture.machine,
    );
    const attributableIds = preview.attributable.map((row) => row.taskId);
    expect(attributableIds).toContain(soloTask1);
    expect(attributableIds).toContain(soloTask2);
    expect(attributableIds).not.toContain(ambiguousTask);
    expect(attributableIds).not.toContain(orphanTask);
    const solo = preview.attributable.find((row) => row.taskId === soloTask1);
    expect(solo?.tenantId).toBe(companyA);
    expect(solo?.workspaceId).toBe(teamA1);
    expect(solo?.principalId).toBe(fixture.ids["principal-backfill-solo"]);
    expect(solo?.userId).toBe(fixture.ids["user-backfill-solo"]);
    const isolated = new Map(
      preview.isolated.map((row) => [row.taskId, row.reason]),
    );
    expect(isolated.get(ambiguousTask)).toBe("ambiguous-membership");
    expect(isolated.get(orphanTask)).toBe("no-membership");
    // preview 后零写入：可回填候选也还没有行。
    expect(await fixture.scopeRowOf(soloTask1)).toBeUndefined();
    expect(await fixture.scopeRowOf(soloTask2)).toBeUndefined();
    expect(await fixture.scopeRowOf(ambiguousTask)).toBeUndefined();
    expect(await fixture.scopeRowOf(orphanTask)).toBeUndefined();
  });

  itDb(
    "注册迁移的回填语句恰好落 preview 的可回填集（三元组与 attribution 正确）",
    async () => {
      const statements = backfillStatements();
      expect(statements.length).toBeGreaterThan(0);
      await fixture.runStatements(statements);
      const solo1 = await fixture.scopeRowOf(soloTask1);
      expect(solo1?.tenantId).toBe(companyA);
      expect(solo1?.workspaceId).toBe(teamA1);
      expect(solo1?.principalId).toBe(fixture.ids["principal-backfill-solo"]);
      expect(solo1?.userId).toBe(fixture.ids["user-backfill-solo"]);
      expect(solo1?.attribution).toBe("backfill");
      expect(solo1?.botId).toBe((await fixture.scopeRowOf(soloTask1))?.botId);
      const solo2 = await fixture.scopeRowOf(soloTask2);
      expect(solo2?.attribution).toBe("backfill");
      expect(solo2?.workspaceId).toBe(teamA1);
      // 隔离任务零行：歧义不猜测，无归属不虚构。
      expect(await fixture.scopeRowOf(ambiguousTask)).toBeUndefined();
      expect(await fixture.scopeRowOf(orphanTask)).toBeUndefined();
    },
  );

  itDb(
    "回填语句幂等：重放零新增；preview 对新候选零写入且分类一致",
    async () => {
      const countBefore = await fixture.countScopeRows(companyA);
      await fixture.runStatements(backfillStatements());
      expect(await fixture.countScopeRows(companyA)).toBe(countBefore);
      // 新候选：preview 列出 → 仍零行 → 语句执行后与 preview 一致。
      const solo3 = await fixture.seedLegacyTask({
        ownerUserId: fixture.ids["user-backfill-solo"],
        botId: `agent-legacy-${randomSuiteToken()}`,
      });
      const preview = await fixture.service.previewLegacyBackfill(
        fixture.machine,
      );
      expect(preview.attributable.map((row) => row.taskId)).toContain(solo3);
      expect(await fixture.scopeRowOf(solo3)).toBeUndefined();
      await fixture.runStatements(backfillStatements());
      const row = await fixture.scopeRowOf(solo3);
      expect(row?.tenantId).toBe(companyA);
      expect(row?.workspaceId).toBe(teamA1);
      expect(row?.attribution).toBe("backfill");
    },
  );

  itDb(
    "回填任务在归属范围内可见（attribution=backfill）；隔离任务对一切范围不可见",
    async () => {
      const soloScope = await scopeAs("backfill-solo", companyA, teamA1);
      const { tasks: listed } = await fixture.service.listTasks(soloScope, {
        limit: 100,
      });
      const mine = listed.filter(
        (entry) => entry.ownership.attribution === "backfill",
      );
      expect(mine.length).toBeGreaterThanOrEqual(3);
      const readOutcome = await fixture.service.readTask(soloScope, soloTask1);
      expect(readOutcome.outcome).toBe("allow");
      // 他人（同团队）看不到 solo 的回填任务。
      const foreign = await fixture.service.readTask(
        await scopeAs("a1-member", companyA, teamA1),
        soloTask1,
      );
      expect(isCanonicalNotFound(foreign)).toBe(true);
      // 歧义任务：两个团队上下文都不可见（受控隔离清单，不猜测归属）。
      for (const teamId of [teamA1, teamA2]) {
        const outcome = await fixture.service.readTask(
          await scopeAs("a1a2-member", companyA, teamId),
          ambiguousTask,
        );
        expect(isCanonicalNotFound(outcome)).toBe(true);
      }
    },
  );

  itDb("preview 由机器身份门卫：伪造身份响亮拒绝", async () => {
    const forged = { kind: "machine-scan", id: "forged" };
    const message = await thrownMessage(() =>
      fixture.service.previewLegacyBackfill(forged as never),
    );
    expect(message.startsWith(MACHINE_IDENTITY_INVALID)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC4：后台触发遵守 MT042 的作用域重建规则
// ---------------------------------------------------------------------------

describeDb("MT060 AC4：后台触发的作用域重建", () => {
  const canary = `canary-${randomSuiteToken()}`;

  itDb(
    "重建按权威协会行执行：伪造 hint 全部不采纳（canary 零出现）",
    async () => {
      const resolved = await fixture.service.resolveForExecution(
        fixture.machine,
        {
          taskId: tasks.multiA.id,
          hint: {
            tenantId: companyB,
            workspaceId: teamB1,
            actorId: fixture.ids["user-b1-member"],
          },
        },
      );
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.scope.tenantId).toBe(companyA);
        expect(resolved.scope.workspaceId).toBe(teamA1);
        expect(resolved.scope.actorId).toBe(fixture.ids["user-multi-company"]);
        expect(resolved.facts.tenantId).toBe(companyA);
      }
      expect(JSON.stringify(resolved)).not.toContain(companyB);
      expect(JSON.stringify(resolved)).not.toContain(teamB1);
      expect(JSON.stringify(resolved)).not.toContain(canary);
    },
  );

  itDb(
    "无协会行的任务响亮拒绝且零回显（SCAN_RECORD_MISSING 同纪律）",
    async () => {
      const ghost = await fixture.seedLegacyTask({
        ownerUserId: fixture.ids["user-a1-member"],
        botId: canary,
      });
      const resolved = await fixture.service.resolveForExecution(
        fixture.machine,
        {
          taskId: ghost,
          hint: { tenantId: canary, workspaceId: canary, actorId: canary },
        },
      );
      expect(resolved).toEqual({
        ok: false,
        code: OPENMUSE_TASK_RECORD_MISSING,
      });
      expect(JSON.stringify(resolved)).not.toContain(canary);
      expect(JSON.stringify(resolved)).not.toContain(ghost);
    },
  );

  itDb(
    "归属主体撤权后执行重建拒绝（OPENMUSE_TASK_SCOPE_REVOKED）",
    async () => {
      // multi-company 在公司 A 被停用（公司 B 资格不受影响）。
      await fixture.suspendCompanyMembership(
        companyA,
        fixture.ids["principal-multi-company"],
      );
      const resolved = await fixture.service.resolveForExecution(
        fixture.machine,
        {
          taskId: tasks.multiA.id,
          hint: { tenantId: companyA, workspaceId: teamA1, actorId: canary },
        },
      );
      expect(resolved).toEqual({
        ok: false,
        code: OPENMUSE_TASK_SCOPE_REVOKED,
      });
    },
  );

  itDb(
    "只有签发的机器身份能驱动重建（伪造/序列化往返/dev-local-user 全拒）",
    async () => {
      const forged = { kind: "machine-scan", id: "forged" };
      await expect(
        thrownMessage(() =>
          fixture.service.resolveForExecution(forged as never, {
            taskId: tasks.a1.id,
          }),
        ),
      ).resolves.toStartWith(MACHINE_IDENTITY_INVALID);
      const roundTripped = JSON.parse(
        JSON.stringify(fixture.machine),
      ) as unknown;
      await expect(
        thrownMessage(() =>
          fixture.service.resolveForExecution(
            roundTripped as Parameters<
              OpenMuseTasksFixture["service"]["resolveForExecution"]
            >[0],
            { taskId: tasks.a1.id },
          ),
        ),
      ).resolves.toStartWith(MACHINE_IDENTITY_INVALID);
      await expect(
        thrownMessage(() =>
          createMachineScanIdentity({ id: "dev-local-user" }),
        ),
      ).resolves.toStartWith(MACHINE_IDENTITY_INVALID);
    },
  );

  itDb(
    "runUnderLease：门内执行 → 租约+执行依据完结；scope 为重建产物",
    async () => {
      let observedTenant = "";
      let observedInTransaction = false;
      const outcome = await fixture.service.runUnderLease(fixture.machine, {
        taskId: tasks.a1Plan.id,
        executor: { kind: "worker", id: "mt060-worker-exec" },
        leaseMs: 60_000,
        work: async ({ scope, tx }) => {
          observedTenant = scope.tenantId;
          await tx.execute(sql`select 1`);
          observedInTransaction = true;
        },
      });
      expect(outcome).toEqual({ status: "executed" });
      expect(observedTenant).toBe(companyA);
      expect(observedInTransaction).toBe(true);
      const lease = await fixture.leaseRowOf(tasks.a1Plan.id);
      expect(lease?.finishedAt).not.toBeNull();
      expect(lease?.claimedBy).toBeNull();
    },
  );

  itDb(
    "runUnderLease：失败 → 释放并以机器码记因（零业务错误回显）",
    async () => {
      const outcome = await fixture.service.runUnderLease(fixture.machine, {
        taskId: tasks.a1Monitor.id,
        executor: { kind: "worker", id: "mt060-worker-exec" },
        leaseMs: 60_000,
        work: async () => {
          throw new Error(`secret business failure ${canary}`);
        },
      });
      expect(outcome.status).toBe("released");
      if (outcome.status === "released") {
        expect(outcome.reason).toBe("OPENMUSE_TASK_EXECUTION_FAILED");
        expect(outcome.reason).not.toContain(canary);
      }
      const lease = await fixture.leaseRowOf(tasks.a1Monitor.id);
      expect(lease?.claimedBy).toBeNull();
      expect(lease?.finishedAt).toBeNull();
    },
  );

  itDb("runUnderLease：他人持活租约 → lease-held，work 不运行", async () => {
    const holder = { kind: "worker" as const, id: "mt060-worker-holder" };
    const grant = await fixture.jobs.claimJobLease({
      kind: "task",
      objectId: tasks.b1.id,
      scope: { tenantId: companyB, workspaceId: teamB1 },
      executor: holder,
      leaseMs: 60_000,
    });
    expect(grant.status).toBe("granted");
    let ran = false;
    const outcome = await fixture.service.runUnderLease(fixture.machine, {
      taskId: tasks.b1.id,
      executor: { kind: "worker", id: "mt060-worker-other" },
      leaseMs: 60_000,
      work: async () => {
        ran = true;
      },
    });
    expect(outcome.status).toBe("lease-held");
    expect(ran).toBe(false);
    await fixture.jobs.releaseJobLease({
      kind: "task",
      objectId: tasks.b1.id,
      scope: { tenantId: companyB, workspaceId: teamB1 },
      executor: holder,
      reason: "mt060-lease-test",
    });
  });

  itDb("无协会行/无 pin 的孤儿任务：重建先行拒绝，不静默执行", async () => {
    // 孤儿任务（有根行、无协会行）：重建在 RECORD_MISSING 拒绝——租约面
    // 永远不会在无归属记录上运行（设计 §7 分叉面的可见侧）。
    const ghost = await fixture.seedLegacyTask({
      ownerUserId: fixture.ids["user-a2-member"],
      botId: canary,
    });
    const outcome = await fixture.service.runUnderLease(fixture.machine, {
      taskId: ghost,
      executor: { kind: "worker", id: "mt060-worker-a2" },
      leaseMs: 60_000,
      work: async () => {},
    });
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.code).toBe(OPENMUSE_TASK_RECORD_MISSING);
      expect(JSON.stringify(outcome)).not.toContain(canary);
      expect(JSON.stringify(outcome)).not.toContain(ghost);
    }
    const lease = await fixture.leaseRowOf(ghost);
    expect(lease).toBeUndefined();
  });
});
