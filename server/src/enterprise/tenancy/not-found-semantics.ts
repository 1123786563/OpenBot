// server/src/enterprise/tenancy/not-found-semantics.ts
// MT011（Issue #54）：集中式 not-found 不可见语义 + 列表/游标/批量面。
//
// 票面：当用户访问无权或跨范围的对象时，系统按 not-found 语义处理；错误
// 文本、列表计数、分页游标和存在性检查都不泄露该对象是否存在。
//
// 结构（三件事，全部纯新增；三个判定模块 resource-policy / team-public-rules
// / personal-share-rules 按票面**只读消费**——它们的哈希与测试已冻结，本文件
// 绝不重构它们，只复用其导出的注册表、可见性解析与事务形状）：
//
//   1. canonical 语义（唯一事实源）：not-found 判定只有一种形状
//      { outcome: "deny", code: "RESOURCE_NOT_FOUND" }——canonical 实例、
//      结构守卫、确定性字节序列化与集中 HTTP 面（404 + 唯一错误体）只在
//      本文件定义一处。任何闭环的拒绝都必须与 canonical 形状逐字节一致；
//      共享测试（not-found-semantics.test.ts）把三个冻结闭环的拒绝逐例
//      钉在这个形状上（reuse-compatibility：闭环复用属下游票接线）。
//   2. 列表/计数/游标面（createResourceInventoryService.listVisibleResources
//      / countVisibleResources）：先经授权（MT008 注册表逐行求值，放行
//      语义只有注册表一处定义）后分页——keyset 游标只从可见项派生，
//      不可见对象不消耗页位、不偏移游标、不出现在计数里。候选行按
//      (created_at, id) 全序读取，游标是服务自发的 opaque 令牌。
//   3. 批量面（resolveResourceBatch）：逐 id 结果与输入顺序一致；一切
//      拒绝（不存在/跨公司/跨团队/无授权/已删除）逐字节同形，与单个
//      decide() 判定完全一致；不存在任何按存在性分叉的语句路径——全缺
//      与全禁的 SQL 语句数相等（时延的结构性代理，由共享测试钉死），
//      无聚合计数、无短路。
//
// 事务纪律与 MT008 判定入口完全一致：受信 Scope（assertTrustedScope）→
// read committed + lock/statement timeout → set_config('app.*', …, true)
// 事务本地 → advisory 共享锁（键序 tenant → principal → membership →
// workspace-membership → resource；批量多资源键按字典序排列，保持全局
// 键序）。事实读取全部经受限 data 角色与真实 RLS：跨公司资源行对本事务
// 不可见（事实即为「不存在」），注册表内的租户/团队比对是第二道独立
// 防线（纵深防御）。
//
// 与 MT008 decide() 的语义对齐（逐字面）：
//   - 判定输入 = 同一组事实（ResourcePolicyFacts），求值 = 同一注册表；
//     版本解析 = 显式覆盖 ?? 资源所属租户的 policy_revision。
//   - 公司级成员资格不在逐行事实内（decide 亦然）：scope 信任边界 +
//     团队成员资格事实 + RLS 与 decide 完全同构——列表即 decide 的
//     复数形状，不多不少。
//
// 边界（诚实披露）：
//   - 列表/计数的候选读取一次性扫过 scope 团队内的候选行（策略求值在
//     应用层注册表中，无法下推为 SQL 谓词——那是重复第二份策略语义）；
//     团队规模超出此模型时属后续分页架构票。
//   - 游标令牌编码 (created_at 文本, id)：服务自发、opaque、只含调用方
//     已见项的键；无效令牌响亮拒绝（INVENTORY_CURSOR_INVALID）——输入
//     校验，不是存在性信号。
//   - 本票不接路由：HTTP 面供下游接线票复用（与 MT009/MT010 装配同例）。

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import { assertDataDatabase, type DataDatabase } from "./connections";
import {
  createShippedResourcePolicyRegistry,
  parseResourceVisibility,
  type ResourcePolicyFacts,
  type ResourcePolicyRegistry,
} from "./resource-policy";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// §1 canonical not-found 语义（唯一事实源）
// ---------------------------------------------------------------------------

/** The one and only not-found verdict shape. Every denial in every closed loop. */
export interface ResourceNotFoundVerdict {
  readonly outcome: "deny";
  readonly code: "RESOURCE_NOT_FOUND";
}

const CANONICAL_NOT_FOUND_VERDICT: Readonly<ResourceNotFoundVerdict> =
  Object.freeze({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });

