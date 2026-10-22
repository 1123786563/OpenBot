// server/tests/multitenancy/openmuse-files.test.ts
// MT061（Issue #104）：OpenMuse 文件、PDF 检视/填写/传输与个人工作区的作用域。
//
// 验收事实源（Issue #104 四条，逐条对应 describe；真实 PostgreSQL，全程受限
// ob_ent_* 角色 + 真实 RLS + 真实 MT059 私有 Bot + 真实签发入口，绝不回退
// 开发库、缺 env 显式 skip）：
//   AC1 文件列举、读取、处理与下载都要求当前范围与个人权限——协会行三元组
//     （租户臂 RLS + 应用层第二道防线）先于一切文件行读写；一切不可见 =
//     MT011 canonical RESOURCE_NOT_FOUND 逐字节同形。
//   AC2 PDF 填写/传输任务保存发起归属，执行时校验；撤权后失败而不是继续
//     ——动作行持久发起归属；执行重建 = 机器身份 → 扫描臂 → 真实签发入口；
//     撤权后 OPENMUSE_DOCUMENT_SCOPE_REVOKED（fail，不继续）。
//   AC3 个人工作区不跨公司共享；同一账号在两个公司的工作区互相不可见
//     ——传输目的地 = 当前 scope 的私有 Bot（结构性不同）；跨公司对文件
//     与动作行不可见。
//   AC4 外部文件引用（如邮件附件）按归属解析，不能凭 ID 跨范围取用
//     ——(owner, sourceKey) 收敛查找后仍须协会行三元组匹配；跨公司同账号
//     = canonical not-found。
//
// 结构（新文件；迁移经真实 MT003 工具 generate→apply→replay 收敛钉死）。

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import type { PlatformScope } from "../../src/enterprise/contracts";
import { MACHINE_IDENTITY_INVALID } from "../../src/enterprise/runs/scan-executor";
import {
  isResourceNotFoundVerdict,
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import {
  OPENMUSE_DOCUMENT_RECORD_MISSING,
  OPENMUSE_DOCUMENT_SCOPE_REVOKED,
} from "../../src/enterprise/tenancy/openmuse-file-tenancy";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import {
  createOpenMuseFilesFixture,
  type OpenMuseFileIdentity,
  type OpenMuseFilesFixture,
} from "./support/openmuse-files";

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
      reason: `MT061 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
const itDb = ((name, fn) =>
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
  throw new Error("expected the call to be rejected, but it succeeded");
};

// ---------------------------------------------------------------------------
// 套件状态
// ---------------------------------------------------------------------------

let fixture: OpenMuseFilesFixture;
let companyA = "";
let companyB = "";
let teamA1 = "";
let teamA2 = "";
let teamB1 = "";
const suiteGeneratedDirs: string[] = [];
const randomSuiteToken = () => Math.random().toString(36).slice(2, 10);

/** 共享文件图：每条 = {id, ownerIdentity, sourceKey?}。 */
const files: Record<
  string,
  { id: string; ownerIdentity: OpenMuseFileIdentity; sourceKey?: string }
> = {};

const scopeAs = (
  identity: OpenMuseFileIdentity,
  tenantId: string,
  workspaceId: string,
): Promise<PlatformScope> => fixture.scopeAs(identity, tenantId, workspaceId);

const seedAndPin = async (
  key: string,
  identity: OpenMuseFileIdentity,
  tenantId: string,
  workspaceId: string,
  input?: { sourceKey?: string; attribution?: "created" | "import" },
) => {
  const ownerUserId = fixture.ids[`user-${identity}`];
  const fileId = await fixture.seedFile({
    ownerUserId,
    ...(input?.sourceKey !== undefined
      ? { idempotencyKey: input.sourceKey }
      : {}),
  });
  const scope = await scopeAs(identity, tenantId, workspaceId);
  const result = await fixture.service.pinFileScope(scope, {
    fileId,
    ...(input?.attribution !== undefined
      ? { attribution: input.attribution }
      : {}),
  });
  if (!("status" in result) || result.status !== "pinned") {
    throw new Error(`pin failed: ${JSON.stringify(result)}`);
  }
  files[key] = {
    id: fileId,
    ownerIdentity: identity,
    ...(input?.sourceKey !== undefined ? { sourceKey: input.sourceKey } : {}),
  };
  return fileId;
};

beforeAll(async () => {
  if (!ENV.ok) return;

  // MT061 migration through the real MT003 tool: generate → apply → replay
  // is convergent (applied on a fresh database, up-to-date on replay).
  if (!resolveTestDatabaseTarget(process.env).ok) {
    throw new Error(
      "MT061 migration target refused: TEST_DATABASE_URL invalid",
    );
  }
  const dir = join("/tmp", `mt061-migration-${randomSuiteToken()}`);
  suiteGeneratedDirs.push(dir);
  const generation = await runMigrateTest(["generate", "MT061", "--out", dir], {
    environment: process.env,
    out: () => {},
  });
  if (generation.kind !== "generated") {
    throw new Error(`MT061 generate failed: ${JSON.stringify(generation)}`);
  }
  const manifestPath = join(dir, "MT061", "manifest.json");
  const applied: RunOutcome = await runMigrateTest(
    ["migrate", "MT061", "--apply", "--manifest", manifestPath],
    { environment: process.env, out: () => {} },
  );
  if (!["applied", "up-to-date"].includes(applied.kind)) {
    throw new Error(`MT061 apply failed: ${JSON.stringify(applied)}`);
  }
  const replay = await runMigrateTest(
    ["migrate", "MT061", "--apply", "--manifest", manifestPath],
    { environment: process.env, out: () => {} },
  );
  if (replay.kind !== "up-to-date") {
    throw new Error(`MT061 replay not convergent: ${JSON.stringify(replay)}`);
  }

  fixture = await createOpenMuseFilesFixture();
  companyA = fixture.ids["company-a"];
  companyB = fixture.ids["company-b"];
  teamA1 = fixture.ids["team-a1"];
  teamA2 = fixture.ids["team-a2"];
  teamB1 = fixture.ids["team-b1"];

  // Shared file graph: one per (identity × scope) the ACs read, one foreign
  // teammate file, one imported external reference, one multi-company pair.
  await seedAndPin("a1", "a1-member", companyA, teamA1);
  await seedAndPin("a1second", "a1-member", companyA, teamA1);
  await seedAndPin("other", "a1-other", companyA, teamA1);
  await seedAndPin("a2", "a2-member", companyA, teamA2);
  await seedAndPin("b1", "b1-member", companyB, teamB1);
  await seedAndPin("multiA", "multi-company", companyA, teamA1);
  await seedAndPin("multiB", "multi-company", companyB, teamB1);
  await seedAndPin("imported", "a1-member", companyA, teamA1, {
    sourceKey: `gmail:t-1:m-1:att-1:import-1`,
    attribution: "import",
  });
}, 120_000);

afterAll(async () => {
  for (const dir of suiteGeneratedDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  if (fixture) {
    await fixture.dispose();
  }
}, 60_000);

// ---------------------------------------------------------------------------
// AC1：文件列举、读取、处理与下载都要求当前范围与个人权限
// ---------------------------------------------------------------------------

describeDb("MT061 AC1：范围化列举/读取", () => {
  itDb("列表只返回本人、所选团队范围内的文件（同团队他人零泄漏）", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const { files: listed } = await fixture.service.listFiles(scope, {
      limit: 100,
    });
    const ids = listed.map((entry) => entry.ownership.fileId).sort();
    expect(ids).toEqual(
      [files.a1.id, files.a1second.id, files.imported.id].sort(),
    );
    for (const entry of listed) {
      expect(entry.ownership.tenantId).toBe(companyA);
      expect(entry.ownership.workspaceId).toBe(teamA1);
      expect(entry.ownership.principalId).toBe(
        fixture.ids["principal-a1-member"],
      );
      expect(entry.ownership.userId).toBe(fixture.ids["user-a1-member"]);
    }
    // 同团队另一人的文件从不出现在别人的列表里。
    expect(ids).not.toContain(files.other.id);
  });

  itDb("跨团队上下文不可见：A2 列表不含 A1 的文件，读取零触达", async () => {
    const scopeA2 = await scopeAs("a1a2-member", companyA, teamA2);
    const { files: listed } = await fixture.service.listFiles(scopeA2, {
      limit: 100,
    });
    expect(listed.map((entry) => entry.ownership.fileId)).toEqual([]);

    const read = await fixture.service.readFile(scopeA2, files.a1.id);
    expect(isCanonicalNotFound(read)).toBe(true);
  });

  itDb(
    "跨公司同账号：B 公司上下文对 A 公司文件 canonical not-found",
    async () => {
      const scopeB = await scopeAs("multi-company", companyB, teamB1);
      const read = await fixture.service.readFile(scopeB, files.multiA.id);
      expect(isCanonicalNotFound(read)).toBe(true);
      // B 上下文只看到 B 的文件。
      const { files: listed } = await fixture.service.listFiles(scopeB, {
        limit: 100,
      });
      expect(listed.map((entry) => entry.ownership.fileId)).toEqual([
        files.multiB.id,
      ]);
    },
  );

  itDb("读取返回归属与文件行；不存在的 id 与跨范围 id 同形", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const read = await fixture.service.readFile(scope, files.a1.id);
    expect(read).toMatchObject({
      outcome: "allow",
      file: { id: files.a1.id },
    });
    const missing = await fixture.service.readFile(scope, "no-such-file");
    expect(isCanonicalNotFound(missing)).toBe(true);
    const foreign = await fixture.service.readFile(scope, files.b1.id);
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
  });

  itDb("同团队他人对本人文件 canonical not-found（个人权限半边）", async () => {
    const scope = await scopeAs("a1-other", companyA, teamA1);
    const read = await fixture.service.readFile(scope, files.a1.id);
    expect(isCanonicalNotFound(read)).toBe(true);
  });

  itDb("公司级撤权后列表响亮拒绝，对象面折叠为不可见", async () => {
    // 独立被撤权人：b1-member 在 B 公司被停用。
    const scope = await scopeAs("b1-member", companyB, teamB1);
    await fixture.suspendCompanyMembership(
      companyB,
      fixture.ids["principal-b1-member"],
    );
    const listed = await thrownMessage(() =>
      fixture.service.listFiles(scope, { limit: 10 }),
    );
    expect(listed).toBe("SCOPE_REVOKED");
    const read = await fixture.service.readFile(scope, files.b1.id);
    expect(isCanonicalNotFound(read)).toBe(true);
  });

  itDb(
    "pin：同三元组幂等 existing；不同选择标识响亮拒绝且已存行不动",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const again = await fixture.service.pinFileScope(scope, {
        fileId: files.a1.id,
      });
      expect(again).toMatchObject({ status: "existing" });

      // 同一文件从 A2 上下文 pin：文件属于 A1 的三元组——响亮拒绝。
      const scopeA2 = await scopeAs("a1a2-member", companyA, teamA2);
      // a1a2-member 不是文件 owner：先折叠为 not-found。
      const foreign = await fixture.service.pinFileScope(scopeA2, {
        fileId: files.a1.id,
      });
      expect(isCanonicalNotFound(foreign)).toBe(true);

      // owner 本人在另一公司上下文 pin 自己的文件：归属已存 → MISMATCH 响亮。
      const scopeB = await scopeAs("multi-company", companyB, teamB1);
      const mismatch = await thrownMessage(() =>
        fixture.service.pinFileScope(scopeB, { fileId: files.multiA.id }),
      );
      expect(mismatch).toContain("OPENMUSE_FILE_SCOPE_MISMATCH");
    },
  );
});

// ---------------------------------------------------------------------------
// AC2：PDF 填写/传输保存发起归属，执行时校验；撤权后失败而不是继续
// ---------------------------------------------------------------------------

describeDb("MT061 AC2：文档动作的发起归属与执行校验", () => {
  itDb(
    "recordDocumentAction 保存发起归属；authorize 以真实签发入口重建受信 Scope",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const recorded = await fixture.service.recordDocumentAction(scope, {
        fileId: files.a1.id,
        actionKind: "fill",
      });
      expect(recorded).toMatchObject({
        status: "recorded",
        facts: {
          fileId: files.a1.id,
          actionKind: "fill",
          tenantId: companyA,
          workspaceId: teamA1,
          principalId: fixture.ids["principal-a1-member"],
        },
      });

      const authorized = await fixture.service.authorizeDocumentAction(
        fixture.machine,
        { fileId: files.a1.id, actionKind: "fill" },
      );
      expect(authorized.ok).toBe(true);
      if (authorized.ok) {
        expect(authorized.scope.tenantId).toBe(companyA);
        expect(authorized.scope.workspaceId).toBe(teamA1);
        expect(authorized.scope.entrypoint).toBe("schedule");
      }
      // 同键重放收敛 existing。
      const replay = await fixture.service.recordDocumentAction(scope, {
        fileId: files.a1.id,
        actionKind: "fill",
      });
      expect(replay).toMatchObject({ status: "existing" });
    },
  );

  itDb(
    "撤权后执行失败而不是继续（OPENMUSE_DOCUMENT_SCOPE_REVOKED）",
    async () => {
      // 独立对象：a2-member 的文件 + 动作，然后撤权。
      const scope = await scopeAs("a2-member", companyA, teamA2);
      const recorded = await fixture.service.recordDocumentAction(scope, {
        fileId: files.a2.id,
        actionKind: "transfer",
      });
      expect(recorded).toMatchObject({ status: "recorded" });

      await fixture.suspendCompanyMembership(
        companyA,
        fixture.ids["principal-a2-member"],
      );

      const authorized = await fixture.service.authorizeDocumentAction(
        fixture.machine,
        { fileId: files.a2.id, actionKind: "transfer" },
      );
      expect(authorized).toEqual({
        ok: false,
        code: OPENMUSE_DOCUMENT_SCOPE_REVOKED,
      });
    },
  );

  itDb(
    "动作对象不属于当前 scope = canonical not-found（零动作行副作用）",
    async () => {
      const scope = await scopeAs("a1-other", companyA, teamA1);
      const recorded = await fixture.service.recordDocumentAction(scope, {
        fileId: files.a1.id,
        actionKind: "fill",
      });
      expect(isCanonicalNotFound(recorded)).toBe(true);
      // 不存在动作行：执行重建拒绝 RECORD_MISSING。
      const missing = await fixture.service.authorizeDocumentAction(
        fixture.machine,
        { fileId: files.a1.id, actionKind: "transfer" },
      );
      expect(missing).toEqual({
        ok: false,
        code: OPENMUSE_DOCUMENT_RECORD_MISSING,
      });
    },
  );

  itDb("机器身份门卫：非受信身份拒绝（MT042 同纪律）", async () => {
    const refused = await thrownMessage(() =>
      fixture.service.authorizeDocumentAction(
        {},
        {
          fileId: files.a1.id,
          actionKind: "fill",
        },
      ),
    );
    expect(refused).toContain(MACHINE_IDENTITY_INVALID);
  });
});

// ---------------------------------------------------------------------------
// AC3：个人工作区不跨公司共享；同一账号在两个公司的工作区互相不可见
// ---------------------------------------------------------------------------

describeDb("MT061 AC3：个人工作区按 scope 隔离", () => {
  itDb(
    "传输目的地 = 当前 scope 的私有 Bot：同一账号两个公司结构性不同的 Bot",
    async () => {
      const scopeA = await scopeAs("multi-company", companyA, teamA1);
      const scopeB = await scopeAs("multi-company", companyB, teamB1);
      const destA = await fixture.service.resolveTransferDestination(
        scopeA,
        files.multiA.id,
      );
      const destB = await fixture.service.resolveTransferDestination(
        scopeB,
        files.multiB.id,
      );
      expect(destA).toMatchObject({ outcome: "allow" });
      expect(destB).toMatchObject({ outcome: "allow" });
      if (destA.outcome === "allow" && destB.outcome === "allow") {
        expect(destA.botAgentId).not.toBe(destB.botAgentId);
      }
      // 幂等：同 scope 重复解析得到同一 Bot（工作区身份稳定）。
      const destAagain = await fixture.service.resolveTransferDestination(
        scopeA,
        files.multiA.id,
      );
      if (destA.outcome === "allow" && destAagain.outcome === "allow") {
        expect(destAagain.botAgentId).toBe(destA.botAgentId);
      }
    },
  );

  itDb(
    "跨公司解析他人/别司文件 = canonical not-found（工作区互相不可见）",
    async () => {
      // multi-company 在 B 上下文解析自己在 A pin 的文件：不可见。
      const scopeB = await scopeAs("multi-company", companyB, teamB1);
      const cross = await fixture.service.resolveTransferDestination(
        scopeB,
        files.multiA.id,
      );
      expect(isCanonicalNotFound(cross)).toBe(true);
      // 同团队他人也不可见。
      const scopeOther = await scopeAs("a1-other", companyA, teamA1);
      const teammate = await fixture.service.resolveTransferDestination(
        scopeOther,
        files.a1.id,
      );
      expect(isCanonicalNotFound(teammate)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// AC4：外部文件引用按归属解析，不能凭 ID 跨范围取用
// ---------------------------------------------------------------------------

describeDb("MT061 AC4：外部引用按归属解析", () => {
  itDb("导入来源键在归属范围内解析成功（attribution=import）", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const resolved = await fixture.service.resolveExternalReference(scope, {
      sourceKey: "gmail:t-1:m-1:att-1:import-1",
    });
    expect(resolved).toMatchObject({
      outcome: "allow",
      file: { id: files.imported.id },
      ownership: { attribution: "import" },
    });
  });

  itDb("同一账号在另一公司凭同一键取用 = canonical not-found", async () => {
    // multi-company 与 a1-member 不是同一人——键收敛是 owner 级的，先
    // 折叠 not-found；真正的「同账号跨公司」用 multi 的双公司文件验。
    const scopeOther = await scopeAs("a1-other", companyA, teamA1);
    const foreign = await fixture.service.resolveExternalReference(scopeOther, {
      sourceKey: "gmail:t-1:m-1:att-1:import-1",
    });
    expect(isCanonicalNotFound(foreign)).toBe(true);

    // 同账号跨公司：multi 在 A 导入、从 B 取用。
    const ownerUserId = fixture.ids["user-multi-company"];
    const sourceKey = "gmail:t-9:m-9:att-9:import-9";
    const fileId = await fixture.seedFile({
      ownerUserId,
      idempotencyKey: sourceKey,
    });
    const scopeA = await scopeAs("multi-company", companyA, teamA1);
    await fixture.service.pinFileScope(scopeA, {
      fileId,
      attribution: "import",
    });
    const fromA = await fixture.service.resolveExternalReference(scopeA, {
      sourceKey,
    });
    expect(fromA).toMatchObject({ outcome: "allow" });
    const scopeB = await scopeAs("multi-company", companyB, teamB1);
    const fromB = await fixture.service.resolveExternalReference(scopeB, {
      sourceKey,
    });
    expect(isCanonicalNotFound(fromB)).toBe(true);
  });

  itDb("未 pin 的文件（无归属）与不存在的键同形 not-found", async () => {
    const ownerUserId = fixture.ids["user-a1-member"];
    const unpinned = await fixture.seedFile({ ownerUserId });
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const resolved = await fixture.service.resolveExternalReference(scope, {
      sourceKey: "gmail:unpinned",
    });
    expect(isCanonicalNotFound(resolved)).toBe(true);
    // 直接凭 ID 读未 pin 的文件同样不可见（不能凭 ID 跨范围取用）。
    const direct = await fixture.service.readFile(scope, unpinned);
    expect(isCanonicalNotFound(direct)).toBe(true);
  });
});
