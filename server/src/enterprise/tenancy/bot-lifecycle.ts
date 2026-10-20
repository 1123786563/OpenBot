// server/src/enterprise/tenancy/bot-lifecycle.ts
// MT019（Issue #62）：Bot 生命周期动作逐项授权（复制/隐藏/重置/删除/模板
// 更新/远端回调）。
//
// 票面语义：复制、隐藏、重置、删除、模板更新与远端回调等每个生命周期
// 动作都单独授权，管理动作不因为可读或可运行而自动放行。
//
// 结构（纯新增，只读消费 MT016/MT017/MT011 既有出口，不改任何既有文件）：
//
//   1. 动作词表六个，逐项独立授权（decideLifecycleAction 是唯一判定源，
//      executeLifecycleAction 逐动作经同一判定，不存在"可读即放行"的旁路）：
//      授权 = 归属 owner ∨ 公司 tenant_admin（enterprise_memberships.role
//      每事务重验，active 行才算数——管理权限是明确声明的事实，不是隐式
//      继承：Spec §4.1 管理权限与内容访问分别判断）。公共 Bot 使用者
//      （同团队非 owner 成员，对已发布 Bot 本就可读可运行）六动作一律
//      BOT_LIFECYCLE_FORBIDDEN——已过可见性门，该拒绝不泄露额外信息。
//   2. 可见性门与 MT016 同一读法（行经 RLS 租户过滤 → 同团队 + active +
//      公司成员 active/epoch 匹配 + 团队成员 active）→ MT011 canonical
//      { outcome: "deny", code: "RESOURCE_NOT_FOUND" }：不存在/跨公司/
//      跨团队/已删除/已撤权对外不可区分。
//   3. remote-callback 是六动作之一但入口无用户 scope（服务间回调）：
//      handleBotRemoteCallback 以持久化归属行（agent_id 全局唯一索引）为
//      唯一归属事实——回调体里出现任何归属键（驼峰/下划线拼写一律）
//      ATTRIBUTION_NOT_CLIENT_DECLARABLE 响亮拒绝，与 MT028 OAuth state
//      同源：服务端持久状态优先于客户端选择。归属定位读取走装配注入的
//      setup 通道（只读、无业务判定；业务写入仍走受限 operator 角色 +
//      归属租户上下文 + RLS）。
//   4. delete 级联失效（验收 3）：同一 operator 事务内，全部 policy-legal：
//      注册行（MT017 发布面）visibility → NULL（operator 对该表的 UPDATE
//      是列级授权仅 visibility——发布受众立即关闭，MT017 unpublish 同款；
//      注册行本体保留：判定面效力已终结——受众关闭 + 下方 grants 清空后
//      MT008/MT009 对该 Bot 一律 canonical not-found，残留行无授权语义，
//      不构成可访问的悬挂引用）；显式授权行逐受益人按 grants 的 operator
//      DELETE 行策略物理删除；归属行硬删（operator DELETE 按租户授权）
//      ——偏好行与共享使用回执（申请 + 批准行）经复合外键 ON DELETE
//      CASCADE 同时消失，回执零残留（数据库层保证）。
//   5. hide = 团队公共撤下：注册行 visibility 'workspace' → NULL（幂等，
//      未发布 Bot no-op allow）；与 MT017 unpublish 效果同形但授权门不同
//      （owner ∨ tenant_admin——管理动作）。reset = 恢复默认：
//      defaultConfig 重置为 {} + revision+1。template-update = 全量替换
//      defaultConfig（拒绝归属键）+ revision+1。duplicate = 同 (tenant,
//      workspace) 新建归属行（归属 = 发起者，displayName/defaultConfig
//      复制，新 agentId 由调用方提议但经同一全局唯一约束拒绝冲突）。
//
// 事务纪律与 MT016/MT017 完全一致：受信 Scope（assertTrustedScope）→
// read committed + lock/statement timeout → set_config('app.*', …, true)
// 事务本地 → advisory 锁。锁序：tenant → principal → membership →
// workspace-membership → bot（判定读共享、生命周期写排他）→ resource
// （排他，["enterprise","resource",tenant,id] MT008 键族——与判定读共享锁、
// MT017 发布写串行化；bot → resource 单向边，无环）。读路径走受限 data
// 角色，写路径走受限 operator 角色；事实读取全部经真实 RLS。
//
// 边界（诚实披露）：
//   - 撤权后拒绝由可见性门的事务内重验保证（MT006 epoch 递增使已签发
//     scope 立即失效）——AC4 的"拒绝"是 canonical not-found，与不存在
//     不可区分（本票不引入第二种撤权后拒绝形状）。
//   - 远端回调的凭据交换（回调 token 签发/校验）不在本票范围：回调入口
//     只持 agentId + 归属事实；凭据层（MT056 签名下载同族）属后续票。
//   - 挂路由非本票范围：服务面供下游接线票复用（MT016/MT017 同例）。

