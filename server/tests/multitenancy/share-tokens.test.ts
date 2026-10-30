// server/tests/multitenancy/share-tokens.test.ts
// MT058（Issue #101）：分享令牌改为有效分享授权（受众、有效期、撤销）。
//
// 验收事实源（Issue #101 四条，逐条对应 describe；真实 PostgreSQL，全程
// 受限 ob_ent_* 角色 + 真实 RLS，绝不回退开发库、缺 env 显式 skip）：
//   验收 1：默认分享受众为同团队；非同团队成员访问被拒绝。
//   验收 2：显式跨团队分享只在同公司内、指定动作与有效期内有效。
//   验收 3：跨公司分享永远不可签发；已有此类令牌失效并记录。
//   验收 4：撤销后签发与访问同时停止；分享页不泄露内容元数据。
//
// 证据可复现（票面 AC）——本套件即复现命令：
//   set +x; source /tmp/mt28-env.sh && bun --no-env-file test \
//     server/tests/multitenancy/share-tokens.test.ts
//
// 边界：前端分享页（身份/受众/撤销状态展示）属 MT092（#135）；本套件只
// 钉服务面契约。

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
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
  createWorkshopTenancyFixture,
  type WorkshopTenancyFixture,
} from "./support/workshop-tenancy";

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
      reason: `MT058 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

// ---------------------------------------------------------------------------
// 断言形状助手
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

let fixture: WorkshopTenancyFixture;

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createWorkshopTenancyFixture();
});

afterAll(async () => {
  if (fixture) await fixture.dispose();
});

/** 属主（a1-member@team-a1）的一个已 pin 会话 + 属主 scope。 */
async function sharedSessionOfOwner() {
  const arrangement = await fixture.ensurePinnedSession({
    owner: "a1-member",
    team: "team-a1",
  });
  const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
  return { arrangement, ownerScope };
}

// ---------------------------------------------------------------------------
// 验收 1：默认受众为同团队；非同团队成员被拒绝
// ---------------------------------------------------------------------------

describeDb("MT058 AC1 the default audience is the owner's team", () => {
  itDb(
    "a same-team member resolves a same-team share; a cross-team member does not",
    async () => {
      const { arrangement, ownerScope } = await sharedSessionOfOwner();
      const issued = await fixture.shareTokens.issueWorkshopShare(ownerScope, {
        channelId: arrangement.channelId,
        audience: "same-team",
        shareAction: "preview",
        expiresInDays: 1,
      });
      expect(issued.outcome).toBe("allow");
      if (issued.outcome !== "allow") return;
      expect(issued.audience).toBe("same-team");

      const teammate = await fixture.scopeAs("a1-other", "team-a1");
      const teammateView = await fixture.shareTokens.resolveShareAccess(
        teammate,
        { token: issued.token },
      );
      expect(teammateView.outcome).toBe("allow");
      if (teammateView.outcome === "allow") {
        expect(teammateView.channelId).toBe(arrangement.channelId);
        expect(teammateView.via).toBe("same-team");
      }

      const crossTeam = await fixture.scopeAs("a2-member", "team-a2");
      const crossTeamView = await fixture.shareTokens.resolveShareAccess(
        crossTeam,
        { token: issued.token },
      );
      expect(isCanonicalNotFound(crossTeamView)).toBe(true);
    },
  );

  itDb(
    "a cross-company caller is refused with the same invisible shape",
    async () => {
      const { arrangement, ownerScope } = await sharedSessionOfOwner();
      const issued = await fixture.shareTokens.issueWorkshopShare(ownerScope, {
        channelId: arrangement.channelId,
        audience: "same-team",
        shareAction: "preview",
        expiresInDays: 1,
      });
      if (issued.outcome !== "allow") throw new Error("ISSUE_FAILED");
      const foreigner = await fixture.scopeAs("b1-member", "team-b1");
      const view = await fixture.shareTokens.resolveShareAccess(foreigner, {
        token: issued.token,
      });
      expect(isCanonicalNotFound(view)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 2：显式跨团队分享只在同公司、指定动作与有效期内有效
// ---------------------------------------------------------------------------

describeDb("MT058 AC2 explicit cross-team shares carry their contract", () => {
  itDb(
    "an audience-workspace member resolves a cross-team share; nobody else does",
    async () => {
      const { arrangement, ownerScope } = await sharedSessionOfOwner();
      const audienceTeam = await fixture.base.base.teamOf(
        "a2-member",
        "team-a2",
      );
      const issued = await fixture.shareTokens.issueWorkshopShare(ownerScope, {
        channelId: arrangement.channelId,
        audience: "cross-team",
        audienceWorkspaceId: audienceTeam.workspaceId,
        shareAction: "preview_download",
        expiresInDays: 7,
      });
      expect(issued.outcome).toBe("allow");
      if (issued.outcome !== "allow") return;
      expect(issued.audience).toBe("cross-team");
      expect(issued.shareAction).toBe("preview_download");

      // 受众团队成员：放行，via = cross-team，动作域随行。
      const audienceMember = await fixture.scopeAs("a2-member", "team-a2");
      const view = await fixture.shareTokens.resolveShareAccess(
        audienceMember,
        {
          token: issued.token,
        },
      );
      expect(view.outcome).toBe("allow");
      if (view.outcome === "allow") {
        expect(view.via).toBe("cross-team");
        expect(view.shareAction).toBe("preview_download");
      }

      // 同公司第三方（属主本人，不在受众团队内）：分享入口按受众判
      // 定，属主自己的会话访问走会话门而非令牌。
      const outsider = await fixture.scopeAs("a1-member", "team-a1");
      const outsiderView = await fixture.shareTokens.resolveShareAccess(
        outsider,
        { token: issued.token },
      );
      expect(isCanonicalNotFound(outsiderView)).toBe(true);
      // 跨公司：不可见，同形。
      const foreigner = await fixture.scopeAs("b1-member", "team-b1");
      const foreignView = await fixture.shareTokens.resolveShareAccess(
        foreigner,
        { token: issued.token },
      );
      expect(isCanonicalNotFound(foreignView)).toBe(true);
    },
  );

  itDb(
    "cross-team to one's own workspace and same-team with a workspace are loud input errors",
    async () => {
      const { arrangement, ownerScope } = await sharedSessionOfOwner();
      await expect(
        thrownMessage(() =>
          fixture.shareTokens.issueWorkshopShare(ownerScope, {
            channelId: arrangement.channelId,
            audience: "cross-team",
            audienceWorkspaceId: ownerScope.workspaceId,
            shareAction: "preview",
            expiresInDays: 1,
          }),
        ),
      ).resolves.toContain("WORKSHOP_SHARE_AUDIENCE_INVALID");
      await expect(
        thrownMessage(() =>
          fixture.shareTokens.issueWorkshopShare(ownerScope, {
            channelId: arrangement.channelId,
            audience: "same-team",
            audienceWorkspaceId: "ws-anywhere",
            shareAction: "preview",
            expiresInDays: 1,
          }),
        ),
      ).resolves.toContain("WORKSHOP_SHARE_AUDIENCE_INVALID");
    },
  );

  itDb(
    "an expired grant stops resolving (validity window enforced at read time)",
    async () => {
      const { arrangement, ownerScope } = await sharedSessionOfOwner();
      const issued = await fixture.shareTokens.issueWorkshopShare(ownerScope, {
        channelId: arrangement.channelId,
        audience: "same-team",
        shareAction: "preview",
        expiresInDays: 1,
      });
      if (issued.outcome !== "allow") throw new Error("ISSUE_FAILED");
      // 时间旅行探针（披露）：把本授权行的 expires_at 挪到过去——有效期
      // 按 DB 时钟在读取现场核对，应用时钟不参与判定。
      const tokenHash = createHash("sha256").update(issued.token).digest("hex");
      await fixture.platform.execute(
        sql`update enterprise_workshop_share_grants set expires_at = now() - interval '1 hour' where token_hash = ${tokenHash}`,
      );
      const teammate = await fixture.scopeAs("a1-other", "team-a1");
      const view = await fixture.shareTokens.resolveShareAccess(teammate, {
        token: issued.token,
      });
      expect(isCanonicalNotFound(view)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 3：跨公司分享永远不可签发；既有令牌失效并记录
// ---------------------------------------------------------------------------

describeDb(
  "MT058 AC3 cross-company shares are unissuable, legacy recorded",
  () => {
    itDb(
      "issuing to a foreign-company workspace is loudly refused (service layer)",
      async () => {
        const { arrangement, ownerScope } = await sharedSessionOfOwner();
        const foreignTeam = await fixture.base.base.teamOf(
          "b1-member",
          "team-b1",
        );
        await expect(
          thrownMessage(() =>
            fixture.shareTokens.issueWorkshopShare(ownerScope, {
              channelId: arrangement.channelId,
              audience: "cross-team",
              audienceWorkspaceId: foreignTeam.workspaceId,
              shareAction: "preview",
              expiresInDays: 1,
            }),
          ),
        ).resolves.toBe("WORKSHOP_SHARE_AUDIENCE_CROSS_COMPANY");
      },
    );

    itDb(
      "an omitted expiresInDays is rejected (no indefinite shares, AC2)",
      async () => {
        const { arrangement, ownerScope } = await sharedSessionOfOwner();
        await expect(
          thrownMessage(() =>
            fixture.shareTokens.issueWorkshopShare(ownerScope, {
              channelId: arrangement.channelId,
              audience: "same-team",
              shareAction: "preview",
            }),
          ),
        ).resolves.toBe("WORKSHOP_SHARE_INPUT_INVALID: expiresInDays");
      },
    );

    itDb(
      "the database layer structurally rejects cross-company audience rows (double fence)",
      async () => {
        const { arrangement, ownerScope } = await sharedSessionOfOwner();
        const foreignTeam = await fixture.base.base.teamOf(
          "b1-member",
          "team-b1",
        );
        // 结构面探针（披露）：跨公司受众行的复合外键在数据库层不存在——
        // 直接插行被 FK 拒绝（23503），「永远不可签发」的第二见证面。
        const grantId = `wsg-probe-${Date.now()}`;
        const session = await fixture.workshop.sessionByChannel(
          arrangement.channelId,
        );
        if (!session) throw new Error("SESSION_MISSING");
        let probeError = "none";
        try {
          await fixture.platform.execute(
            sql.raw(
              `insert into enterprise_workshop_share_grants (id, session_id, token_hash, tenant_id, owner_workspace_id, principal_id, audience, audience_workspace_id, share_action, created_by)
             values ('${grantId}', '${session.id}', 'probe-hash-${grantId}', '${ownerScope.tenantId}', '${ownerScope.workspaceId}', '${ownerScope.principalId}', 'cross-team', '${foreignTeam.workspaceId}', 'preview', '${ownerScope.actorId}')`,
            ),
          );
        } catch (error) {
          probeError = error instanceof Error ? error.message : String(error);
        }
        expect(probeError).not.toBe("none");
      },
    );

    itDb(
      "legacy anonymous bearer tokens are recorded as invalidated (sweep)",
      async () => {
        const { arrangement } = await sharedSessionOfOwner();
        const legacyToken = await fixture.seedLegacyAnonymousShare({
          channelId: arrangement.channelId,
          createdBy: "a1-member",
        });
        // 企业面永不解析旧承载段（MT057 AC3 已钉同形断言；此处 sweep 面）。
        const swept = await fixture.shareTokens.sweepLegacyAnonymousShares();
        expect(swept.outcome).toBe("allow");
        if (swept.outcome !== "allow") return;
        expect(swept.invalidated).toContain(arrangement.sessionId);
        const recorded = fixture.invalidationEvents.find(
          (event) => event.sessionId === arrangement.sessionId,
        );
        expect(recorded?.eventType).toBe("workshop_share_legacy_invalidated");
        expect(recorded?.channelId).toBe(arrangement.channelId);
        // 记录不携带任何内容元数据（note 是固定文案）。
        expect(recorded?.note).not.toContain(legacyToken);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 验收 4：撤销后签发与访问同时停止；不泄露元数据
// ---------------------------------------------------------------------------

describeDb(
  "MT058 AC4 revocation stops both faces, metadata stays hidden",
  () => {
    itDb(
      "revoked tokens stop resolving immediately, and stay dead after reissue",
      async () => {
        const { arrangement, ownerScope } = await sharedSessionOfOwner();
        const issued = await fixture.shareTokens.issueWorkshopShare(
          ownerScope,
          {
            channelId: arrangement.channelId,
            audience: "same-team",
            shareAction: "preview",
            expiresInDays: 30,
          },
        );
        if (issued.outcome !== "allow") throw new Error("ISSUE_FAILED");
        const teammate = await fixture.scopeAs("a1-other", "team-a1");
        const before = await fixture.shareTokens.resolveShareAccess(teammate, {
          token: issued.token,
        });
        expect(before.outcome).toBe("allow");

        const revoked = await fixture.shareTokens.revokeWorkshopShare(
          ownerScope,
          { channelId: arrangement.channelId },
        );
        expect(revoked.outcome).toBe("allow");

        // 访问立即停止。
        const after = await fixture.shareTokens.resolveShareAccess(teammate, {
          token: issued.token,
        });
        expect(isCanonicalNotFound(after)).toBe(true);

        // 再签发 = 新令牌；旧令牌永不复活。
        const reissued = await fixture.shareTokens.issueWorkshopShare(
          ownerScope,
          {
            channelId: arrangement.channelId,
            audience: "same-team",
            shareAction: "preview",
            expiresInDays: 30,
          },
        );
        if (reissued.outcome !== "allow") throw new Error("REISSUE_FAILED");
        expect(reissued.token).not.toBe(issued.token);
        const oldAfterReissue = await fixture.shareTokens.resolveShareAccess(
          teammate,
          { token: issued.token },
        );
        expect(isCanonicalNotFound(oldAfterReissue)).toBe(true);
        const newAfterReissue = await fixture.shareTokens.resolveShareAccess(
          teammate,
          { token: reissued.token },
        );
        expect(newAfterReissue.outcome).toBe("allow");
      },
    );

    itDb(
      "every deny answers the identical canonical shape (no metadata leak)",
      async () => {
        const { arrangement, ownerScope } = await sharedSessionOfOwner();
        const issued = await fixture.shareTokens.issueWorkshopShare(
          ownerScope,
          {
            channelId: arrangement.channelId,
            audience: "same-team",
            shareAction: "preview",
            expiresInDays: 1,
          },
        );
        if (issued.outcome !== "allow") throw new Error("ISSUE_FAILED");
        const wrongToken = "not-a-real-token";
        const stranger = await fixture.scopeAs("a2-member", "team-a2");
        const wrongTokenView = await fixture.shareTokens.resolveShareAccess(
          stranger,
          { token: wrongToken },
        );
        const noAudienceView = await fixture.shareTokens.resolveShareAccess(
          stranger,
          { token: issued.token },
        );
        expect(JSON.stringify(wrongTokenView)).toBe(canonicalNotFoundJson);
        expect(JSON.stringify(noAudienceView)).toBe(canonicalNotFoundJson);
        // 两种 deny 逐字节同形：不泄露「令牌存在但受众不符」。
        expect(JSON.stringify(wrongTokenView)).toBe(
          JSON.stringify(noAudienceView),
        );
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 撤销：成员停用让活授权立即失效（置尾避免污染后续场景的成员资格）
// ---------------------------------------------------------------------------

describeDb("MT058 membership revocation kills live grants", () => {
  itDb(
    "a suspended audience member cannot resolve even a live grant",
    async () => {
      const { arrangement, ownerScope } = await sharedSessionOfOwner();
      const issued = await fixture.shareTokens.issueWorkshopShare(ownerScope, {
        channelId: arrangement.channelId,
        audience: "same-team",
        shareAction: "preview",
        expiresInDays: 30,
      });
      if (issued.outcome !== "allow") throw new Error("ISSUE_FAILED");
      // 受众成员在签发后被停用：解析点成员资格现读 → 拒绝（与不存在
      // 同形）。
      const teammateScope = await fixture.scopeAs("a1-other", "team-a1");
      await fixture.suspendCompany("a1-other", "company-a");
      const view = await fixture.shareTokens.resolveShareAccess(teammateScope, {
        token: issued.token,
      });
      expect(isCanonicalNotFound(view)).toBe(true);
    },
  );
});
