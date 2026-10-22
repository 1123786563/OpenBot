// server/src/enterprise/tenancy/quarantine-list.ts
// MT120（Issue #163）：无法归属外部状态的隔离清单与启用阻断。
//
// 票面语义：无法唯一归属的外部状态进入可运维查看的隔离清单，并在清单
// 非空时阻断多租户启用；处置（归属或销毁）后清单相应更新且处置留审计；
// 绝不为了清空清单而按猜测分配归属。
//
// 结构（持久隔离表 = 本票面；前置各门刻意不落第二份存储）：
//
//   1. 扫描源闭集（两源，全部复用已交付的确定性推导，零新可见性判断）：
//        root-record   rootBackfillReadiness（MT113）——根记录跨租户认领
//                      冲突的隔离重算（kind + recordId + reason）
//        external-file buildExternalFilesOwnershipMap（MT118）——对象存储
//                      归属映射的 openItems（recordId + reason）
//      每源条目 → 持久行 enterprise_quarantine_items（id 确定性 =
//      `<category>:<recordId>`，重扫幂等：首见记 discovered_at，再见只推
//      last_seen_at；status 不回退）。仍 open 但本轮未被任何源报告的条目
//      → status='cleared-upstream'（活推导不再报告 = 事实性移出，不是处置
//      ——处置审计只覆盖 assign/destroy 两种人工决定）。
//   2. 运维查看（AC1）：readQuarantineList——受信 PlatformScope（MT005）
//      且 tenantId = 锚点租户，经 RLS 租户臂读持久表；行含对象（category +
//      recordId）、原因（reason 闭集）、发现时间（discovered_at）与建议处置
//      （suggested_disposition，按 reason 的确定性建议——建议是数据不是
//      动作，永远不自动执行）。
//   3. 处置（AC3）：resolveQuarantineItem——锚点租户 tenant_admin 角色门
//      （非管理员响亮拒绝 QUARANTINE_ADMIN_REQUIRED）；disposition='assign'
//      必须携带显式 targetTenantId（结构上不可猜测——缺目标即拒绝，AC4 反向
//      面的构造半边）；先落 business 域审计事件（recordTenantAuditEvent，
//      决策是可审计事实；审计失败原样上抛绝不折叠成功），后翻 status。仅
//      open 条目可处置；他租户条目在 RLS 之外不可见（canonical 拒绝）。
//   4. 启用阻断（AC2）：evaluateMultitenancyQuarantineReadiness——扫描
//      （新鲜事实入表）后读 open 集，非空 ⇒ accepted=false 且逐条列出
//      （与 MT013/MT123 启动就绪同一纪律：结构化记录、缺口一次列全、
//      verdict 拒绝即非 0 退出；纯函数半边供单测）。
//   5. 不猜（AC4 反向测试的钉子）：扫描零业务写入（只写隔离表本身——
//      enterprise_resources/ownership 各表行数在扫描前后不变）；建议处置
//      永不执行；assign 无显式目标即拒绝。
//
// 通道纪律：扫描与建表写入走 setup/属主连接（工具语义，与 MT113/MT114
// 同款披露——受限角色对源遗留表无全量读授权）；运维查看与处置走受限
// data/operator 通道 + RLS。
//
// 边界（诚实披露）：
//   - blocked-by #162（MT119 外部线程、浏览器状态与向量命名空间迁移）
//     未交付：GitHub closed 是上游撞号关闭（8a6f5a0b6 与 MT119 无关），
//     本工作区无其迁移臂——线程/浏览器/向量三类别不在扫描源闭集中，
//     其隔离条目待该票交付后注册新源（源表是闭集可扩展，不虚构未交付
//     类别的扫描）。
//   - 处置是决策记录，不执行物理归属写入或字节销毁（那是各迁移臂的
//     交付，见票面 Scope boundary「不含具体迁移实现」）；处置后清单
//     更新 = 条目离开 open 集（enablement 解除）。

import { sql } from "drizzle-orm";
import { getLogger } from "../../../../shared/logger";
import type { Database } from "../../db/client";
import type { PlatformScope } from "../contracts";
import { recordTenantAuditEvent } from "./audit-domains";
import {
  assertDataDatabase,
  assertOperatorDatabase,
  type DataDatabase,
  type OperatorDatabase,
} from "./connections";
import { buildExternalFilesOwnershipMap } from "./external-files-migration";
import { rootBackfillReadiness } from "./root-backfill";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// 词汇与形状（闭集）
// ---------------------------------------------------------------------------

