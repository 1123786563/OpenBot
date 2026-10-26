// server/tests/multitenancy/package-withdraw-contention.test.ts
// T13-fix-1（#459 Run，Codex 终审 FC-01）：撤回与 dispatch 的共享事实/锁竞
// 争证明——真实跨进程 CLI、真实受锁保护的索引文件、真实受限角色 DB/RLS。
//
// 证据面（transport 可控注入；DB/RLS/锁/索引全真实，无仅改内存变量的模拟）：
//   (1) 交错-保留臂：dispatch 先进临界区（release 锁内 fresh 读取被 barrier
//       暂停）→ 真实 CLI withdraw 进程被同一把目录锁挡在门外（500ms 内未
//       落盘、未退出）→ dispatch CAS 提交放锁 → CLI 落盘 withdrawn →
//       transport 在撤回已提交后才完成，完成写保留 succeeded（AC3）；随后
//       新 dispatch refused PACKAGE_WITHDRAWN、transport 0（AC2）。
//   (2) 撤回先提交臂：CLI withdraw 完整提交后，存活服务新 dispatch 拒绝、
//       台账无行、transport 0。
//   (3) listed 正交 + 无需重启：同一存活服务实例先经 CLI publish 改
//       listed=false → dispatch 照常放行；再 CLI withdraw → 拒绝。全程不重
//       建 catalogue/dispatch（快照即「启动装配一次」的旧事实）。
//   (4) 互斥另一侧：真实 acquireIndexLock（部署命令的锁原语）持锁时，
//       dispatch 确定性等待（600ms 未落定、transport 0），放锁后放行。
//   (5) 内容寻址：每次 fresh 读取携带 indexDigest，断言判定所对的索引代。
//
// 环境：与 package-withdraw.test.ts 同一企业测试库契约（三角色 URL）。

