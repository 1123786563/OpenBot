// server/src/enterprise/tenancy/learning-demonstrations.ts
// MT040（Issue #83）：学习容器、研究与演示记录隔离。
//
// 票面语义：学习容器、连接应用研究与演示记录按归属隔离；外部学习服务
// 不会把不同公司的客户内容放进同一个容器或同一个命名空间。
//
// 结构（纯新增，不改任何既有文件）：
//
//   1. 容器分配（allocateContainer / releaseContainer）：一行 = 一次
//      分配，归属 = 受信 scope 的 (tenant, workspace)。namespace 由
//      服务端从归属键派生（learningNamespace 工厂：sha256(归属键) 十六
//      进制摘要），绝不掺调用方输入——带凭据字样的输入也进不了 namespace
//      （AC3：不含明文凭据，DB CHECK 钉死形状）。回收后不复用：每次
//      allocate 都建新行（新 id + 同归属新派生 namespace），旧容器状态
//      不迁移（AC1）；把已回收容器交给另一范围 = 结构性不可能（新行从
//      不指向旧行）。
//   2. 研究与演示记录（recordResearch / recordDemonstration /
//      listRecords）：归属 (tenant, workspace, principal) + 容器外键。
//      列表读取谓词 = 本团队 + 现读团队成员 active + 公司成员
//      active/epoch（AC2：他团队/他公司 = canonical not-found 语义的空
//      页，错误与计数不泄露存在性）。
//   3. 撤销访问后运行中的学习任务在下一个敏感动作处失败（AC4）：
//      allocate/record/list 每次事务内现读公司成员资格（MT006 epoch），
//      撤权后已签发 scope 立即失效——后续动作 canonical not-found，
//      不再继续。
//
// 事务纪律与 MT035/MT039 完全一致：受信 Scope → read committed +
// lock/statement timeout → set_config('app.*', …, true) 事务本地 →
// advisory 锁（tenant → principal → membership → workspace-membership →
// container → record）。
//
// 边界（诚实披露）：
//   - 外部学习服务（远程容器编排）不在本票打通：namespace 隔离以本地
//     确定性事实覆盖（工厂纯函数 + DB CHECK + 跨公司断言），真实外部
//     服务联调标记为未验证（票面备注：不编造证据）。
//   - 本模块是归属判定面，不接 HTTP 路由（挂路由属下游接线票）。

