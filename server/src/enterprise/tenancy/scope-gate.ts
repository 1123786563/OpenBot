// server/src/enterprise/tenancy/scope-gate.ts
// MT005（Issue #48）：集中授权入口的业务事务半边。
//
// 签发半边（createScopeResolver.resolve）验证「有效公司成员资格 + 有效团队
// 成员资格」后签发受信 Scope；本文件是同一判定的**事务等价物**：任何业务
// 事务开始时在同一事务内重验两级成员资格，撤权（公司级或团队级）后的下一
// 个事务立即拒绝。形状与 `createConversationStore().transaction` 完全一致
// （conversations/store.ts 模式）：
//   assertTrustedScope → read committed + lock/statement timeout →
//   set_config('app.*', …, true)（事务本地，提交即清除，RLS 纵深防御）→
//   advisory 共享锁 tenant → principal → membership → workspace-membership →
//   公司成员重验（active + epoch === scope.memberEpoch + actor 绑定）→
//   团队成员重验（行存在且 status = 'active'）→ 业务操作。
//
// 裁决 #2（MT005）：本栈策略版本只有 tenancy-v1；本文件不引入任何策略版本
// 常量，也不存在 conversations-v1。团队级锁键是新键型
// ["enterprise","workspace-membership",tenant,workspace,principal]，排在
// membership 之后、resource 之前（seam-identification-mt005.md §4.3 顺序）。

import { and, eq, sql } from "drizzle-orm";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import type { DataDatabase } from "./connections";
import { assertTrustedScope } from "./store";

export interface WorkspaceGate {
  /**
   * Runs `operation` inside a business transaction that revalidates both
   * company and team membership for the trusted scope before the operation,
   * throwing `SCOPE_REVOKED` (company level) or `WORKSPACE_REVOKED` (team
   * level) instead of executing it.
   */
  transaction<T>(
    scope: PlatformScope,
    operation: (
      tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0],
    ) => Promise<T>,
  ): Promise<T>;
}

/** The advisory-lock key the gate takes shared and admin writes take exclusive. */
export function workspaceMembershipLockKey(
  tenantId: string,
  workspaceId: string,
  principalId: string,
): string {
  return JSON.stringify([
    "enterprise",
    "workspace-membership",
    tenantId,
    workspaceId,
    principalId,
  ]);
}

export function createWorkspaceGate(data: DataDatabase): WorkspaceGate {
  return {
    async transaction(scope, operation) {
      // Trust boundary first: only this process's issuance entry can produce
      // a scope the gate will act on (acceptance 1).
      assertTrustedScope(scope);
      return data.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        /* Transaction-local settings are defense in depth for RLS and are cleared on commit. */
        await tx.execute(
          sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true)`,
        );
        // Lock order: tenant → principal → membership → workspace-membership.
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
        // Company-level revalidation (same facts as conversations/store.ts).
        const [membership] = await tx
          .select({
            memberStatus: enterpriseMemberships.status,
            memberEpoch: enterpriseMemberships.epoch,
            principalStatus: enterprisePrincipals.status,
            tenantStatus: enterpriseTenants.status,
          })
          .from(enterpriseMemberships)
          .innerJoin(
            enterprisePrincipals,
            eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
          )
          .innerJoin(
            enterpriseTenants,
            eq(enterpriseTenants.id, enterpriseMemberships.tenantId),
          )
          .where(
            and(
              eq(enterpriseMemberships.tenantId, scope.tenantId),
              eq(enterpriseMemberships.principalId, scope.principalId),
              eq(enterprisePrincipals.userId, scope.actorId),
            ),
          )
          .limit(1);
        if (
          membership?.memberStatus !== "active" ||
          membership?.principalStatus !== "active" ||
          membership?.tenantStatus !== "active" ||
          membership?.memberEpoch !== scope.memberEpoch
        ) {
          throw new Error("SCOPE_REVOKED");
        }
        // Team-level revalidation: the row must exist and be active. Removal
        // deletes the row; suspension flips its status — both land here.
        const [teamMembership] = await tx
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
        if (teamMembership?.status !== "active") {
          throw new Error("WORKSPACE_REVOKED");
        }
        return operation(tx);
      });
    },
  };
}
