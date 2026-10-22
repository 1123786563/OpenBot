// server/tests/multitenancy/openmuse-personal.test.ts
// MT062（Issue #105）：OpenMuse 目标、想法、记忆与财务产物的作用域。
//
// 验收事实源（Issue #105 四条，逐条对应 describe；真实 PostgreSQL，全程受限
// ob_ent_* 角色 + 真实 RLS + 真实 MT073 判定门，绝不回退开发库、缺 env 显式
// skip）：
//   AC1 个人域对象只对本人在当前范围可见；同团队他人不可读取——协会行三元
//     组（租户臂 RLS + restrictive 主体自读）先于一切根行读写；一切不可见
//     = MT011 canonical RESOURCE_NOT_FOUND 逐字节同形；列表零泄漏。
//   AC2 财务产物（含导出与附件）遵守账务可见性规则（与 MT073 一致）——
//     owner-scope 直读 or 同公司显式授权的公司财务读者；无授权管理员、
//     跨公司、同团队他人 = canonical not-found（MT073 单一 deny 形状）。
//   AC3 既有精确动作提案/确认/取消行为回归通过——本模块对既有
//     reviewed-actions 面零改动（纯新增）；回归由既有套件钉死（验证记录
//     见 run 的 verification/，此处断言迁移与协会表对其零触碰的事实面）。
//   AC4 删除与恢复只影响本范围对象——协会门先于根行 tombstone/revive；
//     跨范围 id = {outcome:"missing"} 且零根行副作用。
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
import {
  isResourceNotFoundVerdict,
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import {
  createOpenMusePersonalFixture,
  type OpenMusePersonalFixture,
  type OpenMusePersonalIdentity,
} from "./support/openmuse-personal";

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
      reason: `MT062 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

let fixture: OpenMusePersonalFixture;
let companyA = "";
let companyB = "";
let teamA1 = "";
let teamA2 = "";
let teamB1 = "";
const suiteGeneratedDirs: string[] = [];
const randomSuiteToken = () => Math.random().toString(36).slice(2, 10);

/** 共享对象图：每条 = {id, objectType, ownerIdentity}。 */
const objects: Record<
  string,
  {
    id: string;
    objectType: "goal" | "idea" | "memory" | "finance_artifact";
    ownerIdentity: OpenMusePersonalIdentity;
  }
> = {};

const scopeAs = (
  identity: OpenMusePersonalIdentity,
  tenantId: string,
  workspaceId: string,
): Promise<PlatformScope> => fixture.scopeAs(identity, tenantId, workspaceId);

const seedAndPin = async (
  key: string,
  objectType: "goal" | "idea" | "memory" | "finance_artifact",
  identity: OpenMusePersonalIdentity,
  tenantId: string,
  workspaceId: string,
) => {
  const ownerUserId = fixture.ids[`user-${identity}`];
  const objectId = await fixture.seedObject(objectType, { ownerUserId });
  const scope = await scopeAs(identity, tenantId, workspaceId);
  const result = await fixture.service.pinPersonalObject(scope, {
    objectType,
    objectId,
  });
  if (!("status" in result) || result.status !== "pinned") {
    throw new Error(`pin failed: ${JSON.stringify(result)}`);
  }
  objects[key] = { id: objectId, objectType, ownerIdentity: identity };
  return objectId;
};

beforeAll(async () => {
  if (!ENV.ok) return;

  // MT062 migration through the real MT003 tool: generate → apply → replay
  // is convergent (applied on a fresh database, up-to-date on replay).
  if (!resolveTestDatabaseTarget(process.env).ok) {
    throw new Error(
      "MT062 migration target refused: TEST_DATABASE_URL invalid",
    );
  }
  const dir = join("/tmp", `mt062-migration-${randomSuiteToken()}`);
  suiteGeneratedDirs.push(dir);
  const generation = await runMigrateTest(["generate", "MT062", "--out", dir], {
    environment: process.env,
    out: () => {},
  });
  if (generation.kind !== "generated") {
    throw new Error(`MT062 generate failed: ${JSON.stringify(generation)}`);
  }
  const manifestPath = join(dir, "MT062", "manifest.json");
  const applied: RunOutcome = await runMigrateTest(
    ["migrate", "MT062", "--apply", "--manifest", manifestPath],
    { environment: process.env, out: () => {} },
  );
  if (!["applied", "up-to-date"].includes(applied.kind)) {
    throw new Error(`MT062 apply failed: ${JSON.stringify(applied)}`);
  }
  const replay = await runMigrateTest(
    ["migrate", "MT062", "--apply", "--manifest", manifestPath],
    { environment: process.env, out: () => {} },
  );
  if (replay.kind !== "up-to-date") {
    throw new Error(`MT062 replay not convergent: ${JSON.stringify(replay)}`);
  }

  fixture = await createOpenMusePersonalFixture();
  companyA = fixture.ids["company-a"];
  companyB = fixture.ids["company-b"];
  teamA1 = fixture.ids["team-a1"];
  teamA2 = fixture.ids["team-a2"];
  teamB1 = fixture.ids["team-b1"];

  // Shared object graph: every personal kind in scope A1, a teammate's goal,
  // the other team, the other company, the multi-company pair, and finance
  // artifacts for the AC2 reader rules.
  await seedAndPin("goalA1", "goal", "a1-member", companyA, teamA1);
  await seedAndPin("ideaA1", "idea", "a1-member", companyA, teamA1);
  await seedAndPin("memoryA1", "memory", "a1-member", companyA, teamA1);
  await seedAndPin("goalOther", "goal", "a1-other", companyA, teamA1);
  await seedAndPin("goalA2", "goal", "a2-member", companyA, teamA2);
  await seedAndPin("goalB1", "goal", "b1-member", companyB, teamB1);
  await seedAndPin("goalMultiA", "goal", "multi-company", companyA, teamA1);
  await seedAndPin("goalMultiB", "goal", "multi-company", companyB, teamB1);
  await seedAndPin("finA1", "finance_artifact", "a1-member", companyA, teamA1);
  await seedAndPin("finB1", "finance_artifact", "b1-member", companyB, teamB1);

  // AC2's explicit grant, through the REAL MT073 service: finance-reader may
  // read company A's finance artifacts; the admin (tenant_admin) holds no
  // grant — 角色不自动获得财务读取。
  await fixture.finance.grantCompanyFinanceReader({
    tenantId: companyA,
    principalId: fixture.ids["principal-finance-reader"],
    grantedBy: fixture.ids["principal-company-admin"],
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
// AC1：个人域对象只对本人在当前范围可见；同团队他人不可读取
// ---------------------------------------------------------------------------

describeDb("MT062 AC1：个人域对象的范围化可见性", () => {
  itDb("列表只返回本人、所选团队范围内的对象；三类根表同纪律", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    for (const objectType of ["goal", "idea", "memory"] as const) {
      const { objects: listed } = await fixture.service.listPersonalObjects(
        scope,
        objectType,
        {
          limit: 100,
        },
      );
      const ids = listed.map((entry) => entry.ownership.objectId).sort();
      const expected = {
        goal: [objects.goalA1.id],
        idea: [objects.ideaA1.id],
        memory: [objects.memoryA1.id],
      }[objectType];
      expect(ids).toEqual([...expected].sort());
      for (const entry of listed) {
        expect(entry.ownership.tenantId).toBe(companyA);
        expect(entry.ownership.workspaceId).toBe(teamA1);
        expect(entry.ownership.principalId).toBe(
          fixture.ids["principal-a1-member"],
        );
        expect(entry.ownership.userId).toBe(fixture.ids["user-a1-member"]);
      }
      // 同团队他人的对象从不出现在别人的列表里。
      expect(ids).not.toContain(objects.goalOther.id);
    }
  });

  itDb("同团队他人读取 = canonical not-found（个人权限半边）", async () => {
    const scope = await scopeAs("a1-other", companyA, teamA1);
    for (const [key, objectType] of [
      ["goalA1", "goal"],
      ["ideaA1", "idea"],
      ["memoryA1", "memory"],
    ] as const) {
      const read = await fixture.service.readPersonalObject(
        scope,
        objectType,
        objects[key].id,
      );
      expect(isCanonicalNotFound(read)).toBe(true);
    }
    // 列表视角 = 永远空页（与「该人没有对象」不可区分）。
    const { objects: listed } = await fixture.service.listPersonalObjects(
      scope,
      "goal",
      { limit: 100 },
    );
    expect(
      listed.filter(
        (entry) => entry.ownership.userId === fixture.ids["user-a1-member"],
      ),
    ).toEqual([]);
  });

  itDb("跨团队与跨公司：A2/B 上下文对 A1 对象零触达", async () => {
    const scopeA2 = await scopeAs("a2-member", companyA, teamA2);
    const readA2 = await fixture.service.readPersonalObject(
      scopeA2,
      "goal",
      objects.goalA1.id,
    );
    expect(isCanonicalNotFound(readA2)).toBe(true);

    const scopeB = await scopeAs("multi-company", companyB, teamB1);
    const readB = await fixture.service.readPersonalObject(
      scopeB,
      "goal",
      objects.goalMultiA.id,
    );
    expect(isCanonicalNotFound(readB)).toBe(true);
    const { objects: listedB } = await fixture.service.listPersonalObjects(
      scopeB,
      "goal",
      { limit: 100 },
    );
    expect(listedB.map((entry) => entry.ownership.objectId)).toEqual([
      objects.goalMultiB.id,
    ]);
  });

  itDb("公司级撤权后列表响亮拒绝，对象面折叠为不可见", async () => {
    const scope = await scopeAs("b1-member", companyB, teamB1);
    await fixture.suspendCompanyMembership(
      companyB,
      fixture.ids["principal-b1-member"],
    );
    const listed = await thrownMessage(() =>
      fixture.service.listPersonalObjects(scope, "goal", { limit: 10 }),
    );
    expect(listed).toBe("SCOPE_REVOKED");
    const read = await fixture.service.readPersonalObject(
      scope,
      "goal",
      objects.goalB1.id,
    );
    expect(isCanonicalNotFound(read)).toBe(true);
  });

  itDb("pin：同三元组幂等 existing；不同选择标识响亮拒绝", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const again = await fixture.service.pinPersonalObject(scope, {
      objectType: "goal",
      objectId: objects.goalA1.id,
    });
    expect(again).toMatchObject({ status: "existing" });

    const scopeB = await scopeAs("multi-company", companyB, teamB1);
    const mismatch = await thrownMessage(() =>
      fixture.service.pinPersonalObject(scopeB, {
        objectType: "goal",
        objectId: objects.goalMultiA.id,
      }),
    );
    expect(mismatch).toContain("OPENMUSE_PERSONAL_SCOPE_MISMATCH");

    // 外来对象（非本人根行）与不存在不可区分。
    const scopeOther = await scopeAs("a1-other", companyA, teamA1);
    const foreign = await fixture.service.pinPersonalObject(scopeOther, {
      objectType: "goal",
      objectId: objects.goalA1.id,
    });
    expect(isCanonicalNotFound(foreign)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2：财务产物遵守账务可见性规则（与 MT073 一致）
// ---------------------------------------------------------------------------

describeDb("MT062 AC2：财务产物的账务可见性", () => {
  itDb("owner 在归属范围内直读（via=owner-scope）", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const read = await fixture.service.readFinanceArtifact(
      scope,
      objects.finA1.id,
    );
    expect(read).toMatchObject({
      outcome: "allow",
      via: "owner-scope",
      ownership: { tenantId: companyA },
    });
  });

  itDb(
    "同公司显式授权的财务读者可读（via=company-finance-reader）",
    async () => {
      const scope = await scopeAs("finance-reader", companyA, teamA1);
      const read = await fixture.service.readFinanceArtifact(
        scope,
        objects.finA1.id,
      );
      expect(read).toMatchObject({
        outcome: "allow",
        via: "company-finance-reader",
        ownership: { tenantId: companyA },
      });
    },
  );

  itDb(
    "无授权的 tenant_admin = canonical not-found（角色不自动获得）",
    async () => {
      // company-admin 无团队成员资格也无授权行——MT073 判定门同形拒绝。
      const scope = await scopeAs("company-admin", companyA, teamA1);
      const read = await fixture.service.readFinanceArtifact(
        scope,
        objects.finA1.id,
      );
      expect(isCanonicalNotFound(read)).toBe(true);
    },
  );

  itDb(
    "同团队普通成员（无授权）与跨公司读者 = canonical not-found",
    async () => {
      const scope = await scopeAs("a1-other", companyA, teamA1);
      const read = await fixture.service.readFinanceArtifact(
        scope,
        objects.finA1.id,
      );
      expect(isCanonicalNotFound(read)).toBe(true);

      // B 公司成员（未被撤权的 multi-company B 侧）读 A 公司的财务产物：
      // B 侧无授权行 → 判定门同形拒绝 → not-found（跨公司结构性不可见）。
      const scopeB = await scopeAs("multi-company", companyB, teamB1);
      const readB = await fixture.service.readFinanceArtifact(
        scopeB,
        objects.finA1.id,
      );
      expect(isCanonicalNotFound(readB)).toBe(true);
    },
  );

  itDb("财务读者的授权撤销后立即不可读（活查语义）", async () => {
    const grant = await fixture.finance.revokeCompanyFinanceReader({
      tenantId: companyA,
      principalId: fixture.ids["principal-finance-reader"],
    });
    expect(grant.revoked).toBe(true);
    const scope = await scopeAs("finance-reader", companyA, teamA1);
    const read = await fixture.service.readFinanceArtifact(
      scope,
      objects.finA1.id,
    );
    expect(isCanonicalNotFound(read)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC3：既有精确动作提案/确认/取消行为回归（零改动事实面）
// ---------------------------------------------------------------------------

describeDb("MT062 AC3：既有 reviewed-actions 行为零改动（回归事实面）", () => {
  itDb(
    "本票迁移只新增 openmuse_personal_scopes，不触碰 reviewed-actions 对象",
    async () => {
      // 迁移步的对象清单是可对照的事实：expand-only，无既有对象。
      const { TASKS } = await import("../../scripts/multitenancy/migrate-test");
      const task = TASKS.get("MT062");
      expect(task).toBeDefined();
      const touched = new Set(
        (task?.steps ?? []).flatMap((step) => step.objects),
      );
      expect([...touched]).toEqual(["openmuse_personal_scopes"]);
      // 行为回归本体在既有套件（openmuse-reviewed-actions*），验证记录见
      // 本 run 的 verification/；此处钉死「零改动」的结构事实。
      expect(touched.has("openmuse_reviewed_actions")).toBe(false);
      expect(touched.has("openmuse_reviewed_attempts")).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// AC4：删除与恢复只影响本范围对象
// ---------------------------------------------------------------------------

describeDb("MT062 AC4：范围化删除与恢复", () => {
  itDb("scopedDelete tombstone 本范围对象；scopedRestore 复活", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const deleted = await fixture.service.scopedDelete(
      scope,
      "idea",
      objects.ideaA1.id,
    );
    expect(deleted).toMatchObject({ outcome: "deleted" });
    expect(await fixture.objectTombstoned("idea", objects.ideaA1.id)).toBe(
      true,
    );
    // 删除后读取不可见。
    const read = await fixture.service.readPersonalObject(
      scope,
      "idea",
      objects.ideaA1.id,
    );
    expect(isCanonicalNotFound(read)).toBe(true);

    const restored = await fixture.service.scopedRestore(
      scope,
      "idea",
      objects.ideaA1.id,
    );
    expect(restored).toMatchObject({ outcome: "restored" });
    expect(await fixture.objectTombstoned("idea", objects.ideaA1.id)).toBe(
      false,
    );
    const readAgain = await fixture.service.readPersonalObject(
      scope,
      "idea",
      objects.ideaA1.id,
    );
    expect(readAgain).toMatchObject({ outcome: "allow" });
  });

  itDb("跨范围删除 = missing 且零根行副作用", async () => {
    const scopeOther = await scopeAs("a1-other", companyA, teamA1);
    const outcome = await fixture.service.scopedDelete(
      scopeOther,
      "goal",
      objects.goalA1.id,
    );
    expect(outcome).toEqual({ outcome: "missing" });
    expect(await fixture.objectTombstoned("goal", objects.goalA1.id)).toBe(
      false,
    );

    // 同账号另一公司上下文同样零触达。
    const scopeB = await scopeAs("multi-company", companyB, teamB1);
    const cross = await fixture.service.scopedDelete(
      scopeB,
      "goal",
      objects.goalMultiA.id,
    );
    expect(cross).toEqual({ outcome: "missing" });
    expect(await fixture.objectTombstoned("goal", objects.goalMultiA.id)).toBe(
      false,
    );
  });

  itDb("跨范围恢复 = missing；未删除对象的恢复也只作用于本范围", async () => {
    const scopeOther = await scopeAs("a1-other", companyA, teamA1);
    const cross = await fixture.service.scopedRestore(
      scopeOther,
      "goal",
      objects.goalA1.id,
    );
    expect(cross).toEqual({ outcome: "missing" });

    // 本范围删除后由他范围恢复：missing，tombstone 保持。
    const scope = await scopeAs("a1-member", companyA, teamA1);
    await fixture.service.scopedDelete(scope, "memory", objects.memoryA1.id);
    const foreignRestore = await fixture.service.scopedRestore(
      scopeOther,
      "memory",
      objects.memoryA1.id,
    );
    expect(foreignRestore).toEqual({ outcome: "missing" });
    expect(await fixture.objectTombstoned("memory", objects.memoryA1.id)).toBe(
      true,
    );
    // owner 自己恢复成功。
    const own = await fixture.service.scopedRestore(
      scope,
      "memory",
      objects.memoryA1.id,
    );
    expect(own).toMatchObject({ outcome: "restored" });
  });
});
