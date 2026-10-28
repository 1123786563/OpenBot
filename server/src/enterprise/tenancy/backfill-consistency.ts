// server/src/enterprise/tenancy/backfill-consistency.ts
// MT117（Issue #160）：跨库一致性校验、断点续跑与回填报告。
//
// 票面语义（写作于 2026-10-14）把「主库回填结果」与「知识库侧回填结果」
// 做跨库一致性校验。事实裁定：ADR 0009（2026-10-19 接受）全量下线知识库
// 子系统（本文取代各 spec 的 kb 相关部分；无 KB 库连接面、无 KB 测试库
// env 消费者、存量 KB 表为惰性数据）——「跨库」的第二库不存在。本工具
// 的诚实形态：
//   1. 知识库侧如实记为 not-applicable（依据 = ADR 0009），绝不虚构一个
//      假的 KB 半边，也不静默省略（MT116 钉子套件 child-backfill-kb.
//      test.ts 钉死下线状态；若 KB 面复活，本工具的 KB 裁定必须同步修订）。
//   2. 一致性校验落在真实存在的回填面：根回填（MT113 隔离重算）+ 第一批
//      （MT114）+ 第二批（MT115）的持久进度表 × 活数据对照：
//        - 相位完整性：全部批次 × 类别齐且 completed（missing/running 都
//          是未决项——「一侧未完成被检测，不被当作完成」）。
//        - 计数守恒：scanned = applied + skipped_existing + mismatch_
//          reported（进度表自身的算术一致）。
//        - 活数据对照：进度表声称的写入事实 vs 目标表的直接计数（progress
//          与库事实一侧成功一侧失败的漂移被点名）。
//        - 未决漂移：completed 之后又出现的可归属源行（迟到行）——活数据
//          重分类发现「按进度该完成、按数据还有没回填的行」。
//   3. 断点续跑：一致性校验自身是纯重算（零写入、确定性）；「可从断点
//      续跑」指被点名的批次/类别用其自身机制续跑（MT114/MT115 的游标
//      进度），报告给出确切的重跑入口，续跑后重算即清。
//   4. 可复现：报告内嵌独立验证者可执行的命令与函数入口（AC3）；同一
//      数据上重算两次结果一致（测试钉死）。
//   5. 就绪闸：存在未决项 ⇒ ready=false（与 MT113 rootBackfillReadiness
//      同款阻断纪律——隔离/漂移/未完成都阻断后续启用）。
//
// 通道纪律：只读面——全部读取走调用方给定的连接（进度表与源表是工具/
// 属主语义面；MT114 注册的 operator 只读臂供受限复核，见其 RLS 注册）。

import { sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { rootBackfillReadiness } from "./root-backfill";

/** 票面「两个测试库」在 ADR 0009 之后只剩主库；知识库侧裁定闭集。 */
export const KB_SIDE_DISPOSITION = {
  status: "not-applicable",
  basis:
    "ADR 0009 remove-knowledge-base-domain (accepted 2026-10-19): the KB subsystem is fully removed; " +
    "no KB database connection surface, no KB test-database env consumers, legacy KB tables are inert data. " +
    "There is no KB-side backfill to reconcile; if a knowledge surface is reintroduced this disposition " +
    "and its pin suite (child-backfill-kb.test.ts) must be consciously revised.",
} as const;

/** 独立验证者复现入口（AC3：报告自带可执行命令）。 */
export const BACKFILL_CONSISTENCY_REPRODUCE = {
  command: "bun test server/tests/multitenancy/backfill-consistency.test.ts",
  entrypoint: "buildBackfillConsistencyReport",
} as const;

export type ConsistencyFindingKind =
  | "batch-missing-kind"
  | "kind-phase-running"
  | "kind-counts-inconsistent"
  | "kind-progress-vs-live-drift"
  | "root-quarantine-open"
  | "unknown-batch-rows";

export interface ConsistencyFinding {
  /** 发现类别（闭集）。 */
  readonly kind: ConsistencyFindingKind;
  readonly batchId: string;
  /** 涉及的批次类别名（批次级发现为 '*'）。 */
  readonly kindLabel: string;
  readonly detail: string;
}

export interface BackfillConsistencyReport {
  /** 诚实范围：只含真实存在的回填面 + KB 侧 not-applicable 裁定。 */
  readonly scope: {
    readonly batches: readonly string[];
    readonly kbSide: typeof KB_SIDE_DISPOSITION;
  };
  /** 抽样对照（AC2）：逐类别抽样 = 进度行关键计数 + 目标表现场计数。 */
  readonly kinds: readonly {
    readonly batchId: string;
    readonly kind: string;
    readonly phase: string;
    readonly scanned: number;
    readonly applied: number;
    readonly skippedExisting: number;
    readonly mismatchReported: number;
    readonly quarantined: number;
    readonly writtenRows: number;
    readonly resumes: number;
    readonly countsConserved: boolean;
    readonly liveTargetRows: number | null;
  }[];
  /** 根回填隔离重算（MT113 同一推导，不另立第二份存储）。 */
  readonly rootReadiness: {
    readonly ready: boolean;
    readonly quarantinedCount: number;
  };
  /** 未决项（AC2/AC4）：非空 ⇒ ready=false。 */
  readonly findings: readonly ConsistencyFinding[];
  /** 就绪闸：findings 为空且根隔离清单为空才 true。 */
  readonly ready: boolean;
  /** AC3：复现命令与入口。 */
  readonly reproduce: typeof BACKFILL_CONSISTENCY_REPRODUCE;
}

/** 主库回填批次闭集与各类别的目标表/计数对照面（表名是闭集字面量）。 */
const BATCH_TARGETS: ReadonlyArray<{
  readonly batchId: string;
  readonly kinds: readonly string[];
  /** 目标表现场计数（anchor 绑定参数；null = 该类别无单一目标表）。 */
  readonly target: Record<
    string,
    ((anchor: string) => ReturnType<typeof sql>) | null
  >;
}> = [
  {
    batchId: "child-main-batch1",
    kinds: [
      "bot-ownership",
      "conversation",
      "attachment",
      "credential",
      "plugin-connection",
    ],
    target: {
      "bot-ownership": (anchor) =>
        sql`select count(*)::int as n from enterprise_bot_ownership where tenant_id = ${anchor}`,
      conversation: (anchor) =>
        sql`select count(*)::int as n from enterprise_conversations where tenant_id = ${anchor}`,
      attachment: (anchor) =>
        sql`select count(*)::int as n from enterprise_resources where tenant_id = ${anchor} and kind = 'attachment'`,
      credential: (anchor) =>
        sql`select count(*)::int as n from enterprise_credentials where tenant_id = ${anchor}`,
      "plugin-connection": (anchor) =>
        sql`select count(*)::int as n from enterprise_plugin_connections where tenant_id = ${anchor}`,
    },
  },
  {
    batchId: "child-main-batch2",
    kinds: ["personal-memory", "openmuse-task"],
    target: {
      "personal-memory": (anchor) =>
        sql`select count(*)::int as n from enterprise_personal_memories where tenant_id = ${anchor}`,
      "openmuse-task": (anchor) =>
        // 不过滤 attribution：进度侧的 skipped-existing 对 created/backfill
        // 两种既有协会行都计——对照面必须同口径（服务面 pin 的行也是
        // 「已存在」的事实）。
        sql`select count(*)::int as n from openmuse_task_scopes where tenant_id = ${anchor}`,
    },
  },
];

/** 第二批可归属源行的活数据重分类（迟到行漂移检测；与回填工具同构）。 */
const BATCH2_PENDING_CHECKS: Record<
  string,
  (anchor: string) => ReturnType<typeof sql>
> = {
  "personal-memory": (anchor) => sql`
    select count(*)::int as n from personal_memories pm
    where not exists (
      select 1 from enterprise_personal_memories m
      where m.tenant_id = ${anchor} and m.id = pm.id
    )
    and exists (
      select 1 from enterprise_principals p
      join enterprise_workspace_memberships wm on wm.principal_id = p.id
      where p.user_id = pm.owner_user_id and wm.tenant_id = ${anchor}
      and (select count(*) from enterprise_workspace_memberships wm2 where wm2.principal_id = p.id) = 1
    )`,
  "openmuse-task": (anchor) => sql`
    select count(*)::int as n from openmuse_tasks t
    where not exists (select 1 from openmuse_task_scopes s where s.task_id = t.id)
    and exists (
      select 1 from enterprise_principals p
      join enterprise_workspace_memberships wm on wm.principal_id = p.id
      where p.user_id = t.owner_user_id and wm.tenant_id = ${anchor}
      and (select count(*) from enterprise_workspace_memberships wm2 where wm2.principal_id = p.id) = 1
    )`,
};

/**
 * 构建一致性报告（纯重算、零写入、确定性——同一数据两次调用结果一致，
 * updated_at 时间戳不入报告体）。
 */
export async function buildBackfillConsistencyReport(
  database: Database,
  input: { readonly defaultWorkspaceId: string },
): Promise<BackfillConsistencyReport> {
  const anchors = (await database.execute(
    sql`select tenant_id from enterprise_deployment_anchors`,
  )) as unknown as { tenant_id: string }[];
  if (anchors.length !== 1) {
    throw new Error(
      `BACKFILL_CONSISTENCY_REFUSED: expected exactly one MT112 anchor row, found ${anchors.length}`,
    );
  }
  const anchor = anchors[0].tenant_id;

  const findings: ConsistencyFinding[] = [];
  const kinds: BackfillConsistencyReport["kinds"][number][] = [];

  // 已知批次闭集之外出现任何 (batch_id, kind) 进度行 = 未知回填面（不可静默吞）。
  const knownPairs = new Set(
    BATCH_TARGETS.flatMap((b) => b.kinds.map((k) => `${b.batchId}\u0000${k}`)),
  );
  const unknownRows = (await database.execute(sql`
    select distinct batch_id, kind from enterprise_backfill_batches
  `)) as unknown as { batch_id: string; kind: string }[];
  for (const row of unknownRows) {
    if (!knownPairs.has(`${row.batch_id}\u0000${row.kind}`)) {
      findings.push({
        kind: "unknown-batch-rows",
        batchId: row.batch_id,
        kindLabel: row.kind,
        detail: `进度表出现未知批次/类别 ${row.batch_id}/${row.kind} 的行——已知批次闭集之外不允许存在`,
      });
    }
  }

  for (const batch of BATCH_TARGETS) {
    for (const kind of batch.kinds) {
      const progress = (await database.execute(sql`
        select phase, scanned, applied, skipped_existing, mismatch_reported,
               quarantined, written_rows, resumes
        from enterprise_backfill_batches
        where batch_id = ${batch.batchId} and kind = ${kind}
      `)) as unknown as {
        phase: string;
        scanned: number;
        applied: number;
        skipped_existing: number;
        mismatch_reported: number;
        quarantined: number;
        written_rows: number;
        resumes: number;
      }[];
      if (progress.length === 0) {
        findings.push({
          kind: "batch-missing-kind",
          batchId: batch.batchId,
          kindLabel: kind,
          detail: `批次 ${batch.batchId} 缺类别 ${kind} 的进度行（未跑或空源无行）`,
        });
        kinds.push({
          batchId: batch.batchId,
          kind,
          phase: "missing",
          scanned: 0,
          applied: 0,
          skippedExisting: 0,
          mismatchReported: 0,
          quarantined: 0,
          writtenRows: 0,
          resumes: 0,
          countsConserved: true,
          liveTargetRows: null,
        });
        continue;
      }
      const row = progress[0];
      const scanned = Number(row.scanned);
      const applied = Number(row.applied);
      const skipped = Number(row.skipped_existing);
      const mismatch = Number(row.mismatch_reported);
      const conserved = scanned === applied + skipped + mismatch;
      if (!conserved) {
        findings.push({
          kind: "kind-counts-inconsistent",
          batchId: batch.batchId,
          kindLabel: kind,
          detail: `计数不守恒：scanned=${scanned} ≠ applied(${applied})+skipped(${skipped})+mismatch(${mismatch})`,
        });
      }
      if (row.phase !== "completed") {
        findings.push({
          kind: "kind-phase-running",
          batchId: batch.batchId,
          kindLabel: kind,
          detail: `相位 ${row.phase}——断点续跑入口：runChildBackfill${batch.batchId === "child-main-batch2" ? "Batch2" : ""}(apply)`,
        });
      }
      // 活数据对照：进度声称的归属行数 vs 目标表现场计数。
      const target = batch.target[kind];
      let liveTargetRows: number | null = null;
      if (target) {
        const live = (await database.execute(target(anchor))) as unknown as {
          n: number;
        }[];
        liveTargetRows = Number(live[0]?.n ?? 0);
        // 守恒前提下的漂移判据：进度侧声称已完成，但目标表行数少于进度
        // 声称的 applied+skipped（写入半边被外部回滚/删除 = 一侧成功一侧
        // 失败）。多出不算漂移（迟到的其他写入方合法存在）。
        if (
          row.phase === "completed" &&
          conserved &&
          liveTargetRows < applied + skipped
        ) {
          findings.push({
            kind: "kind-progress-vs-live-drift",
            batchId: batch.batchId,
            kindLabel: kind,
            detail: `进度声称 ${applied + skipped} 行，目标表现场 ${liveTargetRows} 行——进度半边与数据半边不一致`,
          });
        }
      }
      kinds.push({
        batchId: batch.batchId,
        kind,
        phase: row.phase,
        scanned,
        applied,
        skippedExisting: skipped,
        mismatchReported: mismatch,
        quarantined: Number(row.quarantined),
        writtenRows: Number(row.written_rows),
        resumes: Number(row.resumes),
        countsConserved: conserved,
        liveTargetRows,
      });
    }
  }

  // 第二批的迟到行漂移：completed 之后新出现的可归属源行（活数据重分类）。
  for (const [kind, check] of Object.entries(BATCH2_PENDING_CHECKS)) {
    const progress = kinds.find(
      (k) => k.batchId === "child-main-batch2" && k.kind === kind,
    );
    if (progress?.phase !== "completed") continue;
    const pending = (await database.execute(check(anchor))) as unknown as {
      n: number;
    }[];
    const count = Number(pending[0]?.n ?? 0);
    if (count > 0) {
      findings.push({
        kind: "kind-progress-vs-live-drift",
        batchId: "child-main-batch2",
        kindLabel: kind,
        detail: `相位 completed 但存在 ${count} 个可归属未回填源行（迟到行）——断点续跑入口：runChildBackfillBatch2(apply)`,
      });
    }
  }

  // 根回填隔离重算（MT113 同一推导）。
  const root = await rootBackfillReadiness(database, input.defaultWorkspaceId);
  if (!root.ready) {
    findings.push({
      kind: "root-quarantine-open",
      batchId: "root-backfill",
      kindLabel: "*",
      detail: `MT113 隔离清单未清空（${root.quarantined.length} 项）`,
    });
  }

  return {
    scope: {
      batches: BATCH_TARGETS.map((b) => b.batchId),
      kbSide: KB_SIDE_DISPOSITION,
    },
    kinds,
    rootReadiness: {
      ready: root.ready,
      quarantinedCount: root.quarantined.length,
    },
    findings,
    ready: findings.length === 0,
    reproduce: BACKFILL_CONSISTENCY_REPRODUCE,
  };
}

/**
 * AC4 的阻断半边：未决项非空 ⇒ ready=false（与 rootBackfillReadiness
 * 同款纪律）。供后续启用闸（MT120+）消费。
 */
export async function backfillConsistencyReadiness(
  database: Database,
  input: { readonly defaultWorkspaceId: string },
): Promise<{ ready: boolean; findings: readonly ConsistencyFinding[] }> {
  const report = await buildBackfillConsistencyReport(database, input);
  return { ready: report.ready, findings: report.findings };
}
