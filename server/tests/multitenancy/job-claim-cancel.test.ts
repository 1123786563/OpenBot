// server/tests/multitenancy/job-claim-cancel.test.ts
// MT043（Issue #86）：认领、重试与人工取消保持归属。
//
// 验收事实源（票面 4 条 AC，逐条对应 describe）：
//   AC1 无权主体不能取消他人任务；取消请求返回不可见语义。
//   AC2 重试后归属、发起主体与配置版本保持不变。
//   AC3 取消会传播到执行中的敏感动作与外部执行（含沙箱/浏览器），并有
//      测试证据。
//   AC4 并发认领不会让两个执行者同时持有同一租约。
//
// 机制：job 域 cancel/retry 入口（job-control.ts）走 MT005 集中授权 seam
// （受信 PlatformScope + 事务内两级成员重验 + 归属三比），不可见语义为
// MT011 canonical RESOURCE_NOT_FOUND（跨公司/跨团队/他人任务/不存在逐字节
// 不可区分，零写入零传播）。AC3 的传播接 #90 的真 cancelExecution
// （createExecutionArtifactsService + ExecutionSurface 适配器，本套件落
// computer/sandbox 两面 + 适配器翻译面）；AC4 用 8 条受限 operator 连接做
// 真并发认领竞速（insert-conflict 与过期 reclaim 两条路径都跑到）。
//
// 环境契约：专用企业测试库，缺显式 env 整套显式 skip，绝不回退开发库、
// skipped 不计通过。

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import type { PlatformScope } from "../../src/enterprise/contracts";
import { createSandboxClient } from "../../src/codesandbox/client";
import { assertTrustedScope } from "../../src/enterprise/tenancy/store";
import {
  computerExecutionSurface,
  sandboxExecutionSurface,
} from "../../src/enterprise/tenancy/execution-surfaces";
import {
  createExecutionArtifactsService,
  type ExecutionAuditEvent,
  type ExecutionAuditSink,
  type ExecutionSurface,
  type ExecutionTarget,
} from "../../src/enterprise/tenancy/execution-artifacts";
import {
  JOB_LEASE_HELD,
  type JobConfigBasisInput,
  type JobExecutor,
  type JobRef,
} from "../../src/enterprise/tenancy/job-ownership";
import {
  createJobControlService,
  type JobControlService,
} from "../../src/enterprise/tenancy/job-control";
import { notFoundVerdict } from "../../src/enterprise/tenancy/not-found-semantics";
import {
  createJobClaimCancelFixture,
  type JobClaimCancelFixture,
} from "./support/job-claim-cancel";

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
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

const canonicalDeny = JSON.stringify(notFoundVerdict());

let fixture: JobClaimCancelFixture;
let control: JobControlService;

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createJobClaimCancelFixture();
  control = createJobControlService({
    operator: fixture.jobs.operator,
    data: fixture.jobs.data,
  });
});

afterAll(async () => {
  await fixture?.dispose();
});

// ---------------------------------------------------------------------------
// 共享件：夹具语汇（与 MT041 套件同款，外加本票的执行面记录器）
// ---------------------------------------------------------------------------

const WORKER: JobExecutor = {
  kind: "worker",
  id: `mt043-worker-${randomUUID().slice(0, 8)}`,
};

const basisOf = (
  companyRevision: number,
  overrideRevision: number | null,
  tag: string,
): JobConfigBasisInput => ({
  companyRevision,
  overrideRevision,
  document: { model: { defaultModel: `mt043-${tag}` }, revision: tag },
});

interface Pinned {
  readonly kind: JobRef["kind"];
  readonly objectId: string;
  readonly scope: PlatformScope;
}

async function pinTask(
  identity: Parameters<typeof fixture.jobs.scopeAs>[0],
  companyKey: "company-a" | "company-b",
  teamKey: "team-a1" | "team-a2" | "team-b1",
  label: string,
  basis?: JobConfigBasisInput,
): Promise<Pinned> {
  const scope = await fixture.jobs.scopeAs(identity, companyKey, teamKey);
  const objectId = `${fixture.jobs.isolation.idPrefix}-mt043-${label}-${randomUUID().slice(0, 8)}`;
  const result = await fixture.service.pinJobOwnership({
    kind: "task",
    objectId,
    scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
    principalId: scope.principalId,
    basis: basis ?? basisOf(1, null, label),
  });
  expect(result.status).toBe("pinned");
  return { kind: "task", objectId, scope };
}

