# H07 Task Brief — frontend_implementer（公司成员、权限分享、审批与审计）

工作目录（唯一写入范围）：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`
授权来源：父 Issue #443 委派提示词（实施已授权；#450 票面旧状态不适用）。不 commit/push。
前置：H03+H04+H06 已实现并经 W3A/W3B 复审（读 `reviews/REVIEW-W3A-2026-10-20.md`、`REVIEW-W3B-2026-10-20.md` 的 H04/H06 结论与交接项）。

## 必读（按序）
1. `docs/tickets/heroui-migration/issues/h07.md`（范围、AC1–AC5）
2. `docs/adr/0008-test-runner-tester-army-e2e.md`
3. `h06/REPORT.md`「壳契约」节（BotSubpage/BotProfile 三态+返回语义——权限页在壳内）
4. `h04/REPORT.md` 的连接控件复用说明（shared-grant/account-mode 若有 Adapter 约定）
5. `LEDGER.md` 2026-10-20 段

## 上游 Interface（冻结，只消费不改）
- 禁改：`ui/*`、`package.json`/`bun.lock`、`main.tsx`/`__root.tsx`、`styles/*`、`lib/theme.ts`、`preload.ts`、H03–H06/H08/H09/H12/H13 已改文件（见各自 POST-CHECKPOINT，冲突上报不覆盖）。
- H06 交接（必办）：`app/tests/bot-sharing.test.tsx` 1 红（BASE 绿、迁移引入）——`sharing.tsx` 归本任务，修复并入交付。

## 范围（主所有权）
- 路由：_authed/_app/{approvals,bots.$agentId.{access,approvals,sharing}}、admin/{approvals,audit,boundaries,enterprise,identity-providers,people}、settings/approvals。
- 组件：`approvals/*`（bot-rules、inline-approval、rules、settings、shared-use-requests、team-settings、waiting）、`bot-profile/access.tsx`、`bot-profile/sharing.tsx`。

## 合同（AC 对照 h07.md——权限域红线）
- 成员/团队资格/身份源/边界规则既有流程可用；**不能用隐藏控件代替服务端授权**（前端只反映服务端判定）。
- Bot 授权/分享/撤销、批准/拒绝保持资源与动作含义；取消零副作用。
- 审批中/已处理/权限撤销/过期/请求失败反馈明确；**未知状态不得显示为成功**。
- 审计筛选/分页/时间格式/详情读取保持；**不扩大私人内容可见范围**。
- 公司/团队切换后旧内容与异步结果不串入新范围；键盘可完成确认与取消。

## 已知红（须修复或单变量归因）
- `approval-team-settings` 红（2026-10-20 归因落本域）；`bot-sharing.test.tsx` 1 红（H06 交接，迁移引入须修）。pre-existing 勿追：zz-probe 8、heroui-spike、gallery-components（H13 在修）。

## 验证（全部执行并记录命令+exit code）
- `cd app && bun run typecheck`；`cd app && bun run build`
- native：仓库根 `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h07/native bunx e2e run --config e2e.unit.config.ts`
- 重点：multitenancy/selection、shared-grant-dialog、审批相关既有测试
- 变更文件 biome lint/format；BASE 对照 worktree 放 /tmp 且用后删除

## 交付
`h07/REPORT.md` + `POST-CHECKPOINT.sha256`（格式同 h05）。TDD 优先测公共 Seam。阻塞记录证据继续可做部分。
