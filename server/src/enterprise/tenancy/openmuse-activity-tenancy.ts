// server/src/enterprise/tenancy/openmuse-activity-tenancy.ts
// MT065（Issue #108）：OpenMuse 活动流与通知的归属与正文过滤。
//
// 票面语义（brief + Issue #108）：
//   AC1 活动流只包含当前范围条目；切换范围后不显示旧范围条目——聚合读
//      按协会行三元组过滤（通知协会表本模块自有；审阅动作协会表 MT064
//      所有，本模块只读聚合——单一写者纪律，读取面在此注明所有权）；
//      切换三元组 = 新事务新集合，旧范围条目结构性不在结果里。
//   AC2 通知投递前校验接收者权限；无权者不收到且正文不泄露内容——
//      authorizeNotificationDelivery 是投递/sweep 的判定门：allow 才携带
//      正文（title/detail）；一切拒绝 = MT011 canonical
//      RESOURCE_NOT_FOUND（无正文字段——正文不泄露是形状不是纪律）。
//   AC3 撤销权限后停止后续投递，已投递内容不可被无权者读取——撤权后
//      authorize* 一律拒绝（活查语义）；readNotification 对无权读者 =
//      canonical not-found（已投递行仍在，但无权者读不到）。
//   AC4 通知渠道与推送设备绑定到具体用户与范围——
//      openmuse_delivery_binding_scopes 把渠道绑定钉到 (用户, 三元组)；
//      authorizeBindingDelivery 是渠道投递的判定门（推送设备的对应面在
//      MT066）。
//
// 结构（纯新增，消费 MT005/MT011 既有出口与既有 openmuse-notifications
// 权威 store——两张归属协会表是本模块的唯一新持久化对象）：
//
//   1. 归属（pinNotificationScope/pinDeliveryBindingScope）：emit/绑定接线
//      时固定 (公司, 团队, 主体, 用户) 归属——create-once；同三元组幂等
//      existing；不同选择标识一律 MISMATCH 响亮拒绝；缺有效成员事实
//      WORKSPACE_MEMBERSHIP_REQUIRED（响亮创建门）。
//   2. 活动流聚合（listScopedActivity，AC1）：受限 data 通道 + 事务本地
//      上下文 + 真实 RLS → 事务内成员事实重验 → 两源协会行各按三元组读
//      本人条目 → 合并稳定序 (created_at DESC, kind, id DESC)。
//   3. 投递判定门（authorizeNotificationDelivery/authorizeBindingDelivery，
//      AC2/AC3/AC4）：成员重验 + 协会三元组比对；通知门 allow 携带正文，
//      其余一切 = canonical not-found（零正文）。sweep 侧在发送前调用
//      （下游接线票的消费面）。
//   4. 通知读取（readNotification，AC3 后半）：协会门先于委托既有 rows
//      缝读根行；无权者 = canonical not-found。
//
// 事务纪律与 MT060–MT064 完全一致：assertTrustedScope → read committed +
// lock/statement timeout → set_config('app.*', …, true) 事务本地 →
// advisory 锁（键序 tenant → principal → membership → workspace-membership；
// 读共享、写排他）→ 成员事实重验 → 判定或执行。
//
// 不可见语义：canonical { outcome: "deny", code: "RESOURCE_NOT_FOUND" }
// 冻结实例（MT011 唯一事实源，逐字节同形）。
//
// 边界（诚实披露）：
//   - 本票不接路由/装配：投递/sweep 的调用点接线归下游票；本模块提供判
//     定门与聚合面（MT060/MT061 同例）。
//   - 正文过滤的语义 = 无权者拿不到正文（allow 才有正文 + 拒绝同形）；
//     对有权者的正文改写/截断不是本票语义（票面「正文不含其无权访问的
//     内容」）。
//   - 审阅动作协会表（openmuse_reviewed_action_scopes）归 MT064 所有：
//     本模块只读聚合，不写不删。

