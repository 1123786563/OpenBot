// server/tests/multitenancy/conversations-list.test.ts
// MT021（Issue #64）：频道与会话列表、计数、分页游标的作用域。
//
// 票面验收事实源（brief + Issue #64，逐条对应 describe；真实 PostgreSQL，
// 全程受限 ob_ent_* 角色 + 真实 RLS，绝不回退开发库、缺 env 显式 skip）：
//   验收 1：列表、计数、分页游标三者在有权/无权混合数据下都只反映可见集合。
//   验收 2：用另一公司的会话 ID 直接访问详情返回不可见语义——MT011 canonical
//     { outcome: "deny", code: "RESOURCE_NOT_FOUND" }，逐字节同形，不存在/
//     跨公司/跨团队/他人会话/被撤权对外不可区分（票注：复用 MT011，不自造
//     错误码）。
//   验收 3：切换团队后列表与计数立即变化，不需要重新登录（同一 actor 身份
//     经真实 resolver 按选择器铸造新 scope，服务按入参 scope 过滤，无进程级
//     缓存）。
//   验收 4：游标不因隐藏条目而跳过或重复可见条目（keyset (created_at, id)
//     全序，游标只钉最后一个可见项；隐藏条目不消耗页位、不偏移游标、键最大
//     的隐藏条目不制造末页游标；中途改名/删除不引起跳过/重复）。
//   撤权即时性：公司成员被真实撤权（MT006 suspendMembership）后，已签发
//     scope 的列表/计数/详情全部 fail-closed（空页/0/canonical not-found）。
//   存储契约：未验证通道装配拒绝；无租户上下文 RLS fail-closed 0 行；
//     forged scope 信任门拒绝；缺上下文 TENANT/WORKSPACE_REQUIRED；全部受限
//     查询 current_user ∈ ob_ent_*。
//
// 结构（新文件优先；既有文件零改动——无迁移，scenarios 的 "conversations"
// 域已存在）。可见性规则 = 个人会话（Spec §5.1：团队成员资格不开放他人
// 会话）：RLS 租户臂 → 行 workspace === scope workspace → 行 owner ===
// scope principal → 事务内公司（active+epoch）与团队成员关系重验。

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/client";
import type { PlatformScope } from "../../src/enterprise/contracts";
import { createConversationListService } from "../../src/enterprise/tenancy/conversations-list";
import {
  isResourceNotFoundVerdict,
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import {
  type ConversationsIdentity,
  type ConversationsListFixture,
  createConversationsListFixture,
  type SeededConversation,
} from "./support/conversations-list";

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
      reason: `MT021 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

const thrownMessageSync = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to be rejected, but it succeeded");
};

// ---------------------------------------------------------------------------
// 套件状态与确定性种子
// ---------------------------------------------------------------------------

let fixture: ConversationsListFixture;
let companyA = "";
let companyB = "";
let teamA1 = "";
let teamA2 = "";
let teamB1 = "";

const principalOf = (identity: ConversationsIdentity) =>
  fixture.ids[`principal-${identity}`];

const scopeAs = (
  identity: ConversationsIdentity,
  tenantId: string,
  workspaceId: string,
): Promise<PlatformScope> => fixture.scopeAs(identity, tenantId, workspaceId);

/** 确定性创建时间：每行间隔一分钟，(created_at, id) 全序由 created_at 唯一决定。 */
const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");
const at = (minute: number) => new Date(BASE_TIME + minute * 60_000);

interface PlannedConversation {
  readonly key: string;
  readonly tenant: "company-a" | "company-b";
  readonly team: "team-a1" | "team-a2" | "team-b1";
  readonly owner: ConversationsIdentity;
  readonly minute: number;
  readonly title: string;
}

// 种子全集（beforeAll 一次落库；各 describe 的期望集合按此精确推导——
// 「列表/计数 = 当前作用域内的全部可见事实」，含套件顺序累积，MT016 D3 口径）：
//   team-a1: c1(a1) c2(other) c3(a1) c4(other) c5(a1) c6(a1a2) c7(multi)
//            c8(doomed) c9(other, 键最大) + c10/c11（验收 4 变异靶，稍后种）
//   team-a2: d1(a2) d2(a1a2)
//   team-b1: e1(b1) e2(multi) e3(b1)
const SEED_PLAN: readonly PlannedConversation[] = [
  {
    key: "c1",
    tenant: "company-a",
    team: "team-a1",
    owner: "a1-member",
    minute: 1,
    title: "alpha",
  },
  {
    key: "c2",
    tenant: "company-a",
    team: "team-a1",
    owner: "a1-other",
    minute: 2,
    title: "bravo",
  },
  {
    key: "c3",
    tenant: "company-a",
    team: "team-a1",
    owner: "a1-member",
    minute: 3,
    title: "charlie",
  },
  {
    key: "c4",
    tenant: "company-a",
    team: "team-a1",
    owner: "a1-other",
    minute: 4,
    title: "delta",
  },
  {
    key: "c5",
    tenant: "company-a",
    team: "team-a1",
    owner: "a1-member",
    minute: 5,
    title: "echo",
  },
  {
    key: "c6",
    tenant: "company-a",
    team: "team-a1",
    owner: "a1a2-member",
    minute: 6,
    title: "foxtrot",
  },
  {
    key: "c7",
    tenant: "company-a",
    team: "team-a1",
    owner: "multi-company",
    minute: 7,
    title: "golf",
  },
  {
    key: "c8",
    tenant: "company-a",
    team: "team-a1",
    owner: "a1-doomed",
    minute: 8,
    title: "hotel",
  },
  // 键最大的隐藏条目（验收 4：不制造末页游标）。
  {
    key: "c9",
    tenant: "company-a",
    team: "team-a1",
    owner: "a1-other",
    minute: 50,
    title: "india-key-max",
  },
  {
    key: "d1",
    tenant: "company-a",
    team: "team-a2",
    owner: "a2-member",
    minute: 9,
    title: "juliet",
  },
  {
    key: "d2",
    tenant: "company-a",
    team: "team-a2",
    owner: "a1a2-member",
    minute: 10,
    title: "kilo",
  },
  {
    key: "e1",
    tenant: "company-b",
    team: "team-b1",
    owner: "b1-member",
    minute: 11,
    title: "lima",
  },
  {
    key: "e2",
    tenant: "company-b",
    team: "team-b1",
    owner: "multi-company",
    minute: 12,
    title: "mike",
  },
  {
    key: "e3",
    tenant: "company-b",
    team: "team-b1",
    owner: "b1-member",
    minute: 13,
    title: "november",
  },
] as const;

const conversationIds: Record<string, string> = {};
const convId = (key: string) => conversationIds[key];

const toSeed = (planned: PlannedConversation): SeededConversation => ({
  conversationId: randomUUID(),
  tenantId: fixture.ids[planned.tenant],
  workspaceId: fixture.ids[planned.team],
  principalId: principalOf(planned.owner),
  threadId: `thr-${fixture.idPrefix}-${planned.key}`,
  title: planned.title,
  createdAt: at(planned.minute),
});

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createConversationsListFixture();
  companyA = fixture.ids["company-a"];
  companyB = fixture.ids["company-b"];
  teamA1 = fixture.ids["team-a1"];
  teamA2 = fixture.ids["team-a2"];
  teamB1 = fixture.ids["team-b1"];
  for (const planned of SEED_PLAN) {
    const seed = toSeed(planned);
    conversationIds[planned.key] = seed.conversationId;
    await fixture.seedConversation(seed);
  }
}, 60000);

afterAll(async () => {
  if (fixture) {
    await fixture.dispose();
  }
}, 60000);

// ---------------------------------------------------------------------------
// 验收 1：列表、计数、分页游标只反映可见集合（有权/无权混合数据）
// ---------------------------------------------------------------------------

describeDb("MT021 验收 1：列表/计数/游标只反映可见集合", () => {
  itDb(
    "种子完整落库：RLS 下 A 公司 11 行 / B 公司 3 行；无上下文 fail-closed 0 行",
    async () => {
      expect(await fixture.rawConversationCount()).toBe(14);
      const rowsA = await fixture.listConversationRowsAsData(companyA);
      expect(rowsA.length).toBe(11);
      const rowsB = await fixture.listConversationRowsAsData(companyB);
      expect(rowsB.length).toBe(3);
      // 无租户上下文：RLS 先行隐藏一切（fail-closed，不是报错）。
      expect(await fixture.countConversationRowsWithoutContext()).toBe(0);
    },
  );

  itDb(
    "a1-member 的列表与计数恰为其本人 A1 会话：他人的/他团队的/他公司的都不在",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const page = await fixture.service.listVisibleConversations(scope, {
        limit: 200,
      });
      expect(page.items.map((item) => item.conversationId)).toEqual([
        convId("c1"),
        convId("c3"),
        convId("c5"),
      ]);
      const count = await fixture.service.countVisibleConversations(scope);
      expect(count.total).toBe(3);
      const listed = new Set(page.items.map((item) => item.conversationId));
      // 同团队他人（c2/c4）、键更大的他人行（c9）、他团队（d1/d2）、他公司
      // （e1/e2/e3）一律不在列表也不在计数。
      for (const hidden of ["c2", "c4", "c9", "d1", "d2", "e1", "e2", "e3"]) {
        expect(listed.has(convId(hidden))).toBe(false);
      }
    },
  );

  itDb(
    "同团队另一成员的列表独立：a1-other 只见自己的行（互不可见，双向）",
    async () => {
      const scope = await scopeAs("a1-other", companyA, teamA1);
      const page = await fixture.service.listVisibleConversations(scope, {
        limit: 200,
      });
      expect(page.items.map((item) => item.conversationId)).toEqual([
        convId("c2"),
        convId("c4"),
        convId("c9"),
      ]);
      const count = await fixture.service.countVisibleConversations(scope);
      expect(count.total).toBe(3);
      // 反向：a1-member 的行也不出现在 a1-other 的列表里。
      const listed = new Set(page.items.map((item) => item.conversationId));
      for (const hidden of ["c1", "c3", "c5"]) {
        expect(listed.has(convId(hidden))).toBe(false);
      }
    },
  );

  itDb(
    "跨公司：b1-member 只见 B1 自己的行；multi-company 双公司列表互斥且并集不串",
    async () => {
      const bScope = await scopeAs("b1-member", companyB, teamB1);
      const bPage = await fixture.service.listVisibleConversations(bScope, {
        limit: 200,
      });
      expect(bPage.items.map((item) => item.conversationId)).toEqual([
        convId("e1"),
        convId("e3"),
      ]);
      expect(
        (await fixture.service.countVisibleConversations(bScope)).total,
      ).toBe(2);
      const bListed = new Set(bPage.items.map((item) => item.conversationId));
      for (const hidden of ["c1", "c3", "c5", "c7", "d1", "d2"]) {
        expect(bListed.has(convId(hidden))).toBe(false);
      }

      // 同一人在两家公司：各自作用域各自事实（无进程级「当前公司」）。
      const multiA = await scopeAs("multi-company", companyA, teamA1);
      const multiB = await scopeAs("multi-company", companyB, teamB1);
      const pageA = await fixture.service.listVisibleConversations(multiA, {
        limit: 200,
      });
      const pageB = await fixture.service.listVisibleConversations(multiB, {
        limit: 200,
      });
      expect(pageA.items.map((item) => item.conversationId)).toEqual([
        convId("c7"),
      ]);
      expect(pageB.items.map((item) => item.conversationId)).toEqual([
        convId("e2"),
      ]);
      expect(
        (await fixture.service.countVisibleConversations(multiA)).total,
      ).toBe(1);
      expect(
        (await fixture.service.countVisibleConversations(multiB)).total,
      ).toBe(1);
    },
  );

  itDb(
    "分页游标只在可见流上：页并集 == 全量可见集，无重复无遗漏，收敛 null",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const collected: string[] = [];
      const pages: (string | null)[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await fixture.service.listVisibleConversations(scope, {
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        collected.push(...page.items.map((item) => item.conversationId));
        pages.push(page.nextCursor);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(collected).toEqual([convId("c1"), convId("c3"), convId("c5")]);
      // 末页 nextCursor 为 null——键最大的隐藏条目 c9 不制造尾随空页。
      expect(pages.at(-1)).toBeNull();
      expect(new Set(collected).size).toBe(collected.length);
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 2：另一公司会话 ID 的详情 = MT011 canonical 不可见语义
// ---------------------------------------------------------------------------

describeDb("MT021 验收 2：跨范围详情 = canonical 不可见语义", () => {
  itDb(
    "另一公司的会话 ID：canonical not-found，与 MT011 冻结实例逐字节同形",
    async () => {
      const scope = await scopeAs("b1-member", companyB, teamB1);
      const verdict = await fixture.service.readVisibleConversation(
        scope,
        convId("c1"),
      );
      expect(isCanonicalNotFound(verdict)).toBe(true);
    },
  );

  itDb(
    "不存在 / 跨公司 / 跨团队 / 他人会话的拒绝构成单元素字节集（不泄露区别）",
    async () => {
      const a1Scope = await scopeAs("a1-member", companyA, teamA1);
      const b1Scope = await scopeAs("b1-member", companyB, teamB1);
      const a1a2ScopeA1 = await scopeAs("a1a2-member", companyA, teamA1);
      const denials = [
        await fixture.service.readVisibleConversation(a1Scope, randomUUID()),
        await fixture.service.readVisibleConversation(b1Scope, convId("c1")),
        // 本人自己的行、但团队不符（a1a2 的 A2 行从 A1 scope 读）。
        await fixture.service.readVisibleConversation(
          a1a2ScopeA1,
          convId("d2"),
        ),
        // 同团队、他人所有（a1-other 的行从 a1-member scope 读）。
        await fixture.service.readVisibleConversation(a1Scope, convId("c2")),
      ];
      const byteShapes = new Set(
        denials.map((verdict) =>
          isResourceNotFoundVerdict(verdict)
            ? JSON.stringify(verdict)
            : "OTHER",
        ),
      );
      expect(byteShapes).toEqual(new Set([canonicalNotFoundJson]));
    },
  );

  itDb(
    "正向：本人会话详情 allow，视图字段精确（含 workspace 钉死与时间往返）",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const outcome = await fixture.service.readVisibleConversation(
        scope,
        convId("c3"),
      );
      expect(outcome.outcome).toBe("allow");
      if (outcome.outcome !== "allow") throw new Error("unreachable");
      expect(outcome.conversation.conversationId).toBe(convId("c3"));
      expect(outcome.conversation.threadId).toBe(`thr-${fixture.idPrefix}-c3`);
      expect(outcome.conversation.title).toBe("charlie");
      expect(outcome.conversation.workspaceId).toBe(teamA1);
      expect(outcome.conversation.storageBackend).toBe("platform");
      expect(outcome.conversation.createdAt).toBe(at(3).toISOString());
      expect(Object.isFrozen(outcome.conversation)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 3：切团队后列表与计数立即变化，不需要重新登录
// ---------------------------------------------------------------------------

describeDb("MT021 验收 3：切团队立即变化（无需重登）", () => {
  /** 撤权用受信 scope：跨用例保留，供恢复后的「旧 scope 仍被拒」断言复用。 */
  let doomedScope: PlatformScope;

  itDb(
    "a1a2-member：A1 scope 见 [c6]，紧接 A2 scope 见 [d2]——同一身份无需重登",
    async () => {
      const scopeA1 = await scopeAs("a1a2-member", companyA, teamA1);
      const pageA1 = await fixture.service.listVisibleConversations(scopeA1, {
        limit: 200,
      });
      expect(pageA1.items.map((item) => item.conversationId)).toEqual([
        convId("c6"),
      ]);
      expect(
        (await fixture.service.countVisibleConversations(scopeA1)).total,
      ).toBe(1);

      const scopeA2 = await scopeAs("a1a2-member", companyA, teamA2);
      const pageA2 = await fixture.service.listVisibleConversations(scopeA2, {
        limit: 200,
      });
      expect(pageA2.items.map((item) => item.conversationId)).toEqual([
        convId("d2"),
      ]);
      expect(
        (await fixture.service.countVisibleConversations(scopeA2)).total,
      ).toBe(1);
      const listedA2 = new Set(pageA2.items.map((item) => item.conversationId));
      expect(listedA2.has(convId("c6"))).toBe(false);
    },
  );

  itDb(
    "A1→A2→A1 三连切换：每次都精确反映当前 scope（无陈旧缓存）",
    async () => {
      const read = async (workspaceId: string) =>
        (
          await fixture.service.listVisibleConversations(
            await scopeAs("a1a2-member", companyA, workspaceId),
            { limit: 200 },
          )
        ).items.map((item) => item.conversationId);
      expect(await read(teamA1)).toEqual([convId("c6")]);
      expect(await read(teamA2)).toEqual([convId("d2")]);
      expect(await read(teamA1)).toEqual([convId("c6")]);
    },
  );

  itDb(
    "真实撤权（MT006）后：已签发 scope 的列表空页、计数 0、详情 canonical not-found",
    async () => {
      doomedScope = await scopeAs("a1-doomed", companyA, teamA1);
      // 撤权前正向可见（positive control）。
      const before = await fixture.service.listVisibleConversations(
        doomedScope,
        { limit: 200 },
      );
      expect(before.items.map((item) => item.conversationId)).toEqual([
        convId("c8"),
      ]);
      await fixture.suspendCompanyMembership(
        companyA,
        principalOf("a1-doomed"),
      );
      const after = await fixture.service.listVisibleConversations(
        doomedScope,
        { limit: 200 },
      );
      expect(after.items).toEqual([]);
      expect(after.nextCursor).toBeNull();
      expect(
        (await fixture.service.countVisibleConversations(doomedScope)).total,
      ).toBe(0);
      const verdict = await fixture.service.readVisibleConversation(
        doomedScope,
        convId("c8"),
      );
      expect(isCanonicalNotFound(verdict)).toBe(true);
    },
  );

  itDb(
    "撤权后同身份再铸造 scope 被真实资格门拒绝（不是服务层放行）",
    async () => {
      const message = await thrownMessage(() =>
        scopeAs("a1-doomed", companyA, teamA1),
      );
      expect(message.length).toBeGreaterThan(0);
      expect([
        "TENANT_FORBIDDEN",
        "SCOPE_REVOKED",
        "WORKSPACE_FORBIDDEN",
      ]).toContain(message);
    },
  );

  itDb(
    "暂停→恢复（MT007 restore）后：旧 scope 仍被拒（epoch 独立防线），新 scope 正常",
    async () => {
      // 恢复把 status 翻回 active 且 epoch +1：旧 scope 的 epoch 不再匹配
      // ——status 检查已放行，只有 epoch 比对能拒绝它（MUT 独立可捕获性）。
      await fixture.reinstateCompanyMembership(
        companyA,
        principalOf("a1-doomed"),
      );
      const oldList = await fixture.service.listVisibleConversations(
        doomedScope,
        { limit: 200 },
      );
      expect(oldList.items).toEqual([]);
      expect(
        (await fixture.service.countVisibleConversations(doomedScope)).total,
      ).toBe(0);
      const oldDetail = await fixture.service.readVisibleConversation(
        doomedScope,
        convId("c8"),
      );
      expect(isCanonicalNotFound(oldDetail)).toBe(true);
      // 恢复后新铸 scope（新 epoch）正常可见——epoch 是版本事实，不是惩罚。
      const freshScope = await scopeAs("a1-doomed", companyA, teamA1);
      const freshList = await fixture.service.listVisibleConversations(
        freshScope,
        { limit: 200 },
      );
      expect(freshList.items.map((item) => item.conversationId)).toEqual([
        convId("c8"),
      ]);
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 4：游标不因隐藏条目而跳过或重复可见条目
// ---------------------------------------------------------------------------

describeDb("MT021 验收 4：游标稳定性（隐藏条目不跳不重）", () => {
  // 本 describe 专属的两行（追加到 a1-member 的可见集）+ 变异动作。
  const mutationKeys = ["c10", "c11"] as const;

  beforeAll(async () => {
    if (!ENV.ok) return;
    // 追加两行到交错序列：a1-member @ A1 的可见集变为 c1,c3,c5,c10,c11，
    // 与隐藏行 c2,c4,c9 按 created_at 交错。
    const extra: readonly PlannedConversation[] = [
      {
        key: "c10",
        tenant: "company-a",
        team: "team-a1",
        owner: "a1-member",
        minute: 14,
        title: "oscar",
      },
      {
        key: "c11",
        tenant: "company-a",
        team: "team-a1",
        owner: "a1-member",
        minute: 15,
        title: "papa",
      },
    ] as const;
    for (const planned of extra) {
      const seed = toSeed(planned);
      conversationIds[planned.key] = seed.conversationId;
      await fixture.seedConversation(seed);
    }
  }, 30000);

  itDb(
    "limit=1 全页链：隐藏行交错期间页并集 == 精确可见序列（不跳不重）",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const collected: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 12; guard += 1) {
        const page = await fixture.service.listVisibleConversations(scope, {
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        collected.push(...page.items.map((item) => item.conversationId));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(collected).toEqual([
        convId("c1"),
        convId("c3"),
        convId("c5"),
        convId("c10"),
        convId("c11"),
      ]);
      expect(new Set(collected).size).toBe(collected.length);
    },
  );

  itDb("计数同步反映追加后的可见集（5）——隐藏行不进计数", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    expect((await fixture.service.countVisibleConversations(scope)).total).toBe(
      5,
    );
  });

  itDb(
    "翻页中途改名（updated_at 语义无关——游标键不可变）：后续页原样续读",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const firstPage = await fixture.service.listVisibleConversations(scope, {
        limit: 2,
      });
      expect(firstPage.items.map((item) => item.conversationId)).toEqual([
        convId("c1"),
        convId("c3"),
      ]);
      expect(firstPage.nextCursor).not.toBeNull();
      // 中途改 c3 的标题（visible、已见过的行）。
      await fixture.renameConversationAsData(
        companyA,
        convId("c3"),
        "charlie-renamed",
      );
      const secondPage = await fixture.service.listVisibleConversations(scope, {
        limit: 2,
        cursor: firstPage.nextCursor as string,
      });
      expect(secondPage.items.map((item) => item.conversationId)).toEqual([
        convId("c5"),
        convId("c10"),
      ]);
      const tail = await fixture.service.listVisibleConversations(scope, {
        limit: 2,
        cursor: secondPage.nextCursor as string,
      });
      expect(tail.items.map((item) => item.conversationId)).toEqual([
        convId("c11"),
      ]);
      expect(tail.nextCursor).toBeNull();
    },
  );

  itDb(
    "翻页中途删除可见项：后续页无移位、无错误、无复现，计数与游标同步收敛",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      // 当前可见集：c1,c3,c5,c10,c11。删 c5（未读到的行）。
      await fixture.hardDeleteConversationViaSetup(companyA, convId("c5"));
      const collected: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 12; guard += 1) {
        const page = await fixture.service.listVisibleConversations(scope, {
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        collected.push(...page.items.map((item) => item.conversationId));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(collected).toEqual([
        convId("c1"),
        convId("c3"),
        convId("c10"),
        convId("c11"),
      ]);
      expect(new Set(collected).size).toBe(collected.length);
      expect(
        (await fixture.service.countVisibleConversations(scope)).total,
      ).toBe(4);
    },
  );

  itDb("变异靶行存在性自查（c10/c11 是本 describe 追加的真实行）", async () => {
    for (const key of mutationKeys) {
      expect(convId(key)).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// 修复轮 F1：微秒 created_at 形态下翻页收敛（生产写路径 defaultNow() 带微秒，
// JS Date 只到毫秒——游标键若经 JS 序列化会把边界行重新纳入，翻页死循环）。
// 种子经夹具显式 ::timestamptz 字面量通道注入微秒（夹具唯一新增通道，实现轮
// 的 toISOString 通道无法表达亚毫秒精度）。
// ---------------------------------------------------------------------------

describeDb("MT021 修复轮 F1：微秒 created_at 下翻页收敛、不跳不重", () => {
  // 同秒内两行可见微秒行（.123456 / .123999，间隔亚毫秒）+ 一行隔秒微秒行；
  // 另有一行同键微秒隐藏行（a1-other）与可见行同秒交错。追加于 c11(min 15)
  // 之后、c9(min 50) 之前——a1-member 的当前可见全序为：
  //   c1, c3, c10, c11, m1, m2, m3（验收 4 已删 c5；隐藏：c2, c4, mh, c9）。
  const MICRO_M1 = "2026-01-01 00:20:00.123456+00";
  const MICRO_M2 = "2026-01-01 00:20:00.123999+00";
  const MICRO_M3 = "2026-01-01 00:21:00.654321+00";
  const VISIBLE_CHAIN = ["c1", "c3", "c10", "c11", "m1", "m2", "m3"] as const;

  beforeAll(async () => {
    if (!ENV.ok) return;
    const microSeed = (
      key: string,
      owner: ConversationsIdentity,
      createdAtText: string,
    ): SeededConversation => ({
      conversationId: randomUUID(),
      tenantId: companyA,
      workspaceId: teamA1,
      principalId: principalOf(owner),
      threadId: `thr-${fixture.idPrefix}-${key}`,
      title: `micro-${key}`,
      // Date 字段仍必填（类型上），但 createdAtText 优先于其序列化。
      createdAt: at(20),
      createdAtText,
    });
    for (const [key, owner, text] of [
      ["m1", "a1-member", MICRO_M1],
      ["m2", "a1-member", MICRO_M2],
      ["m3", "a1-member", MICRO_M3],
      // 隐藏行（同团队他人）与 m3 同微秒键：隐藏行不得偏移游标或消耗页位。
      ["mh", "a1-other", MICRO_M3],
    ] as const) {
      const seed = microSeed(key, owner, text);
      conversationIds[key] = seed.conversationId;
      await fixture.seedConversation(seed);
    }
  }, 30000);

  itDb(
    "limit=1 全页链收敛：页并集 == 精确可见序列（含微秒边界行自身不重入），无重复，末页 null",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const collected: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 12; guard += 1) {
        const page = await fixture.service.listVisibleConversations(scope, {
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        collected.push(...page.items.map((item) => item.conversationId));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      // 死循环守卫未耗尽（guard 余量 = 12 - 7 页）——微秒边界行 m1 不把
      // 自己重新纳入下一页（修复前此链每页都重复 m1 直至耗尽守卫）。
      expect(collected).toEqual(VISIBLE_CHAIN.map((key) => convId(key)));
      expect(new Set(collected).size).toBe(collected.length);
      // 隐藏微秒行 mh（与 m3 同键）不出现在任何页。
      expect(collected).not.toContain(convId("mh"));
    },
  );

  itDb(
    "游标 at 字段携带微秒精度（SQL 文本形态）：钉在微秒边界行上的游标不解为毫秒",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      // limit=5：首页恰终止于微秒行 m1（可见序 c1,c3,c10,c11,m1）。
      const firstPage = await fixture.service.listVisibleConversations(scope, {
        limit: 5,
      });
      expect(firstPage.items.map((item) => item.conversationId)).toEqual(
        VISIBLE_CHAIN.slice(0, 5).map((key) => convId(key)),
      );
      expect(firstPage.nextCursor).not.toBeNull();
      const payload = JSON.parse(
        Buffer.from(firstPage.nextCursor as string, "base64url").toString(
          "utf8",
        ),
      ) as { v: number; at: string; id: string };
      expect(payload.v).toBe(1);
      expect(payload.id).toBe(convId("m1"));
      // 微秒在场：at 是 created_at 的 SQL 文本形态（非 JS toISOString 的
      // 毫秒截断形态）——本断言在修复前必失败（.123Z 形态无 .123456）。
      expect(payload.at).toContain(".123456");
      // 该游标能真实续读下一页并收敛（m2, m3），隐藏行 mh 不插入。
      const secondPage = await fixture.service.listVisibleConversations(scope, {
        limit: 5,
        cursor: firstPage.nextCursor as string,
      });
      expect(secondPage.items.map((item) => item.conversationId)).toEqual(
        VISIBLE_CHAIN.slice(5).map((key) => convId(key)),
      );
      expect(secondPage.nextCursor).toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// 输入校验与信任边界（响亮拒绝；不可见语义只有 canonical 一种）
// ---------------------------------------------------------------------------

describeDb("MT021 输入校验与信任边界", () => {
  itDb("无效 limit 响亮拒绝（0/201/非整数）", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    for (const limit of [0, -1, 201, 1.5, Number.NaN]) {
      const message = await thrownMessage(() =>
        fixture.service.listVisibleConversations(scope, { limit }),
      );
      expect(message).toContain("CONVERSATIONS_LIMIT_INVALID");
    }
  });

  itDb("无效游标响亮拒绝（非 base64url/坏 JSON/缺字段）", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    for (const token of [
      "not-base64!!",
      Buffer.from("[]").toString("base64url"),
    ]) {
      const message = await thrownMessage(() =>
        fixture.service.listVisibleConversations(scope, { cursor: token }),
      );
      expect(message).toContain("CONVERSATIONS_CURSOR_INVALID");
    }
    const missingFields = Buffer.from(
      JSON.stringify({ v: 1, at: "" }),
    ).toString("base64url");
    const message = await thrownMessage(() =>
      fixture.service.listVisibleConversations(scope, {
        cursor: missingFields,
      }),
    );
    expect(message).toContain("CONVERSATIONS_CURSOR_INVALID");
  });

  itDb(
    "修复轮 F2：结构合法但 at 非时间戳的游标 → CONVERSATIONS_CURSOR_INVALID（不泄漏裸驱动错误）",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const garbageAt = Buffer.from(
        JSON.stringify({ v: 1, at: "garbage", id: randomUUID() }),
      ).toString("base64url");
      const message = await thrownMessage(() =>
        fixture.service.listVisibleConversations(scope, {
          limit: 5,
          cursor: garbageAt,
        }),
      );
      expect(message).toContain("CONVERSATIONS_CURSOR_INVALID");
    },
  );

  itDb("畸形会话 ID 响亮拒绝（输入校验；不与 not-found 混同）", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    for (const bad of ["", "   ", "not-a-uuid"]) {
      const message = await thrownMessage(() =>
        fixture.service.readVisibleConversation(scope, bad),
      );
      expect(message).toContain("CONVERSATION_ID_INVALID");
    }
  });

  itDb("缺公司/团队上下文明确拒绝（先于信任判定的输入形状拒绝）", async () => {
    const minted = await scopeAs("a1-member", companyA, teamA1);
    const withoutTenant = { ...minted, tenantId: "" } as PlatformScope;
    const withoutWorkspace = { ...minted, workspaceId: "" } as PlatformScope;
    expect(
      await thrownMessage(() =>
        fixture.service.listVisibleConversations(withoutTenant, {}),
      ),
    ).toContain("TENANT_REQUIRED");
    expect(
      await thrownMessage(() =>
        fixture.service.listVisibleConversations(withoutWorkspace, {}),
      ),
    ).toContain("WORKSPACE_REQUIRED");
  });

  itDb(
    "forged scope 响亮拒绝（UNVERIFIED_SCOPE，信任边界不放宽）",
    async () => {
      const forged = {
        tenantId: companyA,
        workspaceId: teamA1,
        principalId: principalOf("a1-member"),
        actorId: fixture.ids["user-a1-member"],
        memberEpoch: 1,
        aclEpoch: 1,
        entrypoint: "web",
      } as PlatformScope;
      expect(
        await thrownMessage(() =>
          fixture.service.listVisibleConversations(forged, {}),
        ),
      ).toContain("UNVERIFIED_SCOPE");
      expect(
        await thrownMessage(() =>
          fixture.service.countVisibleConversations(forged),
        ),
      ).toContain("UNVERIFIED_SCOPE");
    },
  );
});

// ---------------------------------------------------------------------------
// 存储契约（RLS / 受限角色 / 装配 fail-closed）
// ---------------------------------------------------------------------------

describeDb("MT021 存储契约", () => {
  itDb(
    "未验证通道在服务装配时拒绝（UNVERIFIED_DATABASE_CAPABILITY）",
    async () => {
      const dataUrl = enterpriseRuntimeDatabaseUrlFrom("data", process.env);
      const rawChannel = createDatabase(dataUrl, { max: 1 });
      try {
        const message = thrownMessageSync(() =>
          createConversationListService(rawChannel as never),
        );
        expect(message).toContain("UNVERIFIED_DATABASE_CAPABILITY");
      } finally {
        await rawChannel.$client.close();
      }
    },
  );

  itDb(
    "canonical 不可见语义只此一种：序列化字节精确且与 MT011 冻结实例一致",
    () => {
      expect(canonicalNotFoundJson).toBe(
        '{"outcome":"deny","code":"RESOURCE_NOT_FOUND"}',
      );
      expect(serializeNotFoundVerdict(notFoundVerdict())).toBe(
        serializeNotFoundVerdict(notFoundVerdict()),
      );
    },
  );

  itDb("全部受限查询以 ob_ent_* 能力角色执行（三种角色都在场）", () => {
    const calls = fixture.restrictedCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.currentUser.startsWith("ob_ent_")).toBe(true);
    }
    const roles = new Set(calls.map((call) => call.role));
    expect(roles.has("data")).toBe(true);
    expect(roles.has("operator")).toBe(true);
  });
});
