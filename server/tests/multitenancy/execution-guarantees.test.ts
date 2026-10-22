// server/tests/multitenancy/execution-guarantees.test.ts
// MT051（Issue #94）：执行上界、审批与机密脱敏的既有保证不回退。
//
// 回归为主的票：既有套件（execution/approvals/redaction 域）在专用库真跑
// 取证（基线与终验记录在 reports/orca-dag-wave3-mt27.md）；本套件把多租
// 户化后最容易回退的三类行为钉死在真实服务面上：
//
//   验收 2（脱敏 × 新归属字段）：执行治理动作（cancel/reset/cull）的审计
//     行只携带归属标识（tenant/workspace/bot/principal），面失败 detail 只
//     落错误类别——即使适配器拿到/抛出的材料含 token/credential 原文，
//     审计与日志文案也一个字节都不带；shared/execution-scope.ts 的
//     describeExecutionScope 只产标识串；审批预览（approvals/types.ts
//     approvalPreview）在携带归属字段的 payload 上原样掩码秘密形状。
//   验收 3（失败注入）：拒绝（适配器 throw）、部分失败（第一面成功第二面
//     抛）、超时（真实 PG：另一会话持同键 advisory 排他锁 → lock_timeout
//     到期）、审计 sink 自身失败——全部不产生跨范围副作用（他 scope 的树
//     原封不动、deny 零传播、cull 候选含他 scope 路径时一个不删）。
//   验收 1（既有保证）：上界与审批的既有行为由基线套件承载（本套件引用
//     其结论）；本套件对「不可见 = 无传播 + canonical 形状」再钉一层。
//
// 证据可复现（票面 AC）——本套件即复现命令：
//   set +x; source /tmp/mt27-env.sh && bun --no-env-file test \
//     server/tests/multitenancy/execution-guarantees.test.ts

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { describeExecutionScope } from "../../../shared/execution-scope";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  buildPlan,
  manifestFor,
  type RunOutcome,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import { approvalPreview } from "../../src/approvals/types";
