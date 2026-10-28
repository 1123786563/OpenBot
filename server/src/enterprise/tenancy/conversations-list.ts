// server/src/enterprise/tenancy/conversations-list.ts
// MT021（Issue #64）：频道与会话列表、计数、分页游标的作用域。
//
// 票面语义：用户看到的会话列表、计数与分页结果只包含当前公司团队范围内
// 自己有权访问的会话；跨范围会话既不出现在列表，也不影响计数与游标；用
// 另一公司的会话 ID 直接访问详情返回不可见语义；切换团队后立即变化，无需
// 重新登录；游标不因隐藏条目而跳过或重复可见条目。
//
// 结构（纯新增，只读消费 MT011 既有出口，不改任何既有文件语义）：
//
//   1. 可见性规则 = 个人会话（父 Spec §5.1：团队成员资格不开放个人会话）。
//      行必须同时满足：RLS 租户臂（受限 ob_ent_data + app.tenant_id 先行
//      隐藏跨公司行）→ 行 workspace_id === 受信 scope.workspaceId → 行
//      principal_id === scope.principalId（同团队他人会话不可见）→ 事务内
//      重验调用者公司成员资格（active 且 epoch === scope.memberEpoch）与
//      团队成员关系 active。任一不成立 → 不可见。
//   2. 列表/计数/游标只从可见项派生：候选行按 (created_at, id) 全序读取
//      （不可变键——updated_at 随消息追加前进，不入游标键），keyset 游标
//      {v:1, at, id} 只钉在最后一个可见项上；第 limit+1 个可见项只用来签发
//      下一页游标。游标 `at` 取 SQL 侧 created_at::text（PG 文本保微秒，
//      MT016 同款；修复轮 F1——JS Date 序列化只到毫秒，微秒边界行会被下一
//      页谓词重新纳入导致翻页死循环/重复）。隐藏条目不消耗页位、不偏移游
//      标；键大于全部可见项的隐藏条目不制造末页游标（nextCursor=null）。
//      中途改名/删除不引起跳过或重复（已见页不受影响，未读页原样续读）。
//   3. 详情 = canonical 不可见语义：readVisibleConversation 的一切拒绝
//      （不存在/跨公司/跨团队/他人会话/被撤权）返回 MT011 的冻结实例
//      notFoundVerdict()——逐字节同形，不泄露任何区别（票注：复用 MT011，
//      不自造错误码）。
//   4. 切团队立即变化：服务按入参受信 scope 过滤，无进程级「当前团队」
//      状态、无跨调用缓存（MT014 验收 4 同纪律）——同一 actor 的每个新
//      scope（真实 resolver 按请求选择器铸造）立即得到该团队的事实。
//
// 事务纪律与 MT008/MT011/MT016 判定入口完全一致：assertScopeContext →
// assertTrustedScope → read committed + lock/statement timeout →
// set_config('app.*', …, true) 事务本地 → advisory 共享锁（键序 tenant →
// principal → membership → workspace-membership）。事实读取全部经受限
// data 角色与真实 RLS：跨公司行对本事务不可见（事实即为「不存在」），
// 纯判定内的租户/团队/本人比对是第二道独立防线（纵深防御）。
//
// 输入校验响亮（错误只含代码，绝不回显值）：CONVERSATIONS_LIMIT_INVALID
// （1..200，缺省 50）、CONVERSATIONS_CURSOR_INVALID（服务自发的 opaque
// 令牌形状）、CONVERSATION_ID_INVALID（UUID 形状）；缺公司/团队上下文
// TENANT_REQUIRED / WORKSPACE_REQUIRED（与 MT005 语义同源）。这些是输入
// 形状拒绝，不是存在性信号；不可见语义只有 canonical RESOURCE_NOT_FOUND
// 一种。
//
// 边界（诚实披露）：
//   - 列表/计数的候选读取一次扫过 scope 团队内本人的候选行（归属谓词在
//     SQL WHERE 内，无应用层二次过滤流——与 MT011 的注册表求值不同，个人
//     会话可见性是纯归属谓词，可完整下推）；团队规模超出此模型时属后续
//     分页架构票。
//   - 本模块为只读面：会话写入仍由既有 conversations 服务负责（其事务
//     纪律不变）；详情读不持逐会话锁（无对应的本模块写者，锁族不预支）。
//   - 本票不接路由：服务面供下游接线票复用（与 MT009/MT011/MT016 装配
//     同例）；列表展示排序（如 updated_at 倒序）属路由/前端职责，视图
//     已携带 created_at/updated_at。

