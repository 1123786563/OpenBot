// server/tests/multitenancy/openmuse-activity-notifications.test.ts
// MT065（Issue #108）：OpenMuse 活动流与通知的归属与正文过滤。
//
// 验收事实源（Issue #108 四条，逐条对应 describe；真实 PostgreSQL，全程受
// 限 ob_ent_* 角色 + 真实 RLS + 真实投递判定门 + 真实 MT064 pin 面，绝不
// 回退开发库、缺 env 显式 skip）：
//   AC1 活动流只包含当前范围条目；切换范围后不显示旧范围条目——聚合读
//     按协会三元组过滤两源（通知 + 审阅动作）；同账号切换公司立即换集
//     合，旧范围条目结构性不在结果里。
//   AC2 通知投递前校验接收者权限；无权者不收到且正文不泄露内容——
//     authorizeNotificationDelivery 只有 allow 携带正文；一切拒绝 = MT011
//     canonical RESOURCE_NOT_FOUND（形状上无正文字段）。
//   AC3 撤销权限后停止后续投递，已投递内容不可被无权者读取——suspend
//     后通知门/渠道门一律拒绝；readNotification 对无权者 = not-found
//     （已投递行仍在，读不到）。
//   AC4 通知渠道与推送设备绑定到具体用户与范围——delivery binding 协会
//     行钉 (用户, 三元组)；渠道投递门按三元组判定（推送设备对应面在
//     MT066 套件）。
//
// 结构（新文件；迁移经真实 MT003 工具 generate→apply→replay 收敛钉死）。

