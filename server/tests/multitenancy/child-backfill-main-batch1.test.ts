// server/tests/multitenancy/child-backfill-main-batch1.test.ts
// MT114（Issue #157）：主库子记录回填第一批——Bot、会话、附件、凭据与插件。
//
// 验收事实源（Issue #157 四条，逐条对应 describe；真实 PostgreSQL——
// MT112 锚点 + MT114 进度表经真实 MT003 工具落地，MT113 根回填真实执行
// 作为父前提，子记录回填真实执行；绝不回退开发库、缺 env 显式 skip）：
//   AC1 本批对象的子记录归属与父记录一致；不一致被检测并报告，不静默
//      覆盖（父在他租户 → mismatch 报告零写入；父缺失 → pending-parent；
//      插件目录身份不可解析 → 隔离清单）。
//   AC2 回填可中断续跑且不重复写入；幂等重跑结果一致（分块进度持久化，
//      主动停 = running 相位 + 游标；续跑完成零重复；重复全量 apply
//      applied 增量 0）。
//   AC3 约束与校验双重保证跨公司关联被数据库拒绝（约束半边：bot 归属
//      agent_id 全局唯一索引、messages/connections 复合外键——真实
//      INSERT 被库拒绝；校验半边：写前父根一致性判定）。
//   AC4 输出本批进度与计数校验报告（childBackfillProgressReport 读持久
//      进度表，五类齐全、计数与直接 SQL 对照一致）。
//
// 前置诚实披露：#117（MT074 余额迁移）无已交付契约（wave16 票号映射分歧，
// 协调器裁决 A 案执行并披露）；本批不消费余额迁移产物。

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
  CHILD_BACKFILL_BATCH_ID,
  CHILD_BACKFILL_KINDS,
  childBackfillProgressReport,
  runChildBackfill,
} from "../../src/enterprise/tenancy/child-backfill";
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
      reason: `MT114 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
const FOREIGN_TENANT = "mt114-foreign";

let setup: Database;
let operator: OperatorDatabase;
const generatedDirs: string[] = [];

let runTag = "";
let userA = "";
let userB = "";
let agentOne = "";
let agentTwo = "";
let craftOne = "";
let channelOne = "";
let attachmentOne = "";
let credentialOne = "";
let pluginToolkit = "";
let pluginToolkitUnknown = "";

async function applyTask(taskId: string): Promise<void> {
  const dir = join("/tmp", `mt114-migration-${randomUUID().slice(0, 8)}`);
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
      "MT114 migration target refused: TEST_DATABASE_URL invalid",
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

  runTag = `mt114-${randomUUID().slice(0, 8)}`;
  userA = `${runTag}-user-a`;
  userB = `${runTag}-user-b`;

  // 身份 + 部署身份（锚点输入）。
  await setup.execute(sql`
    insert into users (id, email) values
      (${userA}, ${`${runTag}-a@example.test`}),
      (${userB}, ${`${runTag}-b@example.test`})
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into deployment_packages (tenant_id, source_path, checksum, loaded_at)
    values (${`${runTag}-deployment`}, '/packages/mt114', 'mt114-checksum', '2019-01-01T00:00:00Z')
    on conflict (tenant_id) do nothing
  `);

  await applyTask("MT112");
  await applyTask("MT114");

  // 父前提：MT113 根回填真实执行（先种根源，再回填）。
  agentOne = `${runTag}-agent-1`;
  agentTwo = `${runTag}-agent-2`;
  await setup.execute(sql`
    insert into agents (id, name, type, configuration) values
      (${agentOne}, 'MT114 Bot One', 'built_in', '{}'::jsonb),
      (${agentTwo}, 'MT114 Bot Two', 'built_in', '{}'::jsonb)
    on conflict (id) do nothing
  `);
  craftOne = `${runTag}-craft-1`;
  await setup.execute(sql`
    insert into craft_sessions (id, user_id) values (${craftOne}, ${userA})
    on conflict (id) do nothing
  `);
  channelOne = `${runTag}-channel-1`;
  await setup.execute(sql`
    insert into channels (id, name, description) values (${channelOne}, 'MT114 Ch', 'mt114')
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into channel_memberships (channel_id, user_id) values (${channelOne}, ${userA})
    on conflict (channel_id, user_id) do nothing
  `);
  const cred = (await setup.execute(sql`
    insert into credentials (kind, provider, encrypted_value, key_id, metadata)
    values ('model', ${`${runTag}-provider`}, ${`${runTag}-envelope`}, ${`${runTag}-key`}, '{}'::jsonb)
    returning id::text
  `)) as unknown as { id: string }[];
  credentialOne = cred[0].id;
  const att = (await setup.execute(sql`
    insert into attachments (channel_id, uploaded_by, name, mime_type, size_bytes, bytes, attached_at)
    values (${channelOne}, ${userA}, 'mt114.txt', 'text/plain', 4, '\\x61626364'::bytea, now())
    returning id::text
  `)) as unknown as { id: string }[];
  attachmentOne = att[0].id;
  // 插件：一个目录可解析（正向）+ 一个目录不可解析（隔离）。
  pluginToolkit = `${runTag}-gmail`;
  pluginToolkitUnknown = `${runTag}-unknown-toolkit`;
  await setup.execute(sql`
    insert into enterprise_plugin_catalog (id, kind, title, vendor, source, metadata)
    values (${pluginToolkit}, 'composio', 'MT114 Gmail', 'composio', 'first-party', '{"summary":"mt114"}'::jsonb)
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into composio_connections (toolkit, user_id) values
      (${pluginToolkit}, ${userA}),
      (${pluginToolkitUnknown}, ${userB})
    on conflict (toolkit, user_id) do nothing
  `);

  await runRootBackfill(setup, {
    mode: "apply",
    defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
  });
}, 60000);

afterAll(async () => {
  for (const dir of generatedDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  if (setup) setup.$client.close();
  if (operator) operator.$client.close();
}, 60000);

/** operator 通道计数（进度表与归属行都是 operator 可读面）。 */
async function countAsOperator(
  table: string,
  where: ReturnType<typeof sql>,
): Promise<number> {
  if (table === "enterprise_conversations") {
    // 会话表的受限读属 data 角色；对账计数走 setup 直读（计数面不经授权）。
    const rows = (await setup.execute(
      sql`select count(*)::int as n from ${sql.raw(table)} where ${where}`,
    )) as unknown as { n: number }[];
    return Number(rows[0]?.n ?? 0);
  }
  return operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${ANCHOR_TENANT_ID}, true)`,
    );
    const rows = (await tx.execute(
      sql`select count(*)::int as n from ${sql.raw(table)} where ${where}`,
    )) as unknown as { n: number }[];
    return Number(rows[0]?.n ?? 0);
  });
}

