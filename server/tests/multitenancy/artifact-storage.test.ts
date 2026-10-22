// server/tests/multitenancy/artifact-storage.test.ts
// MT055（Issue #98）：产物与对象存储路径按归属隔离。
//
// 验收事实源（Issue #98 四条，逐条对应 describe；真实 PostgreSQL，全程
// 受限 ob_ent_* 角色 + 真实 RLS，绝不回退开发库、缺 env 显式 skip）：
//   验收 1：产物路径包含归属标识但不可作为授权依据；直接猜测路径读取
//     被拒绝（objectStore 只在范围门通过后被调用，跨范围零读取）。
//   验收 2：列举只返回本范围产物；跨范围列举为空。
//   验收 3：删除与清理只影响本范围。
//   验收 4：产物元数据（名称、大小、时间）不泄露给无权用户。
//
// 证据可复现（票面 AC）——本套件即复现命令：
//   set +x; source /tmp/mt28-env.sh && bun --no-env-file test \
//     server/tests/multitenancy/artifact-storage.test.ts

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  enterpriseWorkshopArtifactObjectKey,
  parseEnterpriseWorkshopArtifactObjectKey,
} from "../../src/enterprise/tenancy/artifact-storage";
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
      reason: `MT055 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

/** 属主（a1-member@team-a1）创建一个已 pin 的会话 + 两个产物。 */
async function pinnedArtifactsOfOwner() {
  const first = await fixture.ensurePinnedArtifact({
    owner: "a1-member",
    team: "team-a1",
    name: "mt055-report",
  });
  const second = await fixture.ensurePinnedArtifact({
    owner: "a1-member",
    team: "team-a1",
    name: "mt055-chart",
  });
  const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
  return { first, second, ownerScope };
}

// ---------------------------------------------------------------------------
// 纯函数：企业面产物键命名（验收 1 的存储半边）
// ---------------------------------------------------------------------------

describeDb("MT055 artifact object keys (pure naming, #90 discipline)", () => {
  itDb("derives a four-plain-segment key under the owning scope", () => {
    const key = enterpriseWorkshopArtifactObjectKey(
      "acme",
      "acme-finance",
      "ws-abc123",
      "wa-def456",
    );
    expect(key).toBe(
      "workshop-artifacts/acme/acme-finance/ws-abc123/wa-def456",
    );
  });

  itDb(
    "rejects non-plain ids loudly (one scope cannot name another's key)",
    () => {
      expect(() =>
        enterpriseWorkshopArtifactObjectKey("ACME", "w", "ws-1", "wa-1"),
      ).toThrow("ARTIFACT_ID_INVALID");
      expect(() =>
        enterpriseWorkshopArtifactObjectKey("a", "w", "../../escape", "wa-1"),
      ).toThrow("ARTIFACT_ID_INVALID");
    },
  );

  itDb("round-trips through the parser; malformed shapes parse to null", () => {
    const parsed = parseEnterpriseWorkshopArtifactObjectKey(
      "workshop-artifacts/acme/acme-finance/ws-abc123/wa-def456",
    );
    expect(parsed).toEqual({
      tenantId: "acme",
      workspaceId: "acme-finance",
      sessionId: "ws-abc123",
      artifactId: "wa-def456",
    });
    expect(parseEnterpriseWorkshopArtifactObjectKey("a/b/c/d")).toBeNull();
    expect(
      parseEnterpriseWorkshopArtifactObjectKey("craft-snapshots/a/b/c/d"),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 验收 1：路径只寻址不授权；猜测路径读取被拒绝
// ---------------------------------------------------------------------------

describeDb("MT055 AC1 paths address, never authorize", () => {
  itDb(
    "the owner reads bytes through the derived key (gate first)",
    async () => {
      const { first, ownerScope } = await pinnedArtifactsOfOwner();
      const readsBefore = fixture.artifactStore.readCount();
      const read = await fixture.artifacts.readArtifact(ownerScope, {
        sessionId: first.sessionId,
        artifactId: first.artifactId,
      });
      expect(read.outcome).toBe("allow");
      if (read.outcome !== "allow") return;
      expect(read.enterpriseKey).toBe(first.enterpriseKey);
      // 键里的归属段就是请求者自己的 scope（寻址面包含归属标识）。
      expect(read.enterpriseKey.startsWith("workshop-artifacts/")).toBe(true);
      // 字节读取只发生在范围门之后：本例恰好 +1 次，键就是派生键。
      expect(fixture.artifactStore.readCount()).toBe(readsBefore + 1);
      expect(fixture.artifactStore.reads.at(-1)).toBe(first.enterpriseKey);
    },
  );

  itDb(
    "a cross-scope caller (other team, same company) is refused with zero byte reads",
    async () => {
      const { first } = await pinnedArtifactsOfOwner();
      const intruder = await fixture.scopeAs("a2-member", "team-a2");
      const readsBefore = fixture.artifactStore.readCount();
      const read = await fixture.artifacts.readArtifact(intruder, {
        sessionId: first.sessionId,
        artifactId: first.artifactId,
      });
      expect(isCanonicalNotFound(read)).toBe(true);
      // 不可见 = 零字节读取：直接猜测路径在结构上没有入口。
      expect(fixture.artifactStore.readCount()).toBe(readsBefore);
    },
  );

  itDb(
    "a cross-company caller is refused identically (existence stays hidden)",
    async () => {
      const { first } = await pinnedArtifactsOfOwner();
      const foreigner = await fixture.scopeAs("b1-member", "team-b1");
      const read = await fixture.artifacts.readArtifact(foreigner, {
        sessionId: first.sessionId,
        artifactId: first.artifactId,
      });
      expect(isCanonicalNotFound(read)).toBe(true);
    },
  );

  itDb(
    "foreign pins are invisible; a same-user cross-scope pin is loudly refused (create-once)",
    async () => {
      const arrangement = await fixture.ensurePinnedArtifact({
        owner: "a1a2-member",
        team: "team-a1",
        name: "mt055-pin-guard",
      });
      // 他人（不同用户）：本人会话守卫先行——不可见（canonical not-found，
      // 与产物不存在不可区分）。
      const intruder = await fixture.scopeAs("a2-member", "team-a2");
      const foreignPin = await fixture.artifacts.pinWorkshopArtifact(intruder, {
        sessionId: arrangement.sessionId,
        artifactId: arrangement.artifactId,
      });
      expect(isCanonicalNotFound(foreignPin)).toBe(true);
      // 同一用户、另一团队 scope：行是本人的（守卫通过），但归属已被
      // team-a1 钉死——不同选择标识响亮拒绝，已存归属不动。
      const otherTeamScope = await fixture.scopeAs("a1a2-member", "team-a2");
      await expect(
        thrownMessage(() =>
          fixture.artifacts.pinWorkshopArtifact(otherTeamScope, {
            sessionId: arrangement.sessionId,
            artifactId: arrangement.artifactId,
          }),
        ),
      ).resolves.toBe("ARTIFACT_SCOPE_MISMATCH");
      // 幂等重放（本人、同三元组）返回 existing，不抛。
      const ownerScope = await fixture.scopeAs("a1a2-member", "team-a1");
      const replay = await fixture.artifacts.pinWorkshopArtifact(ownerScope, {
        sessionId: arrangement.sessionId,
        artifactId: arrangement.artifactId,
      });
      expect("status" in replay && replay.status).toBe("existing");
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 2：列举只返回本范围；跨范围列举为空
// ---------------------------------------------------------------------------

describeDb("MT055 AC2 listing stays inside the caller's scope", () => {
  itDb("the owner's list contains only their pinned artifacts", async () => {
    const { first, second, ownerScope } = await pinnedArtifactsOfOwner();
    const listed = await fixture.artifacts.listArtifacts(ownerScope, {
      limit: 200,
    });
    const ids = listed.artifacts.map((row) => row.artifactId);
    expect(ids).toContain(first.artifactId);
    expect(ids).toContain(second.artifactId);
  });

  itDb(
    "a cross-scope list is empty of the other scope's artifacts (no metadata)",
    async () => {
      const { first } = await pinnedArtifactsOfOwner();
      const intruder = await fixture.scopeAs("a2-member", "team-a2");
      const listed = await fixture.artifacts.listArtifacts(intruder, {
        limit: 200,
      });
      const serialized = JSON.stringify(listed);
      // 跨范围列举为空：既不含 id，也不含任何元数据字段值。
      expect(serialized).not.toContain(first.artifactId);
      expect(serialized).not.toContain("mt055-report");
      expect(
        listed.artifacts.every((row) => row.artifactId !== first.artifactId),
      ).toBe(true);
    },
  );

  itDb(
    "a cross-company list is equally empty (company boundary holds)",
    async () => {
      await pinnedArtifactsOfOwner();
      const foreigner = await fixture.scopeAs("b1-member", "team-b1");
      const listed = await fixture.artifacts.listArtifacts(foreigner, {
        limit: 200,
      });
      expect(
        listed.artifacts.every((row) =>
          row.enterpriseKey.startsWith("workshop-artifacts/"),
        ),
      ).toBe(true);
      expect(listed.artifacts.length).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 3：删除与清理只影响本范围
// ---------------------------------------------------------------------------

describeDb("MT055 AC3 delete and cleanup stay inside the scope", () => {
  itDb(
    "a cross-scope delete is folded to not-found and touches nothing",
    async () => {
      const { first } = await pinnedArtifactsOfOwner();
      const intruder = await fixture.scopeAs("a2-member", "team-a2");
      const deleted = await fixture.artifacts.deleteArtifact(intruder, {
        sessionId: first.sessionId,
        artifactId: first.artifactId,
      });
      expect(isCanonicalNotFound(deleted)).toBe(true);
      // 属主的产物原样可见（一个字节都没动）。
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      const read = await fixture.artifacts.readArtifact(ownerScope, {
        sessionId: first.sessionId,
        artifactId: first.artifactId,
      });
      expect(read.outcome).toBe("allow");
    },
  );

  itDb(
    "cleanup removes only the caller's own candidates (cross-scope untouched)",
    async () => {
      const ownerArtifact = await fixture.ensurePinnedArtifact({
        owner: "a1-member",
        team: "team-a1",
        name: "mt055-old-mine",
      });
      const otherArtifact = await fixture.ensurePinnedArtifact({
        owner: "a2-member",
        team: "team-a2",
        name: "mt055-old-theirs",
      });
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      const cleaned = await fixture.artifacts.cleanupArtifacts(ownerScope, {
        olderThanSeconds: 0,
      });
      expect(cleaned.outcome).toBe("allow");
      if (cleaned.outcome !== "allow") return;
      expect(cleaned.cleaned).toContain(ownerArtifact.artifactId);
      expect(cleaned.cleaned).not.toContain(otherArtifact.artifactId);
      // 对象存储只删了本 scope 的键。
      expect(fixture.artifactStore.deleted).toContain(
        ownerArtifact.enterpriseKey,
      );
      expect(fixture.artifactStore.deleted).not.toContain(
        otherArtifact.enterpriseKey,
      );
      // 他人的产物行与字节原样。
      const otherScope = await fixture.scopeAs("a2-member", "team-a2");
      const otherRead = await fixture.artifacts.readArtifact(otherScope, {
        sessionId: otherArtifact.sessionId,
        artifactId: otherArtifact.artifactId,
      });
      expect(otherRead.outcome).toBe("allow");
    },
  );

  itDb(
    "the owner's delete removes row, association row and bytes",
    async () => {
      const artifact = await fixture.ensurePinnedArtifact({
        owner: "a1-member",
        team: "team-a1",
        name: "mt055-delete-me",
      });
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      const deleted = await fixture.artifacts.deleteArtifact(ownerScope, {
        sessionId: artifact.sessionId,
        artifactId: artifact.artifactId,
      });
      expect(deleted.outcome).toBe("allow");
      expect(fixture.artifactStore.deleted).toContain(artifact.enterpriseKey);
      const reread = await fixture.artifacts.readArtifact(ownerScope, {
        sessionId: artifact.sessionId,
        artifactId: artifact.artifactId,
      });
      expect(isCanonicalNotFound(reread)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 4：元数据不泄露
// ---------------------------------------------------------------------------

describeDb("MT055 AC4 metadata does not leak to unauthorized callers", () => {
  itDb("deny verdicts carry no name/size/time fields", async () => {
    const { first } = await pinnedArtifactsOfOwner();
    const intruder = await fixture.scopeAs("a2-member", "team-a2");
    const read = await fixture.artifacts.readArtifact(intruder, {
      sessionId: first.sessionId,
      artifactId: first.artifactId,
    });
    expect(JSON.stringify(read)).toBe(canonicalNotFoundJson);
    expect(JSON.stringify(read)).not.toContain("mt055");
    expect(JSON.stringify(read)).not.toContain("sizeBytes");
  });

  itDb(
    "an unknown artifact id is indistinguishable from a hidden one",
    async () => {
      const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
      const missing = await fixture.artifacts.readArtifact(ownerScope, {
        sessionId: "ws-nonexistent",
        artifactId: "wa-nonexistent",
      });
      expect(JSON.stringify(missing)).toBe(canonicalNotFoundJson);
    },
  );
});

// ---------------------------------------------------------------------------
// 撤销：公司级停用对列面响亮、对象面不可见（MT041 同纪律；置尾避免污染
// 后续场景的成员资格）
// ---------------------------------------------------------------------------

describeDb(
  "MT055 revocation folds every entrance of a suspended member",
  () => {
    itDb(
      "company suspension turns the list face loud (SCOPE_REVOKED)",
      async () => {
        const { first } = await pinnedArtifactsOfOwner();
        // 签发在撤销前（MT053 AC4 同款：已签发 scope 在成员事实重验处失效）。
        const ownerScope = await fixture.scopeAs("a1-member", "team-a1");
        await fixture.suspendCompany("a1-member", "company-a");
        await expect(
          thrownMessage(() =>
            fixture.artifacts.listArtifacts(ownerScope, { limit: 10 }),
          ),
        ).resolves.toBe("SCOPE_REVOKED");
        // 对象面：本人的产物在撤权后也折叠为不可见（撤权者无豁免）。
        const read = await fixture.artifacts.readArtifact(ownerScope, {
          sessionId: first.sessionId,
          artifactId: first.artifactId,
        });
        expect(isCanonicalNotFound(read)).toBe(true);
      },
    );
  },
);
