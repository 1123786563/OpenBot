/**
 * MT 任务链与 drizzle 基线的漂移调和（测试基建，仅测试库）。
 *
 * 根因（T00 基线 B-1）：`server/drizzle/0163_restore_drifted_tables.sql` 按 schema
 * 恢复了 38 张表 + 1 列（f64d4b91e 引入），其中一批与 MT 任务链的
 * `CREATE TABLE` / `ADD COLUMN` 重叠。任务链的步骤不是幂等 DDL —— 在
 * drizzle 全量迁移过的库上直接 apply 会撞 `already exists`；而在库上留下
 * 的 drizzle 版本又没有任务链的 RLS/FORCE/GRANT，等于假通过。空库则相反
 * （缺 `enterprise_tenants` 等基表，只能走完整 drizzle 迁移）。
 *
 * 调和规则：对给定任务链的**未记 journal** 步骤，凡其声明要创建的表/列/约束
 * 已存在，即认定是 0163 漂移残留（journal 有记录 = 任务链自己的产物，不动），
 * 先删除再让任务链按原文重建 —— 重建路径就是被验证的迁移 SQL 本身，RLS 与
 * GRANT 断言不变弱。已 journal 的步骤一律不触碰（不重放、不修复）。
 *
 * 约束：
 *   - 只处理本 helper 被显式传入的任务链；不扫描全库。
 *   - JOURNAL_TABLE 字面量必须与 server/scripts/multitenancy/migrate-test.ts
 *     的 JOURNAL_TABLE 保持一致（工具未导出该常量，这里是测试侧副本）。
 *   - drop 用 CASCADE 与 drop-0163.sql 配方一致（0163 恢复的表之间存在
 *     外键链）；列用默认 RESTRICT，若有依赖对象则响亮失败而非静默级联。
 */

import { buildPlan } from "../../../scripts/multitenancy/migrate-test";

const JOURNAL_TABLE = "mt_task_migration_journal";

/** 与 migrate-test 的 MigrationSql.unsafe 同形的最小客户端面。 */
export interface TaskDriftSqlClient {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
}

export interface TaskDriftReport {
  readonly droppedTables: readonly string[];
  readonly droppedColumns: readonly string[];
  readonly droppedConstraints: readonly string[];
  /** journal 已覆盖（视为任务链自有产物、未触碰）的任务 id。 */
  readonly journaledTasks: readonly string[];
}

interface OwnedObject {
  readonly taskId: string;
  readonly stepNumber: number;
  readonly kind: "table" | "column" | "constraint";
  readonly table: string;
  readonly column?: string;
  readonly constraint?: string;
}

