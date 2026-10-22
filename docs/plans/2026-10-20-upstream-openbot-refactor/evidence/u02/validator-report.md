# U02 验收报告（backend_validator）

- 验证人：backend_validator（只读验证；唯一写入为本文件）。
- 日期：2026-10-20。工作区：`.worktrees/upstream-openbot-update`（HEAD 3b4a7c68，未提交树）。
- 对象：Task U02 服务端连接提示共享合约（A06 服务端半部 / Issue #495 / 本地票 up06）。
- **结论：验收通过（5/5 PASS）。无阻断或-major 问题；3 条观察（OBS-1/2/3，均为 minor/info）；偏差 2 判断见 §6。**

所有命令均由验证人在 worktree 根亲自执行；集成套件使用 `TEST_DATABASE_URL=postgres://postgres:openbot@localhost:5433/openbot_test`（docker `openbot-test-pg`，`openbot_test` 库）。

## 1. codec — PASS

- 命令 1（清单原样，无 scope）：`bunx e2e run --config e2e.unit.config.ts shared/connect-prompt.test.ts` → **11 pass / 0 fail**（全树收集后执行，exit 0）。
- 命令 2（与实施者一致）：`E2E_UNIT_SCOPE=shared bunx e2e run --config e2e.unit.config.ts shared/connect-prompt.test.ts` → **11 pass / 0 fail**。两种方式均通过；`shared` 在 `SUITE_DIRS` 内，scope 仅是收集提速，不影响归层。
- 抽查（另以临时 bun 脚本在 /tmp 亲测，未写入仓库）：
  - title 含 `}`/引号/反斜杠 roundtrip ✓（套件用例 1 + 验证人独立复测）。
  - **上游缺陷实证**：把 `evidence/upstream-sources/shared/connect-prompt.ts` 的 `indexOf("}")` 解析逐字内联，对同一 hostile wire 返回 **null（卡片丢失）**；本地 `objectEnd` 配平扫描返回完整 prompt。brief"不得复制该缺陷"的要求成立且被证明是必要的。
  - 截断/畸形 JSON/字段类型错/非对象（数组、字符串、数字）→ null ✓；marker 居中于文本 → null ✓。
  - 长度界**精确边界**：serverId 256 解析 / 257 null；title 200 / 201；message 4000 / 4001；payload **恰 8192 解析 / 8193 null**（验证人自构空格填充用例，比套件的"远超帽"用例更贴边）。
  - 首字符须恰为 `{`：`[connect-app] {"..."}`（前导空格）→ null，严于上游 ✓。
  - 代理对不劈开：120 个 `🍊` + 1 个越界字符，title 以完整 `🍊` 结尾 ✓。

## 2. 分支映射 — PASS

- `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/plugin-connect-route.test.ts` → **5 pass / 0 fail**（含新增 actor 钉住用例）。
- `bun test ./server/tests/plugin-user-credential.integration.test.ts` → **16 pass / 0 fail / 45 expect**。
- `server/src/plugins/store.ts` 中 `connectAppRefusal(` 恰 **4 处**，行号 :1842 / :1925 / :2128 / :2154 与报告逐一相符；4 处均为个人可自助连接臂（brokered 个人 holder 无行 / person-oauth 队前无行 / 队列期断开 / 事务内 `FOR UPDATE` 读到撤销）。
- 保持原拒绝文案的分支（逐一在现树核对为纯文本，无 marker）：Shared 部署账户 :1833、server 级凭据 :1862、noClient 手动 :1960 与动态 :1959、unusableClient :1962/:1963、clientReplaced :1977、缺 Bot grant :7982（`This Bot has not been given the tool`）、以及 `accountRefFor`/policy/audience 各 refusal。
- "无 marker"钉住测试：缺 Bot grant 与 noClient（手动变体）两处在 integration suite 内以 `readConnectPrompt(message)` 为 null + 原句子串双断言钉住 ✓。Shared 部署账户臂由 `shared-brokered-store` 的 `expectOnlyRefusal(said, "sharedNotConnected")` 钉住**句子内容**，但该 helper 是子串正则，若误加 marker 不会红——marker 缺席在该臂**无显式测试钉住**，靠 diff 审查兜底（见 OBS-1）。动态 noClient 变体无钉住（见 §6 偏差 2 / OBS-2）。

