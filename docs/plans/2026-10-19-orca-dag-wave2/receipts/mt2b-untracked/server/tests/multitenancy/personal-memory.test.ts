// server/tests/multitenancy/personal-memory.test.ts
// MT039（Issue #82）：个人记忆与来源选择保持个人权限。
//
// 验收事实源（Issue #82 四条，逐条对应 describe；真实 PostgreSQL，全程受限
// ob_ent_* 角色 + 真实 RLS，绝不回退开发库、缺 env 显式 skip）：
//   验收 1：同团队另一人无法读取或搜索某人的个人记忆（RLS 双 pin——
//     他人视角空页与"没有记忆"不可区分）。
//   验收 2：记忆来源选择只列出调用者有权访问的库与文档（显式 grant ∨
//     团队公共 + 有效成员；无权/跨范围资源不进列表）。
//   验收 3：缓存键含个人与范围标识，切换用户/团队不串用。
//   验收 4：公共 Bot 使用时记忆按使用者本人权限解析，不使用创建者记忆
//     （创建者键参数一律响亮拒绝）。

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  buildPlan,
  manifestFor,
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import { memoryCacheKey } from "../../src/enterprise/tenancy/personal-memory";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import type { IsolationFixture } from "./support/fixture";
import {
  createPersonalMemoryFixture,
  type PersonalMemoryFixture,
} from "./support/personal-memory";

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
      reason: `MT039 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    enterpriseRuntimeDatabaseUrlFrom("directory", process.env);
    enterpriseRuntimeDatabaseUrlFrom("data", process.env);
    enterpriseRuntimeDatabaseUrlFrom("operator", process.env);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const ENV = probeEnvironment();
const describeDb = ENV.ok ? describe : describe.skip;

// ---------------------------------------------------------------------------
// 套件状态
// ---------------------------------------------------------------------------

let fixture: PersonalMemoryFixture;
let isolation: IsolationFixture;
let companyA = "";
let teamA1 = "";
let teamA2 = "";
let companyB = "";
let publicKbId = "";
let grantedDocId = "";
let privateDocId = "";
let dryRunOutcome: RunOutcome | undefined;
let applyOutcome: RunOutcome | undefined;

describeDb(
  "MT039 personal memory and source selection stay personal (Issue #82)",
  () => {
    beforeAll(async () => {
      const resolved = resolveTestDatabaseTarget(process.env);
      if (!resolved.ok) {
        throw new Error(`MT039 tests refuse to run: ${resolved.reason}`);
      }
      // 三步配方（与 MT035 同款；已应用过的库返回 up-to-date 合法）。
      dryRunOutcome = await runMigrateTest(["migrate", "MT039"], {
        environment: { TEST_DATABASE_URL: resolved.target.url },
        out: () => {},
      });
      if (dryRunOutcome.kind === "refused") {
        throw new Error(`MT039 dry-run refused: ${dryRunOutcome.reason}`);
      }
      const manifestPath = `/tmp/mt039-manifest-${randomUUID()}.json`;
      await Bun.write(
        manifestPath,
        `${JSON.stringify(manifestFor(buildPlan("MT039")), null, 2)}\n`,
      );
      try {
        applyOutcome = await runMigrateTest(
          ["migrate", "MT039", "--apply", "--manifest", manifestPath],
          {
            environment: { TEST_DATABASE_URL: resolved.target.url },
            out: () => {},
          },
        );
      } finally {
        await rm(manifestPath, { force: true });
      }
      if (
        applyOutcome.kind !== "applied" &&
        applyOutcome.kind !== "up-to-date"
      ) {
        throw new Error(
          `MT039 apply did not land: ${JSON.stringify(applyOutcome).slice(0, 200)}`,
        );
      }

      fixture = await createPersonalMemoryFixture();
      isolation = fixture.base.isolation;
      companyA = isolation.ids["company-a"];
      teamA1 = isolation.ids["team-a1"];
      teamA2 = isolation.ids["team-a2"];
      companyB = isolation.ids["company-b"];

      // 来源矩阵：A1 团队公共 KB；A1 私有文档（给 a1-other 显式 grant）；
      // A1 私有文档（无任何授权）。
      publicKbId = await fixture.seedResource({
        tenantId: companyA,
        workspaceId: teamA1,
        kind: "knowledge_base",
        displayName: "MT039 Team KB",
        visibility: "workspace",
      });
      grantedDocId = await fixture.seedResource({
        tenantId: companyA,
        workspaceId: teamA1,
        kind: "document",
        displayName: "MT039 Granted Doc",
        visibility: null,
      });
      privateDocId = await fixture.seedResource({
        tenantId: companyA,
        workspaceId: teamA1,
        kind: "document",
        displayName: "MT039 Private Doc",
        visibility: null,
      });
      await fixture.seedReadGrant({
        tenantId: companyA,
        resourceId: grantedDocId,
        principalId: isolation.ids["principal-a1-other"],
      });
    });

    test("AC1 · a teammate cannot read or search someone else's memories", async () => {
      const owner = await fixture.scopeAs("a1-member", companyA, teamA1);
      const secret = `mt039-secret-${randomUUID().slice(0, 8)}`;
      const written = await fixture.memory.writeMemory(owner, {
        memoryKey: "coffee-order",
        content: secret,
      });
      expect(written.outcome).toBe("allow");

      const ownerHits = await fixture.memory.searchMemories(owner, {
        query: secret,
      });
      expect(ownerHits).toHaveLength(1);
      expect(ownerHits[0]?.content).toBe(secret);

      // 同团队他人：同键、同内容、同 id 三种查询全部空页——与"没有
      // 记忆"不可区分（RLS 双 pin，不泄露存在性）。
      const other = await fixture.scopeAs("a1-other", companyA, teamA1);
      expect(
        await fixture.memory.searchMemories(other, { query: secret }),
      ).toEqual([]);
      expect(
        await fixture.memory.searchMemories(other, { query: "coffee-order" }),
      ).toEqual([]);
      expect(
        await fixture.memory.searchMemories(other, {
          query: written.memoryId,
        }),
      ).toEqual([]);

      // 跨团队/跨公司同样空页。
      const crossTeam = await fixture.scopeAs("a2-member", companyA, teamA2);
      expect(
        await fixture.memory.searchMemories(crossTeam, { query: secret }),
      ).toEqual([]);
      const crossCompany = await fixture.scopeAs(
        "b1-member",
        companyB,
        isolation.ids["team-b1"],
      );
      expect(
        await fixture.memory.searchMemories(crossCompany, { query: secret }),
      ).toEqual([]);
    });

    test("AC2 · source selection lists only what the caller may access", async () => {
      const member = await fixture.scopeAs("a1-member", companyA, teamA1);
      const memberSources = await fixture.memory.listMemorySources(member);
      const memberIds = memberSources.map((row) => row.resourceId);
      expect(memberIds).toContain(publicKbId); // 团队公共 → 有效成员可读
      expect(memberIds).not.toContain(grantedDocId); // grant 给的是别人
      expect(memberIds).not.toContain(privateDocId); // 无授权

      const other = await fixture.scopeAs("a1-other", companyA, teamA1);
      const otherSources = await fixture.memory.listMemorySources(other);
      const otherIds = otherSources.map((row) => row.resourceId);
      expect(otherIds).toContain(publicKbId);
      expect(otherIds).toContain(grantedDocId); // 显式 grant
      expect(otherIds).not.toContain(privateDocId);

      // 同公司他团队：A1 的公共资源不属于 A2 的范围。
      const crossTeam = await fixture.scopeAs("a2-member", companyA, teamA2);
      const crossTeamIds = (
        await fixture.memory.listMemorySources(crossTeam)
      ).map((row) => row.resourceId);
      expect(crossTeamIds).not.toContain(publicKbId);
      expect(crossTeamIds).not.toContain(grantedDocId);

      // 跨公司：A 公司资源一概不出现。
      const crossCompany = await fixture.scopeAs(
        "b1-member",
        companyB,
        isolation.ids["team-b1"],
      );
      const crossCompanyIds = (
        await fixture.memory.listMemorySources(crossCompany)
      ).map((row) => row.resourceId);
      for (const id of [publicKbId, grantedDocId, privateDocId]) {
        expect(crossCompanyIds).not.toContain(id);
      }
    });

    test("AC3 · cache keys carry personal and scope identity", () => {
      const a1Member = {
        tenantId: companyA,
        workspaceId: teamA1,
        principalId: isolation.ids["principal-a1-member"],
      };
      const a1Other = {
        tenantId: companyA,
        workspaceId: teamA1,
        principalId: isolation.ids["principal-a1-other"],
      };
      const a2Member = {
        tenantId: companyA,
        workspaceId: teamA2,
        principalId: isolation.ids["principal-a2-member"],
      };
      const b1Member = {
        tenantId: companyB,
        workspaceId: isolation.ids["team-b1"],
        principalId: isolation.ids["principal-b1-member"],
      };

      // 同一身份稳定；个人或范围任一维度变化即不同键。
      expect(memoryCacheKey(a1Member)).toBe(memoryCacheKey(a1Member));
      const keys = [a1Member, a1Other, a2Member, b1Member].map(memoryCacheKey);
      expect(new Set(keys).size).toBe(4);
      for (const key of keys) {
        expect(key.startsWith("memory:v1:")).toBe(true);
        expect(key.split(":")).toHaveLength(5);
      }
      // 键的各段确实是范围/个人标识本身（可核验、非哈希黑盒）。
      expect(memoryCacheKey(a1Member)).toBe(
        `memory:v1:${companyA}:${teamA1}:${isolation.ids["principal-a1-member"]}`,
      );
    });

    test("AC4 · a public bot resolves memories by the user's own permissions", async () => {
      const creator = await fixture.scopeAs("a1-other", companyA, teamA1);
      const creatorSecret = `mt039-creator-${randomUUID().slice(0, 8)}`;
      await fixture.memory.writeMemory(creator, {
        memoryKey: "creator-only",
        content: creatorSecret,
      });

      const user = await fixture.scopeAs("a1-member", companyA, teamA1);
      const userSecret = `mt039-user-${randomUUID().slice(0, 8)}`;
      await fixture.memory.writeMemory(user, {
        memoryKey: "user-own",
        content: userSecret,
      });

      // 公共 Bot 解析：只返回使用者本人的记忆；创建者记忆不出现。
      const resolved = await fixture.memory.resolveMemoriesForPublicBot(user, {
        agentId: "mt039-shared-public-bot",
      });
      expect(resolved.some((row) => row.content === userSecret)).toBe(true);
      expect(resolved.some((row) => row.content === creatorSecret)).toBe(false);

      // 创建者/归属键不可表达：客户端声称的创建者一律响亮拒绝。
      await expect(
        fixture.memory.resolveMemoriesForPublicBot(user, {
          agentId: "mt039-shared-public-bot",
          ownerPrincipalId: isolation.ids["principal-a1-other"],
        }),
      ).rejects.toThrow("ATTRIBUTION_NOT_CLIENT_DECLARABLE");
    });
  },
);