/** Asserts a promise rejects with a sentinel code (`CODE: …` or exact). */
async function expectSentinelRejection(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message === code || message.startsWith(`${code}: `)).toBe(true);
    return;
  }
  throw new Error(`expected rejection with sentinel code ${code}, got resolve`);
}

/** In-memory audit recorder for the #90 seam (AC3 evidence). */
function auditRecorder(): ExecutionAuditSink & {
  events(): readonly ExecutionAuditEvent[];
} {
  const seen: ExecutionAuditEvent[] = [];
  return {
    async record(event) {
      seen.push(event);
    },
    events: () => seen,
  };
}

/** Surfaces that record every call; the propagation assertions read them. */
function recordingSurfaces(): {
  surfaces: ExecutionSurface[];
  cancels: ExecutionTarget[];
  resets: ExecutionTarget[];
} {
  const cancels: ExecutionTarget[] = [];
  const resets: ExecutionTarget[] = [];
  return {
    cancels,
    resets,
    surfaces: [
      {
        surface: "computer",
        async cancel(target) {
          cancels.push(target);
          return { outcome: "cancelled" };
        },
        async reset(target) {
          resets.push(target);
          return { outcome: "cleared" };
        },
      },
      {
        surface: "sandbox",
        async cancel(target) {
          cancels.push(target);
          return { outcome: "not-running" };
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// AC1 — 无权主体不能取消他人任务；取消请求返回不可见语义
// ---------------------------------------------------------------------------

describeDb(
  "MT043 AC1: only an authorized principal can cancel; others are invisible",
  () => {
    itDb(
      "the initiator's cancel clears the live lease and marks it finished",
      async () => {
        const pinned = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac1-own",
        );
        await fixture.service.claimJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: WORKER,
          leaseMs: 60_000,
        });
        const outcome = await control.cancelJob(pinned.scope, {
          kind: pinned.kind,
          objectId: pinned.objectId,
        });
        expect(outcome).toEqual({
          outcome: "cancelled",
          lease: { status: "cleared" },
          propagation: { requested: false },
        });
        const lease = await fixture.readLeaseRaw(pinned);
        expect(lease).not.toBeNull();
        expect(lease?.claimedByKind).toBeNull();
        expect(lease?.claimedBy).toBeNull();
        expect(lease?.leaseUntil).toBeNull();
        expect(lease?.finishedAt).not.toBeNull();
        expect(lease?.lastError).toBe("cancelled");
      },
    );

    itDb(
      "same team, another principal: byte-identical canonical deny, zero side effects",
      async () => {
        const pinned = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac1-peer",
        );
        await fixture.service.claimJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: WORKER,
          leaseMs: 60_000,
        });
        const peer = await fixture.jobs.scopeAs(
          "a1-other",
          "company-a",
          "team-a1",
        );
        const deny = await control.cancelJob(peer, {
          kind: pinned.kind,
          objectId: pinned.objectId,
        });
        expect(JSON.stringify(deny)).toBe(canonicalDeny);
        // 不可见 = 零副作用：持有人原样持有。
        const lease = await fixture.readLeaseRaw(pinned);
        expect(lease?.claimedBy).toBe(WORKER.id);
        expect(lease?.leaseUntil).not.toBeNull();
        expect(lease?.finishedAt).toBeNull();
      },
    );

    itDb(
      "same company other team, and other company: the same canonical bytes",
      async () => {
        const pinned = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac1-cross",
        );
        const a2 = await fixture.jobs.scopeAs(
          "a2-member",
          "company-a",
          "team-a2",
        );
        const b1 = await fixture.jobs.scopeAs(
          "b1-member",
          "company-b",
          "team-b1",
        );
        const denyA2 = await control.cancelJob(a2, {
          kind: pinned.kind,
          objectId: pinned.objectId,
        });
        const denyB1 = await control.cancelJob(b1, {
          kind: pinned.kind,
          objectId: pinned.objectId,
        });
        expect(JSON.stringify(denyA2)).toBe(canonicalDeny);
        expect(JSON.stringify(denyB1)).toBe(canonicalDeny);
        // 与「不存在」逐字节同形（存在性不泄露）。
        const unknown = await control.cancelJob(pinned.scope, {
          kind: "task",
          objectId: `${pinned.objectId}-does-not-exist`,
        });
        expect(JSON.stringify(unknown)).toBe(canonicalDeny);
        expect(JSON.stringify(denyA2)).toBe(JSON.stringify(unknown));
        // 三次拒绝后零写入。
        const lease = await fixture.readLeaseRaw(pinned);
        expect(lease).toBeNull();
      },
    );

    itDb("a hand-built scope never reaches the verdict", async () => {
      const forged = {
        tenantId: "tenant-a",
        workspaceId: "team-a1",
        principalId: "p1",
        actorId: "u1",
        memberEpoch: 1,
        aclEpoch: 1,
        entrypoint: "web",
      } as unknown as PlatformScope;
      expect(() => assertTrustedScope(forged)).toThrow("UNVERIFIED_SCOPE");
      await expectSentinelRejection(
        control.cancelJob(forged, { kind: "task", objectId: "x" }),
        "UNVERIFIED_SCOPE",
      );
    });

    itDb(
      "a suspended membership cancels nothing (revocation is immediate)",
      async () => {
        const pinned = await pinTask(
          "multi-company",
          "company-a",
          "team-a1",
          "ac1-suspended",
        );
        await fixture.service.claimJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: WORKER,
          leaseMs: 60_000,
        });
        const suspended = await fixture.jobs.isolation.suspendCompanyMembership(
          "multi-company",
          pinned.scope.tenantId,
        );
        expect(suspended.changed).toBe(true);
        await expectSentinelRejection(
          control.cancelJob(pinned.scope, {
            kind: pinned.kind,
            objectId: pinned.objectId,
          }),
          "SCOPE_REVOKED",
        );
        const lease = await fixture.readLeaseRaw(pinned);
        expect(lease?.claimedBy).toBe(WORKER.id);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// AC2 — 重试后归属、发起主体与配置版本保持不变
