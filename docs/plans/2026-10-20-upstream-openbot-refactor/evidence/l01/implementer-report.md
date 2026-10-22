# L01 实施报告：Computer 私有验证码 endpoint 与 gateway（A08 基础协议 / Issue #496）

- 执行者：backend_implementer。工作区：`.worktrees/upstream-openbot-update`（HEAD 3b4a7c68）。
- 未 commit/push、未用共享 stash、未派发子 Agent。生产改动仅限 brief owned_files + `server/tests/passwords-sign-in.test.ts`（brief §3 明示的 fake fixture 更新，见 §4）。
- 环境准备：`agent-computer` 为独立 package（非 bun workspace 成员），其 node_modules 缺失，已 `bun install --frozen-lockfile`（82 包，bun.lock 无变化）；`bunx playwright install chromium`（缓存目录，exit 0）。

## 1. 改动摘要

| 文件 | 改动 |
|---|---|
| `agent-computer/src/sign-in.ts` | 对齐上游两段式行为（按行为移植，非整文件复制）：`SignInFillInput` 去掉 `code`；`SignInFillResult` 增必填 `codeRequested: boolean`；`parseSignInFill` 不再读取 body 中的 `code`（旧服务端随密码带来的 code 被静默忽略，不报错）；新增 `SignInCodeInput`/`SignInCodeResult`/`parseSignInCode`（origin 校验、trim、上限 64、错误不回显值）/`fillSignInCode`（仅在已验证 origin 的当前页面定位 code 字段；跨 origin、无字段均明确拒绝且不输入）。`fillSignIn` 密码提交后只检测可见 one-time-code 字段并报告 `codeRequested`，绝不输入；沿用上游"先查 code 字段再查密码字段"的次序（防 site 把 OTP 画成 password input）、2 秒 grace 重查（迟到的 code 字段）、`passwordVisible` 排除被标记为 code 的字段。`markCodeField` 升级为上游版（清旧标记、computed style 可见性、readOnly 排除、aria-label 参与命名匹配、type 限 text/tel/number/password/""）。 |
| `agent-computer/src/index.ts` | 新增 `POST /sign-in/code` 路由，紧邻 `/sign-in/fill`，同一处理模式：parse 失败 400（错误句不含值）、`currentPage(botId)` 定位本 Bot 页面、`fillSignInCode` 输入、`submitted` 时 `session.snapshotId += 1`（ref 退役同 fill）；body 读取一次即弃，不入日志/响应。 |
| `agent-computer/src/authorisation.ts` | `ACTING_PATHS` 增 `/sign-in/code`：与 `/sign-in/fill` 同等服务认证（token 401 门）、Bot 范围（botId/session）、人工控制屏障（人握方向盘时拒绝）；`mutatesBrowser` 保持不含 sign-in 路径（同上游）。 |
| `server/src/computer/schema.ts` | `SignInFillResult` 增可选 `codeRequested?: boolean`（I3"兼容扩展"：未重部署的 agent-computer 不回传，缺省按"未要求"处理，同 `ScreenshotResult.url` 先例）；`SignInFillInput.code` 保留但标注 Deprecated（见偏差 1）；新增 `SignInCodeInput`/`SignInCodeResult`（与 I3 合约逐字段一致）。未动 `COMPUTER_TOOLS`/`COMPUTER_ACTING_TOOLS`——code 不是模型工具参数。 |
| `server/src/computer/gateway.ts` | `ComputerGateway` 接口与实现新增 `signInCode(botId, input, signal?): Promise<SignInCodeResult>`：与 `signIn` 同一 `post` 路径族（`/sign-in/code`）、同一 `SIGN_IN_BACKSTOP_MS`（75s）、同一 signal 透传；与 `signIn` 同一私有登录授权与审计边界（网关侧不写 audit row、不打日志、code 只在请求体）。 |
| `agent-computer/tests/sign-in.test.ts` | 扩展至 18 用例（原 6）：parse 层新增旧客户端 code 忽略、`parseSignInCode` 全边界；浏览器层新增 11 用例（见 §3）。fixture 增 2fa/迟到 code 字段/回密码页/跨 origin 第二服务器（`boundPort` 轮询兼容 e2e runner 的异步 bind，注释说明）；修正文件头过期注释（`bun test` 自迁到 e2e-compat 后已不是入口，Bun 的 node:module 无 registerHooks——HEAD 版本同样复现，属既有文档漂移）。 |
| `server/tests/computer-sign-in-code.test.ts`（新建） | 4 用例，native（e2e-compat，无 Bun API）：POST `/sign-in/code` + bot-id/token header + body 即 parse 输入；成功与 502 失败均 0 audit row 且错误不含 code；预中止 signal 在发出请求前拒绝（`ComputerStoppedError`、0 fetch）；computer 的 codeFieldVisible 拒绝报告原样透传（不是网关错误）。 |
| `server/tests/passwords-sign-in.test.ts` | fake gateway 的 `Pick` 扩为 `"signIn" \| "signInCode" \| "requestHelp"`，`signInCode` 实现为诚实 fake（记录并返回 codeFieldVisible:true，不伪装成功）；service 17/17 回归绿。 |
| `docs/verification/e2e-bun-suites.json` | **未改动**——对账结论：新 suite 为 native 层（见 §5）。 |

