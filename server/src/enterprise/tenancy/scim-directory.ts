// server/src/enterprise/tenancy/scim-directory.ts
// MT026（Issue #69）：公司范围的 SCIM 目录反应——每家公司的目录连接只
// 反应到本公司；离职只撤销该公司的成员资格与资源权限，不删除其他公司
// 资格或全局身份（票面验收 1）；SCIM 请求不能创建或修改其他公司的成员
// 关系（票面验收 3）。
//
// 归属纪律：目录连接以 connection_key 标识（插件以 bearer token 认证后
// 得到的服务端已验证事实）。公司归属**只能**来自按 key 查出的持久绑定行
// （RLS 连接键臂 pin app.scim_connection_key），绝不来自请求载荷。本模块
// 的公开签名没有租户参数；输入对象携带 tenantId 一律响亮拒绝
// （TENANT_ATTRIBUTION_NOT_ACCEPTABLE）。
//
// 三件事：
//   1. resolveBinding：连接 → { 公司, 状态 }。未知连接
//      SCIM_CONNECTION_NOT_BOUND；已停用绑定 SCIM_CONNECTION_DEACTIVATED——
//      两种情况都零成员变更（停用的目录不再反应）。
//   2. deprovisionMember / reprovisionMember：停用 = 成员行 suspended +
//      epoch+1 + 该公司资源授权行逐行删除（撤权=删行范式，MT007）+ 绑定行
//      记录 last_deprovision 事实 + 审计事件（本模块封闭事件集合，写同一张
//      enterprise_security_events，同一 RLS INSERT 策略——不改 revocation.ts，
//      MT075 先例）。恢复 = 仅当成员行当前 epoch === 绑定行所记停用 epoch
//      且 principal 匹配（服务端持久事实，票面验收 4 同一纪律）——期间任何
//      一方动过成员行（管理员恢复/再停用）即拒绝
//      （SCIM_REPROVISION_NOT_ALLOWED，管理员决定优先，scim.ts 全局语义的
//      公司版）。结构性不触碰：users 行、sessions、revoked_access（全局
//      登录）、其他公司的成员行/授权行。
//   3. provisionMember：供应成员关系只写入绑定公司（INSERT 策略 pin
//      app.tenant_id = 绑定公司）；已存在成员关系零写入幂等；目录永不授予
//      管理角色（role 只允许 'member'）。供应不创建全局身份：principal
//      必须已存在（全新用户的 principal 仍由部署级身份流创建——本票只管
//      公司范围的成员关系反应）。

import { and, eq, sql } from "drizzle-orm";
import { enterpriseScimDirectoryBindings } from "../../db/schema/enterprise-sso-scim";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseResourceGrants,
  enterpriseSecurityEvents,
} from "../../db/schema/enterprise-tenancy";
import {
  assertDirectoryDatabase,
  assertOperatorDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
} from "./connections";

// ---------------------------------------------------------------------------
// 审计：本模块封闭事件集合（撤权审计类型在 revocation.ts，跨面审计在
// admin-separation.ts——同一张表、同一条 RLS INSERT 策略，各自封闭集合）
// ---------------------------------------------------------------------------

export const SCIM_DIRECTORY_AUDIT_EVENT_TYPES: readonly string[] = [
  "company_member.scim_provisioned",
  "company_member.scim_deprovisioned",
  "company_member.scim_reprovisioned",
] as const;

type ScimDirectoryAuditEventType =
  (typeof SCIM_DIRECTORY_AUDIT_EVENT_TYPES)[number];

const AUDIT_EVENT_TYPE_IDS: ReadonlySet<string> = new Set(
  SCIM_DIRECTORY_AUDIT_EVENT_TYPES,
);

type OperatorTransaction = Parameters<
  Parameters<OperatorDatabase["transaction"]>[0]
>[0];

/**
 * Writes one directory-reaction audit event inside the caller's transaction.
 * The caller has pinned app.tenant_id (the bound company); this pins
 * app.operation_id (the event id IS the operation id), so the INSERT is
 * RLS-checked against the administered company, like every other writer of
 * enterprise_security_events.
 */
