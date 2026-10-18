// server/tests/multitenancy/scan-executor.test.ts
// MT042（Issue #85）：平台扫描的到期任务发现与按记录重建作用域执行。
//
// 验收事实源（MT042 brief 验收 1–4，逐条对应 describe）：
//   (1) 扫描器列出跨公司到期任务但不读业务内容（列表=元数据，载荷内容不可见）。
//   (2) 每项执行前从服务器持久化记录重建 Scope；队列消息里公司/团队字段不被
//       信任（重建=权威行，消息字段仅作路由提示）。
//   (3) 机器身份不获得 dev-local-user 或普通用户权限；尝试即拒绝（机器 Scope
//       与用户 Scope 类型隔离）。
//   (4) 反序列化 Scope 被拒；只有签发入口产生的 Scope 有效（MT005 scope-gate
//       先例：结构≠信任）。
//
// 机制：扫描面在平台连接上元数据认领 work_items（SELECT 不含 payload 列）；
// 每项先读 job_ownership 权威行（operator 通道 + app.scan_sweep 上下文臂，
// MT042 迁移）+ principal→user（operator 逐主体臂），再经真实签发入口
// createScopeResolver（entrypoint="schedule"）产出受信 Scope；租约消费 MT041
// claimJobLease/finishJobLease/releaseJobLease（同一 lease 纪律）；执行回调在
// MT005 scope-gate 事务内。冻结面（job-ownership.ts / scope-gate.ts 等）只
// 消费不改。
//
// 环境契约：专用企业测试库（w14b），缺显式 env 整套显式 skip，绝不回退开发
// 库、skipped 不计通过。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { jobLeases, jobOwnership } from "../../src/db/schema/job-ownership";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  assertTrustedMachineIdentity,
  createMachineScanIdentity,
  createScanExecutor,
  MACHINE_IDENTITY_INVALID,
  SCAN_EXECUTION_FAILED,
  SCAN_ITEM_MALFORMED,
  SCAN_RECORD_MISSING,
  SCAN_SCOPE_UNRESOLVED,
  SCAN_WORK_KIND,
  type ScannedItem,
} from "../../src/enterprise/runs/scan-executor";
import type {
  createJobOwnershipService,
  JobConfigBasisInput,
  JobExecutor,
  JobKind,
} from "../../src/enterprise/tenancy/job-ownership";
import { assertTrustedScope } from "../../src/enterprise/tenancy/store";
import {
  createScanExecutorFixture,
  type ScanFixture,
} from "./support/scan-executor";

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

let fixture: ScanFixture;
let service: ReturnType<typeof createJobOwnershipService>;

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createScanExecutorFixture();
  service = fixture.service;
  // The work queue is durable across runs: close whatever earlier runs left
  // behind so every scan in this run sees only this run's items.
  await fixture.drainScanQueue();
});

afterAll(async () => {
  await fixture?.dispose();
});

/** Asserts a promise rejects with a scan seam sentinel code (`CODE` or `CODE: …`). */
async function expectSentinelRejection(
  promise: Promise<unknown>,
  code: string,
): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error instanceof Error).toBe(true);
    const message = error instanceof Error ? error.message : String(error);
    expect(message === code || message.startsWith(`${code}: `)).toBe(true);
    return error as Error;
  }
  throw new Error(`expected rejection with sentinel code ${code}, got resolve`);
}

const basisOf = (
  companyRevision: number,
  overrideRevision: number | null,
  tag: string,
): JobConfigBasisInput => ({
  companyRevision,
  overrideRevision,
  document: { model: { defaultModel: `mt042-${tag}` }, revision: tag },
});

interface Pinned {
  readonly kind: JobKind;
  readonly objectId: string;
  readonly scope: PlatformScope;
}