import { and, eq, sql } from "drizzle-orm";
import {
  enterpriseMemberships,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import {
  type OpenMuseDeliveryBindingScopeRow,
  type OpenMuseNotificationScopeRow,
  openmuseDeliveryBindingScopes,
  openmuseNotificationScopes,
} from "../../db/schema/openmuse-activity-tenancy";
import { openmuseReviewedActionScopes } from "../../db/schema/openmuse-reviewed-action-tenancy";
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
// 视图与判定形状
// ---------------------------------------------------------------------------

/** 归属视图：一条通知在一个三元组上的 (公司, 团队, 主体, 用户) 事实。 */
export interface OpenMuseNotificationScopeView {
  readonly notificationId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly createdAt: Date;
}

/** 归属视图：一条渠道绑定在一个三元组上的事实。 */
export interface OpenMuseDeliveryBindingScopeView {
  readonly bindingId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly createdAt: Date;
}

/** 通知根行投影（既有 StoredOpenMuseNotification 的最小子集）。 */
export interface ScopedNotificationRecord {
  readonly id: string;
  readonly eventKind: string;
  readonly title: string;
  readonly detail: string | null;
  readonly createdAt: Date;
}

/** 渠道绑定根行投影。 */
export interface ScopedDeliveryBindingRecord {
  readonly id: string;
  readonly transport: string;
  readonly enabled: boolean;
}

/** 活动流条目（AC1 聚合的统一形状；kind 区分两源）。 */
export interface ScopedActivityEntry {
  readonly kind: "reviewed_action" | "notification";
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly createdAt: Date;
}

/** 通知读取判定：allow 携带归属与根行；一切不可见 = canonical not-found。 */
export type NotificationReadOutcome =
  | {
      readonly outcome: "allow";
      readonly ownership: OpenMuseNotificationScopeView;
      readonly notification: ScopedNotificationRecord;
    }
  | ResourceNotFoundVerdict;

/**
 * AC2 投递判定门：allow 才携带正文（title/detail）；拒绝 = canonical
 * not-found——形状上没有正文字段，无权者不收到也不泄露内容。
 */
export type NotificationDeliveryAuthorization =
  | {
      readonly outcome: "allow";
      readonly ownership: OpenMuseNotificationScopeView;
      readonly body: {
        readonly title: string;
        readonly detail: string | null;
      };
    }
  | ResourceNotFoundVerdict;

/** 渠道投递判定门：allow / canonical not-found（零正文）。 */
export type DeliveryBindingAuthorization =
  | {
      readonly outcome: "allow";
      readonly ownership: OpenMuseDeliveryBindingScopeView;
      readonly binding: ScopedDeliveryBindingRecord;
    }
  | ResourceNotFoundVerdict;

/** 归属 pin 结果：首建 pinned / 幂等 existing；不可见 = canonical not-found。 */
export type ScopePinResult<TView> =
  | { readonly status: "pinned"; readonly ownership: TView }
  | { readonly status: "existing"; readonly ownership: TView }
  | ResourceNotFoundVerdict;

// ---------------------------------------------------------------------------
// 拒绝：哨兵码 + canonical not-found（绝不回显归属或输入值）
// ---------------------------------------------------------------------------

export const OPENMUSE_ACTIVITY_SCOPE_INVALID =
  "OPENMUSE_ACTIVITY_SCOPE_INVALID";
export const OPENMUSE_ACTIVITY_SCOPE_MISMATCH =
  "OPENMUSE_ACTIVITY_SCOPE_MISMATCH";
export const OPENMUSE_ACTIVITY_CURSOR_INVALID =
  "OPENMUSE_ACTIVITY_CURSOR_INVALID";
/** 创建响亮门（MT059/MT016/MT060 同字面量：缺有效成员事实时创建拒绝）。 */
export const OPENMUSE_ACTIVITY_WORKSPACE_MEMBERSHIP_REQUIRED =
  "WORKSPACE_MEMBERSHIP_REQUIRED";

function failInvalid(rule: string): never {
  throw new Error(`${OPENMUSE_ACTIVITY_SCOPE_INVALID}: ${rule}`);
}

// ---------------------------------------------------------------------------
// 输入校验（形状错误响亮拒绝；错误只含规则，不回显值）
// ---------------------------------------------------------------------------

const ID_MAX = 200;

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > ID_MAX) {
    failInvalid(
      `${field} must be a non-empty string of at most ${ID_MAX} characters`,
    );
  }
  return value;
}

/** 活动流页大小：1..100（既有活动面 ACTIVITY_MAX_LIMIT 同上限）。 */
const LIST_LIMIT_MAX = 100;

// ---------------------------------------------------------------------------
// 行缝：既有 openmuse-notifications / delivery 权威面的最小投影
// ---------------------------------------------------------------------------

/**
 * 既有权威面的最小投影。emit/markRead 等语义全部归既有
 * openmuse-notifications/store.ts 与 delivery/store.ts 权威，本模块零复
 * 刻、只做范围门后的委托。
 */
