// server/src/enterprise/tenancy/child-backfill-batch2.ts
// MT115（Issue #158）：主库子记录回填第二批——记忆与 OpenMuse 任务。
//
// 票面语义：剩余主库业务对象的子记录按同一复合关联规则回填，沿用第一批
// （MT114）的进度记录与幂等机制，不重复实现回填框架。
//
// 类别判定（第二批只回填「有已交付归属面 + 有真实遗留数据」的类别，
// MT114 同款纪律；其余域的诚实边界见文件尾）：
//   personal-memory  personal_memories（遗留 owner_user_id 行形状）→
//                    enterprise_personal_memories（MT039 交付面）。父 =
//                    属主主体恰一条 workspace 成员资格的三元组；记忆内容
//                    与来源原样承接（source_id → source_kind='document' +
//                    source_ref；无来源 → 'manual'）；memory_key 用确定性
//                    'legacy:' || 旧行 id（检索键是调用侧事实，不猜语义）。
//   openmuse-task    openmuse_tasks（遗留 owner_user_id + bot_id）→
//                    openmuse_task_scopes（MT060 交付面，attribution=
//                    'backfill'）。回填语义与 MT060 注册迁移的
//                    legacy_task_backfill 语句逐行同构（principal 恰有唯一
//                    一条 workspace membership 才落行；零条或多条 = 受控
//                    隔离清单）；本工具补上进度记录、锚点守卫与 mismatch
//                    报告半边。
//
// 复合关联（AC1）：子行 tenant 必须等于父（属主主体唯一 workspace 成员
// 资格）的 tenant——不一致（成员资格在他租户）被检测报告零写入；无法唯一
// 归属（零条/多条成员资格、属主主体未落地）进隔离清单，绝不猜测。
// 可中断续跑（AC2）：逐 kind 按 id 有序分块；每块的数据写入与进度行（游标
// + 计数）同一事务提交；幂等写入（ON CONFLICT DO NOTHING）保证重放/续跑
// 零重复——机制与进度表（enterprise_backfill_batches，MT114 注册）完全
// 复用，本文件只新增类别，不改第一批交付物。
// 约束与校验双重（AC3）：约束半边 = 既有复合外键（enterprise_personal_
// memories / openmuse_task_scopes 的 (tenant, workspace) 与 (tenant,
// principal) FK、task 全局主键）；校验半边 = 写前属主一致性判定。
// 计数报告（AC4）：childBackfillBatch2ProgressReport 读持久进度表；
// mainBackfillCompletion 汇总第一批 + 第二批全部类别，标记主库回填
// 完成状态（供 MT117 一致性校验消费）。
//
// 通道纪律：写入走 setup/属主连接（迁移语义——受限角色对 principals 无
// INSERT 授权，RLS 的故意设计）；验证读走受限角色（测试侧）。
//
// 边界（诚实披露，票面七域中不回填的五个及其原因）：
//   - Craft turn/消息/快照与 Workshop 会话/执行/产物/沙箱实例：前置
//     #96（MT053）/#100（MT057）未交付——本工作区无已交付归属面可回填
//     （sandbox_instances.tenant_id 列是 MT057 的预留面，本批不预支）；
//     craft_sessions 根面已由第一批 conversation 类别覆盖。
//   - 任务（run/trigger 半边）：code_runs / craft_scheduled_tasks /
//     proactive_settings 无已交付回填路径——MT045 交付契约明言归属列
//     「create-once，永不迁移」；MT041 的 basis 快照纪律无法对历史对象
//     事后伪造。OpenMuse 任务经 MT060 交付面回填（本批唯一任务类别）。
//   - 账务：历史余额迁移 = #117（MT074）幽灵交付（mt20 轮裁决 A 披露）；
//     公司 Customer 映射已由 MT112 锚点幂等落行；billing 三表纯新增无
//     遗留源。
//   - 策略：enterprise 治理策略纯新增（多租户模式无旧默认回退）；
//     gateway_model_preferences 按「per-user，never per-tenant」交付
//     设计运行，无归属回填语义。
//   - 遥测：usage_outbox 的 owner/workspace 归属是写入时事实，null 是
//     命名缺席「never a guess」——回填即猜测，不做（MT109 交付纪律）。

