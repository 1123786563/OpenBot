// server/tests/multitenancy/automation-runs-public.test.ts
// MOD14（Issue #634，根 #620）：后台执行入口统一消费持久 Run 用例的委托等价、
// 四条验收的现状钉与迁移完整性源级钉。
//
// 事实源（Issue #634 验收 + MOD14 Brief §1.C，逐条对应 describe）：
//   C1 统一消费等价：后台入口的 Run 创建（start）/终态回退（cancel）改经 M05
//      公开门面（enterprise/runs/public.ts，MOD07 五能力）——门面委托等价
//      （同参对象同一性/同结果实例/错误实例透传）+ 装配组合（runWithBound
//      ModelRoute 包住门面 start，与浏览器 admit 同构）行为等价 + 源级钉
//      （governedHeadlessRunsFace 逐字节形状、六个 governed 入口唯一注入点、
//      直调内件 start 在装配中归零）。
//   C2 验收①重投递收敛：intent key 确定性（routine-adv:<routineId>:<firingId>，
//      ≤200 截断 sha256）；提交消息先落（clientMessageKey 幂等）→ runs.start
//      拒 RUN_IDEMPOTENCY_CONFLICT（store 同 (tenant,thread,key) 先行行）→
//      governed turn 转 ROUTINE_INTENT_ALREADY_ADVANCED → routine runner 记
//      skipped 不计疲劳；队列侧 offer key（routineId:dueMinute）+ onConflict
//      DoNothing 三副本一 item。
//   C3 验收②领取/重试/恢复从持久事实重建资格和 Payer：调度记录即授权（record
//      re-read、contextMismatch、enabled=false 拒绝）；scope 由目录此刻重签
//      （scopeFor/fresh Request + resolveForThread，队列字符串不是身份）；预算
//      由服务端路由上限签发（budgetUnconfigured 拒猜测）；Payer=准入 scope 的
//      principal（reserveModelBudgetInTransaction 以 trusted scope 记账）；各
//      入口的持久记录行（routine 行/run 行/inbox 行/work item 行）逐入口钉；
//      恢复面经 MOD13 组 + 决定时刻重签 scope + 绑定代次闸；队列 claim/重试
//      以数据库行与钟为准（for update skip locked + SQL now()）。
//   C4 验收③触发语义保持+暂停/租约失效可证：触发语义内件（频率/收件人/投递）
//      留在各 Automation Module（kind 常量与调度策略钉在模块文件，装配零复制）；
//      暂停（routine enabled=false / Bot paused / 投递 opted-out）拒绝路径钉；
//      租约失效（renew 失败 → leaseLost → abort、finally releaseLease、工具面
//      leaseCurrent 闸、终态回退 cancel 经门面）钉。
//   C5 验收④三形态同用例覆盖：worker / server 循环 / CronJob 三形态到同一
//      用例的结构断言（同一 sweep 函数、同一 /internal/routines/run 合同、
//      同一 governedHeadlessTurnFor 工厂、同一门面）+ 冻结普查表（本文件
//      BACKGROUNND_ENTRY_CENSUS 为 reports/MOD14-report.md §1 表的可执行孪生，
//      逐行 marker 断言）。
//   C6 存量对照：Automation 族套件两树对照与复跑见 reports/mod14-verification/
//      （基线侧=干净树 @ d4e6140c5 首跑，实施侧=同树复跑+独立复跑，命令与退出
//      码全表=其 commands.md），不在本文件内。
//
// 运行层（ADR 0008）：import 自 e2e-compat——根 e2e 入口 Node target 原生收集
// （native 桶），不依赖 Bun 运行时、不触真实数据库：门面/装配组合用注入替身
// 证明（替身证明的正是委托本身）；幂等/栅栏/竞争/重投递的事务语义以源级结构
// 断言钉住形状，真实 PG/RLS 与 governed turn 的真引擎行为由存量套件两树对照
// 钉住（reports/mod14-verification/；MOD07/13 同法——run-lifecycle-public 与
// approval-resume-public 先例）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../../tests/support/e2e-compat";
import type {
  CancelRunInput,
  PlatformScope,
  RunDTO,
  RunService,
  TrustedRunAdmission,
} from "../../src/enterprise/contracts";
import type { ExpertVersionRef } from "../../src/enterprise/experts/version-catalog";
import { createRunLifecyclePublic } from "../../src/enterprise/runs/public";
import {
  requestBoundModelRouteFor,
  runWithBoundModelRoute,
} from "../../src/enterprise/runs/runner";

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function sourceOf(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    "utf8",
  );
}

/** 剥掉 // 行注释与块注释后的源码（结构断言不被注释文本干扰）。行注释先剥：
 * 一行行注释里出现的块注释起始记号（如 "/api/" 之后的星号斜杠形态）若先交给
 * 块注释正则，会把从这里到下一个结束记号之间的真实代码一并吞掉
 * （assembly/http.ts 的派发行即踩此坑）。 */
