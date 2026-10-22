# U02 独立 Review（Task U02：服务端连接提示共享合约 / A06 服务端半部 / Issue #495 / 本地票 up06）

- Reviewer：独立 reviewer（OCR 已取消，本 review 为最终质量关口）。
- 日期：2026-10-20。工作区：`.worktrees/upstream-openbot-update`（HEAD 3b4a7c68，未提交树）。
- 性质：只读审查（唯一写入为本文件）。未改源代码/测试/文档，未 git commit/stash/push，未派发子 Agent。
- 对象：`shared/connect-prompt.ts` + `shared/connect-prompt.test.ts`（untracked 新文件）、`server/src/plugins/store.ts`（+38/−5）、`server/tests/plugin-user-credential.integration.test.ts`（+114）、`server/tests/plugin-connect-route.test.ts`（+52）。
- 事实源：Spec §4 前两条（`docs/specs/2026-10-20-upstream-openbot-adoption-design.md:77-78`）、票据 up06 criteria 前两条、brief I2 合约、上游参考 `evidence/upstream-sources/shared/connect-prompt.ts`。

## 1. 独立复核结果（全部由本 reviewer 亲自执行）

| 检查 | 命令 | 结果 |
|---|---|---|
| codec native suite | `E2E_UNIT_SCOPE=shared bunx e2e run --config e2e.unit.config.ts shared/connect-prompt.test.ts` | **11 pass / 0 fail** |
| connect-route native suite | `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/plugin-connect-route.test.ts` | **5 pass / 0 fail** |
| user-credential driven suite | `TEST_DATABASE_URL=…5433/openbot_test bun test ./server/tests/plugin-user-credential.integration.test.ts` | **16 pass / 0 fail / 45 expect** |
| 回归：plugin-store | 同库 `bun test ./server/tests/plugin-store.integration.test.ts` | **135 pass / 468 expect** |
| 回归：shared-brokered-store | 同上 | **14 pass / 71 expect** |
| 回归：server-side-tools | 同上 | **5 pass / 12 expect** |
| biome format | `bunx biome format` 逐文件 | 4/5 exit 0；`plugin-user-credential.integration.test.ts` exit 1 经 HEAD 版本复现（首行 import 98 字符）= **BASE 既有漂移**，与本任务无关 |
| 审计对账 | `node scripts/e2e-coverage-audit.mjs` | 563 native / 462 driven；GAPS 13 条均 BASE 已提交文件（multitenancy/key-status 族）；`shared/connect-prompt.test.ts` 不在 GAPS |
| 清单对账 | `e2e-bun-suites.json` grep | `shared/connect-prompt.test` 0 命中（native 免登记）；`plugin-user-credential` 在 :466/:1021 |
| SHA-256 | `shasum -a 256` 五文件 | 与 implementer §5 全部吻合（03fe33c8 / cd6e2aa8 / bcd7dea3 / 6729ca9d / d87aa0c3） |
| U02 tracked 增量 | before/after-tracked.diff 文件清单 comm | 恰为 3 个 owned 文件；store.ts hunk 与 live `git diff` **逐字节一致**；`e2e-bun-suites.json` 段 before/after **逐字节相同**（U02 零改动成立） |
| RED 证据 | `red-store-run.txt` / `red-codec-collection.txt` | 失败行 638/657/670 与现文件 `not.toBeNull()` 行重合；37 expect = 45 − 8（三个首断言中止用例 3+2+3）算术自洽；codec RED 为 mv 互换复现采集（实施者已如实披露），可信 |
| 独立对抗探针 | /tmp 临时 bun 脚本（未入仓库） | 见 §3 F-02/F-04 |

## 2. Spec compliance 核对（pass）