import { sql } from "drizzle-orm";
import type { Database } from "../../db/client";

/** 第二批批次 id（进度表与第一批共用，批次各用各的 id）。 */
export const CHILD_BACKFILL_BATCH2_ID = "child-main-batch2";

/** 第二批子记录类别（闭集）。 */
export const CHILD_BACKFILL_BATCH2_KINDS = [
  "personal-memory",
  "openmuse-task",
] as const;
export type ChildBackfillBatch2Kind =
  (typeof CHILD_BACKFILL_BATCH2_KINDS)[number];

export type ChildBackfillBatch2Mode = "dry-run" | "apply";

/** mismatch/隔离原因闭集（与第一批共用前两个词汇）。 */
export const CHILD_BACKFILL_BATCH2_REASONS = [
  "owner-principal-missing",
  "parent-tenant-mismatch",
  "ambiguous-membership",
  "claimed-by-another-tenant",
] as const;
export type ChildBackfillBatch2Reason =
  (typeof CHILD_BACKFILL_BATCH2_REASONS)[number];

export interface ChildBackfillBatch2Input {
  readonly mode: ChildBackfillBatch2Mode;
  /** 默认团队 workspace id（MT112/MT113 同一锚点产物）。 */
  readonly defaultWorkspaceId: string;
  /** 分块大小（进度落盘节奏）；默认 200。 */
  readonly chunkSize?: number;
  /** 处理 N 块后主动停（模拟中断：进度已提交、phase='running'）；0=不停。 */
  readonly stopAfterChunks?: number;
}

export interface ChildBackfillBatch2KindReport {
  readonly kind: ChildBackfillBatch2Kind;
  readonly phase: "running" | "completed";
  readonly lastCursor: string | null;
  readonly scanned: number;
  readonly applied: number;
  readonly skippedExisting: number;
  readonly mismatchReported: number;
  readonly quarantined: number;
  readonly writtenRows: number;
  readonly resumes: number;
  readonly mismatches: readonly {
    readonly recordId: string;
    readonly reason: ChildBackfillBatch2Reason;
  }[];
}

export interface ChildBackfillBatch2Report {
  readonly mode: ChildBackfillBatch2Mode;
  readonly anchorTenantId: string;
  readonly kinds: readonly ChildBackfillBatch2KindReport[];
}

/** 拒绝哨兵：锚点缺失/默认团队不属于锚点。 */
export const CHILD_BACKFILL_BATCH2_REFUSED = "CHILD_BACKFILL_BATCH2_REFUSED";

class ChildBackfillBatch2Refusal extends Error {
  constructor(reason: string) {
    super(`${CHILD_BACKFILL_BATCH2_REFUSED}: ${reason}`);
  }
}

/**
 * 每类的源行查询（id 有序；属主主体与唯一 workspace 成员资格事实全部由
 * SQL 推导，与 MT060 注册语句同构——count=1 才可归属，零条/多条都是
 * 无法唯一归属的事实状态）。
 */
const BATCH2_SOURCES: Record<
  ChildBackfillBatch2Kind,
  () => ReturnType<typeof sql>
