// server/src/enterprise/tenancy/bots-ownership.ts
// MT016（Issue #59）：Bot 归属固定。
//
// 票面语义：用户创建、查看和编辑 Bot 时，Bot、其偏好与默认配置都固定在
// 当前公司与团队；另一家公司或非团队成员看不到也改不了它。
//
// 结构（纯新增，只读消费 MT011 既有出口，不改任何既有文件语义）：
//
//   1. 归属即行：enterprise_bot_ownership 一行 = 一个 Bot 在一家公司一个
//      团队内的归属（tenant_id + workspace_id + owner_principal_id），默认
//      配置文档（default_config）就在归属行内——配置与 Bot 结构上不可分离
//      （brief 验收 4 的结构实现）。agent_id 上有全局唯一索引：旧工作台的
//      agents 表是 Bot 业务对象的唯一权威存储且主键全局（Spec §4.2「保留
//      旧业务表为其业务对象的唯一权威存储」），归属层因此不允许两家公司
//      认领同一底层 Bot——冲突在 INSERT 处由约束本身拒绝（BOT_ID_UNAVAILABLE），
//      同公司重复与跨公司占用同一代码，不泄露占用发生在哪家。
//   2. 可见性门 = 生效的团队事实：行存在（RLS 租户过滤后）+ status='active'
//      + 行的 workspace 与受信 scope 同团队 + 调用者在该团队持有 active
//      成员关系（每次事务内重验，撤权即失效）。任一不成立 → MT011 的
//      canonical { outcome: "deny", code: "RESOURCE_NOT_FOUND" }（复用其
//      冻结实例——逐字节同形，不存在/跨公司/跨团队/已删除对外不可区分）。
//      列表/计数/游标只从可见项派生：非成员的列表为空、计数为 0、游标不
//      偏移（issue 验收 3：不能通过搜索或计数发现它）。
//   2b. 公司级重验（MT005 scope-gate 同款）：scope 只在签发时验证，业务
//      事务内在同一事务里重验公司成员资格 status='active' 且
//      epoch === scope.memberEpoch（epoch 由 MT006 撤权递增）——公司成员
//      资格被暂停后的下一个事务立即失效：create 响亮拒绝，读取 fail-closed
//      到 not-found / 空页 / 0（Spec §5.2 撤权后失效）。
//   3. 编辑门 = 可见性门内的 owner 判定：update/delete 仅限归属行
//      owner_principal_id === scope.principalId 的成员（brief 验收 3）。
//      同团队非 owner 成员能读但不能改/删 → BOT_EDIT_FORBIDDEN（已过可见
//      性门，该拒绝不新增任何信息）；公司/团队管理身份不隐式继承内容编辑
//      权（Spec §4.1：管理权限与内容访问分别判断）。
//   4. 偏好是逐主体事实：enterprise_bot_preferences 经复合外键钉到归属行
//      与公司成员关系（Spec §4.2 子记录规则），行内 tenant_id + 主体上下
//      文 + RLS restrictive 自读共同保证「偏好与 Bot 同归属、且只属于本人」。
//      未见过 Bot 读偏好 = canonical not-found；见过但没设置 = null——两种
//      状态严格分开，不泄露存在性。
//   5. 公司作用域清理：enumeratePrincipalBots / hardDeleteOwnedBots 按
//      (tenant_id, owner_principal_id, agent_id) 三重钉死——账号清理/删除
//      清单是公司作用域动作（issue 验收 5），仅凭用户 id 在错公司上下文
//      删不掉任何行；重复执行幂等删 0 行。被硬删 Bot 的偏好行经外键级联
//      同时消失（不留可访问的悬挂引用）。
//
// 事务纪律与 MT008/MT009/MT011 判定入口完全一致：受信 Scope
// （assertTrustedScope）→ read committed + lock/statement timeout →
// set_config('app.*', …, true) 事务本地 → advisory 锁（键序 tenant →
// principal → membership → workspace-membership → bot；读持共享锁、
// 归属写持排他锁，同键串行化）。读路径走受限 data 角色，写路径走受限
// operator 角色（MT006 管理写同款）；事实读取全部经真实 RLS：跨公司行对
// 本事务不可见（事实即为「不存在」），纯判定内的租户/团队比对是第二道
// 独立防线（纵深防御）。
//
// 归属声明不可由客户端表达：默认配置/偏好文档的顶层键携带
// tenant/workspace/owner 归属键一律 ATTRIBUTION_NOT_CLIENT_DECLARABLE——
// 归属只来自服务端受信 scope 与事务内事实（与 MT028 回调归属规则同源：
// 服务端持久状态优先于客户端选择）。
//
// 边界（诚实披露）：
//   - 编辑授权只认「归属行 owner」这一种授权成员形态；团队管理者代编辑、
//     发布受众（MT017）与逐动作生命周期授权（MT019）是后续票据的语义，
//     本模块不预支。
//   - 列表/计数的候选读取一次性扫过 scope 团队内的候选行（与 MT011 同一
//     边界）；团队规模超出此模型时属后续分页架构票。
//   - 本票不接路由：服务面供下游接线票复用（与 MT009/MT011/MT014 装配
//     同例）。

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  enterpriseBotOwnership,
  enterpriseBotPreferences,
} from "../../db/schema/enterprise-bot-ownership";
import {
  enterpriseMemberships,
  enterpriseWorkspaceMemberships,
  enterpriseWorkspaces,
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
// 视图与判定形状
// ---------------------------------------------------------------------------

/** 归属视图：可见成员可读的全部事实（默认配置深冻结，缓存/复用安全）。 */
export interface BotOwnershipView {
  readonly agentId: string;
  readonly workspaceId: string;
  readonly ownerPrincipalId: string;
  readonly displayName: string;
  readonly defaultConfig: Readonly<Record<string, unknown>>;
  readonly revision: number;
  readonly aclEpoch: number;
}

/** 清理面使用的摘要（无配置文档——清理判定不需要内容）。 */
export interface BotOwnershipSummary {
  readonly agentId: string;
  readonly workspaceId: string;
  readonly displayName: string;
}

/**
 * 单对象判定结果。allow 携带视图；一切不可见 = MT011 canonical not-found
 * （逐字节同形）；可见成员的非 owner 编辑/删除 = BOT_EDIT_FORBIDDEN。
 */
export type BotOwnershipOutcome =
  | { readonly outcome: "allow"; readonly bot: BotOwnershipView }
  | ResourceNotFoundVerdict
  | { readonly outcome: "deny"; readonly code: "BOT_EDIT_FORBIDDEN" };

export type BotMutationOutcome =
  | { readonly outcome: "allow" }
  | ResourceNotFoundVerdict
  | { readonly outcome: "deny"; readonly code: "BOT_EDIT_FORBIDDEN" };

/** 偏好判定：allow 携带本人偏好（未设置 = null）；不可见 = canonical not-found。 */
export type BotPreferenceReadOutcome =
  | {
      readonly outcome: "allow";
      readonly preference: Readonly<Record<string, unknown>> | null;
    }
  | ResourceNotFoundVerdict;

export type BotPreferenceWriteOutcome =
  | { readonly outcome: "allow" }
  | ResourceNotFoundVerdict;

/** 一页可见 Bot；nextCursor 为 null 表示可见流结束。 */
export interface BotListPage {
  readonly items: readonly BotOwnershipSummary[];
  readonly nextCursor: string | null;
}

export interface CreateBotInput {
  readonly agentId: string;
  readonly displayName: string;
  readonly defaultConfig: Record<string, unknown>;
}

export interface UpdateBotInput {
  readonly displayName: string;
  readonly defaultConfig: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 输入与文档校验（响亮拒绝；错误只含代码，绝不回显值）
// ---------------------------------------------------------------------------

const MAX_ID_LENGTH = 256;
const MAX_DOCUMENT_BYTES = 65_536;
const MAX_PAGE_LIMIT = 200;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_CLEANUP_IDS = 100;

/**
 * 归属键：客户端文档里表达归属的形状不存在——归属只来自服务端受信 scope
 * 与事务内事实（驼峰与下划线两种拼写都挡）。
 */
const ATTRIBUTION_KEYS: readonly string[] = [
  "tenantId",
  "workspaceId",
  "ownerPrincipalId",
  "tenant_id",
  "workspace_id",
  "owner_principal_id",
];

function assertBotIdentity(agentId: string): string {
  if (
    typeof agentId !== "string" ||
    agentId.trim().length === 0 ||
    agentId.length > MAX_ID_LENGTH
  ) {
    throw new Error("BOT_INPUT_INVALID");
  }
  return agentId;
}

function assertDisplayName(displayName: string): string {
  if (
    typeof displayName !== "string" ||
    displayName.trim().length === 0 ||
    displayName.length > MAX_ID_LENGTH
  ) {
    throw new Error("BOT_INPUT_INVALID");
  }
  return displayName;
}

function assertDocument(document: Record<string, unknown>): void {
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document)
  ) {
    throw new Error("BOT_DOCUMENT_INVALID");
  }
  for (const key of Object.keys(document)) {
    if (ATTRIBUTION_KEYS.includes(key)) {
      throw new Error("ATTRIBUTION_NOT_CLIENT_DECLARABLE");
    }
  }
  if (JSON.stringify(document).length > MAX_DOCUMENT_BYTES) {
    throw new Error("BOT_DOCUMENT_TOO_LARGE");
  }
}

