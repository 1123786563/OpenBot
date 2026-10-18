// server/tests/multitenancy/personal-share-rules.test.ts
// MT010（Issue #53）：个人资源权限与显式跨团队分享。
//
// 验收事实源（Issue #53 四条，逐条对应 describe）：
//   (1) 同团队另一人无法读取某人的个人会话、个人文件与个人连接凭据
//       （三条 canonical personal kind，三条判定门：既有 reader 授权路径、
//       workspace-v1 策略判定、分享感知判定——团队资格不开任何一扇门）。
//   (2) 显式分享只在指定受众、动作与有效期内有效；过期或撤销后立即失效
//       （有效期按数据库时钟 now() 现场核对；撤销 = 删除行，无可达中间态；
//       公司成员资格被停用时分享同样立即失效）。
//   (3) 跨公司 Grant 与跨公司分享永远拒绝（即使资源 ID 正确）：服务层显式
//       拒绝 + 复合外键结构性不可能（23503）+ 跨公司判定与「不存在」逐字节
//       同形（不泄露存在性）。
//   (4) 分享不改变资源归属；被分享方不能转授管理动作（分享前后 ownership
//       facts 逐字段一致；被分享方 share/revoke 一律 NOT_RESOURCE_OWNER；
//       动作域被 CHECK 与服务层双重钉死在 'read'）。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_DATABASE_URL）
// 加三个受限角色 URL；缺配置时整套显式 skip（跳过原因写在用例名里，
// skipped 不计为通过），绝不回退开发库。MT010 迁移（enterprise_resource_shares
// 表 + FORCE RLS + 最小列授权）经 MT003 工具（migrate-test.ts）真实执行，
// 本文件不自己 DDL。

