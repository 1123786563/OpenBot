// server/tests/multitenancy/craft-sessions.test.ts
// MT053（Issue #96）：Craft 会话、turn、消息与快照的作用域。
//
// 验收事实源（Issue #96 四条，逐条对应 describe；真实 PostgreSQL，全程
// 受限 ob_ent_* 角色 + 真实 RLS，绝不回退开发库、缺 env 显式 skip）：
//   验收 1：列表与详情只返回当前范围；跨范围 ID 返回不可见语义
//     （canonical RESOURCE_NOT_FOUND，与「不存在」逐字节同形）。
//   验收 2：快照按归属存储与读取；下载需要授权（objectStore 只在范围门
//     通过后被调用；跨范围下载零读取）。
//   验收 3：团队公共 Craft 内容遵循 MT009 动作矩阵（成员可读不可改：
//     读 = team-public 放行；写 = TEAM_PUBLIC_ACTION_FORBIDDEN；外部人 =
//     不可见）。
//   验收 4：撤权后立即失去访问（epoch 递增后同一 scope 的一切入口折叠
//     为不可见/响亮拒绝）。
//
// 证据可复现（票面 AC）——本套件即复现命令：
//   set +x; source /tmp/mt27-env.sh && bun --no-env-file test \
//     server/tests/multitenancy/craft-sessions.test.ts

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  craftSnapshotObjectKey,
  parseCraftSnapshotObjectKey,
} from "../../src/enterprise/tenancy/craft-sessions";
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
      reason: `MT053 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

let fixture: CraftTenancyFixture;

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createCraftTenancyFixture();
});

afterAll(async () => {
  if (fixture) await fixture.dispose();
});

/** 属主（a1-member）创建一个会话 + 一条消息 + 一个快照并 pin 归属。 */
async function pinnedSessionOfOwner(input?: {
  sharingScope?: "private" | "public_org";
}) {
  const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
  const session = await fixture.craft.createSession({
    userId: ownerScope.actorId,
    name: "mt053 session",
  });
  if (input?.sharingScope) {
    await fixture.craft.updateSession(session.id, {
      sharingScope: input.sharingScope,
    });
  }
  await fixture.craft.createMessage({
    sessionId: session.id,
    type: "user",
    turnIndex: 0,
    messageMetadata: { text: "mt053 secret transcript" },
  });
  const snapshot = await fixture.craft.createSnapshot({
    sessionId: session.id,
    storagePath: `sandbox-snapshots/mt053/${session.id}/snap.tar.gz`,
    sizeBytes: 32,
  });
  await fixture.objectStore.put(
    snapshot.storagePath,
    new TextEncoder().encode("mt053-bytes"),
  );
  const pin = await fixture.sessions.pinCraftSession(ownerScope, {
    sessionId: session.id,
  });
  if (!("status" in pin)) throw new Error(`PIN_FAILED: ${JSON.stringify(pin)}`);
  return { session, snapshot, ownerScope };
}

// ---------------------------------------------------------------------------
// 纯函数：企业面快照键命名（验收 2 的存储半边）
// ---------------------------------------------------------------------------

describeDb(
  "MT053 craft snapshot object keys (pure naming, #90 discipline)",
  () => {
    itDb("derives a four-plain-segment key under the owning scope", () => {
      const key = craftSnapshotObjectKey(
        "acme",
        "acme-finance",
        "cs-abc123",
        "csn-def456",
      );
      expect(key).toBe(
        "craft-snapshots/acme/acme-finance/cs-abc123/csn-def456.tar.gz",
      );
    });

    itDb(
      "rejects non-plain ids loudly (one scope cannot name another's tree)",
      () => {
        expect(() =>
          craftSnapshotObjectKey("ACME", "w", "cs-1", "csn-1"),
        ).toThrow("CRAFT_SESSION_ID_INVALID");
        expect(() =>
          craftSnapshotObjectKey("a", "w", "../escape", "csn-1"),
        ).toThrow("CRAFT_SESSION_ID_INVALID");
      },
    );

    itDb(
      "round-trips through the parser; malformed shapes parse to null",
      () => {
        const parsed = parseCraftSnapshotObjectKey(
          "craft-snapshots/acme/acme-finance/cs-abc123/csn-def456.tar.gz",
        );
        expect(parsed).toEqual({
          tenantId: "acme",
          workspaceId: "acme-finance",
          sessionId: "cs-abc123",
          snapshotId: "csn-def456",
        });
        expect(
          parseCraftSnapshotObjectKey("craft-snapshots/acme/cs-1/x.tar.gz"),
        ).toBeNull();
        expect(
          parseCraftSnapshotObjectKey("other-prefix/a/b/c/d.tar.gz"),
        ).toBeNull();
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 验收 1：列表与详情只返回当前范围
// ---------------------------------------------------------------------------

describeDb("MT053 AC1 list and detail stay inside the caller's scope", () => {
  itDb("the owner sees their pinned session in list and detail", async () => {
    const { session, ownerScope } = await pinnedSessionOfOwner();
    const listed = await fixture.sessions.listSessions(ownerScope, {
      limit: 50,
    });
    expect(listed.sessions.map((row) => row.sessionId)).toContain(session.id);

    const detail = await fixture.sessions.readSession(ownerScope, session.id);
    expect(detail).toMatchObject({
      outcome: "allow",
      via: "owner",
    });
    if (detail.outcome === "allow") {
      expect(detail.session.id).toBe(session.id);
      expect(detail.messages).toHaveLength(1);
      expect(detail.messages[0]?.messageMetadata).toMatchObject({
        text: "mt053 secret transcript",
      });
    }
  });

  itDb(
    "a same-team member does not see a private session in list or detail",
    async () => {
      const { session } = await pinnedSessionOfOwner();
      const teammateScope = await fixture.scopeAs("a1-other", "team-a1");
      const listed = await fixture.sessions.listSessions(teammateScope, {
        limit: 50,
      });
      expect(listed.sessions.map((row) => row.sessionId)).not.toContain(
        session.id,
      );
      const detail = await fixture.sessions.readSession(
        teammateScope,
        session.id,
      );
      expect(isCanonicalNotFound(detail)).toBe(true);
    },
  );

  itDb(
    "cross-team and cross-company ids collapse to the canonical not-found",
    async () => {
      const { session } = await pinnedSessionOfOwner();
      const crossTeamScope = await fixture.scopeAs("a2-member", "team-a2");
      const crossCompanyScope = await fixture.scopeAs("b1-member", "team-b1");
      for (const scope of [crossTeamScope, crossCompanyScope]) {
        expect(
          isCanonicalNotFound(
            await fixture.sessions.readSession(scope, session.id),
          ),
        ).toBe(true);
        expect(
          isCanonicalNotFound(
            await fixture.sessions.pinCraftSession(scope, {
              sessionId: session.id,
            }),
          ),
        ).toBe(true);
      }
    },
  );

  itDb(
    "pinning someone else's session is indistinguishable from a missing one",
    async () => {
      const { session } = await pinnedSessionOfOwner();
      const teammateScope = await fixture.scopeAs("a1-other", "team-a1");
      const pin = await fixture.sessions.pinCraftSession(teammateScope, {
        sessionId: session.id,
      });
      expect(isCanonicalNotFound(pin)).toBe(true);
    },
  );

  itDb(
    "re-pinning under a different selection identity is loudly refused",
    async () => {
      const { session, ownerScope } = await pinnedSessionOfOwner();
      // a1-member also sits in team-a2 (multi-team identity a1a2-member is a
      // different principal; use the SAME principal in another team via
      // a1a2-member only if it is the same user — it is not, so instead pin
      // from the same principal in another team scope: a1-member has only
      // team-a1, so use a1a2-member's own session to construct the mismatch).
      const otherScope = await fixture.scopeAs("a1a2-member", "team-a1");
      const otherSession = await fixture.craft.createSession({
        userId: otherScope.actorId,
        name: "a1a2 session",
      });
      await fixture.sessions.pinCraftSession(otherScope, {
        sessionId: otherSession.id,
      });
      // Same principal, other team → different selection identity → loud.
      const otherTeamScope = await fixture.scopeAs("a1a2-member", "team-a2");
      const message = await thrownMessage(() =>
        fixture.sessions.pinCraftSession(otherTeamScope, {
          sessionId: otherSession.id,
        }),
      );
      expect(message).toContain("CRAFT_SESSION_SCOPE_MISMATCH");
      // Idempotent re-pin under the same triple returns existing.
      const again = await fixture.sessions.pinCraftSession(otherScope, {
        sessionId: otherSession.id,
      });
      expect(again).toMatchObject({ status: "existing" });
      void session;
      void ownerScope;
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 2：快照按归属存储与读取；下载需要授权
// ---------------------------------------------------------------------------

describeDb("MT053 AC2 snapshots live and download under ownership", () => {
  itDb(
    "the owner downloads the snapshot through the authorized gate",
    async () => {
      const { session, snapshot, ownerScope } = await pinnedSessionOfOwner();
      const download = await fixture.sessions.downloadSnapshot(ownerScope, {
        sessionId: session.id,
        snapshotId: snapshot.id,
      });
      expect(download).toMatchObject({ outcome: "allow", via: "owner" });
      if (download.outcome === "allow") {
        expect(new TextDecoder().decode(download.bytes)).toBe("mt053-bytes");
        expect(download.snapshot.id).toBe(snapshot.id);
        expect(download.enterpriseKey).toBe(
          craftSnapshotObjectKey(
            ownerScope.tenantId,
            ownerScope.workspaceId,
            session.id,
            snapshot.id,
          ),
        );
      }
    },
  );

  itDb(
    "a cross-scope download is canonical not-found and reads zero bytes",
    async () => {
      const { session, snapshot } = await pinnedSessionOfOwner();
      const before = fixture.objectStore.readCount();
      const crossTeamScope = await fixture.scopeAs("a2-member", "team-a2");
      const download = await fixture.sessions.downloadSnapshot(crossTeamScope, {
        sessionId: session.id,
        snapshotId: snapshot.id,
      });
      expect(isCanonicalNotFound(download)).toBe(true);
      expect(fixture.objectStore.readCount()).toBe(before);
    },
  );

  itDb(
    "snapshot listing is scoped the same way as the session detail",
    async () => {
      const { session } = await pinnedSessionOfOwner();
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      const teammateScope = await fixture.scopeAs("a1-other", "team-a1");
      const ownerList = await fixture.sessions.listSnapshots(
        ownerScope,
        session.id,
      );
      expect(ownerList).toMatchObject({ outcome: "allow" });
      const teammateList = await fixture.sessions.listSnapshots(
        teammateScope,
        session.id,
      );
      expect(isCanonicalNotFound(teammateList)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 3：团队公共 Craft 内容遵循 MT009 动作矩阵（可用不可改）
// ---------------------------------------------------------------------------

describeDb(
  "MT053 AC3 team-public craft content: usable, not modifiable",
  () => {
    itDb(
      "a same-team member can read a public_org session and its transcript",
      async () => {
        const { session } = await pinnedSessionOfOwner({
          sharingScope: "public_org",
        });
        const teammateScope = await fixture.scopeAs("a1-other", "team-a1");
        const detail = await fixture.sessions.readSession(
          teammateScope,
          session.id,
        );
        expect(detail).toMatchObject({ outcome: "allow", via: "team-public" });
        if (detail.outcome === "allow") {
          expect(detail.messages).toHaveLength(1);
        }
      },
    );

    itDb(
      "a same-team member cannot modify, rename, share-flip or delete it",
      async () => {
        const { session } = await pinnedSessionOfOwner({
          sharingScope: "public_org",
        });
        const teammateScope = await fixture.scopeAs("a1-other", "team-a1");
        const rename = await fixture.sessions.writeSession(teammateScope, {
          sessionId: session.id,
          action: "rename",
          patch: { name: "hijacked" },
        });
        expect(rename).toMatchObject({
          outcome: "forbidden",
          code: "TEAM_PUBLIC_ACTION_FORBIDDEN",
        });
        const flip = await fixture.sessions.writeSession(teammateScope, {
          sessionId: session.id,
          action: "share",
          patch: { sharingScope: "private" },
        });
        expect(flip).toMatchObject({ outcome: "forbidden" });
        const remove = await fixture.sessions.writeSession(teammateScope, {
          sessionId: session.id,
          action: "delete",
        });
        expect(remove).toMatchObject({ outcome: "forbidden" });
        // And the authoritative row is untouched.
        const row = await fixture.craft.findSessionById(session.id);
        expect(row?.name).toBe("mt053 session");
        expect(row?.sharingScope).toBe("public_org");
      },
    );

    itDb(
      "the owner keeps full write authority over their own session",
      async () => {
        const { session, ownerScope } = await pinnedSessionOfOwner({
          sharingScope: "public_org",
        });
        const renamed = await fixture.sessions.writeSession(ownerScope, {
          sessionId: session.id,
          action: "rename",
          patch: { name: "renamed by owner" },
        });
        expect(renamed).toMatchObject({ outcome: "allow", action: "rename" });
        const row = await fixture.craft.findSessionById(session.id);
        expect(row?.name).toBe("renamed by owner");
      },
    );

    itDb(
      "an outsider sees nothing of the public session (not even forbidden)",
      async () => {
        const { session } = await pinnedSessionOfOwner({
          sharingScope: "public_org",
        });
        const crossTeamScope = await fixture.scopeAs("a2-member", "team-a2");
        expect(
          isCanonicalNotFound(
            await fixture.sessions.readSession(crossTeamScope, session.id),
          ),
        ).toBe(true);
        const write = await fixture.sessions.writeSession(crossTeamScope, {
          sessionId: session.id,
          action: "rename",
          patch: { name: "x" },
        });
        expect(isCanonicalNotFound(write)).toBe(true);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 验收 4：撤权后立即失去访问
// ---------------------------------------------------------------------------

describeDb("MT053 AC4 access dies with the membership epoch", () => {
  itDb(
    "suspending the company folds every entry into invisibility",
    async () => {
      const { session, snapshot } = await pinnedSessionOfOwner({
        sharingScope: "public_org",
      });
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      const teammateScope = await fixture.scopeAs("a1-other", "team-a1");
      // Pre-check: both sides work before suspension.
      expect(
        (await fixture.sessions.readSession(ownerScope, session.id)).outcome,
      ).toBe("allow");
      expect(
        (await fixture.sessions.readSession(teammateScope, session.id)).outcome,
      ).toBe("allow");
      await fixture.suspendCompany("a1-member", "company-a");
      // The already-minted OWNER scope is dead: every entry folds into
      // invisibility (membership epoch discipline — MT005/MT018/MT029 同款).
      expect(
        isCanonicalNotFound(
          await fixture.sessions.readSession(ownerScope, session.id),
        ),
      ).toBe(true);
      // The teammate's own access rides THEIR membership (still active): the
      // public_org fact is a row fact, not the owner's membership — same as
      // MT008/MT009 resource visibility (a suspended owner does not unpublish).
      expect(
        (await fixture.sessions.readSession(teammateScope, session.id)).outcome,
      ).toBe("allow");
      const before = fixture.objectStore.readCount();
      expect(
        isCanonicalNotFound(
          await fixture.sessions.downloadSnapshot(ownerScope, {
            sessionId: session.id,
            snapshotId: snapshot.id,
          }),
        ),
      ).toBe(true);
      expect(fixture.objectStore.readCount()).toBe(before);
      // The list face refuses loudly (SCOPE_REVOKED — MT041 member-view rule).
      const message = await thrownMessage(() =>
        fixture.sessions.listSessions(ownerScope, { limit: 10 }),
      );
      expect(message).toContain("SCOPE_REVOKED");
    },
  );
});
