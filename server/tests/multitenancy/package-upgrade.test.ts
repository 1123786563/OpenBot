// server/tests/multitenancy/package-upgrade.test.ts
// PKG06（Issue #465）：升级/回滚与权限增量——真实受限角色证据面。
//
// 证据映射（#465 AC + A03/A06/A07 + Spec §10）：
//   (1) plan 预览：精确版本 diff（资源/工具/effect/schema digest/连接/配置），
//       权限增量=新增工具+read→write+digest 变化（AC1/AC2）。
//   (2) plan 拒绝面：未安装包 upgrade=404 同形；expectedRevision 空/过期=409；
//       未发布（unlisted）/未知版本目标拒绝；install-on-installed 自动按
//       upgrade 语义呈现（PKG02 L-1）。
//   (3) apply：CAS 期望 revision；并发升级一个赢一个确定 409（A07/AC4）；
//       revision 单调递增、generation 不变；同版本同配置幂等。
//   (4) 旧 Run（A06/AC3 两版本对照）：旧 pin 继续读旧 revision 的 Skill、
//       不装载新 Skill；已移除/已变更工具即使在旧 pin 内也不能派发
//       （transport 0 次）；新工具仅对重新授权后的新执行可用。
//   (5) 回滚（AC5）：新建 revision、generation/revision 不倒退、不复活
//       已撤销 grant；目标仍须 published。
//   (6) 升级不动其他团队同包安装与已创建专家行（AC7）；allowedActions 按
//       调用者角色如实给出（member=空）。
//
// 全部判定经真实受限角色与真实 RLS；vendor transport 为可控注入。

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sql } from "drizzle-orm";
import type {
  PackageInstallDTO,
  PackageManifestV1,
} from "../../../shared/enterprise/plugin-package-contracts";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import type { Database } from "../../src/db/client";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  createPackageDispatchService,
  type PackageVendorCaller,
} from "../../src/enterprise/plugin-packages/dispatch";
import {
  createPackageService,
  type PackageService,
} from "../../src/enterprise/plugin-packages/install-service";
import { addedToolsOf } from "../../src/enterprise/plugin-packages/plans";
import { createPackageRuntime } from "../../src/enterprise/plugin-packages/runtime";
import type { SecretVault } from "../../src/enterprise/tenancy/credential-ownership";
import { createPluginCatalogDecisionService } from "../../src/enterprise/tenancy/plugin-catalog";
import { createToolInvocationService } from "../../src/enterprise/tenancy/tool-invocation";
import {
  buildArtifact,
  storeArtifact,
} from "../../src/plugin-packages/artifact";
import {
  loadPackageCatalogue,
  type PackageCatalogue,
} from "../../src/plugin-packages/catalogue";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import {
  applyPackageTasks,
  createPackageInstallFixture,
  type PackageInstallFixture,
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
      reason: `PKG06 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

const PACKAGE_KEY = "openbot/pkg06-flow";
const CONNECTOR = "crm";
const SKILL_KEEP = "summarize";
const SKILL_REMOVED = "legacy-note";
const SKILL_NEW = "fresh-guide";
const V1 = "1.0.0";
const V2 = "2.0.0";
const V3 = "3.0.0";
const SECRET_CANARY = "pkg06-secret-canary";

let fixture: PackageInstallFixture;
let setup: Database;
let service: PackageService;
let catalogue: PackageCatalogue;
let runtime: ReturnType<typeof createPackageRuntime>;
let dispatch: ReturnType<typeof createPackageDispatchService>;
let artifactRoot: string;
let manifestV1: PackageManifestV1;
let clock: Date;
let companyA = "";
let teamA1 = "";
let adminPrincipal = "";
let scopeA1: PlatformScope;
let scopeA1Member: PlatformScope;
let scopeA2: PlatformScope;
let connectorA1 = "";
let catalogId = "";

let vendorCalls = 0;
const vault: SecretVault = {
  seal: async (plaintext) => `pkg06-envelope:${plaintext}`,
  open: async (envelope) => {
    if (!envelope.startsWith("pkg06-envelope:")) {
      throw new Error("PKG06_TEST_ENVELOPE_INVALID");
    }
    return envelope.slice("pkg06-envelope:".length);
  },
};
const vendorCall: PackageVendorCaller = async () => {
  vendorCalls += 1;
  return { text: "ok", isError: false };
};

async function storeVersion(
  version: string,
  definition: {
    skills: readonly string[];
    tools: Array<[string, "read" | "write"]>;
  },
): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), "pkg06-source-"));
  const manifest: PackageManifestV1 = {
    schemaVersion: 1,
    platformApi: 1,
    publisher: "openbot",
    name: "pkg06-flow",
    version,
    display: {
      name: `PKG06 flow ${version}`,
      summary: `The PKG06 flow package ${version}.`,
    },
    resources: [
      ...definition.skills.map((skill) => ({
        kind: "skill" as const,
        id: skill,
        path: `skills/${skill}/SKILL.md`,
      })),
      {
        kind: "managedConnector" as const,
        id: CONNECTOR,
        catalogKey: "pkg06-crm",
        required: true,
        tools: definition.tools.map(([name, effect]) => ({ name, effect })),
      },
    ],
    dependencies: [],
  };
  try {
    await writeFile(
      join(source, "openbot.plugin.json"),
      JSON.stringify(manifest),
    );
    for (const skill of definition.skills) {
      const absolute = join(source, "skills", skill, "SKILL.md");
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, `# ${skill} @ ${version}\n`);
    }
    const artifact = await buildArtifact(source);
    await storeArtifact(artifact, artifactRoot);
    if (version === V1) manifestV1 = manifest;
    return artifact.digest;
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toThrow(code);
}

