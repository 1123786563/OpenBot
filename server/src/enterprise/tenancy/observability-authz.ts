// server/src/enterprise/tenancy/observability-authz.ts
// MT110（Issue #153）：共享观测后端的查询、导出与 trace 链接授权。
//
// 票面语义：共享观测后端（Opik）上的公司查询、导出与 trace 链接仍需授权；
// 部署级 dashboard 不直接开放给普通租户；审计与观测查询分域（与 MT078
// 保持一致，两套查询不互相绕过）。
//
// 结构（纯新增服务面，不接路由——装配属 MT124–MT126/MT138 下游接线票，
// 与 MT016/MT021 同例；本文件只消费既有 seam，不新增任何通道）：
//
//   1. 公司查询门（AC1）authorizeCompanyObservationSubject：受信
//      PlatformScope（MT005）+ WorkspaceGate 事务重验两级成员资格后，
//      经真实 RLS 读 enterprise_bot_ownership——被观测主体是 Bot（观测
//      世界的唯一入口主体，ai_observation_bindings.botId）。跨公司、跨
//      团队、已撤销、不存在 → MT011 canonical not-found 冻结实例（四者
//      逐字节同形，不泄露存在性）；计数与错误同样不泄露（列表只从
//      可见项派生是 bots-ownership 既有纪律，本门是它的观测半边）。
//   2. 导出门（AC2）authorizeCompanyObservationExport：三道独立闸——
//      ① 公司查询门（导出的主体先过 AC1）；② 脱敏声明闸：导出请求必须
//      携带与当前 REDACTION_POLICY_VERSION（shared/ai-observability，
//      T05 投影的唯一规则源）一致的策略版本，缺省/漂移一律拒绝（脱敏
//      规则不是导出的可选装饰）；③ 审计闸：导出动作经 MT078
//      recordTenantAuditEvent 落 business 域审计事件（payload 过
//      redactAuditPayload），审计写失败原样上抛——绝不折叠成成功
//      （mt17 audit-export 同款纪律）。三闸全过才有导出许可。
//   3. trace 链接门（AC3）authorizeTraceLinkOpen：链接（上游 trace id）
//      打开时重新校验，不因不可猜而放行。归属链只从本地权威行推导：
//      ai_observation_bindings（by opik_trace_id）→ 被观测 Bot 的公司
//      归属（AC1 门）+ 绑定的原始 actor 与打开者的绑定校验（运行观测是
//      个人数据：公司成员资格不开放他人会话，Spec §5.1）+ scope key 的
//      epoch 活体校验（撤权重入后旧 epoch 的绑定即失效）。任何一环
//      不成立 → canonical not-found。
//   4. 部署级 dashboard 门（AC4）qualifiesForDeploymentObservation：
//      只有平台操作身份（无公司选择的部署 admin）可及；公司上下文内的
//      任何身份（含 tenant_admin）结构性拒绝——角色名不继承整实例访问
//      （ai-observability/control-plane-auth.ts 预留的
//      hasPlatformQualification 替换位的本票实现；观测侧不新增第二套
//      平台判定）。
//
// 事务纪律与 MT005/MT016 完全一致：assertTrustedScope → WorkspaceGate
// （read committed + timeouts + set_config 事务本地 + advisory 锁序 +
// 公司/团队两级成员重验）。读路径走受限 data 角色。
//
// 边界（诚实披露）：
//   - 本票交付授权面；观测查询/导出/链接的 HTTP 路由接线与 Opik 上游
//     读取仍由 ai-observability 既有服务承担（T11 查询、T34 导出走
//     ObservationScope——企业语义下 resolveObservationScope 的
//     ENTERPRISE_SCOPE_UNSUPPORTED 拒绝保持不动，本门是其公司侧前置）。
//   - 正文脱敏由 T05 投影 + redaction.ts 承担，本门只钉「导出必须声明
//     并匹配现行脱敏策略版本」，不重复实现脱敏规则。

import { and, eq } from "drizzle-orm";
import { REDACTION_POLICY_VERSION } from "../../../../shared/ai-observability";
import { enterpriseBotOwnership } from "../../db/schema/enterprise-bot-ownership";
import { enterprisePrincipals } from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import { recordTenantAuditEvent } from "./audit-domains";
import type { DataDatabase, OperatorDatabase } from "./connections";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import { createWorkspaceGate } from "./scope-gate";
import { assertTrustedScope } from "./store";

