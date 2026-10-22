// server/tests/multitenancy/package-storage.test.ts
// PKG02（Issue #461）：插件包安装存储——真实受限 PostgreSQL 角色。
//
// 证据面（逐条对应 Task Brief Phase A）：
//   (1) PKG02 MT 任务经 MT003 工具真实执行（dry-run → manifest → --apply），
//       MT031 作为连接器权威先行应用。
//   (2) 五张表 ENABLE + FORCE RLS；data 角色只读（租户臂 + 团队臂），
//       operator 角色 install/plan 可读写、revision/link/change 追加写
//       （INSERT+SELECT，无 UPDATE/DELETE），directory 零授权。
//   (3) 跨公司/跨团队复合外键在存储层被拒（23503）；种类互斥 CHECK 生效。
//   (4) RLS 真实隐藏其他公司/其他团队的安装行。
//   (5) 事务本地 app.* 设置在提交与回滚后清除（连接池复用不沿用范围）。
//   (6) 计划签发后被撤权的成员无法继续经 mutation 事务写入：写事务在
//       同一 operator 事务内重验 tenant_admin / epoch / 两级成员资格。
//   (7) PackageWriteTx 只能由 PackageMutationStore 签发（伪造句柄被拒）。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_DATABASE_URL）
// 加三个受限角色 URL；缺配置时整套显式 skip（原因写在用例名里，skipped 不
// 计为通过），绝不回退开发库。

import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { buildPlan } from "../../scripts/multitenancy/migrate-test";
import type { Database } from "../../src/db/client";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import {
  applyPackageTasks,
  createPackageInstallFixture,
  type PackageInstallFixture,
  thrownMessage,
  thrownSqlState,
} from "./support/package-install";

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const required = [
    "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
    "ENTERPRISE_TEST_DATA_DATABASE_URL",
    "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `PKG02 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    enterpriseTestDatabaseUrlFrom(process.env);
    for (const role of ["directory", "data", "operator"] as const) {
      enterpriseRuntimeDatabaseUrlFrom(role, process.env);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const ENV = probeEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

// R5-4 (OCR round 5): the recursive secret-carrier CHECKs had a
// case-sensitive `like_regex`, so `"Token"`/`"API_KEY"` spellings slipped past
// the database-level defense. The fix rides as an APPENDED step (already-
// applied step text is never rewritten — journal drift would refuse the run):
// the new step carries `flag "i"`, the applied `package_hardening` step keeps
// its exact applied text.
test("the case-insensitive secret-carrier rebuild is an appended PKG02 step", () => {
  const plan = buildPlan("PKG02");
  const step = plan.steps[plan.steps.length - 1];
  expect(step.slug).toBe("package_hardening_case_insensitive");
  expect(step.number).toBe(4);
  expect(step.name).toBe("0004_pkg02_package_hardening_case_insensitive.sql");
  const adds = step.statements.filter((statement) =>
    statement.includes("ADD CONSTRAINT"),
  );
  expect(adds).toHaveLength(3);
  for (const constraintName of [
    "enterprise_package_revision_config_shape",
    "enterprise_package_plan_input_shape",
    "enterprise_package_change_diff_shape",
  ]) {
    const rebuilt = adds.filter((statement) =>
      statement.includes(constraintName),
    );
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]).toContain('flag "i"');
  }
  // The already-journaled step keeps its applied (case-sensitive) text: the
  // fix is append-only, and any rewrite would fail the journal digest check.
  const applied = plan.steps[2];
  expect(applied.slug).toBe("package_hardening");
  for (const statement of applied.statements) {
    expect(statement).not.toContain('flag "i"');
  }
});

const TABLES = [
  "enterprise_package_installs",
  "enterprise_package_revisions",
  "enterprise_package_plans",
  "enterprise_package_resource_links",
  "enterprise_package_changes",
] as const;

const DIGEST = "a".repeat(64);

let fixture: PackageInstallFixture;
let setup: Database;

interface SeededInstall {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly installId: string;
  readonly principalId: string;
}

