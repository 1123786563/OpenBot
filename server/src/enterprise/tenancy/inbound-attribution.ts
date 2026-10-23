// server/src/enterprise/tenancy/inbound-attribution.ts
// MT044（Issue #87）：入站邮件、GitHub 与 Webhook 的归属解析。
//
// 票面语义（brief + Issue #87 正文）：
//   AC1 入站事件按持久映射归属到公司与团队；载荷中伪造的公司/团队字段被忽略。
//   AC2 无法解析归属的事件进入隔离队列并可见于运维视图，不写入任何业务范围。
//   AC3 重复投递幂等处理，不产生重复任务或重复计费。
//   AC4 入站触发的执行遵守 MT042 的作用域重建规则。
//
// 结构（纯新增服务面；既有触发器管线只加可选 seam，缺省路径逐字不变）：
//
//   1. 持久映射（AC1 的实现面）：responsibility_triggers 的新列 (tenant_id,
//      workspace_id)（0170 迁移，expand-only）。归属解析 resolveTrigger 只读
//      该行 + 权威企业行——directory 通道（app.user_id 事务本地）解析
//      user→principal→membership→tenant，operator 通道（app.tenant_id）解析
//      workspace∈tenant；两侧都是受限角色 + 真实 RLS。投递载荷从不参与：
//      解析输入是触发器行，不是消息。两列全空 = 旧个人触发器（owner 用户
//      域，行为不变）；一空一有 = 映射残缺，隔离。
//   2. 隔离（AC2 的实现面）：quarantine 写 responsibility_inbound_quarantine
//      （0170 新表，平台侧——无归属的事件没有租户，租户范围策略管不了它）。
//      隔离边界 = 已认证投递：签名验证通过但归属解析失败的投递入隔离；匿名
//      探测维持 401/404 且不落记录（记录未验证字节是投毒面）。运维视图
//      listQuarantined/reviewQuarantined 只对 MT042 机器身份开放（§5.3 平台
//      任务机器读权限；业务读者结构性不可见）。幂等：(channel, trigger_id,
//      delivery_id) 唯一 + onConflictDoNothing——供应商重投同一事件不重复入队。
//   3. 企业入站摄取（AC1/AC3 的接线面）：ingestEnterprise 复用既有
//      store.ingestEvent（事件 + run + 队列一事务、(owner, source, external_id)
//      唯一去重——重复投递 duplicate:true、零新 run），但队列形态换成 MT042
//      扫描队列（kind='enterprise.job.due'，key='run:<runId>'，载荷只是路由
//      提示）；随后每个 run 经 MT041 pinJobOwnership 固定归属（kind='run'）。
//      执行不走 responsibility.run 个人队列——企业归属的 run 只经 MT042 重建。
//   4. MT042 挂接（AC4 的实现面）：createInboundTriggerScanExecute 是
//      createScanExecutor 的执行回调——扫描器从 work_items 元数据认领
//      （payload 结构性不可见）→ job_ownership 权威行重建事实 → 真实签发入口
//      （entrypoint="schedule"）→ MT041 租约 → MT005 gate 事务内执行本回调：
//      beginRun → runTurn → settleRun（与 responsibilities/engine.ts 同状态
//      矩阵；失败上抛由扫描器释放重试，attempt 上限收敛）。
//
// 事务纪律与 MT016/MT022/MT041/MT042 同款：read committed + lock/statement
// timeout → set_config('app.*', …, true) 事务本地 → 受限角色真实 RLS。
//
// 边界（诚实披露）：
//   - 本票不接生产装配（index.ts）：seam 由装配票接线（MT060 openmuse 先例）。
//     测试直接以真实路由 + 真实服务组装。
//   - ingest 与 pin 是两个事务（平台通道 vs operator 通道，无法同事务）：
//     ingest 成功而 pin 失败时，扫描项存在但重建拒绝（SCAN_RECORD_MISSING）
//     → 释放重试至 attempt 上限，last_error 可见于 work_items——不产生无归属
//     执行，只产生可见的未执行。
//   - 归属是创建时一次写入：create 写列，update 不改列（与 MT041 create-once
//     同纪律；改归属 = 新触发器）。

