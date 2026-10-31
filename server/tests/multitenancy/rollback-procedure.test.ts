// server/tests/multitenancy/rollback-procedure.test.ts
// MT121（Issue #164）：冻结写入、备份、恢复、失败隔离与回退程序（含演练）。
//
// 真实 PostgreSQL（openbot_enterprise_* 专用库，setup/属主连接——工具语义）
// 上钉死票面四条验收；缺 env 显式 skip、skipped 不计通过：
//   AC1 程序五步各有明确判定条件（freeze/backup/restore/isolation/gate）；
//   AC2 演练真实执行：逐步计时 + 逐步数据量 + 问题清单（结构断言 +
//      影子恢复对照的真实数据搬运）；
//   AC3 回退门两条硬判定：多公司数据 ⇒ 必须仍支持隔离的版本（拒绝）；
//      飞行事实未清 ⇒ 必须先停止业务入口与任务执行（拒绝）；
//   AC4 演练发现的可修复问题在本票内修正（problems 为空 = 无遗留；
//      发现即修的记录见报告）。
// 判定面：server/src/enterprise/tenancy/rollback-procedure.ts。

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { resolveTestDatabaseTarget } from "../../scripts/multitenancy/migrate-test";
import { createDatabase, type Database } from "../../src/db/client";
import {
  evaluateRollbackGate,
  MULTITENANCY_ROLLBACK_PROCEDURE,
  runRollbackDrill,
} from "../../src/enterprise/tenancy/rollback-procedure";
import { enterpriseTestDatabaseUrlFrom } from "../support/enterprise-database";

const ENV_OK =
  !!process.env.ENTERPRISE_TEST_SETUP_DATABASE_URL?.trim() ||
  !!process.env.TEST_DATABASE_URL?.trim();
const itDb = ((
  name: string,
  fn: () => void | Promise<void>,
  timeout?: number,
) =>
  ENV_OK
    ? test(name, fn, timeout)
    : test.skip(
        `${name} [skipped: dedicated enterprise test database env absent]`,
        fn,
        timeout,
      )) as typeof test;
const describeDb = ENV_OK ? describe : describe.skip;

let setup: Database;
let runTag = "";
let fixtureTenantId = "";
let fixtureWorkspaceId = "";

beforeAll(async () => {
  if (!ENV_OK) return;
  if (!resolveTestDatabaseTarget(process.env).ok) {
    throw new Error("MT121 refuses: TEST_DATABASE_URL invalid");
  }
  setup = createDatabase(enterpriseTestDatabaseUrlFrom(process.env), {
    max: 2,
  });
  runTag = `mt121-${randomUUID().slice(0, 8)}`;
  // 订阅夹具的公司/团队由本套件自种：CI 预迁移用 adopt-existing 把 MT112
  // 数据步 journal 成 up-to-date，锚点行可能从未写入（零 users 时静态 SQL
  // 不产行），不能拿 enterprise_deployment_anchors 当夹具来源。
  fixtureTenantId = `${runTag}-fixture`;
  fixtureWorkspaceId = `${runTag}-fixture-team`;
  await setup.execute(sql`
    insert into enterprise_tenants (id, name)
    values (${fixtureTenantId}, 'MT121 Fixture Company')
    on conflict (id) do nothing
  `);
  await setup.execute(sql`
    insert into enterprise_workspaces (tenant_id, id, name)
    values (${fixtureTenantId}, ${fixtureWorkspaceId}, 'MT121 Fixture Team')
    on conflict (tenant_id, id) do nothing
  `);
});

afterAll(async () => {
  if (!setup) return;
  // 本套件种的判定面行（他套件残留不碰）。
  await setup.execute(
    sql`delete from enterprise_resources where tenant_id like ${`${runTag}%`}`,
  );
  await setup.execute(
    sql`delete from enterprise_workspaces where tenant_id like ${`${runTag}%`}`,
  );
  await setup.execute(
    sql`delete from enterprise_tenants where id like ${`${runTag}%`}`,
  );
  await setup.execute(sql`drop schema if exists mt121_drill_restore cascade`);
  await setup.$client.close();
});

