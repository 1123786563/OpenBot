// server/tests/multitenancy/quarantine-list.test.ts
// MT120（Issue #163）：无法归属外部状态的隔离清单与启用阻断。
//
// 真实 PostgreSQL（openbot_enterprise_* 专用库）+ 受限 ob_ent_* 角色 +
// 真实 MT003 工具建表（MT120 注册表项）上钉死票面四条验收；缺 env 显式
// skip、skipped 不计通过：
//   AC1 隔离清单列出对象、原因、发现时间与建议处置，可被运维查看
//       （readQuarantineList 经受限 data 通道 + RLS）；
//   AC2 清单非空 ⇒ 就绪判定失败并给出具体条目（与启动就绪强制同纪律：
//       结构化记录、一次列全；处置后我的条目离开 open 集）；
//   AC3 处置（归属/销毁）后清单更新且处置留审计（business 域审计事件
//       先行落账）；
//   AC4 反向：assign 无显式目标拒绝；非 tenant_admin 拒绝；扫描零业务
//       写入；建议处置永不自动执行；重扫幂等；活推导移出记
//       cleared-upstream。
// 共享库纪律：基线 open 集（他套件残留）先快照，断言一律做差集——不
// 假设库上只有本套件的条目。

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
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import {
  applyQuarantineReadinessVerdict,
  evaluateMultitenancyQuarantineReadiness,
  evaluateQuarantineReadiness,
  QUARANTINE_ADMIN_REQUIRED,
  QUARANTINE_ASSIGN_TARGET_REQUIRED,
  readQuarantineList,
  resolveQuarantineItem,
  runQuarantineScan,
} from "../../src/enterprise/tenancy/quarantine-list";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";

const ENV_OK =
  !!process.env.ENTERPRISE_TEST_DIRECTORY_DATABASE_URL?.trim() &&
  !!process.env.ENTERPRISE_TEST_DATA_DATABASE_URL?.trim() &&
  !!process.env.ENTERPRISE_TEST_OPERATOR_DATABASE_URL?.trim() &&
  resolveTestDatabaseTarget(process.env).ok;
const _itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV_OK
    ? test(name, fn)
    : test.skip(
        `${name} [skipped: dedicated enterprise test database env absent]`,
        fn,
      )) as typeof test;
const describeDb = ENV_OK ? describe : describe.skip;

/** MT112 固定锚点产物（legacy-anchor 同款常量）。 */
const ANCHOR_TENANT_ID = "ent-legacy-original";
const ANCHOR_WORKSPACE_ID = "ent-legacy-default-team";

let setup: Database;
let data: DataDatabase;
let directory: DirectoryDatabase;
let operator: OperatorDatabase;
let runTag = "";
let anchorAdminUser = "";
let memberUser = "";
let orphanUser = "";
let otherTenantId = "";
let claimedAgentId = "";
let orphanFileId = "";
let orphanVersionId = "";
const generatedDirs: string[] = [];

/** 真实签发（MT005 resolver：成员资格 DB 重验，头只做选择）。 */
let scopeFor: (
  user: string,
  tenant: string,
  workspace: string,
) => Promise<PlatformScope>;

