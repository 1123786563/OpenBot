// server/src/enterprise/tenancy/personal-bot.ts
// MT059（Issue #102）：每位用户在每个公司团队范围内的私有 OpenMuse Bot。
//
// 票面语义：重复创建幂等（同一 (公司, 团队, 用户) 三元组永远得到同一个私
// 有 Bot，不产生重复记录）；模板应用/升级只更新模板管理的字段，用户自定义
// 字段逐位保留；同一账号在两家公司的两个私有 Bot 相互独立、跨公司不可见；
// 私有 Bot 不进团队列表/搜索（它根本不在 MT016 团队归属存储里）。
//
// 结构（纯新增；消费 MT016/MT011/MT005 既有出口与 MT077 模板安装存储，不改
// 任何既有文件语义——bots-ownership.ts 与 runtime-config.ts 是冻结面，本模
// 块只按 MT017 先例本地镜像其判定纪律）：
//
//   1. 幂等键 = 三元组（结构性）：enterprise_personal_bots 复合主键
//      (tenant_id, workspace_id, principal_id) 就是票面幂等键——同一个三元
//      组在物理上至多一行，重复请求读回同一行原样返回（不推进任何版本号、
//      不改写字段），首建输入只在首建消费。agent_id 由服务端生成（专属
//      pbot- 命名空间 + 全局唯一索引），客户端没有身份输入面。重复请求携带
//      不同 templateRef 是身份冲突，响亮拒绝（PERSONAL_BOT_TEMPLATE_CONFLICT），
//      绝不静默改写已有行。
//   2. 字段级所有权是显式清单（brief 交付约束逐字实现）：
//      enterprise_personal_bot_field_ownership 一行 = 一个字段名在一个私有
//      Bot 上的所有权（managed_by ∈ {'template','user'}）。「哪些字段归模
//      板管、哪些归用户」读表即得，不靠命名约定或服务层推断。写路径的一切
//      合并都以这张表为准：
//        - updateUserFields 只能写 'user' 行；触碰 'template' 名 →
//          PERSONAL_BOT_FIELD_MANAGED_BY_TEMPLATE（响亮拒绝，文档值不变）。
//        - applyTemplateUpgrade 只落模板名集合：新模板文档的字段名进
//          'template' 行（值随安装副本），从新模板消失的模板字段连同所有权
//          行一起移除；'user' 行的名字集合与文档值逐位不动——即使新模板宣
//          称了同名字段，既有 user 所有权赢（票面「用户自定义字段保留」的
//          显式所有权语义）。
//   3. 模板来源 = MT077 团队安装副本：创建/升级按 (tenant, workspace,
//      templateRef) 读 enterprise_template_installs（真实安装存储，消费不
//      改）；副本缺失 = PERSONAL_BOT_TEMPLATE_NOT_FOUND（与跨范围不可见不
//      可区分——读不到就是不存在的响亮面）。Bot 行记录 template_ref +
//      template_source_revision（配对可空 CHECK：无模板 Bot 合法，模板元
//      信息不允许半截）。升级把 source_revision 推进到安装副本当前值。
//   4. 可见性 = 三元组钉死 + 成员事实重验：读以受信 scope 的
//      (tenant, workspace, principal) 为主键路径，按 id 读另加 agent_id；
//      RLS 租户过滤 + restrictive 主体自读先裁一层（跨公司行对本事务结构
//      性不可见），判定内的三元组比对与公司成员（active + epoch 匹配签发
//      时版本）/ 团队成员 active 重验是第二道独立防线（MT005 scope-gate 事
//      务等价物切片，MT016 同款）。任一不成立 → MT011 canonical
//      { outcome: "deny", code: "RESOURCE_NOT_FOUND" }（复用冻结实例，逐字
//      节同形：不存在/跨公司/跨团队/他人私有/被撤权对外不可区分）。
//   5. 创建响亮门：目标团队存在 + 公司成员资格（active + epoch）+ 团队成员
//      关系 active 全部为当前事务内事实，缺一 → WORKSPACE_MEMBERSHIP_REQUIRED。
//
// 事务纪律与 MT016/MT017 完全一致：受信 Scope（assertTrustedScope）→ read
// committed + lock/statement timeout → set_config('app.*', …, true) 事务本
// 地 → advisory 锁（键序 tenant → principal → membership →
// workspace-membership → personal-bot；读共享、写排他）。读路径走受限 data
// 角色，写路径走受限 operator 角色；事实读取全部经真实 RLS。
//
// 归属声明不可由客户端表达：字段文档顶层携带 tenant/workspace/owner 归属键
// 一律 ATTRIBUTION_NOT_CLIENT_DECLARABLE（MT016 同一清单、本地镜像）。
//
// 边界（诚实披露）：
//   - display_name 首建后本票不提供改名面；改名属后续票语义。
//   - 公司作用域清理/枚举（账号删除清单）是 MT067 的语义，本票不预支。
//   - 本票不接路由：服务面供下游 OpenMuse 票以「当前范围的私有 Bot」为入
//     口复用（MT016/MT017 装配同例）。
//   - 升级重复执行是合法重放：模板字段按当前安装副本重落（值相同），用户
//     字段仍逐位不动，revision 前进（写即推进，与 MT016 updateBot 同纪律）。

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { enterpriseTemplateInstalls } from "../../db/schema/enterprise-governance-policy";
import {
  enterprisePersonalBotFieldOwnership,
  enterprisePersonalBots,
} from "../../db/schema/enterprise-personal-bot";
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