/** Pins one task via the real MT041 service and returns the references. */
async function pinTask(
  identity: Parameters<typeof fixture.scopeAs>[0],
  companyKey: "company-a" | "company-b",
  teamKey: "team-a1" | "team-a2" | "team-b1",
  label: string,
): Promise<Pinned> {
  const scope = await fixture.jobs.scopeAs(identity, companyKey, teamKey);
  const kind: JobKind = "task";
  const objectId = fixture.objectId(label);
  const pinned = await service.pinJobOwnership({
    kind,
    objectId,
    scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
    principalId: scope.principalId,
    basis: basisOf(1, null, label),
  });
  expect(pinned.status).toBe("pinned");
  return { kind, objectId, scope };
}

/** Offers one due scan item over the real work queue. */
async function offerDue(
  pinned: Pick<Pinned, "kind" | "objectId">,
  payload?: Record<string, unknown>,
  runAt?: Date,
): Promise<"queued" | "already" | "refused"> {
  return fixture.queue.offer({
    kind: SCAN_WORK_KIND,
    key: `${pinned.kind}:${pinned.objectId}`,
    ...(payload === undefined ? {} : { payload }),
    ...(runAt === undefined ? {} : { runAt }),
  });
}

/** The machine identity every positive path in this suite scans under. */
function machineOf(id: string) {
  return createMachineScanIdentity({ id: `mt042-${id}` });
}

/**
 * The queue is shared across runs: items released by an earlier run become due
 * again later and may be claimed alongside this test's item. Every outcome
 * assertion looks only at THIS test's job (identified by its unique objectId).
 */
function mine(
  outcomes: Awaited<
    ReturnType<ReturnType<typeof createScanExecutor>["scanAndExecute"]>
  >,
  objectId: string,
) {
  return outcomes.filter((outcome) => outcome.item?.objectId === objectId);
}

interface RecordedExecution {
  readonly scope: PlatformScope;
  readonly item: ScannedItem;
  sawOwnPinRow: boolean;
}

