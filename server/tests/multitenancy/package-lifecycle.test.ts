// server/tests/multitenancy/package-lifecycle.test.ts
// PKG07（Issue #466）：停用 / 卸载 / 重装与资产保留——真实受限角色证据面。
//
// 证据映射（#466 AC + A01/A05/A08 + Spec §4/§10）：
//   (1) 停用/卸载后无新派发；与在途调用的竞态按 `dispatched` 线性化点处理：
//       先停用 → 后续 CAS 读到 status/generation 漂移、transport 0 次；先
//       dispatched → 回执保留，不谎称撤回已发生效果（A05/AC1）。
//   (2) tombstone：安装行不删，旧 revision/pin/审计回执/unknown 派发全部保留
//       （AC2）。
//   (3) 资产保留与共享 connector 双包：卸载一个包不破坏另一个；底层连接
//       停用则正确反映共同不可用（AC3/AC4/A08）。
//   (4) 重装复用 installation identity、generation 递增；重新启用不复活旧
//       grant/审批（AC5）。
//   (5) 跨范围停用/卸载与不存在同形（404），不改他团队状态（AC6）。
//   (6) revision CAS：过期 revision → 409；同状态重试/同幂等键重放不抬
//       generation；非法转移不可用（422）。
//   (7) allowedActions 按调用者角色 + 安装状态真实计算；成员不可写。
//
// 全部判定经真实受限角色与真实 RLS；vendor transport 为可控注入。

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sql } from "drizzle-orm";
import type {
  PackageInstallDetailDTO,
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
      reason: `PKG07 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

const PKG_A = "openbot/pkg07-flow";
const PKG_B = "openbot/pkg07-shared";
const CONNECTOR = "crm";
const SKILL_A = "summarize";
const SKILL_B = "share-note";
const V1 = "1.0.0";
const V2 = "2.0.0";
const SECRET_CANARY = "pkg07-secret-canary";

let fixture: PackageInstallFixture;
let setup: Database;
let service: PackageService;
let catalogue: PackageCatalogue;
let runtime: ReturnType<typeof createPackageRuntime>;
let dispatch: ReturnType<typeof createPackageDispatchService>;
let artifactRoot: string;
let manifests: Map<string, PackageManifestV1>;
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
  seal: async (plaintext) => `pkg07-envelope:${plaintext}`,
  open: async (envelope) => {
    if (!envelope.startsWith("pkg07-envelope:")) {
      throw new Error("PKG07_TEST_ENVELOPE_INVALID");
    }
    return envelope.slice("pkg07-envelope:".length);
  },
};
const vendorCall: PackageVendorCaller = async () => {
  vendorCalls += 1;
  return { text: "ok", isError: false };
};

function manifestKey(packageKey: string, version: string): string {
  return `${packageKey}@${version}`;
}

/** Build one verified artifact and register it in the manifest map. */
async function storeVersion(
  packageKey: string,
  version: string,
  definition: {
    skills: readonly string[];
    connector: boolean;
  },
): Promise<string> {
  const [publisher, name] = packageKey.split("/") as [string, string];
  const source = await mkdtemp(join(tmpdir(), "pkg07-source-"));
  const manifest: PackageManifestV1 = {
    schemaVersion: 1,
    platformApi: 1,
    publisher,
    name,
    version,
    display: {
      name: `PKG07 ${packageKey} ${version}`,
      summary: `The PKG07 fixture package ${packageKey} ${version}.`,
    },
    resources: [
      ...definition.skills.map((skill) => ({
        kind: "skill" as const,
        id: skill,
        path: `skills/${skill}/SKILL.md`,
      })),
      ...(definition.connector
        ? [
            {
              kind: "managedConnector" as const,
              id: CONNECTOR,
              catalogKey: "pkg07-crm",
              required: true,
              tools: [
                { name: "lookup", effect: "read" as const },
                { name: "purge", effect: "write" as const },
              ],
            },
          ]
        : []),
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
    manifests.set(manifestKey(packageKey, version), manifest);
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
  const agentId = `pkg07-bot-${randomUUID()}`;
  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${workspaceId}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_bot_ownership
            (tenant_id, agent_id, workspace_id, owner_principal_id, display_name, default_config)
          values (${companyA}, ${agentId}, ${workspaceId}, ${adminPrincipal}, 'PKG07 bot', '{}'::jsonb)`,
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
  const expertVersionRef = `pkg07-expert-${randomUUID()}`;
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
     values ($1, $2, $3, $4, $5, $6, $7, 'pkg07-route', 1000, 'running', 1, now() + interval '1 hour')`,
    [
      runId,
      companyA,
      input.workspaceId,
      adminPrincipal,
      `pkg07-thread-${randomUUID()}`,
      `pkg07-msg-${randomUUID()}`,
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
 * Arrangement (operator channel, disclosed): one tool+skill grant generation
 * for the Bot, contracts taken from the REAL manifest the server pinned.
 */
async function seedGrants(input: {
  installId: string;
  botId: string;
  packageKey: string;
  version: string;
  skills: readonly string[];
  tools?: readonly string[];
}): Promise<void> {
  const manifest = manifests.get(manifestKey(input.packageKey, input.version));
  if (!manifest) throw new Error(`MANIFEST_MISSING:${input.packageKey}`);
  const tools = addedToolsOf(manifest).filter((tool) =>
    (input.tools ?? [`${CONNECTOR}:lookup`, `${CONNECTOR}:purge`]).includes(
      tool.ref,
    ),
  );
  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
    );
    for (const skill of input.skills) {
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

interface InstalledPackage {
  installId: string;
  install: PackageInstallDTO;
}

async function installPackage(input: {
  packageKey: string;
  version: string;
  connectorInstalls?: Record<string, string>;
}): Promise<InstalledPackage> {
  const admin = await fixture.adminContextOf("company-admin", "company-a");
  const plan = await service.plan(scopeA1, admin, {
    operation: "install",
    packageKey: input.packageKey,
    version: input.version,
    expectedRevision: null,
    config: {},
    connectorInstalls: input.connectorInstalls ?? { [CONNECTOR]: connectorA1 },
  });
  const applied = await service.apply(
    scopeA1,
    admin,
    plan.planId,
    `pkg07-install-${randomUUID()}`,
  );
  return { installId: applied.install.installId, install: applied.install };
}

function toolRefFor(installId: string, toolName: string): string {
  return `pkg:${installId}:${CONNECTOR}/${toolName}`;
}

/** One granted, pinned tool call ready to dispatch. */
interface DispatchCase {
  installId: string;
  botId: string;
  runId: string;
}

async function prepareDispatchCase(input: {
  packageKey: string;
  version: string;
  skills: readonly string[];
}): Promise<DispatchCase> {
  const installed = await installPackage({
    packageKey: input.packageKey,
    version: input.version,
  });
  const botId = await seedBot(teamA1);
  await seedGrants({
    installId: installed.installId,
    botId,
    packageKey: input.packageKey,
    version: input.version,
    skills: input.skills,
  });
  const runId = await seedRun({ botId, workspaceId: teamA1 });
  await pinRun({ scope: scopeA1, botId, runId });
  return { installId: installed.installId, botId, runId };
}

function dispatchOnce(input: {
  scope?: PlatformScope;
  current: DispatchCase;
  toolCallId?: string;
}) {
  const scope = input.scope ?? scopeA1;
  return dispatch.execute(scope, {
    runId: input.current.runId,
    attemptGeneration: 1,
    toolCallId: input.toolCallId ?? `call-${randomUUID()}`,
    bindingId: toolRefFor(input.current.installId, "lookup"),
    args: { query: "q" },
  });
}

async function adminOf(company: "company-a" | "company-b" = "company-a") {
  return fixture.adminContextOf("company-admin", company);
}

async function changeRowsOf(
  installId: string,
): Promise<Array<{ action: string; diff: Record<string, unknown> }>> {
  const rows = (await setup.$client.unsafe(
    `select action, diff from enterprise_package_changes
      where tenant_id = $1 and install_id = $2
      order by created_at asc`,
    [companyA, installId],
  )) as Array<{ action: string; diff: Record<string, unknown> }>;
  return rows;
}

describeDb("PKG07 package lifecycle: disable / uninstall / reinstall", () => {
  beforeAll(async () => {
    const outcomes = await applyPackageTasks();
    if (!outcomes.pkg07) throw new Error("PKG07_TASK_NOT_APPLIED");
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

    artifactRoot = await mkdtemp(join(tmpdir(), "pkg07-artifacts-"));
    manifests = new Map();
    const digestA1 = await storeVersion(PKG_A, V1, {
      skills: [SKILL_A],
      connector: true,
    });
    const digestA2 = await storeVersion(PKG_A, V2, {
      skills: [SKILL_A],
      connector: true,
    });
    const digestB1 = await storeVersion(PKG_B, V1, {
      skills: [SKILL_B],
      connector: true,
    });

    catalogue = await loadPackageCatalogue({
      artifactRoot,
      index: {
        schemaVersion: 1,
        packages: [
          {
            packageKey: PKG_A,
            version: V1,
            artifactDigest: digestA1,
            category: "productivity",
            listed: true,
          },
          {
            packageKey: PKG_A,
            version: V2,
            artifactDigest: digestA2,
            category: "productivity",
            listed: true,
          },
          {
            packageKey: PKG_B,
            version: V1,
            artifactDigest: digestB1,
            category: "productivity",
            listed: true,
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

    catalogId = `pkg07-crm-${randomUUID()}`;
    await setup.$client.unsafe(
      `insert into enterprise_plugin_catalog (id, kind, title, vendor, source, metadata)
       values ($1, 'mcp', 'PKG07 CRM', 'openbot', 'first-party', '{"summary":"CRM"}'::jsonb)`,
      [catalogId],
    );
    connectorA1 = `pkg07-connector-${randomUUID()}`;
    const connectionId = `pkg07-connection-${randomUUID()}`;
    await fixture.operator.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
      );
      await tx.execute(
        sql`insert into enterprise_plugin_installs
              (tenant_id, id, catalog_id, workspace_id, installed_by, config, envelope, status)
            values (${companyA}, ${connectorA1}, ${catalogId}, ${teamA1}, ${adminPrincipal},
                    '{"url":"https://pkg07-managed.example.test/mcp"}'::jsonb,
                    ${`pkg07-envelope:${SECRET_CANARY}`}, 'active')`,
      );
      await tx.execute(
        sql`insert into enterprise_plugin_connections
              (tenant_id, id, install_id, bound_by, vendor_ref, generation)
            values (${companyA}, ${connectionId}, ${connectorA1}, ${adminPrincipal}, 'acct-admin', 1)`,
      );
    });
  }, 240_000);

  beforeEach(async () => {
    clock = new Date("2026-10-25T00:00:00.000Z");
    vendorCalls = 0;
    // One install per (tenant, workspace, package_key): every case starts from
    // a clean install so its revision/generation/receipt expectations describe
    // only THIS case (same discipline as the PKG02/06 suites; superuser
    // arrangement, disclosed). Deleting installs cascades grants, pins,
    // experts and dispatch rows.
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
    // The shared connector install stays available unless a case disables it.
    await setup.$client.unsafe(
      `update enterprise_plugin_installs set status = 'active'
        where tenant_id = $1 and id = $2`,
      [companyA, connectorA1],
    );
  }, 60_000);

  afterAll(async () => {
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
    if (fixture) await fixture.dispose();
  });

  itDb(
    "AC1/AC5: disable bumps generation, revokes grants and refuses the next dispatch with zero transport calls; re-enable keeps the grant revoked",
    async () => {
      const current = await prepareDispatchCase({
        packageKey: PKG_A,
        version: V1,
        skills: [SKILL_A],
      });
      // Baseline: the granted, pinned call really reaches the transport once.
      expect(await dispatchOnce({ current })).toMatchObject({ outcome: "ok" });
      expect(vendorCalls).toBe(1);

      const disabled = await service.updateInstallStatus(
        scopeA1,
        await adminOf(),
        current.installId,
        { status: "disabled", expectedRevision: 1 },
        `pkg07-disable-${randomUUID()}`,
      );
      expect(disabled.changed).toBe(true);
      expect(disabled.install.status).toBe("disabled");
      expect(disabled.install.generation).toBe(2);
      // A lifecycle move never touches the version revision.
      expect(disabled.install.revision).toBe(1);
      expect(disabled.install.readiness).toBe("unavailable");
      expect(disabled.install.allowedActions).toEqual(["enable", "uninstall"]);

      const facts = await fixture.readStore.getInstall(
        scopeA1,
        current.installId,
      );
      expect(facts?.grants).toEqual([]);
      expect(facts?.links.map((link) => link.resourceId).sort()).toEqual([
        CONNECTOR,
        SKILL_A,
      ]);

      // The NEXT dispatch: the old pin still matches the revision, but the
      // install status and generation moved — refused before any network call.
      expect(await dispatchOnce({ current })).toEqual({
        outcome: "refused",
        code: "NOT_AVAILABLE",
      });
      expect(vendorCalls).toBe(1);

      const reenabled = await service.updateInstallStatus(
        scopeA1,
        await adminOf(),
        current.installId,
        { status: "enabled", expectedRevision: 1 },
        `pkg07-enable-${randomUUID()}`,
      );
      expect(reenabled.changed).toBe(true);
      expect(reenabled.install.status).toBe("enabled");
      expect(reenabled.install.generation).toBe(3);
      // Re-enabling does NOT revive the revoked grants: readiness says the
      // package needs a fresh grant, and the old Run pin stays unable to
      // dispatch because its generation can never come back.
      expect(reenabled.install.readiness).toBe("needs_grant");
      expect(
        (await fixture.readStore.getInstall(scopeA1, current.installId))
          ?.grants,
      ).toEqual([]);
      expect(await dispatchOnce({ current })).toEqual({
        outcome: "refused",
        code: "NOT_AVAILABLE",
      });
      expect(vendorCalls).toBe(1);

      const receipts = await changeRowsOf(current.installId);
      expect(receipts.map((row) => row.action)).toEqual([
        "install",
        "disable",
        "enable",
      ]);
      expect(receipts[1]?.diff).toMatchObject({
        action: "disable",
        previousStatus: "enabled",
        status: "disabled",
        previousGeneration: 1,
        generation: 2,
        revision: 1,
        revokedGrants: 3,
      });
      // No secret ever reaches a receipt.
      const leaked = (await setup.$client.unsafe(
        `select count(*)::int as n from enterprise_package_changes
          where tenant_id = $1 and diff::text like $2`,
        [companyA, `%${SECRET_CANARY}%`],
      )) as Array<{ n: number }>;
      expect(leaked[0]?.n).toBe(0);
    },
  );

  itDb(
    "A05/AC1: a call already dispatched keeps its real receipt after the install is uninstalled",
    async () => {
      const current = await prepareDispatchCase({
        packageKey: PKG_A,
        version: V1,
        skills: [SKILL_A],
      });
      const toolCallId = `call-${randomUUID()}`;
      const begun = await dispatch.beginDispatch(scopeA1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId,
        bindingId: toolRefFor(current.installId, "lookup"),
        args: { query: "q" },
      });
      expect(begun.outcome).toBe("permit");
      if (begun.outcome !== "permit") return;

      // The linearization point committed FIRST; the lifecycle change comes
      // after it and must not rewrite what already happened.
      const uninstalled = await service.updateInstallStatus(
        scopeA1,
        await adminOf(),
        current.installId,
        { status: "uninstalled", expectedRevision: 1 },
        `pkg07-uninstall-${randomUUID()}`,
      );
      expect(uninstalled.install.status).toBe("uninstalled");

      await dispatch.completeDispatch(scopeA1, begun.permit, {
        state: "succeeded",
        effectStatus: "confirmed",
        receiptRef: { effectStatus: "confirmed", isError: false },
      });
      const read = await dispatch.readDispatch(scopeA1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId,
      });
      expect(read?.state).toBe("succeeded");
      expect(read?.receiptRef).toMatchObject({ effectStatus: "confirmed" });
    },
  );

  itDb(
    "AC2: uninstall tombstones the install — revision, pin, audit receipts and unknown operations survive",
    async () => {
      const current = await prepareDispatchCase({
        packageKey: PKG_A,
        version: V1,
        skills: [SKILL_A],
      });
      // One unknown operation (crash after dispatch): its row must survive the
      // uninstall exactly as it is, never deleted or relabelled.
      const unknownCall = `call-${randomUUID()}`;
      const begun = await dispatch.beginDispatch(scopeA1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: unknownCall,
        bindingId: toolRefFor(current.installId, "lookup"),
        args: { query: "unknown" },
      });
      expect(begun.outcome).toBe("permit");
      if (begun.outcome !== "permit") return;
      await dispatch.completeDispatch(scopeA1, begun.permit, {
        state: "unknown",
        effectStatus: "unknown",
        errorCode: "DISPATCH_CRASH",
        receiptRef: { effectStatus: "unknown" },
      });

      const uninstalled = await service.updateInstallStatus(
        scopeA1,
        await adminOf(),
        current.installId,
        { status: "uninstalled", expectedRevision: 1 },
        `pkg07-uninstall-${randomUUID()}`,
      );
      expect(uninstalled.install.status).toBe("uninstalled");
      expect(uninstalled.install.generation).toBe(2);
      expect(uninstalled.install.revision).toBe(1);
      expect(uninstalled.install.allowedActions).toEqual(["enable"]);

      const relations = (await setup.$client.unsafe(
        `select
           (select count(*)::int from enterprise_package_installs where tenant_id = $1 and id = $2) as installs,
           (select count(*)::int from enterprise_package_revisions where tenant_id = $1 and install_id = $2) as revisions,
           (select count(*)::int from enterprise_run_package_pins where tenant_id = $1 and install_id = $2) as pins,
           (select count(*)::int from enterprise_package_changes where tenant_id = $1 and install_id = $2) as changes,
           (select count(*)::int from enterprise_package_dispatches where tenant_id = $1 and install_id = $2 and state = 'unknown') as unknown_dispatches,
           (select count(*)::int from enterprise_bot_ownership where tenant_id = $1 and agent_id = $3) as bots,
           (select count(*)::int from enterprise_runs where tenant_id = $1 and id = $4) as runs,
           (select count(*)::int from enterprise_plugin_connections where tenant_id = $1 and install_id = $5) as connections`,
        [
          companyA,
          current.installId,
          current.botId,
          current.runId,
          connectorA1,
        ],
      )) as Array<Record<string, number>>;
      expect(relations[0]).toMatchObject({
        installs: 1,
        revisions: 1,
        pins: 1,
        unknown_dispatches: 1,
        // AC3: the user's own assets are other domains' rows — an uninstall
        // never deletes a Bot, a run (task产物) or a connected account.
        bots: 1,
        runs: 1,
        connections: 1,
      });
      expect(Number(relations[0]?.changes)).toBe(2);

      // The tombstone still reads through the normal path, and the uninstall
      // receipt names the transition.
      const detail: PackageInstallDetailDTO = await service.get(
        scopeA1,
        current.installId,
      );
      expect(detail.status).toBe("uninstalled");
      expect(detail.readiness).toBe("unavailable");
      const receipts = await changeRowsOf(current.installId);
      expect(receipts.at(-1)?.action).toBe("uninstall");
      expect(receipts.at(-1)?.diff).toMatchObject({
        previousStatus: "enabled",
        status: "uninstalled",
      });

      expect(await dispatchOnce({ current })).toEqual({
        outcome: "refused",
        code: "NOT_AVAILABLE",
      });
      expect(vendorCalls).toBe(0);
    },
  );

  itDb(
    "AC5: reinstall reuses the install identity, increments generation, and never revives the old grants",
    async () => {
      const current = await prepareDispatchCase({
        packageKey: PKG_A,
        version: V1,
        skills: [SKILL_A],
      });
      await service.updateInstallStatus(
        scopeA1,
        await adminOf(),
        current.installId,
        { status: "uninstalled", expectedRevision: 1 },
        `pkg07-uninstall-${randomUUID()}`,
      );
      const reinstalled = await service.updateInstallStatus(
        scopeA1,
        await adminOf(),
        current.installId,
        { status: "enabled", expectedRevision: 1 },
        `pkg07-reinstall-${randomUUID()}`,
      );
      // SAME installation id, same version revision, generation ratchets.
      expect(reinstalled.install.installId).toBe(current.installId);
      expect(reinstalled.install.revision).toBe(1);
      expect(reinstalled.install.generation).toBe(3);
      expect(reinstalled.install.readiness).toBe("needs_grant");

      // The pre-uninstall Run pin cannot dispatch (its generation is gone for
      // good), and a NEW Run admitted on the reinstalled install pins nothing
      // while no grant stands.
      expect(await dispatchOnce({ current })).toEqual({
        outcome: "refused",
        code: "NOT_AVAILABLE",
      });
      const freshRunId = await seedRun({
        botId: current.botId,
        workspaceId: teamA1,
      });
      const snapshot = await withinRunTx(scopeA1, (tx) =>
        runtime.prepareWithin(tx, scopeA1, {
          botId: current.botId,
          runId: freshRunId,
          attemptGeneration: 1,
        }),
      );
      expect(snapshot.pins).toEqual([]);
      expect(vendorCalls).toBe(0);

      // An EXPLICIT re-grant makes the reinstalled install usable again — the
      // old approval was not revived, a new one was written (skill + the exact
      // connector tool the call names).
      const grant = await service.setBotGrant(
        scopeA1,
        await adminOf(),
        {
          installId: current.installId,
          botId: current.botId,
          expectedGrantRevision: null,
          resources: [
            { resourceId: SKILL_A, kind: "skill" },
            {
              resourceId: CONNECTOR,
              kind: "managedConnector",
              toolRefs: [`${CONNECTOR}:lookup`],
            },
          ],
        },
        `pkg07-regrant-${randomUUID()}`,
      );
      expect(grant.created).toBe(true);
      await pinRun({ scope: scopeA1, botId: current.botId, runId: freshRunId });
      const reinstalledCase: DispatchCase = {
        installId: current.installId,
        botId: current.botId,
        runId: freshRunId,
      };
      expect(await dispatchOnce({ current: reinstalledCase })).toMatchObject({
        outcome: "ok",
      });
      expect(vendorCalls).toBe(1);
    },
  );

  itDb(
    "AC4/A08: uninstalling one package leaves a second package on the same connector usable; disabling that connector makes both unavailable",
    async () => {
      const packageA = await prepareDispatchCase({
        packageKey: PKG_A,
        version: V1,
        skills: [SKILL_A],
      });
      const packageB = await prepareDispatchCase({
        packageKey: PKG_B,
        version: V1,
        skills: [SKILL_B],
      });
      // Both installs link the SAME connector install (the shared scenario).
      const links = (await setup.$client.unsafe(
        `select install_id, connector_install_id from enterprise_package_resource_links
          where tenant_id = $1 and install_id in ($2, $3)
            and kind = 'managedConnector'`,
        [companyA, packageA.installId, packageB.installId],
      )) as Array<{ install_id: string; connector_install_id: string }>;
      expect(
        [...new Set(links.map((link) => link.connector_install_id))].sort(),
      ).toEqual([connectorA1]);

      await service.updateInstallStatus(
        scopeA1,
        await adminOf(),
        packageA.installId,
        { status: "uninstalled", expectedRevision: 1 },
        `pkg07-uninstall-${randomUUID()}`,
      );

      // Package B is untouched: its install, links, grant and pin all stand,
      // and its tool call still reaches the transport exactly once.
      expect(
        (await fixture.readStore.getInstall(scopeA1, packageB.installId))
          ?.status,
      ).toBe("enabled");
      expect(await dispatchOnce({ current: packageA })).toEqual({
        outcome: "refused",
        code: "NOT_AVAILABLE",
      });
      expect(await dispatchOnce({ current: packageB })).toMatchObject({
        outcome: "ok",
      });
      expect(vendorCalls).toBe(1);

      // The shared underlying connection goes away: BOTH packages read as
      // unavailable and neither reaches the transport.
      await setup.$client.unsafe(
        `update enterprise_plugin_installs set status = 'disabled'
          where tenant_id = $1 and id = $2`,
        [companyA, connectorA1],
      );
      expect(await dispatchOnce({ current: packageB })).toMatchObject({
        outcome: "refused",
      });
      expect(vendorCalls).toBe(1);
    },
  );

  itDb(
    "AC6: another team's scope answers the same 404 as an unknown install and never moves its state",
    async () => {
      const current = await prepareDispatchCase({
        packageKey: PKG_A,
        version: V1,
        skills: [SKILL_A],
      });
      await expectCode(
        service.updateInstallStatus(
          scopeA2,
          await adminOf("company-a"),
          current.installId,
          { status: "uninstalled", expectedRevision: 1 },
          `pkg07-cross-${randomUUID()}`,
        ),
        "RESOURCE_NOT_FOUND",
      );
      await expectCode(
        service.updateInstallStatus(
          scopeA1,
          await adminOf("company-a"),
          `pkg07-unknown-${randomUUID()}`,
          { status: "uninstalled", expectedRevision: 1 },
          `pkg07-unknown-${randomUUID()}`,
        ),
        "RESOURCE_NOT_FOUND",
      );
      const facts = await fixture.readStore.getInstall(
        scopeA1,
        current.installId,
      );
      expect(facts?.status).toBe("enabled");
      expect(facts?.generation).toBe(1);
    },
  );

  itDb(
    "CAS/AC5: a stale revision is 409, a same-status retry does not ratchet the generation, and an impossible transition is refused",
    async () => {
      const installed = await installPackage({
        packageKey: PKG_A,
        version: V1,
      });
      // An upgrade moves the revision to 2 — the lifecycle caller's view of
      // revision 1 is now stale.
      const admin = await adminOf();
      const plan = await service.plan(scopeA1, admin, {
        operation: "upgrade",
        packageKey: PKG_A,
        version: V2,
        expectedRevision: 1,
        config: {},
        connectorInstalls: { [CONNECTOR]: connectorA1 },
      });
      const upgraded = await service.apply(
        scopeA1,
        admin,
        plan.planId,
        `pkg07-upgrade-${randomUUID()}`,
      );
      expect(upgraded.install.revision).toBe(2);

      await expectCode(
        service.updateInstallStatus(
          scopeA1,
          admin,
          installed.installId,
          { status: "disabled", expectedRevision: 1 },
          `pkg07-stale-${randomUUID()}`,
        ),
        "REVISION_CONFLICT",
      );

      const disableKey = `pkg07-disable-${randomUUID()}`;
      const first = await service.updateInstallStatus(
        scopeA1,
        admin,
        installed.installId,
        { status: "disabled", expectedRevision: 2 },
        disableKey,
      );
      expect(first.changed).toBe(true);
      expect(first.install.generation).toBe(2);
      // Same key + same body: the stored receipt replays, no second bump.
      const replay = await service.updateInstallStatus(
        scopeA1,
        admin,
        installed.installId,
        { status: "disabled", expectedRevision: 2 },
        disableKey,
      );
      expect(replay.changed).toBe(false);
      expect(replay.install.generation).toBe(2);
      // Same status under a NEW key: an idempotent no-op, still no bump.
      const noop = await service.updateInstallStatus(
        scopeA1,
        admin,
        installed.installId,
        { status: "disabled", expectedRevision: 2 },
        `pkg07-disable-${randomUUID()}`,
      );
      expect(noop.changed).toBe(false);
      expect(noop.install.generation).toBe(2);
      // Same key with a DIFFERENT request is a conflict.
      await expectCode(
        service.updateInstallStatus(
          scopeA1,
          admin,
          installed.installId,
          { status: "uninstalled", expectedRevision: 2 },
          disableKey,
        ),
        "IDEMPOTENCY_CONFLICT",
      );

      await service.updateInstallStatus(
        scopeA1,
        admin,
        installed.installId,
        { status: "uninstalled", expectedRevision: 2 },
        `pkg07-uninstall-${randomUUID()}`,
      );
      // uninstalled → disabled has no meaning: the tombstone either comes back
      // enabled or stays.
      await expectCode(
        service.updateInstallStatus(
          scopeA1,
          admin,
          installed.installId,
          { status: "disabled", expectedRevision: 2 },
          `pkg07-impossible-${randomUUID()}`,
        ),
        "PACKAGE_UNSUPPORTED",
      );
      // Input shape: a zero revision and an extra field never reach the row.
      await expectCode(
        service.updateInstallStatus(
          scopeA1,
          admin,
          installed.installId,
          { status: "enabled", expectedRevision: 0 },
          `pkg07-bad-${randomUUID()}`,
        ),
        "INPUT_INVALID",
      );
      await expectCode(
        service.updateInstallStatus(
          scopeA1,
          admin,
          installed.installId,
          {
            status: "enabled",
            expectedRevision: 2,
            generation: 9,
          } as never,
          `pkg07-bad-${randomUUID()}`,
        ),
        "INPUT_INVALID",
      );
    },
  );

  itDb(
    "A01: allowedActions name the lifecycle verbs by role and state; a member cannot write",
    async () => {
      const installed = await installPackage({
        packageKey: PKG_A,
        version: V1,
      });
      const adminDetail = await service.get(scopeA1, installed.installId);
      expect(adminDetail.allowedActions).toEqual([
        "plan",
        "apply",
        "grant",
        "createExpert",
        "disable",
        "uninstall",
      ]);
      const memberDetail = await service.get(
        scopeA1Member,
        installed.installId,
      );
      expect(memberDetail.allowedActions).toEqual([]);

      await service.updateInstallStatus(
        scopeA1,
        await adminOf(),
        installed.installId,
        { status: "disabled", expectedRevision: 1 },
        `pkg07-disable-${randomUUID()}`,
      );
      expect(
        (await service.get(scopeA1, installed.installId)).allowedActions,
      ).toEqual(["enable", "uninstall"]);

      // A member's write is refused inside the mutation transaction, even
      // though the caller holds a valid member scope.
      await expectCode(
        service.updateInstallStatus(
          scopeA1Member,
          await adminOf(),
          installed.installId,
          { status: "enabled", expectedRevision: 1 },
          `pkg07-member-${randomUUID()}`,
        ),
        "TENANT_FORBIDDEN",
      );
      const facts = await fixture.readStore.getInstall(
        scopeA1,
        installed.installId,
      );
      expect(facts?.status).toBe("disabled");
      expect(facts?.generation).toBe(2);
    },
  );
});
