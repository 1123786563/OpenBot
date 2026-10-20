// server/src/enterprise/tenancy/host-access.ts
// MT035（Issue #78）：Host Access、签入帮助与危险动作审批的归属与既有
// 行为保持。
//
// 票面语义：host access 与签入帮助只对本范围授权主体开放，跨范围请求被
// 拒绝；危险动作（write_file / run_command）仍按既有规则要求审批，且审批
// 归属与执行归属一致；执行过程中撤权让后续敏感动作失败而不是继续。
//
// 结构（纯新增，只读消费 MT016/MT006/MT011 既有出口，不改任何既有文件）：
//
//   1. 动作面七个方法，逐项独立授权（不存在“可读即放行”的旁路）：
//      list-grants / grant-host-access / revoke-host-access 是授权生命周期；
//      check-in-help 是签入帮助凭据取用——只有授权主体本人（grant 行的
//      principal）可取，返回服务端派生的凭据引用，绝不含明文凭据；
//      request-dangerous-action / decide-dangerous-action / execute-dangerous-action
//      是危险动作审批三段。危险词表 = write_file / run_command 闭集
//      （host-access schema 既有 HostAccessOperationKind 的危险子集）。
//   2. 可见性门与 MT016/MT019 同一读法（行经 RLS 租户过滤 → grant 行
//      workspace === scope.workspaceId + 团队成员 active + 公司成员
//      active/epoch 匹配）→ MT011 canonical
//      { outcome: "deny", code: "RESOURCE_NOT_FOUND" }：不存在/跨公司/
//      跨团队/已撤权对外不可区分。
//   3. 审批归属与执行归属一致（AC2）：审批行锁定
//      (tenant, workspace, principal, agent, operation_kind, params_digest)
//      ——摘要由服务端对提议参数规范序列化 sha256（MT034 同款纪律，客户
//      端声称的摘要/归属键一律响亮拒绝）。execute 在同一事务内现读
//      approved 行并把执行 scope 的四元组与摘要逐字比对；跨范围审批行
//      经 RLS + 读取谓词结构性不可达，不存在跨团队/跨公司复用通道。
//   4. 撤权即失效（AC4）：每个动作的事务内重验公司成员资格
//      （active + epoch === scope.memberEpoch，MT006 suspendMembership
//      递增 epoch 使已签发 scope 立即失效）——执行中途撤权后，后续
//      check-in-help 与危险动作一律 canonical not-found，不再继续。
//
// 事务纪律与 MT019/MT034 完全一致：受信 Scope（assertTrustedScope）→
// read committed + lock/statement timeout → set_config('app.*', …, true)
// 事务本地 → advisory 锁。锁序：tenant → principal → membership →
// workspace-membership → host-grant → host-approval。读路径走受限 data
// 角色，写路径走受限 operator 角色；事实读取全部经真实 RLS。
//
// 边界（诚实披露）：
//   - 本模块是归属判定面，不接 HTTP 路由（挂路由属下游接线票）；
//     host-access 既有 broker/approvals 交互（提问、恢复、原生确认）
//     行为不变，AC3 以既有 approvals 回归套件证明。
//   - check-in-help 返回的凭据引用是派生串；真实凭据交换（lease 签发）
//     复用 MT029 credential-lease 域，不在本票复制第二份。

