# Task Brief U01：Computer 活动分类、撤回和屏幕 hook

- **Task/AC**: U01 / A05。正式 Issue：[#494](https://github.com/1123786563/OpenBot/issues/494)（本地票 `docs/tickets/upstream-openbot-update/issues/up05.md`）。
- **owner_role**: frontend_implementer（你）。
- **工作区**: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`。所有命令在 worktree 根执行；不得 cd 主 checkout、不得 git stash/commit/push、不派发子 Agent。

## 事实源

1. Spec §3（看屏与工具活动）全部 4 条 + 票据 up05 criteria。
2. 实施计划 I1 接口合约（implementation-plan.md §2 I1）——生产者/消费者签名以它为准。
3. 上游参考（只读，`evidence/upstream-sources/` 下）：
   - `app/src/lib/computers/call.ts`：`OFF_SCREEN_PATHS` 集合（文件/exec 路径不 announce，例外清单而非许可清单——新浏览器路径默认继续 announce）、`reportComputerActivity` 返回 announcement、**仅 403 明确拒绝时** `withdrawComputerActivity`（网络失败/500/abort 不撤回，注释已说明理由）、AbortError→Stopped 语义。
   - `app/src/components/computer/use-auto-watch-screen.ts`：hook 全文（openedFor 只关自己开的面板；dismissed 按 epoch；watching/busy 优先）。
   - `app/src/routes/_authed/_app/channel/$channelId.tsx`：路由接线方式（hook 参数 watching/busy/open/close 如何取自 URL search flags）。
4. 本地现状：`app/src/lib/copilot/computer-activity.ts` 只有 `{botId,epoch}` 与 `reportComputerActivity(botId):void`；`app/src/lib/computers/call.ts` 是旧版（无条件 report，无 announcement/withdrawal）；channel 路由 `:72` 内联订阅 `onComputerActivity` + `dismissedEpoch/runEpoch` refs，面板为 URL flags（watch/settings/workshop 共享一 pane，`show()` 切换）。**本地路径集合以实际 computer API 为准**（核对 /files/*、/exec 等真实 path，含下载类路径），不要盲抄上游清单。

## owned_files

- `app/src/lib/copilot/computer-activity.ts`
- `app/src/lib/computers/call.ts`
- `app/src/components/computer/use-auto-watch-screen.ts`（新建）
- `app/src/routes/_authed/_app/channel/$channelId.tsx`
- `app/tests/auto-watch-screen.test.tsx`（新建）
- `app/tests/computer-screen-announcement.test.ts`（新建）
- `app/tests/computer-activity.test.ts`（既有回归，仅可扩展不可削弱）
- `docs/verification/e2e-bun-suites.json`（仅当新增 suite 需要登记/分组时；先读 `scripts/lib/e2e-manifest.mjs` 理解分组规则，登记后必须与实际执行对账）

## 接口合约（I1，必须严格遵守）

```ts
type Activity = { botId: string; epoch: number; announcement: number };
type Withdrawal = { botId: string; announcement: number };
reportComputerActivity(botId: string): number;
withdrawComputerActivity(botId: string, announcement: number): void;
onComputerActivity(listener: (event: Activity) => void): () => void;
onComputerActivityWithdrawn(listener: (event: Withdrawal) => void): () => void;
```

兼容现有调用者忽略返回值；保留 10 秒静默 epoch 启发式语义（不声称是服务器 runId）。

## 要求（RED→GREEN→REFACTOR）

1. **RED（新测试先行）**：
   - files read/write/list/download、exec 不产生 announcement；navigate/click/type/key/scroll 等显示动作产生。
   - 403（明确拒绝）撤回**同 announcement** 打开的面板；网络错误/500/abort 不撤回。
   - hook：手动面板（busy：settings/workshop 打开）不被抢占；已 watching 不重复开；用户 dismiss 后同 epoch 不再自动开；Bot 切换/卸载清理订阅，旧 Bot 迟到事件无效；openedFor 不匹配的 withdrawal 不关闭面板。
2. **GREEN**：按上游行为适配本地文件；channel 路由改用 `useAutoWatchScreen`，保留 URL pane 语义与既有 `show()` 交互；`callComputer` 签名兼容（现有调用者不改动也能编译）。
3. **验证（V-B，driven 层）**：
   - `bun test ./app/tests/auto-watch-screen.test.tsx`
   - `bun test ./app/tests/computer-screen-announcement.test.ts`
   - `bun test ./app/tests/computer-activity.test.ts`（回归）
   - 统一驱动证据：`E2E_BUN_ONLY=app/tests bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`（注意匹配的是 group.name；核对该轮实际执行的文件数与结果，不得把整组失败说成单文件结论）
   - `bun run typecheck`（app 包）通过。
4. 验证窄屏/键盘关闭路径不被破坏（既有测试或手动证据）；只在确需修复生产返回语义时另立后端 brief 报告，**不得让前端 Agent 改 gateway 权限**。

## 禁止

- 不引入新服务器 Run 权威；不改 gateway/权限；活动数据不持久化；不改消息存储。
- 不修改本 brief 之外文件（locales 若需新词条：本任务不应需要；若确需，停下写报告）。

## 报告

`evidence/u01/implementer-report.md`：改动摘要、本地路径集合核对结果（列实际 OFF_SCREEN_PATHS）、RED/GREEN 证据（命令+用例数）、清单登记与对账、自查、偏差。
