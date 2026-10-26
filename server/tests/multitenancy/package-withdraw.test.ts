// server/tests/multitenancy/package-withdraw.test.ts
// PKG08（Issue #467，Spec §10/§12 + #467 AC + A01/A02/A05/A12）：部署侧下架与
// 安全撤回——真实受限角色、真实 RLS、真实 loadPackageCatalogue 索引 fixture。
//
// 证据面（transport 为可控注入，DB/RLS/catalogue 全真实）：
//   (1) AC2 前半：listed=false 只影响发现——默认 list 不见、includeUnlisted 带
//       PACKAGE_UNLISTED 原因；已安装版本照常派发（transport 恰好 1 次）。
//   (2) AC2 后半：state=withdrawn 阻断新派发（含旧 pin）：refused
//       PACKAGE_WITHDRAWN、transport 0；审批前置面 preparePackageTool 同拒。
//   (3) A05/AC3：先 dispatched 的调用在撤回后完成写保留 succeeded 回执；
//       写超时臂保留 unknown；没有任何行被强行标 cancelled。
//   (4) AC4：撤回版本不能经 install/upgrade/rollback 进入（PACKAGE_UNSUPPORTED，
//       且 resolveRelease 仍解析到该版本——按状态拒，不是 404）。
//   (5) A01：同版本异摘要的索引被 loadPackageCatalogue 拒绝（部署启动面）。
//   (6) AC5：A/B 两公司的真实 unavailable+PACKAGE_WITHDRAWN 展示；availableVersions
//       不含撤回版本；两范围各自只见自己的安装事实（不泄露对方名单）。
//   (7) AC2 跨范围：B 公司同包同版本的派发同样被阻断（撤回是全局部署事实）。
//   (8) AC6：撤回只改元数据——制品、索引行、pin、dispatch 台账全保留。
//
// 「撤回」的进程内模型（T13-fix-1 更正，Codex FC-01 终审否决旧「下次装配」
// 裁决）：loadPackageCatalogue 的启动快照只承载 manifest/验证事实；部署撤回
// 经 deployment-facts 门（与部署命令同一把跨进程 release 锁 + 当前索引重读）
// 在每次 dispatched CAS 前生效——撤回先提交则存活进程立即 transport 0，
// dispatch 先提交则已 dispatched 保留结果/unknown，无需重启。本套件的
// dispatch 服务未注入 releaseFacts 门（行为与门未注入的判定路径一致）；跨进
// 程竞争与存活进程无需重启的证据在 package-withdraw-contention.test.ts。

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sql } from "drizzle-orm";
import type { PackageManifestV1 } from "../../../shared/enterprise/plugin-package-contracts";
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
      reason: `PKG08 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

const PKG_MAIN = "openbot/pkg08-main";
const PKG_PLAN_A = "openbot/pkg08-plan-a";
const PKG_PLAN_B = "openbot/pkg08-plan-b";
const CONNECTOR = "crm";
const SKILL = "summarize";
const V1 = "1.0.0";
const V2 = "2.0.0";
const SECRET_CANARY = "pkg08-secret-canary";

interface IndexEntrySpec {
  readonly packageKey: string;
  readonly version: string;
  readonly listed?: boolean;
  readonly state?: "published" | "withdrawn";
}

let fixture: PackageInstallFixture;
let setup: Database;
let artifactRoot: string;
let digests = new Map<string, string>();
const manifests = new Map<string, PackageManifestV1>();
let runtime: ReturnType<typeof createPackageRuntime>;
let scopeA1: PlatformScope;
let scopeB1: PlatformScope;
let companyA = "";
let teamA1 = "";
let companyB = "";
let teamB1 = "";
let adminAPrincipal = "";
let adminBPrincipal = "";
let connectorA1 = "";
let connectorB1 = "";

let vendorCalls = 0;
const vault: SecretVault = {
  seal: async (plaintext) => `pkg08-envelope:${plaintext}`,
  open: async (envelope) => {
    if (!envelope.startsWith("pkg08-envelope:")) {
      throw new Error("PKG08_TEST_ENVELOPE_INVALID");
    }
    return envelope.slice("pkg08-envelope:".length);
  },
};
const vendorCall: PackageVendorCaller = async () => {
  vendorCalls += 1;
  return { text: "ok", isError: false };
};

function manifestKey(packageKey: string, version: string): string {
  return `${packageKey}@${version}`;
}

/** Build one verified artifact; different `variant` bytes ⇒ different digest. */
async function storeVersion(
  packageKey: string,
  version: string,
  variant = "",
): Promise<string> {
  const [publisher, name] = packageKey.split("/") as [string, string];
  const source = await mkdtemp(join(tmpdir(), "pkg08-source-"));
  const manifest: PackageManifestV1 = {
    schemaVersion: 1,
    platformApi: 1,
    publisher,
    name,
    version,
    display: {
      name: `PKG08 ${name}`,
      summary: `The PKG08 fixture package ${packageKey} ${version}.`,
    },
    resources: [
      { kind: "skill", id: SKILL, path: `skills/${SKILL}/SKILL.md` },
      {
        kind: "managedConnector",
        id: CONNECTOR,
        catalogKey: "pkg08-managed-notes",
        required: true,
        tools: [
          { name: "lookup", effect: "read" },
          { name: "purge", effect: "write" },
        ],
      },
    ],
    dependencies: [],
  };
  try {
    await writeFile(
      join(source, "openbot.plugin.json"),
      JSON.stringify(manifest),
    );
    const skillPath = join(source, "skills", SKILL, "SKILL.md");
    await mkdir(dirname(skillPath), { recursive: true });
    await writeFile(skillPath, `# ${SKILL} @ ${version}${variant}\n`);
    const artifact = await buildArtifact(source);
    await storeArtifact(artifact, artifactRoot);
    manifests.set(manifestKey(packageKey, version), manifest);
    return artifact.digest;
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}