// ---------------------------------------------------------------------------

describeDb(
  "MT043 AC2: a retry keeps ownership, initiator and config version",
  () => {
    itDb(
      "a retry re-arms under the creation basis even after the config moves on",
      async () => {
        await fixture.jobs.seedCompanyConfig("company-a", 1);
        await fixture.jobs.seedTeamOverride("team-a1", 1);
        // 真实 MT014 服务产出创建依据（company 1 + override 1）。
        const resolved = await fixture.jobs.configService.resolve({
          tenantId: fixture.jobs.isolation.ids["company-a"],
          workspaceId: fixture.jobs.isolation.ids["team-a1"],
        });
        const creationBasis: JobConfigBasisInput = {
          companyRevision: resolved.revisions.company,
          overrideRevision: resolved.revisions.override,
          document: resolved,
        };
        const pinned = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac2-retry",
          creationBasis,
        );
        const first = await fixture.service.claimJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: { kind: "worker", id: `${WORKER.id}-1` },
          leaseMs: 60_000,
        });
        expect(first.status).toBe("granted");
        // 失败：释放并带错误。
        await fixture.service.releaseJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: { kind: "worker", id: `${WORKER.id}-1` },
          reason: "simulated failure",
        });
        const retry = await control.retryJob(pinned.scope, {
          kind: pinned.kind,
          objectId: pinned.objectId,
        });
        expect(retry.outcome).toBe("retry-armed");
        if (retry.outcome !== "retry-armed") return;
        expect(retry.retryBasis).toEqual({
          companyRevision: creationBasis.companyRevision,
          overrideRevision: creationBasis.overrideRevision,
          basisDigest: retry.ownership.creationBasis.basisDigest,
          purpose: "execution",
        });

        // 配置前进（公司 revision 2 + 新团队覆盖）：重试仍钉创建依据。
        await fixture.jobs.seedCompanyConfig("company-a", 2);
        await fixture.jobs.seedTeamOverride("team-a1", 2);
        const retryTwo = await control.retryJob(pinned.scope, {
          kind: pinned.kind,
          objectId: pinned.objectId,
        });
        expect(retryTwo.outcome).toBe("retry-armed");
        if (retryTwo.outcome !== "retry-armed") return;
        expect(retryTwo.retryBasis.companyRevision).toBe(
          creationBasis.companyRevision,
        );
        expect(retryTwo.retryBasis.overrideRevision).toBe(
          creationBasis.overrideRevision,
        );
        expect(retryTwo.retryBasis.basisDigest).toBe(
          retry.ownership.creationBasis.basisDigest,
        );

        // 重认领是同一 job 的第二次尝试，不是新任务。
        const second = await fixture.service.claimJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: { kind: "worker", id: `${WORKER.id}-2` },
          leaseMs: 60_000,
        });
        expect(second.status).toBe("granted");
        expect(second.attempts).toBe(2);

        // 三不变：归属行（公司/团队/发起主体）与创建依据原样。
        const raw = await fixture.readOwnershipRaw(pinned);
        expect(raw).toEqual({
          tenantId: pinned.scope.tenantId,
          workspaceId: pinned.scope.workspaceId,
          principalId: pinned.scope.principalId,
        });
        const snapshots = await fixture.readSnapshotsRaw(pinned);
        expect(snapshots.creation).toEqual({
          companyRevision: creationBasis.companyRevision,
          overrideRevision: creationBasis.overrideRevision,
          basisDigest: retry.ownership.creationBasis.basisDigest,
        });
        expect(snapshots.executions).toHaveLength(2);
        for (const execution of snapshots.executions) {
          expect(execution).toEqual(snapshots.creation);
        }
      },
    );

    itDb(
      "a retry from any other scope is invisible and writes nothing",
      async () => {
        const pinned = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac2-cross",
        );
        const a2 = await fixture.jobs.scopeAs(
          "a2-member",
          "company-a",
          "team-a2",
        );
        const b1 = await fixture.jobs.scopeAs(
          "b1-member",
          "company-b",
          "team-b1",
        );
        const peer = await fixture.jobs.scopeAs(
          "a1-other",
          "company-a",
          "team-a1",
        );
        for (const viewer of [a2, b1, peer]) {
          const deny = await control.retryJob(viewer, {
            kind: pinned.kind,
            objectId: pinned.objectId,
          });
          expect(JSON.stringify(deny)).toBe(canonicalDeny);
        }
        // 零写入：无依据快照、无租约行。
        const snapshots = await fixture.readSnapshotsRaw(pinned);
        expect(snapshots.executions).toHaveLength(0);
        expect(await fixture.readLeaseRaw(pinned)).toBeNull();
      },
    );

    itDb("a live lease refuses the retry and appends no basis", async () => {
      const pinned = await pinTask(
        "a1-member",
        "company-a",
        "team-a1",
        "ac2-live",
      );
      await fixture.service.claimJobLease({
        kind: pinned.kind,
        objectId: pinned.objectId,
        scope: {
          tenantId: pinned.scope.tenantId,
          workspaceId: pinned.scope.workspaceId,
        },
        executor: WORKER,
        leaseMs: 60_000,
      });
      await expectSentinelRejection(
        control.retryJob(pinned.scope, {
          kind: pinned.kind,
          objectId: pinned.objectId,
        }),
        JOB_LEASE_HELD,
      );
      const snapshots = await fixture.readSnapshotsRaw(pinned);
      expect(snapshots.executions).toHaveLength(0);
      const lease = await fixture.readLeaseRaw(pinned);
      expect(lease?.claimedBy).toBe(WORKER.id);
    });
  },
);

