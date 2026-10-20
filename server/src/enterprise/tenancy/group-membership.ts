// server/src/enterprise/tenancy/group-membership.ts
// MT023（Issue #66）：群聊成员与 Bot 席位的作用域。
//
// 票面语义：群聊的创建、成员增删与 Bot 席位都限定在同一公司（且符合
// 团队规则）范围内；不能把另一公司的用户或 Bot 拉进群，也不能通过群
// 成员关系读到无权内容。
//
// 结构（纯新增，零 schema 对象——群、成员、席位全部复用 MT008 资源与
// 授权行，只读消费 MT011/MT016/MT017 既有出口，不改任何既有文件）：
//
//   1. 群 = enterprise_resources kind='group-chat'（workspace 归属）；
//      成员 = enterprise_resource_grants action='read'（每成员一行——
//      grants 的 action CHECK 恰为 'read'，语义即"可读群"）。群成员
//      关系不放大任何其他权限：成员资格只是"该群"的资源行授权，
//      MT008/MT009 判定链对其他资源/会话仍按各自 grant 判定（AC2 由
//      授权模型保证，测试钉死）。
//   2. 跨公司邀请（AC1）：被邀者必须在本群所属公司有 active 成员行
//      （enterprise_memberships status 检查）。不存在 / suspended /
//      别家公司用户对外同一形状 canonical not-found——邀请拒绝不泄露
//      对象存在性（MT011 同源）。
//   3. 移除成员（AC3）：删成员 grant 行（grants 的 operator DELETE 行
//      策略：app.tenant_id + app.resource_id + app.operator_principal_id
//      匹配行——逐行 set_config 后物理删除，MT019 delete 同款）。删除
//      后该成员的群读取在下一个事务即 canonical not-found：成员判定
//      每事务重验 grant 行，无任何缓存。
//   4. Bot 席位（AC4）：席位 = enterprise_resources kind='group-bot-seat'
//      （id=`<groupId>:<agentId>`，visibility 列是在场标记——'workspace'
//      在场、NULL 退席；该列是 operator 对本表唯一可 UPDATE 的列，
//      行策略要求 app.resource_id 匹配）。席位变更授权与 Bot 发布
//      （MT017）一致：Bot owner ∨ 公司 tenant_admin（每事务重验）；
//      且 Bot 必须已发布到群所在团队（MT017 注册行 kind='bot' +
//      visibility='workspace' 同租户同团队）——未发布/跨公司 Bot 的
//      席位请求 canonical not-found。
//
// 事务纪律与 MT019/MT020 完全一致：assertScopeContext →
// assertTrustedScope → read committed + lock/statement timeout →
// set_config('app.*', …, true) 事务本地 → advisory 锁。锁序：tenant →
// principal → membership → workspace-membership → group（判定读共享、
// 成员/席位写排他）。读路径受限 data 角色，写路径受限 operator 角色。
//
// 边界（诚实披露）：
//   - 群成员增删的门是"群成员自治"（操作者本人须是 active 群成员）；
//     票面只钉范围限定（同公司同团队），不设群主层级——群主语义
//     （创建者特权）留待下游接线票（resources 行无 owner 列，零
//     schema 下不伪造）。
//   - 退席行保留（visibility=NULL）而非物理删除：operator 对
//     enterprise_resources 无 DELETE 授权；判定面只认 visibility=
//     'workspace' 的席位行，NULL 行不构成可访问事实。
//   - 事件订阅（AC3"事件订阅立即失效"）在本票=群读取面的事实重验；
//     真实 SSE/订阅通道在 MT025（streams）票，彼时消费本模块成员判定。

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
// 词表与形状
// ---------------------------------------------------------------------------

export const GROUP_RESOURCE_KIND = "group-chat";
export const GROUP_SEAT_KIND = "group-bot-seat";

/** 已过可见性门后的管理拒绝（席位管理：非 Bot owner 非 tenant_admin）。 */
export interface GroupSeatForbidden {
  readonly outcome: "deny";
  readonly code: "GROUP_SEAT_FORBIDDEN";
}

export type GroupDecision =
  | { readonly outcome: "allow" }
  | ResourceNotFoundVerdict
  | GroupSeatForbidden;

export type GroupExecution =
  | GroupDecision
  | ({ readonly outcome: "allow" } & Record<string, unknown>)
  | ({ readonly outcome: "deny"; readonly code: string } & Record<
      string,
      unknown
    >);

export interface GroupView {
  readonly groupId: string;
  readonly title: string;
  readonly workspaceId: string;
  readonly memberCount: number;
  readonly seats: readonly string[];
}

function assertGroupId(groupId: string): string {
  if (
    typeof groupId !== "string" ||
    groupId.trim().length === 0 ||
    groupId.length > 256
  ) {
    throw new Error("GROUP_ID_INVALID");
  }
  return groupId;
}