1. **以现有拒绝结果携带结构化提示** ✓：四分支均为在既有 `PluginRefusedError.message` 内经 `connectAppRefusal` 包装原句，无新错误类型、无路由改动、审计路径不动（`tools.ts` 不在 diff，`REFUSAL_MARKER` 信封 ：36/:257 逐字未动）。
2. **四分支恰为"个人可自助连接"** ✓（store.ts 实读核对）：
   - :1842 brokered 个人 holder 无连接行（`resolved.ref.holder !== "deployment"` 臂，Shared 臂 ：1833 纯文本在上）；
   - :1925 person-oauth 队前无连接行；
   - :2128 排队期间事务内读不到连接行；
   - :2154 事务内 `FOR UPDATE` 读到 row 消失或 `revokedAt` 非空。
   `serverId: row.id` 与 connect endpoint `POST /servers/:id/connect` 的 `:id`（`store.serverAddress` 按 id 读行，routes.ts:1379-1412）同一定义，合约注释（connect-prompt.ts:25-26）成立。
3. **保持原拒绝原因的分支** ✓ 逐一实读为纯文本：Shared 部署账户 :1833、server 级凭据 :1862、noClient 手动 :1960 / 动态 :1959、unusableClient :1962-1963、clientReplaced :1977、缺 Bot grant :7982。
4. **提示仅用于展示** ✓：codec 只产出 serverId/title/message 三个展示字段，不产 URL/origin；marker 居中于文本 → null（套件 + 独立复测）；connect endpoint actor 只来自 session（routes.ts:1379 `requireUser`、:2124 `sealConnectState({ userId: context.var.actor.id, serverId, … })`、:2562 `personHasAccess(state.userId)`），新钉住用例实证 body 的 `userId`/`serverId` 冒名被完全忽略（ensureCalls 收到 session actor，state 拆封 `userId === "user-1"`）。codec 结果不是该端点的任何输入。
5. **I2 合约** ✓：签名逐字一致；bounds 256/200/4000/8192；违规/截断/类型错/非对象一律 null；hostile title（`}`+引号+反斜杠）roundtrip；解析不用首个 `}`。

## 3. Findings（编号 + 严重度）

### F-01（low，文档准确性）
`shared/connect-prompt.ts:72-74` 注释称 roundtrip "holds for whatever a caller passes"，但空串 `serverId`/`title`（或 trim 后为空 message 场景之外的空字段）经 writer 发出后 reader 返回 null——roundtrip 对该输入不成立。四个 store 调用点传 `row.id`/`entry.title`（非空），实际不可达；对"命不出任何东西的卡片"fail closed 本身是正确行为。仅注释过度承诺，建议后续微调措辞（不阻断、不要求本轮修）。

### F-02（info，上游分叉实证）
独立复现上游 `indexOf("}")` 缺陷：对 title 含 `}` 的 wire，截断前缀必以未闭合字符串字面量结束，`JSON.parse` **直接 throw → null，卡片整体丢失**（并非"画出截断标题的卡"——比静默截断更干净的弃卡失败）。本地 `objectEnd` 对同一 wire 完整 roundtrip。分叉必要性成立，测试用例 1 的注释与实际失败模式相符。

### F-03（info，状态机复杂度权衡）
`objectEnd` 状态机（inString/escaped/depth 三态）实读正确：`\\` 成对消耗、`\"` 不出串、未闭合串 → null、嵌套按 depth 配平；**payload 帽检查（:134）先于扫描**，扫描 O(n) 且 n ≤ 8192，无大输入 DoS 面。深度计数对"只取外层对象配平"的需求略冗余（flat 的 in-string 追踪 + 首个顶层 `}` 即够），但多出的复杂度约 5 行且不引入错误路径，可接受，不建议改。性能探针：8KB payload × 1000 次读取远低于 500ms。

### F-04（judgment，偏差 1：writer 侧 clamp——采纳）
独立验证 199 组随机转义重载输入（控制字符 serverId/title，message 递增）：**全部 payload ≤ 8192 且全部可解析回**。budget 在 stringify 之后的 JSON 上度量，转义膨胀被真实计入。采纳实施者判断：服务端自产 payload 若被自己的 reader 拒收即卡片静默丢失，恰是长度界要防的事故；"越界退化为纯文本"会静默降级 UX，是更差的失败模式。writer clamp 是对 I2 文字的正确补全，方向更严，无需 Spec 修订。

