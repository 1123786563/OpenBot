// server/tests/multitenancy/backfill-consistency.test.ts
// MT117（Issue #160）：跨库一致性校验、断点续跑与回填报告。
//
// 验收事实源（Issue #160 四条；真实 PostgreSQL——MT112/MT114/MT039/MT060
// 迁移真实落地，MT113 根回填 + MT114 第一批 + MT115 第二批真实执行后
// 一致性校验真实重算）：
//   AC1 跨库不一致被检测、报告并可从断点续跑，不被当作完成：进度半边与
//      数据半边（活数据对照/迟到行重分类）、running 相位、计数不守恒、
//      缺类别、未知批次行、根隔离未清——逐项注入 → 逐项点名 → 逐项
//      续跑/清理恢复。「跨库」的知识库半边按 ADR 0009 如实记为
//      not-applicable（不虚构假半边；若出现 child-kb 批次行反被点名）。
//   AC2 报告包含范围、计数、抽样对照、隔离清单与未决项（scope.kinds/
//      findings/rootReadiness 结构逐项断言）。
//   AC3 报告可被独立验证者用记录的命令复现（reproduce 内嵌命令；同一
//      数据两次重算结果一致）。
//   AC4 存在未决项时阻断后续启用（ready=false 与 rootBackfillReadiness
//      同款阻断纪律；backfillConsistencyReadiness 消费面同形）。
//
// 前置诚实披露：票面 Verification 写「两个测试库」——ADR 0009 下线知识
// 库子系统后第二库不存在，本套件在主库测试库上运行，KB 侧以 not-applicable
// 裁定入报告（MT116 钉子套件 child-backfill-kb.test.ts 钉死下线状态）。

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
import {
  backfillConsistencyReadiness,
  buildBackfillConsistencyReport,
  KB_SIDE_DISPOSITION,
} from "../../src/enterprise/tenancy/backfill-consistency";
import { runChildBackfill } from "../../src/enterprise/tenancy/child-backfill";
import { runChildBackfillBatch2 } from "../../src/enterprise/tenancy/child-backfill-batch2";
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
      reason: `MT117 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
const FOREIGN_TENANT = "mt117-foreign";
const FOREIGN_WORKSPACE = "mt117-foreign-ws";

let setup: Database;
const generatedDirs: string[] = [];

let runTag = "";
let anchorUser = "";
let memAnchor = "";
let taskAnchor = "";

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
  const dir = join("/tmp", `mt117-migration-${randomUUID().slice(0, 8)}`);
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
      "MT117 migration target refused: TEST_DATABASE_URL invalid",
    );
  }
  setup = createDatabase(enterpriseTestDatabaseUrlFrom(process.env), {
    max: 2,
  });

  runTag = `mt117-${randomUUID().slice(0, 8)}`;
  anchorUser = `${runTag}-anchor`;
  await setup.execute(sql`
    insert into users (id, email) values (${anchorUser}, ${`${runTag}-anchor@example.test`})
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into deployment_packages (tenant_id, source_path, checksum, loaded_at)
    values (${`${runTag}-deployment`}, '/packages/mt117', 'mt117-checksum', '2999-01-01T00:00:00Z')
    on conflict (tenant_id) do nothing
  `);
  // 链式预建表按共享库纪律条件重建（见 ensureTaskApplied 注释）。
  await ensureTaskApplied("MT112", "enterprise_deployment_anchors");
  await applyTask("MT114");
  await applyTask("MT039");
  await ensureTaskApplied("MT060", "openmuse_task_scopes");

  await setup.execute(sql`
    insert into enterprise_tenants (id, name) values (${FOREIGN_TENANT}, 'MT117 Foreign')
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into enterprise_workspaces (tenant_id, id, name) values
      (${FOREIGN_TENANT}, ${FOREIGN_WORKSPACE}, 'MT117 Foreign WS')
    on conflict (tenant_id, id) do nothing
  `);

  // 根回填 + 锚点用户显式 workspace 成员资格（时序无关，见 MT115 同款注释）。
  await runRootBackfill(setup, {
    mode: "apply",
    defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
  });
  const anchorPrincipalRow = (await setup.execute(sql`
    select p.id from enterprise_principals p where p.user_id = ${anchorUser}
  `)) as unknown as { id: string }[];
  await setup.execute(sql`
    insert into enterprise_workspace_memberships (tenant_id, workspace_id, principal_id)
    values (${ANCHOR_TENANT_ID}, ${DEFAULT_WORKSPACE_ID}, ${anchorPrincipalRow[0].id})
    on conflict (tenant_id, workspace_id, principal_id) do nothing
  `);

  // 第一批五类源各播一行（空源类别不落进度行——完成语义需要真实源）。
  await setup.execute(sql`
    insert into agents (id, name, type, configuration)
    values (${`${runTag}-agent`}, 'MT117 Bot', 'built_in', '{}'::jsonb)
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into craft_sessions (id, user_id) values (${`${runTag}-craft`}, ${anchorUser})
    on conflict (id) do nothing
  `);
  const channel = `${runTag}-channel`;
  await setup.execute(sql`
    insert into channels (id, name, description) values (${channel}, 'MT117 Ch', 'mt117')
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into channel_memberships (channel_id, user_id) values (${channel}, ${anchorUser})
    on conflict (channel_id, user_id) do nothing
  `);
  await setup.execute(sql`
    insert into attachments (channel_id, uploaded_by, name, mime_type, size_bytes, bytes, attached_at)
    select ${channel}, ${anchorUser}, 'mt117.txt', 'text/plain', 4, '\\x61626364'::bytea, now()
    where not exists (
      select 1 from attachments where channel_id = ${channel} and name = 'mt117.txt'
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
    insert into enterprise_plugin_catalog (id, kind, title, vendor, source, metadata)
    values (${`${runTag}-gmail`}, 'composio', 'MT117 Gmail', 'composio', 'first-party', '{"summary":"mt117"}'::jsonb)
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into composio_connections (toolkit, user_id) values (${`${runTag}-gmail`}, ${anchorUser})
    on conflict (toolkit, user_id) do nothing
  `);

  // 第二批两类源各播一行。
  memAnchor = `${runTag}-mem-anchor`;
  await setup.execute(sql`
    insert into personal_memories (id, owner_user_id, content, provenance)
    values (${memAnchor}, ${anchorUser}, ${`${runTag} anchor memory`}, 'person')
    on conflict (id) do nothing
  `);
  taskAnchor = `${runTag}-task-anchor`;
  await setup.execute(sql`
    insert into openmuse_tasks (id, owner_user_id, bot_id, kind, prompt)
    values (${taskAnchor}, ${anchorUser}, ${`${runTag}-bot`}, 'agent', 'mt117')
    on conflict (id) do nothing
  `);

  // 共享库夹具卫生：兄弟套件（MT114 batch1 等）的 AC1 段会在他租户认领
  // 根记录且不复原——本套件要断言「隔离清单为空的一致状态」，先清掉这些
  // 测试残留认领（他们各自重跑时会重新种回；企业测试库上的他租户行只有
  // 测试夹具一种来源）。
  await setup.execute(sql`
    delete from enterprise_resources r
    where r.tenant_id <> ${ANCHOR_TENANT_ID}
      and r.id in (
        select a.id from agents a
        union select c.id from channels c
        union select cr.id::text from credentials cr
        union select s.id from craft_sessions s
        union select e.id from expert_installs e
      )
  `);
  // 全链真实执行：根 → 第一批 → 第二批（各自幂等，复跑零重复）。
  await runChildBackfill(setup, {
    mode: "apply",
    defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
  });
  await runChildBackfillBatch2(setup, {
    mode: "apply",
    defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
  });
}, 60000);

afterAll(async () => {
  for (const dir of generatedDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  if (setup) setup.$client.close();
}, 60000);

// ---------------------------------------------------------------------------
// AC2：报告结构——范围、计数、抽样对照、隔离清单与未决项
// ---------------------------------------------------------------------------

describeDb("MT117 AC2：一致状态下的报告结构与 KB 侧裁定", () => {
  itDb(
    "报告含范围/计数/抽样对照/隔离清单/未决项，一致状态 ready=true",
    async () => {
      const report = await buildBackfillConsistencyReport(setup, {
        defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      });
      // 范围：真实存在的批次闭集。
      expect(report.scope.batches).toEqual([
        "child-main-batch1",
        "child-main-batch2",
      ]);
      // 计数与抽样对照：每类别进度行计数 + 目标表现场计数。
      expect(report.kinds.length).toBe(7);
      for (const kind of report.kinds) {
        expect(kind.phase).toBe("completed");
        expect(kind.countsConserved).toBe(true);
        expect(kind.liveTargetRows).not.toBeNull();
      }
      // 抽样对照一致性：锚点记忆行进报告且现场计数 ≥ 1。
      const memory = report.kinds.find((k) => k.kind === "personal-memory");
      expect(memory?.applied + memory?.skippedExisting).toBeGreaterThan(0);
      expect(memory?.liveTargetRows).toBeGreaterThanOrEqual(1);
      // 隔离清单与未决项：根隔离重算 + findings。
      expect(report.rootReadiness.quarantinedCount).toBe(0);
      expect(report.findings).toEqual([]);
      expect(report.ready).toBe(true);
    },
  );

  itDb("KB 侧如实记为 not-applicable（ADR 0009 依据，不虚构第二库）", () => {
    expect(KB_SIDE_DISPOSITION.status).toBe("not-applicable");
    expect(KB_SIDE_DISPOSITION.basis).toContain("ADR 0009");
    expect(KB_SIDE_DISPOSITION.basis).toContain("child-backfill-kb.test.ts");
  });
});

// ---------------------------------------------------------------------------
// AC1：不一致被检测、报告、续跑恢复——逐项注入
// ---------------------------------------------------------------------------

describeDb(
  "MT117 AC1：未完成/漂移/不守恒被检测且阻断（每项注入→续跑→恢复）",
  () => {
    itDb("running 相位 = 未决项，不被当作完成；续跑后恢复", async () => {
      await setup.execute(sql`
      update enterprise_backfill_batches set phase = 'running'
      where batch_id = 'child-main-batch2' and kind = 'openmuse-task'
    `);
      const flagged = await buildBackfillConsistencyReport(setup, {
        defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      });
      expect(flagged.ready).toBe(false);
      expect(
        flagged.findings.some(
          (f) =>
            f.kind === "kind-phase-running" &&
            f.kindLabel === "openmuse-task" &&
            f.detail.includes("断点续跑入口"),
        ),
      ).toBe(true);
      // 断点续跑（报告给出的入口）：第二批重跑。
      await runChildBackfillBatch2(setup, {
        mode: "apply",
        defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      });
      const recovered = await buildBackfillConsistencyReport(setup, {
        defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      });
      expect(recovered.ready).toBe(true);
    });

    itDb("计数不守恒被点名（进度算术漂移）", async () => {
      await setup.execute(sql`
      update enterprise_backfill_batches set scanned = scanned + 999
      where batch_id = 'child-main-batch2' and kind = 'personal-memory'
    `);
      const flagged = await buildBackfillConsistencyReport(setup, {
        defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      });
      expect(flagged.ready).toBe(false);
      expect(
        flagged.findings.some(
          (f) =>
            f.kind === "kind-counts-inconsistent" &&
            f.kindLabel === "personal-memory",
        ),
      ).toBe(true);
      await runChildBackfillBatch2(setup, {
        mode: "apply",
        defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      });
      const recovered = await buildBackfillConsistencyReport(setup, {
        defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      });
      expect(recovered.ready).toBe(true);
    });

    itDb(
      "进度半边与数据半边漂移：completed 后目标行被删（一侧成功一侧失败）",
      async () => {
        const before = await buildBackfillConsistencyReport(setup, {
          defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
        });
        expect(before.ready).toBe(true);
        await setup.execute(sql`
        delete from enterprise_personal_memories where id = ${memAnchor}
      `);
        const flagged = await buildBackfillConsistencyReport(setup, {
          defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
        });
        expect(flagged.ready).toBe(false);
        expect(
          flagged.findings.some(
            (f) => f.kind === "kind-progress-vs-live-drift",
          ),
        ).toBe(true);
        // 续跑恢复：第二批重跑把被删行补回（幂等写入重放）。
        await runChildBackfillBatch2(setup, {
          mode: "apply",
          defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
        });
        const recovered = await buildBackfillConsistencyReport(setup, {
          defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
        });
        expect(recovered.ready).toBe(true);
      },
    );

    itDb(
      "迟到行漂移：completed 之后新种的可归属源行被活数据重分类点名",
      async () => {
        const lateUser = `${runTag}-latecomer`;
        await setup.execute(sql`
      insert into users (id, email) values (${lateUser}, ${`${runTag}-latecomer@example.test`})
      on conflict (id) do nothing
    `);
        const latePrincipal = (await setup.execute(sql`
      insert into enterprise_principals (id, user_id)
      values (${`entp-${runTag}-latecomer`}, ${lateUser})
      on conflict (user_id) do nothing
      returning id
    `)) as unknown as { id: string }[];
        await setup.execute(sql`
      insert into enterprise_memberships (tenant_id, principal_id, role)
      values (${ANCHOR_TENANT_ID}, ${latePrincipal[0].id}, 'member')
      on conflict (tenant_id, principal_id) do nothing
    `);
        await setup.execute(sql`
      insert into enterprise_workspace_memberships (tenant_id, workspace_id, principal_id)
      values (${ANCHOR_TENANT_ID}, ${DEFAULT_WORKSPACE_ID}, ${latePrincipal[0].id})
      on conflict (tenant_id, workspace_id, principal_id) do nothing
    `);
        await setup.execute(sql`
      insert into personal_memories (id, owner_user_id, content, provenance)
      values (${`mt117-late-mem-${runTag}`}, ${lateUser}, 'latecomer memory', 'person')
      on conflict (id) do nothing
    `);
        const flagged = await buildBackfillConsistencyReport(setup, {
          defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
        });
        expect(flagged.ready).toBe(false);
        const drift = flagged.findings.find(
          (f) =>
            f.kind === "kind-progress-vs-live-drift" &&
            f.detail.includes("迟到行"),
        );
        expect(drift).toBeDefined();
        // 断点续跑恢复。
        await runChildBackfillBatch2(setup, {
          mode: "apply",
          defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
        });
        const recovered = await buildBackfillConsistencyReport(setup, {
          defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
        });
        expect(recovered.ready).toBe(true);
      },
    );

    itDb("缺类别进度行被点名（未跑类别不是完成）", async () => {
      await setup.execute(sql`
      delete from enterprise_backfill_batches
      where batch_id = 'child-main-batch1' and kind = 'credential'
    `);
      const flagged = await buildBackfillConsistencyReport(setup, {
        defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      });
      expect(flagged.ready).toBe(false);
      expect(
        flagged.findings.some(
          (f) =>
            f.kind === "batch-missing-kind" && f.kindLabel === "credential",
        ),
      ).toBe(true);
      await runChildBackfill(setup, {
        mode: "apply",
        defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      });
      const recovered = await buildBackfillConsistencyReport(setup, {
        defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      });
      expect(recovered.ready).toBe(true);
    });

    itDb(
      "未知批次行被点名：知识库侧若被假造（child-kb 批次行）反成未决项",
      async () => {
        await setup.execute(sql`
        insert into enterprise_backfill_batches
          (batch_id, kind, phase, last_cursor, scanned, applied, skipped_existing,
           mismatch_reported, quarantined, written_rows, resumes, updated_at)
        values ('child-kb', 'probe', 'completed', null, 0, 0, 0, 0, 0, 0, 0, now())
        on conflict (batch_id, kind) do nothing
      `);
        const flagged = await buildBackfillConsistencyReport(setup, {
          defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
        });
        expect(flagged.ready).toBe(false);
        expect(
          flagged.findings.some(
            (f) => f.kind === "unknown-batch-rows" && f.batchId === "child-kb",
          ),
        ).toBe(true);
        await setup.execute(sql`
        delete from enterprise_backfill_batches where batch_id = 'child-kb'
      `);
        const recovered = await buildBackfillConsistencyReport(setup, {
          defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
        });
        expect(recovered.ready).toBe(true);
      },
    );

    itDb("根回填隔离清单未清空 = 未决项（MT113 同一推导）", async () => {
      const claimedAgent = `${runTag}-agent-claimed`;
      await setup.execute(sql`
      insert into agents (id, name, type, configuration)
      values (${claimedAgent}, 'MT117 Claimed', 'built_in', '{}'::jsonb)
      on conflict (id) do nothing
    `);
      await setup.execute(sql`
      insert into enterprise_resources (tenant_id, id, workspace_id, kind, display_name)
      values (${FOREIGN_TENANT}, ${claimedAgent}, ${FOREIGN_WORKSPACE}, 'bot', 'Claimed')
      on conflict (tenant_id, id) do nothing
    `);
      const flagged = await buildBackfillConsistencyReport(setup, {
        defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      });
      expect(flagged.ready).toBe(false);
      expect(flagged.rootReadiness.quarantinedCount).toBeGreaterThan(0);
      expect(
        flagged.findings.some((f) => f.kind === "root-quarantine-open"),
      ).toBe(true);
      // 清理冲突认领行 → 恢复（隔离是事实状态不是终局）。
      await setup.execute(sql`
      delete from enterprise_resources where tenant_id = ${FOREIGN_TENANT} and id = ${claimedAgent}
    `);
      const recovered = await buildBackfillConsistencyReport(setup, {
        defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      });
      expect(recovered.ready).toBe(true);
    });
  },
);

// ---------------------------------------------------------------------------
// AC3：可复现（独立验证者用记录的命令重算，结果一致）
// ---------------------------------------------------------------------------

describeDb("MT117 AC3：报告可被独立验证者复现", () => {
  itDb("reproduce 内嵌命令与入口；同一数据两次重算逐字段一致", async () => {
    const first = await buildBackfillConsistencyReport(setup, {
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    });
    expect(first.reproduce.command).toBe(
      "bun test server/tests/multitenancy/backfill-consistency.test.ts",
    );
    expect(first.reproduce.entrypoint).toBe("buildBackfillConsistencyReport");
    const second = await buildBackfillConsistencyReport(setup, {
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    });
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// AC4：存在未决项时阻断后续启用
// ---------------------------------------------------------------------------

describeDb(
  "MT117 AC4：未决项阻断就绪（与 rootBackfillReadiness 同纪律）",
  () => {
    itDb(
      "backfillConsistencyReadiness 镜像 ready；注入未决项即 false",
      async () => {
        const clean = await backfillConsistencyReadiness(setup, {
          defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
        });
        expect(clean.ready).toBe(true);
        expect(clean.findings).toEqual([]);

        await setup.execute(sql`
      update enterprise_backfill_batches set phase = 'running'
      where batch_id = 'child-main-batch2' and kind = 'personal-memory'
    `);
        const blocked = await backfillConsistencyReadiness(setup, {
          defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
        });
        expect(blocked.ready).toBe(false);
        expect(blocked.findings.length).toBeGreaterThan(0);

        await runChildBackfillBatch2(setup, {
          mode: "apply",
          defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
        });
        const restored = await backfillConsistencyReadiness(setup, {
          defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
        });
        expect(restored.ready).toBe(true);
      },
    );
  },
);