// ---------------------------------------------------------------------------
// AC3 — 取消传播到执行中的敏感动作与外部执行（含沙箱/浏览器）
// ---------------------------------------------------------------------------

describeDb("MT043 AC3: a cancel propagates through the real #90 seam", () => {
  itDb(
    "an authorized cancel reaches every surface with the exact ownership target",
    async () => {
      const recorder = auditRecorder();
      const { surfaces, cancels } = recordingSurfaces();
      const execution = createExecutionArtifactsService({
        data: fixture.jobs.data,
        audit: recorder,
        surfaces,
      });
      const scopedControl = createJobControlService({
        operator: fixture.jobs.operator,
        data: fixture.jobs.data,
        execution,
      });
      const scope = await fixture.jobs.scopeAs(
        "a1-member",
        "company-a",
        "team-a1",
      );
      // 真实 MT016 归属行：传播判定的 bot 事实。
      const botId = `${fixture.jobs.isolation.idPrefix}-mt043-bot-${randomUUID().slice(0, 8)}`;
      const planted = await fixture.bots.createBot(scope, {
        agentId: botId,
        displayName: "MT043 run bot",
        defaultConfig: {},
      });
      expect(planted.outcome).toBe("allow");
      const runId = `${fixture.jobs.isolation.idPrefix}-mt043-run-${randomUUID().slice(0, 8)}`;
      const ref = { kind: "run" as const, objectId: runId };
      const pinResult = await fixture.service.pinJobOwnership({
        kind: "run",
        objectId: runId,
        scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
        principalId: scope.principalId,
        basis: basisOf(1, null, "ac3"),
      });
      expect(pinResult.status).toBe("pinned");
      await fixture.service.claimJobLease({
        kind: "run",
        objectId: runId,
        scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
        executor: WORKER,
        leaseMs: 60_000,
      });

      const outcome = await scopedControl.cancelJob(scope, {
        kind: "run",
        objectId: runId,
        execution: { botId, runId },
      });
      expect(outcome.outcome).toBe("cancelled");
      if (outcome.outcome !== "cancelled") return;
      expect(outcome.propagation).toEqual({
        requested: true,
        verdict: "allow",
        attempts: [
          { surface: "computer", outcome: "cancelled" },
          { surface: "sandbox", outcome: "not-running" },
        ],
      });
      expect(outcome.lease.status).toBe("cleared");
      // 逐面收到的 target 就是归属三元组 + runId，不是别的 Bot。
      expect(cancels).toHaveLength(2);
      for (const target of cancels) {
        expect(target).toEqual({
          tenantId: fixture.jobs.isolation.ids["company-a"],
          workspaceId: fixture.jobs.isolation.ids["team-a1"],
          botId,
          runId,
        });
      }
      // 审计行：allowed，携带归属三元组与主体。
      const cancelEvents = recorder
        .events()
        .filter((event) => event.action === "execution.cancel");
      expect(cancelEvents).toHaveLength(1);
      expect(cancelEvents[0].outcome).toBe("allowed");
      expect(cancelEvents[0].botId).toBe(botId);
      expect(cancelEvents[0].tenantId).toBe(
        fixture.jobs.isolation.ids["company-a"],
      );
      expect(cancelEvents[0].principalId).toBe(scope.principalId);
      // 租约也被清掉：传播与清租约同一次取消完成。
      const lease = await fixture.readLeaseRaw(ref);
      expect(lease?.claimedBy).toBeNull();
      expect(lease?.finishedAt).not.toBeNull();
    },
  );

  itDb(
    "a bot outside the caller's workspace propagates nothing (canonical deny)",
    async () => {
      const recorder = auditRecorder();
      const { surfaces, cancels } = recordingSurfaces();
      const execution = createExecutionArtifactsService({
        data: fixture.jobs.data,
        audit: recorder,
        surfaces,
      });
      const scopedControl = createJobControlService({
        operator: fixture.jobs.operator,
        data: fixture.jobs.data,
        execution,
      });
      const owner = await fixture.jobs.scopeAs(
        "a1-member",
        "company-a",
        "team-a1",
      );
      const otherTeam = await fixture.jobs.scopeAs(
        "a2-member",
        "company-a",
        "team-a2",
      );
      // team-a2 的 bot：对 a1 主体不可见（#90 判定 canonical deny）。
      const foreignBot = `${fixture.jobs.isolation.idPrefix}-mt043-bot2-${randomUUID().slice(0, 8)}`;
      const planted = await fixture.bots.createBot(otherTeam, {
        agentId: foreignBot,
        displayName: "MT043 foreign bot",
        defaultConfig: {},
      });
      expect(planted.outcome).toBe("allow");
      const runId = `${fixture.jobs.isolation.idPrefix}-mt043-run2-${randomUUID().slice(0, 8)}`;
      const pinResult = await fixture.service.pinJobOwnership({
        kind: "run",
        objectId: runId,
        scope: { tenantId: owner.tenantId, workspaceId: owner.workspaceId },
        principalId: owner.principalId,
        basis: basisOf(1, null, "ac3b"),
      });
      expect(pinResult.status).toBe("pinned");
      await fixture.service.claimJobLease({
        kind: "run",
        objectId: runId,
        scope: { tenantId: owner.tenantId, workspaceId: owner.workspaceId },
        executor: WORKER,
        leaseMs: 60_000,
      });

      const outcome = await scopedControl.cancelJob(owner, {
        kind: "run",
        objectId: runId,
        execution: { botId: foreignBot, runId },
      });
      // job 是 owner 的：取消本身成立；bot 判定 deny（canonical 同形）。
      expect(outcome.outcome).toBe("cancelled");
      if (outcome.outcome !== "cancelled") return;
      expect(outcome.propagation.requested).toBe(true);
      expect(outcome.propagation.verdict).toBe("deny");
      expect(outcome.lease.status).toBe("cleared");
      // 一个执行面都没被调用。
      expect(cancels).toHaveLength(0);
      const denied = recorder
        .events()
        .filter(
          (event) =>
            event.action === "execution.cancel" && event.outcome === "denied",
        );
      expect(denied).toHaveLength(1);
    },
  );
});

