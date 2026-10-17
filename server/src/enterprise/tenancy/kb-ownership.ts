// server/src/enterprise/tenancy/kb-ownership.ts
// MT036（Issue #79）：知识库团队归属的主库侧权威与跨库同步约定。
//
// 票面：每个知识库固定公司与团队归属，查询只返回有权范围内的库与文档；主库
// 与知识库是两个独立数据库，一致性由调用时授权与同步版本保证，不声称存在
// 跨库外键。
//
// 结构（纯新增；对既有交付只读消费——resource-policy 注册表、not-found
// 语义、scope 信任边界、连接验证全部按冻结导出复用）：
//
//   1. KB 注册 = 主库 enterprise_resources 行（kind='knowledge'）。授权判定
//      与 MT008 decide() 完全同构：受信 Scope → read committed + lock/
//      statement timeout → 事务本地 app.* → advisory 共享锁（tenant →
//      principal → membership → workspace-membership → resource 同键族）→
//      受限 data 角色经真实 RLS 读事实 → 同一注册表求值。deny 只有一种
//      canonical 形状（not-found-semantics 的 RESOURCE_NOT_FOUND）——不存在、
//      跨公司、跨团队、无授权、已删除、非 knowledge kind 对外不可区分。
//   2. 列表 = decide 的复数形态（MT011 同款）：候选行按 scope 租户/团队 +
//      kind 过滤一次受限读取，逐行经同一注册表求值，只保留 allow。可见 KB
//      集合先于任何检索确定（Spec §6：先定允许集合，再在检索端限制）。
//   3. 同步版本（跨库一致性约定）：kbSyncVersionOf 把注册事实折叠成确定性
//      版本令牌 kb-sync/v1/w=<workspaceId>/r=<revision>/e=<aclEpoch>；KB 侧
//      必须镜像该令牌。compareKbOwnershipSnapshot 在授权放行之后、内容返回
//      之前逐次比对（调用时，无缓存）：镜像缺失/租户不符 → KB_OWNERSHIP_
//      MISSING；团队不符 → KB_OWNERSHIP_WORKSPACE_MISMATCH；版本不符 →
//      KB_SYNC_VERSION_STALE。归属变更（迁移或团队调整）推进 revision 后，
//      未同步的镜像在下一次调用即被拒绝——变更立即反映，不依赖失效通知。
//   4. 信任边界：assertTrustedScope 只放行 seam 签发的 Scope。KB 内部服务
//      身份（API-Key 的 tenantId+role+kbScope）没有 principal/团队事实，
//      结构上进不了本模块，更不可能借它获得公司全域知识范围。
//
// 边界（诚实披露）：
//   - 本模块是主库侧权威与约定；KB 库侧受限查询入口在
//     server/src/kb/application/service/kb-restricted-query.ts（消费本模块）。
//   - 归属变更的写入路径（管理动作 API）属后续管理票；测试经 operator 角色
//     策略内 UPDATE（app.tenant_id + app.resource_id 行策略）执行，与既有
//     夹具先例一致。
//   - 列表/授权不做传递依赖重判：MT009 依赖行的存活校验是 run 动作的前置
//     面；本模块补上的是「引用对运行者本人可见」的调用时收窄（检索入口）。

