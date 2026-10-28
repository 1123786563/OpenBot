// server/src/enterprise/tenancy/rollback-procedure.ts
// MT121（Issue #164）：冻结写入、备份、恢复、失败隔离与回退程序（含演练）。
//
// 票面语义：交付可执行的上线与回退程序——冻结写入、备份、恢复、失败
// 隔离，以及「存在多公司数据后不能回退到不理解归属的旧版本」的安全
// 回退路径，并完成一次演练。不执行生产迁移或部署；本票只交付程序、
// 脚本与演练证据。
//
// 结构（程序 = 声明式步骤 + 可执行判定 + 演练驱动器三件）：
//
//   1. MULTITENANCY_ROLLBACK_PROCEDURE：五步程序的单一事实源（每步的
//      目的、明确判定条件与执行面）——运维文档（docs/plans/tickets/
//      multitenancy/reports/MT121-rollback-procedure.md）逐字引用，不另
//      立第二份叙述。
//   2. evaluateRollbackGate：安全回退门的两条硬判定（AC3）——
//        a. 多公司数据门：可归属业务表中出现多于一家公司的行 ⇒ 回退到
//           不理解归属的旧版本被拒绝（旧版本无法按公司/团队解析这些
//           行，回退即破坏隔离事实）；
//        b. 停止前置门：仍有持有的 job lease 或活跃事件订阅 ⇒ 必须先
//           停止业务入口与任务执行（冻结写入的判定条件），否则回退
//           在飞行写入中途截断。
//   3. runRollbackDrill：对真实数据库执行五步演练（AC2）——逐步计时
//      （durationMs）、逐步数据量（行数/摘要数）与逐步判定结果入
//      DrillRecord；问题如实记录（problems 数组——发现即修即重验，
//      AC4）。演练的恢复半边把租户域表的逐表内容摘要物化到影子模式
//      并对照（真实数据搬运，不是纸面对照）；失败隔离半边按租户逐表
//      枚举行并核对零 NULL 归属（隔离边界存在 = 行可按 tenant_id 完整
//      划分）。
//
// 边界（诚实披露）：
//   - 生产备份/恢复的工具形态是 pg_dump/pg_restore（运维文档步骤 2/3 的
//     人工命令面）；本模块的演练半边在库内做影子物化对照——同一判定
//     条件的可自动化排练，不是生产备份的替代。
//   - 表清单是租户域闭集（十六表 + 容忍缺表）：不属于租户域的表不在
//     回退判定面。
//   - 演练在专用测试库执行（TEST_DATABASE_URL 环境守卫由调用方/测试
//     承担；本模块不连库、不读 env——连接由调用方注入）。

import { sql } from "drizzle-orm";
import type { Database } from "../../db/client";

// ---------------------------------------------------------------------------
// 程序（声明式单一事实源）
// ---------------------------------------------------------------------------

export interface RollbackProcedureStep {
  readonly id:
    | "freeze-writes"
    | "backup"
    | "restore"
    | "failure-isolation"
    | "rollback-gate";
  readonly name: string;
  /** 判定条件（AC1：明确、可执行——每步的进入/通过判据）。 */
  readonly criteria: string;
  /** 执行面（人工命令 or 本模块的判定入口）。 */
  readonly execution: string;
}

/**
 * 五步回退程序（AC1）。顺序即执行顺序；每步的判定条件不过不进下一步。
 */
export const MULTITENANCY_ROLLBACK_PROCEDURE: readonly RollbackProcedureStep[] =
  Object.freeze([
    {
      id: "freeze-writes",
      name: "冻结写入",
      criteria:
        "持有的 job lease 数 = 0 且活跃事件订阅数 = 0（evaluateRollbackGate 的停止前置半边）；业务入口停止对外服务（部署层动作，判定面是上述两个可数事实归零）",
      execution:
        "停止业务入口与任务执行（部署层）；本模块判定入口：evaluateRollbackGate 的 stopFirst",
    },
    {
      id: "backup",
      name: "备份",
      criteria:
        "租户域十六表逐表行数 + 内容摘要（md5 全表稳定投影）落盘成备份清单；清单缺任一存在表即不通过",
      execution:
        "pg_dump（生产）或 runRollbackDrill 的 backup 步（库内逐表 digest）",
    },
    {
      id: "restore",
      name: "恢复",
      criteria:
        "恢复目标上重算同一摘要算法，逐表与备份清单一致；任一表行数或摘要不一致即失败隔离该表",
      execution:
        "pg_restore（生产）或 runRollbackDrill 的 restore 步（影子模式物化对照）",
    },
    {
      id: "failure-isolation",
      name: "失败隔离",
      criteria:
        "按租户逐表枚举行：归属列非空的每一行都落在恰好一个租户（零 NULL 归属残留）；失败租户的行集合可被完整圈出而不触碰他租户行",
      execution: "runRollbackDrill 的 failure-isolation 步（逐租户行枚举）",
    },
    {
      id: "rollback-gate",
      name: "回退门",
      criteria:
        "可归属业务表中的公司数 ≤ 1 才允许回退到不理解归属的旧版本；多公司数据 ⇒ 必须使用仍支持隔离的版本（拒绝回退，不是警告）；冻结前置未满足 ⇒ 必须先停止业务入口与任务执行",
      execution: "evaluateRollbackGate（生产与演练共用同一判定）",
    },
  ] satisfies readonly RollbackProcedureStep[]);