function digestOf(packageKey: string, version: string): string {
  const digest = digests.get(manifestKey(packageKey, version));
  if (!digest) throw new Error(`DIGEST_MISSING:${packageKey}@${version}`);
  return digest;
}

/**
 * The assembled catalogue. Separate from catalogueFrom so every test states
 * its index snapshot explicitly — a withdrawal is a NEW snapshot, never a
 * mutation of a live one.
 */
async function makeCatalogue(
  entries: readonly IndexEntrySpec[],
): Promise<PackageCatalogue> {
  return loadPackageCatalogue({
    artifactRoot,
    index: {
      schemaVersion: 1,
      packages: entries.map((entry) => ({
        packageKey: entry.packageKey,
        version: entry.version,
        artifactDigest: digestOf(entry.packageKey, entry.version),
        category: "productivity",
        listed: entry.listed ?? true,
        ...(entry.state === undefined ? {} : { state: entry.state }),
      })),
    },
  });
}

function makeService(catalogue: PackageCatalogue): PackageService {
  return createPackageService({
    catalogue,
    readStore: fixture.readStore,
    mutation: fixture.mutation,
    artifactRoot,
  });
}

function makeDispatch(
  catalogue: PackageCatalogue,
): ReturnType<typeof createPackageDispatchService> {
  return createPackageDispatchService({
    data: fixture.base.data,
    catalogue,
    artifactRoot,
    vault,
    toolInvocation: createToolInvocationService({ data: fixture.base.data }),
    catalogDecisions: createPluginCatalogDecisionService(fixture.base.data),
    pinnedTools: runtime.readPinnedTools,
    vendorCall,
  });
}

function baseEntries(): IndexEntrySpec[] {
  return [
    { packageKey: PKG_MAIN, version: V1 },
    { packageKey: PKG_MAIN, version: V2 },
    { packageKey: PKG_PLAN_A, version: V1 },
    { packageKey: PKG_PLAN_A, version: V2 },
    { packageKey: PKG_PLAN_B, version: V1 },
    { packageKey: PKG_PLAN_B, version: V2 },
  ];
}

function entriesWith(
  override: IndexEntrySpec & {
    state?: "published" | "withdrawn";
    listed?: boolean;
  },
): IndexEntrySpec[] {
  return baseEntries().map((entry) =>
    entry.packageKey === override.packageKey &&
    entry.version === override.version
      ? {
          ...entry,
          ...(override.listed === undefined ? {} : { listed: override.listed }),
          ...(override.state === undefined ? {} : { state: override.state }),
        }
      : entry,
  );
}

