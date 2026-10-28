// server/src/enterprise/tenancy/team-public-rules.ts
// MT009（Issue #52）：团队公共资源动作规则。
//
// 票面语义：团队成员无需逐人授权即可**使用**明确发布为团队公共的
// Bot（read/run）与公共知识库（read），但不能编辑其配置、上传或删除
// 内容；管理动作与内容读取分别判定。
//
// 结构（纯新增，只读消费 MT008 既有出口，不改任何既有文件语义）：
//
//   1. 动作词表（TeamResourceAction）：read/run/upload/write/delete/
//      share/manage 七个显式动作 id；未知动作响亮拒绝
//      （ACTION_UNSUPPORTED），绝不映射成 deny。
//   2. 内容读取（read）委托 MT008 的 createResourcePolicyService.decide：
//      默认按资源所属租户的 policy_revision 解析（可显式覆盖）——内容
//      读取的放行语义只有一处定义（tenancy-v1 / workspace-v1 注册表），
//      本文件不复制它。
//   3. 其余动作（run/upload/write/delete/share/manage）走本模块的判定
//      事务（受限 data 角色 + 真实 RLS，事务形状与 MT008 判定入口一致：
//      read committed + lock/statement timeout → 事务本地 app.* 上下文 →
//      advisory 共享锁，键序与键形 = resource-policy 判定入口同族）。
//      团队公共使用路径的四个必要条件全部显式：
//        a. 生效策略版本（显式覆盖或租户 policy_revision）属于团队公共
//           能力集（workspace-v1，且必须在该注册表内可解析——版本缺失
//           一律 POLICY_REVISION_UNSUPPORTED 响亮拒绝，绝不猜测）；
//        b. 资源显式标记 visibility='workspace' 且 status='active'；
//        c. scope 与资源同公司同团队（跨公司引用永远拒绝）+ 版本号健全；
//        d. 请求者在资源所属团队持有 active 成员关系。
//      任一条件不成立 → { outcome: "deny", code: "RESOURCE_NOT_FOUND" }：
//      与 MT008 同款唯一拒绝形状，不泄露存在性（不存在/跨公司/跨团队/
//      未发布/版本不含团队公共路径在对外语义上不可区分）。
//   4. run 的附加规则：仅 bot 类资源可运行（read 放行绝不派生 run——
//      知识库/文档没有 run 规则，显式 read 授权更不派生 run；grants 表
//      的 CHECK 本来就只允许 'read' 授权，run 不存在逐人授权形态）。
//      通过后校验资源声明的依赖（enterprise_resource_dependencies，
//      MT009 迁移新增表）：每一行必须 status='active'；知识范围依赖的
//      引用必须解析到同租户内一个 status='active' 的资源行（RLS 过滤使
//      跨租户引用不可见＝无效）。任一依赖无效 → DEPENDENCY_INVALID 并
//      指明 dependencyKind + dependencyRef（可解释、不静默降级）；该
//      解释只发给已通过可见性门的成员——非成员在门处就得到
//      RESOURCE_NOT_FOUND，依赖的存在性与状态对其不可见。
//   5. 管理动作（upload/write/delete/share/manage）在团队公共路径上
//      一律拒绝：对已通过可见性门的成员拒绝形状是
//      TEAM_PUBLIC_ACTION_FORBIDDEN（指明动作；成员本来就能读到资源，
//      该拒绝不新增任何信息）；依赖校验不参与管理动作判定。
//
// 边界（诚实披露）：依赖有效性只回答「声明的依赖是否存活」，不做传递
// 授权重判（例如知识范围引用的资源对运行者本人是否可见）——那属于
// 后续票据的传递授权语义；本模块把这条边界钉在类型与文档上。

