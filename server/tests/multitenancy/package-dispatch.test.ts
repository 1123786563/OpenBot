// server/tests/multitenancy/package-dispatch.test.ts
// PKG05（Issue #464）：受管工具派发的真实受限角色证据面。
//
// 证据映射（Brief deliverable 6 + #464 AC + A02/A04/A05/A07）：
//   (1) 线性化：prepareWithin 钉扎工具绑定；beginDispatch 在 pin/install/
//       grant/connection 全绿时 CAS dispatched 并放行 transport 一次。
//   (2) A05 先停用/先撤权 → 下一次派发拒绝、transport 调用次数 0。
//   (3) A05 先 dispatched → 撤权不丢已发生效果：completeDispatch 仍写回
//       真实结果（succeeded + 回执），行状态可复核。
//   (4) 同 toolCallId 并发只派发一次（唯一键 + prepared→dispatched CAS），
//       另一个调用得到 DUPLICATE_DISPATCH，transport 只被调用一次。
//   (5) 派发后写超时/崩溃 → unknown（写）或 failed（读），不自动重发；
//       再次 execute 同 toolCallId 被 DUPLICATE_DISPATCH 拒绝。
//   (6) 撤权后下一次调用拒绝；旧 pin 不吸收新工具（授权新增但 pin 无）。
//   (7) grant 的 schema digest/effect 与当前修订清单不一致 → 拒绝（A06）。
//   (8) A02 跨公司/跨团队同形：他人 Run 与不存在 Run 同一拒绝码。
//   (9) A07 审批期：prepare 后断连 → CONNECTION_UNAVAILABLE；换代次 →
//       CONNECTION_CHANGED；改参 → ARGS_CHANGED；transport 均为 0 次。
//   (10) A04 秘密面：envelope 只在进程内解封；派发行与回执不含秘密/参数。
//   (11) RLS 形态：dispatch 表 data 读限本租户+团队，directory 零授权。
//   (12) 工具授权写入：manifest 声明决定 digest/effect；未声明工具拒绝。
//
// 全部判定经真实受限角色与真实 RLS；transport 为可控注入（不拨真实供应商）。

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { PackageManifestV1 } from "../../../shared/enterprise/plugin-package-contracts";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createDatabase, type Database } from "../../src/db/client";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  createPackageDispatchService,
  type PackageVendorCaller,
} from "../../src/enterprise/plugin-packages/dispatch";
import { createPackageGrantService } from "../../src/enterprise/plugin-packages/grants";
import { addedToolsOf } from "../../src/enterprise/plugin-packages/plans";
import { createPackageRuntime } from "../../src/enterprise/plugin-packages/runtime";
import type { SecretVault } from "../../src/enterprise/tenancy/credential-ownership";
import {
  createPluginCatalogAdminService,
  createPluginCatalogDecisionService,
} from "../../src/enterprise/tenancy/plugin-catalog";
import { createToolInvocationService } from "../../src/enterprise/tenancy/tool-invocation";
import {
  buildArtifact,
  storeArtifact,
} from "../../src/plugin-packages/artifact";
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
      reason: `PKG05 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
    ? test(name, fn, 120_000)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

const SKILL_A = "summarize";
const CONNECTOR_RESOURCE = "notes";
const TOOL_LOOKUP = `${CONNECTOR_RESOURCE}:lookup`;
const TOOL_WRITE = `${CONNECTOR_RESOURCE}:write_note`;
const SECRET_CANARY = "i459-dispatch-secret-canary";
const ARG_CANARY = "i459-argument-canary-value";
const PACKAGE_KEY_PREFIX = "openbot/pkg05-dispatch";
const PACKAGE_VERSION = "1.0.0";

let fixture: PackageInstallFixture;
let setup: Database;
let artifactRoot: string;
let digest = "";
let manifest: PackageManifestV1;
let runtime: ReturnType<typeof createPackageRuntime>;
let scopeA1: PlatformScope;
let scopeB1: PlatformScope;
let companyA = "";
let teamA1 = "";
let companyB = "";
let teamB1 = "";
let adminPrincipal = "";
let catalogue: PackageCatalogue;
let dispatch: ReturnType<typeof createPackageDispatchService>;
/** The real operator-channel write path a production re-bind rides (H-B). */
let catalogAdmin: ReturnType<typeof createPluginCatalogAdminService>;
/** Every vendor dial the injected transport saw. */
let vendorCalls: Array<{
  url: string | null;
  token: string | null;
  accountHandle: string | null;
  toolName: string;
  args: Record<string, unknown>;
}> = [];
let vendorBehaviour: (input: {
  toolName: string;
}) => Promise<{ text: string; isError: boolean }> = async () => ({
  text: "ok",
  isError: false,
});

const vault: SecretVault = {
  seal: async (plaintext) => `pkg05-envelope:${plaintext}`,
  open: async (envelope) => {
    if (!envelope.startsWith("pkg05-envelope:")) {
      throw new Error("PKG05_TEST_ENVELOPE_INVALID");
    }
    return envelope.slice("pkg05-envelope:".length);
  },
};

const vendorCall: PackageVendorCaller = async (access, toolName, args) => {
  vendorCalls.push({
    url: access.url,
    token: access.token,
    accountHandle: access.accountHandle,
    toolName,
    args,
  });
  return vendorBehaviour({ toolName });
};

async function storePackage(): Promise<string> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const source = await mkdtemp(join(tmpdir(), "pkg05-source-"));
  const builtManifest: PackageManifestV1 = {
    schemaVersion: 1,
    platformApi: 1,
    publisher: "openbot",
    name: "pkg05-dispatch",
    version: PACKAGE_VERSION,
    display: {
      name: "PKG05 dispatch package",
      summary: "The PKG05 dispatch probe.",
    },
    resources: [
      { kind: "skill", id: SKILL_A, path: `skills/${SKILL_A}/SKILL.md` },
      {
        kind: "managedConnector",
        id: CONNECTOR_RESOURCE,
        catalogKey: "managed-notes",
        required: true,
        tools: [
          { name: "lookup", effect: "read" },
          { name: "write_note", effect: "write" },
        ],
      },
    ],
    dependencies: [],
  };
  manifest = builtManifest;
  try {
    await writeFile(
      join(source, "openbot.plugin.json"),
      JSON.stringify(builtManifest),
    );
    const absolute = join(source, "skills", SKILL_A, "SKILL.md");
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, `# ${SKILL_A}\n`);
    const artifact = await buildArtifact(source);
    await storeArtifact(artifact, artifactRoot);
    return artifact.digest;
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}

