// server/tests/multitenancy/runs-protocol.test.ts
// MT048（Issue #91）：运行协议环节的归属——委托、能力、步骤、事件、恢复与取消。
//
// 验收事实源（票面 4 条 AC，逐条对应 describe）：
//   AC1 运行创建、步骤执行与事件回传都携带并校验同一归属；缺失归属时拒绝执行。
//   AC2 恢复只在原归属范围内允许；用另一范围的身份恢复被拒绝。
//   AC3 取消传播到执行中的步骤与外部执行，且已产生事件不推送给无权订阅者。
//   AC4 外部线程上下文按持久记录解析归属，不接受请求体指定。
//
// 两层结构（execution-artifacts 先例）：协议面用真实 PostgreSQL（受限
// ob_ent_* 角色 + 真实 RLS；缺显式 env 整套显式 skip，绝不回退开发库，
// skipped 不计通过）。同一真人拥有两个公司的成员身份（company-a/team-a1
// + company-b/team-b1），全部经真实 provisionDeployment + 真实
// createScopeResolver 签发（MT005 门槛的 workspace_memberships 行按
// fixture.ts 先例经受限 operator 通道插入）。run/事件/能力全部走真实
// RunService + EventService（真实租约栅栏与归属三比 WHERE）；取消传播的
// 两个 seam（在途步骤、外部执行面）用记录型替身——它们的授权语义分别是
// runner 的 relay 纪律与 #90 的 19 用例套件，本套件验证的是协议层把正确
// 的归属交给它们、且异 scope 的取消一个 seam 都不触达。