/** Builds an executor whose execute callback records into `into`. */
function executorRecording(
  into: RecordedExecution[],
  behavior?: "throw" | undefined,
) {
  return createScanExecutor({
    platform: fixture.platform,
    operator: fixture.jobs.operator,
    jobOwnership: service,
    gate: fixture.gate,
    issueScheduleScope: fixture.issueScheduleScope,
    execute: async (context) => {
      if (behavior === "throw") throw new Error("mt042-callback-boom");
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

describeDb("MT042 — platform scan scope rebuild (Issue #85)", () => {
  describe("AC1: the scan lists due jobs across companies as metadata, never business content", () => {
    itDb(
      "lists due jobs of two companies and never reads the payload",
      async () => {
        const MARKER = "mt042-payload-canary-7f3a";
        const a1 = await pinTask("a1-member", "company-a", "team-a1", "ac1-a");
        const b1 = await pinTask("b1-member", "company-b", "team-b1", "ac1-b");
        // Queue messages carry company/team fields as ROUTING HINTS — both sets
        // of hints deliberately point at the WRONG company.
        await offerDue(a1, {
          tenantId: b1.scope.tenantId,
          workspaceId: b1.scope.workspaceId,
          note: MARKER,
        });
        await offerDue(b1, {
          tenantId: a1.scope.tenantId,
          workspaceId: a1.scope.workspaceId,
          note: MARKER,
        });

        const recorded: RecordedExecution[] = [];
        const machine = machineOf("ac1");
        const rawOutcomes =
          await executorRecording(recorded).scanAndExecute(machine);
        const outcomes = mine(rawOutcomes, a1.objectId).concat(
          mine(rawOutcomes, b1.objectId),
        );
        expect(outcomes).toHaveLength(2);
        const items = outcomes.map((outcome) => outcome.item);
        expect(
          items.map((item) => `${item.jobKind}:${item.objectId}`).sort(),
        ).toEqual([`task:${a1.objectId}`, `task:${b1.objectId}`].sort());
        // Cross-company listing: both companies' due jobs were executed.
        expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
          "executed",
          "executed",
        ]);
        // Metadata only: attempts arrived, payload never did.
        for (const item of items) {
          expect(Object.keys(item).sort()).toEqual([
            "attempts",
            "jobKind",
            "objectId",
            "runAt",
          ]);
          expect(item.attempts).toBe(1);
        }
        // The execution callback receives no payload at all, and the canary
        // planted in the queue messages appears nowhere in the scan surface.
        expect(recorded).toHaveLength(2);
        for (const execution of recorded) {
          expect(Object.keys(execution).sort()).toEqual([
            "item",
            "sawOwnPinRow",
            "scope",
          ]);
          expect(execution.sawOwnPinRow).toBe(true);
        }
        expect(JSON.stringify({ outcomes, recorded })).not.toContain(MARKER);
        expect(JSON.stringify(outcomes)).not.toContain("payload");
      },
    );

    itDb("does not offer an item before its run_at", async () => {
      const pinned = await pinTask(
        "a1-member",
        "company-a",
        "team-a1",
        "ac1-future",
      );
      await offerDue(
        pinned,
        { tenantId: pinned.scope.tenantId },
        new Date(Date.now() + 3_600_000),
      );
      const machine = machineOf("ac1-future");
      const outcomes = mine(
        await executorRecording([]).scanAndExecute(machine),
        pinned.objectId,
      );
      expect(outcomes).toHaveLength(0);
    });
  });

  describe("AC2: the scope is rebuilt from the persisted record; message fields are hints only", () => {
    itDb(
      "executes under the authoritative record's scope, ignoring wrong message hints",
      async () => {
        const a1 = await pinTask("a1-member", "company-a", "team-a1", "ac2-a");
        // Hints name company B / team B1 / a forged principal — the message
        // never decides (Spec §6).
        await offerDue(a1, {
          tenantId: "ent-company-b-hint",
          workspaceId: "ws-team-b1-hint",
          principalId: "forged-principal",
        });

        const recorded: RecordedExecution[] = [];
        const machine = machineOf("ac2");
        const outcomes = mine(
          await executorRecording(recorded).scanAndExecute(machine),
          a1.objectId,
        );

        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]?.status).toBe("executed");
        expect(
          recorded.filter((r) => r.item.objectId === a1.objectId),
        ).toHaveLength(1);
        const execution = recorded[0] as RecordedExecution;
        expect(execution.scope.tenantId).toBe(a1.scope.tenantId);
        expect(execution.scope.workspaceId).toBe(a1.scope.workspaceId);
        expect(execution.scope.principalId).toBe(a1.scope.principalId);
        expect(execution.scope.actorId).toBe(a1.scope.actorId);
        // The rebuilt scope is a genuinely ISSUED schedule scope (issuance
        // entry), not a fabricated object.
        expect(execution.scope.entrypoint).toBe("schedule");
        assertTrustedScope(execution.scope);
        // The lease was claimed and finished under the authoritative scope,
        // not the hints: the finished row lives in the pinned company/team and
        // the claim counted exactly one attempt (holder identity is asserted
        // mid-execution in the lease-discipline suite).
        const lease = await fixture.leaseRowOf(a1.kind, a1.objectId);
        expect(lease?.finishedAt).not.toBeNull();
        expect(lease?.tenantId).toBe(a1.scope.tenantId);
        expect(lease?.workspaceId).toBe(a1.scope.workspaceId);
        expect(lease?.attempts).toBe(1);
      },
    );

    itDb(
      "refuses an item with no authoritative record, echoing nothing from the message",
      async () => {
        const CANARY = "mt042-message-canary-b91c";
        const a1 = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac2-anchor",
        );
        // A real-looking message whose object was never pinned: the scan must
        // refuse deterministically and must not echo the message's values.
        const ghostId = fixture.objectId("ac2-ghost");
        await fixture.queue.offer({
          kind: SCAN_WORK_KIND,
          key: `task:${ghostId}`,
          payload: { tenantId: a1.scope.tenantId, canary: CANARY },
        });

        const machine = machineOf("ac2-ghost");
        const outcomes = mine(
          await executorRecording([]).scanAndExecute(machine),
          ghostId,
        );

        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]?.status).toBe("refused");
        const refused = outcomes[0] as { status: string; code: string };
        expect(refused.code).toBe(SCAN_RECORD_MISSING);
        const wire = JSON.stringify(outcomes);
        expect(wire).not.toContain(CANARY);
        expect(wire).not.toContain(a1.scope.tenantId);
        // No lease was written for a record-less item.
        const ghostLease = await fixture.leaseRowOf("task", ghostId);
        expect(ghostLease).toBeUndefined();
      },
    );
  });

  describe("AC3: the machine identity is type-isolated from user identities", () => {
    itDb("is refused wherever a trusted user scope is required", async () => {
      const machine = machineOf("ac3");
      // The machine credential never enters the scope registry…
      expect(() => assertTrustedScope(machine as never)).toThrow(
        "UNVERIFIED_SCOPE",
      );
      // …so every scope-consuming service refuses it (MT041 list surface).
      await expectSentinelRejection(
        service.listJobs(machine as never),
        "UNVERIFIED_SCOPE",
      );
      // The MT005 gate refuses it in exactly the same shape.
      await expectSentinelRejection(
        fixture.gate.transaction(machine as never, async () => undefined),
        "UNVERIFIED_SCOPE",
      );
      // A hand-made look-alike is not the issued credential either
      // (structure ≠ trust, MT005 precedent).
      await expectSentinelRejection(
        Promise.resolve().then(() =>
          assertTrustedMachineIdentity({
            kind: "machine-scan",
            id: "mt042-ac3",
          }),
        ),
        "MACHINE_IDENTITY_INVALID",
      );
    });

    itDb(
      "is not a user login: dev-local-user and principal impersonation are refused",
      async () => {
        // The machine identity can never BE the local dev user…
        expect(() =>
          createMachineScanIdentity({ id: "dev-local-user" }),
        ).toThrow("MACHINE_IDENTITY_INVALID");
        const machine = machineOf("ac3-impersonate");
        // …nor authenticate as any principal: the directory knows no user for a
        // machine id, so the issuance entry refuses (TENANT_FORBIDDEN), and the
        // scan surface turns that into a machine code rather than a session.
        await expectSentinelRejection(
          fixture.issueScheduleScope({
            actorId: machine.id,
            tenantId: (
              await fixture.jobs.scopeAs("a1-member", "company-a", "team-a1")
            ).tenantId,
            workspaceId: "unused-workspace",
          }),
          "TENANT_FORBIDDEN",
        );
      },
    );

    itDb("cannot be driven by a user scope", async () => {
      const user = await fixture.jobs.scopeAs(
        "a1-member",
        "company-a",
        "team-a1",
      );
      await expectSentinelRejection(
        executorRecording(machineOf("unused"), []).scanAndExecute(
          user as never,
        ),
        MACHINE_IDENTITY_INVALID,
      );
      await expectSentinelRejection(
        executorRecording(machineOf("unused"), []).scanAndExecute(
          undefined as never,
        ),
        MACHINE_IDENTITY_INVALID,
      );
    });
  });

  describe("AC4: only the issuance entry produces a valid scope; deserialization is refused", () => {
    itDb(
      "rejects deserialized and cloned scopes and machine identities",
      async () => {
        const real = await fixture.jobs.scopeAs(
          "a1-member",
          "company-a",
          "team-a1",
        );
        const roundTripped = JSON.parse(JSON.stringify(real)) as PlatformScope;
        const cloned = structuredClone(real);
        for (const fake of [roundTripped, cloned]) {
          // Byte-shape-identical, trust-free: the gate refuses both.
          await expectSentinelRejection(
            fixture.gate.transaction(fake, async () => undefined),
            "UNVERIFIED_SCOPE",
          );
        }
        // The same holds for the machine credential: a clone cannot drive a scan.
        const machine = machineOf("ac4");
        const machineClone = structuredClone(machine);
        await expectSentinelRejection(
          executorRecording([]).scanAndExecute(machineClone as never),
          MACHINE_IDENTITY_INVALID,
        );
      },
    );
  });

  describe("execution and lease discipline (MT041 consumption)", () => {
    itDb(
      "executes under the MT041 lease, finishes it, and never re-offers a finished item",
      async () => {
        const a1 = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac-lease-done",
        );
        await offerDue(a1);
        const machine = machineOf("lease-done");
        const outcomes = mine(
          await executorRecording([]).scanAndExecute(machine),
          a1.objectId,
        );
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]?.status).toBe("executed");
        const lease = await fixture.leaseRowOf(a1.kind, a1.objectId);
        expect(lease?.finishedAt).not.toBeNull();
        expect(lease?.claimedBy).toBeNull();
        expect(lease?.attempts).toBe(1);
        // The finished work item is not offered again.
        const second = mine(
          await executorRecording([]).scanAndExecute(machine),
          a1.objectId,
        );
        expect(second).toHaveLength(0);
      },
    );

    itDb(
      "releases the lease on execution failure and the item returns as attempt 2",
      async () => {
        const a1 = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac-lease-retry",
        );
        await offerDue(a1);
        const machine = machineOf("lease-retry");
        const failing = createScanExecutor({
          platform: fixture.platform,
          operator: fixture.jobs.operator,
          jobOwnership: service,
          gate: fixture.gate,
          issueScheduleScope: fixture.issueScheduleScope,
          execute: async () => {
            throw new Error("mt042-execution-boom");
          },
        });
        const first = mine(
          await failing.scanAndExecute(machine, { retryDelayMs: 0 }),
          a1.objectId,
        );
        expect(first).toHaveLength(1);
        expect(first[0]?.status).toBe("released");
        const released = first[0] as { status: string; reason: string };
        expect(released.reason).toBe(SCAN_EXECUTION_FAILED);
        // The raw callback error is not echoed into the queue either.
        expect(released.reason).not.toContain("boom");
        const afterFailure = await fixture.leaseRowOf(a1.kind, a1.objectId);
        expect(afterFailure?.finishedAt).toBeNull();
        expect(afterFailure?.claimedBy).toBeNull();
        expect(afterFailure?.attempts).toBe(1);
        // The retry is a new attempt of the same job — not a fresh one.
        const second = mine(
          await executorRecording([]).scanAndExecute(machine, {
            retryDelayMs: 0,
          }),
          a1.objectId,
        );
        expect(second).toHaveLength(1);
        expect(second[0]?.status).toBe("executed");
        expect(second[0]?.item.attempts).toBe(2);
        const afterRetry = await fixture.leaseRowOf(a1.kind, a1.objectId);
        expect(afterRetry?.attempts).toBe(2);
        expect(afterRetry?.finishedAt).not.toBeNull();
      },
    );

    itDb(
      "skips an item whose job lease is live-held by another executor",
      async () => {
        const a1 = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac-lease-held",
        );
        await offerDue(a1);
        const otherWorker: JobExecutor = {
          kind: "worker",
          id: "mt042-other-worker",
        };
        const granted = await service.claimJobLease({
          kind: a1.kind,
          objectId: a1.objectId,
          scope: {
            tenantId: a1.scope.tenantId,
            workspaceId: a1.scope.workspaceId,
          },
          executor: otherWorker,
          leaseMs: 60_000,
        });
        expect(granted.status).toBe("granted");

        const machine = machineOf("lease-held");
        const outcomes = mine(
          await executorRecording([]).scanAndExecute(machine),
          a1.objectId,
        );
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]?.status).toBe("lease-held");
        // The other executor's lease is untouched, and the item went back for a
        // later pass rather than being finished.
        const lease = await fixture.leaseRowOf(a1.kind, a1.objectId);
        expect(lease?.claimedBy).toBe(otherWorker.id);
        expect(lease?.finishedAt).toBeNull();
        expect(lease?.attempts).toBe(1);
      },
    );

    itDb(
      "claims the lease under the machine's worker identity, visible mid-execution",
      async () => {
        const a1 = await pinTask(
          "a1-member",
          "company-a",
          "team-a1",
          "ac-lease-owner",
        );
        await offerDue(a1);
        const machine = machineOf("lease-owner");
        let holderDuringExecution: string | null | undefined;
        const probing = createScanExecutor({
          platform: fixture.platform,
          operator: fixture.jobs.operator,
          jobOwnership: service,
          gate: fixture.gate,
          issueScheduleScope: fixture.issueScheduleScope,
          execute: async (context) => {
            // Inside the gate transaction (data role, tenant context) the live
            // lease names the machine's worker id — the MT041 holder semantics.
            const [row] = await context.tx
              .select({ claimedBy: jobLeases.claimedBy })
              .from(jobLeases)
              .where(
                and(
                  eq(jobLeases.kind, context.item.jobKind),
                  eq(jobLeases.objectId, context.item.objectId),
                ),
              )
              .limit(1);
            holderDuringExecution = row?.claimedBy ?? null;
          },
        });
        const outcomes = mine(
          await probing.scanAndExecute(machine),
          a1.objectId,
        );
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]?.status).toBe("executed");
        expect(holderDuringExecution).toBe(machine.id);
      },
    );
  });

  describe("revocation and malformed input (machine semantics)", () => {
    itDb(
      "refuses an item whose company membership was revoked, before any execution",
      async () => {
        // Use a dedicated identity so the revocation cannot leak into other tests.
        const other = await pinTask(
          "a1-other",
          "company-a",
          "team-a1",
          "ac-revoke",
        );
        const suspended = await fixture.suspendCompanyMembership(
          "a1-other",
          other.scope.tenantId,
        );
        expect(suspended.changed).toBe(true);
        await offerDue(other);
        const machine = machineOf("revoke");
        const outcomes = mine(
          await executorRecording([]).scanAndExecute(machine),
          other.objectId,
        );
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]?.status).toBe("refused");
        expect((outcomes[0] as { code: string }).code).toBe(
          SCAN_SCOPE_UNRESOLVED,
        );
        // No execution, and no lease row at all: the refusal precedes claiming.
        const lease = await fixture.leaseRowOf(other.kind, other.objectId);
        expect(lease).toBeUndefined();
      },
    );

    itDb(
      "refuses an item whose team membership was revoked, before any execution",
      async () => {
        const member = await pinTask(
          "a1a2-member",
          "company-a",
          "team-a1",
          "ac-team-revoke",
        );
        await fixture.suspendTeamMembership({
          tenantId: member.scope.tenantId,
          workspaceId: member.scope.workspaceId,
          principalId: member.scope.principalId,
        });
        await offerDue(member);
        const machine = machineOf("team-revoke");
        const outcomes = mine(
          await executorRecording([]).scanAndExecute(machine),
          member.objectId,
        );
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]?.status).toBe("refused");
        expect((outcomes[0] as { code: string }).code).toBe(
          SCAN_SCOPE_UNRESOLVED,
        );
        const lease = await fixture.leaseRowOf(member.kind, member.objectId);
        expect(lease).toBeUndefined();
      },
    );

    itDb(
      "refuses a malformed key deterministically and never echoes it",
      async () => {
        // Unique per run: the queue key is identity, and a finished row from a
        // previous run must not collide with this run's refusal.
        const malformedKey = fixture.objectId("garbage");
        await fixture.queue.offer({ kind: SCAN_WORK_KIND, key: malformedKey });
        // Closed jobKind vocabulary: a syntactically valid key whose jobKind is
        // outside the word list (task/run/trigger) is the same terminal format
        // defect — the separator parse alone must not wave it through.
        const kindlessKey = `widget:${fixture.objectId("kindless")}`;
        await fixture.queue.offer({ kind: SCAN_WORK_KIND, key: kindlessKey });
        const machine = machineOf("malformed");
        const outcomes = (
          await executorRecording([]).scanAndExecute(machine)
        ).filter(
          (outcome) =>
            outcome.status === "refused" &&
            (outcome as { code: string }).code === SCAN_ITEM_MALFORMED,
        );
        // Malformed rows are terminal: this run's two keys are finished, so
        // exactly two refusals exist and no other item can produce this code.
        expect(outcomes).toHaveLength(2);
        expect(outcomes[0]?.item).toBeUndefined();
        expect(outcomes[1]?.item).toBeUndefined();
        expect(JSON.stringify(outcomes)).not.toContain(malformedKey);
        expect(JSON.stringify(outcomes)).not.toContain(kindlessKey);
      },
    );
  });
});
