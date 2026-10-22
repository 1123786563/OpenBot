# L03 验收报告：分步登录表单与客户端兼容（A08 / Issue #496）

- 验证者：frontend_validator（只读验证；唯一写入为本报告）。工作区：`.worktrees/upstream-openbot-update`。
- 日期：2026-10-20。材料：`brief.md`、`implementer-report.md`、`before/after-tracked.diff`、`red-first-run.txt`、`green-final-run.txt`、`app/tests/sign-in-code-step.test.tsx`。
- **总判定：PASS（5/5 项通过；0 阻塞 / 0 严重 / 3 条 INFO 级观察）**。

## 1. 行为 — PASS

亲跑 `bun test ./app/tests/sign-in-code-step.test.tsx ./app/tests/sign-in-card.test.tsx` → **12 pass / 0 fail**（34 expect，7.09s），与 `green-final-run.txt` 一致。

| 要求 | 证据 | 判定 |
|---|---|---|
| pending 只显用户名/密码，无 code 字段 | 用例 "the first step asks for a login, never for a code"：`queryByLabelText(/Verification code/)` 为 null，Username 存在 | PASS |
| code_required 只显 code 与说明 | "the code step asks for only the code"：code 输入框为空、Password/Username 均 null、说明句出现；`autoComplete="one-time-code"` + `inputMode="numeric"` 在 `sign-in-form.tsx:165-167` | PASS |
| 初次提交 body 不含 code | "the first submission sends the password alone"：`/submit` body **精确等于** `{password, save}`；旧构建若仍画 code 字段则照常输入并钉死 body 无 `code` | PASS |
| filling 零控件禁重复 | "a filling request offers nothing to submit again"：`container.querySelectorAll("button")` 长度 0，无任何输入框；实现在 `sign-in-form.tsx:282-299` 纯说明分支 | PASS |
| wrong code 可显式重试 | "a wrong code is cleared, explained, and can be sent again"：落定即 `setCode("")`，失败句留存 state 可读，两次 `/code` body 精确 `[{code},{code}]` | PASS |
| expired/cancelled 无可提交控件 | "a closed request offers no controls"（cancelled，0 button）；expired 与 cancelled 同走 `FINAL_SIGN_IN` 终态分支（`sign-in-form.tsx:115-128`），分支内零控件。expired 无独立用例（见 INFO-2） | PASS |

## 2. 秘密清理 — PASS

- **code 不进 vault**：`submitSignInCodeMutationOptions` 只 POST `{code}` 到 `/code`（`mutations.ts:50-57`），无 save 字段、无 checkbox；grep 全部 sign-in 流程文件（form/tool/route/mutations）无 `/api/passwords` 调用（唯一命中是 passwords 页专用的 `deleteSavedLoginMutationOptions`，不在本流程）。
- **leaks() 断言**（seam = MutationCache 全量 variables JSON 包含性，`sign-in-code-step.test.tsx:110-117`）：提交落定后 `leaks("correct horse")`/`leaks(CODE)` 均 false；Decline 后 `leaks("correct horse")` false；发送在途卸载后 `leaks(CODE)` false。
- **gcTime: 0 生效路径**：两个秘密 mutation（submit/submitCode）均带 `gcTime: 0`（`mutations.ts:38,52`）；卸载用例实证缓存条目即刻回收，不等默认 5 分钟 gc。
- **仅勾选保存走既有 vault**：保存勾选与 `save` 字段零改动（`sign-in-form.tsx:409-421`），随密码提交走服务端既有保存点（L02）；用例断言未勾选时 `save:false`。
- **全程零 `/api/passwords` 泄漏调用**："a settled send…" 用例末尾断言 `calls.some(path.startsWith("/api/passwords"))` 为 false。

## 3. 接口与兼容 — PASS

- `submitSignInCodeMutationOptions(queryClient)`，variables 精确 `{id: string; code: string}`（`mutations.ts:50-57`）。
- `SignInStatus` 增 `code_required`（`queries.ts:14`，含文档注释）；`FINAL_SIGN_IN` 恰为四终态 `signed_in/failed/cancelled/expired`（`queries.ts:56-61`，git diff 确认零改动）。
- **sign-in tool 不提前返回成功**：handler 只在 `FINAL_SIGN_IN.includes(status)` 时返回（`sign-in-tool.tsx:115`）；card 测试 "the waiting handler keeps waiting while the site asks for a code" 显式 15s timeout，3500ms（> 2 个 POLL_MS=1500 轮询周期）内 `returned` 恒为 "waiting"，转 `signed_in` 后才带 `signedIn: true` 返回。
- **卸载/组织变化清旧绑定**：`SignInCard` 卸载 effect `removeQueries({queryKey: passwordKeys.pending()})`（`sign-in-tool.tsx:163-167`）；card 测试 unmount 后断言 pending 查询从 QueryCache 消失。
- **独立页面与聊天 dialog 共用组件**：`app/src/routes/_authed/sign-in/$requestId.tsx:5` 与 `app/src/lib/copilot/sign-in-tool.tsx:6` 均从 `@/components/passwords/sign-in-form` 导入同一 `SignInForm`；card 测试在 dialog 内实测 code 步（"Enter the verification code" 出现、无 Password）。

