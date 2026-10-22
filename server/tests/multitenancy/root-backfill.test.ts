// server/tests/multitenancy/root-backfill.test.ts
// MT113（Issue #156）：历史根记录归属回填并保持既有个人授权。
//
// 验收事实源（Issue #156 四条，逐条对应 describe；真实 PostgreSQL——
// MT112 锚点经真实 MT003 工具落地，遗留数据真实入库，回填真实执行；
// 验证读走受限角色与真实判定面，绝不回退开发库、缺 env 显式 skip）：
//   AC1 回填后历史数据可见范围与回填前一致（个人权限未被放宽为团队
//      可见）：资源行一律 visibility='private'；可见集合由 grants 逐主体
//      复刻（部署级=全体用户、频道=成员、个人类=属主）；真实资源策略
//      判定面验证「同公司同团队但无 grant 的成员 → canonical not-found，
//      有 grant 的属主 → allow」。
//   AC2 无法唯一归属的记录进入隔离清单并阻断相关启用：跨租户认领冲突
//      的记录零写入进 quarantined；rootBackfillReadiness ready=false。
//   AC3 回填幂等可重跑，且以 dry-run 预览差异：dry-run 零写入；重复
//      apply 第二轮 wroteRows=0、终态一致。
//   AC4 输出计数与抽样对照的一致性报告：分 kind 计数与直接 SQL 计数
//      对照一致；逐 kind 抽样带授权主体数。
//
// 前置诚实披露：票面前置 #117（MT074 历史余额迁移）无已交付契约（wave16
// 票号映射分歧，协调器裁决按 A 案执行并披露）；MT113 不消费余额迁移
// 产物，仅共享 MT112 锚点（本套件真实落地锚点）。

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
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import { isResourceNotFoundVerdict } from "../../src/enterprise/tenancy/not-found-semantics";
import { createResourcePolicyService } from "../../src/enterprise/tenancy/resource-policy";
import {
  ROOT_BACKFILL_REFUSED,
  rootBackfillReadiness,
  runRootBackfill,
} from "../../src/enterprise/tenancy/root-backfill";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";

