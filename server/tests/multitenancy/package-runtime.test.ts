// server/tests/multitenancy/package-runtime.test.ts
// PKG03B（Issue #462 slice B）：Run 包钉扎 + 运行时 Skill 读取——真实受限角色。
//
// 证据面（逐条对应 Task Brief PKG03B deliverable 5）：
//   (1) 原子性：run 行与 pin 行在同一数据通道事务提交；并发观察者（独立
//       data 角色连接）在轮询窗口内永远看不到"就绪 run 而无 pin"。
//   (2) 同 (run, attempt) 重试读回同一 pin，不产生重复行。
//   (3) 停用安装 → 读取为空；重新启用 → 恢复（A05 收窄）。
//   (4) 撤销一条授权 → 恰好该 skill 从读取集消失，另一条保留（A05）。
//   (5) 升级模拟（新 revision 行 + 新链接 + 新授权）：旧 run 保持旧 revision
//       钉扎并继续读旧制品内容；新 revision 独有 skill 即使已授权也不被
//       旧 run 读取（A06）；升级后的新 run 钉到新 revision。
//   (6) 跨公司 scope 读取他人 run 的 pin 一律为空（RLS + 显式范围谓词）。
//   (7) enterprise_run_package_pins 的最小授权形态：data 读+插（无改/删）、
//       operator 读+插（无改/删）、directory 零授权，ENABLE+FORCE RLS。
//   (8) 无授权 Bot 的 run 不写任何 pin（快照为空，run 正常创建）。
//
// T03-fix 增补（缺口修复）：
//   (9) AC5 准入臂：授权 Bot 的归属行漂移后，下一次 run 绑定显式拒绝
//       PACKAGE_BOT_SCOPE_UNAVAILABLE，整个 run 事务回滚、零 pin 落库。
//   (10) AC4 成员臂：发起人的团队成员关系被暂停后，下一次 pin 读取为空；
//       恢复后立即恢复（每次读取重验，零缓存）。
//   (11) L-3 绑定：(runId, attempt) → admitted bot——同团队另一 Bot 报他人
//       run 的 pin 读取 = INPUT_INVALID。
//
// 排列方式：每个用例自建 install/bot/grant/run（互不共享状态），避免
// PKG02/PKG03A 教训里的共享进程与长事务模式；无任何 10 分钟等待。

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createDatabase, type Database } from "../../src/db/client";
import type { PlatformScope } from "../../src/enterprise/contracts";
import { createPackageRuntime } from "../../src/enterprise/plugin-packages/runtime";
import type { DataDatabase } from "../../src/enterprise/tenancy/connections";
import {
  buildArtifact,
  storeArtifact,
} from "../../src/plugin-packages/artifact";
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
      reason: `PKG03B requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

const SKILL_A = "summarize";
const SKILL_B = "translate";

let fixture: PackageInstallFixture;
let setup: Database;
let artifactRoot: string;
/** digestV1 pins skills [summarize]; digestV2 pins [summarize, translate]. */
let digestV1 = "";
let digestV2 = "";
let runtime: ReturnType<typeof createPackageRuntime>;
let scopeA1: PlatformScope;
let scopeB: PlatformScope;
let companyA = "";
let teamA1 = "";
let adminPrincipal = "";

/** Builds one real artifact (verified, content-addressed) into the temp root. */
async function storePackage(
  destination: string,
  definition: {
    name: string;
    displayName: string;
    skills: readonly string[];
  },
): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), "pkg03b-source-"));
  try {
    const manifest = {
      schemaVersion: 1,
      platformApi: 1,
      publisher: "openbot",
      name: definition.name,
      version: "1.0.0",
      display: {
        name: definition.displayName,
        summary: `${definition.displayName} summary`,
      },
      resources: definition.skills.map((skill) => ({
        kind: "skill" as const,
        id: skill,
        path: `skills/${skill}/SKILL.md`,
      })),
      dependencies: [] as [],
    };
    await writeFile(
      join(source, "openbot.plugin.json"),
      JSON.stringify(manifest),
    );
    for (const skill of definition.skills) {
      const absolute = join(source, "skills", skill, "SKILL.md");
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, `# ${skill}\n`);
    }
    const artifact = await buildArtifact(source);
    await storeArtifact(artifact, destination);
    return artifact.digest;
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}

