// server/scripts/multitenancy/migrate-test.ts
// MT003（Issue #46）：按任务生成迁移的安全迁移工具（dry-run/apply + manifest）。
//
// 这是多租户整改的「按任务迁移」执行工具，仅供测试数据库使用：
//
//   - 命令面收敛为两个：`generate`（把任务迁移物化为带编号的 SQL 文件与
//     manifest）和 `migrate`（默认 dry-run 展示计划；`--apply --manifest`
//     才执行）。未知命令、未知 task id、未知旗标一律在参数阶段拒绝。
//   - task id 来自本文件内的显式枚举注册表（TASKS）。本 Ticket 只交付
//     工具与自检任务 MT000，不编写任何业务迁移；后续 Ticket 在注册表
//     中追加自己的任务条目。
//   - 数据库配置只读 TEST_DATABASE_URL：缺失、非回环主机、非
//     openbot_enterprise_* 命名、非法协议/URL 一律带理由拒绝，绝不回退
//     DATABASE_URL、不加载 .env、没有隐式默认。拒绝发生在任何连接/文件
//     副作用之前。URL 解析复用 server/scripts/runtime-test-environment.ts
//     的 seam（只读 TEST_DATABASE_URL），命名/回环校验遵循
//     server/tests/support/enterprise-database.ts 的模式。
//   - 编号规则：每个任务的步骤编号从 0001 起严格递增且连续；文件名固定
//     为 `NNNN_<taskid小写>_<slug>.sql`（不含时间戳，确定性）。计划、
//     测试库 journal、已生成文件三处都会检测重复编号与断号。
//   - apply 门禁：`--apply` 必须携带 manifest 文件，且其 taskId、步骤
//     名、编号与语句 digest 与当前计划完全一致，否则拒绝。每个步骤在
//     自己的事务内执行并写 journal（mt_task_migration_journal，
//     工具自有表），中断可安全重放。
//
// 用法（显式环境，建议 --no-env-file 避免 Bun 自动读取 .env）：
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55433/openbot_enterprise_mt003_test \
//     bun --no-env-file server/scripts/multitenancy/migrate-test.ts migrate MT000
//   ... migrate-test.ts migrate MT000 --apply --manifest <manifest.json>
//   ... migrate-test.ts generate MT000 --out <dir>
//

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { runtimeTestEnvironment } from "../runtime-test-environment";

// ---------------------------------------------------------------------------
// 任务注册表（显式枚举；本 Ticket 不编写业务迁移）
// ---------------------------------------------------------------------------

export interface TaskMigrationStep {
  /** 固定 slug，参与确定性文件名 NNNN_<taskid>_<slug>.sql；同任务内唯一。 */
  readonly slug: string;
  /** 人类可读的影响说明，dry-run 摘要逐条展示。 */
  readonly impact: string;
  /** 本步骤涉及的数据库对象（表/模式名），仅用于影响摘要。 */
  readonly objects: readonly string[];
  /** 逐条执行的 SQL 语句；顺序即执行顺序。 */
  readonly statements: readonly string[];
}

export interface TaskMigrationSpec {
  readonly id: string;
  readonly description: string;
  readonly steps: readonly TaskMigrationStep[];
}

/**
 * 工具自检任务：只用工具自己的临时表证明 generate/编号/dry-run/manifest/
 * apply/重放链路可用。它不是业务迁移，结束后不残留业务外对象
 * （只剩 journal 表）。真实 apply 测试只允许打到本任务专属测试库。
 */
const SELF_CHECK_TASK: TaskMigrationSpec = {
  id: "MT000",
  description:
    "迁移工具自检（非业务迁移）：创建/校验/删除工具自有临时表，证明链路可用。",
  steps: [
    {
      slug: "selfcheck_table",
      impact:
        "创建工具自检临时表 mt_tool_selfcheck 并写入一行标记（工具自有，非业务表）。",
      objects: ["mt_tool_selfcheck"],
      statements: [
        "CREATE TABLE mt_tool_selfcheck (id integer PRIMARY KEY, note text NOT NULL);",
        "INSERT INTO mt_tool_selfcheck (id, note) VALUES (1, 'multitenancy migrate-test self-check');",
      ],
    },
    {
      slug: "selfcheck_assert",
      impact: "DO 块校验自检行存在，证明步骤顺序与事务边界真实生效。",
      objects: ["mt_tool_selfcheck"],
      statements: [
        "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM mt_tool_selfcheck) THEN RAISE EXCEPTION 'mt_tool_selfcheck row missing: step ordering broken'; END IF; END $$;",
      ],
    },
    {
      slug: "selfcheck_drop",
      impact: "删除自检临时表；任务结束时测试库不残留业务外对象。",
      objects: ["mt_tool_selfcheck"],
      statements: ["DROP TABLE mt_tool_selfcheck;"],
    },
  ],
};