import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import type { Database } from "../../db/client";
import { responsibilityInboundQuarantine } from "../../db/schema/responsibilities";
import { fitPayload } from "../../responsibilities/triggers";
import type {
  ResponsibilityEventResult,
  ResponsibilityRunContext,
  ResponsibilityStore,
} from "../../responsibilities/types";
import type { ScanExecuteContext } from "../runs/scan-executor";
import {
  assertTrustedMachineIdentity,
  SCAN_WORK_KIND,
} from "../runs/scan-executor";
import {
  assertDirectoryDatabase,
  assertOperatorDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
} from "./connections";
import type { JobConfigBasisInput, JobOwnershipService } from "./job-ownership";

// ---------------------------------------------------------------------------
// 类型与拒绝哨兵码
// ---------------------------------------------------------------------------

/** 解析出的企业归属：公司 + 团队 + 发起主体（主体由 owner 用户在该公司派生）。 */
export interface InboundTriggerAttribution {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
}

/**
 * 归属解析结局。`personal` 是两列全空的旧触发器（行为不变）；`unresolvable`
 * 进隔离——绝不落到默认范围（AC2），code 是确定性哨兵码，不回显输入值。
 */
export type InboundTriggerResolution =
  | { readonly kind: "personal" }
  | {
      readonly kind: "enterprise";
      readonly attribution: InboundTriggerAttribution;
    }
  | { readonly kind: "unresolvable"; readonly code: InboundQuarantineReason };

export type InboundQuarantineReason =
  | typeof INBOUND_MAPPING_INCOMPLETE
  | typeof INBOUND_MAPPING_MISSING
  | typeof INBOUND_TENANT_UNRESOLVED
  | typeof INBOUND_WORKSPACE_UNRESOLVED
  | typeof INBOUND_PRINCIPAL_UNRESOLVED;

/** 映射列一空一有（残缺写入）。 */
export const INBOUND_MAPPING_INCOMPLETE = "INBOUND_MAPPING_INCOMPLETE";
/** 通道解析不到任何触发器行（如邮件地址不再路由）。 */
export const INBOUND_MAPPING_MISSING = "INBOUND_MAPPING_MISSING";
/** 公司不存在或已停用。 */
export const INBOUND_TENANT_UNRESOLVED = "INBOUND_TENANT_UNRESOLVED";
/** 团队不存在或不属于该公司。 */
export const INBOUND_WORKSPACE_UNRESOLVED = "INBOUND_WORKSPACE_UNRESOLVED";
/** owner 在该公司无活跃主体或成员资格。 */
export const INBOUND_PRINCIPAL_UNRESOLVED = "INBOUND_PRINCIPAL_UNRESOLVED";

/** 隔离写入请求：channel 是触发器 kind（或 'email' 的未路由地址面）。 */
export interface InboundQuarantineInput {
  readonly channel: string;
  /** 解析不到触发器行时为 undefined（落库为 ''）。 */
  readonly triggerId?: string;
  readonly deliveryId: string;
  readonly eventType: string;
  readonly reason: InboundQuarantineReason;
  readonly payload: Record<string, unknown>;
}

export interface QuarantinedDeliveryView {
  readonly id: string;
  readonly channel: string;
  readonly triggerId: string;
  readonly deliveryId: string;
  readonly eventType: string;
  readonly reason: string;
  readonly payload: Record<string, unknown>;
  readonly receivedAt: Date;
  readonly reviewedAt: Date | null;
  readonly reviewNote: string | null;
}

/** 隔离队列的运维视图面：只有平台机器身份可读（业务读者结构性不可见）。 */
export interface InboundQuarantineOps {
  listQuarantined(
    machine: Parameters<typeof assertTrustedMachineIdentity>[0],
    options?: { limit?: number; includeReviewed?: boolean },
  ): Promise<readonly QuarantinedDeliveryView[]>;
  reviewQuarantined(
    machine: Parameters<typeof assertTrustedMachineIdentity>[0],
    input: { id: string; note?: string },
  ): Promise<boolean>;
}

const READ_TX_SETUP = sql`set transaction isolation level read committed`;
const TIMEOUTS = [
  sql`set local lock_timeout = '2s'`,
  sql`set local statement_timeout = '5s'`,
] as const;