import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sql } from "drizzle-orm";
import {
  acquireIndexLock,
  readMarketplaceIndex,
  serializeMarketplaceIndex,
  sha256Hex,
} from "../../../scripts/plugin-packages/index-file";
import type { PackageManifestV1 } from "../../../shared/enterprise/plugin-package-contracts";
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
import { loadPackageCatalogue } from "../../src/plugin-packages/catalogue";
import {
  createDeployedReleaseFactsGate,
  type DeployedReleaseFacts,
} from "../../src/plugin-packages/deployment-facts";
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
      reason: `T13-fix-1 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const PKG = "openbot/pkg13-contention";
const CONNECTOR = "crm";
const SKILL = "summarize";
const V1 = "1.0.0";

interface CompanyContext {
  readonly company: string;
  readonly workspace: string;
  readonly principal: string;
}

interface ReceiptJson {
  readonly ok: boolean;
  readonly action?: string;
  readonly state?: string;
  readonly listed?: boolean;
  readonly indexDigest?: string;
  readonly error?: string;
}

/** One CLI run (a REAL operating-system process), receipts parsed from stdout. */
async function runCli(
  script: "publish.ts" | "withdraw.ts",
  args: readonly string[],
): Promise<{ exitCode: number; receipt: ReceiptJson | null; stderr: string }> {
  const proc = Bun.spawn(
    ["bun", join(REPO_ROOT, "scripts/plugin-packages", script), ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return {
    exitCode,
    receipt: stdout.trim() ? (JSON.parse(stdout) as ReceiptJson) : null,
    stderr,
  };
}

describeDb(
  "T13-fix-1 withdrawal/dispatch shared facts and release lock (real processes)",
  () => {
    let fixture: PackageInstallFixture;
    let artifactRoot = "";
    let indexDir = "";
    let indexPath = "";
    let scope: PlatformScope;
    let context: CompanyContext;
    let installId = "";
    let botId = "";
    let runId = "";
    let runtime: ReturnType<typeof createPackageRuntime>;
    let digest = "";
    // OCR-fix-B (B2): the LIVE install service (same never-rebuilt rule as
    // the dispatch service above) plus its connector mapping, reused by the
    // plan/apply fresh-facts arm.
    let installService: PackageService;
    let connectorInstallId = "";

    // —— The LIVE service: assembled once against the published snapshot and
    // NEVER rebuilt — exactly the process Codex FC-01 targeted. The boot
    // catalogue stays stale on purpose; freshness comes only from the gate.
    let live: ReturnType<typeof createPackageDispatchService>;
    let vendorCalls = 0;
    let armedTransport: Promise<void> | null = null;

    // Fresh-read barrier: the FIRST readFreshFacts call blocks inside the
    // release-lock window (a file-level critical section — no in-memory
    // stand-in for the mutual exclusion itself).
    const readEvents: DeployedReleaseFacts[] = [];
    let blockFirstRead = false;
    let unblockFirstRead: (() => void) | null = null;
    let enteredResolve: (() => void) | null = null;
    const firstReadEntered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });

    const vault: SecretVault = {
      seal: async (plaintext) => `t13-envelope:${plaintext}`,
      open: async (envelope) => {
        if (!envelope.startsWith("t13-envelope:")) {
          throw new Error("T13_TEST_ENVELOPE_INVALID");
        }
        return envelope.slice("t13-envelope:".length);
      },
    };
    const vendorCall: PackageVendorCaller = async () => {
      vendorCalls += 1;
      if (armedTransport) await armedTransport;
      return { text: "ok", isError: false };
    };

    const withdrawViaCli = () =>
      runCli("withdraw.ts", [
        "--index",
        indexPath,
        "--package",
        PKG,
        "--version",
        V1,
      ]);
    const publishViaCli = (listed: boolean) =>
      runCli("publish.ts", [
        "--index",
        indexPath,
        "--artifact-root",
        artifactRoot,
        "--package",
        PKG,
        "--version",
        V1,
        "--digest",
        digest,
        "--category",
        "productivity",
        "--listed",
        listed ? "true" : "false",
      ]);

    const lockDirExists = async () => {
      try {
        await stat(`${indexPath}.lock`);
        return true;
      } catch {
        return false;
      }
    };

    const dispatchNow = (toolCallId: string) =>
      live.execute(scope, {
        runId,
        attemptGeneration: 1,
        toolCallId,
        bindingId: `pkg:${installId}:${CONNECTOR}/lookup`,
        args: { query: "q" },
      });

    const ledgerRowOf = async (toolCallId: string) => {
      const list = await live.listDispatches(scope, { installId });
      if (list.outcome !== "found") throw new Error("LEDGER_UNREADABLE");
      return list.value.find((row) => row.toolCallId === toolCallId);
    };

    beforeAll(async () => {
      await applyPackageTasks();
      fixture = await createPackageInstallFixture();
      await fixture.addTeamMember(
        "company-admin",
        "company-a",
        "company-admin",
        "team-a1",
      );
      await fixture.promoteToCompanyAdmin("company-admin", "company-a");
      scope = await fixture.scopeFor("company-admin", "team-a1");
      context = {
        company: fixture.tenantOf("company-a"),
        workspace: fixture.teamOf("company-a", "team-a1"),
        principal: fixture.principalOf("company-admin", "company-a"),
      };

      artifactRoot = await mkdtemp(join(tmpdir(), "t13fix1-artifacts-"));
      indexDir = await mkdtemp(join(tmpdir(), "t13fix1-index-"));
      indexPath = join(indexDir, "marketplace.json");

      // One verified artifact; the index registers exactly this release.
      const source = await mkdtemp(join(tmpdir(), "t13fix1-source-"));
      try {
        const manifest: PackageManifestV1 = {
          schemaVersion: 1,
          platformApi: 1,
          publisher: PKG.split("/")[0] as string,
          name: PKG.split("/")[1] as string,
          version: V1,
          display: { name: "T13 Contention", summary: "T13-fix-1 fixture." },
          resources: [
            { kind: "skill", id: SKILL, path: `skills/${SKILL}/SKILL.md` },
            {
              kind: "managedConnector",
              id: CONNECTOR,
              catalogKey: "pkg13-managed-notes",
              required: true,
              tools: [
                { name: "lookup", effect: "read" },
                { name: "purge", effect: "write" },
              ],
            },
          ],
          dependencies: [],
        };
        await writeFile(
          join(source, "openbot.plugin.json"),
          JSON.stringify(manifest),
        );
        const skillPath = join(source, "skills", SKILL, "SKILL.md");
        await mkdir(dirname(skillPath), { recursive: true });
        await writeFile(skillPath, `# ${SKILL} @ ${V1}\n`);
        const artifact = await buildArtifact(source);
        await storeArtifact(artifact, artifactRoot);
        digest = artifact.digest;
      } finally {
        await rm(source, { recursive: true, force: true });
      }

      await writeFile(
        indexPath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            packages: [
              {
                packageKey: PKG,
                version: V1,
                artifactDigest: digest,
                category: "productivity",
                listed: true,
                state: "published",
              },
            ],
          },
          null,
          2,
        )}\n`,
      );

      // The deployment-facts gate: same index file, same cross-process lock,
      // plus the fresh-read barrier hook used by the interleaved arms.
      const gate = createDeployedReleaseFactsGate({
        indexPath,
        onFactsRead: async (facts) => {
          readEvents.push(facts as DeployedReleaseFacts);
          if (blockFirstRead && readEvents.length === 1) {
            enteredResolve?.();
            await new Promise<void>((resolve) => {
              unblockFirstRead = resolve;
            });
          }
        },
      });

      const catalogue = await loadPackageCatalogue({
        artifactRoot,
        index: JSON.parse(await readFile(indexPath, "utf8")),
      });
      runtime = createPackageRuntime({ data: fixture.base.data, artifactRoot });

      // Install under the published catalogue; the boot snapshot stays the
      // manifest source, but plan/apply now re-read fresh deployment facts
      // through the SAME gate the dispatch service linearizes against.
      installService = createPackageService({
        catalogue,
        readStore: fixture.readStore,
        mutation: fixture.mutation,
        artifactRoot,
        releaseFacts: gate,
      });
      const catalogId = "pkg13-managed-notes";
      await fixture.setup.$client.unsafe(
        `insert into enterprise_plugin_catalog (id, kind, title, vendor, source, metadata)
       values ($1, 'mcp', 'T13 Managed Notes', 'openbot', 'first-party', '{"summary":"Managed notes MCP"}'::jsonb)
       on conflict (id) do nothing`,
        [catalogId],
      );
      connectorInstallId = `t13-connector-${randomUUID()}`;
      const connectionId = `t13-connection-${randomUUID()}`;
      await fixture.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${context.company}, true), set_config('app.workspace_id', ${context.workspace}, true)`,
        );
        await tx.execute(
          sql`insert into enterprise_plugin_installs
            (tenant_id, id, catalog_id, workspace_id, installed_by, config, envelope, status)
          values (${context.company}, ${connectorInstallId}, ${catalogId}, ${context.workspace},
                  ${context.principal}, '{"url":"https://t13-managed.example.test/mcp"}'::jsonb,
                  ${"t13-envelope:t13-secret-canary"}, 'active')`,
        );
        await tx.execute(
          sql`insert into enterprise_plugin_connections
            (tenant_id, id, install_id, bound_by, vendor_ref, generation)
          values (${context.company}, ${connectionId}, ${connectorInstallId}, ${context.principal}, 'acct', 1)`,
        );
      });
      const plan = await installService.plan(
        scope,
        await fixture.adminContextOf("company-admin", "company-a"),
        {
          operation: "install",
          packageKey: PKG,
          version: V1,
          expectedRevision: null,
          config: {},
          connectorInstalls: { [CONNECTOR]: connectorInstallId },
        },
      );
      const applied = await installService.apply(
        scope,
        await fixture.adminContextOf("company-admin", "company-a"),
        plan.planId,
        `t13-install-${randomUUID()}`,
      );
      installId = applied.install.installId;

      // Grants + admitted bot + run + pin (the runnable case).
      const manifestJson = (await catalogue.resolveRelease(PKG, V1))?.manifest;
      if (!manifestJson) throw new Error("T13_MANIFEST_MISSING");
      const tools = addedToolsOf(manifestJson);
      botId = `t13-bot-${randomUUID()}`;
      await fixture.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${context.company}, true), set_config('app.workspace_id', ${context.workspace}, true)`,
        );
        await tx.execute(
          sql`insert into enterprise_bot_ownership
            (tenant_id, agent_id, workspace_id, owner_principal_id, display_name, default_config)
          values (${context.company}, ${botId}, ${context.workspace}, ${context.principal}, 'T13 bot', '{}'::jsonb)`,
        );
        await tx.execute(
          sql`insert into enterprise_package_grants
            (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
             resource_kind, tool_ref, granted_by)
          values (${context.company}, ${installId}, 1, ${botId}, ${SKILL},
                  ${context.workspace}, 'skill', '', ${context.principal})`,
        );
        for (const tool of tools) {
          await tx.execute(
            sql`insert into enterprise_package_grants
              (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
               resource_kind, tool_ref, schema_digest, effect, connector_install_id, granted_by)
            values (${context.company}, ${installId}, 1, ${botId}, ${CONNECTOR},
                    ${context.workspace}, 'connectorTool', ${tool.ref},
                    ${tool.schemaDigest}, ${tool.effect}, ${connectorInstallId},
                    ${context.principal})`,
          );
        }
      });
      const expertVersionRef = `t13-expert-${randomUUID()}`;
      runId = randomUUID();
      await fixture.setup.$client.unsafe(
        `insert into enterprise_expert_versions
           (tenant_id, expert_version_ref, schema_version, agent_id, snapshot)
         values ($1, $2, 1, $3, '{}'::jsonb)`,
        [context.company, expertVersionRef, botId],
      );
      await fixture.setup.$client.unsafe(
        `insert into enterprise_runs
           (id, tenant_id, workspace_id, principal_id, thread_id, client_message_key,
            expert_version_ref, model_route_ref, model_route_maximum_tokens, status,
            attempt_generation, lease_expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, 't13-route', 1000, 'running', 1, now() + interval '1 hour')`,
        [
          runId,
          context.company,
          context.workspace,
          context.principal,
          `t13-thread-${randomUUID()}`,
          `t13-msg-${randomUUID()}`,
          expertVersionRef,
        ],
      );
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

      // The LIVE dispatch service — with the shared facts/lock gate wired the
      // same way production (index.ts) wires it.
      live = createPackageDispatchService({
        data: fixture.base.data,
        catalogue,
        releaseFacts: gate,
        artifactRoot,
        vault,
        toolInvocation: createToolInvocationService({
          data: fixture.base.data,
        }),
        catalogDecisions: createPluginCatalogDecisionService(fixture.base.data),
        pinnedTools: runtime.readPinnedTools,
        vendorCall,
      });
    }, 300_000);

    afterAll(async () => {
      if (artifactRoot)
        await rm(artifactRoot, { recursive: true, force: true });
      if (indexDir) await rm(indexDir, { recursive: true, force: true });
      if (fixture) await fixture.dispose();
    });

    itDb(
      "interleaved arm A: dispatch in the release-lock window blocks a real CLI withdrawal until the CAS commits, then the completion is preserved",
      async () => {
        // The decision's index generation, proven against the file itself.
        const preWithdrawDigest = sha256Hex(
          serializeMarketplaceIndex(await readMarketplaceIndex(indexPath)),
        );
        // Arm the fresh-read barrier: the FIRST fresh read (pin arm) parks
        // INSIDE the lock window with the facts already in hand. (OCR-fix-B2
        // note: the install service's own beforeAll plan/apply already read
        // through the gate — reset the evidence log so "first" means first
        // of THIS arm again.)
        readEvents.length = 0;
        blockFirstRead = true;
        let releaseTransport: (() => void) | null = null;
        armedTransport = new Promise<void>((resolve) => {
          releaseTransport = resolve;
        });

        const callA = `t13-a-${randomUUID()}`;
        const dispatchP = dispatchNow(callA);
        await firstReadEntered; // dispatch holds the release lock right now.

        // The CLI withdrawal is a REAL process and must be locked out: within
        // 500ms it has neither written the index nor exited.
        let cliExit: number | null = null;
        const cli = (async () => {
          const result = await withdrawViaCli();
          cliExit = result.exitCode;
          return result;
        })();
        const cliResultP = cli;
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(cliExit).toBeNull(); // still waiting on the lock
        const midIndex = JSON.parse(await readFile(indexPath, "utf8")) as {
          packages: { state: string }[];
        };
        expect(midIndex.packages[0]?.state).toBe("published");
        expect(await lockDirExists()).toBe(true);

        // Let the dispatch finish its critical section: fresh read completes,
        // CAS commits `dispatched`, the lock releases — only then can the CLI
        // replace the index. The transport stays armed (post-commit).
        unblockFirstRead?.();
        const cliResult = await cliResultP;
        expect(cliExit).toBe(0);
        expect(cliResult.receipt).toMatchObject({
          ok: true,
          action: "withdrawn",
          state: "withdrawn",
        });
        blockFirstRead = false;

        // The withdrawal is now committed while the transport never ran.
        expect(vendorCalls).toBe(1); // parked in vendorCall, awaiting the gate
        // The decision linearized against the PRE-withdrawal index generation.
        expect(readEvents[0]?.indexDigest).toBe(preWithdrawDigest);
        expect(readEvents[0]?.state).toBe("published");

        // Release the transport AFTER the withdrawal committed: the effect
        // completes post-withdrawal and is still preserved (PKG08 AC3).
        releaseTransport?.();
        armedTransport = null;
        const result = await dispatchP;
        expect(result.outcome).toBe("ok");
        expect(vendorCalls).toBe(1);
        const row = await ledgerRowOf(callA);
        expect(row?.state).toBe("succeeded");

        // And the next dispatch on the SAME live service is refused.
        const refused = await dispatchNow(`t13-a2-${randomUUID()}`);
        expect(refused).toMatchObject({
          outcome: "refused",
          code: "PACKAGE_WITHDRAWN",
        });
        expect(vendorCalls).toBe(1);
      },
    );

    itDb(
      "interleaved arm B: a committed CLI withdrawal refuses the live service's next dispatch with no ledger row and transport 0",
      async () => {
        // Restore published via the real CLI (same digest = metadata update).
        const restore = await publishViaCli(true);
        expect(restore.exitCode).toBe(0);
        expect(restore.receipt).toMatchObject({ ok: true, state: "published" });

        const before = vendorCalls;
        const withdrawn = await withdrawViaCli();
        expect(withdrawn.exitCode).toBe(0);
        expect(withdrawn.receipt).toMatchObject({
          ok: true,
          action: "withdrawn",
        });

        const callId = `t13-b-${randomUUID()}`;
        const refused = await dispatchNow(callId);
        expect(refused).toMatchObject({
          outcome: "refused",
          code: "PACKAGE_WITHDRAWN",
        });
        expect(vendorCalls).toBe(before); // transport exactly 0 new calls
        expect(await ledgerRowOf(callId)).toBeUndefined(); // no dispatch row
      },
    );

    itDb(
      "live service, no restart: unlisting (listed=false) keeps dispatching; withdrawal blocks it — orthogonal facts on the same instance",
      async () => {
        const restore = await publishViaCli(true);
        expect(restore.exitCode).toBe(0);

        // Unlist via the real CLI: state stays published, discovery-only.
        const unlist = await publishViaCli(false);
        expect(unlist.exitCode).toBe(0);
        expect(unlist.receipt).toMatchObject({
          ok: true,
          listed: false,
          state: "published",
        });

        const before = vendorCalls;
        const ok = await dispatchNow(`t13-c1-${randomUUID()}`);
        expect(ok.outcome).toBe("ok");
        expect(vendorCalls).toBe(before + 1);

        const withdrawn = await withdrawViaCli();
        expect(withdrawn.exitCode).toBe(0);
        const refused = await dispatchNow(`t13-c2-${randomUUID()}`);
        expect(refused).toMatchObject({
          outcome: "refused",
          code: "PACKAGE_WITHDRAWN",
        });
        expect(vendorCalls).toBe(before + 1);
      },
    );

    itDb(
      "mutual exclusion from the dispatch side: a real acquireIndexLock holder deterministically delays the dispatch",
      async () => {
        const restore = await publishViaCli(true);
        expect(restore.exitCode).toBe(0);

        // Hold the EXACT lock primitive the deploy commands take — the same
        // directory protocol the service's gate acquires.
        const holder = await acquireIndexLock(indexPath);
        const before = vendorCalls;
        const callId = `t13-d-${randomUUID()}`;
        const dispatchP = dispatchNow(callId);
        const settled = await Promise.race([
          dispatchP.then(
            () => "settled" as const,
            () => "settled" as const,
          ),
          new Promise<"pending">((resolve) =>
            setTimeout(() => resolve("pending"), 600),
          ),
        ]);
        expect(settled).toBe("pending"); // blocked on the shared lock
        expect(vendorCalls).toBe(before);

        await holder.release();
        const result = await dispatchP;
        expect(result.outcome).toBe("ok");
        expect(vendorCalls).toBe(before + 1);
      },
    );

    itDb(
      "OCR-fix-B2: a committed CLI withdrawal refuses the live install service's plan and apply without a restart",
      async () => {
        const restore = await publishViaCli(true);
        expect(restore.exitCode).toBe(0);

        const admin = await fixture.adminContextOf(
          "company-admin",
          "company-a",
        );
        const expectPackageCode = async (
          promise: Promise<unknown>,
          code: string,
        ) => {
          let caught: unknown;
          try {
            await promise;
          } catch (error) {
            caught = error;
          }
          expect((caught as { code?: string } | undefined)?.code).toBe(code);
        };

        // A plan under the PUBLISHED release still works (positive control),
        // and its receipt stays applicable only while the release stands.
        const facts = await fixture.readStore.getInstall(scope, installId);
        expect(facts?.status).toBe("enabled");
        const standingPlan = await installService.plan(scope, admin, {
          operation: "upgrade",
          packageKey: PKG,
          version: V1,
          expectedRevision: facts?.revision ?? 1,
          config: {},
          connectorInstalls: { [CONNECTOR]: connectorInstallId },
        });

        // The committed withdrawal flips the on-disk state; the boot
        // catalogue snapshot still says published, but plan and apply must
        // re-read the CURRENT facts and refuse, on the SAME live service.
        const withdrawn = await withdrawViaCli();
        expect(withdrawn.exitCode).toBe(0);
        await expectPackageCode(
          installService.plan(scope, admin, {
            operation: "upgrade",
            packageKey: PKG,
            version: V1,
            expectedRevision: facts?.revision ?? 1,
            config: {},
            connectorInstalls: { [CONNECTOR]: connectorInstallId },
          }),
          "PACKAGE_UNSUPPORTED",
        );
        await expectPackageCode(
          installService.apply(
            scope,
            admin,
            standingPlan.planId,
            `t13-b2-apply-${randomUUID()}`,
          ),
          "PACKAGE_UNSUPPORTED",
        );

        // Orthogonal direction: a CLI re-publish makes the very same service
        // plannable again — the freshness read is live both ways, no restart.
        const republish = await publishViaCli(true);
        expect(republish.exitCode).toBe(0);
        const replan = await installService.plan(scope, admin, {
          operation: "upgrade",
          packageKey: PKG,
          version: V1,
          expectedRevision: facts?.revision ?? 1,
          config: {},
          connectorInstalls: { [CONNECTOR]: connectorInstallId },
        });
        expect(replan.operation).toBe("upgrade");
      },
    );
  },
);
