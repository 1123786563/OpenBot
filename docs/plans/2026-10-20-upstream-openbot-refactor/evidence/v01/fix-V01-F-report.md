# Fix Report V01-F：全范围 OCR 有效 finding 修复批（6 项合并派发）

- 日期：2026-10-21。工作区：`.worktrees/upstream-openbot-update`（HEAD=merge 59edf9fb，无 commit）。
- Brief：`evidence/v01/fix-V01-F-brief.md`（owner_role: backend/frontend implementer 合并派发）。
- 全部改动 15 个文件，均在 brief owned_files 内；无 untracked 新增（除本报告）；无 stash、无 commit。

## 逐项结果（每项严格 RED→GREEN）

### V01-F1（L01，ocr:223）sign-in refused 宽限后复评
- 文件：`agent-computer/src/sign-in.ts`、`agent-computer/tests/sign-in.test.ts`。
- 修复：2 秒宽限等待后同步复评 `refused = await passwordVisible(page)`，返回值用新样本计算；注释说明两侧读数都要重采样及陈旧样本的后果（服务端会误落 `signed_in`）。
- 测试：新增路由 `/login-slow-refuse`（错误密码先答过渡态、2500ms 后重绘密码表单）+ 用例 "a refusal the site draws late is still the answer after the grace wait"，断言 `passwordFieldVisible=true, codeRequested=false`。
- RED：1 failed | 18 passed（e2e native + Chromium，OPENBOT_COMPUTER_BROWSER=1）。GREEN：**19/19**。

### V01-F2（U03，ocr:357）connect-app-card 授权 URL 协议校验
- 文件：`app/src/components/channels/connect-app-card.tsx`、`app/tests/connect-app-card.test.tsx`、`app/src/locales/{en,zh-CN}/channels.json`。
- 修复：新增 `webUrl(candidate)`（`new URL` 解析失败或非 `http:`/`https:` → null，fail-closed）；`onSuccess` 在 `setWaiting` 前统一过闸——非法 URL 时不导航、不渲染 href、`tab?.close()`、`setBadUrl(true)` 显示错误退路文案（新词条 `connectCard.badUrl`，en/zh-CN），合法 URL 才进入导航/`blockedUrl` 链接两条路径。
- 测试：javascript: 负例、非 URL 负例、http 正例（scheme 放行回归）三例新增；https 正例由既有 "navigated once the url arrives" 覆盖。
- RED：2 failed | 16 passed（bun，driven island）。GREEN：**18/18**。

### V01-F3（L02，ocr:1473）enterCode 失败审计对齐 landUnknown
- 文件：`server/src/passwords/service.ts`、`server/tests/passwords-sign-in.test.ts`。
- 修复：enterCode 失败路径的 `computer.sign_in_failed` 审计改为 `if (reopened)` 才写（与 landUnknown 仅 CAS 成功才写一致）；`SignInRefusedError(failure, reopened ? 409 : 400)` 保持不变。
- 测试：新增 "a row closed under the code attempt takes no failed audit its state contradicts"——在 signInCode stub 内用 store CAS 把行并发关闭为 failed，断言行保持 failed 且 trail 零新增 sign_in_failed。
- RED：1 failed | 32 passed（e2e native）。GREEN：**33/33**。
- 观察（未动，超出 brief 范围）：同文件 `fill()` 失败路径存在同形的无条件审计（CAS 未生效也写），如需同规则对齐请主控另行裁决。

