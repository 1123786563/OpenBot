// server/tests/multitenancy/external-files-migration.test.ts
// MT118（Issue #161）：对象存储文件与产物的归属迁移（第 1/3 段——映射臂）。
//
// 验收事实源（Issue #161 四条；真实 PostgreSQL + 确定性 fake 对象存储——
// 票注「外部服务不可用时用确定性 fake 完成本地测试，并显式标记未验证项」）：
//   AC1 每类文件都有明确归属或进入隔离清单，没有隐式默认归属（四类闭集
//      全覆盖：可归属 → 映射三元组；属主成员资格零条/多条 → ambiguous
//      隔离；他租户 → mismatch 报告；附件父关联缺失 → 隔离）。
//   AC2 迁移幂等可续跑；失败不留下半迁移状态被业务读取（映射是确定性
//      纯函数——两次重算逐字段一致；工具零业务写入，行数前后钉死）。
//   AC3 迁移后授权与签名下载仍正确（映射不改键派生：同键取回字节与行内
//      sha256/size 一致；映射三元组与 DB 归属事实逐字相等；摘要不一致
//      = 未决项不是绿灯）。
//   AC4 输出逐类计数与抽样校验报告（scanned/mapped/quarantined + 抽样 +
//      隔离清单 + 复现命令 + 物理迁移接线缺口显式披露）。
//
// 前置诚实披露：blocked-by #98（MT055 产物与对象存储路径按归属隔离）未
// 交付——本工作区无已交付的物理分段方案可迁入；票面「迁移**或**建立映射」
// 允许映射臂，物理重排键留待 MT055 交付后接线（报告 strategy 字段披露）。
// #104（MT061 OpenMuse 文件面）已交付（openmuse-file-tenancy.ts 在库）。

