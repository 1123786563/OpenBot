// server/src/enterprise/tenancy/admin-separation.ts
// MT075（Issue #118）：部署级平台管理与公司/团队管理动作分离。
//
// 平台级管理（部署配置、平台静态能力、全局身份审计）与公司/团队管理
// 动作在这里分成两个互不隐含的授权面：
//
//   1. 管理入口分类（封闭规则表）：每个管理入口要么是平台级
//      （platform——/api/admin/** 部署管理面、SCIM 写动词、SSO 登记精确
//      路径），要么是公司/团队级（company——/api/enterprise/workspace-scope/
//      admin/**）。两个面之外没有第三种管理入口；业务与自服务入口不是
//      管理入口（分类返回 null）。MT001 清单（inventory.ts）消费同一
//      函数做回写摘要——分类与清单结构性一致，不是两份手写清单。
//
//   2. 平台面判定（authorizePlatformManagementAction）：部署管理员与平台
//      操作身份（机器读身份，如 ob_ent_identity_operator 的操作主体）可
//      以执行平台管理；公司管理员（tenant_admin）被拒绝——公司管理身份
//      不携带任何平台管理权，平台策略只能由平台面修改。
//
//   3. 公司面判定（authorizeCompanyManagementAction）：受信公司管理员
//      上下文（workspace-admin 的签发半边）在本公司内放行；平台身份
//      （部署管理员或机器身份）只有在**显式跨面授权**（subject × 公司 ×
//      入口精确绑定的登记项）下才放行，且每次放行都产生一条审计事件
//      （recordManagementAuditEvent 经受限 operator 角色与真实 RLS INSERT
//      策略落 enterprise_security_events——与撤权审计同一通道，事件类型
//      独立封闭集合，不改 revocation.ts）。判定放行与审计写入的组合入口
//      是 authorizeAndRecordCompanyManagementAction（同一事务内完成，审计
//      缺失即动作失败）。集成状态（OCR round5 R5-2 披露）：生产代码当前
//      零调用——它是跨面管理动作（MT019 族）的既定 seam，尚无生产接线方；
//      plugin-packages 刻意不经它（缘由见该函数注释）。没有登记就是拒绝：
//      平台身份不因平台权限获得任何公司管理权。
//
// 管理权不隐含业务内容读取权：判定结果只携带动作许可与审计意图，不携带
// 任何 PlatformScope/principal/workspace 句柄；业务内容读取仍只经 MT005
// scope gate 与资源策略（消费方，不在此修改）。

import { sql } from "drizzle-orm";
import { enterpriseSecurityEvents } from "../../db/schema/enterprise-tenancy";
import {
  assertTrustedAdminContext,
  type CompanyAdminContext,
} from "./workspace-admin";

// ---------------------------------------------------------------------------
// 1. 管理入口分类（封闭规则表）
// ---------------------------------------------------------------------------

/** 管理面：平台级（部署）或公司/团队级。 */
export type ManagementPlane = "platform" | "company";

/**
 * 一条分类规则：声明哪个前缀/路径形态属于哪个管理面。规则表是封闭的
 * 清单——新管理面必须显式加规则，而不是靠默认放行。
 */
export interface ManagementPlaneRule {
  readonly plane: ManagementPlane;
  /** 人类可读的面标签（清单与报告用）。 */
  readonly surface: string;
  /** 路径前缀匹配（与 MT001 清单 path 同形）。 */
  readonly prefix?: string;
  /** 精确路径匹配（用于登记在挂载点之外的管理入口）。 */
  readonly pathPattern?: RegExp;
  /** 限定 HTTP 方法；省略 = 全部方法。 */
  readonly methods?: readonly string[];
}