/**
 * 私有 Bot 身份的专属命名空间（MT059：agent_id 由服务端生成
 * `pbot-<uuid>`，客户端没有身份输入面）。导出为常量供包运行时等下游消费：
 * 逻辑私有 Bot（ADR 0006）在执行范围解析未接线前，包绑定/准入按此标记显式
 * 拒绝（PACKAGE_BOT_SCOPE_UNAVAILABLE），不以归属行复制身份绕开约束。
 */
export const PERSONAL_BOT_ID_PREFIX = "pbot-";

/** 私有 Bot 视图：可见主体可读的全部事实（文档/清单深冻结，缓存安全）。 */
export interface PersonalBotView {
  readonly agentId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly ownerPrincipalId: string;
  readonly displayName: string;
  readonly templateRef: string | null;
  readonly templateSourceRevision: number | null;
  readonly fields: Readonly<Record<string, unknown>>;
  /** 模板管理字段名的显式清单（来自所有权表，字典序）。 */
  readonly templateFields: readonly string[];
  /** 用户字段名的显式清单（来自所有权表，字典序）。 */
  readonly userFields: readonly string[];
  readonly revision: number;
}

/**
 * 单对象判定结果。allow 携带视图；一切不可见 = MT011 canonical not-found
 * （逐字节同形，不泄露存在性）。
 */
export type PersonalBotOutcome =
  | { readonly outcome: "allow"; readonly bot: PersonalBotView }
  | ResourceNotFoundVerdict;

export interface EnsurePersonalBotInput {
  readonly displayName: string;
  /** 创建来源模板（团队安装副本的 ref）；缺省 = 无模板私有 Bot。 */
  readonly templateRef?: string | null;
  /** 首建用户字段（只在首建消费；重复请求原样返回既有行）。 */
  readonly userFields?: Record<string, unknown>;
}

export interface UpdateUserFieldsInput {
  readonly fields: Record<string, unknown>;
}

export interface ApplyTemplateUpgradeInput {
  /** 显式指定时必须与 Bot 绑定的模板一致（模板身份不可换）。 */
  readonly templateRef?: string;
}

// ---------------------------------------------------------------------------
// 输入与文档校验（响亮拒绝；错误只含代码，绝不回显值）
// ---------------------------------------------------------------------------

const MAX_ID_LENGTH = 256;
const MAX_DOCUMENT_BYTES = 65_536;