## 3. 安全语义 — PASS

- marker 只是展示数据：居中 marker → null（套件用例 + 验证人复测），普通 vendor 文本永不升级为权限信号。
- connect endpoint actor 再校验（测试 + 代码双层核实）：`routes.ts:1379` `requireUser` 下 actor 仅来自 session；:2124 `sealConnectState({ userId: context.var.actor.id, serverId, ... })`，serverId 取 URL param；brokered 分支注释与代码均不从 body 读 user id。新钉住用例：body 携带 `userId: "intruder@..."`/`serverId: "google-drive"`，`ensureOAuthClient` 实际收到 `{ serverId: "notion", by: "person@openbot.test" }`，state 拆封 `userId === "user-1"`（session actor）。codec 结果不是该端点的任何输入。
- 零改动核对：`server/src/plugins/tools.ts` 不在 diff、`git status` 干净，`REFUSAL_MARKER = "Refused."`（:36）与信封拼接（:257）逐字未动；`PluginRefusedError` 类、审计写入路径、400 字符 `failure` 截断均不在 store.ts 的 5 个 hunk 内（+38/−5 = 1 import + 4 处消息包装）。
- 旧客户端可读：message 原样保留在 marker JSON 之后（`endsWith` 用例），无卡片客户端读到完整句子。

## 4. 范围 — PASS