const TABLE_DDL = /^create table (?:if not exists )?"([^"]+)"/i;
const COLUMN_DDL =
  /^alter table (?:only )?"([^"]+)"\s+add column (?:if not exists )?"([^"]+)"/i;
const CONSTRAINT_DDL =
  /^alter table (?:only )?"([^"]+)"\s+add constraint "([^"]+)"/i;

function ownedObjectsOf(
  taskId: string,
  pendingNumbers: ReadonlySet<number>,
): OwnedObject[] {
  const objects: OwnedObject[] = [];
  for (const step of buildPlan(taskId).steps) {
    if (pendingNumbers.has(step.number)) continue;
    for (const raw of step.statements) {
      const statement = raw.trim().replace(/\s+/g, " ");
      const table = TABLE_DDL.exec(statement);
      if (table) {
        objects.push({
          taskId,
          stepNumber: step.number,
          kind: "table",
          table: table[1],
        });
        continue;
      }
      const column = COLUMN_DDL.exec(statement);
      if (column) {
        objects.push({
          taskId,
          stepNumber: step.number,
          kind: "column",
          table: column[1],
          column: column[2],
        });
        continue;
      }
      const constraint = CONSTRAINT_DDL.exec(statement);
      if (constraint) {
        objects.push({
          taskId,
          stepNumber: step.number,
          kind: "constraint",
          table: constraint[1],
          constraint: constraint[2],
        });
      }
    }
  }
  return objects;
}

async function appliedStepNumbers(
  client: TaskDriftSqlClient,
  taskId: string,
): Promise<Set<number>> {
  try {
    const rows = (await client.unsafe(
      `select number from ${JOURNAL_TABLE} where task_id = $1`,
      [taskId],
    )) as Array<{ number: number | string }>;
    return new Set(rows.map((row) => Number(row.number)));
  } catch (error) {
    /*
     * Bun SQL reports the SQLSTATE in `errno` (`code` is the client-level
     * `ERR_POSTGRES_SERVER_ERROR`); postgres.js would put it in `code`. Both
     * shapes mean "journal not created yet" for 42P01.
     */
    const failure = error as {
      code?: string;
      errno?: string;
      sqlstate?: string;
    };
    const sqlState = failure.errno ?? failure.sqlstate ?? failure.code;
    if (sqlState === "42P01") return new Set();
    throw error;
  }
}

async function tableExists(
  client: TaskDriftSqlClient,
  table: string,
): Promise<boolean> {
  const rows = (await client.unsafe(
    `select 1 from information_schema.tables
     where table_schema = 'public' and table_name = $1`,
    [table],
  )) as unknown[];
  return rows.length > 0;
}

async function columnExists(
  client: TaskDriftSqlClient,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = (await client.unsafe(
    `select 1 from information_schema.columns
     where table_schema = 'public' and table_name = $1 and column_name = $2`,
    [table, column],
  )) as unknown[];
  return rows.length > 0;
}

async function constraintExists(
  client: TaskDriftSqlClient,
  table: string,
  constraint: string,
): Promise<boolean> {
  const rows = (await client.unsafe(
    `select 1 from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     where c.conname = $1 and t.relname = $2 and n.nspname = 'public'`,
    [constraint, table],
  )) as unknown[];
  return rows.length > 0;
}

/**
 * 读取 journal 状态，删除给定任务链的未 journal 步骤所声明、且当前已存在的
 * 表/列/约束（0163 漂移残留），返回删除清单。表先删（CASCADE，先到先得地
 * 带走其上的策略/索引/外键），再删列，最后删约束；对象已随表消失时各自的
 * 存在性检查天然跳过。
 */
export async function reconcileTaskDrift(
  client: TaskDriftSqlClient,
  taskIds: readonly string[],
): Promise<TaskDriftReport> {
  const droppedTables = new Set<string>();
  const droppedColumns = new Set<string>();
  const droppedConstraints = new Set<string>();
  const journaledTasks: string[] = [];

  const pending: OwnedObject[] = [];
  for (const taskId of taskIds) {
    const applied = await appliedStepNumbers(client, taskId);
    const plan = buildPlan(taskId);
    if (applied.size >= plan.steps.length) {
      journaledTasks.push(taskId);
      continue;
    }
    pending.push(...ownedObjectsOf(taskId, applied));
  }

  // 表优先：CASCADE 与 drop-0163 配方一致；同轮内不重复删同一张表。
  for (const object of pending.filter((entry) => entry.kind === "table")) {
    if (droppedTables.has(object.table)) continue;
    if (!(await tableExists(client, object.table))) continue;
    await client.unsafe(`drop table if exists "${object.table}" cascade`);
    droppedTables.add(object.table);
  }
  for (const object of pending.filter((entry) => entry.kind === "column")) {
    if (droppedTables.has(object.table)) continue; // 随表消失
    if (!(await columnExists(client, object.table, object.column ?? "")))
      continue;
    await client.unsafe(
      `alter table "${object.table}" drop column "${object.column}"`,
    );
    droppedColumns.add(`${object.table}.${object.column}`);
  }
  for (const object of pending.filter((entry) => entry.kind === "constraint")) {
    if (droppedTables.has(object.table)) continue;
    if (
      !(await constraintExists(client, object.table, object.constraint ?? ""))
    )
      continue;
    await client.unsafe(
      `alter table "${object.table}" drop constraint "${object.constraint}"`,
    );
    droppedConstraints.add(`${object.table}.${object.constraint}`);
  }

  return {
    droppedTables: [...droppedTables].sort(),
    droppedColumns: [...droppedColumns].sort(),
    droppedConstraints: [...droppedConstraints].sort(),
    journaledTasks,
  };
}