/**
 * MT004（Issue #47）：企业团队成员关系表。expand-only——纯新增
 * enterprise_workspace_memberships（唯一 (tenant, workspace, principal)、
 * 复合外键同时证明 workspace 属 tenant 与 principal 是该 tenant 成员、
 * active/suspended 状态、正整数 epoch）与按既有模式的最小 RLS 策略；
 * 不修改任何既有表/策略/角色授权。
 */
const WORKSPACE_MEMBERSHIP_TASK: TaskMigrationSpec = {
  id: "MT004",
  description:
    "MT004（Issue #47）：新增企业团队成员关系表 enterprise_workspace_memberships（expand-only，仅新增表与最小 RLS，不改既有对象）。",
  steps: [
    {
      slug: "create_table",
      impact:
        "新增 enterprise_workspace_memberships 表：复合主键 (tenant_id, workspace_id, principal_id) 即唯一成员关系；principal 侧唯一索引；status/epoch CHECK；两条复合外键分别指向 enterprise_workspaces 与 enterprise_memberships（同时证明 workspace 属该公司、principal 是该公司成员）。不修改任何既有表。",
      objects: ["enterprise_workspace_memberships"],
      statements: [
        'CREATE TABLE "enterprise_workspace_memberships" (\n' +
          '\t"tenant_id" text NOT NULL,\n' +
          '\t"workspace_id" text NOT NULL,\n' +
          '\t"principal_id" text NOT NULL,\n' +
          "\t\"status\" text DEFAULT 'active' NOT NULL,\n" +
          '\t"epoch" integer DEFAULT 1 NOT NULL,\n' +
          '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,\n' +
          '\tCONSTRAINT "enterprise_workspace_memberships_tenant_id_workspace_id_principal_id_pk" PRIMARY KEY("tenant_id","workspace_id","principal_id"),\n' +
          '\tCONSTRAINT "enterprise_workspace_member_status" CHECK ("enterprise_workspace_memberships"."status" in (\'active\',\'suspended\')),\n' +
          '\tCONSTRAINT "enterprise_workspace_member_epoch" CHECK ("enterprise_workspace_memberships"."epoch" > 0)\n' +
          ");",
        'ALTER TABLE "enterprise_workspace_memberships" ADD CONSTRAINT "enterprise_workspace_memberships_tenant_id_workspace_id_enterprise_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."enterprise_workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;',
        'ALTER TABLE "enterprise_workspace_memberships" ADD CONSTRAINT "enterprise_workspace_memberships_tenant_id_principal_id_enterprise_memberships_tenant_id_principal_id_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."enterprise_memberships"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;',
        'CREATE UNIQUE INDEX "enterprise_workspace_membership_principal_tenant" ON "enterprise_workspace_memberships" USING btree ("principal_id","tenant_id","workspace_id");',
      ],
    },
    {
      slug: "rls_policies",
      impact:
        "仅对新表：REVOKE PUBLIC、启用 RLS、按既有模式新增 5 条最小策略（directory self-read / data read / operator read+insert+update）及配套最小 GRANT（SELECT、operator INSERT、operator UPDATE(status, epoch)）；不改动任何既有表策略或既有授权。",
      objects: ["enterprise_workspace_memberships"],
      statements: [
        'REVOKE ALL PRIVILEGES ON TABLE "enterprise_workspace_memberships" FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;',
        'ALTER TABLE "enterprise_workspace_memberships" ENABLE ROW LEVEL SECURITY;',
        'CREATE POLICY "enterprise_workspace_membership_self_read" ON "enterprise_workspace_memberships"\n' +
          "  FOR SELECT TO ob_ent_directory\n" +
          "  USING (EXISTS (\n" +
          '    SELECT 1 FROM "enterprise_principals" p\n' +
          '    WHERE p."id" = "enterprise_workspace_memberships"."principal_id"\n' +
          "      AND p.\"user_id\" = nullif(current_setting('app.user_id', true), '')\n" +
          "  ));",
        'CREATE POLICY "enterprise_workspace_membership_data_read" ON "enterprise_workspace_memberships"\n' +
          "  FOR SELECT TO ob_ent_data\n" +
          "  USING (\"enterprise_workspace_memberships\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "    AND \"enterprise_workspace_memberships\".\"principal_id\" = nullif(current_setting('app.principal_id', true), ''));",
        'CREATE POLICY "enterprise_workspace_membership_operator_read" ON "enterprise_workspace_memberships"\n' +
          "  FOR SELECT TO ob_ent_operator\n" +
          "  USING (\"enterprise_workspace_memberships\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_workspace_membership_operator_insert" ON "enterprise_workspace_memberships"\n' +
          "  FOR INSERT TO ob_ent_operator\n" +
          "  WITH CHECK (\"enterprise_workspace_memberships\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), ''));",
        'CREATE POLICY "enterprise_workspace_membership_operator_update" ON "enterprise_workspace_memberships"\n' +
          "  FOR UPDATE TO ob_ent_operator\n" +
          "  USING (\"enterprise_workspace_memberships\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "    AND \"enterprise_workspace_memberships\".\"principal_id\" = nullif(current_setting('app.operator_principal_id', true), ''))\n" +
          "  WITH CHECK (\"enterprise_workspace_memberships\".\"tenant_id\" = nullif(current_setting('app.tenant_id', true), '')\n" +
          "    AND \"enterprise_workspace_memberships\".\"principal_id\" = nullif(current_setting('app.operator_principal_id', true), ''));",
        'GRANT SELECT ON TABLE "enterprise_workspace_memberships" TO ob_ent_directory, ob_ent_data, ob_ent_operator;',
        'GRANT INSERT ON TABLE "enterprise_workspace_memberships" TO ob_ent_operator;',
        'GRANT UPDATE ("status", "epoch") ON TABLE "enterprise_workspace_memberships" TO ob_ent_operator;',
      ],
    },
  ],
};

