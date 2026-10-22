# U02 实施报告：服务端连接提示共享合约（A06 服务端半部 / Issue #495 / 本地票 up06）

- 执行者：backend_implementer。工作区：`.worktrees/upstream-openbot-update`（HEAD 3b4a7c68）。
- 未 commit/push、未用共享 stash、未派发子 Agent。改动仅限 brief owned_files；工作区在场 S01–S04/U01 改动未触碰。
- 证据文件：`red-codec-collection.txt`、`red-store-run.txt`（RED 复现，见 §3）、`after-tracked.diff`（全 tracked 工作区 diff，含在场其他任务改动；本任务增量见 §1 与 `before-tracked.diff` 对照）。

## 1. 改动摘要

| 文件 | 改动 |
|---|---|
| `shared/connect-prompt.ts`（新建，156 行） | I2 codec，单声明双端读取。`CONNECT_APP_MARKER`、`ConnectPrompt`、`connectAppRefusal`、`readConnectPrompt`。**严于上游**：(1) 字段长度界 serverId 1–256、title 1–200、message ≤4,000、marker payload ≤8,192——writer 先按同界 clamp（含代理对不劈开），reader 越界即 null；(2) 解析不再 `indexOf("}")` 取第一个花括号，改为感知字符串字面量与转义的配平扫描（`objectEnd`），title 含 `}`/引号/反斜杠可完整 roundtrip；(3) writer clamp 保证服务端自产 payload 恒可解析回（发出去解析不了的 marker = 卡片静默丢失）。首字符必须恰为 `{`（上游容忍前导空白，本地 fail closed）。 |
| `shared/connect-prompt.test.ts`（新建，198 行，11 用例） | hostile title（`}`+引号+反斜杠，message 内嵌伪 JSON）roundtrip；普通句 roundtrip；message 保留可读（endsWith）；超长字段 clamp 后仍 roundtrip + 转义膨胀下 payload ≤8,192；代理对边界；普通文本/null/undefined/空串 → null；**marker 出现在文本中部 → null**（普通 tool 结果不得升级为权限信号）；截断/畸形 JSON → null；数组/字符串/数字/字段类型错 → null；空 serverId/title → null；message 来自 JSON 后文本（无下界）；各长度界越界 → null；字段合规但 payload 超 8,192 → null。 |
| `server/src/plugins/store.ts`（+38/−5） | 仅 4 处个人可自助连接拒绝分支的消息改经 `connectAppRefusal` 包装（见 §2 映射表）；新增 import。工具执行/副作用路径、`PluginRefusedError` 类、审计写入路径、审批与预算逻辑零改动；audit `failure` 字段沿用既有 400 字符截断，marker 文本随之入审计（展示数据）。 |
| `server/tests/plugin-user-credential.integration.test.ts`（+114，driven） | 新 describe 5 用例（§3）；未改动既有 11 用例任何断言。 |
| `server/tests/plugin-connect-route.test.ts`（+52，native） | 新增 1 用例钉住 connect endpoint 的 actor 再校验（§2 末行）；既有 4 用例未动。 |

## 2. 分支映射表（哪些拒绝产生 marker、哪些保持原样及理由）

**产生 marker（个人可自助连接的"无账户/已断开/已撤销"）** —— 全部在 `connectionTokenFor`，均在 `server/src/plugins/store.ts`：

| 分支 | 位置（改后行号） | 原句（保留为 message） | 判定依据 |
|---|---|---|---|
| brokered 个人 holder 无连接行 | store.ts:1842 | `You have not connected your ${row.title} account. Connect it in Settings and ask again.` | `resolved.ref.holder !== "deployment"`；个人 Composio/OpenConnector 账户可经 Settings 自助连接；serverId = 所拨行 id（connect endpoint 即按行 id 接受） |
| person-oauth 无连接行（队前） | store.ts:1925 | 同上句（title 用 catalogue `entry.title`） | 个人 user-oauth 连接器，connect endpoint 自助闭环 |
| person-oauth 排队期间被断开（事务内） | store.ts:2128 | 同上句 | 同一"无账户"事实的排队竞态臂，同句同提示 |
| person-oauth 凭据被撤销/行消失（事务内 `FOR UPDATE` 读） | store.ts:2154 | `Your ${title} access was withdrawn. Connect it again in Settings.` | "已撤销"臂；重连即修复，且由本人在 Settings 完成 |

**保持原样（理由：命名的是别人/部署侧的活，改写成"请个人连接"会把人送去按一个修不好问题的按钮）**：