import { and, eq, sql } from "drizzle-orm";
import {
  enterpriseResources,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import { assertDataDatabase, type DataDatabase } from "./connections";
import {
  createResourcePolicyService,
  createShippedResourcePolicyRegistry,
  parseResourceVisibility,
  type ResourcePolicyRegistry,
  type ResourcePolicyVerdict,
  WORKSPACE_V1_POLICY_ID,
} from "./resource-policy";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 动作词表与判定形状
// ---------------------------------------------------------------------------

/** 团队公共资源动作词表：显式枚举，未知动作一律 ACTION_UNSUPPORTED。 */
export const TEAM_PUBLIC_ACTION_IDS = [
  "read",
  "run",
  "upload",
  "write",
  "delete",
  "share",
  "manage",
] as const;

export type TeamResourceAction = (typeof TEAM_PUBLIC_ACTION_IDS)[number];

/** 依赖种类：与 MT009 迁移的 CHECK 同域。 */
export type ResourceDependencyKind = "model" | "credential";

/**
 * 动作判定结果。
 *
 *   - allow：动作放行（read 形状原样透传 MT008；run 形状 = 纯 allow）。
 *   - deny + RESOURCE_NOT_FOUND：唯一的存在性隐藏拒绝——对不可见者
 *     （非成员/跨公司/未发布/版本不含团队公共路径/不存在）一切动作
 *     不可区分，绝不泄露存在性。
 *   - deny + TEAM_PUBLIC_ACTION_FORBIDDEN：已通过可见性门（必然知道
 *     资源存在）的成员请求团队公共路径不提供的动作。
 *   - deny + DEPENDENCY_INVALID：已通过可见性门的成员请求 run 而资源
 *     依赖无效——指明第一个失效依赖的种类与引用（确定性排序）。
 */
export type TeamResourceActionVerdict =
  | { readonly outcome: "allow" }
  | { readonly outcome: "deny"; readonly code: "RESOURCE_NOT_FOUND" }
  | {
      readonly outcome: "deny";
      readonly code: "TEAM_PUBLIC_ACTION_FORBIDDEN";
      readonly action: TeamResourceAction;
    }
  | {
      readonly outcome: "deny";
      readonly code: "DEPENDENCY_INVALID";
      readonly dependencyKind: ResourceDependencyKind;
      readonly dependencyRef: string;
    };

const DENY_NOT_FOUND: TeamResourceActionVerdict = Object.freeze({
  outcome: "deny",
  code: "RESOURCE_NOT_FOUND",
});

const forbidden = (action: TeamResourceAction): TeamResourceActionVerdict =>
  Object.freeze({
    outcome: "deny",
    code: "TEAM_PUBLIC_ACTION_FORBIDDEN",
    action,
  });

/**
 * 团队公共能力集：哪些已注册策略版本携带「团队公共使用路径」。workspace-v1
 * 是 Issue #51/52 授权的第一个版本；未来版本在此显式追加，绝不隐式放宽。
 */
const TEAM_PUBLIC_CAPABLE_POLICY_VERSIONS: readonly string[] = [
  WORKSPACE_V1_POLICY_ID,
];

/** run 动作只对 bot 类资源存在；知识库与文档没有 run 规则。 */
const RUNNABLE_RESOURCE_KINDS: readonly string[] = ["bot"];

interface TeamResourceFacts {
  readonly scope: {
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly principalId: string;
  };
  readonly tenantPolicyRevision: string;
  readonly resource: {
    readonly tenantId: string | null;
    readonly workspaceId: string | null;
    readonly kind: string | null;
    readonly visibility: ReturnType<typeof parseResourceVisibility>;
    readonly status: "active" | "deleted" | null;
    readonly revision: number | null;
    readonly aclEpoch: number | null;
  };
  readonly workspaceMembership: {
    readonly status: "active" | "suspended" | null;
  };
}

/** 事务句柄类型（与 resource-policy 判定入口同一形状的本地别名）。 */
type DataTx = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];

/** 版本号健全性（与 MT008 判定入口同一不变量的本地镜像）。 */
function revisionsAreSane(facts: TeamResourceFacts): boolean {
  return (
    Number.isSafeInteger(facts.resource.revision) &&
    facts.resource.revision !== null &&
    facts.resource.revision >= 1 &&
    Number.isSafeInteger(facts.resource.aclEpoch) &&
    facts.resource.aclEpoch !== null &&
    facts.resource.aclEpoch >= 1
  );
}

/**
 * 纯判定（依赖检查之前的部分）：输入事实 + 生效策略版本，输出要么是
 * 终局判定，要么是「需要依赖检查」（run 的剩余规则）。与数据库完全
 * 解耦，可被测试在伪造事实层面逐条件钉死（跨租户防线因此有独立于
 * RLS 的用例）。
 */
export type TeamPublicActionDecision =
  | { readonly kind: "verdict"; readonly verdict: TeamResourceActionVerdict }
  | { readonly kind: "requires-dependency-check" };