import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  enterpriseLearningContainers,
  enterpriseLearningRecords,
} from "../../db/schema/enterprise-learning";
import {
  enterpriseMemberships,
  enterpriseWorkspaceMemberships,
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
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 词表与形状
// ---------------------------------------------------------------------------

export const LEARNING_RECORD_KINDS = ["research", "demonstration"] as const;

export type LearningRecordKind = (typeof LEARNING_RECORD_KINDS)[number];

export interface LearningRecordView {
  readonly recordId: string;
  readonly kind: LearningRecordKind;
  readonly title: string;
  readonly containerId: string;
}

export type LearningVerdict =
  | ({ readonly outcome: "allow" } & Record<string, unknown>)
  | ResourceNotFoundVerdict;

/**
 * 外部服务命名空间工厂（AC3）：只由归属键派生，绝不掺调用方输入。
 * 纯函数，可独立核验：同归属稳定，跨归属不同。
 */
export function learningNamespace(scope: {
  readonly tenantId: string;
  readonly workspaceId: string;
}): string {
  const digest = createHash("sha256")
    .update(`${scope.tenantId}:${scope.workspaceId}`)
    .digest("hex")
    .slice(0, 32);
  return `mt040-ns-${digest}`;
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
    throw new Error(`LEARNING_INPUT_INVALID:${field}`);
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

export interface LearningDemonstrationService {
  /** 分配容器（归属 = scope；namespace 服务端派生，含凭据字样也进不去）。 */
  allocateContainer(
    scope: PlatformScope,
    input?: Record<string, unknown>,
  ): Promise<LearningVerdict>;
  /** 释放容器（operator 管理通道）；回收后不复用给任何范围。 */
  releaseContainer(
    scope: PlatformScope,
    input: { readonly containerId: string },
  ): Promise<LearningVerdict>;
  /** 研究记录（归属 = scope；容器必须本范围可见且未释放）。 */
  recordResearch(
    scope: PlatformScope,
    input: {
      readonly containerId: string;
      readonly title: string;
      readonly payload: string;
    },
  ): Promise<LearningVerdict>;
  /** 演示记录（同上）。 */
  recordDemonstration(
    scope: PlatformScope,
    input: {
      readonly containerId: string;
      readonly title: string;
      readonly payload: string;
    },
  ): Promise<LearningVerdict>;
  /** 本范围可见的研究与演示记录（他范围 = 空页，不泄露存在性）。 */
  listRecords(
    scope: PlatformScope,
    input?: { readonly kind?: LearningRecordKind },
  ): Promise<readonly LearningRecordView[]>;
}

/**
 * 装配入口。分配/记录走受限 data 通道，释放走受限 operator 通道；
 * 未验证业务通道在装配时拒绝。
 */
export function createLearningDemonstrationService(channels: {
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
}): LearningDemonstrationService {
  assertDataDatabase(channels.data);
  assertOperatorDatabase(channels.operator);
  const { data, operator } = channels;

  type Tx =
    | Parameters<Parameters<DataDatabase["transaction"]>[0]>[0]
    | Parameters<Parameters<OperatorDatabase["transaction"]>[0]>[0];

  const beginContext = async (tx: Tx, scope: PlatformScope): Promise<void> => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
    );
  };

  const baseLockKeys = (scope: PlatformScope): readonly string[] => [
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
  ];

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

  const record = async (
    scope: PlatformScope,
    kind: LearningRecordKind,
    input: {
      readonly containerId: string;
      readonly title: string;
      readonly payload: string;
    },
  ): Promise<LearningVerdict> => {
    assertScopeShape(scope);
    const containerId = assertPlainString(
      input?.containerId,
      "containerId",
      256,
    );
    const title = assertPlainString(input?.title, "title", 512);
    assertPlainString(input?.payload, "payload", 65536);
    const recordId = `mt040-record-${randomUUID()}`;
    return data.transaction(async (tx) => {
      await beginContext(tx, scope);
      await takeLocks(
        tx,
        baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
      );
      if (!(await membershipActive(tx, scope))) return notFoundVerdict();
      const [container] = await tx
        .select({
          workspaceId: enterpriseLearningContainers.workspaceId,
          status: enterpriseLearningContainers.status,
        })
        .from(enterpriseLearningContainers)
        .where(
          and(
            eq(enterpriseLearningContainers.tenantId, scope.tenantId),
            eq(enterpriseLearningContainers.id, containerId),
          ),
        )
        .limit(1);
      if (
        !container ||
        container.workspaceId !== scope.workspaceId ||
        container.status !== "allocated"
      ) {
        return notFoundVerdict();
      }
      await tx.insert(enterpriseLearningRecords).values({
        tenantId: scope.tenantId,
        id: recordId,
        workspaceId: scope.workspaceId,
        principalId: scope.principalId,
        containerId,
        kind,
        title,
        payload: input.payload,
      });
      return deepFreeze({ outcome: "allow", recordId });
    });
  };

  return {
    async allocateContainer(scope) {
      assertScopeShape(scope);
      const containerId = `mt040-container-${randomUUID()}`;
      const namespace = learningNamespace(scope);
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(
          tx,
          baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
        );
        if (!(await membershipActive(tx, scope))) return notFoundVerdict();
        // 输入只作为声明性提示存在：namespace 唯一来源是归属键派生，
        // 调用方提供的任何字段（含凭据字样）都进不了 namespace。
        await tx.insert(enterpriseLearningContainers).values({
          tenantId: scope.tenantId,
          id: containerId,
          workspaceId: scope.workspaceId,
          namespace,
          allocatedByPrincipalId: scope.principalId,
        });
        return deepFreeze({ outcome: "allow", containerId, namespace });
      });
    },

    async releaseContainer(scope, input) {
      assertScopeShape(scope);
      const containerId = assertPlainString(
        input?.containerId,
        "containerId",
        256,
      );
      return operator.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(tx, [
          ...baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
          {
            key: JSON.stringify([
              "enterprise",
              "learning-container",
              scope.tenantId,
              containerId,
            ]),
            exclusive: true,
          },
        ]);
        if (!(await membershipActive(tx, scope))) return notFoundVerdict();
        const [container] = await tx
          .select({
            workspaceId: enterpriseLearningContainers.workspaceId,
            status: enterpriseLearningContainers.status,
          })
          .from(enterpriseLearningContainers)
          .where(
            and(
              eq(enterpriseLearningContainers.tenantId, scope.tenantId),
              eq(enterpriseLearningContainers.id, containerId),
            ),
          )
          .limit(1);
        if (!container || container.workspaceId !== scope.workspaceId) {
          return notFoundVerdict();
        }
        if (container.status === "released") {
          return deepFreeze({ outcome: "allow", containerId, already: true });
        }
        await tx
          .update(enterpriseLearningContainers)
          .set({ status: "released", releasedAt: new Date() })
          .where(
            and(
              eq(enterpriseLearningContainers.tenantId, scope.tenantId),
              eq(enterpriseLearningContainers.id, containerId),
            ),
          );
        return deepFreeze({ outcome: "allow", containerId });
      });
    },

    recordResearch: (scope, input) => record(scope, "research", input),
    recordDemonstration: (scope, input) =>
      record(scope, "demonstration", input),

    async listRecords(scope, input) {
      assertScopeShape(scope);
      if (
        input?.kind !== undefined &&
        !(LEARNING_RECORD_KINDS as readonly string[]).includes(input.kind)
      ) {
        throw new Error("LEARNING_KIND_INVALID");
      }
      return data.transaction(async (tx) => {
        await beginContext(tx, scope);
        await takeLocks(
          tx,
          baseLockKeys(scope).map((key) => ({ key, exclusive: false })),
        );
        const [membership] = await tx
          .select({
            status: enterpriseWorkspaceMemberships.status,
          })
          .from(enterpriseWorkspaceMemberships)
          .where(
            and(
              eq(enterpriseWorkspaceMemberships.tenantId, scope.tenantId),
              eq(enterpriseWorkspaceMemberships.workspaceId, scope.workspaceId),
              eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
            ),
          )
          .limit(1);
        if (
          membership?.status !== "active" ||
          !(await membershipActive(tx, scope))
        ) {
          return [];
        }
        const rows = await tx
          .select({
            id: enterpriseLearningRecords.id,
            kind: enterpriseLearningRecords.kind,
            title: enterpriseLearningRecords.title,
            containerId: enterpriseLearningRecords.containerId,
          })
          .from(enterpriseLearningRecords)
          .where(
            and(
              eq(enterpriseLearningRecords.tenantId, scope.tenantId),
              eq(enterpriseLearningRecords.workspaceId, scope.workspaceId),
              ...(input?.kind
                ? [eq(enterpriseLearningRecords.kind, input.kind)]
                : []),
            ),
          )
          .limit(200);
        return deepFreeze(
          rows.map((row) => ({
            recordId: row.id,
            kind: row.kind as LearningRecordKind,
            title: row.title,
            containerId: row.containerId,
          })),
        );
      });
    },
  };
}
