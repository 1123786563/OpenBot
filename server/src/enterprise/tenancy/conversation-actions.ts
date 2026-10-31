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

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { intelligenceChannelMappings } from "../../db/schema";
import {
  enterpriseConversations,
  enterpriseMessageParts,
  enterpriseMessages,
} from "../../db/schema/enterprise-conversations";
import {
  enterpriseMemberships,
  enterpriseResources,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope, ScopeResolver } from "../contracts";
import { messageDigest } from "../conversations/store";
import { assertDataDatabase, type DataDatabase } from "./connections";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import {
  createResourcePolicyService,
  createShippedResourcePolicyRegistry,
  type ResourcePolicyDecisionService,
} from "./resource-policy";
import { type WorkspaceGate, workspaceMembershipLockKey } from "./scope-gate";
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

// ---------------------------------------------------------------------------
// T06.02（Issue #574）：channels/thread 路由面的会话作用域动作端口适配器
// ---------------------------------------------------------------------------

/*
 * 会话/Channel/Thread 按稳定根归属、创建者及 read/write 等独立动作：
 *
 *   - Channel 面（detail/list/mutation 公共 route）：channel 的稳定根 =
 *     enterprise_resources(kind='channel')（root-backfill 的注册面）。根
 *     不在本公司（RLS 先行）或根本不存在 = 端口返回 null，遗留面行为原样
 *     （未迁移部署）。根在：判定按「会话根归属」+「MT008 注册表」：
 *       - 该 channel 下存在调用者自己的会话根（enterprise_conversations
 *         principal/workspace 匹配）= 创建者/持有者：read 与 write 都
 *         allow（会话元数据是本人的）；
 *       - 否则 read 交给 T06.01 的 ResourcePolicyDecisionService（显式
 *         read 授权或团队公共，版本由租户 policy_revision 决定）——同团队
 *         成员资格本身不是授权；write 对「可见但非持有者」= ACTION_FORBIDDEN
 *         （可读不派生可改，T06.01 同形 403），对不可见者与不存在同形
 *         404（不泄露存在性）。
 *   - Thread 面（thread-status route，子对象）：thread 的父根 = 它的
 *     会话根（tenant+threadId）或它的 channel 映射。会话根属于他人 =
 *     canonical not-found；映射存在但父 channel 根不在本公司 = not-found
 *     ——子对象不能跨父租户，且拒绝发生在触碰外部 reader 操作之前（零
 *     operation call）。无会话根也无映射 = 未治理的 thread（scratch/
 *     外部部署），null 交回遗留检查。
 *
 * 判定全部经受限 data 角色与真实 RLS（跨公司行对本事务不可见），事务纪律
 * 与本文件既有动作一致（read committed + timeout + set_config 事务本地 +
 * advisory 共享锁，键序 tenant → principal → membership → workspace-
 * membership → resource）。deny 唯一 404 形状；无默认身份、无异步补写。
 */

/** Resolver refusals that mean "no enterprise view for this caller". */
const SCOPE_RESOLVER_REFUSALS = new Set([
  "AUTH_REQUIRED",
  "TENANT_REQUIRED",
  "WORKSPACE_REQUIRED",
  "TENANT_FORBIDDEN",
  "WORKSPACE_FORBIDDEN",
  "SCOPE_REVOKED",
  "RESOURCE_NOT_FOUND",
]);

/** 端口判定形状（channels/routes.ts 与 thread-routes.ts 的结构孪生）。 */
export type ConversationScopeDecision =
  | { readonly outcome: "allow" }
  | { readonly outcome: "deny"; readonly code: "RESOURCE_NOT_FOUND" }
  | { readonly outcome: "deny"; readonly code: "ACTION_FORBIDDEN" };

const SCOPE_ALLOW: ConversationScopeDecision = Object.freeze({
  outcome: "allow",
} as const);
const SCOPE_NOT_FOUND: ConversationScopeDecision = Object.freeze({
  outcome: "deny",
  code: "RESOURCE_NOT_FOUND",
} as const);
const SCOPE_FORBIDDEN: ConversationScopeDecision = Object.freeze({
  outcome: "deny",
  code: "ACTION_FORBIDDEN",
} as const);

/**
 * The port the channels/thread routes consume. `null` from authorize* is not
 * a denial: it says the enterprise registry holds no root for the object, and
 * the route keeps its existing behavior for it.
 */
