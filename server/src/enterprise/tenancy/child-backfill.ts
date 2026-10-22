// server/src/enterprise/tenancy/child-backfill.ts
// MT114（Issue #157）：主库子记录回填第一批——Bot、会话、附件、凭据与插件。
//
// 票面语义：主库中上述域的子记录按复合关联回填公司/团队归属，保证不会
// 关联到与父记录不同的公司；不一致被检测并报告，不静默覆盖；可中断续跑
// 且不重复写入；输出本批进度与计数校验报告（持久化在
// enterprise_backfill_batches，MT114 迁移注册），供后续批次（MT115/116）
// 与一致性校验（MT117）消费。
//
// 结构（前提 = MT113 根记录已回填：父 = enterprise_resources 根行）：
//
//   1. 五类子记录，每类的「复合关联」都是「子行 tenant 必须等于父根行
//      tenant」这一事实的落形：
//        bot-ownership   agents（父根 kind='bot'）→ enterprise_bot_ownership
//                        （agent_id 全局唯一索引 = 跨公司认领的结构性拒绝）
//        conversation    craft_sessions（父根 kind='craft-session'）→
//                        enterprise_conversations（threadId 语义键）
//        attachment      attachments（父根 = 所属频道 kind='channel'）→
//                        enterprise_resources kind='attachment' + 上传者 grant
//        credential      credentials（父根 kind='credential'）→
//                        enterprise_credentials（classification='company'，
//                        行形 CHECK 强制 workspace/owner 双空；envelope 原样
//                        承接既有密文，明文永不经过本工具）
//        plugin-connection composio_connections（父 = enterprise_plugin_
//                        installs）→ 安装 + 连接两级：目录身份可解析
//                        （catalog 行存在且 kind='composio'）才落 install +
//                        connection（复合 FK (tenant, install_id)），否则
//                        整对进隔离清单——目录身份不可猜（AC1「不静默
//                        覆盖/不猜测」的插件半边）。
//   2. 不一致检测（AC1）：每个子记录写前校验父根行——父缺失
//      （pending-parent：MT113 未及或属主主体未落地）与父在**他租户**
//      （parent-tenant-mismatch）都进 mismatch 报告，零写入；已存在的
//      同租户子行 = skipped-existing（幂等跳过，不重写不覆盖）。
//   3. 可中断续跑（AC2）：逐 kind 按 id 有序、分块处理；每块的数据写入与
//      进度行（游标 last_cursor + 计数）**同一事务**提交——崩溃后从游标
//      续跑（resumes 计数）；全部源行处理完 → phase='completed'。幂等
//      写入（ON CONFLICT DO NOTHING）保证重放/续跑零重复。
//   4. 约束与校验双重（AC3）：约束半边由既有对象承担（bot_ownership 的
//      agent_id 全局唯一、messages/prefs/connections 的复合外键——跨公司
//      关联被数据库拒绝）；校验半边是本工具写前的父根一致性判定。测试
//      对两层各给真实证据。
//   5. 计数报告（AC4）：childBackfillProgressReport 读持久进度表（受限
//      operator 只读面），输出逐 kind 计数 + mismatch/隔离明细 + 相位。
//
// 通道纪律：与 MT113 同款——写入走 setup/属主连接（迁移语义），验证读
// 走受限角色；进度表对受限角色只读。
//
// 边界（诚实披露）：
//   - 第二批（记忆/任务/Craft/Workshop/OpenMuse/账务/策略，MT115）与知识
//     库侧（MT116）不在本批；enterprise_messages 等无遗留源（企业表是纯
//     新增），本批只回填有真实遗留数据的类别。
//   - 前置 #156（MT113）同工作区交付；#117（MT074 余额迁移）无已交付
//     契约（协调器裁决 A 案披露），本面不消费其产物。

import { sql } from "drizzle-orm";
import type { Database } from "../../db/client";

/** 本批批次 id（票面「第一批」；后续批次各用自己的 id）。 */
export const CHILD_BACKFILL_BATCH_ID = "child-main-batch1";

/** 本批子记录类别（闭集）。 */
export const CHILD_BACKFILL_KINDS = [
  "bot-ownership",
  "conversation",
  "attachment",
  "credential",
  "plugin-connection",
] as const;
export type ChildBackfillKind = (typeof CHILD_BACKFILL_KINDS)[number];

export type ChildBackfillMode = "dry-run" | "apply";