## 4. 偏差评估 — PASS（均成立）

1. **locales 落 common.json（brief 写 settings.json）**：合理且正确。`signInForm` 命名空间事实源确在 `common.json`——git diff HEAD 显示 L03 只是在既有 `signInForm` 块内加 6 个新 key 并改写 `code` 值；`app/src/lib/i18n/index.ts:12,35,58` 将 NS "common" 绑定到 `locales/{en,zh-CN}/common.json`；两个 `settings.json` 零 `signInForm` 内容；组件与路由均 `useTranslation("common")`。Spec §5 未指定文件，brief 文件清单过期，按事实源落地正确。
2. **未采纳上游 setQueryData**：与 data-access skill 一致。上游 `mutations.ts:12` 确用 `setQueryData(passwordKeys.signIn(...))`（show()，上游 41/51/61 行）；`.claude/skills/openbot-data-access/SKILL.md:252` 明列 "setQueryData after a mutation" 为反模式、`invalidateQueries` 为正解。本地保持 invalidate-only 正确。
3. **测试 seam（userEvent.type / 模块级 queryClient 单例）**：仓库先例成立——`connection-fields.test.tsx:65` 有同因注释（happy-dom 下 `fireEvent.change` 不驱动受控状态）；`channel-history-refresh.test.tsx` 等多个既有测试用模块级 `@/query-client` 单例。
4. **leaks() 取代"缓存为空"**：更精确。cancel mutation 合法携带 request id（非秘密，`cancelSignInMutationOptions` 的 variables 即 id 字符串），"缓存为空"会误报；`leaks(needle)` 语义不变且更准。

## 5. 范围与回归 — PASS

- **改动恰为 owned + manifest**（`git status` 与 `before-status.txt` 精确对比）：tracked 新增修改 = `sign-in-form.tsx`、`mutations.ts`、`queries.ts`、`sign-in-tool.tsx`、`en/common.json`、`zh-CN/common.json`（偏差 1，已声明）、`sign-in-card.test.tsx`；untracked 新增 = `sign-in-code-step.test.tsx`；manifest = `e2e-bun-suites.json`（files/causes 各新增本文件一项，cause 归属 L03，落 app/tests part 4）。**未触碰任何 server/L01/L02 文件**（server 侧 M 条目全部先于 L03 存在）。
- **U 系列回归**：`bun test ./app/tests/connect-app-card.test.tsx ./app/tests/tool-activity.test.tsx` → **33 pass / 0 fail**。
- **typecheck**：`bun run --filter app typecheck` → **exit 0**。
- **biome format**：8 个代码/翻译/测试文件逐一 **exit 0**；`e2e-bun-suites.json` exit 1（见 INFO-1，非 L03 回归）。
- **统一驱动**：`E2E_BUN_ONLY=app/tests bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` → 6 组中 **5 组绿**（part 1-4 含承载两个 sign-in 套件的 part 4 @39s、multitenancy），唯一红 `app/tests/ai-observability`（route-chain `queryClient.ensureQueryData` undefined）= brief 明文登记的基线红，与 L03 文件零交集。
- **覆盖对账**：`node scripts/e2e-coverage-audit.mjs` → "no gaps"，exit 0。

## 问题分级

| 级别 | 编号 | 描述 |
|---|---|---|
| 阻塞/严重 | — | 无 |
| INFO | 1 | `e2e-bun-suites.json` 不过 `bunx biome format`（exit 1）。经 BASE 重放（HEAD 版本同报 exit 1）确证为**先于 L03 的文件级基线状态**：该 manifest 由脚本生成、全文 1 空格缩进、从未 biome-clean；L03 新增行沿用文件既有缩进风格。实施报告"全部 exit 0"明确限定 8 个代码文件，无虚报。建议后续统一处理 manifest 格式口径（超本任务范围）。 |
| INFO | 2 | `expired` 状态无独立测试用例，与 `cancelled` 同走 `FINAL_SIGN_IN` 终态分支（分支内零控件、代码级覆盖）。风险极低，可选补一条分支钉子。 |
| INFO | 3 | `sign-in-card.test.tsx` 余 1 处 `organizeImports`（:2）——经 `git show HEAD` 重放确证 BASE 既有同位 finding，L03 新增行零 lint finding。 |

## 结论

Task L03 验收**通过**。12/12 行为用例亲跑复现；秘密清理矩阵与实现、测试双向吻合；接口契约（`{id, code}` variables、`code_required` 非终态、四终态不变）与兼容钉住齐备；4 项偏差全部核实为正确取舍且有事实源支撑；范围精确收敛于 owned + manifest（locales 文件名为唯一已声明偏差）；typecheck/format/U 系列回归/统一驱动全绿（唯一红为已登记基线）。
