// server/tests/multitenancy/package-unknown.test.ts
// PKG10（Issue #469）：unknown 效果核对的证据面（真实受限角色 + 真实 RLS）。
//
// 证据映射（#469 AC + A05/A08/A12 + Spec §9–10）：
//   (1) dispatched 后收回执前崩溃：新进程实例（“重启”）扫出同 operation 的
//       unknown，可被本范围成员查询（跨公司同形 NOT_AVAILABLE）。
//   (2) 供应商写超时 → unknown；同 toolCallId 再派发 DUPLICATE_DISPATCH，
//       transport 不再被调（无重发）。
//   (3) 无已验证协议：核对入口拒绝（VENDOR_QUERY_PROTOCOL_UNAVAILABLE），
//       transport 0 次、事实不动。
//   (4) 协议存在（测试注入）：仅按原 operation 身份核对，证据绑定原账号/
//       目标/参数摘要；写回保留 prior unknown 事实（撤权前效果不丢弃）；
//       非 unknown 行再核对 → DISPATCH_NOT_UNKNOWN。
//   (5) 协议无匹配 → unresolved，行保持 unknown 原样。
//   (6) 恢复门重验：全绿 → 后续（新 operation）可派发；撤权 → 探针与真实
//       派发同形拒绝——任何后续动作都走完整链，无免验通道。
//   (7) 核对只归 Run 发起人；其他成员可查不可续。
//   (8) 失权者拿不到可信 scope；有资格处理人仍可见事实。
//   (9) 停用/卸载/版本撤回后 unknown 与回执按权限保留（无删除路径）；
//       撤回同时阻断后续派发（PACKAGE_WITHDRAWN）。
//  (10) 安装详情面：unknown 计数徽标（脱敏计数）。
//
// 全部判定经真实受限角色与真实 RLS；transport/协议均为可控注入。

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
import type { Database } from "../../src/db/client";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  createPackageDispatchService,
  type PackageVendorCaller,
  type PackageVendorQueryProtocol,
} from "../../src/enterprise/plugin-packages/dispatch";
import { addedToolsOf } from "../../src/enterprise/plugin-packages/plans";
import { createPackageRuntime } from "../../src/enterprise/plugin-packages/runtime";
import type { SecretVault } from "../../src/enterprise/tenancy/credential-ownership";
import { createPluginCatalogDecisionService } from "../../src/enterprise/tenancy/plugin-catalog";
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
      reason: `PKG10 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

const CONNECTOR_RESOURCE = "notes";
const _TOOL_LOOKUP = `${CONNECTOR_RESOURCE}:lookup`;
const _TOOL_WRITE = `${CONNECTOR_RESOURCE}:write_note`;
const SECRET_CANARY = "i459-unknown-secret-canary";
const PACKAGE_KEY_PREFIX = "openbot/pkg10-unknown";
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
let adminPrincipal = "";
let catalogue: PackageCatalogue;
/** The probe catalogue's live release state — flipped by the withdrawal case. */
let releaseState: "published" | "withdrawn" = "published";
/** The production-shaped service: no registered vendor query protocol. */
let dispatch: ReturnType<typeof createPackageDispatchService>;
/** A second instance with an injected protocol (the "supported" half of AC3). */
let verifier: ReturnType<typeof createPackageDispatchService>;
let protocolSeen: Array<{
  operationId: string;
  argsDigest: string;
  accountHandle: string | null;
  url: string | null;
  toolName: string;
}> = [];
let protocolAnswers:
  | {
      found: true;
      outcome: "succeeded" | "failed";
      effectStatus: "confirmed" | "none";
    }
  | { found: false } = { found: false };
/** Every vendor dial the injected transport saw. */
let vendorCalls = 0;
let vendorBehaviour: () => Promise<{ text: string; isError: boolean }> =
  async () => ({ text: "ok", isError: false });

const vault: SecretVault = {
  seal: async (plaintext) => `pkg10-envelope:${plaintext}`,
  open: async (envelope) => envelope.slice("pkg10-envelope:".length),
};

const vendorCall: PackageVendorCaller = async () => {
  vendorCalls += 1;
  return vendorBehaviour();
};

const vendorQuery: PackageVendorQueryProtocol = async (input) => {
  protocolSeen.push({
    operationId: input.operationId,
    argsDigest: input.argsDigest,
    accountHandle: input.access.accountHandle,
    url: input.access.url,
    toolName: input.toolName,
  });
  return protocolAnswers;
};

async function storePackage(): Promise<string> {
  const { writeFile } = await import("node:fs/promises");
  const source = await mkdtemp(join(tmpdir(), "pkg10-source-"));
  const builtManifest: PackageManifestV1 = {
    schemaVersion: 1,
    platformApi: 1,
    publisher: "openbot",
    name: "pkg10-unknown",
    version: PACKAGE_VERSION,
    display: {
      name: "PKG10 unknown package",
      summary: "The PKG10 unknown-effect probe.",
    },
    resources: [
      {
        kind: "managedConnector",
        id: CONNECTOR_RESOURCE,
        catalogKey: "pkg10-managed-notes",
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
    state: releaseState,
    verified: true,
    displayName: "PKG10 unknown package",
    summary: "The PKG10 unknown-effect probe.",
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

interface ConnectorSeed {
  connectorInstallId: string;
  connectionId: string;
}

async function seedConnector(): Promise<ConnectorSeed> {
  const connectorInstallId = `pkg10-connector-${randomUUID()}`;
  const connectionId = `pkg10-connection-${randomUUID()}`;
  await setup.$client.unsafe(
    `insert into enterprise_plugin_catalog (id, kind, title, vendor, source, metadata)
     values ('pkg10-managed-notes', 'mcp', 'Managed Notes', 'openbot', 'first-party', '{"summary":"Managed notes MCP"}'::jsonb)
     on conflict (id) do nothing`,
  );
  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_plugin_installs
            (tenant_id, id, catalog_id, workspace_id, installed_by, config, envelope, status)
          values (${companyA}, ${connectorInstallId}, 'pkg10-managed-notes', ${teamA1},
                  ${adminPrincipal}, '{"url":"https://managed.example.test/mcp"}'::jsonb,
                  ${`pkg10-envelope:${SECRET_CANARY}`}, 'active')`,
    );
    await tx.execute(
      sql`insert into enterprise_plugin_connections
            (tenant_id, id, install_id, bound_by, vendor_ref, generation)
          values (${companyA}, ${connectionId}, ${connectorInstallId}, ${adminPrincipal}, 'acct-admin', 1)`,
    );
  });
  return { connectorInstallId, connectionId };
}