### V01-F4（S02 ×2，ocr:1793/1958）scrub：SSHPASS env 形式 + docker 全局选项
- 文件：`server/src/telemetry/scrub.ts`、`server/tests/enterprise-controls.test.ts`。
- 修复：(a) 新增专用规则 `\bSSHPASS\s*=\s*(...)`（大小写敏感，置于 sshpass 规则后），覆盖 `SSHPASS=secret sshpass -e ssh host` 及引号形式；(b) docker 规则锚改为允许 `docker` 与 `login` 之间出现全局 flag 及其非 `-` 开头的取值，子命令（`run`/`ps` 等非 `-` 开头词）不可占位，`docker run login -p 8080:80` 端口映射不受影响。
- 测试：正例 4（SSHPASS 裸/引号、`docker -H tcp://… login`、`docker --context prod login`）、负例 3（`SSHPASS_FILE=…` 不误伤、`docker -H … ps -p 8080:80`、`docker run login -p 8080:80`）。
- RED：4 failed | 61 passed（e2e native）。GREEN：**65/65**；邻域 `bun test server/tests/otel-export-scrubbing.test.ts` **1/1**。

### V01-F5（R02，ocr:1232）store.ts docblock 归位（纯移动）
- 文件：`server/src/plugins/store.ts`。
- 改动：把 `deploymentTokenHeader`（含其 docblock）整体上移至 `effectiveUrl` 的 docblock 之前（`reachedAsFor` 之后），恢复 "Where this server actually is…" 注释与 `effectiveUrl` 的绑定。**声明：纯移动、零行为差异**——git diff 仅该 docblock 的删除/原样重插，`deploymentTokenHeader` 函数体与 docblock 文本一字未改。
- 证据：`server/tests/composio-connections.test.ts` + `composio-connection-kinds.test.ts`（bun driven）**149/149**；`agent-callback-token.test.ts`（native）**34/34**；server typecheck 仅 3 条 BASE 红。

### V01-F6（U03/U04 ×2，ocr:383/405）信封剥离三处→一处
- 文件：`shared/connect-prompt.ts`、`shared/connect-prompt.test.ts`、`app/src/components/channels/chat-transcript.tsx`、`app/src/components/channels/tool-activity.tsx`。
- 设计：shared 新增单一 helper `refusalBody(result: string | undefined, marker: string): string | null`（startsWith → slice → trim，fail-closed）。marker 由调用方传入：`REFUSAL_MARKER` 是两端各自声明的常量（`app/src/lib/plugins/tool-result.ts` / `server/src/plugins/tools.ts`，均非 owned 不动），shared 不新增第三份字面量；asText 留在调用侧（shared 不依赖 app 代码）。三处消费同一实现：`connectPromptOf`（chat-transcript）、`asksThePerson` 与 `stepDetails`（tool-activity，`refusal ?? answer` 精确复现原 `refused ? slice().trim() : answer` 语义，含空串拒绝边界）。
- 测试：shared 新增 describe（strip 正例/三类 null 负例含 marker 居中 fail-closed/与 `readConnectPrompt` 组合 roundtrip）。
- RED：COLLECTION_ERROR（refusalBody 未导出，e2e native）。GREEN：shared **14/14**；`app/tests/tool-activity.test.tsx` **27/27**（U04 既有断言全数保留）；`app/tests/connect-app-card.test.tsx` **18/18**（U03 既有断言全数保留，含 connectPromptOf fail-closed 三例）。

## 汇总数字

| 套件 | 运行方式 | RED | GREEN |
| --- | --- | --- | --- |
| agent-computer/tests/sign-in.test.ts | e2e native + Chromium | 1 fail/18 | **19/19** |
| app/tests/connect-app-card.test.tsx | bun（driven island） | 2 fail/16 | **18/18** |
| app/tests/tool-activity.test.tsx | bun（driven island） | — | **27/27** |
| shared/connect-prompt.test.ts | e2e native | COLLECTION_ERROR | **14/14** |
| server/tests/passwords-sign-in.test.ts | e2e native | 1 fail/32 | **33/33** |
| server/tests/enterprise-controls.test.ts | e2e native | 4 fail/61 | **65/65** |

邻域回归：otel-export-scrubbing 1/1；brokered-connection-card 3/3；tool-result 15/15（经 e2e native）；composer/transcript driven 三件套 62/62；composio-connections+kinds 149/149；agent-callback-token 34/34。

## 验证门禁