/** mismatch/隔离原因闭集。 */
export const CHILD_BACKFILL_REASONS = [
  "pending-parent",
  "parent-tenant-mismatch",
  "owner-principal-missing",
  "plugin-catalog-unresolvable",
] as const;
export type ChildBackfillReason = (typeof CHILD_BACKFILL_REASONS)[number];

export interface ChildBackfillInput {
  readonly mode: ChildBackfillMode;
  /** 默认团队 workspace id（MT112/MT113 同一锚点产物）。 */
  readonly defaultWorkspaceId: string;
  /** 分块大小（进度落盘节奏）；默认 200。 */
  readonly chunkSize?: number;
  /** 处理 N 块后主动停（模拟中断：进度已提交、phase='running'）；0=不停。 */
  readonly stopAfterChunks?: number;
}

export interface ChildBackfillKindReport {
  readonly kind: ChildBackfillKind;
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
    readonly reason: ChildBackfillReason;
  }[];
}

export interface ChildBackfillReport {
  readonly mode: ChildBackfillMode;
  readonly anchorTenantId: string;
  readonly kinds: readonly ChildBackfillKindReport[];
}

/** 拒绝哨兵：锚点缺失/默认团队不属于锚点。 */
export const CHILD_BACKFILL_REFUSED = "CHILD_BACKFILL_REFUSED";

class ChildBackfillRefusal extends Error {
  constructor(reason: string) {
    super(`${CHILD_BACKFILL_REFUSED}: ${reason}`);
  }
}

interface ProgressRow {
  readonly kind: ChildBackfillKind;
  readonly phase: "running" | "completed";
  readonly last_cursor: string | null;
  readonly scanned: number;
  readonly applied: number;
  readonly skipped_existing: number;
  readonly mismatch_reported: number;
  readonly quarantined: number;
  readonly written_rows: number;
  readonly resumes: number;
  readonly mismatches: { recordId: string; reason: ChildBackfillReason }[];
}

/** 每类的源行查询（id 有序；带父根事实与属主事实，全部由 SQL 推导）。 */
const CHILD_SOURCES: Record<
  ChildBackfillKind,
  (tenant: string) => ReturnType<typeof sql>
> = {
  "bot-ownership": (tenant) => sql`
    select a.id,
      (select r.tenant_id from enterprise_resources r where r.id = a.id) as parent_tenant,
      (select count(*)::int from enterprise_resources r where r.id = a.id and r.tenant_id = ${tenant} and r.kind = 'bot') as parent_ok
    from agents a order by a.id`,
  conversation: (tenant) => sql`
    select s.id,
      (select r.tenant_id from enterprise_resources r where r.id = s.id) as parent_tenant,
      (select count(*)::int from enterprise_resources r where r.id = s.id and r.tenant_id = ${tenant} and r.kind = 'craft-session') as parent_ok,
      (select p.id from enterprise_principals p where p.user_id = s.user_id) as owner_principal
    from craft_sessions s order by s.id`,
  attachment: (tenant) => sql`
    select at.id::text as id,
      (select r.tenant_id from enterprise_resources r where r.id = at.channel_id) as parent_tenant,
      (select count(*)::int from enterprise_resources r where r.id = at.channel_id and r.tenant_id = ${tenant} and r.kind = 'channel') as parent_ok,
      (select p.id from enterprise_principals p where p.user_id = at.uploaded_by) as owner_principal,
      at.name as display_name
    from attachments at order by at.id`,
  credential: (tenant) => sql`
    select c.id::text as id,
      (select r.tenant_id from enterprise_resources r where r.id = c.id::text) as parent_tenant,
      (select count(*)::int from enterprise_resources r where r.id = c.id::text and r.tenant_id = ${tenant} and r.kind = 'credential') as parent_ok,
      c.provider as target,
      c.encrypted_value as envelope,
      (c.revoked_at is not null) as revoked
    from credentials c order by c.id`,
  "plugin-connection": (_tenant) => sql`
    select cc.toolkit || ':' || cc.user_id as id,
      (select count(*)::int from enterprise_plugin_catalog cat where cat.id = cc.toolkit and cat.kind = 'composio') as catalog_ok,
      (select p.id from enterprise_principals p where p.user_id = cc.user_id) as owner_principal,
      cc.toolkit, cc.user_id
    from composio_connections cc
    order by cc.toolkit, cc.user_id`,
};