function assertPrincipalId(principalId: string): string {
  if (
    typeof principalId !== "string" ||
    principalId.trim().length === 0 ||
    principalId.length > 256
  ) {
    throw new Error("PRINCIPAL_ID_INVALID");
  }
  return principalId;
}

function assertTitle(title: string): string {
  if (
    typeof title !== "string" ||
    title.trim().length === 0 ||
    title.length > 200
  ) {
    throw new Error("GROUP_TITLE_INVALID");
  }
  return title;
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

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface GroupMembershipService {
  /** 建群：归属发起 scope 的 (tenant, workspace)；发起者即首个成员。 */
  createGroup(
    scope: PlatformScope,
    input: { readonly groupId: string; readonly title: string },
  ): Promise<GroupExecution>;
  /** 邀请成员：被邀者须是本公司 active 成员；否则 canonical not-found。 */
  inviteMember(
    scope: PlatformScope,
    groupId: string,
    inviteePrincipalId: string,
  ): Promise<GroupExecution>;
  /** 移除成员：删成员 grant；下一个事务立即失效。 */
  removeMember(
    scope: PlatformScope,
    groupId: string,
    memberPrincipalId: string,
  ): Promise<GroupExecution>;
  /** 加 Bot 席位：Bot owner ∨ tenant_admin + MT017 发布事实（AC4）。 */
  addBotSeat(
    scope: PlatformScope,
    groupId: string,
    agentId: string,
  ): Promise<GroupExecution>;
  /** 撤 Bot 席位：同门；席位行 visibility → NULL。 */
  removeBotSeat(
    scope: PlatformScope,
    groupId: string,
    agentId: string,
  ): Promise<GroupExecution>;
  /** 群读取：成员门（自身 grant active）；返回成员数与在场席位。 */
  readGroup(scope: PlatformScope, groupId: string): Promise<
    | ({ readonly outcome: "allow" } & GroupView)
    | ResourceNotFoundVerdict
  >;
}

export function createGroupMembershipService(channels: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
}): GroupMembershipService {
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

  const groupLockKey = (tenantId: string, groupId: string): string =>
    JSON.stringify(["enterprise", "group", tenantId, groupId]);

  /**
   * 群事实 + 操作者授权事实（事务内一次受限读取）。null = 不可见
   * （canonical not-found）：跨公司（RLS 已隐藏）/ 跨团队 / 非成员
   * / 已撤权（epoch）/ 群行非 active。
   */
  const readGroupFacts = async (
    tx: Tx,
    scope: PlatformScope,
    groupId: string,
  ): Promise<{
    readonly title: string;
    readonly workspaceId: string;
    readonly isMember: boolean;
    readonly companyAdmin: boolean;
  } | null> => {
    const [row] = await tx
      .select({
        displayName: enterpriseResources.displayName,
        workspaceId: enterpriseResources.workspaceId,
        status: enterpriseResources.status,
        ownGrant: enterpriseResourceGrants.principalId,
        membershipStatus: enterpriseWorkspaceMemberships.status,
        companyMemberStatus: enterpriseMemberships.status,
        companyMemberEpoch: enterpriseMemberships.epoch,
        companyMemberRole: enterpriseMemberships.role,
      })
      .from(enterpriseResources)
      .leftJoin(
        enterpriseResourceGrants,
        and(
          eq(enterpriseResourceGrants.tenantId, enterpriseResources.tenantId),
          eq(enterpriseResourceGrants.resourceId, enterpriseResources.id),
          eq(enterpriseResourceGrants.action, "read"),
          eq(enterpriseResourceGrants.principalId, scope.principalId),
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
          eq(
            enterpriseWorkspaceMemberships.principalId,
            scope.principalId,
          ),
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
          eq(enterpriseResources.id, groupId),
          eq(enterpriseResources.kind, GROUP_RESOURCE_KIND),
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
      title: row.displayName,
      workspaceId: row.workspaceId,
      isMember: row.ownGrant === scope.principalId,
      companyAdmin: row.companyMemberRole === "tenant_admin",
    };
  };

  const listSeatsInside = async (
    tx: Tx,
    tenantId: string,
    groupId: string,
  ): Promise<readonly string[]> => {
    const seatRows = await tx
      .select({ id: enterpriseResources.id })
      .from(enterpriseResources)
      .where(
        and(
          eq(enterpriseResources.tenantId, tenantId),
          eq(enterpriseResources.kind, GROUP_SEAT_KIND),
          sql`${enterpriseResources.id} like ${`${groupId}:%`}`,
          eq(enterpriseResources.status, "active"),
          sql`${enterpriseResources.visibility} = 'workspace'`,
        ),
      );
    return seatRows
      .map((row) => row.id.slice(groupId.length + 1))
      .sort();
  };

  return {
    async createGroup(scope, input) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      if (!input || typeof input !== "object") {
        throw new Error("GROUP_INPUT_INVALID");
      }
      const groupId = assertGroupId(input.groupId);
      const title = assertTitle(input.title);
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: groupLockKey(scope.tenantId, groupId), exclusive: true },
        ]);
        await tx
          .insert(enterpriseResources)
          .values({
            tenantId: scope.tenantId,
            id: groupId,
            workspaceId: scope.workspaceId,
            kind: GROUP_RESOURCE_KIND,
            displayName: title,
          })
          .onConflictDoNothing();
        const [created] = await tx
          .select({ id: enterpriseResources.id })
          .from(enterpriseResources)
          .where(
            and(
              eq(enterpriseResources.tenantId, scope.tenantId),
              eq(enterpriseResources.id, groupId),
              eq(enterpriseResources.kind, GROUP_RESOURCE_KIND),
            ),
          )
          .limit(1);
        if (!created) {
          throw new Error("GROUP_ID_UNAVAILABLE");
        }
        await tx
          .insert(enterpriseResourceGrants)
          .values({
            tenantId: scope.tenantId,
            resourceId: groupId,
            principalId: scope.principalId,
            action: "read",
          })
          .onConflictDoNothing();
        return deepFreeze({ outcome: "allow", groupId });
      });
    },

    async inviteMember(scope, groupId, inviteePrincipalId) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertGroupId(groupId);
      assertPrincipalId(inviteePrincipalId);
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: groupLockKey(scope.tenantId, groupId), exclusive: true },
        ]);
        const facts = await readGroupFacts(tx, scope, groupId);
        // 群不可见（跨公司/跨团队/非 active）与群不存在同形。
        if (!facts) return notFoundVerdict();
        // 操作者必须是 active 群成员（群内自治；管理面不外包给团队级）。
        if (!facts.isMember) return notFoundVerdict();
        // 被邀者范围检查：本公司 active 成员行。不存在 / suspended /
        // 别家公司用户对外同一形状（不泄露对象存在性，AC1）。
        const [invitee] = await tx
          .select({ status: enterpriseMemberships.status })
          .from(enterpriseMemberships)
          .where(
            and(
              eq(enterpriseMemberships.tenantId, scope.tenantId),
              eq(enterpriseMemberships.principalId, inviteePrincipalId),
            ),
          )
          .limit(1);
        if (!invitee || invitee.status !== "active") {
          return notFoundVerdict();
        }
        await tx
          .insert(enterpriseResourceGrants)
          .values({
            tenantId: scope.tenantId,
            resourceId: groupId,
            principalId: inviteePrincipalId,
            action: "read",
          })
          .onConflictDoNothing();
        return deepFreeze({
          outcome: "allow",
          groupId,
          principalId: inviteePrincipalId,
        });
      });
    },

    async removeMember(scope, groupId, memberPrincipalId) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertGroupId(groupId);
      assertPrincipalId(memberPrincipalId);
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: groupLockKey(scope.tenantId, groupId), exclusive: true },
        ]);
        const facts = await readGroupFacts(tx, scope, groupId);
        if (!facts) return notFoundVerdict();
        if (!facts.isMember) return notFoundVerdict();
        // grants 的 operator DELETE 行策略：resource_id + operator_principal_id
        // 匹配行（MT019 delete 同款逐行配置）。
        await tx.execute(
          sql`select set_config('app.resource_id', ${groupId}, true)`,
        );
        await tx.execute(
          sql`select set_config('app.operator_principal_id', ${memberPrincipalId}, true)`,
        );
        await tx
          .delete(enterpriseResourceGrants)
          .where(
            and(
              eq(enterpriseResourceGrants.tenantId, scope.tenantId),
              eq(enterpriseResourceGrants.resourceId, groupId),
              eq(enterpriseResourceGrants.principalId, memberPrincipalId),
              eq(enterpriseResourceGrants.action, "read"),
            ),
          );
        return deepFreeze({
          outcome: "allow",
          groupId,
          principalId: memberPrincipalId,
        });
      });
    },

    async addBotSeat(scope, groupId, agentId) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertGroupId(groupId);
      assertGroupId(agentId);
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: groupLockKey(scope.tenantId, groupId), exclusive: true },
        ]);
        const facts = await readGroupFacts(tx, scope, groupId);
        if (!facts) return notFoundVerdict();
        if (!facts.isMember) return notFoundVerdict();
        // 席位管理门与 Bot 发布一致（MT017）：Bot owner ∨ tenant_admin。
        const [bot] = await tx
          .select({
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
        if (!bot || bot.status !== "active") return notFoundVerdict();
        const seatManager =
          bot.ownerPrincipalId === scope.principalId || facts.companyAdmin;
        if (!seatManager) {
          return { outcome: "deny", code: "GROUP_SEAT_FORBIDDEN" } as const;
        }
        // 发布事实（MT017 注册行）：同租户同团队 kind='bot' 且团队公共。
        const [publication] = await tx
          .select({ id: enterpriseResources.id })
          .from(enterpriseResources)
          .where(
            and(
              eq(enterpriseResources.tenantId, scope.tenantId),
              eq(enterpriseResources.id, agentId),
              eq(enterpriseResources.kind, "bot"),
              eq(enterpriseResources.workspaceId, facts.workspaceId),
              sql`${enterpriseResources.visibility} = 'workspace'`,
            ),
          )
          .limit(1);
        if (!publication) return notFoundVerdict();
        const seatId = `${groupId}:${agentId}`;
        // onConflictDoUpdate 的 UPDATE 行策略要求 app.resource_id 匹配行
        // （MT008：app.tenant_id + app.resource_id）。
        await tx.execute(
          sql`select set_config('app.resource_id', ${seatId}, true)`,
        );
        await tx
          .insert(enterpriseResources)
          .values({
            tenantId: scope.tenantId,
            id: seatId,
            workspaceId: facts.workspaceId,
            kind: GROUP_SEAT_KIND,
            displayName: `seat:${agentId}`,
            visibility: "workspace",
          })
          .onConflictDoUpdate({
            target: [
              enterpriseResources.tenantId,
              enterpriseResources.id,
            ],
            set: { visibility: "workspace" },
          });
        return deepFreeze({
          outcome: "allow",
          groupId,
          agentId,
          seatId,
        });
      });
    },

    async removeBotSeat(scope, groupId, agentId) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertGroupId(groupId);
      assertGroupId(agentId);
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: groupLockKey(scope.tenantId, groupId), exclusive: true },
        ]);
        const facts = await readGroupFacts(tx, scope, groupId);
        if (!facts) return notFoundVerdict();
        if (!facts.isMember) return notFoundVerdict();
        const [bot] = await tx
          .select({
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
        if (!bot) return notFoundVerdict();
        const seatManager =
          bot.ownerPrincipalId === scope.principalId || facts.companyAdmin;
        if (!seatManager) {
          return { outcome: "deny", code: "GROUP_SEAT_FORBIDDEN" } as const;
        }
        const seatId = `${groupId}:${agentId}`;
        // operator UPDATE 行策略要求 app.resource_id 匹配行（MT008）。
        await tx.execute(
          sql`select set_config('app.resource_id', ${seatId}, true)`,
        );
        const updated = await tx
          .update(enterpriseResources)
          .set({ visibility: null })
          .where(
            and(
              eq(enterpriseResources.tenantId, scope.tenantId),
              eq(enterpriseResources.id, seatId),
              eq(enterpriseResources.kind, GROUP_SEAT_KIND),
              sql`${enterpriseResources.visibility} = 'workspace'`,
            ),
          )
          .returning({ id: enterpriseResources.id });
        if (updated.length === 0) return notFoundVerdict();
        return deepFreeze({ outcome: "allow", groupId, agentId, seatId });
      });
    },

    async readGroup(scope, groupId) {
      assertScopeContext(scope);
      assertTrustedScope(scope);
      assertGroupId(groupId);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: groupLockKey(scope.tenantId, groupId), exclusive: false },
        ]);
        const facts = await readGroupFacts(tx, scope, groupId);
        if (!facts || !facts.isMember) return notFoundVerdict();
        // 成员计数与席位清点走 operator 通道：data 通道的 grants
        // self_read restrictive 策略只放行本人行（MT008 设计——grants 是
        // 个人事实），而成员面/席位面是群级事实，operator 读策略无此限制。
        const memberCount = await operator.transaction(async (operatorTx) => {
          await beginContext(operatorTx, scope);
          const memberRows = await operatorTx
            .select({ principalId: enterpriseResourceGrants.principalId })
            .from(enterpriseResourceGrants)
            .where(
              and(
                eq(enterpriseResourceGrants.tenantId, scope.tenantId),
                eq(enterpriseResourceGrants.resourceId, groupId),
                eq(enterpriseResourceGrants.action, "read"),
              ),
            );
          return memberRows.length;
        });
        const seats = await operator.transaction(async (operatorTx) => {
          await beginContext(operatorTx, scope);
          return listSeatsInside(operatorTx, scope.tenantId, groupId);
        });
        return deepFreeze({
          outcome: "allow",
          groupId,
          title: facts.title,
          workspaceId: facts.workspaceId,
          memberCount,
          seats,
        });
      });
    },
  };
}