- **biome format**：15 个改动文件 `bunx biome format <file>` 逐一检查，`--write` 后（仅 4 文件换行重排：chat-transcript/tool-activity 的 import 换行、connect-prompt.test 一处断言换行、enterprise-controls.test 表格换行）check 真实 exit 0。
- **typecheck**：`bun run --filter app typecheck` exit 0；`bun run --filter server typecheck` exit 2 = 恰好 3 条 `scripts/bootstrap-local-gateway.ts` TS2339（BASE 红，本批文件零触碰）；另跑 agent-computer `tsc --noEmit` exit 0（sign-in.ts 所在包）。
- **覆盖审计**：`node scripts/e2e-coverage-audit.mjs` exit 0（1074 文件，571 native / 488 driven / 9 engine / 6 named exclusions，no gaps）。
- 已知基线红（与本批无关，V01 verification-summary 已登记）：`app/tests/billing-credits-ui.test.tsx` 8 failed | 10 passed（环境依赖基线红，本批文件零触碰）。

## 偏差与移交

1. F2 闸门实现为 onSuccess 内单点校验，导航与 blocked-tab href 两条路径共用同一个已验证 URL——覆盖 brief 要求的"导航与 href 前校验"且不重复判定；另加 http 正例一枚。
2. F3 仅按 brief 修 enterCode；`fill()` 同形审计未动，留主控裁决（见上）。
3. F6 helper 命名/签名 `refusalBody(result, marker)` 为实现者设计（brief 授权），marker 参数化保住"两端各声明一份"契约。

## 附：V01-F3b 对称补修（主控 2026-10-21 追加授权，验收前）

- 范围：`server/src/passwords/service.ts` 的 `fill()` 失败路径——与 F3 完全同形的无条件 `computer.sign_in_failed` 审计。只动 service.ts 与 `server/tests/passwords-sign-in.test.ts`。
- 修复：审计改 `if (reopened)` 才写，注释与 enterCode/landUnknown 对齐；`SignInRefusedError(failure, reopened ? 409 : 400)` 不变。
- 测试：新增 "a row closed under the login attempt takes no failed audit its state contradicts"（signIn stub 内 CAS 并发关闭 → 断言拒绝 /password field/、行保持 failed、trail 零新增 sign_in_failed）。
- RED：1 failed | 33 passed（e2e native）。GREEN：**34/34**。
- 门禁复跑：biome format 两文件 check exit 0（--write 换行一处）；`bun run --filter server typecheck` 仍恰好 3 条 BASE 红（bootstrap-local-gateway），零新增。
- 偏差 2 就此闭环；偏差 1（F2 单点闸门）与 3（F6 签名设计）维持原状。

## 附二：V01-F2 修复轮（delta OCR 4 项，主控 2026-10-21 派发）

前轮 V01-F 已由主控提交为 685f00df；本轮改动恰为 4 个授权文件（connect-app-card.tsx、connect-app-card.test.tsx、otel-export-scrubbing.test.ts、chat-transcript.tsx）。

1. **badUrl 状态对称（bug·medium）**：badUrl 分支补 `setBlockedUrl(null)` 与 `setTimedOut(false)`；good-url 两臂（导航/blocked）的 `setBadUrl(false)` 移出 `if (tab)`；needsKey 分支同样对称清空 timedOut/badUrl/blockedUrl——badUrl/blockedUrl/timedOut 每条终止/转移路径只保留自己所取代的那一个状态。用例两条（blocked→badUrl 不并存、badUrl→blocked 不并存），并对第一条做了 RED 真实性探针（临时移除 `setBlockedUrl(null)` 单独复跑：该用例失败、其余绿；恢复后 20/20）。
2. **otel wire 级样本（test·medium/low）**：`otel-export-scrubbing.test.ts` 新增第二个 test 块（同现有真 collector 风格）：`docker -H tcp://registry.example:2375 login -p <虚构>` wire 上为 `login -p [REDACTED]`、`SSHPASS=<虚构> sshpass -e` wire 上为 `SSHPASS=[REDACTED]`、`docker run login -p 8080:80 nginx` 端口原样保留。2/2 pass（连同原用例）。
3. **ServerToolLine 第四份剥壳（low）**：改用 `refusalBody`（`refusal ?? answer` 等价改写），注释补"the one sequence every reader shares"。