function probeCatalogue(): PackageCatalogue {
  const releaseFor = (packageKey: string): PackageReleaseFacts => ({
    packageKey,
    version: PACKAGE_VERSION,
    artifactDigest: digest,
    category: "productivity",
    listed: true,
    state: "published",
    verified: true,
    displayName: "PKG05 dispatch package",
    summary: "The PKG05 dispatch probe.",
    blockers: [],
    manifest,
  });
  return {
    async list() {
      return { items: [], nextCursor: null };
    },
    async get() {
      throw new Error("not used");
    },
    async resolveRelease(packageKey, version) {
      return packageKey.startsWith(PACKAGE_KEY_PREFIX) &&
        version === PACKAGE_VERSION
        ? releaseFor(packageKey)
        : null;
    },
  };
}

/** Arrangement (superuser, disclosed): one global MT031 catalogue entry. */
async function seedCatalogEntry(): Promise<string> {
  const catalogId = "pkg05-managed-notes";
  await setup.$client.unsafe(
    `insert into enterprise_plugin_catalog (id, kind, title, vendor, source, metadata)
     values ($1, 'mcp', 'Managed Notes', 'openbot', 'first-party', '{"summary":"Managed notes MCP"}'::jsonb)
     on conflict (id) do nothing`,
    [catalogId],
  );
  return catalogId;
}

interface ConnectorSeed {
  connectorInstallId: string;
  connectionId: string;
}

/** Arrangement (operator channel): one MT031 install + the caller's connection. */
async function seedConnector(catalogId: string): Promise<ConnectorSeed> {
  const connectorInstallId = `pkg05-connector-${randomUUID()}`;
  const connectionId = `pkg05-connection-${randomUUID()}`;
  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_plugin_installs
            (tenant_id, id, catalog_id, workspace_id, installed_by, config, envelope, status)
          values (${companyA}, ${connectorInstallId}, ${catalogId}, ${teamA1},
                  ${adminPrincipal}, '{"url":"https://managed.example.test/mcp"}'::jsonb,
                  ${`pkg05-envelope:${SECRET_CANARY}`}, 'active')`,
    );
    await tx.execute(
      sql`insert into enterprise_plugin_connections
            (tenant_id, id, install_id, bound_by, vendor_ref, generation)
          values (${companyA}, ${connectionId}, ${connectorInstallId}, ${adminPrincipal}, 'acct-admin', 1)`,
    );
  });
  return { connectorInstallId, connectionId };
}

interface PackageSeed {
  installId: string;
  packageKey: string;
  connectorInstallId: string;
  connectionId: string;
}

/** Arrangement (operator channel): the package install, its links and grants. */
async function seedPackageInstall(input: {
  botId: string;
  connector: ConnectorSeed;
  toolRefs?: readonly string[];
  generation?: number;
}): Promise<PackageSeed> {
  const installId = `pkg05-install-${randomUUID()}`;
  // One install per scope per package_key (the PKG02 unique index): every
  // seeded case gets its own key, the catalogue resolves them by prefix.
  const packageKey = `${PACKAGE_KEY_PREFIX}-${randomUUID().slice(0, 8)}`;
  const declared = addedToolsOf(manifest);
  const tools = declared.filter((tool) =>
    (input.toolRefs ?? [TOOL_LOOKUP]).includes(tool.ref),
  );
  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_package_installs
            (tenant_id, id, workspace_id, package_key, current_version, status, installed_by)
          values (${companyA}, ${installId}, ${teamA1}, ${packageKey}, ${PACKAGE_VERSION}, 'enabled', ${adminPrincipal})`,
    );
    await tx.execute(
      sql`insert into enterprise_package_revisions
            (tenant_id, install_id, revision, release_version, artifact_digest, config, created_by)
          values (${companyA}, ${installId}, 1, ${PACKAGE_VERSION}, ${digest}, '{}'::jsonb, ${adminPrincipal})`,
    );
    await tx.execute(
      sql`insert into enterprise_package_resource_links
            (tenant_id, install_id, revision, resource_id, workspace_id, kind, connector_install_id)
          values (${companyA}, ${installId}, 1, ${SKILL_A}, ${teamA1}, 'skill', null)`,
    );
    await tx.execute(
      sql`insert into enterprise_package_resource_links
            (tenant_id, install_id, revision, resource_id, workspace_id, kind, connector_install_id)
          values (${companyA}, ${installId}, 1, ${CONNECTOR_RESOURCE}, ${teamA1}, 'managedConnector',
                  ${input.connector.connectorInstallId})`,
    );
    // One skill grant keeps the pin's skill surface non-empty (the tool path
    // must work alongside it), then the connector-tool rows.
    await tx.execute(
      sql`insert into enterprise_package_grants
            (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
             resource_kind, tool_ref, granted_by)
          values (${companyA}, ${installId}, ${input.generation ?? 1}, ${input.botId}, ${SKILL_A}, ${teamA1}, 'skill', '', ${adminPrincipal})`,
    );
    for (const tool of tools) {
      await tx.execute(
        sql`insert into enterprise_package_grants
              (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
               resource_kind, tool_ref, schema_digest, effect, connector_install_id, granted_by)
            values (${companyA}, ${installId}, ${input.generation ?? 1}, ${input.botId},
                    ${CONNECTOR_RESOURCE}, ${teamA1}, 'connectorTool', ${tool.ref},
                    ${tool.schemaDigest}, ${tool.effect}, ${input.connector.connectorInstallId},
                    ${adminPrincipal})`,
      );
    }
  });
  return {
    installId,
    packageKey,
    connectorInstallId: input.connector.connectorInstallId,
    connectionId: input.connector.connectionId,
  };
}

