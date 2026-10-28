// server/tests/multitenancy/revocation.test.ts
// MT007（Issue #50）：成员停用与撤权的级联生效与审计留痕。
//
// 验收事实源（Issue #50 四条，逐条对应 describe）：
//   (1) 团队停用后：列表、详情、下载签发、事件订阅、任务敏感动作、
//       凭据取用全部被拒绝（逐点测试——失效点清单逐项钉死）。
//   (2) 公司停用后：该公司范围内全部团队权限失效；同一用户在另一公司
//       的资格与数据完好。
//   (3) 恢复成员后权限按当前策略重新生效，不残留旧的拒绝缓存。
//   (4) 每次停用/恢复/撤权写入审计：操作者、对象、范围、版本、时间。
//
// 判定事实源与 MT005/MT006 完全同源：enterprise_memberships +
// enterprise_workspace_memberships 的有效行。本套件的级联判定全部经
// MT007 的单一判定入口 createRevocationGuard（内部复用 MT005 gate 的
// 事务内重验），停用/恢复动作全部经 MT006 的管理面（workspace-admin
// 服务，本票补恢复动作与审计）。下游各闭环 Ticket 复用本票的失效点
// 清单（REVOCATION_CHECKPOINTS），不各自实现撤权判断。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_
// DATABASE_URL）加三个受限角色 URL；缺配置时整套显式 skip（跳过原因
// 写在用例名里，skipped 不计为通过），绝不回退开发库。

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  createDrizzleRunnerEventRepository,
  createRunnerEventService,
} from "../../src/enterprise/runs/events";
import {
  createRevocationGuard,
  REVOCATION_CHECKPOINTS,
  type RevocationDecision,
  type RevocationGuard,
} from "../../src/enterprise/tenancy/revocation";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import {
  createWorkspaceScopeFixture,
  type WorkspaceScopeFixture,
} from "./support/workspace-scope";

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
      reason: `MT007 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    enterpriseTestDatabaseUrlFrom(process.env);
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
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

/** 票面六点失效清单（逐点测试的字面钉死）。 */
const EXPECTED_CHECKPOINTS = [
  "list",
  "detail.read",
  "download.issue",
  "events.subscribe",
  "task.sensitive",
  "credentials.access",
] as const;

async function decisionOf(
  guard: RevocationGuard,
  scope: PlatformScope,
  checkpoint: (typeof REVOCATION_CHECKPOINTS)[number],
): Promise<RevocationDecision> {
  return guard.decide(scope, checkpoint);
}

/** Collects an error's message chain — drizzle wraps the pg lock-timeout fault. */
async function messageChainOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    const messages: string[] = [];
    for (let e: unknown = error; e instanceof Error; e = e.cause) {
      messages.push(e.message);
    }
    return messages.join(" | ");
  }
}

describeDb("MT007 revocation (Issue #50)", () => {
  let fixture: WorkspaceScopeFixture;
  let guard: RevocationGuard;

  beforeAll(async () => {
    fixture = await createWorkspaceScopeFixture();
    guard = createRevocationGuard(fixture.gate.data);
  });

  afterAll(async () => {
    await fixture.dispose();
  });

  // -------------------------------------------------------------------------
  // criterion 0：失效点清单与单一判定入口的模块契约
  // -------------------------------------------------------------------------

  describe("criterion 0: the revocation checkpoint list is the reuse contract", () => {
    itDb("exposes exactly the six ticket-named invalidation points", () => {
      expect([...REVOCATION_CHECKPOINTS]).toEqual([...EXPECTED_CHECKPOINTS]);
    });

    itDb(
      "refuses an unknown checkpoint loudly (no silent bypass)",
      async () => {
        const scope = await fixture.resolveScope("a1-member", {
          tenantId: fixture.ids["company-a"],
          workspaceId: fixture.ids["team-a1"],
        });
        await expect(
          decisionOf(guard, scope, "download.sign" as never),
        ).rejects.toThrow("REVOCATION_CHECKPOINT_UNKNOWN");
      },
    );

    itDb("refuses a forged scope before touching the database", async () => {
      await expect(
        decisionOf(
          guard,
          {
            tenantId: fixture.ids["company-a"],
            workspaceId: fixture.ids["team-a1"],
            principalId: fixture.principalIdOf("a1-member"),
            actorId: "forged",
            memberEpoch: 1,
            aclEpoch: 1,
            entrypoint: "web",
          },
          "detail.read",
        ),
      ).rejects.toThrow("UNVERIFIED_SCOPE");
    });
  });

  // -------------------------------------------------------------------------
  // criterion 1（AC1）：团队停用后，失效点清单逐点全部拒绝
  // -------------------------------------------------------------------------

  describe("criterion 1: team suspension denies every checkpoint (AC1)", () => {
    itDb(
      "allows every checkpoint before the suspension (positive control)",
      async () => {
        const scope = await fixture.resolveScope("a1-member", {
          tenantId: fixture.ids["company-a"],
          workspaceId: fixture.ids["team-a1"],
        });
        for (const checkpoint of REVOCATION_CHECKPOINTS) {
          const decision = await decisionOf(guard, scope, checkpoint);
          expect(decision).toEqual({ outcome: "allow" });
        }
      },
    );

    describe("after the company admin suspends the team member", () => {
      let suspendedScope: PlatformScope;

      beforeAll(async () => {
        suspendedScope = await fixture.resolveScope("a1-member", {
          tenantId: fixture.ids["company-a"],
          workspaceId: fixture.ids["team-a1"],
        });
        const adminContext = await fixture.adminContextOf("company-admin");
        await fixture.adminService().suspendTeamMember(adminContext, {
          workspaceId: fixture.ids["team-a1"],
          principalId: fixture.principalIdOf("a1-member"),
        });
      });

      afterAll(async () => {
        const adminContext = await fixture.adminContextOf("company-admin");
        await fixture.adminService().restoreTeamMember(adminContext, {
          workspaceId: fixture.ids["team-a1"],
          principalId: fixture.principalIdOf("a1-member"),
        });
      });

      for (const checkpoint of EXPECTED_CHECKPOINTS) {
        itDb(
          `checkpoint "${checkpoint}" denies a pre-issued scope (point-by-point)`,
          async () => {
            const decision = await decisionOf(
              guard,
              suspendedScope,
              checkpoint,
            );
            expect(decision).toEqual({
              outcome: "deny",
              code: "WORKSPACE_REVOKED",
              level: "team",
            });
          },
        );
      }

      itDb(
        "the next request cannot even resolve a scope (WORKSPACE_FORBIDDEN)",
        async () => {
          await expect(
            fixture.resolveScope("a1-member", {
              tenantId: fixture.ids["company-a"],
              workspaceId: fixture.ids["team-a1"],
            }),
          ).rejects.toThrow("WORKSPACE_FORBIDDEN");
        },
      );

      itDb("list: the real lister drops the suspended team", async () => {
        const response = await fixture.request("a1-member", {
          method: "GET",
          path: "/",
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          companies: Array<{
            tenantId: string;
            teams: Array<{ workspaceId: string }>;
          }>;
        };
        const companyA = body.companies.find(
          (company) => company.tenantId === fixture.ids["company-a"],
        );
        expect(companyA).toBeDefined();
        expect(companyA?.teams.map((team) => team.workspaceId)).toEqual([]);
      });

      itDb(
        "detail: the real request seam refuses the resource read with 403",
        async () => {
          const response = await fixture.gate.isolation.requestAs("a1-member", {
            method: "GET",
            path: `/resources/${fixture.ids["resource-a1"]}`,
            tenantId: fixture.ids["company-a"],
            workspaceId: fixture.ids["team-a1"],
          });
          expect(response.status).toBe(403);
          const body = (await response.json()) as { error: string };
          expect(body.error).toBe("WORKSPACE_FORBIDDEN");
        },
      );

      itDb(
        "events: the wired runner event service rejects replay for a pre-issued scope",
        async () => {
          const events = createRunnerEventService({
            repository: createDrizzleRunnerEventRepository(fixture.gate.data),
            revocation: guard,
          });
          await expect(
            events.replay(suspendedScope, {
              threadId: "mt007-thread",
              afterSeq: 0,
            }),
          ).rejects.toThrow("WORKSPACE_REVOKED");
        },
      );

      itDb(
        "events: the wired subscription aborts on its first poll",
        async () => {
          const events = createRunnerEventService({
            repository: createDrizzleRunnerEventRepository(fixture.gate.data),
            revocation: guard,
          });
          const controller = new AbortController();
          // Safety abort: if the guard somehow does not reject the first poll,
          // the loop would poll forever — abort and fail loudly instead of
          // hanging the run.
          const safety = setTimeout(() => controller.abort(), 3000);
          const iterator = events.subscribe(
            suspendedScope,
            { threadId: "mt007-thread", afterSeq: 0 },
            controller.signal,
          );
          try {
            await expect(iterator.next()).rejects.toThrow("WORKSPACE_REVOKED");
          } finally {
            clearTimeout(safety);
            controller.abort();
          }
        },
      );

      itDb(
        "events: without the revocation dep the legacy seam shape is unchanged (disclosed)",
        async () => {
          const legacy = createRunnerEventService({
            repository: createDrizzleRunnerEventRepository(fixture.gate.data),
          });
          const page = await legacy.replay(suspendedScope, {
            threadId: "mt007-thread",
            afterSeq: 0,
          });
          expect(page.items).toEqual([]);
        },
      );
    });
  });

  // -------------------------------------------------------------------------
  // criterion 2（AC2）：公司停用级联；另一公司资格与数据完好
  // -------------------------------------------------------------------------

  describe("criterion 2: company suspension cascades; the other company is intact (AC2)", () => {
    itDb(
      "denies every checkpoint at company level after company suspension",
      async () => {
        const scope = await fixture.resolveScope("multi-company", {
          tenantId: fixture.ids["company-a"],
          workspaceId: fixture.ids["team-a1"],
        });
        for (const checkpoint of REVOCATION_CHECKPOINTS) {
          expect(await decisionOf(guard, scope, checkpoint)).toEqual({
            outcome: "allow",
          });
        }
        const adminContext = await fixture.adminContextOf("company-admin");
        try {
          await fixture.adminService().suspendCompanyMember(adminContext, {
            principalId: fixture.principalIdOf("multi-company"),
          });
          for (const checkpoint of EXPECTED_CHECKPOINTS) {
            expect(await decisionOf(guard, scope, checkpoint)).toEqual({
              outcome: "deny",
              code: "SCOPE_REVOKED",
              level: "company",
            });
          }
          // The company-level fact is the single cascade: the next request
          // cannot even select the company anymore.
          await expect(
            fixture.resolveScope("multi-company", {
              tenantId: fixture.ids["company-a"],
              workspaceId: fixture.ids["team-a1"],
            }),
          ).rejects.toThrow("TENANT_FORBIDDEN");
        } finally {
          await fixture.adminService().restoreCompanyMember(adminContext, {
            principalId: fixture.principalIdOf("multi-company"),
          });
        }
      },
    );

    itDb(
      "one company suspension invalidates every team of that company",
      async () => {
        const scopeA1 = await fixture.resolveScope("a1a2-member", {
          tenantId: fixture.ids["company-a"],
          workspaceId: fixture.ids["team-a1"],
        });
        const scopeA2 = await fixture.resolveScope("a1a2-member", {
          tenantId: fixture.ids["company-a"],
          workspaceId: fixture.ids["team-a2"],
        });
        const adminContext = await fixture.adminContextOf("company-admin");
        try {
          await fixture.adminService().suspendCompanyMember(adminContext, {
            principalId: fixture.principalIdOf("a1a2-member"),
          });
          for (const checkpoint of REVOCATION_CHECKPOINTS) {
            expect(await decisionOf(guard, scopeA1, checkpoint)).toEqual({
              outcome: "deny",
              code: "SCOPE_REVOKED",
              level: "company",
            });
            expect(await decisionOf(guard, scopeA2, checkpoint)).toEqual({
              outcome: "deny",
              code: "SCOPE_REVOKED",
              level: "company",
            });
          }
        } finally {
          await fixture.adminService().restoreCompanyMember(adminContext, {
            principalId: fixture.principalIdOf("a1a2-member"),
          });
        }
      },
    );

    itDb(
      "the same user's other company keeps eligibility, checkpoints and data",
      async () => {
        const adminContext = await fixture.adminContextOf("company-admin");
        try {
          await fixture.adminService().suspendCompanyMember(adminContext, {
            principalId: fixture.principalIdOf("multi-company"),
          });

          // Company B still resolves a real scope…
          const scopeB = await fixture.resolveScope("multi-company", {
            tenantId: fixture.ids["company-b"],
            workspaceId: fixture.ids["team-b1"],
          });
          // …every checkpoint still allows…
          for (const checkpoint of REVOCATION_CHECKPOINTS) {
            expect(await decisionOf(guard, scopeB, checkpoint)).toEqual({
              outcome: "allow",
            });
          }
          // …and the granted resource in company B is still readable (200).
          const detail = await fixture.gate.isolation.requestAs(
            "multi-company",
            {
              method: "GET",
              path: `/resources/${fixture.ids["resource-b1"]}`,
              tenantId: fixture.ids["company-b"],
              workspaceId: fixture.ids["team-b1"],
            },
          );
          expect(detail.status).toBe(200);

          // Facts, not effects: company B rows are untouched; the company A
          // row is suspended (not deleted) — 资格不被误删。
          const rows = await fixture.gate.isolation.queryRestricted(
            "operator",
            { tenantId: fixture.ids["company-b"] },
            "select principal_id, status from enterprise_memberships where tenant_id = $1 and principal_id = $2",
            [fixture.ids["company-b"], fixture.principalIdOf("multi-company")],
          );
          expect(rows[0]?.status).toBe("active");
          const suspendedRows = await fixture.gate.isolation.queryRestricted(
            "operator",
            { tenantId: fixture.ids["company-a"] },
            "select status from enterprise_memberships where tenant_id = $1 and principal_id = $2",
            [fixture.ids["company-a"], fixture.principalIdOf("multi-company")],
          );
          expect(suspendedRows[0]?.status).toBe("suspended");
        } finally {
          await fixture.adminService().restoreCompanyMember(adminContext, {
            principalId: fixture.principalIdOf("multi-company"),
          });
        }
      },
    );

    itDb(
      "company suspension serializes with the gate on the membership lock",
      async () => {
        const scope = await fixture.resolveScope("a1a2-member", {
          tenantId: fixture.ids["company-a"],
          workspaceId: fixture.ids["team-a1"],
        });
        const probe = await fixture.gateTransactionProbe(scope);
        const adminContext = await fixture.adminContextOf("company-admin");
        try {
          // The gate transaction holds the shared tenant/membership locks; the
          // company-level write takes them exclusive and fails with 55P03.
          const blocked = await messageChainOf(
            fixture.adminService().suspendCompanyMember(adminContext, {
              principalId: fixture.principalIdOf("a1a2-member"),
            }),
          );
          expect(blocked).toContain("lock timeout");
        } finally {
          probe.release();
          await probe.done;
        }
        try {
          const suspended = await fixture
            .adminService()
            .suspendCompanyMember(adminContext, {
              principalId: fixture.principalIdOf("a1a2-member"),
            });
          expect(suspended.membership.status).toBe("suspended");
          // The pre-issued scope is denied immediately after the write lands.
          expect(await decisionOf(guard, scope, "detail.read")).toEqual({
            outcome: "deny",
            code: "SCOPE_REVOKED",
            level: "company",
          });
        } finally {
          await fixture.adminService().restoreCompanyMember(adminContext, {
            principalId: fixture.principalIdOf("a1a2-member"),
          });
        }
      },
    );
  });

  // -------------------------------------------------------------------------
  // criterion 3（AC3）：恢复后按当前策略重新生效，不残留拒绝缓存
  // -------------------------------------------------------------------------

  describe("criterion 3: restoration re-enables per current policy, no stale denial cache (AC3)", () => {
    itDb(
      "team restore: the very same pre-issued scope is allowed again at every checkpoint",
      async () => {
        const scope = await fixture.resolveScope("a1-member", {
          tenantId: fixture.ids["company-a"],
          workspaceId: fixture.ids["team-a1"],
        });
        const adminContext = await fixture.adminContextOf("company-admin");
        const suspended = await fixture
          .adminService()
          .suspendTeamMember(adminContext, {
            workspaceId: fixture.ids["team-a1"],
            principalId: fixture.principalIdOf("a1-member"),
          });
        expect(suspended.membership.status).toBe("suspended");
        for (const checkpoint of REVOCATION_CHECKPOINTS) {
          expect(await decisionOf(guard, scope, checkpoint)).toEqual({
            outcome: "deny",
            code: "WORKSPACE_REVOKED",
            level: "team",
          });
        }
        const restored = await fixture
          .adminService()
          .restoreTeamMember(adminContext, {
            workspaceId: fixture.ids["team-a1"],
            principalId: fixture.principalIdOf("a1-member"),
          });
        expect(restored.membership.status).toBe("active");
        // 版本推进：恢复也是一次成员关系版本变更。
        expect(restored.membership.epoch).toBeGreaterThan(
          suspended.membership.epoch,
        );
        // No denial cache: the identical scope object that was just denied is
        // now allowed at every checkpoint — the guard re-reads live rows.
        for (const checkpoint of REVOCATION_CHECKPOINTS) {
          expect(await decisionOf(guard, scope, checkpoint)).toEqual({
            outcome: "allow",
          });
        }
      },
    );

    itDb(
      "team restore: a fresh request resolves and reads the granted resource (200)",
      async () => {
        const adminContext = await fixture.adminContextOf("company-admin");
        await fixture.adminService().suspendTeamMember(adminContext, {
          workspaceId: fixture.ids["team-a1"],
          principalId: fixture.principalIdOf("a1-member"),
        });
        try {
          await expect(
            fixture.resolveScope("a1-member", {
              tenantId: fixture.ids["company-a"],
              workspaceId: fixture.ids["team-a1"],
            }),
          ).rejects.toThrow("WORKSPACE_FORBIDDEN");
          await fixture.adminService().restoreTeamMember(adminContext, {
            workspaceId: fixture.ids["team-a1"],
            principalId: fixture.principalIdOf("a1-member"),
          });
          const scope = await fixture.resolveScope("a1-member", {
            tenantId: fixture.ids["company-a"],
            workspaceId: fixture.ids["team-a1"],
          });
          expect(await decisionOf(guard, scope, "detail.read")).toEqual({
            outcome: "allow",
          });
          const detail = await fixture.gate.isolation.requestAs("a1-member", {
            method: "GET",
            path: `/resources/${fixture.ids["resource-a1"]}`,
            tenantId: fixture.ids["company-a"],
            workspaceId: fixture.ids["team-a1"],
          });
          expect(detail.status).toBe(200);
        } finally {
          await fixture
            .adminService()
            .restoreTeamMember(adminContext, {
              workspaceId: fixture.ids["team-a1"],
              principalId: fixture.principalIdOf("a1-member"),
            })
            .catch(() => undefined);
        }
      },
    );

    itDb(
      "company restore: a fresh scope works everywhere; the stale scope stays rejected by epoch policy",
      async () => {
        const staleScope = await fixture.resolveScope("a1a2-member", {
          tenantId: fixture.ids["company-a"],
          workspaceId: fixture.ids["team-a1"],
        });
        const adminContext = await fixture.adminContextOf("company-admin");
        const suspended = await fixture
          .adminService()
          .suspendCompanyMember(adminContext, {
            principalId: fixture.principalIdOf("a1a2-member"),
          });
        expect(suspended.membership.status).toBe("suspended");
        try {
          expect(await decisionOf(guard, staleScope, "detail.read")).toEqual({
            outcome: "deny",
            code: "SCOPE_REVOKED",
            level: "company",
          });
          const restored = await fixture
            .adminService()
            .restoreCompanyMember(adminContext, {
              principalId: fixture.principalIdOf("a1a2-member"),
            });
          expect(restored.membership.status).toBe("active");
          expect(restored.membership.epoch).toBeGreaterThan(
            suspended.membership.epoch,
          );
          // The old scope keeps its pre-suspension epoch: its denial is
          // re-derived from the live epoch fact (policy), never cached.
          expect(staleScope.memberEpoch).toBeLessThan(
            restored.membership.epoch,
          );
          expect(await decisionOf(guard, staleScope, "detail.read")).toEqual({
            outcome: "deny",
            code: "SCOPE_REVOKED",
            level: "company",
          });
          // A freshly resolved scope carries the current epoch and works.
          const freshScope = await fixture.resolveScope("a1a2-member", {
            tenantId: fixture.ids["company-a"],
            workspaceId: fixture.ids["team-a1"],
          });
          expect(freshScope.memberEpoch).toBe(restored.membership.epoch);
          for (const checkpoint of REVOCATION_CHECKPOINTS) {
            expect(await decisionOf(guard, freshScope, checkpoint)).toEqual({
              outcome: "allow",
            });
          }
        } finally {
          await fixture
            .adminService()
            .restoreCompanyMember(adminContext, {
              principalId: fixture.principalIdOf("a1a2-member"),
            })
            .catch(() => undefined);
        }
      },
    );

    itDb(
      "restore/suspend refuse no-op states with the established not-found codes",
      async () => {
        const adminContext = await fixture.adminContextOf("company-admin");
        // Active team member cannot be "restored" again.
        await expect(
          fixture.adminService().restoreTeamMember(adminContext, {
            workspaceId: fixture.ids["team-a1"],
            principalId: fixture.principalIdOf("a1-member"),
          }),
        ).rejects.toThrow("TEAM_MEMBER_NOT_FOUND");
        // Active company member cannot be "restored"…
        await expect(
          fixture.adminService().restoreCompanyMember(adminContext, {
            principalId: fixture.principalIdOf("a1-member"),
          }),
        ).rejects.toThrow("COMPANY_MEMBER_NOT_FOUND");
        // …and an unknown principal is indistinguishable from a mismatched
        // state (no existence leak).
        await expect(
          fixture.adminService().suspendCompanyMember(adminContext, {
            principalId: `${fixture.isolation.idPrefix}-principal-unknown`,
          }),
        ).rejects.toThrow("COMPANY_MEMBER_NOT_FOUND");
      },
    );
  });

  // -------------------------------------------------------------------------
  // criterion 4（AC4）：停用/恢复/撤权逐动作审计留痕
  // -------------------------------------------------------------------------

  describe("criterion 4: every suspend/restore/removal writes an audit event (AC4)", () => {
    async function readAuditEvent(
      tenantId: string,
      eventId: string,
    ): Promise<Record<string, unknown>> {
      const rows = await fixture.gate.isolation.queryRestricted(
        "operator",
        { tenantId, operationId: eventId },
        "select event_type, actor_id, details, created_at from enterprise_security_events where tenant_id = $1 and id = $2",
        [tenantId, eventId],
      );
      expect(rows.length).toBe(1);
      return rows[0] as Record<string, unknown>;
    }

    /** The full AC4 shape: 操作者、对象、范围、版本、时间. */
    function expectAuditShape(
      event: Record<string, unknown>,
      expected: {
        eventType: string;
        operatorPrincipalId: string;
        operatorUserId: string;
        targetPrincipalId: string;
        workspaceId: string | null;
        epoch: number;
      },
    ): void {
      expect(event.event_type).toBe(expected.eventType);
      expect(event.actor_id).toBe(expected.operatorPrincipalId);
      const details = event.details as Record<string, unknown>;
      expect(details.operator_principal_id).toBe(expected.operatorPrincipalId);
      expect(details.operator_user_id).toBe(expected.operatorUserId);
      expect(details.target_principal_id).toBe(expected.targetPrincipalId);
      expect(details.workspace_id).toBe(expected.workspaceId);
      expect(details.epoch).toBe(expected.epoch);
      expect(event.created_at).toBeTruthy();
    }

    itDb("team suspension writes workspace_member.suspended", async () => {
      const adminContext = await fixture.adminContextOf("company-admin");
      try {
        const result = await fixture
          .adminService()
          .suspendTeamMember(adminContext, {
            workspaceId: fixture.ids["team-a1"],
            principalId: fixture.principalIdOf("a1-other"),
          });
        expect(result.auditEventId).toBeTruthy();
        const event = await readAuditEvent(
          fixture.ids["company-a"],
          result.auditEventId as string,
        );
        expectAuditShape(event, {
          eventType: "workspace_member.suspended",
          operatorPrincipalId: fixture.principalIdOf("company-admin"),
          operatorUserId: fixture.ids["user-company-admin"],
          targetPrincipalId: fixture.principalIdOf("a1-other"),
          workspaceId: fixture.ids["team-a1"],
          epoch: result.membership.epoch,
        });
      } finally {
        await fixture.adminService().restoreTeamMember(adminContext, {
          workspaceId: fixture.ids["team-a1"],
          principalId: fixture.principalIdOf("a1-other"),
        });
      }
    });

    itDb("team restoration writes workspace_member.restored", async () => {
      const adminContext = await fixture.adminContextOf("company-admin");
      await fixture.adminService().suspendTeamMember(adminContext, {
        workspaceId: fixture.ids["team-a1"],
        principalId: fixture.principalIdOf("a1-other"),
      });
      try {
        const result = await fixture
          .adminService()
          .restoreTeamMember(adminContext, {
            workspaceId: fixture.ids["team-a1"],
            principalId: fixture.principalIdOf("a1-other"),
          });
        expect(result.auditEventId).toBeTruthy();
        const event = await readAuditEvent(
          fixture.ids["company-a"],
          result.auditEventId as string,
        );
        expectAuditShape(event, {
          eventType: "workspace_member.restored",
          operatorPrincipalId: fixture.principalIdOf("company-admin"),
          operatorUserId: fixture.ids["user-company-admin"],
          targetPrincipalId: fixture.principalIdOf("a1-other"),
          workspaceId: fixture.ids["team-a1"],
          epoch: result.membership.epoch,
        });
      } finally {
        // If anything above failed the member is left suspended; restoring
        // here keeps the isolation matrix whole for later tests.
        await fixture
          .adminService()
          .restoreTeamMember(adminContext, {
            workspaceId: fixture.ids["team-a1"],
            principalId: fixture.principalIdOf("a1-other"),
          })
          .catch(() => undefined);
      }
    });

    itDb(
      "team removal writes workspace_member.removed with the row's last epoch",
      async () => {
        const adminContext = await fixture.adminContextOf("company-admin");
        // The version a removal records is the last epoch the row carried.
        const beforeRows = await fixture.gate.isolation.queryRestricted(
          "operator",
          { tenantId: fixture.ids["company-a"] },
          "select epoch from enterprise_workspace_memberships where tenant_id = $1 and workspace_id = $2 and principal_id = $3",
          [
            fixture.ids["company-a"],
            fixture.ids["team-a1"],
            fixture.principalIdOf("a1-other"),
          ],
        );
        const lastEpoch = Number(beforeRows[0]?.epoch);
        // a1-other is re-added afterwards so the isolation matrix stays whole.
        const result = await fixture
          .adminService()
          .removeTeamMember(adminContext, {
            workspaceId: fixture.ids["team-a1"],
            principalId: fixture.principalIdOf("a1-other"),
          });
        expect(result.removed).toBe(true);
        expect(result.auditEventId).toBeTruthy();
        const event = await readAuditEvent(
          fixture.ids["company-a"],
          result.auditEventId as string,
        );
        expectAuditShape(event, {
          eventType: "workspace_member.removed",
          operatorPrincipalId: fixture.principalIdOf("company-admin"),
          operatorUserId: fixture.ids["user-company-admin"],
          targetPrincipalId: fixture.principalIdOf("a1-other"),
          workspaceId: fixture.ids["team-a1"],
          epoch: lastEpoch,
        });
        await fixture.adminService().addTeamMember(adminContext, {
          workspaceId: fixture.ids["team-a1"],
          principalId: fixture.principalIdOf("a1-other"),
        });
      },
    );

    itDb(
      "re-adding a suspended member (reactivated) writes workspace_member.restored",
      async () => {
        const adminContext = await fixture.adminContextOf("company-admin");
        await fixture.adminService().suspendTeamMember(adminContext, {
          workspaceId: fixture.ids["team-a1"],
          principalId: fixture.principalIdOf("a1-other"),
        });
        const result = await fixture
          .adminService()
          .addTeamMember(adminContext, {
            workspaceId: fixture.ids["team-a1"],
            principalId: fixture.principalIdOf("a1-other"),
          });
        expect(result.outcome).toBe("reactivated");
        expect(result.auditEventId).toBeTruthy();
        const event = await readAuditEvent(
          fixture.ids["company-a"],
          result.auditEventId as string,
        );
        expectAuditShape(event, {
          eventType: "workspace_member.restored",
          operatorPrincipalId: fixture.principalIdOf("company-admin"),
          operatorUserId: fixture.ids["user-company-admin"],
          targetPrincipalId: fixture.principalIdOf("a1-other"),
          workspaceId: fixture.ids["team-a1"],
          epoch: result.membership.epoch,
        });
      },
    );

    itDb(
      "company suspension and restoration write company_member.* events",
      async () => {
        const adminContext = await fixture.adminContextOf("company-admin");
        const suspended = await fixture
          .adminService()
          .suspendCompanyMember(adminContext, {
            principalId: fixture.principalIdOf("multi-company"),
          });
        try {
          expect(suspended.auditEventId).toBeTruthy();
          const suspendEvent = await readAuditEvent(
            fixture.ids["company-a"],
            suspended.auditEventId as string,
          );
          expectAuditShape(suspendEvent, {
            eventType: "company_member.suspended",
            operatorPrincipalId: fixture.principalIdOf("company-admin"),
            operatorUserId: fixture.ids["user-company-admin"],
            targetPrincipalId: fixture.principalIdOf("multi-company"),
            workspaceId: null,
            epoch: suspended.membership.epoch,
          });
          const restored = await fixture
            .adminService()
            .restoreCompanyMember(adminContext, {
              principalId: fixture.principalIdOf("multi-company"),
            });
          expect(restored.auditEventId).toBeTruthy();
          const restoreEvent = await readAuditEvent(
            fixture.ids["company-a"],
            restored.auditEventId as string,
          );
          expectAuditShape(restoreEvent, {
            eventType: "company_member.restored",
            operatorPrincipalId: fixture.principalIdOf("company-admin"),
            operatorUserId: fixture.ids["user-company-admin"],
            targetPrincipalId: fixture.principalIdOf("multi-company"),
            workspaceId: null,
            epoch: restored.membership.epoch,
          });
          // The audit trail lands in the administered company's tenant scope —
          // company B's scope cannot see it (RLS tenant pin).
          const crossRows = await fixture.gate.isolation.queryRestricted(
            "operator",
            {
              tenantId: fixture.ids["company-b"],
              operationId: suspended.auditEventId as string,
            },
            "select 1 from enterprise_security_events where tenant_id = $1 and id = $2",
            [fixture.ids["company-b"], suspended.auditEventId as string],
          );
          expect(crossRows).toEqual([]);
        } finally {
          await fixture
            .adminService()
            .restoreCompanyMember(adminContext, {
              principalId: fixture.principalIdOf("multi-company"),
            })
            .catch(() => undefined);
        }
      },
    );
  });
});
