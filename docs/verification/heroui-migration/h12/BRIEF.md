# H12 Task Brief — frontend_implementer（运行记录、评估对比与运维观测）

工作目录（唯一写入范围）：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`
授权来源：父 Issue #443 委派提示词（实施已授权；#455 票面旧状态不适用）。不 commit/push。
前置：H06 已交付 Bot 详情壳 Interface（读 `h06/REPORT.md` 的壳契约节后消费）。

## 必读（按序）
1. `docs/tickets/heroui-migration/issues/h12.md`（范围、AC1–AC4）
2. `docs/adr/0008-test-runner-tester-army-e2e.md`
3. `docs/verification/heroui-migration/h03/REPORT.md`「下游 Interface」节 + `h06/REPORT.md` 壳契约
4. `docs/verification/heroui-migration/LEDGER.md` 2026-10-20 段

## 上游 Interface（冻结，只消费不改）
- 禁改：`ui/*`、`package.json`/`bun.lock`、`main.tsx`/`__root.tsx`、`styles/*`、`lib/theme.ts`、H03–H09/H11 已改文件（见各自 POST-CHECKPOINT，冲突上报不覆盖）。

## 范围（主所有权）
- 路由：bots.$agentId.{datasets,evaluations,evaluations.$datasetId,evaluations.experiment-comparisons,evaluations.experiments.$experimentId.$executionId,exports,runs,runs.$bindingId}、admin/{ai-observability,computers,observability,playground}。
- 组件：`ai-observability/*`（admin-summary、dataset-detail、datasets-list、evaluations-page、experiment-comparison、experiment-results、experiments-section、exports-status、placeholder、run-detail、run-steps、runs-list、state-notice）。

## 合同（AC 对照 h12.md）
- 运行/数据集/评估详情/对比/导出 现有路径与深链接可用。
- 列表筛选/分页/排序/复杂表头/图表/异步状态保持；**不为换库改写查询或 Recharts**。
- 运维连接失败/不可用/无权限/空数据明确；占位数据不当成功。
- 长表格横向滚动局限于容器；焦点与关键动作窄屏/短屏可达。

## 已知红
- 本域 app 层无已知红。server 161 红为 server 域固有（enterprise/knowledge），不属本任务。新红先单变量归因。

## 验证（全部执行并记录命令+exit code）
- `cd app && bun run typecheck`；`cd app && bun run build`
- native：仓库根 `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h12/native bunx e2e run --config e2e.unit.config.ts`
- 变更文件 biome lint/format

## 交付
`h12/REPORT.md` + `POST-CHECKPOINT.sha256`（格式同 h05）。阻塞记录证据继续可做部分。
