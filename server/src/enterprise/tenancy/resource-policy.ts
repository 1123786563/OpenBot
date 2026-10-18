// server/src/enterprise/tenancy/resource-policy.ts
// MT008（Issue #51）：资源可见性属性与策略版本注册表 + 判定入口。
//
// 结构（三件事，全部纯追加，不触碰 MT005 seam 语义）：
//
//   1. 策略版本注册表（createResourcePolicyRegistry）：显式注册、显式
//      解析；未注册的版本一律 POLICY_REVISION_UNSUPPORTED（与
//      authz/service.ts 的既有语义一致）。tenancy-v1（在位版本：判定
//      = authz.check 的等价复刻，可见性完全不参与）与 workspace-v1
//      （新版本 = tenancy-v1 判定 ∪ {团队公共放行}，绝不更窄）是两个
//      独立注册的版本对象，注册新版本不改变旧版本任何判定。
//   2. 判定入口（createResourcePolicyService.decide）：受信 Scope
//      （createScopeResolver 签发）→ 数据事务（read committed +
//      lock/statement timeout → set_config('app.*', …, true) 事务本地 →
//      advisory 共享锁，键序与键形 = store.readLockKeys ∪
//      scope-gate.workspaceMembershipLockKey：tenant → principal →
//      membership → workspace-membership → resource）→ 受限 data 角色下
//      经真实 RLS 读判定事实 → 注册表求值。deny 只有一种对外形状
//      { outcome: "deny", code: "RESOURCE_NOT_FOUND" }——不存在、跨公司、
//      跨团队、无授权、已删除在对外语义上不可区分（不泄露存在性）。
//   3. 可见性属性读取（parseResourceVisibility）：DB 值 → 类型；取值域
//      外的值属于不变量破坏，响亮拒绝。
//
// 裁决 #2（MT005）边界：本文件引入 workspace-v1 是 Issue #51 票面授权的
// 新策略版本；tenancy-v1 的语义保持不变（对照测试逐例钉死），且本文件
// 不改动 store.ts / scope-gate.ts 的任何既有导出语义。