interface CaseSeed {
  botId: string;
  runId: string;
  installId: string;
  connector: ConnectorSeed;
}

/** One run with BOTH tools pinned: a definite read receipt can coexist. */
async function prepareCase(): Promise<CaseSeed> {
  const connector = await seedConnector();
  const installId = `pkg10-install-${randomUUID()}`;
  const packageKey = `${PACKAGE_KEY_PREFIX}-${randomUUID().slice(0, 8)}`;
  const botId = `pkg10-bot-${randomUUID()}`;
  const runId = randomUUID();
  const expertVersionRef = `pkg10-expert-${randomUUID()}`;
  const declared = addedToolsOf(manifest);
  await setup.$client.unsafe(
    `insert into enterprise_expert_versions
       (tenant_id, expert_version_ref, schema_version, agent_id, snapshot)
     values ($1, $2, 1, $3, '{}'::jsonb)`,
    [companyA, expertVersionRef, botId],
  );
  await setup.$client.unsafe(
    `insert into enterprise_runs
       (id, tenant_id, workspace_id, principal_id, thread_id, client_message_key,
        expert_version_ref, model_route_ref, model_route_maximum_tokens, status,
        attempt_generation, lease_expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'pkg10-route', 1000, 'running', 1, now() + interval '1 hour')`,
    [
      runId,
      companyA,
      teamA1,
      adminPrincipal,
      `pkg10-thread-${randomUUID()}`,
      `pkg10-msg-${randomUUID()}`,
      expertVersionRef,
    ],
  );
  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_bot_ownership
            (tenant_id, agent_id, workspace_id, owner_principal_id, display_name, default_config)
          values (${companyA}, ${botId}, ${teamA1}, ${adminPrincipal}, 'PKG10 bot', '{}'::jsonb)`,
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
          values (${companyA}, ${installId}, 1, ${CONNECTOR_RESOURCE}, ${teamA1}, 'managedConnector',
                  ${connector.connectorInstallId})`,
    );
    for (const tool of declared) {
      await tx.execute(
        sql`insert into enterprise_package_grants
              (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
               resource_kind, tool_ref, schema_digest, effect, connector_install_id, granted_by)
            values (${companyA}, ${installId}, 1, ${botId}, ${CONNECTOR_RESOURCE}, ${teamA1},
                    'connectorTool', ${tool.ref}, ${tool.schemaDigest}, ${tool.effect},
                    ${connector.connectorInstallId}, ${adminPrincipal})`,
      );
    }
  });
  await fixture.base.data.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.principal_id', ${scopeA1.principalId}, true), set_config('app.user_id', ${scopeA1.actorId}, true)`,
    );
    await runtime.prepareWithin(tx, scopeA1, {
      botId,
      runId,
      attemptGeneration: 1,
    });
  });
  return { botId, runId, installId, connector };
}