async function recordScimDirectoryAuditEvent(
  tx: OperatorTransaction,
  input: {
    readonly eventType: ScimDirectoryAuditEventType;
    readonly tenantId: string;
    readonly connectionKey: string;
    readonly targetPrincipalId: string;
    readonly targetUserId: string;
    readonly epoch: number;
  },
): Promise<string> {
  if (
    !AUDIT_EVENT_TYPE_IDS.has(input.eventType) ||
    !String(input.tenantId ?? "").trim() ||
    !String(input.connectionKey ?? "").trim() ||
    !String(input.targetPrincipalId ?? "").trim() ||
    !String(input.targetUserId ?? "").trim() ||
    !Number.isSafeInteger(input.epoch) ||
    input.epoch <= 0
  ) {
    throw new Error("SCIM_DIRECTORY_AUDIT_EVENT_INVALID");
  }
  const eventId = crypto.randomUUID();
  await tx.execute(
    sql`select set_config('app.operation_id', ${eventId}, true)`,
  );
  await tx.insert(enterpriseSecurityEvents).values({
    tenantId: input.tenantId,
    id: eventId,
    operationId: eventId,
    actorId: `scim:directory:${input.connectionKey}`,
    eventType: input.eventType,
    details: {
      connection_key: input.connectionKey,
      target_principal_id: input.targetPrincipalId,
      target_user_id: input.targetUserId,
      epoch: input.epoch,
    },
  });
  return eventId;
}

// ---------------------------------------------------------------------------
// 目录反应服务
// ---------------------------------------------------------------------------

export interface DirectoryBindingFact {
  readonly tenantId: string;
  readonly status: "active" | "deactivated";
}

export type DeprovisionReport =
  | {
      readonly outcome: "deprovisioned";
      readonly tenantId: string;
      readonly principalId: string;
      readonly membership: Readonly<{ status: "suspended"; epoch: number }>;
      readonly grantsDeleted: number;
      readonly auditEventId: string;
    }
  | {
      readonly outcome: "already_suspended";
      readonly tenantId: string;
      readonly principalId: string;
      readonly grantsDeleted: 0;
    };

export type ReprovisionReport = {
  readonly outcome: "reprovisioned";
  readonly tenantId: string;
  readonly principalId: string;
  readonly membership: Readonly<{ status: "active"; epoch: number }>;
  readonly auditEventId: string;
};

export type ProvisionReport =
  | {
      readonly outcome: "provisioned";
      readonly tenantId: string;
      readonly principalId: string;
      readonly membership: Readonly<{ role: "member"; epoch: number }>;
      readonly auditEventId: string;
    }
  | {
      readonly outcome: "already_member";
      readonly tenantId: string;
      readonly principalId: string;
    };

export interface CompanyScopedDirectoryReconcilerOptions {
  /** Reaction transactions (member/grant writes, binding facts, audit). */
  readonly operator: OperatorDatabase;
  /**
   * Global-identity lookup seam: the directory role's self-read policy opens
   * exactly one principal per app.user_id pin, which is how the server-side
   * (plugin-authenticated) userId resolves to a principal under real RLS.
   */
  readonly directory: DirectoryDatabase;
}

export interface CompanyScopedDirectoryReconciler {
  resolveBinding(connectionKey: string): Promise<DirectoryBindingFact>;
  deprovisionMember(
    connectionKey: string,
    input: { readonly userId: string },
  ): Promise<DeprovisionReport>;
  reprovisionMember(
    connectionKey: string,
    input: { readonly userId: string },
  ): Promise<ReprovisionReport>;
  /**
   * The directory's statement "this person belongs to the company". The
   * input must NOT carry a company attribution — the bound company is the
   * only company this can ever touch.
   */
  provisionMember(
    connectionKey: string,
    input: { readonly userId: string; readonly role?: "member" },
  ): Promise<ProvisionReport>;
}

function membershipLockKey(tenantId: string, principalId: string): string {
  return JSON.stringify(["enterprise", "membership", tenantId, principalId]);
}

