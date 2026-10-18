// server/src/enterprise/tenancy/conversation-actions.ts
// MT022（Issue #65）：会话内消息发送/读取/重命名/归档/历史 replay 的作用域授权。
//
// 票面语义（brief + Issue #65）：
//   AC1 非成员不能读写会话消息；不能通过历史 replay 绕过——replay 是独立
//       授权面（自带事务内成员/归属重验的独立事务），不是 read 的别名。
//   AC2 重命名与归档分别授权；可读不派生可改——每动作在各自事务内独立
//       重验全部事实，任何 allow 不缓存任何后续授权。归档在 MT022 为授权
//       判定面（escalation 裁定 Q2/方案B）：owner allow、非成员 canonical
//       not-found，本票零持久化零副作用（deny 与 allow 侧都不写）——持久
//       化（archived_at 列）留下游接线票，报告显著披露。
//   AC3 公共 Bot 使用者的个人会话按 MT018 先例 = 使用者本人私有；本模块按
//       归属谓词（workspace + principal）判定，团队他人/发布者一律 canonical
//       not-found（消费 MT021 冻结面的列表/详情在套件侧钉同一事实）。
//   AC4 撤权后（MT007 停用语义）消息读写与 replay 立即失效——公司级事实 =
//       active 且 epoch === scope.memberEpoch（epoch 臂，MT006 撤权/MT007
//       恢复递增 epoch）；status 臂独立判定（suspended 即拒，与 epoch 无关，
//       「无 epoch bump 依赖」）；团队级事实 = status active。全部在动作
//       自身事务内重验，不依赖任何已签发 scope 的缓存。
//   不可见语义 = MT011 canonical RESOURCE_NOT_FOUND 冻结实例（逐字节同形，
//   不存在/跨公司/跨团队/他人会话/被撤权对外不可区分）；deny 零写入零副
//   作用（一切拒绝发生在任何 INSERT/UPDATE 之前）。
//
// 结构（纯新增，只读消费 MT011/MT016/MT021 既有出口，不改任何既有文件）：
//   每动作一个数据事务，事务纪律与 MT008/MT011/MT016/MT021 判定入口完全
//   一致：assertScopeContext → assertTrustedScope → read committed +
//   lock/statement timeout → set_config('app.*', true) 事务本地 → advisory
//   共享锁（键序 tenant → principal → membership → workspace-membership；
//   写动作在归属与 backend 判定之后再取 conversation 排他锁，与既有
//   conversations 服务同一锁族键）→ 成员事实重验 → 会话归属比对（RLS 租户
//   臂先隐藏跨公司行，workspace + principal 比对是第二道独立防线）→ 执行
//   或 canonical verdict。事实读取全部经受限 data 角色与真实 RLS。
//
// 消息存储契约与既有 conversations 服务同源：digest 复用
// conversations/store.messageDigest（NFC 归一 + CRLF→LF + sha256），
// clientMessageKey 幂等（同键同 digest = 原样返回已有消息，不新占 seq）；
// 同键不同内容 = 响亮 message_conflict（409 语义，零写入）。消息面三动作
// 只对 storage_backend='platform' 生效（mastra/intelligence 写读仍归既有
// conversations 服务）；管理动作（重命名/归档判定）是会话级元数据，不限
// backend，且 backend 门在授权之后（非成员对 mastra 会话仍是 canonical
// not-found，不泄露存在性）。
//
// 输入校验响亮（错误只含代码，绝不回显值）：INVALID_THREAD_ID /
// INVALID_CLIENT_MESSAGE_KEY / INVALID_MESSAGE / CONVERSATION_ID_INVALID /
// INVALID_TITLE / INVALID_LIMIT（1..100，缺省 50）/ INVALID_CURSOR；
// 缺公司/团队上下文 TENANT_REQUIRED / WORKSPACE_REQUIRED（MT021 同序）；
// 未签发 scope UNVERIFIED_SCOPE（MT005 seam）；未验证通道装配
// UNVERIFIED_DATABASE_CAPABILITY。输入形状拒绝先于一切（与 MT021 D5 口径
// 一致：顺序不泄露任何信息）。
//
// 边界（诚实披露）：
//   - attachments 恒为 []（MT024 附件票范围）；parts 写入只含 text 项，
//     与既有 platform append 同构。
//   - 归档为判定面（allow/deny），不落 archived_at——见 AC2 注记。
//   - 本票不接路由：服务面供下游接线票复用（MT009/MT011/MT016/MT021 装配
//     同例）。