- brokered Shared 账户未连接（`holder === "deployment"`）："shared across this deployment… Ask an administrator…" —— 管理员共享账户分支，brief 明令保持。
- brokered `accountRefFor` 全部 refusal（not an app / needs no account / ambiguous / 未归属 run）。
- person-oauth 无 OAuth client（`noClient` 手动/动态两变体）、`unusableClient`、`clientReplaced`：deployment 侧 OAuth client 缺失/不可用/被供应商撤认。注：动态注册变体的原句虽然也说 "Connect … again in Settings"，但按 brief 封闭清单（仅无账户/已断开/已撤销三臂）不加 marker——该状态的第一修复者是部署重新注册而非个人，保守读法 fail closed（报告 §6 偏差 2）。
- server 级凭据缺失（`secretFor(row.credentialId, "…An administrator has to add it again.")`）：部署凭据，非个人账户。
- 缺 Bot grant（`decide` → `This Bot has not been given the tool ${ref}.`）、policy/audience/sharing 各 refusal、craft relay 路径（`mcpWireConnectionFor` 对 PluginRefusedError 一律 null，消息不变即行为不变）。

**connect endpoint actor 再校验（新钉住用例，no-change verified）**：`POST /servers/:id/connect` 的 actor 只来自 session（`context.var.actor`），body 携带 `userId`/`serverId` 冒名不改任何行为（`ensureOAuthClient` 仍以 session actor email 调用）；授权 URL 的 `state` 以 session userId + URL 所指 serverId 封印（用 `readConnectState` 实拆验证）——callback 的 `personHasAccess(state.userId)` 因此问的永远是签到者本人。codec 结果不构成该端点的任何输入。

## 3. RED→GREEN 证据

**RED（codec，实现前）**：`E2E_UNIT_SCOPE=shared bunx e2e run --config e2e.unit.config.ts shared/connect-prompt.test.ts` → exit 2，`COLLECTION_ERROR: Cannot find module '…/shared/connect-prompt'`。全文存 `evidence/u02/red-codec-collection.txt`（实现落地后用 mv 互换复现采集，恢复后复验）。

**RED（store，实现前）**：以 `git show HEAD:` 版本文件级换入复现（非 git stash），`bun test ./server/tests/plugin-user-credential.integration.test.ts` → exit 1，**13 pass / 3 fail**：三个新 marker 用例（not-connected / revoked / 他人已连）`expect(prompt).not.toBeNull()` 收到 null（旧消息无 marker）；两个钉住用例（no-client、no-grant 无 marker）与 11 个既有用例照常通过。全文存 `evidence/u02/red-store-run.txt`。

**GREEN（实现后）**：

| suite | 命令（worktree 根） | 结果 |
|---|---|---|
| `shared/connect-prompt.test.ts` | `E2E_UNIT_SCOPE=shared bunx e2e run --config e2e.unit.config.ts shared/connect-prompt.test.ts` | **11 pass / 0 fail**（native node target 实跑） |
| `server/tests/plugin-connect-route.test.ts` | `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/plugin-connect-route.test.ts` | **5 pass / 0 fail** |
| `server/tests/plugin-user-credential.integration.test.ts` | `bun test ./server/tests/plugin-user-credential.integration.test.ts` | **16 pass / 0 fail**（45 expect；11 既有 + 5 新） |

**回归（改动 seam 的相邻 suite）**：`plugin-store.integration.test.ts` **135 pass**（含 `/You have not connected your GitHub account/i` 正则断言——marker 加在句前，子串匹配仍成立，未削弱）；`shared-brokered-store.integration.test.ts` **14 pass**（`REFUSALS.personalNotConnected` 同理）；`server-side-tools.integration.test.ts` **5 pass**（`grantedTools` 信封路径，`tools.ts` 零改动）。

**统一驱动证据（V-B）**：`E2E_BUN_ONLY="server/tests part 10" E2E_UNIT_OUTPUT=.e2e/u02-driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` → ✓ 18.32s（该组 24 文件，含本任务编辑的 `plugin-user-credential.integration.test.ts`，组判定通过）。

## 4. suite 归层与登记对账

| 文件 | import 层 | 归层 | 清单动作 |
|---|---|---|---|
| `shared/connect-prompt.test.ts` | `tests/support/e2e-compat` | **native**（纯 TS，无 Bun API） | **不登记**。复现算法：`scripts/e2e-coverage-audit.mjs` 以 `/support\/bun-test-compat["']/` → bun 层、`/support\/e2e-compat["']/` → native 分桶（其 73/74/87 行）；驱动清单只收 bun 层文件，故本文件进 native 桶、无需入 `e2e-bun-suites.json`。对账：跑 `node scripts/e2e-coverage-audit.mjs`，本文件**不在 GAPS**（记 563 native / 462 driven）；并以 `E2E_UNIT_SCOPE=shared` 实跑证明 native 收集与执行（§3 第一行） |
| `server/tests/plugin-connect-route.test.ts` | `e2e-compat` | native（既有归属，未变） | 无需登记；清单中无此文件，与实际执行一致 |
| `server/tests/plugin-user-credential.integration.test.ts` | `bun-test-compat` | driven（既有归属，未变） | 已在清单 part 10（`files` 466 行 + flat 1021 行），无增删；对账=上方统一驱动轮实跑该组通过 |