import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { enterpriseBotOwnership } from "../../db/schema/enterprise-bot-ownership";
import {
  enterpriseHostAccessGrants,
  enterpriseHostActionApprovals,
} from "../../db/schema/enterprise-host-access";
import {
  enterpriseMemberships,
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

/** 危险动作词表（host-access 既有操作词表的危险子集，闭集）。 */
export const HOST_DANGEROUS_OPERATIONS = ["write_file", "run_command"] as const;

export type HostDangerousOperation = (typeof HOST_DANGEROUS_OPERATIONS)[number];

/** 已过可见性门后的主体拒绝（不泄露额外信息：能到这一步已说明可见）。 */
export interface HostAccessForbidden {
  readonly outcome: "deny";
  readonly code: "HOST_ACCESS_FORBIDDEN";
}

/** 危险动作缺少归属匹配的已批准审批行（响亮拒绝，不静默放行）。 */
export interface HostActionApprovalRequired {
  readonly outcome: "deny";
  readonly code: "HOST_ACTION_APPROVAL_REQUIRED";
}

export type HostAccessVerdict =
  | ({ readonly outcome: "allow" } & Record<string, unknown>)
  | ResourceNotFoundVerdict
  | HostAccessForbidden
  | HostActionApprovalRequired;

export type HostActionDecision = "approve" | "decline";

/** 危险动作参数（键序规范化后参与摘要；归属键不可表达）。 */
export interface HostDangerousParams {
  readonly relativePath?: string;
  readonly content?: string;
  readonly command?: string;
  readonly writable?: boolean;
}

const ATTRIBUTION_KEYS: readonly string[] = [
  "tenantId",
  "workspaceId",
  "principalId",
  "agentId",
  "grantId",
  "paramsDigest",
  "tenant_id",
  "workspace_id",
  "principal_id",
  "agent_id",
  "grant_id",
  "params_digest",
];

export interface HostGrantView {
  readonly grantId: string;
  readonly agentId: string;
  readonly displayName: string;
  readonly status: string;
}

export interface HostAccessService {
  /** 本人授权行（可见性门后仅本人行；跨范围行不可见）。 */
  listGrants(scope: PlatformScope): Promise<readonly HostGrantView[]>;
  /** 发起 host access 授权：归属 = 受信 scope（Bot 归属行必须本范围可见）。 */
  requestHostAccess(
    scope: PlatformScope,
    input: { readonly agentId: string; readonly displayName: string },
  ): Promise<HostAccessVerdict>;
  /** 撤销本人授权行（幂等语义：已撤销行不再可见 = canonical not-found）。 */
  revokeHostAccess(
    scope: PlatformScope,
    input: { readonly grantId: string },
  ): Promise<HostAccessVerdict>;
  /**
   * 签入帮助凭据取用：仅授权主体本人。返回服务端派生的凭据引用
   * （不含明文凭据）；同团队他人 → HOST_ACCESS_FORBIDDEN。
   */
  checkInHelp(
    scope: PlatformScope,
    input: { readonly grantId: string },
  ): Promise<HostAccessVerdict>;
  /** 发起危险动作审批：摘要由服务端计算，归属锁定为执行 scope。 */
  requestDangerousAction(
    scope: PlatformScope,
    input: {
      readonly grantId: string;
      readonly operation: HostDangerousOperation;
      readonly params: HostDangerousParams;
    },
  ): Promise<HostAccessVerdict>;
  /** 决定本人待处理审批（审批人 = 授权主体；归属与执行一致）。 */
  decideDangerousAction(
    scope: PlatformScope,
    input: {
      readonly approvalId: string;
      readonly decision: HostActionDecision;
    },
  ): Promise<HostAccessVerdict>;
  /**
   * 危险动作执行检查点（AC2/AC4）：现读 approved 审批行并逐字比对
   * 执行 scope 四元组与摘要；撤权后（epoch 失配）一律 canonical
   * not-found。
   */
  executeDangerousAction(
    scope: PlatformScope,
    input: {
      readonly approvalId: string;
      readonly params: HostDangerousParams;
    },
  ): Promise<HostAccessVerdict>;
}

// ---------------------------------------------------------------------------
// 输入校验：拒绝只含代码与字段路径，绝不回显任何值
// ---------------------------------------------------------------------------

function assertPlainId(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 256
  ) {
    throw new Error(`HOST_ACCESS_INPUT_INVALID:${field}`);
  }
  return value;
}

