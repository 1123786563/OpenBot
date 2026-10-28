// server/src/enterprise/tenancy/marketplace-install.ts
// MT020（Issue #63）：专家/模板安装与安装回执的公司团队归属。
//
// 票面语义：从目录安装专家或模板时，安装记录、产生的资源与回执都归属
// 发起安装的公司与团队；公共目录本身可全局只读，但安装与调用不能全局。
//
// 结构（纯新增，零 schema 对象——回执与产物复用既有 MT008/MT016 表，
// 只读消费 MT011 既有出口，不改任何既有文件）：
//
//   1. 目录（AC1）：装配注入的只读清单（生产装配从 marketplace/
//      catalogue.ts 常量投影，测试注入版本化条目模拟模板升级）。装配时
//      逐条扫描租户键（tenantId/workspaceId/ownerPrincipalId 驼峰与下划线
//      拼写一律）：公共目录不含任何公司私有内容是机制保证——毒条目在
//      装配点响亮拒绝（MARKETPLACE_CATALOG_LEAKS_TENANCY），不是约定。
//      readCatalog 对任何已认证 scope 返回同一 deepFrozen 投影。
//   2. 安装（AC2）：installFromCatalog 以发起 scope 的 (tenant, workspace)
//      为唯一归属事实——产物 = enterprise_bot_ownership 行（MT016 归属
//      面：tenant/workspace/ownerPrincipal + defaultConfig 模板默认配置
//      副本 + revision=安装版本），回执 = enterprise_resources 行
//      kind='marketplace-install'（id=产物 agentId 天然关联、
//      displayName='marketplace:<slug>'、revision=安装版本、workspaceId=
//      安装团队）。跨公司读取走 RLS 租户过滤，本模块不给任何全局读面。
//   3. 升级与卸载（AC3）：executeMarketplaceAction 按回执行的持久化归属
//      判定（RLS 行过滤 + snapshot 外的 workspace 匹配 + 成员 active/epoch
//      重验），请求体出现任何归属键一律 ATTRIBUTION_NOT_CLIENT_DECLARABLE
//      响亮拒绝（与 MT019/MT028 同源：服务端持久状态优先于客户端选择）。
//      管理门 = 回执 owner ∨ 公司 tenant_admin（每事务重验 active 行）。
//   4. 双公司互不影响（AC4）：回执行与产物行都是 (tenant, id) 主键的
//      私有行——两家公司装同一 slug 各得各的行，revision 与 defaultConfig
//      各自独立演化；升级只写本租户行（RLS withCheck 兜底）。
//
// 事务纪律与 MT019 完全一致：受信 Scope（assertTrustedScope）→ read
// committed + lock/statement timeout → set_config('app.*', …, true) 事务
// 本地 → advisory 锁。锁序：tenant → principal → membership →
// workspace-membership → bot（产物行，与 MT019 同键族串行化）→
// marketplace-receipt（本票新键族，bot → receipt 单向边，无环）。
// 读路径走受限 data 角色，写路径走受限 operator 角色；事实读取全部经
// 真实 RLS。
//
// 边界（诚实披露）：
//   - 技能/组件发布的通用规则在 MT033（Issue #76 handoff 同源）；本票
//     目录条目 kind 闭集为 'expert'（产物 Bot），不承载技能安装。
//   - 版本单一事实源是产物行 revision（MT016 列级 UPDATE 授权覆盖
//     default_config + revision）；回执行的 resources.revision 是初装
//     记录，升级不改它——operator 对该列无授权，两行永不脱钩。
//   - 卸载 = 产物行硬删（MT019 delete 同形：偏好/共享使用回执经 FK
//     级联消失）；回执行保留 slug 痕迹但判定面经产物缺失一律不可见，
//     不构成可访问的悬挂引用（operator 对该表无 DELETE 授权）。
//   - 挂路由非本票范围：服务面供下游接线票复用（MT016/MT017 同例）。

