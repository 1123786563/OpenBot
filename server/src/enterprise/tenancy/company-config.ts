// server/src/enterprise/tenancy/company-config.ts
// MT096（Issue #139 AC2）：企业设置界面只显示本公司配置——公司配置的只读投影。
//
// 一个读、一个判定事实：
//
//   - 读（companyConfig）：受信 CompanyAdminContext 之下的 operator 事务、
//     租户 pin（与 people-lifecycle / sso-scim-config 同一通道纪律），投影
//     本公司的治理事实：公司行（id/name/status）、团队行（id/name）、按
//     角色的成员计数。跨公司读取在结构上不可表达——上下文绑定公司（MT006
//     签发半边），API 无租户参数；选择头指向别家公司时解析不出本公司管理
//     上下文（TENANT_FORBIDDEN/TENANT_ADMIN_REQUIRED，不泄露存在性）。
//   - 无第二套配置真相：这里不复制 settings-store 的部署级配置（那是
//     平台面 /api/admin/** 的事实），只投影公司自己的行。

import { asc, eq, sql } from "drizzle-orm";
import {
  enterpriseMemberships,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../db/schema/enterprise-tenancy";
import { assertOperatorDatabase, type OperatorDatabase } from "./connections";
import {
  assertTrustedAdminContext,
  type CompanyAdminContext,
} from "./workspace-admin";

/** 一家公司的配置投影（企业设置页渲染的全部事实）。 */
export interface CompanyConfigView {
  readonly tenantId: string;
  readonly name: string;
  readonly status: "active" | "suspended";
  readonly teams: ReadonlyArray<{
    readonly workspaceId: string;
    readonly name: string;
  }>;
  /** 按角色的成员计数（active 成员；suspended 计入 offboarded）。 */
  readonly membersByRole: ReadonlyArray<{
    readonly role: "tenant_admin" | "member" | "auditor";
    readonly count: number;
  }>;
  readonly offboardedCount: number;
}

export function createCompanyConfigReader(
  operator: OperatorDatabase,
): (context: CompanyAdminContext) => Promise<CompanyConfigView> {
  assertOperatorDatabase(operator);
  return async (context) => {
    assertTrustedAdminContext(context);
    return operator.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${context.tenantId}, true)`,
      );
      const [tenant] = await tx
        .select({
          id: enterpriseTenants.id,
          name: enterpriseTenants.name,
          status: enterpriseTenants.status,
        })
        .from(enterpriseTenants)
        .where(eq(enterpriseTenants.id, context.tenantId))
        .limit(1);
      if (
        !tenant ||
        (tenant.status !== "active" && tenant.status !== "suspended")
      ) {
        // 管理上下文刚刚还成立（成员行活查通过），公司行却读不到——租户
        // pin 下的 RLS 或公司不存在；按不可见语义拒绝，不区分原因。
        throw new Error("COMPANY_CONFIG_NOT_FOUND");
      }
      const teams = await tx
        .select({
          workspaceId: enterpriseWorkspaces.id,
          name: enterpriseWorkspaces.name,
        })
        .from(enterpriseWorkspaces)
        .where(eq(enterpriseWorkspaces.tenantId, context.tenantId))
        .orderBy(asc(enterpriseWorkspaces.createdAt));
      const roles = await tx
        .select({
          role: enterpriseMemberships.role,
          status: enterpriseMemberships.status,
          count: sql<number>`count(*)::int`,
        })
        .from(enterpriseMemberships)
        .where(eq(enterpriseMemberships.tenantId, context.tenantId))
        .groupBy(enterpriseMemberships.role, enterpriseMemberships.status);
      const membersByRole = (
        ["tenant_admin", "member", "auditor"] as const
      ).map((role) => ({
        role,
        count:
          roles.find((row) => row.role === role && row.status === "active")
            ?.count ?? 0,
      }));
      const offboardedCount =
        roles
          .filter((row) => row.status === "suspended")
          .reduce((sum, row) => sum + row.count, 0) ?? 0;
      return {
        tenantId: tenant.id,
        name: tenant.name,
        status: tenant.status as "active" | "suspended",
        teams,
        membersByRole,
        offboardedCount,
      } satisfies CompanyConfigView;
    });
  };
}