/** 扫描源类别闭集（每类别 = 一个已交付的确定性推导）。 */
export const QUARANTINE_CATEGORIES = ["root-record", "external-file"] as const;
export type QuarantineCategory = (typeof QUARANTINE_CATEGORIES)[number];

/** 隔离原因闭集（两源各自的 reason 词汇原样并入，来源可溯）。 */
export const QUARANTINE_REASONS = [
  // root-record（MT113）
  "claimed-by-another-tenant",
  // external-file（MT118）
  "owner-principal-missing",
  "ambiguous-membership",
  "parent-tenant-mismatch",
  "parent-association-missing",
  "digest-mismatch",
] as const;
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];

/** 处置闭集：归属（人工显式指定目标）或销毁。 */
export const QUARANTINE_DISPOSITIONS = ["assign", "destroy"] as const;
export type QuarantineDisposition = (typeof QUARANTINE_DISPOSITIONS)[number];

/** 条目生命周期闭集：open 阻断启用；assigned/destroyed 是人工处置；
 * cleared-upstream 是活推导不再报告（事实性移出，非处置）。 */
export const QUARANTINE_STATUSES = [
  "open",
  "assigned",
  "destroyed",
  "cleared-upstream",
] as const;
export type QuarantineStatus = (typeof QUARANTINE_STATUSES)[number];

/** 处置需要管理员角色的唯一哨兵（锚点租户内部状态，非跨租户存在性）。 */
export const QUARANTINE_ADMIN_REQUIRED = "QUARANTINE_ADMIN_REQUIRED";
/** assign 缺显式目标的唯一哨兵（结构上禁止猜测归属）。 */
export const QUARANTINE_ASSIGN_TARGET_REQUIRED =
  "QUARANTINE_ASSIGN_TARGET_REQUIRED";
/** 条目不可处置（不存在/非 open/他租户不可见）的唯一哨兵。 */
export const QUARANTINE_ITEM_NOT_OPEN = "QUARANTINE_ITEM_NOT_OPEN";

/**
 * 建议处置（确定性纯函数：建议是数据不是动作，永不自动执行）。
 * 归属冲突/主体缺失/关联缺失 → 需要人工归属（assign）；摘要不一致 →
 * 字节与权威行不符，建议销毁（destroy）。
 */
export function suggestedDispositionFor(
  reason: QuarantineReason,
): QuarantineDisposition {
  return reason === "digest-mismatch" ? "destroy" : "assign";
}

/** 隔离条目（运维查看面，AC1 的行形状）。 */
export interface QuarantineItem {
  readonly id: string;
  readonly category: QuarantineCategory;
  readonly recordId: string;
  readonly reason: QuarantineReason;
  readonly suggestedDisposition: QuarantineDisposition;
  readonly status: QuarantineStatus;
  readonly discoveredAt: string;
  readonly lastSeenAt: string;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
  readonly targetTenantId: string | null;
}

/** 一次扫描的报告（计数 + 建议处置抽样；幂等重扫第二轮零新行）。 */
export interface QuarantineScanReport {
  readonly anchorTenantId: string;
  readonly categories: readonly {
    readonly category: QuarantineCategory;
    readonly reported: number;
  }[];
  readonly upsertedNew: number;
  readonly clearedUpstream: number;
  readonly openItems: readonly QuarantineItem[];
}

export interface QuarantineReadinessRecord {
  readonly type: "multitenancy-quarantine-readiness";
  readonly mode: "on";
  readonly accepted: boolean;
  readonly timestamp: string;
  /** open 条目一次列全（与 MT013 启动就绪同纪律：不发现第一个就停）。 */
  readonly checks: {
    readonly openItems: readonly QuarantineItem[];
    readonly scannedAt: string;
  };
}

// ---------------------------------------------------------------------------
// 扫描与持久化（setup/属主连接；工具语义）
// ---------------------------------------------------------------------------