function writeBinding(installId: string): string {
  return `pkg:${installId}:${CONNECTOR_RESOURCE}/write_note`;
}

function lookupBinding(installId: string): string {
  return `pkg:${installId}:${CONNECTOR_RESOURCE}/lookup`;
}

/** One timed-out write call: the canonical unknown-effect arrange. */
async function arrangeUnknown(): Promise<{
  seed: CaseSeed;
  toolCallId: string;
}> {
  const seed = await prepareCase();
  vendorCalls = 0;
  vendorBehaviour = async () => {
    throw new Error("vendor write timeout");
  };
  const toolCallId = `call-${randomUUID()}`;
  await expect(
    dispatch.execute(scopeA1, {
      runId: seed.runId,
      attemptGeneration: 1,
      toolCallId,
      bindingId: writeBinding(seed.installId),
      args: { note: "n" },
    }),
  ).rejects.toThrow("vendor write timeout");
  return { seed, toolCallId };
}

async function operationIdOf(
  seed: CaseSeed,
  toolCallId: string,
): Promise<string> {
  const rows = (await setup.$client.unsafe(
    "select operation_id from enterprise_package_dispatches where run_id = $1 and tool_call_id = $2",
    [seed.runId, toolCallId],
  )) as Array<{ operation_id: string }>;
  if (rows.length !== 1 || !rows[0]?.operation_id) {
    throw new Error("PKG10_TEST_OPERATION_NOT_FOUND");
  }
  return rows[0].operation_id;
}