// ---------------------------------------------------------------------------
// 环境探针：缺 env 显式 skip（带理由），绝不静默回退
// ---------------------------------------------------------------------------

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const required = [
    "TEST_DATABASE_URL",
    "ENTERPRISE_TEST_SETUP_DATABASE_URL",
    "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
    "ENTERPRISE_TEST_DATA_DATABASE_URL",
    "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `MT113 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    enterpriseRuntimeDatabaseUrlFrom("directory", process.env);
    enterpriseRuntimeDatabaseUrlFrom("data", process.env);
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

// MT112 锚点的固定常量（迁移语句本体，legacy-anchor.test.ts 同源）。
const ANCHOR_TENANT_ID = "ent-legacy-original";
const DEFAULT_WORKSPACE_ID = "ent-legacy-default-team";

/** setup/属主通道（迁移语义写入）。 */
let setup: Database;
/** 受限 data 通道（验证读）。 */
let data: DataDatabase;
/** 受限 directory 通道（受信 scope 签发）。 */
let directory: DirectoryDatabase;
/** 受限 operator 通道（授权行全量计数——grants 的 data 读是 self-restrictive）。 */
let operator: OperatorDatabase;
const generatedDirs: string[] = [];

/** 本轮唯一标记：同一测试库跨轮重跑不与既有遗留行/资源行碰撞。 */
let runTag = "";
let userEarly = "";
let userA = "";
let userB = "";
let anchorUserId = "";
/** MT112 锚定的最早用户（租户 admin + 默认团队成员，策略判定的探针主体）。 */
let agentBot = "";
let agentBot2 = "";
let channelFull = "";
let channelEmpty = "";
let credentialRow = "";
let craftSession = "";
let expertInstall = "";

beforeAll(async () => {
  if (!ENV.ok) return;
  if (!resolveTestDatabaseTarget(process.env).ok) {
    throw new Error(
      "MT113 migration target refused: TEST_DATABASE_URL invalid",
    );
  }

  setup = createDatabase(enterpriseTestDatabaseUrlFrom(process.env), {
    max: 2,
  });
  data = (await verifyDataDatabase(
    createDatabase(enterpriseRuntimeDatabaseUrlFrom("data", process.env), {
      max: 1,
    }),
  )) as DataDatabase;
  directory = (await verifyDirectoryDatabase(
    createDatabase(enterpriseRuntimeDatabaseUrlFrom("directory", process.env), {
      max: 1,
    }),
  )) as DirectoryDatabase;
  operator = (await verifyOperatorDatabase(
    createDatabase(enterpriseRuntimeDatabaseUrlFrom("operator", process.env), {
      max: 1,
    }),
  )) as OperatorDatabase;

  runTag = `mt113-${randomUUID().slice(0, 8)}`;
  userEarly = `${runTag}-user-early`;
  userA = `${runTag}-user-a`;
  userB = `${runTag}-user-b`;

  // 遗留身份：三个用户（early 用固定纪元时间，是全库最早——MT112 锚点
  // 成员锚定的确定性规则；此前各轮的行都晚于它，跨轮稳定）。
  await setup.execute(sql`
    insert into users (id, email, name, created_at, updated_at) values
      (${userEarly}, ${`${runTag}-early@example.test`}, 'MT113 Early', '2019-01-01T00:00:00Z', '2019-01-01T00:00:00Z'),
      (${userA}, ${`${runTag}-a@example.test`}, 'MT113 A', now(), now()),
      (${userB}, ${`${runTag}-b@example.test`}, 'MT113 B', now(), now())
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into deployment_packages (tenant_id, source_path, checksum, loaded_at)
    values (${`${runTag}-deployment`}, '/packages/mt113', 'mt113-checksum', '2019-01-01T00:00:00Z')
    on conflict (tenant_id) do nothing
  `);

  // MT112 锚点经真实 MT003 工具（幂等：已应用则 up-to-date）。
  const dir = join("/tmp", `mt113-migration-${randomUUID().slice(0, 8)}`);
  generatedDirs.push(dir);
  const generation = await runMigrateTest(["generate", "MT112", "--out", dir], {
    environment: process.env,
    out: () => {},
  });
  if (generation.kind !== "generated") {
    throw new Error(`MT112 generate failed: ${JSON.stringify(generation)}`);
  }
  const manifestPath = join(dir, "MT112", "manifest.json");
  const applied: RunOutcome = await runMigrateTest(
    ["migrate", "MT112", "--apply", "--manifest", manifestPath],
    { environment: process.env, out: () => {} },
  );
  if (!["applied", "up-to-date"].includes(applied.kind)) {
    throw new Error(`MT112 apply failed: ${JSON.stringify(applied)}`);
  }

  // 锚点用户 = MT112 实际锚定的 tenant_admin（读真实成员行，不按规则
  // 重算——跨轮重跑时最早用户可能变化，锚点行是幂等事实）。
  const anchorRows = (await setup.execute(sql`
    select p.user_id as user_id
    from enterprise_memberships m
    join enterprise_principals p on p.id = m.principal_id
    where m.tenant_id = 'ent-legacy-original' and m.role = 'tenant_admin'
    limit 1
  `)) as unknown as { user_id: string }[];
  anchorUserId = anchorRows[0]?.user_id ?? "";

  // 遗留业务根记录（本轮唯一 id）。
  agentBot = `${runTag}-agent-1`;
  agentBot2 = `${runTag}-agent-2`;
  await setup.execute(sql`
    insert into agents (id, name, type, configuration, created_at, updated_at) values
      (${agentBot}, 'MT113 Bot One', 'built_in', '{}'::jsonb, now(), now()),
      (${agentBot2}, 'MT113 Bot Two', 'built_in', '{}'::jsonb, now(), now())
    on conflict (id) do nothing
  `);
  channelFull = `${runTag}-channel-full`;
  channelEmpty = `${runTag}-channel-empty`;
  await setup.execute(sql`
    insert into channels (id, name, description, created_at, updated_at) values
      (${channelFull}, 'MT113 Channel', 'mt113', now(), now()),
      (${channelEmpty}, 'MT113 Channel Empty', 'mt113', now(), now())
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into channel_memberships (channel_id, user_id) values
      (${channelFull}, ${userA}), (${channelFull}, ${userB})
    on conflict (channel_id, user_id) do nothing
  `);
  const credRows = (await setup.execute(sql`
    insert into credentials (kind, provider, encrypted_value, key_id, metadata)
    values ('model', ${`${runTag}-provider`}, 'mt113-envelope', ${`${runTag}-key`}, '{}'::jsonb)
    returning id::text
  `)) as unknown as { id: string }[];
  credentialRow = credRows[0].id;
  craftSession = `${runTag}-craft-1`;
  await setup.execute(sql`
    insert into craft_sessions (id, user_id) values (${craftSession}, ${userA})
    on conflict (id) do nothing
  `);
  expertInstall = `${runTag}-install-1`;
  await setup.execute(sql`
    insert into expert_installs (id, expert_slug, agent_id, owner_user_id)
    values (${expertInstall}, 'mt113-expert', ${agentBot2}, ${userB})
    on conflict (id) do nothing
  `);
}, 60000);

afterAll(async () => {
  for (const dir of generatedDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  if (setup) setup.$client.close();
  if (data) data.$client.close();
  if (directory) directory.$client.close();
  if (operator) operator.$client.close();
}, 60000);

/** 受限 data 角色在锚点租户 pin 下的资源行读取（RLS 真路径）。 */
async function readResourceRowsAsData(tenantId: string): Promise<
  readonly {
    id: string;
    kind: string;
    visibility: string | null;
    status: string;
  }[]
> {
  return data.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${tenantId}, true)`,
    );
    const rows = (await tx.execute(sql`
      select id, kind, visibility, status from enterprise_resources order by id
    `)) as unknown as {
      id: string;
      kind: string;
      visibility: string | null;
      status: string;
    }[];
    return rows;
  });
}

/**
 * 授权行计数：operator 通道（grants 的 data 读带 self-restrictive 策略
 * ——逐主体可见是设计本身；全量计数是回填对账面，走 operator 租户读）。
 */
async function countGrantsAsOperator(
  tenantId: string,
  resourceId: string,
): Promise<number> {
  return operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${tenantId}, true)`,
    );
    const rows = (await tx.execute(sql`
      select count(*)::int as n from enterprise_resource_grants
      where tenant_id = ${tenantId} and resource_id = ${resourceId}
    `)) as unknown as { n: number }[];
    return Number(rows[0]?.n ?? 0);
  });
}

