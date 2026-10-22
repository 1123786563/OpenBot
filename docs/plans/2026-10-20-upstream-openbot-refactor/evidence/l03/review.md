# L03 独立 Review：分步登录表单与客户端兼容（A08 / Issue #496 / up08）

- Reviewer：独立 reviewer（只读；唯一写入为本报告）。工作区：`.worktrees/upstream-openbot-update`。
- 日期：2026-10-20。材料：`after-tracked.diff`、`before-tracked.diff`、`before-status.txt`、untracked `app/tests/sign-in-code-step.test.tsx`、`implementer-report.md`、`validator-report.md`；事实源：Spec §5、`docs/tickets/upstream-openbot-update/issues/up08.md`、上游参考 `evidence/upstream-sources/`。
- 方法：从 before/after 两份 tracked diff 逐文件求增量确认改动范围，全部验证命令亲跑复现，未采信任何未复核的声明。

## 0. 范围核验（diff 增量）

L03 tracked 增量恰为 7 个此前干净的文件 + manifest 增量：`sign-in-form.tsx`、`sign-in-tool.tsx`、`mutations.ts`、`queries.ts`、`en/common.json`、`zh-CN/common.json`、`sign-in-card.test.tsx`；untracked 新增 `sign-in-code-step.test.tsx`；manifest 的 L03 增量经 patch 文本逐行对比确认为**恰好一项**（`app/tests/sign-in-code-step.test.tsx` 进 groups part 4 / files / causes，cause 归属 L03；其余 patch 差异全部是分区脚本重排的 hunk 偏移噪声）。未触碰任何 server/L01/L02 文件。与两份报告声明一致。

## 1. Spec compliance

### Spec §5 第 1 条（初次不问 code、旧客户端 code 忽略）

- UI 侧：初次表单无 code 字段（内联字段整体删除，sign-in-form.tsx 旧 409-421 区块），`SignInSubmission` 删除 `code`（mutations.ts:28-32），提交 body 只含 `{username?, password, save}`。用例 "the first step asks for a login, never for a code" + "the first submission sends the password alone"（body 精确相等、且条件输入钉死：若回归出旧字段则 body 必含 code 而失败）。**PASS**。
- 服务端侧（L02，只读复核）：`POST /:id/submit` 显式不读 `code`（routes.ts:115-119 注释即为此），`use-saved` 只读 `loginId`；`code_required` 仅由 Computer 报告 `result.codeRequested` 进入（service.ts:538-547）。客户端与服务端两侧口径互洽。

### Spec §5 秘密卫生行（验证码不落库/聊天/追踪/日志；表单与 mutation variables 清理；密码仅明确保存进 vault）

- code 从不进 vault：code 步无 save 控件、`submitSignInCodeMutationOptions` body 仅 `{code}`（mutations.ts:50-57）；DB schema 无 code 列（`server/src/db/schema/passwords.ts:93` 仅状态约束含 `code_required`）；service.submitCode 只持久化 outcome（scrub 后）。
- 不进聊天/追踪：code 只存在于组件 state 与在途 mutation variables；sign-in tool handler 从不接触 code；audit 侧 service 层 `scrub(..., [code])`（L02）。
- 清理矩阵核实：落定即 `setCode("")/setPassword("")` + `reset()`（form onSubmit onSettled）；Decline/Cancel/Take over 走 `forgetTyped()`；卸载 effect reset 两个秘密 carrier（`secretCarriers` ref 持首帧 result，observer 稳定故 reset 指向正确实例）；`gcTime: 0`（mutations.ts:38,52）令无观察者即从 MutationCache 移除。测试 seam `leaks()`（MutationCache variables JSON 包含性，test:110-117）语义正确：reset 后 variables 为 undefined 不误报，cancel 携带的 request id 是合法非秘密。
- 密码仅明确保存：保存勾选块与 `save` 字段逐行零改动；"a settled send…" 用例断言全程零 `/api/passwords` 调用。

### up08 criteria 第 1、6、10 条

- **#1**：初次不问 code + 旧客户端 code 忽略 + 仅实测 code 字段才进 code_required——见上，两侧核验。**PASS**。
- **#6**（迟到不覆盖终态、不重发秘密）：UI 侧无任何自动重发路径（提交仅显式动作触发；终态分支零控件）；终态权威在服务端 CAS（store.ts:67-81 条件状态更新），UI 只读。**PASS**（L03 范围内）。
- **#10**：独立页面（`app/src/routes/_authed/sign-in/$requestId.tsx`）与聊天 dialog（sign-in-tool.tsx:220）import 同一 `SignInForm`；保存密码路径零改动；挂起恢复经 pending 列表 lookup 且新用例钉住卸载清缓存；validator 双端验证 + 本独立 review。**PASS**。