export interface ConversationScopeActions {
  /** Decides the channel detail read or a channel mutation for the caller. */
  authorizeChannel(
    request: Request,
    channelId: string,
    action: "read" | "write",
  ): Promise<ConversationScopeDecision | null>;
  /**
   * The roster's visibility filter: which of these channels the caller may
   * see. Ungoverned channels pass through (legacy stands); an unresolvable
   * scope sees nothing.
   */
  visibleChannelIds(
    request: Request,
    channelIds: readonly string[],
  ): Promise<ReadonlySet<string>>;
  /**
   * Decides whether the caller's company owns a thread's parent root. Deny
   * must be answered before any external thread operation is attempted;
   * null = ungoverned thread, the legacy check stands.
   */
  authorizeThread(
    request: Request,
    threadId: string,
  ): Promise<ConversationScopeDecision | null>;
}

/** What the assembly wires: the real channels plus the T06.01 seams. */
export interface ConversationScopeActionsDeps {
  readonly data: DataDatabase;
  /** The trusted-scope issuance (createBaScopeResolver / createScopeResolver). */
  readonly resolveScope: Pick<ScopeResolver, "resolve">;
  /** The live revalidation (createBaWorkspaceGate / createWorkspaceGate). */
  readonly gate: Pick<WorkspaceGate, "transaction">;
}