/** 显式枚举的任务 allowlist；未列出的 task id 一律拒绝。 */
export const TASKS: ReadonlyMap<string, TaskMigrationSpec> = new Map([
  [SELF_CHECK_TASK.id, SELF_CHECK_TASK],
  [WORKSPACE_MEMBERSHIP_TASK.id, WORKSPACE_MEMBERSHIP_TASK],
]);

export const ALLOWED_TASK_IDS: readonly string[] = [...TASKS.keys()].sort();

// ---------------------------------------------------------------------------
// 计划：确定性文件名、编号与 digest
// ---------------------------------------------------------------------------

export const MANIFEST_SCHEMA_VERSION = 1;
const TOOL_NAME = "multitenancy-migrate-test";

export interface PlannedStep {
  /** 1 起严格递增的任务内编号。 */
  readonly number: number;
  /** 确定性文件名：NNNN_<taskid小写>_<slug>.sql。 */
  readonly name: string;
  readonly slug: string;
  readonly impact: string;
  readonly objects: readonly string[];
  readonly statements: readonly string[];
  /** 语句数组的 SHA-256（十六进制），manifest 逐步骤核对。 */
  readonly statementDigest: string;
}

export interface MigrationPlan {
  readonly taskId: string;
  readonly description: string;
  readonly steps: readonly PlannedStep[];
  /** 全部步骤（编号/名称/语句 digest）的 SHA-256，apply 门禁核对。 */
  readonly planDigest: string;
}

export interface MigrationManifestStep {
  readonly number: number;
  readonly name: string;
  readonly statementDigest: string;
  readonly statementCount: number;
}

export interface MigrationManifest {
  readonly schemaVersion: number;
  readonly tool: string;
  readonly taskId: string;
  readonly planDigest: string;
  readonly steps: readonly MigrationManifestStep[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function stepFileName(
  taskId: string,
  number: number,
  slug: string,
): string {
  return `${String(number).padStart(4, "0")}_${taskId.toLowerCase()}_${slug}.sql`;
}

export function buildPlan(taskId: string): MigrationPlan {
  const spec = TASKS.get(taskId);
  if (!spec) {
    throw new Error(
      `unknown task id "${taskId}"; allowed task ids: ${ALLOWED_TASK_IDS.join(", ")}`,
    );
  }
  const steps: PlannedStep[] = spec.steps.map((step, index) => ({
    number: index + 1,
    name: stepFileName(taskId, index + 1, step.slug),
    slug: step.slug,
    impact: step.impact,
    objects: step.objects,
    statements: step.statements,
    statementDigest: sha256(JSON.stringify(step.statements)),
  }));
  const planDigest = sha256(
    JSON.stringify({
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      tool: TOOL_NAME,
      taskId,
      steps: steps.map((step) => ({
        number: step.number,
        name: step.name,
        statementDigest: step.statementDigest,
      })),
    }),
  );
  return { taskId, description: spec.description, steps, planDigest };
}

export function manifestFor(plan: MigrationPlan): MigrationManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    tool: TOOL_NAME,
    taskId: plan.taskId,
    planDigest: plan.planDigest,
    steps: plan.steps.map((step) => ({
      number: step.number,
      name: step.name,
      statementDigest: step.statementDigest,
      statementCount: step.statements.length,
    })),
  };
}

// ---------------------------------------------------------------------------
// 编号校验：计划、journal、已生成文件共用同一套规则
// ---------------------------------------------------------------------------

export type NumberingVerdict = { ok: true } | { ok: false; reason: string };

/**
 * 计划内编号必须从 1 起严格递增、连续且文件名唯一：重复编号、断号、
 * 名称重复都是注册表编写错误，必须在任何执行前拒绝。
 */
export function validatePlanNumbering(
  steps: ReadonlyArray<{ number: number; name: string }>,
): NumberingVerdict {
  if (steps.length === 0) {
    return { ok: false, reason: "migration plan has no steps" };
  }
  const seenNames = new Set<string>();
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step.number !== index + 1) {
      return {
        ok: false,
        reason:
          step.number <= index
            ? `duplicate or non-increasing migration number ${step.number} at position ${index + 1}`
            : `migration number gap: expected ${index + 1}, found ${step.number}`,
      };
    }
    if (seenNames.has(step.name)) {
      return { ok: false, reason: `duplicate migration name "${step.name}"` };
    }
    seenNames.add(step.name);
  }
  return { ok: true };
}