// ---------------------------------------------------------------------------
// 安全回退门（AC3：两条硬判定）
// ---------------------------------------------------------------------------

/** 租户域表闭集（备份/恢复/失败隔离/演练面；容忍缺表——判定如实降级）。 */
export const TENANT_DOMAIN_TABLES: readonly string[] = Object.freeze([
  "enterprise_tenants",
  "enterprise_principals",
  "enterprise_memberships",
  "enterprise_workspaces",
  "enterprise_workspace_memberships",
  "enterprise_resources",
  "enterprise_resource_grants",
  "enterprise_conversations",
  "enterprise_messages",
  "enterprise_bot_ownership",
  "job_ownership",
  "voice_session_scopes",
  "dictation_usage_scopes",
  "push_device_scopes",
  "openmuse_task_scopes",
  "enterprise_quarantine_items",
]);

/** 「存在多公司数据」判定用的可归属业务表（行 = 某公司的业务事实）。 */
const ATTRIBUTABLE_TABLES: readonly string[] = Object.freeze([
  "enterprise_resources",
  "enterprise_conversations",
  "enterprise_bot_ownership",
]);

export interface RollbackGateEvaluation {
  /** 多公司数据门：true = 至多一家公司有业务数据，允许考虑回退。 */
  readonly singleCompanyOnly: boolean;
  /** 停止前置门：true = 无持有的 job lease 且无活跃事件订阅。 */
  readonly stopFirstSatisfied: boolean;
  readonly allowed: boolean;
  /** 拒绝理由（AC3 的两条规则原文；通过时为 null）。 */
  readonly refusal: string | null;
  /** 判定数据量：逐表公司数与飞行事实计数。 */
  readonly measured: {
    readonly tenantsPerTable: readonly {
      readonly table: string;
      readonly tenants: number;
    }[];
    readonly heldJobLeases: number;
    readonly activeEventSubscriptions: number;
  };
}

/**
 * 「表不存在」的判别面：Postgres SQLSTATE 42P01（经 bun-sql 的 cause 链
 * 传递，errno 字段承载）或其等义 message。只有它算「无数据」；连接失败、
 * 权限等一切其他错误都不是——回退门宁可判定失败也不把「测不到」当
 * 「测过为零」（fail-closed）。
 */
