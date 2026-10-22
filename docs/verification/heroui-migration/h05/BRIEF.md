# H05 Task Brief — frontend_implementer（模型目录、网关与凭据管理）

工作目录（唯一写入范围）：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`
授权来源：父 Issue #443 委派提示词（实施已授权；#448 票面"尚未授权实施"为旧状态）。不 commit/push。

## 必读（按序）
1. `docs/tickets/heroui-migration/issues/h05.md`（范围、AC1–AC4、路由/组件清单）
2. `docs/adr/0008-test-runner-tester-army-e2e.md`（跑任何测试前）
3. `docs/verification/heroui-migration/h03/REPORT.md` 的「下游 Interface」节
4. `docs/verification/heroui-migration/LEDGER.md` 2026-10-20 段（已知红清单+环境坑）

## 上游 Interface（冻结，只消费不改）
- `app/src/components/ui/*` 27 个 primitives 已 HeroUI v3 化。禁止修改 `ui/*`、`package.json`/`bun.lock`、`main.tsx`/`__root.tsx`、`styles/*`、`lib/theme.ts`。缺口→域内 Adapter/调用端迁移 + REPORT 记 Interface 变更申请。
- Dialog 原导出与 props 不变；Select/ComboBox `value`/`onValueChange` 领域值合同（不 String() 强转、不 any、保留空值）；Dropdown/Tooltip 导出面不变。
- 链接一律 `@/components/ui/router-link` 的 `ButtonLink`。

## 范围（主所有权）
- 路由：`admin/bot-services.tsx`、`admin/credentials.tsx`、`admin/gateway.tsx`、`admin/model-catalog.tsx` 及其实际 import 的管理视图模块。
- 组件：`app/src/components/admin/model-billing-paths.tsx` 及上述路由消费的 admin 组件。
- 不改网关/Key 协议与服务端合同；`server/scripts/bootstrap-local-gateway.ts` 的 2 个 TS 错误为 server 域 pre-existing（Ledger 有记录），不在本任务修复，仅在 REPORT 提及。

## 合同（AC 对照 h05.md）
- AC1 模型开放/停用、供应商配置、已登记 Bot 增改查路径可用。
- AC2 凭据新增/更新/删除/撤销：输入遮罩、敏感字段不读回、取消后清理。
- AC3 模型选择保留 null/数字/字符串 ID 区分；失效/禁用项明确显示不可选。
- AC4 权限不足/验证失败/网络失败/提交中状态明确；点击一次只提交一次。
- 危险操作（删除凭据等）确认弹窗与焦点返回保持。

## 已知红
- 本域 app 层无已知红（2026-10-20 全量 native 归因）。若跑出红：先单变量归因（是否本任务引入），pre-existing 如实记录不追。

## 验证（全部执行并记录命令+exit code）
- `cd app && bun run typecheck`；`cd app && bun run build`
- native：仓库根 `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h05/native bunx e2e run --config e2e.unit.config.ts`（勿在 app/ 内跑=空集）
- 域内既有测试（model-billing-paths 等）重点核对；变更文件 biome lint/format
- 浏览器证据留待 frontend_validator（代码不得阻塞其验证）

## 交付
`docs/verification/heroui-migration/h05/REPORT.md`（改动清单+要点、AC 状态+证据、命令+exit code、遗留）+ `POST-CHECKPOINT.sha256`（域内改动文件 sha256）。阻塞：记录证据，继续可做部分，不猜不改共享文件。
