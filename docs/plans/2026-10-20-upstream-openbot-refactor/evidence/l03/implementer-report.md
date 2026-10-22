# L03 实施报告：分步登录表单与客户端兼容（A08 / Issue #496，端到端收口）

- 执行者：frontend_implementer。工作区：`.worktrees/upstream-openbot-update`（隔离 worktree；无 commit/push、未用共享 stash、未派发子 Agent）。
- 前置消费：L02 verified 的 `POST /api/sign-in-requests/:id/code`、`code_required` 状态机（服务端已不接受随密码的 `code`）。
- 证据文件：同目录 `red-first-run.txt`（RED 全量失败清单）、`green-final-run.txt`（GREEN 终跑 12/12）。
- 最终状态：**12 pass / 0 fail**（两个测试文件）；`bun run --filter app typecheck` exit 0；全部改动文件 `bunx biome format` exit 0；统一驱动 `E2E_BUN_ONLY=app/tests` 仅剩已登记基线红。

## 1. 改动摘要

| 文件 | 改动 |
|---|---|
| `app/src/lib/passwords/queries.ts` | `SignInStatus` 增 `code_required`（带文档注释："the site took the password and sent a verification code; the form asks for only that now"）。`FINAL_SIGN_IN` 保持四终态 `signed_in/failed/cancelled/expired`，零改动。 |
| `app/src/lib/passwords/mutations.ts` | ①`SignInSubmission` 删除 `code`（服务端本就不读，客户端不再发送）；②`confirmSavedLoginMutationOptions` variables 删除 `code`，body 只发 `{loginId}`；③新增 `submitSignInCodeMutationOptions(queryClient)`，variables `{id, code}`，POST `/api/sign-in-requests/:id/code`，`onSettled` invalidate `passwordKeys.all`（沿用本地 invalidate-only 惯例）；④`submit`/`submitCode` 两个携带秘密的 mutation 加 `gcTime: 0`——观察者一离开（reset 或卸载）缓存条目即被移除，秘密不滞留 TanStack MutationCache（上游无此约束，见偏差 4）。 |
| `app/src/components/passwords/sign-in-form.tsx` | ①初次表单只剩用户名/密码/保存勾选，删除内联 code 字段；②新增 `code_required` 分支：只显示 code 输入（`autoComplete="one-time-code"`、`inputMode="numeric"`、`autoFocus`）+ 必要说明 + sr-only `role="status"` live region，提交按钮 Finish signing in / Take over / Cancel；③新增 `filling` 分支：纯说明（"正在输入到 Bot 的浏览器"），零控件，3s 轮询自然接走——钉死"禁重复提交"；④`failure` 从派生 mutation.error 改为组件状态：携带秘密的 send 落定即 `setCode("")/setPassword("")` + `submit(.code).reset()`，失败句子先留存在 state 里再 reset，人能读到原因、可显式重试；⑤`forgetTyped()`：Decline/Cancel/Take over 一律清空 username/password/code + failure + reset 两个秘密 mutation；⑥卸载 `useEffect` 清理 reset 两个秘密 carrier；⑦保存密码勾选与其路径零改动（原行为保留）。 |
| `app/src/lib/copilot/sign-in-tool.tsx` | ①`SignInCard` 卸载时 `queryClient.removeQueries({ queryKey: passwordKeys.pending() })`——用户导航/切换组织关闭旧 request 绑定并清理旧查询结果；②handler 循环本身零改动：`FINAL_SIGN_IN` 不含 `code_required`，等待 turn 天然不提前返回成功（新增测试钉死）。 |
| `app/src/locales/{en,zh-CN}/common.json` | `signInForm` 词条（详见 §4）。**注意：是 common.json，非 brief 所写 settings.json**，见偏差 1。 |
| `app/tests/sign-in-code-step.test.tsx` | 新建，10 用例（见 §2）。 |
| `app/tests/sign-in-card.test.tsx` | 扩展（既有用例零改动语义）：①stub detail 路由改答 `open[0] ?? signInRequest`（既有用例行为不变）；②fixture `status/method/outcome/resolvedAt` 加宽类型标注（纯类型，运行时零变化）；③beforeAll 增 `i18n.changeLanguage("en")`（dialog 内共用组件翻译需要）；④新增用例 "the waiting handler keeps waiting while the site asks for a code"：code_required 期间 >2 个轮询周期 turn 不返回、dialog 内显示 code 步且无密码框、转 signed_in 后 turn 才带 verdict 返回、卸载后 pending 查询缓存清空。旧 code 字段 UI 的断言更新方式：旧内联 code 字段整体删除，由新文件 "the first step asks for a login, never for a code" 与 "the code step asks for only the code" 按新行为断言（无兼容性旧断言需要迁移）。 |
| `docs/verification/e2e-bun-suites.json` | 经 `node scripts/e2e-add-driven.mjs` 登记 `app/tests/sign-in-code-step.test.tsx`（files + causes，cause="runner named it: L03 A08: …"），`e2e-apply-partition.mjs` 重排 groups（新文件落入 `app/tests part 4`）。`node scripts/e2e-coverage-audit.mjs` → **no gaps**，exit 0。 |

