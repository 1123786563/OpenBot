// server/tests/multitenancy/child-backfill-main-batch2.test.ts
// MT115（Issue #158）：主库子记录回填第二批——记忆与 OpenMuse 任务。
//
// 验收事实源（Issue #158 四条，逐条对应 describe；真实 PostgreSQL——
// MT112 锚点 + MT114 进度表 + MT039/MT060 归属面经真实 MT003 工具落地，
// MT113 根回填真实执行作为属主前提，第二批回填真实执行；绝不回退开发库、
// 缺 env 显式 skip）：
//   AC1 本批对象的子记录归属与父记录一致；不一致被检测并报告，不静默
//      覆盖（属主成员资格在他租户 → mismatch 报告零写入；零条/多条成员
//      资格 → 隔离清单；属主主体未落地 → owner-principal-missing；任务
//      归属被他租户认领 → claimed-by-another-tenant）。
//   AC2 复用第一批进度记录与幂等机制；中断后可续跑（分块进度持久化在
//      同一张 enterprise_backfill_batches，批次 id 各自独立；主动停 =
//      running 相位 + 游标；续跑完成零重复；重复全量 apply 增量 0）。
//   AC3 跨公司关联被数据库拒绝（约束 + 校验）：约束半边——复合外键
//      (tenant, workspace)/(tenant, principal)（23503）与 attribution
//      CHECK（23514）真实 INSERT 被库拒绝；校验半边 = 写前属主判定。
//   AC4 输出本批进度与计数校验报告，并标记主库回填完成状态
//      （childBackfillBatch2ProgressReport 计数守恒；mainBackfillCompletion
//      第一批缺失 → false，第一批补齐后 → true）。
//
// 前置诚实披露（票面七域中本批不回填的五个域）：Craft turn/消息/快照与
// Workshop 全域的前置 #96（MT053）/#100（MT057）未交付（无已交付归属面；
// sandbox_instances.tenant_id 是 MT057 预留面）；run/trigger 半边无已交付
// 回填路径（MT045 契约「create-once 永不迁移」；MT041 basis 纪律无法事后
// 伪造）；账务 = #117（MT074）幽灵交付 + 纯新表；策略纯新增（无旧默认
// 回退）；遥测 owner/workspace 是写入时命名缺席（never a guess）。

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import { createDatabase, type Database } from "../../src/db/client";
import { runChildBackfill } from "../../src/enterprise/tenancy/child-backfill";
import {
  CHILD_BACKFILL_BATCH2_ID,
  CHILD_BACKFILL_BATCH2_KINDS,
  childBackfillBatch2ProgressReport,
  mainBackfillCompletion,
  runChildBackfillBatch2,
} from "../../src/enterprise/tenancy/child-backfill-batch2";
import {
  type OperatorDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import { runRootBackfill } from "../../src/enterprise/tenancy/root-backfill";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const required = [
    "TEST_DATABASE_URL",
    "ENTERPRISE_TEST_SETUP_DATABASE_URL",
    "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `MT115 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    enterpriseRuntimeDatabaseUrlFrom("operator", process.env);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const ENV = probeEnvironment();
const itDb = ((name, fn) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

const ANCHOR_TENANT_ID = "ent-legacy-original";
const DEFAULT_WORKSPACE_ID = "ent-legacy-default-team";
const FOREIGN_TENANT = "mt115-foreign";
const FOREIGN_WORKSPACE = "mt115-foreign-ws";

let setup: Database;
let operator: OperatorDatabase;
const generatedDirs: string[] = [];

let runTag = "";
let anchorUser = "";
let ambiguousUser = "";
let foreignUser = "";
let multiUser = "";
let lateUser = "";
let memAnchor = "";
let memAnchorSourced = "";
let memAmbiguous = "";
let memForeign = "";
let memMulti = "";
let memNoPrincipal = "";
let taskAnchor = "";
let taskAmbiguous = "";
let taskForeign = "";
let memorySource = "";

async function ensureTaskApplied(
  taskId: string,
  /** 链式预建表（无 RLS/CHECK）：journal 无行时 DROP 重建为注册表权威形状。 */
  chainTable: string | null,
): Promise<void> {
  if (chainTable) {
    const journaled = (await setup
      .execute(
        sql`select count(*)::int as n from mt_task_migration_journal where task_id = ${taskId}`,
      )
      .catch(() => [{ n: 0 }] as unknown)) as unknown as { n: number }[];
    if (Number(journaled[0]?.n ?? 0) === 0) {
      // 共享库纪律：journal 已记账的库（如 mt20 先例）走 up-to-date 短路，
      // 绝不重推锚点映射；journal 空白的 fresh 库才 DROP 重建。
      await setup.execute(sql.raw(`drop table if exists ${chainTable}`));
      await setup.execute(
        sql`delete from mt_task_migration_journal where task_id = ${taskId}`,
      );
    }
  }
  await applyTask(taskId);
}

async function applyTask(taskId: string): Promise<void> {
  const dir = join("/tmp", `mt115-migration-${randomUUID().slice(0, 8)}`);
  generatedDirs.push(dir);
  const generation = await runMigrateTest(["generate", taskId, "--out", dir], {
    environment: process.env,
    out: () => {},
  });
  if (generation.kind !== "generated") {
    throw new Error(`${taskId} generate failed: ${JSON.stringify(generation)}`);
  }
  const applied: RunOutcome = await runMigrateTest(
    [
      "migrate",
      taskId,
      "--apply",
      "--manifest",
      join(dir, taskId, "manifest.json"),
    ],
    { environment: process.env, out: () => {} },
  );
  if (!["applied", "up-to-date"].includes(applied.kind)) {
    throw new Error(`${taskId} apply failed: ${JSON.stringify(applied)}`);
  }
}

beforeAll(async () => {
  if (!ENV.ok) return;
  if (!resolveTestDatabaseTarget(process.env).ok) {
    throw new Error(
      "MT115 migration target refused: TEST_DATABASE_URL invalid",
    );
  }
  setup = createDatabase(enterpriseTestDatabaseUrlFrom(process.env), {
    max: 2,
  });
  operator = (await verifyOperatorDatabase(
    createDatabase(enterpriseRuntimeDatabaseUrlFrom("operator", process.env), {
      max: 1,
    }),
  )) as OperatorDatabase;

  runTag = `mt115-${randomUUID().slice(0, 8)}`;
  // 锚点用户单独先插（MT112 锚定全库最早用户；失败重跑的残留用户漂移由
  // 下方的显式 workspace 成员资格兜底，不依赖时序巧合）。
  anchorUser = `${runTag}-anchor`;
  await setup.execute(sql`
    insert into users (id, email) values (${anchorUser}, ${`${runTag}-anchor@example.test`})
    on conflict (id) do nothing
  `);

  // 部署身份（锚点映射输入）先行落地。
  await setup.execute(sql`
    insert into deployment_packages (tenant_id, source_path, checksum, loaded_at)
    values (${`${runTag}-deployment`}, '/packages/mt115', 'mt115-checksum', '2999-01-01T00:00:00Z')
    on conflict (tenant_id) do nothing
  `);
  // MT112 锚点（租户/默认团队/锚点成员资格/部署身份映射）。链式 0163 预建
  // 表无 RLS——ensureTaskApplied 按共享库纪律处理：journal 空白的 fresh 库
  // DROP+task-apply 重建；已记账的库走 up-to-date，不重推锚点映射
  //（legacy-anchor 的 criterion-2 依赖映射指向其夹具部署身份）。
  await ensureTaskApplied("MT112", "enterprise_deployment_anchors");
  await applyTask("MT114");
  await applyTask("MT039");

  // openmuse_task_scopes：链式 0163 预建表无 attribution CHECK——同样按
  // journal 状态条件重建（fresh 库权威形状；已记账库不拆台 openmuse 套件）。
  await ensureTaskApplied("MT060", "openmuse_task_scopes");

  // 属主谱系（覆盖四态分类）：锚点用户（恰一条默认团队成员资格，MT112 产
  // 物）；歧义用户（0 条 workspace 成员资格）；外租户用户（唯一成员资格在
  // 他租户）；多成员资格用户（默认团队 + 第二团队两条）；迟到用户（根回填
  // 之后插入，无 principal）。
  ambiguousUser = `${runTag}-ambiguous`;
  foreignUser = `${runTag}-foreign`;
  multiUser = `${runTag}-multi`;
  await setup.execute(sql`
    insert into users (id, email) values
      (${ambiguousUser}, ${`${runTag}-ambiguous@example.test`}),
      (${foreignUser}, ${`${runTag}-foreign@example.test`}),
      (${multiUser}, ${`${runTag}-multi@example.test`})
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into enterprise_tenants (id, name) values (${FOREIGN_TENANT}, 'MT115 Foreign')
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into enterprise_workspaces (tenant_id, id, name) values
      (${FOREIGN_TENANT}, ${FOREIGN_WORKSPACE}, 'MT115 Foreign WS'),
      (${ANCHOR_TENANT_ID}, ${`${runTag}-second-ws`}, 'MT115 Second WS')
    on conflict (tenant_id, id) do nothing
  `);

  // MT113 根回填真实执行：全体既有用户落 principal + member 成员资格
  //（锚点用户沿用 MT112 的 tenant_admin 行——on conflict do nothing）。
  await runRootBackfill(setup, {
    mode: "apply",
    defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
  });

  // workspace 成员资格按测试谱系直种（生产唯一插入点是 workspace-admin；
  // 测试种子是配方惯例——recipe：测试自己种 workspace_memberships 行）。
  const anchorPrincipalRow = (await setup.execute(sql`
    select p.id from enterprise_principals p where p.user_id = ${anchorUser}
  `)) as unknown as { id: string }[];
  const foreignPrincipal = (await setup.execute(sql`
    select p.id from enterprise_principals p where p.user_id = ${foreignUser}
  `)) as unknown as { id: string }[];
  const multiPrincipal = (await setup.execute(sql`
    select p.id from enterprise_principals p where p.user_id = ${multiUser}
  `)) as unknown as { id: string }[];
  // 外租户成员资格先行（workspace 成员资格的 (tenant, principal) 复合 FK
  // 前提——外租户用户的合法谱系形状）。
  await setup.execute(sql`
    insert into enterprise_memberships (tenant_id, principal_id, role)
    values (${FOREIGN_TENANT}, ${foreignPrincipal[0].id}, 'member')
    on conflict (tenant_id, principal_id) do nothing
  `);
  await setup.execute(sql`
    insert into enterprise_workspace_memberships (tenant_id, workspace_id, principal_id) values
      (${ANCHOR_TENANT_ID}, ${DEFAULT_WORKSPACE_ID}, ${anchorPrincipalRow[0].id}),
      (${FOREIGN_TENANT}, ${FOREIGN_WORKSPACE}, ${foreignPrincipal[0].id}),
      (${ANCHOR_TENANT_ID}, ${DEFAULT_WORKSPACE_ID}, ${multiPrincipal[0].id}),
      (${ANCHOR_TENANT_ID}, ${`${runTag}-second-ws`}, ${multiPrincipal[0].id})
    on conflict (tenant_id, workspace_id, principal_id) do nothing
  `);

  // 迟到用户（根回填已跑完 → 无 principal）。
  lateUser = `${runTag}-late`;
  await setup.execute(sql`
    insert into users (id, email) values (${lateUser}, ${`${runTag}-late@example.test`})
    on conflict (id) do nothing
  `);

  // 遗留记忆：锚点（manual）、锚点带来源、歧义、外租户、多成员、无主体。
  // 记忆来源的 agent FK 先落 agents 行。
  memorySource = `${runTag}-source`;
  await setup.execute(sql`
    insert into agents (id, name, type, configuration)
    values (${`${runTag}-agent`}, 'MT115 Memory Agent', 'built_in', '{}'::jsonb)
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into memory_sources (id, owner_user_id, agent_id, tool_ref, title)
    values (${memorySource}, ${anchorUser}, ${`${runTag}-agent`}, 'mt115-tool', 'MT115 Source')
    on conflict (id) do nothing
  `);
  memAnchor = `${runTag}-mem-anchor`;
  memAnchorSourced = `${runTag}-mem-sourced`;
  memAmbiguous = `${runTag}-mem-ambiguous`;
  memForeign = `${runTag}-mem-foreign`;
  memMulti = `${runTag}-mem-multi`;
  memNoPrincipal = `${runTag}-mem-noprincipal`;
  await setup.execute(sql`
    insert into personal_memories (id, owner_user_id, content, provenance, source_id) values
      (${memAnchor}, ${anchorUser}, ${`${runTag} anchor memory`}, 'person', null),
      (${memAnchorSourced}, ${anchorUser}, ${`${runTag} sourced memory`}, 'source', ${memorySource}),
      (${memAmbiguous}, ${ambiguousUser}, ${`${runTag} ambiguous memory`}, 'person', null),
      (${memForeign}, ${foreignUser}, ${`${runTag} foreign memory`}, 'person', null),
      (${memMulti}, ${multiUser}, ${`${runTag} multi memory`}, 'person', null),
      (${memNoPrincipal}, ${lateUser}, ${`${runTag} noprincipal memory`}, 'person', null)
    on conflict (id) do nothing
  `);

  // 遗留 OpenMuse 任务：锚点、歧义、外租户。
  taskAnchor = `${runTag}-task-anchor`;
  taskAmbiguous = `${runTag}-task-ambiguous`;
  taskForeign = `${runTag}-task-foreign`;
  await setup.execute(sql`
    insert into openmuse_tasks (id, owner_user_id, bot_id, kind, prompt) values
      (${taskAnchor}, ${anchorUser}, ${`${runTag}-bot`}, 'agent', 'mt115'),
      (${taskAmbiguous}, ${ambiguousUser}, ${`${runTag}-bot`}, 'agent', 'mt115'),
      (${taskForeign}, ${foreignUser}, ${`${runTag}-bot`}, 'agent', 'mt115')
    on conflict (id) do nothing
  `);
}, 60000);

afterAll(async () => {
  for (const dir of generatedDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  if (setup) setup.$client.close();
  if (operator) operator.$client.close();
}, 60000);

// ---------------------------------------------------------------------------
// apply 正向 + AC1：子记录与属主一致；不一致检测报告
// ---------------------------------------------------------------------------

describeDb("MT115 apply：记忆与 OpenMuse 任务子记录落地与不一致检测", () => {
  let report: Awaited<ReturnType<typeof runChildBackfillBatch2>>;

  beforeAll(async () => {
    report = await runChildBackfillBatch2(setup, {
      mode: "apply",
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    });
  });

  itDb(
    "记忆子记录落地：属主三元组 + 内容/来源原样承接 + legacy 检索键",
    async () => {
      const rows = (await setup.execute(sql`
      select workspace_id, principal_id, memory_key, content, source_kind, source_ref
      from enterprise_personal_memories
      where tenant_id = ${ANCHOR_TENANT_ID} and id = ${memAnchor}
    `)) as unknown as {
        workspace_id: string;
        principal_id: string;
        memory_key: string;
        content: string;
        source_kind: string;
        source_ref: string | null;
      }[];
      expect(rows.length).toBe(1);
      expect(rows[0].workspace_id).toBe(DEFAULT_WORKSPACE_ID);
      expect(rows[0].principal_id).toBeTruthy();
      expect(rows[0].memory_key).toBe(`legacy:${memAnchor}`);
      expect(rows[0].content).toBe(`${runTag} anchor memory`);
      expect(rows[0].source_kind).toBe("manual");
      expect(rows[0].source_ref).toBeNull();

      const sourced = (await setup.execute(sql`
      select source_kind, source_ref from enterprise_personal_memories
      where tenant_id = ${ANCHOR_TENANT_ID} and id = ${memAnchorSourced}
    `)) as unknown as { source_kind: string; source_ref: string | null }[];
      expect(sourced.length).toBe(1);
      expect(sourced[0].source_kind).toBe("document");
      expect(sourced[0].source_ref).toBe(memorySource);
    },
  );

  itDb(
    "OpenMuse 任务子记录落地：attribution='backfill' 与 MT060 注册语句同构",
    async () => {
      const rows = (await setup.execute(sql`
      select tenant_id, workspace_id, principal_id, user_id, bot_id, attribution
      from openmuse_task_scopes where task_id = ${taskAnchor}
    `)) as unknown as {
        tenant_id: string;
        workspace_id: string;
        principal_id: string;
        user_id: string;
        bot_id: string;
        attribution: string;
      }[];
      expect(rows.length).toBe(1);
      expect(rows[0].tenant_id).toBe(ANCHOR_TENANT_ID);
      expect(rows[0].workspace_id).toBe(DEFAULT_WORKSPACE_ID);
      expect(rows[0].user_id).toBe(anchorUser);
      expect(rows[0].bot_id).toBe(`${runTag}-bot`);
      expect(rows[0].attribution).toBe("backfill");
    },
  );

  itDb(
    "不一致检测：外租户 mismatch、歧义成员资格隔离、无主体报告——锚点租户零写入",
    async () => {
      const memories = report.kinds.find((k) => k.kind === "personal-memory");
      expect(memories).toBeDefined();
      expect(
        memories?.mismatches.find((m) => m.recordId === memForeign)?.reason,
      ).toBe("parent-tenant-mismatch");
      expect(
        memories?.mismatches.find((m) => m.recordId === memAmbiguous)?.reason,
      ).toBe("ambiguous-membership");
      expect(
        memories?.mismatches.find((m) => m.recordId === memMulti)?.reason,
      ).toBe("ambiguous-membership");
      expect(
        memories?.mismatches.find((m) => m.recordId === memNoPrincipal)?.reason,
      ).toBe("owner-principal-missing");
      const leaked = await setup.execute(sql`
      select 1 from enterprise_personal_memories
      where tenant_id = ${ANCHOR_TENANT_ID}
        and id in (${memForeign}, ${memAmbiguous}, ${memMulti}, ${memNoPrincipal})
    `);
      expect((leaked as unknown[]).length).toBe(0);

      const tasks = report.kinds.find((k) => k.kind === "openmuse-task");
      expect(
        tasks?.mismatches.find((m) => m.recordId === taskForeign)?.reason,
      ).toBe("parent-tenant-mismatch");
      expect(
        tasks?.mismatches.find((m) => m.recordId === taskAmbiguous)?.reason,
      ).toBe("ambiguous-membership");
      const leakedScopes = await setup.execute(sql`
      select 1 from openmuse_task_scopes
      where task_id in (${taskForeign}, ${taskAmbiguous})
    `);
      expect((leakedScopes as unknown[]).length).toBe(0);
    },
  );

  itDb("任务归属被他租户认领 → 隔离清单（MT113 词汇），零写入", async () => {
    const claimedTask = `${runTag}-task-claimed`;
    await setup.execute(sql`
      insert into openmuse_tasks (id, owner_user_id, bot_id, kind, prompt)
      values (${claimedTask}, ${anchorUser}, ${`${runTag}-bot`}, 'agent', 'mt115')
      on conflict (id) do nothing
    `);
    // 他租户已认领（task_id 全局主键）。锚点主体须先成为他租户成员，
    // 协会行的 (tenant, principal) 复合 FK 才成立（外租户认领的合法形状）。
    const anchorPrincipal = (await setup.execute(sql`
      select p.id from enterprise_principals p where p.user_id = ${anchorUser}
    `)) as unknown as { id: string }[];
    await setup.execute(sql`
      insert into enterprise_memberships (tenant_id, principal_id, role)
      values (${FOREIGN_TENANT}, ${anchorPrincipal[0].id}, 'member')
      on conflict (tenant_id, principal_id) do nothing
    `);
    await setup.execute(sql`
      insert into openmuse_task_scopes
        (task_id, tenant_id, workspace_id, principal_id, user_id, bot_id, attribution)
      values (${claimedTask}, ${FOREIGN_TENANT}, ${FOREIGN_WORKSPACE},
        ${anchorPrincipal[0].id}, ${anchorUser}, ${`${runTag}-bot`}, 'created')
      on conflict (task_id) do nothing
    `);
    const again = await runChildBackfillBatch2(setup, {
      mode: "apply",
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    });
    const tasks = again.kinds.find((k) => k.kind === "openmuse-task");
    expect(
      tasks?.mismatches.find((m) => m.recordId === claimedTask)?.reason,
    ).toBe("claimed-by-another-tenant");
    const claim = (await setup.execute(sql`
      select tenant_id from openmuse_task_scopes where task_id = ${claimedTask}
    `)) as unknown as { tenant_id: string }[];
    expect(claim.length).toBe(1);
    expect(claim[0].tenant_id).toBe(FOREIGN_TENANT);
  });
});

// ---------------------------------------------------------------------------
// AC2：可中断续跑 + 幂等重跑（复用第一批进度机制）
// ---------------------------------------------------------------------------

describeDb("MT115 AC2：可中断续跑且不重复写入", () => {
  itDb("主动中断：running 相位 + 游标推进；续跑完成零重复", async () => {
    const memoriesBefore = (await setup.execute(sql`
      select count(*)::int as n from enterprise_personal_memories
      where tenant_id = ${ANCHOR_TENANT_ID}
    `)) as unknown as { n: number }[];
    const interrupted = await runChildBackfillBatch2(setup, {
      mode: "apply",
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      chunkSize: 1,
      stopAfterChunks: 1,
    });
    const firstKind = interrupted.kinds.find(
      (k) => k.kind === "personal-memory",
    );
    expect(firstKind?.phase).toBe("running");
    expect(firstKind?.resumes).toBeGreaterThanOrEqual(2);
    // 中断后进度行已落盘（running 相位，块事务提交）。
    const progress = await childBackfillBatch2ProgressReport(setup);
    const memProgress = progress.entries.find(
      (e) => e.kind === "personal-memory",
    );
    expect(memProgress?.phase).toBe("running");

    const resumed = await runChildBackfillBatch2(setup, {
      mode: "apply",
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    });
    for (const kind of resumed.kinds) {
      expect(kind.phase).toBe("completed");
    }
    const memoriesAfter = (await setup.execute(sql`
      select count(*)::int as n from enterprise_personal_memories
      where tenant_id = ${ANCHOR_TENANT_ID}
    `)) as unknown as { n: number }[];
    // claimed 任务不产生记忆行差异；仅有的新增 = 无（中断点在首块后）。
    expect(memoriesAfter[0].n).toBe(memoriesBefore[0].n);
  });

  itDb("幂等重跑：全量 apply 第二轮 applied 增量 0，行数不变", async () => {
    const before = (await setup.execute(sql`
      select count(*)::int as n from openmuse_task_scopes
      where tenant_id = ${ANCHOR_TENANT_ID}
    `)) as unknown as { n: number }[];
    const again = await runChildBackfillBatch2(setup, {
      mode: "apply",
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    });
    const tasks = again.kinds.find((k) => k.kind === "openmuse-task");
    expect(tasks?.applied).toBe(0);
    expect(tasks?.skippedExisting).toBeGreaterThan(0);
    const after = (await setup.execute(sql`
      select count(*)::int as n from openmuse_task_scopes
      where tenant_id = ${ANCHOR_TENANT_ID}
    `)) as unknown as { n: number }[];
    expect(after[0].n).toBe(before[0].n);
  });
});

// ---------------------------------------------------------------------------
// AC3：约束与校验双重——跨公司关联被数据库拒绝
// ---------------------------------------------------------------------------

describeDb("MT115 AC3：跨公司关联被数据库拒绝（约束半边）", () => {
  const expectCode = async (
    run: () => Promise<unknown>,
    code: string,
  ): Promise<void> => {
    try {
      await run();
    } catch (error) {
      // drizzle 把 PG 错误包在 cause 里——取到真正的 SQLSTATE 才算证据。
      let probe: unknown = error;
      let pgCode = "";
      while (probe) {
        const carrier = probe as {
          code?: string;
          errno?: string;
          cause?: unknown;
        };
        for (const candidate of [carrier.code, carrier.errno]) {
          if (typeof candidate === "string" && /^23\d\d\d$/.test(candidate)) {
            pgCode = candidate;
            break;
          }
        }
        if (pgCode) break;
        probe = carrier.cause;
      }
      expect(pgCode).toContain(code);
      return;
    }
    throw new Error("expected the insert to be rejected, but it succeeded");
  };

  itDb("记忆复合外键拒绝他团队 workspace 与非成员主体（23503）", async () => {
    const anchorPrincipal = (await setup.execute(sql`
        select p.id from enterprise_principals p where p.user_id = ${anchorUser}
      `)) as unknown as { id: string }[];
    // (tenant, workspace) 复合 FK：锚点租户不认他租户 workspace。
    await expectCode(
      () =>
        setup.execute(sql`
          insert into enterprise_personal_memories
            (tenant_id, id, workspace_id, principal_id, memory_key, content, source_kind)
          values (${ANCHOR_TENANT_ID}, 'mt115-cross-mem', ${FOREIGN_WORKSPACE},
            ${anchorPrincipal[0].id}, 'k', 'x', 'manual')
        `),
      "23503",
    );
    // (tenant, principal) 复合 FK：非成员主体进不了记忆面——迟到用户
    // 直种 bare principal（无成员资格）作为合法探针形状。
    const barePrincipalId = `${runTag}-bare-principal`;
    await setup.execute(sql`
        insert into enterprise_principals (id, user_id)
        values (${barePrincipalId}, ${lateUser})
        on conflict (user_id) do nothing
      `);
    await expectCode(
      () =>
        setup.execute(sql`
          insert into enterprise_personal_memories
            (tenant_id, id, workspace_id, principal_id, memory_key, content, source_kind)
          values (${ANCHOR_TENANT_ID}, 'mt115-cross-mem-2', ${DEFAULT_WORKSPACE_ID},
            ${barePrincipalId}, 'k', 'x', 'manual')
        `),
      "23503",
    );
  });

  itDb(
    "任务协会复合外键拒绝他公司三元组（23503）与未知 attribution（23514）",
    async () => {
      const anchorPrincipal = (await setup.execute(sql`
        select p.id from enterprise_principals p where p.user_id = ${anchorUser}
      `)) as unknown as { id: string }[];
      await expectCode(
        () =>
          setup.execute(sql`
          insert into openmuse_task_scopes
            (task_id, tenant_id, workspace_id, principal_id, user_id, bot_id, attribution)
          values ('mt115-nonexistent-task', ${ANCHOR_TENANT_ID}, ${DEFAULT_WORKSPACE_ID},
            ${anchorPrincipal[0].id}, ${anchorUser}, 'b', 'backfill')
        `),
        "23503",
      );
      await expectCode(
        () =>
          setup.execute(sql`
          insert into openmuse_task_scopes
            (task_id, tenant_id, workspace_id, principal_id, user_id, bot_id, attribution)
          values (${taskAmbiguous}, ${ANCHOR_TENANT_ID}, ${DEFAULT_WORKSPACE_ID},
            ${anchorPrincipal[0].id}, ${ambiguousUser}, 'b', 'guessed')
        `),
        "23514",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// AC4：进度与计数校验报告 + 主库回填完成状态
// ---------------------------------------------------------------------------

describeDb("MT115 AC4：持久进度报告、计数守恒与主库完成状态", () => {
  itDb(
    "两类齐全、completed、计数守恒（scanned=applied+skipped+mismatch）",
    async () => {
      const report = await childBackfillBatch2ProgressReport(setup);
      expect(report.batchId).toBe(CHILD_BACKFILL_BATCH2_ID);
      expect(report.missingKinds).toEqual([]);
      expect(report.entries.length).toBe(CHILD_BACKFILL_BATCH2_KINDS.length);
      for (const entry of report.entries) {
        expect(entry.phase).toBe("completed");
        expect(entry.scanned, `${entry.kind} 计数不守恒`).toBe(
          entry.applied + entry.skippedExisting + entry.mismatchReported,
        );
      }
      // 报告计数与库内归属行直接对照（任务面为例）。
      const tasks = report.entries.find((e) => e.kind === "openmuse-task");
      const scopeRows = (await setup.execute(sql`
        select count(*)::int as n from openmuse_task_scopes
        where tenant_id = ${ANCHOR_TENANT_ID}
      `)) as unknown as { n: number }[];
      expect(tasks ? tasks.applied + tasks.skippedExisting : -1).toBe(
        Number(scopeRows[0].n),
      );
    },
  );

  itDb("主库回填完成状态：第一批未跑 → false；第一批补齐 → true", async () => {
    // 复跑残留清理：此前套件轮可能已落第一批进度行——先清出「第一批
    // 未跑」的受控起点（进度表是批次自己的记账面，测试可作夹具重置）。
    await setup.execute(
      sql`delete from enterprise_backfill_batches where batch_id = 'child-main-batch1'`,
    );
    const before = await mainBackfillCompletion(setup);
    expect(before.complete).toBe(false);
    const batch1 = before.batches.find(
      (b) => b.batchId === "child-main-batch1",
    );
    expect(batch1?.missingKinds.length).toBeGreaterThan(0);

    // 第一批真实补齐（本库锚点/根回填前提已就绪）。五类源各播一行：
    // 空源类别不落进度行（无块可提交）——完成标记按进度表相位读，故
    // 五类都要有真实源行（生产遗留数据形状）。
    const channel = `${runTag}-channel`;
    await setup.execute(sql`
        insert into channels (id, name, description) values (${channel}, 'MT115 Ch', 'mt115')
        on conflict (id) do nothing
      `);
    await setup.execute(sql`
        insert into channel_memberships (channel_id, user_id) values (${channel}, ${anchorUser})
        on conflict (channel_id, user_id) do nothing
      `);
    await setup.execute(sql`
        insert into attachments (channel_id, uploaded_by, name, mime_type, size_bytes, bytes, attached_at)
        select ${channel}, ${anchorUser}, 'mt115.txt', 'text/plain', 4, '\\x61626364'::bytea, now()
        where not exists (
          select 1 from attachments where channel_id = ${channel} and name = 'mt115.txt'
        )
      `);
    await setup.execute(sql`
        insert into credentials (kind, provider, encrypted_value, key_id, metadata)
        select 'model', ${`${runTag}-provider`}, ${`${runTag}-envelope`}, ${`${runTag}-key`}, '{}'::jsonb
        where not exists (
          select 1 from credentials where provider = ${`${runTag}-provider`}
        )
      `);
    await setup.execute(sql`
        insert into craft_sessions (id, user_id) values (${`${runTag}-craft`}, ${anchorUser})
        on conflict (id) do nothing
      `);
    await setup.execute(sql`
        insert into enterprise_plugin_catalog (id, kind, title, vendor, source, metadata)
        values (${`${runTag}-gmail`}, 'composio', 'MT115 Gmail', 'composio', 'first-party', '{"summary":"mt115"}'::jsonb)
        on conflict (id) do nothing
      `);
    await setup.execute(sql`
        insert into composio_connections (toolkit, user_id) values (${`${runTag}-gmail`}, ${anchorUser})
        on conflict (toolkit, user_id) do nothing
      `);
    await runChildBackfill(setup, {
      mode: "apply",
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    });
    const after = await mainBackfillCompletion(setup);
    expect(after.complete).toBe(true);
    for (const batch of after.batches) {
      expect(batch.presentKinds).toBe(batch.expectedKinds);
      expect(batch.incompleteKinds).toEqual([]);
    }
  });
});