async function seedBot(workspaceId: string): Promise<string> {
  const agentId = `pkg06-bot-${randomUUID()}`;
  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${workspaceId}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_bot_ownership
            (tenant_id, agent_id, workspace_id, owner_principal_id, display_name, default_config)
          values (${companyA}, ${agentId}, ${workspaceId}, ${adminPrincipal}, 'PKG06 bot', '{}'::jsonb)`,
    );
  });
  return agentId;
}

/** Arrangement (superuser, disclosed): the run row + admitted expert version. */
async function seedRun(input: {
  botId: string;
  workspaceId: string;
}): Promise<string> {
  const runId = randomUUID();
  const expertVersionRef = `pkg06-expert-${randomUUID()}`;
  await setup.$client.unsafe(
    `insert into enterprise_expert_versions
       (tenant_id, expert_version_ref, schema_version, agent_id, snapshot)
     values ($1, $2, 1, $3, '{}'::jsonb)`,
    [companyA, expertVersionRef, input.botId],
  );
  await setup.$client.unsafe(
    `insert into enterprise_runs
       (id, tenant_id, workspace_id, principal_id, thread_id, client_message_key,
        expert_version_ref, model_route_ref, model_route_maximum_tokens, status,
        attempt_generation, lease_expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'pkg06-route', 1000, 'running', 1, now() + interval '1 hour')`,
    [
      runId,
      companyA,
      input.workspaceId,
      adminPrincipal,
      `pkg06-thread-${randomUUID()}`,
      `pkg06-msg-${randomUUID()}`,
      expertVersionRef,
    ],
  );
  return runId;
}

type DataTx = Parameters<
  Parameters<
    import("../../src/enterprise/tenancy/connections").DataDatabase["transaction"]
  >[0]
>[0];

async function withinRunTx<T>(
  scope: PlatformScope,
  work: (tx: DataTx) => Promise<T>,
): Promise<T> {
  return fixture.base.data.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
    );
    return work(tx);
  });
}

/**
 * Arrangement (operator channel, disclosed): one v1 tool grant generation for
 * the bot — the same rows the grant service writes, with contracts taken from
 * the REAL v1 manifest so the pin/dispatch gates see reviewed digests.
 */
async function seedV1Grants(input: {
  installId: string;
  botId: string;
  skills?: readonly string[];
  tools?: readonly string[];
}): Promise<void> {
  const skills = input.skills ?? [SKILL_KEEP, SKILL_REMOVED];
  const tools = addedToolsOf(manifestV1).filter((tool) =>
    (input.tools ?? [`${CONNECTOR}:lookup`, `${CONNECTOR}:purge`]).includes(
      tool.ref,
    ),
  );
  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
    );
    for (const skill of skills) {
      await tx.execute(
        sql`insert into enterprise_package_grants
              (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
               resource_kind, tool_ref, granted_by)
            values (${companyA}, ${input.installId}, 1, ${input.botId}, ${skill}, ${teamA1}, 'skill', '', ${adminPrincipal})`,
      );
    }
    for (const tool of tools) {
      await tx.execute(
        sql`insert into enterprise_package_grants
              (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
               resource_kind, tool_ref, schema_digest, effect, connector_install_id, granted_by)
            values (${companyA}, ${input.installId}, 1, ${input.botId}, ${CONNECTOR}, ${teamA1},
                    'connectorTool', ${tool.ref}, ${tool.schemaDigest}, ${tool.effect},
                    ${connectorA1}, ${adminPrincipal})`,
      );
    }
  });
}

async function pinRun(input: {
  scope: PlatformScope;
  botId: string;
  runId: string;
}): Promise<void> {
  await withinRunTx(input.scope, (tx) =>
    runtime.prepareWithin(tx, input.scope, {
      botId: input.botId,
      runId: input.runId,
      attemptGeneration: 1,
    }),
  );
}

interface InstalledCase {
  installId: string;
  botId: string;
  runId: string;
  install: PackageInstallDTO;
}

/** Install v1 for the CURRENT case (real service path), grant, pin run 1. */
async function installV1Case(input?: {
  config?: Record<string, unknown>;
}): Promise<InstalledCase> {
  const admin = await fixture.adminContextOf("company-admin", "company-a");
  const plan = await service.plan(scopeA1, admin, {
    operation: "install",
    packageKey: PACKAGE_KEY,
    version: V1,
    expectedRevision: null,
    config: input?.config ?? { region: "us" },
    connectorInstalls: { crm: connectorA1 },
  });
  const applied = await service.apply(
    scopeA1,
    admin,
    plan.planId,
    `pkg06-install-${randomUUID()}`,
  );
  const botId = await seedBot(teamA1);
  await seedV1Grants({ installId: applied.install.installId, botId });
  const runId = await seedRun({ botId, workspaceId: teamA1 });
  await pinRun({ scope: scopeA1, botId, runId });
  return {
    installId: applied.install.installId,
    botId,
    runId,
    install: applied.install,
  };
}

function toolRefFor(installId: string, toolName: string): string {
  return `pkg:${installId}:${CONNECTOR}/${toolName}`;
}

describeDb("PKG06 package upgrade/rollback (real roles)", () => {
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
    await fixture.addTeamMember(
      "company-admin",
      "company-a",
      "company-admin",
      "team-a2",
    );
    companyA = fixture.tenantOf("company-a");
    teamA1 = fixture.teamOf("company-a", "team-a1");
    adminPrincipal = fixture.principalOf("company-admin", "company-a");
    scopeA1 = await fixture.scopeFor("company-admin", "team-a1");
    scopeA1Member = await fixture.scopeFor("a1-member", "team-a1");
    scopeA2 = await fixture.scopeFor("company-admin", "team-a2");

    artifactRoot = await mkdtemp(join(tmpdir(), "pkg06-artifacts-"));
    const digestV1 = await storeVersion(V1, {
      skills: [SKILL_KEEP, SKILL_REMOVED],
      tools: [
        ["lookup", "read"],
        ["purge", "write"],
      ],
    });
    const digestV2 = await storeVersion(V2, {
      skills: [SKILL_KEEP, SKILL_NEW],
      tools: [
        ["lookup", "write"],
        ["search", "read"],
      ],
    });
    // A third listed release for concurrent-upgrade races (two live targets).
    const digestV3 = await storeVersion(V3, {
      skills: [SKILL_KEEP],
      tools: [["lookup", "read"]],
    });
    // Withdrawn target: listed false, artifact present.
    let digestUnlisted = "";
    const source = await mkdtemp(join(tmpdir(), "pkg06-source-unlisted-"));
    try {
      const manifest: PackageManifestV1 = {
        schemaVersion: 1,
        platformApi: 1,
        publisher: "openbot",
        name: "pkg06-flow",
        version: "2.5.0",
        display: { name: "PKG06 withdrawn", summary: "Withdrawn target." },
        resources: [
          {
            kind: "skill",
            id: SKILL_KEEP,
            path: `skills/${SKILL_KEEP}/SKILL.md`,
          },
        ],
        dependencies: [],
      };
      await writeFile(
        join(source, "openbot.plugin.json"),
        JSON.stringify(manifest),
      );
      const absolute = join(source, "skills", SKILL_KEEP, "SKILL.md");
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, `# ${SKILL_KEEP}\n`);
      const artifact = await buildArtifact(source);
      await storeArtifact(artifact, artifactRoot);
      digestUnlisted = artifact.digest;
    } finally {
      await rm(source, { recursive: true, force: true });
    }

    catalogue = await loadPackageCatalogue({
      artifactRoot,
      index: {
        schemaVersion: 1,
        packages: [
          {
            packageKey: PACKAGE_KEY,
            version: V1,
            artifactDigest: digestV1,
            category: "productivity",
            listed: true,
          },
          {
            packageKey: PACKAGE_KEY,
            version: V2,
            artifactDigest: digestV2,
            category: "productivity",
            listed: true,
          },
          {
            packageKey: PACKAGE_KEY,
            version: V3,
            artifactDigest: digestV3,
            category: "productivity",
            listed: true,
          },
          {
            packageKey: PACKAGE_KEY,
            version: "2.5.0",
            artifactDigest: digestUnlisted,
            category: "productivity",
            listed: false,
          },
        ],
      },
    });
    clock = new Date("2026-10-25T00:00:00.000Z");
    service = createPackageService({
      catalogue,
      readStore: fixture.readStore,
      mutation: fixture.mutation,
      artifactRoot,
      now: () => clock,
    });
    runtime = createPackageRuntime({ data: fixture.base.data, artifactRoot });
    dispatch = createPackageDispatchService({
      data: fixture.base.data,
      catalogue,
      artifactRoot,
      vault,
      toolInvocation: createToolInvocationService({ data: fixture.base.data }),
      catalogDecisions: createPluginCatalogDecisionService(fixture.base.data),
      pinnedTools: runtime.readPinnedTools,
      vendorCall,
    });

    // One MT031 catalogue entry + connector install + the caller's connection.
    catalogId = `pkg06-crm-${randomUUID()}`;
    await setup.$client.unsafe(
      `insert into enterprise_plugin_catalog (id, kind, title, vendor, source, metadata)
       values ($1, 'mcp', 'PKG06 CRM', 'openbot', 'first-party', '{"summary":"CRM"}'::jsonb)`,
      [catalogId],
    );
    connectorA1 = `pkg06-connector-${randomUUID()}`;
    const connectionId = `pkg06-connection-${randomUUID()}`;
    await fixture.operator.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
      );
      await tx.execute(
        sql`insert into enterprise_plugin_installs
              (tenant_id, id, catalog_id, workspace_id, installed_by, config, envelope, status)
            values (${companyA}, ${connectorA1}, ${catalogId}, ${teamA1}, ${adminPrincipal},
                    '{"url":"https://pkg06-managed.example.test/mcp"}'::jsonb,
                    ${`pkg06-envelope:${SECRET_CANARY}`}, 'active')`,
      );
      await tx.execute(
        sql`insert into enterprise_plugin_connections
              (tenant_id, id, install_id, bound_by, vendor_ref, generation)
            values (${companyA}, ${connectionId}, ${connectorA1}, ${adminPrincipal}, 'acct-admin', 1)`,
      );
    });
  }, 180_000);

  beforeEach(async () => {
    clock = new Date("2026-10-25T00:00:00.000Z");
    // One install per (tenant, workspace, package_key): every case starts
    // from a clean install so its revision/generation/receipt expectations
    // describe only THIS case (same discipline as the PKG02 integration
    // suite; superuser arrangement, disclosed).
    for (const table of [
      "enterprise_package_changes",
      "enterprise_package_resource_links",
      "enterprise_package_plans",
      "enterprise_package_revisions",
      "enterprise_package_installs",
    ]) {
      await setup.$client.unsafe(`delete from ${table} where tenant_id = $1`, [
        companyA,
      ]);
    }
  }, 60_000);

  afterAll(async () => {
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
    if (fixture) await fixture.dispose();
  });

  itDb(
    "upgrade plan previews the exact version diff and permission increment (AC1/AC2)",
    async () => {
      const current = await installV1Case();
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      const plan = await service.plan(scopeA1, admin, {
        operation: "upgrade",
        packageKey: PACKAGE_KEY,
        version: V2,
        expectedRevision: current.install.revision,
        config: { region: "us", verbosity: 3 },
        connectorInstalls: { crm: connectorA1 },
      });
      expect(plan.operation).toBe("upgrade");
      expect(plan.version).toBe(V2);
      expect(plan.expectedRevision).toBe(current.install.revision);
      expect(plan.diff?.currentVersion).toBe(V1);
      expect(plan.diff?.currentRevision).toBe(current.install.revision);
      // Resource diff: the new guide arrives, the legacy note leaves.
      expect(plan.diff?.addedResources).toEqual([
        { id: SKILL_NEW, kind: "skill" },
      ]);
      expect(plan.diff?.removedResources).toEqual([
        { id: SKILL_REMOVED, kind: "skill" },
      ]);
      // Permission increment: the NEW tool plus the read→write change.
      const incrementRefs = plan.addedTools.map((tool) => tool.ref).sort();
      expect(incrementRefs).toEqual([
        `${CONNECTOR}:lookup`,
        `${CONNECTOR}:search`,
      ]);
      const lookup = plan.addedTools.find(
        (tool) => tool.ref === `${CONNECTOR}:lookup`,
      );
      expect(lookup?.effect).toBe("write");
      expect(plan.diff?.changedTools).toEqual([
        expect.objectContaining({
          ref: `${CONNECTOR}:lookup`,
          previousEffect: "read",
          effect: "write",
        }),
      ]);
      expect(plan.removedTools).toEqual([`${CONNECTOR}:purge`]);
      // Full-config diff narration: one key added, none silently migrated.
      expect(plan.diff?.configChanges).toEqual([
        { key: "verbosity", change: "added" },
      ]);
      expect(plan.diff?.connectionChanges).toEqual([]);
      // The changed digest really differs (a capability change, not a rename).
      const changed = plan.diff?.changedTools[0];
      expect(changed?.previousSchemaDigest).not.toBe(changed?.schemaDigest);
    },
  );

  itDb(
    "plan refusals: exact published target only; CAS binds the live revision (AC1/AC4)",
    async () => {
      const current = await installV1Case();
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      // No install → same 404 as an unknown id, never a first-install preview.
      await expectCode(
        service.plan(scopeA2, admin, {
          operation: "upgrade",
          packageKey: PACKAGE_KEY,
          version: V2,
          expectedRevision: 1,
          config: {},
          connectorInstalls: {},
        }),
        "RESOURCE_NOT_FOUND",
      );
      // Withdrawn (unlisted) target: published-only, exact version.
      await expectCode(
        service.plan(scopeA1, admin, {
          operation: "upgrade",
          packageKey: PACKAGE_KEY,
          version: "2.5.0",
          expectedRevision: current.install.revision,
          config: {},
          connectorInstalls: {},
        }),
        "PACKAGE_UNSUPPORTED",
      );
      // Unknown version: 404, no latest resolution.
      await expectCode(
        service.plan(scopeA1, admin, {
          operation: "upgrade",
          packageKey: PACKAGE_KEY,
          version: "9.9.9",
          expectedRevision: current.install.revision,
          config: {},
          connectorInstalls: {},
        }),
        "RESOURCE_NOT_FOUND",
      );
      // Null and stale revisions answer the same 409.
      await expectCode(
        service.plan(scopeA1, admin, {
          operation: "upgrade",
          packageKey: PACKAGE_KEY,
          version: V2,
          expectedRevision: null,
          config: {},
          connectorInstalls: {},
        }),
        "REVISION_CONFLICT",
      );
      await expectCode(
        service.plan(scopeA1, admin, {
          operation: "upgrade",
          packageKey: PACKAGE_KEY,
          version: V2,
          expectedRevision: current.install.revision + 5,
          config: {},
          connectorInstalls: {},
        }),
        "REVISION_CONFLICT",
      );
      // PKG02 L-1: an install plan for the installed package is presented as
      // the upgrade it is — current→target diff, CAS-bound revision, no
      // first-install misdirection.
      const presented = await service.plan(scopeA1, admin, {
        operation: "install",
        packageKey: PACKAGE_KEY,
        version: V2,
        expectedRevision: null,
        config: {},
        connectorInstalls: {},
      });
      expect(presented.operation).toBe("upgrade");
      expect(presented.expectedRevision).toBe(current.install.revision);
      expect(presented.diff?.currentVersion).toBe(V1);
    },
  );

  itDb(
    "apply upgrades: revision advances, generation holds, grants untouched; old run keeps the old revision (A06/AC3)",
    async () => {
      const current = await installV1Case();
      const admin = await fixture.adminContextOf("company-admin", "company-a");

      // BEFORE: the pinned run serves v1's skills and lookup is dispatchable.
      const beforeSkills = await runtime.readPinnedSkills(scopeA1, {
        botId: current.botId,
        runId: current.runId,
        attemptGeneration: 1,
      });
      expect(beforeSkills.map((skill) => slugOf(skill)).sort()).toEqual(
        [SKILL_KEEP, SKILL_REMOVED].sort(),
      );
      vendorCalls = 0;
      const beforeDispatch = await dispatch.execute(scopeA1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        bindingId: toolRefFor(current.installId, "lookup"),
        args: { query: "before" },
      });
      expect(beforeDispatch.outcome).toBe("ok");
      expect(vendorCalls).toBe(1);

      const grantsBefore = (await setup.$client.unsafe(
        "select count(*)::int as n from enterprise_package_grants where install_id = $1 and revoked_at is null",
        [current.installId],
      )) as Array<{ n: number }>;

      const plan = await service.plan(scopeA1, admin, {
        operation: "upgrade",
        packageKey: PACKAGE_KEY,
        version: V2,
        expectedRevision: current.install.revision,
        config: { region: "us" },
        connectorInstalls: { crm: connectorA1 },
      });
      const upgraded = await service.apply(
        scopeA1,
        admin,
        plan.planId,
        `pkg06-upgrade-${randomUUID()}`,
      );
      expect(upgraded.created).toBe(false);
      expect(upgraded.install.version).toBe(V2);
      expect(upgraded.install.revision).toBe(current.install.revision + 1);
      expect(upgraded.install.generation).toBe(current.install.generation);

      // The change receipt narrates the move with its previous version.
      const receipt = (await setup.$client.unsafe(
        "select action, diff from enterprise_package_changes where install_id = $1 order by created_at desc limit 1",
        [current.installId],
      )) as Array<{ action: string; diff: Record<string, unknown> }>;
      expect(receipt[0]?.action).toBe("upgrade");
      expect(receipt[0]?.diff).toMatchObject({
        previousVersion: V1,
        previousRevision: current.install.revision,
        version: V2,
      });

      // Grants are neither revoked nor revived by the upgrade.
      const grantsAfter = (await setup.$client.unsafe(
        "select count(*)::int as n from enterprise_package_grants where install_id = $1 and revoked_at is null",
        [current.installId],
      )) as Array<{ n: number }>;
      expect(Number(grantsAfter[0]?.n ?? 0)).toBe(
        Number(grantsBefore[0]?.n ?? 0),
      );

      // OLD RUN: keeps reading the OLD revision's skills; the new skill is
      // not loaded even though the bot keeps its grants.
      const afterSkills = await runtime.readPinnedSkills(scopeA1, {
        botId: current.botId,
        runId: current.runId,
        attemptGeneration: 1,
      });
      expect(afterSkills.map((skill) => slugOf(skill)).sort()).toEqual(
        [SKILL_KEEP, SKILL_REMOVED].sort(),
      );

      // OLD RUN dispatch: the read→write change refuses the old pin (grant
      // still carries the read contract, the current manifest declares write);
      // the removed tool refuses inside the old pin; the new tool is not in
      // the pin at all. Zero transport calls for all three.
      vendorCalls = 0;
      const changed = await dispatch.execute(scopeA1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        bindingId: toolRefFor(current.installId, "lookup"),
        args: { query: "after" },
      });
      expect(changed).toEqual({ outcome: "refused", code: "NOT_AVAILABLE" });
      const removed = await dispatch.execute(scopeA1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        bindingId: toolRefFor(current.installId, "purge"),
        args: {},
      });
      expect(removed).toEqual({ outcome: "refused", code: "NOT_AVAILABLE" });
      const fresh = await dispatch.execute(scopeA1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        bindingId: toolRefFor(current.installId, "search"),
        args: {},
      });
      expect(fresh).toEqual({ outcome: "refused", code: "NOT_AVAILABLE" });
      expect(vendorCalls).toBe(0);

      // NEW RUN after the upgrade: pins the new revision narrowed by the
      // standing v1 grants — new skill absent (not granted), old tool
      // contracts pinned but refused at dispatch until re-granted.
      const run2 = await seedRun({
        botId: current.botId,
        workspaceId: teamA1,
      });
      await pinRun({ scope: scopeA1, botId: current.botId, runId: run2 });
      const run2Skills = await runtime.readPinnedSkills(scopeA1, {
        botId: current.botId,
        runId: run2,
        attemptGeneration: 1,
      });
      expect(run2Skills.map((skill) => slugOf(skill)).sort()).toEqual([
        SKILL_KEEP,
      ]);
      const run2Dispatch = await dispatch.execute(scopeA1, {
        runId: run2,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        bindingId: toolRefFor(current.installId, "lookup"),
        args: {},
      });
      expect(run2Dispatch).toEqual({
        outcome: "refused",
        code: "NOT_AVAILABLE",
      });
    },
  );

  itDb(
    "re-grant after the increment opens the tool for NEW runs only; the old pin never absorbs it (AC2/AC3)",
    async () => {
      const current = await installV1Case();
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      const plan = await service.plan(scopeA1, admin, {
        operation: "upgrade",
        packageKey: PACKAGE_KEY,
        version: V2,
        expectedRevision: current.install.revision,
        config: { region: "us" },
        connectorInstalls: { crm: connectorA1 },
      });
      const upgraded = await service.apply(
        scopeA1,
        admin,
        plan.planId,
        `pkg06-regrant-${randomUUID()}`,
      );
      expect(upgraded.install.revision).toBe(2);

      // The explicit re-authorization: the grant service writes a NEW grant
      // generation whose contracts come from the CURRENT revision manifest.
      await service.setBotGrant(
        scopeA1,
        admin,
        {
          installId: current.installId,
          botId: current.botId,
          expectedGrantRevision: 1,
          resources: [
            {
              resourceId: CONNECTOR,
              kind: "managedConnector",
              toolRefs: [`${CONNECTOR}:lookup`, `${CONNECTOR}:search`],
            },
            // A PUT grant supersedes the pair's whole previous generation:
            // the still-wanted skills travel with the re-authorization.
            { resourceId: SKILL_KEEP, kind: "skill" },
            { resourceId: SKILL_NEW, kind: "skill" },
          ],
        },
        `pkg06-regrant-key-${randomUUID()}`,
      );

      // The OLD run still refuses the changed tool (its pin holds the v1
      // contract; a newer grant never widens an old pin).
      vendorCalls = 0;
      const oldRun = await dispatch.execute(scopeA1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        bindingId: toolRefFor(current.installId, "lookup"),
        args: {},
      });
      expect(oldRun).toEqual({ outcome: "refused", code: "NOT_AVAILABLE" });

      // A NEW run pins the re-granted contracts and dispatches both tools.
      const run2 = await seedRun({
        botId: current.botId,
        workspaceId: teamA1,
      });
      await pinRun({ scope: scopeA1, botId: current.botId, runId: run2 });
      const lookup = await dispatch.execute(scopeA1, {
        runId: run2,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        bindingId: toolRefFor(current.installId, "lookup"),
        args: {},
      });
      expect(lookup.outcome).toBe("ok");
      const search = await dispatch.execute(scopeA1, {
        runId: run2,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        bindingId: toolRefFor(current.installId, "search"),
        args: {},
      });
      expect(search.outcome).toBe("ok");
      // The newly granted skill is served to the new run.
      const run2Skills = await runtime.readPinnedSkills(scopeA1, {
        botId: current.botId,
        runId: run2,
        attemptGeneration: 1,
      });
      expect(run2Skills.map((skill) => slugOf(skill)).sort()).toEqual(
        [SKILL_NEW, SKILL_KEEP].sort(),
      );
      expect(vendorCalls).toBe(2);
    },
  );

  itDb(
    "concurrent upgrades: one wins, the stale one answers a deterministic 409 (A07/AC4)",
    async () => {
      const current = await installV1Case();
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      const planV2 = await service.plan(scopeA1, admin, {
        operation: "upgrade",
        packageKey: PACKAGE_KEY,
        version: V2,
        expectedRevision: current.install.revision,
        config: { region: "us" },
        connectorInstalls: { crm: connectorA1 },
      });
      const planV3 = await service.plan(scopeA1, admin, {
        operation: "upgrade",
        packageKey: PACKAGE_KEY,
        version: V3,
        expectedRevision: current.install.revision,
        config: { region: "us" },
        connectorInstalls: { crm: connectorA1 },
      });
      const [raceV2, raceV3] = await Promise.all([
        service
          .apply(scopeA1, admin, planV2.planId, `race-v2-${randomUUID()}`)
          .then(
            (value) => ({ plan: "v2", value }),
            (error: Error) => ({ plan: "v2", error }),
          ),
        service
          .apply(scopeA1, admin, planV3.planId, `race-v3-${randomUUID()}`)
          .then(
            (value) => ({ plan: "v3", value }),
            (error: Error) => ({ plan: "v3", error }),
          ),
      ]);
      const winners = [raceV2, raceV3].filter((entry) => !("error" in entry));
      const losers = [raceV2, raceV3].filter((entry) => "error" in entry);
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(1);
      const lost = losers[0] as { plan: string; error: Error };
      expect(lost.error.message).toBe("REVISION_CONFLICT");
      const winner = winners[0] as {
        plan: string;
        value: { install: PackageInstallDTO };
      };
      expect(winner.value.install.revision).toBe(2);
      // Exactly one install row, exactly two revisions.
      const rows = (await setup.$client.unsafe(
        "select revision, current_version from enterprise_package_installs where id = $1",
        [current.installId],
      )) as Array<{ revision: number; current_version: string }>;
      expect(rows[0]?.revision).toBe(2);
      const revisionRows = (await setup.$client.unsafe(
        "select count(*)::int as n from enterprise_package_revisions where install_id = $1",
        [current.installId],
      )) as Array<{ n: number }>;
      expect(Number(revisionRows[0]?.n ?? 0)).toBe(2);

      // The LOSING plan re-applied after the winner moved the install: the
      // same deterministic 409 (a replay of the WINNING plan returns its
      // stored result instead — the receipt model, not a conflict).
      const loserPlanId = lost.plan === "v2" ? planV2.planId : planV3.planId;
      await expectCode(
        service.apply(scopeA1, admin, loserPlanId, `stale-${randomUUID()}`),
        "REVISION_CONFLICT",
      );
    },
  );

  itDb(
    "rollback creates a new revision, never regresses counters, never revives revoked grants (AC5)",
    async () => {
      const current = await installV1Case();
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      const upPlan = await service.plan(scopeA1, admin, {
        operation: "upgrade",
        packageKey: PACKAGE_KEY,
        version: V2,
        expectedRevision: current.install.revision,
        config: { region: "us" },
        connectorInstalls: { crm: connectorA1 },
      });
      await service.apply(
        scopeA1,
        admin,
        upPlan.planId,
        `pkg06-rollback-up-${randomUUID()}`,
      );

      // Revoke the (now-changed) lookup tool grant before rolling back.
      await fixture.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${companyA}, true)`,
        );
        await tx.execute(
          sql`update enterprise_package_grants
              set revoked_at = now()
              where tenant_id = ${companyA} and install_id = ${current.installId}
                and resource_kind = 'connectorTool' and revoked_at is null`,
        );
      });

      const rollbackPlan = await service.plan(scopeA1, admin, {
        operation: "rollback",
        packageKey: PACKAGE_KEY,
        version: V1,
        expectedRevision: 2,
        config: { region: "us" },
        connectorInstalls: { crm: connectorA1 },
      });
      expect(rollbackPlan.operation).toBe("rollback");
      expect(rollbackPlan.diff?.currentVersion).toBe(V2);
      // The revoked tool comes back as an increment needing fresh authority.
      expect(rollbackPlan.addedTools.map((tool) => tool.ref).sort()).toEqual([
        `${CONNECTOR}:lookup`,
        `${CONNECTOR}:purge`,
      ]);

      const rolled = await service.apply(
        scopeA1,
        admin,
        rollbackPlan.planId,
        `pkg06-rollback-${randomUUID()}`,
      );
      expect(rolled.install.version).toBe(V1);
      expect(rolled.install.revision).toBe(3);
      expect(rolled.install.generation).toBe(current.install.generation);

      // The revoked grant stays revoked: no resurrection, no new generation.
      const active = (await setup.$client.unsafe(
        "select count(*)::int as n from enterprise_package_grants where install_id = $1 and resource_kind = 'connectorTool' and revoked_at is null",
        [current.installId],
      )) as Array<{ n: number }>;
      expect(Number(active[0]?.n ?? 0)).toBe(0);

      // An old run pinned at v2 keeps its v2 revision pinned (monotonic rows),
      // and a NEW run after the rollback pins v1's revision.
      const run2 = await seedRun({
        botId: current.botId,
        workspaceId: teamA1,
      });
      await pinRun({ scope: scopeA1, botId: current.botId, runId: run2 });
      const run2Skills = await runtime.readPinnedSkills(scopeA1, {
        botId: current.botId,
        runId: run2,
        attemptGeneration: 1,
      });
      // Grants left active after the revoke: both v1 skills stand again.
      expect(run2Skills.map((skill) => slugOf(skill)).sort()).toEqual(
        [SKILL_KEEP, SKILL_REMOVED].sort(),
      );

      // Rollback to a withdrawn target is refused like an upgrade.
      await expectCode(
        service.plan(scopeA1, admin, {
          operation: "rollback",
          packageKey: PACKAGE_KEY,
          version: "2.5.0",
          expectedRevision: 3,
          config: {},
          connectorInstalls: {},
        }),
        "PACKAGE_UNSUPPORTED",
      );
    },
  );

  itDb(
    "same version + same config applies idempotently; different config replans (config compatibility, AC6)",
    async () => {
      const current = await installV1Case({ config: { region: "us" } });
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      // Same version, same full config: a no-op that returns the standing
      // install and does NOT create a revision.
      const same = await service.plan(scopeA1, admin, {
        operation: "upgrade",
        packageKey: PACKAGE_KEY,
        version: V1,
        expectedRevision: current.install.revision,
        config: { region: "us" },
        connectorInstalls: { crm: connectorA1 },
      });
      const replay = await service.apply(
        scopeA1,
        admin,
        same.planId,
        `pkg06-noop-${randomUUID()}`,
      );
      expect(replay.created).toBe(false);
      expect(replay.install.revision).toBe(current.install.revision);
      const revisionRows = (await setup.$client.unsafe(
        "select count(*)::int as n from enterprise_package_revisions where install_id = $1",
        [current.installId],
      )) as Array<{ n: number }>;
      expect(Number(revisionRows[0]?.n ?? 0)).toBe(1);

      // A DIFFERENT config for the same version is a real new revision: V1
      // has no migration scripts — the full target config is the only input.
      const changed = await service.plan(scopeA1, admin, {
        operation: "upgrade",
        packageKey: PACKAGE_KEY,
        version: V1,
        expectedRevision: current.install.revision,
        config: { region: "eu" },
        connectorInstalls: { crm: connectorA1 },
      });
      expect(changed.diff?.configChanges).toEqual([
        { key: "region", change: "changed" },
      ]);
      const moved = await service.apply(
        scopeA1,
        admin,
        changed.planId,
        `pkg06-reconfig-${randomUUID()}`,
      );
      expect(moved.install.revision).toBe(current.install.revision + 1);
      const stored = (await setup.$client.unsafe(
        "select config from enterprise_package_revisions where install_id = $1 and revision = $2",
        [current.installId, moved.install.revision],
      )) as Array<{ config: Record<string, unknown> }>;
      expect(stored[0]?.config).toEqual({ region: "eu" });
    },
  );

  // OCR-fix-H (R7-H1): the no-op and upgraded arms must build their receipts
  // from the install's REAL facts — live links and live grant state read in
  // the same transaction. The pre-fix empty-shaped construction (links: [],
  // grants: []) was persisted into resultJson/planRows, so a connected,
  // granted install kept replaying fabricated needs_connection/needs_grant.
  itDb(
    "OCR-fix-H H1: replay and upgrade receipts carry the standing install's real readiness (no fake needs_*)",
    async () => {
      const current = await installV1Case({ config: { region: "us" } });
      const admin = await fixture.adminContextOf("company-admin", "company-a");

      // Same version, same full config: the no-op arm. The standing install
      // IS connected (crm linked on the current revision) and HAS an active
      // grant (installV1Case seeded one), so the only honest receipt is
      // readiness "ready" with zero blockers.
      const same = await service.plan(scopeA1, admin, {
        operation: "upgrade",
        packageKey: PACKAGE_KEY,
        version: V1,
        expectedRevision: current.install.revision,
        config: { region: "us" },
        connectorInstalls: { crm: connectorA1 },
      });
      const noopKey = `ocrfix-h-noop-${randomUUID()}`;
      const replay = await service.apply(scopeA1, admin, same.planId, noopKey);
      expect(replay.created).toBe(false);
      expect(replay.install.readiness).toBe("ready");
      expect(replay.install.blockers).toEqual([]);

      // The persistence the finding named: both receipt stores (change row
      // resultJson and the consumed plan row's result) hold the real
      // readiness, so later replays read the truth, not a frozen fake.
      const storedChange = (await setup.$client.unsafe(
        "select result_json as result from enterprise_package_changes where idempotency_key = $1",
        [noopKey],
      )) as Array<{ result: { readiness: string; blockers: unknown[] } }>;
      expect(storedChange[0]?.result.readiness).toBe("ready");
      expect(storedChange[0]?.result.blockers).toEqual([]);
      const storedPlan = (await setup.$client.unsafe(
        "select result from enterprise_package_plans where id = $1",
        [same.planId],
      )) as Array<{ result: { readiness: string; blockers: unknown[] } }>;
      expect(storedPlan[0]?.result.readiness).toBe("ready");
      expect(storedPlan[0]?.result.blockers).toEqual([]);

      // Replaying the SAME idempotency key returns exactly the stored answer.
      const replayAgain = await service.apply(
        scopeA1,
        admin,
        same.planId,
        noopKey,
      );
      expect(replayAgain.install).toEqual(replay.install);

      // The real-upgrade arm: an upgrade neither revokes nor revives grants,
      // so the standing active grant keeps the upgraded receipt "ready" —
      // never a fabricated needs_grant persisted into the receipts.
      const plan = await service.plan(scopeA1, admin, {
        operation: "upgrade",
        packageKey: PACKAGE_KEY,
        version: V2,
        expectedRevision: current.install.revision,
        config: { region: "us" },
        connectorInstalls: { crm: connectorA1 },
      });
      const upgradeKey = `ocrfix-h-up-${randomUUID()}`;
      const moved = await service.apply(
        scopeA1,
        admin,
        plan.planId,
        upgradeKey,
      );
      expect(moved.install.readiness).toBe("ready");
      expect(moved.install.blockers).toEqual([]);
      const storedUp = (await setup.$client.unsafe(
        "select result_json as result from enterprise_package_changes where idempotency_key = $1",
        [upgradeKey],
      )) as Array<{ result: { readiness: string; blockers: unknown[] } }>;
      expect(storedUp[0]?.result.readiness).toBe("ready");
      expect(storedUp[0]?.result.blockers).toEqual([]);
    },
  );

  itDb(
    "another team's install and created experts are untouched (AC7); allowedActions names the caller's real actions",
    async () => {
      const current = await installV1Case();
      // A second team (same company) installs the same package at v1.
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      const planA2 = await service.plan(scopeA2, admin, {
        operation: "install",
        packageKey: PACKAGE_KEY,
        version: V1,
        expectedRevision: null,
        config: { region: "apac" },
        connectorInstalls: {},
      });
      const appliedA2 = await service.apply(
        scopeA2,
        admin,
        planA2.planId,
        `pkg06-a2-${randomUUID()}`,
      );
      const expertsBefore = (await setup.$client.unsafe(
        "select count(*)::int as n from enterprise_package_experts",
      )) as Array<{ n: number }>;

      // Team A1 upgrades; team A2's install must not move.
      const plan = await service.plan(scopeA1, admin, {
        operation: "upgrade",
        packageKey: PACKAGE_KEY,
        version: V2,
        expectedRevision: current.install.revision,
        config: { region: "us" },
        connectorInstalls: { crm: connectorA1 },
      });
      await service.apply(
        scopeA1,
        admin,
        plan.planId,
        `pkg06-x-${randomUUID()}`,
      );
      const a2Detail = await service.get(scopeA2, appliedA2.install.installId);
      expect(a2Detail.version).toBe(V1);
      expect(a2Detail.revision).toBe(appliedA2.install.revision);
      const expertsAfter = (await setup.$client.unsafe(
        "select count(*)::int as n from enterprise_package_experts",
      )) as Array<{ n: number }>;
      expect(Number(expertsAfter[0]?.n ?? 0)).toBe(
        Number(expertsBefore[0]?.n ?? 0),
      );

      // allowedActions: the company administrator sees exactly the actions
      // this build supports; a plain member sees none. The detail also carries
      // the published-version facts for the upgrade/rollback picker.
      // PKG07 (#466) extends the set with the lifecycle verbs — an enabled
      // install can be turned off or uninstalled, which is a real action this
      // build now serves.
      const adminDetail = await service.get(scopeA1, current.installId);
      expect(adminDetail.allowedActions).toEqual([
        "plan",
        "apply",
        "grant",
        "createExpert",
        "disable",
        "uninstall",
      ]);
      expect(adminDetail.latestPublishedVersion).toBe(V3);
      expect(
        adminDetail.availableVersions?.map((entry) => entry.version),
      ).toEqual([V3, V2, V1]);
      // The member still sees the install facts (browse) but no actions.
      const memberPage = await service.list(scopeA1Member, {});
      const memberInstall = memberPage.items.find(
        (item) => item.packageKey === PACKAGE_KEY,
      )?.install;
      expect(memberInstall?.allowedActions).toEqual([]);
      const memberDetail = await service.get(scopeA1Member, current.installId);
      expect(memberDetail.allowedActions).toEqual([]);
    },
  );
});

/** The pinned-skill slug is `pkg:<installId>:<resourceId>`; take the tail. */
function slugOf(skill: { slug: string }): string {
  const parts = skill.slug.split(":");
  return parts[parts.length - 1] ?? skill.slug;
}