复跑：connect-app-card **20/20**（RED 2 fail/18 pass）+ tool-activity **27/27**、shared **14/14**、otel wire **2/2**、邻域 transcript-attachments 40/40；biome format 4 文件 check exit 0；`bun run --filter app typecheck` exit 0。

## 附三：V01-F3 终轮小修（delta2 OCR 唯一 medium，主控 2026-10-21 派发）

只动 `connect-app-card.tsx` 与 `connect-app-card.test.tsx`。

1. **统一 `resetOutcome()`**：清 waiting/needsKey/badUrl/timedOut/blockedUrl 五标志；needsKey/badUrl/good-url 三条 onSuccess 路径均改为 `resetOutcome()` 后只设自己的结局标志，删除逐分支手工清单（good-url 导航臂冗余的 `setBlockedUrl(null)` 一并消失）。
2. **onError 对称重置**：connect 失败时 `tab?.close()` + `resetOutcome()`，过时结局（timedOut/badUrl/blockedUrl/waiting）不再与 `connect.error` 叠加。新用例 "a failed retry after the timeout replaces the stale wait instead of stacking on it"（等待超时 → 重试失败 → 断言仅显示 error、/still is not connected/ 消失）。RED：1 fail/20 pass；GREEN：**21/21**（既有 20 用例零削弱，断言逐字未动）。
3. 门禁：biome format 两文件 check exit 0；`bun run --filter app typecheck` exit 0。diff 2 文件 49+/11-。

## 附四：V01-F4 终轮补齐（delta3 两条，主控 2026-10-21 派发）

只动 `connect-app-card.tsx` 与 `connect-app-card.test.tsx`。

1. **5 分钟超时回调改走 `resetOutcome()`**（原手写 `setWaiting(false)+setTimedOut(true)`，不清 blockedUrl——blocked 后超时会双渲染且残留链接可无声完成连接）：改为 `resetOutcome(); setTimedOut(true)`。新用例 "a timeout ends a blocked-tab wait instead of stacking beside its link"（blocked 链接在挂 → 超时 → 断言仅 timedOut 文案、链接消失）。RED：1 fail/21 pass；GREEN 含此用例 **22/22**。
2. **connected effect 同步改走 `resetOutcome()`**（原仅清 waiting/timedOut）：行成为本人连接时五标志全清，防撤销后回落渲染过期结局；`invalidateQueries` 行为不变（既有用例 "invalidates the plugins cache" 与 "a mounted card invalidates nothing" 全绿）。

既有 21 用例零削弱（断言未动）。门禁：biome format 两文件 check exit 0；`bun run --filter app typecheck` exit 0。

## 附五：V01-F5 最后一轮微修（delta4 两项，主控 2026-10-21 派发）

只动 `connect-app-card.tsx` 与 `connect-app-card.test.tsx`。

1. **"Stop waiting" 改走 `resetOutcome()`**（原 `setWaiting(false)`：blocked 结局下残留链接且轮询停止，链接可在无人察觉时完成连接）：新用例 "stopping the wait ends a blocked-tab wait instead of leaving its link"（blocked 链接在挂 → Stop waiting → 断言链接消失、再按 Connect 可发起新尝试且链接重现）。RED：1 fail/22 pass。
2. **`resetOutcome` 以 `useCallback(..., [])` 包装**（repo 惯例，消 exhaustive-deps 告警）；两个 effect 依赖数组补入稳定的 `resetOutcome`（`[connected, resetOutcome]`、`[waiting, resetOutcome]`，恒等引用不改变触发语义）。

GREEN：**23/23**（既有 22 用例零削弱）。门禁：biome format 两文件 check exit 0；`bun run --filter app typecheck` exit 0。