/**
 * 管理入口分类规则表（MT075 封闭清单）：
 *
 *   - /api/admin/** —— 部署管理面（企业控制、身份/凭据/人员管理、全局
 *     审计读取、部署计费管理、平台模板）：平台级。装配在该挂载点下的
 *     新路由自动归平台面（保守默认），归类无需逐条登记。
 *   - /api/enterprise/workspace-scope/admin/** —— 公司管理员管理本公司
 *     团队与成员名单（MT006 等价集中入口的 HTTP 面）：公司/团队级。
 *   - PKG02/PKG03/PKG04：/api/enterprise/plugin-packages/plans 与
 *     /plans/:id/apply（POST），/installs/:id/bots/:botId/grants
 *     （PUT 授权 / DELETE 撤权）与 /installs/:id/experts/:resourceId
 *     （POST 专家实例化）——公司管理员提交插件包安装预览/确认、
 *     为范围内 Bot 授予/撤回技能授权、从安装修订的专家模板创建范围内
 *     Bot：公司/团队级，按精确方法+路径登记（计划/安装/Bot/资源 ID 是
 *     路径参数）。
 *   - /api/auth/scim/** 的 PUT/PATCH/DELETE —— SCIM 供应写动词是部署
 *     管理员的身份管理动作（app.ts 以 ADMIN_ONLY 语义守卫）：平台级；
 *     GET/POST 是普通身份面，不分类。
 *   - /api/auth/sso/{register,update-provider,delete-provider} —— 身份
 *     提供方登记是管理员的部署配置决定（ADMIN_ONLY_AUTH_ROUTES）：
 *     平台级，按精确路径登记（better-auth 面不在 Hono 路由表内）。
 */
export const MANAGEMENT_PLANE_RULES: readonly ManagementPlaneRule[] =
  Object.freeze([
    {
      plane: "platform",
      surface: "deployment-admin",
      prefix: "/api/admin/",
    },
    {
      plane: "company",
      surface: "workspace-admin",
      prefix: "/api/enterprise/workspace-scope/admin/",
    },
    {
      plane: "company",
      surface: "package-admin",
      pathPattern:
        /^\/api\/enterprise\/plugin-packages\/(?:plans(?:\/[^/]+\/apply)?|installs\/[^/]+\/(?:bots\/[^/]+\/grants|experts\/[^/]+))$/,
      methods: ["POST", "PUT", "DELETE"],
    },
    {
      plane: "platform",
      surface: "scim-admin",
      prefix: "/api/auth/scim/",
      methods: ["PUT", "PATCH", "DELETE"],
    },
    {
      plane: "platform",
      surface: "identity-provider-admin",
      pathPattern:
        /^\/api\/auth\/sso\/(?:register|update-provider|delete-provider)$/,
      methods: ["POST"],
    },
  ]);

/**
 * 分类一个入口；不是管理入口时返回 null（业务/自服务面）。首个命中
 * 规则生效；方法不匹配的规则跳过。
 */
export function classifyManagementPlane(entrance: {
  readonly method: string;
  readonly path: string;
}): ManagementPlane | null {
  const method = String(entrance?.method ?? "").toUpperCase();
  const path = String(entrance?.path ?? "");
  if (!method || !path) return null;
  for (const rule of MANAGEMENT_PLANE_RULES) {
    if (rule.methods && !rule.methods.includes(method)) continue;
    if (rule.prefix !== undefined) {
      if (path === rule.prefix || path.startsWith(rule.prefix)) {
        return rule.plane;
      }
      continue;
    }
    if (rule.pathPattern?.test(path)) return rule.plane;
  }
  return null;
}

/** 公司面路由的载荷守卫：分类不是公司面时拒绝（fail-closed，500 语义）。 */
export function assertClassifiedCompanyEntrance(
  method: string,
  path: string,
): void {
  if (classifyManagementPlane({ method, path }) !== "company") {
    throw new Error("MANAGEMENT_ENTRANCE_UNCLASSIFIED");
  }
}

/** 公司管理面的挂载前缀（workspace-scope-routes 的守卫与清单同源）。 */
export const WORKSPACE_SCOPE_MOUNT_PREFIX = "/api/enterprise/workspace-scope";

// ---------------------------------------------------------------------------
// 2. 管理动作判定
// ---------------------------------------------------------------------------

/**
 * 管理动作的执行者。company_admin 携带 workspace-admin 签发的受信上下文；
 * platform_operator 是平台机器/操作身份的主体名（无业务会话）。
 */
export type ManagementActor =
  | { readonly kind: "deployment_admin"; readonly userId: string }
  | { readonly kind: "company_admin"; readonly context: CompanyAdminContext }
  | { readonly kind: "platform_operator"; readonly subject: string };