import { and, asc, eq, sql } from "drizzle-orm";
import {
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import { assertDataDatabase, type DataDatabase } from "./connections";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import {
  createShippedResourcePolicyRegistry,
  type ResourcePolicyFacts,
  type ResourcePolicyRegistry,
  type ResourceVisibility,
} from "./resource-policy";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

/** 主库侧知识库注册的资源 kind 词汇（MT009 依赖表 kind='knowledge' 同源）。 */
export const KNOWLEDGE_RESOURCE_KIND = "knowledge";

/** 授权放行后随行的注册事实（跨库一致性比对的左侧）。 */
export interface KbOwnershipRegistration {
  readonly tenantId: string;
  readonly kbId: string;
  readonly workspaceId: string;
  readonly status: "active" | "deleted" | null;
  readonly visibility: ResourceVisibility | null;
  readonly revision: number | null;
  readonly aclEpoch: number | null;
  /** 资源所属租户的策略版本（判定默认解析来源，原样随行）。 */
  readonly policyRevision: string;
}

export type KbOwnershipDecision =
  | {
      readonly outcome: "allow";
      readonly registration: KbOwnershipRegistration;
    }
  | { readonly outcome: "deny"; readonly code: "RESOURCE_NOT_FOUND" };

// ---------------------------------------------------------------------------
// 同步版本令牌与一致性比对（纯函数面）
// ---------------------------------------------------------------------------

/** kbSyncVersionOf 的最小输入（注册事实的归属/版本子集）。 */
export type KbSyncVersionInputs = {
  readonly workspaceId: string;
  readonly revision: number | null;
  readonly aclEpoch: number | null;
};

function assertSyncInputs(inputs: KbSyncVersionInputs): void {
  if (
    typeof inputs.workspaceId !== "string" ||
    inputs.workspaceId.trim() === "" ||
    !Number.isSafeInteger(inputs.revision) ||
    inputs.revision === null ||
    inputs.revision < 1 ||
    !Number.isSafeInteger(inputs.aclEpoch) ||
    inputs.aclEpoch === null ||
    inputs.aclEpoch < 1
  ) {
    throw new Error("KB_SYNC_INPUT_INVALID");
  }
}

/**
 * 同步版本令牌：KB 侧必须镜像的确定性版本。任何成分变化都改变令牌——
 * 归属迁移（workspaceId）与版本推进（revision/aclEpoch）都立即失效旧镜像。
 */
export function kbSyncVersionOf(inputs: KbSyncVersionInputs): string {
  assertSyncInputs(inputs);
  return Object.freeze(
    `kb-sync/v1/w=${inputs.workspaceId}/r=${inputs.revision}/e=${inputs.aclEpoch}`,
  );
}

/** KB 侧归属镜像行必须携带的最小事实（knowledge_base_ownership_states）。 */
export type KbOwnershipSnapshot = {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly syncVersion: string;
};

export type KbSyncComparison =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "KB_OWNERSHIP_MISSING"
        | "KB_OWNERSHIP_WORKSPACE_MISMATCH"
        | "KB_SYNC_VERSION_STALE";
    };

/**
 * 一致性比对（纯函数，冻结结果，零值回显）：只在授权放行之后调用——
 * 请求者已被告知存在性，因此这里给出可行动的确定性拒绝码而非不可见语义。
 * 镜像缺失与租户不符同码（KB_OWNERSHIP_MISSING）：两者都意味着「KB 侧没有
 * 可信的归属镜像」，一律拒绝放行。
 */
export function compareKbOwnershipSnapshot(
  registration: Pick<
    KbOwnershipRegistration,
    "tenantId" | "workspaceId" | "revision" | "aclEpoch"
  >,
  snapshot: KbOwnershipSnapshot | null | undefined,
): KbSyncComparison {
  if (
    snapshot === null ||
    snapshot === undefined ||
    snapshot.tenantId !== registration.tenantId
  ) {
    return Object.freeze({
      ok: false as const,
      code: "KB_OWNERSHIP_MISSING" as const,
    });
  }
  if (snapshot.workspaceId !== registration.workspaceId) {
    return Object.freeze({
      ok: false as const,
      code: "KB_OWNERSHIP_WORKSPACE_MISMATCH" as const,
    });
  }
  if (snapshot.syncVersion !== kbSyncVersionOf(registration)) {
    return Object.freeze({
      ok: false as const,
      code: "KB_SYNC_VERSION_STALE" as const,
    });
  }
  return Object.freeze({ ok: true as const });
}

// ---------------------------------------------------------------------------
// 权威服务：受信 Scope → 受限角色事务 → 事实读取 → 注册表求值
// ---------------------------------------------------------------------------

