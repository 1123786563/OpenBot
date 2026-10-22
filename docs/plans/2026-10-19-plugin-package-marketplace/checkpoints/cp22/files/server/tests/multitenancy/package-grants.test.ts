// server/tests/multitenancy/package-grants.test.ts
// PKG03（Issue #462）：插件包 Bot 授权——真实受限 PostgreSQL 角色。
//
// 证据面（逐条对应 Task Brief PKG03A deliverable 5）：
//   (1) PKG03 MT 任务经 MT003 工具真实执行（MT004→MT008→MT031→PKG02→PKG03，
//       dry-run → manifest → --apply，up-to-date 合法）。
//   (2) enterprise_package_grants ENABLE + FORCE RLS；data 只读（租户+团队
//       臂）；operator 读+插+改（改仅为撤销置 revoked_at，无 DELETE）；
//       directory 零授权。
//   (3) 授权语义：同公司同团队的 Bot 才能被授予（跨公司/跨团队同形 404）；
//       资源必须是安装当前 revision 的 skill 资源（未知 404，connector
//       种类 RESOURCE_KIND_UNSUPPORTED）；未启用安装拒绝新授权。
//   (4) grant revision = 去重 generation 计数，撤销推进它（单调不减）；
//       明细读取只显示活跃授权。
//   (5) 幂等回执与 apply 同语义：同键同摘要重放 200，同键异摘要 409。
//   (6) 生命周期 seam：revokeGrantsForInstallLifecycle 在受信写事务内
//       撤销安装的全部活跃授权（PKG06 接线的挂点，slice A 直接驱动证明）。
//   (7) RLS：另一家公司的 data 角色看不到授权行。
//
// 环境契约：只认显式企业测试库环境变量；缺配置时整套显式 skip（skipped
// 不计为通过），绝不回退开发库。

import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import type { Database } from "../../src/db/client";
import type {
  PackageCatalogue,
  PackageReleaseFacts,
} from "../../src/plugin-packages/catalogue";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import {
  applyPackageTasks,
  createPackageInstallFixture,
  type PackageInstallFixture,
  thrownMessage,
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
      reason: `PKG03 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

const DIGEST = "a".repeat(64);
const SKILL_A = "summarize";
const SKILL_B = "translate";

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
  readonly status?: "enabled" | "disabled" | "uninstalled";
  /** Defaults to the shared probe package; a second install in the SAME
   * (tenant, workspace) scope must carry its own key — PKG02's
   * `enterprise_package_install_scope_key_uq` is (tenant, workspace, key). */
  readonly packageKey?: string;
}): Promise<SeededInstall> {
  const installId = `pkg03-install-${crypto.randomUUID()}`;
  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${input.tenantId}, true), set_config('app.workspace_id', ${input.workspaceId}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_package_installs
            (tenant_id, id, workspace_id, package_key, current_version, status, installed_by)
          values (${input.tenantId}, ${installId}, ${input.workspaceId}, ${input.packageKey ?? "openbot/pkg03-package"}, '1.0.0', ${input.status ?? "enabled"}, ${input.principalId})`,
    );
    await tx.execute(
      sql`insert into enterprise_package_revisions
            (tenant_id, install_id, revision, release_version, artifact_digest, config, created_by)
          values (${input.tenantId}, ${installId}, 1, '1.0.0', ${DIGEST}, '{}'::jsonb, ${input.principalId})`,
    );
    for (const resourceId of [SKILL_A, SKILL_B]) {
      await tx.execute(
        sql`insert into enterprise_package_resource_links
              (tenant_id, install_id, revision, resource_id, workspace_id, kind)
            values (${input.tenantId}, ${installId}, 1, ${resourceId}, ${input.workspaceId}, 'skill')`,
      );
    }
  });
  return {
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    installId,
    principalId: input.principalId,
  };
}

