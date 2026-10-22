// server/tests/package-install.integration.test.ts
// PKG02（Issue #461）：插件包安装事务的端到端验收（真实数据库 + 真实受限角色）。
//
// 验收事实源（A02/A03/A04/A12 与 Issue #461 bullets）：
//   - 两个团队 / 两家公司安装同一包互不影响：config、connector link 不串。
//   - 并发同计划只建一份安装；不同计划同包 = 409，绝不两行。
//   - 同键异请求 409；已提交计划过期后同键仍返回原结果；未提交计划过期 410。
//   - 首次 expectedRevision=null；已有安装的修订 CAS 归 PKG06，PKG02 拒绝。
//   - 下架（unlisted）计划 422；计划/制品 digest 变化在 apply 被拒。
//   - 跨范围 install/plan ID 与不存在同形（RESOURCE_NOT_FOUND）。
//   - 仅安装不产生 Bot grant / 连接访问，readiness=needs_grant。
//   - 计划后成员被撤权 → apply 被拒（事务内重验）。
//   - plan/apply 零供应商/transport 调用（fetch spy 计数为 0）。
//
// 环境契约：只认显式 enterprise 测试库与三个受限角色 URL；缺配置整套
// 显式 skip（skipped 不计为通过），绝不回退开发库。

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sql } from "drizzle-orm";
import {
  type PackageInstallDTO,
  PackagePageSchema,
  type PackagePlanInput,
} from "../../shared/enterprise/plugin-package-contracts";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import type { PlatformScope } from "../src/enterprise/contracts";
import type {
  PackageMutationStore,
  PackageService,
} from "../src/enterprise/plugin-packages/contracts";
import { createPackageService } from "../src/enterprise/plugin-packages/install-service";
import { buildArtifact, storeArtifact } from "../src/plugin-packages/artifact";
import {
  loadPackageCatalogue,
  type PackageCatalogue,
} from "../src/plugin-packages/catalogue";
import {
  applyPackageTasks,
  createPackageInstallFixture,
  type PackageInstallFixture,
} from "./multitenancy/support/package-install";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "./support/enterprise-database";

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
      reason: `PKG02 integration requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
const TEST_TIMEOUT_MS = 60_000;
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn, TEST_TIMEOUT_MS)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

const PACKAGE = "openbot/meeting-follow-up";
const NEEDS_CALENDAR = "openbot/needs-calendar";
const UNLISTED = "openbot/unlisted-package";

let fixture: PackageInstallFixture;
let catalogue: PackageCatalogue;
let service: PackageService;
let artifactRoot: string;
let clock: Date;
let scopeA: PlatformScope;
let scopeA2: PlatformScope;
let scopeA2Admin: PlatformScope;
let scopeB: PlatformScope;
let connectorA: string;
let connectorB: string;

async function storePackage(
  destination: string,
  definition: {
    name: string;
    version?: string;
    listed?: boolean;
    displayName?: string;
    summary?: string;
    resources?: Array<Record<string, unknown>>;
  },
): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), "pkg02-source-"));
  try {
    const manifest = {
      schemaVersion: 1,
      platformApi: 1,
      publisher: "openbot",
      name: definition.name,
      version: definition.version ?? "1.0.0",
      display: {
        name: definition.displayName ?? `${definition.name} package`,
        summary: definition.summary ?? `The ${definition.name} package.`,
      },
      resources: definition.resources ?? [
        { kind: "skill", id: "summarize", path: "skills/summarize/SKILL.md" },
      ],
      dependencies: [],
    };
    await writeFile(
      join(source, "openbot.plugin.json"),
      JSON.stringify(manifest),
    );
    const files: Record<string, string> = {
      "skills/summarize/SKILL.md": `# ${definition.name}\n`,
      "experts/assistant.json": JSON.stringify({ name: "assistant" }),
    };
    for (const [path, content] of Object.entries(files)) {
      const absolute = join(source, ...path.split("/"));
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    }
    const artifact = await buildArtifact(source);
    await storeArtifact(artifact, destination);
    return artifact.digest;
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}

function input(
  packageKey: string,
  overrides: Partial<PackagePlanInput> = {},
): PackagePlanInput {
  return {
    operation: "install",
    packageKey,
    version: "1.0.0",
    expectedRevision: null,
    config: {},
    connectorInstalls: {},
    ...overrides,
  };
}