> = {
  "personal-memory": () => sql`
    select pm.id,
      pm.owner_user_id,
      pm.content,
      pm.source_id,
      (select p.id from enterprise_principals p where p.user_id = pm.owner_user_id) as owner_principal,
      (select count(*)::int from enterprise_workspace_memberships wm
        where wm.principal_id = (select p.id from enterprise_principals p where p.user_id = pm.owner_user_id)) as membership_count,
      (select wm.tenant_id from enterprise_workspace_memberships wm
        where wm.principal_id = (select p.id from enterprise_principals p where p.user_id = pm.owner_user_id) limit 1) as only_tenant,
      (select wm.workspace_id from enterprise_workspace_memberships wm
        where wm.principal_id = (select p.id from enterprise_principals p where p.user_id = pm.owner_user_id) limit 1) as only_workspace
    from personal_memories pm order by pm.id`,
  "openmuse-task": () => sql`
    select t.id,
      t.owner_user_id,
      t.bot_id,
      (select p.id from enterprise_principals p where p.user_id = t.owner_user_id) as owner_principal,
      (select count(*)::int from enterprise_workspace_memberships wm
        where wm.principal_id = (select p.id from enterprise_principals p where p.user_id = t.owner_user_id)) as membership_count,
      (select wm.tenant_id from enterprise_workspace_memberships wm
        where wm.principal_id = (select p.id from enterprise_principals p where p.user_id = t.owner_user_id) limit 1) as only_tenant,
      (select wm.workspace_id from enterprise_workspace_memberships wm
        where wm.principal_id = (select p.id from enterprise_principals p where p.user_id = t.owner_user_id) limit 1) as only_workspace,
      (select s.tenant_id from openmuse_task_scopes s where s.task_id = t.id) as existing_scope_tenant
    from openmuse_tasks t order by t.id`,
};

interface Batch2SourceRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly content?: string | null;
  readonly source_id?: string | null;
  readonly bot_id?: string | null;
  readonly owner_principal: string | null;
  readonly membership_count: number;
  readonly only_tenant: string | null;
  readonly only_workspace: string | null;
  readonly existing_scope_tenant?: string | null;
}

/** 单类子记录的写入（只写全新行；返回本行实际写入数）。 */
async function writeBatch2ChildRow(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  kind: ChildBackfillBatch2Kind,
  row: Batch2SourceRow,
  tenant: string,
): Promise<number> {
  const inserted = (rows: unknown) => (Array.isArray(rows) ? rows.length : 0);
  if (kind === "personal-memory") {
    return inserted(
      await tx.execute(sql`
        insert into enterprise_personal_memories
          (tenant_id, id, workspace_id, principal_id, memory_key, content, source_kind, source_ref)
        select ${tenant}, ${row.id}, ${row.only_workspace}, ${row.owner_principal},
          ${`legacy:${row.id}`}, ${row.content ?? ""},
          ${row.source_id ? "document" : "manual"}, ${row.source_id ?? null}
        on conflict (tenant_id, id) do nothing
        returning 1
      `),
    );
  }
  return inserted(
    await tx.execute(sql`
      insert into openmuse_task_scopes
        (task_id, tenant_id, workspace_id, principal_id, user_id, bot_id, attribution)
      select ${row.id}, ${tenant}, ${row.only_workspace}, ${row.owner_principal},
        ${row.owner_user_id}, ${row.bot_id ?? ""}, 'backfill'
      on conflict (task_id) do nothing
      returning 1
    `),
  );
}

/** 子记录已存在（同租户）判定（两表主键列名不同：记忆 id / 任务 task_id）。 */
async function batch2ChildExists(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  kind: ChildBackfillBatch2Kind,
  row: Batch2SourceRow,
  tenant: string,
): Promise<boolean> {
  const idColumn = kind === "personal-memory" ? sql`id` : sql`task_id`;
  const target =
    kind === "personal-memory"
      ? sql`enterprise_personal_memories`
      : sql`openmuse_task_scopes`;
  const found = await tx.execute(sql`
    select 1 from ${target}
    where tenant_id = ${tenant} and ${idColumn} = ${row.id} limit 1
  `);
  return Array.isArray(found) && found.length > 0;
}

/**
 * 运行第二批回填。逐 kind 分块；每块一个事务：源行处理（校验→写入→计数）
 * 与进度行推进同事务提交。dry-run 只推导不写业务行（进度也不推进）。
 * 机制与第一批逐字同形（全量重分类 + 幂等写入：uuid 乱序的新源行落在旧
 * 游标之前也接得住），此处不另立第二套语义。
 */
