# #234 执行检查点报告（未提交检查点）

- Ticket: 1123786563/OpenBot#234（04.1 Bot 服务登记与唯一服务身份）
- Worktree/branch: `/Users/wuyongjun/orca/workspaces/OpenBot/issue5-234` @ `1123786563/issue5-234`，BASE `f0520524`（与派发 BASE 一致）
- Checkpoint 形态：**未提交工作区**（dispatch 约束：no commit/push/merge）。全部变更以未提交文件 + 本报告 + 文件哈希为准。
- 测试数据库：dedicated `postgres://openbot:openbot@localhost:5432/openbot_234`（本机 `openbot-postgres-1` 容器内新建库，非 dev `openbot` 库；`tests/support/database.ts` 的守卫拒绝 `openbot` 库名）。dev/prod 数据未触碰。

## TDD 记录

- **RED**（编辑前先写测试）：`server/tests/bot-service-registry.integration.test.ts` 先行，运行输出 `0 pass / 1 fail / 1 error`（`Cannot find module '../src/bots/admin-routes'`），证据存于 `red-evidence.txt`。
- **GREEN**：实现后同文件 `7 pass / 0 fail / 36 expect()`。

## 交付内容（对照票面 AC）

1. **唯一且不可复用 botId**：`bot_services.bot_id` 为 PRIMARY KEY（数据库层拒绝，非前置 check，可并发安全）；重复登记 409；**停用后的 botId 再登记同样 409**（无 DELETE 路由，id 永不回收，审计链不可被重指向）。
2. **仅管理员可登记/编辑/停用**：所有路由 `requireUser + requireAdmin`；非管理员 GET/POST/PATCH/status 全部 403，匿名 401；每次成功操作写审计行（actor + targetId + payload）。
3. **停用状态可查询**：`getBotService(botId)` / `listBotServices()` 返回 `status: 'disabled'`，下游（#235/#238/#241）可据此拒绝；status 端点 404（未知 id）/400（非法状态值）。
4. **登记零凭据/零授权/零积分权限**：登记仅写 `bot_services` 一行 + 一条审计；测试断言 `credentials` / `credit_grants` / `credit_ledger` / `billing_customers` 行数不变，且审计仅 `bot_service.registered` 一条。
5. **下游契约**：导出 `BotServiceRecord { botId, displayName, kind, capabilities[], status, createdAt }`、`getBotService()` / `listBotServices()`（供 #235/#238/#241 消费）；能力枚举封闭为 chat/image/audio/embedding/realtime/async 的非空子集；编辑仅限 displayName/capabilities（botId/kind 不可变）。

## 变更清单与哈希（SHA-256）

新增：
- `server/src/db/schema/bots.ts` — b9b7b557292c9aec6bac8bb2e2eb837e302dfcc673194862f1212d37a954338f
- `server/src/bots/service-registry.ts` — a31df1f4c871e699ec9fc29e5c9df665fe882e503d302de4d5caaeeee341109e
- `server/src/bots/admin-routes.ts` — 26cf1dfbb99d8799ab52cb2c16ad537f435e64e24fa70b63f8d71d5dd8a795b7
- `server/tests/bot-service-registry.integration.test.ts` — 866f2979a7bb9d6b7e12aa085fac9037b6c821a707622a95e3bf186f972a53b4
- `server/drizzle/0122_bot_services.sql` — 90bb0b592931641715a3e846c05a2ae171f37a087be47ffc55fd6a0081bbfc01
- `server/drizzle/meta/0122_snapshot.json` — 1ef71dd4cc2b84434b707fbdb07cc96969e34360222deeabd00eb47aa83429b7

修改（均为追加式接线，无既有逻辑改动）：
- `server/src/app.ts` — 672f238a5b28f1bfb9dd0c44e588b38e714f493198db3e82c2fdd86ba91e7d22（import + 可选参数 `botServiceDatabase` + 条件挂载 `/api/admin/bots`，沿用 billing 的 absent-means-unmounted 契约）
- `server/src/audit.ts` — 0da2068da4dec90692a56bba4e8b3acbdb9aea600cc8a9368d96b909daaa75c0（封闭 union 追加 `bot_service.registered/edited/status_changed`）
- `server/drizzle.config.ts` — 0f4168e43f5d6fb6f8433d93e0872c45d7acfe4ba8da395d39e1059cb269750c（schema 清单加一行；该清单遗漏会使 generate 视表不存在）
- `server/src/db/schema/index.ts` — 82a8125f08be0bdd55bb431eea66addc3c2286529bcc2e23a50f99b67e6bd914（加一行 re-export）
- `server/drizzle/meta/_journal.json` — 1808e3df88b0889cb046bc9ea1b104c2fa57936a8a319fc48e01469a116d5f6a（仅追加 idx 122 条目）

## 0122 迁移与 snapshot 的精确来历（按协调者指令记录）