async function seedBot(): Promise<string> {
  const agentId = `pkg05-bot-${randomUUID()}`;
  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_bot_ownership
            (tenant_id, agent_id, workspace_id, owner_principal_id, display_name, default_config)
          values (${companyA}, ${agentId}, ${teamA1}, ${adminPrincipal}, 'PKG05 bot', '{}'::jsonb)`,
    );
  });
  return agentId;
}

/** Arrangement (superuser, disclosed): the run row + admitted expert version. */
async function seedRun(input: { botId: string }): Promise<string> {
  const runId = randomUUID();
  const expertVersionRef = `pkg05-expert-${randomUUID()}`;
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
     values ($1, $2, $3, $4, $5, $6, $7, 'pkg05-route', 1000, 'running', 1, now() + interval '1 hour')`,
    [
      runId,
      companyA,
      teamA1,
      adminPrincipal,
      `pkg05-thread-${randomUUID()}`,
      `pkg05-msg-${randomUUID()}`,
      expertVersionRef,
    ],
  );
  return runId;
}

async function withinRunTx<T>(
  scope: PlatformScope,
  work: (
    tx: Parameters<Parameters<typeof fixture.base.data.transaction>[0]>[0],
  ) => Promise<T>,
): Promise<T> {
  return fixture.base.data.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
    );
    return work(tx);
  });
}

interface DispatchCase {
  botId: string;
  runId: string;
  installId: string;
  packageKey: string;
  connector: ConnectorSeed;
}

/** One fully prepared run: package install + bot + run + pinned tool surface. */
async function prepareCase(input?: {
  toolRefs?: readonly string[];
  pin?: boolean;
}): Promise<DispatchCase> {
  const botId = await seedBot();
  const catalogId = await seedCatalogEntry();
  const connector = await seedConnector(catalogId);
  const seeded = await seedPackageInstall({
    botId,
    connector,
    ...(input?.toolRefs ? { toolRefs: input.toolRefs } : {}),
  });
  const installId = seeded.installId;
  const runId = await seedRun({ botId });
  if (input?.pin !== false) {
    await withinRunTx(scopeA1, (tx) =>
      runtime.prepareWithin(tx, scopeA1, {
        botId,
        runId,
        attemptGeneration: 1,
      }),
    );
  }
  return { botId, runId, installId, packageKey: seeded.packageKey, connector };
}

function toolRefFor(installId: string, toolName: string): string {
  return `pkg:${installId}:${CONNECTOR_RESOURCE}/${toolName}`;
}