async function beginTransaction(tx: OperatorTransaction): Promise<void> {
  await tx.execute(sql`set transaction isolation level read committed`);
  await tx.execute(sql`set local lock_timeout = '2s'`);
  await tx.execute(sql`set local statement_timeout = '5s'`);
}

export function createCompanyScopedDirectoryReconciler(
  options: CompanyScopedDirectoryReconcilerOptions,
): CompanyScopedDirectoryReconciler {
  assertOperatorDatabase(options.operator);
  assertDirectoryDatabase(options.directory);
  const operator = options.operator;

  /**
   * Global principal behind a server-supplied userId, read through the
   * directory role's self-read policy (pin app.user_id). The userId comes
   * from the authenticated directory plugin hook — a server-side fact, never
   * from an unverified callback payload. Missing or suspended principal →
   * null (the caller turns that into its own refusal code).
   */
  const principalOf = async (userId: string) => {
    if (typeof userId !== "string" || !userId.trim()) return null;
    return options.directory.transaction(async (tx) => {
      await tx.execute(sql`set transaction isolation level read committed`);
      await tx.execute(sql`set local lock_timeout = '2s'`);
      await tx.execute(sql`set local statement_timeout = '5s'`);
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
      const [principal] = await tx
        .select({
          id: enterprisePrincipals.id,
          status: enterprisePrincipals.status,
        })
        .from(enterprisePrincipals)
        .where(eq(enterprisePrincipals.userId, userId))
        .limit(1);
      return principal && principal.status === "active" ? principal : null;
    });
  };

  /**
   * One transaction that resolves the binding by the server-verified
   * connection key and hands the bound tenant to the reaction logic. The
   * tenant pin happens only after the row is in hand, so the reaction runs
   * against exactly the bound company.
   */
  const withBoundTenant = async <T>(
    connectionKey: string,
    run: (
      tx: OperatorTransaction,
      binding: DirectoryBindingFact & {
        id: string;
        lastDeprovisionPrincipalId: string | null;
        lastDeprovisionEpoch: number | null;
      },
    ) => Promise<T>,
  ): Promise<T> =>
    operator.transaction(async (tx) => {
      await beginTransaction(tx);
      await tx.execute(
        sql`select set_config('app.scim_connection_key', ${connectionKey}, true)`,
      );
      const [binding] = await tx
        .select({
          id: enterpriseScimDirectoryBindings.id,
          tenantId: enterpriseScimDirectoryBindings.tenantId,
          status: enterpriseScimDirectoryBindings.status,
          lastDeprovisionPrincipalId:
            enterpriseScimDirectoryBindings.lastDeprovisionPrincipalId,
          lastDeprovisionEpoch:
            enterpriseScimDirectoryBindings.lastDeprovisionEpoch,
        })
        .from(enterpriseScimDirectoryBindings)
        .where(eq(enterpriseScimDirectoryBindings.connectionKey, connectionKey))
        .limit(1);
      if (!binding) throw new Error("SCIM_CONNECTION_NOT_BOUND");
      if (binding.status !== "active") {
        throw new Error("SCIM_CONNECTION_DEACTIVATED");
      }
      await tx.execute(
        sql`select set_config('app.tenant_id', ${binding.tenantId}, true)`,
      );
      return run(tx, {
        id: binding.id,
        tenantId: binding.tenantId,
        status: binding.status,
        lastDeprovisionPrincipalId: binding.lastDeprovisionPrincipalId,
        lastDeprovisionEpoch: binding.lastDeprovisionEpoch,
      });
    });

  return {
    async resolveBinding(connectionKey) {
      const fact = await withBoundTenant(
        connectionKey,
        async (_tx, binding) => ({
          tenantId: binding.tenantId,
          status: binding.status,
        }),
      );
      return fact;
    },

    async deprovisionMember(connectionKey, input) {
      const principal = await principalOf(input.userId);
      if (!principal) throw new Error("SCIM_MEMBER_NOT_FOUND");
      return withBoundTenant(connectionKey, async (tx, binding) => {
        // The update/delete policies pin the TARGET member (MT004 shape), so
        // the reaction re-pins app.operator_principal_id from the acting
        // identity to the target for the write phase.
        await tx.execute(
          sql`select set_config('app.operator_principal_id', ${principal.id}, true)`,
        );
        // Canonical lock order: the membership key, then read the live row.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${membershipLockKey(binding.tenantId, principal.id)}, 0))`,
        );
        const [membership] = await tx
          .select({
            status: enterpriseMemberships.status,
            epoch: enterpriseMemberships.epoch,
          })
          .from(enterpriseMemberships)
          .where(
            and(
              eq(enterpriseMemberships.tenantId, binding.tenantId),
              eq(enterpriseMemberships.principalId, principal.id),
            ),
          )
          .limit(1);
        if (!membership) throw new Error("SCIM_MEMBER_NOT_FOUND");
        if (membership.status !== "active") {
          return {
            outcome: "already_suspended" as const,
            tenantId: binding.tenantId,
            principalId: principal.id,
            grantsDeleted: 0 as const,
          };
        }
        const epoch = membership.epoch + 1;
        const updated = await tx
          .update(enterpriseMemberships)
          .set({ status: "suspended", epoch })
          .where(
            and(
              eq(enterpriseMemberships.tenantId, binding.tenantId),
              eq(enterpriseMemberships.principalId, principal.id),
              eq(enterpriseMemberships.epoch, membership.epoch),
            ),
          )
          .returning({ epoch: enterpriseMemberships.epoch });
        if (updated.length !== 1 || updated[0]?.epoch !== epoch) {
          throw new Error("SCIM_DEPROVISION_CONFLICT");
        }
        // Resource permissions: revocation is row deletion (MT007 paradigm).
        // The delete policy pins app.resource_id + app.operator_principal_id
        // per row, so the grant set is enumerated first and deleted one by one.
        const grants = await tx
          .select({ resourceId: enterpriseResourceGrants.resourceId })
          .from(enterpriseResourceGrants)
          .where(
            and(
              eq(enterpriseResourceGrants.tenantId, binding.tenantId),
              eq(enterpriseResourceGrants.principalId, principal.id),
            ),
          );
        for (const grant of grants) {
          await tx.execute(
            sql`select set_config('app.resource_id', ${grant.resourceId}, true), set_config('app.operator_principal_id', ${principal.id}, true)`,
          );
          await tx
            .delete(enterpriseResourceGrants)
            .where(
              and(
                eq(enterpriseResourceGrants.tenantId, binding.tenantId),
                eq(enterpriseResourceGrants.resourceId, grant.resourceId),
                eq(enterpriseResourceGrants.principalId, principal.id),
              ),
            );
        }
        // Server-persisted fact for the reprovision ruling (the directory may
        // lift only what it wrote): principal + epoch of this suspension.
        await tx
          .update(enterpriseScimDirectoryBindings)
          .set({
            lastDeprovisionPrincipalId: principal.id,
            lastDeprovisionEpoch: epoch,
          })
          .where(eq(enterpriseScimDirectoryBindings.id, binding.id));
        const auditEventId = await recordScimDirectoryAuditEvent(tx, {
          eventType: "company_member.scim_deprovisioned",
          tenantId: binding.tenantId,
          connectionKey,
          targetPrincipalId: principal.id,
          targetUserId: input.userId,
          epoch,
        });
        return {
          outcome: "deprovisioned" as const,
          tenantId: binding.tenantId,
          principalId: principal.id,
          membership: { status: "suspended" as const, epoch },
          grantsDeleted: grants.length,
          auditEventId,
        };
      });
    },

    async reprovisionMember(connectionKey, input) {
      const principal = await principalOf(input.userId);
      if (!principal) throw new Error("SCIM_MEMBER_NOT_FOUND");
      return withBoundTenant(connectionKey, async (tx, binding) => {
        // Update policies pin the target member (MT004 shape).
        await tx.execute(
          sql`select set_config('app.operator_principal_id', ${principal.id}, true)`,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${membershipLockKey(binding.tenantId, principal.id)}, 0))`,
        );
        const [membership] = await tx
          .select({
            status: enterpriseMemberships.status,
            epoch: enterpriseMemberships.epoch,
          })
          .from(enterpriseMemberships)
          .where(
            and(
              eq(enterpriseMemberships.tenantId, binding.tenantId),
              eq(enterpriseMemberships.principalId, principal.id),
            ),
          )
          .limit(1);
        if (!membership) throw new Error("SCIM_MEMBER_NOT_FOUND");
        // The directory may lift only its own suspension: the membership must
        // still be exactly the row state this binding's last deprovision wrote
        // (same principal, same epoch). An administrator's newer decision
        // stands (server-persisted fact, not a callback claim).
        if (
          membership.status === "active" ||
          binding.lastDeprovisionPrincipalId !== principal.id ||
          binding.lastDeprovisionEpoch !== membership.epoch
        ) {
          throw new Error("SCIM_REPROVISION_NOT_ALLOWED");
        }
        const epoch = membership.epoch + 1;
        const updated = await tx
          .update(enterpriseMemberships)
          .set({ status: "active", epoch })
          .where(
            and(
              eq(enterpriseMemberships.tenantId, binding.tenantId),
              eq(enterpriseMemberships.principalId, principal.id),
              eq(enterpriseMemberships.epoch, membership.epoch),
            ),
          )
          .returning({ epoch: enterpriseMemberships.epoch });
        if (updated.length !== 1 || updated[0]?.epoch !== epoch) {
          throw new Error("SCIM_REPROVISION_CONFLICT");
        }
        await tx
          .update(enterpriseScimDirectoryBindings)
          .set({
            lastDeprovisionPrincipalId: null,
            lastDeprovisionEpoch: null,
          })
          .where(eq(enterpriseScimDirectoryBindings.id, binding.id));
        const auditEventId = await recordScimDirectoryAuditEvent(tx, {
          eventType: "company_member.scim_reprovisioned",
          tenantId: binding.tenantId,
          connectionKey,
          targetPrincipalId: principal.id,
          targetUserId: input.userId,
          epoch,
        });
        return {
          outcome: "reprovisioned" as const,
          tenantId: binding.tenantId,
          principalId: principal.id,
          membership: { status: "active" as const, epoch },
          auditEventId,
        };
      });
    },

    async provisionMember(connectionKey, input) {
      // The directory never names a company: an input object carrying a
      // tenant attribution is refused loudly before any database access.
      if (
        input &&
        typeof input === "object" &&
        "tenantId" in (input as Record<string, unknown>)
      ) {
        throw new Error("TENANT_ATTRIBUTION_NOT_ACCEPTABLE");
      }
      const role = input?.role ?? "member";
      if (role !== "member") {
        // The OpenBot role is never taken from the directory (scim.ts): no
        // management role can arrive through a directory connection.
        throw new Error("SCIM_ROLE_NOT_ASSIGNABLE");
      }
      if (typeof input?.userId !== "string" || !input.userId.trim()) {
        throw new Error("SCIM_PRINCIPAL_NOT_FOUND");
      }
      const principal = await principalOf(input.userId);
      if (!principal) throw new Error("SCIM_PRINCIPAL_NOT_FOUND");
      return withBoundTenant(connectionKey, async (tx, binding) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${membershipLockKey(binding.tenantId, principal.id)}, 0))`,
        );
        const [existing] = await tx
          .select({ status: enterpriseMemberships.status })
          .from(enterpriseMemberships)
          .where(
            and(
              eq(enterpriseMemberships.tenantId, binding.tenantId),
              eq(enterpriseMemberships.principalId, principal.id),
            ),
          )
          .limit(1);
        if (existing) {
          // Zero writes: provisioning never flips a member's status (an
          // existing suspension stands until reprovision/admin decides).
          return {
            outcome: "already_member" as const,
            tenantId: binding.tenantId,
            principalId: principal.id,
          };
        }
        const inserted = await tx
          .insert(enterpriseMemberships)
          .values({
            tenantId: binding.tenantId,
            principalId: principal.id,
            role: "member",
            status: "active",
            epoch: 1,
          })
          .returning({ epoch: enterpriseMemberships.epoch });
        if (inserted.length !== 1) {
          throw new Error("SCIM_PROVISION_CONFLICT");
        }
        const auditEventId = await recordScimDirectoryAuditEvent(tx, {
          eventType: "company_member.scim_provisioned",
          tenantId: binding.tenantId,
          connectionKey,
          targetPrincipalId: principal.id,
          targetUserId: input.userId,
          epoch: 1,
        });
        return {
          outcome: "provisioned" as const,
          tenantId: binding.tenantId,
          principalId: principal.id,
          membership: { role: "member" as const, epoch: 1 },
          auditEventId,
        };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// T05.05（#561 / P12）：SCIM 目录反应 → 原子目录命令
//
// 上面的 MT026 reconciler 保留为 legacy/enterprise 岛的原路径（M0/M1 原
// 读写保留）；本节是 BA 权威分支的转译半区：固定 build 的 SCIM 插件在它
// 自己的请求事务里调用应用 hooks（identity.reconcileUser），hooks 在【同一
// 事务】上把每个事件翻译成 Directory 命令——首次供应 member.provision
// （无需邀请，Principal 由 envelope 的 registry.ensure 建立）、停用
// member.suspend、恢复 member.restore、删除 member.remove。命令的授权在
// handler 的锁内重验（scim.ts 的 createScimProvisioningHandlers），本节只
// 负责"哪个事件 → 哪条命令 + 事件证据从已批准规则行铸造"。
//
// 归属纪律（票面钉死）：公司只能来自插件经 bearer 认证解析出的
// connection 的 provisioningDomainId——服务端已验证事实，绝不来自请求
// 载荷；规则行（auth_provisioning_rules 的宽规则，external_group IS
// NULL）把 binding 钉到唯一公司，未批准/已撤销 = 停用的目录，零成员变
// 更（响亮拒绝）。幂等键携带固定 binding 维度（scim:{connection}:…），
// 恢复/停用/删除键再带当前投影 epoch：一次 HTTP 事务内的每一步失败，
// 外层事务整体回滚（BA08）。
// ---------------------------------------------------------------------------

import type {
  Directory,
  DirectoryActor,
  DirectoryOperation,
  DirectoryTx,
} from "../../auth/directory/contracts";
import {
  authCommandReceipts,
  authProvisioningRules,
} from "../../db/schema/auth-directory";

export const SCIM_REACTION_TRANSACTION_REQUIRED =
  "SCIM_REACTION_TRANSACTION_REQUIRED";
export const SCIM_REACTION_DIRECTORY_UNWIRED =
  "SCIM_REACTION_DIRECTORY_UNWIRED";
export const SCIM_REACTION_RULE_NOT_APPROVED =
  "SCIM_REACTION_RULE_NOT_APPROVED";
export const SCIM_REACTION_RULE_FOREIGN = "SCIM_REACTION_RULE_FOREIGN";

/** The per-event identity state the plugin's identity.reconcileUser hands over. */
export interface ScimIdentitySourceFact {
  readonly id: string;
  readonly connectionId: string;
  /** The server-fixed company this connection provisions into. */
  readonly provisioningDomainId: string;
  readonly active: boolean;
}

export interface ScimDirectoryReactionOptions {
  /** The transaction the fixed build's SCIM write currently runs in. */
  readonly currentTransaction: () => DirectoryTx | null;
  /** The directory executor bound to that same transaction. */
  readonly executor: (tx: DirectoryTx) => Pick<Directory, "execute"> | null;
}

export interface ScimDirectoryReaction {
  /**
   * Translates one aggregate identity state into per-company directory
   * commands, on the caller's transaction. Any refusal aborts the whole SCIM
   * HTTP write (the plugin wraps the failure and rolls back).
   */
  reconcileIdentity(state: {
    readonly userId: string;
    readonly active: boolean;
    readonly sources: readonly ScimIdentitySourceFact[];
  }): Promise<void>;
}

/** One approved wide provisioning rule (the binding's admission condition). */
export interface ScimWideRuleFact {
  readonly ruleId: string;
  readonly revision: number;
  readonly minimumRole: string;
  readonly workspaceIds: readonly string[];
}

/**
 * The binding's approved wide rule, read inside the caller's transaction.
 * Missing or revoked means a deactivated directory: the named refusal, never
 * a quieter reaction.
 */
export async function readScimWideRule(
  tx: DirectoryTx,
  connectionId: string,
  tenantId: string,
): Promise<ScimWideRuleFact> {
  const [row] = await tx
    .select({
      ruleId: authProvisioningRules.ruleId,
      revision: authProvisioningRules.revision,
      workspaceIds: authProvisioningRules.workspaceIds,
      status: authProvisioningRules.status,
      minimumRole: authProvisioningRules.minimumRole,
      tenantId: authProvisioningRules.tenantId,
    })
    .from(authProvisioningRules)
    .where(
      and(
        eq(authProvisioningRules.bindingId, connectionId),
        sql`${authProvisioningRules.externalGroup} is null`,
      ),
    )
    .limit(1);
  if (row?.status !== "approved") {
    throw new Error(
      `${SCIM_REACTION_RULE_NOT_APPROVED}: connection ${connectionId} has no approved company-admission provisioning rule; a deactivated directory makes zero member changes`,
    );
  }
  if (row.tenantId !== tenantId) {
    throw new Error(
      `${SCIM_REACTION_RULE_FOREIGN}: connection ${connectionId}'s approved rule belongs to company ${row.tenantId}, not ${tenantId}; the connection's fixed company and its rule disagree and no write may proceed`,
    );
  }
  return {
    ruleId: row.ruleId,
    revision: Number(row.revision),
    minimumRole: String(row.minimumRole),
    workspaceIds: [...row.workspaceIds],
  };
}

/** The company projection state of one user, or null when absent. */
async function readMembershipProjection(
  tx: DirectoryTx,
  tenantId: string,
  userId: string,
): Promise<{ status: string; epoch: number } | null> {
  const [row] = await tx
    .select({
      status: enterpriseMemberships.status,
      epoch: enterpriseMemberships.epoch,
    })
    .from(enterpriseMemberships)
    .innerJoin(
      enterprisePrincipals,
      eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
    )
    .where(
      and(
        eq(enterpriseMemberships.tenantId, tenantId),
        eq(enterprisePrincipals.userId, userId),
      ),
    )
    .limit(1);
  return row ? { status: String(row.status), epoch: Number(row.epoch) } : null;
}

/**
 * The scim actor for one event, its provisioning evidence minted from the
 * rule row this transaction just read (the handler re-verifies it in-lock:
 * the evidence is a claim, the rule is the fact).
 */
function scimActorOf(
  connectionId: string,
  rule: ScimWideRuleFact,
  userId: string,
  sourceId: string | null,
): DirectoryActor {
  return Object.freeze({
    userId,
    principalId: null,
    sessionId: null,
    kind: "scim" as const,
    bindingId: connectionId,
    provisioning: Object.freeze({
      eventId: `scim:${connectionId}:${sourceId ?? `user:${userId}`}`,
      ruleId: rule.ruleId,
      ruleRevision: rule.revision,
      sourceSubject: sourceId ?? `scim:${connectionId}:user:${userId}`,
    }),
  });
}

/** The provision receipt key: the durable "this directory created them" tie. */
export function scimProvisionKey(connectionId: string, userId: string): string {
  return `scim:${connectionId}:provision:${userId}`;
}

export function createScimDirectoryReaction(
  options: ScimDirectoryReactionOptions,
): ScimDirectoryReaction {
  const execute = async (
    actor: DirectoryActor,
    operation: DirectoryOperation,
    tenantId: string,
    idempotencyKey: string,
    payload: Readonly<Record<string, unknown>>,
  ) => {
    const tx = options.currentTransaction();
    if (!tx) {
      throw new Error(
        `${SCIM_REACTION_TRANSACTION_REQUIRED}: the SCIM identity hook fired outside the fixed build's request transaction; a directory reaction without its transaction owner is refused, never executed on the pool`,
      );
    }
    const directory = options.executor(tx);
    if (!directory) {
      throw new Error(
        `${SCIM_REACTION_DIRECTORY_UNWIRED}: this deployment has no directory executor assembled for the SCIM transaction; the write is refused rather than reacted by a stand-in`,
      );
    }
    return directory.execute(actor, {
      operation,
      tenantId,
      idempotencyKey,
      payload,
    });
  };

  return Object.freeze({
    async reconcileIdentity(state: {
      readonly userId: string;
      readonly active: boolean;
      readonly sources: readonly ScimIdentitySourceFact[];
    }) {
      const tx = options.currentTransaction();
      if (!tx) {
        throw new Error(
          `${SCIM_REACTION_TRANSACTION_REQUIRED}: the SCIM identity hook fired outside the fixed build's request transaction; a directory reaction without its transaction owner is refused, never executed on the pool`,
        );
      }
      const sourcesByConnection = new Map(
        state.sources.map((source) => [source.connectionId, source]),
      );
      // 1) Present sources: first supply, suspension, or reactivation.
      for (const source of state.sources) {
        const rule = await readScimWideRule(
          tx,
          source.connectionId,
          source.provisioningDomainId,
        );
        const membership = await readMembershipProjection(
          tx,
          source.provisioningDomainId,
          state.userId,
        );
        const actor = scimActorOf(
          source.connectionId,
          rule,
          state.userId,
          source.id,
        );
        if (!membership && source.active) {
          await execute(
            actor,
            "member.provision",
            source.provisioningDomainId,
            scimProvisionKey(source.connectionId, state.userId),
            { userId: state.userId },
          );
        } else if (membership?.status === "active" && !source.active) {
          await execute(
            actor,
            "member.suspend",
            source.provisioningDomainId,
            `scim:${source.connectionId}:suspend:${state.userId}:e${membership.epoch}`,
            {
              userId: state.userId,
              reason: "SCIM directory deactivation",
            },
          );
        } else if (membership?.status === "suspended" && source.active) {
          await execute(
            actor,
            "member.restore",
            source.provisioningDomainId,
            `scim:${source.connectionId}:restore:${state.userId}:e${membership.epoch}`,
            {
              userId: state.userId,
              reason: "SCIM directory reactivation",
            },
          );
        }
      }
      // 2) Removed sources: this directory provisioned the person and its
      // source is gone (DELETE) — the provision receipt is the tie, so an
      // invited membership this directory never created is never removed.
      const receipts = await tx
        .select({ key: authCommandReceipts.idempotencyKey })
        .from(authCommandReceipts)
        .where(
          and(
            eq(authCommandReceipts.operation, "member.provision"),
            eq(authCommandReceipts.domain, "company"),
            sql`${authCommandReceipts.idempotencyKey} like ${`scim:%:provision:${state.userId}`}`,
          ),
        );
      for (const receipt of receipts) {
        const connectionId = receipt.key.slice(
          "scim:".length,
          receipt.key.length - `:provision:${state.userId}`.length,
        );
        if (sourcesByConnection.has(connectionId)) continue;
        const [tenantRow] = await tx
          .select({ tenantId: authCommandReceipts.tenantId })
          .from(authCommandReceipts)
          .where(
            and(
              eq(authCommandReceipts.idempotencyKey, receipt.key),
              eq(authCommandReceipts.operation, "member.provision"),
            ),
          )
          .limit(1);
        const tenantId = tenantRow?.tenantId;
        if (!tenantId) continue;
        const membership = await readMembershipProjection(
          tx,
          tenantId,
          state.userId,
        );
        if (!membership) continue;
        const rule = await readScimWideRule(tx, connectionId, tenantId);
        await execute(
          scimActorOf(connectionId, rule, state.userId, null),
          "member.remove",
          tenantId,
          `scim:${connectionId}:remove:${state.userId}:e${membership.epoch}`,
          { userId: state.userId, reason: "SCIM directory removal" },
        );
      }
    },
  });
}