## 2. I3 合约对照

| I3 条目 | 实现 | 证据 |
|---|---|---|
| `SignInFillInput.code` 新客户端不再发送；忽略旧客户端 code 不提前输入 | Computer 层类型删字段 + parse 不读取；server 层保留 deprecated 字段（转发即被 Computer 忽略）；`fillSignIn` 无任何 code 输入路径 | sign-in.test.ts："a code an old client sent along…"、"a code field sitting next to the password is not filled at the first submit" |
| `SignInFillResult` 兼容扩展 `codeRequested?`，仅实际检测到可见字段才 true，输入值从不回传 | agent-computer 必填（本进程总是报告）；server schema 可选（兼容未重部署 computer）；仅 `markCodeField` 在已验证 origin 命中可见字段才 true | "a visible one-time-code field is reported…"；"no code field is no codeRequested" |
| `SignInCodeInput`/`SignInCodeResult` 独立 parse/fill；code 字段只在已验证 origin 当前页面定位；跨 origin 明确拒绝 | 两层类型逐字段 = 合约；`fillSignInCode` 开头 origin 检查 + `markCodeField` 当前页定位；跨 origin/无字段拒绝且 0 输入 | "the right code finishes…"、"with no code field…"、"a page that has moved off the origin refuses…"、"a site that moved the code step to another origin is not followed" |
| `POST /sign-in/code` 与 fill 同等服务认证/Bot 范围/人工屏障；不注册为模型工具 | dispatcher 统一 token 401 门 + `actsOnTheComputer` 人工屏障（ACTING_PATHS 新增）+ botId session 隔离；`COMPUTER_TOOLS`/headless-tools 零改动 | authorisation 13/13、action-barrier 2/2；headless-tools 的 `computer_request_sign_in` 定义未触碰 |
| gateway `signInCode(botId, input, signal?)`，与 signIn 同一私有登录授权与审计边界；schema 对应类型；上限 64、沿用 parse* 风格 | 接口+实现同一 post 族/backstop/signal；无 audit row 无日志（测试钉住）；64 上限在 `parseSignInCode`（=65 拒、=64 过） | computer-sign-in-code 4/4；sign-in.test.ts parse 边界用例 |

## 3. RED→GREEN 证据

**RED（实现前）**
- `E2E_UNIT_SCOPE=agent-computer bunx e2e run --config e2e.unit.config.ts agent-computer/tests/sign-in.test.ts` → `COLLECTION_ERROR: The requested module '../src/sign-in' does not provide an export named 'fillSignInCode'`（I3 生产者缺失；parse 层与浏览器层 RED 同被收集失败覆盖——与 U01 先例同型）。
- `E2E_UNIT_SCOPE=server … server/tests/computer-sign-in-code.test.ts` → **4 failed / 0 passed**，全部 `gateway.signInCode is not a function`。

