# Fix Brief V01-F：全范围 OCR 本批有效 finding 修复（6 项）

- **来源**：V01 全范围 OCR（`evidence/v01/ocr-final.txt`，230 文件/124 findings；主控甄别后本批范围内有效 medium+ 共 6 组；main wave3 代码的 finding 不在本批范围、由 ledger 记录转交）。
- **owner_role**: backend/frontend implementer 合并派发（每项独立小修复，共享验证轮）。
- **工作区**: `.worktrees/upstream-openbot-update`（HEAD=merge 59edf9fb 之后）。无 commit（主控统一提交）。

## 修复清单（每项：finding → 修复要求）

1. **V01-F1（L01，bug·high，ocr:223）**：`agent-computer/src/sign-in.ts` fill 结果的 `refused` 在 2 秒宽限等待**之前**采样、等待后只复评 `codeRequested`——慢速拒绝站点会返回陈旧 `refused`（`passwordFieldVisible` 误判）。修复：宽限等待后**同时复评** `refused` 与 `codeRequested`，用新样本计算返回值；测试补"密码被拒后过渡态 2s 后仍无 code 字段→refused=true"用例（现有套件风格）。owned：`agent-computer/src/sign-in.ts`、`agent-computer/tests/sign-in.test.ts`。
2. **V01-F2（U03，security·medium，ocr:357）**：`app/src/components/channels/connect-app-card.tsx` 对授权 URL 无协议校验即 `location.replace` / `<a href>`。修复：导航与 href 前校验 `http:`/`https:`（`new URL` 解析失败或非 http(s) → 不导航、显示错误退路文案（复用 i18n），tab 关闭；新增词条 en/zh）；测试补 javascript: 与非 URL 两负例 + 正常 https 正例。owned：卡片、`app/tests/connect-app-card.test.tsx`、`app/src/locales/{en,zh-CN}/channels.json`。
3. **V01-F3（L02，maintainability·medium，ocr:1473）**：`server/src/passwords/service.ts` enterCode 失败路径 CAS 回退未生效（reopened null）时仍写 `computer.sign_in_failed` 审计——与 landUnknown 仅 CAS 成功才写不一致，并发下产生与真实终态矛盾的审计。修复：仅 CAS 成功才写该审计（对齐 landUnknown）；测试补"行已被并发关闭时零新增 failed 审计"。owned：service.ts、`server/tests/passwords-sign-in.test.ts`。
4. **V01-F4（S02，security·medium ×2，ocr:1793/1958）**：`server/src/telemetry/scrub.ts`——(a) 补 `SSHPASS=secret sshpass -e ...` 环境变量形式（SSHPASS 不含既有 SECRET_NAME 关键词）；(b) docker 规则允许 `docker` 与 `login` 之间出现全局选项（`docker -H tcp://… login -p secret`、`docker --context prod login -p secret`）。各补正例+负例（普通 env 赋值不误伤、`docker -H x ps` 不当 login）。owned：scrub.ts、`server/tests/enterprise-controls.test.ts`。
5. **V01-F5（R02，documentation·medium，ocr:1232）**：`server/src/plugins/store.ts` `deploymentTokenHeader` 插在 `effectiveUrl` 的 docblock 与函数体之间——把该函数（含其 docblock）移到不拆散既有注释对的位置。纯移动零行为变化。owned：store.ts。
6. **V01-F6（U03/U04，maintainability·medium ×2，ocr:383/405）**：信封剥离序列三份拷贝（chat-transcript `connectPromptOf`、tool-activity `asksThePerson` 与 `stepDetails`）。收敛为 `shared/connect-prompt.ts` 新增单一 helper（如 `readRefusedConnectPrompt(text): ConnectPrompt | null`：asText 由调用侧处理或一并纳入——设计由实现者定，但**三处消费同一实现**）；保持 fail-closed 语义与全部既有测试绿；U03/U04 既有断言不削弱。owned：`shared/connect-prompt.ts`、`shared/connect-prompt.test.ts`、`app/src/components/channels/chat-transcript.tsx`、`app/src/components/channels/tool-activity.tsx`。

## 验证（全部）

- 各项所属 suite 全绿（native 按 scope；driven 用 bun test）；`shared/*` 新 helper 测试补齐。
- `bun run --filter server typecheck`（3 条 BASE 红不计入）+ `--filter app typecheck`；`bunx biome format` 每改动文件真实 exit 0（新增行）。
- `node scripts/e2e-coverage-audit.mjs` exit 0。

## 禁止

- 不动 main wave3 文件；不动与本 6 项无关的行为；无 commit/stash；非 owned untracked 不删。

## 报告

`evidence/v01/fix-V01-F-report.md`：逐项 diff 摘要、测试证据、声明核对。