// ---------------------------------------------------------------------------
// AC3 前半：dry-run 预览差异（零写入）
// ---------------------------------------------------------------------------

describeDb("MT113 AC3：dry-run 预览差异，零写入", () => {
  itDb("dry-run 报告计划量且库内行数不变", async () => {
    const before = await readResourceRowsAsData(ANCHOR_TENANT_ID);
    const report = await runRootBackfill(setup, {
      mode: "dry-run",
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    });
    expect(report.mode).toBe("dry-run");
    expect(report.wroteRows).toBe(0);
    expect(report.anchorTenantId).toBe(ANCHOR_TENANT_ID);
    // 本轮种子已计入计划（预览的就是即将发生的差异）。
    const bots = report.kinds.find((k) => k.kind === "bot");
    expect(bots?.attributedNew ?? 0).toBeGreaterThan(0);
    const after = await readResourceRowsAsData(ANCHOR_TENANT_ID);
    expect(after.length).toBe(before.length);
  });

  itDb("锚点缺失的默认团队被响亮拒绝（不猜）", async () => {
    await expect(
      runRootBackfill(setup, {
        mode: "dry-run",
        defaultWorkspaceId: "ent-somewhere-else",
      }),
    ).rejects.toThrow(ROOT_BACKFILL_REFUSED);
  });
});

// ---------------------------------------------------------------------------
// apply + AC1：归属与既有个人授权保持
// ---------------------------------------------------------------------------