interface ChildSourceRow {
  readonly id: string;
  readonly parent_tenant: string | null;
  readonly parent_ok: number;
  readonly owner_principal?: string | null;
  readonly display_name?: string | null;
  readonly target?: string | null;
  readonly envelope?: string | null;
  readonly revoked?: boolean | null;
  readonly catalog_ok?: number | null;
  readonly toolkit?: string | null;
  readonly user_id?: string | null;
}

/** 单类子记录的写入（返回本块实际写入行数；只写全新行）。 */
async function writeChildRows(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  kind: ChildBackfillKind,
  row: ChildSourceRow,
  tenant: string,
  defaultWorkspaceId: string,
  anchorPrincipalId: string,
): Promise<number> {
  const inserted = (rows: unknown) => (Array.isArray(rows) ? rows.length : 0);
  switch (kind) {
    case "bot-ownership": {
      // 属主守门人 = MT112 锚点主体（部署级 Bot 无逐记录属主；锚点 admin
      // 是确定性守门人，不是猜测的属主）。
      return inserted(
        await tx.execute(sql`
          insert into enterprise_bot_ownership
            (tenant_id, agent_id, workspace_id, owner_principal_id, display_name, default_config, status)
          select ${tenant}, a.id, ${defaultWorkspaceId}, ${anchorPrincipalId}, a.name, a.configuration, 'active'
          from agents a where a.id = ${row.id}
          on conflict (tenant_id, agent_id) do nothing
          returning 1
        `),
      );
    }
    case "conversation": {
      return inserted(
        await tx.execute(sql`
          insert into enterprise_conversations
            (tenant_id, workspace_id, principal_id, thread_id)
          select ${tenant}, ${defaultWorkspaceId}, ${row.owner_principal ?? null}, ${row.id}
          on conflict (tenant_id, thread_id) do nothing
          returning 1
        `),
      );
    }
    case "attachment": {
      const resourceRows = await tx.execute(sql`
        insert into enterprise_resources (tenant_id, id, workspace_id, kind, display_name, status)
        select ${tenant}, ${row.id}, ${defaultWorkspaceId}, 'attachment', ${row.display_name ?? row.id}, 'active'
        on conflict (tenant_id, id) do nothing
        returning 1
      `);
      const grantRows = row.owner_principal
        ? await tx.execute(sql`
            insert into enterprise_resource_grants (tenant_id, resource_id, principal_id, action)
            values (${tenant}, ${row.id}, ${row.owner_principal}, 'read')
            on conflict (tenant_id, resource_id, principal_id, action) do nothing
            returning 1
          `)
        : [];
      return inserted(resourceRows) + inserted(grantRows);
    }
    case "credential": {
      return inserted(
        await tx.execute(sql`
          insert into enterprise_credentials
            (tenant_id, id, kind, classification, target, display, envelope, status)
          select ${tenant}::text, ${row.id}::text, 'connection', 'company',
            ${row.target ?? row.id}::text,
            jsonb_build_object('label', ${row.target ?? row.id}::text),
            ${row.envelope ?? ""}::text, ${row.revoked ? "revoked" : "active"}::text
          on conflict (tenant_id, id) do nothing
          returning 1
        `),
      );
    }
    case "plugin-connection": {
      // 目录身份可解析才落两级（install + connection，同一事务）；
      // install id 确定性派生（toolkit:user），复合 FK 保证连接不越公司。
      const installId = `legacy-${row.toolkit}-${row.user_id}`;
      const installRows = await tx.execute(sql`
        insert into enterprise_plugin_installs
          (tenant_id, id, catalog_id, workspace_id, installed_by, config)
        select ${tenant}::text, ${installId}::text, ${row.toolkit ?? ""}::text,
          ${defaultWorkspaceId}::text, ${row.owner_principal ?? null}::text, '{}'::jsonb
        on conflict (tenant_id, id) do nothing
        returning 1
      `);
      const connectionRows = await tx.execute(sql`
        insert into enterprise_plugin_connections
          (tenant_id, id, install_id, bound_by, vendor_ref)
        select ${tenant}::text, ${installId}::text, ${installId}::text,
          ${row.owner_principal ?? null}::text,
          ${`${row.toolkit ?? ""}:${row.user_id ?? ""}`}::text
        on conflict (tenant_id, id) do nothing
        returning 1
      `);
      return inserted(installRows) + inserted(connectionRows);
    }
  }
}