interface QuarantineRow {
  readonly id: string;
  readonly category: string;
  readonly record_id: string;
  readonly reason: string;
  readonly status: string;
  readonly discovered_at: Date;
  readonly last_seen_at: Date;
  readonly resolved_at: Date | null;
  readonly resolved_by: string | null;
  readonly target_tenant_id: string | null;
}

const toItem = (row: QuarantineRow): QuarantineItem => ({
  id: row.id,
  category: row.category as QuarantineCategory,
  recordId: row.record_id,
  reason: row.reason as QuarantineReason,
  suggestedDisposition: suggestedDispositionFor(row.reason as QuarantineReason),
  status: row.status as QuarantineStatus,
  discoveredAt: row.discovered_at.toISOString(),
  lastSeenAt: row.last_seen_at.toISOString(),
  resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
  resolvedBy: row.resolved_by,
  targetTenantId: row.target_tenant_id,
});

async function anchorTenantOf(database: Database): Promise<string> {
  const anchors = (await database.execute(
    sql`select tenant_id from enterprise_deployment_anchors`,
  )) as unknown as { tenant_id: string }[];
  if (anchors.length !== 1) {
    throw new Error(
      `QUARANTINE_SCAN_REFUSED: expected exactly one MT112 anchor row, found ${anchors.length}`,
    );
  }
  return anchors[0].tenant_id;
}

/**
 * 运行隔离扫描（AC1 的发现半边 + AC2 的数据源）：两源确定性推导 → 持久
 * 表幂等 upsert；不在任何源报告里的 open 条目记 cleared-upstream。
 * 零业务写入（只写隔离表自身）。
 */
export async function runQuarantineScan(
  database: Database,
  input: { readonly defaultWorkspaceId: string },
): Promise<QuarantineScanReport> {
  const anchorTenantId = await anchorTenantOf(database);

  // 源 1：根记录跨租户认领冲突（MT113 同一推导，dry-run 零写入）。
  const root = await rootBackfillReadiness(database, input.defaultWorkspaceId);
  // 源 2：对象存储归属映射未决项（MT118 映射臂，纯重算）。
  const files = await buildExternalFilesOwnershipMap(database, {
    defaultWorkspaceId: input.defaultWorkspaceId,
  });

  const reported = new Map<
    string,
    { category: QuarantineCategory; recordId: string; reason: QuarantineReason }
  >();
  for (const entry of root.quarantined) {
    reported.set(`root-record:${entry.recordId}`, {
      category: "root-record",
      recordId: entry.recordId,
      reason: entry.reason,
    });
  }
  for (const open of files.openItems) {
    reported.set(`external-file:${open.recordId}`, {
      category: "external-file",
      recordId: open.recordId,
      reason: open.reason,
    });
  }

  return database.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '30s'`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${anchorTenantId}, true)`,
    );

    let upsertedNew = 0;
    for (const [id, item] of reported) {
      const inserted = (await tx.execute(sql`
        insert into enterprise_quarantine_items
          (tenant_id, id, category, record_id, reason, suggested_disposition, status, last_seen_at)
        values (${anchorTenantId}, ${id}, ${item.category}, ${item.recordId},
                ${item.reason}, ${suggestedDispositionFor(item.reason)}, 'open', now())
        on conflict (tenant_id, id) do update
          set last_seen_at = now(),
              reason = excluded.reason,
              suggested_disposition = excluded.suggested_disposition
        returning (xmax = 0) as inserted_new
      `)) as unknown as { inserted_new: boolean }[];
      if (inserted[0]?.inserted_new) upsertedNew += 1;
    }

    // 本轮未被任何源报告的 open 条目：活推导不再报告 = 事实性移出。
    let clearedUpstream = 0;
    const staleIds = (await tx.execute(sql`
      select id from enterprise_quarantine_items
      where tenant_id = ${anchorTenantId} and status = 'open'
    `)) as unknown as { id: string }[];
    for (const row of staleIds) {
      if (reported.has(row.id)) continue;
      const cleared = (await tx.execute(sql`
        update enterprise_quarantine_items
        set status = 'cleared-upstream', resolved_at = now()
        where tenant_id = ${anchorTenantId} and id = ${row.id} and status = 'open'
        returning 1
      `)) as unknown as unknown[];
      clearedUpstream += cleared.length;
    }

    const openRows = (await tx.execute(sql`
      select id, category, record_id, reason, status, discovered_at, last_seen_at,
             resolved_at, resolved_by, target_tenant_id
      from enterprise_quarantine_items
      where tenant_id = ${anchorTenantId} and status = 'open'
      order by category, id
    `)) as unknown as QuarantineRow[];

    return {
      anchorTenantId,
      categories: [
        {
          category: "root-record" as const,
          reported: root.quarantined.length,
        },
        {
          category: "external-file" as const,
          reported: files.openItems.length,
        },
      ],
      upsertedNew,
      clearedUpstream,
      openItems: openRows.map(toItem),
    };
  });
}

