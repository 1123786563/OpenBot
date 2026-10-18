// MT036（Issue #79）共享夹具：知识库团队归属与受限查询。
//
// 契约：主库（企业测试库，MT008 support 全套受限通道）+ KB 专用测试库
// （KB_TEST_DATABASE_URL，专用受限登录属主通道跑 drizzle-kb 迁移）。缺任一
// 显式 env 由调用方整套显式 skip，绝不回退开发库、skipped 不计通过。
//
// 组成（只读消费既有交付，零改动）：
//   - MT008 support（createResourcePolicyFixture）：身份矩阵、真实 resolver
//     seam、三个已验证受限通道、可见性标记与成员状态翻转。
//   - MT011 同款披露 stand-in：tenant policy_revision 翻转、归属迁移与版本
//     推进、KB 侧内容行管理走 setup 通道（owner/operator 角色对
//     enterprise_resources 无整行 UPDATE 授权——MT008 只授予了 visibility
//     列级 UPDATE；归属迁移的管理写路径属后续管理票）。判定侧从不使用——
//     全部被测查询经受限 data 角色与真实 RLS。
// 本票新增：
//   - KB 库侧种子（knowledge_bases + knowledge_base_ownership_states 镜像行）；
//   - 主库侧 knowledge 注册（operator 策略内 INSERT + 可选 grant + 可见性）；
//   - 归属迁移动作（setup 披露 stand-in：workspace_id + revision 自增；
//     KB 侧镜像行按参数同步——不同步即制造可观测的不一致）；
//   - MT009 依赖行（kind='knowledge'）种子。