export async function runChildBackfillBatch2(
  database: Database,
  input: ChildBackfillBatch2Input,
): Promise<ChildBackfillBatch2Report> {
  if (input.mode !== "dry-run" && input.mode !== "apply") {
    throw new ChildBackfillBatch2Refusal("mode must be dry-run|apply");
  }
  const chunkSize = Math.min(Math.max(input.chunkSize ?? 200, 1), 1000);
  const stopAfterChunks = Math.max(input.stopAfterChunks ?? 0, 0);

  // 锚点与默认团队（MT114 同款守卫，读自库事实）。
  const anchors = (await database.execute(
    sql`select tenant_id from enterprise_deployment_anchors`,
  )) as unknown as { tenant_id: string }[];
  if (anchors.length !== 1) {
    throw new ChildBackfillBatch2Refusal(
      `expected exactly one MT112 anchor row, found ${anchors.length}`,
    );
  }
  const tenant = anchors[0].tenant_id;
  const workspace = (await database.execute(
    sql`select id from enterprise_workspaces where tenant_id = ${tenant} and id = ${input.defaultWorkspaceId}`,
  )) as unknown as { id: string }[];
  if (workspace.length !== 1) {
    throw new ChildBackfillBatch2Refusal(
      `default workspace ${input.defaultWorkspaceId} not in anchor tenant`,
    );
  }

  const reports: ChildBackfillBatch2KindReport[] = [];

  for (const kind of CHILD_BACKFILL_BATCH2_KINDS) {
    const existing = (await database.execute(sql`
      select * from enterprise_backfill_batches
      where batch_id = ${CHILD_BACKFILL_BATCH2_ID} and kind = ${kind}
    `)) as unknown as Record<string, unknown>[];
    const prior = existing[0] ?? {};
    // 计数是本轮判定结果；written_rows 与 resumes 是累计事实（MT114 注释
    // 同款：每轮全量分类，幂等写入使重分类零重复）。
    let scanned = 0;
    let applied = 0;
    let skippedExisting = 0;
    let mismatchReported = 0;
    let quarantined = 0;
    let writtenRows = Number(prior.written_rows ?? 0);
    const resumes =
      Number(prior.resumes ?? 0) + (input.mode === "apply" ? 1 : 0);
    const mismatches: {
      recordId: string;
      reason: ChildBackfillBatch2Reason;
    }[] = [];
    let cursor: string | null = (prior.last_cursor ?? null) as string | null;
    let phase: "running" | "completed" =
      (prior.phase as "running" | "completed" | undefined) ?? "running";

    const sources = (await database.execute(
      BATCH2_SOURCES[kind](),
    )) as unknown as Batch2SourceRow[];
    scanned = sources.length;

    let chunkIndex = 0;
    for (
      let offset = 0;
      offset < sources.length;
      offset += chunkSize, chunkIndex += 1
    ) {
      if (input.mode === "apply") {
        if (stopAfterChunks > 0 && chunkIndex >= stopAfterChunks) {
          phase = "running";
          break;
        }
        await database.transaction(async (tx) => {
          for (
            let i = offset;
            i < Math.min(offset + chunkSize, sources.length);
            i += 1
          ) {
            const row = sources[i];
            cursor = row.id;
            const verdict = classifyBatch2Row(kind, row, tenant);
            if (verdict === "ok") {
              if (await batch2ChildExists(tx, kind, row, tenant)) {
                skippedExisting += 1;
              } else {
                const wrote = await writeBatch2ChildRow(tx, kind, row, tenant);
                writtenRows += wrote;
                applied += wrote > 0 ? 1 : 0;
                if (wrote === 0) skippedExisting += 1;
              }
            } else {
              mismatchReported += 1;
              if (
                verdict === "ambiguous-membership" ||
                verdict === "claimed-by-another-tenant"
              ) {
                quarantined += 1;
              }
              mismatches.push({ recordId: row.id, reason: verdict });
            }
          }
          await tx.execute(sql`
            insert into enterprise_backfill_batches
              (batch_id, kind, phase, last_cursor, scanned, applied, skipped_existing,
               mismatch_reported, quarantined, written_rows, resumes, updated_at)
            values (${CHILD_BACKFILL_BATCH2_ID}, ${kind}, 'running', ${cursor},
                    ${scanned}, ${applied}, ${skippedExisting}, ${mismatchReported},
                    ${quarantined}, ${writtenRows}, ${resumes}, now())
            on conflict (batch_id, kind) do update set
              phase = 'running', last_cursor = excluded.last_cursor,
              scanned = excluded.scanned, applied = excluded.applied,
              skipped_existing = excluded.skipped_existing,
              mismatch_reported = excluded.mismatch_reported,
              quarantined = excluded.quarantined,
              written_rows = excluded.written_rows,
              resumes = excluded.resumes, updated_at = now()
          `);
        });
      } else {
        for (
          let i = offset;
          i < Math.min(offset + chunkSize, sources.length);
          i += 1
        ) {
          const row = sources[i];
          cursor = row.id;
          const verdict = classifyBatch2Row(kind, row, tenant);
          if (verdict === "ok") applied += 1;
          else {
            mismatchReported += 1;
            if (
              verdict === "ambiguous-membership" ||
              verdict === "claimed-by-another-tenant"
            ) {
              quarantined += 1;
            }
            mismatches.push({ recordId: row.id, reason: verdict });
          }
        }
      }
    }

    if (
      input.mode === "apply" &&
      !(stopAfterChunks > 0 && chunkIndex >= stopAfterChunks)
    ) {
      phase = "completed";
      // 空源类别（分块循环零执行）也必须有进度行：upsert 保证 completed
      // 相位行一定落库，一致性报告不再把「空源」误报成「缺行未跑」。
      await database.execute(sql`
        insert into enterprise_backfill_batches
          (batch_id, kind, phase, last_cursor, scanned, applied, skipped_existing,
           mismatch_reported, quarantined, written_rows, resumes, updated_at)
        values (${CHILD_BACKFILL_BATCH2_ID}, ${kind}, 'completed', '', 0, 0, 0, 0, 0, 0, 0, now())
        on conflict (batch_id, kind) do update set
          phase = 'completed', updated_at = now()
      `);
    } else if (input.mode === "apply") {
      // 未跑完（主动停）：phase 保持 running（进度行已由最后块事务落盘）。
    } else {
      phase = prior.phase === "completed" ? "completed" : "running";
    }

    reports.push({
      kind,
      phase,
      lastCursor: cursor,
      scanned,
      applied,
      skippedExisting,
      mismatchReported,
      quarantined,
      writtenRows,
      resumes,
      mismatches,
    });
  }

  return { mode: input.mode, anchorTenantId: tenant, kinds: reports };
}