import { randomUUID } from "node:crypto";
import { like, sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createDatabase, type Database } from "../../src/db/client";
import {
  enterpriseConversations,
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseRunAttempts,
  enterpriseRuns,
  enterpriseSecurityEvents,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../src/db/schema";
import { users } from "../../src/db/schema/core";
import type {
  EventProposal,
  PlatformScope,
  StartRunInput,
  TrustedRunAdmission,
} from "../../src/enterprise/contracts";
import { createConversationService } from "../../src/enterprise/conversations/service";
import { createConversationStore } from "../../src/enterprise/conversations/store";
import { ExpertVersionCatalog } from "../../src/enterprise/experts/version-catalog";
import {
  createDrizzleRunnerEventRepository,
  createRunnerEventService,
} from "../../src/enterprise/runs/events";
import { createRunService } from "../../src/enterprise/runs/service";
import type {
  DataDatabase,
  DirectoryDatabase,
  OperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import {
  provisionDeployment,
  suspendMembership,
} from "../../src/enterprise/tenancy/provision";
import { createRevocationGuard } from "../../src/enterprise/tenancy/revocation";
import {
  createRunsProtocolService,
  type ExecutionCancellationSeam,
  type ProtocolStepsSeam,
} from "../../src/enterprise/tenancy/runs-protocol";
import {
  type AuthenticatedRequestIdentity,
  createScopeResolver,
} from "../../src/enterprise/tenancy/store";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const setup =
    process.env.ENTERPRISE_TEST_SETUP_DATABASE_URL ??
    process.env.TEST_DATABASE_URL;
  if (!setup?.trim()) {
    return {
      ok: false,
      reason: "ENTERPRISE_TEST_SETUP_DATABASE_URL/TEST_DATABASE_URL not set",
    };
  }
  for (const role of ["DIRECTORY", "DATA", "OPERATOR"] as const) {
    if (!process.env[`ENTERPRISE_TEST_${role}_DATABASE_URL`]?.trim()) {
      return {
        ok: false,
        reason: `ENTERPRISE_TEST_${role}_DATABASE_URL not set`,
      };
    }
  }
  return { ok: true };
}

const ENV = probeEnvironment();
const describeDb = ENV.ok ? describe : describe.skip;

const prefix = `mt048-${randomUUID().slice(0, 8)}`;
const actorId = `${prefix}-actor`;
const tenantA = `${prefix}-company-a`;
const workspaceA1 = `${prefix}-team-a1`;
const principalA = `${prefix}-principal-a`;
const tenantB = `${prefix}-company-b`;
const workspaceB1 = `${prefix}-team-b1`;
const syntheticExpertAgentId = "mt048-synthetic-bot";
const syntheticRouteRef = "mt048-synthetic-route";

let setupDatabase: Database | undefined;
let directoryDatabase: DirectoryDatabase | undefined;
let dataDatabase: DataDatabase | undefined;
let operatorDatabase: OperatorDatabase | undefined;
let scopeA: PlatformScope;
let scopeB: PlatformScope;
let forgedScopeB: PlatformScope;
let conversations: ReturnType<typeof createConversationService>;
let expertVersions: ExpertVersionCatalog;
let expertVersionRef: TrustedRunAdmission["expertVersionRef"];
let protocol: ReturnType<typeof createRunsProtocolService>;
let runs: ReturnType<typeof createRunService>;
let resolver: ReturnType<typeof createScopeResolver>;
/** resolveForThread 的请求身份表（与 runs.integration 同款 WeakMap seam）。 */
const authenticated = new WeakMap<Request, AuthenticatedRequestIdentity>();

/** 记录型步骤 seam：AC3 的「取消传播到执行中的步骤」对着它断言。 */
const abortedSteps: string[] = [];
const stepsSeam: ProtocolStepsSeam = {
  abort(runId) {
    if (abortedSteps.includes(runId)) return false;
    abortedSteps.push(runId);
    return true;
  },
};

/** 记录型外部执行面 seam：#90 的判定是它自己的套件；这里记录协议层交给它的归属。 */
const propagationCalls: Array<{
  scope: PlatformScope;
  botId: string;
  runId?: string;
}> = [];
const executionSeam: ExecutionCancellationSeam = {
  async cancelExecution(scope, botId, input) {
    propagationCalls.push({
      scope,
      botId,
      ...(input?.runId !== undefined ? { runId: input.runId } : {}),
    });
    return { outcome: "allow", attempts: [] };
  },
};

function setupDb() {
  setupDatabase ??= createDatabase(enterpriseTestDatabaseUrlFrom(), { max: 4 });
  return setupDatabase;
}

function openRuntimeDatabase(role: "directory"): Promise<DirectoryDatabase>;
function openRuntimeDatabase(role: "data"): Promise<DataDatabase>;
function openRuntimeDatabase(role: "operator"): Promise<OperatorDatabase>;
async function openRuntimeDatabase(role: "directory" | "data" | "operator") {
  const url = enterpriseRuntimeDatabaseUrlFrom(role);
  const database = createDatabase(url, { max: 3 });
  try {
    if (role === "directory") return await verifyDirectoryDatabase(database);
    if (role === "data") return await verifyDataDatabase(database);
    return await verifyOperatorDatabase(database);
  } catch (error) {
    await database.$client.close();
    throw error;
  }
}

/** 受限 operator 通道种 workspace_memberships（MT005 门槛，fixture.ts 先例）。 */
async function materializeTeamMembership(
  tenantId: string,
  workspaceId: string,
  principalId: string,
) {
  const operator = operatorDatabase!;
  await operator.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${tenantId}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_workspace_memberships (tenant_id, workspace_id, principal_id) values (${tenantId}, ${workspaceId}, ${principalId})`,
    );
  });
}

/** 以指定身份/公司/团队签发受信 scope（真实 createScopeResolver）。 */
async function scopeFor(
  tenantId: string,
  workspaceId: string,
): Promise<PlatformScope> {
  const request = new Request("https://mt048.example.invalid/scope", {
    headers: {
      "x-openbot-tenant": tenantId,
      "x-openbot-workspace": workspaceId,
    },
  });
  authenticated.set(request, { actorId, entrypoint: "web" });
  return resolver.resolve(request);
}

async function seedPlatformConversation(
  scope: PlatformScope,
  seedThreadId: string,
) {
  const [seededConversation] = await createConversationStore(
    dataDatabase!,
  ).transaction(scope, (tx) =>
    tx
      .insert(enterpriseConversations)
      .values({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        principalId: scope.principalId,
        threadId: seedThreadId,
        storageBackend: "platform",
        backendVersion: 1,
        lastSeq: 0,
      })
      .returning(),
  );
  if (!seededConversation)
    throw new Error("MT048_PLATFORM_FIXTURE_SEED_FAILED");
  return seededConversation;
}

/** 建线程 + 一条已回执消息 → 入场级 input（runs.integration 同款）。 */
async function admittedInput(
  scope: PlatformScope,
  label: string,
): Promise<TrustedRunAdmission> {
  const threadId = randomUUID();
  await seedPlatformConversation(scope, threadId);
  const conversation = await conversations.getOrCreate(scope, { threadId });
  const clientMessageKey = `${prefix}-${label}-${randomUUID().slice(0, 8)}`;
  await conversations.append(scope, {
    threadId: conversation.thread_id,
    clientMessageKey,
    content: `mt048 run input ${label}`,
    attachments: [],
  });
  const input: StartRunInput = {
    threadId: conversation.thread_id,
    clientMessageKey,
    messageDigest: `sha256:${"0".repeat(64)}`,
    attachmentRefs: [],
    entrypoint: scope.entrypoint,
    forwardedProps: { maxOutputTokens: 2000 },
  };
  return {
    input,
    agentId: syntheticExpertAgentId,
    expertVersionRef,
    routeRef: syntheticRouteRef,
  };
}

beforeAll(async () => {
  // 缺显式 env 的运行整套显式 skip：连接面一个都不打开（skipped 不计通过）。
  if (!ENV.ok) return;
  const setup = setupDb();
  const directory = await openRuntimeDatabase("directory");
  const data = await openRuntimeDatabase("data");
  const operator = await openRuntimeDatabase("operator");
  directoryDatabase = directory;
  dataDatabase = data;
  operatorDatabase = operator;

  // 同一真人在两个公司（跨公司身份，Spec §11 matrix 的 multi-company 类）。
  await setup.insert(users).values({
    id: actorId,
    email: `${actorId}@example.invalid`,
    name: "MT048 multi-company actor",
  });
  await setup
    .insert(enterprisePrincipals)
    .values({ id: principalA, userId: actorId });
  await provisionDeployment(operator, {
    operationId: `${prefix}-provision-a`,
    operator: principalA,
    tenant: { id: tenantA, name: "MT048 company A" },
    workspace: { id: workspaceA1, name: "MT048 team A1" },
    members: [
      { principalId: principalA, userId: actorId, role: "tenant_admin" },
    ],
    resources: [],
  });
  await provisionDeployment(operator, {
    operationId: `${prefix}-provision-b`,
    operator: principalA,
    tenant: { id: tenantB, name: "MT048 company B" },
    workspace: { id: workspaceB1, name: "MT048 team B1" },
    members: [
      { principalId: principalA, userId: actorId, role: "tenant_admin" },
    ],
    resources: [],
  });
  await materializeTeamMembership(tenantA, workspaceA1, principalA);
  await materializeTeamMembership(tenantB, workspaceB1, principalA);

  resolver = createScopeResolver(directory, {
    authenticate: async (request) => authenticated.get(request) ?? null,
    selectTenant: (request) => request.headers.get("x-openbot-tenant"),
    selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
    data,
  });
  scopeA = await scopeFor(tenantA, workspaceA1);
  scopeB = await scopeFor(tenantB, workspaceB1);
  // 手造同形 scope：字段与 scopeB 完全一致，但没经过签发入口。
  forgedScopeB = Object.freeze({ ...scopeB });

  conversations = createConversationService({ data });
  expertVersions = new ExpertVersionCatalog(data);
  expertVersionRef = await expertVersions.putOrGet(scopeA, {
    schemaVersion: 1,
    agentId: syntheticExpertAgentId,
    source: "user_profile",
    agentType: "built_in",
    systemPrompt: "MT048 synthetic admission expert.",
    behaviorVersion: "openbot-builtin-v1",
  });
  runs = createRunService({
    data,
    conversations,
    expertVersions,
    modelRouteFor: async () => ({
      routeRef: syntheticRouteRef,
      maximumTokens: 1000,
    }),
    configuredBudgetTokens: () => 2000,
    modelCapabilitySecret:
      "mt048-test-only-model-capability-secret-0000000000000000000000",
  });
  const events = createRunnerEventService({
    repository: createDrizzleRunnerEventRepository(data),
    // MT007 撤权检查点：订阅面在读任何事件行之前重验两级成员资格。
    revocation: createRevocationGuard(data),
  });
  protocol = createRunsProtocolService({
    runs,
    events,
    revocation: createRevocationGuard(data),
    execution: executionSeam,
    steps: stepsSeam,
  });
});

afterAll(async () => {
  if (!ENV.ok) return;
  const failures: unknown[] = [];
  try {
    if (setupDatabase) {
      await setupDatabase
        .delete(enterpriseRunAttempts)
        .where(like(enterpriseRunAttempts.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseRuns)
        .where(like(enterpriseRuns.tenantId, `${prefix}%`));
      await setupDatabase.execute(
        sql`delete from enterprise_conversations where tenant_id like ${`${prefix}%`}`,
      );
      await setupDatabase.execute(
        sql`delete from enterprise_workspace_memberships where tenant_id like ${`${prefix}%`}`,
      );
      await setupDatabase
        .delete(enterpriseSecurityEvents)
        .where(like(enterpriseSecurityEvents.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseMemberships)
        .where(like(enterpriseMemberships.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseWorkspaces)
        .where(like(enterpriseWorkspaces.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseTenants)
        .where(like(enterpriseTenants.id, `${prefix}%`));
      await setupDatabase
        .delete(enterprisePrincipals)
        .where(like(enterprisePrincipals.id, `${prefix}%`));
      await setupDatabase.delete(users).where(like(users.id, `${prefix}%`));
    }
  } catch (error) {
    failures.push(error);
  }
  for (const database of [
    directoryDatabase,
    dataDatabase,
    operatorDatabase,
    setupDatabase,
  ]) {
    try {
      await database?.$client.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw failures[0];
});

/** 建一个带租约的运行中 run（AC1–AC3 的公共起点）。 */
async function runningRun(scope: PlatformScope, label: string) {
  const admission = await admittedInput(scope, label);
  const run = await protocol.startRun(scope, admission);
  const lease = await protocol.recoverLease(scope, run.run_id);
  return { run, lease, threadId: admission.input.threadId };
}

// ---------------------------------------------------------------------------
// AC1：创建/步骤/事件同一归属；缺失归属拒绝
// ---------------------------------------------------------------------------

describeDb(
  "MT048 AC1 creation, steps and events carry the same ownership",
  () => {
    test("every protocol stage refuses a scope that was not issued by the resolver", async () => {
      const admission = await admittedInput(scopeA, "untrusted");
      await expect(protocol.startRun(forgedScopeB, admission)).rejects.toThrow(
        "UNVERIFIED_SCOPE",
      );
      await expect(
        protocol.appendEvent(forgedScopeB, {
          lease: {
            runId: randomUUID(),
            attemptId: randomUUID(),
            generation: 1,
            ownerToken: randomUUID(),
            expiresAt: new Date(Date.now() + 30_000),
          },
          sourceEventId: randomUUID(),
          schemaVersion: 1,
          event: {
            type: "RUN_STARTED",
            threadId: "thread-mt048",
            runId: randomUUID(),
            timestamp: Date.now(),
          },
        }),
      ).rejects.toThrow("UNVERIFIED_SCOPE");
      await expect(
        protocol.recoverLease(forgedScopeB, randomUUID()),
      ).rejects.toThrow("UNVERIFIED_SCOPE");
      await expect(
        protocol.replayEvents(forgedScopeB, {
          threadId: randomUUID(),
          afterSeq: 0,
        }),
      ).rejects.toThrow("UNVERIFIED_SCOPE");
      await expect(
        protocol.cancelRun(forgedScopeB, {
          runId: randomUUID(),
          reason: "user_requested",
        }),
      ).rejects.toThrow("UNVERIFIED_SCOPE");
    });

    test("a run created under scope A persists exactly A's ownership triple", async () => {
      const { run } = await runningRun(scopeA, "ownership-triple");
      const [row] = await setupDatabase
        .select({
          tenantId: enterpriseRuns.tenantId,
          workspaceId: enterpriseRuns.workspaceId,
          principalId: enterpriseRuns.principalId,
        })
        .from(enterpriseRuns)
        .where(sql`${enterpriseRuns.id} = ${run.run_id}`)
        .limit(1);
      expect(row).toEqual({
        tenantId: tenantA,
        workspaceId: workspaceA1,
        principalId: principalA,
      });
    });

    test("a capability minted for A's run does not resolve under scope B", async () => {
      const { run, lease } = await runningRun(scopeA, "capability-cross-scope");
      const minted = await protocol.issueCapability(scopeA, {
        runId: run.run_id,
        attemptId: lease.attemptId,
        generation: lease.generation,
        modelRequestId: randomUUID(),
        maximumTokens: 500,
      });
      // 原归属内解析成功且上下文携带同一三比。
      const context = await runs.resolveModelInvocationCapability(
        scopeA,
        minted.capability,
      );
      expect(context.tenantId).toBe(tenantA);
      expect(context.workspaceId).toBe(workspaceA1);
      // 另一范围的身份拿同一能力串解析：不可见（401），不是降级继续。
      await expect(
        runs.resolveModelInvocationCapability(scopeB, minted.capability),
      ).rejects.toThrow("MODEL_CAPABILITY_INVALID");
    });

    test("step events append under A's lease and scope; another scope's identical lease is refused", async () => {
      const { run, lease } = await runningRun(scopeA, "event-scope");
      const proposal = (scopeLabel: string): EventProposal => ({
        lease,
        sourceEventId: `mt048-${scopeLabel}-${randomUUID()}`,
        schemaVersion: 1,
        event: {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: `mt048-${run.run_id}`,
          delta: "ownership carries the event",
        },
      });
      const ack = await protocol.appendEvent(scopeA, proposal("a"));
      expect(ack.seq).toBeGreaterThan(0);
      // 同一租约、另一 scope：lockRunAndAttempt 的归属三比不命中 → 拒绝。
      await expect(protocol.appendEvent(scopeB, proposal("b"))).rejects.toThrow(
        "RUN_ATTEMPT_STALE",
      );
      // 步骤没有租约（伪造 ownerToken）：同 scope 也拒绝——步骤执行携带的
      // 归属凭据是租约本身，不是「知道 runId」。
      await expect(
        protocol.appendEvent(scopeA, {
          ...proposal("forged-lease"),
          lease: { ...lease, ownerToken: randomUUID() },
        }),
      ).rejects.toThrow("RUN_ATTEMPT_STALE");
    });
  },
);

// ---------------------------------------------------------------------------
// AC2：恢复只在原归属范围内
// ---------------------------------------------------------------------------

describeDb("MT048 AC2 recovery stays inside the original ownership", () => {
  test("the original scope recovers the lease after it was released", async () => {
    const { run, lease } = await runningRun(scopeA, "recovery-original");
    const released = await runs.releaseRequestLease(scopeA, lease);
    expect(released).toBe(true);
    const recovered = await protocol.recoverLease(scopeA, run.run_id);
    expect(recovered.runId).toBe(run.run_id);
    expect(recovered.attemptId).toBe(lease.attemptId);
    expect(recovered.ownerToken).not.toBe(lease.ownerToken);
  });

  test("another scope's trusted identity cannot recover the run", async () => {
    const { run, lease } = await runningRun(scopeA, "recovery-cross-scope");
    // 同一真人、真实签发的 company B scope：对 A 的 run 恢复被拒（不可见）。
    await expect(protocol.recoverLease(scopeB, run.run_id)).rejects.toThrow(
      "RUN_NOT_ACTIVE",
    );
    // A 的原租约仍然有效（B 的尝试没有产生任何副作用）。
    const stillHeld = await runs.renewRequestLease(scopeA, lease);
    expect(stillHeld.ownerToken).toBe(lease.ownerToken);
    // B 的恢复尝试没有产生第二条 attempt（无归属漂移的执行事实）。
    const attempts = await setupDatabase
      .select({ id: enterpriseRunAttempts.id })
      .from(enterpriseRunAttempts)
      .where(sql`${enterpriseRunAttempts.runId} = ${run.run_id}`);
    expect(attempts).toHaveLength(1);
  });

  test("a reconnecting replay under the other scope sees no events at all", async () => {
    const { run, lease, threadId } = await runningRun(
      scopeA,
      "recovery-replay",
    );
    await protocol.appendEvent(scopeA, {
      lease,
      sourceEventId: `mt048-replay-${randomUUID()}`,
      schemaVersion: 1,
      event: {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: `mt048-${run.run_id}`,
        delta: "ownership carries the event",
      },
    });
    const inScope = await protocol.replayEvents(scopeA, {
      threadId,
      afterSeq: 0,
    });
    expect(inScope.items.length).toBeGreaterThan(0);
    // B 的订阅者对同一 threadId：空页（不可见语义，不是错误也不是内容）。
    const foreign = await protocol.replayEvents(scopeB, {
      threadId,
      afterSeq: 0,
    });
    expect(foreign.items).toHaveLength(0);
    expect(foreign.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC3：取消传播到步骤与外部执行；已产生事件不推给无权订阅者
// ---------------------------------------------------------------------------

describeDb(
  "MT048 AC3 cancellation propagates; unauthorized subscribers get nothing",
  () => {
    test("cancellation terminalizes, aborts in-flight steps and reaches external execution", async () => {
      const beforeSteps = abortedSteps.length;
      const beforePropagation = propagationCalls.length;
      const { run, threadId } = await runningRun(scopeA, "cancel-propagation");
      const botId = `${prefix}-bot`;
      const outcome = await protocol.cancelRun(scopeA, {
        threadId,
        reason: "user_requested",
        botId,
      });
      expect(outcome.outcome).toBe("cancelled");
      if (outcome.outcome !== "cancelled") return;
      expect(outcome.run.status).toBe("cancelled");
      expect(outcome.steps).toBe("aborted");
      expect(abortedSteps.slice(beforeSteps)).toEqual([run.run_id]);
      expect(propagationCalls.slice(beforePropagation)).toEqual([
        {
          scope: scopeA,
          botId,
          runId: run.run_id,
        },
      ]);
      expect(outcome.propagation).toEqual({
        requested: true,
        verdict: "allow",
      });
      // terminalize 是持久事实。
      const after = await runs.get(scopeA, run.run_id);
      expect(after.status).toBe("cancelled");
    });

    test("cancellation from the other scope touches nothing", async () => {
      const { run } = await runningRun(scopeA, "cancel-cross-scope");
      const beforeSteps = abortedSteps.length;
      const beforePropagation = propagationCalls.length;
      const outcome = await protocol.cancelRun(scopeB, {
        runId: run.run_id,
        reason: "user_requested",
        botId: `${prefix}-bot`,
      });
      expect(outcome).toEqual({ outcome: "not-found" });
      expect(abortedSteps.slice(beforeSteps)).toEqual([]);
      expect(propagationCalls.slice(beforePropagation)).toEqual([]);
      // A 的 run 原样活跃（取消不存在 = 没有发生任何事）。
      const after = await runs.get(scopeA, run.run_id);
      expect(after.status).toBe("queued");
    });

    test("already-produced events stop reaching a subscriber whose membership was revoked", async () => {
      const { run, lease, threadId } = await runningRun(
        scopeA,
        "events-revoked",
      );
      await protocol.appendEvent(scopeA, {
        lease,
        sourceEventId: `mt048-revoked-${randomUUID()}`,
        schemaVersion: 1,
        event: {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: `mt048-${run.run_id}`,
          delta: "ownership carries the event",
        },
      });
      // 撤权前：订阅者能看到已产生的事件。
      const before = await protocol.replayEvents(scopeA, {
        threadId,
        afterSeq: 0,
      });
      expect(before.items.length).toBeGreaterThan(0);
      // 真实 MT006 停用公司成员资格（epoch 递增 → 已签发 scope 下一次判定即失效）。
      const receipt = await suspendMembership(operatorDatabase!, {
        operationId: `${prefix}-suspend-${randomUUID().slice(0, 8)}`,
        operator: principalA,
        tenantId: tenantA,
        principalId: principalA,
      });
      expect(receipt.changed).toBe(true);
      // 撤权后：同一受信 scope 的事件订阅在读任何行之前被拒（fail-closed）。
      await expect(
        protocol.replayEvents(scopeA, { threadId, afterSeq: 0 }),
      ).rejects.toThrow();
      // 夹具卫生：恢复成员资格并重签 scope（epoch 已递增——旧 scope 的
      // memberEpoch 对实时行已过时，这是撤权语义本身；后续用例用新签的
      // 同三元组 scope 继续）。
      await setupDatabase
        .update(enterpriseMemberships)
        .set({ status: "active" })
        .where(
          sql`${enterpriseMemberships.tenantId} = ${tenantA} and ${enterpriseMemberships.principalId} = ${principalA}`,
        );
      scopeA = await scopeFor(tenantA, workspaceA1);
    });
  },
);

// ---------------------------------------------------------------------------
// AC4：外部线程上下文按持久记录解析归属
// ---------------------------------------------------------------------------

describeDb(
  "MT048 AC4 external thread context resolves from persisted records",
  () => {
    test("thread attribution comes from the persisted conversation row, never the request", async () => {
      const threadId = randomUUID();
      await seedPlatformConversation(scopeA, threadId);
      // 请求体/头声称 company B：resolveForThread 的解析路径根本不读这些
      // 字段——归属只来自持久线程行 × 真实成员候选。
      const request = new Request(
        `https://mt048.example.invalid/threads/${threadId}`,
        {
          method: "POST",
          headers: {
            "x-openbot-tenant": tenantB,
            "x-openbot-workspace": workspaceB1,
            "x-openbot-thread-tenant": tenantB,
            "x-openbot-thread-workspace": workspaceB1,
          },
          body: JSON.stringify({
            threadId,
            tenantId: tenantB,
            workspaceId: workspaceB1,
            companyId: tenantB,
            teamId: workspaceB1,
          }),
        },
      );
      authenticated.set(request, { actorId, entrypoint: "web" });
      const scope = await resolver.resolveForThread(request, threadId);
      expect({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        principalId: scope.principalId,
      }).toEqual({
        tenantId: tenantA,
        workspaceId: workspaceA1,
        principalId: principalA,
      });
      // 跨公司身份对照：同 principal 在 company B 签发的是另一个范围。
      expect(scopeB.tenantId).toBe(tenantB);
      expect(scopeB.workspaceId).toBe(workspaceB1);
    });

    test("a thread no membership vouches for is refused", async () => {
      const request = new Request(
        "https://mt048.example.invalid/threads/unknown",
      );
      authenticated.set(request, { actorId, entrypoint: "web" });
      await expect(
        resolver.resolveForThread(request, randomUUID()),
      ).rejects.toThrow("THREAD_SCOPE_NOT_FOUND");
    });
  },
);