import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  enterpriseConversations,
  enterpriseMessageParts,
  enterpriseMessages,
} from "../../db/schema/enterprise-conversations";
import {
  enterpriseMemberships,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import { messageDigest } from "../conversations/store";
import { assertDataDatabase, type DataDatabase } from "./connections";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 视图与判定形状
// ---------------------------------------------------------------------------

/** 消息视图：可见成员可读的全部事实（时间以 ISO 字符串往返，深冻结）。 */
export interface ConversationMessageView {
  readonly messageId: string;
  readonly threadId: string;
  readonly seq: number;
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly attachments: readonly string[];
  readonly createdAt: string;
}

/** 会话管理视图：重命名/归档判定 allow 携带的事实（深冻结）。 */
export interface ConversationActionsView {
  readonly conversationId: string;
  readonly threadId: string;
  readonly title: string | null;
  readonly storageBackend: "platform" | "intelligence" | "mastra";
  readonly lastSeq: number;
  readonly workspaceId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 单条发送判定：allow 携带消息视图；一切不可见 = canonical not-found。 */
export type SendMessageOutcome =
  | { readonly outcome: "allow"; readonly message: ConversationMessageView }
  | ResourceNotFoundVerdict;

/** 一页消息（时间线最新一页，items 升序）；nextBeforeSeq 为 null 表示更早消息耗尽。 */
export interface ConversationMessagePage {
  readonly items: readonly ConversationMessageView[];
  readonly nextBeforeSeq: number | null;
}

/** 单次读取判定：allow 携带一页；一切不可见 = canonical not-found。 */
export type ReadMessagesOutcome =
  | { readonly outcome: "allow"; readonly page: ConversationMessagePage }
  | ResourceNotFoundVerdict;

/** 历史 replay 判定：独立授权面，allow 携带全线程升序消息。 */
export type ReplayHistoryOutcome =
  | {
      readonly outcome: "allow";
      readonly messages: readonly ConversationMessageView[];
    }
  | ResourceNotFoundVerdict;

/** 重命名判定：allow 携带管理视图；一切不可见 = canonical not-found。 */
export type RenameConversationOutcome =
  | {
      readonly outcome: "allow";
      readonly conversation: ConversationActionsView;
    }
  | ResourceNotFoundVerdict;

/** 归档判定（本票为纯判定面，零持久化）：allow/deny 同重命名形状。 */
export type ArchiveConversationOutcome =
  | {
      readonly outcome: "allow";
      readonly conversation: ConversationActionsView;
    }
  | ResourceNotFoundVerdict;

export interface ConversationActionsService {
  /** 发送消息（platform 会话）；不可见 = canonical not-found，deny 零写入。 */
  sendMessage(
    scope: PlatformScope,
    input: {
      readonly threadId: string;
      readonly clientMessageKey: string;
      readonly content: string;
    },
  ): Promise<SendMessageOutcome>;

  /**
   * 读取消息时间线（platform 会话）：无 beforeSeq 时返回最新一页，items
   * 升序；nextBeforeSeq 钉在更早一页的续读位（beforeSeq 语义：严格小于）。
   */
  readMessages(
    scope: PlatformScope,
    input: {
      readonly threadId: string;
      readonly limit?: number;
      readonly beforeSeq?: number;
    },
  ): Promise<ReadMessagesOutcome>;

  /** 历史 replay：独立授权面（独立事务独立重验），allow 携带全线程升序。 */
  replayHistory(
    scope: PlatformScope,
    input: { readonly threadId: string },
  ): Promise<ReplayHistoryOutcome>;

  /** 重命名（会话级元数据，不限 backend）；不可见 = canonical not-found。 */
  renameConversation(
    scope: PlatformScope,
    input: { readonly conversationId: string; readonly title: string },
  ): Promise<RenameConversationOutcome>;

  /** 归档判定（本票零持久化）；不可见 = canonical not-found。 */
  archiveConversation(
    scope: PlatformScope,
    input: { readonly conversationId: string },
  ): Promise<ArchiveConversationOutcome>;
}

// ---------------------------------------------------------------------------
// 输入校验（响亮拒绝；错误只含代码，绝不回显值）
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const MAX_ID_LENGTH = 200;
const MAX_CONTENT_LENGTH = 1_000_000;
const MAX_TITLE_LENGTH = 500;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertScopeContext(scope: PlatformScope): void {
  if (!scope.tenantId?.trim()) throw new Error("TENANT_REQUIRED");
  if (!scope.workspaceId?.trim()) throw new Error("WORKSPACE_REQUIRED");
}

function assertThreadId(threadId: string): string {
  if (
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    threadId.length > MAX_ID_LENGTH ||
    threadId.trim() !== threadId
  ) {
    throw new Error("INVALID_THREAD_ID");
  }
  return threadId;
}

function assertClientMessageKey(clientMessageKey: string): string {
  if (
    typeof clientMessageKey !== "string" ||
    clientMessageKey.length === 0 ||
    clientMessageKey.length > MAX_ID_LENGTH ||
    clientMessageKey.trim() !== clientMessageKey
  ) {
    throw new Error("INVALID_CLIENT_MESSAGE_KEY");
  }
  return clientMessageKey;
}

function assertMessageContent(content: string): string {
  if (typeof content !== "string" || content.length > MAX_CONTENT_LENGTH) {
    throw new Error("INVALID_MESSAGE");
  }
  return content;
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

function assertTitle(title: string): string {
  if (
    typeof title !== "string" ||
    title.length === 0 ||
    title.length > MAX_TITLE_LENGTH
  ) {
    throw new Error("INVALID_TITLE");
  }
  return title;
}

function assertPageLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new Error("INVALID_LIMIT");
  }
  return limit;
}

function assertBeforeSeq(beforeSeq: number | undefined): number | null {
  if (beforeSeq === undefined) return null;
  if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1) {
    throw new Error("INVALID_CURSOR");
  }
  return beforeSeq;
}