**Spec compliance 总判定依据**：§5 两条目标行为与秘密卫生全部在真实客户端栈上被钉住，服务端契约（L02 已 verified）经只读复核互洽，范围精确收敛。

## 2. Code quality

### 分步状态渲染与 failure 组件化的取舍

- 结构：按状态早返回（FINAL → code_required → taken_over → filling → pending 表单），镜像服务端状态机，可读。全 app 仅 3 处消费 SignInStatus（form/tool/queries），typecheck exit 0 证明无遗漏穷尽。
- failure 从派生 `mutation.error` 改组件 state 是**必要取舍**而非偏好：秘密 mutation 落定即 reset（清 variables），reset 同时清 error，派生写法下失败原因会恰在清理瞬间消失——state 化是"缓存零秘密"与"人能读到原因"两个目标的唯一解。代价：7 处重复的 `onSettled: (_d, e) => setFailure(e?.message ?? null)`（可接受）与下述 F2 的双告警重复。
- `gcTime: 0` + invalidate-only：`.claude/skills/openbot-data-access/SKILL.md:252` 明列 `setQueryData` after mutation 为反模式、invalidate 为正解；上游 `onSuccess: show(queryClient)` 未采纳正确。`gcTime: 0` 是对 skill 无冲突的附加加固；onSettled invalidate 沿本地既有惯例（409 也改状态，settle 时机正确）。
- sign-in tool 等待语义：handler 循环零改动（diff 证实），仅在 `FINAL_SIGN_IN.includes(status)` 返回（sign-in-tool.tsx:115），`code_required` 非终态不提前返回；WAIT_MS 15 分钟窗口零改动；新用例以 3.5s（>2×POLL_MS=1500）钉住非返回、转 signed_in 才带 verdict 返回。卸载 `removeQueries(pending)` 落实 brief 的"导航/组织变化清旧绑定"。

### i18n 偏差①（common.json 而非 brief 所写 settings.json）

核实为正确落地：`signInForm` 命名空间事实源在 `common.json`（en/zh-CN 各 1 处、settings.json 均 0 处），`app/src/lib/i18n/index.ts` 将 NS "common" 绑定 common.json（:58,:140,:165），组件与路由均 `useTranslation("common")`。Spec §5 未指定文件。按"以事实源为准并声明偏差"处理，成立。

### 测试对真实 TanStack 行为的覆盖质量

- **无 isServer 类环境 hack**：两文件 grep 无 `isServer`/`import.meta.env`/`NODE_ENV` stub/env 假实现。走真实 `QueryClientProvider` + 真实 `useQuery/useMutation` + 真实 `client()` 传输层，fetch stub 在网络边界；card 测试用真实 CopilotKitProvider。模块级 queryClient 单例与 mutation factory 闭包一致是仓库既有先例，且是"落定后失效必须到达渲染查询"的必要条件，不是让步。
- RED→GREEN 证据自洽：`red-first-run.txt` 9 fail/1 pass 与报告表格一致（"a closed request offers no controls" 实现前即绿，属合理终态钉子）；本人亲跑 12 pass/0 fail（34 expects，7.07s）与 `green-final-run.txt` 一致。
- 用例均测生产路径；fixture 全虚构值（`correct horse`/`313131`/`shop.example`），符合 Spec 测试边界。

### 亲跑验证记录（全部真实 exit code）

| 命令 | 结果 |
|---|---|
| `bun test ./app/tests/sign-in-code-step.test.tsx ./app/tests/sign-in-card.test.tsx` | 12 pass / 0 fail（34 expects） |
| `bun run --filter app typecheck` | exit 0 |
| `bunx biome format` × 8 个 L03 代码/翻译/测试文件 | 全部 exit 0 |
| `bunx biome format docs/verification/e2e-bun-suites.json` | exit 1 = **HEAD 版本同 exit 1**（基线既有，INFO-1 成立） |
| `bunx biome check` × 5 个代码文件 | 0 finding |
| `bunx biome check app/tests/sign-in-card.test.tsx` | 1 处 organizeImports(:2)，HEAD 重放同位 finding（HEAD 另有 1 处 format 错误已被 L03 顺手修复，2→1） |
| `E2E_BUN_ONLY=app/tests bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` | 6 组中 5 绿；唯一红 `app/tests/ai-observability`（`queryClient.ensureQueryData` undefined）= brief 预先登记的基线红，与 L03 文件零交集 |
| `node scripts/e2e-coverage-audit.mjs` | no gaps，exit 0 |
| `bun test ./app/tests/connect-app-card.test.tsx ./app/tests/tool-activity.test.tsx` | 33 pass / 0 fail（U 系列回归复现） |