// ---------------------------------------------------------------------------
// apply 正向 + AC1：子记录与父一致；不一致检测报告
// ---------------------------------------------------------------------------

describeDb("MT114 apply：子记录复合关联落地与不一致检测", () => {
  let report: Awaited<ReturnType<typeof runChildBackfill>>;
  let mismatchAgent = "";
  let orphanAgent = "";

  beforeAll(async () => {
    // 两个不一致源：父根在他租户（冲突）；父根缺失（孤儿）。
    mismatchAgent = `${runTag}-agent-mismatch`;
    orphanAgent = `${runTag}-agent-orphan`;
    await setup.execute(sql`
      insert into agents (id, name, type, configuration) values
        (${mismatchAgent}, 'MT114 Mismatch', 'built_in', '{}'::jsonb),
        (${orphanAgent}, 'MT114 Orphan', 'built_in', '{}'::jsonb)
      on conflict (id) do nothing
    `);
    await setup.execute(sql`
      insert into enterprise_tenants (id, name) values (${FOREIGN_TENANT}, 'MT114 Foreign')
      on conflict (id) do nothing
    `);
    await setup.execute(sql`
      insert into enterprise_workspaces (tenant_id, id, name)
      values (${FOREIGN_TENANT}, ${`${FOREIGN_TENANT}-ws`}, 'MT114 Foreign WS')
      on conflict (tenant_id, id) do nothing
    `);
    await setup.execute(sql`
      insert into enterprise_resources (tenant_id, id, workspace_id, kind, display_name)
      values (${FOREIGN_TENANT}, ${mismatchAgent}, ${`${FOREIGN_TENANT}-ws`}, 'bot', 'Claimed')
      on conflict (tenant_id, id) do nothing
    `);

    report = await runChildBackfill(setup, {
      mode: "apply",
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    });
  });

  itDb(
    "Bot 归属行落地：默认团队 + 锚点守门人；冲突/孤儿被检测报告零写入",
    async () => {
      const bots = report.kinds.find((k) => k.kind === "bot-ownership");
      expect(bots).toBeDefined();
      const ownership = (await setup.execute(sql`
      select workspace_id, owner_principal_id from enterprise_bot_ownership
      where tenant_id = ${ANCHOR_TENANT_ID} and agent_id = ${agentOne}
    `)) as unknown as { workspace_id: string; owner_principal_id: string }[];
      expect(ownership.length).toBe(1);
      expect(ownership[0].workspace_id).toBe(DEFAULT_WORKSPACE_ID);
      expect(ownership[0].owner_principal_id).toBeTruthy();
      // 不一致检测：两种原因都在报告里，锚点租户零写入。
      const mismatch = bots?.mismatches.find(
        (m) => m.recordId === mismatchAgent,
      );
      expect(mismatch?.reason).toBe("parent-tenant-mismatch");
      const orphan = bots?.mismatches.find((m) => m.recordId === orphanAgent);
      expect(orphan?.reason).toBe("pending-parent");
      const written = await setup.execute(sql`
      select 1 from enterprise_bot_ownership
      where tenant_id = ${ANCHOR_TENANT_ID} and agent_id in (${mismatchAgent}, ${orphanAgent})
    `);
      expect((written as unknown[]).length).toBe(0);
    },
  );

  itDb("会话子记录落地：threadId 语义键 + 属主主体", async () => {
    const rows = (await setup.execute(sql`
      select principal_id from enterprise_conversations
      where tenant_id = ${ANCHOR_TENANT_ID} and thread_id = ${craftOne}
    `)) as unknown as { principal_id: string }[];
    expect(rows.length).toBe(1);
    const ownerPrincipal = (await setup.execute(sql`
      select p.id from enterprise_principals p where p.user_id = ${userA}
    `)) as unknown as { id: string }[];
    expect(rows[0].principal_id).toBe(ownerPrincipal[0].id);
  });

  itDb("附件子记录落地：父频道归属 + 上传者授权", async () => {
    const rows = (await setup.execute(sql`
      select workspace_id, visibility from enterprise_resources
      where tenant_id = ${ANCHOR_TENANT_ID} and id = ${attachmentOne}
    `)) as unknown as { workspace_id: string; visibility: string | null }[];
    expect(rows.length).toBe(1);
    expect(rows[0].workspace_id).toBe(DEFAULT_WORKSPACE_ID);
    const grants = await countAsOperator(
      "enterprise_resource_grants",
      sql`resource_id = ${attachmentOne}`,
    );
    expect(grants).toBe(1);
  });

  itDb(
    "凭据子记录落地：company 分类 + 既有密文原样承接（明文不经手）",
    async () => {
      const rows = (await setup.execute(sql`
      select classification, workspace_id, owner_principal_id, kind, envelope, target
      from enterprise_credentials
      where tenant_id = ${ANCHOR_TENANT_ID} and id = ${credentialOne}
    `)) as unknown as {
        classification: string;
        workspace_id: string | null;
        owner_principal_id: string | null;
        kind: string;
        envelope: string;
        target: string;
      }[];
      expect(rows.length).toBe(1);
      expect(rows[0].classification).toBe("company");
      expect(rows[0].workspace_id).toBeNull();
      expect(rows[0].owner_principal_id).toBeNull();
      expect(rows[0].kind).toBe("connection");
      expect(rows[0].envelope).toContain("envelope");
      expect(rows[0].target).toContain("provider");
    },
  );

  itDb(
    "插件子记录：目录可解析 → install+connection 复合关联；不可解析 → 隔离零写入",
    async () => {
      const installId = `legacy-${pluginToolkit}-${userA}`;
      const install = (await setup.execute(sql`
      select catalog_id, workspace_id from enterprise_plugin_installs
      where tenant_id = ${ANCHOR_TENANT_ID} and id = ${installId}
    `)) as unknown as { catalog_id: string; workspace_id: string }[];
      expect(install.length).toBe(1);
      expect(install[0].catalog_id).toBe(pluginToolkit);
      expect(install[0].workspace_id).toBe(DEFAULT_WORKSPACE_ID);
      const connection = (await setup.execute(sql`
      select install_id from enterprise_plugin_connections
      where tenant_id = ${ANCHOR_TENANT_ID} and id = ${installId}
    `)) as unknown as { install_id: string }[];
      expect(connection.length).toBe(1);
      expect(connection[0].install_id).toBe(installId);

      const plugins = report.kinds.find((k) => k.kind === "plugin-connection");
      const quarantined = plugins?.mismatches.find(
        (m) => m.recordId === `${pluginToolkitUnknown}:${userB}`,
      );
      expect(quarantined?.reason).toBe("plugin-catalog-unresolvable");
      const leaked = await setup.execute(sql`
      select 1 from enterprise_plugin_connections
      where tenant_id = ${ANCHOR_TENANT_ID} and id = ${`legacy-${pluginToolkitUnknown}-${userB}`}
    `);
      expect((leaked as unknown[]).length).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------
// AC2：可中断续跑 + 幂等重跑
// ---------------------------------------------------------------------------

describeDb("MT114 AC2：可中断续跑且不重复写入", () => {
  let lateAgent = "";
  let lateCraft = "";

  beforeAll(async () => {
    lateAgent = `${runTag}-zzz-agent-late`;
    lateCraft = `${runTag}-zzz-craft-late`;
    await setup.execute(sql`
      insert into agents (id, name, type, configuration) values (${lateAgent}, 'MT114 Late', 'built_in', '{}'::jsonb)
      on conflict (id) do nothing
    `);
    await setup.execute(sql`
      insert into craft_sessions (id, user_id) values (${lateCraft}, ${userB})
      on conflict (id) do nothing
    `);
    // 迟到根记录：MT113 重跑接住（父前提保持真实链路）。
    await runRootBackfill(setup, {
      mode: "apply",
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    });
  });

  itDb("主动中断：running 相位 + 游标推进；续跑完成零重复", async () => {
    // chunkSize=1 且停 1 块：第一个 kind（bot-ownership）只吃一块。
    const interrupted = await runChildBackfill(setup, {
      mode: "apply",
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      chunkSize: 1,
      stopAfterChunks: 1,
    });
    const botsAfterStop = interrupted.kinds.find(
      (k) => k.kind === "bot-ownership",
    );
    expect(botsAfterStop?.phase).toBe("running");
    expect(botsAfterStop?.resumes).toBeGreaterThanOrEqual(2);

    const ownershipBefore = await countAsOperator(
      "enterprise_bot_ownership",
      sql`tenant_id = ${ANCHOR_TENANT_ID}`,
    );

    const resumed = await runChildBackfill(setup, {
      mode: "apply",
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    });
    for (const kind of resumed.kinds) {
      expect(kind.phase).toBe("completed");
    }
    // 续跑后归属行零重复。增量恰为两行：late agent（本段新种）+
    // orphan agent（本段 beforeAll 的 MT113 根重跑把它的父根补齐——
    // pending-parent 是事实状态不是终局，链路真实）。
    const ownershipAfter = await countAsOperator(
      "enterprise_bot_ownership",
      sql`tenant_id = ${ANCHOR_TENANT_ID}`,
    );
    expect(ownershipAfter).toBe(ownershipBefore + 2);
    const late = (await setup.execute(sql`
      select count(*)::int as n from enterprise_bot_ownership
      where tenant_id = ${ANCHOR_TENANT_ID} and agent_id = ${lateAgent}
    `)) as unknown as { n: number }[];
    expect(Number(late[0].n)).toBe(1);
  });

  itDb("幂等重跑：全量 apply 第二轮 applied 增量 0，行数不变", async () => {
    const before = await countAsOperator(
      "enterprise_conversations",
      sql`tenant_id = ${ANCHOR_TENANT_ID}`,
    );
    const again = await runChildBackfill(setup, {
      mode: "apply",
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    });
    const conversations = again.kinds.find((k) => k.kind === "conversation");
    expect(conversations?.applied).toBe(0);
    expect(conversations?.skippedExisting).toBeGreaterThan(0);
    const after = await countAsOperator(
      "enterprise_conversations",
      sql`tenant_id = ${ANCHOR_TENANT_ID}`,
    );
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// AC3：约束与校验双重——跨公司关联被数据库拒绝
// ---------------------------------------------------------------------------

describeDb("MT114 AC3：跨公司关联被数据库拒绝（约束半边）", () => {
  const expectCode = async (
    run: () => Promise<unknown>,
    code: string,
  ): Promise<void> => {
    try {
      await run();
    } catch (error) {
      // drizzle 把 PG 错误包在 cause 里——取到真正的驱动错误码才算证据。
      let probe: unknown = error;
      let pgCode = "";
      while (probe) {
        const carrier = probe as {
          code?: string;
          errno?: string;
          cause?: unknown;
        };
        // 两个属性都验：驱动错误 code 常是 ERR_POSTGRES_SERVER_ERROR，
        // SQLSTATE 在 errno——谁匹配 23xxx 谁是证据。
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

  itDb(
    "bot 归属：agent_id 全局唯一索引拒绝他公司认领同一 Bot（23505）",
    async () => {
      await expectCode(
        () =>
          setup.execute(sql`
          insert into enterprise_bot_ownership
            (tenant_id, agent_id, workspace_id, owner_principal_id, display_name, default_config)
          values (${FOREIGN_TENANT}, ${agentOne}, ${`${FOREIGN_TENANT}-ws`}, 'someone', 'Claim', '{}'::jsonb)
        `),
        "23505",
      );
    },
  );

  itDb("复合外键拒绝跨公司子记录：messages（23503）", async () => {
    await expectCode(
      () =>
        setup.execute(sql`
          insert into enterprise_messages (tenant_id, thread_id, seq, client_message_key, digest, role, content)
          values (${FOREIGN_TENANT}, ${craftOne}, 1, 'mt114-cross', 'digest', 'user', 'x')
        `),
      "23503",
    );
  });

  itDb(
    "复合外键拒绝跨公司插件连接：connection 引用他公司 install（23503）",
    async () => {
      const installId = `legacy-${pluginToolkit}-${userA}`;
      await expectCode(
        () =>
          setup.execute(sql`
          insert into enterprise_plugin_connections
            (tenant_id, id, install_id, bound_by, vendor_ref)
          values (${FOREIGN_TENANT}, 'mt114-cross-conn', ${installId}, 'someone', 'x')
        `),
        "23503",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// AC4：进度与计数校验报告
// ---------------------------------------------------------------------------

describeDb("MT114 AC4：持久进度报告与直接计数一致", () => {
  itDb(
    "五类齐全、completed、计数守恒（scanned=applied+skipped+mismatch）",
    async () => {
      const report = await childBackfillProgressReport(setup);
      expect(report.batchId).toBe(CHILD_BACKFILL_BATCH_ID);
      expect(report.missingKinds).toEqual([]);
      expect(report.entries.length).toBe(CHILD_BACKFILL_KINDS.length);
      for (const entry of report.entries) {
        expect(entry.phase).toBe("completed");
        expect(entry.scanned, `${entry.kind} 计数不守恒`).toBe(
          entry.applied + entry.skippedExisting + entry.mismatchReported,
        );
      }
      // 报告计数与库内归属行直接对照（Bot 归属行为例）。
      const bots = report.entries.find((e) => e.kind === "bot-ownership");
      const ownershipRows = await countAsOperator(
        "enterprise_bot_ownership",
        sql`tenant_id = ${ANCHOR_TENANT_ID}`,
      );
      expect(bots ? bots.applied + bots.skippedExisting : 0).toBe(
        ownershipRows,
      );
    },
  );
});
