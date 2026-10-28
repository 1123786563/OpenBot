// server/src/enterprise/tenancy/purge-restore.ts
// MT068（Issue #111）：清理、保留与恢复带可核验归属与不可伪造 manifest。
//
// 票面语义：purge、retention 与 restore 操作都携带归属与发起权限，并以
// 不可伪造的 manifest 限定范围；不会仅凭 user_id 扫遍所有公司的外部文件
// 或凭据。
//
// 结构（纯新增，消费 MT067 清理域先例与 MT008 资源状态闭集，不改任何
// 既有文件）：
//
//   1. manifest 只由服务端生成（buildPurgeManifest）：枚举谓词 = 归属
//      (tenant [, workspace]) 内的资源行——不存在"仅凭 user_id 扫全
//      库"的通道；签名 = 服务端密钥对规范序列化（operation + 归属 +
//      清单 + 幂等键）的 HMAC-SHA256。执行入口只接受 manifestId（服务
//      端持久行），调用参数里出现任何 manifest 内容/签名/归属键一律
//      响亮拒绝（MANIFEST_NOT_CLIENT_DECLARABLE）——客户端提交的
//      manifest 被拒绝（AC1）。
//   2. 执行（executePurge）在同一 operator 事务内：重读 sealed 行 →
//      重算签名逐字比对（验签失败 = failed + 审计，零资源改动）→ 更新
//      谓词锁定 tenant + workspace + id ∈ 清单（AC2：跨公司资源结构性
//      不被扫描或删除——RLS 租户 pin + 谓词双保险）→ 状态 active →
//      deleted（沿用 enterprise_resources 既有状态闭集）。幂等：已
//      executed 的 manifest 重跑 = allow(already)，审计记 no-op（AC4）。
//   3. 恢复（restoreFromManifest）只恢复到原归属（AC3）：manifest 行
//      内嵌 (tenant, workspace)，恢复更新谓词同源；跨范围调用者对行
//      不可见（RLS + workspace 匹配 = canonical not-found），不产生
//      跨范围数据。
//   4. 审计（enterprise_purge_audit）只追加：sealed/executed/restored/
//      failed 四事件，任何角色零 UPDATE/DELETE（AC4 全程留审计）；失败
//      可安全重跑（幂等键唯一索引 + executed 判定收敛）。
//
// 事务纪律与 MT035/MT039/MT040 完全一致：受信 Scope → read committed +
// lock/statement timeout → set_config('app.*', …, true) 事务本地 →
// advisory 锁（tenant → principal → membership → manifest → resource）。
//
// 边界（诚实披露）：
//   - 本模块是 purge/retention/restore 的归属与 manifest 判定面；外部
//     文件存储的物理清理不在本票范围（manifest 已把范围钉死，外部执行
//     器按清单作业）。
//   - HMAC 密钥由装配层注入（测试注入测试密钥）；密钥轮换/托管属部署
//     线。

import { createHash, createHmac, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  enterprisePurgeAudit,
  enterprisePurgeManifests,
} from "../../db/schema/enterprise-purge-restore";
import {
  enterpriseMemberships,
  enterpriseResources,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import {
  assertDataDatabase,
  assertOperatorDatabase,
  type DataDatabase,
  type OperatorDatabase,
} from "./connections";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 词表与形状
// ---------------------------------------------------------------------------

export const PURGE_OPERATIONS = ["purge", "retention", "restore"] as const;

export type PurgeOperation = (typeof PURGE_OPERATIONS)[number];

export interface PurgeManifestView {
  readonly manifestId: string;
  readonly operation: PurgeOperation;
  readonly workspaceId: string | null;
  readonly itemCount: number;
  readonly status: string;
}

export interface PurgeManifestSignatureInvalid {
  readonly outcome: "deny";
  readonly code: "MANIFEST_SIGNATURE_INVALID";
}

export interface PurgeManifestNotExecuted {
  readonly outcome: "deny";
  readonly code: "MANIFEST_NOT_EXECUTED";
}

export type PurgeVerdict =
  | ({ readonly outcome: "allow" } & Record<string, unknown>)
  | ResourceNotFoundVerdict
  | PurgeManifestSignatureInvalid
  | PurgeManifestNotExecuted;

/** 调用参数里不可表达的 manifest 载荷键（内容/签名/归属一律服务端事）。 */
const MANIFEST_PAYLOAD_KEYS: readonly string[] = [
  "manifest",
  "itemRefs",
  "items",
  "signature",
  "signedManifest",
  "item_refs",
];

// ---------------------------------------------------------------------------
// 输入校验与签名
// ---------------------------------------------------------------------------

function assertScopeShape(scope: PlatformScope): void {
  assertTrustedScope(scope);
  if (!scope.tenantId?.trim()) throw new Error("TENANT_REQUIRED");
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
    throw new Error(`PURGE_INPUT_INVALID:${field}`);
  }
  return value;
}