beforeAll(async () => {
  if (!ENV_OK) return;
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

  runTag = `mt120-${randomUUID().slice(0, 8)}`;

  // MT112 锚点（幂等：已应用则 up-to-date；锚点租户/默认团队是固定 id）。
  const dir = join("/tmp", `mt120-migration-${randomUUID().slice(0, 8)}`);
  generatedDirs.push(dir);
  const generation = await runMigrateTest(["generate", "MT112", "--out", dir], {
    environment: process.env,
    out: () => {},
  });
  if (generation.kind !== "generated") {
    throw new Error(`MT112 generate failed: ${JSON.stringify(generation)}`);
  }
  const applied: RunOutcome = await runMigrateTest(
    [
      "migrate",
      "MT112",
      "--apply",
      "--manifest",
      join(dir, "MT112", "manifest.json"),
    ],
    { environment: process.env, out: () => {} },
  );
  if (!["applied", "up-to-date"].includes(applied.kind)) {
    throw new Error(`MT112 apply failed: ${JSON.stringify(applied)}`);
  }
  // MT120 隔离表（注册表权威形状；journal 已记账的库 up-to-date 短路）。
  const dir120 = join("/tmp", `mt120-migration-${randomUUID().slice(0, 8)}`);
  generatedDirs.push(dir120);
  const generation120 = await runMigrateTest(
    ["generate", "MT120", "--out", dir120],
    { environment: process.env, out: () => {} },
  );
  if (generation120.kind !== "generated") {
    throw new Error(`MT120 generate failed: ${JSON.stringify(generation120)}`);
  }
  const applied120 = await runMigrateTest(
    [
      "migrate",
      "MT120",
      "--apply",
      "--manifest",
      join(dir120, "MT120", "manifest.json"),
    ],
    { environment: process.env, out: () => {} },
  );
  if (!["applied", "up-to-date"].includes(applied120.kind)) {
    throw new Error(`MT120 apply failed: ${JSON.stringify(applied120)}`);
  }

  // 锚点租户的实际 tenant_admin（MT112 幂等事实，不按规则重算）。
  const adminRows = (await setup.execute(sql`
    select p.user_id as user_id
    from enterprise_memberships m
    join enterprise_principals p on p.id = m.principal_id
    where m.tenant_id = ${ANCHOR_TENANT_ID} and m.role = 'tenant_admin'
    order by p.user_id
    limit 1
  `)) as unknown as { user_id: string }[];
  anchorAdminUser = adminRows[0]?.user_id ?? "";
  if (!anchorAdminUser) {
    throw new Error("MT120 fixture: anchor tenant has no tenant_admin row");
  }

  // 本套件自有身份：普通成员（查看面）+ 无 principal 的孤儿属主（external-file 源）。
  memberUser = `${runTag}-member`;
  orphanUser = `${runTag}-orphan`;
  otherTenantId = `${runTag}-other-company`;
  await setup.execute(sql`
    insert into users (id, email, name) values
      (${memberUser}, ${`${runTag}-member@example.test`}, 'MT120 Member'),
      (${orphanUser}, ${`${runTag}-orphan@example.test`}, 'MT120 Orphan')
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into enterprise_principals (id, user_id)
    values (${`${runTag}-principal-member`}, ${memberUser})
    on conflict (user_id) do nothing
  `);
  await setup.execute(sql`
    insert into enterprise_memberships (tenant_id, principal_id, role)
    values (${ANCHOR_TENANT_ID}, ${`${runTag}-principal-member`}, 'member')
    on conflict (tenant_id, principal_id) do nothing
  `);
  await setup.execute(sql`
    insert into enterprise_workspace_memberships (tenant_id, workspace_id, principal_id)
    values (${ANCHOR_TENANT_ID}, ${ANCHOR_WORKSPACE_ID}, ${`${runTag}-principal-member`})
    on conflict (tenant_id, workspace_id, principal_id) do nothing
  `);
  // 他租户（跨租户认领的认领方 + assign 处置的显式目标）。
  await setup.execute(sql`
    insert into enterprise_tenants (id, name)
    values (${otherTenantId}, 'MT120 Other Company')
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into enterprise_workspaces (tenant_id, id, name)
    values (${otherTenantId}, ${`${runTag}-other-team`}, 'MT120 Other Team')
    on conflict (tenant_id, id) do nothing
  `);

  // 源 1（root-record）：agents 行已被他租户的 enterprise_resources 认领。
  claimedAgentId = `${runTag}-agent-claimed`;
  await setup.execute(sql`
    insert into agents (id, name, type, configuration, created_at, updated_at)
    values (${claimedAgentId}, 'MT120 Claimed Bot', 'built_in', '{}'::jsonb, now(), now())
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into enterprise_resources (tenant_id, id, workspace_id, kind, display_name, visibility, status)
    values (${otherTenantId}, ${claimedAgentId}, ${`${runTag}-other-team`}, 'bot', 'MT120 foreign claim', 'private', 'active')
    on conflict (tenant_id, id) do nothing
  `);

  // 源 2（external-file）：孤儿属主的 openmuse 文件版本（owner 无 principal）。
  orphanFileId = `${runTag}-file`;
  orphanVersionId = `${runTag}-ver`;
  await setup.execute(sql`
    insert into openmuse_files (id, owner_user_id, name, mime_type, size, sha256)
    values (${orphanFileId}, ${orphanUser}, 'MT120 Orphan File', 'text/plain', 16, ${`${runTag}-file-digest`})
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into openmuse_file_versions (version_id, file_id, byte_path, sha256)
    values (${orphanVersionId}, ${orphanFileId}, ${`mt120/bytes/${orphanVersionId}`}, ${`${runTag}-digest`})
    on conflict (version_id) do nothing
  `);

  const resolver = createScopeResolver(directory, {
    data,
    authenticate: async (request) => {
      const user = request.headers.get("x-mt120-identity");
      return user ? { actorId: user, entrypoint: "web" } : null;
    },
    selectTenant: (request) => request.headers.get("x-openbot-tenant"),
    selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
  });
  scopeFor = async (user, tenant, workspace) => {
    const request = new Request("https://mt120.test/scope", {
      headers: {
        "x-mt120-identity": user,
        "x-openbot-tenant": tenant,
        "x-openbot-workspace": workspace,
      },
    });
    return (await resolver.resolve(request)) as PlatformScope;
  };
});