import { createHash, randomUUID } from "node:crypto";
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
  buildExternalFilesOwnershipMap,
  type ObjectStorePort,
} from "../../src/enterprise/tenancy/external-files-migration";
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
      reason: `MT118 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
const FOREIGN_TENANT = "mt118-foreign";
const FOREIGN_WORKSPACE = "mt118-foreign-ws";

/** 确定性 fake 对象存储（键 → 字节；与 LocalObjectStore 的 get 同形）。 */
function fakeStore(): ObjectStorePort & {
  readonly put: (key: string, bytes: Uint8Array) => void;
  readonly keys: () => string[];
} {
  const backing = new Map<string, Uint8Array>();
  return {
    put(key, bytes) {
      backing.set(key, bytes);
    },
    keys: () => [...backing.keys()],
    async get(key) {
      return backing.get(key) ?? null;
    },
  };
}

let setup: Database;
const generatedDirs: string[] = [];
const store = fakeStore();

let runTag = "";
let anchorUser = "";
let ambiguousUser = "";
let foreignUser = "";
let fileAnchor = "";
let fileAnchorVersion = "";
let fileAnchorBytes = "";
let fileAmbiguousVersion = "";
let snapshotAnchor = "";
let snapshotAmbiguous = "";
let artifactAnchor = "";
let attachmentAnchorId = "";

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
  const dir = join("/tmp", `mt118-migration-${randomUUID().slice(0, 8)}`);
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
      "MT118 migration target refused: TEST_DATABASE_URL invalid",
    );
  }
  setup = createDatabase(enterpriseTestDatabaseUrlFrom(process.env), {
    max: 2,
  });

  runTag = `mt118-${randomUUID().slice(0, 8)}`;
  anchorUser = `${runTag}-anchor`;
  ambiguousUser = `${runTag}-ambiguous`;
  foreignUser = `${runTag}-foreign`;
  await setup.execute(sql`
    insert into users (id, email) values (${anchorUser}, ${`${runTag}-anchor@example.test`})
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into deployment_packages (tenant_id, source_path, checksum, loaded_at)
    values (${`${runTag}-deployment`}, '/packages/mt118', 'mt118-checksum', '2999-01-01T00:00:00Z')
    on conflict (tenant_id) do nothing
  `);
  // 链式预建表按共享库纪律条件重建（见 ensureTaskApplied 注释）。
  await ensureTaskApplied("MT112", "enterprise_deployment_anchors");

  await setup.execute(sql`
    insert into users (id, email) values
      (${ambiguousUser}, ${`${runTag}-ambiguous@example.test`}),
      (${foreignUser}, ${`${runTag}-foreign@example.test`})
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into enterprise_tenants (id, name) values (${FOREIGN_TENANT}, 'MT118 Foreign')
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into enterprise_workspaces (tenant_id, id, name) values
      (${FOREIGN_TENANT}, ${FOREIGN_WORKSPACE}, 'MT118 Foreign WS')
    on conflict (tenant_id, id) do nothing
  `);

  // 根回填（全体用户落 principal/member）+ 三态谱系。
  await runRootBackfill(setup, {
    mode: "apply",
    defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
  });
  const anchorPrincipal = (await setup.execute(sql`
    select p.id from enterprise_principals p where p.user_id = ${anchorUser}
  `)) as unknown as { id: string }[];
  const foreignPrincipal = (await setup.execute(sql`
    select p.id from enterprise_principals p where p.user_id = ${foreignUser}
  `)) as unknown as { id: string }[];
  await setup.execute(sql`
    insert into enterprise_memberships (tenant_id, principal_id, role)
    values (${FOREIGN_TENANT}, ${foreignPrincipal[0].id}, 'member')
    on conflict (tenant_id, principal_id) do nothing
  `);
  await setup.execute(sql`
    insert into enterprise_workspace_memberships (tenant_id, workspace_id, principal_id) values
      (${ANCHOR_TENANT_ID}, ${DEFAULT_WORKSPACE_ID}, ${anchorPrincipal[0].id}),
      (${FOREIGN_TENANT}, ${FOREIGN_WORKSPACE}, ${foreignPrincipal[0].id})
    on conflict (tenant_id, workspace_id, principal_id) do nothing
  `);

  // 类别一：OpenMuse 文件版本（锚点用户可归属；歧义用户隔离）。
  fileAnchor = `${runTag}-file-anchor`;
  fileAnchorVersion = `${runTag}-ver-anchor`;
  fileAnchorBytes = `${runTag} file bytes`;
  const anchorDigest = createHash("sha256")
    .update(fileAnchorBytes)
    .digest("hex");
  store.put(
    `openmuse-files/${anchorUser}/${fileAnchor}/${fileAnchorVersion}`,
    new TextEncoder().encode(fileAnchorBytes),
  );
  await setup.execute(sql`
    insert into openmuse_files (id, owner_user_id, name, mime_type, size, sha256)
    values (${fileAnchor}, ${anchorUser}, 'anchor.txt', 'text/plain', ${fileAnchorBytes.length}, ${anchorDigest})
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into openmuse_file_versions (version_id, file_id, byte_path, sha256)
    values (${fileAnchorVersion}, ${fileAnchor}, ${`openmuse-files/${anchorUser}/${fileAnchor}/${fileAnchorVersion}`}, ${anchorDigest})
    on conflict (version_id) do nothing
  `);
  const ambiguousFile = `${runTag}-file-ambiguous`;
  fileAmbiguousVersion = `${runTag}-ver-ambiguous`;
  const ambiguousBytes = new TextEncoder().encode(`${runTag} ambiguous bytes`);
  store.put(
    `openmuse-files/${ambiguousUser}/${ambiguousFile}/${fileAmbiguousVersion}`,
    ambiguousBytes,
  );
  const ambiguousDigest = createHash("sha256")
    .update(ambiguousBytes)
    .digest("hex");
  await setup.execute(sql`
    insert into openmuse_files (id, owner_user_id, name, mime_type, size, sha256)
    values (${ambiguousFile}, ${ambiguousUser}, 'ambiguous.txt', 'text/plain', ${ambiguousBytes.length}, ${ambiguousDigest})
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into openmuse_file_versions (version_id, file_id, byte_path, sha256)
    values (${fileAmbiguousVersion}, ${ambiguousFile}, ${`openmuse-files/${ambiguousUser}/${ambiguousFile}/${fileAmbiguousVersion}`}, ${ambiguousDigest})
    on conflict (version_id) do nothing
  `);

  // 类别二：Craft 快照（锚点可归属；歧义隔离）。
  const sessionAnchor = `${runTag}-craft-anchor`;
  const sessionAmbiguous = `${runTag}-craft-ambiguous`;
  await setup.execute(sql`
    insert into craft_sessions (id, user_id) values
      (${sessionAnchor}, ${anchorUser}),
      (${sessionAmbiguous}, ${ambiguousUser})
    on conflict (id) do nothing
  `);
  const snapshotBytes = new TextEncoder().encode(`${runTag} snapshot bytes`);
  snapshotAnchor = `${runTag}-snap-anchor`;
  snapshotAmbiguous = `${runTag}-snap-ambiguous`;
  store.put(
    `sandbox-snapshots/${runTag}-bot/${snapshotAnchor}.tar.gz`,
    snapshotBytes,
  );
  store.put(
    `sandbox-snapshots/${runTag}-bot/${snapshotAmbiguous}.tar.gz`,
    snapshotBytes,
  );
  await setup.execute(sql`
    insert into craft_snapshots (id, session_id, storage_path, size_bytes) values
      (${snapshotAnchor}, ${sessionAnchor}, ${`sandbox-snapshots/${runTag}-bot/${snapshotAnchor}.tar.gz`}, ${snapshotBytes.length}),
      (${snapshotAmbiguous}, ${sessionAmbiguous}, ${`sandbox-snapshots/${runTag}-bot/${snapshotAmbiguous}.tar.gz`}, ${snapshotBytes.length})
    on conflict (id) do nothing
  `);

  // 类别三：Workshop 产物（路径在沙箱工作区，映射面按 DB 事实）。
  // workshop_sessions.bot_id FK → agents：先落 Bot 行。
  await setup.execute(sql`
    insert into agents (id, name, type, configuration)
    values (${`${runTag}-bot`}, 'MT118 Bot', 'built_in', '{}'::jsonb)
    on conflict (id) do nothing
  `);
  const workshopChannel = `${runTag}-ws-channel`;
  await setup.execute(sql`
    insert into channels (id, name, description) values (${workshopChannel}, 'MT118 WS Ch', 'mt118')
    on conflict (id) do nothing
  `);
  const workshopSession = `${runTag}-ws-session`;
  await setup.execute(sql`
    insert into workshop_sessions (id, channel_id, bot_id, owner_user_id)
    values (${workshopSession}, ${workshopChannel}, ${`${runTag}-bot`}, ${anchorUser})
    on conflict (id) do nothing
  `);
  artifactAnchor = `${runTag}-artifact`;
  await setup.execute(sql`
    insert into workshop_artifacts (id, session_id, type, name, path, size_bytes)
    values (${artifactAnchor}, ${workshopSession}, 'file', 'report.csv', 'workspace/report.csv', 12)
    on conflict (id) do nothing
  `);

  // 类别四：附件（归属 = 第一批父频道关联；先跑第一批建立关联）。
  const attachmentChannel = `${runTag}-att-channel`;
  await setup.execute(sql`
    insert into channels (id, name, description) values (${attachmentChannel}, 'MT118 Att Ch', 'mt118')
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into channel_memberships (channel_id, user_id) values (${attachmentChannel}, ${anchorUser})
    on conflict (channel_id, user_id) do nothing
  `);
  const attBytes = `${runTag} attachment bytes`;
  const att = (await setup.execute(sql`
    insert into attachments (channel_id, uploaded_by, name, mime_type, size_bytes, bytes, attached_at)
    select ${attachmentChannel}, ${anchorUser}, 'mt118.txt', 'text/plain', ${attBytes.length}, ${`\\x${Buffer.from(attBytes).toString("hex")}`}::bytea, now()
    where not exists (
      select 1 from attachments where channel_id = ${attachmentChannel} and name = 'mt118.txt'
    )
    returning id::text
  `)) as unknown as { id: string }[];
  attachmentAnchorId = att[0].id;
  // 根回填已跑（频道晚种 → 附件根关联需第二批前重跑根回填 + 第一批）。
  await runRootBackfill(setup, {
    mode: "apply",
    defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
  });
  await runChildBackfill(setup, {
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
// AC1 + AC4：逐类归属映射 / 隔离清单 / 计数与抽样报告
// ---------------------------------------------------------------------------

describeDb("MT118 AC1/AC4：四类闭集的归属映射、隔离与逐类报告", () => {
  let report: Awaited<ReturnType<typeof buildExternalFilesOwnershipMap>>;

  beforeAll(async () => {
    report = await buildExternalFilesOwnershipMap(setup, {
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      store,
      // 抽样上限放大到全窗覆盖（源查询按 id 有序，抽样确定性可断言；
      // 报告默认 3 行抽样属生产口径，测试要逐行钉——共享库残留随轮次
      // 累积，小窗口会让逐行断言随轮次漂移）。
      sampleLimit: 5000,
    });
  });

  itDb(
    "四类齐全、无隐式默认归属（mapped + quarantined = scanned）",
    async () => {
      expect(report.categories.length).toBe(4);
      for (const category of report.categories) {
        expect(
          category.mapped + category.quarantined,
          `${category.category} 有隐式默认归属`,
        ).toBe(category.scanned);
      }
    },
  );

  itDb("OpenMuse 文件版本：锚点映射三元组；歧义属主隔离", async () => {
    const category = report.categories.find(
      (c) => c.category === "openmuse-file-version",
    );
    expect(category?.quarantinedEntries).toContainEqual({
      recordId: fileAmbiguousVersion,
      reason: "ambiguous-membership",
    });
    const sample = category?.samples.find(
      (s) => s.recordId === fileAnchorVersion,
    );
    expect(sample).toBeDefined();
    expect(sample?.tenantId).toBe(ANCHOR_TENANT_ID);
    expect(sample?.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
    expect(sample?.ownerUserId).toBe(anchorUser);
    expect(sample?.storageKey).toBe(
      `openmuse-files/${anchorUser}/${fileAnchor}/${fileAnchorVersion}`,
    );
  });

  itDb("Craft 快照：锚点映射；歧义属主隔离（键派生原样）", async () => {
    const category = report.categories.find(
      (c) => c.category === "craft-snapshot",
    );
    expect(category?.quarantinedEntries).toContainEqual({
      recordId: snapshotAmbiguous,
      reason: "ambiguous-membership",
    });
    const sample = category?.samples.find((s) => s.recordId === snapshotAnchor);
    expect(sample).toBeDefined();
    expect(sample?.tenantId).toBe(ANCHOR_TENANT_ID);
  });

  itDb(
    "Workshop 产物：按 DB 事实映射（沙箱路径非对象存储键，显式 unavailable）",
    async () => {
      const category = report.categories.find(
        (c) => c.category === "workshop-artifact",
      );
      const sample = category?.samples.find(
        (s) => s.recordId === artifactAnchor,
      );
      expect(sample).toBeDefined();
      expect(sample?.tenantId).toBe(ANCHOR_TENANT_ID);
      expect(sample?.digestOutcome).toBe("unavailable");
    },
  );

  itDb(
    "附件：归属 = 第一批父频道关联（锚点租户 + 资源行 workspace）",
    async () => {
      const category = report.categories.find(
        (c) => c.category === "attachment",
      );
      const sample = category?.samples.find(
        (s) => s.recordId === attachmentAnchorId,
      );
      expect(sample).toBeDefined();
      expect(sample?.tenantId).toBe(ANCHOR_TENANT_ID);
      expect(sample?.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
      expect(sample?.digestOutcome).toBe("size-match");
    },
  );

  itDb(
    "附件父关联缺失 → 隔离清单（不猜频道默认）；外租户属主 → mismatch 报告",
    async () => {
      // 未回填频道的附件（种子晚于第一批）：关联缺失隔离。
      const orphanChannel = `${runTag}-orphan-channel`;
      await setup.execute(sql`
        insert into channels (id, name, description) values (${orphanChannel}, 'MT118 Orphan Ch', 'mt118')
        on conflict (id) do nothing
      `);
      const orphanBytes = `${runTag} orphan bytes`;
      const orphan = (await setup.execute(sql`
        insert into attachments (channel_id, uploaded_by, name, mime_type, size_bytes, bytes, attached_at)
        select ${orphanChannel}, ${anchorUser}, 'orphan.txt', 'text/plain', ${orphanBytes.length}, ${`\\x${Buffer.from(orphanBytes).toString("hex")}`}::bytea, now()
        where not exists (
          select 1 from attachments where channel_id = ${orphanChannel} and name = 'orphan.txt'
        )
        returning id::text
      `)) as unknown as { id: string }[];
      // 外租户属主文件版本。
      const foreignFile = `${runTag}-file-foreign`;
      const foreignVersion = `${runTag}-ver-foreign`;
      const foreignBytes = new TextEncoder().encode(`${runTag} foreign bytes`);
      store.put(
        `openmuse-files/${foreignUser}/${foreignFile}/${foreignVersion}`,
        foreignBytes,
      );
      await setup.execute(sql`
        insert into openmuse_files (id, owner_user_id, name, mime_type, size, sha256)
        values (${foreignFile}, ${foreignUser}, 'foreign.txt', 'text/plain', ${foreignBytes.length}, ${createHash("sha256").update(foreignBytes).digest("hex")})
        on conflict (id) do nothing
      `);
      await setup.execute(sql`
        insert into openmuse_file_versions (version_id, file_id, byte_path, sha256)
        values (${foreignVersion}, ${foreignFile}, ${`openmuse-files/${foreignUser}/${foreignFile}/${foreignVersion}`}, ${createHash("sha256").update(foreignBytes).digest("hex")})
        on conflict (version_id) do nothing
      `);
      const rerun = await buildExternalFilesOwnershipMap(setup, {
        defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
        store,
        sampleLimit: 5000,
      });
      const attachments = rerun.categories.find(
        (c) => c.category === "attachment",
      );
      expect(attachments?.quarantinedEntries).toContainEqual({
        recordId: orphan[0].id,
        reason: "parent-association-missing",
      });
      const versions = rerun.categories.find(
        (c) => c.category === "openmuse-file-version",
      );
      expect(versions?.quarantinedEntries).toContainEqual({
        recordId: foreignVersion,
        reason: "parent-tenant-mismatch",
      });
      // 未决项如实携带。
      expect(rerun.openItems.length).toBeGreaterThanOrEqual(2);
    },
  );

  itDb("报告带逐类计数、抽样与复现命令；物理迁移缺口显式披露", () => {
    expect(report.strategy.arm).toBe("ownership-mapping");
    expect(report.strategy.physicalRelocation).toContain("MT055");
    expect(report.reproduce.command).toBe(
      "bun test server/tests/multitenancy/external-files-migration.test.ts",
    );
    for (const category of report.categories) {
      expect(category.samples.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// AC2：幂等可续跑 + 零业务写入（无半迁移状态可被读取）
// ---------------------------------------------------------------------------

describeDb("MT118 AC2：幂等可续跑；零业务写入", () => {
  itDb("两次重算逐字段一致；业务行数前后钉死", async () => {
    const counts = async (): Promise<number> => {
      const rows = (await setup.execute(sql`
        select
          (select count(*) from openmuse_file_versions) +
          (select count(*) from craft_snapshots) +
          (select count(*) from workshop_artifacts) +
          (select count(*) from attachments) as n
      `)) as unknown as { n: number }[];
      return Number(rows[0].n);
    };
    const before = await counts();
    const first = await buildExternalFilesOwnershipMap(setup, {
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      store,
    });
    const second = await buildExternalFilesOwnershipMap(setup, {
      defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
      store,
    });
    expect(second).toEqual(first);
    expect(await counts()).toBe(before);
    // 存储键集不被触碰（映射不改键派生）。
    expect(store.keys().length).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// AC3：授权与下载一致性（映射不破坏既有键派生与字节事实）
// ---------------------------------------------------------------------------

describeDb("MT118 AC3：下载与授权事实一致", () => {
  itDb(
    "同键取回字节与行内 sha256 一致；摘要不一致 = 未决项不是绿灯",
    async () => {
      const report = await buildExternalFilesOwnershipMap(setup, {
        defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
        store,
        sampleLimit: 5000,
      });
      const versions = report.categories.find(
        (c) => c.category === "openmuse-file-version",
      );
      const sample = versions?.samples.find(
        (s) => s.recordId === fileAnchorVersion,
      );
      expect(sample?.digestOutcome).toBe("match");
      const snapshots = report.categories.find(
        (c) => c.category === "craft-snapshot",
      );
      const snapSample = snapshots?.samples.find(
        (s) => s.recordId === snapshotAnchor,
      );
      expect(snapSample?.digestOutcome).toBe("size-match");

      // 摘要不一致注入：行内 sha256 与端口字节错开 → mismatch + 未决项。
      const tampered = `${runTag}-ver-tampered`;
      const tamperedFile = `${runTag}-file-tampered`;
      const tamperedBytes = new TextEncoder().encode(`${runTag} tampered`);
      store.put(
        `openmuse-files/${anchorUser}/${tamperedFile}/${tampered}`,
        tamperedBytes,
      );
      await setup.execute(sql`
        insert into openmuse_files (id, owner_user_id, name, mime_type, size, sha256)
        values (${tamperedFile}, ${anchorUser}, 'tampered.txt', 'text/plain', ${tamperedBytes.length}, ${"0".repeat(64)})
        on conflict (id) do nothing
      `);
      await setup.execute(sql`
        insert into openmuse_file_versions (version_id, file_id, byte_path, sha256)
        values (${tampered}, ${tamperedFile}, ${`openmuse-files/${anchorUser}/${tamperedFile}/${tampered}`}, ${"0".repeat(64)})
        on conflict (version_id) do nothing
      `);
      const flagged = await buildExternalFilesOwnershipMap(setup, {
        defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
        store,
        sampleLimit: 5000,
      });
      expect(
        flagged.openItems.some(
          (item) =>
            item.recordId === tampered && item.reason === "digest-mismatch",
        ),
      ).toBe(true);
    },
  );
});