export type JournalVerdict =
  | { ok: true; appliedCount: number }
  | { ok: false; reason: string };

/**
 * journal 中已应用的编号必须是计划 (1..totalSteps) 的连续前缀：
 * 重复、断号、超出计划长度（计划/journal 漂移）都拒绝执行。
 */
export function validateJournalNumbers(
  appliedNumbers: readonly number[],
  totalSteps: number,
): JournalVerdict {
  const sorted = [...appliedNumbers].sort((left, right) => left - right);
  for (let index = 0; index < sorted.length; index += 1) {
    const number = sorted[index];
    if (number !== index + 1) {
      return {
        ok: false,
        reason:
          number <= index
            ? `journal has duplicate migration number ${number}`
            : `journal migration numbers have a gap: expected ${index + 1}, found ${number}`,
      };
    }
  }
  if (sorted.length > totalSteps) {
    return {
      ok: false,
      reason: `journal records ${sorted.length} applied steps but the plan only has ${totalSteps}; the plan and journal have drifted apart`,
    };
  }
  return { ok: true, appliedCount: sorted.length };
}

export interface JournalEntry {
  readonly number: number;
  readonly statementDigest: string;
}

export type JournalPlanVerdict =
  | { ok: true; appliedCount: number }
  | { ok: false; reason: string };

/**
 * journal 已应用步骤必须与当前计划逐步骤一致：编号是计划前缀（沿用
 * validateJournalNumbers），且每个已记录的 statement_digest 与当前计划
 * 完全一致。任何漂移都拒绝并要求人工审查；工具绝不改写或重放已入账
 * 步骤（不自动修复）。
 */
export function validateJournalAgainstPlan(
  entries: readonly JournalEntry[],
  plan: MigrationPlan,
): JournalPlanVerdict {
  const numbering = validateJournalNumbers(
    entries.map((entry) => entry.number),
    plan.steps.length,
  );
  if (!numbering.ok) {
    return numbering;
  }
  for (const entry of entries) {
    const step = plan.steps[entry.number - 1];
    if (entry.statementDigest !== step.statementDigest) {
      return {
        ok: false,
        reason:
          `journal records ${step.name} with statement digest ${entry.statementDigest.slice(0, 12)}… ` +
          `but the current plan digest is ${step.statementDigest.slice(0, 12)}…; ` +
          "the journal and the current plan have drifted apart — manual review is required; " +
          "the tool never rewrites or replays already-journaled steps",
      };
    }
  }
  return numbering;
}

// ---------------------------------------------------------------------------
// 数据库配置：只读 TEST_DATABASE_URL，生产/缺失/非法一律拒绝
// ---------------------------------------------------------------------------

export interface DatabaseTarget {
  readonly url: string;
  readonly databaseName: string;
  readonly endpoint: string;
}

export type ResolvedDatabase =
  | { ok: true; target: DatabaseTarget }
  | { ok: false; reason: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * 只接受显式的测试库配置：仅读取 TEST_DATABASE_URL（复用
 * runtime-test-environment 的解析 seam），再叠加回环主机与
 * openbot_enterprise_* 命名约束。绝不读取 DATABASE_URL、绝不加载 .env、
 * 绝无隐式回退。任何拒绝都发生在连接之前。
 */
export function resolveTestDatabaseTarget(
  environment: Record<string, string | undefined>,
): ResolvedDatabase {
  const raw = environment.TEST_DATABASE_URL?.trim();
  if (!raw) {
    return {
      ok: false,
      reason:
        "TEST_DATABASE_URL is required and must name the dedicated test database; " +
        "this tool never falls back to DATABASE_URL and never loads .env",
    };
  }
  let databaseUrl: string;
  let databaseName: string;
  try {
    ({ databaseUrl, databaseName } = runtimeTestEnvironment(environment));
  } catch (error) {
    return {
      ok: false,
      reason: `TEST_DATABASE_URL: ${(error as Error).message}`,
    };
  }
  const url = new URL(databaseUrl);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    return {
      ok: false,
      reason:
        `TEST_DATABASE_URL must point at a loopback test database; host "${url.hostname}" ` +
        "looks like a production or remote target and is refused",
    };
  }
  if (url.hash) {
    return {
      ok: false,
      reason: "TEST_DATABASE_URL must not include a URL fragment",
    };
  }
  if (databaseName.includes("/")) {
    return {
      ok: false,
      reason:
        "TEST_DATABASE_URL must name the database as a single path segment",
    };
  }
  if (!/^openbot_enterprise_/.test(databaseName)) {
    return {
      ok: false,
      reason:
        `TEST_DATABASE_URL must name an openbot_enterprise_* test database, got "${databaseName}"; ` +
        "application or production databases are never migration-tool targets",
    };
  }
  return {
    ok: true,
    target: {
      url: raw,
      databaseName,
      endpoint: `${url.hostname}:${url.port || "5432"}`,
    },
  };
}

