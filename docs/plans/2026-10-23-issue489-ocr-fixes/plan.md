# 方案：#489 终审 OCR 有效 finding 修复波（F03）

日期：2026-10-23。Run：`.archive/runs/2026-10-23-issue489-orchestration/`（Orca run_000fcaac3873）。
输入：F02 OCR 三分段（A 3b4a7c68..c081ec50、B c081ec50..9d2251b3、C 4f88d9b310..27bdc381a3）逐条裁决表（ledger §22:2x/22:2x 与 ocr/*.md）。
基线：集成分支 `1123786563/issue-489-integration` HEAD `27bdc381a3`（已过 Codex F01-R2 代码侧终审）。

## 范围裁决（本方案只覆盖有效项）

- **有效需修 11 项**（A-H1、A-M2、A-M3、A-M4、A-M5、A-M6、A-M7、A-M8、A-M9、B-M3、B-M4、C-M1[注释级]、C-L1/L2/L3[顺手]）。
- **误报 2**（当前树已修复：SSHPASS 规则、refused 重估）。
- **转交不扩范围**：MT050 门三件套（B-C1/B-H1/B-M1，mt 线 server 侧适配缺口，主链路 P0）；B 区间 203 条并行线 finding；B-M2 journal 重编号危害（补救=交付说明约束，受影响库已实证灭绝）；24 条 low 延期清单。

## 任务拆分（owned_files 互不相交，可并行）

### T8a server 行为修复（scrub/schema/passwords）

- owned: `server/src/telemetry/scrub.ts`、`server/src/computer/schema.ts`、`server/src/passwords/service.ts`、`server/tests/otel-export-scrubbing.test.ts`、`server/tests/passwords-*.test.ts`（如需）
- F1 scrub（A-H1+A-M8）：mysql/docker/redis-cli 中段支持引号参数原子消费（quoted `;|&` 不截断）；sshpass 中段不吞含 p 的组合短标志（`-vp` 形态可达 `-p` 尾）；补引号/组合标志用例。
- F2 schema（A-M2）：`SignInFillResult.url` 改可选并注释对齐 codeRequested 的版本偏移说明；消费方 tsc 核对（service.ts 已防御）。
- F3 passwords（A-M7+B-M3+B-M4）：claim 进 filling 的两处 transition 清空 `outcome`；fill/enterCode 失败分支在 `reopened` 为 null 时补写 `superseded: true` 标记的 `computer.sign_in_failed` 审计（保留行终态一致性 rationale 注释同步修订）。
- 验证：otel-export-scrubbing 全绿含新用例；passwords-sign-in（38）不回退；server tsc 零新增（BASE 3 条 gateway 红除外）；biome。

### T8b server 注释/性能钉（tools/index/store）

- owned: `server/src/mastra/tools.ts`、`server/src/index.ts`（仅 Craft resolver 区段）、`server/src/plugins/store.ts`（仅 docblock）、`server/tests/revoked-connection-consumers.test.ts`、`server/tests/mastra-tools.test.ts`
- F4 tools.ts（C-M1）：VALID_TOOL_NAME 注释补记 OpenAI 官方 function-name 字符集不含 `.` 的边界——点号放行仅对网关/OpenAI-compatible 端点保证，OpenAI 直连挂载点号名可能整单 400（不改行为）。
- F5 index.ts（C-L1/L2）：connectableAppsFor/mcpServersFor 恢复 Promise.all 并行；同步更新 revoked-connection-consumers.test.ts 两处 source-pin 正则。
- F6 store.ts（C-L3）：swapUserCredential docblock 改为只主张 `connected_at` 不变（upsert 亦写回 `scope`），消除被测试引用的裁定记录失实。
- 验证：revoked-connection-consumers 5/5、mastra-tools 7/7、plugin-selection+catalogue 88/88；server tsc 零新增。

### T9 app 修复（connect 卡/死代码/重构/manifest）

- owned: `app/src/components/channels/connect-app-card.tsx`、`app/src/components/channels/browser-activity.tsx`、`app/src/components/channels/tool-activity.tsx`、`app/src/components/channels/chat-transcript.tsx`、`app/src/lib/copilot/tool-result.ts`（如 helper 落点）、`app/tests/browser-activity.test.ts`、`app/tests/approvals-rules.test.tsx`、`tests/config/e2e-bun-suites.json`
- F7（A-M3）：等待期（waiting）主按钮 disabled，防二次 open() 重复开授权页。
- F8（A-M4）：删除 groupBrowserSteps/BrowserActivity/BrowserGroup/旧 TranscriptItem 死代码，两个测试迁移到 groupToolSteps/ToolActivity 语义。
- F9（A-M5）：信封剥离三处重复收敛为 tool-result 共享 helper（refusalBody 形态），折叠判定与卡片渲染共用。
- F10（A-M9）：折叠/分组按 messages 引用 useMemo，消除逐帧 JSON.parse。
- F11（A-M6）：tests/config/e2e-bun-suites.json 为 auto-watch-screen.test.tsx、computer-screen-announcement.test(.tsx) 补 causes 条目（格式对齐既有 127 条）。
- 验证：app 侧 connect-app-card/tool-activity/chat-transcript 相关套件全绿（含迁移后两个测试）；tool-name 28 不回退；jq 核对 causes 完整。

## 集成与终局

每任务：Pi 实施（无提交检查点）→ 编排者启动独立 Claude R1 审核（Spec+Quality）→ 有效 finding 回 Pi 整改复审 → 编排者串行集成到集成分支（git apply + 哈希核验 + 组合树针对性验证）→ 提交。三任务集成后：重做完整 Codex 终审（R3）与全范围 OCR（A/B/C'），通过后 V03 终版裁决与 C01「待关闭」登记。
