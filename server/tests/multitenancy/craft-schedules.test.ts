// server/tests/multitenancy/craft-schedules.test.ts
// MT054（Issue #97）：Craft 计划任务、子任务与应用连接的归属。
//
// 验收事实源（Issue #97 四条，逐条对应 describe；真实 PostgreSQL，全程
// 受限 ob_ent_* 角色 + 真实 RLS，绝不回退开发库、缺 env 显式 skip）：
//   验收 1：计划任务保存原始归属；触发执行时重建作用域（复用 MT042
//     规则——归属只有协会行一个事实源，hint 不参与）。
//   验收 2：子任务不能引用其他范围的父任务或连接。
//   验收 3：取消计划任务只影响本范围；跨范围请求被拒绝（missing 且权威
//     store 零调用）。
//   验收 4：连接凭据通过 lease 取用，撤销后触发失败而不是静默使用他人
//     凭据。
//
// 证据可复现（票面 AC）——本套件即复现命令：
//   set +x; source /tmp/mt27-env.sh && bun --no-env-file test \
//     server/tests/multitenancy/craft-schedules.test.ts

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  isResourceNotFoundVerdict,
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import {
  type CraftTenancyFixture,
  createCraftTenancyFixture,
} from "./support/craft-tenancy";

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
      reason: `MT054 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
  throw new Error("expected the call to throw");
};

const BASIS = {
  companyRevision: 1,
  overrideRevision: null,
  document: { policy: "mt054" },
} as const;

let fixture: CraftTenancyFixture;

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createCraftTenancyFixture();
});

afterAll(async () => {
  if (fixture) await fixture.dispose();
});

/** 属主（a1-member）创建一个计划任务并 pin 归属。 */
async function pinnedScheduleOfOwner() {
  const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
  const task = await fixture.schedules.createTask({
    userId: ownerScope.actorId,
    name: "mt054 daily brief",
    prompt: "summarize the day",
    cronExpression: "0 9 * * *",
    editorMode: "daily_weekly",
    status: "active",
    nextRunAt: new Date(),
  });
  const pin = await fixture.craftSchedules.pinCraftSchedule(ownerScope, {
    taskId: task.id,
    basis: BASIS,
  });
  if (!("status" in pin)) throw new Error(`PIN_FAILED: ${JSON.stringify(pin)}`);
  return { task, ownerScope };
}

// ---------------------------------------------------------------------------
// 验收 1：计划任务保存原始归属；触发执行时重建作用域
// ---------------------------------------------------------------------------

describeDb(
  "MT054 AC1 ownership is pinned and the trigger rebuilds scope",
  () => {
    itDb(
      "pin persists the original attribution and lists it only in that scope",
      async () => {
        const { task, ownerScope } = await pinnedScheduleOfOwner();
        const listed = await fixture.craftSchedules.listSchedules(ownerScope);
        expect(listed.tasks.map((row) => row.taskId)).toContain(task.id);
        // Same company, other team: invisible.
        const otherTeamScope = await fixture.scopeAs("a1a2-member", "team-a2");
        const otherListed =
          await fixture.craftSchedules.listSchedules(otherTeamScope);
        expect(otherListed.tasks.map((row) => row.taskId)).not.toContain(
          task.id,
        );
        // Cross-company: invisible.
        const crossCompanyScope = await fixture.scopeAs("b1-member", "team-b1");
        const crossListed =
          await fixture.craftSchedules.listSchedules(crossCompanyScope);
        expect(crossListed.tasks.map((row) => row.taskId)).not.toContain(
          task.id,
        );
      },
    );

    itDb(
      "re-pinning under a different selection identity is loudly refused",
      async () => {
        // a1a2-member owns a task pinned under team-a1; re-pinning the SAME task
        // under team-a2 must be refused loudly and leave the pinned row untouched
        // (「切换团队不改变归属」——create-once 纪律).
        const memberScope = await fixture.scopeAs("a1a2-member", "team-a1");
        const task = await fixture.schedules.createTask({
          userId: memberScope.actorId,
          name: "mt054 dual-team task",
          prompt: "p",
          cronExpression: "0 9 * * *",
          editorMode: "daily_weekly",
          status: "active",
          nextRunAt: new Date(),
        });
        await fixture.craftSchedules.pinCraftSchedule(memberScope, {
          taskId: task.id,
          basis: BASIS,
        });
        const otherTeamScope = await fixture.scopeAs("a1a2-member", "team-a2");
        const message = await thrownMessage(() =>
          fixture.craftSchedules.pinCraftSchedule(otherTeamScope, {
            taskId: task.id,
            basis: BASIS,
          }),
        );
        // MT041 pin 先行：跨选择标识的重 pin 在租约物理前置处就被响亮拒绝
        // （JOB_OWNERSHIP_MISMATCH）；协会行的 CRAFT_SCHEDULE_SCOPE_MISMATCH
        // 是第二道同向防线（pin 通过而协会行不一致时触发）。
        expect(
          message.includes("JOB_OWNERSHIP_MISMATCH") ||
            message.includes("CRAFT_SCHEDULE_SCOPE_MISMATCH"),
        ).toBe(true);
        // Same triple re-pin: idempotent.
        const again = await fixture.craftSchedules.pinCraftSchedule(
          memberScope,
          {
            taskId: task.id,
            basis: BASIS,
          },
        );
        expect(again).toMatchObject({ status: "existing" });
      },
    );

    itDb(
      "trigger rebuild resolves the original scope from the association row alone",
      async () => {
        const { task, ownerScope } = await pinnedScheduleOfOwner();
        const resolution = await fixture.craftSchedules.resolveForExecution(
          fixture.machine,
          {
            taskId: task.id,
            // A hostile routing hint must not move the attribution (MT042).
            hint: { tenantId: "evil-tenant", workspaceId: "evil-workspace" },
          },
        );
        expect(resolution).toMatchObject({ outcome: "resolved" });
        if (resolution.outcome === "resolved") {
          expect(resolution.scope.tenantId).toBe(ownerScope.tenantId);
          expect(resolution.scope.workspaceId).toBe(ownerScope.workspaceId);
          expect(resolution.scope.principalId).toBe(ownerScope.principalId);
          expect(resolution.facts.userId).toBe(ownerScope.actorId);
        }
      },
    );

    itDb(
      "a machine identity that was never issued is rejected loudly",
      async () => {
        const { task } = await pinnedScheduleOfOwner();
        const message = await thrownMessage(() =>
          fixture.craftSchedules.resolveForExecution(
            { forged: true },
            {
              taskId: task.id,
            },
          ),
        );
        expect(message).toContain("UNVERIFIED_CRAFT_SCHEDULE_MACHINE_IDENTITY");
      },
    );

    itDb("an unknown task id rebuilds to missing", async () => {
      const resolution = await fixture.craftSchedules.resolveForExecution(
        fixture.machine,
        { taskId: "cst-does-not-exist" },
      );
      expect(resolution).toMatchObject({
        outcome: "missing",
        code: "CRAFT_SCHEDULE_RECORD_MISSING",
      });
    });

    itDb(
      "the fire runs under the rebuilt scope and finishes its lease",
      async () => {
        const { task, ownerScope } = await pinnedScheduleOfOwner();
        const seen: unknown[] = [];
        const outcome = await fixture.craftSchedules.runScheduledFire(
          fixture.machine,
          {
            taskId: task.id,
            executor: { kind: "principal", id: ownerScope.principalId },
            leaseMs: 5_000,
            connectionLeases: [],
            work: async (context) => {
              seen.push({
                tenantId: context.scope.tenantId,
                workspaceId: context.scope.workspaceId,
              });
            },
          },
        );
        expect(outcome).toMatchObject({ outcome: "ran" });
        expect(seen).toEqual([
          {
            tenantId: ownerScope.tenantId,
            workspaceId: ownerScope.workspaceId,
          },
        ]);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 验收 2：子任务不能引用其他范围的父任务或连接
// ---------------------------------------------------------------------------

describeDb("MT054 AC2 subtasks cannot reference outside their scope", () => {
  itDb("a subtask pins under its parent within the same triple", async () => {
    const { task, ownerScope } = await pinnedScheduleOfOwner();
    const pin = await fixture.craftSchedules.pinCraftSubtask(ownerScope, {
      subtaskId: `mt054-sub-${task.id.slice(4)}`,
      parentTaskId: task.id,
      basis: BASIS,
    });
    expect(pin).toMatchObject({ status: "pinned" });
    if ("status" in pin && pin.status === "pinned") {
      expect(pin.ownership.parentObjectId).toBe(task.id);
      expect(pin.ownership.kind).toBe("subtask");
    }
  });

  itDb(
    "a subtask referencing a cross-team parent is canonical not-found",
    async () => {
      const { task } = await pinnedScheduleOfOwner();
      const otherScope = await fixture.scopeAs("a1a2-member", "team-a2");
      const pin = await fixture.craftSchedules.pinCraftSubtask(otherScope, {
        subtaskId: "mt054-sub-cross-team",
        parentTaskId: task.id,
        basis: BASIS,
      });
      expect(isCanonicalNotFound(pin)).toBe(true);
    },
  );

  itDb(
    "a subtask referencing a cross-company parent is canonical not-found",
    async () => {
      const { task } = await pinnedScheduleOfOwner();
      const crossScope = await fixture.scopeAs("b1-member", "team-b1");
      const pin = await fixture.craftSchedules.pinCraftSubtask(crossScope, {
        subtaskId: "mt054-sub-cross-company",
        parentTaskId: task.id,
        basis: BASIS,
      });
      expect(isCanonicalNotFound(pin)).toBe(true);
    },
  );

  itDb(
    "a fire with a connection outside the rebuilt triple fails loudly",
    async () => {
      const { task, ownerScope } = await pinnedScheduleOfOwner();
      // A connection pinned in ANOTHER team of the same company.
      const otherScope = await fixture.scopeAs("a1a2-member", "team-a2");
      const foreignConnection = await fixture.craftSchedules.pinCraftConnection(
        otherScope,
        { connectionId: "mt054-conn-foreign", credentialRef: "jira" },
      );
      expect(foreignConnection).toMatchObject({ status: "pinned" });
      const outcome = await fixture.craftSchedules.runScheduledFire(
        fixture.machine,
        {
          taskId: task.id,
          executor: { kind: "principal", id: ownerScope.principalId },
          leaseMs: 5_000,
          connectionLeases: [
            { connectionId: "mt054-conn-foreign", leaseId: "x" },
          ],
          work: async () => {},
        },
      );
      expect(outcome).toMatchObject({
        outcome: "failed",
        errorClass: "CRAFT_SCHEDULE_LEASE_DENIED",
      });
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 3：取消计划任务只影响本范围
// ---------------------------------------------------------------------------

describeDb("MT054 AC3 cancel stays inside the owning scope", () => {
  itDb(
    "the owner cancels their task (soft delete keeps the history row)",
    async () => {
      const { task, ownerScope } = await pinnedScheduleOfOwner();
      const cancel = await fixture.craftSchedules.cancelSchedule(
        ownerScope,
        task.id,
      );
      expect(cancel).toMatchObject({ outcome: "cancelled" });
      if (cancel.outcome === "cancelled") {
        expect(cancel.task.deleted).toBe(true);
      }
      // The live listing no longer carries the cancelled task (the craft list
      // face shows non-deleted rows); the history row survives soft delete.
      const listed = await fixture.craftSchedules.listSchedules(ownerScope);
      expect(listed.tasks.map((row) => row.taskId)).not.toContain(task.id);
      const raw = await fixture.schedules.getTaskById(task.id);
      expect(raw?.deleted).toBe(true);
    },
  );

  itDb(
    "a cross-team cancel answers missing and never touches the row",
    async () => {
      const { task } = await pinnedScheduleOfOwner();
      const before = await fixture.schedules.getTaskById(task.id);
      const otherScope = await fixture.scopeAs("a1a2-member", "team-a2");
      const cancel = await fixture.craftSchedules.cancelSchedule(
        otherScope,
        task.id,
      );
      expect(cancel).toMatchObject({ outcome: "missing" });
      const after = await fixture.schedules.getTaskById(task.id);
      expect(after?.deleted).toBe(before?.deleted);
      expect(after?.status).toBe(before?.status);
    },
  );

  itDb("a cross-company cancel answers missing too", async () => {
    const { task } = await pinnedScheduleOfOwner();
    const crossScope = await fixture.scopeAs("b1-member", "team-b1");
    const cancel = await fixture.craftSchedules.cancelSchedule(
      crossScope,
      task.id,
    );
    expect(cancel).toMatchObject({ outcome: "missing" });
  });

  itDb(
    "the list face refuses loudly once the company membership is suspended",
    async () => {
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      await fixture.suspendCompany("a1-member", "company-a");
      const message = await thrownMessage(() =>
        fixture.craftSchedules.listSchedules(ownerScope),
      );
      expect(message).toContain("SCOPE_REVOKED");
      // Reactivate for later describes in this file.
      await fixture.base.setCompanyMembershipStatus(
        "a1-member",
        "company-a",
        "active",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 4：连接凭据通过 lease 取用，撤销后触发失败
// ---------------------------------------------------------------------------

describeDb("MT054 AC4 connection credentials ride the lease", () => {
  itDb(
    "a fire with a live lease resolves the owner's own credential",
    async () => {
      const { task, ownerScope } = await pinnedScheduleOfOwner();
      const { credentialId, leaseId } =
        await fixture.provisionPersonalCredentialWithLease({
          owner: "a1-member",
          team: "team-a1",
          target: "jira",
          plaintext: "mt054-owner-secret",
        });
      const connectionPin = await fixture.craftSchedules.pinCraftConnection(
        ownerScope,
        { connectionId: "mt054-conn-own", credentialRef: "jira" },
      );
      expect(connectionPin).toMatchObject({ status: "pinned" });
      let seenCredentials: readonly {
        connectionId: string;
        credentialId: string;
      }[] = [];
      const outcome = await fixture.craftSchedules.runScheduledFire(
        fixture.machine,
        {
          taskId: task.id,
          executor: { kind: "principal", id: ownerScope.principalId },
          leaseMs: 5_000,
          connectionLeases: [{ connectionId: "mt054-conn-own", leaseId }],
          work: async (context) => {
            seenCredentials = context.credentials;
          },
        },
      );
      expect(outcome).toMatchObject({ outcome: "ran" });
      expect(seenCredentials).toEqual([
        { connectionId: "mt054-conn-own", credentialId },
      ]);
    },
  );

  itDb("a revoked lease fails the fire with zero work executed", async () => {
    const { task, ownerScope } = await pinnedScheduleOfOwner();
    const { leaseId } = await fixture.provisionPersonalCredentialWithLease({
      owner: "a1-member",
      team: "team-a1",
      target: "hubspot",
      plaintext: "mt054-owner-secret-2",
    });
    await fixture.craftSchedules.pinCraftConnection(ownerScope, {
      connectionId: "mt054-conn-revoked",
      credentialRef: "hubspot",
    });
    await fixture.leaseAdmin.revoke({
      tenantId: ownerScope.tenantId,
      leaseId,
    });
    let worked = false;
    const outcome = await fixture.craftSchedules.runScheduledFire(
      fixture.machine,
      {
        taskId: task.id,
        executor: { kind: "principal", id: ownerScope.principalId },
        leaseMs: 5_000,
        connectionLeases: [{ connectionId: "mt054-conn-revoked", leaseId }],
        work: async () => {
          worked = true;
        },
      },
    );
    expect(outcome).toMatchObject({
      outcome: "failed",
      errorClass: "CRAFT_SCHEDULE_LEASE_DENIED",
    });
    expect(worked).toBe(false);
  });

  itDb(
    "a lease signed for another principal's credential never validates",
    async () => {
      const { task, ownerScope } = await pinnedScheduleOfOwner();
      // The TEAMMATE issues a lease on their own credential; the owner's fire
      // tries to ride it — the lease binding does not match the rebuilt scope.
      const teammate = await fixture.provisionPersonalCredentialWithLease({
        owner: "a1-other",
        team: "team-a1",
        target: "jira",
        plaintext: "mt054-teammate-secret",
      });
      await fixture.craftSchedules.pinCraftConnection(ownerScope, {
        connectionId: "mt054-conn-teammates",
        credentialRef: "jira",
      });
      let worked = false;
      const outcome = await fixture.craftSchedules.runScheduledFire(
        fixture.machine,
        {
          taskId: task.id,
          executor: { kind: "principal", id: ownerScope.principalId },
          leaseMs: 5_000,
          connectionLeases: [
            { connectionId: "mt054-conn-teammates", leaseId: teammate.leaseId },
          ],
          work: async () => {
            worked = true;
          },
        },
      );
      expect(outcome).toMatchObject({ outcome: "failed" });
      expect(worked).toBe(false);
    },
  );
});