afterAll(async () => {
  for (const dir of generatedDirs)
    await rm(dir, { recursive: true, force: true });
  if (!setup) return;
  // 本套件条目与源行清扫（前缀钉死，不碰他套件残留）。
  await setup.execute(
    sql`delete from enterprise_quarantine_items where id like ${`${runTag}%`} or record_id like ${`${runTag}%`}`,
  );
  await setup.execute(
    sql`delete from enterprise_audit_events where target_id like ${`root-record:${claimedAgentId}`} or target_id like ${`external-file:${orphanVersionId}`}`,
  );
  await setup.execute(
    sql`delete from openmuse_file_versions where version_id = ${orphanVersionId}`,
  );
  await setup.execute(
    sql`delete from openmuse_files where id = ${orphanFileId}`,
  );
  await setup.execute(
    sql`delete from enterprise_resources where tenant_id = ${otherTenantId} and id = ${claimedAgentId}`,
  );
  await setup.execute(sql`delete from agents where id = ${claimedAgentId}`);
  await setup.execute(
    sql`delete from enterprise_workspaces where tenant_id = ${otherTenantId}`,
  );
  await setup.execute(
    sql`delete from enterprise_workspace_memberships where principal_id = ${`${runTag}-principal-member`}`,
  );
  await setup.execute(
    sql`delete from enterprise_memberships where principal_id = ${`${runTag}-principal-member`}`,
  );
  await setup.execute(
    sql`delete from enterprise_principals where id = ${`${runTag}-principal-member`}`,
  );
  await setup.execute(
    sql`delete from enterprise_tenants where id = ${otherTenantId}`,
  );
  await setup.execute(
    sql`delete from users where id in (${memberUser}, ${orphanUser})`,
  );
  await Promise.all([
    data?.$client.close(),
    directory?.$client.close(),
    operator?.$client.close(),
    setup.$client.close(),
  ]);
});

