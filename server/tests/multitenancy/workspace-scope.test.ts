// server/tests/multitenancy/workspace-scope.test.ts
// MT006（Issue #49）：工作范围选择与团队管理。
//
// 验收事实源（Issue #49 四条，逐条对应 describe）：
//   (1) 登录用户可列出其有资格的公司与团队——判定事实 = 有效的
//       enterprise_memberships + enterprise_workspace_memberships 行（与
//       MT005 判定同一事实源）。
//   (2) 选择当前工作范围经裁决 #1 头（x-openbot-tenant / x-openbot-workspace）；
//       无可用团队时返回明确空状态，绝不回退默认团队。
//   (3) 公司管理员可管理本公司团队与成员名单（创建团队、成员加入/移除/
//       停用）——全部经集中管理入口（等价集中入口）执行，在事务内重验
//       tenant_admin 身份与 epoch，写路径走受限 operator 角色 + RLS。
//   (4) 管理权不隐含业务内容读取权——管理角色没有资源读路径授权
//       （越权用例证明：管理员即便自加入团队，无 grant 仍读不到资源）。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_DATABASE_URL）
// 加三个受限角色 URL；缺配置时整套显式 skip（跳过原因写在用例名里，
// skipped 不计为通过），绝不回退开发库。裁决 #1：请求头仅作选择。
// 裁决 #2：不引入任何策略版本常量。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUnavailableWorkspaceScopeRoutes } from "../../src/enterprise/tenancy/workspace-scope-routes";
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
      reason: `MT006 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

// ---------------------------------------------------------------------------
// 共享夹具：MT002 隔离矩阵 + MT004 团队成员行 + MT005 resolver + 真实路由
// ---------------------------------------------------------------------------

let fixture: WorkspaceScopeFixture;

/** The JSON body of a Response (typed loose for assertions). */
async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** The companies array of a listing response body. */
function companiesOf(body: Record<string, unknown>): Array<{
  tenantId: string;
  name: string;
  role: string;
  memberEpoch: number;
  teams: Array<{ workspaceId: string; name: string }>;
}> {
  return body.companies as Array<{
    tenantId: string;
    name: string;
    role: string;
    memberEpoch: number;
    teams: Array<{ workspaceId: string; name: string }>;
  }>;
}

/** Resolves to the rejected error code string ("" when it did not throw). */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    const codes: string[] = [];
    const messages: string[] = [];
    for (let e: unknown = error; e instanceof Error; e = e.cause) {
      messages.push(e.message);
      const code = (e as { code?: unknown }).code;
      if (typeof code === "string") codes.push(code);
    }
    const text = messages.join(" | ");
    return codes.length > 0 ? `${text} [${codes.join(",")}]` : text;
  }
}

describeDb("MT006 workspace scope and team administration (Issue #49)", () => {
  beforeAll(async () => {
    fixture = await createWorkspaceScopeFixture();
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  // -------------------------------------------------------------------------
  // 验收 (1)：登录用户可列出其有资格的公司与团队（事实 = 两种成员行）
  // -------------------------------------------------------------------------

  describe("issue #49 criterion 1: a signed-in user lists eligible companies and teams from membership facts", () => {
    itDb(
      "a member of both teams of one company lists that company with exactly those teams",
      async () => {
        const response = await fixture.request("a1a2-member", {
          method: "GET",
          path: "/",
        });
        expect(response.status).toBe(200);
        const companies = companiesOf(await bodyOf(response));
        expect(companies).toHaveLength(1);
        const [company] = companies;
        expect(company.tenantId).toBe(fixture.ids["company-a"]);
        expect(company.name).toBe("Company A");
        expect(company.role).toBe("member");
        expect(company.teams.map((team) => team.workspaceId).sort()).toEqual(
          [fixture.ids["team-a1"], fixture.ids["team-a2"]].sort(),
        );
        expect(company.teams.map((team) => team.name).sort()).toEqual(
          ["Company A / Team A1", "Company A / Team A2"].sort(),
        );
      },
    );

    itDb(
      "a multi-company member lists each company with only that company's teams",
      async () => {
        const response = await fixture.request("multi-company", {
          method: "GET",
          path: "/",
        });
        expect(response.status).toBe(200);
        const companies = companiesOf(await bodyOf(response));
        expect(companies).toHaveLength(2);
        const byTenant = new Map(
          companies.map((company) => [company.tenantId, company]),
        );
        const companyA = byTenant.get(fixture.ids["company-a"]);
        const companyB = byTenant.get(fixture.ids["company-b"]);
        expect(companyA?.teams.map((team) => team.workspaceId)).toEqual([
          fixture.ids["team-a1"],
        ]);
        expect(companyB?.teams.map((team) => team.workspaceId)).toEqual([
          fixture.ids["team-b1"],
        ]);
      },
    );

    itDb(
      "a company admin lists their company with an explicit empty teams array",
      async () => {
        const response = await fixture.request("company-admin", {
          method: "GET",
          path: "/",
        });
        expect(response.status).toBe(200);
        const companies = companiesOf(await bodyOf(response));
        expect(companies).toHaveLength(1);
        expect(companies[0]?.tenantId).toBe(fixture.ids["company-a"]);
        expect(companies[0]?.role).toBe("tenant_admin");
        expect(companies[0]?.teams).toEqual([]);
      },
    );

    itDb(
      "a user with no company memberships gets an explicit empty listing, not a default",
      async () => {
        const response = await fixture.request("scopeless-user", {
          method: "GET",
          path: "/",
        });
        expect(response.status).toBe(200);
        expect(companiesOf(await bodyOf(response))).toEqual([]);
      },
    );

    itDb("an unauthenticated request is refused, not listed", async () => {
      const response = await fixture.requestAnonymous({
        method: "GET",
        path: "/",
      });
      expect(response.status).toBe(401);
      expect((await bodyOf(response)).error).toBeDefined();
    });

    itDb(
      "a suspended team membership disappears from the listing while other teams stay",
      async () => {
        await fixture.gate.suspendTeamMembership("a1a2-member", "team-a2");
        try {
          const response = await fixture.request("a1a2-member", {
            method: "GET",
            path: "/",
          });
          expect(response.status).toBe(200);
          const [company] = companiesOf(await bodyOf(response));
          expect(company?.teams.map((team) => team.workspaceId)).toEqual([
            fixture.ids["team-a1"],
          ]);
        } finally {
          await fixture.gate.grantTeamMembership("a1a2-member", "team-a2");
        }
      },
    );

    itDb(
      "a suspended company membership hides the whole company from the listing",
      async () => {
        const b1 = fixture.identities["multi-company"];
        const companyB = b1.companies.find(
          (entry) => entry.companyKey === "company-b",
        );
        if (!companyB) throw new Error("fixture company-b fact missing");
        await fixture.isolation.suspendCompanyMembership(
          "multi-company",
          companyB.tenantId,
        );
        const response = await fixture.request("multi-company", {
          method: "GET",
          path: "/",
        });
        expect(response.status).toBe(200);
        const companies = companiesOf(await bodyOf(response));
        expect(
          companies.some((company) => company.tenantId === companyB.tenantId),
        ).toBe(false);
      },
    );

    itDb(
      "the listing never carries a server-chosen current or default scope field",
      async () => {
        const response = await fixture.request("a1-member", {
          method: "GET",
          path: "/",
        });
        const body = await bodyOf(response);
        for (const key of ["current", "selected", "default", "active"]) {
          expect(key in body).toBe(false);
        }
        for (const company of companiesOf(body)) {
          for (const key of ["current", "selected", "default", "active"]) {
            expect(key in company).toBe(false);
          }
        }
      },
    );
  });

  // -------------------------------------------------------------------------
  // 验收 (2)：选择经裁决 #1 头；无可用团队 → 明确空状态，不回退默认团队
  // -------------------------------------------------------------------------

  describe("issue #49 criterion 2: scope selection goes through the ruling #1 headers; no default fallback, explicit empty state", () => {
    itDb(
      "every listed team admits scope selection through the ruling #1 headers",
      async () => {
        const listing = companiesOf(
          await bodyOf(
            await fixture.request("a1a2-member", { method: "GET", path: "/" }),
          ),
        );
        const listed = listing
          .flatMap((company) =>
            company.teams.map((team) => ({
              tenantId: company.tenantId,
              workspaceId: team.workspaceId,
            })),
          )
          .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
        expect(listed).toHaveLength(2);
        for (const selector of listed) {
          const scope = await fixture.gate.resolver.resolve(
            fixture.gate.requestFor("a1a2-member", selector),
          );
          expect(scope.tenantId).toBe(selector.tenantId);
          expect(scope.workspaceId).toBe(selector.workspaceId);
        }
      },
    );

    itDb(
      "a team that is not listed is not selectable (WORKSPACE_FORBIDDEN)",
      async () => {
        // a1-member 的列表只有 team-a1；team-a2 不在列表中，选择即被拒。
        const listing = companiesOf(
          await bodyOf(
            await fixture.request("a1-member", { method: "GET", path: "/" }),
          ),
        );
        const listedTeams = listing.flatMap((company) =>
          company.teams.map((team) => team.workspaceId),
        );
        expect(listedTeams).toEqual([fixture.ids["team-a1"]]);
        expect(
          await codeOf(
            fixture.gate.resolver.resolve(
              fixture.gate.requestFor("a1-member", {
                tenantId: fixture.ids["company-a"],
                workspaceId: fixture.ids["team-a2"],
              }),
            ),
          ),
        ).toBe("WORKSPACE_FORBIDDEN");
      },
    );

    itDb(
      "a user with no teams still gets WORKSPACE_REQUIRED without a header — no only-team or first-team default",
      async () => {
        // company-admin 在唯一公司里没有任何团队；即便全公司只有一个团队，
        // 缺 workspace 头也绝不自动选择。
        expect(
          await codeOf(
            fixture.gate.resolver.resolve(
              fixture.gate.requestFor("company-admin", {
                tenantId: fixture.ids["company-a"],
              }),
            ),
          ),
        ).toBe("WORKSPACE_REQUIRED");
        expect(
          await codeOf(
            fixture.gate.resolver.resolve(
              fixture.gate.requestFor("a1-member", {
                tenantId: fixture.ids["company-a"],
              }),
            ),
          ),
        ).toBe("WORKSPACE_REQUIRED");
      },
    );

    itDb(
      "a user with no companies selecting any company is TENANT_FORBIDDEN (empty state has no hidden default)",
      async () => {
        const listing = companiesOf(
          await bodyOf(
            await fixture.request("scopeless-user", {
              method: "GET",
              path: "/",
            }),
          ),
        );
        expect(listing).toEqual([]);
        expect(
          await codeOf(
            fixture.resolveScope("scopeless-user", {
              tenantId: fixture.ids["company-a"],
              workspaceId: fixture.ids["team-a1"],
            }),
          ),
        ).toBe("TENANT_FORBIDDEN");
      },
    );

    itDb("blank selector headers are refused like missing ones", async () => {
      expect(
        await codeOf(
          fixture.gate.resolver.resolve(
            fixture.gate.requestFor("a1-member", {
              tenantId: "  ",
              workspaceId: fixture.ids["team-a1"],
            }),
          ),
        ),
      ).toBe("TENANT_REQUIRED");
      expect(
        await codeOf(
          fixture.gate.resolver.resolve(
            fixture.gate.requestFor("a1-member", {
              tenantId: fixture.ids["company-a"],
              workspaceId: " ",
            }),
          ),
        ),
      ).toBe("WORKSPACE_REQUIRED");
    });
  });

  // -------------------------------------------------------------------------
  // 验收 (3)：公司管理员经集中管理入口管理团队与成员名单
  // -------------------------------------------------------------------------

  describe("issue #49 criterion 3: a company admin manages the company's teams and roster through the centralized admin entry", () => {
    itDb(
      "the admin creates a team; the row exists and the team appears in listings after membership",
      async () => {
        const response = await fixture.request("company-admin", {
          method: "POST",
          path: "/admin/teams",
          tenantId: fixture.ids["company-a"],
          body: {
            name: "Company A / Team A3",
            workspaceId: fixture.newTeamId(),
          },
        });
        expect(response.status).toBe(201);
        const created = (await bodyOf(response)).team as {
          workspaceId: string;
          name: string;
        };
        expect(created.name).toBe("Company A / Team A3");

        const rows = await fixture.query(
          "operator",
          { tenantId: fixture.ids["company-a"] },
          "select id, name from enterprise_workspaces where id = $1",
          [created.workspaceId],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.name).toBe("Company A / Team A3");

        fixture.registerCreatedTeam(created.workspaceId);
      },
    );

    itDb(
      "creating a team with an existing workspace id is a 409, not a silent overwrite",
      async () => {
        const response = await fixture.request("company-admin", {
          method: "POST",
          path: "/admin/teams",
          tenantId: fixture.ids["company-a"],
          body: {
            name: "Duplicate",
            workspaceId: fixture.ids["team-a1"],
          },
        });
        expect(response.status).toBe(409);
      },
    );

    itDb(
      "a plain member is refused team creation (TENANT_ADMIN_REQUIRED), and so is a non-member",
      async () => {
        const member = await fixture.request("a1-member", {
          method: "POST",
          path: "/admin/teams",
          tenantId: fixture.ids["company-a"],
          body: { name: "Rogue team" },
        });
        expect(member.status).toBe(403);
        expect(((await bodyOf(member)).error as { code: string }).code).toBe(
          "TENANT_ADMIN_REQUIRED",
        );
        const outsider = await fixture.request("b1-member", {
          method: "POST",
          path: "/admin/teams",
          tenantId: fixture.ids["company-a"],
          body: { name: "Outsider team" },
        });
        expect(outsider.status).toBe(403);
      },
    );

    itDb(
      "the admin of company-a cannot administer company-b (company boundary holds)",
      async () => {
        const response = await fixture.request("company-admin", {
          method: "POST",
          path: "/admin/teams",
          tenantId: fixture.ids["company-b"],
          body: { name: "Company B rogue" },
        });
        expect(response.status).toBe(403);
        expect(((await bodyOf(response)).error as { code: string }).code).toBe(
          "TENANT_FORBIDDEN",
        );
      },
    );

    itDb(
      "the admin adds a company member to a team; the same membership fact feeds the MT005 gate",
      async () => {
        const workspaceId = fixture.ids["team-a2"];
        const before = await fixture.request("company-admin", {
          method: "POST",
          path: `/admin/teams/${workspaceId}/members`,
          tenantId: fixture.ids["company-a"],
          body: { principalId: fixture.principalIdOf("a1-member") },
        });
        expect(before.status).toBe(201);
        const membership = (await bodyOf(before)).membership as {
          status: string;
          epoch: number;
        };
        expect(membership.status).toBe("active");
        expect(membership.epoch).toBeGreaterThan(0);

        // 同一事实源：新成员行立即可被 MT005 判定接受（真实 resolver）。
        const scope = await fixture.gate.resolver.resolve(
          fixture.gate.requestFor("a1-member", {
            tenantId: fixture.ids["company-a"],
            workspaceId,
          }),
        );
        expect(scope.workspaceId).toBe(workspaceId);
        // 且成员自己的列表现在包含该团队。
        const listing = companiesOf(
          await bodyOf(
            await fixture.request("a1-member", { method: "GET", path: "/" }),
          ),
        );
        const a2 = listing
          .find((company) => company.tenantId === fixture.ids["company-a"])
          ?.teams.find((team) => team.workspaceId === workspaceId);
        expect(a2).toBeDefined();

        // 再加入已是 active 的成员 → 409。
        const duplicate = await fixture.request("company-admin", {
          method: "POST",
          path: `/admin/teams/${workspaceId}/members`,
          tenantId: fixture.ids["company-a"],
          body: { principalId: fixture.principalIdOf("a1-member") },
        });
        expect(duplicate.status).toBe(409);
      },
    );

    itDb(
      "adding a principal who is not an active company member is refused without leaking existence",
      async () => {
        // b1-member 是 company-b 的成员，不是 company-a 的成员。
        const cross = await fixture.request("company-admin", {
          method: "POST",
          path: `/admin/teams/${fixture.ids["team-a1"]}/members`,
          tenantId: fixture.ids["company-a"],
          body: { principalId: fixture.principalIdOf("b1-member") },
        });
        expect(cross.status).toBe(404);
        // 完全不存在的 principal 同样 404 —— 两种不可区分。
        const ghost = await fixture.request("company-admin", {
          method: "POST",
          path: `/admin/teams/${fixture.ids["team-a1"]}/members`,
          tenantId: fixture.ids["company-a"],
          body: { principalId: `${fixture.ids["company-a"]}-ghost-principal` },
        });
        expect(ghost.status).toBe(404);
        expect(((await bodyOf(ghost)).error as { code: string }).code).toBe(
          ((await bodyOf(cross)).error as { code: string }).code,
        );
      },
    );

    itDb(
      "the admin suspends a member; the MT005 gate revokes the very next selection",
      async () => {
        const workspaceId = fixture.ids["team-a2"];
        const suspended = await fixture.request("company-admin", {
          method: "POST",
          path: `/admin/teams/${workspaceId}/members/${fixture.principalIdOf("a1-member")}/suspend`,
          tenantId: fixture.ids["company-a"],
        });
        expect(suspended.status).toBe(200);
        const membership = (await bodyOf(suspended)).membership as {
          status: string;
          epoch: number;
        };
        expect(membership.status).toBe("suspended");

        const listing = companiesOf(
          await bodyOf(
            await fixture.request("a1-member", { method: "GET", path: "/" }),
          ),
        );
        expect(
          listing
            .find((company) => company.tenantId === fixture.ids["company-a"])
            ?.teams.some((team) => team.workspaceId === workspaceId),
        ).toBe(false);

        // 重新激活（停用后的再加入）→ epoch 严格递增。
        const resumed = await fixture.request("company-admin", {
          method: "POST",
          path: `/admin/teams/${workspaceId}/members`,
          tenantId: fixture.ids["company-a"],
          body: { principalId: fixture.principalIdOf("a1-member") },
        });
        expect(resumed.status).toBe(200);
        const resumedMembership = (await bodyOf(resumed)).membership as {
          status: string;
          epoch: number;
        };
        expect(resumedMembership.status).toBe("active");
        expect(resumedMembership.epoch).toBeGreaterThan(membership.epoch);
      },
    );

    itDb(
      "the admin removes a member; the row is gone and re-adding restores eligibility with a larger epoch",
      async () => {
        const workspaceId = fixture.ids["team-a2"];
        const removed = await fixture.request("company-admin", {
          method: "DELETE",
          path: `/admin/teams/${workspaceId}/members/${fixture.principalIdOf("a1-member")}`,
          tenantId: fixture.ids["company-a"],
        });
        expect(removed.status).toBe(200);

        const rows = await fixture.query(
          "operator",
          { tenantId: fixture.ids["company-a"] },
          "select principal_id from enterprise_workspace_memberships where workspace_id = $1 and principal_id = $2",
          [workspaceId, fixture.principalIdOf("a1-member")],
        );
        expect(rows).toEqual([]);

        // 行已删除：选择立即被拒（同一事实源）。
        expect(
          await codeOf(
            fixture.gate.resolver.resolve(
              fixture.gate.requestFor("a1-member", {
                tenantId: fixture.ids["company-a"],
                workspaceId,
              }),
            ),
          ),
        ).toBe("WORKSPACE_FORBIDDEN");

        // 移除不存在的成员行 → 404，与不存在团队同样不可区分语义由各自码区分。
        const missing = await fixture.request("company-admin", {
          method: "DELETE",
          path: `/admin/teams/${workspaceId}/members/${fixture.principalIdOf("a1-member")}`,
          tenantId: fixture.ids["company-a"],
        });
        expect(missing.status).toBe(404);
      },
    );

    itDb(
      "another company's team is invisible to the admin: removal answers 404 and writes nothing",
      async () => {
        const response = await fixture.request("company-admin", {
          method: "DELETE",
          path: `/admin/teams/${fixture.ids["team-b1"]}/members/${fixture.principalIdOf("b1-member")}`,
          tenantId: fixture.ids["company-a"],
        });
        // 跨公司对象按不可见处理（404），且绝不产生跨公司写入。
        expect(response.status).toBe(404);
        const intact = await fixture.query(
          "operator",
          { tenantId: fixture.ids["company-b"] },
          "select principal_id from enterprise_workspace_memberships where workspace_id = $1 and principal_id = $2",
          [fixture.ids["team-b1"], fixture.principalIdOf("b1-member")],
        );
        expect(intact).toHaveLength(1);
      },
    );

    itDb(
      "a stale admin context (company epoch bumped after issuance) is refused by the in-transaction revalidation",
      async () => {
        const stale = await fixture.staleAdminContext("company-admin");
        expect(
          await codeOf(
            fixture.adminService().createTeam(stale, {
              name: "Post-revocation team",
            }),
          ),
        ).toBe("SCOPE_REVOKED");
      },
    );

    itDb(
      "an admin demoted to plain member (role changed, epoch untouched) is refused by the in-transaction revalidation",
      async () => {
        const context = await fixture.adminContextOf("company-admin");
        await fixture.setCompanyMembershipRole("company-admin", "member");
        try {
          expect(
            await codeOf(
              fixture.adminService().createTeam(context, {
                name: "Demoted admin team",
              }),
            ),
          ).toBe("SCOPE_REVOKED");
        } finally {
          await fixture.setCompanyMembershipRole(
            "company-admin",
            "tenant_admin",
          );
        }
      },
    );

    itDb(
      "a forged or deserialized admin context is rejected like a forged scope",
      async () => {
        const genuine = await fixture.adminContextOf("company-admin");
        const forged = {
          tenantId: genuine.tenantId,
          principalId: genuine.principalId,
          actorId: genuine.actorId,
          memberEpoch: genuine.memberEpoch,
        };
        expect(
          await codeOf(
            fixture.adminService().createTeam(forged, { name: "Forged" }),
          ),
        ).toBe("UNVERIFIED_ADMIN_CONTEXT");
        const serialized = JSON.parse(
          JSON.stringify(genuine),
        ) as typeof genuine;
        expect(
          await codeOf(
            fixture.adminService().createTeam(serialized, { name: "Cloned" }),
          ),
        ).toBe("UNVERIFIED_ADMIN_CONTEXT");
      },
    );

    itDb(
      "an in-flight MT005 gate transaction serializes the admin membership write (same advisory key)",
      async () => {
        // 先把 a1-member 加回 team-a2（上面的移除用例删掉了行）。
        const rejoin = await fixture.request("company-admin", {
          method: "POST",
          path: `/admin/teams/${fixture.ids["team-a2"]}/members`,
          tenantId: fixture.ids["company-a"],
          body: { principalId: fixture.principalIdOf("a1-member") },
        });
        expect([200, 201]).toContain(rejoin.status);

        const scope = await fixture.gate.resolver.resolve(
          fixture.gate.requestFor("a1-member", {
            tenantId: fixture.ids["company-a"],
            workspaceId: fixture.ids["team-a2"],
          }),
        );
        // 持有 gate 事务（共享锁）期间，同一管理写（服务层直调，保留原始错）
        // 以 55P03 lock timeout 失败；释放后同一写立即生效。
        const gate = await fixture.gateTransactionProbe(scope);
        const adminContext = await fixture.adminContextOf("company-admin");
        let released = false;
        try {
          const blocked = await codeOf(
            fixture.adminService().suspendTeamMember(adminContext, {
              workspaceId: fixture.ids["team-a2"],
              principalId: fixture.principalIdOf("a1-member"),
            }),
          );
          expect(blocked).toContain("lock timeout");

          gate.release();
          released = true;
          expect(await gate.done).toBe("done");
        } finally {
          // 断言失败也不能留下悬挂的 gate 事务（否则清理会阻塞在锁上）。
          if (!released) gate.release();
          await gate.done.catch(() => {});
        }

        // 锁释放后管理写正常生效。
        const after = await fixture.request("company-admin", {
          method: "POST",
          path: `/admin/teams/${fixture.ids["team-a2"]}/members/${fixture.principalIdOf("a1-member")}/suspend`,
          tenantId: fixture.ids["company-a"],
        });
        expect(after.status).toBe(200);
      },
    );

    itDb(
      "admin routes answer 503 unavailable when the operator channel is not wired",
      async () => {
        const routes = createUnavailableWorkspaceScopeRoutes();
        const response = await routes.fetch(
          new Request("https://mt006.invalid/admin/teams", {
            method: "POST",
            headers: { "x-openbot-tenant": "t" },
            body: JSON.stringify({ name: "x" }),
          }),
        );
        expect(response.status).toBe(503);
      },
    );
  });

  // -------------------------------------------------------------------------
  // 验收 (4)：管理权不隐含业务内容读取权
  // -------------------------------------------------------------------------

  describe("issue #49 criterion 4: admin power implies no business-content read authorization", () => {
    itDb(
      "a company admin with no team membership cannot resolve into a team to read anything",
      async () => {
        expect(
          await codeOf(
            fixture.gate.resolver.resolve(
              fixture.gate.requestFor("company-admin", {
                tenantId: fixture.ids["company-a"],
                workspaceId: fixture.ids["team-a1"],
              }),
            ),
          ),
        ).toBe("WORKSPACE_FORBIDDEN");
      },
    );

    itDb(
      "even an admin who explicitly adds themselves to a team cannot read a resource without a grant",
      async () => {
        // 管理员把自己加进 team-a1（管理权内的显式行为），读取团队资源仍被拒。
        const joined = await fixture.request("company-admin", {
          method: "POST",
          path: `/admin/teams/${fixture.ids["team-a1"]}/members`,
          tenantId: fixture.ids["company-a"],
          body: { principalId: fixture.principalIdOf("company-admin") },
        });
        expect([200, 201]).toContain(joined.status);
        try {
          const scope = await fixture.gate.resolver.resolve(
            fixture.gate.requestFor("company-admin", {
              tenantId: fixture.ids["company-a"],
              workspaceId: fixture.ids["team-a1"],
            }),
          );
          const response = await fixture.isolation.requestAs("company-admin", {
            method: "GET",
            path: `/resources/${fixture.ids["resource-a1"]}`,
            tenantId: fixture.ids["company-a"],
            workspaceId: fixture.ids["team-a1"],
          });
          void scope;
          // 资源读取走真实 reader：无 grant → 不可见（404），绝不是 200。
          expect(response.status).toBe(404);
        } finally {
          await fixture.request("company-admin", {
            method: "DELETE",
            path: `/admin/teams/${fixture.ids["team-a1"]}/members/${fixture.principalIdOf("company-admin")}`,
            tenantId: fixture.ids["company-a"],
          });
        }
      },
    );

    itDb(
      "the admin surface exposes no resource-read path: every management DTO carries membership facts only",
      async () => {
        // a2-member 只在 team-a2；加入 team-a1 产生新行。
        const response = await fixture.request("company-admin", {
          method: "POST",
          path: `/admin/teams/${fixture.ids["team-a1"]}/members`,
          tenantId: fixture.ids["company-a"],
          body: { principalId: fixture.principalIdOf("a2-member") },
        });
        expect([200, 201]).toContain(response.status);
        const membership = (await bodyOf(response)).membership as Record<
          string,
          unknown
        >;
        for (const key of Object.keys(membership)) {
          expect(["workspaceId", "principalId", "status", "epoch"]).toContain(
            key,
          );
        }
        await fixture.request("company-admin", {
          method: "DELETE",
          path: `/admin/teams/${fixture.ids["team-a1"]}/members/${fixture.principalIdOf("a2-member")}`,
          tenantId: fixture.ids["company-a"],
        });
      },
    );

    itDb(
      "the admin service cannot list or read enterprise resources at all (no such method)",
      async () => {
        const service = fixture.adminService() as unknown as Record<
          string,
          unknown
        >;
        for (const key of Object.keys(service)) {
          expect(key.toLowerCase()).not.toContain("resource");
          expect(key.toLowerCase()).not.toContain("read");
        }
      },
    );
  });

  // -------------------------------------------------------------------------
  // 输入校验：畸形请求在授权之前就被拒绝
  // -------------------------------------------------------------------------

  describe("input validation precedes authorization on every management route", () => {
    itDb("team creation without a name is INVALID_REQUEST", async () => {
      const response = await fixture.request("company-admin", {
        method: "POST",
        path: "/admin/teams",
        tenantId: fixture.ids["company-a"],
        body: {},
      });
      expect(response.status).toBe(400);
    });

    itDb(
      "member addition without a principalId is INVALID_REQUEST",
      async () => {
        const response = await fixture.request("company-admin", {
          method: "POST",
          path: `/admin/teams/${fixture.ids["team-a1"]}/members`,
          tenantId: fixture.ids["company-a"],
          body: {},
        });
        expect(response.status).toBe(400);
      },
    );

    itDb(
      "admin routes without a tenant header are TENANT_REQUIRED",
      async () => {
        const response = await fixture.request("company-admin", {
          method: "POST",
          path: "/admin/teams",
          body: { name: "No tenant" },
        });
        expect(response.status).toBe(400);
        expect(((await bodyOf(response)).error as { code: string }).code).toBe(
          "TENANT_REQUIRED",
        );
      },
    );
  });
});
