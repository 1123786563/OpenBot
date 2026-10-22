# Review V01-F：修复批（F1–F6 + F3b）独立复审

- 日期：2026-10-21。Reviewer 独立只读复审；工作区 `.worktrees/upstream-openbot-update`（HEAD=59edf9fb，未提交树）。
- 对象：`evidence/v01/fix-V01-F-report.md` 所述 6 项修复 + F3b 对称补修，15 个 tracked 文件改动。
- 方法：逐 finding 对照 OCR 原文（ocr-final.txt :223/:357/:1473/:1793/:1958/:1232/:383/:405）与实际 diff；全部 suite 抽跑复现；format/typecheck/coverage 门禁复跑。

## 逐项裁决

### F1（sign-in.ts refused 复评）— resolved，无新问题
- `refused` 改 `let` 并在 2 秒宽限后与 `codeRequested` 同步复评（agent-computer/src/sign-in.ts:309-315）；返回值 `passwordFieldVisible: codeRequested ? false : refused` 两分支均用新样本，无陈旧样本路径。注释如实说明双向重采样理由（含"陈旧沉默会被服务端当作登录成功"）。
- 慢拒绝用例真实：`/slow-refuse` 过渡页 2500ms 后重绘密码表单；时序核实——`settle` 固定 800ms + networkidle 使首采样落 ~1.4s（重绘前），宽限后复评落 ~3.4s（重绘后），用例既触发 pre-fix 缺陷又不竞态。pre-fix 代码（`const refused`）下该用例必红，RED 真实。
- 服务端语义核实：fill() 在 `passwordFieldVisible=false, codeRequested=false` 时确实落 `signed_in`（service.ts:604-611），OCR 定级成立。**19/19 复跑通过**（OPENBOT_COMPUTER_BROWSER=1, Chromium）。

### F2（connect-app-card webUrl 闸门）— resolved，无新问题
- 单点校验：`webUrl()` 在 onSuccess 内 `setWaiting` 之前求值一次；`tab.location.replace(url)`（导航）与 `setBlockedUrl(url)`（blocked-tab href）两路径消费同一验证值（connect-app-card.tsx:183-196, :259）。结构上不存在未过闸的 URL 消费点（grep 全文仅此两处）。
- `javascript:`/非 URL → 解析失败或非 http(s) → null（fail-closed）→ `tab?.close()` + `setBadUrl(true)` + 提前 return，`blockedUrl` 保持 null，无 href 渲染。正常 http/https 原样通过（返回原字符串，无重写副作用）。
- http 放行是对 OCR"仅 https"建议的放宽，但与仓库既有外部 href 约定一致（browserStepDetails/stepDetails 均 `https?`），且以专门正例钉住；目录项与 broker 均答 https，无误伤面。记 Obs-3。
- 新词条 `connectCard.badUrl` en/zh-CN 齐备。三例新增（javascript: 负例、非 URL 负例、http 正例），https 正例由既有 :238 用例覆盖。**18/18 复跑通过**。

### F3+F3b（service.ts 审计一致性）— resolved，无新问题
- enterCode（:410-425）与 fill（:540-556）两处 `computer.sign_in_failed` 审计均改 `if (reopened)` 门控，与 landUnknown（:306-318：CAS 成功 `done` 非空才写）完全同构；`SignInRefusedError(failure, reopened ? 409 : 400)` 两侧均未动；注释三处互引一致。
- 两用例（passwords-sign-in.test.ts :815-850 与 :988-1018）均在 gateway stub 内用 store CAS 把行并发关闭为 failed，断言：拒绝消息、行保持 failed、trail 中零条 `sign_in_failed`（`some(...) === false` 为全新 trail 下的强断言）。F3b 为主控追加授权，改动限于 F3 同两文件，15 文件计数不受影响。**34/34 复跑通过**（F3b 后口径）。

### F4（scrub SSHPASS + docker 全局选项）— resolved，无新问题
- SSHPASS 规则（scrub.ts:87-89）：大小写敏感、`\bSSHPASS\s*=` 锚定；`SSHPASS_FILE` 负例成立（`_` 为 word char，`SSHPASS` 后无边界亦无 `=`）；值三形态（双引号/单引号/裸 `[^\s'"]+`）。`SECRET_NAME` 关键词表核实不含 PASS 单独形式，规则确有必要非冗余。规则无 sshpass 锚定属文件头声明的 over-eager 哲学，误伤代价仅为多脱敏。
- docker 锚（:70-72）：flag + 其非 `-` 开头取值可占位于 `docker` 与 `login` 之间，裸词（`run`/`ps`）不可——`docker run login -p 8080:80` 与 `docker -H … ps -p 8080:80` 负例经结构推演与用例双重成立；续行 `\\\r?\n` 保留。
- 上游分叉注释：mysql 大小写分叉既有注释完好（"Case-sensitive on purpose, unlike the upstream source"）；docker/sshpass 规则本身为 S02 本地新增（非上游原文改fork），新增注释充分说明本地语义，无未注释分叉。
- 正例 4 + 负例 3 落表，与报告一致（RED 4 fail = 4 正例 pre-fix 全红，逻辑吻合）。**65/65 + otel-export-scrubbing 1/1 复跑通过**。

