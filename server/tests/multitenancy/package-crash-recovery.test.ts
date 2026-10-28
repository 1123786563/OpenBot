// server/tests/multitenancy/package-crash-recovery.test.ts
// T13-fix-2（#459 Run，Codex 终审 FC-02）：崩溃后 unknown 生产恢复路径的
// 证明——真实受限角色 + 真实 RLS + 真实跨装配进程租约证据。
//
// 证据面（全程无手动改状态入口：本文件零 markUnknown 调用）：
//   (1) 崩溃重启臂：装配 A（incarnation A）beginDispatch 后不 complete（模拟
//       进程死亡）→ 新装配 B（同库、新 incarnation）走生产恢复路径（台账读
//       本身）→ 行呈现 unknown/DISPATCH_CRASH、completedAt 已落、计入
//       unknown 计数、可被本范围成员查询（跨公司同形 NOT_AVAILABLE）。
//   (2) 不误伤臂：装配自己的 in-flight dispatched 行经自己的台账/详情读保持
//       dispatched（详情 verification.kind=in_flight），不被自己结算。
//   (3) 单写者边界（明示披露）：两个存活装配各自在同一安装持一 in-flight
//       行时，先读的那个会按租约证据结算对方的行——与 §10 release 锁单机
//       语义一致，见报告披露。
//   (4) 其他状态不受影响：prepared（审批挂起）、succeeded、failed、cancelled
//       行在恢复读后原地不动。
//   (5) 无租约存量行：dispatched 且 owner_incarnation 为 NULL（租约列之前的
//       存量行）按死进程孤儿收编 → unknown/DISPATCH_CRASH。
//   (6) 绝不自动重发 + 幂等：恢复后同 toolCallId 再派发 DUPLICATE_DISPATCH、
//       transport 计数不增；重复走恢复路径不改变已结算事实。
//
// 环境：与 package-unknown.test.ts 同一企业测试库契约（三角色 URL）。

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
  type PackageDispatchService,
  type PackageVendorCaller,
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
import type { PackageCatalogue } from "../../src/plugin-packages/catalogue";
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
      reason: `T13-fix-2 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
const SECRET_CANARY = "i459-unknown-secret-canary";
const PACKAGE_KEY_PREFIX = "openbot/pkg11-crash";
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

/** One long-lived assembly: every dispatch it starts, it owns. */
let live: PackageDispatchService;

let vendorCalls = 0;
let vendorBehaviour: () => Promise<{ text: string; isError: boolean }> =
  async () => ({ text: "ok", isError: false });

const vault: SecretVault = {
  seal: async (plaintext) => `pkg11-envelope:${plaintext}`,
  open: async (envelope) => envelope.slice("pkg11-envelope:".length),
};

const vendorCall: PackageVendorCaller = async () => {
  vendorCalls += 1;
  return vendorBehaviour();
};

async function storePackage(): Promise<string> {
  const { writeFile } = await import("node:fs/promises");
  const source = await mkdtemp(join(tmpdir(), "pkg11-source-"));
  const builtManifest: PackageManifestV1 = {
    schemaVersion: 1,
    platformApi: 1,
    publisher: "openbot",
    name: "pkg11-crash",
    version: PACKAGE_VERSION,
    display: {
      name: "PKG11 crash recovery package",
      summary: "The T13-fix-2 crash-recovery probe.",
    },
    resources: [
      {
        kind: "managedConnector",
        id: CONNECTOR_RESOURCE,
        catalogKey: "pkg11-managed-notes",
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
  const releaseFor = (packageKey: string) => ({
    packageKey,
    version: PACKAGE_VERSION,
    artifactDigest: digest,
    category: "productivity",
    listed: true,
    state: "published" as const,
    verified: true,
    displayName: "PKG11 crash recovery package",
    summary: "The T13-fix-2 crash-recovery probe.",
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

interface CaseSeed {
  readonly botId: string;
  readonly runId: string;
  readonly installId: string;
}

async function prepareCase(): Promise<CaseSeed> {
  const connectorInstallId = `pkg11-connector-${randomUUID()}`;
  const connectionId = `pkg11-connection-${randomUUID()}`;
  const installId = `pkg11-install-${randomUUID()}`;
  const packageKey = `${PACKAGE_KEY_PREFIX}-${randomUUID().slice(0, 8)}`;
  const botId = `pkg11-bot-${randomUUID()}`;
  const runId = randomUUID();
  const expertVersionRef = `pkg11-expert-${randomUUID()}`;
  const declared = addedToolsOf(manifest);
  await setup.$client.unsafe(
    `insert into enterprise_plugin_catalog (id, kind, title, vendor, source, metadata)
     values ('pkg11-managed-notes', 'mcp', 'Managed Notes', 'openbot', 'first-party', '{"summary":"Managed notes MCP"}'::jsonb)
     on conflict (id) do nothing`,
  );
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
     values ($1, $2, $3, $4, $5, $6, $7, 'pkg11-route', 1000, 'running', 1, now() + interval '1 hour')`,
    [
      runId,
      companyA,
      teamA1,
      adminPrincipal,
      `pkg11-thread-${randomUUID()}`,
      `pkg11-msg-${randomUUID()}`,
      expertVersionRef,
    ],
  );
  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_plugin_installs
          (tenant_id, id, catalog_id, workspace_id, installed_by, config, envelope, status)
        values (${companyA}, ${connectorInstallId}, 'pkg11-managed-notes', ${teamA1},
                ${adminPrincipal}, '{"url":"https://managed.example.test/mcp"}'::jsonb,
                ${`pkg11-envelope:${SECRET_CANARY}`}, 'active')`,
    );
    await tx.execute(
      sql`insert into enterprise_plugin_connections
          (tenant_id, id, install_id, bound_by, vendor_ref, generation)
        values (${companyA}, ${connectionId}, ${connectorInstallId}, ${adminPrincipal}, 'acct-admin', 1)`,
    );
    await tx.execute(
      sql`insert into enterprise_bot_ownership
          (tenant_id, agent_id, workspace_id, owner_principal_id, display_name, default_config)
        values (${companyA}, ${botId}, ${teamA1}, ${adminPrincipal}, 'PKG11 bot', '{}'::jsonb)`,
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
                ${connectorInstallId})`,
    );
    for (const tool of declared) {
      await tx.execute(
        sql`insert into enterprise_package_grants
            (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
             resource_kind, tool_ref, schema_digest, effect, connector_install_id, granted_by)
          values (${companyA}, ${installId}, 1, ${botId}, ${CONNECTOR_RESOURCE}, ${teamA1},
                  'connectorTool', ${tool.ref}, ${tool.schemaDigest}, ${tool.effect},
                  ${connectorInstallId}, ${adminPrincipal})`,
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
  return { botId, runId, installId };
}

function writeBinding(installId: string): string {
  return `pkg:${installId}:${CONNECTOR_RESOURCE}/write_note`;
}

function lookupBinding(installId: string): string {
  return `pkg:${installId}:${CONNECTOR_RESOURCE}/lookup`;
}

/** A fresh assembly over the same database — a "restarted process". */
function newAssembly(incarnation = randomUUID()): PackageDispatchService {
  return createPackageDispatchService({
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
    incarnation,
  });
}

async function rawStateOf(operationId: string): Promise<string> {
  const rows = (await setup.$client.unsafe(
    "select state from enterprise_package_dispatches where operation_id = $1",
    [operationId],
  )) as Array<{ state: string }>;
  if (!rows[0]) throw new Error("PKG11_TEST_ROW_NOT_FOUND");
  return rows[0].state;
}

async function operationIdOf(
  seed: CaseSeed,
  toolCallId: string,
): Promise<string> {
  const rows = (await setup.$client.unsafe(
    "select operation_id from enterprise_package_dispatches where run_id = $1 and tool_call_id = $2",
    [seed.runId, toolCallId],
  )) as Array<{ operation_id: string }>;
  if (!rows[0]?.operation_id) throw new Error("PKG11_TEST_OPERATION_NOT_FOUND");
  return rows[0].operation_id;
}

/** A dispatch left dangling by a dead process: begin, then never complete. */
async function crashDispatch(
  assembly: PackageDispatchService,
  scope: PlatformScope,
  seed: CaseSeed,
): Promise<string> {
  const toolCallId = `pkg11-call-${randomUUID()}`;
  const begun = await assembly.beginDispatch(scope, {
    runId: seed.runId,
    attemptGeneration: 1,
    toolCallId,
    bindingId: writeBinding(seed.installId),
    args: { note: "crash" },
  });
  if (begun.outcome !== "permit") throw new Error("PKG11_TEST_BEGIN_REFUSED");
  return toolCallId;
}

describeDb(
  "PKG11 crash recovery path (real roles, cross-assembly lease)",
  () => {
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
      adminPrincipal = fixture.principalOf("company-admin", "company-a");
      scopeA1 = await fixture.scopeFor("company-admin", "team-a1");
      scopeB1 = await fixture.scopeFor("b1-member", "team-b1");
      artifactRoot = await mkdtemp(join(tmpdir(), "pkg11-artifacts-"));
      digest = await storePackage();
      catalogue = probeCatalogue();
      runtime = createPackageRuntime({
        data: fixture.base.data,
        artifactRoot,
      });
      live = newAssembly("pkg11-live-assembly");
    });

    afterAll(async () => {
      if (artifactRoot)
        await rm(artifactRoot, { recursive: true, force: true });
      if (fixture) await fixture.dispose();
    });

    itDb(
      "a dead owner's dangling dispatched row settles unknown on the new assembly's ledger read",
      async () => {
        const seed = await prepareCase();
        vendorCalls = 0;
        vendorBehaviour = async () => ({ text: "ok", isError: false });
        const doomed = newAssembly("pkg11-dead-owner");
        const toolCallId = await crashDispatch(doomed, scopeA1, seed);
        const operationId = await operationIdOf(seed, toolCallId);
        // The lease evidence is on the row before "death".
        const leaseRows = (await setup.$client.unsafe(
          "select owner_incarnation, owner_lease_expires_at from enterprise_package_dispatches where operation_id = $1",
          [operationId],
        )) as Array<{
          owner_incarnation: string;
          owner_lease_expires_at: Date;
        }>;
        expect(leaseRows[0]?.owner_incarnation).toBe("pkg11-dead-owner");
        expect(leaseRows[0]!.owner_lease_expires_at!.getTime()).toBeGreaterThan(
          Date.now(),
        );
        // Process death: `doomed` never completes the row and its incarnation
        // dies with it. The restarted assembly walks the production recovery
        // path — the ledger read itself, no manual settle entry anywhere here.
        const restarted = newAssembly("pkg11-restarted");
        const listed = await restarted.listDispatches(scopeA1, {
          installId: seed.installId,
        });
        expect(listed.outcome).toBe("found");
        if (listed.outcome !== "found") return;
        expect(listed.value).toHaveLength(1);
        const row = listed.value[0];
        expect(row).toMatchObject({
          operationId,
          state: "unknown",
          toolCallId,
          runId: seed.runId,
          effect: "write",
          errorCode: "DISPATCH_CRASH",
        });
        expect(row?.completedAt).not.toBeNull();
        expect(row?.receiptRef).toMatchObject({ effectStatus: "unknown" });
        // Settled in the database, not only in the view; the crash evidence
        // (which assembly's lease went dead) is never rewritten by recovery.
        expect(await rawStateOf(operationId)).toBe("unknown");
        const settledLease = (await setup.$client.unsafe(
          "select owner_incarnation from enterprise_package_dispatches where operation_id = $1",
          [operationId],
        )) as Array<{ owner_incarnation: string }>;
        expect(settledLease[0]?.owner_incarnation).toBe("pkg11-dead-owner");
        // Visible and counted through the existing surfaces.
        expect(
          await fixture.readStore.countUnknownDispatches(
            scopeA1,
            seed.installId,
          ),
        ).toBe(1);
        const inspected = await restarted.inspectDispatch(scopeA1, {
          installId: seed.installId,
          operationId,
        });
        expect(inspected.outcome).toBe("found");
        if (inspected.outcome !== "found") return;
        expect(inspected.value.verification.kind).toBe("unknown");
        if (inspected.value.verification.kind !== "unknown") return;
        expect(inspected.value.verification.canQueryVendor).toBe(false);
        expect(inspected.value.verification.noAutoResendReason).toBe(
          "NO_VENDOR_QUERY_PROTOCOL",
        );
        // Existence never leaks cross-company.
        expect(
          await restarted.listDispatches(scopeB1, {
            installId: seed.installId,
          }),
        ).toEqual({ outcome: "refused", code: "NOT_AVAILABLE" });
      },
    );

    itDb("an assembly never settles its own in-flight dispatch", async () => {
      const seed = await prepareCase();
      vendorCalls = 0;
      vendorBehaviour = async () => ({ text: "ok", isError: false });
      const toolCallId = await crashDispatch(live, scopeA1, seed);
      const operationId = await operationIdOf(seed, toolCallId);
      // The owning assembly's own ledger read: its in-flight row survives.
      const listed = await live.listDispatches(scopeA1, {
        installId: seed.installId,
      });
      expect(listed.outcome).toBe("found");
      if (listed.outcome !== "found") return;
      expect(listed.value).toHaveLength(1);
      expect(listed.value[0]).toMatchObject({
        state: "dispatched",
        toolCallId,
        errorCode: null,
      });
      expect(listed.value[0]?.completedAt).toBeNull();
      expect(await rawStateOf(operationId)).toBe("dispatched");
      // The detail surface calls it in_flight, never unknown, and the badge
      // counter stays at zero.
      const inspected = await live.inspectDispatch(scopeA1, {
        installId: seed.installId,
        operationId,
      });
      expect(inspected.outcome).toBe("found");
      if (inspected.outcome !== "found") return;
      expect(inspected.value.verification.kind).toBe("in_flight");
      expect(
        await fixture.readStore.countUnknownDispatches(scopeA1, seed.installId),
      ).toBe(0);
    });

    itDb(
      "two live assemblies: the first ledger read settles the other's row (single-writer boundary)",
      async () => {
        const seed = await prepareCase();
        vendorCalls = 0;
        vendorBehaviour = async () => ({ text: "ok", isError: false });
        const assemblyA = newAssembly("pkg11-live-a");
        const assemblyB = newAssembly("pkg11-live-b");
        // Both dispatch into the SAME install; neither completes yet.
        const callA = await crashDispatch(assemblyA, scopeA1, seed);
        const callB = await crashDispatch(assemblyB, scopeA1, seed);
        const operationA = await operationIdOf(seed, callA);
        const operationB = await operationIdOf(seed, callB);
        // A's own read: A's row is A's lease (live), B's row is foreign. Rule (a)
        // reads the lease, not liveness, so B's row settles — this is the
        // disclosed single-instance boundary (same as §10's release lock).
        const listed = await assemblyA.listDispatches(scopeA1, {
          installId: seed.installId,
        });
        expect(listed.outcome).toBe("found");
        if (listed.outcome !== "found") return;
        const byCallId = new Map(
          listed.value.map((row) => [row.toolCallId, row]),
        );
        expect(byCallId.get(callA)).toMatchObject({ state: "dispatched" });
        expect(byCallId.get(callB)).toMatchObject({
          state: "unknown",
          errorCode: "DISPATCH_CRASH",
        });
        expect(await rawStateOf(operationA)).toBe("dispatched");
        expect(await rawStateOf(operationB)).toBe("unknown");
        // Never a resend: the settled operation cannot be dispatched again.
        const resent = await assemblyB.execute(scopeA1, {
          runId: seed.runId,
          attemptGeneration: 1,
          toolCallId: callB,
          bindingId: writeBinding(seed.installId),
          args: { note: "crash" },
        });
        expect(resent).toEqual({
          outcome: "refused",
          code: "DUPLICATE_DISPATCH",
        });
        expect(vendorCalls).toBe(0);
      },
    );

    itDb(
      "recovery leaves prepared, succeeded, failed and cancelled rows untouched",
      async () => {
        const seed = await prepareCase();
        vendorCalls = 0;
        vendorBehaviour = async () => ({ text: "ok", isError: false });
        // A definite succeeded receipt …
        const okCallId = `pkg11-ok-${randomUUID()}`;
        const okCall = await live.execute(scopeA1, {
          runId: seed.runId,
          attemptGeneration: 1,
          toolCallId: okCallId,
          bindingId: lookupBinding(seed.installId),
          args: { query: "q" },
        });
        expect(okCall.outcome).toBe("ok");
        // … and a definite failed receipt (a read whose result is an error).
        vendorBehaviour = async () => ({ text: "boom", isError: true });
        const failedCallId = `pkg11-failed-${randomUUID()}`;
        const failedCall = await live.execute(scopeA1, {
          runId: seed.runId,
          attemptGeneration: 1,
          toolCallId: failedCallId,
          bindingId: lookupBinding(seed.installId),
          args: { query: "q" },
        });
        expect(failedCall.outcome).toBe("ok");
        // An approval-pending prepared row and a cancelled row.
        const preparedCallId = `pkg11-pending-${randomUUID()}`;
        const ticket = await live.preparePackageTool(scopeA1, {
          runId: seed.runId,
          attemptGeneration: 1,
          toolCallId: preparedCallId,
          ref: writeBinding(seed.installId),
          args: { note: "pending" },
          botId: seed.botId,
        });
        expect(ticket.outcome).toBe("ticket");
        const cancelledCallId = `pkg11-cancelled-${randomUUID()}`;
        await live.preparePackageTool(scopeA1, {
          runId: seed.runId,
          attemptGeneration: 1,
          toolCallId: cancelledCallId,
          ref: writeBinding(seed.installId),
          args: { note: "revoked" },
          botId: seed.botId,
        });
        await live.cancelDispatch(scopeA1, {
          runId: seed.runId,
          attemptGeneration: 1,
          toolCallId: cancelledCallId,
        });
        // The crashed row from a dead owner, dispatched and never completed.
        const doomed = newAssembly("pkg11-doomed-owner");
        const crashedCallId = await crashDispatch(doomed, scopeA1, seed);
        const crashedOperation = await operationIdOf(seed, crashedCallId);
        // A fresh assembly walks the recovery path over this install: exactly
        // the dangling dispatched rows settle; every other state is untouched.
        const restarted = newAssembly("pkg11-restart-mixed");
        const listed = await restarted.listDispatches(scopeA1, {
          installId: seed.installId,
        });
        expect(listed.outcome).toBe("found");
        if (listed.outcome !== "found") return;
        const byCallId = new Map(
          listed.value.map((row) => [row.toolCallId, row]),
        );
        expect(listed.value).toHaveLength(5);
        expect(byCallId.get(crashedCallId)).toMatchObject({
          state: "unknown",
          errorCode: "DISPATCH_CRASH",
        });
        expect(byCallId.get(okCallId)).toMatchObject({ state: "succeeded" });
        expect(byCallId.get(failedCallId)).toMatchObject({ state: "failed" });
        expect(byCallId.get(preparedCallId)).toMatchObject({
          state: "prepared",
          errorCode: null,
          completedAt: null,
        });
        expect(byCallId.get(cancelledCallId)).toMatchObject({
          state: "cancelled",
        });
        expect(await rawStateOf(crashedOperation)).toBe("unknown");
        expect(
          await fixture.readStore.countUnknownDispatches(
            scopeA1,
            seed.installId,
          ),
        ).toBe(1);
        // Recovery is idempotent: a second pass changes no settled fact.
        const again = await restarted.listDispatches(scopeA1, {
          installId: seed.installId,
        });
        expect(again.outcome).toBe("found");
        if (again.outcome !== "found") return;
        const againByCallId = new Map(
          again.value.map((row) => [row.toolCallId, row]),
        );
        expect(againByCallId.get(crashedCallId)).toEqual(
          byCallId.get(crashedCallId),
        );
        expect(againByCallId.get(okCallId)).toEqual(byCallId.get(okCallId));
        expect(againByCallId.get(preparedCallId)).toEqual(
          byCallId.get(preparedCallId),
        );
      },
    );

    itDb(
      "pre-lease legacy dispatched rows carry no owner and settle as orphans",
      async () => {
        const seed = await prepareCase();
        vendorCalls = 0;
        vendorBehaviour = async () => ({ text: "ok", isError: false });
        const toolCallId = await crashDispatch(live, scopeA1, seed);
        const operationId = await operationIdOf(seed, toolCallId);
        // Erase the lease evidence: exactly the shape a row dispatched before
        // PKG11 lands in (both lease columns NULL).
        await setup.$client.unsafe(
          `update enterprise_package_dispatches
            set owner_incarnation = null, owner_lease_expires_at = null
          where operation_id = $1`,
          [operationId],
        );
        // A fresh assembly's ledger read treats it as an orphan of a dead owner.
        const restarted = newAssembly("pkg11-after-legacy");
        const listed = await restarted.listDispatches(scopeA1, {
          installId: seed.installId,
        });
        expect(listed.outcome).toBe("found");
        if (listed.outcome !== "found") return;
        expect(listed.value).toHaveLength(1);
        expect(listed.value[0]).toMatchObject({
          operationId,
          state: "unknown",
          toolCallId,
          errorCode: "DISPATCH_CRASH",
        });
        expect(await rawStateOf(operationId)).toBe("unknown");
      },
    );

    itDb(
      "the settled unknown row is listed, inspected and counted by the existing surfaces",
      async () => {
        const seed = await prepareCase();
        vendorCalls = 0;
        vendorBehaviour = async () => ({ text: "ok", isError: false });
        const doomed = newAssembly("pkg11-visibility-owner");
        const toolCallId = await crashDispatch(doomed, scopeA1, seed);
        // The recovery path is the DETAIL surface here — no ledger list first.
        const restarted = newAssembly("pkg11-visibility-restart");
        const inspected = await restarted.inspectDispatch(scopeA1, {
          installId: seed.installId,
          operationId: await operationIdOf(seed, toolCallId),
        });
        expect(inspected.outcome).toBe("found");
        if (inspected.outcome !== "found") return;
        expect(inspected.value.dispatch).toMatchObject({
          state: "unknown",
          errorCode: "DISPATCH_CRASH",
          effect: "write",
        });
        expect(inspected.value.verification.kind).toBe("unknown");
        if (inspected.value.verification.kind !== "unknown") return;
        expect(inspected.value.evidence).toMatchObject({
          accountHandle: "acct-admin",
          connectionGeneration: 1,
        });
        expect(inspected.value.evidence.argsDigest).toMatch(/^[0-9a-f]{64}$/);
        // The ledger list then shows the same settled row and the badge counts it.
        const listed = await restarted.listDispatches(scopeA1, {
          installId: seed.installId,
        });
        expect(listed.outcome).toBe("found");
        if (listed.outcome !== "found") return;
        expect(listed.value).toHaveLength(1);
        expect(listed.value[0]?.state).toBe("unknown");
        expect(
          await fixture.readStore.countUnknownDispatches(
            scopeA1,
            seed.installId,
          ),
        ).toBe(1);
      },
    );
  },
);
