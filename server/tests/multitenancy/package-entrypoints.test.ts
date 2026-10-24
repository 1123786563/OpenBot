// server/tests/multitenancy/package-entrypoints.test.ts
// PKG09（Issue #468，Spec §9）：后台入口从持久 Run 归属重建可信 Scope 的
// 真实受限角色证据面。
//
// 证据映射（#468 AC1–AC4 + A02/A05/A07）：
//   (1) 正向：身份只有（ownerUserId, runId, botId）时，restoreRunContext 从
//       enterprise_runs 行重建 scope（run 的 tenant/workspace/principal）、
//       attempt 与 admitted Bot；重建的 scope 是 resolver 签发的受信对象，
//       能穿过 dispatch 的 assertTrustedScope 与全部 RLS 臂；经它
//       prepare→dispatch 放行 transport 恰一次。
//   (2) 反序列化客户端 scope 不受信：run 在 team-a1，而 owner 同时属于
//       team-a2；恢复返回的是 run 行的 team-a1（不是调用者想要的团队，也
//       不是提案 target 里的伪造 scope）；伪造的 runId 找不到行即规范化拒绝。
//   (3) 无受管 Run 同形：不存在 runId / 同公司他人 Run / 他公司 Run 一律
//       PACKAGE_RUN_REQUIRED（不泄露存在性）。
//   (4) Bot 绑定：提案命名的 Bot 不是 run 准入的 Bot → PACKAGE_RUN_BOT_MISMATCH。
//   (5) 等待期间撤权/切团队：公司成员资格被真实 suspend（epoch 前移）→ 恢复
//       在签发处拒绝 PACKAGE_RUN_SCOPE_LOST，transport 0 次。
//   (6) A07 审批期失效（恢复后走 T05 beginDispatch 全量重验）：
//       撤 grant → 拒绝；改参 → ARGS_CHANGED；连接换代次 → CONNECTION_CHANGED；
//       连接换账号 → CONNECTION_UNAVAILABLE；均 transport 0 次。
//   (7) 取消/重试不重置 operation identity：cancelled 后同 toolCallId 再派发
//       → DUPLICATE_DISPATCH，transport 0 次。
//
// 真实受限角色（data/operator/directory）+ 真实 RLS；transport 为可控注入
// （不拨真实供应商）。安排行（install/grant/run 种子）经披露过的 superuser/
// operator 通道建立，与被测判定无关的部分与 PKG05 套件同构。

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
import {
  createPackageDispatchService,
  type PackageVendorCaller,
} from "../../src/enterprise/plugin-packages/dispatch";
import {
  createPackageEntrypoints,
  packageRunForBinding,
} from "../../src/enterprise/plugin-packages/entrypoints";
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
      reason: `PKG09 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
const CONNECTOR_URL = "https://managed.example.test/mcp";
const SECRET_CANARY = "i468-entrypoint-secret-canary";
const PACKAGE_KEY_PREFIX = "openbot/pkg09-entrypoints";
const PACKAGE_VERSION = "1.0.0";

const OWNER = "a1a2-member" as const;
const OTHER = "a1-other" as const;

let fixture: PackageInstallFixture;
let setup: Database;
let artifactRoot: string;
let digest = "";
let manifest: PackageManifestV1;
let runtime: ReturnType<typeof createPackageRuntime>;
let entrypoints: ReturnType<typeof createPackageEntrypoints>;
let catalogue: PackageCatalogue;
let dispatch: ReturnType<typeof createPackageDispatchService>;
let companyA = "";
let teamA1 = "";
let teamA2 = "";
let ownerPrincipal = "";
let ownerUserId = "";
let otherPrincipal = "";
let vendorCalls: Array<{
  url: string | null;
  token: string | null;
  accountHandle: string | null;
  toolName: string;
}> = [];

const vault: SecretVault = {
  seal: async (plaintext) => `pkg09-envelope:${plaintext}`,
  open: async (envelope) => {
    if (!envelope.startsWith("pkg09-envelope:")) {
      throw new Error("PKG09_TEST_ENVELOPE_INVALID");
    }
    return envelope.slice("pkg09-envelope:".length);
  },
};

const vendorCall: PackageVendorCaller = async (access, toolName) => {
  vendorCalls.push({
    url: access.url,
    token: access.token,
    accountHandle: access.accountHandle,
    toolName,
  });
  return { text: "found 2 notes", isError: false };
};

async function storePackage(): Promise<string> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const source = await mkdtemp(join(tmpdir(), "pkg09-source-"));
  const builtManifest: PackageManifestV1 = {
    schemaVersion: 1,
    platformApi: 1,
    publisher: "openbot",
    name: "pkg09-entrypoints",
    version: PACKAGE_VERSION,
    display: {
      name: "PKG09 entrypoints package",
      summary: "The PKG09 background-entry probe.",
    },
    resources: [
      { kind: "skill", id: SKILL_A, path: `skills/${SKILL_A}/SKILL.md` },
      {
        kind: "managedConnector",
        id: CONNECTOR_RESOURCE,
        catalogKey: "managed-notes",
        required: true,
        tools: [{ name: "lookup", effect: "read" }],
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
    displayName: "PKG09 entrypoints package",
    summary: "The PKG09 background-entry probe.",
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

interface SeededCase {
  botId: string;
  runId: string;
  installId: string;
  connectorInstallId: string;
  connectionId: string;
}

async function seedCatalogEntry(): Promise<string> {
  const catalogId = "pkg09-managed-notes";
  await setup.$client.unsafe(
    `insert into enterprise_plugin_catalog (id, kind, title, vendor, source, metadata)
     values ($1, 'mcp', 'Managed Notes', 'openbot', 'first-party', '{"summary":"Managed notes MCP"}'::jsonb)
     on conflict (id) do nothing`,
    [catalogId],
  );
  return catalogId;
}

/** One fully prepared case: connector install + package install/grants + bot + run + pins. */
async function prepareCase(input?: {
  principalId?: string;
  workspaceId?: string;
  runStatus?: "running" | "waiting_approval";
}): Promise<SeededCase> {
  const principalId = input?.principalId ?? ownerPrincipal;
  const workspaceId = input?.workspaceId ?? teamA1;
  const botId = `pkg09-bot-${randomUUID().slice(0, 8)}`;
  const catalogId = await seedCatalogEntry();
  const connectorInstallId = `pkg09-connector-${randomUUID().slice(0, 8)}`;
  const connectionId = `pkg09-connection-${randomUUID().slice(0, 8)}`;
  const installId = `pkg09-install-${randomUUID().slice(0, 8)}`;
  const packageKey = `${PACKAGE_KEY_PREFIX}-${randomUUID().slice(0, 8)}`;
  const declared = addedToolsOf(manifest).filter(
    (tool) => tool.ref === TOOL_LOOKUP,
  );
  const [tool] = declared;
  if (!tool) throw new Error("PKG09_MANIFEST_TOOL_MISSING");

  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${workspaceId}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_plugin_installs
            (tenant_id, id, catalog_id, workspace_id, installed_by, config, envelope, status)
          values (${companyA}, ${connectorInstallId}, ${catalogId}, ${workspaceId},
                  ${principalId},
                  '{"url":"https://managed.example.test/mcp"}'::jsonb,
                  ${`pkg09-envelope:${SECRET_CANARY}`}, 'active')`,
    );
    await tx.execute(
      sql`insert into enterprise_plugin_connections
            (tenant_id, id, install_id, bound_by, vendor_ref, generation)
          values (${companyA}, ${connectionId}, ${connectorInstallId}, ${principalId}, 'acct-owner', 1)`,
    );
    await tx.execute(
      sql`insert into enterprise_package_installs
            (tenant_id, id, workspace_id, package_key, current_version, status, installed_by)
          values (${companyA}, ${installId}, ${workspaceId}, ${packageKey}, ${PACKAGE_VERSION}, 'enabled', ${principalId})`,
    );
    await tx.execute(
      sql`insert into enterprise_package_revisions
            (tenant_id, install_id, revision, release_version, artifact_digest, config, created_by)
          values (${companyA}, ${installId}, 1, ${PACKAGE_VERSION}, ${digest}, '{}'::jsonb, ${principalId})`,
    );
    await tx.execute(
      sql`insert into enterprise_package_resource_links
            (tenant_id, install_id, revision, resource_id, workspace_id, kind, connector_install_id)
          values (${companyA}, ${installId}, 1, ${SKILL_A}, ${workspaceId}, 'skill', null)`,
    );
    await tx.execute(
      sql`insert into enterprise_package_resource_links
            (tenant_id, install_id, revision, resource_id, workspace_id, kind, connector_install_id)
          values (${companyA}, ${installId}, 1, ${CONNECTOR_RESOURCE}, ${workspaceId}, 'managedConnector',
                  ${connectorInstallId})`,
    );
    await tx.execute(
      sql`insert into enterprise_bot_ownership
            (tenant_id, agent_id, workspace_id, owner_principal_id, display_name, default_config)
          values (${companyA}, ${botId}, ${workspaceId}, ${principalId}, 'PKG09 bot', '{}'::jsonb)`,
    );
    await tx.execute(
      sql`insert into enterprise_package_grants
            (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
             resource_kind, tool_ref, schema_digest, effect, connector_install_id, granted_by)
          values (${companyA}, ${installId}, 1, ${botId}, ${CONNECTOR_RESOURCE}, ${workspaceId},
                  'connectorTool', ${tool.ref}, ${tool.schemaDigest}, ${tool.effect},
                  ${connectorInstallId}, ${principalId})`,
    );
  });

  const runId = await seedRun({
    botId,
    principalId,
    workspaceId,
    ...(input?.runStatus ? { status: input.runStatus } : {}),
  });
  const scope =
    workspaceId === teamA1
      ? await fixture.scopeFor(OWNER, "team-a1")
      : await fixture.scopeFor(OWNER, "team-a2");
  await fixture.base.data.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
    );
    await runtime.prepareWithin(tx, scope, {
      botId,
      runId,
      attemptGeneration: 1,
    });
  });
  return {
    botId,
    runId,
    installId,
    connectorInstallId,
    connectionId,
  };
}

