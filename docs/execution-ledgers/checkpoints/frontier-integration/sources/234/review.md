# #234 独立只读 Review（Reviewer Dispatch ctx_2cfc68eaf0d0）

- 对象：worktree `d6edf033-748a-4549-ae5a-e9efd34cef91::/Users/wuyongjun/orca/workspaces/OpenBot/issue5-234` 的**未提交检查点**，BASE `f0520524`（HEAD 一致，diff 即工作区变更）。
- 实现者 Dispatch：`ctx_57849bba0118`（settled succeeded）。来源报告：`docs/execution-ledgers/checkpoints/234/report.md`。
- Reviewer 约束遵守情况：**零源码/测试改动，零 commit，未运行任何会写库的命令**（未重跑测试、未跑 migrate）。独立执行的验证仅限只读命令：`shasum`、`git diff`、`git show`（HEAD 快照取证）、`bun run --filter server typecheck`、`bunx biome lint`、`bunx drizzle-kit check`、对 `openbot_234` 测试库的只读 SELECT / `\d`。

## 结论（两项独立判定）

| 判定 | 结论 |
| --- | --- |
| **Spec compliance** | **PASS** — Issue #234 四条 AC、Produces 契约、父 Spec #5（Q15/Q20/AC19 相关面）与 CONTEXT.md「已登记 Bot」定义全部满足，未发现越权/越界实现。 |
| **Code quality** | **APPROVE** — 无阻断或高危问题；2 条 Low、3 条 Info 级观察（见下），均可留待本票或后续票处理，不构成 CHANGES 门槛。 |

## 1. 哈希核验 — 全部一致

报告清单中 11 个文件（6 新增 + 5 修改）逐一 `shasum -a 256` 复核，与 report.md 记录**全部逐字节一致**，无漂移。`git status` 显示工作区变更集合与报告变更清单一一对应，无未申报文件。

## 2. Diff 审查（BASE f0520524）

5 个修改文件全部为**纯追加式接线**，无既有逻辑改动：

- `server/drizzle.config.ts` +1 行（schema 清单加 `./src/db/schema/bots.ts`，必要：缺清单则 generate 视表不存在）。
- `server/src/db/schema/index.ts` +1 行 re-export（按字母序插入，无重导出冲突：`bots.ts` 导出 `botServices`，grep 全 schema 无同名）。
- `server/drizzle/meta/_journal.json` +1 条目（idx 122，追加在 0121 后）。
- `server/src/app.ts` +24 行：import + 可选参数 `botServiceDatabase?: Database` + 条件挂载 `/api/admin/bots`。挂载点在 `createEnterpriseAdminRoutes` 之后，模式与 billing/template-revisions 的 absent-means-unmounted 契约一致；可选参数置于签名末尾，不影响现有 `createApp` 调用方（回归测试文件 64 pass 佐证 + typecheck exit 0）。
- `server/src/audit.ts` +9 行：封闭 union 追加 `bot_service.registered/edited/status_changed`，注释明确与个人 Bot 对象事件（`bot.created` 等）的领域区分。

6 个新文件（schema / service-registry / admin-routes / 集成测试 / SQL / snapshot）逐行审读，见下节。

## 3. Spec 合规逐条核验

对照 Issue #234 AC、Produces 契约、父 Spec #5 与 ADR 0002：

1. **管理员可登记 Bot 并指定能力声明，重复 botId 被拒绝 — 满足。**
   唯一性由数据库层强制：`bot_services.bot_id` 为 PRIMARY KEY，`registerBotService` 用 `onConflictDoNothing({target: botId}) + returning()`，冲突→`BotIdTakenError`→409。这是**并发安全**的（非前置 check-then-insert 竞态）。能力枚举封闭为 `chat/image/audio/embedding/realtime/async` 非空子集（与父 Spec Q20「全面覆盖调用能力」一致），运行时 `parseCapabilities` 强制。测试覆盖重复登记 409。
2. **非管理员无法登记、编辑或停用 — 满足。**
   `createBotAdminRoutes` 内 `routes.use("*", requireUser)` + 第二个中间件调用 `requireAdmin`，**四条路由（GET/POST/PATCH/status）全部在守卫之后注册**，无逃逸路由。测试断言 member 对 GET/POST/PATCH/status 全 403、匿名 401。守卫语义与 `src/auth/guards.ts` 的 `requireAdmin`（role !== "admin" → 403）一致。
