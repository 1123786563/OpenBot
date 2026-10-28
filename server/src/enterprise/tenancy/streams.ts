// server/src/enterprise/tenancy/streams.ts
// MT025（Issue #68）：事件流订阅授权与外部线程映射归属。
//
// 票面语义：socket/SSE 订阅按订阅者权限校验，事件正文不泄露无权内容；
// 与外部服务建立的线程映射固定公司团队归属，切换团队不会让旧线程
// 继续推送。
//
// 结构（纯新增，零 schema 对象，只读消费 MT011 既有出口）：
//
//   1. 订阅 = enterprise_resources kind='event-subscription'（id 服务端
//      随机、displayName=threadId、workspace=订阅时 scope 团队）。
//      visibility 列双态生命周期（NULL=活跃 / 'private'=已取消——
//      operator 唯一可 UPDATE 列，与 MT024 附件同款披露）。
//   2. 订阅门（AC1）：开订阅重验目标会话可见性（同租户同团队同
//      principal 的会话行）；被撤权（MT006 停用，epoch 递增）后 scope
//      签发面直接死亡。推送面每次重验订阅者当前事实：公司/团队
//      active + epoch 匹配 + 订阅行活跃——撤权后推送返回
//      {stopped, closed}（停止推送并关闭连接语义的判定面表达）。
//   3. 事件正文（AC2）：推送正文是白名单闭形 {type, status, message}
//      ——错误与状态事件同样只透传这三字段；payload 里的任何资源
//      引用、归属键、错误细节在服务面就不可表达（构造方传不进来），
//      订阅者无权的内容不进入正文是形状保证，不是过滤约定。
//   4. 外部线程映射（AC3）：resources kind='thread-mapping'
//      （id=`map:<externalId>`、displayName=内部 threadId、workspace=
//      建立时归属）。id 是 (tenant, id) 主键——同一外部串在两租户是
//      各自的行；另一公司的线程 ID 查询/续订在 RLS 租户臂之外先
//      nothing 可见（canonical not-found）。
//   5. 切换范围（AC4）：开订阅时同一 principal 在其他 workspace 的
//      活跃订阅一律关闭（visibility → 'private'）——切换团队后旧
//      范围订阅被取消，旧订阅的推送面立即 closed，不产生跨范围推送。
//
// 事务纪律与 MT019/MT020/MT023/MT024 一致：受信 Scope → read
// committed + lock/statement timeout → set_config 事务本地 → advisory
// 锁（键序 tenant → principal → membership → workspace-membership →
// subscription/mapping）。读路径受限 data 角色，写路径受限 operator
// 角色。
//
// 边界（诚实披露）：
//   - 真实 socket/SSE 传输层不在本票：本模块是订阅授权与推送判定面
//     （挂传输的接线票消费）；"关闭连接"的表达=推送面 closed 判定。
//   - 事件持久化（outbox/断线重放）不在本票：推送是判定+返回形状。
//   - 会话可见性走 data 通道读 enterprise_conversations（授权面是
//     ob_ent_data，与 MT024 绑定同款披露）。

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { enterpriseConversations } from "../../db/schema/enterprise-conversations";
import {
  enterpriseMemberships,
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import {
  assertDataDatabase,
  assertOperatorDatabase,
  type DataDatabase,
  type OperatorDatabase,
} from "./connections";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 词表与形状
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_RESOURCE_KIND = "event-subscription";
export const THREAD_MAPPING_KIND = "thread-mapping";

export type StreamVerdict<T> =
  | ({ readonly outcome: "allow" } & T)
  | ResourceNotFoundVerdict;

/** 推送正文白名单闭形（AC2：形状保证，构造面不可表达更多字段）。 */
export interface StreamEventBody {
  readonly type: "message" | "status" | "error";
  readonly status: "ok" | "failed";
  readonly message: string;
}

export type PushOutcome =
  | { readonly outcome: "delivered"; readonly body: StreamEventBody }
  /** 订阅者已无有效事实（撤权/取消/切换范围）：停止推送并关闭。 */
  | { readonly outcome: "closed" }
  | ResourceNotFoundVerdict;

function assertScopeContext(scope: PlatformScope): void {
  if (!scope.tenantId?.trim()) throw new Error("TENANT_REQUIRED");
  if (!scope.workspaceId?.trim()) throw new Error("WORKSPACE_REQUIRED");
}

function assertThreadId(threadId: string): string {
  if (
    typeof threadId !== "string" ||
    threadId.trim().length === 0 ||
    threadId.length > 256
  ) {
    throw new Error("THREAD_ID_INVALID");
  }
  return threadId;
}

function assertExternalId(externalId: string): string {
  if (
    typeof externalId !== "string" ||
    externalId.trim().length === 0 ||
    externalId.length > 256 ||
    externalId.includes(":")
  ) {
    throw new Error("EXTERNAL_THREAD_ID_INVALID");
  }
  return externalId;
}

function assertEventBody(input: StreamEventBody): StreamEventBody {
  if (
    !input ||
    // 白名单闭形：多一个键都不行（AC2 的形状保证在构造面收口）。
    Object.keys(input).length !== 3 ||
    !["message", "status", "error"].includes(input.type) ||
    !["ok", "failed"].includes(input.status) ||
    typeof input.message !== "string" ||
    input.message.length > 2000
  ) {
    throw new Error("STREAM_EVENT_BODY_INVALID");
  }
  return input;
}

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
// 服务
// ---------------------------------------------------------------------------

export interface StreamSubscriptionService {
  /**
   * 开订阅（AC1）：目标会话可见门；同一 principal 在其他 workspace 的
   * 活跃订阅同时关闭（AC4：切换范围即收旧）。
   */
  openSubscription(
    scope: PlatformScope,
    input: { readonly threadId: string },
  ): Promise<StreamVerdict<{ readonly subscriptionId: string }>>;
  /**
   * 推送（AC1/AC2）：订阅者当前事实重验（撤权/取消 → closed），正文为
   * 白名单闭形。
   */
  pushEvent(
    scope: PlatformScope,
    subscriptionId: string,
    body: StreamEventBody,
  ): Promise<PushOutcome>;
  /** 取消订阅（visibility → 'private'）。 */
  cancelSubscription(
    scope: PlatformScope,
    subscriptionId: string,
  ): Promise<StreamVerdict<{ readonly subscriptionId: string }>>;
  /**
   * 建立外部线程映射（AC3）：归属 = 发起 scope；同串在两租户各为
   * 独立行。
   */
  bindExternalThread(
    scope: PlatformScope,
    input: { readonly externalId: string; readonly threadId: string },
  ): Promise<StreamVerdict<{ readonly mappingId: string }>>;
  /** 按外部串读内部线程（AC3）：另一公司的串 canonical not-found。 */
  readThreadByExternal(
    scope: PlatformScope,
    externalId: string,
  ): Promise<StreamVerdict<{ readonly threadId: string }>>;
  /**
   * 按外部串续订（AC3）：重验映射归属 + 订阅者事实；另一公司的串
   * 无法续订。
   */
  renewSubscriptionByExternal(
    scope: PlatformScope,
    externalId: string,
  ): Promise<StreamVerdict<{ readonly threadId: string }>>;
}

export function createStreamSubscriptionService(channels: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
}): StreamSubscriptionService {
  assertDataDatabase(channels.data);
  assertOperatorDatabase(channels.operator);
  const { data, operator } = channels;

  type Tx =
    | Parameters<Parameters<DataDatabase["transaction"]>[0]>[0]
    | Parameters<Parameters<OperatorDatabase["transaction"]>[0]>[0];

  const beginContext = async (
    tx: Tx,
    scope: {
      readonly tenantId: string;
      readonly workspaceId?: string;
      readonly principalId?: string;
      readonly actorId?: string;
    },
  ): Promise<void> => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId ?? ""}, true), set_config('app.principal_id', ${scope.principalId ?? ""}, true), set_config('app.user_id', ${scope.actorId ?? ""}, true)`,
    );
  };

  const baseLockKeys = (scope: {
    readonly tenantId: string;
    readonly principalId?: string;
    readonly workspaceId?: string;
  }): readonly string[] => [
    JSON.stringify(["enterprise", "tenant", scope.tenantId]),
    ...(scope.principalId
      ? [
          JSON.stringify(["enterprise", "principal", scope.principalId]),
          JSON.stringify([
            "enterprise",
            "membership",
            scope.tenantId,
            scope.principalId,
          ]),
        ]
      : []),
    ...(scope.principalId && scope.workspaceId
      ? [
          workspaceMembershipLockKey(
            scope.tenantId,
            scope.workspaceId,
            scope.principalId,
          ),
        ]
      : []),
  ];

  const takeLocks = async (
    tx: Tx,
    keys: readonly { readonly key: string; exclusive: boolean }[],
  ): Promise<void> => {
    for (const { key, exclusive } of keys) {
      await tx.execute(
        exclusive
          ? sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`
          : sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
      );
    }
  };

  const streamLockKey = (tenantId: string, id: string): string =>
    JSON.stringify(["enterprise", "stream", tenantId, id]);

  /**
   * 订阅者当前事实（事务内一次受限读取）：公司 active + epoch 匹配 +
   * 团队 active。null = 事实已死（撤权/停用/换团队）。
   */
  const readSubscriberFacts = async (
    tx: Tx,
    scope: PlatformScope,
  ): Promise<boolean> => {
    const [row] = await tx
      .select({
        companyStatus: enterpriseMemberships.status,
        companyEpoch: enterpriseMemberships.epoch,
        teamStatus: enterpriseWorkspaceMemberships.status,
      })
      .from(enterpriseMemberships)
      .leftJoin(
        enterpriseWorkspaceMemberships,
        and(
          eq(
            enterpriseWorkspaceMemberships.tenantId,
            enterpriseMemberships.tenantId,
          ),
          eq(
            enterpriseWorkspaceMemberships.workspaceId,
            scope.workspaceId ?? "",
          ),
          eq(
            enterpriseWorkspaceMemberships.principalId,
            enterpriseMemberships.principalId,
          ),
        ),
      )
      .where(
        and(
          eq(enterpriseMemberships.tenantId, scope.tenantId),
          eq(enterpriseMemberships.principalId, scope.principalId),
        ),
      )
      .limit(1);
    if (!row) return false;
    return (
      row.companyStatus === "active" &&
      row.companyEpoch === scope.memberEpoch &&
      row.teamStatus === "active"
    );
  };

  /** 活跃订阅行读取（data 通道；RLS 租户臂 + 订阅者 grant 事实）。 */
  const readSubscription = async (
    tx: Tx,
    scope: PlatformScope,
    subscriptionId: string,
  ): Promise<{ readonly threadId: string } | null> => {
    // 订阅是个人事实：订阅行配 grants read 行（开订阅时写入），
    // 推送面 join 验订阅者身份——他人 scope 对该行不可见。
    const [row] = await tx
      .select({
        displayName: enterpriseResources.displayName,
        workspaceId: enterpriseResources.workspaceId,
        status: enterpriseResources.status,
        visibility: enterpriseResources.visibility,
        subscriberGrant: enterpriseResourceGrants.principalId,
      })
      .from(enterpriseResources)
      .innerJoin(
        enterpriseResourceGrants,
        and(
          eq(enterpriseResourceGrants.tenantId, enterpriseResources.tenantId),
          eq(enterpriseResourceGrants.resourceId, enterpriseResources.id),
          eq(enterpriseResourceGrants.action, "read"),
          eq(enterpriseResourceGrants.principalId, scope.principalId),
        ),
      )
      .where(
        and(
          eq(enterpriseResources.tenantId, scope.tenantId),
          eq(enterpriseResources.id, subscriptionId),
          eq(enterpriseResources.kind, SUBSCRIPTION_RESOURCE_KIND),
        ),
      )
      .limit(1);
    if (
      row?.status !== "active" ||
      row.visibility !== null ||
      row.workspaceId !== scope.workspaceId
    ) {
      return null;
    }
    return { threadId: row.displayName };
  };

  /** 关闭（visibility → 'private'）一行；返回是否发生翻转。 */
  const closeRow = async (
    tx: Tx,
    tenantId: string,
    id: string,
  ): Promise<boolean> => {
    await tx.execute(sql`select set_config('app.resource_id', ${id}, true)`);
    const updated = await tx
      .update(enterpriseResources)
      .set({ visibility: "private" })
      .where(
        and(
          eq(enterpriseResources.tenantId, tenantId),
          eq(enterpriseResources.id, id),
          sql`${enterpriseResources.visibility} is null`,
        ),
      )
      .returning({ id: enterpriseResources.id });
    return updated.length > 0;
  };

  return {
    async openSubscription(scope, input) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      if (!input) throw new Error("STREAM_INPUT_INVALID");
      const threadId = assertThreadId(input.threadId);
      // 订阅门（AC1）：目标会话对本 scope 可见——conversations 的读
      // 授权面是 ob_ent_data（与 MT024 绑定同款披露：会话读取与订阅
      // 写入分两个事务）。
      const conversationVisible = await data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
        ]);
        const [conversation] = await tx
          .select({ threadId: enterpriseConversations.threadId })
          .from(enterpriseConversations)
          .where(
            and(
              eq(enterpriseConversations.tenantId, scope.tenantId),
              eq(enterpriseConversations.workspaceId, scope.workspaceId),
              // 个人会话语义（MT022 同源）：他人会话对本 scope 不可见。
              eq(enterpriseConversations.principalId, scope.principalId),
              eq(enterpriseConversations.threadId, threadId),
            ),
          )
          .limit(1);
        return conversation !== undefined;
      });
      if (!conversationVisible) return notFoundVerdict();
      // AC4 的订阅者线程清单同样经 data 通道预取（conversations 的读
      // 授权面是 ob_ent_data；operator 事务只碰 resources）。
      const ownThreads = await data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
        ]);
        const rows = await tx
          .select({ threadId: enterpriseConversations.threadId })
          .from(enterpriseConversations)
          .where(
            and(
              eq(enterpriseConversations.tenantId, scope.tenantId),
              eq(enterpriseConversations.principalId, scope.principalId),
            ),
          );
        return rows.map((row) => row.threadId);
      });
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
        ]);
        // AC4：同一 principal 在其他 workspace 的活跃订阅一律关闭
        // （切换公司/团队后旧范围订阅被取消）。
        const staleRows =
          ownThreads.length === 0
            ? []
            : await tx
                .select({ id: enterpriseResources.id })
                .from(enterpriseResources)
                // 订阅是个人事实（readSubscription 同款）：只关闭本人订阅行，
                // 同名 threadId 的他人订阅不得被本 principal 翻转。
                .innerJoin(
                  enterpriseResourceGrants,
                  and(
                    eq(
                      enterpriseResourceGrants.tenantId,
                      enterpriseResources.tenantId,
                    ),
                    eq(
                      enterpriseResourceGrants.resourceId,
                      enterpriseResources.id,
                    ),
                    eq(enterpriseResourceGrants.action, "read"),
                    eq(enterpriseResourceGrants.principalId, scope.principalId),
                  ),
                )
                .where(
                  and(
                    eq(enterpriseResources.tenantId, scope.tenantId),
                    eq(enterpriseResources.kind, SUBSCRIPTION_RESOURCE_KIND),
                    sql`${enterpriseResources.visibility} is null`,
                    sql`${enterpriseResources.status} = 'active'`,
                    sql`${enterpriseResources.workspaceId} <> ${scope.workspaceId}`,
                    inArray(enterpriseResources.displayName, ownThreads),
                  ),
                );
        for (const row of staleRows) {
          await closeRow(tx, scope.tenantId, row.id);
        }
        const subscriptionId = `sub-${randomUUID()}`;
        await tx.insert(enterpriseResources).values({
          tenantId: scope.tenantId,
          id: subscriptionId,
          workspaceId: scope.workspaceId,
          kind: SUBSCRIPTION_RESOURCE_KIND,
          displayName: threadId,
        });
        // 订阅者身份的持久事实（个人订阅语义；推送面 join 验证）。
        await tx
          .insert(enterpriseResourceGrants)
          .values({
            tenantId: scope.tenantId,
            resourceId: subscriptionId,
            principalId: scope.principalId,
            action: "read",
          })
          .onConflictDoNothing();
        return deepFreeze({ outcome: "allow", subscriptionId });
      });
    },

    async pushEvent(scope, subscriptionId, body) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertEventBody(body);
      const frozenBody = deepFreeze({ ...body });
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          {
            key: streamLockKey(scope.tenantId, subscriptionId),
            exclusive: false,
          },
        ]);
        // 推送面事实重验（AC1）：订阅行活跃 + 订阅者当前事实。
        const subscription = await readSubscription(tx, scope, subscriptionId);
        if (!subscription) {
          // 订阅行已取消/失效（private/非 active/已切范围）：契约语义是
          //「停止推送并关闭」，与撤权同臂，不折叠为 canonical not-found。
          return { outcome: "closed" } as const;
        }
        const alive = await readSubscriberFacts(tx, scope);
        if (!alive) {
          // 撤权/停用：停止推送并关闭连接语义（判定面表达）。
          return { outcome: "closed" } as const;
        }
        // AC2：正文即白名单闭形（构造面不可表达更多字段）。
        return { outcome: "delivered", body: frozenBody } as const;
      });
    },

    async cancelSubscription(scope, subscriptionId) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          {
            key: streamLockKey(scope.tenantId, subscriptionId),
            exclusive: true,
          },
        ]);
        // 订阅是个人事实（readSubscription 同款 join）：订阅 id 泄露给同
        // workspace 他人时，他人 scope 也不得取消本人订阅。
        const [row] = await tx
          .select({ id: enterpriseResources.id })
          .from(enterpriseResources)
          .innerJoin(
            enterpriseResourceGrants,
            and(
              eq(
                enterpriseResourceGrants.tenantId,
                enterpriseResources.tenantId,
              ),
              eq(enterpriseResourceGrants.resourceId, enterpriseResources.id),
              eq(enterpriseResourceGrants.action, "read"),
              eq(enterpriseResourceGrants.principalId, scope.principalId),
            ),
          )
          .where(
            and(
              eq(enterpriseResources.tenantId, scope.tenantId),
              eq(enterpriseResources.id, subscriptionId),
              eq(enterpriseResources.kind, SUBSCRIPTION_RESOURCE_KIND),
              eq(enterpriseResources.workspaceId, scope.workspaceId),
              sql`${enterpriseResources.visibility} is null`,
            ),
          )
          .limit(1);
        if (!row) return notFoundVerdict();
        await closeRow(tx, scope.tenantId, subscriptionId);
        return deepFreeze({ outcome: "allow", subscriptionId });
      });
    },

    async bindExternalThread(scope, input) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      if (!input) throw new Error("STREAM_INPUT_INVALID");
      const externalId = assertExternalId(input.externalId);
      const threadId = assertThreadId(input.threadId);
      // 目标会话可见门（与开订阅同源；conversations 读授权面是
      // ob_ent_data）。
      const conversationVisible = await data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
        ]);
        const [conversation] = await tx
          .select({ threadId: enterpriseConversations.threadId })
          .from(enterpriseConversations)
          .where(
            and(
              eq(enterpriseConversations.tenantId, scope.tenantId),
              eq(enterpriseConversations.workspaceId, scope.workspaceId),
              eq(enterpriseConversations.principalId, scope.principalId),
              eq(enterpriseConversations.threadId, threadId),
            ),
          )
          .limit(1);
        return conversation !== undefined;
      });
      if (!conversationVisible) return notFoundVerdict();
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          {
            key: streamLockKey(scope.tenantId, `map:${externalId}`),
            exclusive: true,
          },
        ]);
        const mappingId = `map:${externalId}`;
        await tx.execute(
          sql`select set_config('app.resource_id', ${mappingId}, true)`,
        );
        // 映射不可变：operator 对本表只有 visibility 列的 UPDATE 授权，
        // 重绑同串幂等返回既有行；同串改绑新 thread 是改映射语义，不在
        // 本票（撤旧建新属下游接线票）。
        await tx
          .insert(enterpriseResources)
          .values({
            tenantId: scope.tenantId,
            id: mappingId,
            workspaceId: scope.workspaceId,
            kind: THREAD_MAPPING_KIND,
            displayName: threadId,
          })
          .onConflictDoNothing();
        return deepFreeze({ outcome: "allow", mappingId });
      });
    },

    async readThreadByExternal(scope, externalId) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertExternalId(externalId);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
        ]);
        const [row] = await tx
          .select({
            displayName: enterpriseResources.displayName,
            workspaceId: enterpriseResources.workspaceId,
            status: enterpriseResources.status,
          })
          .from(enterpriseResources)
          .where(
            and(
              eq(enterpriseResources.tenantId, scope.tenantId),
              eq(enterpriseResources.id, `map:${externalId}`),
              eq(enterpriseResources.kind, THREAD_MAPPING_KIND),
            ),
          )
          .limit(1);
        // 另一公司的映射行在 RLS 租户臂之外不可见：canonical not-found。
        if (row?.status !== "active") return notFoundVerdict();
        if (row.workspaceId !== scope.workspaceId) return notFoundVerdict();
        const alive = await readSubscriberFacts(tx, scope);
        if (!alive) return notFoundVerdict();
        return deepFreeze({ outcome: "allow", threadId: row.displayName });
      });
    },

    async renewSubscriptionByExternal(scope, externalId) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertExternalId(externalId);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
        ]);
        const [row] = await tx
          .select({
            displayName: enterpriseResources.displayName,
            workspaceId: enterpriseResources.workspaceId,
            status: enterpriseResources.status,
          })
          .from(enterpriseResources)
          .where(
            and(
              eq(enterpriseResources.tenantId, scope.tenantId),
              eq(enterpriseResources.id, `map:${externalId}`),
              eq(enterpriseResources.kind, THREAD_MAPPING_KIND),
            ),
          )
          .limit(1);
        if (row?.status !== "active") return notFoundVerdict();
        if (row.workspaceId !== scope.workspaceId) return notFoundVerdict();
        const alive = await readSubscriberFacts(tx, scope);
        if (!alive) return notFoundVerdict();
        return deepFreeze({ outcome: "allow", threadId: row.displayName });
      });
    },
  };
}