### F5（store.ts docblock 归位）— resolved，纯移动属实
- diff 逐行比对：删除的 17 行与重插的 17 行逐行相同（sort|uniq 验证零残差）；`deploymentTokenHeader` docblock 与函数体一字未动，仅 `effectiveUrl` 注释块从其上方移至其下方、回到 `effectiveUrl` 之前。"纯移动、零行为变化"声明属实。**composio-connections+kinds 149/149、agent-callback-token 34/34 复跑通过**。

### F6（refusalBody 收敛）— resolved，无新问题
- shared `refusalBody(result, marker)`（connect-prompt.ts:169-173）：startsWith → slice → trim，undefined/marker 不在开头 → null，fail-closed 与 readConnectPrompt 同向。
- 三处消费语义等价逐一核对：`connectPromptOf`（undefined 先查后 asText，null → null）；`asksThePerson`（`body !== null && (…)` 精确复现原三段式）；`stepDetails`（`refusal ?? answer` —— `??` 仅对 nullish 落空，空串拒绝 `body=""`、`refused=true` 与原 `refused ? slice().trim() : answer` 边界一致，含空串场景验证）。
- marker 参数化：调用方各传本侧 `REFUSAL_MARKER`（app/src/lib/plugins/tool-result.ts:11 / server/src/plugins/tools.ts），shared 无第三份字面量；shared 测试用本地字面量避免单侧声明成为双边契约——两端各自声明原则保持。
- U03/U04 零削弱：connect-app-card.test.tsx diff 仅新增 3 用例零删改（含既有 connectPromptOf fail-closed 组）；tool-activity.test.tsx 完全未触碰。**shared 14/14、tool-activity 27/27、connect-app-card 18/18 复跑通过**。

## 范围与门禁核对

- 15 个 modified tracked 文件恰按 2（F1）+4（F2）+2（F3/F3b）+2（F4）+1（F5）+4（F6）分解，无额外 tracked 改动；untracked `agent-mastra/bun.lock` mtime 00:23 早于本批全部修复文件（~11:19），非本批产物，报告"无 untracked 新增"成立。
- 抽跑复现全部与报告一致：sign-in 19/19、connect-app-card 18/18、tool-activity 27/27、shared 14/14、passwords-sign-in 34/34、enterprise-controls 65/65、otel 1/1、composio 149/149、agent-callback-token 34/34。
- biome format 15 文件逐一 check 通过；app typecheck exit 0；server typecheck 恰 3 条 TS2339 全在 scripts/bootstrap-local-gateway.ts（BASE 红，改动文件零错误）；agent-computer `tsc --noEmit` exit 0；coverage audit exit 0（1074/571/488/9/6 与报告一致）。

## Findings

| # | 严重度 | 内容 |
| --- | --- | --- |
| F-1 | Low | **Brief 工件缺失**：`evidence/v01/fix-V01-F-brief.md` 被 report 与 ledger §7（:115）引用，但文件不在 evidence 目录。owned_files 无法对 brief 原文独立核对，仅能以 report 逐项文件清单（与实际 15 文件恰合）替代验证。建议补写该 brief 或在 ledger 更正引用。 |
| F-2 | Low | **第四份信封剥离残留**：`app/src/components/channels/chat-transcript.tsx:1402-1410`（`ServerToolLine`）仍有同形手工序列（asText → startsWith → slice+trim）。BASE 既有、OCR 未列名、不在本批三处收敛范围内，属范围外残留而非修复缺陷；但其 refused/body 与折叠判定同源，漂移风险即 OCR 所述。建议后续票一并换用 `refusalBody`。 |
| Obs-3 | Obs | F2 放行 `http:` 与 OCR 建议的仅 https 有差——有意为之，与仓库 `https?` 惯例一致且有正例钉住，无需处理。 |
| Obs-4 | Obs | `agent-mastra/bun.lock` 为 worktree 既有 untracked 残留（先于本批），提交授权时需与 V01 既有 untracked 清单一并裁决。 |

## 结论

六项修复 + F3b 全部真实解决对应 OCR finding，未引入新缺陷；全部 suite 数字独立复现一致；门禁声明（format/typecheck/coverage）核实无误。两条 Low 均为证据/范围卫生项，不影响修复有效性。

Spec compliance: pass
Code quality: pass