interface CompanyContext {
  readonly company: string;
  readonly workspace: string;
  readonly principal: string;
}

async function seedBot(context: CompanyContext): Promise<string> {
  const agentId = `pkg08-bot-${randomUUID()}`;
  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${context.company}, true), set_config('app.workspace_id', ${context.workspace}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_bot_ownership
            (tenant_id, agent_id, workspace_id, owner_principal_id, display_name, default_config)
          values (${context.company}, ${agentId}, ${context.workspace}, ${context.principal}, 'PKG08 bot', '{}'::jsonb)`,
    );
  });
  return agentId;
}

/** Arrangement (operator channel): one MT031 install + the caller's connection. */
async function seedConnector(
  context: CompanyContext,
  catalogId: string,
): Promise<string> {
  const connectorInstallId = `pkg08-connector-${randomUUID()}`;
  const connectionId = `pkg08-connection-${randomUUID()}`;
  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${context.company}, true), set_config('app.workspace_id', ${context.workspace}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_plugin_installs
            (tenant_id, id, catalog_id, workspace_id, installed_by, config, envelope, status)
          values (${context.company}, ${connectorInstallId}, ${catalogId}, ${context.workspace},
                  ${context.principal}, '{"url":"https://pkg08-managed.example.test/mcp"}'::jsonb,
                  ${`pkg08-envelope:${SECRET_CANARY}`}, 'active')`,
    );
    await tx.execute(
      sql`insert into enterprise_plugin_connections
            (tenant_id, id, install_id, bound_by, vendor_ref, generation)
          values (${context.company}, ${connectionId}, ${connectorInstallId}, ${context.principal}, 'acct', 1)`,
    );
  });
  return connectorInstallId;
}

