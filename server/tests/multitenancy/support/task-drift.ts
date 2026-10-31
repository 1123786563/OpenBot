/**
 * MT 任务链与 drizzle 基线的漂移调和（测试基建，仅测试库）。
 *
 * 实现自 T00 基线 B-1 上移到工具本体（server/scripts/multitenancy/
 * migrate-test.ts 的 reconcile-drift 命令），本模块保留为 seam 转发：调用方
 * （package-install 的链前调和、task-drift.test.ts 的规则测试）不改导入路径。
 * 规则与约束的完整叙述见工具侧注释。
 */

export {
  reconcileTaskDrift,
  type TaskDriftSqlClient,
  type TaskDriftReport,
} from "../../../scripts/multitenancy/migrate-test";