/** The canonical not-found verdict (frozen; identical bytes every call). */
export function notFoundVerdict(): ResourceNotFoundVerdict {
  return CANONICAL_NOT_FOUND_VERDICT;
}

/**
 * Structural guard for the canonical shape — exactly two fields, exactly
 * these values. Anything else (allow verdicts, other deny codes, extra
 * fields) is not a not-found verdict and must never wear its shape.
 */
export function isResourceNotFoundVerdict(
  value: unknown,
): value is ResourceNotFoundVerdict {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.outcome === "deny" &&
    candidate.code === "RESOURCE_NOT_FOUND" &&
    Object.keys(candidate).length === 2
  );
}

/**
 * Deterministic byte serialization of the canonical verdict. Refuses
 * anything that is not exactly the canonical shape — a wrong shape must
 * never silently pass as not-found.
 */
export function serializeNotFoundVerdict(
  verdict: ResourceNotFoundVerdict,
): string {
  if (!isResourceNotFoundVerdict(verdict)) {
    throw new Error("NOT_FOUND_VERDICT_REQUIRED");
  }
  return JSON.stringify({ outcome: verdict.outcome, code: verdict.code });
}

/** The one HTTP status every not-found maps to. */
export const NOT_FOUND_HTTP_STATUS = 404;

/** The one error body every not-found maps to (matches the route error shape `{ error: code }`). */
export function notFoundErrorBody(): string {
  return JSON.stringify({ error: "RESOURCE_NOT_FOUND" });
}

/** The one HTTP face for every not-found: identical status, identical body bytes. */
export function notFoundHttpResponse(): {
  readonly status: typeof NOT_FOUND_HTTP_STATUS;
  readonly body: string;
} {
  return Object.freeze({
    status: NOT_FOUND_HTTP_STATUS,
    body: notFoundErrorBody(),
  });
}

// ---------------------------------------------------------------------------
// §2 列表/游标/批量面：授权（注册表）→ 过滤 → keyset 分页 / 逐 id 判定
// ---------------------------------------------------------------------------

/** The visible-resource view handed back by the inventory surface. */
export interface InventoryResourceView {
  readonly resourceId: string;
  readonly kind: string;
  readonly displayName: string;
  readonly revision: number;
  readonly aclEpoch: number;
}

/** One page of the visible stream; `nextCursor` is null after the last visible item. */
export interface ResourceInventoryPage {
  readonly items: readonly InventoryResourceView[];
  readonly nextCursor: string | null;
}

/** Per-id batch results: allow carries the view; every denial is the canonical not-found. */
export type ResourceBatchEntry =
  | {
      readonly resourceId: string;
      readonly outcome: "allow";
      readonly resource: InventoryResourceView;
    }
  | {
      readonly resourceId: string;
      readonly outcome: "deny";
      readonly code: "RESOURCE_NOT_FOUND";
    };

export interface ResourceInventoryService {
  /**
   * Lists the resources visible to the scope in its own team, keyset-paginated
   * over the visible stream only. Invisible objects never consume page slots
   * and never shift cursors.
   */
  listVisibleResources(
    scope: PlatformScope,
    options?: {
      readonly limit?: number;
      readonly cursor?: string;
      readonly policyVersion?: string;
    },
  ): Promise<ResourceInventoryPage>;

  /** Counts the visible resources only; invisible objects are not in the count. */
  countVisibleResources(
    scope: PlatformScope,
    options?: { readonly policyVersion?: string },
  ): Promise<{ readonly total: number }>;

  /**
   * Resolves one entry per input id, in input order. Every denial is the
   * canonical not-found — byte-identical whether the id is missing,
   * cross-company, cross-team, unauthorized or deleted. No short-circuit,
   * no aggregate counts.
   */
  resolveResourceBatch(
    scope: PlatformScope,
    resourceIds: readonly string[],
    options?: { readonly policyVersion?: string },
  ): Promise<readonly ResourceBatchEntry[]>;
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const MAX_BATCH_IDS = 100;

interface CursorPayload {
  readonly v: 1;
  readonly at: string;
  readonly id: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(token: string): CursorPayload {
  let parsed: unknown;
  try {
    const json = Buffer.from(token, "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    throw new Error("INVENTORY_CURSOR_INVALID");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as CursorPayload).v !== 1 ||
    typeof (parsed as CursorPayload).at !== "string" ||
    (parsed as CursorPayload).at.trim() === "" ||
    typeof (parsed as CursorPayload).id !== "string" ||
    (parsed as CursorPayload).id.trim() === ""
  ) {
    throw new Error("INVENTORY_CURSOR_INVALID");
  }
  return parsed as CursorPayload;
}

function assertPageLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new Error("INVENTORY_LIMIT_INVALID");
  }
  return limit;
}

function assertBatchIds(resourceIds: readonly string[]): readonly string[] {
  if (!Array.isArray(resourceIds)) {
    throw new Error("INVENTORY_BATCH_INPUT_INVALID");
  }
  if (resourceIds.length > MAX_BATCH_IDS) {
    throw new Error("INVENTORY_BATCH_INPUT_INVALID");
  }
  for (const id of resourceIds) {
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error("INVENTORY_BATCH_INPUT_INVALID");
    }
  }
  return resourceIds;
}