async function resetPackageRows(): Promise<void> {
  const tenants = [
    fixture.tenantOf("company-a"),
    fixture.tenantOf("company-b"),
  ];
  for (const table of [
    "enterprise_package_changes",
    "enterprise_package_resource_links",
    "enterprise_package_plans",
    "enterprise_package_revisions",
    "enterprise_package_installs",
  ]) {
    for (const tenantId of tenants) {
      await fixture.setup.$client.unsafe(
        `delete from ${table} where tenant_id = $1`,
        [tenantId],
      );
    }
  }
}

async function installRowCount(tenantId: string): Promise<number> {
  const rows = (await fixture.setup.$client.unsafe(
    "select count(*)::int as n from enterprise_package_installs where tenant_id = $1",
    [tenantId],
  )) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

async function countRows(text: string, values: unknown[]): Promise<number> {
  const rows = (await fixture.setup.$client.unsafe(text, values)) as Array<{
    n: number;
  }>;
  return Number(rows[0]?.n ?? 0);
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toThrow(code);
}

describeDb(
  "PKG02 package install integration (real database, real roles)",
  () => {
    beforeAll(async () => {
      await applyPackageTasks();
      fixture = await createPackageInstallFixture();

      // company-admin (tenant_admin of A) has no team in the base matrix: add it
      // through the real MT006 admin service. b1-member is promoted to
      // tenant_admin of company B (disclosed arrangement stand-in).
      await fixture.addTeamMember(
        "company-admin",
        "company-a",
        "company-admin",
        "team-a1",
      );
      // Same company, second team: the admin is a member of both so a plan in
      // one team can be presented in the other (and must not apply there).
      await fixture.addTeamMember(
        "company-admin",
        "company-a",
        "company-admin",
        "team-a2",
      );
      await fixture.promoteToCompanyAdmin("b1-member", "company-b");

      scopeA = await fixture.scopeFor("company-admin", "team-a1");
      scopeA2 = await fixture.scopeFor("a2-member", "team-a2");
      scopeA2Admin = await fixture.scopeFor("company-admin", "team-a2");
      scopeB = await fixture.scopeFor("b1-member", "team-b1");

      artifactRoot = await mkdtemp(join(tmpdir(), "pkg02-artifacts-"));
      const connectorDigest = await storePackage(artifactRoot, {
        name: "meeting-follow-up",
        resources: [
          { kind: "skill", id: "summarize", path: "skills/summarize/SKILL.md" },
          {
            kind: "expertTemplate",
            id: "assistant",
            path: "experts/assistant.json",
            skills: ["summarize"],
          },
          {
            kind: "managedConnector",
            id: "calendar",
            catalogKey: "calendar",
            required: false,
            tools: [{ name: "list-events", effect: "read" }],
          },
        ],
      });
      const requiredDigest = await storePackage(artifactRoot, {
        name: "needs-calendar",
        resources: [
          {
            kind: "managedConnector",
            id: "calendar",
            catalogKey: "calendar",
            required: true,
            tools: [{ name: "list-events", effect: "read" }],
          },
        ],
      });
      const unlistedDigest = await storePackage(artifactRoot, {
        name: "unlisted-package",
      });
      catalogue = await loadPackageCatalogue({
        artifactRoot,
        index: {
          schemaVersion: 1,
          packages: [
            {
              packageKey: PACKAGE,
              version: "1.0.0",
              artifactDigest: connectorDigest,
              category: "productivity",
              listed: true,
            },
            {
              packageKey: NEEDS_CALENDAR,
              version: "1.0.0",
              artifactDigest: requiredDigest,
              category: "productivity",
              listed: true,
            },
            {
              packageKey: UNLISTED,
              version: "1.0.0",
              artifactDigest: unlistedDigest,
              category: "productivity",
              listed: false,
            },
          ],
        },
      });
      service = createPackageService({
        catalogue,
        readStore: fixture.readStore,
        mutation: fixture.mutation,
        now: () => clock,
      });
      clock = new Date("2026-10-20T00:00:00.000Z");

      // MT031 connector installs (the #74 authority) for company A / B.
      const catalogId = `pkg02-connector-catalog-${crypto.randomUUID()}`;
      await fixture.setup.$client.unsafe(
        `insert into enterprise_plugin_catalog (id, kind, title, vendor, source, metadata)
       values ($1, 'mcp', 'PKG02 calendar', 'acme', 'first-party', '{"summary":"calendar"}'::jsonb)`,
        [catalogId],
      );
      const seedConnector = async (
        tenantId: string,
        workspaceId: string,
        installedBy: string,
      ): Promise<string> => {
        const id = `pkg02-connector-${crypto.randomUUID()}`;
        await fixture.operator.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true)`,
          );
          await tx.execute(
            sql`insert into enterprise_plugin_installs
                (tenant_id, id, catalog_id, workspace_id, installed_by, config)
              values (${tenantId}, ${id}, ${catalogId}, ${workspaceId}, ${installedBy}, '{}'::jsonb)`,
          );
        });
        return id;
      };
      connectorA = await seedConnector(
        fixture.tenantOf("company-a"),
        fixture.teamOf("company-a", "team-a1"),
        fixture.principalOf("company-admin", "company-a"),
      );
      connectorB = await seedConnector(
        fixture.tenantOf("company-b"),
        fixture.teamOf("company-b", "team-b1"),
        fixture.principalOf("b1-member", "company-b"),
      );
    }, 180_000);

    beforeEach(async () => {
      clock = new Date("2026-10-20T00:00:00.000Z");
      await resetPackageRows();
    }, 60_000);

    afterAll(async () => {
      if (artifactRoot)
        await rm(artifactRoot, { recursive: true, force: true });
      if (fixture) await fixture.dispose();
    });

    itDb(
      "two teams and two companies install the same package independently",
      async () => {
        const adminA = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const adminB = await fixture.adminContextOf("b1-member", "company-b");
        const planA = await service.plan(
          scopeA,
          adminA,
          input(PACKAGE, {
            config: { region: "us" },
            connectorInstalls: { calendar: connectorA },
          }),
        );
        const planB = await service.plan(
          scopeB,
          adminB,
          input(PACKAGE, {
            config: { region: "eu" },
            connectorInstalls: { calendar: connectorB },
          }),
        );
        const appliedA = await service.apply(
          scopeA,
          adminA,
          planA.planId,
          "a-key-1",
        );
        const appliedB = await service.apply(
          scopeB,
          adminB,
          planB.planId,
          "b-key-1",
        );
        expect(appliedA.created).toBe(true);
        expect(appliedB.created).toBe(true);
        expect(appliedA.install.installId).not.toBe(appliedB.install.installId);
        expect(appliedA.install.artifactDigest).toBe(planA.artifactDigest);
        expect(appliedB.install.artifactDigest).toBe(planB.artifactDigest);

        // Config and connector links stay inside their own scope.
        const configs = (await fixture.setup.$client.unsafe(
          `select i.tenant_id, r.config
       from enterprise_package_revisions r
       join enterprise_package_installs i
         on i.tenant_id = r.tenant_id and i.id = r.install_id
       where i.id in ($1, $2)`,
          [appliedA.install.installId, appliedB.install.installId],
        )) as Array<{ tenant_id: string; config: Record<string, unknown> }>;
        const configOf = (tenantId: string) =>
          configs.find((row) => row.tenant_id === tenantId)?.config;
        expect(configOf(fixture.tenantOf("company-a"))).toEqual({
          region: "us",
        });
        expect(configOf(fixture.tenantOf("company-b"))).toEqual({
          region: "eu",
        });
        const links = (await fixture.setup.$client.unsafe(
          `select install_id, connector_install_id
       from enterprise_package_resource_links
       where install_id in ($1, $2) and kind = 'managedConnector'`,
          [appliedA.install.installId, appliedB.install.installId],
        )) as Array<{ install_id: string; connector_install_id: string }>;
        expect(
          links.find((row) => row.install_id === appliedA.install.installId)
            ?.connector_install_id,
        ).toBe(connectorA);
        expect(
          links.find((row) => row.install_id === appliedB.install.installId)
            ?.connector_install_id,
        ).toBe(connectorB);

        // List merges only the current scope's install.
        const pageA = PackagePageSchema.parse(await service.list(scopeA, {}));
        expect(
          pageA.items.find((item) => item.packageKey === PACKAGE)?.install,
        ).toMatchObject({
          installId: appliedA.install.installId,
        });
        const pageB = PackagePageSchema.parse(await service.list(scopeB, {}));
        expect(
          pageB.items.find((item) => item.packageKey === PACKAGE)?.install,
        ).toMatchObject({
          installId: appliedB.install.installId,
        });
        const pageA2 = PackagePageSchema.parse(await service.list(scopeA2, {}));
        expect(
          pageA2.items.find((item) => item.packageKey === PACKAGE)?.install,
        ).toBeNull();

        // Detail is scope-bound; cross-scope and unknown answer one shape.
        const detail = await service.get(scopeA, appliedA.install.installId);
        expect(detail.resources).toEqual(
          expect.arrayContaining([
            { id: "summarize", kind: "skill", available: true },
            { id: "assistant", kind: "expertTemplate", available: true },
            { id: "calendar", kind: "managedConnector", available: true },
          ]),
        );
        await expectCode(
          service.get(scopeB, appliedA.install.installId),
          "RESOURCE_NOT_FOUND",
        );
        await expectCode(
          service.get(scopeA, "unknown-install-id"),
          "RESOURCE_NOT_FOUND",
        );
      },
    );

    itDb(
      "install alone creates no Bot grant and no connector access",
      async () => {
        const grantsBefore = await countRows(
          "select count(*)::int as n from plugin_grants",
          [],
        );
        const connectionsBefore = await countRows(
          "select count(*)::int as n from enterprise_plugin_connections",
          [],
        );
        const adminA = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const plan = await service.plan(
          scopeA,
          adminA,
          input(PACKAGE, { connectorInstalls: { calendar: connectorA } }),
        );
        const applied = await service.apply(
          scopeA,
          adminA,
          plan.planId,
          "grant-key",
        );
        expect(applied.install.readiness).toBe("needs_grant");
        expect(applied.install.allowedActions).toEqual([]);
        expect(applied.install.blockers).toEqual([{ code: "NEEDS_GRANT" }]);
        expect(
          await countRows("select count(*)::int as n from plugin_grants", []),
        ).toBe(grantsBefore);
        expect(
          await countRows(
            "select count(*)::int as n from enterprise_plugin_connections",
            [],
          ),
        ).toBe(connectionsBefore);
        // No config, secret or internal path in the DTO.
        const serialized = JSON.stringify(
          await service.get(scopeA, applied.install.installId),
        );
        expect(serialized).not.toContain("region");
        expect(serialized).not.toContain("config");
        expect(serialized).not.toContain("sha256");
      },
    );

    itDb(
      "a required connector without a mapping installs but stays needs_connection",
      async () => {
        const adminA = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const plan = await service.plan(scopeA, adminA, input(NEEDS_CALENDAR));
        expect(plan.blockers).toEqual([
          { code: "NEEDS_CONNECTION", resourceId: "calendar" },
        ]);
        expect(plan.addedTools).toEqual([
          expect.objectContaining({
            ref: "calendar:list-events",
            effect: "read",
          }),
        ]);
        const applied = await service.apply(
          scopeA,
          adminA,
          plan.planId,
          "needs-conn",
        );
        expect(applied.install.readiness).toBe("needs_connection");
        expect(applied.install.blockers).toContainEqual({
          code: "NEEDS_CONNECTION",
          resourceId: "calendar",
        });
      },
    );

    itDb(
      "concurrent apply of the same plan creates exactly one install",
      async () => {
        const adminA = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const plan = await service.plan(scopeA, adminA, input(PACKAGE));
        const results = await Promise.allSettled([
          service.apply(scopeA, adminA, plan.planId, "same-key"),
          service.apply(scopeA, adminA, plan.planId, "same-key"),
        ]);
        const fulfilled = results
          .filter(
            (
              result,
            ): result is PromiseFulfilledResult<{
              install: PackageInstallDTO;
              created: boolean;
            }> => result.status === "fulfilled",
          )
          .map((result) => result.value);
        expect(fulfilled.length).toBe(2);
        expect(fulfilled.filter((result) => result.created).length).toBe(1);
        expect(fulfilled[0].install.installId).toBe(
          fulfilled[1].install.installId,
        );
        expect(await installRowCount(fixture.tenantOf("company-a"))).toBe(1);
      },
    );

    itDb("distinct keys for one plan replay the same install", async () => {
      const adminA = await fixture.adminContextOf("company-admin", "company-a");
      const plan = await service.plan(scopeA, adminA, input(PACKAGE));
      const results = await Promise.allSettled([
        service.apply(scopeA, adminA, plan.planId, "key-one"),
        service.apply(scopeA, adminA, plan.planId, "key-two"),
      ]);
      const fulfilled = results
        .filter(
          (
            result,
          ): result is PromiseFulfilledResult<{
            install: PackageInstallDTO;
            created: boolean;
          }> => result.status === "fulfilled",
        )
        .map((result) => result.value);
      expect(fulfilled.length).toBe(2);
      expect(fulfilled.filter((result) => result.created).length).toBe(1);
      expect(fulfilled[0].install).toEqual(fulfilled[1].install);
      expect(await installRowCount(fixture.tenantOf("company-a"))).toBe(1);
      // Both keys are recorded as independent receipts.
      expect(
        await countRows(
          "select count(*)::int as n from enterprise_package_changes where tenant_id = $1",
          [fixture.tenantOf("company-a")],
        ),
      ).toBe(2);
    });

    itDb(
      "different plans for the same package answer 409 and never install twice",
      async () => {
        const adminA = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const first = await service.plan(scopeA, adminA, input(PACKAGE));
        const second = await service.plan(
          scopeA,
          adminA,
          input(PACKAGE, { config: { region: "other" } }),
        );
        await service.apply(scopeA, adminA, first.planId, "first-key");
        await expectCode(
          service.apply(scopeA, adminA, second.planId, "second-key"),
          "REVISION_CONFLICT",
        );
        expect(await installRowCount(fixture.tenantOf("company-a"))).toBe(1);
      },
    );

    itDb(
      "concurrent DIFFERENT plans for one package: one wins, the other conflicts",
      async () => {
        const adminA = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const first = await service.plan(scopeA, adminA, input(PACKAGE));
        const second = await service.plan(
          scopeA,
          adminA,
          input(PACKAGE, { config: { region: "other" } }),
        );
        const results = await Promise.allSettled([
          service.apply(scopeA, adminA, first.planId, "race-key-a"),
          service.apply(scopeA, adminA, second.planId, "race-key-b"),
        ]);
        const fulfilled = results.filter(
          (
            result,
          ): result is PromiseFulfilledResult<{
            install: PackageInstallDTO;
            created: boolean;
          }> => result.status === "fulfilled",
        );
        const rejected = results.filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        expect(fulfilled.length).toBe(1);
        expect(fulfilled[0].value.created).toBe(true);
        expect(rejected.length).toBe(1);
        expect((rejected[0].reason as Error).message).toBe("REVISION_CONFLICT");
        expect(await installRowCount(fixture.tenantOf("company-a"))).toBe(1);
      },
    );

    itDb(
      "same company, different team: plan/apply/detail stay inside their team",
      async () => {
        const adminA = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const planA = await service.plan(
          scopeA,
          adminA,
          input(PACKAGE, { config: { region: "team-a1" } }),
        );
        // Team A1's plan presented in team A2 is the same not-found as an
        // unknown id: a plan never crosses a team boundary inside one company.
        await expectCode(
          service.apply(scopeA2Admin, adminA, planA.planId, "cross-team-key"),
          "RESOURCE_NOT_FOUND",
        );
        expect(await installRowCount(fixture.tenantOf("company-a"))).toBe(0);

        const planA2 = await service.plan(
          scopeA2Admin,
          adminA,
          input(PACKAGE, { config: { region: "team-a2" } }),
        );
        const appliedA = await service.apply(
          scopeA,
          adminA,
          planA.planId,
          "team-a1-key",
        );
        const appliedA2 = await service.apply(
          scopeA2Admin,
          adminA,
          planA2.planId,
          "team-a2-key",
        );
        expect(appliedA.created).toBe(true);
        expect(appliedA2.created).toBe(true);
        expect(appliedA.install.installId).not.toBe(
          appliedA2.install.installId,
        );
        // Two installs for one company: the install key is per team.
        expect(await installRowCount(fixture.tenantOf("company-a"))).toBe(2);

        // Detail is team-bound in both directions.
        await expectCode(
          service.get(scopeA, appliedA2.install.installId),
          "RESOURCE_NOT_FOUND",
        );
        await expectCode(
          service.get(scopeA2Admin, appliedA.install.installId),
          "RESOURCE_NOT_FOUND",
        );
        const pageA = PackagePageSchema.parse(await service.list(scopeA, {}));
        expect(
          pageA.items.find((item) => item.packageKey === PACKAGE)?.install
            ?.installId,
        ).toBe(appliedA.install.installId);
        const pageA2Admin = PackagePageSchema.parse(
          await service.list(scopeA2Admin, {}),
        );
        expect(
          pageA2Admin.items.find((item) => item.packageKey === PACKAGE)?.install
            ?.installId,
        ).toBe(appliedA2.install.installId);
      },
    );

    itDb(
      "an expired confirm can be re-planned from the same non-secret input",
      async () => {
        const adminA = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const original = input(PACKAGE, { config: { region: "us" } });
        const expired = await service.plan(scopeA, adminA, original);
        clock = new Date(clock.getTime() + 11 * 60 * 1000);
        await expectCode(
          service.apply(scopeA, adminA, expired.planId, "expired-key"),
          "PLAN_EXPIRED",
        );
        expect(await installRowCount(fixture.tenantOf("company-a"))).toBe(0);

        // The caller still holds the non-secret input; planning it again must
        // succeed and install that same config.
        const replanned = await service.plan(scopeA, adminA, original);
        const applied = await service.apply(
          scopeA,
          adminA,
          replanned.planId,
          "replanned-key",
        );
        expect(applied.created).toBe(true);
        const configs = (await fixture.setup.$client.unsafe(
          "select config from enterprise_package_revisions where tenant_id = $1 and install_id = $2",
          [fixture.tenantOf("company-a"), applied.install.installId],
        )) as Array<{ config: Record<string, unknown> }>;
        expect(configs[0]?.config).toEqual({ region: "us" });
      },
    );

    itDb(
      "a plan row rewritten between readPlan and apply answers PLAN_CHANGED",
      async () => {
        const adminA = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const plan = await service.plan(scopeA, adminA, input(PACKAGE));
        const tenantId = fixture.tenantOf("company-a");
        // Simulate the TOCTOU window: readPlan returns the original row, then the
        // row's canonical input is rewritten before the write transaction reads
        // it. The recomputed digest no longer matches the stored one.
        const tampering: PackageMutationStore = {
          ...fixture.mutation,
          async readPlan(scope, planId) {
            const record = await fixture.mutation.readPlan(scope, planId);
            if (record) {
              const rewritten = {
                ...record.canonicalInput,
                config: { region: "tampered" },
              };
              await fixture.setup.$client.unsafe(
                "update enterprise_package_plans set canonical_input = $1::jsonb where tenant_id = $2 and id = $3",
                [rewritten, tenantId, planId],
              );
            }
            return record;
          },
        };
        const tamperedService = createPackageService({
          catalogue,
          readStore: fixture.readStore,
          mutation: tampering,
          now: () => clock,
        });
        await expectCode(
          tamperedService.apply(scopeA, adminA, plan.planId, "tamper-key"),
          "PLAN_CHANGED",
        );
        expect(await installRowCount(tenantId)).toBe(0);
      },
    );

    itDb(
      "R4-3: a connector install deleted between plan and apply refuses apply with zero link rows",
      async () => {
        const adminA = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const tenantId = fixture.tenantOf("company-a");
        // A dedicated connector install (own catalog row): deleting it below
        // must not disturb the shared connectorA other cases plan against.
        const catalogId = `pkg02-r44-catalog-${crypto.randomUUID()}`;
        await fixture.setup.$client.unsafe(
          `insert into enterprise_plugin_catalog (id, kind, title, vendor, source, metadata)
         values ($1, 'mcp', 'PKG02 R4-3 connector', 'acme', 'first-party', '{"summary":"s"}'::jsonb)`,
          [catalogId],
        );
        const ephemeralConnector = `pkg02-connector-${crypto.randomUUID()}`;
        await fixture.operator.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true)`,
          );
          await tx.execute(
            sql`insert into enterprise_plugin_installs
                (tenant_id, id, catalog_id, workspace_id, installed_by, config)
              values (${tenantId}, ${ephemeralConnector}, ${catalogId}, ${fixture.teamOf("company-a", "team-a1")}, ${fixture.principalOf("company-admin", "company-a")}, '{}'::jsonb)`,
          );
        });
        // Plan succeeds: the connector install exists and is mapped.
        const plan = await service.plan(
          scopeA,
          adminA,
          input(PACKAGE, {
            connectorInstalls: { calendar: ephemeralConnector },
          }),
        );
        expect(plan.blockers).toEqual([]);
        // The plan→apply window: the referenced connector install is deleted.
        await fixture.setup.$client.unsafe(
          "delete from enterprise_plugin_installs where tenant_id = $1 and id = $2",
          [tenantId, ephemeralConnector],
        );
        // Apply is refused with a branded, explainable code — never a bare
        // FK 500 — and the whole transaction rolls back.
        await expectCode(
          service.apply(scopeA, adminA, plan.planId, "missing-connector-key"),
          "CONNECTOR_INSTALL_MISSING",
        );
        expect(await installRowCount(tenantId)).toBe(0);
        expect(
          await countRows(
            "select count(*)::int as n from enterprise_package_resource_links where tenant_id = $1",
            [tenantId],
          ),
        ).toBe(0);
        expect(
          await countRows(
            "select count(*)::int as n from enterprise_package_changes where tenant_id = $1",
            [tenantId],
          ),
        ).toBe(0);
        // The plan was not consumed: the admin can re-plan and re-apply.
        const consumed = (await fixture.setup.$client.unsafe(
          "select consumed_at from enterprise_package_plans where tenant_id = $1 and id = $2",
          [tenantId, plan.planId],
        )) as Array<{ consumed_at: string | null }>;
        expect(consumed[0]?.consumed_at ?? null).toBeNull();
      },
    );

    itDb(
      "install detail links only the install's current revision",
      async () => {
        const adminA = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const plan = await service.plan(scopeA, adminA, input(PACKAGE));
        const applied = await service.apply(
          scopeA,
          adminA,
          plan.planId,
          "revision-key",
        );
        const tenantId = fixture.tenantOf("company-a");
        const installId = applied.install.installId;
        const workspaceId = fixture.teamOf("company-a", "team-a1");
        // A future revision with its own link exists (append-only history). The
        // install still points at revision 1, so that stale link must not appear.
        await fixture.setup.$client.unsafe(
          `insert into enterprise_package_revisions
         (tenant_id, install_id, revision, release_version, artifact_digest, config, created_by)
       values ($1, $2, 2, '1.0.0', $3, '{}'::jsonb, $4)`,
          [
            tenantId,
            installId,
            "b".repeat(64),
            fixture.principalOf("company-admin", "company-a"),
          ],
        );
        await fixture.setup.$client.unsafe(
          `insert into enterprise_package_resource_links
         (tenant_id, install_id, revision, resource_id, workspace_id, kind)
       values ($1, $2, 2, 'stale-skill', $3, 'skill')`,
          [tenantId, installId, workspaceId],
        );

        const facts = await fixture.readStore.getInstall(scopeA, installId);
        expect(facts).not.toBeNull();
        const detailResources =
          facts?.links.map((link) => link.resourceId) ?? [];
        expect(detailResources).toContain("summarize");
        expect(detailResources).not.toContain("stale-skill");
        const listed = await fixture.readStore.listInstalls(scopeA);
        const listedResources =
          listed
            .find((entry) => entry.installId === installId)
            ?.links.map((link) => link.resourceId) ?? [];
        expect(listedResources).not.toContain("stale-skill");
      },
    );

    itDb(
      "a platform administrator with no company membership is refused by the real authorizer",
      async () => {
        const actorId = `pkg02-platform-admin-${crypto.randomUUID()}`;
        const principalId = `pkg02-platform-principal-${crypto.randomUUID()}`;
        await fixture.setup.$client.unsafe(
          "insert into users (id, email) values ($1, $2)",
          [actorId, `${actorId}@pkg02.invalid`],
        );
        await fixture.setup.$client.unsafe(
          "insert into enterprise_principals (id, user_id) values ($1, $2)",
          [principalId, actorId],
        );
        try {
          // No enterprise_memberships row: platform-level identity is not a
          // company authority, and the refusal comes from the real authorizer.
          await expect(
            fixture.adminContextForActor(actorId, "company-a"),
          ).rejects.toThrow("TENANT_FORBIDDEN");
          await expect(
            fixture.adminContextForActor(actorId, "company-b"),
          ).rejects.toThrow("TENANT_FORBIDDEN");
        } finally {
          await fixture.setup.$client.unsafe(
            "delete from enterprise_principals where id = $1",
            [principalId],
          );
          await fixture.setup.$client.unsafe(
            "delete from users where id = $1",
            [actorId],
          );
        }
      },
    );

    itDb(
      "the same idempotency key with a different plan answers 409",
      async () => {
        const adminA = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const first = await service.plan(scopeA, adminA, input(PACKAGE));
        const second = await service.plan(
          scopeA,
          adminA,
          input(NEEDS_CALENDAR),
        );
        await service.apply(scopeA, adminA, first.planId, "shared-key");
        await expectCode(
          service.apply(scopeA, adminA, second.planId, "shared-key"),
          "IDEMPOTENCY_CONFLICT",
        );
      },
    );

    itDb(
      "a consumed plan replays after expiry; an unapplied expired plan answers 410",
      async () => {
        const adminA = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const applied = await service.plan(scopeA, adminA, input(PACKAGE));
        const first = await service.apply(
          scopeA,
          adminA,
          applied.planId,
          "expiry-key",
        );
        const neverApplied = await service.plan(
          scopeA,
          adminA,
          input(NEEDS_CALENDAR),
        );
        clock = new Date(clock.getTime() + 11 * 60 * 1000);
        // Same key after expiry → the original result, not 410.
        const replay = await service.apply(
          scopeA,
          adminA,
          applied.planId,
          "expiry-key",
        );
        expect(replay.created).toBe(false);
        expect(replay.install).toEqual(first.install);
        // A consumed plan under a new key still returns the original result.
        const newKeyReplay = await service.apply(
          scopeA,
          adminA,
          applied.planId,
          "expiry-key-2",
        );
        expect(newKeyReplay.install).toEqual(first.install);
        // A plan that was never applied expires.
        await expectCode(
          service.apply(scopeA, adminA, neverApplied.planId, "fresh-key"),
          "PLAN_EXPIRED",
        );
      },
    );

    itDb(
      "expectedRevision is null for the first install and refuses CAS in PKG02",
      async () => {
        const adminA = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        await expectCode(
          service.plan(scopeA, adminA, input(PACKAGE, { expectedRevision: 1 })),
          "REVISION_CONFLICT",
        );
        const first = await service.plan(scopeA, adminA, input(PACKAGE));
        await service.apply(scopeA, adminA, first.planId, "cas-first");
        const second = await service.plan(scopeA, adminA, input(PACKAGE));
        await expectCode(
          service.apply(scopeA, adminA, second.planId, "cas-second"),
          "REVISION_CONFLICT",
        );
      },
    );

    itDb(
      "unlisted releases cannot be planned and a changed digest is refused at apply",
      async () => {
        const adminA = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        await expectCode(
          service.plan(scopeA, adminA, input(UNLISTED)),
          "PACKAGE_UNSUPPORTED",
        );
        await expectCode(
          service.plan(scopeA, adminA, input("openbot/does-not-exist")),
          "RESOURCE_NOT_FOUND",
        );
        const plan = await service.plan(scopeA, adminA, input(PACKAGE));
        // Arrangement stand-in: tamper the stored plan digest between plan/apply.
        await fixture.setup.$client.unsafe(
          "update enterprise_package_plans set artifact_digest = $1 where tenant_id = $2 and id = $3",
          ["b".repeat(64), fixture.tenantOf("company-a"), plan.planId],
        );
        await expectCode(
          service.apply(scopeA, adminA, plan.planId, "digest-key"),
          "PLAN_CHANGED",
        );
        expect(await installRowCount(fixture.tenantOf("company-a"))).toBe(0);
      },
    );

    itDb(
      "cross-scope plan and install ids answer the same not-found",
      async () => {
        const adminA = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const adminB = await fixture.adminContextOf("b1-member", "company-b");
        const plan = await service.plan(scopeA, adminA, input(PACKAGE));
        const applied = await service.apply(
          scopeA,
          adminA,
          plan.planId,
          "scope-key",
        );
        const cases: ReadonlyArray<readonly [string, Promise<unknown>]> = [
          [
            "cross-scope plan",
            service.apply(scopeB, adminB, plan.planId, "scope-key-b"),
          ],
          [
            "unknown plan",
            service.apply(scopeB, adminB, "unknown-plan-id", "scope-key-b"),
          ],
          [
            "cross-scope install",
            service.get(scopeB, applied.install.installId),
          ],
          ["unknown install", service.get(scopeB, "unknown-install-id")],
        ];
        // Handlers attach immediately: an unobserved rejection between sequential
        // awaits would otherwise be reported as an unhandled failure.
        const states = await Promise.all(
          cases.map(async ([label, promise]) => ({
            label,
            state: await promise.then(
              () => `resolved:${label}`,
              (error: Error) => error.message,
            ),
          })),
        );
        for (const { label, state } of states) {
          expect({ label, state }).toEqual({
            label,
            state: "RESOURCE_NOT_FOUND",
          });
        }
      },
    );

    itDb("a membership revoked between plan and apply is refused", async () => {
      const scope = await fixture.scopeFor("company-admin", "team-a1");
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      const plan = await service.plan(scope, admin, input(PACKAGE));
      await fixture.setCompanyMembershipStatus(
        "company-admin",
        "company-a",
        "suspended",
      );
      // Stale scope + admin context: refused inside the write transaction.
      await expectCode(
        service.apply(scope, admin, plan.planId, "revoked-key"),
        "TENANT_FORBIDDEN",
      );
      // A fresh authorizer refuses too (no company authority while suspended).
      await expect(
        fixture.adminContextOf("company-admin", "company-a"),
      ).rejects.toThrow("TENANT_FORBIDDEN");
      expect(await installRowCount(fixture.tenantOf("company-a"))).toBe(0);
      await fixture.setCompanyMembershipStatus(
        "company-admin",
        "company-a",
        "active",
      );
      // Restoration advances the epoch: re-issue the scope for later cases.
      scopeA = await fixture.scopeFor("company-admin", "team-a1");
    });

    itDb("plan and apply make no vendor or transport call", async () => {
      const adminA = await fixture.adminContextOf("company-admin", "company-a");
      const originalFetch = globalThis.fetch;
      let transportCalls = 0;
      globalThis.fetch = (async () => {
        transportCalls += 1;
        throw new Error("transport must not be used");
      }) as typeof fetch;
      try {
        const plan = await service.plan(
          scopeA,
          adminA,
          input(PACKAGE, { connectorInstalls: { calendar: connectorA } }),
        );
        await service.apply(scopeA, adminA, plan.planId, "no-transport");
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect(transportCalls).toBe(0);
    });
  },
);