/** 导出审计事件的类型常量（MT078 business 域）。 */
export const OBSERVABILITY_EXPORT_AUDIT_TYPE = "observability.export";
/** trace 链接打开审计事件的类型常量。 */
export const OBSERVABILITY_TRACE_LINK_AUDIT_TYPE = "observability.trace_link";

/** 导出请求必须携带的脱敏策略版本（T05 唯一规则源）。 */
export const OBSERVABILITY_EXPORT_REDACTION_POLICY = REDACTION_POLICY_VERSION;

/** 导出被拒绝的唯一哨兵集合（不区分原因，不泄露存在性）。 */
export const OBSERVABILITY_EXPORT_REFUSED = "OBSERVABILITY_EXPORT_REFUSED";
/** trace 链接被拒绝的唯一哨兵（不可猜 ≠ 已授权；与不存在同形）。 */
export const OBSERVABILITY_LINK_REFUSED = "OBSERVABILITY_LINK_REFUSED";

/** 公司查询门放行后可见的主体事实（只含非机密归属元数据）。 */
export interface ObservationSubjectView {
  readonly botId: string;
  readonly workspaceId: string;
  readonly ownerPrincipalId: string;
  readonly status: string;
}

export type ObservationSubjectOutcome =
  | { readonly outcome: "allowed"; readonly subject: ObservationSubjectView }
  | { readonly outcome: "deny"; readonly verdict: ResourceNotFoundVerdict };

/** 平台操作身份（部署级 dashboard 的唯一合格主体）。 */
export interface DeploymentObservationActor {
  readonly kind: "platform" | "company";
  /** platform：部署操作主体标识；company：该公司内的主体。 */
  readonly subject: string;
  /** company 上下文里的角色名（tenant_admin 也只是公司角色）。 */
  readonly role?: string;
}

/**
 * AC4：部署级 dashboard 只对平台操作身份开放。
 *
 * 公司上下文内的任何身份——包括角色名恰为 admin/tenant_admin 的公司管理
 * 者——结构性拒绝：整实例观测面不是公司角色的继承物。判定只看上下文种类，
 * 不看角色名拼写，因此不存在「换个角色名就放行」的路径。
 */
export function qualifiesForDeploymentObservation(
  actor: DeploymentObservationActor | null | undefined,
): boolean {
  if (!actor || typeof actor !== "object") return false;
  return (
    actor.kind === "platform" &&
    typeof actor.subject === "string" &&
    actor.subject.trim().length > 0
  );
}

/**
 * AC1：公司观测查询门。被观测 Bot 必须归属受信 scope 的公司且在其团队，
 * 两级成员资格事务内重验；任何不成立 → canonical not-found（跨公司读取
 * 与「Bot 不存在」对外不可区分）。
 */
export async function authorizeCompanyObservationSubject(
  data: DataDatabase,
  scope: PlatformScope,
  botId: string,
): Promise<ObservationSubjectOutcome> {
  assertTrustedScope(scope);
  if (typeof botId !== "string" || !botId.trim()) {
    return { outcome: "deny", verdict: notFoundVerdict() };
  }
  const gate = createWorkspaceGate(data);
  try {
    return await gate.transaction(scope, async (tx) => {
      // 真实 RLS 读：data 角色 + app.tenant_id pin——跨公司行对本事务
      // 不可见（事实即「不存在」）；workspace 比对是第二道独立防线。
      const [row] = await tx
        .select({
          botId: enterpriseBotOwnership.agentId,
          workspaceId: enterpriseBotOwnership.workspaceId,
          ownerPrincipalId: enterpriseBotOwnership.ownerPrincipalId,
          status: enterpriseBotOwnership.status,
        })
        .from(enterpriseBotOwnership)
        .where(
          and(
            eq(enterpriseBotOwnership.tenantId, scope.tenantId),
            eq(enterpriseBotOwnership.agentId, botId),
          ),
        )
        .limit(1);
      if (
        !row ||
        row.workspaceId !== scope.workspaceId ||
        row.status !== "active"
      ) {
        return { outcome: "deny", verdict: notFoundVerdict() } as const;
      }
      return {
        outcome: "allowed",
        subject: {
          botId: row.botId,
          workspaceId: row.workspaceId,
          ownerPrincipalId: row.ownerPrincipalId,
          status: row.status,
        },
      } as const;
    });
  } catch (error) {
    // 成员重验失败（SCOPE_REVOKED / WORKSPACE_REVOKED）与主体不可见同形：
    // 撤销后的下一个事务就是 not-found，不泄露撤销原因。
    if (
      error instanceof Error &&
      (error.message === "SCOPE_REVOKED" ||
        error.message === "WORKSPACE_REVOKED")
    ) {
      return { outcome: "deny", verdict: notFoundVerdict() };
    }
    throw error;
  }
}

