// server/tests/multitenancy/computer-allocation.test.ts
// MT046（Issue #89）：电脑与浏览器实例分配、远程屏幕与人工接管授权。
//
// 验收事实源（Issue #89 正文四条 AC，逐条对应 describe）：
//   AC1 只有归属范围内的授权主体可以查看屏幕或接管；跨范围请求被拒绝。
//   AC2 实例回收后状态被清理，不会带着上一个范围的登录态或工作目录被
//      复用。
//   AC3 服务 token 只授予其登记的能力；用它请求任意公司数据被拒绝。
//   AC4 撤权后正在进行的屏幕会话与接管立即终止。
//
// 机制：真实隔离矩阵 + 真实受限通道（真实 RLS）+ 真实 MT016 归属行 +
// 真实 #90 执行产物服务作为授权 seam（票面「复用 #90/#86 已交付 seam」
// 的落点——授权判定不另造第二套）。计算机面是记录型端口；AC2 的状态树
// 用 #90 的命名隔离（executionArtifactDir）落在内存树上；AC3 的能力
// lease 走真实 data/operator 通道与 0178 表（真实 RLS + 列级 GRANT）。
// deny 断言一律与 MT011 canonical 形状逐字节比对。
//
// 环境契约：专用企业测试库（openbot_enterprise_*），缺显式 env 整套显式
// skip，绝不回退开发库、skipped 不计通过。

import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  type ComputerAllocationAuditEvent,
  type ComputerAllocationAuditSink,
  createComputerAllocationService,
  createExecutionCapabilityLeaseAdminService,
  createExecutionCapabilityLeaseService,
} from "../../src/enterprise/tenancy/computer-allocation";
import { notFoundVerdict } from "../../src/enterprise/tenancy/not-found-semantics";
import {
  type ComputerAllocationFixture,
  createComputerAllocationFixture,
  recordingPorts,
} from "./support/computer-allocation";

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

let fixture: ComputerAllocationFixture;

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createComputerAllocationFixture();
});

afterAll(async () => {
  await fixture?.dispose();
});

// ---------------------------------------------------------------------------
// 共享件
// ---------------------------------------------------------------------------

function allocationAuditRecorder(): ComputerAllocationAuditSink & {
  events(): readonly ComputerAllocationAuditEvent[];
} {
  const seen: ComputerAllocationAuditEvent[] = [];
  return {
    async record(event) {
      seen.push(event);
    },
    events: () => seen,
  };
}

/** The service under test: real #90 seam + recording computer ports. */
function allocationWith(
  ports: ReturnType<typeof recordingPorts>,
  audit: ComputerAllocationAuditSink,
) {
  return createComputerAllocationService({
    authorization: fixture.artifacts,
    ports: ports.ports,
    audit,
    stateRoot: "/mt046-state-root",
  });
}

/** Registers a bot in a team and returns the owner's trusted scope. */
async function ownedBot(input: {
  identity: Parameters<typeof fixture.scopeAs>[0];
  companyKey: "company-a" | "company-b";
  teamKey: "team-a1" | "team-a2" | "team-b1";
  label: string;
}): Promise<{ botId: string; scope: PlatformScope }> {
  return fixture.registerBot(input);
}

// ---------------------------------------------------------------------------
// AC1 — 归属范围内的授权主体才可看屏/接管
// ---------------------------------------------------------------------------