describeDb("PKG10 unknown dispatch ledger (real roles)", () => {
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
    // a1-member is an active team-a1 member of the isolation fixture: the
    // second reader (the view-vs-continue split below) needs no arrangement.
    companyA = fixture.tenantOf("company-a");
    teamA1 = fixture.teamOf("company-a", "team-a1");
    adminPrincipal = fixture.principalOf("company-admin", "company-a");
    scopeA1 = await fixture.scopeFor("company-admin", "team-a1");
    scopeB1 = await fixture.scopeFor("b1-member", "team-b1");
    artifactRoot = await mkdtemp(join(tmpdir(), "pkg10-artifacts-"));
    digest = await storePackage();
    catalogue = probeCatalogue();
    runtime = createPackageRuntime({
      data: fixture.base.data,
      artifactRoot,
    });
    const baseDeps = {
      data: fixture.base.data,
      catalogue,
      artifactRoot,
      vault,
      toolInvocation: createToolInvocationService({
        data: fixture.base.data,
      }),
      catalogDecisions: createPluginCatalogDecisionService(fixture.base.data),
      pinnedTools: runtime.readPinnedTools,
      vendorCall,
    } as const;
    dispatch = createPackageDispatchService(baseDeps);
    verifier = createPackageDispatchService({
      ...baseDeps,
      vendorQuery,
    });
  });

  afterAll(async () => {
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
    if (fixture) await fixture.dispose();
  });

  itDb(
    "a crash after dispatched survives a restart as the same unknown operation",
    async () => {
      const seed = await prepareCase();
      vendorCalls = 0;
      vendorBehaviour = async () => ({ text: "ok", isError: false });
      const toolCallId = `call-${randomUUID()}`;
      const begun = await dispatch.beginDispatch(scopeA1, {
        runId: seed.runId,
        attemptGeneration: 1,
        toolCallId,
        bindingId: writeBinding(seed.installId),
        args: { note: "n" },
      });
      expect(begun.outcome).toBe("permit");
      // Process death: nothing completes the row.
      // "Restart": a fresh service instance over the same database, plus the
      // documented sweep entry that settles the dangling dispatched row.
      const restarted = createPackageDispatchService({
        data: fixture.base.data,
        catalogue,
        artifactRoot,
        vault,
        toolInvocation: createToolInvocationService({
          data: fixture.base.data,
        }),
        catalogDecisions: createPluginCatalogDecisionService(fixture.base.data),
        pinnedTools: runtime.readPinnedTools,
        vendorCall,
      });
      expect(
        await restarted.markUnknown(scopeA1, {
          runId: seed.runId,
          attemptGeneration: 1,
          toolCallId,
          errorCode: "DISPATCH_CRASH",
        }),
      ).toBe(true);
      const listed = await restarted.listDispatches(scopeA1, {
        installId: seed.installId,
      });
      expect(listed.outcome).toBe("found");
      if (listed.outcome !== "found") return;
      expect(listed.value).toHaveLength(1);
      expect(listed.value[0]).toMatchObject({
        state: "unknown",
        toolCallId,
        runId: seed.runId,
        effect: "write",
        errorCode: "DISPATCH_CRASH",
      });
      const operationId = listed.value[0]?.operationId ?? "";
      const inspected = await restarted.inspectDispatch(scopeA1, {
        installId: seed.installId,
        operationId,
      });
      expect(inspected.outcome).toBe("found");
      if (inspected.outcome !== "found") return;
      expect(inspected.value.verification.kind).toBe("unknown");
      if (inspected.value.verification.kind !== "unknown") return;
      // The honest verification facts: no protocol, no auto-resend, and the
      // recovery gate evaluated against the live world.
      expect(inspected.value.verification.canQueryVendor).toBe(false);
      expect(inspected.value.verification.noAutoResendReason).toBe(
        "NO_VENDOR_QUERY_PROTOCOL",
      );
      expect(inspected.value.evidence).toMatchObject({
        connectorInstallId: seed.connector.connectorInstallId,
        accountHandle: "acct-admin",
      });
      expect(inspected.value.evidence.argsDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(inspected.value.recovery).toEqual({ ready: true });
      // Cross-company: one identical NOT_AVAILABLE (existence never leaks).
      expect(
        await restarted.listDispatches(scopeB1, { installId: seed.installId }),
      ).toEqual({ outcome: "refused", code: "NOT_AVAILABLE" });
      expect(
        await restarted.inspectDispatch(scopeB1, {
          installId: seed.installId,
          operationId,
        }),
      ).toEqual({ outcome: "refused", code: "NOT_AVAILABLE" });
    },
  );

  itDb(
    "a vendor write timeout settles as unknown and never resends",
    async () => {
      const { seed, toolCallId } = await arrangeUnknown();
      const read = await dispatch.readDispatch(scopeA1, {
        runId: seed.runId,
        attemptGeneration: 1,
        toolCallId,
      });
      expect(read?.state).toBe("unknown");
      expect(read?.receiptRef).toMatchObject({ effectStatus: "unknown" });
      expect(vendorCalls).toBe(1);
      // Re-running the SAME tool call id is refused — there is no resend path.
      const resent = await dispatch.execute(scopeA1, {
        runId: seed.runId,
        attemptGeneration: 1,
        toolCallId,
        bindingId: writeBinding(seed.installId),
        args: { note: "n" },
      });
      expect(resent).toEqual({
        outcome: "refused",
        code: "DUPLICATE_DISPATCH",
      });
      expect(vendorCalls).toBe(1);
      // The ledger count backs the install detail badge.
      expect(
        await fixture.readStore.countUnknownDispatches(scopeA1, seed.installId),
      ).toBe(1);
    },
  );

  itDb(
    "verification without a protocol is refused, transport untouched",
    async () => {
      const { seed, toolCallId } = await arrangeUnknown();
      vendorCalls = 0;
      const operationId = await operationIdOf(seed, toolCallId);
      const result = await dispatch.verifyDispatch(scopeA1, {
        installId: seed.installId,
        operationId,
      });
      expect(result).toEqual({
        outcome: "refused",
        code: "VENDOR_QUERY_PROTOCOL_UNAVAILABLE",
      });
      expect(vendorCalls).toBe(0);
      const read = await dispatch.readDispatch(scopeA1, {
        runId: seed.runId,
        attemptGeneration: 1,
        toolCallId,
      });
      expect(read?.state).toBe("unknown");
      // Non-members of the run see the same NOT_AVAILABLE as an unknown id.
      const cross = await dispatch.verifyDispatch(scopeB1, {
        installId: seed.installId,
        operationId,
      });
      expect(cross).toEqual({ outcome: "refused", code: "NOT_AVAILABLE" });
    },
  );

  itDb(
    "a registered protocol verifies by the original operation identity and preserves prior facts",
    async () => {
      const { seed, toolCallId } = await arrangeUnknown();
      protocolSeen = [];
      protocolAnswers = {
        found: true,
        outcome: "succeeded",
        effectStatus: "confirmed",
      };
      const operationId = await operationIdOf(seed, toolCallId);
      const before = await dispatch.readDispatch(scopeA1, {
        runId: seed.runId,
        attemptGeneration: 1,
        toolCallId,
      });
      const result = await verifier.verifyDispatch(scopeA1, {
        installId: seed.installId,
        operationId,
      });
      expect(result.outcome).toBe("found");
      if (result.outcome !== "found") return;
      expect(result.value.outcome).toBe("verified");
      expect(result.value.dispatch.state).toBe("succeeded");
      // The protocol was queried by the ORIGINAL identities only.
      expect(protocolSeen).toHaveLength(1);
      expect(protocolSeen[0]).toMatchObject({
        operationId,
        accountHandle: "acct-admin",
        url: "https://managed.example.test/mcp",
        toolName: "write_note",
      });
      expect(protocolSeen[0]?.argsDigest).toBe(before?.argsDigest);
      // The write-back keeps the pre-revocation facts: prior unknown state
      // rides along, the digest/generation columns never moved.
      const after = await dispatch.readDispatch(scopeA1, {
        runId: seed.runId,
        attemptGeneration: 1,
        toolCallId,
      });
      expect(after?.state).toBe("succeeded");
      expect(after?.receiptRef).toMatchObject({
        effectStatus: "confirmed",
        verifiedVia: "vendor_query",
        operationId,
        evidence: {
          accountHandle: "acct-admin",
          connectorInstallId: seed.connector.connectorInstallId,
        },
        prior: { state: "unknown" },
      });
      expect(after?.argsDigest).toBe(before?.argsDigest);
      expect(after?.connectionGeneration).toBe(before?.connectionGeneration);
      expect(
        await fixture.readStore.countUnknownDispatches(scopeA1, seed.installId),
      ).toBe(0);
      // A settled row is no longer verifiable.
      const again = await verifier.verifyDispatch(scopeA1, {
        installId: seed.installId,
        operationId,
      });
      expect(again).toEqual({
        outcome: "refused",
        code: "DISPATCH_NOT_UNKNOWN",
      });
    },
  );

  itDb(
    "an unresolved protocol match leaves the unknown facts untouched",
    async () => {
      const { seed, toolCallId } = await arrangeUnknown();
      protocolSeen = [];
      protocolAnswers = { found: false };
      const operationId = await operationIdOf(seed, toolCallId);
      const result = await verifier.verifyDispatch(scopeA1, {
        installId: seed.installId,
        operationId,
      });
      expect(result.outcome).toBe("found");
      if (result.outcome !== "found") return;
      expect(result.value.outcome).toBe("unresolved");
      expect(result.value.dispatch.state).toBe("unknown");
      const read = await dispatch.readDispatch(scopeA1, {
        runId: seed.runId,
        attemptGeneration: 1,
        toolCallId,
      });
      expect(read?.state).toBe("unknown");
      expect(read?.errorCode).toBe("DISPATCH_TRANSPORT_ERROR");
    },
  );

  itDb("recovery revalidation gates every follow-up action", async () => {
    const { seed } = await arrangeUnknown();
    vendorBehaviour = async () => ({ text: "ok", isError: false });
    vendorCalls = 0;
    const binding = writeBinding(seed.installId);
    // All gates green: the probe says ready, and a real follow-up (a NEW
    // operation, never the same toolCallId) passes the enforced chain.
    const ready = await dispatch.probeRecovery(scopeA1, {
      runId: seed.runId,
      attemptGeneration: 1,
      bindingRef: binding,
    });
    expect(ready).toEqual({ outcome: "ready" });
    const followUp = await dispatch.execute(scopeA1, {
      runId: seed.runId,
      attemptGeneration: 1,
      toolCallId: `call-${randomUUID()}`,
      bindingId: binding,
      args: { note: "retry-shape" },
    });
    expect(followUp.outcome).toBe("ok");
    expect(vendorCalls).toBe(1);
    // Revoke the grant: probe and real dispatch refuse the same way — no
    // follow-up path skips the full chain.
    await fixture.operator.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
      );
      await tx.execute(
        sql`update enterprise_package_grants set revoked_at = now()
              where tenant_id = ${companyA} and install_id = ${seed.installId} and revoked_at is null`,
      );
    });
    const blocked = await dispatch.probeRecovery(scopeA1, {
      runId: seed.runId,
      attemptGeneration: 1,
      bindingRef: binding,
    });
    expect(blocked).toEqual({ outcome: "refused", code: "NOT_AVAILABLE" });
    const refused = await dispatch.execute(scopeA1, {
      runId: seed.runId,
      attemptGeneration: 1,
      toolCallId: `call-${randomUUID()}`,
      bindingId: binding,
      args: { note: "retry-shape" },
    });
    expect(refused).toEqual({ outcome: "refused", code: "NOT_AVAILABLE" });
    expect(vendorCalls).toBe(1);
    // The unknown row itself is untouched by all of this.
    const rows = (await setup.$client.unsafe(
      "select count(*)::int as n from enterprise_package_dispatches where run_id = $1 and state = 'unknown'",
      [seed.runId],
    )) as Array<{ n: number }>;
    expect(Number(rows[0]?.n ?? 0)).toBe(1);
  });

  itDb(
    "verification belongs to the run's initiator; viewing is any member's",
    async () => {
      const { seed, toolCallId } = await arrangeUnknown();
      const memberScope = await fixture.scopeFor("a1-member", "team-a1");
      const operationId = await operationIdOf(seed, toolCallId);
      protocolSeen = [];
      protocolAnswers = {
        found: true,
        outcome: "succeeded",
        effectStatus: "confirmed",
      };
      // Another active member sees the ledger …
      const listed = await verifier.listDispatches(memberScope, {
        installId: seed.installId,
      });
      expect(listed.outcome).toBe("found");
      // … but cannot verify on someone else's account.
      expect(
        await verifier.verifyDispatch(memberScope, {
          installId: seed.installId,
          operationId,
        }),
      ).toEqual({ outcome: "refused", code: "NOT_AVAILABLE" });
      expect(protocolSeen).toHaveLength(0);
    },
  );

  itDb(
    "a revoked reader cannot obtain a scope; eligible handlers keep the facts",
    async () => {
      const { seed } = await arrangeUnknown();
      await fixture.scopeFor("a1-member", "team-a1");
      await fixture.setCompanyMembershipStatus(
        "a1-member",
        "company-a",
        "suspended",
      );
      // The live scope resolver refuses the suspended member — no view, no
      // continue, at the boundary the HTTP surface actually uses.
      await expect(fixture.scopeFor("a1-member", "team-a1")).rejects.toThrow();
      // The admin (an eligible handler) still sees every fact.
      const listed = await dispatch.listDispatches(scopeA1, {
        installId: seed.installId,
      });
      expect(listed.outcome).toBe("found");
      if (listed.outcome !== "found") return;
      expect(listed.value.length).toBeGreaterThan(0);
      await fixture.setCompanyMembershipStatus(
        "a1-member",
        "company-a",
        "active",
      );
    },
  );

  itDb("disable, uninstall and withdrawal preserve the ledger", async () => {
    const seed = await prepareCase();
    vendorBehaviour = async () => ({ text: "ok", isError: false });
    vendorCalls = 0;
    // A definite receipt and an unknown row in the SAME run.
    const okCall = await dispatch.execute(scopeA1, {
      runId: seed.runId,
      attemptGeneration: 1,
      toolCallId: `call-${randomUUID()}`,
      bindingId: lookupBinding(seed.installId),
      args: { query: "q" },
    });
    expect(okCall.outcome).toBe("ok");
    vendorBehaviour = async () => {
      throw new Error("vendor write timeout");
    };
    const unknownCallId = `call-${randomUUID()}`;
    await expect(
      dispatch.execute(scopeA1, {
        runId: seed.runId,
        attemptGeneration: 1,
        toolCallId: unknownCallId,
        bindingId: writeBinding(seed.installId),
        args: { note: "n" },
      }),
    ).rejects.toThrow("vendor write timeout");
    const operationId = await operationIdOf(seed, unknownCallId);
    const inspect = await dispatch.inspectDispatch(scopeA1, {
      installId: seed.installId,
      operationId,
    });
    expect(inspect.outcome).toBe("found");
    if (inspect.outcome === "found") {
      expect(inspect.value.verification.kind).toBe("unknown");
      if (inspect.value.verification.kind === "unknown") {
        // The same run's settled receipt is the correlated evidence.
        expect(inspect.value.verification.relatedReceipts).toHaveLength(1);
        expect(inspect.value.verification.relatedReceipts[0]).toMatchObject({
          state: "succeeded",
        });
      }
    }
    // Release withdrawal (install still enabled): facts remain, but no
    // follow-up dispatch may start.
    releaseState = "withdrawn";
    try {
      const blocked = await dispatch.probeRecovery(scopeA1, {
        runId: seed.runId,
        attemptGeneration: 1,
        bindingRef: writeBinding(seed.installId),
      });
      expect(blocked).toEqual({
        outcome: "refused",
        code: "PACKAGE_WITHDRAWN",
      });
      const stillVisible = await dispatch.listDispatches(scopeA1, {
        installId: seed.installId,
      });
      expect(stillVisible.outcome).toBe("found");
      if (stillVisible.outcome === "found") {
        expect(stillVisible.value).toHaveLength(2);
      }
    } finally {
      releaseState = "published";
    }
    // Disable → the ledger (unknown + receipt) stays.
    await fixture.operator.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
      );
      await tx.execute(
        sql`update enterprise_package_installs set status = 'disabled', generation = generation + 1
              where tenant_id = ${companyA} and id = ${seed.installId}`,
      );
    });
    let listed = await dispatch.listDispatches(scopeA1, {
      installId: seed.installId,
    });
    expect(listed.outcome).toBe("found");
    if (listed.outcome === "found") {
      expect(listed.value.map((row) => row.state).sort()).toEqual([
        "succeeded",
        "unknown",
      ]);
    }
    // Uninstall is a tombstone, never a delete: rows stay, and the
    // inspection (receipts included) still answers.
    await fixture.operator.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
      );
      await tx.execute(
        sql`update enterprise_package_installs set status = 'uninstalled', generation = generation + 1
              where tenant_id = ${companyA} and id = ${seed.installId}`,
      );
    });
    listed = await dispatch.listDispatches(scopeA1, {
      installId: seed.installId,
    });
    expect(listed.outcome).toBe("found");
    if (listed.outcome === "found") {
      expect(listed.value).toHaveLength(2);
    }
    expect(
      await dispatch.inspectDispatch(scopeA1, {
        installId: seed.installId,
        operationId,
      }),
    ).toMatchObject({ outcome: "found" });
  });
});