async function seedInstall(input: {
  readonly digest: string;
  readonly skills: readonly string[];
  readonly botId: string;
  readonly generations?: readonly number[];
}): Promise<string> {
  const installId = `pkg03b-install-${crypto.randomUUID()}`;
  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_package_installs
            (tenant_id, id, workspace_id, package_key, current_version, status, installed_by)
          values (${companyA}, ${installId}, ${teamA1}, ${`openbot/pkg03b-${randomUUID()}`}, '1.0.0', 'enabled', ${adminPrincipal})`,
    );
    await tx.execute(
      sql`insert into enterprise_package_revisions
            (tenant_id, install_id, revision, release_version, artifact_digest, config, created_by)
          values (${companyA}, ${installId}, 1, '1.0.0', ${input.digest}, '{}'::jsonb, ${adminPrincipal})`,
    );
    for (const skill of input.skills) {
      await tx.execute(
        sql`insert into enterprise_package_resource_links
              (tenant_id, install_id, revision, resource_id, workspace_id, kind)
            values (${companyA}, ${installId}, 1, ${skill}, ${teamA1}, 'skill')`,
      );
    }
    for (const generation of input.generations ?? [1]) {
      for (const skill of input.skills) {
        await tx.execute(
          sql`insert into enterprise_package_grants
                (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
                 resource_kind, tool_ref, granted_by)
              values (${companyA}, ${installId}, ${generation}, ${input.botId}, ${skill}, ${teamA1}, 'skill', '', ${adminPrincipal})`,
        );
      }
    }
  });
  return installId;
}

async function seedBot(): Promise<string> {
  const agentId = `pkg03b-bot-${crypto.randomUUID()}`;
  await fixture.operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_bot_ownership
            (tenant_id, agent_id, workspace_id, owner_principal_id, display_name, default_config)
          values (${companyA}, ${agentId}, ${teamA1}, ${adminPrincipal}, 'PKG03B bot', '{}'::jsonb)`,
    );
  });
  return agentId;
}

/**
 * Arrangement stand-in (superuser, disclosed): the run row itself plus the
 * expert-version row that names the run's admitted Bot. The production path
 * writes runs through the data channel; the pins DECISION paths under test
 * (prepareWithin + pinned read) all run through real roles. The expert row is
 * what the pinned read binds (runId, attempt) → admitted bot (L-3).
 */