function codeOf(relative: string): string {
  return sourceOf(relative)
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 源文件中某锚点串的出现次数（0=缺席）。 */
function countOf(relative: string, needle: string): number {
  return sourceOf(relative).split(needle).length - 1;
}

const SCOPE: PlatformScope = {
  tenantId: "tenant-1",
  workspaceId: "ws-1",
  principalId: "principal-1",
  actorId: "person-1",
  entrypoint: "schedule",
};

/** 受治理后台回合的准入（entrypoint=schedule——非 attended web 面）。 */
const ADMISSION: TrustedRunAdmission = {
  input: {
    threadId: "thread-1",
    clientMessageKey: "routine-adv:routine-1:routine-1:2026-10-26T01:00Z",
    messageDigest: "digest-server",
    attachmentRefs: [],
    entrypoint: "schedule",
    forwardedProps: { maxOutputTokens: 8192 },
  },
  agentId: "bot-1",
  expertVersionRef: "expert:v1:stub-server-ref" as ExpertVersionRef,
  routeRef: "route-ref-server",
};

const RUN_DTO: RunDTO = {
  run_id: "run-server",
  thread_id: "thread-1",
  status: "queued",
  created_at: "2026-10-26T01:00:00.000Z",
} as unknown as RunDTO;

/**
 * 全量 RunService 录音替身：start 在被调时刻读请求本地路由绑定（证明绑定在
 * start 调用期间存活），每个成员记录实参并返回稳定实例；引擎面成员（lease/
 * complete/fail/suspension）原样记录，供组合面透传断言用。
 */
function recordingRuns() {
  const calls: Array<{ capability: string; args: unknown[] }> = [];
  const routesSeen: Array<{ routeRef: string; maximumTokens: number }> = [];
  const lease = {
    runId: RUN_DTO.run_id,
    attemptId: "attempt-1",
    generation: 1,
    ownerToken: "owner-1",
    expiresAt: new Date(Date.now() + 60_000),
  };
  const runs: RunService = {
    async start(scope, admission) {
      calls.push({ capability: "start", args: [scope, admission] });
      // The route binding is only live when the caller wrapped this call
      // (runWithBoundModelRoute); absent is legal here, so probe tolerantly.
      try {
        const route = await requestBoundModelRouteFor(
          scope,
          admission.input.threadId,
        );
        routesSeen.push(route);
      } catch {
        // unbound context — the plain-facade tests run exactly like this
      }
      return RUN_DTO;
    },
    async get() {
      calls.push({ capability: "get", args: [] });
      return RUN_DTO;
    },
    async getActiveForThread() {
      calls.push({ capability: "getActiveForThread", args: [] });
      return null;
    },
    async cancel(scope, input) {
      calls.push({ capability: "cancel", args: [scope, input] });
      return RUN_DTO;
    },
    async stop(scope, input) {
      calls.push({ capability: "stop", args: [scope, input] });
      return RUN_DTO;
    },
    async acquireRequestLease(scope, runId) {
      calls.push({ capability: "acquireRequestLease", args: [scope, runId] });
      return lease;
    },
    async renewRequestLease(scope, input) {
      calls.push({ capability: "renewRequestLease", args: [scope, input] });
      return lease;
    },
    async releaseRequestLease(scope, input) {
      calls.push({ capability: "releaseRequestLease", args: [scope, input] });
      return true;
    },
    async fail(scope, input) {
      calls.push({ capability: "fail", args: [scope, input] });
      return true;
    },
    async complete(scope, input) {
      calls.push({ capability: "complete", args: [scope, input] });
      return true;
    },
    async getActiveAttemptGeneration(scope, runId, attemptId) {
      calls.push({
        capability: "getActiveAttemptGeneration",
        args: [scope, runId, attemptId],
      });
      return 1;
    },
    async markRunSuspended(scope, input) {
      calls.push({ capability: "markRunSuspended", args: [scope, input] });
      return true;
    },
    async reactivateSuspensionLease(scope, runId) {
      calls.push({
        capability: "reactivateSuspensionLease",
        args: [scope, runId],
      });
      return {
        lease,
        modelRouteRef: "route-ref-server",
        maximumTokens: 8192,
        settledTokens: 0,
      };
    },
    async reserveModelBudget(scope, input) {
      calls.push({ capability: "reserveModelBudget", args: [scope, input] });
      return { reservationId: "res-1" } as never;
    },
    async issueModelInvocationCapability() {
      throw new Error("UNUSED_IN_THIS_SUITE");
    },
    async resolveModelInvocationCapability() {
      throw new Error("UNUSED_IN_THIS_SUITE");
    },
    async confirmModelInvocationUsage() {
      throw new Error("UNUSED_IN_THIS_SUITE");
    },
    async markModelInvocationUnknown() {
      throw new Error("UNUSED_IN_THIS_SUITE");
    },
    async releaseModelInvocation() {
      throw new Error("UNUSED_IN_THIS_SUITE");
    },
  };
  return { calls, routesSeen, runs };
}

/**
 * 装配组合面的可执行孪生：与 runtime.ts 的 governedHeadlessRunsFace 同形
 * （源级钉在 C1 结构断言里逐字节核对）——门面实例 + start 包
 * runWithBoundModelRoute + cancel 经门面 + 引擎面原样展开。
 */
function composedUnattendedFace(runs: RunService) {
  const lifecycle = createRunLifecyclePublic({ runs });
  return {
    lifecycle,
    face: {
      ...runs,
      start: (scope: PlatformScope, admission: TrustedRunAdmission) =>
        runWithBoundModelRoute(
          {
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
            actorId: scope.actorId,
            threadId: admission.input.threadId,
            agentId: admission.agentId,
            routeRef: admission.routeRef,
            maximumTokens: admission.input.forwardedProps
              .maxOutputTokens as number,
          },
          () => lifecycle.start(scope, admission),
        ),
      cancel: (scope: PlatformScope, input: CancelRunInput) =>
        lifecycle.cancel(scope, input),
    } as RunService,
  };
}

// ---------------------------------------------------------------------------
// C1 统一消费等价（Brief C1：迁移前后同触发 → 同 Run 事实）
// ---------------------------------------------------------------------------

describe("C1 unified consumption: the unattended Run faces go through the M05 public facade", () => {
  test("facade delegation equivalence — identical (scope, admission) objects in, identical RunDTO out (start/cancel)", async () => {
    const { calls, runs } = recordingRuns();
    const lifecycle = createRunLifecyclePublic({ runs });
    const started = await lifecycle.start(SCOPE, ADMISSION);
    expect(started).toBe(RUN_DTO);
    expect(calls[0]?.capability).toBe("start");
    expect(calls[0]?.args[0]).toBe(SCOPE);
    expect(calls[0]?.args[1]).toBe(ADMISSION);
    const cancelInput: CancelRunInput = {
      runId: RUN_DTO.run_id,
      reason: "timeout",
    };
    const cancelled = await lifecycle.cancel(SCOPE, cancelInput);
    expect(cancelled).toBe(RUN_DTO);
    expect(calls[1]?.capability).toBe("cancel");
    expect(calls[1]?.args[0]).toBe(SCOPE);
    expect(calls[1]?.args[1]).toBe(cancelInput);
  });

  test("facade passes the internal service's error instance through untouched (a redelivery's convergence refusal is not re-wrapped)", async () => {
    const boom = new Error("RUN_IDEMPOTENCY_CONFLICT");
    const runs = recordingRuns().runs;
    const refusing: RunService = {
      ...runs,
      async start() {
        throw boom;
      },
    };
    const lifecycle = createRunLifecyclePublic({ runs: refusing });
    let caught: unknown = null;
    try {
      await lifecycle.start(SCOPE, ADMISSION);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(boom);
  });

  test("the composed unattended face: start reaches the internal service INSIDE the request-local model-route binding, exactly as the browser admit binds", async () => {
    const { calls, routesSeen, runs } = recordingRuns();
    const { face } = composedUnattendedFace(runs);
    const started = await face.start(SCOPE, ADMISSION);
    expect(started).toBe(RUN_DTO);
    expect(calls[0]?.args[0]).toBe(SCOPE);
    expect(calls[0]?.args[1]).toBe(ADMISSION);
    // The binding the wrapper declared is the one live during the internal call:
    expect(routesSeen.length).toBe(1);
    expect(routesSeen[0]?.routeRef).toBe(ADMISSION.routeRef);
    expect(routesSeen[0]?.maximumTokens).toBe(
      ADMISSION.input.forwardedProps.maxOutputTokens,
    );
    // …and only for the duration of the start call (request-local, not ambient):
    let ambient: unknown = null;
    try {
      await requestBoundModelRouteFor(SCOPE, ADMISSION.input.threadId);
    } catch (error) {
      ambient = error;
    }
    expect(String(ambient)).toContain("MODEL_ROUTE_CONTEXT_UNAVAILABLE");
  });

  test("the composed unattended face: cancel routes through the facade; engine members pass through the spread untouched", async () => {
    const { calls, runs } = recordingRuns();
    const { face } = composedUnattendedFace(runs);
    const cancelInput: CancelRunInput = {
      runId: RUN_DTO.run_id,
      reason: "timeout",
    };
    const cancelled = await face.cancel(SCOPE, cancelInput);
    expect(cancelled).toBe(RUN_DTO);
    expect(calls[0]?.capability).toBe("cancel");
    expect(calls[0]?.args[1]).toBe(cancelInput);
    // The internal worker/engine face is the SAME instances the spread carried
    // (acquireRequestLease etc. are not re-implemented on the composed face):
    expect(face.acquireRequestLease).toBe(runs.acquireRequestLease);
    expect(face.renewRequestLease).toBe(runs.renewRequestLease);
    expect(face.releaseRequestLease).toBe(runs.releaseRequestLease);
    expect(face.complete).toBe(runs.complete);
    expect(face.fail).toBe(runs.fail);
    expect(face.markRunSuspended).toBe(runs.markRunSuspended);
  });

  test("source pin: assembly builds exactly this face — one injection point, six governed entries, zero direct internal start", () => {
    const runtime = codeOf("../../src/assembly/runtime.ts");
    // The face is built from the facade, once, with the internal service:
    expect(runtime).toContain("const governedHeadlessRunsFace = (");
    expect(runtime).toContain("createRunLifecyclePublic({ runs });");
    // start delegates through the facade inside the same route binding wrapper:
    expect(runtime).toContain("() => lifecycle.start(scope, admission),");
    // the timeout-cancel terminal backstop goes through the facade too:
    expect(runtime).toContain(
      "cancel: (scope, input) => lifecycle.cancel(scope, input),",
    );
    // exactly one injection site feeds every governed entry:
    expect(
      countOf(
        "../../src/assembly/runtime.ts",
        "runs: governedHeadlessRunsFace(enterpriseRunner.runs),",
      ),
    ).toBe(1);
    // and the pre-MOD14 direct internal call is gone from the assembly:
    expect(runtime).not.toContain(
      "enterpriseRunner.runs.start(scope, admission)",
    );
  });

  test("source pin: six governed background entries share the one turn factory (the selector contract)", () => {
    expect(
      countOf("../../src/assembly/runtime.ts", "governedHeadlessTurnFor({"),
    ).toBe(6);
    const runtime = codeOf("../../src/assembly/runtime.ts");
    for (const selector of [
      "governedRoutineTurn ?? legacyRoutineTurn",
      "return governedResponsibilityTurn({",
      "governedDeliveryTurn ?? approvalContinuationRunner",
      "governedWakeUpTurn ??",
      "governedOpenMuseTaskTurn ??",
      "governedHandoffDelivery",
    ]) {
      expect(runtime).toContain(selector);
    }
  });
});

// ---------------------------------------------------------------------------
// C2 验收①重投递收敛（幂等现状钉）
// ---------------------------------------------------------------------------

describe("C2 acceptance 1: redelivering the same business work converges instead of minting a second Run", () => {
  test("the advance-intent key is deterministic in (entry, firing) and never a tenant/owner string", () => {
    const headless = codeOf("../../src/mastra/headless.ts");
    // The plain form is pinned by template (ME09's own tests assert it literally):
    expect(headless).toContain(`\`routine-adv:\${routineId}:\${firingId}\``);
    // …and the capped sha256 form keeps the key under the conversation cap:
    expect(headless).toContain("routine-adv:sha256:");
    // The key is derived from the record's own ids, never a queue identity:
    expect(headless).toContain(
      "const clientMessageKey = governedFiringIntentKey(input.routineId, firingId);",
    );
    // A manual click (no firing key) mints its own intent — it is its own turn:
    expect(headless).toContain(`\`manual-\${crypto.randomUUID()}\``);
  });

  test("the submitted message lands first, idempotent on the intent key — the browser runner's order", () => {
    const headless = codeOf("../../src/mastra/headless.ts");
    expect(headless).toContain("await deps.conversations.append(scope, {");
    expect(headless).toContain("clientMessageKey,");
  });

  test("the second delivery's runs.start refuses on the durable conflict, and the turn surfaces the named convergence refusal", () => {
    // Store: same (tenant, thread, clientMessageKey) prior submission → 409 conflict:
    const store = codeOf("../../src/enterprise/runs/store.ts");
    expect(store).toContain('"RUN_IDEMPOTENCY_CONFLICT",');
    expect(store).toContain(
      "eq(enterpriseRuns.clientMessageKey, input.clientMessageKey),",
    );
    // Headless turn: the conflict IS the duplicate-delivery convergence:
    const headless = codeOf("../../src/mastra/headless.ts");
    expect(headless).toContain(
      "run = await deps.runs.start(scope, admission);",
    );
    expect(headless).toContain("ROUTINE_INTENT_ALREADY_ADVANCED");
    // Routine runner: a converged redelivery is skipped, never a failure the
    // fatigue rule could read as the routine failing:
    const runner = codeOf("../../src/routines/runner.ts");
    expect(runner).toContain(
      "GOVERNED_HEADLESS_REFUSALS.intentAlreadyAdvanced",
    );
    expect(runner).toContain(
      'await routineStore.finishRun(routineRunId, "skipped", error.message);',
    );
  });

  test("queue side: the offer key carries the due minute, and a duplicate offer is the same row, not new work", () => {
    const sweep = codeOf("../../src/routines/sweep.ts");
    expect(sweep).toContain(
      `key: \`\${routine.id}:\${minuteKey(routine.nextRunAt)}\`,`,
    );
    const queue = codeOf("../../src/work/queue.ts");
    expect(queue).toContain(".onConflictDoNothing()");
  });

  test("every governed entry keys its own advance intent from its persistent record id", () => {
    const runtime = codeOf("../../src/assembly/runtime.ts");
    // Responsibility: the run row IS the record and the intent (one advance per run):
    expect(runtime).toContain("routineId: context.runId,");
    expect(runtime).toContain("runId: context.runId,");
    // Delivery: the inbox row id is the intent (one answer per inbound message):
    expect(runtime).toContain(`routineId: \`delivery:\${input.runId}\`,`);
    // Wake-up: the work item key is the intent, in the wake-up module itself:
    expect(codeOf("../../src/agents/wake-up.ts")).toContain(
      `routineId: \`follow-up:\${item.key}\`,`,
    );
    expect(codeOf("../../src/agents/wake-up.ts")).toContain("runId: item.key,");
  });
});

// ---------------------------------------------------------------------------
// C3 验收②领取/重试/恢复从持久事实重建资格和 Payer
// ---------------------------------------------------------------------------

describe("C3 acceptance 2: claim/retry/resume rebuild eligibility and Payer from persistent facts", () => {
  test("the scheduling record is the authorization — re-read at the moment of running, never the queue payload", () => {
    const headless = codeOf("../../src/mastra/headless.ts");
    expect(headless).toContain(
      "const record = await deps.schedulingRecordFor(input.routineId);",
    );
    expect(headless).toContain("ROUTINE_SCHEDULING_RECORD_GONE");
    // A firing whose caller disagrees with the record is not this firing:
    expect(headless).toContain("input.threadId !== record.threadId ||");
    expect(headless).toContain("ROUTINE_FIRING_CONTEXT_MISMATCH");
    // A switched-off entry does not out-authorize the switch:
    expect(headless).toContain("if (!record.enabled) {");
  });

  test("the scope is re-issued from the directory NOW — a queue string is not an identity", () => {
    const headless = codeOf("../../src/mastra/headless.ts");
    expect(headless).toContain("const scope = await deps.scopeFor({");
    const runtime = codeOf("../../src/assembly/runtime.ts");
    // The shared resolver: a fresh Request per call, entrypoint "schedule",
    // membership decided by the directory, tenancy by the conversation row:
    expect(runtime).toContain("resolveForThread(request, input.threadId);");
    expect(runtime).toContain('entrypoint: "schedule" as const');
  });

  test("the budget is explicit and server-side; the Payer is the admitted scope's own principal", () => {
    const headless = codeOf("../../src/mastra/headless.ts");
    expect(headless).toContain("GOVERNED_HEADLESS_REFUSALS.budgetUnconfigured");
    // The reservation is booked against the trusted scope inside the start
    // transaction — the payer is fixed by the admission, not the trigger:
    const service = codeOf("../../src/enterprise/runs/service.ts");
    expect(service).toContain("reserveModelBudgetInTransaction(");
    const store = codeOf("../../src/enterprise/runs/store.ts");
    expect(store).toContain("principalId: scope.principalId,");
  });

  test("each governed entry's durable record is its own persistent row, re-read per firing", () => {
    const runtime = codeOf("../../src/assembly/runtime.ts");
    // Routine: the routine row, through the channel the owner's thread resolves to:
    expect(runtime).toContain("routineStore.recordForFiring(routineId)");
    // Responsibility: the run+goal+event rows joined NOW; only an actively
    // driven run may advance:
    expect(runtime).toContain(
      'enabled: row.goalStatus === "active" && row.runStatus === "running",',
    );
    // Delivery: the inbox row; a terminal inbox is a closed delivery:
    expect(runtime).toContain(
      'enabled: !["failed", "opted_out"].includes(row.state),',
    );
    // Wake-up: the work item row; a finished item never fires again:
    expect(runtime).toContain("enabled: !row.finishedAt,");
  });

  test("resume rebuilds from persistent facts: re-signed scope at decision time, the MOD13 group, the binding-currency gate", () => {
    const runtime = codeOf("../../src/assembly/runtime.ts");
    // The approval drive re-signs the scope when the decision arrives:
    expect(runtime).toContain("const scope = await governedHeadlessScopeFor({");
    // …and consumes the waiting/resume faces only through the MOD13 group:
    expect(runtime).toContain("runContinuations.waitingContinuations(scope)");
    expect(runtime).toContain("runContinuations.resumeContinuation({");
    // The resumed lease must be the same attempt/generation the continuation binds:
    const headless = codeOf("../../src/mastra/headless.ts");
    expect(headless).toContain("assertResumeBindingCurrent(");
  });

  test("queue claim/retry reads the database's rows and the database's clock, never a payload cache", () => {
    const queue = codeOf("../../src/work/queue.ts");
    expect(queue).toContain("for update skip locked");
    expect(queue).toContain("sql`now() + make_interval(");
    // renew/finish/release ask "still ours?" — a lost lease cannot finish
    // somebody else's item:
    expect(queue).toContain("eq(workItems.claimedBy, owner),");
  });
});

// ---------------------------------------------------------------------------
// C4 验收③触发语义保持 + 暂停与租约失效可证
// ---------------------------------------------------------------------------

describe("C4 acceptance 3: trigger semantics stay in the Automation modules; pause and lease-loss stay provable", () => {
  test("the trigger semantics own their module files (kinds and scheduling policy are defined once, in-module)", () => {
    // The five modules' own constants are the single definitions:
    expect(codeOf("../../src/routines/sweep.ts")).toContain(
      'export const ROUTINE_FIRE_KIND = "routine.fire";',
    );
    expect(codeOf("../../src/routines/schedule.ts")).toContain(
      "export const MINIMUM_INTERVAL_MS",
    );
    expect(codeOf("../../src/responsibilities/engine.ts")).toContain(
      'export const RESPONSIBILITY_RUN_KIND = "responsibility.run";',
    );
    expect(codeOf("../../src/delivery/router.ts")).toContain(
      "export const DELIVERY_WORK_KINDS",
    );
    expect(codeOf("../../src/proactive/engine.ts")).toContain(
      'export const PROACTIVE_RUN_KIND = "proactive.run";',
    );
    expect(codeOf("../../src/agents/wake-up.ts")).toContain(
      'export const WAKE_UP_KIND = "bot.wakeup";',
    );
    // The consumers import the constants; the assembly defines no second copy:
    expect(countOf("../../src/assembly/runtime.ts", "ROUTINE_FIRE_KIND")).toBe(
      0,
    );
    expect(
      countOf("../../../worker/src/index.ts", "ROUTINE_FIRE_KIND"),
    ).toBeGreaterThanOrEqual(1);
  });

  test("pause paths refuse by name on every layer that can meet them", () => {
    // The governed turn: a switched-off record is a gone record:
    expect(codeOf("../../src/mastra/headless.ts")).toContain(
      "a queued firing does not out-authorize the switch",
    );
    // The routine runner: paused never runs, checked at the moment of running,
    // and skipped so the fatigue rule never counts a pause:
    const runner = codeOf("../../src/routines/runner.ts");
    expect(runner).toContain("if (context.enabled === false) {");
    expect(runner).toContain("BOT_PAUSED_REASON");
    // Delivery: an opted-out binding is a closed delivery:
    expect(codeOf("../../src/delivery/router.ts")).toContain("optedOutAt");
  });

  test("lease loss is fenced: renewal failure aborts the turn, the lease returns on every exit, the tools probe before every new external call", () => {
    const headless = codeOf("../../src/mastra/headless.ts");
    expect(headless).toContain("leaseLost = true;");
    expect(headless).toContain("leaseCurrent: async () => {");
    // Released exactly once per turn, on every exit path:
    expect(headless).toContain("releaseLease();");
    expect(headless).toContain("input.signal?.removeEventListener(");
    // The headless turn's own terminal backstop stays the runs cancel the
    // composed face now routes through the facade (three call sites: the
    // acquire-failure backstop, the settle-failure fallback, and the
    // completion-settlement fallback):
    expect(
      countOf(
        "../../src/mastra/headless.ts",
        '.cancel(scope, { runId: run.run_id, reason: "timeout" })',
      ),
    ).toBe(3);
    expect(codeOf("../../src/assembly/runtime.ts")).toContain(
      "cancel: (scope, input) => lifecycle.cancel(scope, input),",
    );
  });
});

// ---------------------------------------------------------------------------
// C5 验收④三形态同用例覆盖（结构断言 + 冻结普查表）
// ---------------------------------------------------------------------------

/**
 * 冻结普查表（reports/MOD14-report.md §1 的可执行孪生；marker 为各形态文件中
 * 逐一断言存在的锚点）。处置三值：unified（经门面，本票 A）/ retained（保留
 * 臂：legacy Intelligence 面或引擎内件，具名登记）/ no-run（无 Run 触达）。
 */
const BACKGROUND_ENTRY_CENSUS: ReadonlyArray<{
  id: string;
  form: "worker" | "server-loop" | "cronjob" | "sync-http";
  file: string;
  marker: string;
  disposition: "unified" | "retained" | "no-run" | "out-of-scope";
}> = [
  {
    id: "E01 routine firing (scheduled)",
    form: "worker",
    file: "../../../worker/src/index.ts",
    marker: "dispatchClaimedRoutines,",
    disposition: "unified",
  },
  {
    id: "E01 routine firing (scheduled, CronJob arm)",
    form: "cronjob",
    file: "../../scripts/fire-routines.ts",
    marker: "offerDueRoutines(options);",
    disposition: "unified",
  },
  {
    id: "E02 routine manual run-now",
    form: "sync-http",
    file: "../../src/routines/routes.ts",
    marker: "void runner.run(runId).catch(() => {});",
    disposition: "unified",
  },
  {
    id: "E03 responsibility advance",
    form: "server-loop",
    file: "../../src/responsibilities/engine.ts",
    marker: "async dispatch(input: {",
    disposition: "unified",
  },
  {
    id: "E04 approval-decision resume (governed)",
    form: "server-loop",
    file: "../../src/enterprise/runs/continuations.ts",
    marker: "export interface RunContinuations {",
    disposition: "retained",
  },
  {
    id: "E05 delivery inbound",
    form: "server-loop",
    file: "../../src/delivery/router.ts",
    marker: "async sweep(kind: DeliveryWorkKind) {",
    disposition: "unified",
  },
  {
    id: "E06 delivery outbound",
    form: "server-loop",
    file: "../../src/delivery/push.ts",
    marker: "export function createExpoPushTransport(",
    disposition: "no-run",
  },
  {
    id: "E07 proactive research",
    form: "server-loop",
    file: "../../src/proactive/engine.ts",
    marker: "async sweep() {",
    disposition: "retained",
  },
  {
    id: "E08 bot wake-up",
    form: "server-loop",
    file: "../../src/agents/wake-up.ts",
    marker: 'export const WAKE_UP_KIND = "bot.wakeup";',
    disposition: "unified",
  },
  {
    id: "E09 openmuse task",
    form: "server-loop",
    file: "../../src/openmuse-tasks/runner.ts",
    marker: "createOpenMuseTaskRunner",
    disposition: "unified",
  },
  {
    id: "E10 handoff hop delivery",
    form: "server-loop",
    file: "../../src/mastra/handoff-delivery.ts",
    marker: "createGovernedHandoffDelivery",
    disposition: "unified",
  },
  {
    id: "E11 person response resume",
    form: "server-loop",
    file: "../../src/approvals/question-resume.ts",
    marker: 'routineId: "person-response",',
    disposition: "retained",
  },
  {
    id: "E12 group conversation turns",
    form: "server-loop",
    file: "../../src/assembly/runtime.ts",
    marker: "const groupConversations = createGroupConversations({",
    disposition: "retained",
  },
  {
    id: "E13 memory/hindsight maintenance",
    form: "server-loop",
    file: "../../src/assembly/runtime.ts",
    marker: "hindsightSyncQueue.drain()",
    disposition: "no-run",
  },
  {
    id: "E14 channel summaries",
    form: "server-loop",
    file: "../../src/assembly/runtime.ts",
    marker: "summariseClaimedChannels(channelSummaries)",
    disposition: "no-run",
  },
  {
    id: "E15 audit retention",
    form: "server-loop",
    file: "../../src/audit-retention.ts",
    marker: "setInterval",
    disposition: "no-run",
  },
  {
    id: "E16 idle computer culler",
    form: "cronjob",
    file: "../../src/work/culler.ts",
    marker: 'export const CULL_KIND = "computer.suspend";',
    disposition: "no-run",
  },
  {
    id: "E17 staged attachment culler",
    form: "cronjob",
    file: "../../scripts/cull-staged-attachments.ts",
    marker: "cullStagedAttachments",
    disposition: "no-run",
  },
  {
    id: "E18 craft scheduled tasks",
    form: "server-loop",
    file: "../../src/craft/scheduled-tasks.ts",
    marker: "export function computeNextRunAt(",
    disposition: "out-of-scope",
  },
  {
    id: "E19 workshop schedules",
    form: "cronjob",
    file: "../../src/workshop/schedule-executor.ts",
    marker: "sweepWorkshopSchedules",
    disposition: "out-of-scope",
  },
];

describe("C5 acceptance 4: worker, server loop and CronJob reuse the same use case; every enabled entry is covered", () => {
  test("the frozen census is pinned: every entry's marker exists in its file", () => {
    // 20 rows: the report's 19 entries with E01's two forms (worker + CronJob)
    // pinned separately, since acceptance 4 names the forms.
    expect(BACKGROUND_ENTRY_CENSUS.length).toBe(20);
    const seen = new Set<string>();
    for (const entry of BACKGROUND_ENTRY_CENSUS) {
      expect(seen.has(entry.id)).toBe(false);
      seen.add(entry.id);
      const code = codeOf(entry.file);
      expect(code).toContain(entry.marker);
    }
  });

  test("worker form and CronJob form run the SAME sweep halves and the SAME dispatch contract", () => {
    const worker = codeOf("../../../worker/src/index.ts");
    const cronjob = codeOf("../../scripts/fire-routines.ts");
    for (const half of ["offerDueRoutines", "dispatchClaimedRoutines"]) {
      expect(worker).toContain(half);
      expect(cronjob).toContain(half);
    }
    // Both dispatch over the server's internal route with the shared secret,
    // and treat anything but 202 as the failure to hand the run over:
    expect(worker).toContain("routineRunUrl(serverInternalUrl)");
    expect(worker).toContain(`Bearer \${workerSharedSecret}`);
    expect(cronjob).toContain(`\${serverInternalUrl}/internal/routines/run`);
    expect(cronjob).toContain(`Bearer \${workerSharedSecret}`);
    expect(worker).toContain("rather than 202 when handed a routine run");
    expect(cronjob).toContain("rather than 202 when handed a routine run");
  });

  test("all three forms converge on one server-side use case: the internal route hands the runner the run id, the runner's turn goes through the shared governed factory and the facade", () => {
    const http = codeOf("../../src/assembly/http.ts");
    expect(http).toContain(
      'app.post("/internal/routines/run", async (context) => {',
    );
    expect(http).toContain("routineRunner.run(routineRunId, firing),");
    const runtime = codeOf("../../src/assembly/runtime.ts");
    // The runner the route hands to is the one whose turn selection is the
    // shared governed factory (C1 pins its runs face to the facade):
    expect(runtime).toContain(
      "runTurn: governedRoutineTurn ?? legacyRoutineTurn",
    );
    // The server-loop form consumes the SAME factory for its own entries:
    expect(runtime).toContain("const responsibilitySweep = repeatAfterEach(");
    expect(runtime).toContain(
      "const deliverySweeps = DELIVERY_WORK_KINDS.map(",
    );
    expect(runtime).toContain("const wakeUpSweep = repeatAfterEach(");
    expect(runtime).toContain("const openMuseTaskSweep = repeatAfterEach(");
  });

  test("retained arms are named, not silent: the legacy selectors stay explicit per entry", () => {
    const runtime = codeOf("../../src/assembly/runtime.ts");
    // Proactive/group/person-response keep the legacy Intelligence turn (no
    // governed selector exists for them — migrating would be new turn code):
    expect(runtime).toContain(
      "const proactiveEngine = createProactiveEngine({",
    );
    expect(
      countOf(
        "../../src/assembly/runtime.ts",
        "runTurn: approvalContinuationRunner,",
      ),
    ).toBeGreaterThanOrEqual(1);
    // The approval continuation's governed drive is the MOD13 group, with the
    // legacy resume as the explicit fallback for legacy parkings:
    expect(runtime).toContain("if (governedApprovalContinuationDrive) {");
    expect(runtime).toContain("approvalService.resume(");
  });
});

// ---------------------------------------------------------------------------
// C6 存量 Automation 套件两侧对照（执行证据不在本文件——见文件头 C6 注与
// reports/mod14-verification/commands.md；此处钉两侧对照的对象面=五模块+worker
// +governed turn 的既有套件清单在树且被 e2e 分区收编）。
// ---------------------------------------------------------------------------

describe("C6 legacy-suite comparison: the compared corpus exists and is scheduled by the e2e partition", () => {
  test("the automation suites this ticket compares two-tree are present in the tree", () => {
    for (const file of [
      "../../tests/routine-runner.test.ts",
      "../../tests/routine-sweep.integration.test.ts",
      "../../tests/routine-run-now.integration.test.ts",
      "../../tests/responsibilities-engine.test.ts",
      "../../tests/responsibility-triggers.test.ts",
      "../../tests/proactive.test.ts",
      "../../tests/delivery-router.test.ts",
      "../../tests/delivery-turn.test.ts",
      "../../tests/work-loop.test.ts",
      "../../tests/work-queue.integration.test.ts",
      "../../tests/mastra-headless.test.ts",
    ]) {
      expect(sourceOf(file).length).toBeGreaterThan(0);
    }
  });

  test("the governed-turn suite and the worker assembly suite are on the e2e partition (driven layer), this suite is native", () => {
    const manifest = sourceOf("../../../tests/config/e2e-bun-suites.json");
    expect(manifest).toContain("server/tests/mastra-headless.test.ts");
    expect(manifest).toContain("server/tests/work-queue.integration.test.ts");
    // This file stays native: it imports the e2e-compat layer only (ADR 0008),
    // so it must NOT appear on the driven manifest:
    expect(manifest).not.toContain(
      "server/tests/multitenancy/automation-runs-public.test.ts",
    );
  });
});