import { and, eq, sql } from "drizzle-orm";
import { enterpriseBotOwnership } from "../../db/schema/enterprise-bot-ownership";
import {
  enterpriseMemberships,
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
// 词表与判定形状
// ---------------------------------------------------------------------------

/** 安装域动作词表（票面三项，闭集；install 走独立入口带目录交互）。 */
export const MARKETPLACE_RECEIPT_ACTIONS = ["upgrade", "uninstall"] as const;

export type MarketplaceReceiptAction =
  (typeof MARKETPLACE_RECEIPT_ACTIONS)[number];

/** 已过可见性门后的管理拒绝（不泄露额外信息：能到这一步已说明可见）。 */
export interface MarketplaceForbidden {
  readonly outcome: "deny";
  readonly code: "MARKETPLACE_FORBIDDEN";
}

export type MarketplaceDecision =
  | { readonly outcome: "allow" }
  | ResourceNotFoundVerdict
  | MarketplaceForbidden;

export type MarketplaceExecution =
  | MarketplaceDecision
  /** 域内事实性拒绝（模板下架/降级拒绝）：可见前提下的响亮业务码。 */
  | ({ readonly outcome: "deny"; readonly code: string } & Record<
      string,
      unknown
    >)
  | ({ readonly outcome: "allow" } & Record<string, unknown>);

/** 目录条目（装配注入；生产从 marketplace/catalogue.ts 投影）。 */
export interface MarketplaceCatalogEntry {
  readonly slug: string;
  readonly kind: "expert";
  readonly name: string;
  /** 模板版本，>0；升级判定以版本号单调递增为前提。 */
  readonly version: number;
  /** 模板默认配置副本（安装时逐字拷贝进产物行）。 */
  readonly defaultConfig: Record<string, unknown>;
}

export interface MarketplaceCatalog {
  readonly entries: readonly MarketplaceCatalogEntry[];
}

/** 回执在 resources 表上的固定形状（kind + displayName 前缀）。 */
export const MARKETPLACE_RECEIPT_KIND = "marketplace-install";
export const MARKETPLACE_RECEIPT_PREFIX = "marketplace:";

export interface MarketplaceInstallReceipt {
  /** 回执 ref = 产物 Bot 的 agentId（全局唯一，即 resources 行 id）。 */
  readonly agentId: string;
  readonly expertSlug: string;
  readonly installedVersion: number;
  readonly workspaceId: string;
  readonly ownerPrincipalId: string;
}

/** 归属键（请求体与目录条目一律不可表达；驼峰/下划线拼写同拒）。 */
const ATTRIBUTION_KEYS: readonly string[] = [
  "tenantId",
  "workspaceId",
  "ownerPrincipalId",
  "tenant_id",
  "workspace_id",
  "owner_principal_id",
];

export interface MarketplaceInstallInput {
  /** 产物 Bot 的 agentId（调用方提议；全局唯一冲突 = BOT_ID_UNAVAILABLE）。 */
  readonly proposedAgentId: string;
}

export interface MarketplaceUpgradeInput {
  /** 升级后的默认配置（可选：缺省沿用目录条目配置）。 */
  readonly defaultConfig?: Record<string, unknown>;
}

function assertSlug(slug: string): string {
  if (
    typeof slug !== "string" ||
    slug.trim().length === 0 ||
    slug.length > 128
  ) {
    throw new Error("MARKETPLACE_SLUG_INVALID");
  }
  return slug;
}

function assertAgentId(agentId: string): string {
  if (
    typeof agentId !== "string" ||
    agentId.trim().length === 0 ||
    agentId.length > 256
  ) {
    throw new Error("MARKETPLACE_AGENT_ID_INVALID");
  }
  return agentId;
}

function assertNoClientAttribution(document: Record<string, unknown>): void {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (ATTRIBUTION_KEYS.includes(key)) {
        throw new Error("ATTRIBUTION_NOT_CLIENT_DECLARABLE");
      }
      visit(child);
    }
  };
  visit(document);
}