/**
 * 归属键：客户端文档里表达归属的形状不存在——归属只来自服务端受信 scope
 * 与事务内事实（驼峰与下划线两种拼写都挡；MT016 同一清单，本地镜像）。
 */
const ATTRIBUTION_KEYS: readonly string[] = [
  "tenantId",
  "workspaceId",
  "ownerPrincipalId",
  "tenant_id",
  "workspace_id",
  "owner_principal_id",
];

function assertScopeContext(scope: PlatformScope): void {
  if (!scope.tenantId?.trim()) throw new Error("TENANT_REQUIRED");
  if (!scope.workspaceId?.trim()) throw new Error("WORKSPACE_REQUIRED");
}

function assertDisplayName(displayName: string): string {
  if (
    typeof displayName !== "string" ||
    displayName.trim().length === 0 ||
    displayName.length > MAX_ID_LENGTH
  ) {
    throw new Error("PERSONAL_BOT_INPUT_INVALID");
  }
  return displayName;
}

function assertTemplateRef(templateRef: string): string {
  if (
    typeof templateRef !== "string" ||
    templateRef.trim().length === 0 ||
    templateRef.length > MAX_ID_LENGTH
  ) {
    throw new Error("PERSONAL_BOT_INPUT_INVALID");
  }
  return templateRef;
}

function assertFieldName(name: string): string {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > MAX_ID_LENGTH
  ) {
    throw new Error("PERSONAL_BOT_FIELD_NAME_INVALID");
  }
  return name;
}

function assertDocument(document: Record<string, unknown>): void {
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document)
  ) {
    throw new Error("PERSONAL_BOT_DOCUMENT_INVALID");
  }
  for (const key of Object.keys(document)) {
    if (ATTRIBUTION_KEYS.includes(key)) {
      throw new Error("ATTRIBUTION_NOT_CLIENT_DECLARABLE");
    }
  }
  if (JSON.stringify(document).length > MAX_DOCUMENT_BYTES) {
    throw new Error("PERSONAL_BOT_DOCUMENT_TOO_LARGE");
  }
}

/** 模板安装副本的文档形状（服务端事实，但同受归属键与形状纪律约束）。 */
function assertTemplateDocument(document: unknown): Record<string, unknown> {
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document)
  ) {
    throw new Error("PERSONAL_BOT_TEMPLATE_DOCUMENT_INVALID");
  }
  for (const key of Object.keys(document as Record<string, unknown>)) {
    if (ATTRIBUTION_KEYS.includes(key)) {
      throw new Error("PERSONAL_BOT_TEMPLATE_DOCUMENT_INVALID");
    }
  }
  return document as Record<string, unknown>;
}

/** 深冻结：调用方拿到不可变快照（与 MT014/MT016 输出同一纪律）。 */
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

export interface PersonalBotService {
  /**
   * 幂等创建（或读回）：同一受信 scope 三元组永远得到同一个私有 Bot。首建
   * 输入只在首建消费；重复请求原样返回既有行（不推进版本号）；带不同模板
   * ref 的重复请求 = PERSONAL_BOT_TEMPLATE_CONFLICT。
   */
  ensurePersonalBot(
    scope: PlatformScope,
    input: EnsurePersonalBotInput,
  ): Promise<PersonalBotOutcome>;
  /** 当前三元组的私有 Bot；不可见 = canonical not-found。 */
  getPersonalBot(scope: PlatformScope): Promise<PersonalBotOutcome>;
  /** 按 id 读当前主体的私有 Bot；跨公司/他人/不存在 = canonical not-found。 */
  getPersonalBotById(
    scope: PlatformScope,
    agentId: string,
  ): Promise<PersonalBotOutcome>;
  /**
   * 写用户字段（新建或覆盖既有 user 字段）；触碰模板管理字段名 =
   * PERSONAL_BOT_FIELD_MANAGED_BY_TEMPLATE（响亮拒绝，文档不变）。
   */
  updateUserFields(
    scope: PlatformScope,
    input: UpdateUserFieldsInput,
  ): Promise<PersonalBotOutcome>;
  /**
   * 模板升级：按团队安装副本的当前文档重落模板管理字段（更新/新增/移除），
   * 用户字段与用户所有权行逐位不动；template_source_revision 推进到安装副
   * 本当前值。无模板 Bot 升级 = PERSONAL_BOT_TEMPLATE_REQUIRED。
   */
  applyTemplateUpgrade(
    scope: PlatformScope,
    input?: ApplyTemplateUpgradeInput,
  ): Promise<PersonalBotOutcome>;
}

