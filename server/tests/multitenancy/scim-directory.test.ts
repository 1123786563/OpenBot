// server/tests/multitenancy/scim-directory.test.ts
// MT026（Issue #69）：公司范围的 SCIM 目录反应——离职只撤销本公司的成员
// 资格与资源权限。
//
// 验收事实源（Issue #69 验收 1/3，逐条对应 describe）：
//   (1) 公司 A 的 SCIM 停用只影响公司 A 的成员资格；公司 B 的资格与全局
//       登录不受影响。
//   (3) SCIM 请求不能创建或修改其他公司的成员关系。
//
// 判定事实与测试手段：
//   - 归属：绑定解析按 connection_key（RLS 连接键臂，pin
//     app.scim_connection_key）——未知连接 SCIM_CONNECTION_NOT_BOUND、已停用
//     绑定 SCIM_CONNECTION_DEACTIVATED，两种情况都零成员变更。
//   - 停用：单一 operator 事务内——成员行 suspended + epoch+1、该公司资源
//     授权行逐行删除（撤权=删行范式）、绑定行记录 last_deprovision 事实、
//     审计事件写 enterprise_security_events（本模块封闭事件集合）。用
//     multi-company 身份（同时是 A/B 两家成员、在 A 持 resource-a1 授权）
//     逐项断言 A 撤销、B 与全局身份原样。
//   - 恢复：仅当成员行当前 epoch === 绑定行所记停用 epoch 且 principal
//     匹配（服务端持久事实）才允许——期间管理员动过成员行即拒绝
//     （SCIM_REPROVISION_NOT_ALLOWED，管理员决定优先）。
//   - 供应：租户永远来自绑定行，签名没有租户字段；输入对象携带 tenantId
//     一律 TENANT_ATTRIBUTION_NOT_ACCEPTABLE；目录永不授予管理角色
//     （SCIM_ROLE_NOT_ASSIGNABLE）；已存在成员关系零写入幂等。
//
// 环境契约：同 sso-scim-config.test.ts——缺显式 env 整套显式 skip，绝不回退
// 开发库。