export function decideTeamPublicActionWithoutDependencies(
  action: TeamResourceAction,
  facts: TeamResourceFacts,
  effectiveVersion: string,
  registry: Pick<
    ResourcePolicyRegistry,
    "has"
  > = createShippedResourcePolicyRegistry(),
): TeamPublicActionDecision {
  // (a) 版本门：生效版本必须属于团队公共能力集且在注册表内可解析。
  if (!registry.has(effectiveVersion)) {
    throw new Error("POLICY_REVISION_UNSUPPORTED");
  }
  if (!TEAM_PUBLIC_CAPABLE_POLICY_VERSIONS.includes(effectiveVersion)) {
    return { kind: "verdict", verdict: DENY_NOT_FOUND };
  }

  // (b)-(d) 团队公共可见性门：显式发布、活跃、同公司同团队、版本健全、
  // 成员有效。任一不成立即不可见（不泄露存在性）。显式 read 授权绝不
  // 参与这道门——授权路径不派生团队公共使用路径。
  if (
    facts.resource.visibility !== "workspace" ||
    facts.resource.status !== "active" ||
    facts.resource.tenantId !== facts.scope.tenantId ||
    facts.resource.workspaceId !== facts.scope.workspaceId ||
    !revisionsAreSane(facts) ||
    facts.workspaceMembership.status !== "active"
  ) {
    return { kind: "verdict", verdict: DENY_NOT_FOUND };
  }

  // 管理动作：团队公共使用路径一律不提供（编辑配置、上传、删除、分享、
  // 管理范围都不是成员使用路径的一部分）。
  if (action !== "run") {
    return { kind: "verdict", verdict: forbidden(action) };
  }

  // run：仅 bot 类；依赖有效性由调用方在事实源内继续校验。
  if (
    facts.resource.kind === null ||
    !RUNNABLE_RESOURCE_KINDS.includes(facts.resource.kind)
  ) {
    return { kind: "verdict", verdict: forbidden(action) };
  }
  return { kind: "requires-dependency-check" };
}

// ---------------------------------------------------------------------------
// 判定服务
// ---------------------------------------------------------------------------

export interface TeamResourceActionService {
  /**
   * 逐动作判定。`options.policyVersion` 缺省时按资源所属租户的
   * policy_revision 解析（read 的委托与此处使用同一解析规则）。
   */
  decideAction(
    scope: PlatformScope,
    resourceId: string,
    action: TeamResourceAction,
    options?: { readonly policyVersion?: string },
  ): Promise<TeamResourceActionVerdict>;
}

/**
 * 装配入口。`registry` 缺省用已发布注册表（tenancy-v1 + workspace-v1）；
 * read 委托与团队公共能力集解析共用同一个注册表实例，测试注入受限
 * 注册表时两条路径的版本视野保持一致。
 */