### F-05（judgment，偏差 2：动态 noClient 不加 marker——采纳，同意升格 Spec 修订候选，但收窄候选范围）
独立读 store.ts:1939-1983 上下文后的结论：
1. **流程正确**：Spec §4 :78 "只对…账户缺失/断开/撤销" 是账户状态的封闭枚举；noClient 是部署侧能力缺口而非账户状态，不加 marker 恰是 Spec 合规读法。Phase B 未静默扩 Spec，正确。
2. **语义上验证者观察成立**：动态变体原句自述"the deployment registers itself with the vendor when somebody connects"，个人在 Settings 发起 connect 时 `ensureOAuthClient` 会以本人身份自注册，卡片可闭环。
3. **但对验证者 §6 建议做一处收窄**：Spec 修订候选应限定为**动态注册变体**（noClient-dynamic :1959；如需可含 unusableClient-dynamic :1962）。`clientReplaced`（:1977）**不应入候选**——该臂 throw 时部署已自注册完毕（注释与句子均明言），connect 卡片指导的是冗余动作，重试即应成功。
4. 在 Spec 修订前维持原句 + 无 marker 是正确落点。

### F-06（judgment，OBS-1/OBS-2 是否本轮补钉——不需要）
- OBS-1（Shared 部署臂无 marker 缺席钉住）：属实。`expectOnlyRefusal`（helpers/refusals.ts:181-193）为 `toMatch` 正则断言，前缀 marker 不影响命中——该臂 marker 缺席确实无测试兜底，靠 diff 审查。
- OBS-2（动态 noClient/unusableClient/clientReplaced 无缺席钉住）：属实。
- **本轮不补**：两处钉住都要触碰 U02 owned_files 之外的套件（shared-brokered-store / user-credential 既有用例），在 owned_files 纪律下扩界代价比收益高；当前四臂由"已审 diff + 新 describe 头注释合约 + 既有两处 no-marker 钉住先例"保护，无现实缺陷。处置：OBS-1 钉住与 OBS-2 的动态臂钉住**并入 F-05 的同一张 Spec 修订票**，随 Spec 决议一并落（届时该臂语义已定，钉住写法不会返工）。

### F-07（major 以下，交接风险，同意验证者 OBS-3）
实读 `tools.ts:257`：工具结果文本为 `Refused. [connect-app]{…} 句子`，而 `readConnectPrompt` 要求 marker 在 index 0。U03/U04 若对整段 tool-result 文本直接调用 codec 将**永远得到 null、卡片永不绘制**。U02 侧无缺陷（信封保留是 brief 明令），但这是硬性交接要求：**U03/U04 brief 必须写明读取点是 `PluginRefusedError.message`（剥 `Refused. ` 信封前段）或以包含定位**。请编排者在派发 U03/U04 前把该句写入 brief。

### F-08（info，测试结构）
11 用例全部经公共 seam（`connectAppRefusal` → `readConnectPrompt`）断言 wire 行为：roundtrip、fail-closed、边界（含"帽在 trim 之前生效"的 9000 空格用例）、旧客户端可读（`endsWith`）、marker 居中不升级。未直接 poke 私有 `objectEnd`。行为而非实现，合格。

### F-09（info，集成覆盖面备忘）
四个 marker 臂中，集成测试直接钉住臂 2（:1925 未连接）与臂 4（:2154 撤销）+ 两处 no-marker 钉住；臂 1（brokered 个人）仅由 plugin-store 的消息正则间接覆盖、臂 3（排队竞态断开）因事务内竞态难直接驱动、与臂 2 同句。可接受，记录备查。

### F-10（info，报告声明核对）
implementer/validator 两报告抽核的全部可验证声明（四分支行号、纯文本分支清单、SHA-256、diff 字节一致性、清单登记、审计计数、RED 数字与行号、format 漂移归属、typecheck 诊断归属 `scripts/bootstrap-local-gateway.ts`）**均与源码/实跑事实相符**，未发现虚报。validator 对偏差 2 的升格建议被本 review 采纳并收窄（F-05.3）。

## 4. 结论

无阻断、无 major 问题。F-07 为派发 U03/U04 前的 brief 编辑动作（非代码返工）；F-01/F-06 为低优先级后续项；F-05 交回 Matt 侧 `to-spec` 一张票。

Spec compliance: pass
Code quality: pass