/** 子记录已存在（同租户）判定。 */
async function childExists(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  kind: ChildBackfillKind,
  row: ChildSourceRow,
  tenant: string,
): Promise<boolean> {
  const table =
    kind === "bot-ownership"
      ? sql`enterprise_bot_ownership`
      : kind === "conversation"
        ? sql`enterprise_conversations`
        : kind === "attachment"
          ? sql`enterprise_resources`
          : kind === "credential"
            ? sql`enterprise_credentials`
            : sql`enterprise_plugin_connections`;
  // 各子表的主体列名不同（归属表=agent_id、会话表=thread_id、其余=id）。
  const idColumn =
    kind === "bot-ownership"
      ? sql`agent_id`
      : kind === "conversation"
        ? sql`thread_id`
        : sql`id`;
  const kindFilter =
    kind === "attachment" ? sql` and kind = 'attachment'` : sql``;
  const rows = await tx.execute(sql`
    select 1 from ${table}
    where tenant_id = ${tenant} and ${idColumn} = ${row.id}${kindFilter} limit 1
  `);
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * 运行本批回填。逐 kind 分块；每块一个事务：源行处理（校验→写入→计数）
 * 与进度行推进同事务提交。dry-run 只推导不写业务行（进度也不推进）。
 */
export async function runChildBackfill(
  database: Database,
  input: ChildBackfillInput,
): Promise<ChildBackfillReport> {
  if (input.mode !== "dry-run" && input.mode !== "apply") {
    throw new ChildBackfillRefusal("mode must be dry-run|apply");
  }
  const chunkSize = Math.min(Math.max(input.chunkSize ?? 200, 1), 1000);
  const stopAfterChunks = Math.max(input.stopAfterChunks ?? 0, 0);

  // 锚点与默认团队（MT113 同款守卫，读自库事实）。
  const anchors = (await database.execute(
    sql`select tenant_id from enterprise_deployment_anchors`,
  )) as unknown as { tenant_id: string }[];
  if (anchors.length !== 1) {
    throw new ChildBackfillRefusal(
      `expected exactly one MT112 anchor row, found ${anchors.length}`,
    );
  }
  const tenant = anchors[0].tenant_id;
  const workspace = (await database.execute(
    sql`select id from enterprise_workspaces where tenant_id = ${tenant} and id = ${input.defaultWorkspaceId}`,
  )) as unknown as { id: string }[];
  if (workspace.length !== 1) {
    throw new ChildBackfillRefusal(
      `default workspace ${input.defaultWorkspaceId} not in anchor tenant`,
    );
  }
  // 锚点主体 = 原有公司 tenant_admin（部署级子记录的确定性守门人）。
  const anchorPrincipals = (await database.execute(sql`
    select m.principal_id from enterprise_memberships m
    where m.tenant_id = ${tenant} and m.role = 'tenant_admin' limit 1
  `)) as unknown as { principal_id: string }[];
  if (anchorPrincipals.length !== 1) {
    throw new ChildBackfillRefusal("anchor tenant_admin principal not found");
  }
  const anchorPrincipalId = anchorPrincipals[0].principal_id;

  const reports: ChildBackfillKindReport[] = [];

  for (const kind of CHILD_BACKFILL_KINDS) {
    // 既有进度（续跑事实）。
    const existing = (await database.execute(sql`
      select * from enterprise_backfill_batches
      where batch_id = ${CHILD_BACKFILL_BATCH_ID} and kind = ${kind}
    `)) as unknown as (ChildSourceRow & Record<string, unknown>)[];
    const prior = (existing[0] ?? {}) as Partial<ProgressRow> &
      Record<string, unknown>;
    // 计数是**本轮**的判定结果（进度行 = 最后一轮的画像；written_rows 与
    // resumes 是累计事实）。每轮全量分类：新源行可能落在旧游标之前
    //（uuid 乱序），只认游标会把它们永远跳过——幂等写入让全量重分类
    // 零重复，正确性优先于省力。
    let scanned = 0;
    let applied = 0;
    let skippedExisting = 0;
    let mismatchReported = 0;
    let quarantined = 0;
    let writtenRows = Number(prior.written_rows ?? 0);
    const resumes =
      Number(prior.resumes ?? 0) + (input.mode === "apply" ? 1 : 0);
    const mismatches: { recordId: string; reason: ChildBackfillReason }[] = [];
    let cursor: string | null = (prior.last_cursor ?? null) as string | null;
    let phase: "running" | "completed" =
      (prior.phase as "running" | "completed" | undefined) ?? "running";

    // 源行（id 有序；游标是最后处理位置的记录，不排除任何行）。
    const sources = (await database.execute(
      CHILD_SOURCES[kind](tenant),
    )) as unknown as ChildSourceRow[];
    const pending = sources;
    scanned = sources.length;

    let chunkIndex = 0;
    for (
      let offset = 0;
      offset < pending.length;
      offset += chunkSize, chunkIndex += 1
    ) {
      if (input.mode === "apply") {
        if (stopAfterChunks > 0 && chunkIndex >= stopAfterChunks) {
          phase = "running";
          break;
        }
        // 每块一个事务：写入与进度同提交（崩溃安全）。
        await database.transaction(async (tx) => {
          for (
            let i = offset;
            i < Math.min(offset + chunkSize, pending.length);
            i += 1
          ) {
            const row = pending[i];
            cursor = row.id;
            const verdict = classifyChildRow(kind, row, tenant);
            if (verdict === "ok") {
              if (await childExists(tx, kind, row, tenant)) {
                skippedExisting += 1;
              } else {
                const wrote = await writeChildRows(
                  tx,
                  kind,
                  row,
                  tenant,
                  input.defaultWorkspaceId,
                  anchorPrincipalId,
                );
                writtenRows += wrote;
                applied += wrote > 0 ? 1 : 0;
                if (wrote === 0) skippedExisting += 1;
              }
            } else {
              mismatchReported += 1;
              if (verdict === "plugin-catalog-unresolvable") quarantined += 1;
              mismatches.push({ recordId: row.id, reason: verdict });
            }
          }
          await tx.execute(sql`
            insert into enterprise_backfill_batches
              (batch_id, kind, phase, last_cursor, scanned, applied, skipped_existing,
               mismatch_reported, quarantined, written_rows, resumes, updated_at)
            values (${CHILD_BACKFILL_BATCH_ID}, ${kind}, 'running', ${cursor},
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
        // dry-run：整块逐行推导，不写不推进。
        for (
          let i = offset;
          i < Math.min(offset + chunkSize, pending.length);
          i += 1
        ) {
          const row = pending[i];
          cursor = row.id;
          const verdict = classifyChildRow(kind, row, tenant);
          if (verdict === "ok") applied += 1;
          else {
            mismatchReported += 1;
            if (verdict === "plugin-catalog-unresolvable") quarantined += 1;
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
      await database.execute(sql`
        update enterprise_backfill_batches set phase = 'completed', updated_at = now()
        where batch_id = ${CHILD_BACKFILL_BATCH_ID} and kind = ${kind}
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

/** 写前校验（AC1 检测半边）：父根事实 → ok | 具体原因。 */
function classifyChildRow(
  kind: ChildBackfillKind,
  row: ChildSourceRow,
  tenant: string,
): "ok" | ChildBackfillReason {
  if (kind === "plugin-connection") {
    if (Number(row.catalog_ok ?? 0) < 1) return "plugin-catalog-unresolvable";
    if (!row.owner_principal) return "owner-principal-missing";
    return "ok";
  }
  if (Number(row.parent_ok ?? 0) >= 1) {
    if (
      (kind === "conversation" || kind === "attachment") &&
      !row.owner_principal
    ) {
      return "owner-principal-missing";
    }
    return "ok";
  }
  if (row.parent_tenant !== null && row.parent_tenant !== tenant) {
    return "parent-tenant-mismatch";
  }
  return "pending-parent";
}

export interface ChildBackfillProgressEntry {
  readonly kind: ChildBackfillKind;
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
 * AC4：进度与计数校验报告——读持久进度表（enterprise_backfill_batches），
 * 供后续批次与 MT117 一致性校验消费。批次缺失/类别缺失都如实列出
 * （phase='missing' 语义由空位表达，不虚构行）。
 */
export async function childBackfillProgressReport(
  database: Database,
  batchId: string = CHILD_BACKFILL_BATCH_ID,
): Promise<{
  readonly batchId: string;
  readonly entries: readonly ChildBackfillProgressEntry[];
  readonly missingKinds: readonly ChildBackfillKind[];
}> {
  const rows = (await database.execute(sql`
    select kind, phase, last_cursor, scanned, applied, skipped_existing,
           mismatch_reported, quarantined, written_rows, resumes, updated_at
    from enterprise_backfill_batches where batch_id = ${batchId}
  `)) as unknown as {
    kind: ChildBackfillKind;
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
  const entries: ChildBackfillProgressEntry[] = rows.map((row) => ({
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
    batchId,
    entries,
    missingKinds: CHILD_BACKFILL_KINDS.filter((kind) => !present.has(kind)),
  };
}