3. **停用后状态可查询为 disabled，下游可据此拒绝 — 满足。**
   `getBotService()`/`listBotServices()` 返回含 `status: 'disabled'` 的 `BotServiceRecord`；测试同时断言单查与列表两条路径。`status` 端点语义完整：未知 id 404（非静默）、非法值 400。Produces 契约 `BotServiceRecord {botId, displayName, kind, capabilities[], status, createdAt}` 与票面逐字段一致，类型已导出供 #235/#238/#241 消费。
4. **登记不产生凭据、授权或任何积分权限 — 满足。**
   实现路径为**单表单行 insert + 单条审计**，代码无任何对 credentials/credit/billing 表的写路径；测试以计数断言 `credentials`/`credit_grants`/`credit_ledger`/`billing_customers` 行数不变，且审计仅 `bot_service.registered` 一条。与 CONTEXT.md「已登记 Bot：登记本身不授予消费任何用户积分的权限」逐字吻合；`kind` builtin/external 同表区分（AC 实现步骤 3）。
5. **botId 全局唯一且不可复用 — 满足（超出票面字面的正确强化）。**
   无 DELETE 路由、无 delete service 函数；测试显式覆盖「停用后再登记同 id → 409」，审计链不可被 id 回收重指向。这与 Q15「第一版只允许管理员登记并认证的服务端 Bot」的意图一致。
6. **审计 — 满足。** 三类操作各写一条（actor + targetType `bot_service` + targetId + payload），经 `recordAuditEvent`（含 `redactAuditPayload` 标准脱敏）；测试断言事件类型、actor、target。
7. **写范围 — 合规。** 全部变更落在「Bot 服务登记模块与迁移 + 管理员登记路由 + 对应测试」及必要接线点（app 挂载、audit union、schema 清单/re-export、journal）。未顺带实施其他票（无凭据发放、无 Key、无授权路径——正是 AC4 要求的「不产生」）。

## 4. 迁移 / Snapshot 溯源核验（按协调者关注点重点审查）

报告对 0122 三件套的来历说明（drizzle-kit generate 因历史碰撞不可用 → 以 0121 为基底注入 69759c79 中 drizzle 生成的 bot_services 子树）**逐项取证核实，无虚构**：

1. **snapshot 最小性**：结构化 diff `0121_snapshot.json` vs `0122_snapshot.json` —— 顶层除 `id`/`prevId` 外**仅** `tables` 差异，且 tables 差异**仅**为新增 `public.bot_services`（added={bot_services}, removed=∅, changed=∅）。历史快照未被触碰。
2. **链完整性**：`0122.prevId == 0121.id`（`fbb4e855-…`）✓；journal idx 122 紧随 121。
3. **子树来历逐字一致**：`git show 69759c79:server/drizzle/meta/0115_snapshot.json` 的 `public.bot_services` 子树与 0122 中的**深度相等**；`0115_bumpy_shadowcat.sql` 的 CREATE TABLE 与 `0122_bot_services.sql` **逐字节一致**。即「无手工推导字段结构」的声明属实。
4. **历史碰撞为既有问题**：`git show HEAD:` 取证确认 0054/0055 共享 prevId、0086/0096 同 id 在**干净 HEAD 上即存在**，与本票无关；`drizzle-kit check` 在本工作区 exit 0，仅报这两组碰撞，对 0122 新链零报错（reviewer 独立重跑）。
5. **journal `when` 合法性**：0122 的 `1792036800000 > 0121 的 1792008991185`，满足 `migration-runner.ts` 的严格递增校验（该校验失败会直接抛错）。
6. **运行时事实**：`scripts/migrate.ts`/`migration-runner.ts` 只读 `_journal.json` + SQL（drizzle-orm postgres-js migrator），不读 meta 快照 —— 报告声明属实。
7. **实测库只读取证**：`openbot_234` 中 `bot_services` 表结构 `\d` 输出与 schema 完全一致（text PK/jsonb/默认值）；`drizzle.__drizzle_migrations` 共 123 条，最后两条 hash 分别等于 `sha256(0121_married_harpoon.sql)` 与 `sha256(0122_bot_services.sql)` —— 迁移确实以该 SQL 内容真实 apply，非编造证据。

## 5. 安全 / 正确性审查