`docs/verification/e2e-bun-suites.json` 本任务**零改动**（在场 diff 属 U01）。审计 GAPS 13 条均为 BASE 已提交文件（wave2 `fd62295a` 引入的 multitenancy/key-status 等 bun 层文件未入清单），逐条核过 `git ls-files`/manifest 命中：**BASE 既有审计红，非本任务引入，不属本任务 owned**，留给 V01 台账。

## 5. 自查

- `bunx biome format <file>` 真实 exit code（逐文件）：
  - exit 0：`shared/connect-prompt.ts`、`shared/connect-prompt.test.ts`（初查 exit 1 一处为本人新增行超宽，`--write` 修复后复查 exit 0）、`server/tests/plugin-connect-route.test.ts`、`server/src/plugins/store.ts`（整文件含本人改动全干净）。
  - exit 1：`server/tests/plugin-user-credential.integration.test.ts` —— **BASE 既有漂移**：第 1 行 import（98 字符）BASE 即需折行。证据：BASE 内容写为同目录真实文件跑 `biome format` exit 1（stdin//tmp 对照因不加载项目 biome.json 而失真，S01 ledger 已登记同款陷阱）；本人 diff 仅 2 hunk（1 行 import + 末尾新 describe），均格式干净。未触碰漂移行。
- `bun run --filter server typecheck` → 仅 `scripts/bootstrap-local-gateway.ts`(106,52/108,53/120,74) 3 个 TS2339，为 ledger 预登记 BASE 既有红（ledger 记 4 处，实测 3 条诊断，同一文件同一批判别联合，非本批引入）；`store.ts` 及其传递引入的 `shared/connect-prompt.ts` 在 tsc 范围内零错误。`server/tsconfig.json` include 不含 `tests/*.test.ts`（BASE 作用域如此），测试文件以实跑为证。
- SHA-256（after）：`shared/connect-prompt.ts` 03fe33c8…；`shared/connect-prompt.test.ts` cd6e2aa8…；`server/src/plugins/store.ts` bcd7dea3…；`server/tests/plugin-user-credential.integration.test.ts` 6729ca9d…；`server/tests/plugin-connect-route.test.ts` d87aa0c3…。
- 禁止范围核对：未改 `tools.ts`（`REFUSAL_MARKER = "Refused."` 外层信封逐字未动，marker 只在其内容里随行）；未建第二套 OAuth；未扩大账户归属（ADR 0004/0006/0007）；无 DB migration；未动 U03/U04 前端文件；未动工具执行/副作用路径。
- A06 前两条对照：结构化提示只挂四个人可自助分支（§2 表）；codec 严格校验且 title 引号/花括号 roundtrip（§1）；提示仅展示（mid-text marker → null 测试 + connect endpoint actor 再校验钉住）。

## 6. 偏差（需要编排者/验证者注意）

1. **writer 侧 clamp 是计划文字之外的补全，方向更严**。I2 只写了 reader 越界返回 null；本实现让 writer 先 clamp 到同界（含代理对处理），使服务端自产 payload 恒可 roundtrip。理由：发一个 reader 必拒的 marker 等于卡片静默丢失，恰是长度界要防的事故。测试钉住 clamp 行为；若评审认为 writer 应改为"越界退化为纯文本拒答"，属一处小改。
2. **动态注册变体的 `noClient`（"Connect … again in Settings: the deployment registers itself…"）未加 marker**。该句字面上也叫个人去 Connect，但状态的第一修复是部署重新注册（`refuseAndReplaceEvictedClient` 注释明言"IT DOES NOT MAKE THIS CALL POSSIBLE"），且 brief 三臂清单不含它；按封闭清单与 fail-closed 处理，保持原句。若 Spec 评审希望该臂也引导个人重连，需先改 Spec 而非顺手加。
3. **"另一公司的连接不能使本人请求通过"在本 suite 以"另一人"（otherId）覆盖**。该 fixture 库与本 suite 的数据模型无公司维度，跨公司插件隔离由 multitenancy 套件族承担（BASE 既有）；本任务新增用例钉住的是同一账户模型内"他人凭据既不通过也不改写 prompt 指向"。
4. **typecheck 诊断计数 3 与 ledger 预登记的"4 个"不一致**：同一文件（bootstrap-local-gateway.ts）同一批判别联合错误，实测 3 条 TS2339。系 ledger 计数口径（可能把多行诊断计两条）或 BASE 后续微漂移，非本任务文件，未处理，提请 V01 归并口径。
5. RED 复现采用文件级换入换出（`git show HEAD:` → 跑 → 恢复），全程未用 git stash；两次换入后均已恢复并以 GREEN 复跑确认（§3 数字即恢复后终态）。