## 2. RED → GREEN 证据

**RED（实现前，`bun test ./app/tests/sign-in-code-step.test.tsx`）**：**9 fail / 1 pass**（`red-first-run.txt`）。

| 用例 | RED 失败点 |
|---|---|
| the first step asks for a login, never for a code | 旧 UI 在 pending 就画 code 字段 |
| the first submission sends the password alone | 提交 body 含 `code`（`{password, code, save}`） |
| the code step asks for only the code | 无 code 步，落入完整登录表单 |
| a wrong code is cleared, explained, and can be sent again | 无 code 步可重试 |
| a settled send leaves no secret in the mutation cache | TanStack 保留 `{id, code}`/`{id, input:{password}}` variables（gcTime 默认 5 分钟） |
| a filling request offers nothing to submit again | filling 仍显示全部可点控件 |
| declining clears what was typed | Decline 不清已输入的密码/用户名 |
| unmounting mid-send leaves no secret in the mutation cache | 卸载后缓存仍持 code variables |
| the code step speaks both languages | 词条不存在（`t` 返回键名） |
| a closed request offers no controls | 实现前即绿（FINAL 分支钉子，保留） |

**GREEN（实现后）**：`bun test ./app/tests/sign-in-code-step.test.tsx` → **10 pass / 0 fail**；回归 `bun test ./app/tests/sign-in-card.test.tsx` → **2 pass / 0 fail**（原用例 + 新 code_required 等待用例）；两文件合跑 **12 pass / 0 fail**（`green-final-run.txt`）。

**测试基建说明（非生产让步）**：①输入用仓库惯例 `userEvent.type`（`fireEvent.change` 在 happy-dom+React 下不驱动受控状态，connection-fields.test.tsx 有同因注释）；②渲染用模块级 queryClient 单例（channel-history-refresh 等既有同例）——mutation factory 的 invalidate 闭包持有的就是该单例，per-test client 会让落定后的失效永远到不了渲染查询；③秘密卫生断言的 seam 是 `leaks(secret)`（MutationCache 全量 variables JSON 包含性），而非"缓存为空"——Cancel mutation 合法携带非秘密的 request id，见偏差 3。

## 3. 秘密清理矩阵