interface RegistrationRow {
  readonly policyRevision: string;
  readonly resourceTenantId: string;
  readonly resourceWorkspaceId: string;
  readonly resourceId: string;
  readonly visibility: string | null;
  readonly status: "active" | "deleted" | null;
  readonly revision: number | null;
  readonly aclEpoch: number | null;
  readonly grantPrincipalId: string | null;
  readonly membershipStatus: "active" | "suspended" | null;
}

type DataTx = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];

function toRegistration(row: RegistrationRow): KbOwnershipRegistration | null {
  if (
    row.resourceTenantId === null ||
    row.resourceWorkspaceId === null ||
    row.status === null ||
    row.revision === null ||
    row.aclEpoch === null
  ) {
    return null;
  }
  if (
    row.visibility !== null &&
    row.visibility !== "private" &&
    row.visibility !== "workspace"
  ) {
    return null;
  }
  return {
    tenantId: row.resourceTenantId,
    kbId: row.resourceId,
    workspaceId: row.resourceWorkspaceId,
    status: row.status,
    visibility: row.visibility,
    revision: row.revision,
    aclEpoch: row.aclEpoch,
    policyRevision: row.policyRevision,
  };
}

function rowToFacts(
  row: RegistrationRow,
  scope: PlatformScope,
  registration: KbOwnershipRegistration,
): ResourcePolicyFacts {
  return {
    scope: {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      principalId: scope.principalId,
      actorId: scope.actorId,
    },
    resource: {
      tenantId: registration.tenantId,
      workspaceId: registration.workspaceId,
      id: registration.kbId,
      visibility: registration.visibility,
      status: registration.status,
      revision: registration.revision,
      aclEpoch: registration.aclEpoch,
      policyRevision: registration.policyRevision,
    },
    grant: { read: row.grantPrincipalId !== null },
    workspaceMembership: { status: row.membershipStatus },
  };
}

function selectionShape() {
  return {
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
  };
}

/** 事务本地上下文 + advisory 共享锁（MT008/MT011 同键族同键序）。 */
async function kbReadTransaction<T>(
  data: DataDatabase,
  scope: PlatformScope,
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
    // 锁序：tenant → principal → membership → workspace-membership（与
    // store.readLockKeys ∪ scope-gate.workspaceMembershipLockKey 同键族）。
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
    return operation(tx);
  });
}

function assertKbId(kbId: string): string {
  if (typeof kbId !== "string" || kbId.trim() === "") {
    throw new Error("KB_ID_REQUIRED");
  }
  return kbId;
}

export interface KbOwnershipAuthority {
  /**
   * 单库调用时授权。deny = canonical 不可见语义（与全系统唯一 not-found
   * 形状逐字节一致）；allow 随行注册事实供跨库一致性比对。
   */
  authorizeKnowledgeBase(
    scope: PlatformScope,
    kbId: string,
  ): Promise<KbOwnershipDecision>;
  /**
   * 当前 scope 的可见 KB 注册列表（decide 的复数形态；先定允许集合，
   * 再在检索端限制）。跨团队/跨公司/无授权行不出现，计数不泄露存在性。
   */
  listVisibleKnowledgeBaseRegistrations(
    scope: PlatformScope,
  ): Promise<readonly KbOwnershipRegistration[]>;
}

/**
 * 权威服务。事实读取全部经受限 data 角色与真实 RLS：跨公司资源行对本事务
 * 不可见（事实即为「不存在」），注册表内的租户/团队比对是第二道独立防线
 * （纵深防御）。
 */
