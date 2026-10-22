// server/src/enterprise/tenancy/company-capabilities.ts
// MT095/MT096（Issues #138-#139 AC1）：公司管理界面的「入口由服务端能力决定」。
//
// 一个组合面，零判定逻辑：每个能力位是**对应服务自己的判定门**的布尔半边，
// 这里只把四个答案装进同一载荷——前端不复制角色判断（票面备注），也不出
// 现第二套能力规则表：
//
//   - peopleAdmin：MT006 管理上下文解析（活跃成员 ∧ tenant_admin）——与
//     团队/人员管理路由同一判定。
//   - auditReader：MT078 audit-domains 的 canReadBusinessAudit（活跃成员
//     ∧ auditor|tenant_admin）——与审计查询/导出同一判定门。
//   - financeReader：MT073 assertCompanyFinanceReader（活跃成员 ∧ 显式财务
//     读取授权行）——与公司账簿读取同一判定门。
//   - billingManager：MT078 holdsAnyBillingManageGrant（活跃成员 ∧ 计费
//     管理授权行）——与计费管理动作同一判定门。
//
// 判定失败按 false 收口（fail-closed）：能力答案绝不把基础设施故障翻译成
// 「有权限」；每个位独立回答，任何一位的故障不影响其他位。载荷只含四个
// 布尔与公司 id——不是成员名册，不泄露任何事实给无能力者。

import { canReadBusinessAudit } from "./audit-domains";
import type { BillingManagementService } from "./audit-domains";
import type { CompanyFinanceVisibilityService } from "../../billing/company-finance-visibility";
import type { OperatorDatabase } from "./connections";
import type { CompanyMemberContext } from "./workspace-admin";

/** 一位成员在一家公司里被服务端事实授权的管理能力位。 */
export interface CompanyCapabilities {
  readonly tenantId: string;
  readonly principalId: string;
  /** people/身份提供方/凭据/企业设置/学习管理面（tenant_admin）。 */
  readonly peopleAdmin: boolean;
  /** 审计查询与导出面（auditor|tenant_admin，MT078 域授权矩阵）。 */
  readonly auditReader: boolean;
  /** 公司账簿与团队用量视图（显式财务读取授权，MT073）。 */
  readonly financeReader: boolean;
  /** 计费管理入口（显式计费管理授权，MT078）。 */
  readonly billingManager: boolean;
}

export interface CompanyCapabilitiesService {
  /**
   * The capability answer for an already-resolved member context. Each bit
   * consults its own surface's gate and fails closed; the composition itself
   * holds no rule of its own.
   */
  capabilitiesOf(member: CompanyMemberContext): Promise<CompanyCapabilities>;
}

export function createCompanyCapabilitiesService({
  operator,
  finance,
  billing,
}: {
  operator: OperatorDatabase;
  finance: CompanyFinanceVisibilityService;
  billing: BillingManagementService;
}): CompanyCapabilitiesService {
  return {
    async capabilitiesOf(member) {
      const [auditReader, financeReader, billingManager] = await Promise.all([
        canReadBusinessAudit(
          operator,
          { kind: "company", principalId: member.principalId },
          member.tenantId,
        ).catch(() => false),
        finance
          .assertCompanyFinanceReader({
            tenantId: member.tenantId,
            principalId: member.principalId,
          })
          .then(() => true)
          .catch(() => false),
        billing
          .holdsAnyBillingManageGrant({
            tenantId: member.tenantId,
            principalId: member.principalId,
          })
          .catch(() => false),
      ]);
      return {
        tenantId: member.tenantId,
        principalId: member.principalId,
        peopleAdmin: member.role === "tenant_admin",
        auditReader,
        financeReader,
        billingManager,
      };
    },
  };
}