| 时刻 | 密码 | code | 证据 |
|---|---|---|---|
| 初次 UI | 输入框有，随 `/submit` 发送 | **UI 不出现、body 不发送** | "the first submission sends the password alone"：body `{password, save}` 精确相等 |
| code 步 UI | 不再显示/不再发送 | 只随 `/code` 发送，body 仅 `{code}` | "a wrong code…" 断言两次 `/code` body 精确 `[{code},{code}]` |
| 提交落定（无论成败） | `setPassword("")` + `submit.reset()` | `setCode("")` + `submitCode.reset()` | "a settled send leaves no secret in the mutation cache"：`leaks("correct horse")`/`leaks(CODE)` 均 false |
| 取消/拒绝/接管 | `forgetTyped()` 清 state + reset | 同左 | "declining clears what was typed"：两输入框空 + leaks false |
| 组件卸载 | 卸载 effect reset 两个 carrier（`gcTime:0` 令缓存条目即刻回收） | 同左 | "unmounting mid-send…"：send 在途即卸载，leaks(CODE) false |
| vault | 仅本人勾选保存时经既有加密 vault（服务端保存点在 code_required 分支，L02） | **从不进 vault** | 同 settled-send 用例断言全程零 `/api/passwords` 调用 |
| 缓存 | 秘密 mutation `gcTime: 0`：无观察者即从 MutationCache 移除（query-core `optionalRemove`），不等默认 5 分钟 gc | 同左 | 同上用例 |

## 4. i18n 词条（en / zh-CN，`common.json` → `signInForm`）

| key | en | zh-CN |
|---|---|---|
| `code`（改值） | "Verification code"（原 "…, if the site asks for one"） | "验证码"（原 "验证码（如网站要求）"） |
| `codeTitle`（新） | Enter the verification code | 输入验证码 |
| `codeDescription`（新） | The site asked for one after your password. Enter it to finish signing in. | 网站在密码之后要求验证码。输入它以完成登录。 |
| `codeStepNotice`（新，sr-only `role="status"` live region） | The site is asking for a verification code. Enter it to finish signing in. | 网站要求输入验证码。在此输入以完成登录。 |
| `finishSignIn`（新） | Finish signing in | 完成登录 |
| `checking`（新） | Checking… | 正在校验… |
| `workingDescription`（新，filling 说明） | Your login is being typed into the Bot's browser. This page continues on its own. | 你的登录信息正在被输入到 Bot 的浏览器中。此页面会自动继续。 |

复用既有词条：`signingIn`（filling 标题）、`takeOver`、`cancel`、`decline`、`signedIn/closed/noLongerOpen` 等。15 分钟等待窗口口径零改动（sign-in-tool `WAIT_MS` 未触碰）。双语言由 "the code step speaks both languages" 钉住。

## 5. format / typecheck / 统一驱动（真实 exit code）

- `bunx biome format` 逐一 exit 0：sign-in-form.tsx、queries.ts、mutations.ts、sign-in-tool.tsx、en/common.json、zh-CN/common.json、sign-in-card.test.tsx、sign-in-code-step.test.tsx（初查 4 个 .tsx 需折行，`--write` 后复验 exit 0，且 `git diff` 确认折行只发生在我新增的行）。
- `bunx biome check`（lint）：上述 5 个代码文件 **No fixes applied / 0 finding**；`sign-in-card.test.tsx` 余 1 处 `organizeImports`（:2）——经 `git show HEAD` 重放验证为 BASE 既有，同文件同行号复现，本人新增行零 finding。
- `bun run --filter app typecheck` → **exit 0**。
- 统一驱动：`E2E_BUN_ONLY=app/tests bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` → 6 组中 **5 组绿**（含承载两个 sign-in 套件的 part 4，39s）；唯一红为 `app/tests/ai-observability`（route-chain `queryClient.ensureQueryData` undefined，组内 billing-credits-ui 独跑即绿）——即 brief 登记的基线红，与本任务文件无交集。
- 覆盖对账：`node scripts/e2e-coverage-audit.mjs` → no gaps，exit 0。

## 6. 偏差与澄清（需编排者/验证者注意）