// ---------------------------------------------------------------------------
// AC3 适配器翻译面（纯函数：computer / sandbox → 既有入口）
// ---------------------------------------------------------------------------

describe("MT043 AC3 adapters: targets translated to the existing entries", () => {
  const target: ExecutionTarget = {
    tenantId: "tenant-a",
    workspaceId: "team-a1",
    botId: "bot-1",
    runId: "run-9",
  };

  test("the computer adapter calls stopComputer with the target's bot and the actor", async () => {
    const stops: Array<{ botId: string; actor: { id: string } }> = [];
    const resets: Array<{ botId: string; actor: { id: string } }> = [];
    const surface = computerExecutionSurface({
      actor: { id: "user-1" },
      stopComputer: async (botId, actor) => {
        stops.push({ botId, actor });
        return { wasRunning: true };
      },
      resetComputer: async (botId, actor) => {
        resets.push({ botId, actor });
        return { cleared: true };
      },
    });
    expect(surface.surface).toBe("computer");
    expect(await surface.cancel(target)).toEqual({ outcome: "cancelled" });
    expect(stops).toEqual([{ botId: "bot-1", actor: { id: "user-1" } }]);
    expect(await surface.reset?.(target)).toEqual({ outcome: "cleared" });
    expect(resets).toEqual([{ botId: "bot-1", actor: { id: "user-1" } }]);
    // not-running 翻译：实例本来就没在跑。
    const idle = computerExecutionSurface({
      actor: { id: "user-1" },
      stopComputer: async () => ({ wasRunning: false }),
    });
    expect(await idle.cancel(target)).toEqual({ outcome: "not-running" });
  });

  test("the sandbox adapter aborts the active session under the ownership headers", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> =
      [];
    const surface = sandboxExecutionSurface({
      createClient: (input) =>
        createSandboxClient({
          baseUrl: "https://sandbox.invalid",
          token: "sandbox-token-1",
          botId: input.botId,
          executionScope: input.executionScope,
          fetchImpl: (async (input2: RequestInfo | URL, init?: RequestInit) => {
            requests.push({
              url: String(input2),
              headers: Object.fromEntries(new Headers(init?.headers).entries()),
            });
            return new Response(null, { status: 200 });
          }) as typeof fetch,
        }),
      sessions: {
        async activeSession() {
          return "sess-1";
        },
      },
    });
    expect(surface.surface).toBe("sandbox");
    expect(await surface.cancel(target)).toEqual({ outcome: "cancelled" });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "https://sandbox.invalid/session/sess-1/abort",
    );
    // 归属头随行（MT050 契约）：token 与 bot 头之外，tenant/workspace 必在。
    expect(requests[0].headers["x-sandbox-token"]).toBe("sandbox-token-1");
    expect(requests[0].headers["x-openbot-bot-id"]).toBe("bot-1");
    expect(requests[0].headers["x-openbot-tenant-id"]).toBe("tenant-a");
    expect(requests[0].headers["x-openbot-workspace-id"]).toBe("team-a1");
    // 重置走同一归属构造（真实端点 /workspace/reset）。
    expect(await surface.reset?.(target)).toEqual({ outcome: "cleared" });
    expect(requests[1]?.url).toBe("https://sandbox.invalid/workspace/reset");
  });

  test("no active session: not-running, zero requests", async () => {
    const requests: unknown[] = [];
    const surface = sandboxExecutionSurface({
      createClient: () =>
        createSandboxClient({
          baseUrl: "https://sandbox.invalid",
          token: "t",
          botId: "bot-1",
          fetchImpl: (async () => {
            requests.push("called");
            return new Response(null, { status: 200 });
          }) as typeof fetch,
        }),
      sessions: {
        async activeSession() {
          return null;
        },
      },
    });
    expect(await surface.cancel(target)).toEqual({ outcome: "not-running" });
    expect(requests).toHaveLength(0);
  });

  test("a throwing sandbox call lands unavailable without stopping the propagation", async () => {
    const surface = sandboxExecutionSurface({
      createClient: () => ({
        abortSession: async () => {
          throw new Error("proxy down");
        },
        resetWorkspace: async () => {
          throw new Error("proxy down");
        },
      }),
      sessions: {
        async activeSession() {
          return "sess-1";
        },
      },
    });
    const outcome = await surface.cancel(target);
    expect(outcome.outcome).toBe("unavailable");
  });
});