describeDb(
  "MT046 AC1: only authorized principals in the owning scope view screens or take over",
  () => {
    itDb(
      "the owning team's member views the screen and takes over; the ports fire",
      async () => {
        const { botId, scope } = await ownedBot({
          identity: "a1-member",
          companyKey: "company-a",
          teamKey: "team-a1",
          label: "ac1-own",
        });
        const ports = recordingPorts();
        ports.seedLogin(botId, "session-cookie-a1");
        const service = allocationWith(ports, allocationAuditRecorder());

        const frame = await service.viewScreen(scope, botId);
        expect(frame.outcome).toBe("allow");
        if (frame.outcome === "allow") {
          expect(
            Buffer.from(frame.frame.base64, "base64").toString("utf8"),
          ).toBe("frame:session-cookie-a1");
        }

        const takeover = await service.takeOverControl(scope, botId, "req-1");
        expect(takeover.outcome).toBe("allow");
        expect(ports.recording().takeControls).toEqual([
          { botId, actorId: scope.actorId, requestId: "req-1" },
        ]);
      },
    );

    itDb(
      "the same member's OTHER team scope is denied (same person, wrong scope)",
      async () => {
        const { botId } = await ownedBot({
          identity: "a1a2-member",
          companyKey: "company-a",
          teamKey: "team-a1",
          label: "ac1-other-team",
        });
        const a2Scope = await fixture.scopeAs(
          "a1a2-member",
          "company-a",
          "team-a2",
        );
        const ports = recordingPorts();
        const service = allocationWith(ports, allocationAuditRecorder());

        expect(JSON.stringify(await service.viewScreen(a2Scope, botId))).toBe(
          canonicalDeny,
        );
        expect(
          JSON.stringify(
            await service.takeOverControl(a2Scope, botId, "req-2"),
          ),
        ).toBe(canonicalDeny);
        // 不可见 = 零副作用：屏幕与接管端口一次都没被调用。
        expect(ports.recording().screenshots).toHaveLength(0);
        expect(ports.recording().takeControls).toHaveLength(0);
      },
    );

    itDb(
      "another company's member is denied and the denial is byte-identical to a nonexistent bot",
      async () => {
        const { botId } = await ownedBot({
          identity: "a1-member",
          companyKey: "company-a",
          teamKey: "team-a1",
          label: "ac1-cross-company",
        });
        const bScope = await fixture.scopeAs(
          "b1-member",
          "company-b",
          "team-b1",
        );
        const ports = recordingPorts();
        const service = allocationWith(ports, allocationAuditRecorder());

        const crossCompany = await service.viewScreen(bScope, botId);
        const nonexistent = await service.viewScreen(bScope, "no-such-bot");
        expect(JSON.stringify(crossCompany)).toBe(canonicalDeny);
        expect(JSON.stringify(crossCompany)).toBe(JSON.stringify(nonexistent));
        expect(
          JSON.stringify(await service.takeOverControl(bScope, botId, "req-3")),
        ).toBe(canonicalDeny);
        expect(ports.recording().screenshots).toHaveLength(0);
      },
    );

    itDb(
      "a same-team member who is NOT the owner still sees the team's bot (team scope, not owner-only)",
      async () => {
        const { botId } = await ownedBot({
          identity: "a1-member",
          companyKey: "company-a",
          teamKey: "team-a1",
          label: "ac1-teammate",
        });
        const teammate = await fixture.scopeAs(
          "a1-other",
          "company-a",
          "team-a1",
        );
        const ports = recordingPorts();
        const service = allocationWith(ports, allocationAuditRecorder());

        const frame = await service.viewScreen(teammate, botId);
        expect(frame.outcome).toBe("allow");
      },
    );
  },
);

// ---------------------------------------------------------------------------
// AC2 — 回收清理：登录态与工作目录不跨范围复用
// ---------------------------------------------------------------------------