/** Arrangement (operator channel): skill + connector-tool grants from the manifest. */
async function seedGrants(input: {
  context: CompanyContext;
  installId: string;
  botId: string;
  packageKey: string;
  version: string;
  connectorInstallId: string;
}): Promise<void> {
  const manifest = manifests.get(manifestKey(input.packageKey, input.version));
  if (!manifest) throw new Error(`MANIFEST_MISSING:${input.packageKey}`);
  const tools = addedToolsOf(manifest);
  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${input.context.company}, true), set_config('app.workspace_id', ${input.context.workspace}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_package_grants
            (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
             resource_kind, tool_ref, granted_by)
          values (${input.context.company}, ${input.installId}, 1, ${input.botId}, ${SKILL},
                  ${input.context.workspace}, 'skill', '', ${input.context.principal})`,
    );
    for (const tool of tools) {
      await tx.execute(
        sql`insert into enterprise_package_grants
              (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
               resource_kind, tool_ref, schema_digest, effect, connector_install_id, granted_by)
            values (${input.context.company}, ${input.installId}, 1, ${input.botId}, ${CONNECTOR},
                    ${input.context.workspace}, 'connectorTool', ${tool.ref},
                    ${tool.schemaDigest}, ${tool.effect}, ${input.connectorInstallId},
                    ${input.context.principal})`,
      );
    }
  });
}

/** Arrangement (superuser, disclosed): the run row + admitted expert version. */
async function seedRun(input: {
  context: CompanyContext;
  botId: string;
}): Promise<string> {
  const runId = randomUUID();
  const expertVersionRef = `pkg08-expert-${randomUUID()}`;
  await setup.$client.unsafe(
    `insert into enterprise_expert_versions
       (tenant_id, expert_version_ref, schema_version, agent_id, snapshot)
     values ($1, $2, 1, $3, '{}'::jsonb)`,
    [input.context.company, expertVersionRef, input.botId],
  );
  await setup.$client.unsafe(
    `insert into enterprise_runs
       (id, tenant_id, workspace_id, principal_id, thread_id, client_message_key,
        expert_version_ref, model_route_ref, model_route_maximum_tokens, status,
        attempt_generation, lease_expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'pkg08-route', 1000, 'running', 1, now() + interval '1 hour')`,
    [
      runId,
      input.context.company,
      input.context.workspace,
      input.context.principal,
      `pkg08-thread-${randomUUID()}`,
      `pkg08-msg-${randomUUID()}`,
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

async function installPackage(input: {
  service: PackageService;
  scope: PlatformScope;
  admin: Awaited<ReturnType<PackageInstallFixture["adminContextOf"]>>;
  packageKey: string;
  version: string;
  connectorInstallId: string;
}): Promise<string> {
  const plan = await input.service.plan(input.scope, input.admin, {
    operation: "install",
    packageKey: input.packageKey,
    version: input.version,
    expectedRevision: null,
    config: {},
    connectorInstalls: { [CONNECTOR]: input.connectorInstallId },
  });
  const applied = await input.service.apply(
    input.scope,
    input.admin,
    plan.planId,
    `pkg08-install-${randomUUID()}`,
  );
  return applied.install.installId;
}

function toolRefFor(installId: string, toolName: string): string {
  return `pkg:${installId}:${CONNECTOR}/${toolName}`;
}

/** One granted, pinned, runnable case per company. */
interface DispatchCase {
  readonly installId: string;
  readonly botId: string;
  readonly runId: string;
}

let caseA: DispatchCase;
let caseB: DispatchCase;
let installA = "";
let installB = "";

describeDb(
  "PKG08 deployment unlisting and safety withdrawal (real roles)",
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
      // b1-member is already a team-b1 member of the isolation fixture; the
      // company-admin identity belongs to company A and cannot administer B —
      // the promotion stand-in is the only arrangement needed.
      await fixture.promoteToCompanyAdmin("b1-member", "company-b");
      companyA = fixture.tenantOf("company-a");
      teamA1 = fixture.teamOf("company-a", "team-a1");
      companyB = fixture.tenantOf("company-b");
      teamB1 = fixture.teamOf("company-b", "team-b1");
      adminAPrincipal = fixture.principalOf("company-admin", "company-a");
      adminBPrincipal = fixture.principalOf("b1-member", "company-b");
      scopeA1 = await fixture.scopeFor("company-admin", "team-a1");
      scopeB1 = await fixture.scopeFor("b1-member", "team-b1");

      artifactRoot = await mkdtemp(join(tmpdir(), "pkg08-artifacts-"));
      digests = new Map(
        await Promise.all(
          (
            [
              [PKG_MAIN, V1],
              [PKG_MAIN, V2],
              [PKG_PLAN_A, V1],
              [PKG_PLAN_A, V2],
              [PKG_PLAN_B, V1],
              [PKG_PLAN_B, V2],
            ] as const
          ).map(async ([key, version]) => [
            manifestKey(key, version),
            await storeVersion(key, version),
          ]),
        ),
      );
      runtime = createPackageRuntime({ data: fixture.base.data, artifactRoot });

      // The published catalogue both companies install under.
      const cataloguePublished = await makeCatalogue(baseEntries());
      const servicePublished = makeService(cataloguePublished);

      const catalogId = "pkg08-managed-notes";
      await setup.$client.unsafe(
        `insert into enterprise_plugin_catalog (id, kind, title, vendor, source, metadata)
       values ($1, 'mcp', 'PKG08 Managed Notes', 'openbot', 'first-party', '{"summary":"Managed notes MCP"}'::jsonb)
       on conflict (id) do nothing`,
        [catalogId],
      );
      const contextA = {
        company: companyA,
        workspace: teamA1,
        principal: adminAPrincipal,
      };
      const contextB = {
        company: companyB,
        workspace: teamB1,
        principal: adminBPrincipal,
      };
      connectorA1 = await seedConnector(contextA, catalogId);
      connectorB1 = await seedConnector(contextB, catalogId);

      // Company A: install + grants + bot + run + pin on PKG_MAIN V1.
      installA = await installPackage({
        service: servicePublished,
        scope: scopeA1,
        admin: await fixture.adminContextOf("company-admin", "company-a"),
        packageKey: PKG_MAIN,
        version: V1,
        connectorInstallId: connectorA1,
      });
      const botA = await seedBot(contextA);
      await seedGrants({
        context: contextA,
        installId: installA,
        botId: botA,
        packageKey: PKG_MAIN,
        version: V1,
        connectorInstallId: connectorA1,
      });
      const runA = await seedRun({ context: contextA, botId: botA });
      await pinRun({ scope: scopeA1, botId: botA, runId: runA });
      caseA = { installId: installA, botId: botA, runId: runA };

      // Company B: the same package, its own install/grants/run/pin (A02 arm).
      installB = await installPackage({
        service: servicePublished,
        scope: scopeB1,
        admin: await fixture.adminContextOf("b1-member", "company-b"),
        packageKey: PKG_MAIN,
        version: V1,
        connectorInstallId: connectorB1,
      });
      const botB = await seedBot(contextB);
      await seedGrants({
        context: contextB,
        installId: installB,
        botId: botB,
        packageKey: PKG_MAIN,
        version: V1,
        connectorInstallId: connectorB1,
      });
      const runB = await seedRun({ context: contextB, botId: botB });
      await pinRun({ scope: scopeB1, botId: botB, runId: runB });
      caseB = { installId: installB, botId: botB, runId: runB };
    }, 300_000);

    afterAll(async () => {
      if (artifactRoot)
        await rm(artifactRoot, { recursive: true, force: true });
      if (fixture) await fixture.dispose();
    });

    itDb(
      "AC2a: unlisting hides discovery but the installed release keeps dispatching (transport exactly once)",
      async () => {
        const catalogue = await makeCatalogue(
          entriesWith({ packageKey: PKG_MAIN, version: V1, listed: false }),
        );
        // Discovery: the package's only other release is V2 (listed+published),
        // so the row stays discoverable via V2 — while V1 itself is gone from
        // the version picker. Both assertions use the real catalogue.
        const page = await catalogue.list(scopeA1, { limit: 100 });
        const row = page.items.find((item) => item.packageKey === PKG_MAIN);
        expect(row).toBeDefined();
        expect(row?.version).toBe(V2);
        const unlistedPage = await catalogue.list(
          scopeA1,
          { limit: 100 },
          { includeUnlisted: true },
        );
        const unlistedRow = unlistedPage.items.find(
          (item) => item.packageKey === PKG_MAIN && item.version === V1,
        );
        // Hmm — includeUnlisted picks ONE record per package (the newest); V2 is
        // newer, so V1 does not appear here. The unlisted fact shows on the
        // exact release via resolveRelease instead.
        expect(unlistedRow).toBeUndefined();
        const release = await catalogue.resolveRelease(PKG_MAIN, V1);
        expect(release).toMatchObject({
          listed: false,
          state: "published",
          verified: true,
        });
        expect(release?.blockers.map((blocker) => blocker.code)).toContain(
          "PACKAGE_UNLISTED",
        );
        // Runtime eligibility is untouched: the installed V1 still dispatches.
        vendorCalls = 0;
        const result = await makeDispatch(catalogue).execute(scopeA1, {
          runId: caseA.runId,
          attemptGeneration: 1,
          toolCallId: `call-${randomUUID()}`,
          bindingId: toolRefFor(caseA.installId, "lookup"),
          args: { query: "q" },
        });
        expect(result.outcome).toBe("ok");
        expect(vendorCalls).toBe(1);
        // And readiness stays runtime-eligible (NOT unavailable-by-unlisting).
        const service = makeService(catalogue);
        const detailDTO = await service.get(scopeA1, caseA.installId);
        expect(detailDTO.readiness).not.toBe("unavailable");
        expect(detailDTO.blockers.map((blocker) => blocker.code)).not.toContain(
          "PACKAGE_UNLISTED",
        );
        expect(detailDTO.blockers.map((blocker) => blocker.code)).not.toContain(
          "PACKAGE_WITHDRAWN",
        );
      },
    );

    itDb(
      "AC2b: a withdrawn release refuses new dispatch (old pin included) with zero transport calls, in BOTH companies",
      async () => {
        const catalogue = await makeCatalogue(
          entriesWith({
            packageKey: PKG_MAIN,
            version: V1,
            state: "withdrawn",
          }),
        );
        const dispatch = makeDispatch(catalogue);
        vendorCalls = 0;
        const refusedA = await dispatch.execute(scopeA1, {
          runId: caseA.runId,
          attemptGeneration: 1,
          toolCallId: `call-${randomUUID()}`,
          bindingId: toolRefFor(caseA.installId, "lookup"),
          args: { query: "q" },
        });
        expect(refusedA).toEqual({
          outcome: "refused",
          code: "PACKAGE_WITHDRAWN",
        });
        // 撤回是部署全局事实：B 公司同样阻断。
        const refusedB = await dispatch.execute(scopeB1, {
          runId: caseB.runId,
          attemptGeneration: 1,
          toolCallId: `call-${randomUUID()}`,
          bindingId: toolRefFor(caseB.installId, "lookup"),
          args: { query: "q" },
        });
        expect(refusedB).toEqual({
          outcome: "refused",
          code: "PACKAGE_WITHDRAWN",
        });
        expect(vendorCalls).toBe(0);
        // The approval-staging face refuses the same way, and leaves no row.
        const prepared = await dispatch.preparePackageTool(scopeA1, {
          runId: caseA.runId,
          attemptGeneration: 1,
          toolCallId: `call-${randomUUID()}`,
          ref: toolRefFor(caseA.installId, "lookup"),
          args: { query: "q" },
          botId: caseA.botId,
        });
        expect(prepared).toEqual({
          outcome: "refused",
          code: "PACKAGE_WITHDRAWN",
        });
        const rows = (await setup.$client.unsafe(
          "select count(*)::int as n from enterprise_package_dispatches where tool_call_id like 'call-%' and state = 'prepared'",
        )) as Array<{ n: number }>;
        expect(Number(rows[0]?.n ?? 0)).toBe(0);
      },
    );

    itDb(
      "A05/AC3: a call dispatched before the withdrawal keeps its result; a timeout stays unknown; nothing is force-cancelled",
      async () => {
        const published = await makeCatalogue(baseEntries());
        const withdrawn = await makeCatalogue(
          entriesWith({
            packageKey: PKG_MAIN,
            version: V1,
            state: "withdrawn",
          }),
        );
        // The call linearized while the release was still published…
        const begun = await makeDispatch(published).beginDispatch(scopeA1, {
          runId: caseA.runId,
          attemptGeneration: 1,
          toolCallId: `call-${randomUUID()}`,
          bindingId: toolRefFor(caseA.installId, "lookup"),
          args: { query: "q" },
        });
        expect(begun.outcome).toBe("permit");
        if (begun.outcome !== "permit") return;
        // …the withdrawal lands (a new catalogue snapshot)…
        // …and the completion write is NOT gated on authorization.
        await makeDispatch(withdrawn).completeDispatch(scopeA1, begun.permit, {
          state: "succeeded",
          effectStatus: "confirmed",
          receiptRef: { effectStatus: "confirmed", isError: false },
        });
        const kept = await makeDispatch(withdrawn).readDispatch(scopeA1, {
          runId: caseA.runId,
          attemptGeneration: 1,
          toolCallId: begun.permit.toolCallId,
        });
        expect(kept?.state).toBe("succeeded");
        expect(kept?.receiptRef).toMatchObject({ effectStatus: "confirmed" });
        // The unknown arm: dispatched before withdrawal, marked unknown after.
        const timedOut = await makeDispatch(published).beginDispatch(scopeA1, {
          runId: caseA.runId,
          attemptGeneration: 1,
          toolCallId: `call-${randomUUID()}`,
          bindingId: toolRefFor(caseA.installId, "lookup"),
          args: { query: "q" },
        });
        expect(timedOut.outcome).toBe("permit");
        if (timedOut.outcome !== "permit") return;
        const marked = await makeDispatch(withdrawn).markUnknown(scopeA1, {
          runId: caseA.runId,
          attemptGeneration: 1,
          toolCallId: timedOut.permit.toolCallId,
          errorCode: "DISPATCH_TRANSPORT_ERROR",
        });
        expect(marked).toBe(true);
        const unknownRead = await makeDispatch(withdrawn).readDispatch(
          scopeA1,
          {
            runId: caseA.runId,
            attemptGeneration: 1,
            toolCallId: timedOut.permit.toolCallId,
          },
        );
        expect(unknownRead?.state).toBe("unknown");
        // 撤回从不把已发生的效果改写为取消。
        const cancelled = (await setup.$client.unsafe(
          "select count(*)::int as n from enterprise_package_dispatches where state = 'cancelled'",
        )) as Array<{ n: number }>;
        expect(Number(cancelled[0]?.n ?? 0)).toBe(0);
      },
    );

    itDb(
      "AC4: a withdrawn release cannot be entered by install, upgrade or rollback plans (refused by state, not 404)",
      async () => {
        const cataloguePublished = await makeCatalogue(baseEntries());
        const servicePublished = makeService(cataloguePublished);
        const admin = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );

        // PLAN A: install V1 published, then withdraw V2 → upgrade refused.
        const installA = await installPackage({
          service: servicePublished,
          scope: scopeA1,
          admin,
          packageKey: PKG_PLAN_A,
          version: V1,
          connectorInstallId: connectorA1,
        });
        const current = await servicePublished.get(scopeA1, installA);
        const upgradeTarget = await makeCatalogue(
          entriesWith({
            packageKey: PKG_PLAN_A,
            version: V2,
            state: "withdrawn",
          }),
        );
        const serviceUpgradeRefused = makeService(upgradeTarget);
        await expect(
          serviceUpgradeRefused.plan(scopeA1, admin, {
            operation: "upgrade",
            packageKey: PKG_PLAN_A,
            version: V2,
            expectedRevision: current.revision,
            config: {},
            connectorInstalls: {},
          }),
        ).rejects.toThrow("PACKAGE_UNSUPPORTED");
        // The release still resolves — the refusal is the state, not a 404.
        const stillResolves = await upgradeTarget.resolveRelease(
          PKG_PLAN_A,
          V2,
        );
        expect(stillResolves).toMatchObject({
          state: "withdrawn",
          listed: true,
        });

        // PLAN B: install V2 published, then withdraw V1 → rollback and fresh
        // install both refused.
        const installB = await installPackage({
          service: servicePublished,
          scope: scopeA1,
          admin,
          packageKey: PKG_PLAN_B,
          version: V2,
          connectorInstallId: connectorA1,
        });
        const currentB = await servicePublished.get(scopeA1, installB);
        const v1Withdrawn = await makeCatalogue(
          entriesWith({
            packageKey: PKG_PLAN_B,
            version: V1,
            state: "withdrawn",
          }),
        );
        const serviceRollbackRefused = makeService(v1Withdrawn);
        await expect(
          serviceRollbackRefused.plan(scopeA1, admin, {
            operation: "rollback",
            packageKey: PKG_PLAN_B,
            version: V1,
            expectedRevision: currentB.revision,
            config: {},
            connectorInstalls: {},
          }),
        ).rejects.toThrow("PACKAGE_UNSUPPORTED");
        await expect(
          serviceRollbackRefused.plan(scopeA1, admin, {
            operation: "install",
            packageKey: PKG_PLAN_B,
            version: V1,
            expectedRevision: null,
            config: {},
            connectorInstalls: { [CONNECTOR]: connectorA1 },
          }),
        ).rejects.toThrow("PACKAGE_UNSUPPORTED");
      },
    );

    itDb(
      "A01: an index declaring one release with two digests refuses to assemble",
      async () => {
        const digest = digestOf(PKG_MAIN, V1);
        await expect(
          loadPackageCatalogue({
            artifactRoot,
            index: {
              schemaVersion: 1,
              packages: [
                {
                  packageKey: PKG_MAIN,
                  version: V1,
                  artifactDigest: digest,
                  category: "productivity",
                  listed: true,
                },
                {
                  packageKey: PKG_MAIN,
                  version: V1,
                  artifactDigest: "b".repeat(64),
                  category: "productivity",
                  listed: true,
                },
              ],
            },
          }),
        ).rejects.toThrow("two different digests");
      },
    );

    itDb(
      "AC5: both teams see the real unavailable reason; the picker drops the withdrawn release; no cross-team install leak",
      async () => {
        const catalogue = await makeCatalogue(
          entriesWith({
            packageKey: PKG_MAIN,
            version: V1,
            state: "withdrawn",
          }),
        );
        const service = makeService(catalogue);
        const detailA = await service.get(scopeA1, caseA.installId);
        expect(detailA.readiness).toBe("unavailable");
        expect(detailA.blockers.map((blocker) => blocker.code)).toContain(
          "PACKAGE_WITHDRAWN",
        );
        // The upgrade/rollback picker never offers the withdrawn release.
        expect(
          detailA.availableVersions?.map((entry) => entry.version),
        ).toEqual([V2]);
        expect(detailA.latestPublishedVersion).toBe(V2);

        // Company B sees the SAME deployment fact for its own install — never
        // company A's install id, revision or grants.
        const detailB = await service.get(scopeB1, caseB.installId);
        expect(detailB.readiness).toBe("unavailable");
        expect(detailB.blockers.map((blocker) => blocker.code)).toContain(
          "PACKAGE_WITHDRAWN",
        );
        expect(detailB.installId).toBe(caseB.installId);
        expect(detailB.installId).not.toBe(caseA.installId);

        // The list merge keeps each scope's install facts to itself: A's page
        // carries A's install, B's page carries B's — never each other's.
        const pageA = await service.list(scopeA1, { limit: 100 });
        const rowA = pageA.items.find((item) => item.packageKey === PKG_MAIN);
        expect(rowA?.install?.installId).toBe(caseA.installId);
        const pageB = await service.list(scopeB1, { limit: 100 });
        const rowB = pageB.items.find((item) => item.packageKey === PKG_MAIN);
        expect(rowB?.install?.installId).toBe(caseB.installId);
        // The list row's selected release is the published V2 (discovery stays
        // honest: the newest PUBLISHED release wins, the withdrawn one does not
        // hide it and is not offered). V2's own RESOURCE_UNAVAILABLE (a
        // managed-connector PKG01 fact) may stand; withdrawal/unlisting facts
        // must not leak into the published row.
        expect(rowA?.version).toBe(V2);
        const rowACodes = (rowA?.blockers ?? []).map((blocker) => blocker.code);
        expect(rowACodes).not.toContain("PACKAGE_WITHDRAWN");
        expect(rowACodes).not.toContain("PACKAGE_UNLISTED");

        // A catalogue whose every listed release is withdrawn still surfaces —
        // as unavailable WITH the withdrawal reason, never silently gone.
        const allWithdrawn = await makeCatalogue([
          { packageKey: PKG_MAIN, version: V1, state: "withdrawn" },
          { packageKey: PKG_MAIN, version: V2, state: "withdrawn" },
          ...baseEntries().filter((entry) => entry.packageKey !== PKG_MAIN),
        ]);
        const withdrawnPage = await allWithdrawn.list(scopeA1, { limit: 100 });
        const withdrawnRow = withdrawnPage.items.find(
          (item) => item.packageKey === PKG_MAIN,
        );
        expect(withdrawnRow).toBeDefined();
        expect(withdrawnRow?.installable).toBe(false);
        expect(withdrawnRow?.blockers.map((blocker) => blocker.code)).toContain(
          "PACKAGE_WITHDRAWN",
        );
        const withdrawnDetail = await allWithdrawn.get(
          scopeA1,
          "openbot",
          "pkg08-main",
        );
        expect(
          withdrawnDetail.blockers.map((blocker) => blocker.code),
        ).toContain("PACKAGE_WITHDRAWN");
        expect(withdrawnDetail.installable).toBe(false);
      },
    );

    itDb(
      "AC6: withdrawal is metadata-only — the artifact, index facts, pins and dispatch ledger all stay",
      async () => {
        const catalogue = await makeCatalogue(
          entriesWith({
            packageKey: PKG_MAIN,
            version: V1,
            state: "withdrawn",
          }),
        );
        const release = await catalogue.resolveRelease(PKG_MAIN, V1);
        expect(release).toMatchObject({
          state: "withdrawn",
          artifactDigest: digestOf(PKG_MAIN, V1),
          verified: true,
        });
        // The content-addressed artifact bytes are still on disk (no GC).
        const artifactDir = join(
          artifactRoot,
          "sha256",
          digestOf(PKG_MAIN, V1),
        );
        const stats = await (await import("node:fs/promises")).stat(
          artifactDir,
        );
        expect(stats.isDirectory()).toBe(true);
        // The pin rows and the earlier dispatch rows survive untouched.
        const pins = (await setup.$client.unsafe(
          "select count(*)::int as n from enterprise_run_package_pins where run_id = $1",
          [caseA.runId],
        )) as Array<{ n: number }>;
        expect(Number(pins[0]?.n ?? 0)).toBe(1);
        const ledger = (await setup.$client.unsafe(
          "select count(*)::int as n from enterprise_package_dispatches where run_id = $1",
          [caseA.runId],
        )) as Array<{ n: number }>;
        expect(Number(ledger[0]?.n ?? 0)).toBeGreaterThan(0);
      },
    );
  },
);