function assertNoClientAttribution(params: HostDangerousParams): void {
  for (const key of Object.keys(params)) {
    if (ATTRIBUTION_KEYS.includes(key)) {
      throw new Error("ATTRIBUTION_NOT_CLIENT_DECLARABLE");
    }
  }
}

/** 提议参数的服务端规范摘要（键序固定；客户端永远只交原始参数）。 */
export function hostDangerousParamsDigest(params: HostDangerousParams): string {
  const canonical = JSON.stringify({
    command: typeof params.command === "string" ? params.command : null,
    content: typeof params.content === "string" ? params.content : null,
    relativePath:
      typeof params.relativePath === "string" ? params.relativePath : null,
    writable: params.writable === true,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

const FORBIDDEN: HostAccessForbidden = Object.freeze({
  outcome: "deny",
  code: "HOST_ACCESS_FORBIDDEN",
});

const APPROVAL_REQUIRED: HostActionApprovalRequired = Object.freeze({
  outcome: "deny",
  code: "HOST_ACTION_APPROVAL_REQUIRED",
});

/**
 * 装配入口。读路径走已验证 data 通道，写路径走已验证 operator 通道；
 * 未验证业务通道在装配时拒绝。
 */
export function createHostAccessService(channels: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
}): HostAccessService {
  assertDataDatabase(channels.data);
  assertOperatorDatabase(channels.operator);
  const { data, operator } = channels;

  type Tx =
    | Parameters<Parameters<DataDatabase["transaction"]>[0]>[0]
    | Parameters<Parameters<OperatorDatabase["transaction"]>[0]>[0];

  const beginContext = async (tx: Tx, scope: PlatformScope): Promise<void> => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
    );
  };

  /** 锁序：tenant → principal → membership → workspace-membership → host 域。 */
  const baseLockKeys = (scope: PlatformScope): readonly string[] => [
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

  const grantLockKey = (tenantId: string, grantId: string): string =>
    JSON.stringify(["enterprise", "host-grant", tenantId, grantId]);

  const approvalLockKey = (tenantId: string, approvalId: string): string =>
    JSON.stringify(["enterprise", "host-approval", tenantId, approvalId]);

  /**
   * 可见性 + 授权事实（事务内一次受限读取；MT016 readVisibleOwnership 的
   * 本模块切片）。返回 null = 不可见（canonical not-found）。
   */
  const readGrantFacts = async (
    tx: Tx,
    scope: PlatformScope,
    grantId: string,
  ): Promise<{
    readonly agentId: string;
    readonly principalId: string;
    readonly displayName: string;
    readonly status: string;
  } | null> => {
    const [row] = await tx
      .select({
        agentId: enterpriseHostAccessGrants.agentId,
        principalId: enterpriseHostAccessGrants.principalId,
        displayName: enterpriseHostAccessGrants.displayName,
        status: enterpriseHostAccessGrants.status,
        workspaceId: enterpriseHostAccessGrants.workspaceId,
        membershipStatus: enterpriseWorkspaceMemberships.status,
        companyMemberStatus: enterpriseMemberships.status,
        companyMemberEpoch: enterpriseMemberships.epoch,
      })
      .from(enterpriseHostAccessGrants)
      .leftJoin(
        enterpriseWorkspaceMemberships,
        and(
          eq(
            enterpriseWorkspaceMemberships.tenantId,
            enterpriseHostAccessGrants.tenantId,
          ),
          eq(
            enterpriseWorkspaceMemberships.workspaceId,
            enterpriseHostAccessGrants.workspaceId,
          ),
          eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
        ),
      )
      .leftJoin(
        enterpriseMemberships,
        and(
          eq(
            enterpriseMemberships.tenantId,
            enterpriseHostAccessGrants.tenantId,
          ),
          eq(enterpriseMemberships.principalId, scope.principalId),
        ),
      )
      .where(
        and(
          eq(enterpriseHostAccessGrants.tenantId, scope.tenantId),
          eq(enterpriseHostAccessGrants.id, grantId),
        ),
      )
      .limit(1);
    if (!row) return null;
    if (
      row.workspaceId !== scope.workspaceId ||
      row.membershipStatus !== "active" ||
      row.companyMemberStatus !== "active" ||
      row.companyMemberEpoch !== scope.memberEpoch
    ) {
      return null;
    }
    return {
      agentId: row.agentId,
      principalId: row.principalId,
      displayName: row.displayName,
      status: row.status,
    };
  };

  /** Bot 归属行在本范围可见（grant/审批申请的先决事实）。 */
  const botVisibleInScope = async (
    tx: Tx,
    scope: PlatformScope,
    agentId: string,
  ): Promise<boolean> => {
    const [row] = await tx
      .select({ workspaceId: enterpriseBotOwnership.workspaceId })
      .from(enterpriseBotOwnership)
      .where(
        and(
          eq(enterpriseBotOwnership.tenantId, scope.tenantId),
          eq(enterpriseBotOwnership.agentId, agentId),
        ),
      )
      .limit(1);
    return row?.workspaceId === scope.workspaceId;
  };

  const assertScopeShape = (scope: PlatformScope): void => {
    assertTrustedScope(scope);
    if (!scope.tenantId?.trim()) throw new Error("TENANT_REQUIRED");
    if (!scope.workspaceId?.trim()) throw new Error("WORKSPACE_REQUIRED");
  };

  return {
    async listGrants(scope) {
      assertScopeShape(scope);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(
          tx,
          baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
        );
        const [membership] = await tx
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
        if (membership?.status !== "active") return [];
        const rows = await tx
          .select({
            id: enterpriseHostAccessGrants.id,
            agentId: enterpriseHostAccessGrants.agentId,
            displayName: enterpriseHostAccessGrants.displayName,
            status: enterpriseHostAccessGrants.status,
          })
          .from(enterpriseHostAccessGrants)
          .where(
            and(
              eq(enterpriseHostAccessGrants.tenantId, scope.tenantId),
              eq(enterpriseHostAccessGrants.principalId, scope.principalId),
              eq(enterpriseHostAccessGrants.workspaceId, scope.workspaceId),
            ),
          );
        return deepFreeze(
          rows.map((row) => ({
            grantId: row.id,
            agentId: row.agentId,
            displayName: row.displayName,
            status: row.status,
          })),
        );
      });
    },

    async requestHostAccess(scope, input) {
      assertScopeShape(scope);
      const agentId = assertPlainId(input?.agentId, "agentId");
      const displayName =
        typeof input?.displayName === "string" && input.displayName.trim()
          ? input.displayName
          : "Host";
      const grantId = `mt035-grant-${randomUUID()}`;
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(
          tx,
          baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
        );
        if (!(await botVisibleInScope(tx, scope, agentId))) {
          return notFoundVerdict();
        }
        await tx.insert(enterpriseHostAccessGrants).values({
          tenantId: scope.tenantId,
          id: grantId,
          workspaceId: scope.workspaceId,
          agentId,
          principalId: scope.principalId,
          displayName,
        });
        return deepFreeze({ outcome: "allow", grantId });
      });
    },

    async revokeHostAccess(scope, input) {
      assertScopeShape(scope);
      const grantId = assertPlainId(input?.grantId, "grantId");
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: grantLockKey(scope.tenantId, grantId), exclusive: true },
        ]);
        const facts = await readGrantFacts(tx, scope, grantId);
        if (!facts) return notFoundVerdict();
        if (facts.principalId !== scope.principalId) return FORBIDDEN;
        if (facts.status !== "active") {
          return deepFreeze({ outcome: "allow", grantId, already: "revoked" });
        }
        await tx
          .update(enterpriseHostAccessGrants)
          .set({ status: "revoked", revokedAt: new Date() })
          .where(
            and(
              eq(enterpriseHostAccessGrants.tenantId, scope.tenantId),
              eq(enterpriseHostAccessGrants.id, grantId),
            ),
          );
        return deepFreeze({ outcome: "allow", grantId });
      });
    },

    async checkInHelp(scope, input) {
      assertScopeShape(scope);
      const grantId = assertPlainId(input?.grantId, "grantId");
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(
          tx,
          baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
        );
        const facts = await readGrantFacts(tx, scope, grantId);
        if (!facts) return notFoundVerdict();
        if (facts.status !== "active") return notFoundVerdict();
        if (facts.principalId !== scope.principalId) return FORBIDDEN;
        // 派生引用而非明文：真实凭据交换归 MT029 lease 域。
        const reference = `host-signin-${createHash("sha256")
          .update(`${grantId}:${scope.principalId}:${scope.memberEpoch}`)
          .digest("hex")
          .slice(0, 24)}`;
        return deepFreeze({
          outcome: "allow",
          grantId,
          credentialReference: reference,
        });
      });
    },

    async requestDangerousAction(scope, input) {
      assertScopeShape(scope);
      const grantId = assertPlainId(input?.grantId, "grantId");
      if (
        !input ||
        !(HOST_DANGEROUS_OPERATIONS as readonly string[]).includes(
          input.operation,
        )
      ) {
        throw new Error("HOST_ACCESS_OPERATION_INVALID");
      }
      const params = input.params ?? {};
      assertNoClientAttribution(params);
      const digest = hostDangerousParamsDigest(params);
      const approvalId = `mt035-approval-${randomUUID()}`;
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: grantLockKey(scope.tenantId, grantId), exclusive: false },
        ]);
        const facts = await readGrantFacts(tx, scope, grantId);
        if (!facts) return notFoundVerdict();
        if (facts.status !== "active") return notFoundVerdict();
        if (facts.principalId !== scope.principalId) return FORBIDDEN;
        await tx.insert(enterpriseHostActionApprovals).values({
          tenantId: scope.tenantId,
          id: approvalId,
          workspaceId: scope.workspaceId,
          agentId: facts.agentId,
          principalId: scope.principalId,
          grantId,
          operationKind: input.operation,
          paramsDigest: digest,
        });
        return deepFreeze({ outcome: "allow", approvalId });
      });
    },

    async decideDangerousAction(scope, input) {
      assertScopeShape(scope);
      const approvalId = assertPlainId(input?.approvalId, "approvalId");
      if (input?.decision !== "approve" && input?.decision !== "decline") {
        throw new Error("HOST_ACCESS_INPUT_INVALID:decision");
      }
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          { key: approvalLockKey(scope.tenantId, approvalId), exclusive: true },
        ]);
        const [row] = await tx
          .select({
            principalId: enterpriseHostActionApprovals.principalId,
            workspaceId: enterpriseHostActionApprovals.workspaceId,
            status: enterpriseHostActionApprovals.status,
          })
          .from(enterpriseHostActionApprovals)
          .where(
            and(
              eq(enterpriseHostActionApprovals.tenantId, scope.tenantId),
              eq(enterpriseHostActionApprovals.id, approvalId),
            ),
          )
          .limit(1);
        if (
          !row ||
          row.workspaceId !== scope.workspaceId ||
          row.status === "withdrawn"
        ) {
          return notFoundVerdict();
        }
        // 审批归属与执行归属一致：只有审批行的归属主体能决定自己的审批。
        if (row.principalId !== scope.principalId) return FORBIDDEN;
        if (row.status !== "pending") {
          return deepFreeze({
            outcome: "allow",
            approvalId,
            already: row.status,
          });
        }
        await tx
          .update(enterpriseHostActionApprovals)
          .set({
            status: input.decision === "approve" ? "approved" : "declined",
            decidedBy: scope.principalId,
            decidedAt: new Date(),
          })
          .where(
            and(
              eq(enterpriseHostActionApprovals.tenantId, scope.tenantId),
              eq(enterpriseHostActionApprovals.id, approvalId),
            ),
          );
        return deepFreeze({ outcome: "allow", approvalId });
      });
    },

    async executeDangerousAction(scope, input) {
      assertScopeShape(scope);
      const approvalId = assertPlainId(input?.approvalId, "approvalId");
      const params = input?.params ?? {};
      assertNoClientAttribution(params);
      const digest = hostDangerousParamsDigest(params);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          {
            key: approvalLockKey(scope.tenantId, approvalId),
            exclusive: false,
          },
        ]);
        const [row] = await tx
          .select({
            approvalId: enterpriseHostActionApprovals.id,
            workspaceId: enterpriseHostActionApprovals.workspaceId,
            principalId: enterpriseHostActionApprovals.principalId,
            agentId: enterpriseHostActionApprovals.agentId,
            grantId: enterpriseHostActionApprovals.grantId,
            operationKind: enterpriseHostActionApprovals.operationKind,
            status: enterpriseHostActionApprovals.status,
            paramsDigest: enterpriseHostActionApprovals.paramsDigest,
            grantStatus: enterpriseHostAccessGrants.status,
            membershipStatus: enterpriseWorkspaceMemberships.status,
            companyMemberStatus: enterpriseMemberships.status,
            companyMemberEpoch: enterpriseMemberships.epoch,
          })
          .from(enterpriseHostActionApprovals)
          .innerJoin(
            enterpriseHostAccessGrants,
            and(
              eq(
                enterpriseHostAccessGrants.tenantId,
                enterpriseHostActionApprovals.tenantId,
              ),
              eq(
                enterpriseHostAccessGrants.id,
                enterpriseHostActionApprovals.grantId,
              ),
            ),
          )
          .leftJoin(
            enterpriseWorkspaceMemberships,
            and(
              eq(
                enterpriseWorkspaceMemberships.tenantId,
                enterpriseHostActionApprovals.tenantId,
              ),
              eq(
                enterpriseWorkspaceMemberships.workspaceId,
                enterpriseHostActionApprovals.workspaceId,
              ),
              eq(
                enterpriseWorkspaceMemberships.principalId,
                enterpriseHostActionApprovals.principalId,
              ),
            ),
          )
          .leftJoin(
            enterpriseMemberships,
            and(
              eq(
                enterpriseMemberships.tenantId,
                enterpriseHostActionApprovals.tenantId,
              ),
              eq(
                enterpriseMemberships.principalId,
                enterpriseHostActionApprovals.principalId,
              ),
            ),
          )
          .where(
            and(
              eq(enterpriseHostActionApprovals.tenantId, scope.tenantId),
              eq(enterpriseHostActionApprovals.id, approvalId),
            ),
          )
          .limit(1);
        // 没有任何可见的匹配审批行 = 危险动作缺少审批（响亮拒绝，不静默
        // 放行，也不泄露任何行的存在性）；行可见但不在执行范围 = 不可见
        // 语义（canonical not-found）。
        if (!row) return APPROVAL_REQUIRED;
        if (
          row.workspaceId !== scope.workspaceId ||
          row.membershipStatus !== "active" ||
          row.companyMemberStatus !== "active" ||
          row.companyMemberEpoch !== scope.memberEpoch
        ) {
          return notFoundVerdict();
        }
        if (row.principalId !== scope.principalId) return FORBIDDEN;
        if (row.grantStatus !== "active") return notFoundVerdict();
        if (row.status !== "approved" || row.paramsDigest !== digest) {
          return APPROVAL_REQUIRED;
        }
        return deepFreeze({
          outcome: "allow",
          approvalId,
          agentId: row.agentId,
          grantId: row.grantId,
          operation: row.operationKind,
        });
      });
    },
  };
}
