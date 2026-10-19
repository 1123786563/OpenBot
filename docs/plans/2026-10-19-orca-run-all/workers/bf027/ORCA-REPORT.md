# [bf027] Issue #221 — Bifrost 02.7 用户余额页面（B 类核验）

## 结论

**main 已含完整等价实现，零功能改动收尾。** 02.7 作为 b5-221 已在 main 落地（commit
`5192c33c` / `fb66bd11`，计划存档 `docs/plans/2026-10-17-b5-221-personal-balance-ui.md`），
四条 AC 全部可实证。唯一改动是 1 行**测试字面量排序修正**（见下），属本票消费接口的契约
测试修复，不动任何产品代码。

## 逐条 AC 实证

**AC1 登录后看到本人可用、已消费、已过期额度与账户类型 — ✓**
- 页面 `/_authed/settings/usage`（auth 由 `_authed` 布局段强制），主体
  `app/src/components/billing/usage-credits-view.tsx:175-191`：个人积分账户区块，summary
  成功才挂载 `PersonalBalanceCard`。
- `app/src/components/billing/personal-balance-card.tsx:22-44`：`account-type` 徽标由服务器
  响应的 `accountType` 渲染（绝不假设），四个数字 available/consumed/expired/held 全部来自
  同一次服务器读取，无任何 `?? 0` 兜底。
- 测试实证：`app/tests/personal-credits-ui.test.tsx`「个人余额页渲染账户类型、
  可用/已消费/已过期与待结算未启用」✓（见下命令输出）。

**AC2 接口失败显示错误提示，不显示 0 余额 — ✓**
- `usage-credits-view.tsx:179-190`：`summary.error` → `LoadError`（`role="alert"` + 服务器
  原句 + 重试按钮），`PersonalBalanceCard` 不挂载；组件内无默认值可落入 0。
- 测试实证：「接口失败时显示错误提示，不渲染 0 余额」✓（summary 500 → alert 出现、
  `personal-balance` 为 null、重试按钮存在）。

**AC3 无数据时空态文案明确，不显示误导性 0 — ✓**
- `personal-balance-card.tsx:133-145`：grants 空 + 四项全 0 → `empty-ledger` 文案
  「本账户还没有积分记录。」；grants 区块空 → `PageEmpty`「暂无奖励积分。」。
- 测试实证：「无发放记录时显示明确空态文案」✓。

**AC4 页面不发起任何跨账户查询 — ✓（客户端 + 服务端双层）**
- 客户端：`app/src/lib/billing/credits.ts:182-190` summary 读不带任何账户参数；测试
  「页面请求不携带任何账户标识参数」捕获全部请求 URL，逐条断言不含
  userid/externalcustomerid/payerid/accountid/companyid/tenantid（大小写不敏感）✓。
- 服务端：`server/src/billing/routes.ts:212-221` 所有 credits 路由先 `requireUser`，再由
  中间件把携带账户标识（任意大小写）的请求以 400 拒绝；`/credits/summary` 的账户由
  `resolvePayerForPersonalUser(context.var.actor)` 从会话身份解析（routes.ts:236-241），
  路由不接受任何账户参数、不回退部署 key。
- 服务端契约测试实证（`server/tests/personal-credits-read.test.ts`）：另一用户 id 各读
  均 400、六类账户标识任意大小写均 400、未认证 401、读零写（录制数据库计数）、读答本人
  而非部署 key —— 全部 ✓。

## 命令与输出摘要

- `E2E_UNIT_SCOPE=app bun run test`（app 作用域，两层制第二层的规范收集形态）：
  `Test Files 128 passed (128)` / `Tests 967 passed (967)`，其中
  `✓ |node| app/tests/personal-credits-ui.test.tsx (8 tests) 171ms`、
  `✓ |node| app/tests/billing-credits-ui.test.tsx (18 tests) 1.35s`。
- `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5561/bf027 bun test
  ./server/tests/personal-credits-read.test.ts`（Bun 驱动层，e2e-bun-suites.json:1015 收录）：
  修复前 `9 pass / 1 fail`，修复后 `10 pass / 0 fail`（107 expect() calls）。
- 全量 `bun run test`（不带 scope）当前在无关文件上 COLLECTION_ERROR 中止
  （agent-computer/tests/web-bot-auth-browser.test.ts 缺 `web-bot-auth` 包，环境未
  `bun install`），非本票面。

## 改动文件（1 行）

- `server/tests/personal-credits-read.test.ts:393-394`：`pendingSettlement` 键集断言的期望
  数组字面量排序错误——`"reserved"` 排在 `"reservations"` 前，而 `Array.prototype.sort`
  的码点序中 `reservations`（第 7 字符 `a`）先于 `reserved`（`e`）；响应键集合本身与契约
  完全一致，属测试字面量 bug（很可能是 06.12 给该数组补键时插入位置错），交换两行后
  10/10 绿。产品代码零改动。

## git status --short

```
 M server/tests/personal-credits-read.test.ts
```

## 遗留

1. **app UI 套件的独跑红/整组绿偶合（已知 ADR 0008 补充二类问题，非本票产品缺口）**：
   `app/tests/personal-credits-ui.test.tsx` 单文件跑 5/8 红（页面级测试统一 ~1s 超时，
   `personal-balance` 不出现，组件级 3 个全过），与 `billing-credits-ui` 两文件同跑时双双
   红；但 app 作用域整组跑 8/8 与 18/18 全绿。属进程共享状态偶合（本 worktree 分支对
   app/tests 与 tests/support 零改动，与 main 同码），归 e2e 迁移收尾票
   （project_e2e_migration_leftovers / 近期 commit 0a85bb42 的 102 条根因工作流）处理。
2. 全量单测入口被 agent-computer 缺依赖的收集失败中止（环境 `bun install` 即可），与本票
   无关。
3. DB 容器 `orca-all-bf027-pg`（pgvector/pgvector:pg16，5561）按纪律保留未删。任务原定
   `postgres:16` 镜像缺 pgvector 扩展，迁移 `CREATE EXTENSION vector` 失败，故换
   pgvector 镜像（同端口同库名，先跑 `server/ops/enterprise/roles.sql` 再
   `bun scripts/migrate.ts`，输出 `{"type":"migrations-applied","status":"ok"}`）。