/** 深冻结：调用方拿到不可变快照（与 MT014/MT016/MT021 同一纪律）。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

const messageConflictError = () =>
  Object.assign(
    new Error("Message key was already used with different content."),
    { code: "message_conflict", status: 409 },
  );

type ActionsTransaction = Parameters<
  Parameters<DataDatabase["transaction"]>[0]
>[0];

// ---------------------------------------------------------------------------
// 服务装配
// ---------------------------------------------------------------------------

/**
 * 装配入口。全部动作走已验证 data 通道；未验证通道在装配时拒绝
 * （UNVERIFIED_DATABASE_CAPABILITY）——绝不以宽松替身服务流量。
 */
export function createConversationActionsService(
  data: DataDatabase,
): ConversationActionsService {
  assertDataDatabase(data);

  const rowToMessageView = (row: typeof enterpriseMessages.$inferSelect) =>
    deepFreeze({
      messageId: row.id,
      threadId: row.threadId,
      seq: row.seq,
      role: row.role as ConversationMessageView["role"],
      content: row.content,
      attachments: Object.freeze([...row.attachments]),
      createdAt: row.createdAt.toISOString(),
    });

  const rowToConversationView = (
    row: typeof enterpriseConversations.$inferSelect,
  ) =>
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

  /**
   * 事务内成员事实重验（MT021 readMembershipFacts 同款切片）：公司级 =
   * active 且 epoch === scope.memberEpoch（status 臂独立——suspended 即拒，
   * 「无 epoch bump 依赖」；epoch 臂由 MT006/MT007 的递增驱动已签发 scope
   * 失效）；团队级 = active。
   */
  const readMembershipFacts = async (
    tx: ActionsTransaction,
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

  /** 事务开场（MT008/MT011/MT016/MT021 判定入口同一形状）。 */
  const beginContext = async (
    tx: ActionsTransaction,
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
    // 共享锁）；写动作的 conversation 排他锁在归属判定之后补取，键族与既有
    // conversations 服务一致。
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

  const conversationExclusiveLock = async (
    tx: ActionsTransaction,
    tenantId: string,
    threadId: string,
  ): Promise<void> => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["conversation", tenantId, threadId])}, 0))`,
    );
  };

  /**
   * 授权切片：成员事实重验 → 按 threadId 加载会话行（RLS 租户臂先行）→
   * workspace + principal 归属比对。任一不成立 = canonical not-found。
   * 返回 null 表示不可见；调用方直接返回 notFoundVerdict()。
   */
  const authorizeByThread = async (
    tx: ActionsTransaction,
    scope: PlatformScope,
    threadId: string,
  ): Promise<typeof enterpriseConversations.$inferSelect | null> => {
    const facts = await readMembershipFacts(tx, scope);
    if (!facts.companyActive || !facts.teamActive) return null;
    const [row] = await tx
      .select()
      .from(enterpriseConversations)
      .where(
        and(
          eq(enterpriseConversations.tenantId, scope.tenantId),
          eq(enterpriseConversations.threadId, threadId),
        ),
      )
      .limit(1);
    if (
      !row ||
      row.workspaceId !== scope.workspaceId ||
      row.principalId !== scope.principalId
    ) {
      return null;
    }
    return row;
  };

  /** 同 authorizeByThread，但按会话 UUID 定位（重命名/归档判定面）。 */
  const authorizeByConversationId = async (
    tx: ActionsTransaction,
    scope: PlatformScope,
    conversationId: string,
  ): Promise<typeof enterpriseConversations.$inferSelect | null> => {
    const facts = await readMembershipFacts(tx, scope);
    if (!facts.companyActive || !facts.teamActive) return null;
    const [row] = await tx
      .select()
      .from(enterpriseConversations)
      .where(
        and(
          eq(enterpriseConversations.tenantId, scope.tenantId),
          eq(enterpriseConversations.id, conversationId),
        ),
      )
      .limit(1);
    if (
      !row ||
      row.workspaceId !== scope.workspaceId ||
      row.principalId !== scope.principalId
    ) {
      return null;
    }
    return row;
  };

  return {
    async sendMessage(scope, input) {
      // 输入形状先于上下文与信任判定（MT021 D5 口径：响亮拒绝的顺序不泄
      // 露任何信息）。
      const threadId = assertThreadId(input.threadId);
      const clientMessageKey = assertClientMessageKey(input.clientMessageKey);
      const rawContent = assertMessageContent(input.content);
      assertScopeContext(scope);
      assertTrustedScope(scope);
      const { content, digest } = messageDigest(rawContent, []);
      if (content.trim().length === 0) throw new Error("INVALID_MESSAGE");
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const conversation = await authorizeByThread(tx, scope, threadId);
        if (!conversation) return notFoundVerdict();
        // 消息面只对 platform backend 生效；非 platform 写读归既有
        // conversations 服务（授权之后的响亮拒绝，不泄露给非成员）。
        if (conversation.storageBackend !== "platform") {
          throw new Error("CONVERSATION_BACKEND_UNSUPPORTED");
        }
        await conversationExclusiveLock(tx, scope.tenantId, threadId);
        // 幂等臂：同键同 digest 原样返回已有消息（不新占 seq）；同键不同
        // 内容 = message_conflict（零写入）。
        const [existing] = await tx
          .select()
          .from(enterpriseMessages)
          .where(
            and(
              eq(enterpriseMessages.tenantId, scope.tenantId),
              eq(enterpriseMessages.threadId, threadId),
              eq(enterpriseMessages.clientMessageKey, clientMessageKey),
            ),
          )
          .limit(1);
        if (existing) {
          if (existing.digest !== digest) throw messageConflictError();
          return deepFreeze({
            outcome: "allow" as const,
            message: rowToMessageView(existing),
          });
        }
        const [sequence] = await tx
          .update(enterpriseConversations)
          .set({
            lastSeq: sql`${enterpriseConversations.lastSeq} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(enterpriseConversations.tenantId, scope.tenantId),
              eq(enterpriseConversations.threadId, threadId),
            ),
          )
          .returning({ lastSeq: enterpriseConversations.lastSeq });
        if (!sequence) return notFoundVerdict();
        const [saved] = await tx
          .insert(enterpriseMessages)
          .values({
            tenantId: scope.tenantId,
            threadId,
            seq: sequence.lastSeq,
            clientMessageKey,
            digest,
            role: "user",
            content,
            attachments: [],
          })
          .returning();
        if (content) {
          await tx.insert(enterpriseMessageParts).values({
            tenantId: scope.tenantId,
            messageId: saved.id,
            ordinal: 0,
            kind: "text",
            data: { text: content },
          });
        }
        return deepFreeze({
          outcome: "allow" as const,
          message: rowToMessageView(saved),
        });
      });
    },

    async readMessages(scope, input) {
      const threadId = assertThreadId(input.threadId);
      const limit = assertPageLimit(input.limit);
      const beforeSeq = assertBeforeSeq(input.beforeSeq);
      assertScopeContext(scope);
      assertTrustedScope(scope);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const conversation = await authorizeByThread(tx, scope, threadId);
        if (!conversation) return notFoundVerdict();
        if (conversation.storageBackend !== "platform") {
          throw new Error("CONVERSATION_BACKEND_UNSUPPORTED");
        }
        // 时间线最新一页：seq 降序读取（升序返回见上），nextBeforeSeq
        // 是更早一页的续读位（beforeSeq 严格小于语义）。
        const rows = await tx
          .select()
          .from(enterpriseMessages)
          .where(
            and(
              eq(enterpriseMessages.tenantId, scope.tenantId),
              eq(enterpriseMessages.threadId, threadId),
              beforeSeq === null
                ? undefined
                : sql`${enterpriseMessages.seq} < ${beforeSeq}`,
            ),
          )
          .orderBy(desc(enterpriseMessages.seq))
          .limit(limit + 1);
        // 降序取 limit+1 行，第 limit+1 行只判断「还有更早消息」；items 翻转
        // 为升序返回（时间线语义），nextBeforeSeq 钉在本页最早一条的 seq。
        const items = rows
          .slice(0, limit)
          .toReversed()
          .map((row) => rowToMessageView(row));
        const nextBeforeSeq = rows.length > limit ? items[0].seq : null;
        return deepFreeze({
          outcome: "allow" as const,
          page: deepFreeze({ items, nextBeforeSeq }),
        });
      });
    },

    async replayHistory(scope, input) {
      // replay 是独立授权面：独立输入校验、独立事务、独立成员/归属重验，
      // 绝不委托 readMessages（否则它就是读的别名，AC1 的绕过面）。
      const threadId = assertThreadId(input.threadId);
      assertScopeContext(scope);
      assertTrustedScope(scope);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const conversation = await authorizeByThread(tx, scope, threadId);
        if (!conversation) return notFoundVerdict();
        if (conversation.storageBackend !== "platform") {
          throw new Error("CONVERSATION_BACKEND_UNSUPPORTED");
        }
        const rows = await tx
          .select()
          .from(enterpriseMessages)
          .where(
            and(
              eq(enterpriseMessages.tenantId, scope.tenantId),
              eq(enterpriseMessages.threadId, threadId),
            ),
          )
          .orderBy(asc(enterpriseMessages.seq));
        return deepFreeze({
          outcome: "allow" as const,
          messages: rows.map((row) => rowToMessageView(row)),
        });
      });
    },

    async renameConversation(scope, input) {
      const conversationId = assertConversationId(input.conversationId);
      const title = assertTitle(input.title);
      assertScopeContext(scope);
      assertTrustedScope(scope);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const conversation = await authorizeByConversationId(
          tx,
          scope,
          conversationId,
        );
        if (!conversation) return notFoundVerdict();
        // 会话级元数据写（不限 backend）；排他锁与既有写者同族，防并发
        // append/rename 交错。
        await conversationExclusiveLock(
          tx,
          scope.tenantId,
          conversation.threadId,
        );
        const [updated] = await tx
          .update(enterpriseConversations)
          .set({ title, updatedAt: new Date() })
          .where(
            and(
              eq(enterpriseConversations.tenantId, scope.tenantId),
              eq(enterpriseConversations.id, conversationId),
            ),
          )
          .returning();
        if (!updated) return notFoundVerdict();
        return deepFreeze({
          outcome: "allow" as const,
          conversation: rowToConversationView(updated),
        });
      });
    },

    async archiveConversation(scope, input) {
      const conversationId = assertConversationId(input.conversationId);
      assertScopeContext(scope);
      assertTrustedScope(scope);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const conversation = await authorizeByConversationId(
          tx,
          scope,
          conversationId,
        );
        if (!conversation) return notFoundVerdict();
        // MT022 的归档 = 授权判定面（escalation 裁定 Q2/方案B）：owner
        // allow、非成员 canonical not-found；本票零持久化零副作用
        // （archived_at 留下游接线票）。
        return deepFreeze({
          outcome: "allow" as const,
          conversation: rowToConversationView(conversation),
        });
      });
    },
  };
}