// ---------------------------------------------------------------------------
// 运维查看与处置（受限通道 + RLS）
// ---------------------------------------------------------------------------

/**
 * AC1 查看半边：受信 scope + 锚点租户（调用方从 setup/属主连接读得的
 * anchor——受限通道上读锚点表需要先有租户上下文，鸡生蛋；anchor 作为
 * 显式输入是 fail-closed，不是隐式默认）。status 过滤可选。
 */
export async function readQuarantineList(
  data: DataDatabase,
  scope: PlatformScope,
  anchorTenantId: string,
  filter?: { readonly status?: QuarantineStatus },
): Promise<readonly QuarantineItem[]> {
  assertDataDatabase(data);
  assertTrustedScope(scope);
  if (
    typeof anchorTenantId !== "string" ||
    !anchorTenantId.trim() ||
    scope.tenantId !== anchorTenantId
  ) {
    throw new Error("QUARANTINE_SCOPE_MISMATCH");
  }
  return data.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
    );
    const rows = (await tx.execute(sql`
      select id, category, record_id, reason, status, discovered_at, last_seen_at,
             resolved_at, resolved_by, target_tenant_id
      from enterprise_quarantine_items
      where tenant_id = ${scope.tenantId}
        ${filter?.status ? sql`and status = ${filter.status}` : sql``}
      order by status, category, id
    `)) as unknown as QuarantineRow[];
    return rows.map(toItem);
  });
}

/** 锚点租户 tenant_admin 判定（处置门；查看不要求）。 */
async function requireAnchorAdmin(
  tx: Parameters<Parameters<OperatorDatabase["transaction"]>[0]>[0],
  scope: PlatformScope,
  anchor: string,
): Promise<void> {
  const rows = (await tx.execute(sql`
    select role from enterprise_memberships
    where tenant_id = ${anchor} and principal_id = ${scope.principalId}
    limit 1
  `)) as unknown as { role: string }[];
  if (rows[0]?.role !== "tenant_admin") {
    throw new Error(QUARANTINE_ADMIN_REQUIRED);
  }
}

export interface QuarantineResolutionInput {
  readonly itemId: string;
  readonly disposition: QuarantineDisposition;
  /** assign 必须显式给出目标租户（人工决定，不是推导）。 */
  readonly targetTenantId?: string;
}

/**
 * AC3 处置半边：tenant_admin 门 + assign 显式目标门 + 审计先行 + 状态
 * 翻转。审计失败原样上抛（决策是可审计事实，绝不折叠成功）；翻转失败
 * 同样上抛（审计已留痕，方向是过度记录而非漏记录）。
 */