describeDb("MT120 quarantine list (Issue #163)", () => {
  test("fixture wires the anchor admin scope (real issuance)", async () => {
    const scope = await scopeFor(
      anchorAdminUser,
      ANCHOR_TENANT_ID,
      ANCHOR_WORKSPACE_ID,
    );
    expect(scope.tenantId).toBe(ANCHOR_TENANT_ID);
    expect(scope.workspaceId).toBe(ANCHOR_WORKSPACE_ID);
  });

  // ---- AC1：清单列出对象、原因、发现时间与建议处置，可被运维查看 ----
  describeDb(
    "AC1 the list is viewable with object, reason, discovery time and suggestion",
    () => {
      test("scan discovers both my sources and the list carries every column", async () => {
        const report = await runQuarantineScan(setup, {
          defaultWorkspaceId: ANCHOR_WORKSPACE_ID,
        });
        const mine = report.openItems.filter(
          (item) =>
            item.id.startsWith(`root-record:${claimedAgentId}`) ||
            item.id.startsWith(`external-file:${orphanVersionId}`),
        );
        expect(mine).toHaveLength(2);
        const claimed = mine.find((item) => item.category === "root-record");
        expect(claimed?.recordId).toBe(claimedAgentId);
        expect(claimed?.reason).toBe("claimed-by-another-tenant");
        expect(claimed?.suggestedDisposition).toBe("assign");
        expect(claimed?.status).toBe("open");
        expect(claimed?.discoveredAt).toBeTruthy();

        // 运维查看半边（受限 data 通道 + RLS）。
        const memberScope = await scopeFor(
          memberUser,
          ANCHOR_TENANT_ID,
          ANCHOR_WORKSPACE_ID,
        );
        const list = await readQuarantineList(
          data,
          memberScope,
          ANCHOR_TENANT_ID,
        );
        const listed = list.find((item) => item.id === claimed?.id);
        expect(listed).toBeDefined();
        expect(listed?.reason).toBe("claimed-by-another-tenant");
        expect(listed?.suggestedDisposition).toBe("assign");
        expect(listed?.discoveredAt).toBe(claimed?.discoveredAt);

        // 他租户 scope 不读锚点清单（跨租户查看 = 配置错误，响亮拒绝）。
        await expect(
          readQuarantineList(data, memberScope, otherTenantId),
        ).rejects.toThrow("QUARANTINE_SCOPE_MISMATCH");
      });
    },
  );

  // ---- AC2：清单非空 ⇒ 就绪判定失败并给出具体条目 ----
  describeDb(
    "AC2 non-empty open set refuses the readiness gate with the items",
    () => {
      test("readiness record lists my items (startup-verdict discipline)", async () => {
        const record = await evaluateMultitenancyQuarantineReadiness(setup, {
          defaultWorkspaceId: ANCHOR_WORKSPACE_ID,
        });
        expect(record.type).toBe("multitenancy-quarantine-readiness");
        expect(record.accepted).toBe(false);
        expect(
          record.checks.openItems.some(
            (item) => item.recordId === claimedAgentId,
          ),
        ).toBe(true);
        expect(
          record.checks.openItems.some(
            (item) => item.recordId === orphanVersionId,
          ),
        ).toBe(true);

        // verdict 半边：拒绝记录恰好一条 + 非 0 退出（可注入断言）。
        const logged: unknown[] = [];
        let exitCode: number | null = null;
        applyQuarantineReadinessVerdict(record, {
          log: {
            info: (entry: unknown) => {
              logged.push(entry);
            },
          },
          exit: (code) => {
            exitCode = code;
          },
        });
        expect(logged).toHaveLength(1);
        expect(exitCode).toBe(1);

        // 纯函数半边：空集放行、非空拒绝并逐条列出。
        const acceptedRecord = evaluateQuarantineReadiness(
          [],
          "2026-10-22T00:00:00Z",
        );
        expect(acceptedRecord.accepted).toBe(true);
        const refused = evaluateQuarantineReadiness(
          record.checks.openItems,
          "2026-10-22T00:00:00Z",
        );
        expect(refused.accepted).toBe(false);
        expect(refused.checks.openItems).toEqual(record.checks.openItems);
      });
    },
  );

  // ---- AC3：处置后清单更新且处置留审计 ----
  describeDb(
    "AC3 disposition updates the list and leaves an audit trail",
    () => {
      test("assign with explicit target: audit-first, status flip, item leaves open set", async () => {
        const adminScope = await scopeFor(
          anchorAdminUser,
          ANCHOR_TENANT_ID,
          ANCHOR_WORKSPACE_ID,
        );
        const itemId = `root-record:${claimedAgentId}`;
        const before = await readQuarantineList(
          data,
          adminScope,
          ANCHOR_TENANT_ID,
          { status: "open" },
        );
        expect(before.some((item) => item.id === itemId)).toBe(true);

        const result = await resolveQuarantineItem(
          operator,
          adminScope,
          ANCHOR_TENANT_ID,
          {
            itemId,
            disposition: "assign",
            targetTenantId: otherTenantId,
          },
        );
        expect(result.status).toBe("assigned");

        // 清单更新：条目仍在表上（可追溯）但不在 open 集。
        const after = await readQuarantineList(
          data,
          adminScope,
          ANCHOR_TENANT_ID,
          { status: "open" },
        );
        expect(after.some((item) => item.id === itemId)).toBe(false);
        const resolvedRow = (
          await readQuarantineList(data, adminScope, ANCHOR_TENANT_ID)
        ).find((item) => item.id === itemId);
        expect(resolvedRow?.status).toBe("assigned");
        expect(resolvedRow?.targetTenantId).toBe(otherTenantId);
        expect(resolvedRow?.resolvedAt).toBeTruthy();

        // 审计留痕：business 域事件，处置与目标租户都在正文里。
        const auditRows = (await setup.execute(sql`
        select event_type, actor_id, target_id, payload
        from enterprise_audit_events
        where target_id = ${itemId}
        order by created_at desc
      `)) as unknown as {
          event_type: string;
          actor_id: string;
          target_id: string;
          payload: Record<string, unknown>;
        }[];
        expect(auditRows.length).toBeGreaterThanOrEqual(1);
        expect(auditRows[0].event_type).toBe("quarantine.item.disposition");
        expect(auditRows[0].actor_id).toBe(adminScope.actorId);
        expect(auditRows[0].payload.disposition).toBe("assign");
        expect(auditRows[0].payload.targetTenantId).toBe(otherTenantId);

        // 已处置条目不可再处置。
        await expect(
          resolveQuarantineItem(operator, adminScope, ANCHOR_TENANT_ID, {
            itemId,
            disposition: "destroy",
          }),
        ).rejects.toThrow("QUARANTINE_ITEM_NOT_OPEN");
      });

      test("destroy disposition flips the external-file item the same way", async () => {
        const adminScope = await scopeFor(
          anchorAdminUser,
          ANCHOR_TENANT_ID,
          ANCHOR_WORKSPACE_ID,
        );
        const itemId = `external-file:${orphanVersionId}`;
        const result = await resolveQuarantineItem(
          operator,
          adminScope,
          ANCHOR_TENANT_ID,
          {
            itemId,
            disposition: "destroy",
          },
        );
        expect(result.status).toBe("destroyed");
        const open = await readQuarantineList(
          data,
          adminScope,
          ANCHOR_TENANT_ID,
          {
            status: "open",
          },
        );
        expect(open.some((item) => item.id === itemId)).toBe(false);
      });

      test("after both dispositions my items no longer block the gate", async () => {
        const record = await evaluateMultitenancyQuarantineReadiness(setup, {
          defaultWorkspaceId: ANCHOR_WORKSPACE_ID,
        });
        // 我的两个条目都已处置：open 集里不再有本 run 前缀的任何条目。
        const mine = record.checks.openItems.filter((item) =>
          item.recordId.startsWith(runTag),
        );
        expect(mine).toEqual([]);
        // 门纪律本身不变：open 非空（共享库残留）仍拒绝。
        expect(record.accepted).toBe(record.checks.openItems.length === 0);
      });
    },
  );

  // ---- AC4：不为清空清单而猜（反向测试） ----
  describeDb("AC4 nothing guesses attribution to empty the list", () => {
    test("assign without an explicit target is refused", async () => {
      const adminScope = await scopeFor(
        anchorAdminUser,
        ANCHOR_TENANT_ID,
        ANCHOR_WORKSPACE_ID,
      );
      await expect(
        resolveQuarantineItem(operator, adminScope, ANCHOR_TENANT_ID, {
          itemId: `root-record:${claimedAgentId}`,
          disposition: "assign",
        }),
      ).rejects.toThrow(QUARANTINE_ASSIGN_TARGET_REQUIRED);
    });

    test("a plain member cannot dispose (admin gate)", async () => {
      const memberScope = await scopeFor(
        memberUser,
        ANCHOR_TENANT_ID,
        ANCHOR_WORKSPACE_ID,
      );
      await expect(
        resolveQuarantineItem(operator, memberScope, ANCHOR_TENANT_ID, {
          itemId: `root-record:${claimedAgentId}`,
          disposition: "destroy",
        }),
      ).rejects.toThrow(QUARANTINE_ADMIN_REQUIRED);
    });

    test("scan writes zero business rows and never auto-assigns", async () => {
      const resourceCount = async () =>
        Number(
          (
            (await setup.execute(
              sql`select count(*)::int as n from enterprise_resources where tenant_id = ${ANCHOR_TENANT_ID} and id = ${claimedAgentId}`,
            )) as unknown as { n: number }[]
          )[0]?.n ?? 0,
        );
      const before = await resourceCount();
      const report = await runQuarantineScan(setup, {
        defaultWorkspaceId: ANCHOR_WORKSPACE_ID,
      });
      expect(await resourceCount()).toBe(before);
      // 处置过的条目不被重扫翻回 open（幂等不回退）。
      const mine = report.openItems.filter((item) =>
        item.recordId.startsWith(runTag),
      );
      expect(mine).toEqual([]);
      expect(report.upsertedNew).toBe(0);
    });

    test("a source that stops reporting clears the item upstream (factual, not a disposition)", async () => {
      // 新源行 → 新 open 条目；随后删除源行 → 活推导不再报告 →
      // cleared-upstream（只作用于 open 条目；已处置条目保持处置态）。
      const secondVersionId = `${runTag}-ver-transient`;
      await setup.execute(sql`
        insert into openmuse_file_versions (version_id, file_id, byte_path, sha256)
        values (${secondVersionId}, ${orphanFileId}, ${`mt120/bytes/${secondVersionId}`}, ${`${runTag}-digest-2`})
        on conflict (version_id) do nothing
      `);
      const firstScan = await runQuarantineScan(setup, {
        defaultWorkspaceId: ANCHOR_WORKSPACE_ID,
      });
      const transientId = `external-file:${secondVersionId}`;
      expect(firstScan.openItems.some((item) => item.id === transientId)).toBe(
        true,
      );
      expect(firstScan.upsertedNew).toBe(1);

      await setup.execute(
        sql`delete from openmuse_file_versions where version_id = ${secondVersionId}`,
      );
      const secondScan = await runQuarantineScan(setup, {
        defaultWorkspaceId: ANCHOR_WORKSPACE_ID,
      });
      expect(secondScan.openItems.some((item) => item.id === transientId)).toBe(
        false,
      );
      const rows = (await setup.execute(sql`
        select status from enterprise_quarantine_items where id = ${transientId}
      `)) as unknown as { status: string }[];
      expect(rows[0]?.status).toBe("cleared-upstream");
      // 已处置条目不被重扫翻回 open（幂等不回退）。
      const destroyedRows = (await setup.execute(sql`
        select status from enterprise_quarantine_items where id = ${`external-file:${orphanVersionId}`}
      `)) as unknown as { status: string }[];
      expect(destroyedRows[0]?.status).toBe("destroyed");
      // 清扫本断言的瞬态行。
      await setup.execute(
        sql`delete from enterprise_quarantine_items where id = ${transientId}`,
      );
    });
  });
});
