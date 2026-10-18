// server/src/enterprise/tenancy/resource-visibility.ts
// MT008（Issue #51）：遗留资源 → 团队公共的**显式**迁移入口。
//
// 票面验收 3：把旧 public 资源迁移为团队公共必须经显式动作——本入口只
// 按显式清单（tenantId + resourceIds）执行；无清单 / 空清单 = 零写入
// （结构性提前返回，一条 SQL 都不发）；清单外的资源绝不触碰；
// 'private'（显式个人选择）绝不被清单翻转成团队公共；跨租户 id 只会
// 以 notFound 入报告、绝不写入。写入经受限 operator 角色，遵守既有
// UPDATE 行策略（app.tenant_id + app.resource_id 匹配行）与 MT008 迁移
// 授予的 visibility 列级 UPDATE 权限；每个资源先取排他 advisory 锁
// （键 = store.readLockKeys 的 resource 键：["enterprise","resource",
// tenant,id]，与判定入口的共享锁同键族），读-判-写在锁内完成。
//
// 迁移方向唯一：NULL（未标记/遗留）→ 'workspace'。已是 'workspace' =
// 幂等 no-op；'private' = privateKept（绝不自动扩大暴露范围）。

import { and, eq, isNull, sql } from "drizzle-orm";
import { enterpriseResources } from "../../db/schema/enterprise-tenancy";
import { assertOperatorDatabase, type OperatorDatabase } from "./connections";

/** 显式清单：只迁移列出的资源；两个必填字段都由调用方显式给出。 */
export interface ResourceVisibilityMigrationManifest {
  readonly tenantId: string;
  readonly resourceIds: readonly string[];
}

/** 逐资源结果报告；updatesExecuted 是「实际执行的 UPDATE 条数」。 */
export interface ResourceVisibilityMigrationReport {
  readonly tenantId: string;
  /** 清单内资源数（无清单/空清单为 0）。 */
  readonly requested: number;
  /** 实际执行的 UPDATE 语句数——零写入的直接证据。 */
  readonly updatesExecuted: number;
  /** NULL → 'workspace'，真实迁移成功的资源。 */
  readonly migrated: readonly string[];
  /** 清单内但已是 'workspace'（幂等 no-op）。 */
  readonly alreadyWorkspace: readonly string[];
  /** 清单内但已显式标记 'private'——绝不被翻转（不扩大暴露范围）。 */
  readonly privateKept: readonly string[];
  /** 清单内但该租户下不存在（含跨租户 id）——绝不写入。 */
  readonly notFound: readonly string[];
}

export type ParsedResourceVisibilityManifest =
  | {
      readonly ok: true;
      readonly manifest: ResourceVisibilityMigrationManifest;
    }
  | { readonly ok: false; readonly reason: string };

/** 解析显式清单（JSON 文本）：形状不对一律拒绝，绝不猜测。 */
export function parseResourceVisibilityManifest(
  text: string,
): ParsedResourceVisibilityManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "MANIFEST_NOT_JSON" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "MANIFEST_NOT_OBJECT" };
  }
  const candidate = value as { tenantId?: unknown; resourceIds?: unknown };
  if (
    typeof candidate.tenantId !== "string" ||
    candidate.tenantId.trim().length === 0
  ) {
    return { ok: false, reason: "MANIFEST_TENANT_ID_INVALID" };
  }
  if (
    !Array.isArray(candidate.resourceIds) ||
    candidate.resourceIds.some(
      (id) => typeof id !== "string" || id.trim().length === 0,
    )
  ) {
    return { ok: false, reason: "MANIFEST_RESOURCE_IDS_INVALID" };
  }
  return {
    ok: true,
    manifest: {
      tenantId: candidate.tenantId,
      resourceIds: candidate.resourceIds as readonly string[],
    },
  };
}

function resourceLockKey(tenantId: string, resourceId: string): string {
  // 与 store.readLockKeys 的 resource 键同形：判定入口持共享锁，本入口
  // 持排他锁——迁移写与判定读串行化。
  return JSON.stringify(["enterprise", "resource", tenantId, resourceId]);
}

/**
 * 显式迁移入口。`manifest` 为 null/undefined 或 resourceIds 为空时
 * **零写入**（结构性提前返回，不打开任何写事务）。
 */
export async function migrateLegacyResourcesToWorkspaceVisibility(
  operator: OperatorDatabase,
  manifest: ResourceVisibilityMigrationManifest | null | undefined,
): Promise<ResourceVisibilityMigrationReport> {
  assertOperatorDatabase(operator);
  const tenantId = manifest?.tenantId ?? "";
  const resourceIds = manifest?.resourceIds ?? [];
  if (resourceIds.length === 0) {
    // 无清单 / 空清单：零写入——不发任何 SQL，直接返回空报告。
    return {
      tenantId,
      requested: 0,
      updatesExecuted: 0,
      migrated: [],
      alreadyWorkspace: [],
      privateKept: [],
      notFound: [],
    };
  }

  const migrated: string[] = [];
  const alreadyWorkspace: string[] = [];
  const privateKept: string[] = [];
  const notFound: string[] = [];
  let updatesExecuted = 0;

  await operator.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '10s'`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${tenantId}, true)`,
    );
    for (const resourceId of resourceIds) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${resourceLockKey(tenantId, resourceId)}, 0))`,
      );
      await tx.execute(
        sql`select set_config('app.resource_id', ${resourceId}, true)`,
      );
      const [row] = await tx
        .select({
          id: enterpriseResources.id,
          visibility: enterpriseResources.visibility,
        })
        .from(enterpriseResources)
        .where(
          and(
            eq(enterpriseResources.tenantId, tenantId),
            eq(enterpriseResources.id, resourceId),
          ),
        )
        .limit(1);
      if (!row) {
        notFound.push(resourceId);
        continue;
      }
      if (row.visibility === "workspace") {
        alreadyWorkspace.push(resourceId);
        continue;
      }
      if (row.visibility === "private") {
        // 显式个人选择优先于清单：绝不自动扩大暴露范围。
        privateKept.push(resourceId);
        continue;
      }
      const updated = await tx
        .update(enterpriseResources)
        .set({ visibility: "workspace" })
        .where(
          and(
            eq(enterpriseResources.tenantId, tenantId),
            eq(enterpriseResources.id, resourceId),
            isNull(enterpriseResources.visibility),
          ),
        )
        .returning({ id: enterpriseResources.id });
      if (updated.length !== 1) {
        throw new Error(
          `VISIBILITY_MIGRATION_CONFLICT:${tenantId}:${resourceId}`,
        );
      }
      updatesExecuted += 1;
      migrated.push(resourceId);
    }
  });

  return {
    tenantId,
    requested: resourceIds.length,
    updatesExecuted,
    migrated,
    alreadyWorkspace,
    privateKept,
    notFound,
  };
}