async function seedBot(input: {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly ownerPrincipalId: string;
}): Promise<string> {
  const agentId = `pkg03-bot-${crypto.randomUUID()}`;
  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${input.tenantId}, true), set_config('app.workspace_id', ${input.workspaceId}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_bot_ownership
            (tenant_id, agent_id, workspace_id, owner_principal_id, display_name, default_config)
          values (${input.tenantId}, ${agentId}, ${input.workspaceId}, ${input.ownerPrincipalId}, 'PKG03 bot', '{}'::jsonb)`,
    );
  });
  return agentId;
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

// F-C1 readiness: the seeded probe package key resolved to a verified,
// connector-free skill release, so the service's readiness ladder
// (unavailable → needs_connection → needs_grant → ready) is decided by the
// real grant facts loaded through the fixture's real restricted read channel.
const PROBE_PACKAGE_KEY = "openbot/pkg03-package";

function probeCatalogue(): PackageCatalogue {
  const release: PackageReleaseFacts = {
    packageKey: PROBE_PACKAGE_KEY,
    version: "1.0.0",
    artifactDigest: DIGEST,
    category: "productivity",
    listed: true,
    verified: true,
    displayName: "PKG03 probe package",
    summary: "The PKG03 probe package.",
    blockers: [],
    manifest: {
      schemaVersion: 1,
      platformApi: 1,
      publisher: "openbot",
      name: "pkg03-package",
      version: "1.0.0",
      display: {
        name: "PKG03 probe package",
        summary: "The PKG03 probe package.",
      },
      resources: [
        { kind: "skill", id: SKILL_A, path: `skills/${SKILL_A}/SKILL.md` },
        { kind: "skill", id: SKILL_B, path: `skills/${SKILL_B}/SKILL.md` },
      ],
      dependencies: [],
    },
  };
  return {
    async list() {
      return {
        items: [
          {
            packageKey: release.packageKey,
            version: release.version,
            displayName: release.displayName,
            summary: release.summary,
            category: release.category,
            install: null,
            installable: true,
            blockers: [],
          },
        ],
        nextCursor: null,
      };
    },
    async get() {
      throw new Error("not used");
    },
    async resolveRelease(packageKey, version) {
      return packageKey === release.packageKey && version === release.version
        ? release
        : null;
    },
  };
}

/** The real package service over the fixture's real read/mutation channels. */
async function probeReadinessService() {
  const { createPackageService } = await import(
    "../../src/enterprise/plugin-packages/install-service"
  );
  return createPackageService({
    catalogue: probeCatalogue(),
    readStore: fixture.readStore,
    mutation: fixture.mutation,
  });
}

describeDb("PKG03 package Bot grants (real restricted roles)", () => {
  let installA1: SeededInstall;
  let botA1: string;
  let grantSeq = 0;
  const nextKey = (label: string) => `pkg03-${label}-${++grantSeq}`;

  beforeAll(async () => {
    await applyPackageTasks();
    fixture = await createPackageInstallFixture();
    setup = fixture.setup;
    await fixture.addTeamMember(
      "company-admin",
      "company-a",
      "company-admin",
      "team-a1",
    );
    const companyA = fixture.tenantOf("company-a");
    const teamA1 = fixture.teamOf("company-a", "team-a1");
    const adminPrincipal = fixture.principalOf("company-admin", "company-a");
    installA1 = await seedInstall({
      tenantId: companyA,
      workspaceId: teamA1,
      principalId: adminPrincipal,
    });
    botA1 = await seedBot({
      tenantId: companyA,
      workspaceId: teamA1,
      ownerPrincipalId: adminPrincipal,
    });
  });

  afterAll(async () => {
    if (fixture) await fixture.dispose();
  });

  itDb(
    "applies the PKG03 task after PKG02 through the real migration tool",
    async () => {
      expect(
        await fixture.probes.tableExists("enterprise_package_grants"),
      ).toBe(true);
      const flags = await fixture.probes.rlsFlags("enterprise_package_grants");
      expect(flags.relrowsecurity).toBe(true);
      expect(flags.relforcerowsecurity).toBe(true);
      const columns = await fixture.probes.columnsOf(
        "enterprise_package_grants",
      );
      for (const column of [
        "tenant_id",
        "install_id",
        "generation",
        "bot_id",
        "resource_id",
        "workspace_id",
        "resource_kind",
        "tool_ref",
        "granted_by",
        "granted_at",
        "revoked_at",
      ]) {
        expect(columns).toContain(column);
      }
      // The compound grant→install FK needs the scope-unique install index.
      expect(
        await fixture.probes.indexColumns(
          "enterprise_package_install_scope_id_uq",
        ),
      ).toEqual(["tenant_id", "workspace_id", "id"]);
      // The changes action CHECK now admits grant/revoke receipts.
      const rows = (await setup.$client.unsafe(
        `select pg_get_constraintdef(oid) as def from pg_constraint
         where conname = 'enterprise_package_change_action'`,
      )) as Array<{ def: string }>;
      expect(rows[0]?.def).toContain("'grant'");
      expect(rows[0]?.def).toContain("'revoke'");
      // R4-2: the appended `package_grant_pk_tool_ref` step rebuilt the
      // grants PK to six columns — the live DDL carries tool_ref in the key.
      const pkDef = (await setup.$client.unsafe(
        `select pg_get_constraintdef(oid) as def from pg_constraint
         where conname = 'enterprise_package_grant_pk'`,
      )) as Array<{ def: string }>;
      for (const column of [
        "tenant_id",
        "install_id",
        "generation",
        "bot_id",
        "resource_id",
        "tool_ref",
      ]) {
        expect(pkDef[0]?.def).toContain(column);
      }
      expect(pkDef[0]?.def).toContain("PRIMARY KEY");
    },
  );

  itDb(
    "the grants table exposes the minimal privilege shape to the three roles",
    async () => {
      expect(
        await fixture.probes.hasPrivilege(
          "enterprise_package_grants",
          "ob_ent_data",
          "SELECT",
        ),
      ).toBe(true);
      for (const privilege of ["INSERT", "UPDATE", "DELETE"] as const) {
        expect(
          await fixture.probes.hasPrivilege(
            "enterprise_package_grants",
            "ob_ent_data",
            privilege,
          ),
        ).toBe(false);
      }
      for (const privilege of ["SELECT", "INSERT", "UPDATE"] as const) {
        expect(
          await fixture.probes.hasPrivilege(
            "enterprise_package_grants",
            "ob_ent_operator",
            privilege,
          ),
        ).toBe(true);
      }
      expect(
        await fixture.probes.hasPrivilege(
          "enterprise_package_grants",
          "ob_ent_operator",
          "DELETE",
        ),
      ).toBe(false);
      for (const privilege of [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
      ] as const) {
        expect(
          await fixture.probes.hasPrivilege(
            "enterprise_package_grants",
            "ob_ent_directory",
            privilege,
          ),
        ).toBe(false);
      }
    },
  );

  itDb(
    "the tool_ref CHECK keeps skill rows empty and connector rows non-empty",
    async () => {
      const companyA = fixture.tenantOf("company-a");
      const teamA1 = fixture.teamOf("company-a", "team-a1");
      const adminPrincipal = fixture.principalOf("company-admin", "company-a");
      // The grant table's bot FK demands a real ownership row.
      const probeBot = await seedBot({
        tenantId: companyA,
        workspaceId: teamA1,
        ownerPrincipalId: adminPrincipal,
      });
      const insert = (
        generation: number,
        resourceKind: string,
        toolRef: string,
      ) =>
        setup.$client.unsafe(
          `insert into enterprise_package_grants
           (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
            resource_kind, tool_ref, granted_by)
           values ($1, $2, $3, $4, 'probe-resource', $5, $6, $7, $8)`,
          [
            companyA,
            installA1.installId,
            generation,
            probeBot,
            teamA1,
            resourceKind,
            toolRef,
            adminPrincipal,
          ],
        );
      // A skill row with a tool ref is a lie about kind.
      //
      // Bun 1.4.x: `expect(<Bun SQL query>).rejects.toThrow()` never settles
      // (the query promise is a client thenable jest-expect cannot await — the
      // process spins hot and the pending query wedges the max-1 setup pool).
      // Refusal probes therefore go through the fixture family's try/catch
      // helper, exactly like the PKG02 storage suite.
      const skillLie = await thrownMessage(
        insert(900, "skill", "summarize:run"),
      );
      expect(skillLie).toContain("23514");
      expect(skillLie).toContain("enterprise_package_grant_tool_ref");
      // A connector-tool row without a tool ref cannot be told apart.
      const connectorLie = await thrownMessage(
        insert(900, "connectorTool", ""),
      );
      expect(connectorLie).toContain("23514");
      expect(connectorLie).toContain("enterprise_package_grant_tool_ref");
      // The valid pair is accepted (two kinds, distinct tool_refs). Both rows
      // are born revoked so they never pollute the active-grant reads below.
      await setup.$client.unsafe(
        `insert into enterprise_package_grants
         (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
          resource_kind, tool_ref, granted_by, revoked_at)
         values ($1, $2, 900, $3, 'probe-resource', $4, 'skill', '', $5, now())`,
        [companyA, installA1.installId, probeBot, teamA1, adminPrincipal],
      );
      await setup.$client.unsafe(
        `insert into enterprise_package_grants
         (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
          resource_kind, tool_ref, granted_by, revoked_at)
         values ($1, $2, 901, $3, 'probe-resource', $4, 'connectorTool', 'probe:run', $5, now())`,
        [companyA, installA1.installId, probeBot, teamA1, adminPrincipal],
      );
    },
  );

  itDb(
    "setBotGrant grants current-revision skills and the detail read surfaces them",
    async () => {
      const scope = await fixture.scopeFor("company-admin", "team-a1");
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      const { createPackageGrantService } = await import(
        "../../src/enterprise/plugin-packages/grants"
      );
      // The real grant service over the fixture's real operator channel.
      const grants = createPackageGrantService({
        mutation: fixture.mutation,
      });
      const first = await grants.setBotGrant(
        scope,
        admin,
        {
          installId: installA1.installId,
          botId: botA1,
          expectedGrantRevision: null,
          resources: [
            { resourceId: SKILL_A, kind: "skill" },
            { resourceId: SKILL_B, kind: "skill" },
          ],
        },
        nextKey("set1"),
      );
      expect(first.created).toBe(true);
      expect(first.grant).toMatchObject({
        installId: installA1.installId,
        botId: botA1,
        revision: 1,
      });

      const facts = await fixture.readStore.getInstall(
        scope,
        installA1.installId,
      );
      expect(facts?.grants).toEqual([
        {
          botId: botA1,
          revision: 1,
          resources: [
            { resourceId: SKILL_A, kind: "skill" },
            { resourceId: SKILL_B, kind: "skill" },
          ],
        },
      ]);
    },
  );

  itDb(
    "revokeBotGrant hides the grant, advances the revision and stays monotonic",
    async () => {
      const scope = await fixture.scopeFor("company-admin", "team-a1");
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      const { createPackageGrantService } = await import(
        "../../src/enterprise/plugin-packages/grants"
      );
      const grants = createPackageGrantService({
        mutation: fixture.mutation,
      });
      const revisions: number[] = [];
      const revoke = await grants.revokeBotGrant(
        scope,
        admin,
        {
          installId: installA1.installId,
          botId: botA1,
          expectedGrantRevision: 1,
        },
        nextKey("revoke1"),
      );
      expect(revoke.created).toBe(true);
      expect(revoke.grant.revision).toBe(2);
      revisions.push(revoke.grant.revision);
      let facts = await fixture.readStore.getInstall(
        scope,
        installA1.installId,
      );
      expect(facts?.grants).toEqual([]);

      const regrant = await grants.setBotGrant(
        scope,
        admin,
        {
          installId: installA1.installId,
          botId: botA1,
          expectedGrantRevision: 2,
          resources: [{ resourceId: SKILL_A, kind: "skill" }],
        },
        nextKey("set2"),
      );
      expect(regrant.created).toBe(true);
      expect(regrant.grant.revision).toBe(3);
      revisions.push(regrant.grant.revision);
      facts = await fixture.readStore.getInstall(scope, installA1.installId);
      expect(facts?.grants).toEqual([
        {
          botId: botA1,
          revision: 3,
          resources: [{ resourceId: SKILL_A, kind: "skill" }],
        },
      ]);
      for (let index = 1; index < revisions.length; index += 1) {
        expect(revisions[index]).toBeGreaterThan(revisions[index - 1]);
      }
      // A stale CAS target is refused.
      const state = await thrownMessage(
        grants.setBotGrant(
          scope,
          admin,
          {
            installId: installA1.installId,
            botId: botA1,
            expectedGrantRevision: 1,
            resources: [{ resourceId: SKILL_A, kind: "skill" }],
          },
          nextKey("stale"),
        ),
      );
      expect(state).toContain("REVISION_CONFLICT");
    },
  );

  itDb(
    "install reads report readiness ready while an active grant exists",
    async () => {
      // The previous test left exactly one active grant (revision 3, SKILL_A).
      // The catalog here is the probe double; the grants are the real rows the
      // store loaded through the restricted data role.
      const scope = await fixture.scopeFor("company-admin", "team-a1");
      const service = await probeReadinessService();
      const detail = await service.get(scope, installA1.installId);
      expect(detail.readiness).toBe("ready");
      expect(detail.blockers).toEqual([]);
      expect(detail.grants).toEqual([
        {
          installId: installA1.installId,
          botId: botA1,
          revision: 3,
          resources: [{ resourceId: SKILL_A, kind: "skill" }],
        },
      ]);
      const page = await service.list(scope, {});
      const listed = page.items.find(
        (item) => item.packageKey === PROBE_PACKAGE_KEY,
      )?.install;
      expect(listed).toMatchObject({
        installId: installA1.installId,
        readiness: "ready",
      });
      expect(listed?.blockers).toEqual([]);
    },
  );

  itDb(
    "the same idempotency key replays; the same key with another payload conflicts",
    async () => {
      const scope = await fixture.scopeFor("company-admin", "team-a1");
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      const { createPackageGrantService } = await import(
        "../../src/enterprise/plugin-packages/grants"
      );
      const grants = createPackageGrantService({
        mutation: fixture.mutation,
      });
      const input = {
        installId: installA1.installId,
        botId: botA1,
        expectedGrantRevision: null as number | null,
        resources: [{ resourceId: SKILL_A, kind: "skill" as const }],
      };
      const key = nextKey("idem");
      const first = await grants.setBotGrant(scope, admin, input, key);
      expect(first.created).toBe(true);
      const replay = await grants.setBotGrant(scope, admin, input, key);
      expect(replay.created).toBe(false);
      expect(replay.grant).toEqual(first.grant);
      const conflict = thrownMessage(
        grants.setBotGrant(
          scope,
          admin,
          {
            ...input,
            botId: botA1,
            resources: [{ resourceId: SKILL_B, kind: "skill" }],
          },
          key,
        ),
      );
      expect(await conflict).toContain("IDEMPOTENCY_CONFLICT");
    },
  );

  itDb("a cross-company bot is refused with the same 404 shape", async () => {
    const scope = await fixture.scopeFor("company-admin", "team-a1");
    const admin = await fixture.adminContextOf("company-admin", "company-a");
    const botB1 = await seedBot({
      tenantId: fixture.tenantOf("company-b"),
      workspaceId: fixture.teamOf("company-b", "team-b1"),
      ownerPrincipalId: fixture.principalOf("b1-member", "company-b"),
    });
    const { createPackageGrantService } = await import(
      "../../src/enterprise/plugin-packages/grants"
    );
    const grants = createPackageGrantService({
      mutation: fixture.mutation,
    });
    const state = await thrownMessage(
      grants.setBotGrant(
        scope,
        admin,
        {
          installId: installA1.installId,
          botId: botB1,
          expectedGrantRevision: null,
          resources: [{ resourceId: SKILL_A, kind: "skill" }],
        },
        nextKey("cross-tenant"),
      ),
    );
    expect(state).toContain("RESOURCE_NOT_FOUND");
  });

  itDb(
    "a bot of another team in the same company is refused (404, same shape)",
    async () => {
      const scope = await fixture.scopeFor("company-admin", "team-a1");
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      const botA2 = await seedBot({
        tenantId: fixture.tenantOf("company-a"),
        workspaceId: fixture.teamOf("company-a", "team-a2"),
        ownerPrincipalId: fixture.principalOf("a2-member", "company-a"),
      });
      const { createPackageGrantService } = await import(
        "../../src/enterprise/plugin-packages/grants"
      );
      const grants = createPackageGrantService({
        mutation: fixture.mutation,
      });
      const foreign = await thrownMessage(
        grants.setBotGrant(
          scope,
          admin,
          {
            installId: installA1.installId,
            botId: botA2,
            expectedGrantRevision: null,
            resources: [{ resourceId: SKILL_A, kind: "skill" }],
          },
          nextKey("cross-team"),
        ),
      );
      const unknown = await thrownMessage(
        grants.setBotGrant(
          scope,
          admin,
          {
            installId: installA1.installId,
            botId: "pkg03-does-not-exist",
            expectedGrantRevision: null,
            resources: [{ resourceId: SKILL_A, kind: "skill" }],
          },
          nextKey("unknown-bot"),
        ),
      );
      expect(foreign).toContain("RESOURCE_NOT_FOUND");
      expect(unknown).toContain("RESOURCE_NOT_FOUND");
    },
  );

  itDb(
    "unknown resources and connector-kind resources are refused",
    async () => {
      const scope = await fixture.scopeFor("company-admin", "team-a1");
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      const { createPackageGrantService } = await import(
        "../../src/enterprise/plugin-packages/grants"
      );
      const grants = createPackageGrantService({
        mutation: fixture.mutation,
      });
      const unknownResource = await thrownMessage(
        grants.setBotGrant(
          scope,
          admin,
          {
            installId: installA1.installId,
            botId: botA1,
            expectedGrantRevision: null,
            resources: [{ resourceId: "not-a-linked-resource", kind: "skill" }],
          },
          nextKey("unknown-resource"),
        ),
      );
      expect(unknownResource).toContain("RESOURCE_NOT_FOUND");
      const connector = await thrownMessage(
        grants.setBotGrant(
          scope,
          admin,
          {
            installId: installA1.installId,
            botId: botA1,
            expectedGrantRevision: null,
            resources: [{ resourceId: "tracker", kind: "managedConnector" }],
          },
          nextKey("connector-kind"),
        ),
      );
      expect(connector).toContain("RESOURCE_KIND_UNSUPPORTED");
    },
  );

  itDb("an uninstalled install refuses new grants", async () => {
    const companyA = fixture.tenantOf("company-a");
    const teamA1 = fixture.teamOf("company-a", "team-a1");
    const adminPrincipal = fixture.principalOf("company-admin", "company-a");
    const tombstone = await seedInstall({
      tenantId: companyA,
      workspaceId: teamA1,
      principalId: adminPrincipal,
      status: "uninstalled",
      // Same team as installA1: the scope key must differ or PKG02's
      // (tenant, workspace, package_key) unique index refuses the arrangement.
      packageKey: "openbot/pkg03-tombstone",
    });
    const scope = await fixture.scopeFor("company-admin", "team-a1");
    const admin = await fixture.adminContextOf("company-admin", "company-a");
    const { createPackageGrantService } = await import(
      "../../src/enterprise/plugin-packages/grants"
    );
    const grants = createPackageGrantService({
      mutation: fixture.mutation,
    });
    const state = await thrownMessage(
      grants.setBotGrant(
        scope,
        admin,
        {
          installId: tombstone.installId,
          botId: botA1,
          expectedGrantRevision: null,
          resources: [{ resourceId: SKILL_A, kind: "skill" }],
        },
        nextKey("tombstone"),
      ),
    );
    expect(state).toContain("PACKAGE_UNSUPPORTED");
  });

  itDb(
    "the lifecycle seam revokes every active grant inside a trusted write tx",
    async () => {
      const scope = await fixture.scopeFor("company-admin", "team-a1");
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      const { revokeGrantsForInstallLifecycle } = await import(
        "../../src/enterprise/plugin-packages/grants"
      );
      const { assertPackageWriteTx } = await import(
        "../../src/enterprise/plugin-packages/contracts"
      );
      await fixture.mutation.transaction(scope, admin, async (tx) => {
        assertPackageWriteTx(tx);
        await revokeGrantsForInstallLifecycle(
          tx,
          { tenantId: installA1.tenantId, installId: installA1.installId },
          new Date(),
        );
      });
      const facts = await fixture.readStore.getInstall(
        scope,
        installA1.installId,
      );
      expect(facts?.grants).toEqual([]);
    },
  );

  itDb("a forged write handle is refused (issuance-only seam)", async () => {
    await expect(
      fixture.mutation.transaction(
        await fixture.scopeFor("company-admin", "team-a1"),
        await fixture.adminContextOf("company-admin", "company-a"),
        async (tx) => {
          const forged = { db: tx.db } as typeof tx;
          const { assertPackageWriteTx } = await import(
            "../../src/enterprise/plugin-packages/contracts"
          );
          expect(() => assertPackageWriteTx(forged)).toThrow(
            "UNVERIFIED_PACKAGE_WRITE_TX",
          );
          await expect(revokeSeam(forged)).rejects.toThrow(
            "UNVERIFIED_PACKAGE_WRITE_TX",
          );
        },
      ),
    ).resolves.toBeUndefined();
  });

  itDb("grant rows are invisible to another tenant's data role", async () => {
    const companyA = fixture.tenantOf("company-a");
    const companyB = fixture.tenantOf("company-b");
    const teamA1 = fixture.teamOf("company-a", "team-a1");
    const teamB1 = fixture.teamOf("company-b", "team-b1");
    // Positive control first: the owning tenant's data role DOES see rows, so
    // the company-B zero below is the RLS policy and not an empty table.
    expect(
      await dataCount(companyA, teamA1, "enterprise_package_grants"),
    ).toBeGreaterThan(0);
    // The cross-tenant arm: Spec §6 — another company's data role sees none.
    expect(await dataCount(companyB, teamB1, "enterprise_package_grants")).toBe(
      0,
    );
  });

  itDb(
    "with every grant revoked the install reads needs_grant again",
    async () => {
      // The lifecycle-seam test above revoked every active grant of installA1,
      // so the reads must have fallen back from ready to needs_grant.
      const scope = await fixture.scopeFor("company-admin", "team-a1");
      const service = await probeReadinessService();
      const detail = await service.get(scope, installA1.installId);
      expect(detail.readiness).toBe("needs_grant");
      expect(detail.blockers).toEqual([{ code: "NEEDS_GRANT" }]);
      expect(detail.grants).toEqual([]);
      const page = await service.list(scope, {});
      const listed = page.items.find(
        (item) => item.packageKey === PROBE_PACKAGE_KEY,
      )?.install;
      expect(listed).toMatchObject({
        installId: installA1.installId,
        readiness: "needs_grant",
      });
      expect(listed?.blockers).toEqual([{ code: "NEEDS_GRANT" }]);
    },
  );

  itDb(
    "R4-2: two tool_refs of one (install, generation, bot, resource) coexist as active grants",
    async () => {
      const companyA = fixture.tenantOf("company-a");
      const teamA1 = fixture.teamOf("company-a", "team-a1");
      const adminPrincipal = fixture.principalOf("company-admin", "company-a");
      // Dedicated install + Bot: the active rows written here must never
      // perturb the exact-equality grant reads earlier tests make on installA1.
      const toolRefInstall = await seedInstall({
        tenantId: companyA,
        workspaceId: teamA1,
        principalId: adminPrincipal,
        packageKey: "openbot/pkg03-toolref",
      });
      const toolRefBot = await seedBot({
        tenantId: companyA,
        workspaceId: teamA1,
        ownerPrincipalId: adminPrincipal,
      });
      const insertGrant = (toolRef: string) =>
        setup.$client.unsafe(
          `insert into enterprise_package_grants
           (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
            resource_kind, tool_ref, granted_by)
           values ($1, $2, 910, $3, 'tracker', $4, 'connectorTool', $5, $6)`,
          [
            companyA,
            toolRefInstall.installId,
            toolRefBot,
            teamA1,
            toolRef,
            adminPrincipal,
          ],
        );
      // The PKG03 `package_grant_pk_tool_ref` six-column PK: one connector
      // resource holds one row PER TOOL per cycle, so two distinct tool_refs
      // of the same (install, generation, bot, resource) are two active rows.
      await insertGrant("tracker:list");
      await insertGrant("tracker:write");
      const active = (await setup.$client.unsafe(
        `select tool_ref from enterprise_package_grants
         where tenant_id = $1 and install_id = $2 and generation = 910
           and bot_id = $3 and resource_id = 'tracker' and revoked_at is null
         order by tool_ref`,
        [companyA, toolRefInstall.installId, toolRefBot],
      )) as Array<{ tool_ref: string }>;
      expect(active.map((row) => row.tool_ref)).toEqual([
        "tracker:list",
        "tracker:write",
      ]);
      // The key is still a key: the same tool_ref again collides on the PK.
      // The probe row is born revoked so the ACTIVE-grant unique index is out
      // of the picture and the PK itself is what refuses the insert.
      const duplicate = await thrownMessage(
        setup.$client.unsafe(
          `insert into enterprise_package_grants
           (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
            resource_kind, tool_ref, granted_by, revoked_at)
           values ($1, $2, 910, $3, 'tracker', $4, 'connectorTool', 'tracker:list', $5, now())`,
          [
            companyA,
            toolRefInstall.installId,
            toolRefBot,
            teamA1,
            adminPrincipal,
          ],
        ),
      );
      expect(duplicate).toContain("23505");
      expect(duplicate).toContain("enterprise_package_grant_pk");
      // Skill behavior is unchanged: tool_ref '' stays one row per cycle, so
      // a second identical skill row collides exactly as before.
      const insertSkill = () =>
        setup.$client.unsafe(
          `insert into enterprise_package_grants
           (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
            resource_kind, tool_ref, granted_by)
           values ($1, $2, 911, $3, 'summarize', $4, 'skill', '', $5)`,
          [
            companyA,
            toolRefInstall.installId,
            toolRefBot,
            teamA1,
            adminPrincipal,
          ],
        );
      await insertSkill();
      const skillDuplicate = await thrownMessage(
        setup.$client.unsafe(
          `insert into enterprise_package_grants
           (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
            resource_kind, tool_ref, granted_by, revoked_at)
           values ($1, $2, 911, $3, 'summarize', $4, 'skill', '', $5, now())`,
          [
            companyA,
            toolRefInstall.installId,
            toolRefBot,
            teamA1,
            adminPrincipal,
          ],
        ),
      );
      expect(skillDuplicate).toContain("23505");
      expect(skillDuplicate).toContain("enterprise_package_grant_pk");
    },
  );
});

async function revokeSeam(tx: unknown): Promise<void> {
  const { revokeGrantsForInstallLifecycle } = await import(
    "../../src/enterprise/plugin-packages/grants"
  );
  return revokeGrantsForInstallLifecycle(
    tx as Parameters<typeof revokeGrantsForInstallLifecycle>[0],
    { tenantId: "t", installId: "i" },
    new Date(),
  );
}
