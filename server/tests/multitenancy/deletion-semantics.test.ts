// MT067（Issue #110）：退出/清理某公司数据 与 独立授权的全局账号删除 是两个
// 不同操作。
//
// 验收事实源（Issue #110 验收 1–4，逐条对应 describe）：
//   (1) 公司管理员只能清理本公司范围内该成员的数据与资格；全局身份与其他
//       公司资格保留。
//   (2) 全局账号删除是独立、显式授权的操作，不能被公司管理动作触发。
//   (3) 退出公司后该范围内的任务、连接、文件与订阅失效；其他范围不受影响。
//   (4) 两种操作的响应与审计记录可区分，不产生歧义。
//
// 判定事实与测试手段：
//   - 管理上下文来自真实 MT006 authorizer；被测双轨服务运行在受限 operator
//     角色 + 真实 directory 通道上，全部写经真实 RLS。
//   - Track B 的 fence 是真实 §9 store（insert-once 标记），绝不测试替身；
//     Track A 永不产生 §9 标记（平台通道探针逐用例断言零行）。
//   - 失效证据落在生产门上：任务协会行（MT060 可见性权威）、凭据行、授权
//     行、团队成员行 + 真实 scope 解析器/资源读取器的 requestAs 正反两侧
//     （A5「影响后续 HTTP 请求」），而不是断言一个想象中的状态。
//   - 审计经 report.auditEventId（tenant + operation 双 pin）读回
//     enterprise_security_events——受限 operator 角色的唯一审计读回门
//     （MT026 D4 / MT076 先例）。
//
// 环境契约：同 people-lifecycle.test.ts——缺显式 env 整套显式 skip，绝不回
// 退开发库。

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  type CompanyCleanupReport,
  createCompanyMemberCleanupService,
  createGlobalAccountDeletionService,
  GLOBAL_DELETION_CONFIRMATION,
  type GlobalDeletionReport,
} from "../../src/enterprise/tenancy/deletion-semantics";
import {
  createDeletionSemanticsFixture,
  type DeletionSemanticsFixture,
} from "./support/deletion-semantics";

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
      reason: `MT067 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

let fixture: DeletionSemanticsFixture;
let cleanup: ReturnType<typeof createCompanyMemberCleanupService>;
let globalDeletion: ReturnType<typeof createGlobalAccountDeletionService>;

/** The AC1/AC3/AC4 dual-company member (cleaned in company A only). */
let dual: { userId: string; principalId: string };
/** The AC2 dual-company member (globally deleted). */
let dual2: { userId: string; principalId: string };

let cleanupReport: CompanyCleanupReport;
let deletionReport: GlobalDeletionReport;
let deletionRepeatReport: GlobalDeletionReport;

const COMPANY_A = () => fixture.isolation.ids["company-a"];
const COMPANY_B = () => fixture.isolation.ids["company-b"];
const TEAM_A1 = () => fixture.isolation.ids["team-a1"];
const TEAM_B1 = () => fixture.isolation.ids["team-b1"];

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

/** Live credential status rows for (tenant, owner principal). */
async function credentialStatusOf(tenantId: string, credentialId: string) {
  const rows = await fixture.isolation.queryRestricted(
    "operator",
    { tenantId },
    "select status, classification, owner_principal_id from enterprise_credentials where id = $1",
    [credentialId],
  );
  return rows[0] as
    | {
        status: string;
        classification: string;
        owner_principal_id: string | null;
      }
    | undefined;
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

/** Principal status via the setup-channel oracle (global identity fact). */
async function principalStatusOf(principalId: string) {
  return fixture.principalStatusOf(principalId);
}

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createDeletionSemanticsFixture();
  cleanup = createCompanyMemberCleanupService(fixture.operator);
  globalDeletion = createGlobalAccountDeletionService({
    operator: fixture.operator,
    directory: fixture.directory,
    fence: fixture.deletionStore.delete,
  });

  // The two dual-company members: real memberships in company A (team A1)
  // and company B (team B1) through the restricted operator role, then the
  // scoped facts each company holds for them — one MT060 task association,
  // one personal connection credential, one grant-gated resource ("file").
  dual = await fixture.targetUser("dual");
  dual2 = await fixture.targetUser("dual2");
  for (const target of [dual, dual2]) {
    await fixture.isolation.queryRestricted(
      "operator",
      { tenantId: COMPANY_A() },
      "insert into enterprise_memberships (tenant_id, principal_id, role, status, epoch) values ($1, $2, 'member', 'active', 1)",
      [COMPANY_A(), target.principalId],
    );
    await fixture.isolation.queryRestricted(
      "operator",
      { tenantId: COMPANY_B() },
      "insert into enterprise_memberships (tenant_id, principal_id, role, status, epoch) values ($1, $2, 'member', 'active', 1)",
      [COMPANY_B(), target.principalId],
    );
    // One team row per company (the isolation fixture materializes the
    // matrix identities' team rows the same way).
    await fixture.isolation.queryRestricted(
      "operator",
      { tenantId: COMPANY_A() },
      "insert into enterprise_workspace_memberships (tenant_id, workspace_id, principal_id) values ($1, $2, $3)",
      [COMPANY_A(), TEAM_A1(), target.principalId],
    );
    await fixture.isolation.queryRestricted(
      "operator",
      { tenantId: COMPANY_B() },
      "insert into enterprise_workspace_memberships (tenant_id, workspace_id, principal_id) values ($1, $2, $3)",
      [COMPANY_B(), TEAM_B1(), target.principalId],
    );
  }
  const suffix = dual.principalId.slice(-6);
  const suffix2 = dual2.principalId.slice(-6);
  await fixture.seedTaskScope({
    taskId: `mt067-task-a-${suffix}`,
    tenantId: COMPANY_A(),
    workspaceId: TEAM_A1(),
    principalId: dual.principalId,
    userId: dual.userId,
  });
  await fixture.seedTaskScope({
    taskId: `mt067-task-b-${suffix}`,
    tenantId: COMPANY_B(),
    workspaceId: TEAM_B1(),
    principalId: dual.principalId,
    userId: dual.userId,
  });
  await fixture.seedPersonalCredential({
    tenantId: COMPANY_A(),
    credentialId: `mt067-cred-a-${suffix}`,
    ownerPrincipalId: dual.principalId,
    target: "https://conn.example.invalid/a",
  });
  await fixture.seedPersonalCredential({
    tenantId: COMPANY_B(),
    credentialId: `mt067-cred-b-${suffix}`,
    ownerPrincipalId: dual.principalId,
    target: "https://conn.example.invalid/b",
  });
  await fixture.seedResourceGrant({
    tenantId: COMPANY_A(),
    workspaceId: TEAM_A1(),
    resourceId: `mt067-res-a-${suffix}`,
    principalId: dual.principalId,
  });
  await fixture.seedResourceGrant({
    tenantId: COMPANY_B(),
    workspaceId: TEAM_B1(),
    resourceId: `mt067-res-b-${suffix}`,
    principalId: dual.principalId,
  });
  // dual2: memberships only (AC2 proves eligibility revocation; its scoped
  // facts would be MT068's purge face, not this ticket's).
  void suffix2;

  // Same-company control member facts (a1-other, company A team A1): the
  // cleanup of `dual` must not touch another member's scope facts.
  await fixture.seedTaskScope({
    taskId: "mt067-task-other",
    tenantId: COMPANY_A(),
    workspaceId: TEAM_A1(),
    principalId: fixture.isolation.identities["a1-other"].principalId!,
    userId: fixture.isolation.identities["a1-other"].userId!,
  });
  await fixture.seedPersonalCredential({
    tenantId: COMPANY_A(),
    credentialId: "mt067-cred-other",
    ownerPrincipalId: fixture.isolation.identities["a1-other"].principalId!,
    target: "https://conn.example.invalid/other",
  });
});

afterAll(async () => {
  await fixture?.dispose();
});

// ---------------------------------------------------------------------------
// AC1：公司管理员只能清理本公司范围；全局身份与其他公司资格保留
// ---------------------------------------------------------------------------

describeDb("MT067 AC1: company cleanup stays inside this company", () => {
  itDb(
    "cleaning the dual-company member in company A reports the cleaned scope and leaves company B and the global identity intact",
    async () => {
      const tenantA = COMPANY_A();
      const tenantB = COMPANY_B();
      const beforeB = await membershipOf(tenantB, dual.principalId);
      expect(beforeB?.status).toBe("active");
      expect(beforeB?.epoch).toBe(1);

      const context = await fixture.adminContextOf(
        "company-admin",
        "company-a",
      );
      cleanupReport = await cleanup.cleanupCompanyMemberData(context, {
        principalId: dual.principalId,
      });

      expect(cleanupReport.outcome).toBe("company_scope_cleaned");
      expect(cleanupReport.tenantId).toBe(tenantA);
      expect(cleanupReport.principalId).toBe(dual.principalId);
      expect(cleanupReport.membership.status).toBe("suspended");
      expect(cleanupReport.membership.epoch).toBe(2);
      expect(cleanupReport.workspaceMembershipsRemoved).toBe(1);
      expect(cleanupReport.grantsDeleted).toBe(1);
      expect(cleanupReport.taskScopesRemoved).toBe(1);
      expect(cleanupReport.credentialsRevoked).toBe(1);
      expect(cleanupReport.auditEventId).toBeTruthy();

      // Company B: membership, team row, grant, task association, credential.
      const afterB = await membershipOf(tenantB, dual.principalId);
      expect(afterB?.status).toBe("active");
      expect(afterB?.epoch).toBe(1);
      expect(await teamRowCountOf(tenantB, dual.principalId)).toBe(1);
      expect(await grantCountOf(tenantB, dual.principalId)).toBe(1);
      expect(
        await fixture.taskScopeRowOf(
          `mt067-task-b-${dual.principalId.slice(-6)}`,
        ),
      ).toBeDefined();
      const credB = await credentialStatusOf(
        tenantB,
        `mt067-cred-b-${dual.principalId.slice(-6)}`,
      );
      expect(credB?.status).toBe("active");

      // Global identity: users row and principal row untouched.
      const userRow = await fixture.userRowOf(dual.userId);
      expect(userRow?.id).toBe(dual.userId);
      expect(await principalStatusOf(dual.principalId)).toBe("active");
      // The company-admin cleanup path never writes the §9 deletion marker.
      expect(await fixture.deletionMarkerCountOf(dual.userId)).toBe(0);
    },
  );

  itDb(
    "another member's scope facts in the same company survive the cleanup untouched",
    async () => {
      const other = fixture.isolation.identities["a1-other"];
      const membership = await membershipOf(COMPANY_A(), other.principalId!);
      expect(membership?.status).toBe("active");
      expect(await teamRowCountOf(COMPANY_A(), other.principalId!)).toBe(1);
      expect(await fixture.taskScopeRowOf("mt067-task-other")).toBeDefined();
      const credOther = await credentialStatusOf(
        COMPANY_A(),
        "mt067-cred-other",
      );
      expect(credOther?.status).toBe("active");
    },
  );

  itDb(
    "a foreign-company or fabricated principal is the same invisible refusal (no existence leak), and a non-admin cannot act at all",
    async () => {
      const context = await fixture.adminContextOf(
        "company-admin",
        "company-a",
      );
      // Company B's b1-member (no company A membership at all) is invisible
      // from company A's admin chair.
      const b1 = fixture.isolation.identities["b1-member"];
      expect(
        cleanup
          .cleanupCompanyMemberData(context, { principalId: b1.principalId! })
          .then(() => {
            throw new Error("SHOULD_HAVE_BEEN_REFUSED");
          })
          .catch((error: Error) => error.message),
      ).resolves.toBe("COMPANY_MEMBER_NOT_FOUND");
      // A fabricated id is the same refusal.
      expect(
        cleanup
          .cleanupCompanyMemberData(context, {
            principalId: "mt067-does-not-exist",
          })
          .then(() => {
            throw new Error("SHOULD_HAVE_BEEN_REFUSED");
          })
          .catch((error: Error) => error.message),
      ).resolves.toBe("COMPANY_MEMBER_NOT_FOUND");
      // dual2's company B membership unaffected by the refused attempts.
      const afterB = await membershipOf(COMPANY_B(), dual2.principalId);
      expect(afterB?.status).toBe("active");
      // b1-member's own company B membership likewise untouched.
      const b1After = await membershipOf(COMPANY_B(), b1.principalId!);
      expect(b1After?.status).toBe("active");

      // A plain member holds no admin context to act with (real MT006 gate).
      const memberContext = fixture.adminContextOf("a1-member", "company-a");
      expect(
        memberContext
          .then(() => {
            throw new Error("SHOULD_HAVE_BEEN_REFUSED");
          })
          .catch((error: Error) => error.message),
      ).resolves.toContain("ADMIN");
    },
  );

  itDb(
    "re-cleaning an already-cleaned member refuses invisibly and the cleaned state does not move",
    async () => {
      const context = await fixture.adminContextOf(
        "company-admin",
        "company-a",
      );
      expect(
        cleanup
          .cleanupCompanyMemberData(context, { principalId: dual.principalId })
          .then(() => {
            throw new Error("SHOULD_HAVE_BEEN_REFUSED");
          })
          .catch((error: Error) => error.message),
      ).resolves.toBe("COMPANY_MEMBER_NOT_FOUND");
      const membership = await membershipOf(COMPANY_A(), dual.principalId);
      expect(membership?.status).toBe("suspended");
      expect(membership?.epoch).toBe(2);
    },
  );

  itDb(
    "an admin context whose company membership moved after issuance is refused inside the transaction (SCOPE_REVOKED)",
    async () => {
      const admin = fixture.isolation.identities["company-admin"];
      // Issue the context while the admin is still active, THEN move the
      // membership underneath it through the real MT006 revocation path:
      // the cleanup must revalidate the admin inside the transaction and
      // refuse (epoch drift + suspended status).
      const staleContext = await fixture.adminContextOf(
        "company-admin",
        "company-a",
      );
      const { epoch: revokedEpoch } =
        await fixture.isolation.suspendCompanyMembership(
          "company-admin",
          COMPANY_A(),
        );
      expect(revokedEpoch).toBe(staleContext.memberEpoch + 1);
      expect(
        cleanup
          .cleanupCompanyMemberData(staleContext, {
            principalId: dual2.principalId,
          })
          .then(() => {
            throw new Error("SHOULD_HAVE_BEEN_REFUSED");
          })
          .catch((error: Error) => error.message),
      ).resolves.toBe("SCOPE_REVOKED");
      // Zero side effects: dual2's memberships are both still active (the
      // AC2 group relies on that state).
      expect((await membershipOf(COMPANY_A(), dual2.principalId))?.status).toBe(
        "active",
      );
      expect((await membershipOf(COMPANY_B(), dual2.principalId))?.status).toBe(
        "active",
      );
      // Re-arm the fixture's only company A admin for the later groups
      // (exact-epoch restore through the disclosed setup-channel probe).
      await fixture.restoreCompanyMembership(
        COMPANY_A(),
        admin.principalId!,
        staleContext.memberEpoch,
      );
      const restored = await membershipOf(COMPANY_A(), admin.principalId!);
      expect(restored?.status).toBe("active");
      expect(restored?.epoch).toBe(staleContext.memberEpoch);
    },
  );
});

// ---------------------------------------------------------------------------
// AC2：全局账号删除是独立、显式授权的操作
// ---------------------------------------------------------------------------

describeDb("MT067 AC2: global deletion is independent and explicit", () => {
  itDb(
    "a missing or wrong confirmation refuses loudly with zero writes",
    async () => {
      const beforeA = await membershipOf(COMPANY_A(), dual2.principalId);
      expect(beforeA?.status).toBe("active");

      for (const confirmation of [
        undefined,
        "",
        "delete my account",
        GLOBAL_DELETION_CONFIRMATION.toUpperCase(),
        GLOBAL_DELETION_CONFIRMATION.slice(0, -1),
      ]) {
        expect(
          globalDeletion
            .deleteGlobalAccount({
              userId: dual2.userId,
              confirmation: confirmation as string,
            })
            .then(() => {
              throw new Error("SHOULD_HAVE_BEEN_REFUSED");
            })
            .catch((error: Error) => error.message),
        ).resolves.toBe("GLOBAL_DELETION_CONFIRMATION_REQUIRED");
      }
      // Nothing moved: no §9 marker, memberships still active.
      expect(await fixture.deletionMarkerCountOf(dual2.userId)).toBe(0);
      expect((await membershipOf(COMPANY_A(), dual2.principalId))?.status).toBe(
        "active",
      );
      expect((await membershipOf(COMPANY_B(), dual2.principalId))?.status).toBe(
        "active",
      );
    },
  );

  itDb(
    "the explicit global deletion fences the account through the real §9 store and revokes every company's eligibility — but never the global identity rows",
    async () => {
      deletionReport = await globalDeletion.deleteGlobalAccount({
        userId: dual2.userId,
        confirmation: GLOBAL_DELETION_CONFIRMATION,
      });

      expect(deletionReport.outcome).toBe("global_deletion_fenced");
      expect(deletionReport.userId).toBe(dual2.userId);
      expect(deletionReport.phase).toBe("fenced");
      expect(deletionReport.disabledAt).toBeTruthy();
      expect(deletionReport.companiesRevoked).toBe(2);
      expect(deletionReport.auditEventIds).toHaveLength(2);

      // Both companies' membership rows: suspended, epoch advanced.
      const afterA = await membershipOf(COMPANY_A(), dual2.principalId);
      expect(afterA?.status).toBe("suspended");
      expect(afterA?.epoch).toBe(2);
      const afterB = await membershipOf(COMPANY_B(), dual2.principalId);
      expect(afterB?.status).toBe("suspended");
      expect(afterB?.epoch).toBe(2);

      // Global identity rows stand (the §9 fence gates access; physical
      // purge is MT068's execution, not this track's).
      const userRow = await fixture.userRowOf(dual2.userId);
      expect(userRow?.id).toBe(dual2.userId);
      expect(await principalStatusOf(dual2.principalId)).toBe("active");

      // The marker exists exactly once, in the fenced phase.
      expect(await fixture.deletionMarkerCountOf(dual2.userId)).toBe(1);
      const marker = await fixture.deletionStore.get(dual2.userId);
      expect(marker?.phase).toBe("fenced");
      expect(marker?.disabledAt.toISOString()).toBe(deletionReport.disabledAt);
    },
  );

  itDb(
    "a repeat global deletion is idempotent on the fence (same marker, no double revocation)",
    async () => {
      deletionRepeatReport = await globalDeletion.deleteGlobalAccount({
        userId: dual2.userId,
        confirmation: GLOBAL_DELETION_CONFIRMATION,
      });
      expect(deletionRepeatReport.outcome).toBe("global_deletion_fenced");
      expect(deletionRepeatReport.disabledAt).toBe(deletionReport.disabledAt);
      expect(deletionRepeatReport.companiesRevoked).toBe(0);
      expect(await fixture.deletionMarkerCountOf(dual2.userId)).toBe(1);
      const afterA = await membershipOf(COMPANY_A(), dual2.principalId);
      expect(afterA?.epoch).toBe(2);
    },
  );

  itDb(
    "company management actions never trigger a global deletion (no §9 marker behind any admin path)",
    async () => {
      // The AC1 cleanup ran the full company-admin path against `dual`:
      // its §9 marker count is still zero. The cleanup service exposes no
      // global-deletion entry at all (shape separation).
      expect(await fixture.deletionMarkerCountOf(dual.userId)).toBe(0);
      expect(Object.keys(cleanup).sort()).toEqual(["cleanupCompanyMemberData"]);
    },
  );
});

// ---------------------------------------------------------------------------
// AC3：退出后该范围内任务/连接/文件/订阅失效；其他范围不受影响
// ---------------------------------------------------------------------------

describeDb(
  "MT067 AC3: scope facts die with the exit; other scopes live on",
  () => {
    itDb(
      "positive control before cleanup: the multi-company member reads company A and company B resources through the real gate",
      async () => {
        const before = await fixture.isolation.requestAs("multi-company", {
          method: "GET",
          path: `/resources/${fixture.isolation.ids["resource-a1"]}`,
          tenantId: COMPANY_A(),
          workspaceId: TEAM_A1(),
        });
        expect(before.status).toBe(200);
        const beforeB = await fixture.isolation.requestAs("multi-company", {
          method: "GET",
          path: `/resources/${fixture.isolation.ids["resource-b1"]}`,
          tenantId: COMPANY_B(),
          workspaceId: TEAM_B1(),
        });
        expect(beforeB.status).toBe(200);
      },
    );

    itDb(
      "after the company A cleanup the same member's company A task, connection, file grant and access die; company B keeps working",
      async () => {
        const multi = fixture.isolation.identities["multi-company"];
        // Seed one company A task association for the multi-company member so
        // the task-invalidation face is observed on their own scope.
        await fixture.seedTaskScope({
          taskId: "mt067-task-multi-a",
          tenantId: COMPANY_A(),
          workspaceId: TEAM_A1(),
          principalId: multi.principalId!,
          userId: multi.userId!,
        });
        await fixture.seedPersonalCredential({
          tenantId: COMPANY_A(),
          credentialId: "mt067-cred-multi-a",
          ownerPrincipalId: multi.principalId!,
          target: "https://conn.example.invalid/multi",
        });

        const context = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const report = await cleanup.cleanupCompanyMemberData(context, {
          principalId: multi.principalId!,
        });
        expect(report.outcome).toBe("company_scope_cleaned");
        expect(report.taskScopesRemoved).toBe(1);
        expect(report.credentialsRevoked).toBe(1);

        // Task: the association row (MT060 visibility authority) is gone.
        expect(
          await fixture.taskScopeRowOf("mt067-task-multi-a"),
        ).toBeUndefined();
        // Connection: the personal credential is revoked for everyone.
        const cred = await credentialStatusOf(
          COMPANY_A(),
          "mt067-cred-multi-a",
        );
        expect(cred?.status).toBe("revoked");
        // File: the grant row is gone.
        expect(await grantCountOf(COMPANY_A(), multi.principalId!)).toBe(0);
        // Subscription-shaped ongoing access: the real scope gate now refuses.
        const after = await fixture.isolation.requestAs("multi-company", {
          method: "GET",
          path: `/resources/${fixture.isolation.ids["resource-a1"]}`,
          tenantId: COMPANY_A(),
          workspaceId: TEAM_A1(),
        });
        expect(after.status).toBe(403);
        // Other scope: company B still answers 200 through the same gate.
        const otherScope = await fixture.isolation.requestAs("multi-company", {
          method: "GET",
          path: `/resources/${fixture.isolation.ids["resource-b1"]}`,
          tenantId: COMPANY_B(),
          workspaceId: TEAM_B1(),
        });
        expect(otherScope.status).toBe(200);
        const membershipB = await membershipOf(COMPANY_B(), multi.principalId!);
        expect(membershipB?.status).toBe("active");
      },
    );
  },
);

// ---------------------------------------------------------------------------
// AC4：两种操作的响应与审计记录可区分
// ---------------------------------------------------------------------------

describeDb(
  "MT067 AC4: the two tracks are distinguishable on response and audit",
  () => {
    itDb(
      "response shapes differ: company-scoped report vs global fenced report",
      async () => {
        expect(cleanupReport.outcome).toBe("company_scope_cleaned");
        expect(deletionReport.outcome).toBe("global_deletion_fenced");
        expect(cleanupReport.outcome).not.toBe(deletionReport.outcome);
        // The company report is tenant-addressed; the global report is not.
        expect(cleanupReport.tenantId).toBe(COMPANY_A());
        expect(
          (deletionReport as unknown as { tenantId?: string }).tenantId,
        ).toBeUndefined();
        // The global report carries the §9 fence facts; the company report does not.
        expect(deletionReport.phase).toBe("fenced");
        expect(typeof deletionReport.disabledAt).toBe("string");
        expect(
          (cleanupReport as unknown as { phase?: string }).phase,
        ).toBeUndefined();
      },
    );

    itDb(
      "audit trails differ: the cleanup writes company_member.data_cleaned in the cleaned company only; the global deletion writes global_account.membership_revoked per company",
      async () => {
        const cleanupEvent = await auditEventOf(
          COMPANY_A(),
          cleanupReport.auditEventId,
        );
        expect(cleanupEvent?.event_type).toBe("company_member.data_cleaned");
        expect(cleanupEvent?.details.target_principal_id).toBe(
          dual.principalId,
        );

        for (const [index, tenantId] of [COMPANY_A(), COMPANY_B()].entries()) {
          const eventId = deletionReport.auditEventIds[index];
          const event = await auditEventOf(tenantId, eventId);
          expect(event?.event_type).toBe("global_account.membership_revoked");
          expect(event?.details.target_principal_id).toBe(dual2.principalId);
        }

        // Cross-assertions: neither track ever writes the other's event type.
        for (const [index, tenantId] of [COMPANY_A(), COMPANY_B()].entries()) {
          const eventId = deletionReport.auditEventIds[index];
          const event = await auditEventOf(tenantId, eventId);
          expect(event?.event_type).not.toBe("company_member.data_cleaned");
        }
        expect(cleanupEvent?.event_type).not.toBe(
          "global_account.membership_revoked",
        );
      },
    );
  },
);
