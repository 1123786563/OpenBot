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
// 事务纪律与 MT019/MT034/MT035 完全一致：受信 Scope（assertTrustedScope）
// → read committed + lock/statement timeout → set_config('app.*', …, true)
// 事务本地 → advisory 锁（tenant → principal → membership）。
//
// 边界（诚实披露）：
//   - 本模块是记忆归属判定面，不接 HTTP 路由（挂路由属下游接线票）；
//   - 语义检索（embedding）不在本票范围：searchMemories 是键/内容包含
//     匹配，向量检索属 Intelligence 域后续票。

import { randomUUID } from "node:crypto";
import { and, eq, ilike, or, type SQL, sql } from "drizzle-orm";
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

/** 来源选择列出的资源种类（库与文档）。 */
const SOURCE_RESOURCE_KINDS = ["knowledge_base", "document"] as const;

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

  const ownRowsPredicate = (scope: PlatformScope) =>
    and(
      eq(enterprisePersonalMemories.tenantId, scope.tenantId),
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

  const toView = (row: {
    id: string;
    memoryKey: string;
    content: string;
    sourceKind: string;
    sourceRef: string | null;
  }): MemoryView =>
    deepFreeze({
      memoryId: row.id,
      memoryKey: row.memoryKey,
      content: row.content,
      sourceKind: row.sourceKind as MemorySourceKind,
      sourceRef: row.sourceRef,
    });

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
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, scope);
        const rows = await selectOwnRows(
          tx,
          and(
            ownRowsPredicate(scope),
            or(
              ilike(enterprisePersonalMemories.memoryKey, `%${query}%`),
              ilike(enterprisePersonalMemories.content, `%${query}%`),
            ),
          ),
        ).limit(100);
        return rows.map(toView);
      });
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
        return rows.map(toView);
      });
    },
  };
}