import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import { enterpriseConversations } from "../../db/schema/enterprise-conversations";
import {
  enterpriseMemberships,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import { assertDataDatabase, type DataDatabase } from "./connections";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 视图与页面形状
// ---------------------------------------------------------------------------

/** 会话视图：可见成员可读的全部事实（时间以 ISO 字符串往返，深冻结）。 */
export interface ConversationListView {
  readonly conversationId: string;
  readonly threadId: string;
  readonly title: string | null;
  readonly storageBackend: "platform" | "intelligence" | "mastra";
  readonly lastSeq: number;
  readonly workspaceId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 单条详情判定：allow 携带视图；一切不可见 = canonical not-found。 */
export type ConversationDetailOutcome =
  | { readonly outcome: "allow"; readonly conversation: ConversationListView }
  | ResourceNotFoundVerdict;

/** 一页可见会话；nextCursor 为 null 表示可见流结束。 */
export interface ConversationListPage {
  readonly items: readonly ConversationListView[];
  readonly nextCursor: string | null;
}

export interface ConversationListService {
  /**
   * 受信 scope 的本人会话列表，keyset 分页只在可见流上。不可见对象不消耗
   * 页位、不偏移游标。
   */
  listVisibleConversations(
    scope: PlatformScope,
    options?: { readonly limit?: number; readonly cursor?: string },
  ): Promise<ConversationListPage>;

  /** 受信 scope 的本人会话计数；不可见对象不在计数内。 */
  countVisibleConversations(
    scope: PlatformScope,
  ): Promise<{ readonly total: number }>;

  /** 详情读取；不可见 = canonical not-found（MT011 冻结实例，逐字节同形）。 */
  readVisibleConversation(
    scope: PlatformScope,
    conversationId: string,
  ): Promise<ConversationDetailOutcome>;
}

// ---------------------------------------------------------------------------
// 输入校验（响亮拒绝；错误只含代码，绝不回显值）
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 游标 `at` 的时间戳形状：PG `timestamptz::text`（ISO DateStyle，空格分隔，
 * 数字时区偏移如 +00 / +05:30）与 ISO-8601（T 分隔，Z 或偏移）都接受。服务
 * 只消费自己签发的令牌，两种形态都能安全 ::timestamptz。
 */
const CURSOR_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

function assertScopeContext(scope: PlatformScope): void {
  if (!scope.tenantId?.trim()) throw new Error("TENANT_REQUIRED");
  if (!scope.workspaceId?.trim()) throw new Error("WORKSPACE_REQUIRED");
}

function assertPageLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new Error("CONVERSATIONS_LIMIT_INVALID");
  }
  return limit;
}

function assertConversationId(conversationId: string): string {
  if (
    typeof conversationId !== "string" ||
    !UUID_PATTERN.test(conversationId)
  ) {
    throw new Error("CONVERSATION_ID_INVALID");
  }
  return conversationId;
}

// ---------------------------------------------------------------------------
// 游标：服务自发的 opaque 令牌，只含调用方已见项的键（MT011/MT016 同款）
// ---------------------------------------------------------------------------

