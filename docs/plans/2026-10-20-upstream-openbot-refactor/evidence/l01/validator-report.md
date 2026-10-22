# L01 验收报告（backend_validator）

- 验证者：backend_validator（只读验收，仅写本报告）。
- 工作区：`.worktrees/upstream-openbot-update`（HEAD 3b4a7c68，与实施时一致）。
- 验证时间：2026-10-20。所有命令均由验证者亲跑，输出截取自真实运行。
- 范围声明：树中另含 S01–S04/U01–U04 已裁决在途改动，不在本次验收内；以下仅针对 L01 增量。

## 总结论：**PASS（接受，含 3 条 minor 备注，无 blocker）**

## 1. 行为 — PASS

亲跑命令与结果：

| 形态 | 命令（cwd = 工作区根） | 结果 |
|---|---|---|
| 本地 Chromium 全量 | `OPENBOT_COMPUTER_BROWSER=1 E2E_UNIT_SCOPE=agent-computer bunx e2e run --config e2e.unit.config.ts agent-computer/tests/sign-in.test.ts` | **18 pass / 0 fail**（22.93s，真实 Chromium） |
| CI 形态 | 同命令去掉 `OPENBOT_COMPUTER_BROWSER=1` | **3 pass / 15 skipped**（skipIf 机制，共 18） |
| server 新套件 | `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/computer-sign-in-code.test.ts` | **4 pass / 0 fail** |

断言抽查（逐条读了测试体，非只看标题）：

- **codeRequested 仅在密码提交后实测到可见 one-time-code 字段**：`"a visible one-time-code field is reported, and left for the person to fill"` 断言完整 result 形状（codeRequested:true）且该字段 inputValue 为空串（未输入）。PASS。
- **无字段不报告**：`"no code field is no codeRequested"` 断言 codeRequested:false + passwordFieldVisible:true。PASS。
- **旧客户端 code 被忽略**：parse 层 `"a code an old client sent along…"` 断言带 code 的 body parse 结果恰为 `{origin, password}`（code 丢弃、无错误）；浏览器层 `"a code field sitting next to the password is not filled at the first submit"` 断言密码单独提交、落点页无 code 请求。PASS。
- **code 字段只在已验证 origin 当前页定位、跨 origin 明确拒绝**：`fillSignInCode` 入口即查 `originOfUrl(page.url()) !== input.origin`；测试钉了 about:blank 与第二真实 origin（`elsewhere` server）双重拒绝，且另一 origin 上的 code 字段 inputValue 为空；`"a site that moved the code step to another origin is not followed"` 断言 codeRequested:false + error 含目标 origin + 字段未输入。PASS。
- **输入值从不回传**：`JSON.stringify(result)` not.toContain(CODE)、not.toContain(PASSWORD)（两处）；SignInCodeResult/SignInFillResult 形状无任何值字段。PASS。

## 2. I3 对照 — PASS

- **SignInFillResult.codeRequested 兼容扩展**：agent-computer 侧必填（与上游一字不差——`diff` 证实本地 `sign-in.ts` 与 `evidence/upstream-sources/agent-computer/src/sign-in.ts` **仅多一行注释**，行为移植完整）；server schema 侧可选 `codeRequested?: boolean`，注释写明"未重部署的 agent-computer 不回传，缺省按未要求处理"。兼容方向（server 收旧 computer）处理正确。
- **SignInCodeInput/Result 形状**：两层类型逐字段 = 合约（origin/code / submitted/codeFieldVisible/passwordFieldVisible/url/error?）。PASS。
- **`POST /sign-in/code` 守卫**：亲读 dispatcher——token 401 门（index.ts:751-758，作用于全部非 open path）、botId 400 门（:768）、`actsOnTheComputer` 人工控制屏障（:803，经 `ACTING_PATHS`，authorisation.ts:84 新增 `/sign-in/code`）；`currentPage(botId)` 做 Bot 隔离；`mutatesBrowser` 不含 sign-in 路径（与 fill 同）。与 `/sign-in/fill` 完全同模式。PASS。
- **gateway signInCode 同一私有边界与 backstop**：同一 `post` 族、同一 `SIGN_IN_BACKSTOP_MS`（75s）、signal 透传；接口注释明示"no audit row here"；对照同文件 `requestSecret`/`supplySecret`（写 audit）确认 signIn/signInCode 均不写。computer-sign-in-code 测试钉 0 audit row。PASS。
- **schema `code` 标 Deprecated**：server `SignInFillInput.code` 保留 + Deprecated JSDoc（schema.ts:330-335）。理由成立（见偏差 1）。PASS（附备注 M1）。

## 3. 安全 — PASS

- **未注册为模型工具**：`COMPUTER_TOOLS`/`COMPUTER_ACTING_TOOLS` 零改动（读 schema.ts:23-64 现值并对照 diff，diff 不含这两个数组）；`grep -rn signInCode server/src` 仅命中 computer/gateway.ts；headless-tools 未触碰。
- **code 不入持久层/日志**：gateway 新增代码无 audit/log 调用（diff 逐行核过）；index.ts 路由 body 读取一次即弃（parse→fill→json(result)，无日志无存储）；sign-in.ts 无任何存储路径，`typeSecret` 打 SECRET_ATTRIBUTE 使快照/截图掩码；server 测试钉"成功与 502 均 0 audit row 且错误不含 code"。PASS。
- **错误不回显输入值**：`parseSignInCode` 全部错误为固定句式（无模板插值）；`fillSignInCode`/`fillSignIn` 的 catch 返回模块自有句式；测试断言 parse 错误与 result 均不含值。PASS。

## 4. 范围与回归 — PASS