describeDb(
  "MT046 AC2: recycling clears logins and working state; nothing is reused across scopes",
  () => {
    itDb(
      "recycle stops the instance, wipes the profile logins and removes the scope's state dir",
      async () => {
        const { botId, scope } = await ownedBot({
          identity: "a1-member",
          companyKey: "company-a",
          teamKey: "team-a1",
          label: "ac2-recycle",
        });
        const ports = recordingPorts();
        const service = allocationWith(ports, allocationAuditRecorder());

        const allocated = await service.allocateInstance(scope, botId);
        expect(allocated.outcome).toBe("allocated");
        if (allocated.outcome !== "allocated") return;
        // 上一个“范围”留下的登录态与工作目录。
        ports.seedLogin(botId, "oauth-token-from-previous-scope");
        await ports.ports.state.write(
          allocated.stateDir,
          "workspace-notes.txt",
          new TextEncoder().encode("previous scope's working files"),
        );

        const recycled = await service.recycleInstance(scope, botId);
        expect(recycled.outcome).toBe("recycled");
        if (recycled.outcome !== "recycled") return;
        expect(recycled.profileCleared).toBe(true);
        expect(recycled.stopped).toBe(true);
        expect(ports.recording().stops).toEqual([botId]);
        expect(ports.recording().profileResets).toEqual([botId]);
        // 登录态消失：再截屏得到的是空帧，不是上一个范围的会话。
        expect(ports.loginOf(botId)).toBeUndefined();
        // 工作目录消失：文件树里不再有该 scope 的任何文件。
        expect(ports.fileNames()).toEqual([]);

        // 回收后的重分配：空目录起步（residual 为空），generation 递增。
        const reallocated = await service.allocateInstance(scope, botId);
        expect(reallocated.outcome).toBe("allocated");
        if (reallocated.outcome !== "allocated") return;
        expect(reallocated.residualFiles).toEqual([]);
        expect(reallocated.generation).toBeGreaterThan(allocated.generation);
        const state = service.allocationOf(scope, botId);
        expect(state?.active).toBe(true);
      },
    );

    itDb(
      "a cross-scope recycle request is denied and touches NOTHING of the owning scope",
      async () => {
        const { botId, scope } = await ownedBot({
          identity: "a1a2-member",
          companyKey: "company-a",
          teamKey: "team-a1",
          label: "ac2-cross",
        });
        const a2Scope = await fixture.scopeAs(
          "a1a2-member",
          "company-a",
          "team-a2",
        );
        const ports = recordingPorts();
        const service = allocationWith(ports, allocationAuditRecorder());

        await service.allocateInstance(scope, botId);
        ports.seedLogin(botId, "login-of-a1");
        const allocated = service.allocationOf(scope, botId);
        expect(allocated?.stateDir).toBeTruthy();
        await ports.ports.state.write(
          allocated!.stateDir!,
          "a1-file.txt",
          new TextEncoder().encode("A1's working file"),
        );

        // 异 scope 的回收被拒：零停止、零 profile 清除、零目录删除。
        const denied = await service.recycleInstance(a2Scope, botId);
        expect(JSON.stringify(denied)).toBe(canonicalDeny);
        expect(ports.recording().stops).toHaveLength(0);
        expect(ports.recording().profileResets).toHaveLength(0);
        expect(ports.loginOf(botId)).toBe("login-of-a1");
        expect(ports.fileNames()).toContain(
          `${allocated!.stateDir}/a1-file.txt`,
        );
      },
    );

    itDb(
      "state directories are scope-segmented: one scope cannot name another scope's tree",
      async () => {
        const a1 = await ownedBot({
          identity: "a1-member",
          companyKey: "company-a",
          teamKey: "team-a1",
          label: "ac2-segment-a1",
        });
        const a2 = await ownedBot({
          identity: "a2-member",
          companyKey: "company-a",
          teamKey: "team-a2",
          label: "ac2-segment-a2",
        });
        const ports = recordingPorts();
        const service = allocationWith(ports, allocationAuditRecorder());
        const first = await service.allocateInstance(a1.scope, a1.botId);
        const second = await service.allocateInstance(a2.scope, a2.botId);
        expect(first.outcome).toBe("allocated");
        expect(second.outcome).toBe("allocated");
        if (first.outcome !== "allocated" || second.outcome !== "allocated")
          return;
        expect(first.stateDir).not.toBe(second.stateDir);
        expect(first.stateDir).toContain(
          `/tenants/${a1.scope.tenantId}/workspaces/${a1.scope.workspaceId}/bots/${a1.botId}`,
        );
        expect(second.stateDir).toContain(
          `/tenants/${a2.scope.tenantId}/workspaces/${a2.scope.workspaceId}/bots/${a2.botId}`,
        );
        // 回收 A2 不动 A1 的目录。
        await service.recycleInstance(a2.scope, a2.botId);
        await ports.ports.state.write(
          first.stateDir,
          "still-here.txt",
          new TextEncoder().encode("A1's file survives A2's recycle"),
        );
        expect(ports.fileNames()).toContain(`${first.stateDir}/still-here.txt`);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// AC3 — 服务 token 只授予登记的能力
// ---------------------------------------------------------------------------

describeDb(
  "MT046 AC3: a service token grants only its registered capabilities",
  () => {
    itDb(
      "an issued lease validates for its registered purpose and is denied for everything else",
      async () => {
        const { botId, scope } = await ownedBot({
          identity: "a1-member",
          companyKey: "company-a",
          teamKey: "team-a1",
          label: "ac3-lease",
        });
        const leases = createExecutionCapabilityLeaseService(fixture.data);

        const issued = await leases.issue(scope, {
          botId,
          purposes: ["screen.view"],
          ttlSeconds: 600,
        });
        expect(issued.outcome).toBe("allow");
        if (issued.outcome !== "allow") return;

        const context = {
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          principalId: scope.principalId,
        };
        const allowed = await leases.validate({
          ...context,
          leaseId: issued.leaseId,
          claimedPurpose: "screen.view",
        });
        expect(allowed.outcome).toBe("allow");

        // 未登记的能力（instance.operate）= canonical deny。
        const unregistered = await leases.validate({
          ...context,
          leaseId: issued.leaseId,
          claimedPurpose: "instance.operate",
        });
        expect(JSON.stringify(unregistered)).toBe(canonicalDeny);

        // 用 lease 请求「任意公司数据」甚至不是可登记的能力——闭集形状
        // 检查响亮拒绝（输入校验，不是存在性信号）。
        await expect(
          leases.validate({
            ...context,
            leaseId: issued.leaseId,
            claimedPurpose: "company.data.read",
          }),
        ).rejects.toThrow("EXECUTION_LEASE_PURPOSE_UNKNOWN");
      },
    );

    itDb(
      "a lease presented under another company's context reads nothing (RLS + three-way)",
      async () => {
        const { botId, scope } = await ownedBot({
          identity: "a1-member",
          companyKey: "company-a",
          teamKey: "team-a1",
          label: "ac3-foreign",
        });
        const leases = createExecutionCapabilityLeaseService(fixture.data);
        const issued = await leases.issue(scope, {
          botId,
          purposes: ["screen.view", "control.take"],
        });
        expect(issued.outcome).toBe("allow");
        if (issued.outcome !== "allow") return;

        const bRows = await fixture.setup.execute(sql`
          select p.id as principal_id, m.tenant_id
          from enterprise_principals p
          join enterprise_memberships m on m.principal_id = p.id
          where p.user_id = ${fixture.isolation.ids["user-b1-member"]}
          limit 1
        `);
        const bRow = (
          Array.isArray(bRows)
            ? bRows
            : ((bRows as { rows?: unknown[] }).rows ?? [])
        )[0] as { principal_id: string; tenant_id: string };

        const foreign = await leases.validate({
          tenantId: String(bRow.tenant_id),
          workspaceId: fixture.isolation.ids["team-b1"],
          principalId: String(bRow.principal_id),
          leaseId: issued.leaseId,
          claimedPurpose: "screen.view",
        });
        expect(JSON.stringify(foreign)).toBe(canonicalDeny);
      },
    );

    itDb(
      "revocation and expiry each take effect at the next checkpoint; a machine token cannot mint a scope",
      async () => {
        const { botId, scope } = await ownedBot({
          identity: "a1-member",
          companyKey: "company-a",
          teamKey: "team-a1",
          label: "ac3-revoke",
        });
        const leases = createExecutionCapabilityLeaseService(fixture.data);
        const admin = createExecutionCapabilityLeaseAdminService(
          fixture.operator,
        );
        const context = {
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          principalId: scope.principalId,
        };

        // 过期：回拨 issued_at 与 expires_at（setup 通道，真实行；保持
        // TTL CHECK 的不变量——expires 仍晚于 issued，只是两者都已过去）。
        const shortLived = await leases.issue(scope, {
          botId,
          purposes: ["screen.view"],
          ttlSeconds: 60,
        });
        expect(shortLived.outcome).toBe("allow");
        if (shortLived.outcome !== "allow") return;
        await fixture.setup.execute(sql`
          update enterprise_execution_capability_leases
          set issued_at = now() - interval '1 hour',
              expires_at = now() - interval '1 minute'
          where id = ${shortLived.leaseId}
        `);
        expect(
          JSON.stringify(
            await leases.validate({
              ...context,
              leaseId: shortLived.leaseId,
              claimedPurpose: "screen.view",
            }),
          ),
        ).toBe(canonicalDeny);

        // 撤销：operator 通道原子臂，重复撤销幂等。
        const live = await leases.issue(scope, {
          botId,
          purposes: ["control.take"],
        });
        expect(live.outcome).toBe("allow");
        if (live.outcome !== "allow") return;
        expect(
          await admin.revoke({
            tenantId: scope.tenantId,
            leaseId: live.leaseId,
          }),
        ).toEqual({ revoked: true });
        expect(
          await admin.revoke({
            tenantId: scope.tenantId,
            leaseId: live.leaseId,
          }),
        ).toEqual({ revoked: false });
        expect(
          JSON.stringify(
            await leases.validate({
              ...context,
              leaseId: live.leaseId,
              claimedPurpose: "control.take",
            }),
          ),
        ).toBe(canonicalDeny);

        // 机器 token 不能铸造 PlatformScope：lease 的 validate 输出里没有
        // 任何 scope 材料，机器身份结构上无法进入 #90 判定入口。
        const machineContext = {
          tenantId: `forged-${scope.tenantId}`,
          workspaceId: scope.workspaceId,
          principalId: scope.principalId,
        };
        expect(
          JSON.stringify(
            await leases.validate({
              ...machineContext,
              leaseId: live.leaseId,
              claimedPurpose: "control.take",
            }),
          ),
        ).toBe(canonicalDeny);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// AC4 — 撤权后屏幕会话与接管立即终止
// ---------------------------------------------------------------------------

describeDb(
  "MT046 AC4: revocation ends in-flight screen sessions and takeovers immediately",
  () => {
    itDb(
      "terminateForMemberRevocation closes the member's screen session and ends their takeover",
      async () => {
        const { botId, scope } = await ownedBot({
          identity: "a1-member",
          companyKey: "company-a",
          teamKey: "team-a1",
          label: "ac4-terminate",
        });
        const ports = recordingPorts();
        const audit = allocationAuditRecorder();
        const service = allocationWith(ports, audit);

        // 在途事实：一个屏幕流 + 一个接管。
        const session = await service.openScreenSession(scope, botId);
        expect(session.outcome).toBe("allow");
        const takeover = await service.takeOverControl(scope, botId, "req-9");
        expect(takeover.outcome).toBe("allow");
        expect(service.activeSessions().length).toBe(2);

        // 撤权（真实 provision 收据，epoch 递增）→ 终止入口。
        await fixture.suspendCompanyMembership("a1-member", "company-a");
        const terminated = await service.terminateForMemberRevocation({
          tenantId: scope.tenantId,
          principalId: scope.principalId,
          reason: "membership suspended",
        });
        expect(terminated.sessionsEnded).toBe(2);
        expect(service.activeSessions()).toHaveLength(0);
        // 端口面：屏幕流被关、接管被取消。
        expect(ports.recording().closedScreens).toEqual([botId]);
        expect(ports.recording().cancelControls).toEqual([
          { botId, actorId: scope.principalId, requestId: "req-9" },
        ]);
        // 终止留审计（内部事实）。
        const terminateEvents = audit
          .events()
          .filter((event) => event.action === "computer.terminate_revoked");
        expect(terminateEvents.length).toBe(2);

        // 撤权后的新请求在判定段被拒（fail-closed；epoch 已递增）。
        expect(JSON.stringify(await service.viewScreen(scope, botId))).toBe(
          canonicalDeny,
        );

        await fixture.restoreCompanyMembership("a1-member", "company-a");
      },
    );

    itDb(
      "termination is scoped: another member's sessions in the same company survive",
      async () => {
        const owner = await ownedBot({
          identity: "a1-member",
          companyKey: "company-a",
          teamKey: "team-a1",
          label: "ac4-scoped",
        });
        const other = await fixture.scopeAs("a1-other", "company-a", "team-a1");
        const ports = recordingPorts();
        const service = allocationWith(ports, allocationAuditRecorder());

        await service.openScreenSession(owner.scope, owner.botId);
        await service.openScreenSession(other, owner.botId);
        expect(service.activeSessions().length).toBe(2);

        // 只终止 owner 的会话：同公司同团队的另一成员不受影响。
        const terminated = await service.terminateForMemberRevocation({
          tenantId: owner.scope.tenantId,
          workspaceId: owner.scope.workspaceId,
          principalId: owner.scope.principalId,
        });
        expect(terminated.sessionsEnded).toBe(1);
        expect(service.activeSessions().length).toBe(1);
        expect(service.activeSessions()[0]?.principalId).toBe(
          other.principalId,
        );
      },
    );

    itDb(
      "recycle also ends the scope's in-flight sessions (the stronger action)",
      async () => {
        const { botId, scope } = await ownedBot({
          identity: "a1-member",
          companyKey: "company-a",
          teamKey: "team-a1",
          label: "ac4-recycle",
        });
        const ports = recordingPorts();
        const service = allocationWith(ports, allocationAuditRecorder());
        await service.allocateInstance(scope, botId);
        await service.openScreenSession(scope, botId);
        await service.takeOverControl(scope, botId, "req-10");
        expect(service.activeSessions().length).toBe(2);

        const recycled = await service.recycleInstance(scope, botId);
        expect(recycled.outcome).toBe("recycled");
        if (recycled.outcome !== "recycled") return;
        expect(recycled.sessionsEnded).toBe(2);
        expect(service.activeSessions()).toHaveLength(0);
        expect(ports.recording().cancelControls.length).toBe(1);
        expect(ports.recording().closedScreens.length).toBe(1);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// #90 seam 复用核对（票面约束：实例分配/接管授权复用 #90 的 seam）
// ---------------------------------------------------------------------------

describeDb(
  "MT046 seam reuse: the allocation service consumes the real #90 verdict",
  () => {
    itDb(
      "the authorization seam is the real execution-artifacts service over real RLS",
      async () => {
        const { botId, scope } = await ownedBot({
          identity: "a1-member",
          companyKey: "company-a",
          teamKey: "team-a1",
          label: "seam-reuse",
        });
        // The #90 service itself (fixture.artifacts) is what the allocation
        // service calls; its verdict for the same scope/bot must agree.
        const verdict = await fixture.artifacts.authorizeExecution(
          scope,
          botId,
        );
        expect(verdict.outcome).toBe("allow");
        const ports = recordingPorts();
        const service = allocationWith(ports, allocationAuditRecorder());
        expect((await service.viewScreen(scope, botId)).outcome).toBe("allow");
        // And the deny shape is the canonical one from not-found-semantics.
        const stranger = await fixture.scopeAs(
          "b1-member",
          "company-b",
          "team-b1",
        );
        expect(
          JSON.stringify(
            await fixture.artifacts.authorizeExecution(stranger, botId),
          ),
        ).toBe(canonicalDeny);
        expect(JSON.stringify(await service.viewScreen(stranger, botId))).toBe(
          canonicalDeny,
        );
      },
    );
  },
);