// ---------------------------------------------------------------------------
// 参数面：generate/migrate 之外的命令、旗标与未知 task id 一律拒绝
// ---------------------------------------------------------------------------

export type MigrationCommand = "generate" | "migrate";

export interface ParsedArgs {
  readonly command: MigrationCommand;
  readonly taskId: string;
  readonly outDir?: string;
  readonly apply: boolean;
  readonly manifestPath?: string;
}

const USAGE =
  "usage: migrate-test.ts <generate|migrate> <taskId> " +
  "[--out DIR (generate)] | [--apply --manifest FILE (migrate)]";

export function parseArgs(
  argv: readonly string[],
): { ok: true; args: ParsedArgs } | { ok: false; reason: string } {
  const positional: string[] = [];
  let outDir: string | undefined;
  let apply = false;
  let manifestPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--out") {
      outDir = argv[index + 1];
      index += 1;
      if (!outDir || outDir.startsWith("--")) {
        return {
          ok: false,
          reason: `--out requires a directory path\n${USAGE}`,
        };
      }
    } else if (token === "--manifest") {
      manifestPath = argv[index + 1];
      index += 1;
      if (!manifestPath || manifestPath.startsWith("--")) {
        return {
          ok: false,
          reason: `--manifest requires a file path\n${USAGE}`,
        };
      }
    } else if (token === "--apply") {
      apply = true;
    } else if (token.startsWith("--")) {
      return {
        ok: false,
        reason: `unknown flag "${token}"\n${USAGE}`,
      };
    } else {
      positional.push(token);
    }
  }
  if (positional.length < 2) {
    return {
      ok: false,
      reason: `a command and a task id are required\n${USAGE}`,
    };
  }
  if (positional.length > 2) {
    return {
      ok: false,
      reason: `unexpected extra argument "${positional[2]}"\n${USAGE}`,
    };
  }
  const [command, taskId] = positional;
  if (command !== "generate" && command !== "migrate") {
    return {
      ok: false,
      reason: `unknown command "${command}"; only generate and migrate are accepted\n${USAGE}`,
    };
  }
  if (!TASKS.has(taskId)) {
    return {
      ok: false,
      reason: `unknown task id "${taskId}"; allowed task ids: ${ALLOWED_TASK_IDS.join(", ")}`,
    };
  }
  if (command === "generate") {
    if (apply || manifestPath) {
      return {
        ok: false,
        reason: `generate does not accept --apply or --manifest (those gate migrate)\n${USAGE}`,
      };
    }
    return { ok: true, args: { command, taskId, outDir, apply: false } };
  }
  if (outDir) {
    return {
      ok: false,
      reason: `migrate does not accept --out (that is a generate flag)\n${USAGE}`,
    };
  }
  if (apply && !manifestPath) {
    return {
      ok: false,
      reason:
        "--apply requires an explicit --manifest FILE that matches the current plan; " +
        "without --apply the command stays a dry-run",
    };
  }
  if (manifestPath && !apply) {
    return {
      ok: false,
      reason:
        "--manifest requires --apply; without --apply the command stays a dry-run " +
        "and a provided manifest would be silently ignored, so it is refused instead",
    };
  }
  return { ok: true, args: { command, taskId, apply, manifestPath } };
}

// ---------------------------------------------------------------------------
// 运行入口与结果
// ---------------------------------------------------------------------------

export type RefusalStage =
  | "args"
  | "database-config"
  | "numbering"
  | "manifest"
  | "journal"
  | "execution";

export type RunOutcome =
  | { kind: "refused"; stage: RefusalStage; reason: string }
  | {
      kind: "generated";
      taskId: string;
      outDir: string | null;
      written: readonly string[];
      verified: readonly string[];
      manifest: MigrationManifest;
    }
  | {
      kind: "dry-run";
      taskId: string;
      databaseName: string;
      endpoint: string;
      appliedCount: number;
      pending: readonly PlannedStep[];
      manifest: MigrationManifest;
    }
  | {
      kind: "applied";
      taskId: string;
      databaseName: string;
      endpoint: string;
      appliedSteps: readonly PlannedStep[];
    }
  | {
      kind: "up-to-date";
      taskId: string;
      databaseName: string;
      endpoint: string;
      appliedCount: number;
    };