describeDb("MT121 rollback procedure (Issue #164)", () => {
  // ---- AC1：程序覆盖每一步且有明确判定条件 ----
  describeDb(
    "AC1 the procedure covers every step with explicit criteria",
    () => {
      itDb(
        "five steps in execution order, each with criteria and execution",
        () => {
          expect(
            MULTITENANCY_ROLLBACK_PROCEDURE.map((step) => step.id),
          ).toEqual([
            "freeze-writes",
            "backup",
            "restore",
            "failure-isolation",
            "rollback-gate",
          ]);
          for (const step of MULTITENANCY_ROLLBACK_PROCEDURE) {
            expect(step.name.trim()).toBeTruthy();
            // 判定条件必须点名可数事实或明确规则（不是「视情况而定」）。
            expect(step.criteria.length).toBeGreaterThan(20);
            expect(step.execution.trim()).toBeTruthy();
          }
          // 关键规则在判定条件里逐字在场（AC3 的文档半边）。
          const gateCriteria = MULTITENANCY_ROLLBACK_PROCEDURE.find(
            (step) => step.id === "rollback-gate",
          )?.criteria;
          expect(gateCriteria).toContain("回退到不理解归属的旧版本");
          expect(gateCriteria).toContain("必须先停止业务入口与任务执行");
        },
      );
    },
  );

  // ---- AC2：演练真实执行（耗时 + 数据量 + 问题） ----
  describeDb("AC2 the drill executes against the real database", () => {
    itDb(
      "every step is timed and measured; problems are recorded honestly",
      async () => {
        const drill = await runRollbackDrill(setup);
        expect(drill.databaseName).toContain("openbot_enterprise_");
        expect(drill.steps.map((step) => step.stepId)).toEqual(
          MULTITENANCY_ROLLBACK_PROCEDURE.map((step) => step.id),
        );
        for (const step of drill.steps) {
          expect(step.durationMs).toBeGreaterThanOrEqual(0);
          expect(Object.keys(step.measured).length).toBeGreaterThan(0);
        }
        // 备份/恢复/隔离逐步数据量在场。
        const backup = drill.steps.find((step) => step.stepId === "backup");
        expect(Number(backup?.measured.tablesPresent)).toBeGreaterThan(0);
        const restore = drill.steps.find((step) => step.stepId === "restore");
        expect(Number(restore?.measured.tablesRestored)).toBe(
          Number(backup?.measured.tablesPresent),
        );
        const isolation = drill.steps.find(
          (step) => step.stepId === "failure-isolation",
        );
        expect(Number(isolation?.measured.orphanTenantRows)).toBe(0);
        // 演练后影子模式清场（不留演练对象）。
        const shadow = (await setup.execute(
          sql`select count(*)::int as n from pg_namespace where nspname = 'mt121_drill_restore'`,
        )) as unknown as { n: number }[];
        expect(Number(shadow[0]?.n ?? 0)).toBe(0);
        // AC4：演练发现的可修复问题在本票内修正（此刻应为空；发现记录见报告）。
        expect(drill.problems).toEqual([]);
        expect(drill.overallPass).toBe(true);
      },
      // 全表摘要随共享库残留增长（实测 12s+ 在满目录轮之后），60s 上限。
      60000,
    );

    itDb(
      "the drill is repeatable (same database, same verdicts)",
      async () => {
        const first = await runRollbackDrill(setup);
        const second = await runRollbackDrill(setup);
        expect(second.overallPass).toBe(first.overallPass);
        expect(second.steps.map((s) => s.pass)).toEqual(
          first.steps.map((s) => s.pass),
        );
      },
      60000,
    );
  });

  // ---- 回退门缺表容错的判别面（fail-closed，不把「测不到」当「测过为零」）----
  describe("the gate tolerates only missing tables, never measurement failures", () => {
    /**
     * evaluateRollbackGate 的 execute 次序：3 张可归属表 → job_leases →
     * 订阅数。前 N 次成功（0 行/0 计数），第 failAt 次抛 failure。
     */
    function databaseFailingAt(failAt: number, failure: () => Error): Database {
      let calls = 0;
      return {
        execute: async () => {
          calls += 1;
          if (calls === failAt) throw failure();
          return [{ n: 0 }];
        },
      } as unknown as Database;
    }

    test("an unreachable database rejects the gate instead of allowing rollback", async () => {
      await expect(
        evaluateRollbackGate(
          databaseFailingAt(
            1,
            () => new Error("Failed query: select … (connection refused)"),
          ),
        ),
      ).rejects.toThrow(/connection refused/);
    });

    test("a measurement failure on the subscription count also rejects (no swallowed stop-first)", async () => {
      await expect(
        evaluateRollbackGate(
          databaseFailingAt(
            5,
            () => new Error("Failed query: select count(*) … (terminated)"),
          ),
        ),
      ).rejects.toThrow(/terminated/);
    });

    test("a genuinely missing table still degrades honestly to zero (missing ≠ failure)", async () => {
      const missingTable = () => {
        const cause = Object.assign(
          new Error('relation "public.enterprise_resources" does not exist'),
          {
            name: "PostgresError",
            errno: "42P01",
          },
        );
        return new Error(
          "Failed query: select count(distinct tenant_id)::int as n",
          {
            cause,
          } as ErrorOptions,
        );
      };
      // 第 1 次（enterprise_resources）缺表；其余成功。
      const gate = await evaluateRollbackGate(
        databaseFailingAt(1, missingTable),
      );
      expect(
        gate.measured.tenantsPerTable.map((row) => row.table),
      ).not.toContain("enterprise_resources");
      // 第 5 次（订阅计数）缺表：订阅按 0 计。
      const gateSubscriptions = await evaluateRollbackGate(
        databaseFailingAt(5, missingTable),
      );
      expect(gateSubscriptions.measured.activeEventSubscriptions).toBe(0);
    });
  });

  // ---- AC3：回退门两条硬判定 ----
  describeDb("AC3 the rollback gate enforces both hard rules", () => {
    itDb(
      "multi-company data forces the isolation-aware version (refusal)",
      async () => {
        // 种第二家公司（带可归属业务行）→ 多公司事实 → 拒绝回退。
        await setup.execute(sql`
        insert into enterprise_tenants (id, name)
        values (${`${runTag}-company`}, 'MT121 Drill Company')
        on conflict (id) do nothing
      `);
        await setup.execute(sql`
        insert into enterprise_workspaces (tenant_id, id, name)
        values (${`${runTag}-company`}, ${`${runTag}-team`}, 'MT121 Drill Team')
        on conflict (tenant_id, id) do nothing
      `);
        await setup.execute(sql`
        insert into enterprise_resources (tenant_id, id, workspace_id, kind, display_name, visibility, status)
        values (${`${runTag}-company`}, ${`${runTag}-res-1`}, ${`${runTag}-team`}, 'bot', 'MT121 drill row', 'private', 'active')
        on conflict (tenant_id, id) do nothing
      `);
        const gate = await evaluateRollbackGate(setup);
        expect(gate.singleCompanyOnly).toBe(false);
        expect(gate.allowed).toBe(false);
        expect(gate.refusal).toContain("必须使用仍支持隔离的版本");
        // 判定数据量在场：逐表公司数至少含本套件种的那一家。
        const resources = gate.measured.tenantsPerTable.find(
          (row) => row.table === "enterprise_resources",
        );
        expect(resources?.tenants).toBeGreaterThanOrEqual(2);
      },
    );

    itDb(
      "in-flight work forces stop-first (no rollback over flying writes)",
      async () => {
        // 种一个活跃事件订阅（MT025 的订阅行形状）→ 停止前置未满足。
        await setup.execute(sql`
        insert into enterprise_resources (tenant_id, id, workspace_id, kind, display_name, status)
        values (${fixtureTenantId}, ${`${runTag}-sub-live`}, ${fixtureWorkspaceId}, 'event-subscription', ${`${runTag}-thread`}, 'active')
        on conflict (tenant_id, id) do nothing
      `);
        try {
          const gate = await evaluateRollbackGate(setup);
          expect(gate.stopFirstSatisfied).toBe(false);
          expect(gate.allowed).toBe(false);
          expect(gate.refusal).toContain("必须先停止业务入口与任务执行");
        } finally {
          await setup.execute(
            sql`delete from enterprise_resources where id = ${`${runTag}-sub-live`}`,
          );
        }
      },
    );

    itDb(
      "both refusals are listed together (list-all discipline)",
      async () => {
        // 上一例已删订阅；再种回多公司事实并叠加订阅 → 两条理由一次列全。
        await setup.execute(sql`
        insert into enterprise_resources (tenant_id, id, workspace_id, kind, display_name, status)
        values (${fixtureTenantId}, ${`${runTag}-sub-live2`}, ${fixtureWorkspaceId}, 'event-subscription', ${`${runTag}-thread-2`}, 'active')
        on conflict (tenant_id, id) do nothing
      `);
        try {
          const gate = await evaluateRollbackGate(setup);
          expect(gate.refusal).toContain("仍支持隔离的版本");
          expect(gate.refusal).toContain("必须先停止业务入口与任务执行");
        } finally {
          await setup.execute(
            sql`delete from enterprise_resources where id = ${`${runTag}-sub-live2`}`,
          );
        }
      },
    );
  });
});