import { and, eq, sql } from "drizzle-orm";
import { enterpriseBotOwnership } from "../../db/schema/enterprise-bot-ownership";
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
// 词表与判定形状
// ---------------------------------------------------------------------------

/** 生命周期动作词表（票面六项，闭集）。 */
export const BOT_LIFECYCLE_ACTIONS = [
  "duplicate",
  "hide",
  "reset",
  "delete",
  "template-update",
  "remote-callback",
] as const;

export type BotLifecycleAction = (typeof BOT_LIFECYCLE_ACTIONS)[number];

/** 有用户 scope 的五个动作；remote-callback 走独立入口（无用户 scope）。 */
export type ScopedBotLifecycleAction = Exclude<
  BotLifecycleAction,
  "remote-callback"
>;

/** 已过可见性门后的管理拒绝（不泄露额外信息：能到这一步已说明可见）。 */
export interface BotLifecycleForbidden {
  readonly outcome: "deny";
  readonly code: "BOT_LIFECYCLE_FORBIDDEN";
}

export type BotLifecycleDecision =
  | { readonly outcome: "allow" }
  | ResourceNotFoundVerdict
  | BotLifecycleForbidden;

/** duplicate / template-update 的输入（归属键一律不可表达）。 */
const ATTRIBUTION_KEYS: readonly string[] = [
  "tenantId",
  "workspaceId",
  "ownerPrincipalId",
  "tenant_id",
  "workspace_id",
  "owner_principal_id",
];

export interface BotLifecycleDuplicateInput {
  /** 新 Bot 的 agentId（调用方提议；全局唯一冲突 = BOT_ID_UNAVAILABLE）。 */
  readonly newAgentId: string;
}

export interface BotLifecycleTemplateUpdateInput {
  readonly defaultConfig: Record<string, unknown>;
}

export type BotLifecycleInput =
  | BotLifecycleDuplicateInput
  | BotLifecycleTemplateUpdateInput
  | undefined;

/** 动作执行结果：allow 携带动作效果事实（deepFrozen）。 */
export type BotLifecycleExecution =
  | BotLifecycleDecision
  | ({ readonly outcome: "allow" } & Record<string, unknown>);

// ---------------------------------------------------------------------------
// 回调形状（remote-callback：无用户 scope）
// ---------------------------------------------------------------------------

export type BotRemoteCallbackKind = "template-update" | "external-notice";

export interface BotRemoteCallbackParams {
  readonly kind: BotRemoteCallbackKind;
  /** 回调针对的 Bot（持久化归属行按 agent_id 全局唯一定位）。 */
  readonly agentId: string;
  /** template-update 的新配置（拒绝归属键）；external-notice 忽略。 */
  readonly payload?: Record<string, unknown>;
}

export type BotRemoteCallbackVerdict =
  | { readonly outcome: "allow"; readonly revision: number }
  | ResourceNotFoundVerdict;

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface BotLifecycleService {
  /**
   * 逐动作授权判定（唯一判定源；不产生任何写效果）。
   * remote-callback 不在 scoped 词表内——它没有用户 scope，经
   * handleBotRemoteCallback 判定（归属匹配即该动作的授权）。
   */
  decideLifecycleAction(
    scope: PlatformScope,
    agentId: string,
    action: ScopedBotLifecycleAction,
  ): Promise<BotLifecycleDecision>;
  /** 执行面：同一判定 + 动作效果；效果见模块头第 5 节。 */
  executeLifecycleAction(
    scope: PlatformScope,
    agentId: string,
    action: ScopedBotLifecycleAction,
    input?: BotLifecycleInput,
  ): Promise<BotLifecycleExecution>;
  /**
   * 远端回调（模板更新 / 外部通知）：归属只来自持久化归属行；
   * 回调体出现归属键一律响亮拒绝（服务端持久状态优先于客户端选择）。
   */
  handleBotRemoteCallback(
    params: BotRemoteCallbackParams,
  ): Promise<BotRemoteCallbackVerdict>;
}

/** 装配通道：setup 只用于回调归属定位（无业务判定的只读通道）。 */
export interface BotLifecycleChannels {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  readonly setup: {
    readonly $client: { readonly end: () => Promise<void> };
  } & {
    readonly execute: DataDatabase["execute"];
    readonly transaction: DataDatabase["transaction"];
  };
}