function assertScopeContext(scope: PlatformScope): void {
  if (!scope.tenantId?.trim()) throw new Error("TENANT_REQUIRED");
  if (!scope.workspaceId?.trim()) throw new Error("WORKSPACE_REQUIRED");
}

function assertPageLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new Error("BOTS_LIMIT_INVALID");
  }
  return limit;
}

function assertCleanupIds(agentIds: readonly string[]): readonly string[] {
  if (!Array.isArray(agentIds) || agentIds.length > MAX_CLEANUP_IDS) {
    throw new Error("BOT_CLEANUP_INPUT_INVALID");
  }
  for (const id of agentIds) assertBotIdentity(id);
  return agentIds;
}

/** 深冻结：调用方拿到不可变快照（与 MT014 解析输出同一纪律）。 */
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
// 游标：服务自发的 opaque 令牌，只含调用方已见项的键
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
    // Opaque token bound: refuses oversized tokens before base64+JSON work.
    if (token.length > 1024) throw new Error("BOTS_CURSOR_INVALID");
    const json = Buffer.from(token, "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    throw new Error("BOTS_CURSOR_INVALID");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as CursorPayload).v !== 1 ||
    typeof (parsed as CursorPayload).at !== "string" ||
    (parsed as CursorPayload).at.trim() === "" ||
    !Number.isFinite(Date.parse((parsed as CursorPayload).at)) ||
    (parsed as CursorPayload).at.length > 64 ||
    typeof (parsed as CursorPayload).id !== "string" ||
    (parsed as CursorPayload).id.trim() === "" ||
    (parsed as CursorPayload).id.length > 200
  ) {
    throw new Error("BOTS_CURSOR_INVALID");
  }
  return parsed as CursorPayload;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface BotOwnershipService {
  /** 在受信 scope 的公司 + 团队内创建归属（默认配置同行落库）。 */
  createBot(
    scope: PlatformScope,
    input: CreateBotInput,
  ): Promise<BotOwnershipOutcome>;
  /** 详情/配置读取；不可见 = canonical not-found。 */
  getBot(scope: PlatformScope, agentId: string): Promise<BotOwnershipOutcome>;
  /** 团队内可见 Bot 列表；非成员 = 空页（不泄露）。 */
  listBots(
    scope: PlatformScope,
    options?: { readonly limit?: number; readonly cursor?: string },
  ): Promise<BotListPage>;
  /** 团队内可见 Bot 计数；非成员 = 0（不泄露）。 */
  countBots(scope: PlatformScope): Promise<{ readonly total: number }>;
  /** 默认配置/名称编辑；可见性门 → owner 门。 */
  updateBot(
    scope: PlatformScope,
    agentId: string,
    input: UpdateBotInput,
  ): Promise<BotOwnershipOutcome>;
  /** 软删除（读面立即回到 not-found）；可见性门 → owner 门。 */
  deleteBot(scope: PlatformScope, agentId: string): Promise<BotMutationOutcome>;
  /** 写/覆盖本人对该 Bot 的偏好；不可见 = canonical not-found。 */
  setBotPreference(
    scope: PlatformScope,
    agentId: string,
    preferences: Record<string, unknown>,
  ): Promise<BotPreferenceWriteOutcome>;
  /** 读本人对该 Bot 的偏好；未设置 = null，不可见 = canonical not-found。 */
  getBotPreference(
    scope: PlatformScope,
    agentId: string,
  ): Promise<BotPreferenceReadOutcome>;
  /** 清除本人对该 Bot 的偏好；幂等。 */
  clearBotPreference(
    scope: PlatformScope,
    agentId: string,
  ): Promise<BotPreferenceWriteOutcome>;
  /**
   * 公司作用域枚举：某主体在某公司名下的全部活跃归属（删除清单的事实源）。
   * 服务器侧清理流程调用（无 scope——与 profile-store.hardDelete 同位）。
   */
  enumeratePrincipalBots(
    tenantId: string,
    ownerPrincipalId: string,
  ): Promise<readonly BotOwnershipSummary[]>;
  /**
   * 公司作用域硬删除：按 (tenant, owner, ids) 三重钉死；错公司/非本人/
   * 未知 id 一律不命中；返回实际删除的输入 id（输入序）。偏好行经外键
   * 级联同时消失。
   */
  hardDeleteOwnedBots(
    tenantId: string,
    ownerPrincipalId: string,
    agentIds: readonly string[],
  ): Promise<readonly string[]>;
}