/** 服务端规范序列化（清单排序后参与签名，防重排伪造）。 */
function canonicalManifest(input: {
  readonly operation: PurgeOperation;
  readonly tenantId: string;
  readonly workspaceId: string | null;
  readonly itemRefs: readonly string[];
  readonly idempotencyKey: string;
}): string {
  return JSON.stringify({
    idempotencyKey: input.idempotencyKey,
    itemRefs: [...input.itemRefs].sort(),
    operation: input.operation,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
  });
}

/** 签名工厂（装配注入密钥；纯函数可独立核验）。 */
export function signPurgeManifest(
  secretKey: string,
  input: {
    readonly operation: PurgeOperation;
    readonly tenantId: string;
    readonly workspaceId: string | null;
    readonly itemRefs: readonly string[];
    readonly idempotencyKey: string;
  },
): string {
  return createHmac("sha256", secretKey)
    .update(canonicalManifest(input))
    .digest("hex");
}

/** 幂等键派生（服务端：归属 + 清单摘要；调用方不可指定内容）。 */
export function deriveIdempotencyKey(
  operation: PurgeOperation,
  manifestId: string,
): string {
  return `${operation}:${createHash("sha256").update(manifestId).digest("hex").slice(0, 16)}`;
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

export interface PurgeRestoreService {
  /** 服务端生成并签名 manifest（枚举归属范围内的资源；幂等键收敛）。 */
  buildPurgeManifest(
    scope: PlatformScope,
    input: {
      readonly operation: PurgeOperation;
      readonly workspaceId?: string;
    } & Record<string, unknown>,
  ): Promise<PurgeVerdict>;
  /** 执行 sealed manifest（验签 → 范围谓词更新；幂等重跑收敛）。 */
  executePurge(
    scope: PlatformScope,
    input: { readonly manifestId: string } & Record<string, unknown>,
  ): Promise<PurgeVerdict>;
  /** 只恢复到原归属范围（跨范围调用者不可见）。 */
  restoreFromManifest(
    scope: PlatformScope,
    input: { readonly manifestId: string } & Record<string, unknown>,
  ): Promise<PurgeVerdict>;
  /** 审计探针（测试断言面）：本租户审计行。 */
  listAudit(
    scope: PlatformScope,
    input: { readonly manifestId: string },
  ): Promise<readonly { readonly event: string; readonly id: string }[]>;
}

/**
 * 装配入口。manifest 写与执行走受限 operator 通道；清单读取走受限
 * data 通道；未验证业务通道在装配时拒绝。
 */
export function createPurgeRestoreService(channels: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  /** 服务端 HMAC 密钥（装配注入；空密钥响亮拒绝）。 */
  readonly signingKey: string;
}): PurgeRestoreService {
  assertDataDatabase(channels.data);
  assertOperatorDatabase(channels.operator);
  if (typeof channels.signingKey !== "string" || !channels.signingKey.trim()) {
    throw new Error("PURGE_SIGNING_KEY_REQUIRED");
  }
  const { data, operator, signingKey } = channels;

  type Tx =
    | Parameters<Parameters<DataDatabase["transaction"]>[0]>[0]
    | Parameters<Parameters<OperatorDatabase["transaction"]>[0]>[0];

  const beginContext = async (
    tx: Tx,
    scope: PlatformScope,
    workspaceId?: string | null,
  ): Promise<void> => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '10s'`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${workspaceId ?? ""}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
    );
  };

  const takeLocks = async (
    tx: Tx,
    keys: readonly { readonly key: string; readonly exclusive: boolean }[],
  ): Promise<void> => {
    for (const { key, exclusive } of keys) {
      await tx.execute(
        exclusive
          ? sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`
          : sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
      );
    }
  };

  const manifestLockKey = (tenantId: string, manifestId: string): string =>
    JSON.stringify(["enterprise", "purge-manifest", tenantId, manifestId]);

  const appendAudit = async (
    tx: Tx,
    input: {
      readonly tenantId: string;
      readonly manifestId: string;
      readonly event: "sealed" | "executed" | "restored" | "failed";
      readonly actorPrincipalId: string;
      readonly detail: Record<string, unknown>;
    },
  ): Promise<void> => {
    await tx.insert(enterprisePurgeAudit).values({
      tenantId: input.tenantId,
      id: `mt068-audit-${randomUUID()}`,
      manifestId: input.manifestId,
      event: input.event,
      actorPrincipalId: input.actorPrincipalId,
      detail: input.detail,
    });
  };

  /** 撤权即失效：公司成员资格（active + epoch）每事务现读。 */
  const membershipActive = async (
    tx: Tx,
    scope: PlatformScope,
  ): Promise<boolean> => {
    const [row] = await tx
      .select({
        status: enterpriseMemberships.status,
        epoch: enterpriseMemberships.epoch,
      })
      .from(enterpriseMemberships)
      .where(
        and(
          eq(enterpriseMemberships.tenantId, scope.tenantId),
          eq(enterpriseMemberships.principalId, scope.principalId),
        ),
      )
      .limit(1);
    return row?.status === "active" && row?.epoch === scope.memberEpoch;
  };

  const assertNoClientManifestPayload = (
    input: Record<string, unknown>,
  ): void => {
    for (const key of Object.keys(input)) {
      if (MANIFEST_PAYLOAD_KEYS.includes(key)) {
        throw new Error("MANIFEST_NOT_CLIENT_DECLARABLE");
      }
    }
  };

  return {
    async buildPurgeManifest(scope, input) {
      assertScopeShape(scope);
      if (
        !input ||
        !(PURGE_OPERATIONS as readonly string[]).includes(input.operation)
      ) {
        throw new Error("PURGE_OPERATION_INVALID");
      }
      assertNoClientManifestPayload(input);
      const workspaceId =
        typeof input.workspaceId === "string" && input.workspaceId.trim()
          ? assertPlainString(input.workspaceId, "workspaceId", 256)
          : null;
      const manifestId = `mt068-manifest-${randomUUID()}`;
      const idempotencyKey = deriveIdempotencyKey(input.operation, manifestId);
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope, workspaceId);
        await takeLocks(tx, [
          {
            key: JSON.stringify(["enterprise", "tenant", scope.tenantId]),
            exclusive: false,
          },
          {
            key: JSON.stringify([
              "enterprise",
              "membership",
              scope.tenantId,
              scope.principalId,
            ]),
            exclusive: false,
          },
          { key: manifestLockKey(scope.tenantId, manifestId), exclusive: true },
        ]);
        if (!(await membershipActive(tx, scope))) return notFoundVerdict();
        // 服务端枚举：归属范围内的资源行（tenant [+ workspace]）——不存在
        // "仅凭 user_id 扫全库"的通道。
        const rows = await tx
          .select({ id: enterpriseResources.id })
          .from(enterpriseResources)
          .where(
            and(
              eq(enterpriseResources.tenantId, scope.tenantId),
              eq(enterpriseResources.status, "active"),
              ...(workspaceId
                ? [eq(enterpriseResources.workspaceId, workspaceId)]
                : []),
            ),
          )
          .limit(1000);
        const itemRefs = rows.map((row) => row.id);
        const signature = signPurgeManifest(signingKey, {
          operation: input.operation,
          tenantId: scope.tenantId,
          workspaceId,
          itemRefs,
          idempotencyKey,
        });
        await tx.insert(enterprisePurgeManifests).values({
          tenantId: scope.tenantId,
          id: manifestId,
          operation: input.operation,
          workspaceId,
          principalId: scope.principalId,
          itemRefs,
          signature,
          idempotencyKey,
        });
        await appendAudit(tx, {
          tenantId: scope.tenantId,
          manifestId,
          event: "sealed",
          actorPrincipalId: scope.principalId,
          detail: { itemCount: itemRefs.length, operation: input.operation },
        });
        return deepFreeze({
          outcome: "allow",
          manifestId,
          itemCount: itemRefs.length,
        });
      });
    },

    async executePurge(scope, input) {
      assertScopeShape(scope);
      const manifestId = assertPlainString(
        input?.manifestId,
        "manifestId",
        256,
      );
      assertNoClientManifestPayload(input ?? {});
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          {
            key: JSON.stringify(["enterprise", "tenant", scope.tenantId]),
            exclusive: false,
          },
          { key: manifestLockKey(scope.tenantId, manifestId), exclusive: true },
        ]);
        if (!(await membershipActive(tx, scope))) return notFoundVerdict();
        const [manifest] = await tx
          .select({
            operation: enterprisePurgeManifests.operation,
            workspaceId: enterprisePurgeManifests.workspaceId,
            itemRefs: enterprisePurgeManifests.itemRefs,
            signature: enterprisePurgeManifests.signature,
            status: enterprisePurgeManifests.status,
            idempotencyKey: enterprisePurgeManifests.idempotencyKey,
          })
          .from(enterprisePurgeManifests)
          .where(
            and(
              eq(enterprisePurgeManifests.tenantId, scope.tenantId),
              eq(enterprisePurgeManifests.id, manifestId),
            ),
          )
          .limit(1);
        if (!manifest) return notFoundVerdict();
        // 幂等：已执行 = 收敛（审计记 no-op），不是失败。
        if (manifest.status === "executed") {
          await appendAudit(tx, {
            tenantId: scope.tenantId,
            manifestId,
            event: "executed",
            actorPrincipalId: scope.principalId,
            detail: { idempotentReplay: true },
          });
          return deepFreeze({ outcome: "allow", manifestId, already: true });
        }
        // 验签：重算逐字比对（失败 = failed + 审计，零资源改动）。
        const expected = signPurgeManifest(signingKey, {
          operation: manifest.operation as PurgeOperation,
          tenantId: scope.tenantId,
          workspaceId: manifest.workspaceId,
          itemRefs: (manifest.itemRefs as string[]) ?? [],
          idempotencyKey: manifest.idempotencyKey,
        });
        if (expected !== manifest.signature) {
          await tx
            .update(enterprisePurgeManifests)
            .set({ status: "failed" })
            .where(
              and(
                eq(enterprisePurgeManifests.tenantId, scope.tenantId),
                eq(enterprisePurgeManifests.id, manifestId),
              ),
            );
          await appendAudit(tx, {
            tenantId: scope.tenantId,
            manifestId,
            event: "failed",
            actorPrincipalId: scope.principalId,
            detail: { reason: "signature-mismatch" },
          });
          return deepFreeze({
            outcome: "deny",
            code: "MANIFEST_SIGNATURE_INVALID",
          });
        }
        const itemRefs = ((manifest.itemRefs as string[]) ?? []).filter(
          (ref) => typeof ref === "string",
        );
        // 逐项作业：operator 的 UPDATE 行策略按 app.resource_id 逐资源
        // pin（一次一行），范围谓词 = tenant + workspace + id ∈ 清单——
        // 跨公司资源结构性不被扫描或删除（RLS 租户 pin + 谓词双保险）。
        let purgedCount = 0;
        for (const ref of itemRefs) {
          await tx.execute(
            sql`select set_config('app.resource_id', ${ref}, true)`,
          );
          const updated = await tx
            .update(enterpriseResources)
            .set({
              status: "deleted",
              revision: sql`${enterpriseResources.revision} + 1`,
            })
            .where(
              and(
                eq(enterpriseResources.tenantId, scope.tenantId),
                ...(manifest.workspaceId
                  ? [eq(enterpriseResources.workspaceId, manifest.workspaceId)]
                  : []),
                eq(enterpriseResources.id, ref),
                eq(enterpriseResources.status, "active"),
              ),
            )
            .returning({ id: enterpriseResources.id });
          purgedCount += updated.length;
        }
        await tx
          .update(enterprisePurgeManifests)
          .set({ status: "executed", executedAt: new Date() })
          .where(
            and(
              eq(enterprisePurgeManifests.tenantId, scope.tenantId),
              eq(enterprisePurgeManifests.id, manifestId),
            ),
          );
        await appendAudit(tx, {
          tenantId: scope.tenantId,
          manifestId,
          event: "executed",
          actorPrincipalId: scope.principalId,
          detail: { purgedCount },
        });
        return deepFreeze({
          outcome: "allow",
          manifestId,
          purgedCount,
        });
      });
    },

    async restoreFromManifest(scope, input) {
      assertScopeShape(scope);
      const manifestId = assertPlainString(
        input?.manifestId,
        "manifestId",
        256,
      );
      assertNoClientManifestPayload(input ?? {});
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          {
            key: JSON.stringify(["enterprise", "tenant", scope.tenantId]),
            exclusive: false,
          },
          { key: manifestLockKey(scope.tenantId, manifestId), exclusive: true },
        ]);
        if (!(await membershipActive(tx, scope))) return notFoundVerdict();
        const [manifest] = await tx
          .select({
            workspaceId: enterprisePurgeManifests.workspaceId,
            itemRefs: enterprisePurgeManifests.itemRefs,
            status: enterprisePurgeManifests.status,
          })
          .from(enterprisePurgeManifests)
          .where(
            and(
              eq(enterprisePurgeManifests.tenantId, scope.tenantId),
              eq(enterprisePurgeManifests.id, manifestId),
            ),
          )
          .limit(1);
        if (!manifest) return notFoundVerdict();
        // 只恢复到原归属范围：manifest 行内嵌 workspace；跨范围调用者
        // （不同 workspace 的 scope）不可见。
        if (
          manifest.workspaceId &&
          scope.workspaceId &&
          manifest.workspaceId !== scope.workspaceId
        ) {
          return notFoundVerdict();
        }
        if (manifest.status !== "executed") {
          return deepFreeze({ outcome: "deny", code: "MANIFEST_NOT_EXECUTED" });
        }
        const itemRefs = ((manifest.itemRefs as string[]) ?? []).filter(
          (ref) => typeof ref === "string",
        );
        // 逐项恢复（同 execute 的行策略纪律）：只回 manifest 记录的原
        // 归属范围，不产生跨范围数据。
        let restoredCount = 0;
        for (const ref of itemRefs) {
          await tx.execute(
            sql`select set_config('app.resource_id', ${ref}, true)`,
          );
          const updated = await tx
            .update(enterpriseResources)
            .set({
              status: "active",
              revision: sql`${enterpriseResources.revision} + 1`,
            })
            .where(
              and(
                eq(enterpriseResources.tenantId, scope.tenantId),
                ...(manifest.workspaceId
                  ? [eq(enterpriseResources.workspaceId, manifest.workspaceId)]
                  : []),
                eq(enterpriseResources.id, ref),
                eq(enterpriseResources.status, "deleted"),
              ),
            )
            .returning({ id: enterpriseResources.id });
          restoredCount += updated.length;
        }
        await appendAudit(tx, {
          tenantId: scope.tenantId,
          manifestId,
          event: "restored",
          actorPrincipalId: scope.principalId,
          detail: { restoredCount },
        });
        return deepFreeze({
          outcome: "allow",
          manifestId,
          restoredCount,
        });
      });
    },

    async listAudit(scope, input) {
      assertScopeShape(scope);
      const manifestId = assertPlainString(
        input?.manifestId,
        "manifestId",
        256,
      );
      // 审计面归 operator 读通道（MT069 审计先例；data 无审计表授权）。
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        // 撤权即失效（与 build/execute/restore 同款纪律）：现读成员资格。
        // 列表面的「不可见 = 空页」与 countBots/listBots 同例，不泄露存在性。
        if (!(await membershipActive(tx, scope))) return deepFreeze([]);
        const rows = await tx
          .select({
            id: enterprisePurgeAudit.id,
            event: enterprisePurgeAudit.event,
          })
          .from(enterprisePurgeAudit)
          .where(
            and(
              eq(enterprisePurgeAudit.tenantId, scope.tenantId),
              eq(enterprisePurgeAudit.manifestId, manifestId),
            ),
          );
        return deepFreeze(rows);
      });
    },
  };
}