import { randomUUID } from "node:crypto";
import { like, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createDatabase, type Database } from "../../../src/db/client";
import {
  enterpriseResourceGrants,
  enterpriseResources,
} from "../../../src/db/schema";
import { kbSyncVersionOf } from "../../../src/enterprise/tenancy/kb-ownership";
import type { Db as KbDb } from "../../../src/kb/db/client";
import { knowledgeBaseOwnershipStates } from "../../../src/kb/db/ownership-schema";
import { knowledgeBases } from "../../../src/kb/db/schema";
import {
  enterpriseSetupDatabaseVariable,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";
import type { FixtureIdentity } from "./fixture";
import {
  createResourcePolicyFixture,
  type ResourcePolicyFixture,
  type TeamKey,
} from "./resource-policy";

/** 环境探针：企业测试库 + KB 专用测试库缺一不可，显式 skip 绝不回退开发库。 */
export function probeKbOwnershipEnvironment():
  | { ok: true }
  | { ok: false; reason: string } {
  const enterpriseVariable = enterpriseSetupDatabaseVariable();
  if (!process.env[enterpriseVariable]?.trim()) {
    return {
      ok: false,
      reason: `MT036 requires ${enterpriseVariable} (dedicated openbot_enterprise_* test database) — no dev-database fallback`,
    };
  }
  if (!process.env.KB_TEST_DATABASE_URL?.trim()) {
    return {
      ok: false,
      reason:
        "MT036 requires KB_TEST_DATABASE_URL (dedicated knowledge-base test database) — no dev-database fallback",
    };
  }
  return { ok: true };
}

export interface KbOwnershipFixture {
  readonly ent: ResourcePolicyFixture;
  /** KB 专用测试库连接（专用受限登录属主通道；企业侧角色与此库无关）。 */
  readonly kbDb: KbDb;
  /** 本轮运行隔离前缀（KB 行与依赖行按此前缀清理）。 */
  readonly runId: string;
  /**
   * 披露的 setup 通道 stand-in（MT011 同款）：翻转租户 policy_revision。
   * 判定侧从不使用；workspace-v1 的团队公共语义经真实注册表求值验证。
   */
  setTenantPolicyRevision(tenantId: string, revision: string): Promise<void>;
  /**
   * 种子一个知识库：KB 库行 + 主库 knowledge 注册（operator 策略内）+
   * 可选 read 授权 + 可见性标记 + KB 侧归属镜像行（真实 kbSyncVersionOf）。
   * 返回 kbId。
   */
  seedKnowledgeBase(input: {
    key: string;
    tenantId: string;
    workspaceId: string;
    name: string;
    visibility?: "workspace" | "private" | null;
    readers?: readonly { identity: FixtureIdentity; teamKey: TeamKey }[];
  }): Promise<string>;
  /**
   * 归属迁移动作：workspace_id 变更 + revision 自增（setup 披露 stand-in：
   * 整行 UPDATE 的管理写路径属后续管理票；资源排他 advisory 锁与判定侧
   * 共享锁同键族）；syncKbSide=false 时刻意不同步 KB 侧镜像行（制造可观测
   * 不一致）。
   */
  moveKnowledgeBaseOwnership(input: {
    tenantId: string;
    kbId: string;
    toWorkspaceId: string;
    syncKbSide: boolean;
  }): Promise<void>;
  /** 团队不变的版本推进（revision 自增）；syncKbSide 语义同上。 */
  bumpRegistrationRevision(input: {
    tenantId: string;
    kbId: string;
    syncKbSide: boolean;
  }): Promise<void>;
  /** 按主库当前事实重写 KB 侧镜像行（真实 kbSyncVersionOf）。 */
  syncKbOwnershipState(input: {
    tenantId: string;
    kbId: string;
  }): Promise<void>;
  /** MT009 依赖行（kind='knowledge'，status='active'）——跨库引用演示面。 */
  seedKnowledgeDependency(input: {
    tenantId: string;
    resourceId: string;
    kbId: string;
  }): Promise<void>;
  /** KB 库内容行软删（跨库内容缺失演示面）。 */
  softDeleteKbRow(input: { kbId: string }): Promise<void>;
  /**
   * 主库注册 kind 漂移演示面（setup 披露 stand-in）：把 knowledge 注册改成
   * 其他 kind——非 knowledge 注册绝不能当作知识库服务。
   */
  corruptRegistrationKind(input: {
    tenantId: string;
    kbId: string;
    kind: string;
  }): Promise<void>;
  dispose(): Promise<void>;
}

export async function createKbOwnershipFixture(): Promise<KbOwnershipFixture> {
  const ent = await createResourcePolicyFixture();
  const kbUrl = process.env.KB_TEST_DATABASE_URL as string;
  const kbSql = postgres(kbUrl, {
    max: 4,
    idle_timeout: 5,
    connect_timeout: 10,
  });
  const kbDb = drizzle(kbSql, {
    schema: { knowledgeBases, knowledgeBaseOwnershipStates },
  });
  const runId = `mt036-${randomUUID().slice(0, 8)}`;
  const setup: Database = createDatabase(enterpriseTestDatabaseUrlFrom(), {
    max: 1,
  });

  const operatorContextTx = async (
    tenantId: string,
    resourceId: string | null,
    body: (
      tx: Parameters<
        Parameters<ResourcePolicyFixture["operator"]["transaction"]>[0]
      >[0],
    ) => Promise<void>,
  ): Promise<void> => {
    await ent.operator.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '2s'`);
      await tx.execute(sql`set local statement_timeout = '5s'`);
      if (resourceId === null) {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
      } else {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.resource_id', ${resourceId}, true)`,
        );
      }
      await body(tx);
    });
  };

  /** 经受限 data 通道读注册事实（workspace/revision/aclEpoch），缺失为 null。 */
  const readRegistrationFacts = async (
    tenantId: string,
    kbId: string,
  ): Promise<{
    workspaceId: string;
    revision: number;
    aclEpoch: number;
  } | null> => {
    return ent.data.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${tenantId}, true)`,
      );
      const rows = await tx
        .select({
          workspaceId: enterpriseResources.workspaceId,
          revision: enterpriseResources.revision,
          aclEpoch: enterpriseResources.aclEpoch,
        })
        .from(enterpriseResources)
        .where(
          sql`${enterpriseResources.tenantId} = ${tenantId} and ${enterpriseResources.id} = ${kbId} and kind = 'knowledge'`,
        )
        .limit(1);
      return rows[0] ?? null;
    });
  };

  const syncKbOwnershipState = async (input: {
    tenantId: string;
    kbId: string;
  }): Promise<void> => {
    const facts = await readRegistrationFacts(input.tenantId, input.kbId);
    if (facts === null) {
      throw new Error(
        `KB_SYNC_SEED_FAILED: no knowledge registration for ${input.kbId}`,
      );
    }
    await kbDb
      .insert(knowledgeBaseOwnershipStates)
      .values({
        knowledgeBaseId: input.kbId,
        tenantId: input.tenantId,
        workspaceId: facts.workspaceId,
        syncVersion: kbSyncVersionOf(facts),
      })
      .onConflictDoUpdate({
        target: knowledgeBaseOwnershipStates.knowledgeBaseId,
        set: {
          tenantId: input.tenantId,
          workspaceId: facts.workspaceId,
          syncVersion: kbSyncVersionOf(facts),
          updatedAt: new Date(),
        },
      });
  };

  let disposed = false;
  const fixture: KbOwnershipFixture = {
    ent,
    kbDb,
    runId,

    async setTenantPolicyRevision(tenantId, revision) {
      await setup.transaction(async (tx) => {
        await tx.execute(sql`
          update enterprise_tenants
          set policy_revision = ${revision}
          where id = ${tenantId}
        `);
      });
    },

    async seedKnowledgeBase({
      key,
      tenantId,
      workspaceId,
      name,
      visibility = null,
      readers = [],
    }) {
      const kbId = `${runId}-${key}`;
      await kbDb.insert(knowledgeBases).values({
        id: kbId,
        tenantId,
        name,
        chunkingConfig: {
          chunkSize: 512,
          chunkOverlap: 64,
          separators: ["\n\n"],
          strategy: "auto",
        },
        embeddingModelId: "mt036-test-embedder",
      });
      await operatorContextTx(tenantId, null, async (tx) => {
        await tx.insert(enterpriseResources).values({
          tenantId,
          id: kbId,
          workspaceId,
          kind: "knowledge",
          displayName: name,
        });
        for (const reader of readers) {
          const principal = ent.teamOf(reader.identity, reader.teamKey);
          await tx.insert(enterpriseResourceGrants).values({
            tenantId,
            resourceId: kbId,
            principalId: principal.principalId,
            action: "read",
          });
        }
      });
      if (visibility !== null) {
        await ent.markVisibility({ tenantId, resourceId: kbId, visibility });
      }
      await syncKbOwnershipState({ tenantId, kbId });
      return kbId;
    },

    async moveKnowledgeBaseOwnership({
      tenantId,
      kbId,
      toWorkspaceId,
      syncKbSide,
    }) {
      await setup.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
            "enterprise",
            "resource",
            tenantId,
            kbId,
          ])}, 0))`,
        );
        const rows = await tx
          .update(enterpriseResources)
          .set({
            workspaceId: toWorkspaceId,
            revision: sql`${enterpriseResources.revision} + 1`,
          })
          .where(
            sql`${enterpriseResources.tenantId} = ${tenantId} and ${enterpriseResources.id} = ${kbId} and kind = 'knowledge'`,
          )
          .returning({ id: enterpriseResources.id });
        if (rows.length !== 1) {
          throw new Error(`KB_MOVE_FAILED:${kbId}:${rows.length}`);
        }
      });
      if (syncKbSide) await syncKbOwnershipState({ tenantId, kbId });
    },

    async bumpRegistrationRevision({ tenantId, kbId, syncKbSide }) {
      await setup.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
            "enterprise",
            "resource",
            tenantId,
            kbId,
          ])}, 0))`,
        );
        const rows = await tx
          .update(enterpriseResources)
          .set({ revision: sql`${enterpriseResources.revision} + 1` })
          .where(
            sql`${enterpriseResources.tenantId} = ${tenantId} and ${enterpriseResources.id} = ${kbId} and kind = 'knowledge'`,
          )
          .returning({ id: enterpriseResources.id });
        if (rows.length !== 1) {
          throw new Error(`KB_BUMP_FAILED:${kbId}:${rows.length}`);
        }
      });
      if (syncKbSide) await syncKbOwnershipState({ tenantId, kbId });
    },

    syncKbOwnershipState,

    async seedKnowledgeDependency({ tenantId, resourceId, kbId }) {
      await operatorContextTx(tenantId, null, async (tx) => {
        await tx.execute(sql`
          insert into enterprise_resource_dependencies
            (tenant_id, resource_id, dependency_kind, dependency_ref, status)
          values (${tenantId}, ${resourceId}, 'knowledge', ${kbId}, 'active')
          on conflict do nothing
        `);
      });
    },

    async softDeleteKbRow({ kbId }) {
      await kbDb
        .update(knowledgeBases)
        .set({ deletedAt: new Date() })
        .where(like(knowledgeBases.id, kbId));
    },

    async corruptRegistrationKind({ tenantId, kbId, kind }) {
      await setup.transaction(async (tx) => {
        const rows = await tx
          .update(enterpriseResources)
          .set({ kind })
          .where(
            sql`${enterpriseResources.tenantId} = ${tenantId} and ${enterpriseResources.id} = ${kbId}`,
          )
          .returning({ id: enterpriseResources.id });
        if (rows.length !== 1) {
          throw new Error(`KB_KIND_CORRUPT_FAILED:${kbId}:${rows.length}`);
        }
      });
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      await kbDb
        .delete(knowledgeBaseOwnershipStates)
        .where(
          like(knowledgeBaseOwnershipStates.knowledgeBaseId, `${runId}-%`),
        );
      await kbDb
        .delete(knowledgeBases)
        .where(like(knowledgeBases.id, `${runId}-%`));
      await kbSql.end({ timeout: 5 });
      await setup.$client.close().catch(() => {});
      await ent.dispose();
    },
  };
  return fixture;
}

/** KB 库迁移（drizzle-kb journal，幂等 + advisory lock；专用受限登录通道）。 */
export async function applyKbOwnershipMigrations(): Promise<void> {
  const { runMigrations } = await import("../../../src/kb/db/migrate");
  await runMigrations(process.env.KB_TEST_DATABASE_URL as string);
}