describeDb("PKG05 package tool dispatch (real roles)", () => {
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
    await fixture.promoteToCompanyAdmin("company-admin", "company-a");
    companyA = fixture.tenantOf("company-a");
    teamA1 = fixture.teamOf("company-a", "team-a1");
    companyB = fixture.tenantOf("company-b");
    teamB1 = fixture.teamOf("company-b", "team-b1");
    adminPrincipal = fixture.principalOf("company-admin", "company-a");
    scopeA1 = await fixture.scopeFor("company-admin", "team-a1");
    scopeB1 = await fixture.scopeFor("b1-member", "team-b1");
    artifactRoot = await mkdtemp(join(tmpdir(), "pkg05-artifacts-"));
    digest = await storePackage();
    catalogue = probeCatalogue();
    runtime = createPackageRuntime({
      data: fixture.base.data,
      artifactRoot,
    });
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
    catalogAdmin = createPluginCatalogAdminService(fixture.operator, vault);
  });

  afterAll(async () => {
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
    if (fixture) await fixture.dispose();
  });

  itDb("pin records the run's dispatchable tool bindings", async () => {
    const current = await prepareCase();
    const pins = (await setup.$client.unsafe(
      "select allowed_tool_bindings from enterprise_run_package_pins where run_id = $1",
      [current.runId],
    )) as Array<{ allowed_tool_bindings: unknown }>;
    expect(pins).toHaveLength(1);
    expect(pins[0]?.allowed_tool_bindings).toMatchObject([
      {
        resourceId: CONNECTOR_RESOURCE,
        toolRef: TOOL_LOOKUP,
        effect: "read",
        connectorInstallId: current.connector.connectorInstallId,
      },
    ]);
    // readPinnedTools serves exactly the pinned binding.
    const served = await runtime.readPinnedTools(scopeA1, {
      botId: current.botId,
      runId: current.runId,
      attemptGeneration: 1,
    });
    expect(served.map((tool) => tool.toolRef)).toEqual([TOOL_LOOKUP]);
  });

  itDb(
    "beginDispatch linearizes and dispatches exactly once to the transport",
    async () => {
      const current = await prepareCase();
      vendorCalls = [];
      vendorBehaviour = async () => ({ text: "found 2 notes", isError: false });
      const result = await dispatch.execute(scopeA1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        bindingId: toolRefFor(current.installId, "lookup"),
        args: { query: ARG_CANARY },
      });
      expect(result.outcome).toBe("ok");
      expect(vendorCalls).toHaveLength(1);
      // The transport reached the MANAGED endpoint, unsealed in-process only,
      // and the connection row's account alias — never a package URL.
      expect(vendorCalls[0]?.url).toBe("https://managed.example.test/mcp");
      expect(vendorCalls[0]?.token).toBe(SECRET_CANARY);
      expect(vendorCalls[0]?.accountHandle).toBe("acct-admin");
      const row = (await setup.$client.unsafe(
        "select state, receipt_ref, effect from enterprise_package_dispatches where run_id = $1",
        [current.runId],
      )) as Array<{ state: string; receipt_ref: unknown; effect: string }>;
      expect(row).toHaveLength(1);
      expect(row[0]?.state).toBe("succeeded");
      expect(row[0]?.effect).toBe("read");
      expect(row[0]?.receipt_ref).toMatchObject({
        effectStatus: "confirmed",
        isError: false,
      });
      // A04: neither the argument value nor the secret reaches the ledger.
      const leaked = (await setup.$client.unsafe(
        `select count(*)::int as n from enterprise_package_dispatches
         where row_to_json(enterprise_package_dispatches)::text like $1
            or row_to_json(enterprise_package_dispatches)::text like $2`,
        [`%${ARG_CANARY}%`, `%${SECRET_CANARY}%`],
      )) as Array<{ n: number }>;
      expect(Number(leaked[0]?.n ?? 0)).toBe(0);
    },
  );

  itDb(
    "A05: a disable committed first means zero transport calls",
    async () => {
      const current = await prepareCase();
      vendorCalls = [];
      await fixture.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
        );
        await tx.execute(
          sql`update enterprise_package_installs
                set status = 'disabled', generation = generation + 1
              where tenant_id = ${companyA} and id = ${current.installId}`,
        );
      });
      const result = await dispatch.execute(scopeA1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        bindingId: toolRefFor(current.installId, "lookup"),
        args: { query: "q" },
      });
      expect(result).toEqual({ outcome: "refused", code: "NOT_AVAILABLE" });
      expect(vendorCalls).toHaveLength(0);
    },
  );

  itDb(
    "A05: a revoked grant refuses the NEXT dispatch with zero transport calls",
    async () => {
      const current = await prepareCase();
      vendorCalls = [];
      await fixture.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
        );
        await tx.execute(
          sql`update enterprise_package_grants
                set revoked_at = now()
              where tenant_id = ${companyA} and install_id = ${current.installId}
                and tool_ref = ${TOOL_LOOKUP} and revoked_at is null`,
        );
      });
      const result = await dispatch.execute(scopeA1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        bindingId: toolRefFor(current.installId, "lookup"),
        args: { query: "q" },
      });
      expect(result).toEqual({ outcome: "refused", code: "NOT_AVAILABLE" });
      expect(vendorCalls).toHaveLength(0);
    },
  );

  itDb(
    "A05: an already-dispatched call keeps its real result after revocation",
    async () => {
      const current = await prepareCase();
      const begun = await dispatch.beginDispatch(scopeA1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        bindingId: toolRefFor(current.installId, "lookup"),
        args: { query: "q" },
      });
      expect(begun.outcome).toBe("permit");
      if (begun.outcome !== "permit") return;
      // Revoke everything AFTER the linearization point.
      await fixture.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
        );
        await tx.execute(
          sql`update enterprise_package_grants set revoked_at = now()
              where tenant_id = ${companyA} and install_id = ${current.installId}
                and revoked_at is null`,
        );
      });
      // The completion write is NOT gated on authorization: the effect happened.
      await dispatch.completeDispatch(scopeA1, begun.permit, {
        state: "succeeded",
        effectStatus: "confirmed",
        receiptRef: { effectStatus: "confirmed", isError: false },
      });
      const read = await dispatch.readDispatch(scopeA1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: begun.permit.toolCallId,
      });
      expect(read?.state).toBe("succeeded");
      expect(read?.receiptRef).toMatchObject({ effectStatus: "confirmed" });
    },
  );

  itDb("the same toolCallId dispatches once under concurrency", async () => {
    const current = await prepareCase();
    vendorCalls = [];
    vendorBehaviour = async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { text: "once", isError: false };
    };
    const toolCallId = `call-${randomUUID()}`;
    const input = {
      runId: current.runId,
      attemptGeneration: 1,
      toolCallId,
      bindingId: toolRefFor(current.installId, "lookup"),
      args: { query: "race" },
    };
    const [first, second] = await Promise.all([
      dispatch.execute(scopeA1, input),
      dispatch.execute(scopeA1, input),
    ]);
    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["ok", "refused"]);
    expect(vendorCalls).toHaveLength(1);
    const read = await dispatch.readDispatch(scopeA1, {
      runId: current.runId,
      attemptGeneration: 1,
      toolCallId,
    });
    expect(read?.state).toBe("succeeded");
  });

  itDb(
    "a write timeout is unknown, a read failure is failed, and neither is resent",
    async () => {
      const writeCase = await prepareCase({ toolRefs: [TOOL_WRITE] });
      vendorCalls = [];
      vendorBehaviour = async () => {
        throw new Error("socket closed mid-write");
      };
      const toolCallId = `call-${randomUUID()}`;
      await expect(
        dispatch.execute(scopeA1, {
          runId: writeCase.runId,
          attemptGeneration: 1,
          toolCallId,
          bindingId: toolRefFor(writeCase.installId, "write_note"),
          args: { note: "x" },
        }),
      ).rejects.toThrow();
      const writeRead = await dispatch.readDispatch(scopeA1, {
        runId: writeCase.runId,
        attemptGeneration: 1,
        toolCallId,
      });
      expect(writeRead?.state).toBe("unknown");
      expect(writeRead?.receiptRef).toMatchObject({ effectStatus: "unknown" });
      // No automatic resend: the same tool call refuses.
      const resent = await dispatch.execute(scopeA1, {
        runId: writeCase.runId,
        attemptGeneration: 1,
        toolCallId,
        bindingId: toolRefFor(writeCase.installId, "write_note"),
        args: { note: "x" },
      });
      expect(resent).toEqual({
        outcome: "refused",
        code: "DUPLICATE_DISPATCH",
      });
      expect(vendorCalls).toHaveLength(1);

      const readCase = await prepareCase();
      vendorBehaviour = async () => {
        throw new Error("read failed");
      };
      const readCallId = `call-${randomUUID()}`;
      await expect(
        dispatch.execute(scopeA1, {
          runId: readCase.runId,
          attemptGeneration: 1,
          toolCallId: readCallId,
          bindingId: toolRefFor(readCase.installId, "lookup"),
          args: { query: "q" },
        }),
      ).rejects.toThrow();
      const readRead = await dispatch.readDispatch(scopeA1, {
        runId: readCase.runId,
        attemptGeneration: 1,
        toolCallId: readCallId,
      });
      expect(readRead?.state).toBe("failed");
      expect(readRead?.receiptRef).toMatchObject({ effectStatus: "none" });
    },
  );

  itDb(
    "a crash after dispatch is recorded unknown and never resent",
    async () => {
      const current = await prepareCase();
      vendorCalls = [];
      const toolCallId = `call-${randomUUID()}`;
      const begun = await dispatch.beginDispatch(scopeA1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId,
        bindingId: toolRefFor(current.installId, "lookup"),
        args: { query: "q" },
      });
      expect(begun.outcome).toBe("permit");
      // Process death: nothing completes the dispatch row.
      expect(
        await dispatch.markUnknown(scopeA1, {
          runId: current.runId,
          attemptGeneration: 1,
          toolCallId,
          errorCode: "DISPATCH_CRASH",
        }),
      ).toBe(true);
      const read = await dispatch.readDispatch(scopeA1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId,
      });
      expect(read?.state).toBe("unknown");
      const retried = await dispatch.execute(scopeA1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId,
        bindingId: toolRefFor(current.installId, "lookup"),
        args: { query: "q" },
      });
      expect(retried).toEqual({
        outcome: "refused",
        code: "DUPLICATE_DISPATCH",
      });
      expect(vendorCalls).toHaveLength(0);
    },
  );

  itDb("an old pin never absorbs a tool granted after admission", async () => {
    const current = await prepareCase();
    vendorCalls = [];
    // A new active grant row for the SECOND tool, at a new generation.
    await fixture.operator.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
      );
      const declared = addedToolsOf(manifest).find(
        (tool) => tool.ref === TOOL_WRITE,
      );
      await tx.execute(
        sql`insert into enterprise_package_grants
                (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
                 resource_kind, tool_ref, schema_digest, effect, connector_install_id, granted_by)
              values (${companyA}, ${current.installId}, 2, ${current.botId},
                      ${CONNECTOR_RESOURCE}, ${teamA1}, 'connectorTool', ${TOOL_WRITE},
                      ${declared?.schemaDigest}, ${declared?.effect},
                      ${current.connector.connectorInstallId}, ${adminPrincipal})`,
      );
    });
    const result = await dispatch.execute(scopeA1, {
      runId: current.runId,
      attemptGeneration: 1,
      toolCallId: `call-${randomUUID()}`,
      bindingId: toolRefFor(current.installId, "write_note"),
      args: { note: "x" },
    });
    expect(result).toEqual({ outcome: "refused", code: "NOT_AVAILABLE" });
    expect(vendorCalls).toHaveLength(0);
    // And the offer never shows it either.
    const served = await runtime.readPinnedTools(scopeA1, {
      botId: current.botId,
      runId: current.runId,
      attemptGeneration: 1,
    });
    expect(served.map((tool) => tool.toolRef)).toEqual([TOOL_LOOKUP]);
  });

  itDb(
    "a grant whose contract drifted from the manifest is refused (A06)",
    async () => {
      const current = await prepareCase();
      vendorCalls = [];
      await fixture.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
        );
        await tx.execute(
          sql`update enterprise_package_grants
                set effect = 'write'
              where tenant_id = ${companyA} and install_id = ${current.installId}
                and tool_ref = ${TOOL_LOOKUP} and revoked_at is null`,
        );
      });
      const result = await dispatch.execute(scopeA1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        bindingId: toolRefFor(current.installId, "lookup"),
        args: { query: "q" },
      });
      expect(result).toEqual({ outcome: "refused", code: "NOT_AVAILABLE" });
      expect(vendorCalls).toHaveLength(0);
    },
  );

  itDb(
    "A02: a run of another company and an unknown run answer the same refusal",
    async () => {
      const current = await prepareCase();
      vendorCalls = [];
      const crossCompany = await dispatch.execute(scopeB1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        bindingId: toolRefFor(current.installId, "lookup"),
        args: { query: "q" },
      });
      const unknown = await dispatch.execute(scopeB1, {
        runId: randomUUID(),
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        bindingId: toolRefFor(current.installId, "lookup"),
        args: { query: "q" },
      });
      expect(crossCompany).toEqual(unknown);
      expect(crossCompany).toEqual({
        outcome: "refused",
        code: "RUN_LEASE_INVALID",
      });
      expect(vendorCalls).toHaveLength(0);
      // The other company's data role cannot even read the ledger.
      expect(companyB).not.toBe(companyA);
      expect(teamB1).not.toBe(teamA1);
      const readBack = await dispatch.readDispatch(scopeB1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: "irrelevant",
      });
      expect(readBack).toBeNull();
    },
  );

  itDb(
    "A07: approval facts bind — a disconnect, a generation change and changed args all refuse",
    async () => {
      // Disconnect during the approval wait.
      const disconnected = await prepareCase();
      vendorCalls = [];
      const prepared = await dispatch.preparePackageTool(scopeA1, {
        runId: disconnected.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        ref: toolRefFor(disconnected.installId, "lookup"),
        args: { query: "q" },
        botId: disconnected.botId,
      });
      expect(prepared.outcome).toBe("ticket");
      if (prepared.outcome !== "ticket") return;
      await fixture.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
        );
        await tx.execute(
          sql`delete from enterprise_plugin_connections
              where tenant_id = ${companyA} and id = ${disconnected.connector.connectionId}`,
        );
      });
      const refused = await dispatch.dispatchPackageTool(
        scopeA1,
        prepared.ticket,
        { query: "q" },
      );
      // The connection the proposal was approved against is gone: a different
      // action than the one approved, refused at the CAS, never at the vendor.
      expect(refused).toEqual({
        outcome: "refused",
        code: "CONNECTION_CHANGED",
      });
      expect(vendorCalls).toHaveLength(0);

      // A changed argument set is a different action.
      const argsCase = await prepareCase();
      const preparedArgs = await dispatch.preparePackageTool(scopeA1, {
        runId: argsCase.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        ref: toolRefFor(argsCase.installId, "lookup"),
        args: { query: "approved" },
        botId: argsCase.botId,
      });
      expect(preparedArgs.outcome).toBe("ticket");
      if (preparedArgs.outcome !== "ticket") return;
      const changed = await dispatch.dispatchPackageTool(
        scopeA1,
        preparedArgs.ticket,
        { query: "changed-after-approval" },
      );
      expect(changed).toEqual({ outcome: "refused", code: "ARGS_CHANGED" });
      expect(vendorCalls).toHaveLength(0);

      // A connection generation bump while the approval waited.
      const generationCase = await prepareCase();
      const preparedGen = await dispatch.preparePackageTool(scopeA1, {
        runId: generationCase.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        ref: toolRefFor(generationCase.installId, "lookup"),
        args: { query: "q" },
        botId: generationCase.botId,
      });
      expect(preparedGen.outcome).toBe("ticket");
      if (preparedGen.outcome !== "ticket") return;
      // Arrangement stand-in (superuser, disclosed): a connection re-bind that
      // bumps the generation lives in the #75 connection domain, which is not
      // wired in this version; the operator role deliberately has no UPDATE on
      // the connection table (unbind = delete row), so the stand-in writes the
      // column the decision path reads.
      await setup.$client.unsafe(
        `update enterprise_plugin_connections set generation = generation + 1
          where tenant_id = $1 and id = $2`,
        [companyA, generationCase.connector.connectionId],
      );
      const generationChanged = await dispatch.dispatchPackageTool(
        scopeA1,
        preparedGen.ticket,
        { query: "q" },
      );
      expect(generationChanged).toEqual({
        outcome: "refused",
        code: "CONNECTION_CHANGED",
      });
      expect(vendorCalls).toHaveLength(0);
    },
  );

  itDb(
    "OCR-fix-F2 H-B: a re-bind converges the scope and dispatch resolves the newest binding",
    async () => {
      const current = await prepareCase();
      // Historical residue (superuser stand-in, disclosed): a duplicate
      // binding for the same (install, boundBy) scope left by a pre-fix
      // re-bind, ordered OLDER than the live row — the state the write-side
      // convergence and the deterministic selection must both survive.
      const residueId = `pkg05-connection-${randomUUID()}`;
      await setup.$client.unsafe(
        `insert into enterprise_plugin_connections
           (tenant_id, id, install_id, bound_by, vendor_ref, generation, created_at)
         values ($1, $2, $3, $4, 'acct-stale-residue', 1, now() - interval '1 hour')`,
        [
          companyA,
          residueId,
          current.connector.connectorInstallId,
          adminPrincipal,
        ],
      );

      // Prepare BEFORE the re-bind: the ticket pins the live binding.
      const before = await dispatch.preparePackageTool(scopeA1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        ref: toolRefFor(current.installId, "lookup"),
        args: { query: "q" },
        botId: current.botId,
      });
      expect(before.outcome).toBe("ticket");
      if (before.outcome !== "ticket") return;
      expect(before.ticket.connectionId).toBe(current.connector.connectionId);

      // Re-bind through the real operator write path: the scope converges
      // to exactly one row — the new binding — residue included in the
      // sweep, so "the latest binding" always has exactly one answer.
      const rebound = await catalogAdmin.bindConnection({
        tenantId: companyA,
        installId: current.connector.connectorInstallId,
        boundBy: adminPrincipal,
        vendorRef: "acct-rebound",
      });
      const scopeRows = (await setup.$client.unsafe(
        `select id, vendor_ref from enterprise_plugin_connections
         where tenant_id = $1 and install_id = $2 and bound_by = $3`,
        [companyA, current.connector.connectorInstallId, adminPrincipal],
      )) as Array<{ id: string; vendor_ref: string }>;
      expect(scopeRows).toHaveLength(1);
      expect(scopeRows[0]?.id).toBe(rebound.connectionId);
      expect(scopeRows[0]?.vendor_ref).toBe("acct-rebound");

      // The proposal approved against the old binding refuses at the CAS:
      // the connection it described no longer exists.
      const stale = await dispatch.dispatchPackageTool(scopeA1, before.ticket, {
        query: "q",
      });
      expect(stale).toEqual({ outcome: "refused", code: "CONNECTION_CHANGED" });
      expect(vendorCalls).toHaveLength(0);

      // A fresh prepare resolves the NEW binding — the newest row with the
      // new vendor-ref fingerprint — never the stale residue.
      const after = await dispatch.preparePackageTool(scopeA1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        ref: toolRefFor(current.installId, "lookup"),
        args: { query: "q" },
        botId: current.botId,
      });
      expect(after.outcome).toBe("ticket");
      if (after.outcome !== "ticket") return;
      expect(after.ticket.connectionId).toBe(rebound.connectionId);
      expect(after.ticket.connectionId).not.toBe(residueId);

      // The call carries the new credential fingerprint to the vendor, once.
      vendorCalls = [];
      vendorBehaviour = async () => ({ text: "ok", isError: false });
      const dispatched = await dispatch.dispatchPackageTool(
        scopeA1,
        after.ticket,
        { query: "q" },
      );
      expect(dispatched).toEqual({ outcome: "ok", text: "ok", isError: false });
      expect(vendorCalls).toHaveLength(1);
      expect(vendorCalls[0]?.accountHandle).toBe("acct-rebound");

      // Determinism under surviving residue (rows a pre-fix bind left
      // behind and no re-bind ever swept): the resolution must point at the
      // newest created_at regardless of the rows' physical layout, so the
      // live row is deleted and re-inserted AFTER the residue — newest by
      // time, last by physical position.
      const residueCase = await prepareCase();
      const liveId = residueCase.connector.connectionId;
      const survivorId = `pkg05-connection-${randomUUID()}`;
      await setup.$client.unsafe(
        `insert into enterprise_plugin_connections
           (tenant_id, id, install_id, bound_by, vendor_ref, generation, created_at)
         values ($1, $2, $3, $4, 'acct-older-duplicate', 1, now() - interval '1 hour')`,
        [
          companyA,
          survivorId,
          residueCase.connector.connectorInstallId,
          adminPrincipal,
        ],
      );
      await setup.$client.unsafe(
        `delete from enterprise_plugin_connections
         where tenant_id = $1 and id = $2`,
        [companyA, liveId],
      );
      await setup.$client.unsafe(
        `insert into enterprise_plugin_connections
           (tenant_id, id, install_id, bound_by, vendor_ref, generation, created_at)
         values ($1, $2, $3, $4, 'acct-admin', 1, now())`,
        [
          companyA,
          liveId,
          residueCase.connector.connectorInstallId,
          adminPrincipal,
        ],
      );
      const residueProbe = await dispatch.preparePackageTool(scopeA1, {
        runId: residueCase.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        ref: toolRefFor(residueCase.installId, "lookup"),
        args: { query: "q" },
        botId: residueCase.botId,
      });
      expect(residueProbe.outcome).toBe("ticket");
      if (residueProbe.outcome !== "ticket") return;
      expect(residueProbe.ticket.connectionId).toBe(liveId);
      expect(residueProbe.ticket.connectionId).not.toBe(survivorId);
    },
  );

  itDb(
    "OCR-fix-C (R2-H3): a duplicate prepare answers the ledger row's facts, never a fresh ticket",
    async () => {
      const current = await prepareCase();
      const toolCallId = `call-${randomUUID()}`;
      const prepare = (args: Record<string, unknown>) =>
        dispatch.preparePackageTool(scopeA1, {
          runId: current.runId,
          attemptGeneration: 1,
          toolCallId,
          ref: toolRefFor(current.installId, "lookup"),
          args,
          botId: current.botId,
        });
      const first = await prepare({ query: "first-args" });
      expect(first.outcome).toBe("ticket");
      if (first.outcome !== "ticket") return;

      // ① 同 toolCallId 换参重入，旧行仍 prepared：票面必须回到台账行的
      // 事实（argsDigest=旧行值）——票面=台账=transport 三方一致。
      const retry = await prepare({ query: "changed-second-args" });
      expect(retry.outcome).toBe("ticket");
      if (retry.outcome !== "ticket") return;
      expect(retry.ticket.argsDigest).toBe(first.ticket.argsDigest);
      expect(retry.ticket.toolRef).toBe(first.ticket.toolRef);
      expect(retry.ticket.installId).toBe(first.ticket.installId);
      const ledgerRows = (await setup.$client.unsafe(
        "select count(*)::int as n from enterprise_package_dispatches where run_id = $1 and tool_call_id = $2",
        [current.runId, toolCallId],
      )) as Array<{ n: number }>;
      expect(ledgerRows[0]?.n).toBe(1);

      // ② 旧行已 dispatched：二次 prepare 是 typed 拒绝，不再发新事实票。
      vendorBehaviour = async () => ({ text: "ok", isError: false });
      const dispatched = await dispatch.dispatchPackageTool(
        scopeA1,
        first.ticket,
        { query: "first-args" },
      );
      expect(dispatched.outcome).toBe("ok");
      expect(await prepare({ query: "first-args" })).toEqual({
        outcome: "refused",
        code: "DUPLICATE_DISPATCH",
      });
    },
  );

  itDb(
    "an account-bearing connector without the caller's own connection refuses",
    async () => {
      const botId = await seedBot();
      // A composio-kind managed install with NO connection row: V1 package
      // calls run only in the caller's own account and never fall back to a
      // deployment credential.
      const composioCatalogId = `pkg05-composio-${randomUUID().slice(0, 8)}`;
      await setup.$client.unsafe(
        `insert into enterprise_plugin_catalog (id, kind, title, vendor, source, metadata)
         values ($1, 'composio', 'Managed Notes (brokered)', 'openbot', 'first-party', '{"summary":"brokered"}'::jsonb)`,
        [composioCatalogId],
      );
      const connectorInstallId = `pkg05-connector-${randomUUID()}`;
      await fixture.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
        );
        await tx.execute(
          sql`insert into enterprise_plugin_installs
                (tenant_id, id, catalog_id, workspace_id, installed_by, config, envelope, status)
              values (${companyA}, ${connectorInstallId}, ${composioCatalogId}, ${teamA1},
                      ${adminPrincipal}, '{"url":"https://broker.example.test/app/notes"}'::jsonb,
                      null, 'active')`,
        );
      });
      const connector: ConnectorSeed = {
        connectorInstallId,
        connectionId: "",
      };
      const seeded = await seedPackageInstall({ botId, connector });
      const runId = await seedRun({ botId });
      await withinRunTx(scopeA1, (tx) =>
        runtime.prepareWithin(tx, scopeA1, {
          botId,
          runId,
          attemptGeneration: 1,
        }),
      );
      vendorCalls = [];
      const result = await dispatch.execute(scopeA1, {
        runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        bindingId: toolRefFor(seeded.installId, "lookup"),
        args: { query: "q" },
      });
      expect(result).toEqual({
        outcome: "refused",
        code: "CONNECTION_UNAVAILABLE",
      });
      expect(vendorCalls).toHaveLength(0);
    },
  );

  itDb("a cancelled prepared call never dispatches", async () => {
    const current = await prepareCase();
    vendorCalls = [];
    const toolCallId = `call-${randomUUID()}`;
    const prepared = await dispatch.preparePackageTool(scopeA1, {
      runId: current.runId,
      attemptGeneration: 1,
      toolCallId,
      ref: toolRefFor(current.installId, "lookup"),
      args: { query: "q" },
      botId: current.botId,
    });
    expect(prepared.outcome).toBe("ticket");
    if (prepared.outcome !== "ticket") return;
    await dispatch.cancelDispatch(scopeA1, {
      runId: current.runId,
      attemptGeneration: 1,
      toolCallId,
    });
    const read = await dispatch.readDispatch(scopeA1, {
      runId: current.runId,
      attemptGeneration: 1,
      toolCallId,
    });
    expect(read?.state).toBe("cancelled");
    const refused = await dispatch.dispatchPackageTool(
      scopeA1,
      prepared.ticket,
      { query: "q" },
    );
    expect(refused).toEqual({ outcome: "refused", code: "DUPLICATE_DISPATCH" });
    expect(vendorCalls).toHaveLength(0);
  });

  itDb(
    "the dispatch ledger's data role is scoped and the directory role has no grant",
    async () => {
      const current = await prepareCase();
      vendorCalls = [];
      vendorBehaviour = async () => ({ text: "ok", isError: false });
      await dispatch.execute(scopeA1, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        bindingId: toolRefFor(current.installId, "lookup"),
        args: { query: "q" },
      });
      const dataB = createDatabase(enterpriseRuntimeDatabaseUrlFrom("data"), {
        max: 1,
      });
      try {
        const rows = (await dataB.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.tenant_id', ${companyB}, true), set_config('app.workspace_id', ${teamB1}, true)`,
          );
          return tx.execute(
            sql`select count(*)::int as n from enterprise_package_dispatches`,
          );
        })) as unknown as Array<{ n: number }>;
        expect(Number(rows[0]?.n ?? 0)).toBe(0);
      } finally {
        await dataB.$client.close().catch(() => {});
      }
      const directory = createDatabase(
        enterpriseRuntimeDatabaseUrlFrom("directory"),
        { max: 1 },
      );
      try {
        await expect(
          directory.transaction(async (tx) => {
            await tx.execute(
              sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
            );
            return tx.execute(
              sql`select count(*)::int as n from enterprise_package_dispatches`,
            );
          }),
        ).rejects.toThrow();
      } finally {
        await directory.$client.close().catch(() => {});
      }
    },
  );

  itDb(
    "connector tool grants take their contract from the revision manifest",
    async () => {
      const botId = await seedBot();
      const catalogId = await seedCatalogEntry();
      const connector = await seedConnector(catalogId);
      const seeded = await seedPackageInstall({
        botId,
        connector,
        toolRefs: [],
      });
      const installId = seeded.installId;
      const grants = createPackageGrantService({
        mutation: fixture.mutation,
        artifactRoot,
      });
      const admin = await fixture.adminContextOf("company-admin", "company-a");
      const declared = addedToolsOf(manifest);
      const written = await grants.setBotGrant(
        scopeA1,
        admin,
        {
          installId,
          botId,
          expectedGrantRevision: null,
          resources: [
            {
              resourceId: CONNECTOR_RESOURCE,
              kind: "managedConnector",
              toolRefs: [TOOL_LOOKUP],
            },
          ],
        },
        "pkg05-grant-tools",
      );
      expect(written.created).toBe(true);
      const rows = (await setup.$client.unsafe(
        `select tool_ref, schema_digest, effect, connector_install_id, resource_kind
           from enterprise_package_grants
          where tenant_id = $1 and install_id = $2 and revoked_at is null`,
        [companyA, installId],
      )) as Array<{
        tool_ref: string;
        schema_digest: string;
        effect: string;
        connector_install_id: string;
        resource_kind: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.resource_kind).toBe("connectorTool");
      expect(rows[0]?.tool_ref).toBe(TOOL_LOOKUP);
      expect(rows[0]?.schema_digest).toBe(
        declared.find((tool) => tool.ref === TOOL_LOOKUP)?.schemaDigest,
      );
      expect(rows[0]?.effect).toBe("read");
      expect(rows[0]?.connector_install_id).toBe(connector.connectorInstallId);
      // An undeclared tool (and a resource that carries no connection) is
      // refused rather than silently narrowed.
      const unknownToolFailure = await thrownMessage(
        grants.setBotGrant(
          scopeA1,
          admin,
          {
            installId,
            botId,
            expectedGrantRevision: written.grant.revision,
            resources: [
              {
                resourceId: CONNECTOR_RESOURCE,
                kind: "managedConnector",
                toolRefs: [`${CONNECTOR_RESOURCE}:not_a_tool`],
              },
            ],
          },
          "pkg05-grant-unknown-tool",
        ),
      );
      expect(unknownToolFailure).toContain("RESOURCE_NOT_FOUND");
      // A skill resource may not declare tools.
      const skillToolsFailure = await thrownMessage(
        grants.setBotGrant(
          scopeA1,
          admin,
          {
            installId,
            botId,
            expectedGrantRevision: written.grant.revision,
            resources: [
              { resourceId: SKILL_A, kind: "skill", toolRefs: [TOOL_LOOKUP] },
            ],
          },
          "pkg05-grant-skill-tools",
        ),
      );
      expect(skillToolsFailure).toContain("INPUT_INVALID");
    },
  );

  itDb("a run pinned with no package grants has no tool bindings", async () => {
    const botId = await seedBot();
    const runId = await seedRun({ botId });
    const snapshot = await withinRunTx(scopeA1, (tx) =>
      runtime.prepareWithin(tx, scopeA1, {
        botId,
        runId,
        attemptGeneration: 1,
      }),
    );
    expect(snapshot.pins).toEqual([]);
    const served = await runtime.readPinnedTools(scopeA1, {
      botId,
      runId,
      attemptGeneration: 1,
    });
    expect(served).toEqual([]);
  });
});