import { and, eq, sql } from "drizzle-orm";
import {
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import { assertDataDatabase, type DataDatabase } from "./connections";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 可见性属性
// ---------------------------------------------------------------------------

/** 资源可见性：'private' = 个人，'workspace' = 团队公共；null = 未标记（遗留）。 */
export type ResourceVisibility = "private" | "workspace";

/**
 * Reads one visibility attribute value (as stored). Anything outside
 * { null, 'private', 'workspace' } breaks the database CHECK — an invariant
 * violation that must fail loudly, never silently default.
 */
export function parseResourceVisibility(
  value: unknown,
): ResourceVisibility | null {
  if (value === null || value === undefined) return null;
  if (value === "private" || value === "workspace") return value;
  throw new Error("RESOURCE_VISIBILITY_INVALID");
}

// ---------------------------------------------------------------------------
// 判定事实与判定形状
// ---------------------------------------------------------------------------

/** The subset of PlatformScope the policy decides on. */
export interface ResourcePolicyScope {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly actorId: string;
}

/** Everything a policy version needs to decide one resource read. */
export interface ResourcePolicyFacts {
  readonly scope: ResourcePolicyScope;
  readonly resource: {
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly id: string;
    /** null = 未标记（遗留资源，既有行为）。 */
    readonly visibility: ResourceVisibility | null;
    /** null = 行不可见（RLS 拦截或不存在）——与 deleted 同为拒绝。 */
    readonly status: "active" | "deleted" | null;
    readonly revision: number | null;
    readonly aclEpoch: number | null;
    /** 资源所属租户的策略版本（decide 的默认解析来源）。 */
    readonly policyRevision: string;
  };
  /** scope.principalId 对该资源是否持有显式 read 授权。 */
  readonly grant: { readonly read: boolean };
  /** scope.principalId 在资源所属团队（按 scope 选择）的成员状态。 */
  readonly workspaceMembership: {
    readonly status: "active" | "suspended" | null;
  };
}

/**
 * 判定结果。deny 只有一种形状——code 恒为 RESOURCE_NOT_FOUND，任何拒绝
 * 原因（不存在/跨公司/跨团队/无授权/已删除/成员停用）在对外语义上
 * 不可区分：不泄露存在性。
 */
export type ResourcePolicyVerdict =
  | { readonly outcome: "allow" }
  | { readonly outcome: "deny"; readonly code: "RESOURCE_NOT_FOUND" };

const ALLOW_VERDICT: ResourcePolicyVerdict = Object.freeze({
  outcome: "allow",
});
const DENY_VERDICT: ResourcePolicyVerdict = Object.freeze({
  outcome: "deny",
  code: "RESOURCE_NOT_FOUND",
});

// ---------------------------------------------------------------------------
// 策略版本：tenancy-v1（在位语义）与 workspace-v1（新版本）
// ---------------------------------------------------------------------------

export interface ResourcePolicyVersion {
  readonly id: string;
  readonly description: string;
  decide(facts: ResourcePolicyFacts): ResourcePolicyVerdict;
}

export const TENANCY_V1_POLICY_ID = "tenancy-v1";
export const WORKSPACE_V1_POLICY_ID = "workspace-v1";

function revisionsAreSane(facts: ResourcePolicyFacts): boolean {
  return (
    Number.isSafeInteger(facts.resource.revision) &&
    facts.resource.revision !== null &&
    facts.resource.revision >= 1 &&
    Number.isSafeInteger(facts.resource.aclEpoch) &&
    facts.resource.aclEpoch !== null &&
    facts.resource.aclEpoch >= 1
  );
}

/** tenancy-v1 判定 = authz/service.ts createAuthz().check 的等价复刻。 */
function tenancyV1Decide(facts: ResourcePolicyFacts): ResourcePolicyVerdict {
  const { scope, resource, grant } = facts;
  if (resource.status !== "active") return DENY_VERDICT;
  if (scope.tenantId !== resource.tenantId) return DENY_VERDICT;
  if (scope.workspaceId !== resource.workspaceId) return DENY_VERDICT;
  if (!revisionsAreSane(facts)) return DENY_VERDICT;
  // 可见性属性完全不参与：未标记/私有/团队公共在旧版本下都只看授权。
  if (grant.read !== true) return DENY_VERDICT;
  return ALLOW_VERDICT;
}

/**
 * workspace-v1 判定 = tenancy-v1 判定 ∪ {团队公共放行}：
 *
 *   - 先按旧版本判定（跨公司/跨团队/无授权等一切旧拒绝原样保留）；
 *   - 旧版本已放行 → 放行（绝不更窄：授权路径不受成员状态影响）；
 *   - 唯一新增放行：资源显式标记 'workspace' 且请求者在同一团队持有
 *     有效成员关系。跨公司引用在这一步之前就已被拒绝——永远拒绝。
 */
function workspaceV1Decide(facts: ResourcePolicyFacts): ResourcePolicyVerdict {
  const baseline = tenancyV1Decide(facts);
  if (baseline.outcome === "allow") return baseline;
  const { scope, resource, workspaceMembership } = facts;
  if (resource.visibility !== "workspace") return DENY_VERDICT;
  if (resource.status !== "active") return DENY_VERDICT;
  // 跨公司永远拒绝（Issue #51 验收 4）：即使有授权、即使团队公共。
  if (scope.tenantId !== resource.tenantId) return DENY_VERDICT;
  if (scope.workspaceId !== resource.workspaceId) return DENY_VERDICT;
  if (!revisionsAreSane(facts)) return DENY_VERDICT;
  if (workspaceMembership.status !== "active") return DENY_VERDICT;
  return ALLOW_VERDICT;
}

/** 在位策略版本：语义与 authz/service.ts 完全一致（可见性不参与判定）。 */
export const tenancyV1ResourcePolicy: ResourcePolicyVersion = Object.freeze({
  id: TENANCY_V1_POLICY_ID,
  description:
    "tenancy-v1：既有授权语义——显式 read 授权 + 同租户同团队 + 活跃资源；可见性属性不参与判定。",
  decide: tenancyV1Decide,
});

/**
 * 新策略版本：独立注册。在 tenancy-v1 全部判定的基础上，唯一新增
 * 「团队公共」放行（visibility='workspace' + 有效团队成员）。
 */
export const workspaceV1ResourcePolicy: ResourcePolicyVersion = Object.freeze({
  id: WORKSPACE_V1_POLICY_ID,
  description:
    "workspace-v1：tenancy-v1 判定 ∪ {团队公共放行：visibility='workspace' 且同团队有效成员}；绝不更窄；跨公司永远拒绝。",
  decide: workspaceV1Decide,
});

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

export interface ResourcePolicyRegistry {
  /** 独立注册一个策略版本；重复 id 响亮拒绝。 */
  register(version: ResourcePolicyVersion): void;
  has(policyVersionId: string): boolean;
  registeredVersions(): readonly string[];
  /** 未注册的版本一律 POLICY_REVISION_UNSUPPORTED（与 authz 语义一致）。 */
  evaluate(
    policyVersionId: string,
    facts: ResourcePolicyFacts,
  ): ResourcePolicyVerdict;
}

/** 空注册表：注册与解析完全显式，无隐式默认。 */
export function createResourcePolicyRegistry(): ResourcePolicyRegistry {
  const versions = new Map<string, ResourcePolicyVersion>();
  return Object.freeze({
    register(version: ResourcePolicyVersion): void {
      if (
        !version ||
        typeof version !== "object" ||
        typeof version.id !== "string" ||
        !version.id.trim() ||
        typeof version.decide !== "function"
      ) {
        throw new Error("POLICY_VERSION_INVALID");
      }
      if (versions.has(version.id)) {
        throw new Error("POLICY_VERSION_ALREADY_REGISTERED");
      }
      versions.set(version.id, version);
    },
    has(policyVersionId: string): boolean {
      return versions.has(policyVersionId);
    },
    registeredVersions(): readonly string[] {
      return [...versions.keys()];
    },
    evaluate(
      policyVersionId: string,
      facts: ResourcePolicyFacts,
    ): ResourcePolicyVerdict {
      const version = versions.get(policyVersionId);
      if (!version) throw new Error("POLICY_REVISION_UNSUPPORTED");
      return version.decide(facts);
    },
  });
}

/** 生产装配套件：两个已发布版本都已注册（租户经 policy_revision 选择）。 */
export function createShippedResourcePolicyRegistry(): ResourcePolicyRegistry {
  const registry = createResourcePolicyRegistry();
  registry.register(tenancyV1ResourcePolicy);
  registry.register(workspaceV1ResourcePolicy);
  return registry;
}

// ---------------------------------------------------------------------------
// 判定入口：受信 Scope → 受限角色事务 → 事实读取 → 注册表求值
// ---------------------------------------------------------------------------

export interface ResourcePolicyDecisionService {
  /**
   * Decides one resource read for a trusted scope. The policy version is the
   * explicit option when given, otherwise the resource's tenant's own
   * policy_revision (resolution). Denied reads all surface identically as
   * { outcome: "deny", code: "RESOURCE_NOT_FOUND" }.
   */
  decide(
    scope: PlatformScope,
    resourceId: string,
    options?: { readonly policyVersion?: string },
  ): Promise<ResourcePolicyVerdict>;
}

/** 事务本地上下文 + advisory 共享锁（键序/键形与既有两处 seam 一致）。 */
async function policyReadTransaction<T>(
  data: DataDatabase,
  scope: PlatformScope,
  resourceId: string,
  operation: (
    tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0],
  ) => Promise<T>,
): Promise<T> {
  return data.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    /* Transaction-local settings are defense in depth for RLS and are cleared on commit. */
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true)`,
    );
    // 锁序：tenant → principal → membership → workspace-membership → resource
    //（store.readLockKeys 与 scope-gate 的同一键族，resource 键在前者共享）。
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

/**
 * 判定服务。事实读取全部经受限 data 角色与真实 RLS：跨公司资源行对
 * 本事务不可见（事实即为「不存在」），注册表内的租户比对是第二道
 * 独立防线（纵深防御）。
 */
export function createResourcePolicyService(
  data: DataDatabase,
  registry: ResourcePolicyRegistry = createShippedResourcePolicyRegistry(),
): ResourcePolicyDecisionService {
  assertDataDatabase(data);
  return {
    async decide(scope, resourceId, options) {
      // 信任边界：只有签发入口产出的 Scope 能进入判定。
      assertTrustedScope(scope);
      return policyReadTransaction(data, scope, resourceId, async (tx) => {
        const [row] = await tx
          .select({
            policyRevision: enterpriseTenants.policyRevision,
            resourceTenantId: enterpriseResources.tenantId,
            resourceWorkspaceId: enterpriseResources.workspaceId,
            resourceId: enterpriseResources.id,
            visibility: enterpriseResources.visibility,
            status: enterpriseResources.status,
            revision: enterpriseResources.revision,
            aclEpoch: enterpriseResources.aclEpoch,
            grantPrincipalId: enterpriseResourceGrants.principalId,
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
            enterpriseResourceGrants,
            and(
              eq(enterpriseResourceGrants.tenantId, enterpriseTenants.id),
              eq(enterpriseResourceGrants.resourceId, resourceId),
              eq(enterpriseResourceGrants.principalId, scope.principalId),
              eq(enterpriseResourceGrants.action, "read"),
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
        // 竞态）按拒绝处理——绝不放宽。
        if (!row) return DENY_VERDICT;
        const facts: ResourcePolicyFacts = {
          scope: {
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
            actorId: scope.actorId,
          },
          resource: {
            tenantId: row.resourceTenantId ?? scope.tenantId,
            workspaceId: row.resourceWorkspaceId ?? "",
            id: row.resourceId ?? resourceId,
            visibility: parseResourceVisibility(row.visibility),
            status:
              (row.status as ResourcePolicyFacts["resource"]["status"]) ?? null,
            revision: row.revision ?? null,
            aclEpoch: row.aclEpoch ?? null,
            policyRevision: row.policyRevision,
          },
          grant: { read: row.grantPrincipalId != null },
          workspaceMembership: {
            status: (row.membershipStatus ??
              null) as ResourcePolicyFacts["workspaceMembership"]["status"],
          },
        };
        const version = options?.policyVersion ?? facts.resource.policyRevision;
        return registry.evaluate(version, facts);
      });
    },
  };
}