describeDb("MT113 apply：归属落地且可见范围不变", () => {
  let report: Awaited<ReturnType<typeof runRootBackfill>>;

  beforeAll(async () => {
    report = await runRootBackfill(setup, {
      mode: "apply",
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    });
  });

  itDb("本轮种子全部归属：默认团队 + private + active", async () => {
    expect(report.wroteRows).toBeGreaterThan(0);
    const rows = await readResourceRowsAsData(ANCHOR_TENANT_ID);
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of [
      agentBot,
      channelFull,
      channelEmpty,
      credentialRow,
      craftSession,
      expertInstall,
    ]) {
      const row = byId.get(id);
      expect(row, `resource row missing for ${id}`).toBeDefined();
      expect(row?.kind).toBeTruthy();
      expect(row?.visibility).toBe("private");
      expect(row?.status).toBe("active");
    }
    expect(byId.get(agentBot)?.kind).toBe("bot");
    expect(byId.get(channelFull)?.kind).toBe("channel");
    expect(byId.get(credentialRow)?.kind).toBe("credential");
    expect(byId.get(craftSession)?.kind).toBe("craft-session");
    expect(byId.get(expertInstall)?.kind).toBe("marketplace-install");
  });

  itDb("AC1 授权复刻：部署级=全体用户、频道=成员、个人类=属主", async () => {
    const totalUsers = (await setup.execute(
      sql`select count(*)::int as n from users`,
    )) as unknown as { n: number }[];
    const userCount = Number(totalUsers[0].n);
    // Bot：全体用户（requireUser 可见面的如实复刻）。
    expect(await countGrantsAsOperator(ANCHOR_TENANT_ID, agentBot)).toBe(
      userCount,
    );
    // 频道：仅成员（userA/userB），空频道=0（零授权是既有事实）。
    expect(await countGrantsAsOperator(ANCHOR_TENANT_ID, channelFull)).toBe(2);
    expect(await countGrantsAsOperator(ANCHOR_TENANT_ID, channelEmpty)).toBe(0);
    // 个人类：只属主。
    expect(await countGrantsAsOperator(ANCHOR_TENANT_ID, craftSession)).toBe(1);
    expect(await countGrantsAsOperator(ANCHOR_TENANT_ID, expertInstall)).toBe(
      1,
    );
    expect(await countGrantsAsOperator(ANCHOR_TENANT_ID, credentialRow)).toBe(
      userCount,
    );
  });

  itDb("AC1 主体落地：成员一律 member 角色，回填零新增管理员", async () => {
    // 基线是 MT112 自己锚定的 tenant_admin 集合（历史上重复 apply 可能
    // 留有多于一个——那是 MT112 幂等行的既有事实）；本 AC 钉的是回填
    // 行为零新增管理员，member 角色才是回填的唯一产物。
    const before = (await setup.execute(sql`
      select count(*)::int as n from enterprise_memberships
      where tenant_id = ${ANCHOR_TENANT_ID} and role = 'tenant_admin'
    `)) as unknown as { n: number }[];
    await runRootBackfill(setup, {
      mode: "apply",
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    });
    const after = (await setup.execute(sql`
      select count(*)::int as n from enterprise_memberships
      where tenant_id = ${ANCHOR_TENANT_ID} and role = 'tenant_admin'
    `)) as unknown as { n: number }[];
    expect(Number(after[0].n)).toBe(Number(before[0].n));
    const members = (await setup.execute(sql`
      select count(*)::int as n from enterprise_memberships
      where tenant_id = ${ANCHOR_TENANT_ID} and role = 'member'
    `)) as unknown as { n: number }[];
    expect(Number(members[0].n)).toBeGreaterThanOrEqual(3);
  });

  itDb(
    "AC1 真实判定面：无 grant 的同公司同团队成员 → canonical not-found；有 grant → allow",
    async () => {
      // 锚点用户（tenant_admin + 默认团队成员）：对 craft-session（属主
      // userA，只授 userA）没有 grant → not-found（个人权限未放宽为团队
      // 可见）；对 bot（全员 grant）→ allow。
      expect(anchorUserId).toBeTruthy();
      const resolver = createScopeResolver(directory, {
        authenticate: async () => ({
          actorId: anchorUserId,
          entrypoint: "web",
        }),
        selectTenant: () => ANCHOR_TENANT_ID,
        selectWorkspace: () => DEFAULT_WORKSPACE_ID,
      });
      const scope = await resolver.resolve(new Request("http://mt113.test/"));
      const policy = createResourcePolicyService(data);
      const denied = await policy.decide(scope, craftSession);
      expect(denied.outcome).toBe("deny");
      expect(isResourceNotFoundVerdict(denied)).toBe(true);
      const allowed = await policy.decide(scope, agentBot);
      expect(allowed.outcome).toBe("allow");
    },
  );
});

// ---------------------------------------------------------------------------
// AC2：无法唯一归属 → 隔离清单 + 阻断
// ---------------------------------------------------------------------------