- **L01 增量恰 7 改 + 1 新**：`agent-computer/src/{sign-in,index,authorisation}.ts`、`agent-computer/tests/sign-in.test.ts`、`server/src/computer/{schema,gateway}.ts`、`server/tests/passwords-sign-in.test.ts`（改）+ `server/tests/computer-sign-in-code.test.ts`（新）。逐文件核 diff：authorisation.ts 仅 ACTING_PATHS +3 行；其余均在 owned_files 内。`e2e-bun-suites.json` 的树内改动内容为前批任务（auto-watch-screen 等），**零** `computer-sign-in-code` 引用——L01 零改动成立（新套件为 native 层，无需登记）。
- **fake gateway 诚实**：`passwords-sign-in.test.ts` 的 `Pick` 扩为 `"signIn" | "signInCode" | "requestHelp"`，`signInCode` fake 记录提交并返回 `codeFieldVisible: true`（报告字段仍在，不伪装成功），无类型断言掩盖。grep 全部 ComputerGateway 测试文件：除新套件外**所有 fake 文件 signIn 提及数为 0**——不存在需要补而未补的 fake。PASS。
- **回归亲跑**：passwords-sign-in **17/17**（native e2e）；computer-gateway **75/75**（driven 层，按 ADR 0008 用 `bun test server/tests/computer-gateway.test.ts`）；authorisation **13/13**、action-barrier **2/2**（agent-computer scope）。三个全跑，超过"抽跑两个"要求。
- **对账**：`node scripts/e2e-coverage-audit.mjs` exit 0，"no gaps"（本跑 1056 文件 / 564 native / 477 driven——与实施报告 577/464 的差异系主控 U03-W1 还原 13 文件所致，no gaps 结论不变）。
- **typecheck**：`cd agent-computer && bun run typecheck`（tsc --noEmit）exit 0；`bun run --filter server typecheck` 仅 `scripts/bootstrap-local-gateway.ts(106/108/120)` TS2339——与台账 V01 预登记 BASE 红完全一致，该文件树内未改动，L01 文件零报错。
- **format**：`bunx biome format server/src/computer/gateway.ts` exit 1 亲跑证实，且 HEAD 版本落 /tmp 单独 format **同样 exit 1**（同一处 :897/:909 revokeControl `observed?: {…}` 单行参数）——BASE 既有漂移，非 L01 引入；其余 L01 文件 format 干净（新套件 e2e 直跑通过侧面佐证无语法异常）。

## 5. RED 真实性与偏差 — PASS（附备注）

**RED 逻辑一致性**：BASE（HEAD）亲查——`git show HEAD:agent-computer/src/sign-in.ts` 导出表无 `fillSignInCode`/`parseSignInCode`（扩展后的测试 import 它们必然 COLLECTION_ERROR）；`git show HEAD:server/src/computer/gateway.ts` 中 `signInCode` 出现 0 次（4 个用例运行期必然 `gateway.signInCode is not a function`，4 fail / 0 pass）；HEAD 测试文件 6 用例 → 现 18，增量 12 与报告相符。报告所述两种 RED 形态是 BASE 状态的必然结果，**逻辑一致**。备注 M2：RED 运行输出未存档为证据文件（evidence/l01/ 仅 after 系），依赖重建推理；可接受。

**偏差 1（server 侧 `code` 字段 Deprecated 保留一个任务周期）——接受**：亲查 `server/src/passwords/service.ts:269` 与 `:481` 确实仍向 gateway 传 `code`，该文件属 L02（L01 brief 明令不改），L01 删字段必致断树或越权。行为无分歧（Computer 侧已忽略，恰是 Spec §5"旧客户端 code 被忽略"）。**备注 M1**：L02 brief 的 owned_files **不含** `server/src/computer/schema.ts`——"L02 删除发送方时一并删字段"目前无任务可执行（L02 不能改 schema.ts）。需编排者在派发 L02 时把该单字段删除补进 L02 owned_files，或指定后续任务，否则 Deprecated 字段会无限期滞留。**不阻塞 L01 验收**。

**偏差 2（markCodeField 启发式收窄）——接受**：亲对比 HEAD 与现版：HEAD 匹配 `token`、不查 aria-label、无 computed style/readOnly 检查，且 HEAD 的 `fillSignIn` 在初次提交就 `typeSecret` 输入 code（现版已彻底移除该路径）；现版正则 `/code|otp|totp|2fa|mfa|verif|passcode/i` 与上游 ：184 逐字符一致、password 型不参与启发式、可见性收紧。`codeRequested` 将成 L02 code_required 迁移条件，收窄防假阳性，方向正确。

**偏差 3（测试基建修复）——接受，且全部在 owned 内**：`boundPort()` 轮询与文件头注释修正**均在 `agent-computer/tests/sign-in.test.ts`（owned_files 之内）**，未触碰 `tests/support/`、`scripts/`、`e2e.unit.config.ts`（亲查 git status 为空）。无需点名文件外归属。

## 问题分级汇总

| 级别 | 条目 | 处置 |
|---|---|---|
| blocker | 无 | — |
| major | 无 | — |
| minor M1 | Deprecated `code` 字段的删除义务未落在任何任务的 owned_files（L02 brief 不含 computer/schema.ts） | 编排者派发 L02 时补 owned_files 或指定后续任务 |
| minor M2 | RED 运行输出未存档（仅报告文字描述）；BASE 状态反推逻辑一致 | 记录在案，后续任务建议留 red-run 文本 |
| minor M3 | 实施报告引 action-barrier 2/2 未标 scope（实为 agent-computer scope） | 仅记录；套件亲跑通过 |

## 验收判定

**L01 验收通过**。行为、I3 合约、安全边界、范围纪律、回归与类型/对账证据全部达标；三条 minor 均不阻塞，其中 M1 需编排者跟进 L02 派发。