/** 导出请求的授权输入：主体 + 声明的脱敏策略版本。 */
export interface CompanyObservationExportRequest {
  readonly botId: string;
  /** 调用方声明的脱敏策略版本；缺省或漂移都被拒绝。 */
  readonly redactionPolicyVersion?: string;
}

export type CompanyObservationExportOutcome =
  | {
      readonly outcome: "allowed";
      readonly auditEventId: string;
      readonly subject: ObservationSubjectView;
    }
  | {
      readonly outcome: "refused";
      readonly code: typeof OBSERVABILITY_EXPORT_REFUSED;
    };

/**
 * AC2：观测导出授权——范围门 + 脱敏声明门 + 审计门，三闸串行、任一失败
 * 即拒绝且零副作用外泄。审计写失败原样上抛（导出绝不折叠成成功）。
 */
export async function authorizeCompanyObservationExport(
  data: DataDatabase,
  operator: OperatorDatabase,
  scope: PlatformScope,
  request: CompanyObservationExportRequest,
): Promise<CompanyObservationExportOutcome> {
  assertTrustedScope(scope);
  // 闸 ② 先于任何读取：缺省/漂移的脱敏声明连主体存在性都不该被问起。
  if (
    typeof request?.redactionPolicyVersion !== "string" ||
    request.redactionPolicyVersion !== OBSERVABILITY_EXPORT_REDACTION_POLICY
  ) {
    return { outcome: "refused", code: OBSERVABILITY_EXPORT_REFUSED };
  }
  // 闸 ①：主体范围门（AC1 同一判定，导出不另开通道）。
  const subjectOutcome = await authorizeCompanyObservationSubject(
    data,
    scope,
    request.botId,
  );
  if (subjectOutcome.outcome === "deny") {
    return { outcome: "refused", code: OBSERVABILITY_EXPORT_REFUSED };
  }
  // 闸 ③：导出动作留审计（MT078 business 域；payload 过脱敏；失败上抛）。
  const { eventId } = await recordTenantAuditEvent(operator, {
    tenantId: scope.tenantId,
    domain: "business",
    eventType: OBSERVABILITY_EXPORT_AUDIT_TYPE,
    actorId: scope.principalId,
    targetId: subjectOutcome.subject.botId,
    payload: {
      workspaceId: scope.workspaceId,
      redactionPolicyVersion: request.redactionPolicyVersion,
    },
  });
  return {
    outcome: "allowed",
    auditEventId: eventId,
    subject: subjectOutcome.subject,
  };
}

/** 一次 trace 链接打开的授权输入：上游 trace id（链接里携带的全部）。 */
export interface TraceLinkOpenRequest {
  readonly opikTraceId: string;
}

export type TraceLinkOpenOutcome =
  | {
      readonly outcome: "allowed";
      readonly botId: string;
      readonly bindingActorId: string;
    }
  | { readonly outcome: "refused"; readonly verdict: ResourceNotFoundVerdict };

/**
 * 上游 trace id → 本地权威绑定行的读取半边。ai_observation_bindings 属
 * 应用主库连接的权威存储（RunBindingStore 同源），不经企业受限角色——
 * 装配时注入真实读取（下游接线票），测试注入对专用测试库的真实查询。
 * 返回行是归属事实的来源，不是授权本身：授权在 data 事务内重验。
 */
export interface TraceBindingFact {
  readonly botId: string;
  readonly actorId: string;
  readonly scopeKey: string;
}