export async function resolveQuarantineItem(
  operator: OperatorDatabase,
  scope: PlatformScope,
  anchorTenantId: string,
  input: QuarantineResolutionInput,
): Promise<{ readonly itemId: string; readonly status: QuarantineStatus }> {
  assertOperatorDatabase(operator);
  assertTrustedScope(scope);
  if (!QUARANTINE_DISPOSITIONS.includes(input?.disposition)) {
    throw new Error("QUARANTINE_DISPOSITION_INVALID");
  }
  if (input.disposition === "assign") {
    if (
      typeof input.targetTenantId !== "string" ||
      !input.targetTenantId.trim()
    ) {
      throw new Error(QUARANTINE_ASSIGN_TARGET_REQUIRED);
    }
  }
  if (
    typeof anchorTenantId !== "string" ||
    !anchorTenantId.trim() ||
    scope.tenantId !== anchorTenantId
  ) {
    throw new Error("QUARANTINE_SCOPE_MISMATCH");
  }
  const anchor = anchorTenantId;

  // 条目事实先读（open 与否 + 原因进审计正文）；他租户/不存在同形拒绝。
  const item = await operator.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
    );
    await requireAnchorAdmin(tx, scope, anchor);
    const rows = (await tx.execute(sql`
      select id, category, record_id, reason, status
      from enterprise_quarantine_items
      where tenant_id = ${scope.tenantId} and id = ${input.itemId}
      limit 1
    `)) as unknown as {
      id: string;
      category: string;
      record_id: string;
      reason: string;
      status: string;
    }[];
    return rows[0] ?? null;
  });
  if (item?.status !== "open") {
    throw new Error(QUARANTINE_ITEM_NOT_OPEN);
  }

  // 审计先行：处置是决策事实，先于状态翻转落 business 域审计。
  await recordTenantAuditEvent(operator, {
    tenantId: scope.tenantId,
    domain: "business",
    eventType: "quarantine.item.disposition",
    actorId: scope.actorId,
    targetId: item.id,
    payload: {
      category: item.category,
      recordId: item.record_id,
      reason: item.reason,
      disposition: input.disposition,
      targetTenantId:
        input.disposition === "assign" ? (input.targetTenantId ?? null) : null,
    },
  });

  const updated = await operator.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
    );
    const rows = (await tx.execute(sql`
      update enterprise_quarantine_items
      set status = ${input.disposition === "assign" ? "assigned" : "destroyed"},
          resolved_at = now(),
          resolved_by = ${scope.principalId},
          target_tenant_id = ${input.disposition === "assign" ? (input.targetTenantId ?? null) : null}
      where tenant_id = ${scope.tenantId} and id = ${input.itemId} and status = 'open'
      returning status
    `)) as unknown as { status: string }[];
    if (rows.length === 0) throw new Error(QUARANTINE_ITEM_NOT_OPEN);
    return rows[0].status as QuarantineStatus;
  });
  return { itemId: input.itemId, status: updated };
}

// ---------------------------------------------------------------------------
// 启用阻断（AC2：与启动就绪强制一致）
// ---------------------------------------------------------------------------

/**
 * AC2 纯函数半边：open 集非空 ⇒ accepted=false（逐条列出，不发现第一个
 * 就停）。记录形状与 MT013/MT123 的启动就绪记录同款（结构化、可审计）。
 */
export function evaluateQuarantineReadiness(
  openItems: readonly QuarantineItem[],
  scannedAt: string,
): QuarantineReadinessRecord {
  return {
    type: "multitenancy-quarantine-readiness",
    mode: "on",
    accepted: openItems.length === 0,
    timestamp: new Date().toISOString(),
    checks: {
      openItems: [...openItems],
      scannedAt,
    },
  };
}

/**
 * 编排半边：扫描（新鲜事实入表）→ 读 open 集 → 就绪记录。启动装配在
 * 多租户模式下消费本记录（applyQuarantineReadinessVerdict）。
 */
export async function evaluateMultitenancyQuarantineReadiness(
  database: Database,
  input: { readonly defaultWorkspaceId: string },
): Promise<QuarantineReadinessRecord> {
  const report = await runQuarantineScan(database, input);
  return evaluateQuarantineReadiness(
    report.openItems,
    new Date().toISOString(),
  );
}

/**
 * verdict：写启动日志（恰好一条结构化记录）并按结果退出——拒绝不是
 * 警告继续（MT013 applyStartupVerdict / MT123 applyStartupDefaultsVerdict
 * 同款）。log/exit 可注入供单测断言。
 */
export function applyQuarantineReadinessVerdict(
  record: QuarantineReadinessRecord,
  hooks: {
    log?: Pick<ReturnType<typeof getLogger>, "info">;
    exit?: (code: number) => void;
  } = {},
): void {
  const log = hooks.log ?? getLogger("server");
  log.info(
    record,
    record.accepted
      ? "quarantine readiness passed — the un-attributable external-state list is empty"
      : "quarantine readiness failed — refusing to enable multitenancy (open quarantine items in this record)",
  );
  if (!record.accepted) {
    if (hooks.exit) hooks.exit(1);
    else process.exit(1);
  }
}