describeDb("MT113 AC2：跨租户认领冲突进隔离清单并阻断启用", () => {
  const foreignTenant = `mt113-foreign-${runTag || "x"}`;
  let conflictedAgent = "";

  beforeAll(async () => {
    conflictedAgent = `${runTag}-agent-conflicted`;
    await setup.execute(sql`
      insert into agents (id, name, type, configuration, created_at, updated_at) values
        (${conflictedAgent}, 'MT113 Conflicted', 'built_in', '{}'::jsonb, now(), now())
      on conflict (id) do nothing
    `);
    // 他租户已认领该 id：归属不唯一。
    await setup.execute(sql`
      insert into enterprise_tenants (id, name) values (${foreignTenant}, 'MT113 Foreign')
      on conflict (id) do nothing
    `);
    await setup.execute(sql`
      insert into enterprise_workspaces (tenant_id, id, name)
      values (${foreignTenant}, ${`${foreignTenant}-ws`}, 'MT113 Foreign WS')
      on conflict (tenant_id, id) do nothing
    `);
    await setup.execute(sql`
      insert into enterprise_resources (tenant_id, id, workspace_id, kind, display_name, status)
      values (${foreignTenant}, ${conflictedAgent}, ${`${foreignTenant}-ws`}, 'bot', 'Claimed', 'active')
      on conflict (tenant_id, id) do nothing
    `);
  });

  itDb("冲突记录零写入进 quarantined；就绪闸 ready=false 阻断", async () => {
    const report = await runRootBackfill(setup, {
      mode: "apply",
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    });
    const hit = report.quarantined.find((q) => q.recordId === conflictedAgent);
    expect(hit).toBeDefined();
    expect(hit?.reason).toBe("claimed-by-another-tenant");
    // 锚点租户里没有它的行（零写入、不猜）。
    const rows = await readResourceRowsAsData(ANCHOR_TENANT_ID);
    expect(rows.some((row) => row.id === conflictedAgent)).toBe(false);

    const readiness = await rootBackfillReadiness(setup, DEFAULT_WORKSPACE_ID);
    expect(readiness.ready).toBe(false);
    expect(
      readiness.quarantined.some((q) => q.recordId === conflictedAgent),
    ).toBe(true);
  });

  itDb("清理冲突后就绪恢复（隔离不是永久状态，是事实状态）", async () => {
    // 清掉全部跨租户认领（本套件历轮与同库他套件的冲突夹具——就绪是
    // 全库事实状态，按事实清理到零冲突）。
    await setup.execute(sql`
      delete from enterprise_resources
      where tenant_id <> ${ANCHOR_TENANT_ID} and kind = 'bot'
    `);
    const readiness = await rootBackfillReadiness(setup, DEFAULT_WORKSPACE_ID);
    expect(readiness.ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC3 后半：幂等重跑 + AC4 计数抽样报告
// ---------------------------------------------------------------------------

describeDb("MT113 AC3/AC4：幂等重跑与计数抽样一致性", () => {
  itDb(
    "重复 apply：第二轮 wroteRows=0，alreadyPresent 接住全部种子，终态一致",
    async () => {
      // 紧邻双跑：第一轮吸收在途数据，第二轮必须零写入。
      await runRootBackfill(setup, {
        mode: "apply",
        defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      });
      const snapshotBefore = await readResourceRowsAsData(ANCHOR_TENANT_ID);
      const report = await runRootBackfill(setup, {
        mode: "apply",
        defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      });
      expect(report.wroteRows).toBe(0);
      for (const counters of report.kinds) {
        expect(counters.attributedNew).toBe(0);
        expect(counters.quarantined).toBe(0);
      }
      const snapshotAfter = await readResourceRowsAsData(ANCHOR_TENANT_ID);
      expect(snapshotAfter.length).toBe(snapshotBefore.length);
    },
  );

  itDb("AC4 计数与直接 SQL 计数一致；抽样带授权主体数", async () => {
    const report = await runRootBackfill(setup, {
      mode: "dry-run",
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
    });
    // 逐 kind：scanned = attributedNew + alreadyPresent + quarantined。
    for (const counters of report.kinds) {
      expect(counters.scanned, `${counters.kind} 计数不守恒`).toBe(
        counters.attributedNew + counters.alreadyPresent + counters.quarantined,
      );
    }
    // 抽样存在且授权主体数与受限读一致。
    expect(report.samples.length).toBeGreaterThan(0);
    for (const sample of report.samples) {
      const direct = await countGrantsAsOperator(
        ANCHOR_TENANT_ID,
        sample.recordId,
      );
      expect(sample.grantPrincipals).toBe(direct);
    }
  });
});
