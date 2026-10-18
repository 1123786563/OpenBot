// server/tests/multitenancy/people-lifecycle.test.ts
// MT076（Issue #119）：人员管理动作（提升、降级、离职）只作用于本公司范围。
//
// 验收事实源（Issue #119 验收 1–4，逐条对应 describe）：
//   (1) 离职动作只撤销本公司资格与资源权限；其他公司资格与全局身份保留。
//   (2) 提升/降级只影响本公司角色，不改变其他范围权限。
//   (3) 无权主体调用返回不可见语义；动作留审计。
//   (4) 与 SCIM 触发的停用结果一致（不产生两套语义）。
//
// 判定事实与测试手段：
//   - 管理上下文来自真实 MT006 authorizer（tenant_admin 重验 + WeakSet 信
//     任标记）；被测服务运行在受限 operator 角色上，全部写经真实 RLS。
//   - AC1/AC4 用 multi-company 身份（同时是 A/B 两家成员、在两家各持一条
//     团队行与一条资源授权）逐项断言：A 撤销、B 与全局身份原样。
//   - AC4 用真实 MT026 目录反应服务做同态对照：同一状态谓词集（suspended、
//     epoch+1、grants 清零、团队行保留、principal 不动）在 SCIM 停用与
//     管理员离职两条通道上逐一相等；且目录不能解除管理员离职、管理员离职
//     不能叠加在已停用成员上——两个方向都不产生第二套语义。
//   - 审计经 report.auditEventId（tenant + operation 双 pin）读回
//     enterprise_security_events——受限 operator 角色的唯一审计读回门
//     （MT026 D4 先例）。
//
// 环境契约：同 scim-directory.test.ts——缺显式 env 整套显式 skip，绝不回退
// 开发库。