async function seedRun(input: {
  botId: string;
  principalId: string;
  workspaceId: string;
  status?: "running" | "waiting_approval";
}): Promise<string> {
  const runId = randomUUID();
  const expertVersionRef = `pkg09-expert-${randomUUID()}`;
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
     values ($1, $2, $3, $4, $5, $6, $7, 'pkg09-route', 1000, $8, 1, now() + interval '1 hour')`,
    [
      runId,
      companyA,
      input.workspaceId,
      input.principalId,
      `pkg09-thread-${randomUUID()}`,
      `pkg09-msg-${randomUUID()}`,
      expertVersionRef,
      input.status ?? "running",
    ],
  );
  return runId;
}

function toolRefFor(installId: string): string {
  return `pkg:${installId}:${CONNECTOR_RESOURCE}/lookup`;
}

describeDb("PKG09 package entrypoints (real roles)", () => {
  beforeAll(async () => {
    await applyPackageTasks();
    fixture = await createPackageInstallFixture();
    setup = fixture.setup;
    companyA = fixture.tenantOf("company-a");
    teamA1 = fixture.teamOf("company-a", "team-a1");
    teamA2 = fixture.teamOf("company-a", "team-a2");
    ownerPrincipal = fixture.principalOf(OWNER, "company-a");
    otherPrincipal = fixture.principalOf(OTHER, "company-a");
    const ownerFact = fixture.base.isolation.identities[OWNER];
    if (ownerFact.kind !== "human" || !ownerFact.userId) {
      throw new Error("PKG09_OWNER_NOT_HUMAN");
    }
    ownerUserId = ownerFact.userId;
    artifactRoot = await mkdtemp(join(tmpdir(), "pkg09-artifacts-"));
    digest = await storePackage();
    catalogue = probeCatalogue();
    runtime = createPackageRuntime({
      data: fixture.base.data,
      artifactRoot,
    });
    entrypoints = createPackageEntrypoints({
      directory: fixture.base.directory,
      data: fixture.base.data,
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
  });

  afterAll(async () => {
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
    if (fixture) await fixture.dispose();
  });

  itDb(
    "restores the trusted run scope from the persistent row, and the resumed dispatch goes through once",
    async () => {
      const current = await prepareCase();
      const restored = await entrypoints.restoreRunContext({
        ownerUserId,
        runId: current.runId,
        botId: current.botId,
      });
      expect(restored.outcome).toBe("context");
      if (restored.outcome !== "context") return;
      // Every authority-bearing field is the RUN ROW's, re-verified now.
      expect(restored.run.scope.tenantId).toBe(companyA);
      expect(restored.run.scope.workspaceId).toBe(teamA1);
      expect(restored.run.scope.principalId).toBe(ownerPrincipal);
      expect(restored.run.attemptGeneration).toBe(1);
      expect(restored.run.botId).toBe(current.botId);

      // The restored scope is a resolver-signed object: the dispatch chain's
      // assertTrustedScope accepts it and the real RLS arms serve it.
      vendorCalls = [];
      const ticket = await dispatch.preparePackageTool(restored.run.scope, {
        runId: restored.run.runId,
        attemptGeneration: restored.run.attemptGeneration,
        toolCallId: `call-${randomUUID()}`,
        ref: toolRefFor(current.installId),
        args: { query: "notes" },
        botId: current.botId,
      });
      expect(ticket.outcome).toBe("ticket");
      if (ticket.outcome !== "ticket") return;
      const result = await dispatch.dispatchPackageTool(
        restored.run.scope,
        ticket.ticket,
        { query: "notes" },
      );
      expect(result.outcome).toBe("ok");
      expect(vendorCalls).toHaveLength(1);
      expect(vendorCalls[0]?.url).toBe(CONNECTOR_URL);
      expect(vendorCalls[0]?.token).toBe(SECRET_CANARY);
    },
  );

  itDb(
    "the run's own team wins over another team the owner belongs to — no client field selects the scope",
    async () => {
      // The owner is a member of BOTH team-a1 and team-a2; the run belongs to
      // team-a1. The restore must answer team-a1 — the team is read from the
      // run row, never chosen by the caller (and a proposal's target scope
      // cannot be supplied here at all: the input has no scope field).
      const current = await prepareCase();
      const restored = await entrypoints.restoreRunContext({
        ownerUserId,
        runId: current.runId,
        botId: current.botId,
      });
      expect(restored.outcome).toBe("context");
      if (restored.outcome !== "context") return;
      expect(restored.run.scope.workspaceId).toBe(teamA1);
      // The same person signing in to team-a2 gets a DIFFERENT scope — the two
      // are not interchangeable, so a stale proposal from team-a1 cannot ride
      // a team-a2 session.
      const other = await fixture.scopeFor(OWNER, "team-a2");
      expect(other.workspaceId).toBe(teamA2);
      expect(other.workspaceId).not.toBe(restored.run.scope.workspaceId);
    },
  );

  itDb(
    "no reachable managed run answers one canonical refusal (nonexistent, other person, other company)",
    async () => {
      // A run in the same company, owned by somebody else, plus a run that does
      // not exist — the same answer, so the refusal leaks no existence.
      const otherRun = await prepareCase({
        principalId: otherPrincipal,
        workspaceId: teamA1,
      });
      const nonexistent = randomUUID();
      for (const runId of [nonexistent, otherRun.runId]) {
        const restored = await entrypoints.restoreRunContext({
          ownerUserId,
          runId,
          botId: otherRun.botId,
        });
        expect(restored).toEqual({
          outcome: "refused",
          code: "PACKAGE_RUN_REQUIRED",
        });
      }
    },
  );

  itDb(
    "a proposal naming another Bot is refused as a bot mismatch",
    async () => {
      const current = await prepareCase();
      const restored = await entrypoints.restoreRunContext({
        ownerUserId,
        runId: current.runId,
        botId: `pkg09-other-bot-${randomUUID().slice(0, 8)}`,
      });
      expect(restored).toEqual({
        outcome: "refused",
        code: "PACKAGE_RUN_BOT_MISMATCH",
      });
    },
  );

  itDb(
    "a membership revoked while the approval waited refuses the restore (scope lost)",
    async () => {
      const current = await prepareCase();
      await fixture.setCompanyMembershipStatus(OWNER, "company-a", "suspended");
      try {
        const restored = await entrypoints.restoreRunContext({
          ownerUserId,
          runId: current.runId,
          botId: current.botId,
        });
        expect(restored).toEqual({
          outcome: "refused",
          code: "PACKAGE_RUN_SCOPE_LOST",
        });
      } finally {
        await fixture.setCompanyMembershipStatus(OWNER, "company-a", "active");
      }
      // With the membership back, the same proposal restores again — the
      // refusal was the membership's, not a poisoned cache.
      const again = await entrypoints.restoreRunContext({
        ownerUserId,
        runId: current.runId,
        botId: current.botId,
      });
      expect(again.outcome).toBe("context");
    },
  );

  itDb(
    "a grant revoked during the wait refuses the resumed dispatch, transport 0",
    async () => {
      const current = await prepareCase();
      const restored = await entrypoints.restoreRunContext({
        ownerUserId,
        runId: current.runId,
        botId: current.botId,
      });
      expect(restored.outcome).toBe("context");
      if (restored.outcome !== "context") return;
      const prepared = await dispatch.preparePackageTool(restored.run.scope, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        ref: toolRefFor(current.installId),
        args: { query: "notes" },
        botId: current.botId,
      });
      expect(prepared.outcome).toBe("ticket");
      if (prepared.outcome !== "ticket") return;
      // The proposal waited; the company admin revokes the tool grant.
      await fixture.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
        );
        await tx.execute(
          sql`update enterprise_package_grants
                set revoked_at = now()
              where tenant_id = ${companyA} and install_id = ${current.installId}`,
        );
      });
      vendorCalls = [];
      const result = await dispatch.dispatchPackageTool(
        restored.run.scope,
        prepared.ticket,
        { query: "notes" },
      );
      expect(result).toEqual({ outcome: "refused", code: "NOT_AVAILABLE" });
      expect(vendorCalls).toHaveLength(0);
    },
  );

  itDb(
    "changed arguments / a re-bound connection / a moved generation all refuse the old proposal",
    async () => {
      const current = await prepareCase();
      const restored = await entrypoints.restoreRunContext({
        ownerUserId,
        runId: current.runId,
        botId: current.botId,
      });
      expect(restored.outcome).toBe("context");
      if (restored.outcome !== "context") return;

      // —— A07 改参 ——
      const forArgs = await dispatch.preparePackageTool(restored.run.scope, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        ref: toolRefFor(current.installId),
        args: { query: "notes" },
        botId: current.botId,
      });
      expect(forArgs.outcome).toBe("ticket");
      if (forArgs.outcome !== "ticket") return;
      vendorCalls = [];
      expect(
        await dispatch.dispatchPackageTool(restored.run.scope, forArgs.ticket, {
          query: "different",
        }),
      ).toEqual({ outcome: "refused", code: "ARGS_CHANGED" });
      expect(vendorCalls).toHaveLength(0);

      // —— A07 连接换代次 ——
      const forGeneration = await dispatch.preparePackageTool(
        restored.run.scope,
        {
          runId: current.runId,
          attemptGeneration: 1,
          toolCallId: `call-${randomUUID()}`,
          ref: toolRefFor(current.installId),
          args: { query: "notes" },
          botId: current.botId,
        },
      );
      expect(forGeneration.outcome).toBe("ticket");
      if (forGeneration.outcome !== "ticket") return;
      // Disclosed superuser arrangement (the MT031 write channel has no
      // generation writer yet — the same arrangement PKG05's suite documents):
      // the connection moves generation while the proposal waits.
      await setup.$client.unsafe(
        "update enterprise_plugin_connections set generation = 2 where tenant_id = $1 and id = $2",
        [companyA, current.connectionId],
      );
      vendorCalls = [];
      expect(
        await dispatch.dispatchPackageTool(
          restored.run.scope,
          forGeneration.ticket,
          { query: "notes" },
        ),
      ).toEqual({ outcome: "refused", code: "CONNECTION_CHANGED" });
      expect(vendorCalls).toHaveLength(0);

      // —— A07 换账号：连接被重绑到别人。mcp 类连接不要求本人账号
      // （accountBearing=false），因此恢复后解析到「无本人连接」，与提案
      // 票面的 connectionId 不同 → CONNECTION_CHANGED；账号型连接
      // （composio/open-connector）会答 CONNECTION_UNAVAILABLE（PKG05 面）。 ——
      const forAccount = await dispatch.preparePackageTool(restored.run.scope, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        ref: toolRefFor(current.installId),
        args: { query: "notes" },
        botId: current.botId,
      });
      expect(forAccount.outcome).toBe("ticket");
      if (forAccount.outcome !== "ticket") return;
      await setup.$client.unsafe(
        "update enterprise_plugin_connections set bound_by = $1 where tenant_id = $2 and id = $3",
        [otherPrincipal, companyA, current.connectionId],
      );
      vendorCalls = [];
      expect(
        await dispatch.dispatchPackageTool(
          restored.run.scope,
          forAccount.ticket,
          { query: "notes" },
        ),
      ).toEqual({ outcome: "refused", code: "CONNECTION_CHANGED" });
      expect(vendorCalls).toHaveLength(0);
    },
  );

  itDb(
    "cancel then retry keeps the operation identity: the same toolCallId cannot dispatch twice",
    async () => {
      const current = await prepareCase();
      const restored = await entrypoints.restoreRunContext({
        ownerUserId,
        runId: current.runId,
        botId: current.botId,
      });
      expect(restored.outcome).toBe("context");
      if (restored.outcome !== "context") return;
      const toolCallId = `call-${randomUUID()}`;
      const prepared = await dispatch.preparePackageTool(restored.run.scope, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId,
        ref: toolRefFor(current.installId),
        args: { query: "notes" },
        botId: current.botId,
      });
      expect(prepared.outcome).toBe("ticket");
      if (prepared.outcome !== "ticket") return;
      // The person declines (or policy refuses): prepared → cancelled.
      await dispatch.cancelDispatch(restored.run.scope, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId,
      });
      // A retry of the SAME identity prepares again (idempotent insert, row
      // stays cancelled) and the CAS cannot resurrect it.
      const retried = await dispatch.preparePackageTool(restored.run.scope, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId,
        ref: toolRefFor(current.installId),
        args: { query: "notes" },
        botId: current.botId,
      });
      expect(retried.outcome).toBe("ticket");
      if (retried.outcome !== "ticket") return;
      vendorCalls = [];
      expect(
        await dispatch.dispatchPackageTool(restored.run.scope, retried.ticket, {
          query: "notes",
        }),
      ).toEqual({ outcome: "refused", code: "DUPLICATE_DISPATCH" });
      expect(vendorCalls).toHaveLength(0);
    },
  );

  itDb(
    "a proposal bound to an attempt the run has left behind refuses (L2 attempt binding)",
    async () => {
      const current = await prepareCase();
      // The run is cancelled/retried while the approval waits: the run row's
      // attempt generation moves on, and the pins (and operation identity)
      // that belonged to the old attempt are no longer this run's.
      await setup.$client.unsafe(
        `update enterprise_runs set attempt_generation = 2 where id = $1 and tenant_id = $2`,
        [current.runId, companyA],
      );
      // The proposal names the attempt it was prepared against → the restore
      // refuses instead of executing the old approval against the new pins.
      const stale = await entrypoints.restoreRunContext({
        ownerUserId,
        runId: current.runId,
        botId: current.botId,
        expectedAttemptGeneration: 1,
      });
      expect(stale).toEqual({
        outcome: "refused",
        code: "PACKAGE_RUN_ATTEMPT_STALE",
      });
      // Without a bound attempt (a proposal written before the binding) the
      // restore answers the run's CURRENT attempt — the adjudicated fallback;
      // the dispatch CAS still refuses it at the lease/pin gates below.
      const currentAttempt = await entrypoints.restoreRunContext({
        ownerUserId,
        runId: current.runId,
        botId: current.botId,
      });
      expect(currentAttempt.outcome).toBe("context");
      if (currentAttempt.outcome !== "context") return;
      expect(currentAttempt.run.attemptGeneration).toBe(2);
      vendorCalls = [];
      const refusedAtDispatch = await dispatch.preparePackageTool(
        currentAttempt.run.scope,
        {
          runId: current.runId,
          attemptGeneration: currentAttempt.run.attemptGeneration,
          toolCallId: `call-${randomUUID()}`,
          ref: toolRefFor(current.installId),
          args: { query: "notes" },
          botId: current.botId,
        },
      );
      // The moved attempt has no admitted binding (its pins belong to the
      // old attempt) → the run/attempt lease gate refuses, transport 0.
      expect(refusedAtDispatch).toEqual({
        outcome: "refused",
        code: "RUN_LEASE_INVALID",
      });
      expect(vendorCalls).toHaveLength(0);
    },
  );

  itDb(
    "the governed continuation's own binding offers the pinned tool and the resume revalidates it (transport 1; moved attempt and revoked grant → 0)",
    async () => {
      const current = await prepareCase();
      const scope = await fixture.scopeFor(OWNER, "team-a1");
      // What the continuation record holds: the run and the attempt the call
      // was parked under. The assembly turns it into the server-issued
      // context through the ONE helper both resume gates use.
      const packageRun = packageRunForBinding({
        scope,
        binding: { runId: current.runId, attemptGeneration: 1 },
      });
      expect(packageRun).toEqual({
        runId: current.runId,
        attemptGeneration: 1,
        scope,
      });

      // THE OFFER SIDE: the grant the parked call rode on is still there, at
      // exactly this run/attempt — this is the name `toolGrantCurrent` looks
      // for, and the offer the resumed loop mounts.
      const pinned = await dispatch.listPinnedTools(packageRun.scope, {
        botId: current.botId,
        runId: packageRun.runId,
        attemptGeneration: packageRun.attemptGeneration,
      });
      expect(pinned.map((fact) => fact.toolRef)).toContain(TOOL_LOOKUP);

      // THE RESUME: prepare then dispatch under the same context; the whole
      // CAS chain revalidates and the vendor is reached exactly once.
      vendorCalls = [];
      const prepared = await dispatch.preparePackageTool(packageRun.scope, {
        runId: packageRun.runId,
        attemptGeneration: packageRun.attemptGeneration,
        toolCallId: `call-${randomUUID()}`,
        ref: toolRefFor(current.installId),
        args: { query: "notes" },
        botId: current.botId,
      });
      expect(prepared.outcome).toBe("ticket");
      if (prepared.outcome !== "ticket") return;
      expect(
        await dispatch.dispatchPackageTool(packageRun.scope, prepared.ticket, {
          query: "notes",
        }),
      ).toMatchObject({ outcome: "ok" });
      expect(vendorCalls).toHaveLength(1);

      // A context built from a MOVED attempt reaches no pins: the same
      // binding shape with the wrong generation refuses, transport 0.
      const moved = await dispatch.preparePackageTool(packageRun.scope, {
        runId: packageRun.runId,
        attemptGeneration: 2,
        toolCallId: `call-${randomUUID()}`,
        ref: toolRefFor(current.installId),
        args: { query: "notes" },
        botId: current.botId,
      });
      expect(moved).toEqual({ outcome: "refused", code: "RUN_LEASE_INVALID" });
      expect(vendorCalls).toHaveLength(1);

      // Revoked while the approval waited: the pin leaves the offer, so the
      // grant gate refuses the resume, and a fresh prepare refuses too.
      await fixture.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
        );
        await tx.execute(
          sql`update enterprise_package_grants
                set revoked_at = now()
              where tenant_id = ${companyA} and install_id = ${current.installId}`,
        );
      });
      const revokedPins = await dispatch.listPinnedTools(packageRun.scope, {
        botId: current.botId,
        runId: packageRun.runId,
        attemptGeneration: packageRun.attemptGeneration,
      });
      expect(revokedPins).toEqual([]);
      const revoked = await dispatch.preparePackageTool(packageRun.scope, {
        runId: packageRun.runId,
        attemptGeneration: packageRun.attemptGeneration,
        toolCallId: `call-${randomUUID()}`,
        ref: toolRefFor(current.installId),
        args: { query: "notes" },
        botId: current.botId,
      });
      expect(revoked).toEqual({ outcome: "refused", code: "NOT_AVAILABLE" });
      expect(vendorCalls).toHaveLength(1);
    },
  );

  itDb(
    "a run already waiting for approval still restores (the resume's own state)",
    async () => {
      const current = await prepareCase({ runStatus: "waiting_approval" });
      const restored = await entrypoints.restoreRunContext({
        ownerUserId,
        runId: current.runId,
        botId: current.botId,
      });
      expect(restored.outcome).toBe("context");
      if (restored.outcome !== "context") return;
      // Dispatch accepts a waiting_approval run at its lease gate; the actual
      // resume revalidates everything at the CAS (proven above).
      const prepared = await dispatch.preparePackageTool(restored.run.scope, {
        runId: current.runId,
        attemptGeneration: 1,
        toolCallId: `call-${randomUUID()}`,
        ref: toolRefFor(current.installId),
        args: { query: "notes" },
        botId: current.botId,
      });
      expect(prepared.outcome).toBe("ticket");
    },
  );
});