async function seedInstall(input: {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly packageKey: string;
  readonly connectorInstallId?: string;
}): Promise<SeededInstall> {
  const installId = `pkg02-install-${crypto.randomUUID()}`;
  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${input.tenantId}, true), set_config('app.workspace_id', ${input.workspaceId}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_package_installs
            (tenant_id, id, workspace_id, package_key, current_version, installed_by)
          values (${input.tenantId}, ${installId}, ${input.workspaceId}, ${input.packageKey}, '1.0.0', ${input.principalId})`,
    );
    await tx.execute(
      sql`insert into enterprise_package_revisions
            (tenant_id, install_id, revision, release_version, artifact_digest, config, created_by)
          values (${input.tenantId}, ${installId}, 1, '1.0.0', ${DIGEST}, '{}'::jsonb, ${input.principalId})`,
    );
    await tx.execute(
      sql`insert into enterprise_package_resource_links
            (tenant_id, install_id, revision, resource_id, workspace_id, kind, connector_install_id)
          values (${input.tenantId}, ${installId}, 1, 'summarize', ${input.workspaceId}, 'skill', null)`,
    );
    await tx.execute(
      sql`insert into enterprise_package_changes
            (tenant_id, change_id, workspace_id, install_id, revision, actor_id, action, diff, request_digest, result_json)
          values (${input.tenantId}, ${`pkg02-change-${crypto.randomUUID()}`}, ${input.workspaceId}, ${installId}, 1, ${input.principalId}, 'install', '{}'::jsonb, ${DIGEST}, '{}'::jsonb)`,
    );
  });
  return {
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    installId,
    principalId: input.principalId,
  };
}

async function dataCount(
  tenantId: string,
  workspaceId: string,
  table: string,
): Promise<number> {
  const rows = (await fixture.base.data.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.workspace_id', ${workspaceId}, true)`,
    );
    return tx.execute(sql`select count(*)::int as n from ${sql.raw(table)}`);
  })) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