import { afterAll, beforeAll, describe, expect, test } from "../../../tests/support/bun-test-compat";
import {
  type CompanyOffboardReport,
  type CompanyPeopleLifecycleService,
  type CompanyRoleChangeReport,
  createCompanyPeopleLifecycleService,
} from "../../src/enterprise/tenancy/people-lifecycle";
import {
  createPeopleLifecycleFixture,
  type PeopleLifecycleFixture,
} from "./support/people-lifecycle";

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
      reason: `MT076 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

let fixture: PeopleLifecycleFixture;
let service: CompanyPeopleLifecycleService;

const COMPANY_A_CONNECTION = "directory:company-a";
const COMPANY_B_CONNECTION = "directory:company-b";

/** The SCIM-provisioned dual-company member used for AC2/AC4 comparisons. */
let dual: { userId: string; principalId: string };

/** Reports captured while the suite runs (audit readback in AC3). */
let offboardReport: CompanyOffboardReport;
let promoteReport: CompanyRoleChangeReport;
let demoteReport: CompanyRoleChangeReport;

/** Live membership fact for (tenant, principal) under the operator role. */
async function membershipOf(tenantId: string, principalId: string) {
  const rows = await fixture.isolation.queryRestricted(
    "operator",
    { tenantId },
    "select role, status, epoch from enterprise_memberships where principal_id = $1",
    [principalId],
  );
  return rows[0] as { role: string; status: string; epoch: number } | undefined;
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

/** Live team-membership row count for (tenant, principal). */
async function teamRowCountOf(tenantId: string, principalId: string) {
  const rows = await fixture.isolation.queryRestricted(
    "operator",
    { tenantId },
    "select count(*)::int as n from enterprise_workspace_memberships where principal_id = $1",
    [principalId],
  );
  return Number((rows[0] as { n: number } | undefined)?.n ?? 0);
}

/** Live principal status via the directory self-read pin (matrix identities). */
async function principalStatusOf(tenantId: string, principalId: string) {
  const rows = await fixture.isolation.queryRestricted(
    "directory",
    { tenantId, principalId },
    "select status from enterprise_principals where id = $1",
    [principalId],
  );
  return (rows[0] as { status: string } | undefined)?.status;
}

/** Reads one audit event back through the restricted operator role. */
async function auditEventOf(tenantId: string, eventId: string) {
  const rows = await fixture.isolation.queryRestricted(
    "operator",
    { tenantId, operationId: eventId },
    "select event_type, details, created_at from enterprise_security_events where id = $1",
    [eventId],
  );
  return rows[0] as
    | {
        event_type: string;
        details: Record<string, unknown>;
        created_at: string;
      }
    | undefined;
}

function companyIdOf(key: "company-a" | "company-b") {
  return fixture.isolation.ids[key];
}

function principalOf(identity: keyof typeof fixture.isolation.identities) {
  const fact = fixture.isolation.identities[identity];
  if (!fact.principalId) throw new Error(`NOT_HUMAN:${String(identity)}`);
  return fact.principalId;
}

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createPeopleLifecycleFixture();
  service = createCompanyPeopleLifecycleService(fixture.operator);

  // Company A and B each register one active directory binding (the company
  // management plane is the only writer — same discipline as production).
  const contextOfA = await fixture.adminContextOf("company-admin", "company-a");
  await fixture.configService.registerScimBinding(contextOfA, {
    connectionKey: COMPANY_A_CONNECTION,
    credentialRef: "credentials/scim/company-a/token",
  });
  const contextOfB = await fixture.adminContextOf("b-admin", "company-b");
  await fixture.configService.registerScimBinding(contextOfB, {
    connectionKey: COMPANY_B_CONNECTION,
    credentialRef: "credentials/scim/company-b/token",
  });

  // The SCIM-provisioned dual-company member (AC2 cross-role + AC4 mirror):
  // provisioned through the REAL MT026 directory reaction (member role only —
  // a directory can never grant a management role), then given one team row
  // and one grant per company through the restricted operator role, exactly
  // like the isolation fixture materializes the matrix.
  dual = await fixture.lifecycleTargetUser("dual");
  await fixture.reconciler.provisionMember(COMPANY_A_CONNECTION, {
    userId: dual.userId,
  });
  await fixture.reconciler.provisionMember(COMPANY_B_CONNECTION, {
    userId: dual.userId,
  });
  for (const [companyKey, teamKey, resourceKey] of [
    ["company-a", "team-a1", "resource-a1"],
    ["company-b", "team-b1", "resource-b1"],
  ] as const) {
    const tenantId = companyIdOf(companyKey);
    await fixture.isolation.queryRestricted(
      "operator",
      { tenantId },
      "insert into enterprise_workspace_memberships (tenant_id, workspace_id, principal_id) values ($1, $2, $3)",
      [tenantId, fixture.isolation.ids[teamKey], dual.principalId],
    );
    await fixture.isolation.queryRestricted(
      "operator",
      { tenantId },
      "insert into enterprise_resource_grants (tenant_id, resource_id, principal_id, action) values ($1, $2, $3, 'read')",
      [tenantId, fixture.isolation.ids[resourceKey], dual.principalId],
    );
  }
});

afterAll(async () => {
  await fixture?.dispose();
});

// ---------------------------------------------------------------------------
// AC2：提升/降级只影响本公司角色，不改变其他范围权限
// ---------------------------------------------------------------------------

describeDb("MT076 AC2: promote/demote touch only this company's role", () => {
  itDb(
    "promoting the dual-company member to tenant_admin in company A leaves their company B role, membership, and grants untouched",
    async () => {
      const tenantA = companyIdOf("company-a");
      const tenantB = companyIdOf("company-b");
      const beforeB = await membershipOf(tenantB, dual.principalId);
      const beforeGrantsB = await grantCountOf(tenantB, dual.principalId);
      expect(beforeB?.role).toBe("member");
      expect(beforeB?.status).toBe("active");

      const context = await fixture.adminContextOf(
        "company-admin",
        "company-a",
      );
      promoteReport = await service.promoteCompanyMember(context, {
        principalId: dual.principalId,
      });

      expect(promoteReport.outcome).toBe("role_changed");
      expect(promoteReport.tenantId).toBe(tenantA);
      expect(promoteReport.previousRole).toBe("member");
      expect(promoteReport.membership.role).toBe("tenant_admin");
      expect(promoteReport.membership.epoch).toBe((beforeB?.epoch ?? 0) + 1);
      expect(promoteReport.auditEventId).toBeTruthy();

      const afterA = await membershipOf(tenantA, dual.principalId);
      expect(afterA?.role).toBe("tenant_admin");
      expect(afterA?.status).toBe("active");
      // The other scope is untouched: role, status, epoch, grants.
      const afterB = await membershipOf(tenantB, dual.principalId);
      expect(afterB).toEqual(beforeB);
      expect(await grantCountOf(tenantB, dual.principalId)).toBe(beforeGrantsB);
    },
  );

  itDb(
    "demoting the promoted admin back to member keeps the other company's facts intact",
    async () => {
      const tenantA = companyIdOf("company-a");
      const tenantB = companyIdOf("company-b");
      const beforeA = await membershipOf(tenantA, dual.principalId);
      const beforeB = await membershipOf(tenantB, dual.principalId);
      expect(beforeA?.role).toBe("tenant_admin");

      const context = await fixture.adminContextOf(
        "company-admin",
        "company-a",
      );
      demoteReport = await service.demoteCompanyMember(context, {
        principalId: dual.principalId,
        to: "member",
      });

      expect(demoteReport.outcome).toBe("role_changed");
      expect(demoteReport.previousRole).toBe("tenant_admin");
      expect(demoteReport.membership.role).toBe("member");
      expect(demoteReport.membership.epoch).toBe(beforeA!.epoch + 1);

      const afterB = await membershipOf(tenantB, dual.principalId);
      expect(afterB).toEqual(beforeB);
    },
  );

  itDb(
    "a demoted admin's outstanding context can no longer manage (epoch drift → SCOPE_REVOKED)",
    async () => {
      const tenantA = companyIdOf("company-a");
      const target = principalOf("a1-member");
      // Promote, then issue the context the new admin would hold.
      const context = await fixture.adminContextOf(
        "company-admin",
        "company-a",
      );
      await service.promoteCompanyMember(context, { principalId: target });
      const promotedContext = await fixture.adminContextOf(
        "a1-member",
        "company-a",
      );
      // Demote via the acting admin: the promoted member loses the role.
      await service.demoteCompanyMember(context, {
        principalId: target,
        to: "member",
      });
      // The demoted admin's previously issued context is dead on arrival.
      let refused: unknown;
      try {
        await service.promoteCompanyMember(promotedContext, {
          principalId: principalOf("a2-member"),
        });
      } catch (error) {
        refused = error;
      }
      expect((refused as Error | undefined)?.message).toBe("SCOPE_REVOKED");
      // And the refused call wrote nothing.
      const a2 = await membershipOf(tenantA, principalOf("a2-member"));
      expect(a2?.role).toBe("member");
    },
  );

  itDb(
    "demoting a member (who is not an admin) is refused with the invisible NOT_FOUND and zero writes",
    async () => {
      const tenantA = companyIdOf("company-a");
      const target = principalOf("a2-member");
      const before = await membershipOf(tenantA, target);
      const context = await fixture.adminContextOf(
        "company-admin",
        "company-a",
      );
      let refused: unknown;
      try {
        await service.demoteCompanyMember(context, {
          principalId: target,
          to: "member",
        });
      } catch (error) {
        refused = error;
      }
      expect((refused as Error | undefined)?.message).toBe(
        "COMPANY_MEMBER_NOT_FOUND",
      );
      expect(await membershipOf(tenantA, target)).toEqual(before);
    },
  );

  itDb(
    "promoting an existing tenant_admin is refused with the invisible NOT_FOUND and zero writes",
    async () => {
      const tenantA = companyIdOf("company-a");
      const admin = principalOf("company-admin");
      const before = await membershipOf(tenantA, admin);
      const context = await fixture.adminContextOf(
        "company-admin",
        "company-a",
      );
      let refused: unknown;
      try {
        await service.promoteCompanyMember(context, {
          principalId: admin,
        });
      } catch (error) {
        refused = error;
      }
      expect((refused as Error | undefined)?.message).toBe(
        "COMPANY_MEMBER_NOT_FOUND",
      );
      expect(await membershipOf(tenantA, admin)).toEqual(before);
    },
  );
});

// ---------------------------------------------------------------------------
// AC1：离职动作只撤销本公司资格与资源权限；其他公司资格与全局身份保留
// ---------------------------------------------------------------------------

describeDb("MT076 AC1: offboarding in company A touches company A only", () => {
  itDb(
    "offboarding the dual-company member suspends company A's membership, deletes A's grants, and nothing else",
    async () => {
      const tenantA = companyIdOf("company-a");
      const tenantB = companyIdOf("company-b");
      const multi = principalOf("multi-company");
      const beforeA = await membershipOf(tenantA, multi);
      const beforeGrantsA = await grantCountOf(tenantA, multi);
      const beforeTeamRowsA = await teamRowCountOf(tenantA, multi);
      const beforeB = await membershipOf(tenantB, multi);
      const beforeGrantsB = await grantCountOf(tenantB, multi);
      const beforeTeamRowsB = await teamRowCountOf(tenantB, multi);
      expect(beforeA?.status).toBe("active");
      expect(beforeGrantsA).toBeGreaterThan(0);

      const context = await fixture.adminContextOf(
        "company-admin",
        "company-a",
      );
      offboardReport = await service.offboardCompanyMember(context, {
        principalId: multi,
      });

      expect(offboardReport.outcome).toBe("offboarded");
      expect(offboardReport.tenantId).toBe(tenantA);
      expect(offboardReport.membership.status).toBe("suspended");
      expect(offboardReport.membership.epoch).toBe(beforeA!.epoch + 1);
      expect(offboardReport.grantsDeleted).toBe(beforeGrantsA);
      expect(offboardReport.auditEventId).toBeTruthy();

      // Company A: membership suspended, grants gone, team rows preserved
      // (team eligibility dies through the company-suspension cascade, the
      // same fact source the MT005 gate reads — never by row deletion).
      const afterA = await membershipOf(tenantA, multi);
      expect(afterA?.status).toBe("suspended");
      expect(afterA?.epoch).toBe(beforeA!.epoch + 1);
      expect(await grantCountOf(tenantA, multi)).toBe(0);
      expect(await teamRowCountOf(tenantA, multi)).toBe(beforeTeamRowsA);

      // Company B: membership, epoch, grants, team rows — all untouched.
      expect(await membershipOf(tenantB, multi)).toEqual(beforeB);
      expect(await grantCountOf(tenantB, multi)).toBe(beforeGrantsB);
      expect(await teamRowCountOf(tenantB, multi)).toBe(beforeTeamRowsB);
    },
  );

  itDb(
    "after offboarding, the former member's company A requests refuse while their company B requests still authorize",
    async () => {
      const refused = await fixture.isolation.requestAs("multi-company", {
        method: "GET",
        path: `/resources/${fixture.isolation.ids["resource-a1"]}`,
        tenantId: companyIdOf("company-a"),
        workspaceId: fixture.isolation.ids["team-a1"],
      });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: string }).error).toBe(
        "TENANT_FORBIDDEN",
      );

      const otherCompany = await fixture.isolation.requestAs("multi-company", {
        method: "GET",
        path: `/resources/${fixture.isolation.ids["resource-b1"]}`,
        tenantId: companyIdOf("company-b"),
        workspaceId: fixture.isolation.ids["team-b1"],
      });
      expect(otherCompany.status).toBe(200);
    },
  );

  itDb(
    "offboarding preserves the global identity: the principal stays active and the restricted roles structurally cannot touch the deployment identity tables",
    async () => {
      const tenantA = companyIdOf("company-a");
      const multi = principalOf("multi-company");
      expect(await principalStatusOf(tenantA, multi)).toBe("active");

      // Structural fact (MT026 D3): the restricted business roles hold no
      // privilege on the deployment-level identity tables, so an offboard
      // that ran entirely under them cannot have touched global identity.
      for (const role of ["directory", "data", "operator"] as const) {
        const rows = await fixture.isolation.queryRestricted(
          role,
          undefined,
          "select has_table_privilege(current_user, 'users', 'SELECT') as users_select, has_table_privilege(current_user, 'sessions', 'SELECT') as sessions_select, has_table_privilege(current_user, 'revoked_access', 'SELECT') as revoked_select",
          [],
        );
        const row = rows[0] as {
          users_select: boolean;
          sessions_select: boolean;
          revoked_select: boolean;
        };
        expect(row.users_select).toBe(false);
        expect(row.sessions_select).toBe(false);
        expect(row.revoked_select).toBe(false);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// AC3：无权主体调用返回不可见语义；动作留审计
// ---------------------------------------------------------------------------

describeDb(
  "MT076 AC3: unauthorized callers get invisible semantics; executed actions leave audit",
  () => {
    itDb(
      "a non-admin member cannot resolve a management context at all",
      async () => {
        let refused: unknown;
        try {
          await fixture.adminContextOf("a1-member", "company-a");
        } catch (error) {
          refused = error;
        }
        expect((refused as Error | undefined)?.message).toBe(
          "TENANT_ADMIN_REQUIRED",
        );
      },
    );

    itDb(
      "a company B admin acting on company A's member gets the same NOT_FOUND as an unknown principal (no existence leak) and zero writes",
      async () => {
        const tenantA = companyIdOf("company-a");
        const target = principalOf("a1-member");
        const before = await membershipOf(tenantA, target);
        const bAdminContext = await fixture.adminContextOf(
          "b-admin",
          "company-b",
        );

        let crossCompany: unknown;
        try {
          await service.promoteCompanyMember(bAdminContext, {
            principalId: target,
          });
        } catch (error) {
          crossCompany = error;
        }
        let unknownTarget: unknown;
        try {
          await service.promoteCompanyMember(bAdminContext, {
            principalId: `${fixture.isolation.idPrefix}-nobody`,
          });
        } catch (error) {
          unknownTarget = error;
        }
        const crossMessage = (crossCompany as Error | undefined)?.message;
        const unknownMessage = (unknownTarget as Error | undefined)?.message;
        expect(crossMessage).toBe("COMPANY_MEMBER_NOT_FOUND");
        // Invisible semantics: the existing A member and a fabricated id are
        // indistinguishable to the unauthorized caller.
        expect(crossMessage).toBe(unknownMessage);
        expect(await membershipOf(tenantA, target)).toEqual(before);
      },
    );

    itDb(
      "a forged (never-issued) admin context is refused for every action before any database access",
      async () => {
        const forged = {
          tenantId: companyIdOf("company-a"),
          principalId: principalOf("company-admin"),
          actorId: fixture.isolation.identities["company-admin"].userId,
          memberEpoch: 1,
        };
        for (const attempt of [
          () =>
            service.promoteCompanyMember(forged, {
              principalId: principalOf("a1-member"),
            }),
          () =>
            service.demoteCompanyMember(forged, {
              principalId: principalOf("a1-member"),
              to: "member",
            }),
          () =>
            service.offboardCompanyMember(forged, {
              principalId: principalOf("a1-member"),
            }),
        ]) {
          let refused: unknown;
          try {
            await attempt();
          } catch (error) {
            refused = error;
          }
          expect((refused as Error | undefined)?.message).toBe(
            "UNVERIFIED_ADMIN_CONTEXT",
          );
        }
      },
    );

    itDb(
      "inputs outside the closed vocabulary are refused before any database access",
      async () => {
        const context = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        let badRole: unknown;
        try {
          await service.demoteCompanyMember(context, {
            principalId: principalOf("a1-member"),
            // Runtime-invalid target role: the closed vocabulary is
            // {member, auditor} — anything else is a caller bug.
            to: "nobody" as "member",
          });
        } catch (error) {
          badRole = error;
        }
        expect((badRole as Error | undefined)?.message).toBe("INVALID_REQUEST");

        let blankPrincipal: unknown;
        try {
          await service.offboardCompanyMember(context, { principalId: "   " });
        } catch (error) {
          blankPrincipal = error;
        }
        expect((blankPrincipal as Error | undefined)?.message).toBe(
          "INVALID_REQUEST",
        );
      },
    );

    itDb(
      "every executed action left an audit event: type, operator, target, epoch, and action specifics are readable by the returned id",
      async () => {
        const adminPrincipal = principalOf("company-admin");
        const adminUser = fixture.isolation.identities["company-admin"].userId;

        const offboardEvent = await auditEventOf(
          offboardReport.tenantId,
          offboardReport.auditEventId,
        );
        expect(offboardEvent?.event_type).toBe("company_member.offboarded");
        expect(offboardEvent?.created_at).toBeTruthy();
        expect(offboardEvent?.details.operator_principal_id).toBe(
          adminPrincipal,
        );
        expect(offboardEvent?.details.operator_user_id).toBe(adminUser);
        expect(offboardEvent?.details.target_principal_id).toBe(
          principalOf("multi-company"),
        );
        expect(offboardEvent?.details.epoch).toBe(
          offboardReport.membership.epoch,
        );
        expect(offboardEvent?.details.grants_deleted).toBe(
          offboardReport.grantsDeleted,
        );

        const promoteEvent = await auditEventOf(
          promoteReport.tenantId,
          promoteReport.auditEventId,
        );
        expect(promoteEvent?.event_type).toBe("company_member.promoted");
        expect(promoteEvent?.details.role_from).toBe("member");
        expect(promoteEvent?.details.role_to).toBe("tenant_admin");
        expect(promoteEvent?.details.epoch).toBe(
          promoteReport.membership.epoch,
        );

        const demoteEvent = await auditEventOf(
          demoteReport.tenantId,
          demoteReport.auditEventId,
        );
        expect(demoteEvent?.event_type).toBe("company_member.demoted");
        expect(demoteEvent?.details.role_from).toBe("tenant_admin");
        expect(demoteEvent?.details.role_to).toBe("member");
        expect(demoteEvent?.details.epoch).toBe(demoteReport.membership.epoch);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// AC4：与 SCIM 触发的停用结果一致（不产生两套语义）
// ---------------------------------------------------------------------------

describeDb(
  "MT076 AC4: admin offboard matches SCIM deprovision semantics",
  () => {
    itDb(
      "a SCIM deprovision lands the same member-state predicates as the admin offboard",
      async () => {
        const tenantA = companyIdOf("company-a");
        const before = await membershipOf(tenantA, dual.principalId);
        const beforeGrants = await grantCountOf(tenantA, dual.principalId);
        const beforeTeamRows = await teamRowCountOf(tenantA, dual.principalId);
        expect(before?.status).toBe("active");
        expect(beforeGrants).toBeGreaterThan(0);

        const report = await fixture.reconciler.deprovisionMember(
          COMPANY_A_CONNECTION,
          { userId: dual.userId },
        );
        expect(report.outcome).toBe("deprovisioned");

        const after = await membershipOf(tenantA, dual.principalId);
        // The shared predicate set — identical for both channels:
        // suspended, epoch+1, grants cleared, team rows preserved.
        expect(after?.status).toBe("suspended");
        expect(after!.epoch).toBe(before!.epoch + 1);
        expect(await grantCountOf(tenantA, dual.principalId)).toBe(0);
        expect(await teamRowCountOf(tenantA, dual.principalId)).toBe(
          beforeTeamRows,
        );
        // The admin-offboarded member shows the same shape (captured in AC1).
        const multi = principalOf("multi-company");
        const multiAfter = await membershipOf(tenantA, multi);
        expect(multiAfter?.status).toBe("suspended");
        expect(await grantCountOf(tenantA, multi)).toBe(0);
      },
    );

    itDb(
      "the directory cannot lift an admin offboard — the admin decision stands (no second semantics)",
      async () => {
        const tenantA = companyIdOf("company-a");
        const multi = principalOf("multi-company");
        const before = await membershipOf(tenantA, multi);
        expect(before?.status).toBe("suspended");

        let refused: unknown;
        try {
          await fixture.reconciler.reprovisionMember(COMPANY_A_CONNECTION, {
            userId: fixture.isolation.identities["multi-company"].userId,
          });
        } catch (error) {
          refused = error;
        }
        expect((refused as Error | undefined)?.message).toBe(
          "SCIM_REPROVISION_NOT_ALLOWED",
        );
        expect(await membershipOf(tenantA, multi)).toEqual(before);
      },
    );

    itDb(
      "an admin offboard of a SCIM-deprovisioned member is refused invisibly with zero writes",
      async () => {
        const tenantA = companyIdOf("company-a");
        const before = await membershipOf(tenantA, dual.principalId);
        expect(before?.status).toBe("suspended");

        const context = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        let refused: unknown;
        try {
          await service.offboardCompanyMember(context, {
            principalId: dual.principalId,
          });
        } catch (error) {
          refused = error;
        }
        expect((refused as Error | undefined)?.message).toBe(
          "COMPANY_MEMBER_NOT_FOUND",
        );
        expect(await membershipOf(tenantA, dual.principalId)).toEqual(before);
        expect(await grantCountOf(tenantA, dual.principalId)).toBe(0);
      },
    );
  },
);