export function createKbOwnershipAuthority(
  data: DataDatabase,
  registry: ResourcePolicyRegistry = createShippedResourcePolicyRegistry(),
): KbOwnershipAuthority {
  assertDataDatabase(data);
  return {
    async authorizeKnowledgeBase(scope, kbId) {
      assertTrustedScope(scope);
      assertKbId(kbId);
      return kbReadTransaction(data, scope, async (tx) => {
        const [row] = (await tx
          .select(selectionShape())
          .from(enterpriseResources)
          .innerJoin(
            enterpriseTenants,
            eq(enterpriseTenants.id, enterpriseResources.tenantId),
          )
          .leftJoin(
            enterpriseResourceGrants,
            and(
              eq(
                enterpriseResourceGrants.tenantId,
                enterpriseResources.tenantId,
              ),
              eq(enterpriseResourceGrants.resourceId, enterpriseResources.id),
              eq(enterpriseResourceGrants.principalId, scope.principalId),
              eq(enterpriseResourceGrants.action, "read"),
            ),
          )
          .leftJoin(
            enterpriseWorkspaceMemberships,
            and(
              eq(enterpriseWorkspaceMemberships.tenantId, scope.tenantId),
              eq(enterpriseWorkspaceMemberships.workspaceId, scope.workspaceId),
              eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
            ),
          )
          .where(
            and(
              eq(enterpriseResources.tenantId, scope.tenantId),
              eq(enterpriseResources.id, kbId),
              eq(enterpriseResources.kind, KNOWLEDGE_RESOURCE_KIND),
            ),
          )
          .limit(1)) as RegistrationRow[];
        if (row === undefined) {
          return { outcome: "deny", code: "RESOURCE_NOT_FOUND" };
        }
        const registration = toRegistration(row);
        if (registration === null) {
          return { outcome: "deny", code: "RESOURCE_NOT_FOUND" };
        }
        const facts = rowToFacts(row, scope, registration);
        const verdict = registry.evaluate(registration.policyRevision, facts);
        if (verdict.outcome !== "allow") {
          return notFoundVerdict();
        }
        return { outcome: "allow", registration };
      });
    },

    async listVisibleKnowledgeBaseRegistrations(scope) {
      assertTrustedScope(scope);
      return kbReadTransaction(data, scope, async (tx) => {
        // 候选行：scope 租户 + scope 团队 + kind 过滤，(created_at, id) 全序
        // 一次受限读取；跨公司行由 RLS 隐藏，注册表求值是第二道防线。列表
        // 不持逐资源锁（候选集无界；MT011 同款边界）。
        const rows = (await tx
          .select(selectionShape())
          .from(enterpriseResources)
          .innerJoin(
            enterpriseTenants,
            eq(enterpriseTenants.id, enterpriseResources.tenantId),
          )
          .leftJoin(
            enterpriseResourceGrants,
            and(
              eq(
                enterpriseResourceGrants.tenantId,
                enterpriseResources.tenantId,
              ),
              eq(enterpriseResourceGrants.resourceId, enterpriseResources.id),
              eq(enterpriseResourceGrants.principalId, scope.principalId),
              eq(enterpriseResourceGrants.action, "read"),
            ),
          )
          .leftJoin(
            enterpriseWorkspaceMemberships,
            and(
              eq(enterpriseWorkspaceMemberships.tenantId, scope.tenantId),
              eq(enterpriseWorkspaceMemberships.workspaceId, scope.workspaceId),
              eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
            ),
          )
          .where(
            and(
              eq(enterpriseResources.tenantId, scope.tenantId),
              eq(enterpriseResources.workspaceId, scope.workspaceId),
              eq(enterpriseResources.kind, KNOWLEDGE_RESOURCE_KIND),
            ),
          )
          .orderBy(
            asc(enterpriseResources.createdAt),
            asc(enterpriseResources.id),
          )) as RegistrationRow[];
        const visible: KbOwnershipRegistration[] = [];
        for (const row of rows) {
          const registration = toRegistration(row);
          if (registration === null) continue;
          const facts = rowToFacts(row, scope, registration);
          const verdict = registry.evaluate(registration.policyRevision, facts);
          if (verdict.outcome === "allow") visible.push(registration);
        }
        return Object.freeze(visible);
      });
    },
  };
}

/** canonical 不可见判定的再导出形态（入口层消费；单一事实源在 not-found-semantics）。 */
export type { ResourceNotFoundVerdict };