function isMissingRelationError(error: unknown): boolean {
  let current: unknown = error;
  for (
    let depth = 0;
    current !== null && typeof current === "object" && depth < 4;
    depth += 1
  ) {
    const candidate = current as {
      errno?: unknown;
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (candidate.errno === "42P01" || candidate.code === "42P01") return true;
    if (
      typeof candidate.message === "string" &&
      /relation "[^"]+" does not exist/i.test(candidate.message)
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/** 闭集表名直查（sql.raw 只接本模块的表名闭集，不接任何外部输入）。 */
async function countByTable(
  database: Database,
  table: string,
  projection: string,
): Promise<{ n: number }[]> {
  return (await database
    .execute(sql.raw(`select ${projection} as n from public."${table}"`))
    .catch((error: unknown) => {
      // 缺表 = 无数据（判定如实降级；缺表事实由备份步的 missingTables 披露）。
      if (isMissingRelationError(error)) return [];
      throw error;
    })) as unknown as { n: number }[];
}

/**
 * 安全回退门（AC3 判定半边；纯读、零写入）。两条硬判定都不满足条件时
 * 拒绝，两条拒绝理由都列出（MT013 同纪律：一次列全）。表缺失按 0 计
 * （缺表 = 无数据，不是判定失败——缺表事实由备份步的 missingTables 披露）；
 * 任何其他测量错误（连接失败、权限等）如实抛出——fail-closed，不把
 * 「测不到」折叠成「测过为零」的放行。
 */
export async function evaluateRollbackGate(
  database: Database,
): Promise<RollbackGateEvaluation> {
  const tenantsPerTable: { table: string; tenants: number }[] = [];
  for (const table of ATTRIBUTABLE_TABLES) {
    const rows = await countByTable(
      database,
      table,
      "count(distinct tenant_id)::int",
    );
    if (rows.length > 0) {
      tenantsPerTable.push({ table, tenants: Number(rows[0]?.n ?? 0) });
    }
  }
  const maxTenants = Math.max(0, ...tenantsPerTable.map((row) => row.tenants));
  const singleCompanyOnly = maxTenants <= 1;

  const leaseRows = await countByTable(database, "job_leases", "count(*)::int");
  const subscriptionRows = (await database
    .execute(sql`
    select count(*)::int as n from enterprise_resources
    where kind = 'event-subscription' and visibility is null and status = 'active'
  `)
    .catch((error: unknown) => {
      // 与 countByTable 同一判别面：只有缺表按 0 计，其余错误如实抛出。
      if (isMissingRelationError(error)) return [{ n: 0 }] as unknown;
      throw error;
    })) as unknown as { n: number }[];
  const heldJobLeases = Number(leaseRows[0]?.n ?? 0);
  const activeEventSubscriptions = Number(subscriptionRows[0]?.n ?? 0);
  const stopFirstSatisfied =
    heldJobLeases === 0 && activeEventSubscriptions === 0;

  const refusals: string[] = [];
  if (!singleCompanyOnly) {
    refusals.push(
      "存在多公司数据（可归属业务表出现多于一家公司的行）——必须使用仍支持隔离的版本，不能回退到不理解归属的旧版本",
    );
  }
  if (!stopFirstSatisfied) {
    refusals.push(
      `必须先停止业务入口与任务执行（持有 job lease ${heldJobLeases} 条、活跃事件订阅 ${activeEventSubscriptions} 条）`,
    );
  }
  return {
    singleCompanyOnly,
    stopFirstSatisfied,
    allowed: refusals.length === 0,
    refusal: refusals.length > 0 ? refusals.join("；") : null,
    measured: { tenantsPerTable, heldJobLeases, activeEventSubscriptions },
  };
}

// ---------------------------------------------------------------------------
// 演练驱动器（AC2：耗时、数据量、问题）
// ---------------------------------------------------------------------------

export interface DrillStepRecord {
  readonly stepId: RollbackProcedureStep["id"];
  readonly durationMs: number;
  readonly pass: boolean;
  /** 逐步数据量（行数/摘要数/租户数——审计面如实记录）。 */
  readonly measured: Record<string, number | string | boolean>;
}

export interface DrillRecord {
  readonly executedAt: string;
  readonly databaseName: string;
  readonly steps: readonly DrillStepRecord[];
  /** 演练发现的问题（AC4：在本票内修正并重验后清零）。 */
  readonly problems: readonly string[];
  readonly overallPass: boolean;
}

interface TableDigest {
  readonly table: string;
  readonly rows: number;
  readonly digest: string;
}

/** 逐表内容摘要（稳定投影：全表 md5 拼接的 md5；确定性，同一数据两次一致）。 */
async function digestTable(
  database: Database,
  table: string,
  schema = "public",
): Promise<TableDigest | null> {
  const rows = (await database
    .execute(
      sql.raw(
        `select count(*)::int as rows, ` +
          `coalesce(md5(string_agg(md5(t::text), '' order by md5(t::text))), md5('')) as digest ` +
          `from "${schema}"."${table}" t`,
      ),
    )
    .catch((error) => {
      if (isMissingRelationError(error)) return [];
      throw error;
    })) as unknown as { rows: number; digest: string }[];
  if (rows.length === 0) return null;
  return {
    table,
    rows: Number(rows[0]?.rows ?? 0),
    digest: String(rows[0]?.digest ?? ""),
  };
}

/**
 * 执行一次完整演练（AC2）：五步逐步计时 + 逐步数据量；恢复半边把逐表
 * 摘要在影子模式真实物化后对照（数据搬运，不是纸面对照）。零业务写入
 * （影子模式是演练自有对象，结束即清）；发现的问题如实入 problems。
 */
export async function runRollbackDrill(
  database: Database,
): Promise<DrillRecord> {
  const steps: DrillStepRecord[] = [];
  const problems: string[] = [];
  const started = (id: RollbackProcedureStep["id"]) => ({
    id,
    at: performance.now(),
  });

  // ---- 步骤 1：冻结写入（判定 = 停止前置半边）----
  {
    const mark = started("freeze-writes");
    const gate = await evaluateRollbackGate(database);
    steps.push({
      stepId: "freeze-writes",
      durationMs: Math.round(performance.now() - mark.at),
      pass: gate.stopFirstSatisfied,
      measured: {
        heldJobLeases: gate.measured.heldJobLeases,
        activeEventSubscriptions: gate.measured.activeEventSubscriptions,
      },
    });
    if (!gate.stopFirstSatisfied) {
      problems.push(
        `freeze-writes: 停止前置未满足（lease ${gate.measured.heldJobLeases}/订阅 ${gate.measured.activeEventSubscriptions}）——生产演练需先停业务入口与任务执行`,
      );
    }
  }

  // ---- 步骤 2：备份（逐表行数 + 内容摘要）----
  const backup: TableDigest[] = [];
  {
    const mark = started("backup");
    const present: string[] = [];
    for (const table of TENANT_DOMAIN_TABLES) {
      const digest = await digestTable(database, table);
      if (digest) {
        backup.push(digest);
        present.push(table);
      }
    }
    steps.push({
      stepId: "backup",
      durationMs: Math.round(performance.now() - mark.at),
      pass: backup.length > 0,
      measured: {
        tablesPresent: present.length,
        totalRows: backup.reduce((sum, entry) => sum + entry.rows, 0),
        missingTables: TENANT_DOMAIN_TABLES.length - present.length,
      },
    });
  }

  // ---- 步骤 3：恢复（影子模式物化 + 摘要对照）----
  {
    const mark = started("restore");
    const shadowSchema = "mt121_drill_restore";
    await database.execute(
      sql`drop schema if exists ${sql.raw(shadowSchema)} cascade`,
    );
    await database.execute(sql`create schema ${sql.raw(shadowSchema)}`);
    let mismatched = 0;
    try {
      for (const entry of backup) {
        await database.execute(
          sql.raw(
            `create table "${shadowSchema}"."${entry.table}" as table public."${entry.table}"`,
          ),
        );
        const shadowDigest = await digestTable(
          database,
          entry.table,
          shadowSchema,
        );
        const shadow = shadowDigest;
        if (
          shadow === null ||
          shadow.rows !== entry.rows ||
          shadow.digest !== entry.digest
        ) {
          mismatched += 1;
          problems.push(`restore: 表 ${entry.table} 影子摘要与备份不一致`);
        }
      }
    } finally {
      await database.execute(
        sql`drop schema if exists ${sql.raw(shadowSchema)} cascade`,
      );
    }
    steps.push({
      stepId: "restore",
      durationMs: Math.round(performance.now() - mark.at),
      pass: mismatched === 0 && backup.length > 0,
      measured: { tablesRestored: backup.length, mismatchedTables: mismatched },
    });
  }

  // ---- 步骤 4：失败隔离（逐租户行枚举 + 零 NULL 归属）----
  {
    const mark = started("failure-isolation");
    let tenants = 0;
    let orphanRows = 0;
    let enumerableTables = 0;
    for (const table of ATTRIBUTABLE_TABLES) {
      const perTenant = (await database
        .execute(
          sql.raw(
            `select tenant_id::text as tenant_id, count(*)::int as rows from public."${table}" group by tenant_id`,
          ),
        )
        .catch((error) => {
          if (isMissingRelationError(error)) return [];
          throw error;
        })) as unknown as { tenant_id: string; rows: number }[];
      if (perTenant.length === 0) continue;
      enumerableTables += 1;
      tenants = Math.max(tenants, perTenant.length);
      const nullTenant = perTenant.find((row) => !row.tenant_id);
      if (nullTenant) orphanRows += Number(nullTenant.rows);
    }
    steps.push({
      stepId: "failure-isolation",
      durationMs: Math.round(performance.now() - mark.at),
      pass: orphanRows === 0,
      measured: {
        attributableTables: enumerableTables,
        maxTenantsPerTable: tenants,
        orphanTenantRows: orphanRows,
      },
    });
    if (orphanRows > 0) {
      problems.push(
        `failure-isolation: ${orphanRows} 行归属列为 NULL——失败隔离边界不完整`,
      );
    }
  }

  // ---- 步骤 5：回退门（AC3 两条硬判定）----
  {
    const mark = started("rollback-gate");
    const gate = await evaluateRollbackGate(database);
    steps.push({
      stepId: "rollback-gate",
      durationMs: Math.round(performance.now() - mark.at),
      pass: true,
      measured: {
        allowed: gate.allowed,
        singleCompanyOnly: gate.singleCompanyOnly,
        maxTenants: Math.max(
          0,
          ...gate.measured.tenantsPerTable.map((row) => row.tenants),
        ),
        refusal: gate.refusal ?? "",
      },
    });
  }

  const nameRows = (await database.execute(
    sql`select current_database() as name`,
  )) as unknown as { name: string }[];
  return {
    executedAt: new Date().toISOString(),
    databaseName: String(nameRows[0]?.name ?? ""),
    steps,
    problems,
    overallPass:
      problems.length === 0 &&
      steps.slice(0, 4).every((step) => step.pass) === true,
  };
}
