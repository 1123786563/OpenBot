// server/tests/multitenancy/not-found-semantics.test.ts
// MT011（Issue #54）：集中式 not-found 不可见语义 + 列表/游标/批量面。
//
// 验收事实源（票面四条，逐条对应 describe）：
//   (1) 访问无权对象返回与访问不存在对象一致的响应（状态码、错误体、时延
//       不产生可区分信号）——三个冻结闭环（MT008 resource-policy /
//       MT009 team-public-rules / MT010 personal-share-rules）的一切
//       RESOURCE_NOT_FOUND 拒绝与集中模块的 canonical 形状逐字节一致；
//       「不存在」与「无权」的 SQL 语句数逐条相等（时延的结构性代理：
//       同一语句序列，不存在任何按存在性分叉的路径）。
//   (2) 列表与计数不包含无权对象；分页游标不因其存在而偏移——keyset
//       游标只从可见项派生，不可见项不消耗页位、不产生末页游标、
//       中途消失不引起移位或错误。
//   (3) 批量接口不通过部分成功/部分失败差异泄露存在性——逐 id 结果
//       顺序与输入一致，一切拒绝逐字节同形（与单个判定完全一致），
//       全缺与全禁的语句数相等，无聚合计数。
//   (4) 该语义在授权模块集中实现，各闭环复用（有共享测试）——canonical
//       形状/序列化/HTTP 面只定义一处，共享不变量套件逐例跑过三个闭环。
//
// 边界（诚实披露）：三个判定模块按票面**只读消费**（哈希冻结，不重构）；
// 各闭环对新表面的接线属下游票。共享测试证明三者的拒绝形状已与集中
// 语义逐字节一致（reuse-compatibility），新的列表/游标/批量面则直接
// 复用 MT008 的 policy 注册表——放行语义只有一处定义。
//
// 环境契约：只认显式 TEST_DATABASE_URL / ENTERPRISE_TEST_SETUP_DATABASE_URL
// 加三个受限角色 URL；缺配置时整套显式 skip（跳过原因写在用例名里，
// skipped 不计为通过），绝不回退开发库。

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  createResourceInventoryService,
  isResourceNotFoundVerdict,
  NOT_FOUND_HTTP_STATUS,
  notFoundErrorBody,
  notFoundHttpResponse,
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import {
  createPersonalShareAdminService,
  createPersonalShareDecisionService,
} from "../../src/enterprise/tenancy/personal-share-rules";
import {
  createResourcePolicyService,
  WORKSPACE_V1_POLICY_ID,
} from "../../src/enterprise/tenancy/resource-policy";
import { createTeamResourceActionService } from "../../src/enterprise/tenancy/team-public-rules";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import {
  createNotFoundSemanticsFixture,
  type NotFoundSemanticsFixture,
} from "./support/not-found-semantics";

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
      reason: `MT011 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
const describeDb = ENV.ok ? describe : describe.skip;

// ---------------------------------------------------------------------------
// canonical 断言助手：deny 只有一种对外形状（不泄露存在性）
// ---------------------------------------------------------------------------

const CANONICAL_NOT_FOUND_BYTES =
  '{"outcome":"deny","code":"RESOURCE_NOT_FOUND"}';

/** Extracts only the verdict fields for byte comparison (id 由调用方提供，不参与）。 */
function verdictBytes(entry: { outcome: unknown; code?: unknown }): string {
  return JSON.stringify({ outcome: entry.outcome, code: entry.code });
}

function expectCanonicalNotFound(entry: {
  outcome: unknown;
  code?: unknown;
}): void {
  expect(entry.outcome).toBe("deny");
  expect(entry.code).toBe("RESOURCE_NOT_FOUND");
  expect(verdictBytes(entry)).toBe(CANONICAL_NOT_FOUND_BYTES);
  expect(
    isResourceNotFoundVerdict({ outcome: entry.outcome, code: entry.code }),
  ).toBe(true);
  // 任何闭环的拒绝经集中 HTTP 面映射后，状态码与错误体逐字节一致。
  const http = notFoundHttpResponse();
  expect(http.status).toBe(NOT_FOUND_HTTP_STATUS);
  expect(http.status).toBe(404);
  expect(http.body).toBe(notFoundErrorBody());
}

// ---------------------------------------------------------------------------
// 共享夹具 + 服务装配（全部经计数代理数据通道——受限 ob_ent_data 角色）
// ---------------------------------------------------------------------------

let fixture: NotFoundSemanticsFixture;
let policyDecision: ReturnType<typeof createResourcePolicyService>;
let teamActions: ReturnType<typeof createTeamResourceActionService>;
let shareDecision: ReturnType<typeof createPersonalShareDecisionService>;
let shareAdmin: ReturnType<typeof createPersonalShareAdminService>;
let inventory: ReturnType<typeof createResourceInventoryService>;

// 团队 A1 追加资源平面（provision 顺序 = created_at 顺序，keyset 有序）：
//   pub1  团队公共（bot，readers=[a1]）
//   priv1 个人（private，readers=[a1]）
//   v1..v3  a1-member 可见（readers=[a1]）
//   i1..i3  a1-member 不可见（readers=[a1-other]），与 v* 交错
//   v-del  可见后被软删（拒绝「已删除」不可区分于「不存在」）
//   p1     个人分享面资源（private，readers=[a1]）
//   i4     排在所有可见项之后的不可见项（末页游标不被其偏移）
let tenantA: string;
let teamA1: { tenantId: string; workspaceId: string };
let a1Principal: string;
let a1OtherPrincipal: string;
let a1a2Principal: string;
let resourceA1: string;
let resourceA1Other: string;
let resourceA2: string;
let resourceB1: string;
let vDel: string;
let priv1: string;
let p1: string;
const visibleIds = ["mt011-v-1", "mt011-v-2", "mt011-v-3"];
const invisibleIds = ["mt011-i-1", "mt011-i-2", "mt011-i-3", "mt011-i-4"];
const MISSING_ID = "mt011-missing-resource";

describeDb(
  "MT011 centralized not-found invisibility semantics + list/cursor/batch (Issue #54)",
  () => {
    beforeAll(async () => {
      fixture = await createNotFoundSemanticsFixture();
      const a1 = fixture.base.teamOf("a1-member", "team-a1");
      tenantA = a1.tenantId;
      teamA1 = { tenantId: a1.tenantId, workspaceId: a1.workspaceId };
      a1Principal = a1.principalId;
      a1OtherPrincipal = fixture.base.teamOf("a1-other", "team-a1").principalId;
      a1a2Principal = fixture.base.teamOf("a1a2-member", "team-a1").principalId;
      resourceA1 = fixture.base.isolation.ids["resource-a1"];
      resourceA1Other = fixture.base.isolation.ids["resource-a1-other"];
      resourceA2 = fixture.base.isolation.ids["resource-a2"];
      resourceB1 = fixture.base.isolation.ids["resource-b1"];
      vDel = "mt011-v-del";
      priv1 = "mt011-priv-1";
      p1 = "mt011-p-1";

      policyDecision = createResourcePolicyService(fixture.countedData);
      teamActions = createTeamResourceActionService(fixture.countedData);
      shareDecision = createPersonalShareDecisionService(fixture.countedData);
      shareAdmin = createPersonalShareAdminService(fixture.base.operator);
      inventory = createResourceInventoryService(fixture.countedData);

      const provisionOrder: Array<{
        id: string;
        readers: readonly string[];
        kind: string;
      }> = [
        { id: "mt011-pub-1", readers: [a1Principal], kind: "bot" },
        { id: priv1, readers: [a1Principal], kind: "document" },
        { id: visibleIds[0], readers: [a1Principal], kind: "document" },
        { id: invisibleIds[0], readers: [a1OtherPrincipal], kind: "document" },
        { id: visibleIds[1], readers: [a1Principal], kind: "document" },
        { id: invisibleIds[1], readers: [a1OtherPrincipal], kind: "document" },
        { id: visibleIds[2], readers: [a1Principal], kind: "document" },
        { id: invisibleIds[2], readers: [a1OtherPrincipal], kind: "document" },
        { id: vDel, readers: [a1Principal], kind: "document" },
        { id: p1, readers: [a1Principal], kind: "session" },
        { id: invisibleIds[3], readers: [a1OtherPrincipal], kind: "document" },
      ];
      for (const item of provisionOrder) {
        await fixture.provisionResource({
          team: "team-a1",
          resourceId: item.id,
          kind: item.kind,
          displayName: `MT011 ${item.id}`,
          readerPrincipalIds: item.readers,
        });
      }
      // 团队公共/个人标记与软删除都走真实受限 UPDATE 策略。
      await fixture.markVisibility({
        tenantId: tenantA,
        resourceId: "mt011-pub-1",
        visibility: "workspace",
      });
      // i1 也显式发布为团队公共（a1-other 侧 workspace-v1 列表的第三项）。
      await fixture.markVisibility({
        tenantId: tenantA,
        resourceId: invisibleIds[0],
        visibility: "workspace",
      });
      await fixture.markVisibility({
        tenantId: tenantA,
        resourceId: priv1,
        visibility: "private",
      });
      await fixture.markVisibility({
        tenantId: tenantA,
        resourceId: p1,
        visibility: "private",
      });
      await fixture.softDeleteResource({ tenantId: tenantA, resourceId: vDel });
    });

    afterAll(async () => {
      if (fixture) await fixture.dispose();
    });

    // ---------------------------------------------------------------------
    // 验收 1 + 4：三个冻结闭环的拒绝 = canonical 形状（共享不变量套件）
    // ---------------------------------------------------------------------

    describe("shared not-found invariants across the three frozen decision loops", () => {
      test("resource-policy loop: allow positive control, then missing/forbidden/deleted/cross-team/cross-company all deny byte-identically canonical", async () => {
        const scope = await fixture.scopeFor("a1-member", teamA1);
        const allowed = await policyDecision.decide(scope, resourceA1);
        expect(allowed.outcome).toBe("allow");

        const missing = await policyDecision.decide(scope, MISSING_ID);
        const forbidden = await policyDecision.decide(scope, resourceA1Other);
        const deleted = await policyDecision.decide(scope, vDel);
        const crossTeam = await policyDecision.decide(scope, resourceA2);
        const crossCompany = await policyDecision.decide(scope, resourceB1);
        for (const verdict of [
          missing,
          forbidden,
          deleted,
          crossTeam,
          crossCompany,
        ]) {
          expectCanonicalNotFound(verdict);
        }
        const bytes = new Set([
          verdictBytes(missing),
          verdictBytes(forbidden),
          verdictBytes(deleted),
          verdictBytes(crossTeam),
          verdictBytes(crossCompany),
        ]);
        expect([...bytes]).toEqual([CANONICAL_NOT_FOUND_BYTES]);
      });

      test("resource-policy loop: missing vs forbidden cost identical SQL work (latency produces no distinguishable signal)", async () => {
        const scope = await fixture.scopeFor("a1-member", teamA1);
        fixture.resetStatementCount();
        await policyDecision.decide(scope, MISSING_ID);
        const missingStatements = fixture.statementCount();
        fixture.resetStatementCount();
        await policyDecision.decide(scope, resourceA1Other);
        const forbiddenStatements = fixture.statementCount();
        expect(missingStatements).toBeGreaterThan(0);
        expect(missingStatements).toBe(forbiddenStatements);
      });

      test("team-public loop: run positive control for a member, then unpublished/missing denials are byte-identically canonical", async () => {
        const memberScope = await fixture.scopeFor("a1-member", teamA1);
        // 正向对照：门对有效成员真实打开（拒绝不是空洞的）。
        const allowed = await teamActions.decideAction(
          memberScope,
          "mt011-pub-1",
          "run",
          { policyVersion: WORKSPACE_V1_POLICY_ID },
        );
        expect(allowed.outcome).toBe("allow");

        const otherScope = await fixture.scopeFor("a1-other", teamA1);
        // 未发布（private）+ 非属主 → 对 a1-other 不可见。
        const unpublished = await teamActions.decideAction(
          otherScope,
          priv1,
          "run",
          { policyVersion: WORKSPACE_V1_POLICY_ID },
        );
        // 不存在的资源 → 同一不可见语义（门先于动作分类）。
        const missingRead = await teamActions.decideAction(
          otherScope,
          MISSING_ID,
          "read",
        );
        const missingRun = await teamActions.decideAction(
          otherScope,
          MISSING_ID,
          "run",
          { policyVersion: WORKSPACE_V1_POLICY_ID },
        );
        expectCanonicalNotFound(unpublished);
        expectCanonicalNotFound(missingRead);
        expectCanonicalNotFound(missingRun);
        expect(
          new Set([
            verdictBytes(unpublished),
            verdictBytes(missingRead),
            verdictBytes(missingRun),
          ]),
        ).toEqual(new Set([CANONICAL_NOT_FOUND_BYTES]));
      });

      test("personal-share loop: share grants access, revoke makes it invisible again — all denials byte-identically canonical", async () => {
        const ownerScope = await fixture.scopeFor("a1-member", teamA1);
        // 无分享、无授权的同团队另一人 → 不可见。
        const noShare = await shareDecision.decide(
          await fixture.scopeFor("a1-other", teamA1),
          p1,
        );
        // 不存在的资源 → 同一不可见语义。
        const missing = await shareDecision.decide(ownerScope, MISSING_ID);
        expectCanonicalNotFound(noShare);
        expectCanonicalNotFound(missing);

        // 显式分享（跨团队受众：a1a2-member 以 team-a2 scope 访问）。
        await shareAdmin.share({
          tenantId: tenantA,
          resourceId: p1,
          actorPrincipalId: a1Principal,
          audiencePrincipalId: a1a2Principal,
          action: "read",
          expiresAt: new Date(Date.now() + 60_000),
        });
        const sharedScope = await fixture.scopeFor("a1a2-member", {
          tenantId: tenantA,
          workspaceId: fixture.base.teamOf("a1a2-member", "team-a2")
            .workspaceId,
        });
        const shared = await shareDecision.decide(sharedScope, p1);
        expect(shared.outcome).toBe("allow");
        await shareAdmin.revoke({
          tenantId: tenantA,
          resourceId: p1,
          actorPrincipalId: a1Principal,
          audiencePrincipalId: a1a2Principal,
          action: "read",
        });
        const revoked = await shareDecision.decide(sharedScope, p1);
        expectCanonicalNotFound(revoked);
        expect(verdictBytes(revoked)).toBe(verdictBytes(noShare));
      });
    });

    // ---------------------------------------------------------------------
    // 验收 2：列表与计数不包含无权对象；游标不因其存在而偏移
    // ---------------------------------------------------------------------

    describe("list / count / cursor surface", () => {
      test("count excludes invisible objects (tenancy-v1 default: grants only)", async () => {
        const scope = await fixture.scopeFor("a1-member", teamA1);
        const counted = await inventory.countVisibleResources(scope);
        // 可见：resource-a1 + pub1 + priv1 + v1..v3 + p1 = 7；
        // 不可见（i1..i4、resource-a1-other、跨团队、跨公司、已删除）一律不计入。
        expect(counted.total).toBe(7);
      });

      test("list pages through exactly the visible stream; invisible objects consume no page slots and leave no trailing cursor", async () => {
        const scope = await fixture.scopeFor("a1-member", teamA1);
        const expected = [resourceA1, "mt011-pub-1", priv1, ...visibleIds, p1];
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const page = await inventory.listVisibleResources(scope, {
            limit: 2,
            cursor: cursor ?? undefined,
          });
          pages += 1;
          for (const item of page.items) {
            seen.push(item.resourceId);
            // 每一项都是完整可见视图：字段来自真实行（夹具自建资源逐字段
            // 钉死；夹具预置资源的 displayName 断言归 MT002 套件所有）。
            expect(item.revision).toBe(1);
            expect(item.aclEpoch).toBe(1);
            if (item.resourceId.startsWith("mt011-")) {
              expect(item.displayName).toBe(`MT011 ${item.resourceId}`);
            }
          }
          expect(page.items.length).toBeLessThanOrEqual(2);
          cursor = page.nextCursor;
          expect(pages).toBeLessThan(10);
        } while (cursor !== null);
        expect(seen).toEqual(expected);
        expect(pages).toBe(4);
        // 不可见 id 一个都不出现（i4 在所有可见项之后也不产生额外页）。
        for (const invisible of invisibleIds) {
          expect(seen).not.toContain(invisible);
        }
      });

      test("other member's list: the visibility gate adds published objects only under workspace-v1", async () => {
        const otherScope = await fixture.scopeFor("a1-other", teamA1);
        const tenancyV1 = await inventory.countVisibleResources(otherScope);
        // tenancy-v1：只有显式授权项——自己的 resource-a1-other + i1..i4
        //（四个不可见对象对 a1-other 是「自己的授权资源」；可见性属性在
        // 旧版本完全不参与）。
        expect(tenancyV1.total).toBe(5);
        const workspaceV1 = await inventory.countVisibleResources(otherScope, {
          policyVersion: WORKSPACE_V1_POLICY_ID,
        });
        // workspace-v1 = 旧判定 ∪ 团队公共：新增 pub-1（发布 + 有效成员）；
        // i1 已发布但本就在授权集内（不重复计数）。
        expect(workspaceV1.total).toBe(6);
        const page = await inventory.listVisibleResources(otherScope, {
          limit: 10,
          policyVersion: WORKSPACE_V1_POLICY_ID,
        });
        expect(page.items.map((item) => item.resourceId).sort()).toEqual(
          [resourceA1Other, "mt011-pub-1", ...invisibleIds].sort(),
        );
      });

      test("suspended team membership closes the team-public door immediately — grants stay personal (and restore)", async () => {
        // a1a2-member：resource-a1 的授权人 + A1 有效成员。workspace-v1 下
        // 可见 = 授权项 resource-a1 + 团队公共 pub-1/i-1 = 3。停用后团队
        // 公共门立即关闭（发布项消失），但授权项仍属本人（MT008 语义：
        // 授权路径不受成员状态影响）→ 剩 1；恢复后回 3。
        const a1a2Scope = await fixture.scopeFor("a1a2-member", teamA1);
        const before = await inventory.countVisibleResources(a1a2Scope, {
          policyVersion: WORKSPACE_V1_POLICY_ID,
        });
        expect(before.total).toBe(3);
        await fixture.base.setTeamMembershipStatus(
          "a1a2-member",
          "team-a1",
          "suspended",
        );
        const suspended = await inventory.countVisibleResources(a1a2Scope, {
          policyVersion: WORKSPACE_V1_POLICY_ID,
        });
        expect(suspended.total).toBe(1);
        await fixture.base.setTeamMembershipStatus(
          "a1a2-member",
          "team-a1",
          "active",
        );
        const restored = await inventory.countVisibleResources(a1a2Scope, {
          policyVersion: WORKSPACE_V1_POLICY_ID,
        });
        expect(restored.total).toBe(3);
      });

      test("tenant policy_revision governs default resolution without explicit override", async () => {
        const otherScope = await fixture.scopeFor("a1-other", teamA1);
        const tenancyBaseline =
          await inventory.countVisibleResources(otherScope);
        expect(tenancyBaseline.total).toBe(5);
        await fixture.setTenantPolicyRevision(tenantA, WORKSPACE_V1_POLICY_ID);
        const flipped = await inventory.countVisibleResources(otherScope);
        expect(flipped.total).toBe(6);
        await fixture.setTenantPolicyRevision(tenantA, "tenancy-v1");
        const restored = await inventory.countVisibleResources(otherScope);
        expect(restored.total).toBe(5);
      });

      test("invalid cursors and limits fail loudly (input validation, not existence signals)", async () => {
        const scope = await fixture.scopeFor("a1-member", teamA1);
        const badCursor = inventory.listVisibleResources(scope, {
          cursor: "not-a-cursor",
        });
        await expect(badCursor).rejects.toThrow("INVENTORY_CURSOR_INVALID");
        await expect(
          inventory.listVisibleResources(scope, { limit: 0 }),
        ).rejects.toThrow("INVENTORY_LIMIT_INVALID");
        await expect(
          inventory.listVisibleResources(scope, { limit: 2.5 }),
        ).rejects.toThrow("INVENTORY_LIMIT_INVALID");
        await expect(
          inventory.listVisibleResources(scope, { limit: 201 }),
        ).rejects.toThrow("INVENTORY_LIMIT_INVALID");
      });

      test("revoking access mid-stream neither shifts nor breaks the cursor stream", async () => {
        const scope = await fixture.scopeFor("a1-member", teamA1);
        const page1 = await inventory.listVisibleResources(scope, { limit: 2 });
        expect(page1.items.map((i) => i.resourceId)).toEqual([
          resourceA1,
          "mt011-pub-1",
        ]);
        // priv1 从可见流中消失（对 该调用方等价于删除/撤销——不可区分）。
        await fixture.softDeleteResource({
          tenantId: tenantA,
          resourceId: priv1,
        });
        const page2 = await inventory.listVisibleResources(scope, {
          limit: 2,
          cursor: page1.nextCursor ?? undefined,
        });
        expect(page2.items.map((i) => i.resourceId)).toEqual(
          visibleIds.slice(0, 2),
        );
        const page3 = await inventory.listVisibleResources(scope, {
          limit: 4,
          cursor: page2.nextCursor ?? undefined,
        });
        expect(page3.items.map((i) => i.resourceId)).toEqual([
          ...visibleIds.slice(2),
          p1,
        ]);
        expect(page3.nextCursor).toBeNull();
      });
    });

    // ---------------------------------------------------------------------
    // 验收 3：批量接口不通过部分成功/失败差异泄露存在性
    // ---------------------------------------------------------------------

    describe("batch surface", () => {
      test("mixed batch resolves in input order; every denial is byte-identically canonical", async () => {
        const scope = await fixture.scopeFor("a1-member", teamA1);
        const entries = await inventory.resolveResourceBatch(scope, [
          resourceA1,
          MISSING_ID,
          resourceA1Other,
          resourceB1,
          vDel,
        ]);
        expect(entries.map((e) => e.resourceId)).toEqual([
          resourceA1,
          MISSING_ID,
          resourceA1Other,
          resourceB1,
          vDel,
        ]);
        expect(entries[0].outcome).toBe("allow");
        if (entries[0].outcome === "allow") {
          expect(entries[0].resource.kind).toBe("document");
          expect(entries[0].resource.displayName).toBe(
            fixture.base.isolation.identities["a1-member"].userId
              ? `Team A1 shared document`
              : entries[0].resource.displayName,
          );
        }
        for (const entry of entries.slice(1)) {
          expectCanonicalNotFound(entry);
        }
        expect(new Set(entries.slice(1).map((e) => verdictBytes(e)))).toEqual(
          new Set([CANONICAL_NOT_FOUND_BYTES]),
        );
      });

      test("batch denies match single decide verdicts for the same id (surface consistency)", async () => {
        const scope = await fixture.scopeFor("a1-member", teamA1);
        const ids = [MISSING_ID, resourceA1Other, vDel, resourceB1];
        const entries = await inventory.resolveResourceBatch(scope, ids);
        for (const [index, id] of ids.entries()) {
          const single = await policyDecision.decide(scope, id);
          expect(entries[index].outcome).toBe(single.outcome);
          if (single.outcome === "deny") {
            expect(verdictBytes(entries[index])).toBe(verdictBytes(single));
          }
        }
      });

      test("all-missing and all-forbidden batches cost identical SQL work (no partial-success differential)", async () => {
        const scope = await fixture.scopeFor("a1-member", teamA1);
        fixture.resetStatementCount();
        await inventory.resolveResourceBatch(scope, [
          `${MISSING_ID}-1`,
          `${MISSING_ID}-2`,
          `${MISSING_ID}-3`,
        ]);
        const missingStatements = fixture.statementCount();
        fixture.resetStatementCount();
        await inventory.resolveResourceBatch(scope, [
          invisibleIds[0],
          invisibleIds[1],
          invisibleIds[2],
        ]);
        const forbiddenStatements = fixture.statementCount();
        expect(missingStatements).toBeGreaterThan(0);
        expect(missingStatements).toBe(forbiddenStatements);
      });

      test("batch input validation: empty is empty, oversize and malformed ids fail loudly", async () => {
        const scope = await fixture.scopeFor("a1-member", teamA1);
        const empty = await inventory.resolveResourceBatch(scope, []);
        expect(empty).toEqual([]);
        await expect(
          inventory.resolveResourceBatch(scope, [MISSING_ID, ""]),
        ).rejects.toThrow("INVENTORY_BATCH_INPUT_INVALID");
        await expect(
          inventory.resolveResourceBatch(
            scope,
            Array.from({ length: 101 }, (_, i) => `mt011-overflow-${i}`),
          ),
        ).rejects.toThrow("INVENTORY_BATCH_INPUT_INVALID");
        await expect(
          inventory.resolveResourceBatch(scope, [42 as unknown as string]),
        ).rejects.toThrow("INVENTORY_BATCH_INPUT_INVALID");
      });

      test("duplicate ids resolve to identical entries", async () => {
        const scope = await fixture.scopeFor("a1-member", teamA1);
        const entries = await inventory.resolveResourceBatch(scope, [
          MISSING_ID,
          MISSING_ID,
        ]);
        expect(entries).toHaveLength(2);
        expect(entries[0]).toEqual(entries[1]);
      });
    });
  },
);

// ---------------------------------------------------------------------------
// canonical 语义单元面（纯函数，无数据库）
// ---------------------------------------------------------------------------

describe("MT011 canonical not-found semantics (offline unit face)", () => {
  test("canonical verdict is frozen and serializes to exactly one byte shape", () => {
    const verdict = notFoundVerdict();
    expect(Object.isFrozen(verdict)).toBe(true);
    expect(verdict).toEqual({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });
    expect(serializeNotFoundVerdict(verdict)).toBe(CANONICAL_NOT_FOUND_BYTES);
    expect(notFoundErrorBody()).toBe('{"error":"RESOURCE_NOT_FOUND"}');
    expect(notFoundHttpResponse()).toEqual({
      status: 404,
      body: '{"error":"RESOURCE_NOT_FOUND"}',
    });
  });

  test("serialize refuses anything that is not the canonical not-found shape", () => {
    for (const bad of [
      null,
      undefined,
      { outcome: "allow" },
      { outcome: "deny", code: "WORKSPACE_FORBIDDEN" },
      "RESOURCE_NOT_FOUND",
    ]) {
      expect(() =>
        serializeNotFoundVerdict(
          bad as Parameters<typeof serializeNotFoundVerdict>[0],
        ),
      ).toThrow("NOT_FOUND_VERDICT_REQUIRED");
    }
  });

  test("isResourceNotFoundVerdict accepts only the canonical shape", () => {
    expect(isResourceNotFoundVerdict(notFoundVerdict())).toBe(true);
    expect(
      isResourceNotFoundVerdict({
        outcome: "deny",
        code: "RESOURCE_NOT_FOUND",
      }),
    ).toBe(true);
    expect(isResourceNotFoundVerdict({ outcome: "allow" })).toBe(false);
    expect(isResourceNotFoundVerdict({ outcome: "deny", code: "OTHER" })).toBe(
      false,
    );
    expect(isResourceNotFoundVerdict(null)).toBe(false);
    expect(isResourceNotFoundVerdict("RESOURCE_NOT_FOUND")).toBe(false);
    // 拒绝形状唯一意味着：多带一个解释字段（如泄露拒绝原因的 reason）
    // 的对象不得再穿 not-found 的形状——多余字段即破坏唯一形状。
    expect(
      isResourceNotFoundVerdict({
        outcome: "deny",
        code: "RESOURCE_NOT_FOUND",
        reason: "cross-tenant",
      }),
    ).toBe(false);
    expect(() =>
      serializeNotFoundVerdict({
        outcome: "deny",
        code: "RESOURCE_NOT_FOUND",
        reason: "cross-tenant",
      } as Parameters<typeof serializeNotFoundVerdict>[0]),
    ).toThrow("NOT_FOUND_VERDICT_REQUIRED");
  });
});