**GREEN（实现后）**
- 浏览器全量：`OPENBOT_COMPUTER_BROWSER=1 E2E_UNIT_SCOPE=agent-computer bunx e2e run --config e2e.unit.config.ts agent-computer/tests/sign-in.test.ts` → **18 pass / 0 fail**（真实 Chromium；含正确 code、错误 code→字段仍在、回密码页→passwordFieldVisible、DOM 消失拒绝不输入、about:blank 与第二 origin 双重跨 origin 拒绝、迟到 2.5s 出现的 code 字段经 grace 命中、跨 origin code 步不被跟随且不输入、secrets 不回读回归）。
- 无浏览器（CI 同款）：同命令不带 env → 3 pass / 15 skipped（skipIf 机制，原生收集不受影响）。
- `E2E_UNIT_SCOPE=server … server/tests/computer-sign-in-code.test.ts` → **4 pass / 0 fail**。
- 回归：`passwords-sign-in.test.ts` **17 pass**；`computer-gateway.test.ts`（driven）`bun test` 单文件 **75 pass / 0 fail**；`agent-computer/tests/authorisation.test.ts` 13 pass；`action-barrier.test.ts` 2 pass。
- 覆盖说明：Playwright 15s STEP_TIMEOUT 本身未用真实 15s 用例 exercising（沿既有套件取舍，避免每次 +15s）；迟到字段用例真实走过 2s grace 计时路径。

## 4. fixture 更新清单（grep 所有 ComputerGateway fake）

- **更新**：`server/tests/passwords-sign-in.test.ts` fakeGateway——唯一实现 signIn 契约的 fake（`Pick<ComputerGateway, "signIn" | "requestHelp">`），显式补 `signInCode` 诚实 fake，未加新类型断言掩盖。
- **盘点不动（14 处，8 文件）**：`computer-routes`（4）、`computer-page-frame-route`（2）、`computer-download-routes`（2）、`computer-exec-timeout`、`computer-fleet-route`、`computer-human-input`、`computer-scroll-delta`、`computer-snapshot-id`——全部是 route 级最小 fake（只 fake 该 route 触及的方法），**无一含 signIn**（grep 证：8 文件 0 处 signIn），本任务接口扩展为加法不破坏其 typecheck（`bun run --filter server typecheck` 通过佐证）；逐一补未行使的 `signInCode` 属无行为噪音，按仓库"fake 只 fake 行使路径"惯例不动。`passwords-sign-in.test.ts:573` 的 `{} as ComputerGateway` 为 BASE 既有 cast，行使路径不触网关方法，不动。
- 其余 `createComputerGateway(...)` 构造（approvals、gateway、handoff 等 12 文件）为真实工厂，无需更新。

## 5. 归层对账

- `server/tests/computer-sign-in-code.test.ts` import `tests/support/e2e-compat`，不 import `bun:test`/`bun-test-compat`，不用 Bun 运行时 API → **native 层**（e2e.unit.config 直接收集执行，§3 实跑为证）。
- 按 ADR 0008/清单惯例，仅 Bun 运行时套件登记 `e2e-bun-suites.json`；native 套件由 SUITE_DIRS 自动收集。故 **本任务不需登记行，manifest 未改动**（文件在任务分派前已含前批任务的合法改动，非我所写）。
- 对账证据：`node scripts/e2e-coverage-audit.mjs` → exit 0，"1056 suite files · 577 native · 464 driven · 9 engine · 6 named exclusions · **no gaps**"（新文件在册并被 native 桶计数）。
- `agent-computer/tests/sign-in.test.ts` 维持 native（浏览器组经 `OPENBOT_COMPUTER_BROWSER=1` 在同一入口内启用）。

## 6. format / typecheck 自查（真实 exit code）