- `drizzle-kit generate`（drizzle-kit 0.31.10，server/package.json）在本分支**因历史快照碰撞而失败**：`0054/0055 共享同一 prevId`、`0086/0096 为同一快照`。该失败在**干净 HEAD 上逐字复现**（stash 验证），属既有仓库问题，与本票无关；未触碰任何历史文件。
- 因此 0122 三件套按以下方式构造（发生在收到协调者 04:33 migration-guard 消息之前；已按 04:34 指令保持现状并如实记录）：
  1. `0122_bot_services.sql`：与 schema 定义一致的 CREATE TABLE（与 wave-1 检查点 69759c79 中 drizzle 生成的 `0115_bumpy_shadowcat.sql` 同表结构同语句形态）。
  2. `0122_snapshot.json`：以**本分支** `0121_snapshot.json` 为基底（不改历史），仅注入 `tables["public.bot_services"]` 子树 —— 该子树逐字取自 69759c79 中 drizzle-kit 生成的 `0115_snapshot.json`（两处表定义完全一致，无枚举依赖），并将 `prevId` 链到 0121 的 id、`id` 换新 uuid。未做任何手工推导的字段结构。
  3. `_journal.json`：仅追加 idx 122 条目（tag `0122_bot_services`，breakpoints true），格式与既有条目一致。
- **`bunx drizzle-kit check --config=drizzle.config.ts` 退出码 0**：仅报告上述两组历史碰撞（与干净 HEAD 输出逐字相同），**对 0122 新链无任何报错**——新链通过校验。
- 运行时事实：`scripts/migrate.ts`（drizzle-orm postgres-js migrator）只读 `_journal.json` + SQL 文件，**不读 meta 快照**；0122 已在专用测试库实际 apply 成功并建表（`\d bot_services` 验证）。
- 给集成者的备注：历史碰撞未修复前 `drizzle-kit generate` 在本仓库对任何人不可用（含干净 HEAD）；0122 快照与 schema 一致，碰撞修复后 generate 可继续从该链推导。

## 验证命令与输出摘要（可重跑）

```bash
# 1. 票面 Verification 命令（仓库根目录）
TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_234 bun test server/tests/bot-service-registry.integration.test.ts
# 7 pass / 0 fail / 36 expect()：登记契约+审计 / 重复与停用后复用 409 / 非管理员全路由 403+匿名 401 /
# 编辑（botId、kind 不可变；未知 id 404）/ 停用可查询 disabled / 零凭据零积分副作用 / 非法输入 400

# 2. 迁移与链校验
DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_234 bun scripts/migrate.ts   # {"type":"migrations-applied","status":"ok"}
TEST_DATABASE_URL=... bunx drizzle-kit check --config=drizzle.config.ts                     # exit 0（仅历史碰撞提示，与 HEAD 相同）

# 3. 类型与 lint
bun run --filter server typecheck                                                            # exit 0
bunx biome lint --error-on-warnings server/src/bots/*.ts server/src/db/schema/bots.ts server/tests/bot-service-registry.integration.test.ts server/src/audit.ts server/drizzle.config.ts server/src/db/schema/index.ts
# Checked, No fixes applied, exit 0（server/src/app.ts 存在 1 处先于本票的 noUnusedFunctionParameters 告警，
# 位于未改动的 usage-origin 行 1003，干净 HEAD 同样报，不属本票范围）

# 4. 回归
TEST_DATABASE_URL=... bun test tests/audit.test.ts                        # 7 pass / 1 fail（workshop.* taxonomy，干净 HEAD 同败，先于本票）
TEST_DATABASE_URL=... bun test tests/admin-people-credentials-validation.test.ts tests/agent-routes.test.ts
# 64 pass / 0 fail（createApp 消费方回归）
```

## 既有问题（先于本票、stash 干净 HEAD 复现，非本票引入，仅记录）

1. `drizzle-kit generate` 因 0054/0055、0086/0096 历史快照碰撞不可用（见上）。
2. `tests/audit.test.ts` taxonomy 用例失败：19 个 `workshop.*` 事件类型在 src 中无字面量写入者。
3. `server/src/app.ts:1003`（HEAD 行号）`noUnusedFunctionParameters` lint 告警。

## 与 wave-1 检查点（69759c79）的差异

本票在协调者 BASE f0520524 上独立重做（wave1 分支 ancestry 不合格），并按票面补齐其自认缺口：新增 `getBotService()` 查询、显式 `BotServiceRecord` 类型、编辑路由（`PATCH /:botId`，displayName/capabilities 可改，botId/kind 不可变）、`bot_service.edited` 审计事件、未知 id 的 404 语义、迁移编号改为本分支下一个号 0122。票面 Verification 的测试文件名 `bot-service-registry.integration.test.ts` 亦按原文落地（wave1 用了非 integration 命名）。

## 剩余事项 / 交接

- 全部 AC 与 Produces 契约已满足；无已知阻塞。
- 集成时注意：并行兄弟票（#207/#209/#215）可能同样占用迁移号/共享接线点（见 `file-scope.md` 冲突备注）；0122 编号如冲突需整体重编号（SQL+journal+snapshot 同步）。
