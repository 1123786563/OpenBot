// server/src/enterprise/tenancy/openmuse-reviewed-action-tenancy.ts
// MT064（Issue #107）：OpenMuse 审阅动作提案与回执的归属。
//
// 票面语义（brief + Issue #107）：
//   AC1 提案与回执按归属授权；跨范围访问返回不可见语义——协会行三元组
//      （租户臂 RLS + restrictive 主体自读）先于一切提案/回执读取；回执经
//      action FK 级联继承同一归属；一切不可见 = MT011 canonical
//      RESOURCE_NOT_FOUND 逐字节同形。
//   AC2 确认与取消只对有权限的主体生效，且状态变化留审计——scopedDecide/
//      scopedCancel 协会门先于委托既有 reviewed-actions 服务（决策语义零
//      复刻）；每次生效的状态变化写一条企业审计事件（MT078 business 域，
//      经真实 recordTenantAuditEvent）。
//   AC3 既有精确动作提案/确认/取消行为回归通过——本模块零改动既有
//      openmuse-reviewed-actions 面（纯新增）；回归由既有套件钉死。
//   AC4 撤权后待处理提案不可继续操作——成员事实重验失败后 scopedDecide/
//      scopedCancel 折叠为不可见（canonical not-found），根行零副作用、
//      executor 零拨号。
//
// 结构（纯新增，消费 MT005/MT011/MT078 既有出口与既有
// openmuse-reviewed-actions 权威服务——归属协会表是本模块的唯一新持久化
// 对象）：
//
//   1. 归属（pinReviewedActionScope）：propose 接线时固定 (公司, 团队,
//      主体, 用户) 归属——create-once；同三元组幂等 existing；不同选择
//      标识一律 OPENMUSE_REVIEWED_ACTION_SCOPE_MISMATCH 响亮拒绝且已存行
//      不动；缺有效成员事实 WORKSPACE_MEMBERSHIP_REQUIRED（响亮创建门）。
//   2. 范围化读取（listReviewedActions/readReviewedAction/
//      readReviewedReceipt）：受限 data 通道 + 事务本地上下文 + 真实 RLS
//      → 事务内公司（active + epoch）与团队（active）事实重验 → 协会行
//      三元组比对（第二道独立防线）→ 委托既有 rows 缝读根行。回执经
//      receiptOf 缝（既有服务 §6 回执面）在协会门后读取。公司级撤销在
//      列表面响亮拒绝（SCOPE_REVOKED）；团队级撤销 = 空页；对象面一律
//      不可见。
//   3. 范围化决策（scopedDecide/scopedCancel，AC2/AC4）：协会门 +
//      成员重验先于委托；委托返回 null（根行不存在/非本 owner——门后不
//      可能，防御性同形）= canonical not-found；生效变化后写审计事件，
//      审计失败原样上抛（审计缺失绝不折叠成成功——MT078 纪律）。
//
// 事务纪律与 MT060–MT062 完全一致：assertTrustedScope → read committed +
// lock/statement timeout → set_config('app.*', …, true) 事务本地 →
// advisory 锁（键序 tenant → principal → membership → workspace-membership；
// 读共享、写排他）→ 成员事实重验 → 判定或执行。
//
// 不可见语义：canonical { outcome: "deny", code: "RESOURCE_NOT_FOUND" }
// 冻结实例（MT011 唯一事实源，逐字节同形）。
//
// 边界（诚实披露）：
//   - 本票不接路由/装配：服务面供下游接线票复用（MT060/MT061 同例）。
//   - 提案动作本体的发起（propose）归既有服务；本模块只管归属与范围化
//     决策面。审计事件的消费/导出面归 MT078 域。