describeDb("PKG02 package install storage (real restricted roles)", () => {
  let installA1: SeededInstall;
  let installB1: SeededInstall;

  beforeAll(async () => {
    await applyPackageTasks();
    fixture = await createPackageInstallFixture();
    setup = fixture.setup;
    // company-admin is tenant_admin of company A but has no team in the base
    // matrix; give it team-a1 through the real MT006 admin service so a
    // trusted scope can be issued for it.
    await fixture.addTeamMember(
      "company-admin",
      "company-a",
      "company-admin",
      "team-a1",
    );
    installA1 = await seedInstall({
      tenantId: fixture.tenantOf("company-a"),
      workspaceId: fixture.teamOf("company-a", "team-a1"),
      principalId: fixture.principalOf("company-admin", "company-a"),
      packageKey: "openbot/team-a1-package",
    });
    await seedInstall({
      tenantId: fixture.tenantOf("company-a"),
      workspaceId: fixture.teamOf("company-a", "team-a2"),
      principalId: fixture.principalOf("a2-member", "company-a"),
      packageKey: "openbot/team-a2-package",
    });
    installB1 = await seedInstall({
      tenantId: fixture.tenantOf("company-b"),
      workspaceId: fixture.teamOf("company-b", "team-b1"),
      principalId: fixture.principalOf("b1-member", "company-b"),
      packageKey: "openbot/team-b1-package",
    });
  });

  afterAll(async () => {
    if (fixture) await fixture.dispose();
  });

  itDb(
    "applies the PKG02 task after MT031 through the real migration tool",
    async () => {
      for (const table of TABLES) {
        expect(await fixture.probes.tableExists(table)).toBe(true);
      }
      // The connector authority stays the MT031 table; PKG02 only adds the
      // scope-unique index the resource-link FK needs.
      expect(
        await fixture.probes.indexColumns(
          "enterprise_plugin_install_scope_id_uq",
        ),
      ).toEqual(["tenant_id", "workspace_id", "id"]);
      expect(
        await fixture.probes.columnsOf("enterprise_package_resource_links"),
      ).toContain("connector_install_id");
    },
  );

  itDb("all five tables have RLS enabled and forced", async () => {
    for (const table of TABLES) {
      const flags = await fixture.probes.rlsFlags(table);
      expect(flags.relrowsecurity).toBe(true);
      expect(flags.relforcerowsecurity).toBe(true);
    }
  });

  itDb(
    "the data role is read-only and the directory role has no access",
    async () => {
      for (const table of TABLES) {
        expect(
          await fixture.probes.hasPrivilege(table, "ob_ent_data", "SELECT"),
        ).toBe(true);
        for (const privilege of ["INSERT", "UPDATE", "DELETE"] as const) {
          expect(
            await fixture.probes.hasPrivilege(table, "ob_ent_data", privilege),
          ).toBe(false);
        }
        for (const privilege of [
          "SELECT",
          "INSERT",
          "UPDATE",
          "DELETE",
        ] as const) {
          expect(
            await fixture.probes.hasPrivilege(
              table,
              "ob_ent_directory",
              privilege,
            ),
          ).toBe(false);
        }
      }
    },
  );

  itDb(
    "operator can write installs/plans but revisions/links/changes are append-only",
    async () => {
      for (const table of [
        "enterprise_package_installs",
        "enterprise_package_plans",
      ]) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE"] as const) {
          expect(
            await fixture.probes.hasPrivilege(
              table,
              "ob_ent_operator",
              privilege,
            ),
          ).toBe(true);
        }
      }
      for (const table of [
        "enterprise_package_revisions",
        "enterprise_package_resource_links",
        "enterprise_package_changes",
      ]) {
        expect(
          await fixture.probes.hasPrivilege(table, "ob_ent_operator", "SELECT"),
        ).toBe(true);
        expect(
          await fixture.probes.hasPrivilege(table, "ob_ent_operator", "INSERT"),
        ).toBe(true);
        for (const privilege of ["UPDATE", "DELETE"] as const) {
          expect(
            await fixture.probes.hasPrivilege(
              table,
              "ob_ent_operator",
              privilege,
            ),
          ).toBe(false);
        }
      }
    },
  );

  itDb(
    "the data role cannot INSERT, UPDATE or DELETE any package row",
    async () => {
      for (const [label, statement] of [
        [
          "insert",
          sql`insert into enterprise_package_installs
              (tenant_id, id, workspace_id, package_key, current_version, installed_by)
            values (${installA1.tenantId}, ${`raw-${crypto.randomUUID()}`}, ${installA1.workspaceId}, 'openbot/forbidden', '1.0.0', ${installA1.principalId})`,
        ],
        [
          "update",
          sql`update enterprise_package_installs set status = 'disabled'
            where tenant_id = ${installA1.tenantId} and id = ${installA1.installId}`,
        ],
        [
          "delete",
          sql`delete from enterprise_package_installs
            where tenant_id = ${installA1.tenantId} and id = ${installA1.installId}`,
        ],
      ] as const) {
        const state = await thrownSqlState(
          fixture.base.data.transaction(async (tx) => {
            await tx.execute(
              sql`select set_config('app.tenant_id', ${installA1.tenantId}, true), set_config('app.workspace_id', ${installA1.workspaceId}, true)`,
            );
            await tx.execute(statement);
          }),
        );
        expect({ label, state }).toEqual({ label, state: "42501" });
      }
    },
  );

  itDb(
    "operator cannot UPDATE or DELETE revisions, links or changes",
    async () => {
      for (const [label, statement] of [
        [
          "revision update",
          sql`update enterprise_package_revisions set release_version = '2.0.0'
            where tenant_id = ${installA1.tenantId} and install_id = ${installA1.installId}`,
        ],
        [
          "revision delete",
          sql`delete from enterprise_package_revisions
            where tenant_id = ${installA1.tenantId} and install_id = ${installA1.installId}`,
        ],
        [
          "link update",
          sql`update enterprise_package_resource_links set kind = 'skill'
            where tenant_id = ${installA1.tenantId} and install_id = ${installA1.installId}`,
        ],
        [
          "link delete",
          sql`delete from enterprise_package_resource_links
            where tenant_id = ${installA1.tenantId} and install_id = ${installA1.installId}`,
        ],
      ] as const) {
        const state = await thrownSqlState(
          fixture.operator.transaction(async (tx) => {
            await tx.execute(
              sql`select set_config('app.tenant_id', ${installA1.tenantId}, true)`,
            );
            await tx.execute(statement);
          }),
        );
        expect({ label, state }).toEqual({ label, state: "42501" });
      }
    },
  );

  itDb(
    "cross-company and cross-team references are refused by compound FKs",
    async () => {
      const teamB1 = fixture.teamOf("company-b", "team-b1");
      const principalB = fixture.principalOf("b1-member", "company-b");
      const companyA = fixture.tenantOf("company-a");
      const teamA1 = fixture.teamOf("company-a", "team-a1");

      // company A tenant + company B workspace: the workspace FK refuses it.
      expect(
        await thrownSqlState(
          setup.$client.unsafe(
            `insert into enterprise_package_installs
             (tenant_id, id, workspace_id, package_key, current_version, installed_by)
           values ($1, $2, $3, 'openbot/cross-team', '1.0.0', $4)`,
            [companyA, `raw-${crypto.randomUUID()}`, teamB1, principalB],
          ),
        ),
      ).toBe("23503");

      // company A tenant + company B principal as installer.
      expect(
        await thrownSqlState(
          setup.$client.unsafe(
            `insert into enterprise_package_installs
             (tenant_id, id, workspace_id, package_key, current_version, installed_by)
           values ($1, $2, $3, 'openbot/cross-member', '1.0.0', $4)`,
            [companyA, `raw-${crypto.randomUUID()}`, teamA1, principalB],
          ),
        ),
      ).toBe("23503");

      // revision references a company-B install from company A.
      expect(
        await thrownSqlState(
          setup.$client.unsafe(
            `insert into enterprise_package_revisions
             (tenant_id, install_id, revision, release_version, artifact_digest, config, created_by)
           values ($1, $2, 1, '1.0.0', $3, '{}'::jsonb, $4)`,
            [companyA, installB1.installId, DIGEST, installA1.principalId],
          ),
        ),
      ).toBe("23503");

      // change receipt references another company's install revision.
      expect(
        await thrownSqlState(
          setup.$client.unsafe(
            `insert into enterprise_package_changes
             (tenant_id, change_id, workspace_id, install_id, revision, actor_id, action, diff, request_digest, result_json)
           values ($1, $2, $3, $4, 1, 'actor', 'install', '{}'::jsonb, $5, '{}'::jsonb)`,
            [
              companyA,
              `raw-${crypto.randomUUID()}`,
              teamA1,
              installB1.installId,
              DIGEST,
            ],
          ),
        ),
      ).toBe("23503");

      // A plan can never be pinned to another company's workspace.
      expect(
        await thrownSqlState(
          setup.$client.unsafe(
            `insert into enterprise_package_plans
             (tenant_id, id, workspace_id, actor_id, principal_id, operation, package_key, version,
              artifact_digest, expected_revision, canonical_input, input_digest, preview, expires_at)
           values ($1, $2, $3, 'actor', $4, 'install', 'openbot/cross-plan', '1.0.0', $5, null,
                   '{}'::jsonb, $5, '{}'::jsonb, now() + interval '10 minutes')`,
            [
              companyA,
              `raw-${crypto.randomUUID()}`,
              teamB1,
              installA1.principalId,
              DIGEST,
            ],
          ),
        ),
      ).toBe("23503");
    },
  );

  itDb(
    "a connector link must point at a connector install in the same company and team",
    async () => {
      const companyB = fixture.tenantOf("company-b");
      const teamB1 = fixture.teamOf("company-b", "team-b1");
      const companyA = fixture.tenantOf("company-a");
      const teamA1 = fixture.teamOf("company-a", "team-a1");
      const principalB = fixture.principalOf("b1-member", "company-b");

      // The MT031 connector install lives in company B / team B1.
      const catalogId = `pkg02-catalog-${crypto.randomUUID()}`;
      await setup.$client.unsafe(
        `insert into enterprise_plugin_catalog (id, kind, title, vendor, source, metadata)
       values ($1, 'mcp', 'PKG02 connector', 'acme', 'first-party', '{"summary":"s"}'::jsonb)`,
        [catalogId],
      );
      const connectorInstallId = `pkg02-connector-${crypto.randomUUID()}`;
      await fixture.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${companyB}, true)`,
        );
        await tx.execute(
          sql`insert into enterprise_plugin_installs
              (tenant_id, id, catalog_id, workspace_id, installed_by, config)
            values (${companyB}, ${connectorInstallId}, ${catalogId}, ${teamB1}, ${principalB}, '{}'::jsonb)`,
        );
      });

      // A link from company A / team A1 to that company-B connector install is
      // structurally impossible (compound FK), never a silent copy.
      expect(
        await thrownSqlState(
          setup.$client.unsafe(
            `insert into enterprise_package_resource_links
             (tenant_id, install_id, revision, resource_id, workspace_id, kind, connector_install_id)
           values ($1, $2, 1, 'calendar', $3, 'managedConnector', $4)`,
            [companyA, installA1.installId, teamA1, connectorInstallId],
          ),
        ),
      ).toBe("23503");

      // Kind-specific exclusivity: a skill row may not carry a connector ref.
      expect(
        await thrownSqlState(
          setup.$client.unsafe(
            `insert into enterprise_package_resource_links
             (tenant_id, install_id, revision, resource_id, workspace_id, kind, connector_install_id)
           values ($1, $2, 1, 'sneaky', $3, 'skill', $4)`,
            [companyA, installA1.installId, teamA1, connectorInstallId],
          ),
        ),
      ).toBe("23514");
    },
  );

  itDb(
    "the secret-carrier CHECKs refuse case-variant keys at any depth (R5-4)",
    async () => {
      const companyA = fixture.tenantOf("company-a");
      const teamA1 = fixture.teamOf("company-a", "team-a1");
      const principal = installA1.principalId;

      // Defense against a previously aborted run of this probe: the seeded
      // install carries exactly revision 1, so anything above is leftover.
      await setup.$client.unsafe(
        `delete from enterprise_package_revisions
         where tenant_id = $1 and install_id = $2 and revision >= 2`,
        [companyA, installA1.installId],
      );

      // The rebuilt constraint definitions carry the case-insensitive flag.
      const constraints = (await setup.$client.unsafe(
        `select conname, pg_get_constraintdef(oid) as def
         from pg_constraint
         where conname in ('enterprise_package_revision_config_shape',
                           'enterprise_package_plan_input_shape',
                           'enterprise_package_change_diff_shape')`,
      )) as Array<{ conname: string; def: string }>;
      expect(constraints.map((row) => row.conname).sort()).toEqual([
        "enterprise_package_change_diff_shape",
        "enterprise_package_plan_input_shape",
        "enterprise_package_revision_config_shape",
      ]);
      for (const row of constraints) {
        expect(row.def).toContain('flag "i"');
      }

      // A capitalised carrier key nested one level deep: the pre-R5 regex was
      // case-sensitive and let this exact shape through.
      expect(
        await thrownSqlState(
          setup.$client.unsafe(
            `insert into enterprise_package_revisions
             (tenant_id, install_id, revision, release_version, artifact_digest, config, created_by)
           values ($1, $2, 2, '1.0.0', $3, '{"nested":{"Token":"x"}}'::jsonb, $4)`,
            [companyA, installA1.installId, DIGEST, principal],
          ),
        ),
      ).toBe("23514");

      // "API_KEY" in a plan's canonical_input.
      expect(
        await thrownSqlState(
          setup.$client.unsafe(
            `insert into enterprise_package_plans
             (tenant_id, id, workspace_id, actor_id, principal_id, operation, package_key, version,
              artifact_digest, expected_revision, canonical_input, input_digest, preview, expires_at)
           values ($1, $2, $3, 'actor', $4, 'install', 'openbot/case-probe', '1.0.0', $5, null,
                   '{"Nested":{"API_KEY":"x"}}'::jsonb, $5, '{}'::jsonb, now() + interval '10 minutes')`,
            [companyA, `raw-${crypto.randomUUID()}`, teamA1, principal, DIGEST],
          ),
        ),
      ).toBe("23514");

      // "SecretRef" in a change receipt diff.
      expect(
        await thrownSqlState(
          setup.$client.unsafe(
            `insert into enterprise_package_changes
             (tenant_id, change_id, workspace_id, install_id, revision, actor_id, action, diff, request_digest, result_json)
           values ($1, $2, $3, $4, 1, 'actor', 'install', '{"n":{"SecretRef":"x"}}'::jsonb, $5, '{}'::jsonb)`,
            [
              companyA,
              `raw-${crypto.randomUUID()}`,
              teamA1,
              installA1.installId,
              DIGEST,
            ],
          ),
        ),
      ).toBe("23514");

      // The same CHECKs still accept ordinary lower-case keys. The probe row
      // is removed again so the later RLS row-count assertions see exactly the
      // rows they seeded (dispose() would cover it, but only after the file).
      await setup.$client.unsafe(
        `insert into enterprise_package_revisions
         (tenant_id, install_id, revision, release_version, artifact_digest, config, created_by)
       values ($1, $2, 3, '1.0.0', $3, '{"region":"us"}'::jsonb, $4)`,
        [companyA, installA1.installId, DIGEST, principal],
      );
      const stored = (await setup.$client.unsafe(
        `select config from enterprise_package_revisions
         where tenant_id = $1 and install_id = $2 and revision = 3`,
        [companyA, installA1.installId],
      )) as Array<{ config: unknown }>;
      expect(stored).toHaveLength(1);
      expect(stored[0]?.config).toEqual({ region: "us" });
      await setup.$client.unsafe(
        `delete from enterprise_package_revisions
         where tenant_id = $1 and install_id = $2 and revision = 3`,
        [companyA, installA1.installId],
      );
    },
  );

  itDb(
    "RLS hides other tenants' and other teams' install rows from the data role",
    async () => {
      const companyA = fixture.tenantOf("company-a");
      const companyB = fixture.tenantOf("company-b");
      const teamA1 = fixture.teamOf("company-a", "team-a1");
      const teamA2 = fixture.teamOf("company-a", "team-a2");
      const teamB1 = fixture.teamOf("company-b", "team-b1");
      expect(
        await dataCount(companyA, teamA1, "enterprise_package_installs"),
      ).toBe(1);
      expect(
        await dataCount(companyA, teamA2, "enterprise_package_installs"),
      ).toBe(1);
      expect(
        await dataCount(companyB, teamB1, "enterprise_package_installs"),
      ).toBe(1);
      for (const [tenant, workspace] of [
        [companyA, teamA2],
        [companyB, teamB1],
        [companyB, teamA1],
      ] as const) {
        const rows = (await fixture.base.data.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenant}, true), set_config('app.workspace_id', ${workspace}, true)`,
          );
          return tx.execute(
            sql`select id from enterprise_package_installs where id = ${installA1.installId}`,
          );
        })) as unknown as unknown[];
        expect(rows.length).toBe(0);
      }
    },
  );

  itDb(
    "RLS hides revision, link and change rows across tenants and teams",
    async () => {
      const companyA = fixture.tenantOf("company-a");
      const companyB = fixture.tenantOf("company-b");
      const teamA1 = fixture.teamOf("company-a", "team-a1");
      const teamA2 = fixture.teamOf("company-a", "team-a2");
      const teamB1 = fixture.teamOf("company-b", "team-b1");

      // Each scope sees exactly its own append-only rows.
      for (const table of [
        "enterprise_package_revisions",
        "enterprise_package_resource_links",
        "enterprise_package_changes",
      ]) {
        for (const [tenant, workspace] of [
          [companyA, teamA1],
          [companyA, teamA2],
          [companyB, teamB1],
        ] as const) {
          expect({
            table,
            tenant,
            count: await dataCount(tenant, workspace, table),
          }).toEqual({ table, tenant, count: 1 });
        }
      }

      // A row that belongs to team A1 is invisible from team A2 and company B,
      // not merely outnumbered.
      for (const table of [
        "enterprise_package_revisions",
        "enterprise_package_resource_links",
        "enterprise_package_changes",
      ]) {
        for (const [tenant, workspace] of [
          [companyA, teamA2],
          [companyB, teamB1],
        ] as const) {
          const rows = (await fixture.base.data.transaction(async (tx) => {
            await tx.execute(
              sql`select set_config('app.tenant_id', ${tenant}, true), set_config('app.workspace_id', ${workspace}, true)`,
            );
            return tx.execute(
              sql`select 1 from ${sql.raw(table)} where install_id = ${installA1.installId}`,
            );
          })) as unknown as unknown[];
          expect({ table, tenant, rows: rows.length }).toEqual({
            table,
            tenant,
            rows: 0,
          });
        }
      }
    },
  );

  itDb(
    "revision config, plan input and change diff refuse nested secret-carrier keys",
    async () => {
      const companyA = fixture.tenantOf("company-a");
      const teamA1 = fixture.teamOf("company-a", "team-a1");
      const principalA = fixture.principalOf("company-admin", "company-a");
      const nestedSecret = `'{"nested": {"token": "should-not-store"}}'::jsonb`;

      expect(
        await thrownSqlState(
          setup.$client.unsafe(
            `insert into enterprise_package_revisions
             (tenant_id, install_id, revision, release_version, artifact_digest, config, created_by)
           values ($1, $2, 2, '1.0.0', $3, ${nestedSecret}, $4)`,
            [companyA, installA1.installId, DIGEST, principalA],
          ),
        ),
      ).toBe("23514");

      expect(
        await thrownSqlState(
          setup.$client.unsafe(
            `insert into enterprise_package_plans
             (tenant_id, id, workspace_id, actor_id, principal_id, operation, package_key, version,
              artifact_digest, expected_revision, canonical_input, input_digest, preview, expires_at)
           values ($1, $2, $3, 'actor', $4, 'install', 'openbot/nested-plan', '1.0.0', $5, null,
                   ${nestedSecret}, $5, '{}'::jsonb, now() + interval '10 minutes')`,
            [
              companyA,
              `raw-${crypto.randomUUID()}`,
              teamA1,
              principalA,
              DIGEST,
            ],
          ),
        ),
      ).toBe("23514");

      expect(
        await thrownSqlState(
          setup.$client.unsafe(
            `insert into enterprise_package_changes
             (tenant_id, change_id, workspace_id, install_id, revision, actor_id, action, diff, request_digest, result_json)
           values ($1, $2, $3, $4, 1, 'actor', 'install', ${nestedSecret}, $5, '{}'::jsonb)`,
            [
              companyA,
              `raw-${crypto.randomUUID()}`,
              teamA1,
              installA1.installId,
              DIGEST,
            ],
          ),
        ),
      ).toBe("23514");
    },
  );

  itDb(
    "transaction-local app.* settings are cleared after commit and rollback",
    async () => {
      const companyA = fixture.tenantOf("company-a");
      const teamA1 = fixture.teamOf("company-a", "team-a1");
      await fixture.base.data.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true), set_config('app.principal_id', ${installA1.principalId}, true)`,
        );
      });
      const afterCommit = (await fixture.base.data.execute(
        sql`select nullif(current_setting('app.tenant_id', true), '') as tenant,
                 nullif(current_setting('app.workspace_id', true), '') as workspace,
                 nullif(current_setting('app.principal_id', true), '') as principal`,
      )) as unknown as Array<Record<string, unknown>>;
      expect(afterCommit[0]).toMatchObject({
        tenant: null,
        workspace: null,
        principal: null,
      });

      await expect(
        fixture.base.data.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.tenant_id', ${companyA}, true)`,
          );
          throw new Error("rollback-on-purpose");
        }),
      ).rejects.toThrow("rollback-on-purpose");
      const afterRollback = (await fixture.base.data.execute(
        sql`select nullif(current_setting('app.tenant_id', true), '') as tenant`,
      )) as unknown as Array<Record<string, unknown>>;
      expect(afterRollback[0]?.tenant).toBeNull();
    },
  );

  itDb(
    "a company membership revoked after the context was issued cannot write",
    async () => {
      const scope = await fixture.scopeFor("company-admin", "team-a1");
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      await fixture.setCompanyMembershipStatus(
        "company-admin",
        "company-a",
        "suspended",
      );
      const state = await thrownMessage(
        fixture.mutation.transaction(scope, admin, async () => undefined),
      );
      expect(state).toContain("TENANT_FORBIDDEN");
      // Restore for the remaining cases (epoch also advances, so the old context
      // stays stale — exactly the revocation semantics under test).
      await fixture.setCompanyMembershipStatus(
        "company-admin",
        "company-a",
        "active",
      );
    },
  );

  itDb(
    "a team membership suspended after the context was issued cannot write",
    async () => {
      const scope = await fixture.scopeFor("company-admin", "team-a1");
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      await fixture.workspaceAdmin.suspendTeamMember(admin, {
        workspaceId: fixture.teamOf("company-a", "team-a1"),
        principalId: fixture.principalOf("company-admin", "company-a"),
      });
      const state = await thrownMessage(
        fixture.mutation.transaction(scope, admin, async () => undefined),
      );
      expect(state).toContain("TENANT_FORBIDDEN");
      await fixture.workspaceAdmin.restoreTeamMember(admin, {
        workspaceId: fixture.teamOf("company-a", "team-a1"),
        principalId: fixture.principalOf("company-admin", "company-a"),
      });
    },
  );

  itDb(
    "a forged write handle is refused (PackageWriteTx is issuance-only)",
    async () => {
      await expect(
        fixture.mutation.transaction(
          await fixture.scopeFor("company-admin", "team-a1"),
          await fixture.adminContextOf("company-admin", "company-a"),
          async (tx) => {
            const forged = { db: tx.db } as typeof tx;
            // A structurally identical object never received the brand.
            const { assertPackageWriteTx } = await import(
              "../../src/enterprise/plugin-packages/contracts"
            );
            expect(() => assertPackageWriteTx(forged)).toThrow(
              "UNVERIFIED_PACKAGE_WRITE_TX",
            );
            expect(() => assertPackageWriteTx(tx)).not.toThrow();
          },
        ),
      ).resolves.toBeUndefined();
    },
  );
});