function assertAgentId(agentId: string): string {
  if (
    typeof agentId !== "string" ||
    agentId.trim().length === 0 ||
    agentId.length > 256
  ) {
    throw new Error("BOT_LIFECYCLE_INPUT_INVALID");
  }
  return agentId;
}

/** 回调/配置体里的归属键（驼峰与下划线拼写一律拒绝）。 */
function assertNoClientAttribution(document: Record<string, unknown>): void {
  for (const key of Object.keys(document)) {
    if (ATTRIBUTION_KEYS.includes(key)) {
      throw new Error("ATTRIBUTION_NOT_CLIENT_DECLARABLE");
    }
  }
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

const FORBIDDEN: BotLifecycleForbidden = Object.freeze({
  outcome: "deny",
  code: "BOT_LIFECYCLE_FORBIDDEN",
});

/**
 * 装配入口。读路径走已验证 data 通道，写路径走已验证 operator 通道，
 * 回调归属定位走装配层 setup 通道；未验证业务通道在装配时拒绝。
 */
export function createBotLifecycleService(channels: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  readonly setup: BotLifecycleChannels["setup"];
}): BotLifecycleService {
  assertDataDatabase(channels.data);
  assertOperatorDatabase(channels.operator);
  const { data, operator, setup } = channels;

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

  const resourceLockKey = (tenantId: string, id: string): string =>
    JSON.stringify(["enterprise", "resource", tenantId, id]);

  /**
   * 可见性 + 授权事实（事务内一次受限读取；MT016 readVisibleOwnership 的
   * 本模块切片，多读一列公司成员 role——tenant_admin 是明确管理权限的
   * 唯一域内表达）。返回 null = 不可见（canonical not-found）。
   */
  const readLifecycleFacts = async (
    tx: Tx,
    scope: PlatformScope,
    agentId: string,
  ): Promise<{
    readonly ownerPrincipalId: string;
    readonly displayName: string;
    readonly defaultConfig: Record<string, unknown>;
    readonly revision: number;
    readonly companyAdmin: boolean;
  } | null> => {
    const [row] = await tx
      .select({
        workspaceId: enterpriseBotOwnership.workspaceId,
        ownerPrincipalId: enterpriseBotOwnership.ownerPrincipalId,
        displayName: enterpriseBotOwnership.displayName,
        defaultConfig: enterpriseBotOwnership.defaultConfig,
        status: enterpriseBotOwnership.status,
        revision: enterpriseBotOwnership.revision,
        membershipStatus: enterpriseWorkspaceMemberships.status,
        companyMemberStatus: enterpriseMemberships.status,
        companyMemberEpoch: enterpriseMemberships.epoch,
        companyMemberRole: enterpriseMemberships.role,
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
    if (
      row.status !== "active" ||
      row.workspaceId !== scope.workspaceId ||
      row.membershipStatus !== "active" ||
      row.companyMemberStatus !== "active" ||
      row.companyMemberEpoch !== scope.memberEpoch
    ) {
      return null;
    }
    return {
      ownerPrincipalId: row.ownerPrincipalId,
      displayName: row.displayName,
      defaultConfig: row.defaultConfig as Record<string, unknown>,
      revision: row.revision,
      companyAdmin: row.companyMemberRole === "tenant_admin",
    };
  };

  /** 判定（事务内共享读取；decision-only，不写）。 */
  const decideInside = async (
    tx: Tx,
    scope: PlatformScope,
    agentId: string,
  ): Promise<BotLifecycleDecision> => {
    const facts = await readLifecycleFacts(tx, scope, agentId);
    if (!facts) return notFoundVerdict();
    if (facts.ownerPrincipalId !== scope.principalId && !facts.companyAdmin) {
      return FORBIDDEN;
    }
    return { outcome: "allow" };
  };

  return {
    async decideLifecycleAction(scope, agentId, action) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertAgentId(agentId);
      // 词表闭集的运行时防御：未知动作一律响亮拒绝，绝无声默 allow。
      if (!(BOT_LIFECYCLE_ACTIONS as readonly string[]).includes(action)) {
        throw new Error("BOT_LIFECYCLE_ACTION_INVALID");
      }
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: botLockKey(scope.tenantId, agentId), exclusive: false },
        ]);
        return decideInside(tx, scope, agentId);
      });
    },

    async executeLifecycleAction(scope, agentId, action, input) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertAgentId(agentId);
      if (input) {
        for (const value of Object.values(input)) {
          if (value !== null && typeof value === "object") {
            assertNoClientAttribution(value as Record<string, unknown>);
          }
        }
      }
      if (action === "duplicate") {
        if (
          !input ||
          typeof (input as BotLifecycleDuplicateInput).newAgentId !== "string"
        ) {
          throw new Error("BOT_LIFECYCLE_INPUT_INVALID");
        }
        assertAgentId((input as BotLifecycleDuplicateInput).newAgentId);
      }
      if (action === "template-update") {
        const config = (input as BotLifecycleTemplateUpdateInput | undefined)
          ?.defaultConfig;
        if (
          config === null ||
          typeof config !== "object" ||
          Array.isArray(config)
        ) {
          throw new Error("BOT_DOCUMENT_INVALID");
        }
        assertNoClientAttribution(config);
      }
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: botLockKey(scope.tenantId, agentId), exclusive: true },
        ]);
        const facts = await readLifecycleFacts(tx, scope, agentId);
        if (!facts) return notFoundVerdict();
        if (
          facts.ownerPrincipalId !== scope.principalId &&
          !facts.companyAdmin
        ) {
          return FORBIDDEN;
        }

        switch (action) {
          case "duplicate": {
            const { newAgentId } = input as BotLifecycleDuplicateInput;
            await tx
              .insert(enterpriseBotOwnership)
              .values({
                tenantId: scope.tenantId,
                agentId: newAgentId,
                workspaceId: scope.workspaceId,
                ownerPrincipalId: scope.principalId,
                displayName: facts.displayName,
                defaultConfig: facts.defaultConfig,
              })
              .onConflictDoNothing();
            const [created] = await tx
              .select({ revision: enterpriseBotOwnership.revision })
              .from(enterpriseBotOwnership)
              .where(
                and(
                  eq(enterpriseBotOwnership.tenantId, scope.tenantId),
                  eq(enterpriseBotOwnership.agentId, newAgentId),
                ),
              )
              .limit(1);
            // 冲突（全局唯一索引或主键占用）在 INSERT 处被约束本身拒绝：
            // 同公司重复与跨公司占用同一代码，不泄露占用发生在哪。
            if (!created) {
              throw new Error("BOT_ID_UNAVAILABLE");
            }
            return deepFreeze({ outcome: "allow", newAgentId });
          }

          case "hide": {
            await takeLocks(tx, [
              {
                key: resourceLockKey(scope.tenantId, agentId),
                exclusive: true,
              },
            ]);
            await tx.execute(
              sql`select set_config('app.resource_id', ${agentId}, true)`,
            );
            // 列级授权仅 visibility（MT008）：revision/aclEpoch 不可写。
            await tx
              .update(enterpriseResources)
              .set({ visibility: null })
              .where(
                and(
                  eq(enterpriseResources.tenantId, scope.tenantId),
                  eq(enterpriseResources.id, agentId),
                  eq(enterpriseResources.kind, "bot"),
                  eq(enterpriseResources.status, "active"),
                  eq(enterpriseResources.visibility, "workspace"),
                ),
              );
            // 未发布 Bot：无注册行变化（no-op allow，幂等）。
            return { outcome: "allow" };
          }

          case "reset": {
            await tx
              .update(enterpriseBotOwnership)
              .set({
                defaultConfig: {},
                revision: sql`${enterpriseBotOwnership.revision} + 1`,
                updatedAt: sql`now()`,
              })
              .where(
                and(
                  eq(enterpriseBotOwnership.tenantId, scope.tenantId),
                  eq(enterpriseBotOwnership.agentId, agentId),
                ),
              );
            return { outcome: "allow" };
          }

          case "template-update": {
            const { defaultConfig } = input as BotLifecycleTemplateUpdateInput;
            await tx
              .update(enterpriseBotOwnership)
              .set({
                defaultConfig,
                revision: sql`${enterpriseBotOwnership.revision} + 1`,
                updatedAt: sql`now()`,
              })
              .where(
                and(
                  eq(enterpriseBotOwnership.tenantId, scope.tenantId),
                  eq(enterpriseBotOwnership.agentId, agentId),
                ),
              );
            return { outcome: "allow" };
          }

          case "delete": {
            await takeLocks(tx, [
              {
                key: resourceLockKey(scope.tenantId, agentId),
                exclusive: true,
              },
            ]);
            // 注册行（发布/受众）关闭：operator 对该表的 UPDATE 是列级
            // 授权（仅 visibility，MT008 迁移）——status 不可写，走 MT017
            // unpublish 同款 visibility → NULL（团队公共受众立即关闭），
            // 行策略要求 app.resource_id 匹配行。
            await tx.execute(
              sql`select set_config('app.resource_id', ${agentId}, true)`,
            );
            await tx
              .update(enterpriseResources)
              .set({ visibility: null })
              .where(
                and(
                  eq(enterpriseResources.tenantId, scope.tenantId),
                  eq(enterpriseResources.id, agentId),
                  eq(enterpriseResources.kind, "bot"),
                  eq(enterpriseResources.status, "active"),
                ),
              );
            // 相关授权物理失效：grants 的 operator DELETE 策略按
            // (tenant, resource, principal) 逐行授权——先读出该资源的
            // 全部受益人，再逐行按其主体上下文删除（行数 = 该 Bot 的
            // 显式授权数；锁内读取，集合稳定）。
            const grantRows = await tx
              .select({ principalId: enterpriseResourceGrants.principalId })
              .from(enterpriseResourceGrants)
              .where(
                and(
                  eq(enterpriseResourceGrants.tenantId, scope.tenantId),
                  eq(enterpriseResourceGrants.resourceId, agentId),
                ),
              );
            for (const grant of grantRows) {
              await tx.execute(
                sql`select set_config('app.operator_principal_id', ${grant.principalId}, true)`,
              );
              await tx
                .delete(enterpriseResourceGrants)
                .where(
                  and(
                    eq(enterpriseResourceGrants.tenantId, scope.tenantId),
                    eq(enterpriseResourceGrants.resourceId, agentId),
                    eq(enterpriseResourceGrants.principalId, grant.principalId),
                  ),
                );
            }
            // 归属行硬删：operator DELETE 策略按租户授权。偏好行与共享
            // 使用回执（pending 申请 + 批准行）经复合外键 ON DELETE
            // CASCADE 同时消失——回执零残留，数据库层保证（无悬挂引用）。
            await tx
              .delete(enterpriseBotOwnership)
              .where(
                and(
                  eq(enterpriseBotOwnership.tenantId, scope.tenantId),
                  eq(enterpriseBotOwnership.agentId, agentId),
                ),
              );
            return { outcome: "allow" };
          }

          default: {
            // 词表闭集已由类型钉死；运行时兜底同 MT016 输入纪律。
            throw new Error("BOT_LIFECYCLE_ACTION_INVALID");
          }
        }
      });
    },

    async handleBotRemoteCallback(params) {
      const { kind, agentId } = params;
      assertAgentId(agentId);
      const payload = params.payload ?? {};
      assertNoClientAttribution(payload);

      // 归属定位：持久化归属行（agent_id 全局唯一）是唯一归属事实。setup
      // 通道只做这一定位读取；业务效果全部落在受限 operator 事务内。
      const located = await setup.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = '5s'`);
        const rows = (await tx.execute(
          sql`select tenant_id, workspace_id, status, default_config, revision from enterprise_bot_ownership where agent_id = ${agentId} limit 1`,
        )) as unknown;
        const list = Array.isArray(rows)
          ? rows
          : ((rows as { rows?: unknown[] })?.rows ?? []);
        const row = list[0] as
          | {
              tenant_id: string;
              workspace_id: string;
              status: string;
              default_config: unknown;
              revision: number;
            }
          | undefined;
        return row ?? null;
      });
      // 不存在与已删除同一形状（回调方不得借此区分）。
      if (located?.status !== "active") {
        return notFoundVerdict();
      }

      return operator.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        // 归属租户上下文 = 持久化归属行，绝不来自回调体。
        await tx.execute(
          sql`select set_config('app.tenant_id', ${located.tenant_id}, true), set_config('app.workspace_id', ${located.workspace_id}, true)`,
        );
        await takeLocks(tx, [
          {
            key: JSON.stringify(["enterprise", "tenant", located.tenant_id]),
            exclusive: false,
          },
          { key: botLockKey(located.tenant_id, agentId), exclusive: true },
        ]);
        // 竞态复核：定位与写入之间归属行可能被删/改（锁内重读）。
        const [current] = await tx
          .select({
            status: enterpriseBotOwnership.status,
            revision: enterpriseBotOwnership.revision,
          })
          .from(enterpriseBotOwnership)
          .where(eq(enterpriseBotOwnership.agentId, agentId))
          .limit(1);
        if (current?.status !== "active") {
          return notFoundVerdict();
        }
        if (kind === "template-update") {
          await tx
            .update(enterpriseBotOwnership)
            .set({
              defaultConfig: payload,
              revision: sql`${enterpriseBotOwnership.revision} + 1`,
              updatedAt: sql`now()`,
            })
            .where(eq(enterpriseBotOwnership.agentId, agentId));
        }
        // external-notice：无状态变化（域内无事件表；效果面属后续票）。
        return { outcome: "allow" as const, revision: current.revision + 1 };
      });
    },
  };
}