import { and, eq, sql } from "drizzle-orm";
import {
  enterpriseMemberships,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import {
  type OpenMuseReviewedActionScopeRow,
  openmuseReviewedActionScopes,
} from "../../db/schema/openmuse-reviewed-action-tenancy";
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

/** 归属视图：一条审阅动作提案的 (公司, 团队, 主体, 用户) 事实。 */
export interface OpenMuseReviewedActionScopeView {
  readonly actionId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly createdAt: Date;
}

/** 根行投影：rows 缝返回的提案最小面（既有 StoredReviewedAction 的子集）。 */
export interface ScopedReviewedActionRecord {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly accountEmail: string;
  readonly createdAt: Date;
}

/** 范围化列表条目：根行投影 + 归属事实。 */
export interface ScopedReviewedAction {
  readonly ownership: OpenMuseReviewedActionScopeView;
  readonly action: ScopedReviewedActionRecord;
}

/** 单对象读取判定：allow 携带归属与根行；一切不可见 = canonical not-found。 */
export type ReviewedActionReadOutcome =
  | {
      readonly outcome: "allow";
      readonly ownership: OpenMuseReviewedActionScopeView;
      readonly action: ScopedReviewedActionRecord;
    }
  | ResourceNotFoundVerdict;

/** 归属 pin 结果：首建 pinned / 幂等 existing；不可见 = canonical not-found。 */
export type ReviewedActionScopePinResult =
  | {
      readonly status: "pinned";
      readonly ownership: OpenMuseReviewedActionScopeView;
    }
  | {
      readonly status: "existing";
      readonly ownership: OpenMuseReviewedActionScopeView;
    }
  | ResourceNotFoundVerdict;

/** §6 回执的投影面（既有 ReviewedActionReceipt 的最小子集）。 */
export interface ScopedReviewedReceipt {
  readonly attemptId: string;
  readonly providerRef: string | null;
  readonly decidedAt: Date | null;
  readonly attemptedAt: Date | null;
  readonly completedAt: Date | null;
}

/** 回执读取判定：allow 携带归属与回执；一切不可见 = canonical not-found。 */
export type ReviewedReceiptReadOutcome =
  | {
      readonly outcome: "allow";
      readonly ownership: OpenMuseReviewedActionScopeView;
      readonly receipt: ScopedReviewedReceipt;
    }
  | ResourceNotFoundVerdict;

/** 范围化决策结局：allow 携带决策后根行；不可见 = canonical not-found。 */
export type ScopedDecisionOutcome =
  | {
      readonly outcome: "allow";
      readonly ownership: OpenMuseReviewedActionScopeView;
      readonly action: ScopedReviewedActionRecord;
      /** 本次决策写入的审计事件 id（AC2 状态变化留审计的事实）。 */
      readonly auditEventId: string | null;
    }
  | ResourceNotFoundVerdict;

// ---------------------------------------------------------------------------
// 拒绝：哨兵码 + canonical not-found（绝不回显归属或输入值）
// ---------------------------------------------------------------------------

export const OPENMUSE_REVIEWED_ACTION_SCOPE_INVALID =
  "OPENMUSE_REVIEWED_ACTION_SCOPE_INVALID";
export const OPENMUSE_REVIEWED_ACTION_SCOPE_MISMATCH =
  "OPENMUSE_REVIEWED_ACTION_SCOPE_MISMATCH";
export const OPENMUSE_REVIEWED_ACTION_CURSOR_INVALID =
  "OPENMUSE_REVIEWED_ACTION_CURSOR_INVALID";
/** 创建响亮门（MT059/MT016/MT060 同字面量：缺有效成员事实时创建拒绝）。 */
export const OPENMUSE_REVIEWED_ACTION_WORKSPACE_MEMBERSHIP_REQUIRED =
  "WORKSPACE_MEMBERSHIP_REQUIRED";

function failInvalid(rule: string): never {
  throw new Error(`${OPENMUSE_REVIEWED_ACTION_SCOPE_INVALID}: ${rule}`);
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

/** 列表页大小：1..100（既有 reviewed-actions 路由的合同上限一致）。 */
const LIST_LIMIT_MAX = 100;

// ---------------------------------------------------------------------------
// 行缝：既有 openmuse-reviewed-actions 权威面的最小投影
// ---------------------------------------------------------------------------

/**
 * 既有权威面的最小投影。propose/decide/cancel/reconcile 等语义全部归既有
 * openmuse-reviewed-actions/{service,store}.ts 权威，本模块零复刻、只做范
 * 围门后的委托。listActionsByIds 是范围化列表的批量取行面（一查
 * inArray——MT060 listTasksByIds 同例）。
 */
export type OpenMuseReviewedActionTenancyRows = {
  /** owner 的一条提案根行（不存在/外来 = null）。 */
  findOwnedAction(
    ownerUserId: string,
    actionId: string,
  ): Promise<ScopedReviewedActionRecord | null>;
  listActionsByIds(
    ownerUserId: string,
    actionIds: readonly string[],
  ): Promise<readonly ScopedReviewedActionRecord[]>;
};

/**
 * 既有 reviewed-actions 服务的决策/回执缝——装配注入真实
 * createOpenMuseReviewedActionService 的对应方法；本模块从不复刻决策语义。
 */
export type ReviewedDecisionSeam = {
  decide(
    ownerUserId: string,
    id: string,
    decision: "approve" | "deny",
  ): Promise<ScopedReviewedActionRecord | null>;
  cancel(
    ownerUserId: string,
    id: string,
  ): Promise<ScopedReviewedActionRecord | null>;
  /** §6 回执面：actionId 的回执或 null。 */
  receiptOf(actionId: string): Promise<ScopedReviewedReceipt | null>;
};

/**
 * MT078 审计缝——装配注入 (event) => recordTenantAuditEvent(operator, event)
 * 的绑定；本模块只决定事件的事实形状（domain 由装配钉为 business），不触
 * 碰审计域通道。
 */
export type ReviewedAuditSeam = (event: {
  readonly tenantId: string;
  readonly eventType: string;
  readonly actorId: string;
  readonly targetId: string;
  readonly payload: Record<string, unknown>;
}) => Promise<{ eventId: string }>;

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface OpenMuseReviewedActionTenancyService {
  /**
   * propose 接线时的归属固定（AC1 写半边）。外来提案（根行不存在/非本
   * 人）= canonical not-found；同三元组重放幂等 existing；不同选择标识
   * 一律 MISMATCH 响亮拒绝且已存归属不动。
   */
  pinReviewedActionScope(
    scope: PlatformScope,
    input: { readonly actionId: string },
  ): Promise<ReviewedActionScopePinResult>;

  /**
   * 范围化列表（AC1）：只返回 (tenant, workspace, principal) 三元组下本人
   * 的提案；公司级撤销响亮拒绝（SCOPE_REVOKED）；团队级撤销 = 空页。
   * 分页 keyset 稳定序 (created_at DESC, action_id DESC)。
   */
  listReviewedActions(
    scope: PlatformScope,
    page: { readonly limit: number; readonly cursor?: string },
  ): Promise<{
    readonly actions: readonly ScopedReviewedAction[];
    readonly nextCursor?: string;
  }>;

  /** 范围化读取（AC1）：不可见 = canonical not-found。 */
  readReviewedAction(
    scope: PlatformScope,
    actionId: string,
  ): Promise<ReviewedActionReadOutcome>;

  /**
   * 范围化回执读取（AC1 回执半边）：回执经协会门后由 receiptOf 缝读取
   * （回执继承 action 归属）；不可见 = canonical not-found。
   */
  readReviewedReceipt(
    scope: PlatformScope,
    actionId: string,
  ): Promise<ReviewedReceiptReadOutcome>;

  /**
   * AC2 范围化确认：协会门 + 成员重验先于委托既有 decide；生效变化写
   * 审计事件（openmuse.reviewed_action.decided）。无权/撤权/跨范围 =
   * canonical not-found，根行零副作用。
   */
  scopedDecide(
    scope: PlatformScope,
    actionId: string,
    decision: "approve" | "deny",
  ): Promise<ScopedDecisionOutcome>;

  /**
   * AC2 范围化取消：同 scopedDecide（审计事件
   * openmuse.reviewed_action.cancelled）。
   */
  scopedCancel(
    scope: PlatformScope,
    actionId: string,
  ): Promise<ScopedDecisionOutcome>;
}

const READ_TX_SETUP = sql`set transaction isolation level read committed`;
const TIMEOUTS = [
  sql`set local lock_timeout = '2s'`,
  sql`set local statement_timeout = '5s'`,
] as const;

type DataTx = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];
type OperatorTx = Parameters<Parameters<OperatorDatabase["transaction"]>[0]>[0];

export function createOpenMuseReviewedActionTenancyService(deps: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  readonly rows: OpenMuseReviewedActionTenancyRows;
  /** 既有服务的决策/回执面（AC2/AC1 委托，零复刻）。 */
  readonly decisions: ReviewedDecisionSeam;
  /** MT078 审计缝（AC2 状态变化留审计）。 */
  readonly audit: ReviewedAuditSeam;
}): OpenMuseReviewedActionTenancyService {
  assertDataDatabase(deps.data);
  assertOperatorDatabase(deps.operator);

  const { data, operator, rows, decisions, audit } = deps;

  /** 事务开场（MT060–MT062 判定入口同一形状）。 */
  const beginContext = async (
    tx: DataTx | OperatorTx,
    scope: PlatformScope,
  ) => {
    await tx.execute(READ_TX_SETUP);
    for (const timeout of TIMEOUTS) await tx.execute(timeout);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
    );
    // 锁序：tenant → principal → membership → workspace-membership（读共享）。
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

  /**
   * 对象级范围门（AC1/AC2/AC4 唯一判定入口）：协会行经真实 RLS + 事务内
   * 成员事实重验 + 三元组比对。任何不成立 = null（不可见，零存在泄漏）。
   */
  const authorizeAction = async (
    scope: PlatformScope,
    actionId: string,
  ): Promise<OpenMuseReviewedActionScopeView | null> =>
    data.transaction(async (tx) => {
      await beginContext(tx, scope);
      const facts = await readMembershipFacts(tx, scope);
      if (!facts.companyActive || !facts.teamActive) return null;
      const [row] = await tx
        .select()
        .from(openmuseReviewedActionScopes)
        .where(eq(openmuseReviewedActionScopes.actionId, actionId))
        .limit(1);
      if (!row) return null;
      if (
        row.tenantId !== scope.tenantId ||
        row.workspaceId !== scope.workspaceId ||
        row.principalId !== scope.principalId
      ) {
        return null;
      }
      return scopeViewOf(row);
    });

  /** AC2 决策半边的共享实现（decide/cancel 只差事件名与委托）。 */
  const scopedTransition = async (
    scope: PlatformScope,
    actionId: string,
    eventType: string,
    delegate: (facts: {
      readonly actionId: string;
      readonly userId: string;
    }) => Promise<ScopedReviewedActionRecord | null>,
  ): Promise<ScopedDecisionOutcome> => {
    assertTrustedScope(scope);
    const id = requireId(actionId, "actionId");
    const ownership = await authorizeAction(scope, id);
    if (!ownership) return notFoundVerdict();
    // 委托一律用门内已归一的 (actionId, userId)：多用户同主体时与门按
    // 同一行对齐，杜绝「门放行、决策缝折叠为 not-found」的口径分裂。
    const decided = await delegate({
      actionId: id,
      userId: ownership.userId,
    });
    if (!decided) return notFoundVerdict();
    // 状态变化留审计（AC2）：生效决策必写；审计失败原样上抛，绝不折叠成
    // 成功——调用方看到的异常就是交付事实。
    const { eventId } = await audit({
      tenantId: scope.tenantId,
      eventType,
      actorId: scope.actorId,
      targetId: id,
      payload: {
        actionKind: decided.kind,
        status: decided.status,
      },
    });
    return {
      outcome: "allow" as const,
      ownership,
      action: decided,
      auditEventId: eventId,
    };
  };

  return {
    async pinReviewedActionScope(scope, input) {
      assertTrustedScope(scope);
      const actionId = requireId(input.actionId, "actionId");
      // 外来提案（根行不存在/非本人）与不存在不可区分。
      const owned = await rows.findOwnedAction(scope.actorId, actionId);
      if (!owned) return notFoundVerdict();
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          throw new Error(
            OPENMUSE_REVIEWED_ACTION_WORKSPACE_MEMBERSHIP_REQUIRED,
          );
        }
        const [inserted] = await tx
          .insert(openmuseReviewedActionScopes)
          .values({
            actionId,
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
            ownership: scopeViewOf(inserted),
          };
        }
        const [existing] = await tx
          .select()
          .from(openmuseReviewedActionScopes)
          .where(eq(openmuseReviewedActionScopes.actionId, actionId))
          .limit(1);
        if (
          !existing ||
          existing.tenantId !== scope.tenantId ||
          existing.workspaceId !== scope.workspaceId ||
          existing.principalId !== scope.principalId ||
          existing.userId !== scope.actorId
        ) {
          throw new Error(
            `${OPENMUSE_REVIEWED_ACTION_SCOPE_MISMATCH}: reviewed action is already owned by a different scope`,
          );
        }
        return {
          status: "existing" as const,
          ownership: scopeViewOf(existing),
        };
      });
    },

    async listReviewedActions(scope, page) {
      assertTrustedScope(scope);
      if (
        typeof page?.limit !== "number" ||
        !Number.isInteger(page.limit) ||
        page.limit < 1 ||
        page.limit > LIST_LIMIT_MAX
      ) {
        failInvalid(`limit must be an integer between 1 and ${LIST_LIMIT_MAX}`);
      }
      let cursor: { createdAt: Date; actionId: string } | undefined;
      if (page.cursor !== undefined) {
        const decoded = decodeCursor(page.cursor);
        if (!decoded) throw new Error(OPENMUSE_REVIEWED_ACTION_CURSOR_INVALID);
        cursor = decoded;
      }
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive) {
          throw new Error("SCOPE_REVOKED");
        }
        if (!facts.teamActive) {
          return { actions: [] as ScopedReviewedAction[] };
        }
        const associationRows = await tx
          .select()
          .from(openmuseReviewedActionScopes)
          .where(
            and(
              eq(openmuseReviewedActionScopes.tenantId, scope.tenantId),
              eq(openmuseReviewedActionScopes.workspaceId, scope.workspaceId),
              eq(openmuseReviewedActionScopes.principalId, scope.principalId),
              ...(cursor
                ? [
                    sql`(${openmuseReviewedActionScopes.createdAt}, ${openmuseReviewedActionScopes.actionId}) < (${cursor.createdAt}, ${cursor.actionId})`,
                  ]
                : []),
            ),
          )
          .orderBy(
            sql`${openmuseReviewedActionScopes.createdAt} DESC, ${openmuseReviewedActionScopes.actionId} DESC`,
          )
          .limit(page.limit + 1);
        const hasMore = associationRows.length > page.limit;
        const visible = associationRows.slice(0, page.limit);
        if (visible.length === 0) {
          return { actions: [] as ScopedReviewedAction[] };
        }
        const actionRows = await rows.listActionsByIds(
          scope.actorId,
          visible.map((row) => row.actionId),
        );
        const actionById = new Map(actionRows.map((a) => [a.id, a]));
        const actions: ScopedReviewedAction[] = [];
        for (const row of visible) {
          const action = actionById.get(row.actionId);
          // 根行在两次读取之间被硬删：条目消失，不泄露存在性。
          if (!action) continue;
          actions.push({ ownership: scopeViewOf(row), action });
        }
        const last = visible[visible.length - 1];
        return {
          actions,
          ...(hasMore && last ? { nextCursor: encodeCursor(last) } : {}),
        };
      });
    },

    async readReviewedAction(scope, actionId) {
      assertTrustedScope(scope);
      const id = requireId(actionId, "actionId");
      const ownership = await authorizeAction(scope, id);
      if (!ownership) return notFoundVerdict();
      const action = await rows.findOwnedAction(ownership.userId, id);
      if (!action) return notFoundVerdict();
      return { outcome: "allow" as const, ownership, action };
    },

    async readReviewedReceipt(scope, actionId) {
      assertTrustedScope(scope);
      const id = requireId(actionId, "actionId");
      const ownership = await authorizeAction(scope, id);
      if (!ownership) return notFoundVerdict();
      // 回执继承 action 归属（AC1）：门后的 receiptOf 只可能命中本人提案。
      const receipt = await decisions.receiptOf(id);
      if (!receipt) return notFoundVerdict();
      return { outcome: "allow" as const, ownership, receipt };
    },

    async scopedDecide(scope, actionId, decision) {
      return scopedTransition(
        scope,
        actionId,
        "openmuse.reviewed_action.decided",
        ({ actionId: id, userId }) => decisions.decide(userId, id, decision),
      );
    },

    async scopedCancel(scope, actionId) {
      return scopedTransition(
        scope,
        actionId,
        "openmuse.reviewed_action.cancelled",
        ({ actionId: id, userId }) => decisions.cancel(userId, id),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// 形状映射与游标（模块底部小件）
// ---------------------------------------------------------------------------

function scopeViewOf(
  row: OpenMuseReviewedActionScopeRow,
): OpenMuseReviewedActionScopeView {
  return {
    actionId: row.actionId,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    principalId: row.principalId,
    userId: row.userId,
    createdAt: row.createdAt,
  };
}

const encodeCursor = (row: OpenMuseReviewedActionScopeRow): string =>
  Buffer.from(
    JSON.stringify({ c: row.createdAt.toISOString(), i: row.actionId }),
    "utf8",
  ).toString("base64");

function decodeCursor(
  raw: string,
): { createdAt: Date; actionId: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as {
      c?: unknown;
      i?: unknown;
    };
    if (
      typeof parsed.c !== "string" ||
      typeof parsed.i !== "string" ||
      parsed.i.length === 0
    ) {
      return null;
    }
    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, actionId: parsed.i };
  } catch {
    return null;
  }
}