- `bunx biome format` 逐一：exit 0 —— `sign-in.ts`、`index.ts`（初查 exit 1 系本人 import 行超 80 列，按 biome 建议折行后复查 exit 0）、`authorisation.ts`、`agent-computer/tests/sign-in.test.ts`、`schema.ts`、`computer-sign-in-code.test.ts`（初查 exit 1 两处本人新增行，`--write` 后 exit 0）、`passwords-sign-in.test.ts`；**exit 1 —— `server/src/computer/gateway.ts`，BASE 既有漂移**（`git show HEAD:` 版本同 exit 1，唯一差异点 :909 revokeControl 参数，非本人新增行；本人新增行不在 format 差异内），按 S01 先例登记不触碰。
- `bunx biome check`（lint）：本人新增/修改行无 lint finding；剩 `organizeImports` 3 处（两测试文件 + passwords-sign-in）经 HEAD 版本对照**均为 BASE 既有**（与台账 S03 漂移同类），不触碰；`computer-sign-in-code.test.ts` 的 2 处 `noUnsafeOptionalChaining` 系本人代码，已改写消除后该文件 check 全绿。
- `bun run --filter server typecheck` → 仅 `scripts/bootstrap-local-gateway.ts(106/108/120)` 3 条 TS2339，**与台账登记的 BASE 红完全一致**，本任务文件零报错。
- `cd agent-computer && bun run typecheck`（tsc --noEmit）→ exit 0。

## 7. 偏差（需编排者/验证者注意）

1. **`SignInFillInput.code` 在 server schema 保留一个任务周期（最重要的偏差）**。上游直接删除该字段；I3 合约要求"新客户端不再发送"。本地 `passwords/service.ts:265-270` 仍向 gateway 传 `code`，而该文件属 L02（brief 明令不改）。若本任务删字段，service.ts 立即 typecheck 红，构成越权改动或断树。处置：server 类型保留字段 + Deprecated 注释（Computer 侧已忽略，行为即 Spec §5"旧客户端 code 被忽略"），L02 删除发送方时一并删字段。**行为无分歧，仅字段生命周期后移一个任务**。
2. **`markCodeField` 命名启发式随上游收窄**：本地旧版匹配 `token` 且不查 aria-label；上游版匹配 `passcode`/aria-label 且不再匹配 `token`、排除 password 型字段（防 site 把 OTP 画成 password input 的误判）。按 brief"按行为对齐"取上游；同时收紧可见性判定（computed style/readOnly），因为 `codeRequested` 将成为 L02 状态机迁移条件，假阳性会把请求错误导入 code_required。
3. **测试基建两处修正**（均为让断言对准真实合约，非修绿）：`boundPort()` 轮询——e2e runner 的 Bun.serve 替身异步 bind，直读 `.port` 得 0（真实 Bun 同步 bind 不受影响），不加则 14 个浏览器用例在 native 入口全灭；文件头注释同步改为实际可用入口（`bun test` 在 HEAD 上即因 Bun 缺 `node:module.registerHooks` 无法加载 e2e-compat，属既有漂移）。
4. `e2e-bun-suites.json` 在 owned_files 内但**零改动**，理由见 §5——对账结论是"native 层无需登记"，不是遗漏。
5. 环境侧操作（非代码改动）：agent-computer `bun install --frozen-lockfile` + `playwright install chromium`；另发现共享 stash 栈存在 1 条他人条目（`stash@{0} WIP on main`），未触碰。

## 8. 证据文件

- `after-tracked.diff`（40 文件全树 tracked diff，含前批任务在途改动，本任务 8 文件见 `git diff --stat` 于 §1 表）/ `after-status.txt` / `sha256.txt`（8 个改动文件 + 新 suite 完整副本 + diff 的 SHA-256）。
- 秘密卫生：本报告与全部 fixture 仅含虚构值（`hunter2-not-for-the-model`、`918273-fixture-not-a-real-code` 等）；无任何真实凭据。
