// server/tests/multitenancy/migrate-adopt.test.ts
// --adopt-existing 的语句计划（adoptingStatementPlan）单测。
//
// 任务建表语句是窄快照，drizzle 全链先建的表是宽现状；adopt 把建表语句展开
// 对齐（drizzle 的列保留、任务的约束补齐）。这里直接用注册表里全部真实的
// CREATE TABLE 语句跑展开，手写样例只覆盖分支形态。

import { describe, expect, test } from "../../../tests/support/e2e-compat";
import {
  adoptingStatementPlan,
  TASKS,
} from "../../scripts/multitenancy/migrate-test";

describe("adoptingStatementPlan：语句形态分支", () => {
  test("CREATE INDEX 先删同名索引再原样建", () => {
    const plan = adoptingStatementPlan(
      'CREATE UNIQUE INDEX "job_leases_kind_object_id_idx" ON "job_leases" ("kind", "object_id");',
      false,
    );
    expect(plan[0]).toBe(
      'DROP INDEX IF EXISTS "job_leases_kind_object_id_idx" CASCADE',
    );
    expect(plan[1]).toContain("CREATE UNIQUE INDEX");
  });

  test("CREATE POLICY 先删同名策略", () => {
    const plan = adoptingStatementPlan(
      'CREATE POLICY "job_leases_data_read" ON "job_leases" AS PERMISSIVE FOR SELECT USING (true);',
      false,
    );
    expect(plan[0]).toBe(
      'DROP POLICY IF EXISTS "job_leases_data_read" ON "job_leases"',
    );
  });

  test("ADD CONSTRAINT 先删同名约束；ADD COLUMN 改写为 IF NOT EXISTS", () => {
    const constraint = adoptingStatementPlan(
      'ALTER TABLE "enterprise_workspaces" ADD CONSTRAINT "enterprise_workspace_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."enterprise_tenants"("id");',
      false,
    );
    expect(constraint[0]).toBe(
      'ALTER TABLE "enterprise_workspaces" DROP CONSTRAINT IF EXISTS "enterprise_workspace_tenant_fk"',
    );
    const column = adoptingStatementPlan(
      'ALTER TABLE "enterprise_resources" ADD COLUMN "visibility" text;',
      false,
    );
    expect(column).toEqual([
      'ALTER TABLE "enterprise_resources" ADD COLUMN IF NOT EXISTS "visibility" text',
    ]);
  });

  test("非 OR REPLACE 的 CREATE FUNCTION 先按签名删；OR REPLACE 原样", () => {
    const fn = adoptingStatementPlan(
      'CREATE FUNCTION "public"."openbot_create_package_expert"("p_tenant_id" text) RETURNS void LANGUAGE sql AS $func$ SELECT 1 $func$;',
      false,
    );
    expect(fn[0]).toBe(
      'DROP FUNCTION IF EXISTS "public"."openbot_create_package_expert"("p_tenant_id" text)',
    );
    const replaceFn = adoptingStatementPlan(
      'CREATE OR REPLACE FUNCTION "public"."ob_ent_reset_business_context"() RETURNS void LANGUAGE sql AS $func$ SELECT 1 $func$;',
      false,
    );
    expect(replaceFn).toHaveLength(1);
  });

  test("GRANT 原样透传", () => {
    const statement = 'GRANT SELECT ON "job_leases" TO "ob_ent_data";';
    expect(adoptingStatementPlan(statement, false)).toEqual([statement]);
  });
});

describe("adoptingStatementPlan：注册表全部建表语句的展开对齐", () => {
  test("表不存在原样；已存在时每个顶层项都落成 ALTER，约束先删后加且无占位残留", () => {
    let expanded = 0;
    for (const [, spec] of TASKS) {
      for (const step of spec.steps) {
        for (const statement of step.statements) {
          if (!/^CREATE TABLE /i.test(statement.trim())) continue;
          expanded += 1;
          expect(adoptingStatementPlan(statement, false)).toEqual([
            statement.trim(),
          ]);
          const plan = adoptingStatementPlan(statement, true);
          expect(plan.length).toBeGreaterThan(0);
          for (const line of plan) {
            expect(line.startsWith("ALTER TABLE ")).toBe(true);
            expect(line).not.toContain("table-placeholder");
          }
          // 约束项必须先 DROP 再 ADD（两段式），列项必须走 IF NOT EXISTS。
          const adds = plan.filter((line) => line.includes(" ADD "));
          const drops = plan.filter((line) => line.includes("DROP CONSTRAINT"));
          for (const drop of drops) {
            const name = drop.match(/DROP CONSTRAINT IF EXISTS "([^"]+)"/)?.[1];
            expect(
              adds.some((line) => line.includes(`ADD CONSTRAINT "${name}"`)),
            ).toBe(true);
          }
          const addColumns = plan.filter((line) => line.includes("ADD COLUMN"));
          expect(
            addColumns.every((line) => line.includes("IF NOT EXISTS")),
          ).toBe(true);
        }
      }
    }
    // 展开路径确实覆盖了注册表的建表语句，而不是空转。
    expect(expanded).toBeGreaterThan(50);
  });
});