export type OpenMuseActivityTenancyRows = {
  /** owner 的一条通知根行（不存在/外来 = null）。 */
  findOwnedNotification(
    ownerUserId: string,
    notificationId: string,
  ): Promise<ScopedNotificationRecord | null>;
  listNotificationsByIds(
    ownerUserId: string,
    notificationIds: readonly string[],
  ): Promise<readonly ScopedNotificationRecord[]>;
  /** owner 的一条渠道绑定根行（不存在/外来 = null）。 */
  findOwnedBinding(
    ownerUserId: string,
    bindingId: string,
  ): Promise<ScopedDeliveryBindingRecord | null>;
};

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface OpenMuseActivityTenancyService {
  /**
   * emit 接线时的通知归属固定（AC1/AC2 写半边）。外来通知（根行不存在/
   * 非本人）= canonical not-found；同三元组幂等 existing；不同选择标识
   * MISMATCH 响亮拒绝且已存归属不动。
   */
  pinNotificationScope(
    scope: PlatformScope,
    input: { readonly notificationId: string },
  ): Promise<ScopePinResult<OpenMuseNotificationScopeView>>;

  /**
   * 渠道绑定接线时的归属固定（AC4）。同款 create-once 语义。
   */
  pinDeliveryBindingScope(
    scope: PlatformScope,
    input: { readonly bindingId: string },
  ): Promise<ScopePinResult<OpenMuseDeliveryBindingScopeView>>;

  /**
   * AC1 活动流聚合：只返回当前三元组的条目（通知 + 审阅动作两源）；公
   * 司级撤销响亮拒绝（SCOPE_REVOKED）；团队级撤销 = 空页。稳定序
   * (created_at DESC, kind, id DESC)。
   */
  listScopedActivity(
    scope: PlatformScope,
    page: { readonly limit: number },
  ): Promise<{
    readonly entries: readonly ScopedActivityEntry[];
  }>;

  /**
   * AC2 投递判定门（通知半边）：成员重验 + 协会三元组；allow 携带正文，
   * 拒绝 = canonical not-found（无权者不收到，正文零泄露）。
   */
  authorizeNotificationDelivery(
    scope: PlatformScope,
    input: { readonly notificationId: string },
  ): Promise<NotificationDeliveryAuthorization>;

  /**
   * AC3 已投递内容的读取门：协会门先于根行读取；无权者（同团队他人/
   * 跨团队/跨公司/撤权）= canonical not-found。
   */
  readNotification(
    scope: PlatformScope,
    notificationId: string,
  ): Promise<NotificationReadOutcome>;

  /**
   * AC2/AC4 渠道投递判定门：成员重验 + 绑定协会三元组；撤权后拒绝
   * （AC3 停止后续投递的判定半边）。
   */
  authorizeBindingDelivery(
    scope: PlatformScope,
    input: { readonly bindingId: string },
  ): Promise<DeliveryBindingAuthorization>;
}

const READ_TX_SETUP = sql`set transaction isolation level read committed`;
const TIMEOUTS = [
  sql`set local lock_timeout = '2s'`,
  sql`set local statement_timeout = '5s'`,
] as const;

type DataTx = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];
type OperatorTx = Parameters<Parameters<OperatorDatabase["transaction"]>[0]>[0];