export function createTeamResourceActionService(
  data: DataDatabase,
  registry: ResourcePolicyRegistry = createShippedResourcePolicyRegistry(),
): TeamResourceActionService {
  assertDataDatabase(data);
  const policy = createResourcePolicyService(data, registry);
  return {
    async decideAction(scope, resourceId, action, options) {
      // 信任边界：只有签发入口产出的 Scope 能进入判定。
      assertTrustedScope(scope);
      if (!TEAM_PUBLIC_ACTION_IDS.includes(action)) {
        throw new Error("ACTION_UNSUPPORTED");
      }

      // 内容读取与管理动作分别判定：read 的放行语义只有 MT008 注册表
      // 一处定义，这里原样透传（含其唯一拒绝形状与版本解析规则）。
      if (action === "read") {
        const verdict: ResourcePolicyVerdict = await policy.decide(
          scope,
          resourceId,
          options?.policyVersion
            ? { policyVersion: options.policyVersion }
            : undefined,
        );
        return verdict;
      }

      return actionRulesTransaction(data, scope, resourceId, async (tx) => {
        // 判定事实全部经受限 data 角色与真实 RLS 读取：跨公司资源行对
        // 本事务不可见（事实即为「不存在」），随后的租户/团队比对是
        // 第二道独立防线（纵深防御）。
        const [row] = await tx
          .select({
            policyRevision: enterpriseTenants.policyRevision,
            resourceTenantId: enterpriseResources.tenantId,
            resourceWorkspaceId: enterpriseResources.workspaceId,
            resourceKind: enterpriseResources.kind,
            visibility: enterpriseResources.visibility,
            status: enterpriseResources.status,
            revision: enterpriseResources.revision,
            aclEpoch: enterpriseResources.aclEpoch,
            membershipStatus: enterpriseWorkspaceMemberships.status,
          })
          .from(enterpriseTenants)
          .leftJoin(
            enterpriseResources,
            and(
              eq(enterpriseResources.tenantId, enterpriseTenants.id),
              eq(enterpriseResources.id, resourceId),
            ),
          )
          .leftJoin(
            enterpriseWorkspaceMemberships,
            and(
              eq(enterpriseWorkspaceMemberships.tenantId, enterpriseTenants.id),
              eq(enterpriseWorkspaceMemberships.workspaceId, scope.workspaceId),
              eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
            ),
          )
          .where(eq(enterpriseTenants.id, scope.tenantId))
          .limit(1);
        // 受信 Scope 必然对应一家存在且活跃过的租户；租户行缺失（撤权
        // 竞态）按拒绝处理——绝不放宽。判定事实全部经受限 data 角色与
        // 真实 RLS 读取：跨公司资源行对本事务不可见（事实即为「不存在」），
        // 纯判定内的租户/团队比对是第二道独立防线（纵深防御）。
        if (!row) return DENY_NOT_FOUND;
        const facts: TeamResourceFacts = {
          scope: {
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
          },
          tenantPolicyRevision: row.policyRevision,
          resource: {
            tenantId: row.resourceTenantId ?? null,
            workspaceId: row.resourceWorkspaceId ?? null,
            kind: row.resourceKind ?? null,
            visibility: parseResourceVisibility(row.visibility),
            status:
              (row.status as TeamResourceFacts["resource"]["status"]) ?? null,
            revision: row.revision ?? null,
            aclEpoch: row.aclEpoch ?? null,
          },
          workspaceMembership: {
            status: (row.membershipStatus ??
              null) as TeamResourceFacts["workspaceMembership"]["status"],
          },
        };

        // 生效版本 = 显式覆盖 ?? 租户 policy_revision（read 的委托与此
        // 使用同一解析规则）。门规则在纯函数中，可独立于 RLS 被伪造
        // 事实逐条件钉死。
        const effectiveVersion =
          options?.policyVersion ?? facts.tenantPolicyRevision;
        const decision = decideTeamPublicActionWithoutDependencies(
          action,
          facts,
          effectiveVersion,
          registry,
        );
        if (decision.kind === "verdict") {
          return decision.verdict;
        }

        // run 的剩余规则：全部依赖必须有效（不静默降级）。
        const invalid = await firstInvalidDependency(
          tx,
          scope.tenantId,
          resourceId,
        );
        if (invalid) {
          return Object.freeze({
            outcome: "deny",
            code: "DEPENDENCY_INVALID",
            dependencyKind: invalid.kind,
            dependencyRef: invalid.ref,
          });
        }
        return Object.freeze({ outcome: "allow" });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 依赖有效性（MT009 迁移新增表；schema 文件本票不动，raw SQL 读取）
// ---------------------------------------------------------------------------

interface DependencyRow {
  readonly dependency_kind: string;
  readonly dependency_ref: string;
  readonly status: string;
}

/**
 * 返回第一条失效依赖（kind/ref 确定性排序），全部有效时返回 null。
 * 知识范围依赖的引用必须解析到同租户内一个活跃资源行——RLS 使跨租户
 * 引用不可见（＝无效），软删除（status='deleted'）同样无效。
 */
async function firstInvalidDependency(
  tx: DataTx,
  tenantId: string,
  resourceId: string,
): Promise<{ kind: ResourceDependencyKind; ref: string } | null> {
  const result = (await tx.execute(sql`
    select dependency_kind, dependency_ref, status
    from enterprise_resource_dependencies
    where tenant_id = ${tenantId} and resource_id = ${resourceId}
    order by dependency_kind asc, dependency_ref asc
  `)) as unknown as DependencyRow[] | { rows?: DependencyRow[] };
  // 驱动结果归一（bun-sql/node-postgres 两形状，public-bot-profiles 同款）：
  // 直接 for...of {rows} 包装对象会 TypeError，判定入口直接 500。
  const dependencyRows = Array.isArray(result) ? result : (result?.rows ?? []);
  for (const row of dependencyRows) {
    if (row.status !== "active") {
      return {
        kind: row.dependency_kind as ResourceDependencyKind,
        ref: row.dependency_ref,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 判定事务：形状与 MT008 判定入口一致（纵深防御的同一键族）
// ---------------------------------------------------------------------------

async function actionRulesTransaction<T>(
  data: DataDatabase,
  scope: PlatformScope,
  resourceId: string,
  operation: (tx: DataTx) => Promise<T>,
): Promise<T> {
  return data.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    /* Transaction-local settings are defense in depth for RLS and are cleared on commit. */
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true)`,
    );
    // 锁序：tenant → principal → membership → workspace-membership →
    // resource（与 resource-policy 判定入口同一键序与键形，共享锁）。
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
      JSON.stringify(["enterprise", "resource", scope.tenantId, resourceId]),
    ]) {
      await tx.execute(
        sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
      );
    }
    return operation(tx);
  });
}