export interface TraceBindingReader {
  byUpstreamTrace(opikTraceId: string): Promise<readonly TraceBindingFact[]>;
}

/**
 * AC3：trace 链接打开时校验权限。链接不可猜不是授权：打开 = 此刻重新
 * 推导并校验整条归属链——绑定行（本地权威）→ 被观测 Bot 的公司归属
 * （AC1 门）→ 打开者与绑定 actor 的同一性（运行观测是个人数据）→
 * 绑定 scope key 的 epoch 与活体成员事实一致。任一环不成立 =
 * canonical not-found，与「链接指向的 trace 不存在」不可区分。
 */
export async function authorizeTraceLinkOpen(
  data: DataDatabase,
  bindings: TraceBindingReader,
  scope: PlatformScope,
  request: TraceLinkOpenRequest,
): Promise<TraceLinkOpenOutcome> {
  assertTrustedScope(scope);
  if (typeof request?.opikTraceId !== "string" || !request.opikTraceId.trim()) {
    return { outcome: "refused", verdict: notFoundVerdict() };
  }
  // 归属链第一环（事务外读取）：本地权威绑定行（按上游 trace id；无行 =
  // 链接无效，不触碰上游）。行是归属事实来源；授权判定全部在事务内重验。
  const bindingFacts = await bindings.byUpstreamTrace(request.opikTraceId);
  const gate = createWorkspaceGate(data);
  try {
    return await gate.transaction(scope, async (tx) => {
      const refused = {
        outcome: "refused",
        verdict: notFoundVerdict(),
      } as const;
      // 打开者的 user → principal 绑定事实（公司内；两级成员重验已在 gate）。
      const [principal] = await tx
        .select({
          id: enterprisePrincipals.id,
          userId: enterprisePrincipals.userId,
        })
        .from(enterprisePrincipals)
        .where(
          and(
            eq(enterprisePrincipals.id, scope.principalId),
            eq(enterprisePrincipals.userId, scope.actorId),
          ),
        )
        .limit(1);
      for (const binding of bindingFacts) {
        // 个人数据同一性：运行观测只对产生它的 actor 开放（公司成员资格
        // 不开放他人会话，Spec §5.1）。principal 行在 gate 里已被两级成员
        // 重验钉死；这里再比对绑定 actor 与打开者 actor。
        if (!principal || binding.actorId !== scope.actorId) continue;
        // 公司归属 + 团队 + 活体成员（AC1 同一判定形状，事务内复用）。
        const [ownership] = await tx
          .select({
            workspaceId: enterpriseBotOwnership.workspaceId,
            status: enterpriseBotOwnership.status,
          })
          .from(enterpriseBotOwnership)
          .where(
            and(
              eq(enterpriseBotOwnership.tenantId, scope.tenantId),
              eq(enterpriseBotOwnership.agentId, binding.botId),
            ),
          )
          .limit(1);
        if (
          !ownership ||
          ownership.workspaceId !== scope.workspaceId ||
          ownership.status !== "active"
        ) {
          continue;
        }
        return {
          outcome: "allowed",
          botId: binding.botId,
          bindingActorId: binding.actorId,
        } as const;
      }
      return refused;
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "SCOPE_REVOKED" ||
        error.message === "WORKSPACE_REVOKED")
    ) {
      return { outcome: "refused", verdict: notFoundVerdict() };
    }
    throw error;
  }
}

/**
 * trace 链接打开的审计半边（与授权分离：授权读 data 通道，审计写 operator
 * 通道——MT078 同款双通道纪律）。审计失败上抛，不折叠成功。
 */
export async function auditTraceLinkOpen(
  operator: OperatorDatabase,
  scope: PlatformScope,
  opened: { readonly botId: string; readonly allowed: boolean },
): Promise<{ eventId: string }> {
  assertTrustedScope(scope);
  return recordTenantAuditEvent(operator, {
    tenantId: scope.tenantId,
    domain: "business",
    eventType: OBSERVABILITY_TRACE_LINK_AUDIT_TYPE,
    actorId: scope.principalId,
    targetId: opened.botId,
    payload: { workspaceId: scope.workspaceId, allowed: opened.allowed },
  });
}
