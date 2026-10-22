// server/tests/multitenancy/execution-artifacts.test.ts
// MT047（Issue #90）：执行侧快照、shell、文件、cancel/reset/cull 的归属。
//
// 验收事实源（票面 4 条 AC，逐条对应 describe）：
//   AC1 快照与工作目录按归属命名与隔离；列举与下载都需要授权。
//   AC2 shell 与文件操作以执行业务身份授权，不以机器身份放大权限。
//   AC3 cancel/reset/cull 只对有权主体生效，且操作留审计。
//   AC4 清理任务不会删除其他范围的快照或工作目录。
//
// 两层结构（scan-executor 先例）：纯函数面（命名/隔离/清理过滤器/受信
// grant）不依赖数据库；归属判定与传播面用真实 PostgreSQL（w14b 纪律：
// 受限 ob_ent_* 角色 + 真实 RLS，缺显式 env 整套显式 skip，绝不回退开发
// 库、skipped 不计通过）。DB 面复用 MT016 的 bots-ownership fixture
// （真实 provision + 真实签发入口 scopeAs + 真实 createBot 归属行 + 真实
// MT006 撤权），本套件自建一条受限 data 通道喂 execution-artifacts 服务。

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/e2e-compat";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createDatabase, type Database } from "../../src/db/client";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  assertTrustedExecutionGrant,
  cullableArtifactsInScope,
  createExecutionArtifactsService,
  type ExecutionAuditEvent,
  type ExecutionAuditSink,
  type ExecutionGrant,
  type ExecutionSurface,
  type ExecutionTarget,
  executionArtifactDir,
  executionArtifactRoot,
  parseExecutionArtifactPath,
  scopeOwnsArtifactPath,
} from "../../src/enterprise/tenancy/execution-artifacts";
import { notFoundVerdict } from "../../src/enterprise/tenancy/not-found-semantics";
import { assertTrustedScope } from "../../src/enterprise/tenancy/store";
import {
  buildPlan,
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import {
  verifyDataDatabase,
  type DataDatabase,
} from "../../src/enterprise/tenancy/connections";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import {
  createBotsOwnershipFixture,
  type BotsOwnershipFixture,
} from "./support/bots-ownership";

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const setup =
    process.env.ENTERPRISE_TEST_SETUP_DATABASE_URL ??
    process.env.TEST_DATABASE_URL;
  if (!setup?.trim()) {
    return {
      ok: false,
      reason: "ENTERPRISE_TEST_SETUP_DATABASE_URL/TEST_DATABASE_URL not set",
    };
  }
  for (const role of ["DIRECTORY", "DATA", "OPERATOR"] as const) {
    if (!process.env[`ENTERPRISE_TEST_${role}_DATABASE_URL`]?.trim()) {
      return {
        ok: false,
        reason: `ENTERPRISE_TEST_${role}_DATABASE_URL not set`,
      };
    }
  }
  return { ok: true };
}

const ENV = probeEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

const canonicalDeny = JSON.stringify(notFoundVerdict());

/** In-memory audit recorder: the rows the AC3 audit claim is checked against. */
function auditRecorder(): ExecutionAuditSink & {
  events(): readonly ExecutionAuditEvent[];
} {
  const seen: ExecutionAuditEvent[] = [];
  return {
    async record(event) {
      seen.push(event);
    },
    events: () => seen,
  };
}

// ---------------------------------------------------------------------------
// 纯函数面：命名、隔离与清理过滤（AC1/AC4 的路径半边，无数据库）
// ---------------------------------------------------------------------------