import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
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
  createOpenMuseActivityFixture,
  type OpenMuseActivityFixture,
  type OpenMuseActivityIdentity,
} from "./support/openmuse-activity-notifications";

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
      reason: `MT065 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

let fixture: OpenMuseActivityFixture;
let companyA = "";
let companyB = "";
let teamA1 = "";
let teamA2 = "";
let teamB1 = "";
/**
 * b1-member 的受信 Scope：在 beforeAll（撤权发生前）解析一次并缓存——
 * AC1 的撤权用例停用该成员后，AC3 复用同一 Scope 输入验证判定门的活查
 * 语义（门内重验，而非 resolve 时拒绝）。
 */
let revokedB1Scope: PlatformScope;
const suiteGeneratedDirs: string[] = [];
const randomSuiteToken = () => Math.random().toString(36).slice(2, 10);

/** 共享对象图：每条 = {id, ownerIdentity}。 */
const notifications: Record<string, { id: string; ownerIdentity: string }> = {};
const bindings: Record<string, { id: string; ownerIdentity: string }> = {};
const reviewed: Record<string, { id: string; ownerIdentity: string }> = {};

const scopeAs = (
  identity: OpenMuseActivityIdentity,
  tenantId: string,
  workspaceId: string,
): Promise<PlatformScope> => fixture.scopeAs(identity, tenantId, workspaceId);

const seedAndPinNotification = async (
  key: string,
  identity: OpenMuseActivityIdentity,
  tenantId: string,
  workspaceId: string,
  input?: { readonly title?: string; readonly detail?: string },
) => {
  const ownerUserId = fixture.ids[`user-${identity}`];
  const notificationId = await fixture.seedNotification({
    ownerUserId,
    title: input?.title ?? `MT065 notification ${key}`,
    detail: input?.detail ?? `secret detail for ${key}`,
  });
  const scope = await scopeAs(identity, tenantId, workspaceId);
  const result = await fixture.service.pinNotificationScope(scope, {
    notificationId,
  });
  if (!("status" in result) || result.status !== "pinned") {
    throw new Error(`pin failed: ${JSON.stringify(result)}`);
  }
  notifications[key] = { id: notificationId, ownerIdentity: identity };
  return notificationId;
};

const seedAndPinBinding = async (
  key: string,
  identity: OpenMuseActivityIdentity,
  tenantId: string,
  workspaceId: string,
) => {
  const ownerUserId = fixture.ids[`user-${identity}`];
  const bindingId = await fixture.seedBinding({ ownerUserId });
  const scope = await scopeAs(identity, tenantId, workspaceId);
  const result = await fixture.service.pinDeliveryBindingScope(scope, {
    bindingId,
  });
  if (!("status" in result) || result.status !== "pinned") {
    throw new Error(`pin failed: ${JSON.stringify(result)}`);
  }
  bindings[key] = { id: bindingId, ownerIdentity: identity };
  return bindingId;
};

const seedAndPinReviewed = async (
  key: string,
  identity: OpenMuseActivityIdentity,
  tenantId: string,
  workspaceId: string,
) => {
  const ownerUserId = fixture.ids[`user-${identity}`];
  const actionId = await fixture.seedReviewedAction(ownerUserId);
  const scope = await scopeAs(identity, tenantId, workspaceId);
  const result = await fixture.reviewedTenancy.pinReviewedActionScope(scope, {
    actionId,
  });
  if (!("status" in result) || result.status !== "pinned") {
    throw new Error(`pin failed: ${JSON.stringify(result)}`);
  }
  reviewed[key] = { id: actionId, ownerIdentity: identity };
  return actionId;
};

beforeAll(async () => {
  if (!ENV.ok) return;

  // MT065 migration through the real MT003 tool: generate → apply → replay
  // is convergent (applied on a fresh database, up-to-date on replay).
  if (!resolveTestDatabaseTarget(process.env).ok) {
    throw new Error(
      "MT065 migration target refused: TEST_DATABASE_URL invalid",
    );
  }
  const dir = join("/tmp", `mt065-migration-${randomSuiteToken()}`);
  suiteGeneratedDirs.push(dir);
  const generation = await runMigrateTest(["generate", "MT065", "--out", dir], {
    environment: process.env,
    out: () => {},
  });
  if (generation.kind !== "generated") {
    throw new Error(`MT065 generate failed: ${JSON.stringify(generation)}`);
  }
  const manifestPath = join(dir, "MT065", "manifest.json");
  const applied: RunOutcome = await runMigrateTest(
    ["migrate", "MT065", "--apply", "--manifest", manifestPath],
    { environment: process.env, out: () => {} },
  );
  if (!["applied", "up-to-date"].includes(applied.kind)) {
    throw new Error(`MT065 apply failed: ${JSON.stringify(applied)}`);
  }
  const replay = await runMigrateTest(
    ["migrate", "MT065", "--apply", "--manifest", manifestPath],
    { environment: process.env, out: () => {} },
  );
  if (replay.kind !== "up-to-date") {
    throw new Error(`MT065 replay not convergent: ${JSON.stringify(replay)}`);
  }

  fixture = await createOpenMuseActivityFixture();
  companyA = fixture.ids["company-a"];
  companyB = fixture.ids["company-b"];
  teamA1 = fixture.ids["team-a1"];
  teamA2 = fixture.ids["team-a2"];
  teamB1 = fixture.ids["team-b1"];

  // Shared graph: notifications/reviewed actions per (identity × scope), one
  // foreign teammate notification, one multi-company pair, bindings for AC4.
  await seedAndPinNotification("a1", "a1-member", companyA, teamA1);
  await seedAndPinNotification("other", "a1-other", companyA, teamA1);
  await seedAndPinNotification("a2", "a1a2-member", companyA, teamA2);
  await seedAndPinNotification("b1", "b1-member", companyB, teamB1);
  await seedAndPinNotification("multiA", "multi-company", companyA, teamA1);
  await seedAndPinNotification("multiB", "multi-company", companyB, teamB1);
  await seedAndPinReviewed("revA1", "a1-member", companyA, teamA1);
  await seedAndPinReviewed("revB1", "b1-member", companyB, teamB1);
  await seedAndPinBinding("bindA1", "a1-member", companyA, teamA1);
  await seedAndPinBinding("bindB1", "b1-member", companyB, teamB1);
  await seedAndPinBinding("bindMultiA", "multi-company", companyA, teamA1);
  // 撤权用例的 Scope 输入：撤权前解析（之后 scopeAs 会活查拒绝）。
  revokedB1Scope = await scopeAs("b1-member", companyB, teamB1);
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
// AC1：活动流只包含当前范围条目；切换范围后不显示旧范围条目
// ---------------------------------------------------------------------------

describeDb("MT065 AC1：范围化活动流", () => {
  itDb(
    "活动流只含当前三元组条目（通知 + 审阅动作两源；同团队他人零泄漏）",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const { entries } = await fixture.service.listScopedActivity(scope, {
        limit: 100,
      });
      const ids = entries.map((entry) => entry.id).sort();
      expect(ids).toEqual([notifications.a1.id, reviewed.revA1.id].sort());
      for (const entry of entries) {
        expect(entry.tenantId).toBe(companyA);
        expect(entry.workspaceId).toBe(teamA1);
        expect(entry.principalId).toBe(fixture.ids["principal-a1-member"]);
        expect(entry.userId).toBe(fixture.ids["user-a1-member"]);
      }
      // 同团队另一人的通知/审阅动作从不出现在别人的活动流里。
      expect(ids).not.toContain(notifications.other.id);
    },
  );

  itDb("切换范围后不显示旧范围条目：同账号 A→B→A 互斥切换", async () => {
    const scopeA = await scopeAs("multi-company", companyA, teamA1);
    const inA = await fixture.service.listScopedActivity(scopeA, {
      limit: 100,
    });
    expect(inA.entries.map((entry) => entry.id)).toEqual([
      notifications.multiA.id,
    ]);
    // 切换到 B：同一用户的另一个三元组——旧范围条目立即不在。
    const scopeB = await scopeAs("multi-company", companyB, teamB1);
    const inB = await fixture.service.listScopedActivity(scopeB, {
      limit: 100,
    });
    expect(inB.entries.map((entry) => entry.id)).toEqual([
      notifications.multiB.id,
    ]);
    expect(inB.entries.map((entry) => entry.id)).not.toContain(
      notifications.multiA.id,
    );
    // 切回 A：B 的条目同样不在（每次读取都是当前三元组的活查）。
    const backA = await fixture.service.listScopedActivity(scopeA, {
      limit: 100,
    });
    expect(backA.entries.map((entry) => entry.id)).toEqual([
      notifications.multiA.id,
    ]);
  });

  itDb("跨团队上下文不可见：A2 活动流为空（无 A1 条目）", async () => {
    const scopeA2 = await scopeAs("a1a2-member", companyA, teamA2);
    const { entries } = await fixture.service.listScopedActivity(scopeA2, {
      limit: 100,
    });
    // a1a2-member 在 A2 钉过自己的通知（a2）。
    expect(entries.map((entry) => entry.id)).toEqual([notifications.a2.id]);
    expect(entries.map((entry) => entry.id)).not.toContain(notifications.a1.id);
  });

  itDb("公司级撤权后活动流响亮拒绝（SCOPE_REVOKED）", async () => {
    // 本用例执行 b1-member 的撤权（一次性事实，后续 AC3 复用）。
    await fixture.suspendCompanyMembership(
      companyB,
      fixture.ids["principal-b1-member"],
    );
    const listed = await thrownMessage(() =>
      fixture.service.listScopedActivity(revokedB1Scope, { limit: 10 }),
    );
    expect(listed).toBe("SCOPE_REVOKED");
  });
});

// ---------------------------------------------------------------------------
// AC2：通知投递前校验接收者权限；无权者不收到且正文不泄露内容
// ---------------------------------------------------------------------------

describeDb("MT065 AC2：投递判定门与正文过滤", () => {
  itDb("有权接收者 allow 携带正文（title/detail）", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const decision = await fixture.service.authorizeNotificationDelivery(
      scope,
      {
        notificationId: notifications.a1.id,
      },
    );
    expect(decision).toMatchObject({
      outcome: "allow",
      body: {
        title: `MT065 notification a1`,
        detail: "secret detail for a1",
      },
    });
  });

  itDb(
    "同团队他人不收到且正文不泄露：拒绝形状无正文字段、同形 not-found",
    async () => {
      const scope = await scopeAs("a1-other", companyA, teamA1);
      const decision = await fixture.service.authorizeNotificationDelivery(
        scope,
        {
          notificationId: notifications.a1.id,
        },
      );
      expect(isCanonicalNotFound(decision)).toBe(true);
      // 正文不泄露是形状：序列化结果里没有 title/detail。
      const serialized = JSON.stringify(decision);
      expect(serialized).not.toContain("secret detail");
      expect(serialized).not.toContain("title");
    },
  );

  itDb("跨范围（跨团队/跨公司同账号）不收到，与不存在同形", async () => {
    const scopeTeam = await scopeAs("a1a2-member", companyA, teamA2);
    const scopeCompany = await scopeAs("multi-company", companyB, teamB1);
    const missing = await fixture.service.authorizeNotificationDelivery(
      await scopeAs("a1-member", companyA, teamA1),
      { notificationId: "no-such-notification" },
    );
    for (const scope of [scopeTeam, scopeCompany]) {
      const decision = await fixture.service.authorizeNotificationDelivery(
        scope,
        { notificationId: notifications.a1.id },
      );
      expect(JSON.stringify(decision)).toBe(JSON.stringify(missing));
    }
  });
});

// ---------------------------------------------------------------------------
// AC3：撤销权限后停止后续投递，已投递内容不可被无权者读取
// ---------------------------------------------------------------------------

describeDb("MT065 AC3：撤权停投递与已投递内容不可读", () => {
  itDb("撤权后通知投递门与渠道投递门一律拒绝（停止后续投递）", async () => {
    // b1-member 已在 AC1 用例中被停用；此处复用撤权前解析的同一 Scope
    // 输入验证判定门的活查语义（门内成员重验，而非 resolve 时拒绝）。
    const notificationGate =
      await fixture.service.authorizeNotificationDelivery(revokedB1Scope, {
        notificationId: notifications.b1.id,
      });
    expect(isCanonicalNotFound(notificationGate)).toBe(true);
    const bindingGate = await fixture.service.authorizeBindingDelivery(
      revokedB1Scope,
      {
        bindingId: bindings.bindB1.id,
      },
    );
    expect(isCanonicalNotFound(bindingGate)).toBe(true);
  });

  itDb(
    "已投递内容不可被无权者读取：行仍在，他人/他范围 = not-found",
    async () => {
      const ownerScope = await scopeAs("a1-member", companyA, teamA1);
      const own = await fixture.service.readNotification(
        ownerScope,
        notifications.a1.id,
      );
      expect(own).toMatchObject({ outcome: "allow" });

      // 同团队他人：根行仍在库里，但读不到（不可见不是删除）。
      const mateScope = await scopeAs("a1-other", companyA, teamA1);
      const mate = await fixture.service.readNotification(
        mateScope,
        notifications.a1.id,
      );
      expect(isCanonicalNotFound(mate)).toBe(true);
      // 跨公司同账号同理。
      const foreignScope = await scopeAs("multi-company", companyB, teamB1);
      const foreign = await fixture.service.readNotification(
        foreignScope,
        notifications.a1.id,
      );
      expect(isCanonicalNotFound(foreign)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// AC4：通知渠道与推送设备绑定到具体用户与范围
// ---------------------------------------------------------------------------

describeDb("MT065 AC4：渠道绑定到用户与范围", () => {
  itDb("绑定协会行钉 (用户, 三元组)：重放幂等，异三元组响亮拒绝", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const again = await fixture.service.pinDeliveryBindingScope(scope, {
      bindingId: bindings.bindA1.id,
    });
    expect(again).toMatchObject({ status: "existing" });

    // 同一账号（multi-company）在另一公司上下文重 pin 自己的 A 绑定 =
    // MISMATCH（归属已钉在 A 三元组，且归属不可改写）。
    const otherScope = await scopeAs("multi-company", companyB, teamB1);
    const mismatch = await thrownMessage(() =>
      fixture.service.pinDeliveryBindingScope(otherScope, {
        bindingId: bindings.bindMultiA.id,
      }),
    );
    expect(mismatch).toContain("OPENMUSE_ACTIVITY_SCOPE_MISMATCH");
  });

  itDb(
    "渠道投递门按三元组放行：本人范围 allow，跨范围/撤权 not-found",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const allow = await fixture.service.authorizeBindingDelivery(scope, {
        bindingId: bindings.bindA1.id,
      });
      expect(allow).toMatchObject({
        outcome: "allow",
        binding: { id: bindings.bindA1.id, transport: "sms", enabled: true },
      });

      // 跨公司同账号对 A 绑定不可见。
      const foreignScope = await scopeAs("multi-company", companyB, teamB1);
      const foreign = await fixture.service.authorizeBindingDelivery(
        foreignScope,
        {
          bindingId: bindings.bindA1.id,
        },
      );
      expect(isCanonicalNotFound(foreign)).toBe(true);

      // 多公司账号自己的 B 绑定在 B 上下文 allow（绑定是逐范围的）。
      const ownB = await fixture.service.authorizeBindingDelivery(
        foreignScope,
        {
          bindingId: bindings.bindMultiA.id,
        },
      );
      expect(isCanonicalNotFound(ownB)).toBe(true);
    },
  );

  itDb("外来绑定（根行不存在/非本人）与不存在同形 not-found", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const missing = await fixture.service.authorizeBindingDelivery(scope, {
      bindingId: "no-such-binding",
    });
    const foreign = await fixture.service.authorizeBindingDelivery(scope, {
      bindingId: bindings.bindB1.id,
    });
    expect(isCanonicalNotFound(missing)).toBe(true);
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
  });
});