interface CursorPayload {
  readonly v: 1;
  readonly at: string;
  readonly id: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(token: string): CursorPayload {
  let parsed: unknown;
  try {
    const json = Buffer.from(token, "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    throw new Error("CONVERSATIONS_CURSOR_INVALID");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as CursorPayload).v !== 1 ||
    typeof (parsed as CursorPayload).at !== "string" ||
    (parsed as CursorPayload).at.trim() === "" ||
    typeof (parsed as CursorPayload).id !== "string" ||
    (parsed as CursorPayload).id.trim() === ""
  ) {
    throw new Error("CONVERSATIONS_CURSOR_INVALID");
  }
  // 修复轮 F2：`at` 必须是可被 ::timestamptz 解析的时间戳文本（服务自发签的
  // 是 PG created_at::text 形态；ISO-8601 也接受）。结构合法但非时间戳的令
  // 牌在 decode 时就落入既定拒绝码，绝不把裸驱动错误（PG 22007）泄漏给调
  // 用方。
  if (!CURSOR_TIMESTAMP_PATTERN.test((parsed as CursorPayload).at)) {
    throw new Error("CONVERSATIONS_CURSOR_INVALID");
  }
  // `id` 同理必须是会话 UUID：伪令牌的非法 id 进入 keyset 谓词会触发裸
  // 驱动错误（uuid 类型列的 22P02），同样不得泄漏给调用方。
  if (!UUID_PATTERN.test((parsed as CursorPayload).id)) {
    throw new Error("CONVERSATIONS_CURSOR_INVALID");
  }
  return parsed as CursorPayload;
}

/** 深冻结：调用方拿到不可变快照（与 MT014/MT016 同一纪律）。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 服务装配
// ---------------------------------------------------------------------------

/**
 * 装配入口。读路径走已验证 data 通道；未验证通道在装配时拒绝
 * （UNVERIFIED_DATABASE_CAPABILITY）——绝不以宽松替身服务流量。
 */
export function createConversationListService(
  data: DataDatabase,
): ConversationListService {
  assertDataDatabase(data);

  /**
   * 事务内成员事实重验（MT005 scope-gate 事务等价物的本模块切片，MT016
   * readMembershipFacts 同款）：公司级 = active 且 epoch === scope.memberEpoch
   * （MT006 撤权递增 epoch，已签发 scope 立即失效）；团队级 = active。
   */
  const readMembershipFacts = async (
    tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0],
    scope: PlatformScope,
  ): Promise<{
    readonly companyActive: boolean;
    readonly teamActive: boolean;
  }> => {
    const [company] = await tx
      .select({
        status: enterpriseMemberships.status,
        epoch: enterpriseMemberships.epoch,
      })
      .from(enterpriseMemberships)
      .where(
        and(
          eq(enterpriseMemberships.tenantId, scope.tenantId),
          eq(enterpriseMemberships.principalId, scope.principalId),
        ),
      )
      .limit(1);
    const [team] = await tx
      .select({ status: enterpriseWorkspaceMemberships.status })
      .from(enterpriseWorkspaceMemberships)
      .where(
        and(
          eq(enterpriseWorkspaceMemberships.tenantId, scope.tenantId),
          eq(enterpriseWorkspaceMemberships.workspaceId, scope.workspaceId),
          eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
        ),
      )
      .limit(1);
    return {
      companyActive:
        company?.status === "active" && company.epoch === scope.memberEpoch,
      teamActive: team?.status === "active",
    };
  };

  /** 事务开场（MT008/MT011/MT016 判定入口同一形状）。 */
  const beginContext = async (
    tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0],
    scope: PlatformScope,
  ): Promise<void> => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    /* Transaction-local settings are defense in depth for RLS and are cleared on commit. */
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
    );
    // 锁序：tenant → principal → membership → workspace-membership（读持
    // 共享锁；列表不持逐会话锁——候选集边界见模块头披露）。
    for (const key of [
      JSON.stringify(["enterprise", "tenant", scope.tenantId]),
      JSON.stringify(["enterprise", "principal", scope.principalId]),
      JSON.stringify([
        "enterprise",
        "membership",
        scope.tenantId,
        scope.principalId,
      ]),
      workspaceMembershipLockKey(
        scope.tenantId,
        scope.workspaceId,
        scope.principalId,
      ),
    ]) {
      await tx.execute(
        sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
      );
    }
  };

  const rowToView = (row: typeof enterpriseConversations.$inferSelect) =>
    deepFreeze({
      conversationId: row.id,
      threadId: row.threadId,
      title: row.title,
      storageBackend: row.storageBackend,
      lastSeq: row.lastSeq,
      workspaceId: row.workspaceId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });

  return {
    async listVisibleConversations(scope, options) {
      // 输入形状先于信任判定：缺公司/团队上下文与未签发 scope 得到各自的
      // 明确拒绝码（两者都是响亮拒绝，顺序不泄露任何信息——MT016 D5 口径）。
      assertScopeContext(scope);
      assertTrustedScope(scope);
      const limit = assertPageLimit(options?.limit);
      const cursor = options?.cursor ? decodeCursor(options.cursor) : null;
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        // 撤权者/非成员的列表为空页（不泄露任何存在性）。
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          return Object.freeze({
            items: Object.freeze([]),
            nextCursor: null,
          });
        }
        // keyset 读取：谓词含全部归属条件（租户 RLS 先行 + 团队 + 本人），
        // (created_at, id) 全序；取 limit+1 行——第 limit+1 个可见项只用来
        // 判断「还有下一页」，游标钉在最后一个可见项的键上。键源是 SQL 侧
        // created_at::text（保微秒；修复轮 F1，MT016 bots-ownership 同款）：
        // JS Date/toISOString 只到毫秒，微秒行会被下一页谓词重新纳入。
        const rows = await tx
          .select({
            ...getTableColumns(enterpriseConversations),
            createdAtText:
              sql<string>`${enterpriseConversations.createdAt}::text`.as(
                "created_at_text",
              ),
          })
          .from(enterpriseConversations)
          .where(
            and(
              eq(enterpriseConversations.tenantId, scope.tenantId),
              eq(enterpriseConversations.workspaceId, scope.workspaceId),
              eq(enterpriseConversations.principalId, scope.principalId),
              cursor
                ? sql`(${enterpriseConversations.createdAt}, ${enterpriseConversations.id}) > (${cursor.at}::timestamptz, ${cursor.id})`
                : undefined,
            ),
          )
          .orderBy(
            asc(enterpriseConversations.createdAt),
            asc(enterpriseConversations.id),
          )
          .limit(limit + 1);
        const items = rows.slice(0, limit).map((row) => rowToView(row));
        const nextCursor =
          rows.length > limit
            ? encodeCursor({
                v: 1,
                at: rows[limit - 1].createdAtText,
                id: rows[limit - 1].id,
              })
            : null;
        return Object.freeze({
          items: Object.freeze(items),
          nextCursor,
        });
      });
    },

    async countVisibleConversations(scope) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          return { total: 0 };
        }
        const [row] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(enterpriseConversations)
          .where(
            and(
              eq(enterpriseConversations.tenantId, scope.tenantId),
              eq(enterpriseConversations.workspaceId, scope.workspaceId),
              eq(enterpriseConversations.principalId, scope.principalId),
            ),
          );
        return { total: row?.total ?? 0 };
      });
    },

    async readVisibleConversation(scope, conversationId) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      const id = assertConversationId(conversationId);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        // 行经 RLS 租户过滤后，再验团队匹配 + 本人所有 + 成员事实重验。
        // 任一不成立 = canonical 不可见（不存在/跨公司/跨团队/他人会话/
        // 被撤权对外不可区分——MT011 冻结实例）。
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          return notFoundVerdict();
        }
        const [row] = await tx
          .select()
          .from(enterpriseConversations)
          .where(
            and(
              eq(enterpriseConversations.tenantId, scope.tenantId),
              eq(enterpriseConversations.id, id),
            ),
          )
          .limit(1);
        if (
          !row ||
          row.workspaceId !== scope.workspaceId ||
          row.principalId !== scope.principalId
        ) {
          return notFoundVerdict();
        }
        return Object.freeze({
          outcome: "allow" as const,
          conversation: rowToView(row),
        });
      });
    },
  };
}