/**
 * 装配入口。读路径走已验证 data 通道，写路径走已验证 operator 通道；
 * 未验证通道在装配时拒绝（UNVERIFIED_DATABASE_CAPABILITY）。
 */
export function createBotOwnershipService(channels: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
}): BotOwnershipService {
  assertDataDatabase(channels.data);
  assertOperatorDatabase(channels.operator);
  const { data, operator } = channels;

  /** 事务句柄类型（两个通道同一形状的本地别名）。 */
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
    /* Transaction-local settings are defense in depth for RLS and are cleared on commit. */
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId ?? ""}, true), set_config('app.principal_id', ${scope.principalId ?? ""}, true), set_config('app.user_id', ${scope.actorId ?? ""}, true)`,
    );
  };

  /** 锁序：tenant → principal → membership → workspace-membership → bot。 */
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
    keys: readonly { readonly key: string; readonly exclusive: boolean }[],
  ): Promise<void> => {
    for (const { key, exclusive } of keys) {
      await tx.execute(
        exclusive
          ? sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`
          : sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
      );
    }
  };

  const botLockKey = (tenantId: string, agentId: string): string =>
    JSON.stringify(["enterprise", "bot", tenantId, agentId]);

  /**
   * 事务内成员事实重验（MT005 scope-gate 事务等价物的本模块切片）：公司级
   * = active 且 epoch === scope.memberEpoch（MT006 撤权递增 epoch，已签发
   * scope 立即失效）；团队级 = 行存在且 status='active'。
   */
  const readMembershipFacts = async (
    tx: Tx,
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

  /**
   * 可见性事实（事务内一次受限读取）：行经 RLS 租户过滤后，再验团队匹配
   * + active + 调用者的公司成员资格（active + epoch 钉住签发时版本）与
   * 团队成员关系（重验）。返回 null = 不可见。
   */
  const readVisibleOwnership = async (
    tx: Tx,
    scope: PlatformScope,
    agentId: string,
  ): Promise<BotOwnershipView | null> => {
    const [row] = await tx
      .select({
        agentId: enterpriseBotOwnership.agentId,
        workspaceId: enterpriseBotOwnership.workspaceId,
        ownerPrincipalId: enterpriseBotOwnership.ownerPrincipalId,
        displayName: enterpriseBotOwnership.displayName,
        defaultConfig: enterpriseBotOwnership.defaultConfig,
        status: enterpriseBotOwnership.status,
        revision: enterpriseBotOwnership.revision,
        aclEpoch: enterpriseBotOwnership.aclEpoch,
        membershipStatus: enterpriseWorkspaceMemberships.status,
        companyMemberStatus: enterpriseMemberships.status,
        companyMemberEpoch: enterpriseMemberships.epoch,
      })
      .from(enterpriseBotOwnership)
      .leftJoin(
        enterpriseWorkspaceMemberships,
        and(
          eq(
            enterpriseWorkspaceMemberships.tenantId,
            enterpriseBotOwnership.tenantId,
          ),
          eq(
            enterpriseWorkspaceMemberships.workspaceId,
            enterpriseBotOwnership.workspaceId,
          ),
          eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
        ),
      )
      .leftJoin(
        enterpriseMemberships,
        and(
          eq(enterpriseMemberships.tenantId, enterpriseBotOwnership.tenantId),
          eq(enterpriseMemberships.principalId, scope.principalId),
        ),
      )
      .where(
        and(
          eq(enterpriseBotOwnership.tenantId, scope.tenantId),
          eq(enterpriseBotOwnership.agentId, agentId),
        ),
      )
      .limit(1);
    if (!row) return null;
    // 可见性门：同团队 + active + 公司成员（active + epoch 匹配签发时
    // 版本）+ 团队成员 active。任一不成立 = 不可见（不存在/跨公司/跨团队/
    // 已删除/被撤权者对外不可区分）。
    if (
      row.status !== "active" ||
      row.workspaceId !== scope.workspaceId ||
      row.membershipStatus !== "active" ||
      row.companyMemberStatus !== "active" ||
      row.companyMemberEpoch !== scope.memberEpoch
    ) {
      return null;
    }
    return deepFreeze({
      agentId: row.agentId,
      workspaceId: row.workspaceId,
      ownerPrincipalId: row.ownerPrincipalId,
      displayName: row.displayName,
      defaultConfig: deepFreeze(row.defaultConfig as Record<string, unknown>),
      revision: row.revision,
      aclEpoch: row.aclEpoch,
    });
  };

  /** 列表候选读取：租户 + 团队 + active（RLS 先行），(created_at, id) 全序。 */
  const readCandidateRows = async (
    tx: Tx,
    scope: PlatformScope,
    cursor: CursorPayload | null,
    limit: number,
  ) =>
    tx
      .select({
        agentId: enterpriseBotOwnership.agentId,
        workspaceId: enterpriseBotOwnership.workspaceId,
        displayName: enterpriseBotOwnership.displayName,
        createdAtText:
          sql<string>`${enterpriseBotOwnership.createdAt}::text`.as(
            "created_at_text",
          ),
      })
      .from(enterpriseBotOwnership)
      .where(
        and(
          eq(enterpriseBotOwnership.tenantId, scope.tenantId),
          eq(enterpriseBotOwnership.workspaceId, scope.workspaceId),
          eq(enterpriseBotOwnership.status, "active"),
          cursor
            ? sql`(${enterpriseBotOwnership.createdAt}, ${enterpriseBotOwnership.agentId}) > (${cursor.at}::timestamptz, ${cursor.id})`
            : undefined,
        ),
      )
      .orderBy(
        asc(enterpriseBotOwnership.createdAt),
        asc(enterpriseBotOwnership.agentId),
      )
      // 候选行在 SQL 层截断（+1 供分页边界判定）；分页序是全序，截断语义
      // 与「全量拉回再在 JS 截断」一致，只是不再随团队规模线性放大。
      .limit(limit + 1);

  return {
    async createBot(scope, input) {
      // 输入形状先于信任判定：缺公司/团队上下文与未签发 scope 得到各自的
      // 明确拒绝码（两者都是响亮拒绝，顺序不泄露任何信息）。
      assertScopeContext(scope);
      assertTrustedScope(scope);
      const agentId = assertBotIdentity(input.agentId);
      const displayName = assertDisplayName(input.displayName);
      assertDocument(input.defaultConfig);
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        // 锁序：基础键共享 → bot 排他（同 id 创建串行化）。
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: botLockKey(scope.tenantId, agentId), exclusive: true },
        ]);
        // 事务内重验：目标团队必须存在（归属同一租户）且调用者的公司成员
        // 资格（active + epoch 匹配签发时版本）与团队成员关系都是当前事实
        // ——scope 只在签发时验证，这里钉住当前事实（撤权后下一事务拒绝）。
        const [team] = await tx
          .select({ workspaceId: enterpriseWorkspaces.id })
          .from(enterpriseWorkspaces)
          .where(
            and(
              eq(enterpriseWorkspaces.tenantId, scope.tenantId),
              eq(enterpriseWorkspaces.id, scope.workspaceId),
            ),
          )
          .limit(1);
        const facts = await readMembershipFacts(tx, scope);
        if (!team || !facts.companyActive || !facts.teamActive) {
          throw new Error("WORKSPACE_MEMBERSHIP_REQUIRED");
        }
        try {
          await tx.insert(enterpriseBotOwnership).values({
            tenantId: scope.tenantId,
            agentId,
            workspaceId: scope.workspaceId,
            ownerPrincipalId: scope.principalId,
            displayName,
            defaultConfig: input.defaultConfig,
          });
        } catch (error) {
          // 全局唯一索引（agent_id）+ 复合主键都在 INSERT 处收口：同公司
          // 重复与跨公司占用同一代码——不泄露占用发生在哪家。（bun 的
          // PostgresError 把 SQLSTATE 暴露在 errno；drizzle 包装层在同源
          // cause 链上。）
          let candidate: unknown = error;
          for (
            let depth = 0;
            candidate !== undefined && depth < 5;
            depth += 1
          ) {
            const shaped = candidate as { code?: string; errno?: string };
            if (shaped.code === "23505" || shaped.errno === "23505") {
              throw new Error("BOT_ID_UNAVAILABLE");
            }
            candidate = (candidate as { cause?: unknown }).cause;
          }
          throw error;
        }
        const view = await readVisibleOwnership(tx, scope, agentId);
        if (!view) throw new Error("BOT_CREATE_READBACK_FAILED");
        return Object.freeze({ outcome: "allow", bot: view });
      });
    },

    async getBot(scope, agentId) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          {
            key: botLockKey(scope.tenantId, agentId),
            exclusive: false,
          },
        ]);
        const view = await readVisibleOwnership(tx, scope, agentId);
        if (!view) return notFoundVerdict();
        return Object.freeze({ outcome: "allow", bot: view });
      });
    },

    async listBots(scope, options) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      const limit = assertPageLimit(options?.limit);
      const cursor = options?.cursor ? decodeCursor(options.cursor) : null;
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        // 列表不持逐 Bot 锁（候选集无界，与 MT011 同一边界）；成员关系
        // 事实经下述 join 重验。
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
        ]);
        // 成员事实重验（公司级 + 团队级）：被撤权者/非成员的列表为空页
        // （不泄露任何存在性）。
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) {
          return Object.freeze({
            items: Object.freeze([]),
            nextCursor: null,
          });
        }
        const rows = (await readCandidateRows(
          tx,
          scope,
          cursor,
          limit,
        )) as readonly {
          agentId: string;
          workspaceId: string;
          displayName: string;
          createdAtText: string;
        }[];
        const items: BotOwnershipSummary[] = [];
        let nextCursor: string | null = null;
        let boundary: { at: string; id: string } | null = null;
        for (const row of rows) {
          if (items.length === limit) {
            nextCursor = encodeCursor({
              v: 1,
              at: boundary?.at ?? "",
              id: boundary?.id ?? "",
            });
            break;
          }
          items.push(
            Object.freeze({
              agentId: row.agentId,
              workspaceId: row.workspaceId,
              displayName: row.displayName,
            }),
          );
          boundary = { at: row.createdAtText, id: row.agentId };
        }
        return Object.freeze({
          items: Object.freeze(items),
          nextCursor,
        });
      });
    },

    async countBots(scope) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
        ]);
        const facts = await readMembershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) return { total: 0 };
        // 计数只需聚合值：不在应用层拉全量行再数长度。
        const [counted] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(enterpriseBotOwnership)
          .where(
            and(
              eq(enterpriseBotOwnership.tenantId, scope.tenantId),
              eq(enterpriseBotOwnership.workspaceId, scope.workspaceId),
              eq(enterpriseBotOwnership.status, "active"),
            ),
          );
        return { total: Number(counted?.total ?? 0) };
      });
    },

    async updateBot(scope, agentId, input) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      const displayName = assertDisplayName(input.displayName);
      assertDocument(input.defaultConfig);
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: botLockKey(scope.tenantId, agentId), exclusive: true },
        ]);
        const view = await readVisibleOwnership(tx, scope, agentId);
        if (!view) return notFoundVerdict();
        if (view.ownerPrincipalId !== scope.principalId) {
          return Object.freeze({
            outcome: "deny",
            code: "BOT_EDIT_FORBIDDEN",
          });
        }
        await tx
          .update(enterpriseBotOwnership)
          .set({
            displayName,
            defaultConfig: input.defaultConfig,
            revision: sql`${enterpriseBotOwnership.revision} + 1`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(enterpriseBotOwnership.tenantId, scope.tenantId),
              eq(enterpriseBotOwnership.agentId, agentId),
            ),
          );
        const updated = await readVisibleOwnership(tx, scope, agentId);
        if (!updated) return notFoundVerdict();
        return Object.freeze({ outcome: "allow", bot: updated });
      });
    },

    async deleteBot(scope, agentId) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: botLockKey(scope.tenantId, agentId), exclusive: true },
        ]);
        const view = await readVisibleOwnership(tx, scope, agentId);
        if (!view) return notFoundVerdict();
        if (view.ownerPrincipalId !== scope.principalId) {
          return Object.freeze({
            outcome: "deny",
            code: "BOT_EDIT_FORBIDDEN",
          });
        }
        await tx
          .update(enterpriseBotOwnership)
          .set({
            status: "deleted",
            aclEpoch: sql`${enterpriseBotOwnership.aclEpoch} + 1`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(enterpriseBotOwnership.tenantId, scope.tenantId),
              eq(enterpriseBotOwnership.agentId, agentId),
            ),
          );
        return Object.freeze({ outcome: "allow" });
      });
    },

    async setBotPreference(scope, agentId, preferences) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertDocument(preferences);
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: botLockKey(scope.tenantId, agentId), exclusive: true },
        ]);
        const view = await readVisibleOwnership(tx, scope, agentId);
        if (!view) return notFoundVerdict();
        await tx
          .insert(enterpriseBotPreferences)
          .values({
            tenantId: scope.tenantId,
            agentId,
            principalId: scope.principalId,
            preferences,
          })
          .onConflictDoUpdate({
            target: [
              enterpriseBotPreferences.tenantId,
              enterpriseBotPreferences.agentId,
              enterpriseBotPreferences.principalId,
            ],
            set: { preferences: preferences, updatedAt: sql`now()` },
          });
        return Object.freeze({ outcome: "allow" });
      });
    },

    async getBotPreference(scope, agentId) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          {
            key: botLockKey(scope.tenantId, agentId),
            exclusive: false,
          },
        ]);
        const view = await readVisibleOwnership(tx, scope, agentId);
        if (!view) return notFoundVerdict();
        const [row] = await tx
          .select({ preferences: enterpriseBotPreferences.preferences })
          .from(enterpriseBotPreferences)
          .where(
            and(
              eq(enterpriseBotPreferences.tenantId, scope.tenantId),
              eq(enterpriseBotPreferences.agentId, agentId),
              eq(enterpriseBotPreferences.principalId, scope.principalId),
            ),
          )
          .limit(1);
        return Object.freeze({
          outcome: "allow",
          preference: row
            ? deepFreeze(row.preferences as Record<string, unknown>)
            : null,
        });
      });
    },

    async clearBotPreference(scope, agentId) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: botLockKey(scope.tenantId, agentId), exclusive: true },
        ]);
        const view = await readVisibleOwnership(tx, scope, agentId);
        if (!view) return notFoundVerdict();
        await tx
          .delete(enterpriseBotPreferences)
          .where(
            and(
              eq(enterpriseBotPreferences.tenantId, scope.tenantId),
              eq(enterpriseBotPreferences.agentId, agentId),
              eq(enterpriseBotPreferences.principalId, scope.principalId),
            ),
          );
        return Object.freeze({ outcome: "allow" });
      });
    },

    async enumeratePrincipalBots(tenantId, ownerPrincipalId) {
      if (!tenantId?.trim()) throw new Error("TENANT_REQUIRED");
      if (!ownerPrincipalId?.trim()) throw new Error("PRINCIPAL_REQUIRED");
      return operator.transaction(async (tx) => {
        await beginContext(tx, { tenantId });
        await takeLocks(tx, [
          {
            key: JSON.stringify(["enterprise", "tenant", tenantId]),
            exclusive: false,
          },
        ]);
        const rows = await tx
          .select({
            agentId: enterpriseBotOwnership.agentId,
            workspaceId: enterpriseBotOwnership.workspaceId,
            displayName: enterpriseBotOwnership.displayName,
          })
          .from(enterpriseBotOwnership)
          .where(
            and(
              eq(enterpriseBotOwnership.tenantId, tenantId),
              eq(enterpriseBotOwnership.ownerPrincipalId, ownerPrincipalId),
              eq(enterpriseBotOwnership.status, "active"),
            ),
          )
          .orderBy(asc(enterpriseBotOwnership.agentId));
        return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
      });
    },

    async hardDeleteOwnedBots(tenantId, ownerPrincipalId, agentIds) {
      if (!tenantId?.trim()) throw new Error("TENANT_REQUIRED");
      if (!ownerPrincipalId?.trim()) throw new Error("PRINCIPAL_REQUIRED");
      const ids = assertCleanupIds(agentIds);
      if (ids.length === 0) return Object.freeze([]);
      return operator.transaction(async (tx) => {
        await beginContext(tx, { tenantId });
        // 锁序：tenant → bot（去重 + 字典序，保持全局键序；排他——这是
        // 归属行的删除动作）。
        await takeLocks(tx, [
          {
            key: JSON.stringify(["enterprise", "tenant", tenantId]),
            exclusive: false,
          },
          ...[...new Set(ids)].sort().map((agentId) => ({
            key: botLockKey(tenantId, agentId),
            exclusive: true,
          })),
        ]);
        // 三重钉死：公司 + owner + id。外键级联在同一语句内清掉该 Bot 的
        // 全部偏好行（级联不经过逐行 RLS——PostgreSQL 语义），不留悬挂引用。
        const deleted = await tx
          .delete(enterpriseBotOwnership)
          .where(
            and(
              eq(enterpriseBotOwnership.tenantId, tenantId),
              eq(enterpriseBotOwnership.ownerPrincipalId, ownerPrincipalId),
              inArray(enterpriseBotOwnership.agentId, [...ids]),
            ),
          )
          .returning({ agentId: enterpriseBotOwnership.agentId });
        const deletedIds = new Set(deleted.map((row) => row.agentId));
        return Object.freeze(ids.filter((id) => deletedIds.has(id)));
      });
    },
  };
}