import { afterAll, beforeAll, describe, expect, test } from "../../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  buildPlan,
  manifestFor,
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import {
  createResourcePolicyService,
  TENANCY_V1_POLICY_ID,
  WORKSPACE_V1_POLICY_ID,
} from "../../src/enterprise/tenancy/resource-policy";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import { rejectionOf } from "../support/pg-errors";
import {
  createPersonalShareFixture,
  type PersonalResourceFact,
  type PersonalShareFixture,
} from "./support/personal-share";

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
      reason: `MT010 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
// 判定断言助手：deny 只有一种对外形状（不泄露存在性）
// ---------------------------------------------------------------------------

const DENY_NOT_FOUND = Object.freeze({
  outcome: "deny",
  code: "RESOURCE_NOT_FOUND",
});

/** Resolves to the thrown error message ("" when it did not throw). */
async function thrownMessage(promise: Promise<unknown>): Promise<string> {
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

function secondsFromNow(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

// ---------------------------------------------------------------------------
// 共享夹具 + MT010 迁移（经 MT003 工具真实执行）
// ---------------------------------------------------------------------------

let fixture: PersonalShareFixture;
let dryRunOutcome: RunOutcome;
let applyOutcome: RunOutcome;

// 个人资源平面：三位属主、三个 canonical kind、一家公司 B 对照资源。
let pSession: PersonalResourceFact;
let pFile: PersonalResourceFact;
let pConn: PersonalResourceFact;
let pConnOfOther: PersonalResourceFact;
let pSessionB: PersonalResourceFact;

describeDb(
  "MT010 personal resource permissions and explicit cross-team shares (Issue #53)",
  () => {
    beforeAll(async () => {
      const resolved = resolveTestDatabaseTarget(process.env);
      if (!resolved.ok) {
        throw new Error(
          `MT010 personal-share tests refuse to run: ${resolved.reason}`,
        );
      }
      dryRunOutcome = await runMigrateTest(["migrate", "MT010"], {
        environment: { TEST_DATABASE_URL: resolved.target.url },
        out: () => {},
      });
      const manifestPath = `/tmp/mt010-manifest-${randomUUID()}.json`;
      await Bun.write(
        manifestPath,
        `${JSON.stringify(manifestFor(buildPlan("MT010")), null, 2)}\n`,
      );
      try {
        applyOutcome = await runMigrateTest(
          ["migrate", "MT010", "--apply", "--manifest", manifestPath],
          {
            environment: { TEST_DATABASE_URL: resolved.target.url },
            out: () => {},
          },
        );
      } finally {
        await rm(manifestPath, { force: true });
      }
      fixture = await createPersonalShareFixture();
      pSession = await fixture.provisionPersonalResource({
        kind: "session",
        owner: "a1-member",
        team: "team-a1",
      });
      pFile = await fixture.provisionPersonalResource({
        kind: "file",
        owner: "a1-member",
        team: "team-a1",
      });
      pConn = await fixture.provisionPersonalResource({
        kind: "connection",
        owner: "a1-member",
        team: "team-a1",
      });
      pConnOfOther = await fixture.provisionPersonalResource({
        kind: "connection",
        owner: "a1-other",
        team: "team-a1",
      });
      pSessionB = await fixture.provisionPersonalResource({
        kind: "session",
        owner: "b1-member",
        team: "team-b1",
      });
    });

    afterAll(async () => {
      await fixture?.dispose();
    });

    // ---------------------------------------------------------------------
    // 验收 1：团队资格不开个人资源——三个 kind × 三条判定门
    // ---------------------------------------------------------------------

    describe("issue #53 acceptance 1: team membership never opens personal session/file/connection", () => {
      itDb(
        "the same-team other person is denied through the real reader for every personal kind",
        async () => {
          for (const resource of [pSession, pFile, pConn]) {
            const response = await fixture.base.isolation.requestAs(
              "a1-other",
              {
                method: "GET",
                path: `/resources/${resource.resourceId}`,
                tenantId: resource.tenantId,
                workspaceId: resource.workspaceId,
              },
            );
            expect(response.status).toBe(404);
            expect(await response.json()).toEqual({
              error: "RESOURCE_NOT_FOUND",
            });
          }
        },
      );

      itDb(
        "the denial is not vacuous: the same-team other person holds an active team membership",
        async () => {
          const where = fixture.base.teamOf("a1-other", "team-a1");
          const rows = await fixture.base.isolation.queryRestricted(
            "operator",
            { tenantId: where.tenantId },
            "select status from enterprise_workspace_memberships where tenant_id = $1 and workspace_id = $2 and principal_id = $3",
            [where.tenantId, where.workspaceId, where.principalId],
          );
          expect(rows.length).toBe(1);
          expect(String(rows[0].status)).toBe("active");
        },
      );

      itDb(
        "the owner keeps reading every personal kind through the same reader (positive control)",
        async () => {
          for (const resource of [pSession, pFile, pConn]) {
            const response = await fixture.base.isolation.requestAs(
              "a1-member",
              {
                method: "GET",
                path: `/resources/${resource.resourceId}`,
                tenantId: resource.tenantId,
                workspaceId: resource.workspaceId,
              },
            );
            expect(response.status).toBe(200);
            const view = (await response.json()) as Record<string, unknown>;
            expect(view.resourceId).toBe(resource.resourceId);
            expect(view.resourceType).toBe(resource.kind);
          }
        },
      );

      itDb(
        "workspace-v1 and tenancy-v1 both deny the same-team member for every personal kind",
        async () => {
          const policy = createResourcePolicyService(fixture.base.data);
          for (const resource of [pSession, pFile, pConn]) {
            const scope = await fixture.base.scopeFor("a1-other", {
              tenantId: resource.tenantId,
              workspaceId: resource.workspaceId,
            });
            expect(
              await policy.decide(scope, resource.resourceId, {
                policyVersion: WORKSPACE_V1_POLICY_ID,
              }),
            ).toEqual(DENY_NOT_FOUND);
            expect(
              await policy.decide(scope, resource.resourceId, {
                policyVersion: TENANCY_V1_POLICY_ID,
              }),
            ).toEqual(DENY_NOT_FOUND);
          }
        },
      );

      itDb(
        "the share-aware decision denies a same-team non-owner with no share in place",
        async () => {
          for (const resource of [pSession, pFile, pConn]) {
            const scope = await fixture.base.scopeFor("a1-other", {
              tenantId: resource.tenantId,
              workspaceId: resource.workspaceId,
            });
            expect(
              await fixture.decisions.decide(scope, resource.resourceId),
            ).toEqual(DENY_NOT_FOUND);
          }
        },
      );

      itDb(
        "a foreign same-company principal cannot read someone else's personal resource either",
        async () => {
          // a2-member 属于同公司另一团队——同公司≠同权：个人资源不因公司成员资格可见。
          const scope = await fixture.base.scopeFor("a2-member", {
            tenantId: pSession.tenantId,
            workspaceId: fixture.base.teamOf("a2-member", "team-a2")
              .workspaceId,
          });
          expect(
            await fixture.decisions.decide(scope, pSession.resourceId),
          ).toEqual(DENY_NOT_FOUND);
        },
      );
    });

    // ---------------------------------------------------------------------
    // 验收 2：显式分享只在受众/动作/有效期内有效；过期与撤销立即失效
    // ---------------------------------------------------------------------

    describe("issue #53 acceptance 2: a share holds only for its audience, action and validity window", () => {
      itDb(
        "the owner shares a personal session cross-team and the audience reads within the window",
        async () => {
          const owner = fixture.base.teamOf("a1-member", "team-a1");
          const audience = fixture.base.teamOf("a2-member", "team-a2");
          const receipt = await fixture.shares.share({
            tenantId: pSession.tenantId,
            resourceId: pSession.resourceId,
            actorPrincipalId: owner.principalId,
            audiencePrincipalId: audience.principalId,
            action: "read",
            expiresAt: secondsFromNow(30),
          });
          expect(receipt).toMatchObject({
            tenantId: pSession.tenantId,
            resourceId: pSession.resourceId,
            audiencePrincipalId: audience.principalId,
            action: "read",
          });
          // 受众在自己团队的 scope 下读取（跨团队访问的唯一合法路径）。
          const audienceScope = await fixture.base.scopeFor("a2-member", {
            tenantId: pSession.tenantId,
            workspaceId: audience.workspaceId,
          });
          expect(
            await fixture.decisions.decide(audienceScope, pSession.resourceId),
          ).toEqual({ outcome: "allow" });
        },
      );

      itDb(
        "the share is audience-scoped: the owner's same-team colleague stays denied",
        async () => {
          const scope = await fixture.base.scopeFor("a1-other", {
            tenantId: pSession.tenantId,
            workspaceId: pSession.workspaceId,
          });
          expect(
            await fixture.decisions.decide(scope, pSession.resourceId),
          ).toEqual(DENY_NOT_FOUND);
        },
      );

      itDb(
        "the share never flows through the grant path: the audience's grant read stays denied",
        async () => {
          // 分享事实只存在于分享表；grants 表保持只有属主一行——后续分享令牌
          // 票（MT058/MT092）消费的是分享判定入口，而不是 grants 路径。
          const audience = fixture.base.teamOf("a2-member", "team-a2");
          const response = await fixture.base.isolation.requestAs("a2-member", {
            method: "GET",
            path: `/resources/${pSession.resourceId}`,
            tenantId: pSession.tenantId,
            workspaceId: audience.workspaceId,
          });
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual({
            error: "RESOURCE_NOT_FOUND",
          });
          const snapshot = await fixture.ownershipSnapshot({
            tenantId: pSession.tenantId,
            resourceId: pSession.resourceId,
          });
          expect(snapshot.grantPrincipals).toEqual([pSession.ownerPrincipalId]);
          expect(snapshot.grantPrincipals).not.toContain(audience.principalId);
        },
      );

      itDb(
        "an expired share stops authorizing immediately; the database clock decides",
        async () => {
          const owner = fixture.base.teamOf("a1-member", "team-a1");
          const audience = fixture.base.teamOf("a2-member", "team-a2");
          await fixture.shares.share({
            tenantId: pFile.tenantId,
            resourceId: pFile.resourceId,
            actorPrincipalId: owner.principalId,
            audiencePrincipalId: audience.principalId,
            action: "read",
            expiresAt: new Date(Date.now() + 600),
          });
          const audienceScope = await fixture.base.scopeFor("a2-member", {
            tenantId: pFile.tenantId,
            workspaceId: audience.workspaceId,
          });
          expect(
            await fixture.decisions.decide(audienceScope, pFile.resourceId),
          ).toEqual({ outcome: "allow" });
          await Bun.sleep(900);
          expect(
            await fixture.decisions.decide(audienceScope, pFile.resourceId),
          ).toEqual(DENY_NOT_FOUND);
          // 行仍在（过期是判定时事实，不是行删除）；判定拒绝即失效。
          const row = await fixture.shareRow({
            tenantId: pFile.tenantId,
            resourceId: pFile.resourceId,
            audiencePrincipalId: audience.principalId,
          });
          expect(row).not.toBeNull();
        },
      );

      itDb(
        "a share whose validity is already past is refused at creation",
        async () => {
          const owner = fixture.base.teamOf("a1-member", "team-a1");
          const audience = fixture.base.teamOf("a2-member", "team-a2");
          expect(
            await thrownMessage(
              fixture.shares.share({
                tenantId: pFile.tenantId,
                resourceId: pFile.resourceId,
                actorPrincipalId: owner.principalId,
                audiencePrincipalId: audience.principalId,
                action: "read",
                expiresAt: new Date(Date.now() - 1000),
              }),
            ),
          ).toBe("SHARE_EXPIRY_INVALID");
        },
      );

      itDb(
        "revocation is immediate: one delete and the audience loses access at once",
        async () => {
          const owner = fixture.base.teamOf("a1-member", "team-a1");
          const audience = fixture.base.teamOf("a2-member", "team-a2");
          await fixture.shares.share({
            tenantId: pConn.tenantId,
            resourceId: pConn.resourceId,
            actorPrincipalId: owner.principalId,
            audiencePrincipalId: audience.principalId,
            action: "read",
            expiresAt: secondsFromNow(30),
          });
          const audienceScope = await fixture.base.scopeFor("a2-member", {
            tenantId: pConn.tenantId,
            workspaceId: audience.workspaceId,
          });
          expect(
            await fixture.decisions.decide(audienceScope, pConn.resourceId),
          ).toEqual({ outcome: "allow" });
          const receipt = await fixture.shares.revoke({
            tenantId: pConn.tenantId,
            resourceId: pConn.resourceId,
            actorPrincipalId: owner.principalId,
            audiencePrincipalId: audience.principalId,
            action: "read",
          });
          expect(receipt.revoked).toBe(true);
          expect(
            await fixture.decisions.decide(audienceScope, pConn.resourceId),
          ).toEqual(DENY_NOT_FOUND);
          expect(
            await fixture.shareRow({
              tenantId: pConn.tenantId,
              resourceId: pConn.resourceId,
              audiencePrincipalId: audience.principalId,
            }),
          ).toBeNull();
        },
      );

      itDb(
        "an active share cannot be duplicated; after revocation a fresh window may open",
        async () => {
          const audience = fixture.base.teamOf("a2-member", "team-a2");
          await fixture.shares.share({
            tenantId: pConnOfOther.tenantId,
            resourceId: pConnOfOther.resourceId,
            actorPrincipalId: pConnOfOther.ownerPrincipalId,
            audiencePrincipalId: audience.principalId,
            action: "read",
            expiresAt: secondsFromNow(30),
          });
          expect(
            await thrownMessage(
              fixture.shares.share({
                tenantId: pConnOfOther.tenantId,
                resourceId: pConnOfOther.resourceId,
                actorPrincipalId: pConnOfOther.ownerPrincipalId,
                audiencePrincipalId: audience.principalId,
                action: "read",
                expiresAt: secondsFromNow(60),
              }),
            ),
          ).toBe("SHARE_ALREADY_ACTIVE");
          const revoked = await fixture.shares.revoke({
            tenantId: pConnOfOther.tenantId,
            resourceId: pConnOfOther.resourceId,
            actorPrincipalId: pConnOfOther.ownerPrincipalId,
            audiencePrincipalId: audience.principalId,
            action: "read",
          });
          expect(revoked.revoked).toBe(true);
          const reopened = await fixture.shares.share({
            tenantId: pConnOfOther.tenantId,
            resourceId: pConnOfOther.resourceId,
            actorPrincipalId: pConnOfOther.ownerPrincipalId,
            audiencePrincipalId: audience.principalId,
            action: "read",
            expiresAt: secondsFromNow(60),
          });
          expect(reopened.action).toBe("read");
          const audienceScope = await fixture.base.scopeFor("a2-member", {
            tenantId: pConnOfOther.tenantId,
            workspaceId: audience.workspaceId,
          });
          expect(
            await fixture.decisions.decide(
              audienceScope,
              pConnOfOther.resourceId,
            ),
          ).toEqual({ outcome: "allow" });
        },
      );

      itDb("a suspended audience loses the share immediately", async () => {
        const owner = fixture.base.teamOf("a1-member", "team-a1");
        const audience = fixture.base.teamOf("a1a2-member", "team-a2");
        await fixture.shares.share({
          tenantId: pSession.tenantId,
          resourceId: pSession.resourceId,
          actorPrincipalId: owner.principalId,
          audiencePrincipalId: audience.principalId,
          action: "read",
          expiresAt: secondsFromNow(30),
        });
        const audienceScope = await fixture.base.scopeFor("a1a2-member", {
          tenantId: pSession.tenantId,
          workspaceId: audience.workspaceId,
        });
        expect(
          await fixture.decisions.decide(audienceScope, pSession.resourceId),
        ).toEqual({ outcome: "allow" });
        await fixture.base.isolation.suspendCompanyMembership(
          "a1a2-member",
          pSession.tenantId,
        );
        // 撤销后用「撤销前签发的受信 Scope」再判：成员资格事实已翻转，判定
        // 按当前事实拒绝（scope 不是通行证，事实才是）。
        expect(
          await fixture.decisions.decide(audienceScope, pSession.resourceId),
        ).toEqual(DENY_NOT_FOUND);
        // 恢复成员资格（离线安排替身，见 support 披露）后：旧 scope 仍被拒绝
        // ——epoch 已前进，旧 scope 是过期快照；新签发的 scope 立即恢复访问。
        await fixture.setCompanyMembershipStatus(
          "a1a2-member",
          pSession.tenantId,
          "active",
        );
        expect(
          await fixture.decisions.decide(audienceScope, pSession.resourceId),
        ).toEqual(DENY_NOT_FOUND);
        const freshScope = await fixture.base.scopeFor("a1a2-member", {
          tenantId: pSession.tenantId,
          workspaceId: audience.workspaceId,
        });
        expect(
          await fixture.decisions.decide(freshScope, pSession.resourceId),
        ).toEqual({ outcome: "allow" });
      });

      itDb(
        "the share action domain is exactly read, in the service and in the database",
        async () => {
          const owner = fixture.base.teamOf("a1-member", "team-a1");
          const audience = fixture.base.teamOf("a2-member", "team-a2");
          expect(
            await thrownMessage(
              fixture.shares.share({
                tenantId: pSession.tenantId,
                resourceId: pSession.resourceId,
                actorPrincipalId: owner.principalId,
                audiencePrincipalId: audience.principalId,
                action: "update",
                expiresAt: secondsFromNow(30),
              }),
            ),
          ).toBe("SHARE_ACTION_UNSUPPORTED");
          // 结构兜底：CHECK 约束在数据库层拒绝一切非 read 动作。
          const violation = await rejectionOf(() =>
            fixture.base.isolation.queryRestricted(
              "operator",
              { tenantId: pSession.tenantId },
              "insert into enterprise_resource_shares (tenant_id, resource_id, principal_id, action, expires_at, granted_by) values ($1, $2, $3, 'update', $4, $5)",
              [
                pSession.tenantId,
                pSession.resourceId,
                audience.principalId,
                secondsFromNow(30).toISOString(),
                owner.principalId,
              ],
            ),
          );
          expect(violation.code).toBe("23514");
          expect(violation.message).toContain("enterprise_share_action");
        },
      );

      itDb("sharing to yourself is refused", async () => {
        const owner = fixture.base.teamOf("a1-member", "team-a1");
        expect(
          await thrownMessage(
            fixture.shares.share({
              tenantId: pSession.tenantId,
              resourceId: pSession.resourceId,
              actorPrincipalId: owner.principalId,
              audiencePrincipalId: owner.principalId,
              action: "read",
              expiresAt: secondsFromNow(30),
            }),
          ),
        ).toBe("SHARE_AUDIENCE_SELF");
      });
    });

    // ---------------------------------------------------------------------
    // 验收 3：跨公司 Grant 与跨公司分享永远拒绝（即使资源 ID 正确）
    // ---------------------------------------------------------------------

    describe("issue #53 acceptance 3: cross-company grants and shares always refuse", () => {
      itDb("a share to a principal of another company is refused", async () => {
        const owner = fixture.base.teamOf("a1-member", "team-a1");
        const foreignAudience = fixture.base.teamOf("b1-member", "team-b1");
        expect(
          await thrownMessage(
            fixture.shares.share({
              tenantId: pSession.tenantId,
              resourceId: pSession.resourceId,
              actorPrincipalId: owner.principalId,
              audiencePrincipalId: foreignAudience.principalId,
              action: "read",
              expiresAt: secondsFromNow(30),
            }),
          ),
        ).toBe("AUDIENCE_NOT_COMPANY_MEMBER");
      });

      itDb(
        "a cross-company share row is structurally impossible (audience side)",
        async () => {
          const owner = fixture.base.teamOf("a1-member", "team-a1");
          const foreignAudience = fixture.base.teamOf("b1-member", "team-b1");
          const violation = await rejectionOf(() =>
            fixture.base.isolation.queryRestricted(
              "operator",
              { tenantId: pSession.tenantId },
              "insert into enterprise_resource_shares (tenant_id, resource_id, principal_id, action, expires_at, granted_by) values ($1, $2, $3, 'read', $4, $5)",
              [
                pSession.tenantId,
                pSession.resourceId,
                foreignAudience.principalId,
                secondsFromNow(30).toISOString(),
                owner.principalId,
              ],
            ),
          );
          expect(violation.code).toBe("23503");
        },
      );

      itDb(
        "a cross-company share row is structurally impossible (sharer side)",
        async () => {
          // 受众选一个在本资源上从无分享行的同公司成员，让 granted_by 的
          // 复合外键成为唯一会被触发的约束（先前的用例证明约束链真实存在）。
          const audience = fixture.base.teamOf("a1-other", "team-a1");
          const foreignSharer = fixture.base.teamOf("b1-member", "team-b1");
          const violation = await rejectionOf(() =>
            fixture.base.isolation.queryRestricted(
              "operator",
              { tenantId: pSession.tenantId },
              "insert into enterprise_resource_shares (tenant_id, resource_id, principal_id, action, expires_at, granted_by) values ($1, $2, $3, 'read', $4, $5)",
              [
                pSession.tenantId,
                pSession.resourceId,
                audience.principalId,
                secondsFromNow(30).toISOString(),
                foreignSharer.principalId,
              ],
            ),
          );
          expect(violation.code).toBe("23503");
        },
      );

      itDb("a cross-company grant row is structurally impossible", async () => {
        const foreignPrincipal = fixture.base.teamOf("b1-member", "team-b1");
        const violation = await rejectionOf(() =>
          fixture.base.isolation.queryRestricted(
            "operator",
            { tenantId: pSession.tenantId },
            "insert into enterprise_resource_grants (tenant_id, resource_id, principal_id, action) values ($1, $2, $3, 'read')",
            [
              pSession.tenantId,
              pSession.resourceId,
              foreignPrincipal.principalId,
            ],
          ),
        );
        expect(violation.code).toBe("23503");
      });

      itDb(
        "a cross-company reader is denied with the exact shape of a missing resource",
        async () => {
          const foreignScope = await fixture.base.scopeFor("b1-member", {
            tenantId: pSessionB.tenantId,
            workspaceId: pSessionB.workspaceId,
          });
          const crossCompany = await fixture.decisions.decide(
            foreignScope,
            pSession.resourceId,
          );
          const missing = await fixture.decisions.decide(
            foreignScope,
            `${fixture.base.isolation.idPrefix}-does-not-exist`,
          );
          expect(crossCompany).toEqual(DENY_NOT_FOUND);
          // 不泄露存在性：跨公司拒绝与不存在拒绝在对外语义上不可区分。
          expect(JSON.stringify(crossCompany)).toBe(JSON.stringify(missing));
        },
      );

      itDb(
        "a shared dual-company principal keeps the share only inside the granting company's scope",
        async () => {
          const owner = fixture.base.teamOf("a1-member", "team-a1");
          const multiInA = fixture.base.teamOf("multi-company", "team-a1");
          await fixture.shares.share({
            tenantId: pFile.tenantId,
            resourceId: pFile.resourceId,
            actorPrincipalId: owner.principalId,
            audiencePrincipalId: multiInA.principalId,
            action: "read",
            expiresAt: secondsFromNow(30),
          });
          const scopeInA = await fixture.base.scopeFor("multi-company", {
            tenantId: pFile.tenantId,
            workspaceId: multiInA.workspaceId,
          });
          expect(
            await fixture.decisions.decide(scopeInA, pFile.resourceId),
          ).toEqual({ outcome: "allow" });
          const scopeInB = await fixture.base.scopeFor("multi-company", {
            tenantId: pSessionB.tenantId,
            workspaceId: pSessionB.workspaceId,
          });
          expect(
            await fixture.decisions.decide(scopeInB, pFile.resourceId),
          ).toEqual(DENY_NOT_FOUND);
        },
      );
    });

    // ---------------------------------------------------------------------
    // 验收 4：分享不改变归属；被分享方拿不到管理动作
    // ---------------------------------------------------------------------

    describe("issue #53 acceptance 4: sharing never moves ownership and sharees never gain management actions", () => {
      itDb("sharing leaves every ownership fact byte-identical", async () => {
        const owner = fixture.base.teamOf("a1-member", "team-a1");
        const audience = fixture.base.teamOf("a2-member", "team-a2");
        const before = await fixture.ownershipSnapshot({
          tenantId: pConn.tenantId,
          resourceId: pConn.resourceId,
        });
        await fixture.shares.share({
          tenantId: pConn.tenantId,
          resourceId: pConn.resourceId,
          actorPrincipalId: owner.principalId,
          audiencePrincipalId: audience.principalId,
          action: "read",
          expiresAt: secondsFromNow(30),
        });
        const after = await fixture.ownershipSnapshot({
          tenantId: pConn.tenantId,
          resourceId: pConn.resourceId,
        });
        expect(after).toEqual(before);
        expect(after.visibility).toBe("private");
        expect(after.grantPrincipals).toEqual([owner.principalId]);
      });

      itDb("the sharee cannot re-share the resource to anyone", async () => {
        const audience = fixture.base.teamOf("a2-member", "team-a2");
        const thirdParty = fixture.base.teamOf("a1a2-member", "team-a1");
        expect(
          await thrownMessage(
            fixture.shares.share({
              tenantId: pSession.tenantId,
              resourceId: pSession.resourceId,
              actorPrincipalId: audience.principalId,
              audiencePrincipalId: thirdParty.principalId,
              action: "read",
              expiresAt: secondsFromNow(30),
            }),
          ),
        ).toBe("NOT_RESOURCE_OWNER");
      });

      itDb("the sharee cannot revoke either", async () => {
        const audience = fixture.base.teamOf("a2-member", "team-a2");
        const owner = fixture.base.teamOf("a1-member", "team-a1");
        expect(
          await thrownMessage(
            fixture.shares.revoke({
              tenantId: pSession.tenantId,
              resourceId: pSession.resourceId,
              actorPrincipalId: audience.principalId,
              audiencePrincipalId: owner.principalId,
              action: "read",
            }),
          ),
        ).toBe("NOT_RESOURCE_OWNER");
      });

      itDb(
        "nobody but the owner can create a share, and the refusal does not leak existence",
        async () => {
          const sameTeamColleague = fixture.base.teamOf("a1-other", "team-a1");
          const companyAdmin = fixture.base.isolation.identities[
            "company-admin"
          ].companies.find((company) => company.tenantId === pSession.tenantId);
          if (!companyAdmin) throw new Error("COMPANY_ADMIN_FACT_MISSING");
          const audience = fixture.base.teamOf("a2-member", "team-a2");
          for (const actorPrincipalId of [
            sameTeamColleague.principalId,
            companyAdmin.principalId,
          ]) {
            expect(
              await thrownMessage(
                fixture.shares.share({
                  tenantId: pSession.tenantId,
                  resourceId: pSession.resourceId,
                  actorPrincipalId,
                  audiencePrincipalId: audience.principalId,
                  action: "read",
                  expiresAt: secondsFromNow(30),
                }),
              ),
            ).toBe("NOT_RESOURCE_OWNER");
          }
          // 不存在的资源与不属于你的资源对外同一个拒绝码：不泄露存在性。
          expect(
            await thrownMessage(
              fixture.shares.share({
                tenantId: pSession.tenantId,
                resourceId: `${fixture.base.isolation.idPrefix}-does-not-exist`,
                actorPrincipalId: sameTeamColleague.principalId,
                audiencePrincipalId: audience.principalId,
                action: "read",
                expiresAt: secondsFromNow(30),
              }),
            ),
          ).toBe("NOT_RESOURCE_OWNER");
        },
      );

      itDb(
        "a share is only possible on an explicitly personal resource",
        async () => {
          // 团队公共资源（visibility='workspace'）不走个人分享：显式原则。
          const owner = fixture.base.teamOf("a1-member", "team-a1");
          const audience = fixture.base.teamOf("a2-member", "team-a2");
          const shared = await fixture.provisionPersonalResource({
            kind: "file",
            owner: "a1-member",
            team: "team-a1",
          });
          await fixture.base.markVisibility({
            tenantId: shared.tenantId,
            resourceId: shared.resourceId,
            visibility: "workspace",
          });
          expect(
            await thrownMessage(
              fixture.shares.share({
                tenantId: shared.tenantId,
                resourceId: shared.resourceId,
                actorPrincipalId: owner.principalId,
                audiencePrincipalId: audience.principalId,
                action: "read",
                expiresAt: secondsFromNow(30),
              }),
            ),
          ).toBe("SHARE_TARGET_NOT_PERSONAL");
        },
      );
    });

    // ---------------------------------------------------------------------
    // 迁移注册与 expand-only（票面约束：MT004/MT008/MT012 惯例）
    // ---------------------------------------------------------------------

    describe("the MT010 task migration is registered, deterministic, and expand-only", () => {
      itDb("MT010 is a registered task whose plan is deterministic", () => {
        const plan = buildPlan("MT010");
        expect(plan.taskId).toBe("MT010");
        expect(plan.steps.map((step) => step.name)).toEqual([
          "0001_mt010_create_table.sql",
          "0002_mt010_share_rls_policies.sql",
        ]);
        expect(manifestFor(plan)).toEqual(manifestFor(buildPlan("MT010")));
      });

      itDb(
        "the dry-run previews the plan and the apply converges to up-to-date",
        () => {
          expect(dryRunOutcome.kind).toBe("dry-run");
          expect(
            applyOutcome.kind === "applied" ||
              applyOutcome.kind === "up-to-date",
          ).toBe(true);
        },
      );

      itDb(
        "the migration is expand-only: exactly one new table, no existing object touched",
        () => {
          const statements = buildPlan("MT010").steps.flatMap(
            (step) => step.statements,
          );
          const createTables = statements.filter((statement) =>
            statement.startsWith("CREATE TABLE"),
          );
          expect(createTables.length).toBe(1);
          expect(createTables[0]).toContain('"enterprise_resource_shares"');
          for (const statement of statements) {
            expect(statement.startsWith("DROP")).toBe(false);
            if (statement.startsWith("ALTER TABLE")) {
              // ALTER 只允许出现在新表自己的外键追加语句里。
              expect(
                statement.includes('ALTER TABLE "enterprise_resource_shares"'),
                statement,
              ).toBe(true);
            }
            if (
              statement.startsWith("CREATE POLICY") ||
              statement.startsWith("GRANT") ||
              statement.startsWith("REVOKE")
            ) {
              expect(statement.includes("enterprise_resource_shares")).toBe(
                true,
              );
            }
            expect(
              /alter table "(?!enterprise_resource_shares)/i.test(statement),
            ).toBe(false);
          }
          const rlsStatements = buildPlan("MT010").steps[1].statements;
          expect(
            rlsStatements.some((statement) =>
              statement.includes("FORCE ROW LEVEL SECURITY"),
            ),
          ).toBe(true);
        },
      );

      itDb(
        "the applied table carries FORCE RLS and the minimal grant matrix",
        async () => {
          const flags = await fixture.shareTableRlsFlags();
          expect(flags.rowSecurity).toBe(true);
          expect(flags.forceRowSecurity).toBe(true);
          const grants = await fixture.shareTableGrants();
          expect(grants.get("ob_ent_directory") ?? []).toEqual([]);
          expect(grants.get("ob_ent_data") ?? []).toEqual(["SELECT"]);
          expect(grants.get("ob_ent_operator") ?? []).toEqual([
            "DELETE",
            "INSERT",
            "SELECT",
          ]);
          // 无 UPDATE：撤销 = DELETE，分享行永不部分改写。
          expect(grants.get("ob_ent_operator") ?? []).not.toContain("UPDATE");
        },
      );
    });

    // ---------------------------------------------------------------------
    // 收尾检查：受限角色全程在位
    // ---------------------------------------------------------------------

    describe("closing check: restricted roles were in play", () => {
      itDb(
        "every channel used by share decisions and writes is a capability role, never a superuser",
        async () => {
          expect(await fixture.currentUserOf("data")).toBe("ob_ent_data");
          expect(await fixture.currentUserOf("operator")).toBe(
            "ob_ent_operator",
          );
        },
      );

      itDb(
        "the data channel can read its own share rows but never another principal's",
        async () => {
          const audience = fixture.base.teamOf("a2-member", "team-a2");
          const where = fixture.base.teamOf("a1-other", "team-a1");
          // a2 持有 pSession 的有效分享（验收 2 首例建立）；a1-other 一行都看不到。
          const ownRows = await fixture.base.isolation.queryRestricted(
            "data",
            {
              tenantId: pSession.tenantId,
              principalId: audience.principalId,
              workspaceId: audience.workspaceId,
            },
            "select principal_id from enterprise_resource_shares where tenant_id = $1 and resource_id = $2",
            [pSession.tenantId, pSession.resourceId],
          );
          expect(ownRows.length).toBe(1);
          expect(String(ownRows[0].principal_id)).toBe(audience.principalId);
          const foreignRows = await fixture.base.isolation.queryRestricted(
            "data",
            {
              tenantId: pSession.tenantId,
              principalId: where.principalId,
              workspaceId: where.workspaceId,
            },
            "select principal_id from enterprise_resource_shares where tenant_id = $1 and resource_id = $2",
            [pSession.tenantId, pSession.resourceId],
          );
          expect(foreignRows).toEqual([]);
        },
      );

      itDb(
        "the schema-level membership facts the share FKs prove are real rows",
        async () => {
          const owner = fixture.base.teamOf("a1-member", "team-a1");
          const rows = await fixture.base.isolation.queryRestricted(
            "data",
            {
              tenantId: owner.tenantId,
              principalId: owner.principalId,
              workspaceId: owner.workspaceId,
            },
            "select count(*)::int as memberships from enterprise_memberships where tenant_id = $1 and principal_id = $2 and status = 'active'",
            [owner.tenantId, owner.principalId],
          );
          expect(Number(rows[0].memberships)).toBe(1);
        },
      );
    });
  },
);