/** 写前校验（AC1 检测半边）：属主事实 → ok | 具体原因。 */
function classifyBatch2Row(
  kind: ChildBackfillBatch2Kind,
  row: Batch2SourceRow,
  tenant: string,
): "ok" | ChildBackfillBatch2Reason {
  if (!row.owner_principal) return "owner-principal-missing";
  if (kind === "openmuse-task" && row.existing_scope_tenant != null) {
    // 任务归属协会是全局主键：他租户已认领 = 归属冲突（隔离），本租户已
    // 存在 = 幂等跳过（调用侧 childExists 处理）。
    return row.existing_scope_tenant === tenant
      ? "ok"
      : "claimed-by-another-tenant";
  }
  if (Number(row.membership_count ?? 0) !== 1) return "ambiguous-membership";
  if (row.only_tenant !== tenant) return "parent-tenant-mismatch";
  return "ok";
}

export interface ChildBackfillBatch2ProgressEntry {
  readonly kind: ChildBackfillBatch2Kind;
  readonly phase: "running" | "completed";
  readonly lastCursor: string | null;
  readonly scanned: number;
  readonly applied: number;
  readonly skippedExisting: number;
  readonly mismatchReported: number;
  readonly quarantined: number;
  readonly writtenRows: number;
  readonly resumes: number;
  readonly updatedAt: string;
}

/**
 * AC4：第二批进度与计数校验报告——读持久进度表（enterprise_backfill_
 * batches），类别缺失如实列出（phase='missing' 语义由空位表达，不虚构行）。
 */