describe("MT047 execution artifact naming and isolation (pure)", () => {
  const scopeA1 = { tenantId: "tenant-a", workspaceId: "team-a1" };

  test("the workspace is named by its ownership: tenants/<t>/workspaces/<w>/bots/<bot>", () => {
    expect(executionArtifactDir("/data", scopeA1, "bot-1")).toBe(
      "/data/tenants/tenant-a/workspaces/team-a1/bots/bot-1",
    );
    expect(executionArtifactRoot("/data", scopeA1)).toBe(
      "/data/tenants/tenant-a/workspaces/team-a1/bots",
    );
  });

  test("a path parses back to exactly its ownership triple", () => {
    expect(
      parseExecutionArtifactPath(
        "/data",
        "/data/tenants/tenant-a/workspaces/team-a1/bots/bot-1/snapshots/s4.tar.gz",
      ),
    ).toEqual({ tenantId: "tenant-a", workspaceId: "team-a1", botId: "bot-1" });
  });

  test("paths that are not ownership-shaped do not parse (no cross-scope reach by shape)", () => {
    const bad = [
      "/data/bots/bot-1", // 部署级旧布局：无归属段
      "/data/tenants/tenant-a/bots/bot-1", // 缺 workspaces 段
      "/data/tenants/tenant-a/workspaces/team-a1/bots", // 缺 bot 段
      "/data/tenants/../workspaces/team-a1/bots/bot-1", // 爬升段
      "/data/tenants/Tenant-A/workspaces/team-a1/bots/bot-1", // 非 plain id
      "/data/tenants/tenant-a/workspaces/team-a1/bots/bot 1", // 空格
      "/elsewhere/tenants/tenant-a/workspaces/team-a1/bots/bot-1", // 别的 root
    ];
    for (const path of bad) {
      expect(parseExecutionArtifactPath("/data", path)).toBeNull();
    }
  });

  test("a scope owns only its own segments: cross-company and cross-team both false", () => {
    expect(
      scopeOwnsArtifactPath(scopeA1, {
        tenantId: "tenant-a",
        workspaceId: "team-a1",
      }),
    ).toBe(true);
    expect(
      scopeOwnsArtifactPath(scopeA1, {
        tenantId: "tenant-a",
        workspaceId: "team-a2",
      }),
    ).toBe(false);
    expect(
      scopeOwnsArtifactPath(scopeA1, {
        tenantId: "tenant-b",
        workspaceId: "team-b1",
      }),
    ).toBe(false);
    expect(scopeOwnsArtifactPath(scopeA1, null)).toBe(false);
  });

  test("the cull filter never hands another scope's path to the remover (AC4)", () => {
    const candidates = [
      "/data/tenants/tenant-a/workspaces/team-a1/bots/bot-1",
      "/data/tenants/tenant-a/workspaces/team-a1/bots/bot-2",
      "/data/tenants/tenant-a/workspaces/team-a2/bots/bot-3",
      "/data/tenants/tenant-b/workspaces/team-b1/bots/bot-4",
      "/data/bots/legacy-bot",
      "/data/tenants/../../etc/bots/bot-5",
    ];
    expect(cullableArtifactsInScope("/data", scopeA1, candidates)).toEqual([
      "/data/tenants/tenant-a/workspaces/team-a1/bots/bot-1",
      "/data/tenants/tenant-a/workspaces/team-a1/bots/bot-2",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 受信执行业务身份（AC2 的信任半边，无数据库）
// ---------------------------------------------------------------------------

describe("MT047 execution grant trust (pure)", () => {
  test("a hand-built grant is not a grant: structure is not trust", () => {
    const forged: ExecutionGrant = {
      tenantId: "tenant-a",
      workspaceId: "team-a1",
      botId: "bot-1",
      principalId: "p1",
    };
    expect(() => assertTrustedExecutionGrant(forged)).toThrow(
      "UNVERIFIED_EXECUTION_GRANT",
    );
    expect(() =>
      assertTrustedExecutionGrant(JSON.parse(JSON.stringify(forged))),
    ).toThrow("UNVERIFIED_EXECUTION_GRANT");
  });

  test("an untrusted scope never reaches the verdict: the issuance entry is the only door", () => {
    // 同形手造 scope（MT005 纪律：结构≠信任）在判定入口就被拒绝。
    const forgedScope = {
      tenantId: "tenant-a",
      workspaceId: "team-a1",
      principalId: "p1",
      actorId: "u1",
      memberEpoch: 1,
      aclEpoch: 1,
      entrypoint: "web",
    } as unknown as PlatformScope;
    expect(() => assertTrustedScope(forgedScope)).toThrow("UNVERIFIED_SCOPE");
  });
});

// ---------------------------------------------------------------------------
// DB 面：归属判定、列举/下载、cancel/reset 传播、撤权、清理（AC1–AC4）
// ---------------------------------------------------------------------------

const generatedDirs: string[] = [];

describeDb(
  "MT047 execution ownership against the real tenancy database",
  () => {
    let fixture: BotsOwnershipFixture;
    let data: DataDatabase;
    let closeables: Array<{ close(): void | Promise<void> }>;

    beforeAll(async () => {
      // The ownership facts this suite reads live in MT016's tables, applied
      // through the real MT003 migrate tool (generate → apply → replay
      // convergent), exactly the way the MT016 suite provisions them.
      if (!resolveTestDatabaseTarget(process.env).ok) {
        throw new Error(
          "MT047 migration target refused: TEST_DATABASE_URL invalid",
        );
      }
      const dir = join("/tmp", `mt047-migration-${randomUUID().slice(0, 8)}`);
      generatedDirs.push(dir);
      const generation = await runMigrateTest(
        ["generate", "MT016", "--out", dir],
        { environment: process.env, out: () => {} },
      );
      if (generation.kind !== "generated") {
        throw new Error(
          `MT047 backing generate failed: ${JSON.stringify(generation)}`,
        );
      }
      const manifestPath = join(dir, "MT016", "manifest.json");
      const applied: RunOutcome = await runMigrateTest(
        ["migrate", "MT016", "--apply", "--manifest", manifestPath],
        { environment: process.env, out: () => {} },
      );
      if (!["applied", "up-to-date"].includes(applied.kind)) {
        throw new Error(
          `MT047 backing apply failed: ${JSON.stringify(applied)}`,
        );
      }

      fixture = await createBotsOwnershipFixture();
      const channel = await verifyDataDatabase(
        createDatabase(enterpriseRuntimeDatabaseUrlFrom("data", process.env), {
          max: 1,
        }),
      );
      data = channel as DataDatabase;
      closeables = [
        (channel as unknown as { $client: { close(): void } }).$client,
      ];
    });

    afterAll(async () => {
      for (const closeable of closeables.reverse()) {
        await closeable.close();
      }
      await fixture?.dispose();
      for (const dir of generatedDirs)
        await rm(dir, { recursive: true, force: true });
    });

    const prefix = `mt047-${randomUUID().slice(0, 8)}`;
    const botIdOf = (name: string) => `${prefix}-${name}`;

    /** Plants one ownership row through the REAL MT016 service. */
    async function plantBot(
      scope: PlatformScope,
      name: string,
    ): Promise<string> {
      const botId = botIdOf(name);
      const outcome = await fixture.service.createBot(scope, {
        agentId: botId,
        displayName: `MT047 ${name}`,
        defaultConfig: {},
      });
      expect(outcome.outcome).toBe("allow");
      return botId;
    }

    function makeService(
      surfaces: readonly ExecutionSurface[] = [],
      sink?: ReturnType<typeof auditRecorder>,
    ) {
      const audit = sink ?? auditRecorder();
      return {
        audit,
        service: createExecutionArtifactsService({ data, audit, surfaces }),
      };
    }

    /** Surfaces that record every call; the propagation assertions read them. */
    function recordingSurfaces(): {
      surfaces: ExecutionSurface[];
      cancels: ExecutionTarget[];
      resets: ExecutionTarget[];
    } {
      const cancels: ExecutionTarget[] = [];
      const resets: ExecutionTarget[] = [];
      return {
        cancels,
        resets,
        surfaces: [
          {
            surface: "computer",
            async cancel(target) {
              cancels.push(target);
              return { outcome: "cancelled" };
            },
            async reset(target) {
              resets.push(target);
              return { outcome: "cleared" };
            },
          },
          {
            surface: "sandbox",
            async cancel(target) {
              cancels.push(target);
              return { outcome: "not-running" };
            },
            // no reset seam: resetExecutionWorkspace skips this surface
          },
        ],
      };
    }

    // ---- AC1: 归属判定 ------------------------------------------------------

    itDb(
      "a team member's authorize mints a trusted grant carrying the ownership",
      async () => {
        const scope = await fixture.scopeAs(
          "a1-member",
          fixture.ids["company-a"],
          fixture.ids["team-a1"],
        );
        const botId = await plantBot(scope, "own");
        const { service } = makeService();
        const verdict = await service.authorizeExecution(scope, botId);
        expect(verdict.outcome).toBe("allow");
        if (verdict.outcome !== "allow") return;
        expect(verdict.grant.tenantId).toBe(fixture.ids["company-a"]);
        expect(verdict.grant.workspaceId).toBe(fixture.ids["team-a1"]);
        expect(verdict.grant.botId).toBe(botId);
        expect(() => assertTrustedExecutionGrant(verdict.grant)).not.toThrow();
      },
    );

    itDb(
      "same company, other team: byte-identical canonical not-found (no existence leak)",
      async () => {
        const owner = await fixture.scopeAs(
          "a1-member",
          fixture.ids["company-a"],
          fixture.ids["team-a1"],
        );
        const botId = await plantBot(owner, "crossteam");
        const a2 = await fixture.scopeAs(
          "a2-member",
          fixture.ids["company-a"],
          fixture.ids["team-a2"],
        );
        const { service } = makeService();
        expect(
          JSON.stringify(await service.authorizeExecution(a2, botId)),
        ).toBe(canonicalDeny);
      },
    );

    itDb("other company: byte-identical canonical not-found", async () => {
      const owner = await fixture.scopeAs(
        "a1-member",
        fixture.ids["company-a"],
        fixture.ids["team-a1"],
      );
      const botId = await plantBot(owner, "crosscompany");
      const b1 = await fixture.scopeAs(
        "b1-member",
        fixture.ids["company-b"],
        fixture.ids["team-b1"],
      );
      const { service } = makeService();
      expect(JSON.stringify(await service.authorizeExecution(b1, botId))).toBe(
        canonicalDeny,
      );
    });

    itDb(
      "a company admin without team membership cannot even mint the team scope",
      async () => {
        // 签发入口（真实 createScopeResolver）拒绝无团队成员资格的 scope：
        // 管理身份不隐含内容访问（Spec §4.1）。
        await expect(
          fixture.scopeAs(
            "company-admin",
            fixture.ids["company-a"],
            fixture.ids["team-a1"],
          ),
        ).rejects.toThrow();
      },
    );

    itDb(
      "revocation takes the next verdict away: a suspended member sees not-found",
      async () => {
        const doomed = await fixture.scopeAs(
          "a1-doomed",
          fixture.ids["company-a"],
          fixture.ids["team-a1"],
        );
        const botId = await plantBot(doomed, "doomed");
        const { service } = makeService();
        expect((await service.authorizeExecution(doomed, botId)).outcome).toBe(
          "allow",
        );
        await fixture.suspendCompanyMembership(
          fixture.ids["company-a"],
          doomed.principalId,
        );
        expect(
          JSON.stringify(await service.authorizeExecution(doomed, botId)),
        ).toBe(canonicalDeny);
      },
    );

    // ---- AC1: 列举与下载 ----------------------------------------------------

    itDb(
      "listing shows the owner's artifacts and hides everything from other scopes",
      async () => {
        const owner = await fixture.scopeAs(
          "a1-member",
          fixture.ids["company-a"],
          fixture.ids["team-a1"],
        );
        const botId = await plantBot(owner, "list");
        const listed: string[] = [];
        const { service } = makeService();
        const page = await service.listExecutionArtifacts(
          owner,
          botId,
          { list: async (dir) => (listed.push(dir), ["snapshots/s1.tar.gz"]) },
          "/data",
        );
        expect(page.entries).toEqual(["snapshots/s1.tar.gz"]);
        expect(listed).toEqual([
          `/data/tenants/${fixture.ids["company-a"]}/workspaces/${fixture.ids["team-a1"]}/bots/${botId}`,
        ]);
        // 跨团队与跨公司：空页（计数 0），lister 一个都没被调用。
        const a2 = await fixture.scopeAs(
          "a2-member",
          fixture.ids["company-a"],
          fixture.ids["team-a2"],
        );
        const b1 = await fixture.scopeAs(
          "b1-member",
          fixture.ids["company-b"],
          fixture.ids["team-b1"],
        );
        listed.length = 0;
        for (const scope of [a2, b1]) {
          const denied = await service.listExecutionArtifacts(
            scope,
            botId,
            { list: async (dir) => (listed.push(dir), ["should-not-appear"]) },
            "/data",
          );
          expect(denied.entries).toEqual([]);
        }
        expect(listed).toEqual([]);
      },
    );

    itDb(
      "download authorizes the owner and refuses another scope's path as not-found",
      async () => {
        const owner = await fixture.scopeAs(
          "a1-member",
          fixture.ids["company-a"],
          fixture.ids["team-a1"],
        );
        const botId = await plantBot(owner, "download");
        const a2 = await fixture.scopeAs(
          "a2-member",
          fixture.ids["company-a"],
          fixture.ids["team-a2"],
        );
        const opened: string[] = [];
        const { service } = makeService();
        const own = await service.downloadExecutionArtifact(owner, botId, {
          artifactPath: `/data/tenants/${fixture.ids["company-a"]}/workspaces/${fixture.ids["team-a1"]}/bots/${botId}/snapshots/s1.tar.gz`,
          root: "/data",
          open: async (path) => (opened.push(path), new Uint8Array([1, 2, 3])),
        });
        expect(own.outcome).toBe("allow");
        if (own.outcome === "allow")
          expect(Array.from(own.bytes)).toEqual([1, 2, 3]);
        // 另一家 scope 的真实存在的路径：not-found，open 不被调用（磁盘零接触）。
        const foreign = await service.downloadExecutionArtifact(a2, botId, {
          artifactPath: `/data/tenants/${fixture.ids["company-a"]}/workspaces/${fixture.ids["team-a2"]}/bots/${botId}/snapshots/s1.tar.gz`,
          root: "/data",
          open: async (path) => (opened.push(path), new Uint8Array([9])),
        });
        expect(JSON.stringify(foreign)).toBe(canonicalDeny);
        // 同 scope 内指向别的 Bot 的路径同样拒绝。
        const strayBot = await service.downloadExecutionArtifact(owner, botId, {
          artifactPath: `/data/tenants/${fixture.ids["company-a"]}/workspaces/${fixture.ids["team-a1"]}/bots/${botIdOf("stranger")}/x`,
          root: "/data",
          open: async (path) => (opened.push(path), new Uint8Array([9])),
        });
        expect(JSON.stringify(strayBot)).toBe(canonicalDeny);
        expect(opened).toEqual([
          `/data/tenants/${fixture.ids["company-a"]}/workspaces/${fixture.ids["team-a1"]}/bots/${botId}/snapshots/s1.tar.gz`,
        ]);
      },
    );

    // ---- AC3: cancel/reset 只对有权主体生效且留审计 --------------------------

    itDb(
      "cancel propagates to every surface for the owner, with the ownership riding along",
      async () => {
        const owner = await fixture.scopeAs(
          "a1-member",
          fixture.ids["company-a"],
          fixture.ids["team-a1"],
        );
        const botId = await plantBot(owner, "cancel");
        const recording = recordingSurfaces();
        const { service, audit } = makeService(recording.surfaces);
        const outcome = await service.cancelExecution(owner, botId, {
          runId: "run-77",
        });
        expect(outcome.outcome).toBe("allow");
        if (outcome.outcome !== "allow") return;
        expect(outcome.attempts.map((a) => a.surface)).toEqual([
          "computer",
          "sandbox",
        ]);
        expect(recording.cancels).toHaveLength(2);
        for (const target of recording.cancels) {
          expect(target.tenantId).toBe(fixture.ids["company-a"]);
          expect(target.workspaceId).toBe(fixture.ids["team-a1"]);
          expect(target.botId).toBe(botId);
          expect(target.runId).toBe("run-77");
        }
        expect(recording.resets).toEqual([]);
        const cancelRows = audit
          .events()
          .filter((event) => event.action === "execution.cancel");
        expect(cancelRows).toHaveLength(1);
        expect(cancelRows[0]?.outcome).toBe("allowed");
        expect(cancelRows[0]?.botId).toBe(botId);
        expect(cancelRows[0]?.tenantId).toBe(fixture.ids["company-a"]);
      },
    );

    itDb("reset reaches only the surfaces that have a reset seam", async () => {
      const owner = await fixture.scopeAs(
        "a1-member",
        fixture.ids["company-a"],
        fixture.ids["team-a1"],
      );
      const botId = await plantBot(owner, "reset");
      const recording = recordingSurfaces();
      const { service } = makeService(recording.surfaces);
      const outcome = await service.resetExecutionWorkspace(owner, botId);
      expect(outcome.outcome).toBe("allow");
      expect(recording.resets).toHaveLength(1); // sandbox has no reset seam
      expect(recording.cancels).toEqual([]);
    });

    itDb(
      "an out-of-scope caller cancels nothing: no surface is touched, audit keeps the denial",
      async () => {
        const owner = await fixture.scopeAs(
          "a1-member",
          fixture.ids["company-a"],
          fixture.ids["team-a1"],
        );
        const botId = await plantBot(owner, "denied-cancel");
        const b1 = await fixture.scopeAs(
          "b1-member",
          fixture.ids["company-b"],
          fixture.ids["team-b1"],
        );
        const recording = recordingSurfaces();
        const { service, audit } = makeService(recording.surfaces);
        const outcome = await service.cancelExecution(b1, botId);
        expect(JSON.stringify(outcome)).toBe(canonicalDeny);
        expect(recording.cancels).toEqual([]);
        expect(recording.resets).toEqual([]);
        const cancelRows = audit
          .events()
          .filter((event) => event.action === "execution.cancel");
        expect(cancelRows).toHaveLength(1);
        expect(cancelRows[0]?.outcome).toBe("denied");
        expect(cancelRows[0]?.tenantId).toBe(fixture.ids["company-b"]);
      },
    );

    itDb(
      "a surface that throws does not stop the others: unavailable, not silent",
      async () => {
        const owner = await fixture.scopeAs(
          "a1-member",
          fixture.ids["company-a"],
          fixture.ids["team-a1"],
        );
        const botId = await plantBot(owner, "flaky");
        const seen: string[] = [];
        const { service } = makeService([
          {
            surface: "computer",
            async cancel() {
              seen.push("computer");
              throw new Error("computer plane down");
            },
          },
          {
            surface: "sandbox",
            async cancel() {
              seen.push("sandbox");
              return { outcome: "cancelled" };
            },
          },
        ]);
        const outcome = await service.cancelExecution(owner, botId);
        expect(outcome.outcome).toBe("allow");
        if (outcome.outcome !== "allow") return;
        expect(seen).toEqual(["computer", "sandbox"]);
        expect(outcome.attempts.map((a) => a.outcome)).toEqual([
          "unavailable",
          "cancelled",
        ]);
      },
    );

    // ---- AC4: 清理不删其他范围 ----------------------------------------------

    itDb(
      "cull removes only this scope's candidates and reports the rest as skipped",
      async () => {
        const owner = await fixture.scopeAs(
          "a1-member",
          fixture.ids["company-a"],
          fixture.ids["team-a1"],
        );
        await plantBot(owner, "cull-a");
        await plantBot(owner, "cull-b");
        const removed: string[] = [];
        const { service, audit } = makeService();
        const candidates = [
          `/data/tenants/${fixture.ids["company-a"]}/workspaces/${fixture.ids["team-a1"]}/bots/${botIdOf("cull-a")}`,
          `/data/tenants/${fixture.ids["company-a"]}/workspaces/${fixture.ids["team-a2"]}/bots/${botIdOf("other-team")}`,
          `/data/tenants/${fixture.ids["company-b"]}/workspaces/${fixture.ids["team-b1"]}/bots/${botIdOf("other-company")}`,
          `/data/bots/legacy`,
          `/data/tenants/${fixture.ids["company-a"]}/workspaces/${fixture.ids["team-a1"]}/bots/${botIdOf("cull-b")}`,
        ];
        const outcome = await service.cullExecutionArtifacts(owner, {
          root: "/data",
          candidates,
          remove: async (path) => {
            removed.push(path);
          },
        });
        expect(outcome.removed).toEqual([
          `/data/tenants/${fixture.ids["company-a"]}/workspaces/${fixture.ids["team-a1"]}/bots/${botIdOf("cull-a")}`,
          `/data/tenants/${fixture.ids["company-a"]}/workspaces/${fixture.ids["team-a1"]}/bots/${botIdOf("cull-b")}`,
        ]);
        expect(outcome.skipped).toHaveLength(3);
        expect(removed).toEqual(outcome.removed);
        expect(
          audit.events().filter((event) => event.action === "execution.cull"),
        ).toHaveLength(1);
      },
    );
  },
);