/**
 * 装配入口。读路径走已验证 data 通道，写路径走已验证 operator 通道；
 * 未验证通道在装配时拒绝（UNVERIFIED_DATABASE_CAPABILITY）。
 */
export function createPersonalBotService(channels: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
}): PersonalBotService {
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

  /** 锁序：tenant → principal → membership → workspace-membership → personal-bot。 */
  const baseLockKeys = (scope: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly workspaceId: string;
  }): readonly string[] => [
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

  const personalBotLockKey = (
    tenantId: string,
    workspaceId: string,
    principalId: string,
  ): string =>
    JSON.stringify([
      "enterprise",
      "personal-bot",
      tenantId,
      workspaceId,
      principalId,
    ]);

  /**
   * 可见性门（MT016 readVisibleOwnership 同款事实切片，本模块本地镜像）：
   * 行存在之后，调用者的公司成员资格（active + epoch 匹配签发时版本）与
   * 团队成员关系 active 必须仍是当前事务内事实。任一不成立 → null（读/
   * 写一律 fail-closed 到 canonical not-found；创建路径另有响亮门）。
   */
  const visibleWithFacts = async (
    tx: Tx,
    scope: PlatformScope,
    row: typeof enterprisePersonalBots.$inferSelect | null,
  ): Promise<typeof enterprisePersonalBots.$inferSelect | null> => {
    if (!row) return null;
    // 可见性门（三元组钉死，MT016 同款第二道独立防线）：行的团队必须与受信
    // scope 的团队一致——by-agentId 路径的行可以来自同公司的其他团队（RLS
    // 只裁租户 + 主体自读，不裁团队），归属者本人换个团队上下文也看不到它：
    // 私有 Bot 不随人跨团队漂移。任一不成立 → null（canonical not-found）。
    if (row.workspaceId !== scope.workspaceId) return null;
    const facts = await readMembershipFacts(tx, scope);
    if (!facts.companyActive || !facts.teamActive) return null;
    return row;
  };

  /**
   * 事务内成员事实重验（MT005 scope-gate 事务等价物的本模块切片，MT016
   * 同款）：公司级 = active 且 epoch === scope.memberEpoch（MT006 撤权递增
   * epoch，已签发 scope 立即失效）；团队级 = 行存在且 status='active'。
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

  /** Bot 行读取（三元组路径；RLS 租户 + restrictive 主体自读先裁一层）。 */
  const readRow = async (tx: Tx, scope: PlatformScope) => {
    const [row] = await tx
      .select()
      .from(enterprisePersonalBots)
      .where(
        and(
          eq(enterprisePersonalBots.tenantId, scope.tenantId),
          eq(enterprisePersonalBots.workspaceId, scope.workspaceId),
          eq(enterprisePersonalBots.principalId, scope.principalId),
        ),
      )
      .limit(1);
    return row ?? null;
  };

  /** by-agentId 读取（三元组 + 身份四重钉死；跨公司行 RLS 先裁）。 */
  const readRowByAgentId = async (
    tx: Tx,
    scope: PlatformScope,
    agentId: string,
  ) => {
    const [row] = await tx
      .select()
      .from(enterprisePersonalBots)
      .where(
        and(
          eq(enterprisePersonalBots.tenantId, scope.tenantId),
          eq(enterprisePersonalBots.principalId, scope.principalId),
          eq(enterprisePersonalBots.agentId, agentId),
        ),
      )
      .limit(1);
    return row ?? null;
  };

  const readOwnershipRows = async (tx: Tx, scope: PlatformScope) =>
    tx
      .select({
        fieldName: enterprisePersonalBotFieldOwnership.fieldName,
        managedBy: enterprisePersonalBotFieldOwnership.managedBy,
      })
      .from(enterprisePersonalBotFieldOwnership)
      .where(
        and(
          eq(enterprisePersonalBotFieldOwnership.tenantId, scope.tenantId),
          eq(
            enterprisePersonalBotFieldOwnership.workspaceId,
            scope.workspaceId,
          ),
          eq(
            enterprisePersonalBotFieldOwnership.principalId,
            scope.principalId,
          ),
        ),
      )
      .orderBy(enterprisePersonalBotFieldOwnership.fieldName);

  const buildView = (
    row: typeof enterprisePersonalBots.$inferSelect,
    ownership: readonly {
      fieldName: string;
      managedBy: string;
    }[],
  ): PersonalBotView => {
    const templateFields = ownership
      .filter((entry) => entry.managedBy === "template")
      .map((entry) => entry.fieldName);
    const userFields = ownership
      .filter((entry) => entry.managedBy === "user")
      .map((entry) => entry.fieldName);
    return deepFreeze({
      agentId: row.agentId,
      tenantId: row.tenantId,
      workspaceId: row.workspaceId,
      ownerPrincipalId: row.principalId,
      displayName: row.displayName,
      templateRef: row.templateRef,
      templateSourceRevision: row.templateSourceRevision,
      fields: deepFreeze(row.document as Record<string, unknown>),
      templateFields: Object.freeze(templateFields),
      userFields: Object.freeze(userFields),
      revision: row.revision,
    });
  };

  const allowView = (
    row: typeof enterprisePersonalBots.$inferSelect,
    ownership: readonly { fieldName: string; managedBy: string }[],
  ) =>
    Object.freeze({
      outcome: "allow" as const,
      bot: buildView(row, ownership),
    });

  /** 团队安装副本读取（MT077 存储，消费不改；读不到 = 响亮 NOT_FOUND）。 */
  const readInstall = async (
    tx: Tx,
    tenantId: string,
    workspaceId: string,
    templateRef: string,
  ) => {
    const [install] = await tx
      .select({
        sourceRevision: enterpriseTemplateInstalls.sourceRevision,
        document: enterpriseTemplateInstalls.document,
      })
      .from(enterpriseTemplateInstalls)
      .where(
        and(
          eq(enterpriseTemplateInstalls.tenantId, tenantId),
          eq(enterpriseTemplateInstalls.workspaceId, workspaceId),
          eq(enterpriseTemplateInstalls.templateRef, templateRef),
        ),
      )
      .limit(1);
    return install ?? null;
  };

  return {
    async ensurePersonalBot(scope, input) {
      // 输入形状先于信任判定：缺公司/团队上下文与未签发 scope 得到各自的
      // 明确拒绝码（两者都是响亮拒绝，顺序不泄露任何信息）。
      assertScopeContext(scope);
      assertTrustedScope(scope);
      const displayName = assertDisplayName(input.displayName);
      const templateRef =
        input.templateRef === undefined || input.templateRef === null
          ? null
          : assertTemplateRef(input.templateRef);
      const userFields =
        input.userFields === undefined || input.userFields === null
          ? {}
          : input.userFields;
      assertDocument(userFields);
      for (const key of Object.keys(userFields)) assertFieldName(key);
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        // 锁序：基础键共享 → personal-bot 排他（同一三元组创建串行化）。
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          {
            key: personalBotLockKey(
              scope.tenantId,
              scope.workspaceId,
              scope.principalId,
            ),
            exclusive: true,
          },
        ]);
        // 创建门：目标团队存在 + 公司成员资格（active + epoch 匹配签发时
        // 版本）+ 团队成员关系都是当前事务内事实（撤权后下一事务拒绝）。
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
        // 幂等路径：三元组已有行 → 原样读回（不推进版本号、不改写任何值）。
        const existing = await readRow(tx, scope);
        if (existing) {
          if (templateRef && existing.templateRef !== templateRef) {
            throw new Error("PERSONAL_BOT_TEMPLATE_CONFLICT");
          }
          const ownership = await readOwnershipRows(tx, scope);
          return allowView(existing, ownership);
        }
        // 首建：模板来源 = 团队安装副本（真实 MT077 存储）。
        let templateDocument: Record<string, unknown> | null = null;
        let sourceRevision: number | null = null;
        if (templateRef) {
          const install = await readInstall(
            tx,
            scope.tenantId,
            scope.workspaceId,
            templateRef,
          );
          if (!install) throw new Error("PERSONAL_BOT_TEMPLATE_NOT_FOUND");
          templateDocument = assertTemplateDocument(install.document);
          sourceRevision = install.sourceRevision;
          // 用户字段不得侵占模板管理字段名（显式所有权在创建时就成立）。
          for (const key of Object.keys(userFields)) {
            if (key in templateDocument) {
              throw new Error("PERSONAL_BOT_FIELD_MANAGED_BY_TEMPLATE");
            }
          }
        }
        const document: Record<string, unknown> = {
          ...userFields,
          ...(templateDocument ?? {}),
        };
        const agentId = `${PERSONAL_BOT_ID_PREFIX}${randomUUID()}`;
        // 复合主键 (tenant, workspace, principal) 是幂等键的结构兜底：同一
        // 三元组在排他锁内不可能并发首建，约束本身挡住任何绕道路径。
        await tx.insert(enterprisePersonalBots).values({
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          principalId: scope.principalId,
          agentId,
          displayName,
          templateRef,
          templateSourceRevision: sourceRevision,
          document,
        });
        const ownershipRows = [
          ...Object.keys(templateDocument ?? {}).map((fieldName) => ({
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
            fieldName,
            managedBy: "template",
          })),
          ...Object.keys(userFields).map((fieldName) => ({
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
            fieldName,
            managedBy: "user",
          })),
        ];
        if (ownershipRows.length > 0) {
          await tx
            .insert(enterprisePersonalBotFieldOwnership)
            .values(ownershipRows);
        }
        // RLS 下的读回（与 MT016 createBot 的 readback 同纪律）。
        const [row] = await tx
          .select()
          .from(enterprisePersonalBots)
          .where(
            and(
              eq(enterprisePersonalBots.tenantId, scope.tenantId),
              eq(enterprisePersonalBots.workspaceId, scope.workspaceId),
              eq(enterprisePersonalBots.principalId, scope.principalId),
            ),
          )
          .limit(1);
        if (!row) throw new Error("PERSONAL_BOT_CREATE_READBACK_FAILED");
        const ownership = await readOwnershipRows(tx, scope);
        return allowView(row, ownership);
      });
    },

    async getPersonalBot(scope) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          {
            key: personalBotLockKey(
              scope.tenantId,
              scope.workspaceId,
              scope.principalId,
            ),
            exclusive: false,
          },
        ]);
        const row = await visibleWithFacts(tx, scope, await readRow(tx, scope));
        if (!row) return notFoundVerdict();
        const ownership = await readOwnershipRows(tx, scope);
        return allowView(row, ownership);
      });
    },

    async getPersonalBotById(scope, agentId) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      if (typeof agentId !== "string" || agentId.trim().length === 0) {
        throw new Error("PERSONAL_BOT_INPUT_INVALID");
      }
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          {
            key: personalBotLockKey(
              scope.tenantId,
              scope.workspaceId,
              scope.principalId,
            ),
            exclusive: false,
          },
        ]);
        const row = await visibleWithFacts(
          tx,
          scope,
          await readRowByAgentId(tx, scope, agentId),
        );
        if (!row) return notFoundVerdict();
        const ownership = await readOwnershipRows(tx, scope);
        return allowView(row, ownership);
      });
    },

    async updateUserFields(scope, input) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertDocument(input.fields);
      for (const key of Object.keys(input.fields)) assertFieldName(key);
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          {
            key: personalBotLockKey(
              scope.tenantId,
              scope.workspaceId,
              scope.principalId,
            ),
            exclusive: true,
          },
        ]);
        const row = await visibleWithFacts(tx, scope, await readRow(tx, scope));
        if (!row) return notFoundVerdict();
        const ownership = await readOwnershipRows(tx, scope);
        // 显式所有权判定：模板管理的字段名对用户写入响亮拒绝，文档值不变。
        const templateManaged = new Set(
          ownership
            .filter((entry) => entry.managedBy === "template")
            .map((entry) => entry.fieldName),
        );
        for (const key of Object.keys(input.fields)) {
          if (templateManaged.has(key)) {
            throw new Error("PERSONAL_BOT_FIELD_MANAGED_BY_TEMPLATE");
          }
        }
        const document = {
          ...(row.document as Record<string, unknown>),
          ...input.fields,
        };
        await tx
          .update(enterprisePersonalBots)
          .set({
            document,
            revision: sql`${enterprisePersonalBots.revision} + 1`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(enterprisePersonalBots.tenantId, scope.tenantId),
              eq(enterprisePersonalBots.workspaceId, scope.workspaceId),
              eq(enterprisePersonalBots.principalId, scope.principalId),
            ),
          );
        await tx
          .insert(enterprisePersonalBotFieldOwnership)
          .values(
            Object.keys(input.fields).map((fieldName) => ({
              tenantId: scope.tenantId,
              workspaceId: scope.workspaceId,
              principalId: scope.principalId,
              fieldName,
              managedBy: "user",
            })),
          )
          .onConflictDoUpdate({
            target: [
              enterprisePersonalBotFieldOwnership.tenantId,
              enterprisePersonalBotFieldOwnership.workspaceId,
              enterprisePersonalBotFieldOwnership.principalId,
              enterprisePersonalBotFieldOwnership.fieldName,
            ],
            set: {
              managedBy: "user",
              updatedAt: sql`now()`,
            },
          });
        const [updated] = await tx
          .select()
          .from(enterprisePersonalBots)
          .where(
            and(
              eq(enterprisePersonalBots.tenantId, scope.tenantId),
              eq(enterprisePersonalBots.workspaceId, scope.workspaceId),
              eq(enterprisePersonalBots.principalId, scope.principalId),
            ),
          )
          .limit(1);
        if (!updated) return notFoundVerdict();
        const refreshed = await readOwnershipRows(tx, scope);
        return allowView(updated, refreshed);
      });
    },

    async applyTemplateUpgrade(scope, input) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          {
            key: personalBotLockKey(
              scope.tenantId,
              scope.workspaceId,
              scope.principalId,
            ),
            exclusive: true,
          },
        ]);
        const row = await visibleWithFacts(tx, scope, await readRow(tx, scope));
        if (!row) return notFoundVerdict();
        const requested = input?.templateRef;
        if (requested !== undefined) {
          assertTemplateRef(requested);
          // 模板身份不可换：无模板的 Bot 也不经此入口绑定首个模板
          //（首建走 EnsurePersonalBotInput.templateRef），显式指定必须
          // 与既有绑定一致，包括「无模板遇显式指定」。
          if (requested !== row.templateRef) {
            throw new Error("PERSONAL_BOT_TEMPLATE_CONFLICT");
          }
        }
        const templateRef = requested ?? row.templateRef;
        if (!templateRef) {
          throw new Error("PERSONAL_BOT_TEMPLATE_REQUIRED");
        }
        const install = await readInstall(
          tx,
          scope.tenantId,
          scope.workspaceId,
          templateRef,
        );
        if (!install) throw new Error("PERSONAL_BOT_TEMPLATE_NOT_FOUND");
        const templateDocument = assertTemplateDocument(install.document);
        const ownership = await readOwnershipRows(tx, scope);
        const userOwned = ownership.filter(
          (entry) => entry.managedBy === "user",
        );
        const userOwnedNames = new Set(
          userOwned.map((entry) => entry.fieldName),
        );
        const templateOwnedNames = new Set(
          ownership
            .filter((entry) => entry.managedBy === "template")
            .map((entry) => entry.fieldName),
        );
        const currentDocument = row.document as Record<string, unknown>;
        // 合并以显式所有权表为准：模板字段落到非 user 拥有的名字上（既有
        // user 所有权赢——票面「用户自定义字段保留」的字段级语义）；用户字
        // 段的文档值原样搬运（逐位不变）。
        const document: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(templateDocument)) {
          if (!userOwnedNames.has(name)) document[name] = value;
        }
        for (const entry of userOwned) {
          if (entry.fieldName in currentDocument) {
            document[entry.fieldName] = currentDocument[entry.fieldName];
          }
        }
        // 从新模板消失的模板字段：文档值随升级移除、所有权行同删。
        const droppedTemplateNames = [...templateOwnedNames].filter(
          (name) => !(name in templateDocument),
        );
        await tx
          .update(enterprisePersonalBots)
          .set({
            document,
            templateRef,
            templateSourceRevision: install.sourceRevision,
            revision: sql`${enterprisePersonalBots.revision} + 1`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(enterprisePersonalBots.tenantId, scope.tenantId),
              eq(enterprisePersonalBots.workspaceId, scope.workspaceId),
              eq(enterprisePersonalBots.principalId, scope.principalId),
            ),
          );
        if (droppedTemplateNames.length > 0) {
          await tx
            .delete(enterprisePersonalBotFieldOwnership)
            .where(
              and(
                eq(
                  enterprisePersonalBotFieldOwnership.tenantId,
                  scope.tenantId,
                ),
                eq(
                  enterprisePersonalBotFieldOwnership.workspaceId,
                  scope.workspaceId,
                ),
                eq(
                  enterprisePersonalBotFieldOwnership.principalId,
                  scope.principalId,
                ),
                inArray(
                  enterprisePersonalBotFieldOwnership.fieldName,
                  droppedTemplateNames,
                ),
              ),
            );
        }
        // 模板字段行 upsert 为 'template'（user 拥有的名字绝不翻转）。
        const templateNamesToUpsert = Object.keys(templateDocument).filter(
          (name) => !userOwnedNames.has(name),
        );
        if (templateNamesToUpsert.length > 0) {
          await tx
            .insert(enterprisePersonalBotFieldOwnership)
            .values(
              templateNamesToUpsert.map((fieldName) => ({
                tenantId: scope.tenantId,
                workspaceId: scope.workspaceId,
                principalId: scope.principalId,
                fieldName,
                managedBy: "template",
              })),
            )
            .onConflictDoUpdate({
              target: [
                enterprisePersonalBotFieldOwnership.tenantId,
                enterprisePersonalBotFieldOwnership.workspaceId,
                enterprisePersonalBotFieldOwnership.principalId,
                enterprisePersonalBotFieldOwnership.fieldName,
              ],
              set: {
                managedBy: "template",
                updatedAt: sql`now()`,
              },
            });
        }
        const [updated] = await tx
          .select()
          .from(enterprisePersonalBots)
          .where(
            and(
              eq(enterprisePersonalBots.tenantId, scope.tenantId),
              eq(enterprisePersonalBots.workspaceId, scope.workspaceId),
              eq(enterprisePersonalBots.principalId, scope.principalId),
            ),
          )
          .limit(1);
        if (!updated) return notFoundVerdict();
        const refreshed = await readOwnershipRows(tx, scope);
        return allowView(updated, refreshed);
      });
    },
  };
}