import { afterAll, beforeAll, describe, expect, test } from "../../../tests/support/bun-test-compat";
import { createWorkspaceAdminService } from "../../src/enterprise/tenancy/workspace-admin";
import { createSsoScimFixture, type SsoScimFixture } from "./support/sso-scim";

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
      reason: `MT026 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

let fixture: SsoScimFixture;
let adminService: ReturnType<typeof createWorkspaceAdminService>;

const CONNECTION_A = "directory:company-a";
const CONNECTION_B = "directory:company-b";

/** Live membership fact for (tenant, principal) under the operator role. */
async function membershipOf(tenantId: string, principalId: string) {
  const rows = await fixture.isolation.queryRestricted(
    "operator",
    { tenantId },
    "select status, epoch from enterprise_memberships where principal_id = $1",
    [principalId],
  );
  return rows[0] as { status: string; epoch: number } | undefined;
}

/** Live grant count for (tenant, principal) under the operator role. */
async function grantCountOf(tenantId: string, principalId: string) {
  const rows = await fixture.isolation.queryRestricted(
    "operator",
    { tenantId },
    "select count(*)::int as n from enterprise_resource_grants where principal_id = $1",
    [principalId],
  );
  return Number((rows[0] as { n: number } | undefined)?.n ?? 0);
}

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createSsoScimFixture();
  adminService = createWorkspaceAdminService(fixture.operator);
  // Company A and B each register one active directory binding (the company
  // management plane is the only writer — same discipline as production).
  const contextOfA = await fixture.adminContextOf("company-admin", "company-a");
  await fixture.configService.registerScimBinding(contextOfA, {
    connectionKey: CONNECTION_A,
    credentialRef: "credentials/scim/company-a/token",
  });
  const contextOfB = await fixture.adminContextOf("b-admin", "company-b");
  await fixture.configService.registerScimBinding(contextOfB, {
    connectionKey: CONNECTION_B,
    credentialRef: "credentials/scim/company-b/token",
  });
});

afterAll(async () => {
  await fixture?.dispose();
});

describeDb(
  "MT026 AC1: company A's SCIM deprovision touches company A only",
  () => {
    itDb(
      "an unknown connection resolves to NOT_BOUND and the membership side stays untouched",
      async () => {
        const multi = fixture.isolation.identities["multi-company"];
        const membershipA = multi.companies.find(
          (c) => c.companyKey === "company-a",
        );
        const before = await membershipOf(
          fixture.isolation.ids["company-a"],
          membershipA!.principalId,
        );
        await expect(
          fixture.reconciler.resolveBinding("no-such-connection"),
        ).rejects.toThrow("SCIM_CONNECTION_NOT_BOUND");
        await expect(
          fixture.reconciler.deprovisionMember("no-such-connection", {
            userId: multi.userId!,
          }),
        ).rejects.toThrow("SCIM_CONNECTION_NOT_BOUND");
        const after = await membershipOf(
          fixture.isolation.ids["company-a"],
          membershipA!.principalId,
        );
        expect(after).toEqual(before);
      },
    );

    itDb(
      "deactivating the directory member in company A revokes company A's membership, grants, and nothing else",
      async () => {
        const multi = fixture.isolation.identities["multi-company"];
        const tenantA = fixture.isolation.ids["company-a"];
        const tenantB = fixture.isolation.ids["company-b"];
        const membershipA = multi.companies.find(
          (c) => c.companyKey === "company-a",
        )!;
        const membershipB = multi.companies.find(
          (c) => c.companyKey === "company-b",
        )!;
        const epochBBefore = (
          await membershipOf(tenantB, membershipB.principalId)
        )?.epoch;
        const grantsBBefore = await grantCountOf(
          tenantB,
          membershipB.principalId,
        );
        expect(grantsBBefore).toBeGreaterThan(0);

        const report = await fixture.reconciler.deprovisionMember(
          CONNECTION_A,
          {
            userId: multi.userId!,
          },
        );
        expect(report.outcome).toBe("deprovisioned");
        if (report.outcome !== "deprovisioned") return;
        expect(report.tenantId).toBe(tenantA);
        expect(report.membership.status).toBe("suspended");
        expect(report.membership.epoch).toBe(membershipA.epoch + 1);
        expect(report.grantsDeleted).toBeGreaterThan(0);
        expect(report.auditEventId).toBeTruthy();

        // Company A: membership suspended, grants gone.
        const afterA = await membershipOf(tenantA, membershipA.principalId);
        expect(afterA).toMatchObject({
          status: "suspended",
          epoch: membershipA.epoch + 1,
        });
        expect(await grantCountOf(tenantA, membershipA.principalId)).toBe(0);

        // Company B: untouched — same membership row, same epoch, grants intact.
        const afterB = await membershipOf(tenantB, membershipB.principalId);
        expect(afterB).toMatchObject({ status: "active", epoch: epochBBefore });
        expect(await grantCountOf(tenantB, membershipB.principalId)).toBe(
          grantsBBefore,
        );

        // Global identity: untouched. The restricted roles hold NO grants on the
        // deployment identity plane (users, sessions, revoked_access), so a
        // company-scoped directory reaction is structurally unable to affect
        // global login; what IS reachable proves the point — the global principal
        // behind the user still lives, still active (directory self-read seam).
        const principalRows = await fixture.isolation.queryRestricted(
          "directory",
          {
            tenantId: fixture.isolation.ids["company-a"],
            principalId: membershipA.principalId,
          },
          "select id, user_id, status from enterprise_principals where user_id = $1",
          [multi.userId!],
        );
        expect(principalRows).toHaveLength(1);
        expect(principalRows[0]).toMatchObject({
          id: membershipA.principalId,
          user_id: multi.userId,
          status: "active",
        });
      },
    );

    itDb(
      "the deprovision audit event is on the trail, readable through its operation pin",
      async () => {
        // Provision a fresh member on company A's connection; the report carries
        // the audit event id (which IS the operation id — the only door the
        // restricted role has into enterprise_security_events, by design).
        const target = await fixture.scimTargetUser("audit");
        const provisioned = await fixture.reconciler.provisionMember(
          CONNECTION_A,
          {
            userId: target.userId,
          },
        );
        if (provisioned.outcome !== "provisioned")
          throw new Error("provision failed");
        const tenantA = fixture.isolation.ids["company-a"];
        // Without the operation pin the trail is closed (RLS); with it, exactly
        // this event is readable and names the target.
        const unpinned = await fixture.isolation.queryRestricted(
          "operator",
          { tenantId: tenantA },
          "select count(*)::int as n from enterprise_security_events",
          [],
        );
        expect(Number((unpinned[0] as { n: number }).n)).toBe(0);
        const pinned = await fixture.isolation.queryRestricted(
          "operator",
          { tenantId: tenantA, operationId: provisioned.auditEventId },
          "select event_type, actor_id, details from enterprise_security_events where id = $1",
          [provisioned.auditEventId],
        );
        expect(pinned).toHaveLength(1);
        expect(pinned[0]).toMatchObject({
          event_type: "company_member.scim_provisioned",
          actor_id: `scim:directory:${CONNECTION_A}`,
        });
        expect(
          (pinned[0]!.details as Record<string, unknown>).target_user_id,
        ).toBe(target.userId);
      },
    );

    itDb(
      "a second deprovision of the already-suspended member writes nothing",
      async () => {
        const multi = fixture.isolation.identities["multi-company"];
        const membershipA = multi.companies.find(
          (c) => c.companyKey === "company-a",
        )!;
        const tenantA = fixture.isolation.ids["company-a"];
        const report = await fixture.reconciler.deprovisionMember(
          CONNECTION_A,
          {
            userId: multi.userId!,
          },
        );
        expect(report.outcome).toBe("already_suspended");
        if (report.outcome !== "already_suspended") return;
        expect(report.grantsDeleted).toBe(0);
        const after = await membershipOf(tenantA, membershipA.principalId);
        expect(after).toMatchObject({
          status: "suspended",
          epoch: membershipA.epoch + 1,
        });
      },
    );

    itDb(
      "deprovisioning a person who is not a member of the bound company is NOT_FOUND with zero cross-company writes",
      async () => {
        const b1 = fixture.isolation.identities["b1-member"];
        const membershipB = b1.companies.find(
          (c) => c.companyKey === "company-b",
        )!;
        const tenantB = fixture.isolation.ids["company-b"];
        const before = await membershipOf(tenantB, membershipB.principalId);
        await expect(
          fixture.reconciler.deprovisionMember(CONNECTION_A, {
            userId: b1.userId!,
          }),
        ).rejects.toThrow("SCIM_MEMBER_NOT_FOUND");
        const after = await membershipOf(tenantB, membershipB.principalId);
        expect(after).toEqual(before);
      },
    );
  },
);

describeDb(
  "MT026 reprovision: the directory may lift only what it wrote",
  () => {
    itDb(
      "reprovision reactivates the SCIM-suspended membership in the bound company only",
      async () => {
        const multi = fixture.isolation.identities["multi-company"];
        const membershipA = multi.companies.find(
          (c) => c.companyKey === "company-a",
        )!;
        const tenantA = fixture.isolation.ids["company-a"];
        const report = await fixture.reconciler.reprovisionMember(
          CONNECTION_A,
          {
            userId: multi.userId!,
          },
        );
        expect(report.outcome).toBe("reprovisioned");
        if (report.outcome !== "reprovisioned") return;
        expect(report.membership.status).toBe("active");
        expect(report.membership.epoch).toBe(membershipA.epoch + 2);
        const after = await membershipOf(tenantA, membershipA.principalId);
        expect(after).toMatchObject({
          status: "active",
          epoch: membershipA.epoch + 2,
        });
      },
    );

    itDb(
      "an administrator's change after the SCIM suspension stands: reprovision is refused",
      async () => {
        const multi = fixture.isolation.identities["multi-company"];
        const membershipA = multi.companies.find(
          (c) => c.companyKey === "company-a",
        )!;
        const tenantA = fixture.isolation.ids["company-a"];
        // SCIM suspends again (epoch+1 over the restored state, fact recorded).
        const deprovisioned = await fixture.reconciler.deprovisionMember(
          CONNECTION_A,
          {
            userId: multi.userId!,
          },
        );
        expect(deprovisioned.outcome).toBe("deprovisioned");
        // The company administrator restores the member (admin decision, epoch+1).
        const adminContext = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        await adminService.restoreCompanyMember(adminContext, {
          principalId: membershipA.principalId,
        });
        // The directory now says "active" — the admin's newer decision stands.
        await expect(
          fixture.reconciler.reprovisionMember(CONNECTION_A, {
            userId: multi.userId!,
          }),
        ).rejects.toThrow("SCIM_REPROVISION_NOT_ALLOWED");
        const after = await membershipOf(tenantA, membershipA.principalId);
        expect(after).toMatchObject({ status: "active" });
      },
    );

    itDb(
      "a member the administrator suspended is not the directory's to lift",
      async () => {
        const multi = fixture.isolation.identities["multi-company"];
        const membershipA = multi.companies.find(
          (c) => c.companyKey === "company-a",
        )!;
        const tenantA = fixture.isolation.ids["company-a"];
        // The company administrator suspends the member (no SCIM deprovision
        // preceded it — the binding's persisted deprovision fact does not
        // match this row's state).
        const adminContext = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const suspended = await adminService.suspendCompanyMember(
          adminContext,
          {
            principalId: membershipA.principalId,
          },
        );
        // The directory saying "active" must not lift an administrator's
        // suspension: the server-persisted fact is not this row's state.
        await expect(
          fixture.reconciler.reprovisionMember(CONNECTION_A, {
            userId: multi.userId!,
          }),
        ).rejects.toThrow("SCIM_REPROVISION_NOT_ALLOWED");
        const after = await membershipOf(tenantA, membershipA.principalId);
        expect(after).toMatchObject({
          status: "suspended",
          epoch: suspended.membership.epoch,
        });
      },
    );
  },
);

describeDb(
  "MT026 AC3: SCIM provisioning cannot create or modify other companies' memberships",
  () => {
    itDb(
      "provisioning on company A's connection creates the membership in company A only",
      async () => {
        const target = await fixture.scimTargetUser("ac3");
        const tenantA = fixture.isolation.ids["company-a"];
        const tenantB = fixture.isolation.ids["company-b"];
        const report = await fixture.reconciler.provisionMember(CONNECTION_A, {
          userId: target.userId,
        });
        expect(report.outcome).toBe("provisioned");
        if (report.outcome !== "provisioned") return;
        expect(report.membership).toMatchObject({ role: "member", epoch: 1 });
        const membershipA = await membershipOf(tenantA, target.principalId);
        expect(membershipA).toMatchObject({ status: "active", epoch: 1 });
        // Company B: no membership appeared for the target.
        expect(await membershipOf(tenantB, target.principalId)).toBeUndefined();
      },
    );

    itDb(
      "provisioning an already-member person is a zero-write idempotent report",
      async () => {
        const multi = fixture.isolation.identities["multi-company"];
        const membershipA = multi.companies.find(
          (c) => c.companyKey === "company-a",
        )!;
        const tenantA = fixture.isolation.ids["company-a"];
        // Live pre-call fact (earlier tests in this file moved the epoch).
        const before = await membershipOf(tenantA, membershipA.principalId);
        const report = await fixture.reconciler.provisionMember(CONNECTION_A, {
          userId: multi.userId!,
        });
        expect(report.outcome).toBe("already_member");
        const after = await membershipOf(tenantA, membershipA.principalId);
        expect(after).toEqual(before);
      },
    );

    itDb(
      "an input that tries to carry a company attribution is refused loudly",
      async () => {
        const target = await fixture.scimTargetUser("ac3-claim");
        await expect(
          fixture.reconciler.provisionMember(CONNECTION_A, {
            userId: target.userId,
            // The directory never names a company; trying to must fail loudly.
            tenantId: fixture.isolation.ids["company-b"],
          } as never),
        ).rejects.toThrow("TENANT_ATTRIBUTION_NOT_ACCEPTABLE");
        // Zero writes: the claimed company B must not have gained a membership.
        expect(
          await membershipOf(
            fixture.isolation.ids["company-b"],
            target.principalId,
          ),
        ).toBeUndefined();
        expect(
          await membershipOf(
            fixture.isolation.ids["company-a"],
            target.principalId,
          ),
        ).toBeUndefined();
      },
    );

    itDb("the directory can never grant a management role", async () => {
      const target = await fixture.scimTargetUser("ac3-role");
      await expect(
        fixture.reconciler.provisionMember(CONNECTION_A, {
          userId: target.userId,
          role: "tenant_admin",
        }),
      ).rejects.toThrow("SCIM_ROLE_NOT_ASSIGNABLE");
      expect(
        await membershipOf(
          fixture.isolation.ids["company-a"],
          target.principalId,
        ),
      ).toBeUndefined();
    });

    itDb(
      "raw-SQL cross-company membership inserts stay fenced by the write policy",
      async () => {
        // Belt and braces: even a raw INSERT through the operator role pinned to
        // company B cannot write a membership row into company A (withCheck pins
        // tenant_id) — the policy REJECTS the row loudly.
        const target = await fixture.scimTargetUser("ac3-rls");
        const tenantB = fixture.isolation.ids["company-b"];
        await expect(
          fixture.isolation.queryRestricted(
            "operator",
            { tenantId: tenantB },
            "insert into enterprise_memberships (tenant_id, principal_id, role, status, epoch) values ($1, $2, 'member', 'active', 1) returning tenant_id",
            [fixture.isolation.ids["company-a"], target.principalId],
          ),
        ).rejects.toThrow();
        expect(
          await membershipOf(
            fixture.isolation.ids["company-a"],
            target.principalId,
          ),
        ).toBeUndefined();
      },
    );
  },
);

describeDb(
  "MT026 AC1: a deactivated binding stops all directory reactions",
  () => {
    itDb(
      "deactivating the binding deactivates resolution, deprovision, and provision",
      async () => {
        const contextOfA = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        await fixture.configService.deactivateScimBinding(
          contextOfA,
          CONNECTION_A,
        );
        await expect(
          fixture.reconciler.resolveBinding(CONNECTION_A),
        ).rejects.toThrow("SCIM_CONNECTION_DEACTIVATED");
        const multi = fixture.isolation.identities["multi-company"];
        const membershipA = multi.companies.find(
          (c) => c.companyKey === "company-a",
        )!;
        const tenantA = fixture.isolation.ids["company-a"];
        const before = await membershipOf(tenantA, membershipA.principalId);
        await expect(
          fixture.reconciler.deprovisionMember(CONNECTION_A, {
            userId: multi.userId!,
          }),
        ).rejects.toThrow("SCIM_CONNECTION_DEACTIVATED");
        const target = await fixture.scimTargetUser("deactivated");
        await expect(
          fixture.reconciler.provisionMember(CONNECTION_A, {
            userId: target.userId,
          }),
        ).rejects.toThrow("SCIM_CONNECTION_DEACTIVATED");
        const after = await membershipOf(tenantA, membershipA.principalId);
        expect(after).toEqual(before);
      },
    );
  },
);