export function createConversationScopeActions(
  deps: ConversationScopeActionsDeps,
): ConversationScopeActions {
  assertDataDatabase(deps.data);
  const policy: ResourcePolicyDecisionService = createResourcePolicyService(
    deps.data,
    createShippedResourcePolicyRegistry(),
  );

  /**
   * Mint + live-revalidate, or null: a scope the resolver refuses or the gate
   * revokes leaves the caller with no enterprise view — canonical not-found,
   * never a fallback to some other identity.
   */
  const revalidatedScope = async (
    request: Request,
  ): Promise<PlatformScope | null> => {
    let scope: PlatformScope;
    try {
      scope = await deps.resolveScope.resolve(request);
    } catch (error) {
      if (
        error instanceof Error &&
        SCOPE_RESOLVER_REFUSALS.has(error.message)
      ) {
        return null;
      }
      throw error;
    }
    try {
      await deps.gate.transaction(scope, async () => undefined);
      return scope;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "SCOPE_REVOKED" ||
          error.message === "WORKSPACE_REVOKED")
      ) {
        return null;
      }
      throw error;
    }
  };

  type ScopeTransaction = Parameters<
    Parameters<DataDatabase["transaction"]>[0]
  >[0];

  /** 事务开场（本文件既有动作同一形状，resource 键随判定对象）。 */
  const beginScopeContext = async (
    tx: ScopeTransaction,
    scope: PlatformScope,
    resourceId: string,
  ): Promise<void> => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    /* Transaction-local settings are defense in depth for RLS and are cleared on commit. */
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
    );
    // 锁序：tenant → principal → membership → workspace-membership → resource
    //（resource-policy.policyReadTransaction 的同一键族）。
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
      JSON.stringify(["enterprise", "resource", scope.tenantId, resourceId]),
    ]) {
      await tx.execute(
        sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
      );
    }
  };

  /** 调用者是否在该 channel 下持有自己的会话根（创建者/持有者事实）。 */
  const ownsConversationIn = async (
    tx: ScopeTransaction,
    scope: PlatformScope,
    channelIds: readonly string[],
  ): Promise<ReadonlySet<string>> => {
    if (channelIds.length === 0) return new Set();
    const mappings = await tx
      .select({
        channelId: intelligenceChannelMappings.channelId,
        threadId: intelligenceChannelMappings.threadId,
      })
      .from(intelligenceChannelMappings)
      .where(inArray(intelligenceChannelMappings.channelId, [...channelIds]));
    if (mappings.length === 0) return new Set();
    const conversations = await tx
      .select({
        threadId: enterpriseConversations.threadId,
        principalId: enterpriseConversations.principalId,
        workspaceId: enterpriseConversations.workspaceId,
      })
      .from(enterpriseConversations)
      .where(
        and(
          eq(enterpriseConversations.tenantId, scope.tenantId),
          inArray(
            enterpriseConversations.threadId,
            mappings.map((row) => row.threadId),
          ),
        ),
      );
    const ownedThreads = new Set(
      conversations
        .filter(
          (row) =>
            row.principalId === scope.principalId &&
            row.workspaceId === scope.workspaceId,
        )
        .map((row) => row.threadId),
    );
    return new Set(
      mappings
        .filter((row) => ownedThreads.has(row.threadId))
        .map((row) => row.channelId),
    );
  };

  /** 该 channel 在本公司是否有稳定根（RLS 租户臂先行）。 */
  const channelRootExists = async (
    tx: ScopeTransaction,
    scope: PlatformScope,
    channelId: string,
  ): Promise<boolean> => {
    const [root] = await tx
      .select({ id: enterpriseResources.id })
      .from(enterpriseResources)
      .where(
        and(
          eq(enterpriseResources.tenantId, scope.tenantId),
          eq(enterpriseResources.id, channelId),
          eq(enterpriseResources.kind, "channel"),
        ),
      )
      .limit(1);
    return root != null;
  };

  /** read 判定折叠：策略 deny 与不可见同形。 */
  const readDecision = (
    verdict: Awaited<ReturnType<ResourcePolicyDecisionService["decide"]>>,
  ): ConversationScopeDecision =>
    verdict.outcome === "allow" ? SCOPE_ALLOW : SCOPE_NOT_FOUND;

  return {
    async authorizeChannel(request, channelId, action) {
      const scope = await revalidatedScope(request);
      if (!scope) return SCOPE_NOT_FOUND;
      return deps.data.transaction(async (tx) => {
        await beginScopeContext(tx, scope, channelId);
        if (!(await channelRootExists(tx, scope, channelId))) return null;
        const owned = await ownsConversationIn(tx, scope, [channelId]);
        if (owned.has(channelId)) return SCOPE_ALLOW;
        // 可见性交给 T06.01 的注册表（显式授权或团队公共）；write 对
        // 「可见但非持有者」= ACTION_FORBIDDEN，不可见者与不存在同形。
        const visible = await policy.decide(scope, channelId);
        if (action === "read") return readDecision(visible);
        return visible.outcome === "allow" ? SCOPE_FORBIDDEN : SCOPE_NOT_FOUND;
      });
    },

    async visibleChannelIds(request, channelIds) {
      if (channelIds.length === 0) return new Set();
      const scope = await revalidatedScope(request);
      // 无企业视图 = 无可见集（fail-closed，绝不回退默认身份）。
      if (!scope) return new Set();
      return deps.data.transaction(async (tx) => {
        await beginScopeContext(tx, scope, channelIds[0]);
        const roots = await tx
          .select({ id: enterpriseResources.id })
          .from(enterpriseResources)
          .where(
            and(
              eq(enterpriseResources.tenantId, scope.tenantId),
              eq(enterpriseResources.kind, "channel"),
              inArray(enterpriseResources.id, [...channelIds]),
            ),
          );
        const governed = new Set(roots.map((row) => row.id));
        // 未治理的 channel 原样通过：端口对它没有企业事实。
        const visible = new Set(channelIds.filter((id) => !governed.has(id)));
        const owned = await ownsConversationIn(tx, scope, [...governed]);
        const pending: string[] = [];
        for (const id of governed) {
          if (owned.has(id)) visible.add(id);
          else pending.push(id);
        }
        for (const id of pending) {
          const verdict = await policy.decide(scope, id);
          if (verdict.outcome === "allow") visible.add(id);
        }
        return visible;
      });
    },

    async authorizeThread(request, threadId) {
      const scope = await revalidatedScope(request);
      if (!scope) return SCOPE_NOT_FOUND;
      return deps.data.transaction(async (tx) => {
        await beginScopeContext(tx, scope, threadId);
        // 父根之一：会话根（tenant+threadId）。属于他人 = 不可见。
        const [conversation] = await tx
          .select({
            principalId: enterpriseConversations.principalId,
            workspaceId: enterpriseConversations.workspaceId,
          })
          .from(enterpriseConversations)
          .where(
            and(
              eq(enterpriseConversations.tenantId, scope.tenantId),
              eq(enterpriseConversations.threadId, threadId),
            ),
          )
          .limit(1);
        if (conversation) {
          return conversation.principalId === scope.principalId &&
            conversation.workspaceId === scope.workspaceId
            ? SCOPE_ALLOW
            : SCOPE_NOT_FOUND;
        }
        // 父根之二：channel 映射。无映射 = 未治理 thread，遗留检查原样。
        const [mapping] = await tx
          .select({
            userId: intelligenceChannelMappings.userId,
            channelId: intelligenceChannelMappings.channelId,
          })
          .from(intelligenceChannelMappings)
          .where(eq(intelligenceChannelMappings.threadId, threadId))
          .limit(1);
        if (!mapping) return null;
        // 子对象不能跨父租户：父 channel 根不在本公司 = 不可见，且绝
        // 不触碰外部 reader。
        if (!(await channelRootExists(tx, scope, mapping.channelId))) {
          return SCOPE_NOT_FOUND;
        }
        if (mapping.userId === scope.actorId) return SCOPE_ALLOW;
        return readDecision(await policy.decide(scope, mapping.channelId));
      });
    },
  };
}