- **注入**：生产代码全部经 drizzle 参数化（`eq`/`insert`/`update`）；`sql.raw` 仅出现在测试的 `sideEffectCounts()`，表名为固定字面量数组。无字符串拼接 SQL。
- **鉴权旁路**：无。守卫中间件先于全部路由注册；`requireAdmin` 为可选依赖但缺省回落到导入的同名守卫；`context.var.actor` 由 requireUser 前置设置。
- **信息暴露**：登记响应/列表仅含注册字段，表本身无凭据列；审计 payload 经标准脱敏管道。
- **并发**：唯一性由 PK 决定（`onConflictDoNothing` 原子），报告「可并发安全」的声明成立；edit/status 为单行 UPDATE … RETURNING，last-write-wins 属登记台账可接受语义。
- **输入边界**：botId 正则 `^[a-z0-9][a-z0-9-]{1,63}$`（2–64，禁首尾连字符等）、displayName 1–100、kind/枚举封闭、未知 id 404、非法 status/枚举/空能力 400，均有测试（含 9 组 malformed 用例与「拒绝批次未落库」断言）。
- **测试卫生**：`TEST_DATABASE_URL` 守卫拒绝 `openbot` 库名（`tests/support/database.ts` 确认）；`$client.close()` 模式与既有集成测试一致。

## 6. Reviewer 独立执行的只读验证（可重跑）

```bash
shasum -a 256 <报告清单 11 文件>          # 全部一致
git diff / git show HEAD:<snapshots>      # diff 纯追加；历史碰撞在 HEAD 即存在
bun run --filter server typecheck         # exit 0（reviewer 重跑）
bunx biome lint --error-on-warnings <changed files>   # Checked, exit 0（reviewer 重跑）
TEST_DATABASE_URL=…openbot_234 bunx drizzle-kit check --config=drizzle.config.ts   # exit 0，仅历史碰撞提示（reviewer 重跑）
docker exec openbot-postgres-1 psql -U openbot -d openbot_234 -c '\d bot_services'  # 结构一致（只读）
SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 2  # 与 0121/0122 SQL sha256 一致（只读）
```

**未重跑**：`bun test`（会向测试库写入，违反本次 no-mutation 约束）。GREEN 证据采信实现者报告（7 pass / 0 fail / 36 expect）并经上述静态与库态证据交叉印证；`tests/audit.test.ts` 的 workshop.* 既有失败与 `app.ts:1003` 既有 lint 告警按报告标注为先于本票（与 HEAD 碰撞取证同类，未复核运行为唯一保留项，均不在本票写范围）。

## 7. 发现清单（均非阻断）

| # | 级别 | 发现 | 证据 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | **Low** | `POST /` 与 `PATCH /:botId` 的 `await context.req.json()` 无 parse 失败兜底：畸形 JSON body 会抛错返回 500 而非 400；同文件 status 路由用了 `.catch(() => ({}))`，craft/workshop 路由亦兜底（billing 同样未兜底，故是仓库内并存的两种惯例）。管理员路由之后，无安全影响，仅健壮性/一致性。 | `admin-routes.ts` L61 vs L94 | 后续小修：补 `.catch` 返回 400（可并入 04.2 或 lint 清理票） |
| 2 | **Low** | `capabilities` 允许重复元素（如 `["chat","chat"]`）通过校验并原样存储。票面只要求「受限枚举非空子集」，不违规，但列表语义上应去重或拒绝重复。 | `parseCapabilities` 仅查枚举成员 | 后续小修：`new Set(capabilities).size === capabilities.length` |
| 3 | Info | 未交付管理员登记页面；票面 Write scope 允许「页面」但 AC 与 Implementation steps 仅要求接口，AC19 的页面要求属父 Spec 后续 Key 管理面。不构成缺口。 | 票面 AC 1–4 | 留待有 UI 需求的下游票 |
| 4 | Info | 0122 迁移三件套为手工构造（generate 因既有碰撞不可用），来历已逐项取证核验；集成时若兄弟票（#207/#209/#215）占号需整体重编号。 | 报告「0122 迁移与 snapshot 的精确来历」 | 集成者按 file-scope.md 冲突备注处理 |
| 5 | Info | 既有问题（先于本票、非本票引入）：drizzle-kit generate 历史 snapshot 碰撞（0054/0055、0086/0096，HEAD 取证确认）；`tests/audit.test.ts` workshop.* 失败；`app.ts:1003` lint 告警。 | 本 review §4.4 | 单独立票修复 generate 可用性 |

## 8. 最终判定

- **Spec compliance: PASS** — 四条 AC、Produces/Consumes 契约、父 Spec 约束（Q15/Q20、登记惰性）、CONTEXT.md 术语、写范围全部满足且有测试与库态证据。
- **Code quality: APPROVE** — 代码清晰、并发安全、审计完整、与仓库模式一致；仅存 2 Low + 3 Info 观察项，均不影响正确性/安全性/可回归性，无需在本票返工。

*Review 完成，未改动任何源码/测试/迁移，未 commit。*