export interface MigrationSql {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
  begin<T>(work: (tx: MigrationSql) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export interface ToolFileSystem {
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface MigrateTestDeps {
  readonly environment?: Record<string, string | undefined>;
  readonly connect?: (url: string) => MigrationSql;
  readonly fs?: ToolFileSystem;
  readonly out?: (line: string) => void;
}

const defaultFileSystem: ToolFileSystem = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  readdir: (path) => readdir(path),
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, content) => writeFile(path, content, "utf8"),
};

const defaultConnect = (url: string): MigrationSql =>
  postgres(url, { max: 1, onnotice: () => {} }) as unknown as MigrationSql;

/**
 * 工具入口：所有拒绝都发生在任何 connect / 文件写副作用之前。
 * 参数与环境校验先行，随后才进入命令分发。
 */
export async function runMigrateTest(
  argv: readonly string[],
  deps: MigrateTestDeps = {},
): Promise<RunOutcome> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    return { kind: "refused", stage: "args", reason: parsed.reason };
  }
  const args = parsed.args;
  const resolved = resolveTestDatabaseTarget(deps.environment ?? process.env);
  if (!resolved.ok) {
    return {
      kind: "refused",
      stage: "database-config",
      reason: resolved.reason,
    };
  }
  const target = resolved.target;
  const plan = buildPlan(args.taskId);
  const numbering = validatePlanNumbering(plan.steps);
  if (!numbering.ok) {
    return { kind: "refused", stage: "numbering", reason: numbering.reason };
  }
  if (args.command === "generate") {
    return runGenerate(args, plan, target, deps);
  }
  return runMigrate(args, plan, target, deps);
}

// ---------------------------------------------------------------------------
// 人类可读输出（语句与影响摘要）
// ---------------------------------------------------------------------------

export function renderOutcome(outcome: RunOutcome): string[] {
  if (outcome.kind === "refused") {
    return [`refused (${outcome.stage}): ${outcome.reason}`];
  }
  if (outcome.kind === "generated") {
    const lines = [
      `generated: ${outcome.taskId} → ${outcome.outDir ?? "(stdout)"}`,
    ];
    if (outcome.outDir) {
      for (const file of outcome.written) lines.push(`  wrote ${file}`);
      for (const file of outcome.verified) lines.push(`  verified ${file}`);
    } else {
      for (const file of outcome.verified) lines.push(`  计划文件: ${file}`);
    }
    lines.push("manifest:", JSON.stringify(outcome.manifest));
    return lines;
  }
  if (outcome.kind === "dry-run") {
    const plan = buildPlan(outcome.taskId);
    const lines = [
      "multitenancy migrate-test — dry-run（默认；执行需 --apply --manifest <file>）",
      `task: ${outcome.taskId} — ${plan.description}`,
      `database: ${outcome.databaseName} @ ${outcome.endpoint}`,
      `journal: 已应用 ${outcome.appliedCount}/${plan.steps.length}；待应用 ${outcome.pending.length} 步`,
    ];
    let statements = 0;
    const objects = new Set<string>();
    for (const step of outcome.pending) {
      lines.push(`step ${step.name} — 影响: ${step.impact}`);
      for (const object of step.objects) objects.add(object);
      step.statements.forEach((statement, index) => {
        statements += 1;
        lines.push(`  语句 ${index + 1}: ${statement}`);
      });
    }
    lines.push(
      `summary: 待应用 ${outcome.pending.length} 步 / ${statements} 条语句 / 涉及对象: ${[...objects].join(", ") || "无"}`,
      "manifest:",
      JSON.stringify(outcome.manifest),
    );
    return lines;
  }
  if (outcome.kind === "applied") {
    return [
      `applied: ${outcome.taskId} @ ${outcome.databaseName} (${outcome.endpoint})`,
      `  已执行并记入 journal: ${outcome.appliedSteps
        .map((step) => step.name)
        .join(", ")}`,
    ];
  }
  return [
    `up-to-date: ${outcome.taskId} @ ${outcome.databaseName} (${outcome.endpoint})`,
    `  已应用 ${outcome.appliedCount} 步，无需执行`,
  ];
}

// ---------------------------------------------------------------------------
// journal（工具自有表）与执行
// ---------------------------------------------------------------------------

const JOURNAL_TABLE = "mt_task_migration_journal";

const JOURNAL_DDL = `CREATE TABLE IF NOT EXISTS ${JOURNAL_TABLE} (
  task_id text NOT NULL,
  number integer NOT NULL,
  name text NOT NULL,
  statement_digest text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, number)
)`;

/** journal 缺表 = 尚未应用过任何步骤；其它错误照常抛出。 */
async function readJournalEntries(
  connection: MigrationSql,
  taskId: string,
): Promise<JournalEntry[]> {
  let rows: Array<{ number: number; statement_digest: string }>;
  try {
    rows = (await connection.unsafe(
      `SELECT number, statement_digest FROM ${JOURNAL_TABLE} WHERE task_id = $1 ORDER BY number`,
      [taskId],
    )) as Array<{ number: number; statement_digest: string }>;
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") {
      return [];
    }
    throw error;
  }
  return rows.map((row) => ({
    number: Number(row.number),
    statementDigest: String(row.statement_digest),
  }));
}

/** journal 写入用字面量（值全部来自工具自身，不携带用户输入）。 */
function sqlLiteral(value: string | number): string {
  return typeof value === "number"
    ? String(value)
    : `'${value.replaceAll("'", "''")}'`;
}

// ---------------------------------------------------------------------------
// manifest 解析与门禁
// ---------------------------------------------------------------------------

export type ManifestVerdict =
  | { ok: true; manifest: MigrationManifest }
  | { ok: false; reason: string };