// ---------------------------------------------------------------------------
// AC4 — 并发认领不会让两个执行者同时持有同一租约
// ---------------------------------------------------------------------------

describeDb("MT043 AC4: concurrent claims never double-hold one lease", () => {
  const RACERS = 8;

  /** Fires one concurrent claim per racer; returns settled results. */
  async function raceClaim(
    services: Awaited<ReturnType<typeof fixture.raceServices>>,
    pinned: Pinned,
    round: number,
  ) {
    const attempts = await Promise.allSettled(
      services.map((service, index) =>
        service.claimJobLease({
          kind: pinned.kind,
          objectId: pinned.objectId,
          scope: {
            tenantId: pinned.scope.tenantId,
            workspaceId: pinned.scope.workspaceId,
          },
          executor: {
            kind: "worker",
            id: `mt043-racer-${round}-${index}`,
          },
          leaseMs: 60_000,
        }),
      ),
    );
    return attempts;
  }

  itDb(
    "eight executors race a fresh claim: exactly one grant, seven refusals",
    async () => {
      const pinned = await pinTask(
        "a1-member",
        "company-a",
        "team-a1",
        "ac4-fresh",
      );
      const services = await fixture.raceServices(RACERS);
      const results = await raceClaim(services, pinned, 1);
      const granted = results.filter((result) => result.status === "fulfilled");
      const refused = results.filter((result) => result.status === "rejected");
      expect(granted).toHaveLength(1);
      expect(refused).toHaveLength(RACERS - 1);
      if (granted[0].status !== "fulfilled") return;
      expect(granted[0].value.status).toBe("granted");
      expect(granted[0].value.attempts).toBe(1);
      for (const refusal of refused) {
        if (refusal.status !== "rejected") continue;
        const message =
          refusal.reason instanceof Error
            ? refusal.reason.message
            : String(refusal.reason);
        expect(
          message === JOB_LEASE_HELD ||
            message.startsWith(`${JOB_LEASE_HELD}: `),
        ).toBe(true);
      }
      // 权威行只有一个持有人。
      const lease = await fixture.readLeaseRaw(pinned);
      expect(lease?.claimedBy).toBe(granted[0].value.claimedBy);
      expect(lease?.attempts).toBe(1);
    },
  );

  itDb(
    "after expiry the reclaim race also grants exactly once (three rounds)",
    async () => {
      const pinned = await pinTask(
        "a1-member",
        "company-a",
        "team-a1",
        "ac4-reclaim",
      );
      const services = await fixture.raceServices(RACERS);
      const first = await services[0].claimJobLease({
        kind: pinned.kind,
        objectId: pinned.objectId,
        scope: {
          tenantId: pinned.scope.tenantId,
          workspaceId: pinned.scope.workspaceId,
        },
        executor: { kind: "worker", id: "mt043-reclaim-first" },
        leaseMs: 60_000,
      });
      expect(first.status).toBe("granted");
      for (let round = 1; round <= 3; round += 1) {
        // 确定性过期：把租约回拨（superuser 夹具，只动时钟不动持有人）。
        await fixture.backdateLease(pinned, 2_000);
        const results = await raceClaim(services, pinned, round + 1);
        const granted = results.filter(
          (result) => result.status === "fulfilled",
        );
        expect(granted).toHaveLength(1);
        if (granted[0].status !== "fulfilled") return;
        expect(granted[0].value.attempts).toBe(round + 1);
        const lease = await fixture.readLeaseRaw(pinned);
        expect(lease?.claimedBy).toBe(granted[0].value.claimedBy);
        expect(lease?.attempts).toBe(round + 1);
      }
    },
  );
});