## 3. 两份报告交叉核对

3 条 INFO 抽验全部核实：

1. **INFO-1 manifest 格式**：HEAD 重放 exit 1 属实；实施报告"全部 exit 0"限定 8 个代码文件，无虚报。
2. **INFO-2 expired 无独立用例**：属实且**可接受**——form 终态分支只做 `FINAL_SIGN_IN.includes()` 成员判断（sign-in-form.tsx:115），cancelled/expired 命中同一零控件代码路径，独立用例只会钉同一行；服务端到期文案与状态迁移在 L02 覆盖（service.ts:200-201）。残余风险接近零，维持 INFO 不升级。
3. **INFO-3 organizeImports**：HEAD 同文件同行号复现属实；补充——HEAD 实为 2 处 finding（+format），L03 折行反而消除了 format 那处，净改善。

实现/验证报告的行号引用抽验 10 处（mutations.ts:38/50-57/52、queries.ts:56-61、sign-in-form.tsx:115-128/165-167/282-299、sign-in-tool.tsx:115/163-167、SKILL.md:252）全部准确。validator 的 U 系列回归与统一驱动结论均独立复现。

## 4. Findings

| # | 严重度 | 描述 |
|---|---|---|
| F1 | INFO | i18n 落 `common.json`（brief 写 settings.json）：核实为 brief 文件清单过期，落地正确，偏差声明成立。 |
| F2 | LOW | **failure 错误路径无测试钉住 + 双告警重复**：新测试所有 stub 均返回 200，`setFailure(error?.message)` 分支与 failure 跨 reset 存续机制（该任务自身设计取舍的核心）未被任何用例执行——错误改写回派生式 failure 也能过 12/12。且生产错误码流下（如错 code 返回 409），服务端把同一句子既存为 outcome 又作为 error 抛出，code_required 分支会渲染两段相同 `role="alert"`（sign-in-form.tsx:174-183；pending 分支同型，HEAD 已有，L03 延续并复制进新分支）。行为无损、句不出错，建议后续加一条 500/409 形态 stub 用例并去重告警。 |
| F3 | INFO | expired 无独立用例：与 cancelled 同一 FINAL 成员分支，代码级覆盖等价，服务端到期 L02 已覆盖。可接受；可选补一条分支钉子。 |
| F4 | INFO | `SignInCard` 卸载 `removeQueries(passwordKeys.pending())` 会移除仍被同会话兄弟卡片观察的共享 pending 查询（sign-in-tool.tsx:163-167）；后果限于下一个轮询周期内的一次重建拉取，列表仅含用户名无秘密，且该清理本身是 brief 明文要求。 |
| F5 | INFO | manifest 不过 biome format（exit 1）：HEAD 重放证实为基线状态，脚本生成物、1 空格缩进既有风格；建议后续统一 manifest 格式口径（超本任务范围）。 |
| F6 | INFO | 实施报告"折行只发生在我新增的行"略有不准：`sign-in-card.test.tsx:2` 的 import 折行触及 BASE 行（该行本超宽，HEAD 因此本就报 format 错误）。改动本身正确且是 format exit 0 的必要条件，仅叙述不精确。 |
| F7 | INFO | code 步 Take over 按钮复用 `signInForm.takeOver`（"Take over to sign in"），上游此处为 "Take over to finish"；code 步时登录已提交，文案轻微失准。复用既有 key 的取舍，纯文案。 |
| F8 | INFO | UI 层无勾选 save=true 的用例（仅 save:false 钉子）：勾选路径自 HEAD 起零改动且 L02 服务端已覆盖 save:true，非 L03 回归。 |

无阻塞、无严重、无 MEDIUM 级问题。F2 是唯一 LOW，不改变判分：其行为面（可读原因 + 显式重试）已被 outcome 路径钉住，缺口在实现机制层面。

## 5. 结论

Task L03：范围精确（7 文件 + manifest 一项 + 1 新测试文件）、Spec §5 两条与 up08 #1/#6/#10 全部在真实栈上被钉住并经本人复现、秘密清理矩阵实现/测试/服务端三向互洽、data-access skill 符合、两份报告交叉核对无虚报、4 项偏差（i18n、setQueryData 拒用、leaks seam、测试基建）全部核实为正确取舍。质量关口放行。

Spec compliance: pass
Code quality: pass