- before-tracked.diff（13 文件，S01–S04/U01 在场改动）vs after-tracked.diff（16 文件）：**U02 tracked 增量恰为 3 个 owned 文件**（store.ts、plugin-connect-route.test.ts、plugin-user-credential.integration.test.ts）；三个文件的 evidence diff 与 live `git diff` **逐字节一致**（store.ts 与两测试文件均复核）。
- untracked 中 U02 所有物仅 `shared/connect-prompt.ts` + `shared/connect-prompt.test.ts`；其余 untracked（app/*、docs/*）属其他任务/总规划文档。
- `docs/verification/e2e-bun-suites.json`：before/after 两 diff 中该文件段**逐字节相同** → U02 零改动声明成立；live diff vs HEAD 仅含其他任务的 app/tests 条目。
- 回归（:5433 亲跑）：`plugin-store.integration.test.ts` **135 pass**（468 expect）、`shared-brokered-store.integration.test.ts` **14 pass**、`server-side-tools.integration.test.ts` **5 pass**——与报告数字完全一致。
- 审计对账：`node scripts/e2e-coverage-audit.mjs` → 563 native / 462 driven，与报告一致；`shared/connect-prompt.test.ts` 不在 GAPS（native 桶，免登记）；GAPS 13 条经验证 **13/13 为 `git ls-files` 可匹配的 BASE 已提交文件**（wave2 遗留），非本任务引入。
- 登记对账：`plugin-user-credential` 在清单 part 10（:466 组内 + :1021 flat，24 文件组）；connect-route 与 connect-prompt 不在清单（native，与实际执行一致）。
- 质量：biome format 4/5 exit 0；user-credential 的 exit 1 经用 HEAD 内容（项目配置下）复现确认为 **BASE 既有漂移**，与报告 §5 一致。`bun run --filter server typecheck` 仅 3 条 TS2339，全部在 `scripts/bootstrap-local-gateway.ts`（不在任何 diff 中 → BASE 既有），U02 文件零诊断。
- SHA-256 五文件与报告 §5 全部吻合（03fe33c8… / cd6e2aa8… / bcd7dea3… / 6729ca9d… / d87aa0c3…）。

## 5. RED 真实性 — PASS（可信）

- **codec RED**（`red-codec-collection.txt`）：`COLLECTION_ERROR: Cannot find module …/shared/connect-prompt`，exit 2。评估：对全新模块这是唯一可能的最初 RED（无实现则无断言可跑），作为行为 RED 是最弱形态，但实施者如实披露这是 GREEN 后以 mv 互换复现采集（非时序首捕），run id 与时间戳（18:58:42）自洽，恢复后以 GREEN 复跑收口。可信。
- **store RED**（`red-store-run.txt`）：**13 pass / 3 fail**。这是双向断言级 RED：3 个 marker 用例在 HEAD store 上 `expect(prompt).not.toBeNull()` 收到 null（旧句无 marker），2 个"无 marker"钉住用例与 11 个既有用例照常通过。内部一致性极强：GREEN 45 expect − RED 37 = 8，恰等于 3 个失败用例在首断言中止所损失的 expect 数（3+2+3，逐用例核对）；失败行号 638/657/670 与现文件 `expect(prompt).not.toBeNull()` 所在行逐一重合。
- 换入复现用 `git show HEAD:` 文件级替换、未动共享 stash：stash 栈现仅一条陈旧无关条目（`WIP on main: 792c8760`），与 U02 无涉；终态由验证人上述 GREEN 复跑独立确认。证据链可信。

## 6. 偏差 2 判断（动态注册 noClient 不加 marker）

验证人独立读取 `store.ts:1939-1963` 上下文后的判断：**接受现状（不加 marker），但该臂应升格为 Spec 层待决问题。**

理由：

1. **语义上该臂其实是个人可修复的**。动态变体的原句自己说明修复路径——"the deployment registers itself with the vendor **when somebody connects**"：个人在 Settings 发起 connect 时，connect endpoint 的 `ensureOAuthClient` 会以本人 session 身份为部署自注册 OAuth client，工具调用随即恢复。它是 brief 三臂（无账户/已断开/已撤销）之外**最强的人格化修复候选**，未来加卡片的 serverId 也仍是同一行 id，追加成本极低。
2. **但实施者的保守处理是流程正确的**。brief 的 RED 清单是封闭三臂；缺失的物件是部署侧 OAuth client 而非本人连接行，卡片若说"connect your account"在措辞上越过了 spec 已批的语义；Phase B 不得静默扩 Spec。`unusableClient`/`clientReplaced` 两臂还叠加"部署已自愈/旧 grant 不可迁移"的措辞负担，一并冻结是对的。
3. **建议**：把"动态注册 noClient/unusableClient 臂是否携带卡片"作为一条 Spec 修订候选交回 Matt 侧 `to-spec`（一张票即可），而非在本任务返工。在 Spec 修订前，保持原句 + 不加 marker 是正确落点。

## 7. 问题分级与观察

| 级别 | 条目 | 说明 |
|---|---|---|
| 阻断/major | 无 | — |
| OBS-1（minor） | Shared 部署臂 marker 缺席无显式测试钉住 | `expectOnlyRefusal` 子串正则对"误加 marker"不敏感；现由 diff 审查兜底。若该 suite 后续再被触碰，建议补一行 `readConnectPrompt` → null 钉住。 |
| OBS-2（minor） | 动态 noClient/unusableClient/clientReplaced 三臂无 marker 缺席钉住 | 与偏差 2 同源；Spec 修订（§6 建议）时一并补。 |
| OBS-3（info，交接给 U03/U04） | 信封与 marker 的组合形态 | 工具结果文本为 `Refused. [connect-app]{…} 句子`；codec 的 `startsWith` 针对的是 `PluginRefusedError.message`（信封前），前端读者（U03/U04）必须先剥 `Refused. ` 信封或以包含定位——建议 U03/U04 brief 把该读取点写明，否则卡片永不绘制。U02 侧无缺陷（信封保留是 brief 明令）。 |

## 8. 验证人执行命令与结果汇总

| 命令 | 结果 |
|---|---|
| `bunx e2e run --config e2e.unit.config.ts shared/connect-prompt.test.ts` | 11/11，exit 0 |
| `E2E_UNIT_SCOPE=shared bunx e2e run --config e2e.unit.config.ts shared/connect-prompt.test.ts` | 11/11 |
| `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/plugin-connect-route.test.ts` | 5/5 |
| `TEST_DATABASE_URL=…5433/openbot_test bun test ./server/tests/plugin-user-credential.integration.test.ts` | 16/16（45 expect） |
| 同上 `plugin-store.integration.test.ts` | 135/135（468 expect） |
| 同上 `shared-brokered-store.integration.test.ts` | 14/14 |
| 同上 `server-side-tools.integration.test.ts` | 5/5 |
| `node scripts/e2e-coverage-audit.mjs` | 563 native / 462 driven；GAPS 13 条均 BASE |
| `bun run --filter server typecheck` | 仅 3 条 BASE 既有 TS2339（bootstrap-local-gateway.ts） |
| 边界/上游对照抽查（/tmp 临时脚本） | 全部符合预期；上游 `indexOf("}")` 缺陷实证 |