export type ManagementDenialCode =
  | "MANAGEMENT_ENTRANCE_UNCLASSIFIED"
  | "PLATFORM_ADMIN_REQUIRED"
  | "COMPANY_ADMIN_CONTEXT_REQUIRED"
  | "MANAGEMENT_CROSS_AUTHORIZATION_REQUIRED";

/** 管理动作判定结果：要么放行（跨面放行必须携带审计事件），要么拒绝。 */
export type ManagementActionDecision =
  | {
      readonly outcome: "allow";
      readonly plane: ManagementPlane;
      /** 跨面放行（平台身份 → 公司入口）的审计事件；同面放行为 null。 */
      readonly audit: ManagementAuditEvent | null;
    }
  | {
      readonly outcome: "deny";
      readonly code: ManagementDenialCode;
      /** 入口未分类时为 null（分类失败先于任何面判定）。 */
      readonly plane: ManagementPlane | null;
    };

/**
 * 平台面判定。部署管理员与平台操作身份放行；公司管理员拒绝——这是
 * 「公司管理员不能修改平台策略」的判定点。入口必须已分类为平台面。
 */
export function authorizePlatformManagementAction(
  actor: ManagementActor,
  entrance: { readonly method: string; readonly path: string },
): ManagementActionDecision {
  if (classifyManagementPlane(entrance) !== "platform") {
    return Object.freeze({
      outcome: "deny",
      code: "MANAGEMENT_ENTRANCE_UNCLASSIFIED",
      plane: null,
    });
  }
  if (actor.kind === "company_admin") {
    return Object.freeze({
      outcome: "deny",
      code: "PLATFORM_ADMIN_REQUIRED",
      plane: "platform",
    });
  }
  // 与公司面的空 tenantId 拒绝对称（fail-closed）：kind 正确但主体为空
  // 的畸形 actor（{ kind: "deployment_admin", userId: "" } 等）不因构造
  // 恰好命中类型而进入平台管理面。
  if (!actorSubjectOf(actor).trim()) {
    return Object.freeze({
      outcome: "deny",
      code: "PLATFORM_ADMIN_REQUIRED",
      plane: "platform",
    });
  }
  return Object.freeze({
    outcome: "allow",
    plane: "platform",
    audit: null,
  });
}

/**
 * 公司面判定。受信公司管理员上下文（信任边界 + 租户绑定）放行且不留
 * 跨面审计（动作本身的留痕由管理服务写）；平台身份（部署管理员或机器
 * 身份）需要精确绑定的显式授权，放行即产生审计事件。
 */
export function authorizeCompanyManagementAction(input: {
  readonly actor: ManagementActor;
  readonly entrance: { readonly method: string; readonly path: string };
  readonly tenantId: string;
  readonly grants: ManagementCrossGrantRegistry;
}): ManagementActionDecision {
  if (classifyManagementPlane(input.entrance) !== "company") {
    return Object.freeze({
      outcome: "deny",
      code: "MANAGEMENT_ENTRANCE_UNCLASSIFIED",
      plane: null,
    });
  }
  if (!String(input.tenantId ?? "").trim()) {
    return Object.freeze({
      outcome: "deny",
      code: "COMPANY_ADMIN_CONTEXT_REQUIRED",
      plane: "company",
    });
  }
  if (input.actor.kind === "company_admin") {
    try {
      assertTrustedAdminContext(input.actor.context);
    } catch {
      return Object.freeze({
        outcome: "deny",
        code: "COMPANY_ADMIN_CONTEXT_REQUIRED",
        plane: "company",
      });
    }
    if (input.actor.context.tenantId !== input.tenantId) {
      return Object.freeze({
        outcome: "deny",
        code: "COMPANY_ADMIN_CONTEXT_REQUIRED",
        plane: "company",
      });
    }
    return Object.freeze({
      outcome: "allow",
      plane: "company",
      audit: null,
    });
  }
  // 平台身份跨面：没有显式授权就是拒绝（fail-closed）。
  const grant = input.grants.find(
    actorSubjectOf(input.actor),
    input.tenantId,
    entranceIdOf(input.entrance),
  );
  if (!grant) {
    return Object.freeze({
      outcome: "deny",
      code: "MANAGEMENT_CROSS_AUTHORIZATION_REQUIRED",
      plane: "company",
    });
  }
  return Object.freeze({
    outcome: "allow",
    plane: "company",
    audit: Object.freeze(
      buildCrossPlaneAuditEvent(input.actor, grant, input.entrance),
    ),
  });
}

