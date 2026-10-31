// server/src/enterprise/tenancy/personal-memory.ts
// MT039（Issue #82）：个人记忆与来源选择保持个人权限。
//
// 票面语义：个人业务记忆、记忆来源选择与相关缓存按个人权限控制；团队
// 成员资格不会让他人读到某人的记忆，公共 Bot 运行时也只会使用当前使用
// 者被授权的记忆来源。
//
// 结构（纯新增，只读消费 MT008/MT010 既有资源与授权表，不改任何既有
// 文件）：
//
//   1. 记忆读写（writeMemory / searchMemories / listMemories）经受限
//      data 通道 + RLS 双 pin（tenant + principal）——同团队他人连行都
//      不可见（AC1）：搜索结果为空页与"该人没有记忆"不可区分，列表与
//      计数不泄露存在性。
//   2. 来源选择（listMemorySources）只列调用者有权访问的库与文档（AC2）：
//      enterprise_resources 中 kind ∈ {knowledge_base, document} 且
//      (a) 调用者持有显式 read 授权行（MT010），或 (b) 资源标记
//      workspace 公共且调用者是该团队有效成员（MT008 visibility +
//      团队成员资格现读）。无权资源结构性不进列表。
//   3. 缓存键（memoryCacheKey）是纯函数，键含 tenant + workspace +
//      principal 三段个人与范围标识（AC3）：切换用户或团队得到不同键，
//      不串用。
//   4. 公共 Bot 使用（resolveMemoriesForPublicBot，AC4）：记忆按使用者
//      本人权限解析——检索谓词只带使用者的 (tenant, workspace,
//      principal)，Bot 创建者的记忆对解析路径结构性不可达（RLS 双 pin）；
//      调用参数里出现任何创建者/归属键（ownerPrincipalId / creator 等
//      驼峰与下划线拼写）一律响亮拒绝（ATTRIBUTION_NOT_CLIENT_DECLARABLE，
//      MT019/MT028 同源：服务端持久状态优先于客户端选择）。
//
//   5. T06.04（#576，原任务 P14）：读入口维持 company/team/principal 来源，
//      派生结果逐来源现读授权。
//      - list（searchMemories）/ recall（resolveMemoriesForPublicBot）/
//        confirm（confirmMemory）/ forget（forgetMemory）四处读与确认都只认
//        本 scope 的 (tenant, workspace, principal) 三元组：同一个人在另一个
//        团队开会话时读不到、也忘不掉本团队的行（已确认不等于向团队公开）。
//      - kb/document 来源的记忆在每次读取时实时重新推导来源授权：
//        enterprise_resources 该行仍 active、kind 与来源类型一致，且调用者仍
//        有显式 read 授权，或资源 workspace 公共且调用者在该团队的有效成员
//        关系仍 active。授权撤销（删 grant 行/成员关系失效）在下一次读取即
//        生效——比较本身就是撤销，无需外部 cleanup 改写记忆行；来源离线的
//        KB 不复活（不恢复 KB）。无授权的来源行结构性不进任何结果。
//      - Bot 面只见来源类型：resolveMemoriesForPublicBot 的视图把 sourceRef
//        （调用者私有来源定位符）脱敏为 null；本人列表仍带自己的 sourceRef。
//      - 确认只重证来源授权、不改归属：来源已撤销的确认抛
//        PERSONAL_MEMORY_SOURCE_REVOKED；跨团队 id 一律
//        PERSONAL_MEMORY_NOT_FOUND。
//      - memoryCacheKey 维持 company/team/principal 三段与 memory:v1 命名
//        空间；代际版本由消费者按 scope 另派生，不在键里猜。
//
// 事务纪律与 MT019/MT034/MT035 完全一致：受信 Scope（assertTrustedScope）
// → read committed + lock/statement timeout → set_config('app.*', …, true)
// 事务本地 → advisory 锁（tenant → principal → membership）。
//
// 边界（诚实披露）：
//   - 本模块是记忆归属判定面，不接 HTTP 路由（挂路由属下游接线票）；
//   - 语义检索（embedding）不在本票范围：searchMemories 是键/内容包含
//     匹配，向量检索属 Intelligence 域后续票。

