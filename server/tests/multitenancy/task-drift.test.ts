/**
 * 约束预删 vs 断点续跑（OCR R6-H5）。
 *
 * PKG03/PKG04 的 `enterprise_package_change_action`（PKG03 还有 grant 主键）在
 * 同一步骤里 drop→add。`reconcileTaskDrift` 若把它当 0163 漂移残留先删掉，重放
 * 到该步自己的 `DROP CONSTRAINT`（没有 IF EXISTS）就撞 does not exist，该步
 * 永不入账，下次已无约束可预删而 DROP 依旧失败 —— 逐步入账的续跑永久卡死。
 * 这里是解析层的断言，用内存假客户端，不需要数据库。
 */
import { describe, expect, test } from "../../../tests/support/e2e-compat";
import { buildPlan } from "../../scripts/multitenancy/migrate-test";
import {
  reconcileTaskDrift,
  type TaskDriftSqlClient,
} from "./support/task-drift";

function fakeClient(
  applied: ReadonlySet<number>,
  constraints: readonly string[],
) {
  const statements: string[] = [];
  const client: TaskDriftSqlClient = {
    async unsafe(query: string, params?: unknown[]) {
      statements.push(query);
      if (query.includes("mt_task_migration_journal"))
        return [...applied].map((number) => ({ number }));
      if (query.includes("pg_constraint"))
        return constraints.includes(String(params?.[0])) ? [{ exists: 1 }] : [];
      return [];
    },
  };
  return { client, statements };
}

/** 已入账 = 目标步骤之前的步骤（该步骤失败在上半句 DROP 之后的续跑形态）。 */
function appliedBefore(taskId: string, slug: string): Set<number> {
  const steps = buildPlan(taskId).steps;
  const target = steps.find((step) => step.slug === slug);
  if (!target) throw new Error(`${taskId} has no step ${slug}`);
  return new Set(
    steps
      .filter((step) => step.number < target.number)
      .map((step) => step.number),
  );
}

describe("reconcileTaskDrift", () => {
  test("a constraint the pending step drops itself is not pre-dropped", async () => {
    const { client, statements } = fakeClient(
      appliedBefore("PKG03", "package_changes_grant_actions"),
      ["enterprise_package_change_action"],
    );
    const report = await reconcileTaskDrift(client, ["PKG03"]);
    expect(report.droppedConstraints).toEqual([]);
    expect(
      statements.filter((query) => /drop constraint/i.test(query)),
    ).toEqual([]);
  });

  test("a constraint no pending step drops is still pre-dropped", async () => {
    const { client } = fakeClient(new Set(), [
      "enterprise_package_expert_created_by_fk",
    ]);
    const report = await reconcileTaskDrift(client, ["PKG04"]);
    expect(report.droppedConstraints).toEqual([
      "enterprise_package_experts.enterprise_package_expert_created_by_fk",
    ]);
  });
});