1. **i18n 落在 `common.json` 而非 brief/计划所写 `settings.json`**：`signInForm` 命名空间的事实源是 `app/src/locales/{en,zh-CN}/common.json`，组件与 `/sign-in/$requestId` 路由均 `useTranslation("common")`；settings.json 从无 signInForm 内容。Spec §5 只要求"两语言新词条"，未指定文件——按实际代码落 common.json，settings.json 零改动。此为 brief 文件清单与实际代码的冲突，按"以已批准 Spec 为准并记录"处理。
2. **旧 client 上游 code 字段的钉住方式**：brief 要求"加一条客户端不发送的钉住"。"the first submission sends the password alone" 用 `queryByLabelText(/Verification code/)` 条件输入：若回归出旧 code 字段则照常输入并断言 body 无 `code`（RED 即此形态）；"the first step…" 另行断言该字段不存在。未改服务端。
3. **秘密卫生 seam 从"缓存为空"改为"秘密不出现"**：Cancel/TakeOver 等 mutation 合法携带 request id（非秘密），断言改为 `leaks(needle)`（variables JSON 包含性）。秘密清理的语义不变且更精确。
4. **相对上游源码的取舍**：①未采纳上游 `onSuccess: show(queryClient)`（`setQueryData` 手工补缓存）——违反 `.claude/skills/openbot-data-access` 的 "invalidate, never patch"，本地保持 invalidate-only；②未采纳上游 `fallback` 句串——本地 `fallbackKey` 惯例零改动；③采纳上游 code 步输入框明文（无 `type="password"`，数字键盘 + `one-time-code`），取代本地旧内联字段的掩码样式；④本地额外物（上游没有）：`filling` 纯说明分支、`gcTime: 0` + 落定/取消/卸载 reset、sr-only live region、卡片卸载清 pending 查询、i18n——均出自 brief 明文要求（禁重复提交、mutation variables 清理、live region、旧绑定关闭）。
5. **`sign-in-card.test.tsx` fixture 类型加宽**（`status: "pending" as string` 等四处）：为让新增 code_required 变体通过 `serving((typeof signInRequest)[])` 参数类型；运行时值零变化，既有用例语义零变化。
6. **新增卡片测试显式 timeout 15s**：需跨越 handler 两个轮询周期（POLL_MS=1500）证明"不提前返回"，再等终态轮询；既有文件已无超时先例，bun 默认 5s 不够，属测试时间预算而非生产逻辑。
7. **manifest 分组重排的外溢**：`e2e-add-driven.mjs` 内建调用 `e2e-apply-partition.mjs` 重排 groups，把此前已登记进 `files`（由前序任务）的在途文件按字母序重新分箱；`files`/`causes` 层面本任务只新增 `app/tests/sign-in-code-step.test.tsx` 一项（cause 归属 L03），无文件被移除或改因。coverage audit 仍 no gaps。
8. **`filling` 分支显示 outcome/failure 但无任何控件**：服务端在 filling 期间 take-over/cancel/二次提交均 409（OPEN=[pending,code_required,taken_over]），UI 与服务端能力一致；最长 120s lease + 3s 轮询保证离开该屏。

## 7. 验证命令清单（实跑）

```
bun test ./app/tests/sign-in-code-step.test.tsx            # RED 9 fail/1 pass → GREEN 10 pass/0 fail
bun test ./app/tests/sign-in-card.test.tsx                 # 2 pass / 0 fail（含新增 code_required 等待用例）
bun run --filter app typecheck                             # exit 0
bunx biome format <8 个改动文件逐一>                          # 全部 exit 0
bunx biome check <5 个代码文件>                              # 0 finding（card 测试 1 处 BASE 既有 organizeImports）
E2E_BUN_ONLY=app/tests bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
                                                           # 5/6 组绿；唯一红 ai-observability = brief 登记基线红
node scripts/e2e-coverage-audit.mjs                        # no gaps, exit 0
```

秘密卫生：本报告与全部测试 fixture 仅含虚构值（`correct horse`、`313131`/`747474`、`shop.example`）；无任何真实凭据。