function assertScopeContext(scope: PlatformScope): void {
  if (!scope.tenantId?.trim()) throw new Error("TENANT_REQUIRED");
  if (!scope.workspaceId?.trim()) throw new Error("WORKSPACE_REQUIRED");
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

/**
 * 目录租户键防御（AC1 机制保证）：公共目录不含任何公司私有内容。
 * 装配点一次性扫描，毒条目（条目本体或 defaultConfig 携带归属键）
 * 响亮拒绝——目录泄漏不可能静默通过。
 */
function assertCatalogTenancyClean(catalog: MarketplaceCatalog): void {
  for (const entry of catalog.entries) {
    assertSlug(entry.slug);
    if (typeof entry.name !== "string" || !entry.name.trim()) {
      throw new Error("MARKETPLACE_CATALOG_ENTRY_INVALID");
    }
    if (!Number.isInteger(entry.version) || entry.version < 1) {
      throw new Error("MARKETPLACE_CATALOG_ENTRY_INVALID");
    }
    if (
      entry.defaultConfig === null ||
      typeof entry.defaultConfig !== "object" ||
      Array.isArray(entry.defaultConfig)
    ) {
      throw new Error("MARKETPLACE_CATALOG_ENTRY_INVALID");
    }
    assertNoClientAttribution(entry.defaultConfig as Record<string, unknown>);
  }
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface MarketplaceInstallService {
  /** 公共目录只读投影（任何已认证 scope 同一答案；deepFrozen）。 */
  readCatalog(scope: PlatformScope): Promise<
    readonly {
      readonly slug: string;
      readonly kind: "expert";
      readonly name: string;
      readonly version: number;
    }[]
  >;
  /** 本租户可见的安装回执（RLS 租户过滤；跨公司天然不可见）。 */
  listInstalls(
    scope: PlatformScope,
  ): Promise<readonly MarketplaceInstallReceipt[]>;
  /** 从目录安装：归属 = 发起 scope 的 (tenant, workspace)。 */
  installFromCatalog(
    scope: PlatformScope,
    expertSlug: string,
    input: MarketplaceInstallInput,
  ): Promise<
    | { readonly outcome: "allow"; readonly replay: boolean }
    | ({ readonly outcome: "deny" } & Record<string, unknown>)
  >;
  /** 逐动作授权判定（唯一判定源；不产生任何写效果）。 */
  decideMarketplaceAction(
    scope: PlatformScope,
    receiptRef: string,
    action: MarketplaceReceiptAction,
  ): Promise<MarketplaceDecision>;
  /** 执行面：同一判定 + 动作效果。 */
  executeMarketplaceAction(
    scope: PlatformScope,
    receiptRef: string,
    action: MarketplaceReceiptAction,
    input?: MarketplaceUpgradeInput,
  ): Promise<MarketplaceExecution>;
}

/** 装配入口：读路径受限 data 通道，写路径受限 operator 通道。 */
export function createMarketplaceInstallService(channels: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  readonly catalog: MarketplaceCatalog;
}): MarketplaceInstallService {
  assertDataDatabase(channels.data);
  assertOperatorDatabase(channels.operator);
  assertCatalogTenancyClean(channels.catalog);
  const { data, operator, catalog } = channels;

  const catalogBySlug = new Map(catalog.entries.map((e) => [e.slug, e]));
  const catalogProjection = deepFreeze(
    catalog.entries
      .map(({ slug, kind, name, version }) => ({ slug, kind, name, version }))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
  );

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

  /** 锁序：tenant → principal → membership → workspace-membership。 */
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

  const botLockKey = (tenantId: string, agentId: string): string =>
    JSON.stringify(["enterprise", "bot", tenantId, agentId]);

  const receiptLockKey = (tenantId: string, agentId: string): string =>
    JSON.stringify(["enterprise", "marketplace-receipt", tenantId, agentId]);

  const receiptOfResourceRow = (row: {
    readonly id: string;
    readonly displayName: string;
    readonly workspaceId: string;
    readonly status: string;
    readonly ownerPrincipalId: string | null;
    readonly productRevision: number | null;
  }): MarketplaceInstallReceipt | null => {
    if (
      row.status !== "active" ||
      row.ownerPrincipalId === null ||
      row.productRevision === null ||
      !row.displayName.startsWith(MARKETPLACE_RECEIPT_PREFIX)
    ) {
      return null;
    }
    return {
      agentId: row.id,
      expertSlug: row.displayName.slice(MARKETPLACE_RECEIPT_PREFIX.length),
      // 版本单一事实源 = 产物行 revision（resources.revision 是初装记录，
      // operator 对该列无 UPDATE 授权——升级只写产物行，两行永不脱钩）。
      installedVersion: row.productRevision,
      workspaceId: row.workspaceId,
      ownerPrincipalId: row.ownerPrincipalId,
    };
  };

  /**
   * 回执可见性 + 授权事实（事务内一次受限读取；MT016 readVisibleOwnership
   * 的本模块切片）。返回 null = 不可见（canonical not-found）。
   */
  const readReceiptFacts = async (
    tx: Tx,
    scope: PlatformScope,
    receiptRef: string,
  ): Promise<{
    readonly receipt: MarketplaceInstallReceipt;
    readonly productConfig: Record<string, unknown>;
    readonly companyAdmin: boolean;
  } | null> => {
    const [row] = await tx
      .select({
        id: enterpriseResources.id,
        kind: enterpriseResources.kind,
        displayName: enterpriseResources.displayName,
        workspaceId: enterpriseResources.workspaceId,
        status: enterpriseResources.status,
        ownerPrincipalId: enterpriseBotOwnership.ownerPrincipalId,
        productRevision: enterpriseBotOwnership.revision,
        productConfig: enterpriseBotOwnership.defaultConfig,
        membershipStatus: enterpriseWorkspaceMemberships.status,
        companyMemberStatus: enterpriseMemberships.status,
        companyMemberEpoch: enterpriseMemberships.epoch,
        companyMemberRole: enterpriseMemberships.role,
      })
      .from(enterpriseResources)
      .leftJoin(
        enterpriseBotOwnership,
        and(
          eq(enterpriseBotOwnership.tenantId, enterpriseResources.tenantId),
          eq(enterpriseBotOwnership.agentId, enterpriseResources.id),
        ),
      )
      .leftJoin(
        enterpriseWorkspaceMemberships,
        and(
          eq(
            enterpriseWorkspaceMemberships.tenantId,
            enterpriseResources.tenantId,
          ),
          eq(
            enterpriseWorkspaceMemberships.workspaceId,
            enterpriseResources.workspaceId,
          ),
          eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
        ),
      )
      .leftJoin(
        enterpriseMemberships,
        and(
          eq(enterpriseMemberships.tenantId, enterpriseResources.tenantId),
          eq(enterpriseMemberships.principalId, scope.principalId),
        ),
      )
      .where(
        and(
          eq(enterpriseResources.tenantId, scope.tenantId),
          eq(enterpriseResources.id, receiptRef),
        ),
      )
      .limit(1);
    if (!row || row.kind !== MARKETPLACE_RECEIPT_KIND) return null;
    const receipt = receiptOfResourceRow(row);
    // 产物行缺失（半清理态）按不可见处理，不产生第二种可见形状。
    if (!receipt || !row.ownerPrincipalId) return null;
    if (
      row.workspaceId !== scope.workspaceId ||
      row.membershipStatus !== "active" ||
      row.companyMemberStatus !== "active" ||
      row.companyMemberEpoch !== scope.memberEpoch
    ) {
      return null;
    }
    return {
      receipt,
      productConfig: row.productConfig as Record<string, unknown>,
      companyAdmin: row.companyMemberRole === "tenant_admin",
    };
  };

  return {
    async readCatalog() {
      return catalogProjection;
    },

    async listInstalls(scope) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        const rows = await tx
          .select({
            id: enterpriseResources.id,
            displayName: enterpriseResources.displayName,
            workspaceId: enterpriseResources.workspaceId,
            status: enterpriseResources.status,
            ownerPrincipalId: enterpriseBotOwnership.ownerPrincipalId,
            productRevision: enterpriseBotOwnership.revision,
          })
          .from(enterpriseResources)
          .leftJoin(
            enterpriseBotOwnership,
            and(
              eq(enterpriseBotOwnership.tenantId, enterpriseResources.tenantId),
              eq(enterpriseBotOwnership.agentId, enterpriseResources.id),
            ),
          )
          .where(
            and(
              eq(enterpriseResources.kind, MARKETPLACE_RECEIPT_KIND),
              eq(enterpriseResources.status, "active"),
            ),
          );
        const receipts = [];
        for (const row of rows) {
          if (!row.ownerPrincipalId) continue;
          const receipt = receiptOfResourceRow({
            ...row,
            ownerPrincipalId: row.ownerPrincipalId,
          });
          if (receipt) receipts.push(receipt);
        }
        return deepFreeze(receipts);
      });
    },

    async installFromCatalog(scope, expertSlug, input) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertSlug(expertSlug);
      const entry = catalogBySlug.get(expertSlug);
      // 目录是公共常量：未知 slug 不存在存在性敏感，大方拒绝。
      if (!entry) {
        return deepFreeze({
          outcome: "deny",
          code: "MARKETPLACE_SLUG_UNKNOWN",
        });
      }
      if (!input || typeof input.proposedAgentId !== "string") {
        throw new Error("MARKETPLACE_INPUT_INVALID");
      }
      const agentId = assertAgentId(input.proposedAgentId);
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: botLockKey(scope.tenantId, agentId), exclusive: true },
          { key: receiptLockKey(scope.tenantId, agentId), exclusive: true },
        ]);
        // 幂等回放：同团队同 slug 已安装 → 既有回执即答案（不双开 Bot）。
        const displayName = `${MARKETPLACE_RECEIPT_PREFIX}${entry.slug}`;
        const [existing] = await tx
          .select({ id: enterpriseResources.id })
          .from(enterpriseResources)
          .innerJoin(
            enterpriseBotOwnership,
            and(
              eq(enterpriseBotOwnership.tenantId, enterpriseResources.tenantId),
              eq(enterpriseBotOwnership.agentId, enterpriseResources.id),
            ),
          )
          .where(
            and(
              eq(enterpriseResources.tenantId, scope.tenantId),
              eq(enterpriseResources.workspaceId, scope.workspaceId),
              eq(enterpriseResources.kind, MARKETPLACE_RECEIPT_KIND),
              eq(enterpriseResources.displayName, displayName),
              eq(enterpriseResources.status, "active"),
            ),
          )
          .limit(1);
        if (existing) {
          return deepFreeze({
            outcome: "allow",
            replay: true,
            agentId: existing.id,
          });
        }
        // 产物行（MT016 归属面）：INSERT 处被全局唯一约束拒绝冲突——
        // 同公司重复与跨公司占用同一代码，不泄露占用发生在哪家。
        await tx
          .insert(enterpriseBotOwnership)
          .values({
            tenantId: scope.tenantId,
            agentId,
            workspaceId: scope.workspaceId,
            ownerPrincipalId: scope.principalId,
            displayName: entry.name,
            defaultConfig: structuredClone(entry.defaultConfig),
            revision: entry.version,
          })
          .onConflictDoNothing();
        const [createdProduct] = await tx
          .select({
            workspaceId: enterpriseBotOwnership.workspaceId,
            ownerPrincipalId: enterpriseBotOwnership.ownerPrincipalId,
            status: enterpriseBotOwnership.status,
          })
          .from(enterpriseBotOwnership)
          .where(
            and(
              eq(enterpriseBotOwnership.tenantId, scope.tenantId),
              eq(enterpriseBotOwnership.agentId, agentId),
            ),
          )
          .limit(1);
        // 冲突吞掉后的重读只认本人本团队的活行；同租户他人/别团队的占用行
        // 对 RLS 可见，不得当作安装成功（同码 BOT_ID_UNAVAILABLE，不泄露）。
        if (
          !createdProduct ||
          createdProduct.status !== "active" ||
          createdProduct.ownerPrincipalId !== scope.principalId ||
          createdProduct.workspaceId !== scope.workspaceId
        ) {
          throw new Error("BOT_ID_UNAVAILABLE");
        }
        await tx.insert(enterpriseResources).values({
          tenantId: scope.tenantId,
          id: agentId,
          workspaceId: scope.workspaceId,
          kind: MARKETPLACE_RECEIPT_KIND,
          displayName,
          revision: entry.version,
        });
        return deepFreeze({ outcome: "allow", replay: false, agentId });
      });
    },

    async decideMarketplaceAction(scope, receiptRef, action) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertAgentId(receiptRef);
      if (
        !(MARKETPLACE_RECEIPT_ACTIONS as readonly string[]).includes(action)
      ) {
        throw new Error("MARKETPLACE_ACTION_INVALID");
      }
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: botLockKey(scope.tenantId, receiptRef), exclusive: false },
          { key: receiptLockKey(scope.tenantId, receiptRef), exclusive: false },
        ]);
        const facts = await readReceiptFacts(tx, scope, receiptRef);
        if (!facts) return notFoundVerdict();
        if (
          facts.receipt.ownerPrincipalId !== scope.principalId &&
          !facts.companyAdmin
        ) {
          return { outcome: "deny", code: "MARKETPLACE_FORBIDDEN" } as const;
        }
        return { outcome: "allow" } as const;
      });
    },

    async executeMarketplaceAction(scope, receiptRef, action, input) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertAgentId(receiptRef);
      if (input?.defaultConfig !== undefined) {
        assertNoClientAttribution(input.defaultConfig);
      }
      if (
        !(MARKETPLACE_RECEIPT_ACTIONS as readonly string[]).includes(action)
      ) {
        throw new Error("MARKETPLACE_ACTION_INVALID");
      }
      return operator.transaction(async (tx): Promise<MarketplaceExecution> => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: botLockKey(scope.tenantId, receiptRef), exclusive: true },
          {
            key: receiptLockKey(scope.tenantId, receiptRef),
            exclusive: true,
          },
        ]);
        const facts = await readReceiptFacts(tx, scope, receiptRef);
        if (!facts) return notFoundVerdict();
        if (
          facts.receipt.ownerPrincipalId !== scope.principalId &&
          !facts.companyAdmin
        ) {
          return { outcome: "deny", code: "MARKETPLACE_FORBIDDEN" } as const;
        }
        const entry = catalogBySlug.get(facts.receipt.expertSlug);

        switch (action) {
          case "upgrade": {
            // 模板已下架：升级无源，仍可卸载；不泄露其他公司是否装过。
            if (!entry) {
              return deepFreeze({
                outcome: "deny",
                code: "MARKETPLACE_SLUG_RETIRED",
              });
            }
            if (entry.version < facts.receipt.installedVersion) {
              return deepFreeze({
                outcome: "deny",
                code: "MARKETPLACE_DOWNGRADE_REFUSED",
              });
            }
            if (entry.version === facts.receipt.installedVersion) {
              return deepFreeze({
                outcome: "allow",
                alreadyCurrent: true,
                agentId: receiptRef,
                version: entry.version,
              });
            }
            const nextConfig =
              input?.defaultConfig ?? structuredClone(entry.defaultConfig);
            await tx
              .update(enterpriseBotOwnership)
              .set({
                defaultConfig: nextConfig,
                revision: entry.version,
              })
              .where(
                and(
                  eq(enterpriseBotOwnership.tenantId, scope.tenantId),
                  eq(enterpriseBotOwnership.agentId, receiptRef),
                ),
              );
            return deepFreeze({
              outcome: "allow",
              alreadyCurrent: false,
              agentId: receiptRef,
              version: entry.version,
            });
          }

          case "uninstall": {
            // 产物行硬删（MT019 delete 同形：偏好/共享使用回执经 FK 级联
            // 消失）。回执行保留——operator 对 enterprise_resources 只有
            // visibility 列的 UPDATE 授权，无 DELETE；卸载的失效语义由
            // 判定面保证：产物行缺失的回执行一律不可见（not-found 与
            // listInstalls 过滤），不构成可访问的悬挂引用。
            await tx
              .delete(enterpriseBotOwnership)
              .where(
                and(
                  eq(enterpriseBotOwnership.tenantId, scope.tenantId),
                  eq(enterpriseBotOwnership.agentId, receiptRef),
                ),
              );
            return deepFreeze({ outcome: "allow", agentId: receiptRef });
          }
        }
      });
    },
  };
}