/** execute() 结果归一：bun-sql 返回数组、node postgres 返回 {rows}。 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  const rows = (
    Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] })?.rows ?? [])
  ) as Record<string, unknown>[];
  return rows;
}

const ID_MAX = 200;

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > ID_MAX) {
    throw new Error(
      `INBOUND_ATTRIBUTION_INVALID: ${field} must be a non-empty string of at most ${ID_MAX} characters`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// 归属解析 + 隔离队列服务
// ---------------------------------------------------------------------------

export function createInboundAttributionService(deps: {
  /** 平台连接（隔离表所在域；无 RLS，运维面走机器身份门）。 */
  readonly platform: Database;
  /** directory 受限通道：user→principal→membership→tenant 事实（app.user_id 臂）。 */
  readonly directory: DirectoryDatabase;
  /** operator 受限通道：workspace∈tenant 事实（app.tenant_id 臂）。 */
  readonly operator: OperatorDatabase;
}): InboundQuarantineOps & {
  resolveTrigger(trigger: {
    readonly ownerUserId: string;
    readonly tenantId: string | null;
    readonly workspaceId: string | null;
  }): Promise<InboundTriggerResolution>;
  quarantine(input: InboundQuarantineInput): Promise<{
    status: "quarantined" | "duplicate";
    id: string;
  }>;
} {
  if (!deps || typeof deps !== "object") {
    throw new TypeError("INBOUND_ATTRIBUTION_DEPENDENCIES_REQUIRED");
  }
  assertDirectoryDatabase(deps.directory);
  assertOperatorDatabase(deps.operator);
  const { platform, directory, operator } = deps;

  return {
    /**
     * AC1 的实现面：归属只来自持久映射列 + 权威企业行。载荷（无论是事件
     * 体还是队列消息）从不进入本函数的输入。
     */
    async resolveTrigger(trigger) {
      const ownerUserId = requireId(trigger.ownerUserId, "ownerUserId");
      const tenantId = trigger.tenantId;
      const workspaceId = trigger.workspaceId;
      if (tenantId === null && workspaceId === null)
        return { kind: "personal" };
      if (tenantId === null || workspaceId === null)
        return { kind: "unresolvable", code: INBOUND_MAPPING_INCOMPLETE };
      const tenant = requireId(tenantId, "tenantId");
      const workspace = requireId(workspaceId, "workspaceId");

      // Identity facts on the directory channel: the owner's live principal,
      // their membership in THIS tenant, and the tenant's own liveness. All
      // three under real RLS with a transaction-local app.user_id.
      const identity:
        | { code: InboundQuarantineReason }
        | { principalId: string } = await directory.transaction(
        async (
          tx,
        ): Promise<
          { code: InboundQuarantineReason } | { principalId: string }
        > => {
          await tx.execute(READ_TX_SETUP);
          for (const timeout of TIMEOUTS) await tx.execute(timeout);
          await tx.execute(
            sql`select set_config('app.user_id', ${ownerUserId}, true)`,
          );
          const principals = rowsOf(
            await tx.execute(sql`
            select p.id, p.status
            from enterprise_principals p
            where p.user_id = ${ownerUserId}
            limit 1
          `),
          );
          if (principals.length === 0)
            return { code: INBOUND_PRINCIPAL_UNRESOLVED };
          const principalId = String(principals[0].id);
          if (String(principals[0].status) !== "active")
            return { code: INBOUND_PRINCIPAL_UNRESOLVED };
          const memberships = rowsOf(
            await tx.execute(sql`
            select m.status
            from enterprise_memberships m
            where m.tenant_id = ${tenant} and m.principal_id = ${principalId}
            limit 1
          `),
          );
          if (
            memberships.length === 0 ||
            String(memberships[0].status) !== "active"
          )
            return { code: INBOUND_PRINCIPAL_UNRESOLVED };
          const tenants = rowsOf(
            await tx.execute(sql`
            select t.status
            from enterprise_tenants t
            where t.id = ${tenant}
            limit 1
          `),
          );
          if (tenants.length === 0 || String(tenants[0].status) !== "active")
            return { code: INBOUND_TENANT_UNRESOLVED };
          return { principalId };
        },
      );
      if ("code" in identity)
        return { kind: "unresolvable", code: identity.code };

      // Workspace fact on the operator channel: the team must exist and
      // belong to this company (composite PK), under real RLS.
      const workspaceLive = await operator.transaction(async (tx) => {
        await tx.execute(READ_TX_SETUP);
        for (const timeout of TIMEOUTS) await tx.execute(timeout);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenant}, true)`,
        );
        const rows = rowsOf(
          await tx.execute(sql`
            select 1
            from enterprise_workspaces w
            where w.tenant_id = ${tenant} and w.id = ${workspace}
            limit 1
          `),
        );
        return rows.length === 1;
      });
      if (!workspaceLive)
        return { kind: "unresolvable", code: INBOUND_WORKSPACE_UNRESOLVED };

      return {
        kind: "enterprise",
        attribution: {
          tenantId: tenant,
          workspaceId: workspace,
          principalId: identity.principalId,
        },
      };
    },

    /** AC2 的写入面：幂等（重投同一事件不重复入队），载荷经 fitPayload 限幅。 */
    async quarantine(input) {
      const channel = requireId(input.channel, "channel");
      const deliveryId = requireId(input.deliveryId, "deliveryId");
      const reason = requireId(input.reason, "reason");
      const id = randomUUID();
      const inserted = await platform
        .insert(responsibilityInboundQuarantine)
        .values({
          id,
          channel,
          triggerId: input.triggerId ?? "",
          deliveryId,
          eventType: input.eventType.slice(0, 128),
          reason,
          payload: fitPayload(input.payload ?? {}),
        })
        .onConflictDoNothing({
          target: [
            responsibilityInboundQuarantine.channel,
            responsibilityInboundQuarantine.triggerId,
            responsibilityInboundQuarantine.deliveryId,
          ],
        })
        .returning({ id: responsibilityInboundQuarantine.id });
      if (inserted.length > 0)
        return { status: "quarantined", id: inserted[0].id };
      const [existing] = await platform
        .select({ id: responsibilityInboundQuarantine.id })
        .from(responsibilityInboundQuarantine)
        .where(
          and(
            eq(responsibilityInboundQuarantine.channel, channel),
            eq(
              responsibilityInboundQuarantine.triggerId,
              input.triggerId ?? "",
            ),
            eq(responsibilityInboundQuarantine.deliveryId, deliveryId),
          ),
        );
      if (!existing)
        throw new Error("Quarantined delivery could not be loaded.");
      return { status: "duplicate", id: existing.id };
    },

    /** 运维视图：待审优先、新到先出；只有平台机器身份可读。 */
    async listQuarantined(machine, options) {
      assertTrustedMachineIdentity(machine);
      const limit = options?.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new Error("INBOUND_QUARANTINE_LIMIT_INVALID");
      const rows = await platform
        .select()
        .from(responsibilityInboundQuarantine)
        .where(
          options?.includeReviewed
            ? undefined
            : isNull(responsibilityInboundQuarantine.reviewedAt),
        )
        .orderBy(
          desc(responsibilityInboundQuarantine.receivedAt),
          desc(responsibilityInboundQuarantine.id),
        )
        .limit(limit);
      return rows.map((row) => ({
        id: row.id,
        channel: row.channel,
        triggerId: row.triggerId,
        deliveryId: row.deliveryId,
        eventType: row.eventType,
        reason: row.reason,
        payload: row.payload,
        receivedAt: row.receivedAt,
        reviewedAt: row.reviewedAt,
        reviewNote: row.reviewNote,
      }));
    },

    /** 运维处置：标记已审（不影响任何业务范围；幂等——再次处置返回 false）。 */
    async reviewQuarantined(machine, input) {
      assertTrustedMachineIdentity(machine);
      const id = requireId(input.id, "id");
      const [row] = await platform
        .update(responsibilityInboundQuarantine)
        .set({
          reviewedAt: sql`now()`,
          ...(input.note === undefined
            ? {}
            : { reviewNote: input.note.slice(0, 2000) }),
        })
        .where(
          and(
            eq(responsibilityInboundQuarantine.id, id),
            isNull(responsibilityInboundQuarantine.reviewedAt),
          ),
        )
        .returning({ id: responsibilityInboundQuarantine.id });
      return Boolean(row);
    },
  };
}

// ---------------------------------------------------------------------------
// 企业入站摄取：事件 + run + MT042 扫描队列 + MT041 归属 pin
// ---------------------------------------------------------------------------

/** MT042 扫描队列里入站 run 的键形：`run:<runId>`（载荷只是路由提示）。 */
export function inboundScanRunKey(runId: string): string {
  return `run:${runId}`;
}

export interface InboundEnterpriseIngestInput {
  readonly ownerUserId: string;
  readonly responsibilityId: string;
  readonly triggerId: string;
  readonly source: string;
  readonly attribution: InboundTriggerAttribution;
  /** The authenticated delivery, exactly as the ingress route received it. */
  readonly delivery: {
    readonly deliveryId: string;
    readonly type: string;
    readonly payload: Record<string, unknown>;
  };
}

/**
 * 企业归属投递的唯一摄取入口：复用既有 store.ingestEvent 的事务与去重
 * （AC3——事件身份 (owner, source, externalId) 的构造与个人路径逐字一致），
 * 队列换成 MT042 扫描形态；每个新 run 经 MT041 pin 固定归属（重复投递不
 * 产生新 run，也不重复 pin）。
 */
export function createInboundEnterpriseIngest(deps: {
  readonly store: Pick<ResponsibilityStore, "ingestEvent">;
  readonly jobs: JobOwnershipService;
  /** 创建时配置依据（两级 revision + 文档）；由装配以 MT014 真实服务解析。 */
  readonly basisOf: (input: {
    readonly triggerId: string;
    readonly attribution: InboundTriggerAttribution;
  }) => JobConfigBasisInput;
}): (
  input: InboundEnterpriseIngestInput,
) => Promise<ResponsibilityEventResult> {
  const { store, jobs, basisOf } = deps;
  return async (input) => {
    const result = await store.ingestEvent(
      {
        ownerUserId: input.ownerUserId,
        responsibilityId: input.responsibilityId,
        triggerId: input.triggerId,
        source: input.source,
        externalId: `${input.triggerId}:${input.delivery.deliveryId}`.slice(
          0,
          256,
        ),
        type: input.delivery.type.slice(0, 128) || "received",
        payload: fitPayload(input.delivery.payload),
      },
      {
        // AC4: enterprise-attributed runs are queued ONLY through the MT042
        // scan shape — never the personal responsibility.run queue.
        queueItem: (runId) => ({
          kind: SCAN_WORK_KIND,
          key: inboundScanRunKey(runId),
        }),
      },
    );
    if (!result.duplicate) {
      const basis = basisOf({
        triggerId: input.triggerId,
        attribution: input.attribution,
      });
      for (const runId of result.runIds) {
        await jobs.pinJobOwnership({
          kind: "run",
          objectId: runId,
          scope: {
            tenantId: input.attribution.tenantId,
            workspaceId: input.attribution.workspaceId,
          },
          principalId: input.attribution.principalId,
          basis,
        });
      }
    }
    return result;
  };
}

// ---------------------------------------------------------------------------
// MT042 执行回调：扫描器重建作用域后，在 MT005 gate 事务内跑完 run
// ---------------------------------------------------------------------------

/** 与 responsibilities/engine.ts 的 RunResponsibilityTurn 同形。 */
export type InboundTriggerRunTurn = (
  input: ResponsibilityRunContext & { signal: AbortSignal },
) => Promise<{ replyText: string }>;

/**
 * AC4 的执行面：MT042 scan executor 的 execute 回调。回调收到的 scope 是从
 * job_ownership 权威行重建、经真实签发入口签发的受信 Scope——本回调从不自
 * 己构造 Scope，也不读队列消息里的任何归属字段。
 */
export function createInboundTriggerScanExecute(deps: {
  readonly store: Pick<ResponsibilityStore, "beginRun" | "settleRun">;
  readonly runTurn: InboundTriggerRunTurn;
}): (context: ScanExecuteContext) => Promise<void> {
  const { store, runTurn } = deps;
  return async (context) => {
    if (context.item.jobKind !== "run")
      throw new Error("INBOUND_SCAN_KIND_IGNORED");
    const runId = context.item.objectId;
    const begun = await store.beginRun(runId, {
      recovered: context.item.attempts > 1,
    });
    if (!begun) return; // beginRun already marked it skipped — nothing to settle.
    // The scan executor holds the MT041 job lease for this run; the abort
    // signal exists for turn shape parity and is never aborted here.
    const controller = new AbortController();
    try {
      const result = await runTurn({ ...begun, signal: controller.signal });
      await store.settleRun(runId, {
        status: "succeeded",
        replyText: result.replyText,
      });
    } catch (error) {
      // Same state matrix as responsibilities/engine.ts: a suspension parks the
      // run as waiting, anything else fails it. Both are settled outcomes, so
      // the scan item finishes — only infra failures (thrown before settling)
      // are released for retry by the executor.
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof HeadlessToolSuspension) {
        await store.settleRun(runId, {
          status: "waiting",
          waiting: error.waiting,
          error: message,
        });
        return;
      }
      await store.settleRun(runId, { status: "failed", error: message });
    }
  };
}