function actorSubjectOf(
  actor: Exclude<ManagementActor, { kind: "company_admin" }>,
): string {
  return actor.kind === "deployment_admin" ? actor.userId : actor.subject;
}

function entranceIdOf(entrance: { method: string; path: string }): string {
  return `${entrance.method.toUpperCase()} ${entrance.path}`;
}

// ---------------------------------------------------------------------------
// 3. 显式跨面授权登记（平台例外登记）
// ---------------------------------------------------------------------------

/**
 * 一条显式跨面授权：平台身份 subject 在公司 tenantId 上执行入口 entrance
 * 的公司管理动作。三个维度全部精确绑定（没有通配）；grantedBy/reason
 * 是留痕的最低要求。
 */
export interface ManagementCrossGrant {
  readonly grantId: string;
  /** 平台身份主体：机器身份名或部署管理员 userId。 */
  readonly subject: string;
  readonly tenantId: string;
  /** 清单 id 同形："METHOD path"，且必须分类为公司面。 */
  readonly entrance: string;
  readonly grantedBy: string;
  readonly reason: string;
}

export interface ManagementCrossGrantRegistry {
  find(
    subject: string,
    tenantId: string,
    entrance: string,
  ): ManagementCrossGrant | undefined;
}

/**
 * 显式授权登记：构造时校验每条授权（字段完整、入口确实分类为公司面），
 * 登记错误在装配期响亮失败，而不是在判定期被静默跳过。
 */