export async function childBackfillBatch2ProgressReport(
  database: Database,
): Promise<{
  readonly batchId: string;
  readonly entries: readonly ChildBackfillBatch2ProgressEntry[];
  readonly missingKinds: readonly ChildBackfillBatch2Kind[];
}> {
  const rows = (await database.execute(sql`
    select kind, phase, last_cursor, scanned, applied, skipped_existing,
           mismatch_reported, quarantined, written_rows, resumes, updated_at
    from enterprise_backfill_batches where batch_id = ${CHILD_BACKFILL_BATCH2_ID}
  `)) as unknown as {
    kind: ChildBackfillBatch2Kind;
    phase: "running" | "completed";
    last_cursor: string | null;
    scanned: number;
    applied: number;
    skipped_existing: number;
    mismatch_reported: number;
    quarantined: number;
    written_rows: number;
    resumes: number;
    updated_at: Date;
  }[];
  const entries: ChildBackfillBatch2ProgressEntry[] = rows.map((row) => ({
    kind: row.kind,
    phase: row.phase,
    lastCursor: row.last_cursor,
    scanned: Number(row.scanned),
    applied: Number(row.applied),
    skippedExisting: Number(row.skipped_existing),
    mismatchReported: Number(row.mismatch_reported),
    quarantined: Number(row.quarantined),
    writtenRows: Number(row.written_rows),
    resumes: Number(row.resumes),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
  const present = new Set(entries.map((entry) => entry.kind));
  return {
    batchId: CHILD_BACKFILL_BATCH2_ID,
    entries,
    missingKinds: CHILD_BACKFILL_BATCH2_KINDS.filter(
      (kind) => !present.has(kind),
    ),
  };
}

/** 主库回填批次清单（第一批 + 第二批，闭集）。 */
export const MAIN_BACKFILL_BATCHES = [
  { batchId: "child-main-batch1", kinds: 5 },
  {
    batchId: CHILD_BACKFILL_BATCH2_ID,
    kinds: CHILD_BACKFILL_BATCH2_KINDS.length,
  },
] as const;

export interface MainBackfillCompletion {
  /** 全部主库批次 × 类别齐且 phase='completed' 才为 true。 */
  readonly complete: boolean;
  readonly batches: readonly {
    readonly batchId: string;
    readonly expectedKinds: number;
    readonly presentKinds: number;
    readonly incompleteKinds: readonly { kind: string; phase: string }[];
    readonly missingKinds: readonly string[];
  }[];
}

/**
 * AC4 后半：「标记主库回填完成状态」——第一批 + 第二批全部类别齐且完成
 * 才 complete=true（计数守恒由 MT117 一致性校验的活数据对照承担，本面
 * 只报相位完整性）。供 MT117 与就绪闸消费。
 */
export async function mainBackfillCompletion(
  database: Database,
): Promise<MainBackfillCompletion> {
  const batches: MainBackfillCompletion["batches"][number][] = [];
  let complete = true;
  for (const expected of MAIN_BACKFILL_BATCHES) {
    const rows = (await database.execute(sql`
      select kind, phase from enterprise_backfill_batches
      where batch_id = ${expected.batchId}
    `)) as unknown as { kind: string; phase: string }[];
    const present = rows.length;
    const missing: string[] = [];
    // 缺类核对无条件执行：计数守恒（present ≥ kinds）不排除「混入未知 kind
    // 挤掉期望类别」——缺谁必须按行名逐类对账，不能被 present 计数门控。
    const known =
      expected.batchId === CHILD_BACKFILL_BATCH2_ID
        ? ([...CHILD_BACKFILL_BATCH2_KINDS] as string[])
        : [
            "bot-ownership",
            "conversation",
            "attachment",
            "credential",
            "plugin-connection",
          ];
    for (const kind of known) {
      if (!rows.some((row) => row.kind === kind)) missing.push(kind);
    }
    const incomplete = rows
      .filter((row) => row.phase !== "completed")
      .map((row) => ({ kind: row.kind, phase: row.phase }));
    if (
      missing.length > 0 ||
      incomplete.length > 0 ||
      present < expected.kinds
    ) {
      complete = false;
    }
    batches.push({
      batchId: expected.batchId,
      expectedKinds: expected.kinds,
      presentKinds: present,
      incompleteKinds: incomplete,
      missingKinds: missing,
    });
  }
  return { complete, batches };
}