import { randomUUID } from "node:crypto";
import { and, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
import { enterprisePersonalMemories } from "../../db/schema/enterprise-personal-memory";
import {
  enterpriseMemberships,
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import { assertDataDatabase, type DataDatabase } from "./connections";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 词表与形状
// ---------------------------------------------------------------------------

/** 记忆来源类型（闭集；kb/document 必须带 source_ref）。 */
export const MEMORY_SOURCE_KINDS = ["manual", "kb", "document"] as const;

export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];

export interface MemoryView {
  readonly memoryId: string;
  readonly memoryKey: string;
  readonly content: string;
  readonly sourceKind: MemorySourceKind;
  readonly sourceRef: string | null;
}

export interface MemorySourceView {
  readonly resourceId: string;
  readonly kind: string;
  readonly displayName: string;
  readonly via: "grant" | "workspace-public";
}

/** 创建者/归属键在公共 Bot 解析参数中不可表达。 */
const ATTRIBUTION_KEYS: readonly string[] = [
  "ownerPrincipalId",
  "creatorPrincipalId",
  "creator",
  "owner_principal_id",
  "creator_principal_id",
];

export interface PersonalMemoryService {
  /** 写一条个人记忆（归属 = 受信 scope 的三元组）。 */
  writeMemory(
    scope: PlatformScope,
    input: {
      readonly memoryKey: string;
      readonly content: string;
      readonly sourceKind?: MemorySourceKind;
      readonly sourceRef?: string;
    },
  ): Promise<{ readonly outcome: "allow"; readonly memoryId: string }>;
  /** 搜索本人记忆（键或内容包含匹配；他人视角 = 永远空页）。 */
  searchMemories(
    scope: PlatformScope,
    input: { readonly query: string },
  ): Promise<readonly MemoryView[]>;
  /**
   * 本人确认（T06.04）：只在本 scope 的 (tenant, workspace, principal)
   * 内找到行，并实时重证 kb/document 来源授权；确认不改归属、不扩大来源
   * 范围。来源已撤销 → PERSONAL_MEMORY_SOURCE_REVOKED；跨团队/不存在 →
   * PERSONAL_MEMORY_NOT_FOUND。
   */
  confirmMemory(
    scope: PlatformScope,
    input: { readonly memoryId: string },
  ): Promise<MemoryView>;
  /** 本人遗忘（T06.04）：只删本 scope 三元组内的行，跨团队不可达。 */
  forgetMemory(
    scope: PlatformScope,
    input: { readonly memoryId: string },
  ): Promise<{ readonly outcome: "forgotten"; readonly memoryId: string }>;
  /** 来源选择：只列调用者有权访问的库与文档。 */
  listMemorySources(scope: PlatformScope): Promise<readonly MemorySourceView[]>;
  /**
   * 公共 Bot 使用的记忆解析（AC4）：只按使用者本人权限解析，创建者
   * 记忆结构性不可达；归属键参数一律响亮拒绝。
   */
  resolveMemoriesForPublicBot(
    scope: PlatformScope,
    input: { readonly agentId: string } & Record<string, unknown>,
  ): Promise<readonly MemoryView[]>;
}

/** 缓存键工厂（AC3）：键含个人与范围标识，切换用户/团队不串用。 */
export function memoryCacheKey(scope: {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
}): string {
  return `memory:v1:${scope.tenantId}:${scope.workspaceId}:${scope.principalId}`;
}

// ---------------------------------------------------------------------------
// 输入校验
// ---------------------------------------------------------------------------

function assertScopeShape(scope: PlatformScope): void {
  assertTrustedScope(scope);
  if (!scope.tenantId?.trim()) throw new Error("TENANT_REQUIRED");
  if (!scope.workspaceId?.trim()) throw new Error("WORKSPACE_REQUIRED");
}

function assertPlainString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw new Error(`PERSONAL_MEMORY_INPUT_INVALID:${field}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * 装配入口。记忆读写与来源选择全部走受限 data 通道（RLS 双 pin）；
 * 未验证业务通道在装配时拒绝。
 */
export function createPersonalMemoryService(channels: {
  readonly data: DataDatabase;
}): PersonalMemoryService {
  assertDataDatabase(channels.data);
  const { data } = channels;

  type Tx = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];

  const beginContext = async (tx: Tx, scope: PlatformScope): Promise<void> => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
    );
  };

  const takeLocks = async (tx: Tx, scope: PlatformScope): Promise<void> => {
    for (const key of [
      JSON.stringify(["enterprise", "tenant", scope.tenantId]),
      JSON.stringify(["enterprise", "principal", scope.principalId]),
      JSON.stringify([
        "enterprise",
        "membership",
        scope.tenantId,
        scope.principalId,
      ]),
    ]) {
      await tx.execute(
        sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
      );
    }
  };

  /*
   * T06.04: the read provenance is the FULL owner triple — company, team and
   * principal. The same person scoped to another team reads none of this
   * team's rows (a confirmed memory never becomes another team's to see), and
   * a memory written for one team is not re-read through another selection.
   */
  const ownRowsPredicate = (scope: PlatformScope) =>
    and(
      eq(enterprisePersonalMemories.tenantId, scope.tenantId),
      eq(enterprisePersonalMemories.workspaceId, scope.workspaceId),
      eq(enterprisePersonalMemories.principalId, scope.principalId),
    );

  const selectOwnRows = (tx: Tx, extra?: SQL) =>
    tx
      .select({
        id: enterprisePersonalMemories.id,
        memoryKey: enterprisePersonalMemories.memoryKey,
        content: enterprisePersonalMemories.content,
        sourceKind: enterprisePersonalMemories.sourceKind,
        sourceRef: enterprisePersonalMemories.sourceRef,
      })
      .from(enterprisePersonalMemories)
      .where(extra);

  type MemoryRow = Awaited<ReturnType<typeof selectOwnRows>>[number];

  const toView = (row: MemoryRow): MemoryView =>
    deepFreeze({
      memoryId: row.id,
      memoryKey: row.memoryKey,
      content: row.content,
      sourceKind: row.sourceKind as MemorySourceKind,
      sourceRef: row.sourceRef,
    });

  /*
   * T06.04: the Bot face learns the source KIND, never the person's private
   * source locator — sourceRef is masked (null), and no other source-private
   * field is exposed.
   */
  const toBotView = (row: MemoryRow): MemoryView =>
    deepFreeze({
      memoryId: row.id,
      memoryKey: row.memoryKey,
      content: row.content,
      sourceKind: row.sourceKind as MemorySourceKind,
      sourceRef: null,
    });

  const SOURCE_RESOURCE_KIND = {
    kb: "knowledge_base",
    document: "document",
  } as const;

  /*
   * T06.04: derived (kb/document) memories are authorized PER SOURCE, live, on
   * every read — never from a cached or previously-stamped grant:
   *
   *   - the source resource still exists in this company and is active (an
   *     offline KB is not restored: its derived memory stops answering);
   *   - its kind matches the memory's source kind (a document reference never
   *     borrows a KB's authorization);
   *   - the caller holds an explicit `read` grant on it, or it is
   *     workspace-public in THIS team and the caller's membership there is
   *     still active (leaving the source team ends the ability to recall).
   *
   * The comparison IS the revocation: removing the grant row or suspending the
   * membership takes effect at the very next read, with no cleanup rewriting
   * memory rows. Manual memories carry no source and always pass.
   */
  const filterSourceAuthorized = async (
    tx: Tx,
    scope: PlatformScope,
    rows: readonly MemoryRow[],
  ): Promise<MemoryRow[]> => {
    const sourceRefs = [
      ...new Set(
        rows.flatMap((row) =>
          row.sourceKind === "manual" || !row.sourceRef ? [] : [row.sourceRef],
        ),
      ),
    ];
    if (sourceRefs.length === 0) return [...rows];

    const resources = await tx
      .select({
        id: enterpriseResources.id,
        kind: enterpriseResources.kind,
        workspaceId: enterpriseResources.workspaceId,
        visibility: enterpriseResources.visibility,
      })
      .from(enterpriseResources)
      .where(
        and(
          eq(enterpriseResources.tenantId, scope.tenantId),
          inArray(enterpriseResources.id, sourceRefs),
          eq(enterpriseResources.status, "active"),
        ),
      );
    const sourceById = new Map(resources.map((row) => [row.id, row]));

    const grants = await tx
      .select({ resourceId: enterpriseResourceGrants.resourceId })
      .from(enterpriseResourceGrants)
      .where(
        and(
          eq(enterpriseResourceGrants.tenantId, scope.tenantId),
          inArray(enterpriseResourceGrants.resourceId, sourceRefs),
          eq(enterpriseResourceGrants.principalId, scope.principalId),
          eq(enterpriseResourceGrants.action, "read"),
        ),
      );
    const grantedSources = new Set(grants.map((row) => row.resourceId));

    const memberships = await tx
      .select({
        workspaceId: enterpriseWorkspaceMemberships.workspaceId,
      })
      .from(enterpriseWorkspaceMemberships)
      .where(
        and(
          eq(enterpriseWorkspaceMemberships.tenantId, scope.tenantId),
          eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
          eq(enterpriseWorkspaceMemberships.status, "active"),
        ),
      );
    const activeWorkspaces = new Set(memberships.map((row) => row.workspaceId));

    return rows.filter((row) => {
      if (row.sourceKind === "manual") return true;
      // The row-shape CHECK makes this unreachable; fail closed if it is not.
      if (!row.sourceRef) return false;
      const source = sourceById.get(row.sourceRef);
      if (!source) return false;
      if (
        source.kind !==
        SOURCE_RESOURCE_KIND[
          row.sourceKind as keyof typeof SOURCE_RESOURCE_KIND
        ]
      )
        return false;
      if (grantedSources.has(row.sourceRef)) return true;
      return (
        source.visibility === "workspace" &&
        source.workspaceId === scope.workspaceId &&
        activeWorkspaces.has(source.workspaceId)
      );
    });
  };

  return {
    async writeMemory(scope, input) {
      assertScopeShape(scope);
      const memoryKey = assertPlainString(input?.memoryKey, "memoryKey", 256);
      const content = assertPlainString(input?.content, "content", 65536);
      const sourceKind = input?.sourceKind ?? "manual";
      if (!(MEMORY_SOURCE_KINDS as readonly string[]).includes(sourceKind)) {
        throw new Error("PERSONAL_MEMORY_SOURCE_INVALID");
      }
      const sourceRef =
        sourceKind === "manual"
          ? null
          : assertPlainString(input?.sourceRef, "sourceRef", 512);
      const memoryId = `mt039-memory-${randomUUID()}`;
      await data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, scope);
        await tx.insert(enterprisePersonalMemories).values({
          tenantId: scope.tenantId,
          id: memoryId,
          workspaceId: scope.workspaceId,
          principalId: scope.principalId,
          memoryKey,
          content,
          sourceKind,
          sourceRef,
        });
      });
      return Object.freeze({ outcome: "allow", memoryId });
    },

    async searchMemories(scope, input) {
      assertScopeShape(scope);
      const query = assertPlainString(input?.query, "query", 512);
      // ILIKE 按字面量匹配：转义用户输入中的 LIKE 通配符（PG 默认转义符
      // 为反斜杠），否则单个 % 会命中全部记忆、_ 单字符通配。
      const literal = query.replace(/[\\%_]/g, "\\$&");
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, scope);
        const rows = await selectOwnRows(
          tx,
          and(
            ownRowsPredicate(scope),
            or(
              ilike(enterprisePersonalMemories.memoryKey, `%${literal}%`),
              ilike(enterprisePersonalMemories.content, `%${literal}%`),
            ),
          ),
        ).limit(100);
        // T06.04: the list is the person's own review surface, so the source
        // locator stays visible to them — but a derived memory whose source
        // authorization is gone is not listed either.
        const authorized = await filterSourceAuthorized(tx, scope, rows);
        return authorized.map(toView);
      });
    },

    async confirmMemory(scope, input) {
      assertScopeShape(scope);
      const memoryId = assertPlainString(input?.memoryId, "memoryId", 256);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, scope);
        // T06.04: confirmation only reaches this scope's own row — the owner
        // triple is company + team + principal, so another team's selection
        // cannot confirm (or widen) it.
        const [row] = await selectOwnRows(
          tx,
          and(
            ownRowsPredicate(scope),
            eq(enterprisePersonalMemories.id, memoryId),
          ),
        ).limit(1);
        if (!row) throw new Error("PERSONAL_MEMORY_NOT_FOUND");
        // Confirmation re-derives the source authorization and changes no
        // provenance: a revoked source cannot be re-affirmed.
        const [authorized] = await filterSourceAuthorized(tx, scope, [row]);
        if (!authorized) throw new Error("PERSONAL_MEMORY_SOURCE_REVOKED");
        return toView(row);
      });
    },

    async forgetMemory(scope, input) {
      assertScopeShape(scope);
      const memoryId = assertPlainString(input?.memoryId, "memoryId", 256);
      await data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, scope);
        const removed = await tx
          .delete(enterprisePersonalMemories)
          .where(
            and(
              ownRowsPredicate(scope),
              eq(enterprisePersonalMemories.id, memoryId),
            ),
          )
          .returning({ id: enterprisePersonalMemories.id });
        if (removed.length === 0) throw new Error("PERSONAL_MEMORY_NOT_FOUND");
      });
      return Object.freeze({ outcome: "forgotten" as const, memoryId });
    },

    async listMemorySources(scope) {
      assertScopeShape(scope);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, scope);
        // 有权 = 显式 read 授权行（MT010）∨ 团队公共（MT008 visibility
        // + 现读团队成员资格）。两者都以调用者身份现读，无继承。
        const granted = await tx
          .select({
            id: enterpriseResources.id,
            kind: enterpriseResources.kind,
            displayName: enterpriseResources.displayName,
          })
          .from(enterpriseResources)
          .innerJoin(
            enterpriseResourceGrants,
            and(
              eq(
                enterpriseResourceGrants.tenantId,
                enterpriseResources.tenantId,
              ),
              eq(enterpriseResourceGrants.resourceId, enterpriseResources.id),
              eq(enterpriseResourceGrants.principalId, scope.principalId),
              // 只认显式 read 授权行（MT010），不放行其他 action 位。
              eq(enterpriseResourceGrants.action, "read"),
            ),
          )
          .where(
            and(
              eq(enterpriseResources.tenantId, scope.tenantId),
              eq(enterpriseResources.status, "active"),
              sql`${enterpriseResources.kind} in ('knowledge_base', 'document')`,
            ),
          );
        const publicRows = await tx
          .select({
            id: enterpriseResources.id,
            kind: enterpriseResources.kind,
            displayName: enterpriseResources.displayName,
          })
          .from(enterpriseResources)
          .innerJoin(
            enterpriseWorkspaceMemberships,
            and(
              eq(
                enterpriseWorkspaceMemberships.tenantId,
                enterpriseResources.tenantId,
              ),
              eq(
                enterpriseWorkspaceMemberships.workspaceId,
                enterpriseResources.workspaceId,
              ),
              eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
            ),
          )
          .where(
            and(
              eq(enterpriseResources.tenantId, scope.tenantId),
              eq(enterpriseResources.workspaceId, scope.workspaceId),
              eq(enterpriseResources.status, "active"),
              sql`${enterpriseResources.visibility} = 'workspace'`,
              eq(enterpriseWorkspaceMemberships.status, "active"),
              sql`${enterpriseResources.kind} in ('knowledge_base', 'document')`,
            ),
          );
        const seen = new Map<string, MemorySourceView>();
        for (const row of granted) {
          seen.set(row.id, {
            resourceId: row.id,
            kind: row.kind,
            displayName: row.displayName,
            via: "grant",
          });
        }
        for (const row of publicRows) {
          if (!seen.has(row.id)) {
            seen.set(row.id, {
              resourceId: row.id,
              kind: row.kind,
              displayName: row.displayName,
              via: "workspace-public",
            });
          }
        }
        return deepFreeze([...seen.values()]);
      });
    },

    async resolveMemoriesForPublicBot(scope, input) {
      assertScopeShape(scope);
      assertPlainString(input?.agentId, "agentId", 256);
      for (const key of Object.keys(input)) {
        if (ATTRIBUTION_KEYS.includes(key)) {
          throw new Error("ATTRIBUTION_NOT_CLIENT_DECLARABLE");
        }
      }
      // 只按使用者本人权限解析：与 searchMemories 同一谓词（RLS 双 pin），
      // Bot 创建者的记忆在此路径结构性不可达。
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, scope);
        const [company] = await tx
          .select({ status: enterpriseMemberships.status })
          .from(enterpriseMemberships)
          .where(
            and(
              eq(enterpriseMemberships.tenantId, scope.tenantId),
              eq(enterpriseMemberships.principalId, scope.principalId),
            ),
          )
          .limit(1);
        if (company?.status !== "active") return [];
        const rows = await selectOwnRows(tx, ownRowsPredicate(scope)).limit(
          100,
        );
        // T06.04: the recall is per source (a revoked source's memories are
        // gone) and the Bot view masks the private source locator.
        const authorized = await filterSourceAuthorized(tx, scope, rows);
        return authorized.map(toBotView);
      });
    },
  };
}