export function createManagementCrossGrantRegistry(
  grants: readonly ManagementCrossGrant[],
): ManagementCrossGrantRegistry {
  const validated = grants.map((grant, index) => {
    const invalid = (reason: string): Error =>
      new Error(`MANAGEMENT_CROSS_GRANT_INVALID[${index}]: ${reason}`);
    if (!grant || typeof grant !== "object") {
      throw invalid("grant must be an object");
    }
    if (!String(grant.grantId ?? "").trim())
      throw invalid("grantId is required");
    if (!String(grant.subject ?? "").trim())
      throw invalid("subject is required");
    if (!String(grant.tenantId ?? "").trim()) {
      throw invalid("tenantId is required");
    }
    if (!String(grant.grantedBy ?? "").trim()) {
      throw invalid("grantedBy is required");
    }
    if (!String(grant.reason ?? "").trim()) {
      throw invalid("reason is required (the audit trail is the point)");
    }
    const entrance = String(grant.entrance ?? "");
    const separator = entrance.indexOf(" ");
    if (separator <= 0)
      throw invalid(`entrance "${entrance}" is not "METHOD path"`);
    if (
      classifyManagementPlane({
        method: entrance.slice(0, separator),
        path: entrance.slice(separator + 1),
      }) !== "company"
    ) {
      throw invalid(
        `entrance "${entrance}" is not a classified company management entrance`,
      );
    }
    return grant;
  });
  return {
    find(subject, tenantId, entrance) {
      return validated.find(
        (grant) =>
          grant.subject === subject &&
          grant.tenantId === tenantId &&
          grant.entrance === entrance,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// 4. 跨面审计事件
// ---------------------------------------------------------------------------

/** 跨面审计事件类型（本模块封闭集合；撤权审计类型在 revocation.ts）。 */
export const MANAGEMENT_AUDIT_EVENT_TYPE = "management_action.cross_plane";

export interface ManagementAuditEvent {
  readonly eventId: string;
  readonly eventType: typeof MANAGEMENT_AUDIT_EVENT_TYPE;
  /** 被管理的公司。 */
  readonly tenantId: string;
  /** 被授权的公司管理入口（清单 id 同形）。 */
  readonly entrance: string;
  readonly actorKind: "platform_operator" | "deployment_admin";
  readonly actorSubject: string;
  readonly grantId: string;
  readonly grantedBy: string;
  readonly reason: string;
  readonly at: string;
}

function buildCrossPlaneAuditEvent(
  actor: Exclude<ManagementActor, { kind: "company_admin" }>,
  grant: ManagementCrossGrant,
  entrance: { method: string; path: string },
): ManagementAuditEvent {
  return Object.freeze({
    eventId: crypto.randomUUID(),
    eventType: MANAGEMENT_AUDIT_EVENT_TYPE,
    tenantId: grant.tenantId,
    entrance: entranceIdOf(entrance),
    actorKind: actor.kind,
    actorSubject: actorSubjectOf(actor),
    grantId: grant.grantId,
    grantedBy: grant.grantedBy,
    reason: grant.reason,
    at: new Date().toISOString(),
  });
}

/** The operator-role transaction an audit event is written through. */
type OperatorTransaction = Parameters<
  Parameters<import("./connections").OperatorDatabase["transaction"]>[0]
>[0];

/**
 * 把一条跨面审计事件写进 enterprise_security_events——与撤权审计
 * （revocation.ts recordRevocationAuditEvent）同一张表、同一条受限
 * operator 角色 RLS INSERT 策略（app.tenant_id + app.operation_id pin），
 * 事件类型是本模块自己的封闭集合。调用方事务必须已 pin app.tenant_id
 * （被管理的公司）；本函数 pin app.operation_id。返回无值：写入失败
 * 原样上抛，审计缺失绝不被折叠成成功。
 */
export async function recordManagementAuditEvent(
  tx: OperatorTransaction,
  event: ManagementAuditEvent,
): Promise<void> {
  if (
    !event ||
    typeof event !== "object" ||
    event.eventType !== MANAGEMENT_AUDIT_EVENT_TYPE ||
    !String(event.eventId ?? "").trim() ||
    !String(event.tenantId ?? "").trim() ||
    !String(event.entrance ?? "").trim() ||
    (event.actorKind !== "platform_operator" &&
      event.actorKind !== "deployment_admin") ||
    !String(event.actorSubject ?? "").trim() ||
    !String(event.grantId ?? "").trim() ||
    !String(event.grantedBy ?? "").trim() ||
    !String(event.reason ?? "").trim() ||
    !String(event.at ?? "").trim()
  ) {
    throw new Error("MANAGEMENT_AUDIT_EVENT_INVALID");
  }
  await tx.execute(
    sql`select set_config('app.operation_id', ${event.eventId}, true)`,
  );
  await tx.insert(enterpriseSecurityEvents).values({
    tenantId: event.tenantId,
    id: event.eventId,
    operationId: event.eventId,
    actorId: event.actorSubject,
    eventType: event.eventType,
    details: {
      entrance: event.entrance,
      actor_kind: event.actorKind,
      actor_subject: event.actorSubject,
      cross_plane_from: "platform",
      grant_id: event.grantId,
      granted_by: event.grantedBy,
      reason: event.reason,
      at: event.at,
    },
  });
}

/**
 * 跨面放行判定与审计落库的组合入口：判定放行（allow）携带的审计事件在
 * 调用方传入的同一 operator 事务内写入——写入失败原样上抛，动作随之
 * 失败。头注释「每次放行都产生一条审计事件」由此成为构造保证，而不是
 * 留给接线方的自觉：拿到 allow 却丢弃 decision.audit 的未来调用方不再
 * 存在（与撤权审计 recordRevocationAuditEvent 的判定-落库绑定同一模式）。
 * deny 原样返回，不接触事务。
 *
 * 集成状态（OCR round5 R5-2，文档披露，零行为变更）：生产代码零调用
 * （grep 实证），当前只有测试消费。意图消费方是跨面管理动作（MT019
 * 族：平台身份经显式登记跨面执行公司管理动作）的接线方。plugin-packages
 * 刻意不经它：PKG02/03/04 的写通道按 Spec 走 CompanyAdminContext
 * （assert + resolve），其域内审计是同一事务内的 enterprise_package_changes
 * 回执（PKG03/PKG04 已测），不属于本函数绑定的 enterprise_security_events
 * 跨面审计通道。首个真实跨面消费方接线时必须经此组合入口——不允许
 * 拿到 allow 却丢弃审计。
 */
export async function authorizeAndRecordCompanyManagementAction(
  input: Parameters<typeof authorizeCompanyManagementAction>[0],
  tx: OperatorTransaction,
): Promise<ManagementActionDecision> {
  const decision = authorizeCompanyManagementAction(input);
  if (decision.outcome === "allow" && decision.audit !== null) {
    await recordManagementAuditEvent(tx, decision.audit);
  }
  return decision;
}