export function createOpenMuseActivityTenancyService(deps: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  readonly rows: OpenMuseActivityTenancyRows;
}): OpenMuseActivityTenancyService {
  assertDataDatabase(deps.data);
  assertOperatorDatabase(deps.operator);

  const { data, operator, rows } = deps;

  /** 事务开场（MT060–MT064 判定入口同一形状）。 */
  const beginContext = async (
    tx: DataTx | OperatorTx,
    scope: PlatformScope,
  ) => {
    await tx.execute(READ_TX_SETUP);
    for (const timeout of TIMEOUTS) await tx.execute(timeout);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
    );
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

  /** 事务内成员事实重验（公司 active + epoch；团队 active）。 */
  const readMembershipFacts = async (tx: DataTx, scope: PlatformScope) => {
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
        company?.status === "active" && company?.epoch === scope.memberEpoch,
      teamActive: team?.status === "active",
    };
  };

  /** 通知协会门（对象面唯一判定入口）；任何不成立 = null。 */
  const authorizeNotification = async (
    scope: PlatformScope,
    notificationId: string,
  ): Promise<OpenMuseNotificationScopeView | null> =>
    data.transaction(async (tx) => {
      await beginContext(tx, scope);
      const facts = await readMembershipFacts(tx, scope);
      if (!facts.companyActive || !facts.teamActive) return null;
      const [row] = await tx
        .select()
        .from(openmuseNotificationScopes)
        .where(eq(openmuseNotificationScopes.notificationId, notificationId))
        .limit(1);
      if (!row) return null;
      if (
        row.tenantId !== scope.tenantId ||
        row.workspaceId !== scope.workspaceId ||
        row.principalId !== scope.principalId
      ) {
        return null;
      }
      return notificationViewOf(row);
    });

  /** 绑定协会门（对象面唯一判定入口）；任何不成立 = null。 */
  const authorizeBinding = async (
    scope: PlatformScope,
    bindingId: string,
  ): Promise<OpenMuseDeliveryBindingScopeView | null> =>
    data.transaction(async (tx) => {
      await beginContext(tx, scope);
      const facts = await readMembershipFacts(tx, scope);
      if (!facts.companyActive || !facts.teamActive) return null;
      const [row] = await tx
        .select()
        .from(openmuseDeliveryBindingScopes)
        .where(eq(openmuseDeliveryBindingScopes.bindingId, bindingId))
        .limit(1);
      if (!row) return null;
      if (
        row.tenantId !== scope.tenantId ||
        row.workspaceId !== scope.workspaceId ||
        row.principalId !== scope.principalId
      ) {
        return null;
      }
      return bindingViewOf(row);
    });

  return {
    async pinNotificationScope(scope, input) {
      assertTrustedScope(scope);
      const notificationId = requireId(input.notificationId, "notificationId");
      // 外来通知（根行不存在/非本人）与不存在不可区分。
      const owned = await rows.findOwnedNotification(
        scope.actorId,
        notificationId,
      );
      if (!owned) return notFoundVerdict();
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          throw new Error(OPENMUSE_ACTIVITY_WORKSPACE_MEMBERSHIP_REQUIRED);
        }
        const [inserted] = await tx
          .insert(openmuseNotificationScopes)
          .values({
            notificationId,
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
            userId: scope.actorId,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted) {
          return {
            status: "pinned" as const,
            ownership: notificationViewOf(inserted),
          };
        }
        const [existing] = await tx
          .select()
          .from(openmuseNotificationScopes)
          .where(eq(openmuseNotificationScopes.notificationId, notificationId))
          .limit(1);
        if (
          !existing ||
          existing.tenantId !== scope.tenantId ||
          existing.workspaceId !== scope.workspaceId ||
          existing.principalId !== scope.principalId ||
          existing.userId !== scope.actorId
        ) {
          throw new Error(
            `${OPENMUSE_ACTIVITY_SCOPE_MISMATCH}: notification is already owned by a different scope`,
          );
        }
        return {
          status: "existing" as const,
          ownership: notificationViewOf(existing),
        };
      });
    },

    async pinDeliveryBindingScope(scope, input) {
      assertTrustedScope(scope);
      const bindingId = requireId(input.bindingId, "bindingId");
      const owned = await rows.findOwnedBinding(scope.actorId, bindingId);
      if (!owned) return notFoundVerdict();
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          throw new Error(OPENMUSE_ACTIVITY_WORKSPACE_MEMBERSHIP_REQUIRED);
        }
        const [inserted] = await tx
          .insert(openmuseDeliveryBindingScopes)
          .values({
            bindingId,
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
            userId: scope.actorId,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted) {
          return {
            status: "pinned" as const,
            ownership: bindingViewOf(inserted),
          };
        }
        const [existing] = await tx
          .select()
          .from(openmuseDeliveryBindingScopes)
          .where(eq(openmuseDeliveryBindingScopes.bindingId, bindingId))
          .limit(1);
        if (
          !existing ||
          existing.tenantId !== scope.tenantId ||
          existing.workspaceId !== scope.workspaceId ||
          existing.principalId !== scope.principalId ||
          existing.userId !== scope.actorId
        ) {
          throw new Error(
            `${OPENMUSE_ACTIVITY_SCOPE_MISMATCH}: delivery binding is already owned by a different scope`,
          );
        }
        return {
          status: "existing" as const,
          ownership: bindingViewOf(existing),
        };
      });
    },

    async listScopedActivity(scope, page) {
      assertTrustedScope(scope);
      if (
        typeof page?.limit !== "number" ||
        !Number.isInteger(page.limit) ||
        page.limit < 1 ||
        page.limit > LIST_LIMIT_MAX
      ) {
        failInvalid(`limit must be an integer between 1 and ${LIST_LIMIT_MAX}`);
      }
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive) {
          throw new Error("SCOPE_REVOKED");
        }
        if (!facts.teamActive) {
          return { entries: [] as ScopedActivityEntry[] };
        }
        // 两源各按三元组读本人协会行（restrictive 主体自读臂下的本人
        // 面）；审阅动作协会表归 MT064 所有，此处只读聚合。同一事务连接
        // 上顺序执行（并发查询无收益且会借出额外连接）。
        const notificationRows = await tx
          .select()
          .from(openmuseNotificationScopes)
          .where(
            and(
              eq(openmuseNotificationScopes.tenantId, scope.tenantId),
              eq(openmuseNotificationScopes.workspaceId, scope.workspaceId),
              eq(openmuseNotificationScopes.principalId, scope.principalId),
            ),
          )
          .orderBy(
            sql`${openmuseNotificationScopes.createdAt} DESC, ${openmuseNotificationScopes.notificationId} DESC`,
          )
          .limit(page.limit);
        const reviewedRows = await tx
          .select()
          .from(openmuseReviewedActionScopes)
          .where(
            and(
              eq(openmuseReviewedActionScopes.tenantId, scope.tenantId),
              eq(openmuseReviewedActionScopes.workspaceId, scope.workspaceId),
              eq(openmuseReviewedActionScopes.principalId, scope.principalId),
            ),
          )
          .orderBy(
            sql`${openmuseReviewedActionScopes.createdAt} DESC, ${openmuseReviewedActionScopes.actionId} DESC`,
          )
          .limit(page.limit);
        const entries: ScopedActivityEntry[] = [
          ...notificationRows.map((row) =>
            entryOf("notification", row.notificationId, row),
          ),
          ...reviewedRows.map((row) =>
            entryOf("reviewed_action", row.actionId, row),
          ),
        ];
        entries.sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        );
        return { entries: entries.slice(0, page.limit) };
      });
    },

    async authorizeNotificationDelivery(scope, input) {
      assertTrustedScope(scope);
      const notificationId = requireId(input.notificationId, "notificationId");
      const ownership = await authorizeNotification(scope, notificationId);
      if (!ownership) return notFoundVerdict();
      const notification = await rows.findOwnedNotification(
        ownership.userId,
        notificationId,
      );
      if (!notification) return notFoundVerdict();
      // AC2：正文只在 allow 上携带——拒绝形状没有正文字段。
      return {
        outcome: "allow" as const,
        ownership,
        body: {
          title: notification.title,
          detail: notification.detail,
        },
      };
    },

    async readNotification(scope, notificationId) {
      assertTrustedScope(scope);
      const id = requireId(notificationId, "notificationId");
      const ownership = await authorizeNotification(scope, id);
      if (!ownership) return notFoundVerdict();
      const notification = await rows.findOwnedNotification(
        ownership.userId,
        id,
      );
      if (!notification) return notFoundVerdict();
      return { outcome: "allow" as const, ownership, notification };
    },

    async authorizeBindingDelivery(scope, input) {
      assertTrustedScope(scope);
      const bindingId = requireId(input.bindingId, "bindingId");
      const ownership = await authorizeBinding(scope, bindingId);
      if (!ownership) return notFoundVerdict();
      const binding = await rows.findOwnedBinding(ownership.userId, bindingId);
      if (!binding) return notFoundVerdict();
      return { outcome: "allow" as const, ownership, binding };
    },
  };
}

// ---------------------------------------------------------------------------
// 形状映射（模块底部小件）
// ---------------------------------------------------------------------------

function notificationViewOf(
  row: OpenMuseNotificationScopeRow,
): OpenMuseNotificationScopeView {
  return {
    notificationId: row.notificationId,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    principalId: row.principalId,
    userId: row.userId,
    createdAt: row.createdAt,
  };
}

function bindingViewOf(
  row: OpenMuseDeliveryBindingScopeRow,
): OpenMuseDeliveryBindingScopeView {
  return {
    bindingId: row.bindingId,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    principalId: row.principalId,
    userId: row.userId,
    createdAt: row.createdAt,
  };
}

function entryOf(
  kind: ScopedActivityEntry["kind"],
  id: string,
  row: {
    tenantId: string;
    workspaceId: string;
    principalId: string;
    userId: string;
    createdAt: Date;
  },
): ScopedActivityEntry {
  return {
    kind,
    id,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    principalId: row.principalId,
    userId: row.userId,
    createdAt: row.createdAt,
  };
}