/** 事务句柄类型（与 resource-policy 判定入口同一形状的本地别名）。 */
type DataTx = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];

/** 判定事实行（一次受限读取，行内容与 MT008 判定入口同一组事实）。 */
interface InventoryRow {
  readonly policyRevision: string;
  readonly resourceTenantId: string | null;
  readonly resourceWorkspaceId: string | null;
  readonly resourceId: string | null;
  readonly kind: string | null;
  readonly displayName: string | null;
  readonly visibility: string | null;
  readonly status: string | null;
  readonly revision: number | null;
  readonly aclEpoch: number | null;
  readonly grantPrincipalId: string | null;
  readonly membershipStatus: string | null;
  readonly createdAtText: string;
}

function rowToView(row: InventoryRow): InventoryResourceView {
  return Object.freeze({
    resourceId: row.resourceId as string,
    kind: row.kind as string,
    displayName: row.displayName as string,
    revision: row.revision as number,
    aclEpoch: row.aclEpoch as number,
  });
}

function rowToFacts(
  row: InventoryRow,
  scope: PlatformScope,
): ResourcePolicyFacts {
  return {
    scope: {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      principalId: scope.principalId,
      actorId: scope.actorId,
    },
    resource: {
      tenantId: row.resourceTenantId ?? scope.tenantId,
      workspaceId: row.resourceWorkspaceId ?? "",
      id: row.resourceId ?? "",
      visibility: parseResourceVisibility(row.visibility),
      status: (row.status as ResourcePolicyFacts["resource"]["status"]) ?? null,
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
}

/**
 * 装配入口。`registry` 缺省用已发布注册表（tenancy-v1 + workspace-v1）；
 * 逐行求值与 MT008 decide() 使用同一注册表——放行语义只有一处定义。
 */
export function createResourceInventoryService(
  data: DataDatabase,
  registry: ResourcePolicyRegistry = createShippedResourcePolicyRegistry(),
): ResourceInventoryService {
  assertDataDatabase(data);
  const evaluateRow = (
    row: InventoryRow,
    scope: PlatformScope,
    policyVersion: string | undefined,
  ): boolean => {
    const facts = rowToFacts(row, scope);
    const effectiveVersion = policyVersion ?? facts.resource.policyRevision;
    return registry.evaluate(effectiveVersion, facts).outcome === "allow";
  };

  const readVisibleRows = async (
    tx: DataTx,
    scope: PlatformScope,
    options:
      | { readonly cursor?: string; readonly policyVersion?: string }
      | undefined,
  ): Promise<InventoryRow[]> => {
    const cursor = options?.cursor ? decodeCursor(options.cursor) : null;
    return (await tx
      .select({
        policyRevision: enterpriseTenants.policyRevision,
        resourceTenantId: enterpriseResources.tenantId,
        resourceWorkspaceId: enterpriseResources.workspaceId,
        resourceId: enterpriseResources.id,
        kind: enterpriseResources.kind,
        displayName: enterpriseResources.displayName,
        visibility: enterpriseResources.visibility,
        status: enterpriseResources.status,
        revision: enterpriseResources.revision,
        aclEpoch: enterpriseResources.aclEpoch,
        grantPrincipalId: enterpriseResourceGrants.principalId,
        membershipStatus: enterpriseWorkspaceMemberships.status,
        createdAtText: sql<string>`${enterpriseResources.createdAt}::text`.as(
          "created_at_text",
        ),
      })
      .from(enterpriseResources)
      .innerJoin(
        enterpriseTenants,
        eq(enterpriseTenants.id, enterpriseResources.tenantId),
      )
      .leftJoin(
        enterpriseResourceGrants,
        and(
          eq(enterpriseResourceGrants.tenantId, enterpriseResources.tenantId),
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
          cursor
            ? sql`(${enterpriseResources.createdAt}, ${enterpriseResources.id}) > (${cursor.at}::timestamptz, ${cursor.id})`
            : undefined,
        ),
      )
      // 全序键集：(created_at, id) 双键升序——同刻创建的行按 id 决胜。
      .orderBy(
        asc(enterpriseResources.createdAt),
        asc(enterpriseResources.id),
      )) as InventoryRow[];
  };

  return {
    async listVisibleResources(scope, options) {
      assertTrustedScope(scope);
      const limit = assertPageLimit(options?.limit);
      return data.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        /* Transaction-local settings are defense in depth for RLS and are cleared on commit. */
        await tx.execute(
          sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true)`,
        );
        // 锁序：tenant → principal → membership → workspace-membership。
        // 列表不持逐资源锁（候选集无界；行事实与 decide 同源，跨公司行
        // 由 RLS 隐藏）——边界已在模块头披露。
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
        const rows = await readVisibleRows(tx, scope, options);
        const items: InventoryResourceView[] = [];
        let nextCursor: string | null = null;
        let boundaryRow: InventoryRow | null = null;
        for (const row of rows) {
          if (!evaluateRow(row, scope, options?.policyVersion)) continue;
          if (items.length === limit) {
            // 第 limit+1 个可见项只用来签发下一页游标：游标钉在最后一个
            // 可见项的键上——不可见对象既不进页也不偏移游标。
            nextCursor = encodeCursor({
              v: 1,
              at: boundaryRow?.createdAtText ?? "",
              id: boundaryRow?.resourceId ?? "",
            });
            break;
          }
          items.push(rowToView(row));
          boundaryRow = row;
        }
        return Object.freeze({ items: Object.freeze(items), nextCursor });
      });
    },

    async countVisibleResources(scope, options) {
      assertTrustedScope(scope);
      return data.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true)`,
        );
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
        const rows = await readVisibleRows(tx, scope, options);
        let total = 0;
        for (const row of rows) {
          if (evaluateRow(row, scope, options?.policyVersion)) total += 1;
        }
        return { total };
      });
    },

    async resolveResourceBatch(scope, resourceIds, options) {
      assertTrustedScope(scope);
      const ids = assertBatchIds(resourceIds);
      if (ids.length === 0) return Object.freeze([]);
      return data.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true)`,
        );
        // 锁序：基础键 → 资源键（去重 + 字典序，保持全局键序；与 decide
        // 同族共享锁——对不存在 id 也照常取锁，语句路径不按存在性分叉）。
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
          ...[...new Set(ids)]
            .sort()
            .map((resourceId) =>
              JSON.stringify([
                "enterprise",
                "resource",
                scope.tenantId,
                resourceId,
              ]),
            ),
        ]) {
          await tx.execute(
            sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
          );
        }
        // 一次受限读取取回全部事实（in-list；RLS 使跨公司行不可见＝事实
        // 为「不存在」）。逐 id 判定与 MT008 decide() 同一注册表。
        const rows = (await tx
          .select({
            policyRevision: enterpriseTenants.policyRevision,
            resourceTenantId: enterpriseResources.tenantId,
            resourceWorkspaceId: enterpriseResources.workspaceId,
            resourceId: enterpriseResources.id,
            kind: enterpriseResources.kind,
            displayName: enterpriseResources.displayName,
            visibility: enterpriseResources.visibility,
            status: enterpriseResources.status,
            revision: enterpriseResources.revision,
            aclEpoch: enterpriseResources.aclEpoch,
            grantPrincipalId: enterpriseResourceGrants.principalId,
            membershipStatus: enterpriseWorkspaceMemberships.status,
            createdAtText:
              sql<string>`${enterpriseResources.createdAt}::text`.as(
                "created_at_text",
              ),
          })
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
              inArray(enterpriseResources.id, ids as unknown as string[]),
            ),
          )) as InventoryRow[];
        const byId = new Map<string, InventoryRow>();
        for (const row of rows) {
          if (row.resourceId != null) byId.set(row.resourceId, row);
        }
        const entries: ResourceBatchEntry[] = ids.map((resourceId) => {
          const row = byId.get(resourceId);
          if (!row) {
            return Object.freeze({
              resourceId,
              outcome: "deny",
              code: "RESOURCE_NOT_FOUND",
            });
          }
          if (evaluateRow(row, scope, options?.policyVersion)) {
            return Object.freeze({
              resourceId,
              outcome: "allow",
              resource: rowToView(row),
            });
          }
          return Object.freeze({
            resourceId,
            outcome: "deny",
            code: "RESOURCE_NOT_FOUND",
          });
        });
        return Object.freeze(entries);
      });
    },
  };
}