import { createDatabase } from "../../src/db/client";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  type DataDatabase,
  verifyDataDatabase,
} from "../../src/enterprise/tenancy/connections";
import {
  createExecutionArtifactsService,
  type ExecutionAuditEvent,
  type ExecutionAuditSink,
  type ExecutionSurface,
  type ExecutionTarget,
  executionArtifactDir,
} from "../../src/enterprise/tenancy/execution-artifacts";
import {
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import {
  type BotsOwnershipFixture,
  createBotsOwnershipFixture,
} from "./support/bots-ownership";

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const required = [
    "TEST_DATABASE_URL",
    "ENTERPRISE_TEST_SETUP_DATABASE_URL",
    "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
    "ENTERPRISE_TEST_DATA_DATABASE_URL",
    "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `MT051 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
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
const itDb = ((name: string, fn: () => Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

const canonicalDeny = serializeNotFoundVerdict(notFoundVerdict());

/** In-memory audit recorder (may be made to fail mid-run for AC3). */
function auditRecorder(): ExecutionAuditSink & {
  events(): readonly ExecutionAuditEvent[];
  failFrom(call: number): void;
} {
  const seen: ExecutionAuditEvent[] = [];
  let failAfter = Number.POSITIVE_INFINITY;
  return {
    async record(event) {
      seen.push(event);
      if (seen.length >= failAfter) {
        throw new Error("AUDIT_SINK_DOWN");
      }
    },
    events: () => seen,
    failFrom(call) {
      failAfter = call;
    },
  };
}

let fixture: BotsOwnershipFixture;
let data: DataDatabase;
const closeables: Array<{ close(): void | Promise<void> }> = [];
const generatedDirs: string[] = [];

beforeAll(async () => {
  if (!ENV.ok) return;
  // MT016 的归属表经真实 MT003 工具就位（up-to-date 幂等）。
  const dir = join("/tmp", `mt051-migration-${randomUUID().slice(0, 8)}`);
  generatedDirs.push(dir);
  const manifestDir = join(dir, "MT016");
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(manifestDir, "manifest.json"),
    JSON.stringify(manifestFor(buildPlan("MT016")), null, 2),
  );
  const applied: RunOutcome = await runMigrateTest(
    [
      "migrate",
      "MT016",
      "--apply",
      "--manifest",
      join(manifestDir, "manifest.json"),
    ],
    { environment: process.env, out: () => {} },
  );
  if (!["applied", "up-to-date"].includes(applied.kind)) {
    throw new Error(`MT051 backing apply failed: ${JSON.stringify(applied)}`);
  }

  fixture = await createBotsOwnershipFixture();
  const channel = await verifyDataDatabase(
    createDatabase(enterpriseRuntimeDatabaseUrlFrom("data", process.env), {
      max: 1,
    }),
  );
  data = channel as DataDatabase;
  closeables.push(
    (channel as unknown as { $client: { close(): void } }).$client,
  );
});

afterAll(async () => {
  for (const closeable of closeables.reverse()) {
    await closeable.close();
  }
  await fixture?.dispose();
  for (const dir of generatedDirs)
    await rm(dir, { recursive: true, force: true });
});

const prefix = `mt051-${randomUUID().slice(0, 8)}`;

/** 经真实 MT016 服务种一棵归属行。 */
async function plantBot(scope: PlatformScope, name: string): Promise<string> {
  const botId = `${prefix}-${name}`;
  const outcome = await fixture.service.createBot(scope, {
    agentId: botId,
    displayName: `MT051 ${name}`,
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

/** A1 owner scope 与他 scope（同公司他团队 / 他公司）的三元组。 */
async function scopes() {
  const owner = await fixture.scopeAs(
    "a1-member",
    fixture.ids["company-a"],
    fixture.ids["team-a1"],
  );
  const sameCompanyOtherTeam = await fixture.scopeAs(
    "a2-member",
    fixture.ids["company-a"],
    fixture.ids["team-a2"],
  );
  const otherCompany = await fixture.scopeAs(
    "b1-member",
    fixture.ids["company-b"],
    fixture.ids["team-b1"],
  );
  return { owner, sameCompanyOtherTeam, otherCompany };
}

const SECRET_MATERIAL = "sk-live-SUPERSECRET-candor";
const TOKEN_MATERIAL = "Bearer eyJhbGciOi.example.token";

// ---------------------------------------------------------------------------
// 验收 2：脱敏规则在新归属字段引入后仍生效
// ---------------------------------------------------------------------------

describeDb("MT051 AC2 redaction holds with the new ownership fields", () => {
  itDb(
    "audit rows carry only ownership identifiers, never adapter secrets",
    async () => {
      const { owner } = await scopes();
      const botId = await plantBot(owner, "redact");
      const sink = auditRecorder();
      // 适配器抛出的错误对象里塞满秘密材料——审计行只能落错误类别。
      const surfaces: ExecutionSurface[] = [
        {
          surface: "computer",
          async cancel() {
            throw new Error(
              `gateway refused: password=${SECRET_MATERIAL} ${TOKEN_MATERIAL}`,
            );
          },
          async reset() {
            throw new Error(`reset leaked: ${SECRET_MATERIAL}`);
          },
        },
        {
          surface: "sandbox",
          async cancel() {
            return {
              outcome: "cancelled" as const,
              detail: `session aborted; token=${SECRET_MATERIAL}`,
            };
          },
        },
      ];
      const { service } = makeService(surfaces, sink);
      const cancelled = await service.cancelExecution(owner, botId);
      expect(cancelled).toMatchObject({ outcome: "allow" });
      if (cancelled.outcome !== "allow") return;
      // 失败面 = unavailable + 仅错误类别；成功面的 detail 原样透传是适配器
      // 契约（面内部文案），但审计行本身不含 detail 字段外的任何材料——
      // 断言序列化后的审计零秘密。
      const serialized = JSON.stringify(sink.events());
      expect(serialized).not.toContain(SECRET_MATERIAL);
      expect(serialized).not.toContain("SUPERSECRET");
      expect(serialized).not.toContain("eyJhbGciOi");
      expect(serialized).toContain(fixture.ids["company-a"]);
      expect(serialized).toContain(fixture.ids["team-a1"]);
      const failedAttempt = cancelled.attempts.find(
        (a) => a.outcome === "unavailable",
      );
      expect(failedAttempt?.detail).toBe("Error");
    },
  );

  itDb("describeExecutionScope renders identifiers only", () => {
    const described = describeExecutionScope({
      tenantId: `t-${SECRET_MATERIAL}`,
      workspaceId: "team-a1",
    });
    expect(described).toContain("team-a1");
    // The helper has no channel for secrets at all — pin the shape.
    expect(described).toBe(`tenant t-${SECRET_MATERIAL} workspace team-a1`);
  });

  itDb(
    "approval previews mask secret shapes while ownership fields survive",
    () => {
      const preview = approvalPreview({
        tenantId: "acme",
        workspaceId: "acme-finance",
        botId: "bot-1",
        runId: "run-9",
        password: "hunter2",
        api_key: SECRET_MATERIAL,
        authorization: "Basic dXNlcjpwYXNz",
        command: `deploy --token=${SECRET_MATERIAL}`,
      }) as Record<string, unknown>;
      expect(preview.tenantId).toBe("acme");
      expect(preview.workspaceId).toBe("acme-finance");
      expect(preview.botId).toBe("bot-1");
      expect(preview.runId).toBe("run-9");
      expect(preview.password).toBe("[private value]");
      expect(preview.authorization).toBe("[private value]");
      // 既有词表（基线行为，不改）：按名掩码的键集合是
      // pass|secret|token|authorization|cookie|credential——api_key 不在名
      // 单（它只在字符串值形状里掩码）。回归票钉现状，不上调词表。
      expect(preview.api_key).toBe(SECRET_MATERIAL);
      expect(preview.command).not.toContain(SECRET_MATERIAL);
      expect(String(preview.command)).toContain("token=[private value]");
      // api_key 键名不在名单（现状），但密码与凭据头形状全部掩掉。
      const serialized = JSON.stringify(preview);
      expect(serialized).not.toContain("hunter2");
      expect(serialized).not.toContain("Basic dXNlcjpwYXNz");
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 3：失败注入下不产生跨范围副作用
// ---------------------------------------------------------------------------

describeDb(
  "MT051 AC3 failure injections leave no cross-scope side effects",
  () => {
    itDb(
      "a denied cancel propagates to zero surfaces (invisible = no propagation)",
      async () => {
        const { owner, sameCompanyOtherTeam, otherCompany } = await scopes();
        const botId = await plantBot(owner, "deny-cancel");
        const cancels: ExecutionTarget[] = [];
        const surfaces: ExecutionSurface[] = [
          {
            surface: "computer",
            async cancel(target) {
              cancels.push(target);
              return { outcome: "cancelled" };
            },
          },
        ];
        const sink = auditRecorder();
        const { service } = makeService(surfaces, sink);
        for (const scope of [sameCompanyOtherTeam, otherCompany]) {
          const verdict = await service.cancelExecution(scope, botId);
          expect(JSON.stringify(verdict)).toBe(canonicalDeny);
        }
        expect(cancels).toHaveLength(0);
        expect(
          sink.events().filter((e) => e.outcome === "denied"),
        ).toHaveLength(2);
      },
    );

    itDb(
      "partial surface failure still reaches every surface and stays in scope",
      async () => {
        const { owner } = await scopes();
        const botId = await plantBot(owner, "partial");
        const order: string[] = [];
        const surfaces: ExecutionSurface[] = [
          {
            surface: "first",
            async cancel(target) {
              order.push(`first:${target.botId}`);
              return { outcome: "cancelled" };
            },
          },
          {
            surface: "second",
            async cancel(target) {
              order.push(`second:${target.botId}`);
              throw new Error("boom");
            },
          },
          {
            surface: "third",
            async cancel(target) {
              order.push(`third:${target.botId}`);
              return { outcome: "not-running" };
            },
          },
        ];
        const { service } = makeService(surfaces);
        const outcome = await service.cancelExecution(owner, botId);
        expect(outcome).toMatchObject({ outcome: "allow" });
        expect(order).toEqual([
          `first:${botId}`,
          `second:${botId}`,
          `third:${botId}`,
        ]);
        if (outcome.outcome === "allow") {
          expect(outcome.attempts.map((a) => a.outcome)).toEqual([
            "cancelled",
            "unavailable",
            "not-running",
          ]);
        }
      },
    );

    itDb(
      "a real lock timeout aborts before any side effect (PG-injected)",
      async () => {
        const { owner } = await scopes();
        const botId = await plantBot(owner, "timeout");
        // 另一会话以 session 级排他锁占住 beginContext 会请求的共享锁键——
        // 服务侧 lock_timeout('2s') 到期 → 判定事务失败 → 零传播零审计。
        const blocker = postgres(enterpriseTestDatabaseUrlFrom(), { max: 1 });
        const key = JSON.stringify(["enterprise", "tenant", owner.tenantId]);
        await blocker.unsafe(
          `select pg_advisory_lock(hashtextextended('${key.replace(/'/g, "''")}', 0))`,
        );
        const cancels: ExecutionTarget[] = [];
        const sink = auditRecorder();
        const { service } = makeService(
          [
            {
              surface: "computer",
              async cancel(target) {
                cancels.push(target);
                return { outcome: "cancelled" };
              },
            },
          ],
          sink,
        );
        let threw = "";
        try {
          await service.cancelExecution(owner, botId);
        } catch (error) {
          threw = error instanceof Error ? error.message : String(error);
        }
        await blocker.unsafe(
          `select pg_advisory_unlock(hashtextextended('${key.replace(/'/g, "''")}', 0))`,
        );
        await blocker.end();
        // 判定事务在 lock_timeout('2s') 处真实失败（耗时即证据）；错误链由
        // bun 的 query 包装承载——超时与锁形状都在链上，秘密与归属零回显。
        expect(threw).not.toBe("");
        expect(threw.toLowerCase()).toMatch(
          /timeout|advisory|canceling statement/,
        );
        expect(cancels).toHaveLength(0);
        expect(sink.events()).toHaveLength(0);
      },
    );

    itDb(
      "an audit sink failure never widens the effect (still own-scope only)",
      async () => {
        const { owner, sameCompanyOtherTeam } = await scopes();
        const botId = await plantBot(owner, "sink-fail");
        const sink = auditRecorder();
        sink.failFrom(1); // 第一面成功后的审计行失败。
        const { service } = makeService(
          [
            {
              surface: "computer",
              async cancel() {
                return { outcome: "cancelled" };
              },
            },
          ],
          sink,
        );
        await expect(service.cancelExecution(owner, botId)).rejects.toThrow(
          "AUDIT_SINK_DOWN",
        );
        // 他 scope 的对象依旧不可见且零审计（sink 故障不改变可见性语义）。
        const verdict = await createExecutionArtifactsService({
          data,
          audit: auditRecorder(),
          surfaces: [],
        }).cancelExecution(sameCompanyOtherTeam, botId);
        expect(JSON.stringify(verdict)).toBe(canonicalDeny);
      },
    );

    itDb(
      "cull candidates from other scopes are never removed, even mid-failure",
      async () => {
        const { owner, otherCompany } = await scopes();
        const ownBot = await plantBot(owner, "cull-own");
        const foreignBot = await plantBot(
          await fixture.scopeAs(
            "b1-member",
            fixture.ids["company-b"],
            fixture.ids["team-b1"],
          ),
          "cull-foreign",
        );
        const root = "/mt051-state";
        const ownPath1 = `${executionArtifactDir(root, owner, ownBot)}/snap-1.tar.gz`;
        const ownPath2 = `${executionArtifactDir(root, owner, ownBot)}/snap-2.tar.gz`;
        const foreignPath = `${executionArtifactDir(
          root,
          otherCompany,
          foreignBot,
        )}/snap.tar.gz`;
        const removed: string[] = [];
        const attempted: string[] = [];
        let calls = 0;
        const { service } = makeService([]);
        let threw = "";
        try {
          await service.cullExecutionArtifacts(owner, {
            root,
            candidates: [ownPath1, ownPath2, foreignPath],
            remove: async (path) => {
              calls += 1;
              attempted.push(path);
              if (calls === 1) {
                removed.push(path);
                return;
              }
              throw new Error("REMOVE_FAILED");
            },
          });
        } catch (error) {
          threw = error instanceof Error ? error.message : String(error);
        }
        // 只动本 scope 的候选；他 scope 的路径在 remove 之前就出局（部分失败
        // 时已删的停留已删，未动的永不动）。
        expect(removed).toEqual([ownPath1]);
        expect(attempted).toEqual([ownPath1, ownPath2]);
        expect(attempted).not.toContain(foreignPath);
        expect(threw).toBe("REMOVE_FAILED");
      },
    );
  },
);

// ---------------------------------------------------------------------------
// 验收 1 的回归钉：不可见语义与既有上界行为的形状（基线套件的补充层）
// ---------------------------------------------------------------------------

describeDb("MT051 AC1 regression pins on the delivered guarantees", () => {
  itDb(
    "the canonical deny shape is byte-identical across every denied path",
    async () => {
      const { owner, sameCompanyOtherTeam, otherCompany } = await scopes();
      const botId = await plantBot(owner, "shape");
      const { service } = makeService();
      const verdicts = [
        await service.authorizeExecution(sameCompanyOtherTeam, botId),
        await service.authorizeExecution(otherCompany, botId),
        await service.cancelExecution(sameCompanyOtherTeam, botId),
        await service.resetExecutionWorkspace(otherCompany, botId),
      ];
      for (const verdict of verdicts) {
        expect(JSON.stringify(verdict)).toBe(canonicalDeny);
      }
      // A nonexistent bot in one's own scope: the same shape (no existence leak).
      const missing = await service.authorizeExecution(
        owner,
        `${prefix}-missing`,
      );
      expect(JSON.stringify(missing)).toBe(canonicalDeny);
    },
  );

  itDb(
    "list/download stay scoped under the real RLS reader (deny = empty page)",
    async () => {
      const { owner, otherCompany } = await scopes();
      const botId = await plantBot(owner, "tree");
      const root = "/mt051-tree";
      const ownDir = executionArtifactDir(root, owner, botId);
      const tree = new Map<string, readonly string[]>([
        [ownDir, ["snap-1.tar.gz", "workdir/"]],
        [
          executionArtifactDir(root, otherCompany, "any-bot"),
          ["foreign.tar.gz"],
        ],
      ]);
      const { service } = makeService();
      const own = await service.listExecutionArtifacts(
        owner,
        botId,
        {
          list: async (dir) => tree.get(dir) ?? [],
        },
        root,
      );
      expect(own.entries).toEqual(["snap-1.tar.gz", "workdir/"]);
      const foreign = await service.listExecutionArtifacts(
        otherCompany,
        botId,
        {
          list: async (dir) => tree.get(dir) ?? [],
        },
        root,
      );
      expect(foreign.entries).toEqual([]);
    },
  );
});