async function seedRun(input: {
  readonly botId: string;
  readonly workspaceId?: string;
  readonly principalId?: string;
}): Promise<string> {
  const runId = crypto.randomUUID();
  const expertVersionRef = `pkg03b-expert-${randomUUID()}`;
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
     values ($1, $2, $3, $4, $5, $6, $7, 'pkg03b-route', 1000, 'queued', 1, now() + interval '1 hour')`,
    [
      runId,
      companyA,
      input.workspaceId ?? teamA1,
      input.principalId ?? adminPrincipal,
      `pkg03b-thread-${randomUUID()}`,
      `pkg03b-msg-${randomUUID()}`,
      expertVersionRef,
    ],
  );
  return runId;
}

/**
 * Simulates the run-writer channel exactly: one data transaction with the
 * run tx's GUCs (tenant/principal/user — workspace deliberately left to
 * `prepareWithin` itself), the caller's extra work inside the same tx, then
 * `prepareWithin`.
 */
async function withinRunTx<T>(
  scope: PlatformScope,
  work: (
    tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0],
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

async function pinCount(installId: string): Promise<number> {
  const rows = (await setup.$client.unsafe(
    "select count(*)::int as n from enterprise_run_package_pins where install_id = $1",
    [installId],
  )) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

describeDb("PKG03B run package pins + pinned runtime read (real roles)", () => {
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
    companyA = fixture.tenantOf("company-a");
    teamA1 = fixture.teamOf("company-a", "team-a1");
    adminPrincipal = fixture.principalOf("company-admin", "company-a");
    scopeA1 = await fixture.scopeFor("company-admin", "team-a1");
    scopeB = await fixture.scopeFor("b1-member", "team-b1");
    artifactRoot = await mkdtemp(join(tmpdir(), "pkg03b-artifacts-"));
    digestV1 = await storePackage(artifactRoot, {
      name: "pkg03b-v1",
      displayName: "PKG03B v1 name",
      skills: [SKILL_A],
    });
    digestV2 = await storePackage(artifactRoot, {
      name: "pkg03b-v2",
      displayName: "PKG03B v2 name",
      skills: [SKILL_A, SKILL_B],
    });
    runtime = createPackageRuntime({
      data: fixture.base.data,
      artifactRoot,
    });
  });

  afterAll(async () => {
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
    if (fixture) await fixture.dispose();
  });

  itDb(
    "run and pins commit atomically: no observer sees a ready run without pins",
    async () => {
      const botId = await seedBot();
      const installId = await seedInstall({
        digest: digestV1,
        skills: [SKILL_A],
        botId,
      });
      // The concurrent observer: an independent data-role connection polling
      // for "queued run without its pins" while prepares commit.
      const probe = createDatabase(enterpriseRuntimeDatabaseUrlFrom("data"), {
        max: 1,
      });
      let observations = 0;
      let orphans = 0;
      let polling = true;
      const poller = (async () => {
        while (polling) {
          try {
            await probe.transaction(async (tx) => {
              await tx.execute(
                sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
              );
              const rows = (await tx.execute(sql`
                select count(*)::int as n from enterprise_runs r
                where r.status = 'queued'
                  and not exists (
                    select 1 from enterprise_run_package_pins p
                    where p.tenant_id = r.tenant_id
                      and p.run_id = r.id
                      and p.attempt_generation = r.attempt_generation
                      and p.workspace_id = r.workspace_id
                  )
              `)) as unknown as Array<{ n: number }>;
              observations += 1;
              orphans = Math.max(orphans, Number(rows[0]?.n ?? 0));
            });
          } catch {
            // Poller failures must not fail the test on their own; the
            // committed-state assertions below carry the verdict.
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })();

      const runIds: string[] = [];
      try {
        for (let index = 0; index < 8; index += 1) {
          const runId = await withinRunTx(scopeA1, async (tx) => {
            const id = crypto.randomUUID();
            // The run row, written by the run writer in this same transaction.
            await tx.execute(sql`
              insert into enterprise_runs
                (id, tenant_id, workspace_id, principal_id, thread_id, client_message_key,
                 expert_version_ref, model_route_ref, model_route_maximum_tokens, status,
                 attempt_generation, lease_expires_at)
              values (${id}, ${companyA}, ${teamA1}, ${scopeA1.principalId},
                      ${`pkg03b-race-${randomUUID()}`}, ${`pkg03b-race-${randomUUID()}`},
                      'pkg03b', 'pkg03b-route', 1000, 'queued', 1, now() + interval '1 hour')
            `);
            await runtime.prepareWithin(tx, scopeA1, {
              botId,
              runId: id,
              attemptGeneration: 1,
            });
            return id;
          });
          runIds.push(runId);
        }
      } finally {
        polling = false;
        await poller;
        await probe.$client.close().catch(() => {});
      }
      expect(runIds.length).toBe(8);
      expect(observations).toBeGreaterThan(0);
      // The invariant: every committed, ready run was always pinned.
      expect(orphans).toBe(0);
      // All pins landed (8 runs x 1 install).
      expect(await pinCount(installId)).toBe(8);
    },
  );

  itDb(
    "a retry of the same attempt reads the same pin back without duplicating",
    async () => {
      const botId = await seedBot();
      const installId = await seedInstall({
        digest: digestV1,
        skills: [SKILL_A],
        botId,
      });
      const runId = await seedRun({ botId });
      const first = await withinRunTx(scopeA1, (tx) =>
        runtime.prepareWithin(tx, scopeA1, {
          botId,
          runId,
          attemptGeneration: 1,
        }),
      );
      expect(first.pins).toMatchObject([
        {
          installId,
          installGeneration: 1,
          revision: 1,
          artifactDigest: digestV1,
          grantRevision: 1,
          allowedResourceIds: [SKILL_A],
        },
      ]);
      const retry = await withinRunTx(scopeA1, (tx) =>
        runtime.prepareWithin(tx, scopeA1, {
          botId,
          runId,
          attemptGeneration: 1,
        }),
      );
      expect(retry).toEqual(first);
      expect(await pinCount(installId)).toBe(1);
    },
  );

  itDb("a bot without grants pins nothing and the run stands", async () => {
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
    const served = await runtime.readPinnedSkills(scopeA1, {
      botId,
      runId,
      attemptGeneration: 1,
    });
    expect(served).toEqual([]);
  });

  itDb(
    "disable empties the pinned read; re-enable restores it (A05)",
    async () => {
      const botId = await seedBot();
      const installId = await seedInstall({
        digest: digestV1,
        skills: [SKILL_A],
        botId,
      });
      const runId = await seedRun({ botId });
      await withinRunTx(scopeA1, (tx) =>
        runtime.prepareWithin(tx, scopeA1, {
          botId,
          runId,
          attemptGeneration: 1,
        }),
      );
      const servedBefore = await runtime.readPinnedSkills(scopeA1, {
        botId,
        runId,
        attemptGeneration: 1,
      });
      expect(servedBefore.map((skill) => skill.slug)).toEqual([
        `pkg:${installId}:${SKILL_A}`,
      ]);
      expect(servedBefore[0]?.title).toBe("PKG03B v1 name");

      await fixture.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
        );
        await tx.execute(
          sql`update enterprise_package_installs set status = 'disabled' where tenant_id = ${companyA} and id = ${installId}`,
        );
      });
      expect(
        await runtime.readPinnedSkills(scopeA1, {
          botId,
          runId,
          attemptGeneration: 1,
        }),
      ).toEqual([]);

      await fixture.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
        );
        await tx.execute(
          sql`update enterprise_package_installs set status = 'enabled' where tenant_id = ${companyA} and id = ${installId}`,
        );
      });
      expect(
        (
          await runtime.readPinnedSkills(scopeA1, {
            botId,
            runId,
            attemptGeneration: 1,
          })
        ).length,
      ).toBe(1);
    },
  );

  itDb(
    "revoking one grant removes exactly that skill from the pinned read",
    async () => {
      const botId = await seedBot();
      const installId = await seedInstall({
        digest: digestV2,
        skills: [SKILL_A, SKILL_B],
        botId,
      });
      const runId = await seedRun({ botId });
      await withinRunTx(scopeA1, (tx) =>
        runtime.prepareWithin(tx, scopeA1, {
          botId,
          runId,
          attemptGeneration: 1,
        }),
      );
      const before = await runtime.readPinnedSkills(scopeA1, {
        botId,
        runId,
        attemptGeneration: 1,
      });
      expect(before.map((skill) => skill.slug).sort()).toEqual([
        `pkg:${installId}:${SKILL_A}`,
        `pkg:${installId}:${SKILL_B}`,
      ]);

      // Revoke exactly SKILL_B's grant row (operator UPDATE policy, the same
      // channel the grants service uses).
      await fixture.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
        );
        await tx.execute(
          sql`update enterprise_package_grants set revoked_at = now()
              where tenant_id = ${companyA} and install_id = ${installId}
                and bot_id = ${botId} and resource_id = ${SKILL_B} and revoked_at is null`,
        );
      });
      const after = await runtime.readPinnedSkills(scopeA1, {
        botId,
        runId,
        attemptGeneration: 1,
      });
      expect(after.map((skill) => skill.slug)).toEqual([
        `pkg:${installId}:${SKILL_A}`,
      ]);
    },
  );

  itDb(
    "an upgrade keeps the old run on its pinned revision; new skills stay refused (A06)",
    async () => {
      const botId = await seedBot();
      const installId = await seedInstall({
        digest: digestV1,
        skills: [SKILL_A],
        botId,
      });
      const oldRunId = await seedRun({ botId });
      await withinRunTx(scopeA1, (tx) =>
        runtime.prepareWithin(tx, scopeA1, {
          botId,
          runId: oldRunId,
          attemptGeneration: 1,
        }),
      );

      // Upgrade simulation: new immutable revision row (slice A revision
      // writer is PKG06 scope, so direct rows), CAS the install onto it, link
      // the new revision's skills, and re-grant (generation 2) both skills.
      await fixture.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
        );
        await tx.execute(
          sql`insert into enterprise_package_revisions
                (tenant_id, install_id, revision, release_version, artifact_digest, config, created_by)
              values (${companyA}, ${installId}, 2, '2.0.0', ${digestV2}, '{}'::jsonb, ${adminPrincipal})`,
        );
        // A re-grant supersedes: the previous active rows are revoked before
        // generation 2 is written (the grants service's own discipline).
        await tx.execute(
          sql`update enterprise_package_grants set revoked_at = now()
              where tenant_id = ${companyA} and install_id = ${installId}
                and bot_id = ${botId} and revoked_at is null`,
        );
        for (const skill of [SKILL_A, SKILL_B]) {
          await tx.execute(
            sql`insert into enterprise_package_resource_links
                  (tenant_id, install_id, revision, resource_id, workspace_id, kind)
                values (${companyA}, ${installId}, 2, ${skill}, ${teamA1}, 'skill')`,
          );
          await tx.execute(
            sql`insert into enterprise_package_grants
                  (tenant_id, install_id, generation, bot_id, resource_id, workspace_id,
                   resource_kind, tool_ref, granted_by)
                values (${companyA}, ${installId}, 2, ${botId}, ${skill}, ${teamA1}, 'skill', '', ${adminPrincipal})`,
          );
        }
        await tx.execute(
          sql`update enterprise_package_installs
              set revision = 2, current_version = '2.0.0'
              where tenant_id = ${companyA} and id = ${installId}`,
        );
      });

      // The OLD run keeps serving the OLD revision's content; SKILL_B exists
      // only in the new revision and is not in the pin → refused even though
      // the live grant now allows it.
      const oldRead = await runtime.readPinnedSkills(scopeA1, {
        botId,
        runId: oldRunId,
        attemptGeneration: 1,
      });
      expect(oldRead.map((skill) => skill.slug)).toEqual([
        `pkg:${installId}:${SKILL_A}`,
      ]);
      expect(oldRead[0]?.title).toBe("PKG03B v1 name");
      expect(oldRead[0]?.summary).toBe("PKG03B v1 name summary");

      // A run created AFTER the upgrade pins the NEW revision.
      const newRunId = await seedRun({ botId });
      const newSnapshot = await withinRunTx(scopeA1, (tx) =>
        runtime.prepareWithin(tx, scopeA1, {
          botId,
          runId: newRunId,
          attemptGeneration: 1,
        }),
      );
      expect(newSnapshot.pins).toMatchObject([
        {
          installId,
          installGeneration: 1,
          revision: 2,
          artifactDigest: digestV2,
          grantRevision: 2,
          allowedResourceIds: [SKILL_A, SKILL_B],
        },
      ]);
      const newRead = await runtime.readPinnedSkills(scopeA1, {
        botId,
        runId: newRunId,
        attemptGeneration: 1,
      });
      expect(newRead.map((skill) => skill.slug).sort()).toEqual([
        `pkg:${installId}:${SKILL_A}`,
        `pkg:${installId}:${SKILL_B}`,
      ]);
      expect(newRead[0]?.title).toBe("PKG03B v2 name");
    },
  );

  itDb("another tenant's scope reads nothing from a pinned run", async () => {
    const botId = await seedBot();
    await seedInstall({ digest: digestV1, skills: [SKILL_A], botId });
    const runId = await seedRun({ botId });
    await withinRunTx(scopeA1, (tx) =>
      runtime.prepareWithin(tx, scopeA1, {
        botId,
        runId,
        attemptGeneration: 1,
      }),
    );
    // Positive control first: the owning scope DOES read the pin.
    expect(
      (
        await runtime.readPinnedSkills(scopeA1, {
          botId,
          runId,
          attemptGeneration: 1,
        })
      ).length,
    ).toBe(1);
    // The cross-tenant arm: company B's trusted scope gets an empty set.
    expect(
      await runtime.readPinnedSkills(scopeB, {
        botId,
        runId,
        attemptGeneration: 1,
      }),
    ).toEqual([]);
  });

  itDb(
    "run admission refuses a granted Bot whose business ownership no longer resolves (AC5)",
    async () => {
      const botId = await seedBot();
      const installId = await seedInstall({
        digest: digestV1,
        skills: [SKILL_A],
        botId,
      });
      // Positive control: the owned expert Bot binds and pins normally.
      const boundRun = await seedRun({ botId });
      const bound = await withinRunTx(scopeA1, (tx) =>
        runtime.prepareWithin(tx, scopeA1, {
          botId,
          runId: boundRun,
          attemptGeneration: 1,
        }),
      );
      expect(bound.pins.length).toBe(1);

      // The ownership row drifts away (soft delete): the NEXT run start for
      // the still-granted Bot refuses loudly. Grants without a resolvable
      // execution scope (ADR 0006) never start a run — the refusal throws
      // inside the caller's transaction, so nothing pins.
      await fixture.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${companyA}, true), set_config('app.workspace_id', ${teamA1}, true)`,
        );
        await tx.execute(
          sql`update enterprise_bot_ownership set status = 'deleted'
              where tenant_id = ${companyA} and agent_id = ${botId}`,
        );
      });
      const driftedRun = await seedRun({ botId });
      const state = await thrownMessage(
        withinRunTx(scopeA1, (tx) =>
          runtime.prepareWithin(tx, scopeA1, {
            botId,
            runId: driftedRun,
            attemptGeneration: 1,
          }),
        ),
      );
      expect(state).toContain("PACKAGE_BOT_SCOPE_UNAVAILABLE");
      expect(await pinCount(installId)).toBe(1);
    },
  );

  itDb(
    "revoking the initiator's membership refuses the next pinned read (AC4)",
    async () => {
      // a1-member is the fixture's own team-a1 member; the scope below is a
      // real trusted scope for that principal.
      const memberScope = await fixture.scopeFor("a1-member", "team-a1");
      const botId = await seedBot();
      const installId = await seedInstall({
        digest: digestV1,
        skills: [SKILL_A],
        botId,
      });
      const runId = await seedRun({
        botId,
        principalId: memberScope.principalId,
      });
      await withinRunTx(memberScope, (tx) =>
        runtime.prepareWithin(tx, memberScope, {
          botId,
          runId,
          attemptGeneration: 1,
        }),
      );
      // Positive control: the active member's read serves the pinned skill.
      expect(
        (
          await runtime.readPinnedSkills(memberScope, {
            botId,
            runId,
            attemptGeneration: 1,
          })
        ).map((skill) => skill.slug),
      ).toEqual([`pkg:${installId}:${SKILL_A}`]);

      // The team membership is suspended. Arrangement stand-in (superuser,
      // disclosed): the membership lifecycle writer is the identity domain's
      // own surface — the arm under test is the READ-side revalidation, which
      // runs through the real restricted data role.
      const suspend = (status: "suspended" | "active") =>
        setup.$client.unsafe(
          `update enterprise_workspace_memberships set status = $4
           where tenant_id = $1 and workspace_id = $2 and principal_id = $3`,
          [companyA, teamA1, memberScope.principalId, status],
        );
      await suspend("suspended");
      expect(
        await runtime.readPinnedSkills(memberScope, {
          botId,
          runId,
          attemptGeneration: 1,
        }),
      ).toEqual([]);
      // Restored, the very next read serves again — every read revalidates,
      // zero cache in either direction.
      await suspend("active");
      expect(
        (
          await runtime.readPinnedSkills(memberScope, {
            botId,
            runId,
            attemptGeneration: 1,
          })
        ).map((skill) => skill.slug),
      ).toEqual([`pkg:${installId}:${SKILL_A}`]);
    },
  );

  itDb("the pinned read is bound to the run's admitted Bot (L-3)", async () => {
    const botId = await seedBot();
    await seedInstall({ digest: digestV1, skills: [SKILL_A], botId });
    const runId = await seedRun({ botId });
    await withinRunTx(scopeA1, (tx) =>
      runtime.prepareWithin(tx, scopeA1, {
        botId,
        runId,
        attemptGeneration: 1,
      }),
    );
    // A second, owned Bot of the SAME workspace naming the first Bot's run
    // is a contract violation: the pins belong to the admitted Bot only,
    // and the (runId, attempt) → admitted bot binding refuses loudly.
    const otherBot = await seedBot();
    const state = await thrownMessage(
      runtime.readPinnedSkills(scopeA1, {
        botId: otherBot,
        runId,
        attemptGeneration: 1,
      }),
    );
    expect(state).toContain("INPUT_INVALID");
  });

  itDb(
    "the pins table exposes the minimal privilege shape to the three roles",
    async () => {
      expect(
        await fixture.probes.tableExists("enterprise_run_package_pins"),
      ).toBe(true);
      const flags = await fixture.probes.rlsFlags(
        "enterprise_run_package_pins",
      );
      expect(flags.relrowsecurity).toBe(true);
      expect(flags.relforcerowsecurity).toBe(true);
      const columns = await fixture.probes.columnsOf(
        "enterprise_run_package_pins",
      );
      for (const column of [
        "tenant_id",
        "run_id",
        "attempt_generation",
        "install_id",
        "workspace_id",
        "revision",
        "release_digest",
        "grant_revision",
        "allowed_resource_ids",
        "pinned_at",
      ]) {
        expect(columns).toContain(column);
      }
      for (const role of ["ob_ent_data", "ob_ent_operator"] as const) {
        expect(
          await fixture.probes.hasPrivilege(
            "enterprise_run_package_pins",
            role,
            "SELECT",
          ),
        ).toBe(true);
        expect(
          await fixture.probes.hasPrivilege(
            "enterprise_run_package_pins",
            role,
            "INSERT",
          ),
        ).toBe(true);
        for (const privilege of ["UPDATE", "DELETE"] as const) {
          expect(
            await fixture.probes.hasPrivilege(
              "enterprise_run_package_pins",
              role,
              privilege,
            ),
          ).toBe(false);
        }
      }
      for (const privilege of [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
      ] as const) {
        expect(
          await fixture.probes.hasPrivilege(
            "enterprise_run_package_pins",
            "ob_ent_directory",
            privilege,
          ),
        ).toBe(false);
      }
      // The compound run FK pins the pin to its run's tenant.
      const runPk = (await setup.$client.unsafe(
        `select conkey::int[] as cols from pg_constraint
         where conname = 'enterprise_run_package_pin_run_fk'`,
      )) as unknown as Array<{ cols: number[] }>;
      expect(runPk[0]?.cols?.length).toBe(2);
    },
  );
});