export function parseManifestText(text: string): ManifestVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "manifest file is not valid JSON" };
  }
  const candidate = parsed as Partial<MigrationManifest>;
  if (
    candidate.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    candidate.tool !== TOOL_NAME ||
    typeof candidate.taskId !== "string" ||
    typeof candidate.planDigest !== "string" ||
    !Array.isArray(candidate.steps) ||
    candidate.steps.some(
      (step) =>
        typeof step?.number !== "number" ||
        typeof step?.name !== "string" ||
        typeof step?.statementDigest !== "string" ||
        typeof step?.statementCount !== "number",
    )
  ) {
    return {
      ok: false,
      reason: `manifest does not match schema version ${MANIFEST_SCHEMA_VERSION} of ${TOOL_NAME}`,
    };
  }
  return { ok: true, manifest: candidate as MigrationManifest };
}

export function validateManifestAgainstPlan(
  manifest: MigrationManifest,
  plan: MigrationPlan,
): { ok: true } | { ok: false; reason: string } {
  if (manifest.taskId !== plan.taskId) {
    return {
      ok: false,
      reason: `manifest task id "${manifest.taskId}" does not match the requested task "${plan.taskId}"`,
    };
  }
  if (manifest.planDigest !== plan.planDigest) {
    return {
      ok: false,
      reason:
        `manifest plan digest ${manifest.planDigest.slice(0, 12)}… does not match ` +
        `the current plan ${plan.planDigest.slice(0, 12)}…; regenerate the manifest and review the change`,
    };
  }
  if (manifest.steps.length !== plan.steps.length) {
    return {
      ok: false,
      reason: `manifest lists ${manifest.steps.length} steps but the plan has ${plan.steps.length}`,
    };
  }
  for (let index = 0; index < plan.steps.length; index += 1) {
    const expected = plan.steps[index];
    const actual = manifest.steps[index];
    if (
      actual.number !== expected.number ||
      actual.name !== expected.name ||
      actual.statementDigest !== expected.statementDigest
    ) {
      return {
        ok: false,
        reason: `manifest step ${index + 1} does not match plan step ${expected.name}`,
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 命令分发
// ---------------------------------------------------------------------------

function defaultOut(line: string): void {
  console.log(line);
}

// generate：确定性文件物化（断号/重复/漂移在写入前拒绝）

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

function stepFileContent(step: PlannedStep): string {
  return `-- multitenancy migrate-test\n${step.statements.join(`\n${STATEMENT_BREAKPOINT}\n`)}\n`;
}

async function runGenerate(
  args: ParsedArgs,
  plan: MigrationPlan,
  target: DatabaseTarget,
  deps: MigrateTestDeps,
): Promise<RunOutcome> {
  void target; // 生成不连接数据库；target 仅证明配置已通过校验
  const fs = deps.fs ?? defaultFileSystem;
  const out = deps.out ?? defaultOut;
  const manifest = manifestFor(plan);

  if (!args.outDir) {
    const printed = {
      kind: "generated" as const,
      taskId: plan.taskId,
      outDir: null,
      written: [],
      verified: plan.steps.map((step) => step.name),
      manifest,
    };
    for (const line of renderOutcome(printed)) out(line);
    return printed;
  }

  const taskDir = join(args.outDir, plan.taskId);
  const taskFilePattern = new RegExp(
    `^(\\d{4})_${plan.taskId.toLowerCase()}_.*\\.sql$`,
  );
  let entries: string[] = [];
  try {
    entries = await fs.readdir(taskDir);
  } catch {
    entries = [];
  }
  const existing = entries
    .flatMap((name) => {
      const match = taskFilePattern.exec(name);
      return match ? [{ name, number: Number(match[1]) }] : [];
    })
    .sort((left, right) => left.number - right.number);

  const refuseNumbering = (reason: string): RunOutcome => ({
    kind: "refused",
    stage: "numbering",
    reason: `existing files in ${taskDir}: ${reason}`,
  });

  // 重复编号 / 断号 / 超出计划长度。
  for (let index = 0; index < existing.length; index += 1) {
    const file = existing[index];
    if (file.number !== index + 1) {
      return refuseNumbering(
        file.number <= index
          ? `duplicate migration number ${file.number}`
          : `migration number gap: expected ${String(index + 1).padStart(4, "0")}, found ${String(file.number).padStart(4, "0")}`,
      );
    }
  }
  if (existing.length > plan.steps.length) {
    return refuseNumbering(
      `found ${existing.length} numbered files but the plan only has ${plan.steps.length} steps; the directory and the plan have drifted apart`,
    );
  }

  // 已存在文件必须与计划逐字一致（名称与内容），否则拒绝且不改写。
  const verified: string[] = [];
  for (const file of existing) {
    const step = plan.steps[file.number - 1];
    if (file.name !== step.name) {
      return refuseNumbering(
        `file "${file.name}" does not match plan name "${step.name}" for number ${file.number}`,
      );
    }
    let content: string;
    try {
      content = await fs.readFile(join(taskDir, file.name));
    } catch (error) {
      return refuseNumbering(
        `file "${file.name}" could not be read: ${(error as Error).message}`,
      );
    }
    if (content !== stepFileContent(step)) {
      return refuseNumbering(
        `file "${file.name}" differs from the current plan; review the drift instead of overwriting it`,
      );
    }
    verified.push(file.name);
  }

  await fs.mkdir(taskDir);
  const written: string[] = [];
  for (const step of plan.steps) {
    if (verified.includes(step.name)) continue;
    const path = join(taskDir, step.name);
    await fs.writeFile(path, stepFileContent(step));
    written.push(path);
  }
  const manifestPath = join(taskDir, "manifest.json");
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  let currentManifest: string | undefined;
  try {
    currentManifest = await fs.readFile(manifestPath);
  } catch {
    currentManifest = undefined;
  }
  if (currentManifest !== manifestText) {
    await fs.writeFile(manifestPath, manifestText);
    written.push(manifestPath);
  }

  const outcome = {
    kind: "generated" as const,
    taskId: plan.taskId,
    outDir: taskDir,
    written,
    verified,
    manifest,
  };
  for (const line of renderOutcome(outcome)) out(line);
  return outcome;
}

async function runMigrate(
  args: ParsedArgs,
  plan: MigrationPlan,
  target: DatabaseTarget,
  deps: MigrateTestDeps,
): Promise<RunOutcome> {
  const fs = deps.fs ?? defaultFileSystem;
  const out = deps.out ?? defaultOut;
  const connect = deps.connect ?? defaultConnect;

  // apply 门禁在连接之前：manifest 缺失或不一致时绝无任何数据库副作用。
  if (args.apply && args.manifestPath) {
    let text: string;
    try {
      text = await fs.readFile(args.manifestPath);
    } catch (error) {
      return {
        kind: "refused",
        stage: "manifest",
        reason: `manifest file "${args.manifestPath}" could not be read: ${(error as Error).message}`,
      };
    }
    const parsed = parseManifestText(text);
    if (!parsed.ok) {
      return { kind: "refused", stage: "manifest", reason: parsed.reason };
    }
    const verified = validateManifestAgainstPlan(parsed.manifest, plan);
    if (!verified.ok) {
      return { kind: "refused", stage: "manifest", reason: verified.reason };
    }
  }

  const connection = connect(target.url);
  try {
    const journalEntries = await readJournalEntries(connection, plan.taskId);
    // 编号前缀与逐步骤 digest 都必须与当前计划一致；漂移在 apply 前拒绝，
    // 且不自动修复/重放（人工审查后才可能继续）。
    const journal = validateJournalAgainstPlan(journalEntries, plan);
    if (!journal.ok) {
      return { kind: "refused", stage: "journal", reason: journal.reason };
    }
    const pending = plan.steps.slice(journal.appliedCount);

    if (!args.apply) {
      const dryRun = {
        kind: "dry-run" as const,
        taskId: plan.taskId,
        databaseName: target.databaseName,
        endpoint: target.endpoint,
        appliedCount: journal.appliedCount,
        pending,
        manifest: manifestFor(plan),
      };
      for (const line of renderOutcome(dryRun)) out(line);
      return dryRun;
    }

    if (pending.length === 0) {
      const upToDate = {
        kind: "up-to-date" as const,
        taskId: plan.taskId,
        databaseName: target.databaseName,
        endpoint: target.endpoint,
        appliedCount: journal.appliedCount,
      };
      for (const line of renderOutcome(upToDate)) out(line);
      return upToDate;
    }

    await connection.unsafe(JOURNAL_DDL);
    for (const step of pending) {
      await connection.begin(async (tx) => {
        for (const statement of step.statements) {
          await tx.unsafe(statement);
        }
        await tx.unsafe(
          `INSERT INTO ${JOURNAL_TABLE} (task_id, number, name, statement_digest) ` +
            `VALUES (${sqlLiteral(plan.taskId)}, ${sqlLiteral(step.number)}, ` +
            `${sqlLiteral(step.name)}, ${sqlLiteral(step.statementDigest)})`,
        );
      });
    }
    const applied = {
      kind: "applied" as const,
      taskId: plan.taskId,
      databaseName: target.databaseName,
      endpoint: target.endpoint,
      appliedSteps: pending,
    };
    for (const line of renderOutcome(applied)) out(line);
    return applied;
  } catch (error) {
    return {
      kind: "refused",
      stage: "execution",
      reason: `execution failed: ${(error as Error).message}; already-committed steps stay journaled and a retry resumes from the next step`,
    };
  } finally {
    await connection.end();
  }
}

// ---------------------------------------------------------------------------
// CLI 入口（必须在文件末尾：top-level await 早于后面的 const 初始化会 TDZ）
// 拒绝时非零退出；建议 bun --no-env-file 运行，不读 .env。
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const outcome = await runMigrateTest(process.argv.slice(2), {
    out: () => {},
  });
  if (outcome.kind === "refused") {
    console.error(renderOutcome(outcome)[0]);
    process.exitCode = 1;
  } else {
    for (const line of renderOutcome(outcome)) console.log(line);
  }
}
