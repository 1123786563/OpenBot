# Task Brief L02：验证码持久状态、请求租约与恢复

- **Task/AC**: L02 / A08。正式 Issue：[#496](https://github.com/1123786563/OpenBot/issues/496)（本地票 `docs/tickets/upstream-openbot-update/issues/up08.md`）。
- **owner_role**: backend_implementer（你）。
- **工作区**: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`。不得 cd 主 checkout、不得 git stash/commit/push、不派发子 Agent。**前置**：L01 已 verified（gateway `signInCode`、schema 类型、Computer `/sign-in/code`）。本任务不改 web 表单（L03）。

## 事实源

1. Spec §5 全部 9 条 + up08 criteria 第 2–9 条；实施计划 L02 状态表（implementation-plan.md Task L02 内的 8 行状态转移表——逐行实现）。
2. 上游参考（只读，已分叉按行为对齐）：`evidence/upstream-sources/server/src/passwords/{types,store,service,routes,resume}.ts`、`server/src/db/schema/passwords.ts`。
3. 本地现状：`server/src/db/schema/passwords.ts:88` status check 现为 7 态（pending/filling/taken_over/signed_in/failed/cancelled/expired）；`fillingUntil` lease 字段已有（:84）；**迁移编号**：journal 现到 idx 164（0164），本次用 **`server/drizzle/0165_sign_in_code_step.sql`**，语义照上游 0056（DROP+ADD check 增 `code_required`），并更新 `server/drizzle/meta/_journal.json`。**不复制上游编号 0056，不碰其他在途工作的迁移。**
4. DB 测试环境：docker `openbot-test-pg:5433` / `openbot-enterprise-test-pg:5435` 在跑；`.env` 已就绪；用独立 fixture 库，不重用其他执行流的库。

## owned_files

- `server/src/passwords/{types,store,service,routes,resume}.ts`
- `server/src/computer/schema.ts`（**仅限**删除 L01 标 Deprecated 的 `SignInFillInput.code` 字段——你把 `service.ts` 的 code 发送移除、全树 typecheck 过后，该字段即无生产方，删除它；不改此文件其他内容）
- `server/src/db/schema/passwords.ts`
- `server/src/audit.ts`（仅验证码事件类型与脱敏载荷；最小增量）
- `server/drizzle/0165_sign_in_code_step.sql`（新建）、`server/drizzle/meta/_journal.json`
- `server/tests/passwords-sign-in.test.ts`、`server/tests/passwords-store.integration.test.ts`
- `docs/verification/e2e-bun-suites.json`（如需登记）

## 状态机（逐行实现；一切写回用"预期状态+有效 lease"的条件更新）

| 当前状态/事件 | 下个状态 | 操作 |
|---|---|---|
| pending 提交密码 | filling | CAS 领取，保留 120 秒 lease |
| filling，网站要求 code | code_required | 清空 fillingUntil，不恢复 agent |
| code_required 显式提交 code | filling | CAS 领取，调用 L01 gateway signInCode |
| filling，code 明确错误且字段仍在 | code_required | 保留请求，允许用户明确重试 |
| filling，回密码页 | pending | 明确要求重新登录 |
| filling，确认完成 | signed_in | 执行现有终态恢复机制 |
| 请求取消/到期 | cancelled/expired | 不再接受输入，不自动重放 |
| 已发送后结果不明/lease 到期 | failed | outcome="无法确认是否完成"；不自动重发、不报告成功；用户可接管或知情后新建请求 |

## 要求（RED→GREEN→REFACTOR）

1. **RED**：新状态存取；pending 列表含 code_required、终态（FINAL_SIGN_IN）不含它；两并发 code 提交仅一个 CAS 成功、另一个 409；已取消/到期请求的迟到响应不覆盖终态、不保存密码、不重新恢复 agent；初次 submit/use-saved 收到 code 字段只忽略不输入（L01 契约）；网络不确定不自动重发；到期 lease 从 filling 以 CAS 进入 failed（**禁止现有过期 filling 自动回 pending 导致误重放**——如本地存在该行为，用测试钉住后移除）；service 重启只恢复状态不重调 gateway；明确密码/code 失败且可证明未完成的分支按状态表返回 pending/code_required；code_required 不触发 onResolved、不恢复 headless continuation；signed_in 才走现有终态机制（复用现有防重复恢复边界，不建第二套 queue）。
2. **迁移**：0165 只扩充 check constraint；fresh install 与已有数据升级两条路径都跑（`bun test` 集成层）；不改任何现存迁移文件。
3. **submitCode API**：`SignInService.submitCode(ownerUserId, id, {code})`；OpenBot 路由 `POST /api/sign-in-requests/:id/code`（body `{code}`，字段上限 64；沿用 owner/request/Bot 授权、同源校验、终态拒绝约定）；拒绝错误用户、过期、终态、未到 code_required 的请求。
4. **Deprecated 字段清除（L01 交接义务）**：移除 `passwords/service.ts` 中 SignInFillInput 的 code 发送后，删除 `server/src/computer/schema.ts` 的 `code` 字段；`agent-computer` 侧 L01 已不再读取。删后全树 typecheck 必须通过（app/desktop 无引用，L03 之前的 UI 尚未发送 code 以外的东西——若发现意外引用，停下写报告）。
5. **秘密边界**：code 不落库、不进日志/追踪/聊天；审计事件只含 request/site/method/category（经现有 scrub/清理路径）；密码只在本人明确保存时进既有加密 vault（现有行为不动）；RequestView 继续排除秘密。
6. **验证**：`E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/passwords-sign-in.test.ts`（native）；`bun test ./server/tests/passwords-store.integration.test.ts`（driven+DB）；migration 演练记录数据库版本与编号；`bun run --filter server typecheck`（bootstrap BASE 红不计入）；`bunx biome format` 每改动文件真实 exit 0（新增行）。
7. **回滚证据**：在报告中给出回滚步骤（停新入口→排空/终结 code_required 与在途 filling→保留扩展 schema 回滚应用），不需要真执行生产回滚。

## 禁止

- 不改 L01 的 agent-computer/gateway 文件；不改 web UI（L03）；不新增保存 code 的列；不把 code 变成模型工具参数；不复制上游迁移编号；不改其他在途工作迁移；fixture 秘密虚构。

## 报告

`evidence/l02/implementer-report.md`：改动摘要、状态机逐行对照表、RED/GREEN 证据（含并发/迟到/重启组合）、迁移演练（fresh+upgrade、编号 0165）、审计载荷样例（脱敏后）、format/typecheck、偏差。
