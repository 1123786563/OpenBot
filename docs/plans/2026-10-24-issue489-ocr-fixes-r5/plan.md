# #489 F05 修复波（OCR R5 有效 finding）

依据：`.archive/runs/2026-10-23-issue489-orchestration/ocr/r5-adjudication.md`（R5 终裁）。三任务 owned_files 互不相交，可并行（K 上限内）。全部自集成分支 HEAD 派生，无提交检查点交付（沿 F04 惯例）。

## 全局约束

- 每任务仅改自己的 owned_files；不动他人文件；测试先行（RED→GREEN）；独立审核（Claude R1 双轴）后才集成。
- 验证入口一律用真实调度路径（ADR 0008）：passwords 套件=`E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts passwords-sign-in computer-sign-in-code`（仓库根）；agent-computer sign-in=`E2E_UNIT_SCOPE=agent-computer OPENBOT_COMPUTER_BROWSER=1 bunx e2e run --config e2e.unit.config.ts sign-in`（真 Chromium）；connect-app-card=对应 app e2e/bun 套件按现仓库实际入口。
- tsc/biome 与 F04 同口径：server tsc 恰 3 条 BASE（bootstrap-local-gateway TS2339）；agent-computer tsc 0；app tsc 与裸 BASE 逐字节一致；biome owned 文件净。

## T11a：OTP 尝试上限（security；r5-chunkA passwords/routes.ts:126-136 + service.ts）

现状：code_required 在 15 分钟 TTL 内可无限次 submitCode，每次驱动 Bot 浏览器向目标站点真实提交；全 passwords 无限流/尝试计数。修复：每请求计失败提交次数（行级字段或 store 侧计数，Pi 定实现，倾向复用现有 row 字段面避免新迁移——**不新增 drizzle 迁移**，若需持久字段须先报告并改用内存/审计派生方案）；上限 N=5；达到上限 transition 终态 failed（failure=TOO_MANY_CODE_ATTEMPTS 语义并入现有 failure 枚举或等价文案）+ SERVER_ACTOR 审计（镜像 T10b 语义：不标 superseded）；第 N+1 次提交得到明确拒绝。正确码在达限前照常成功。测试：RED=现 HEAD 无上限可连错 6 次；GREEN=第 6 次被拒/终态化，正确路径与超时路径零回退。
owned：server/src/passwords/service.ts、server/src/passwords/routes.ts（仅当需要错误映射）、server/tests/passwords-sign-in*.test.ts / computer-sign-in-code*.test.ts（现有文件内加用例）。

## T11b：postcode 词表补齐（T10c/F04-1 残余；r5-chunkC sign-in.ts:186-187）

现状：businessCode 排除词表含 country/postal/zip… 但缺 post（postcode/post_code 英式拼写）；name=postcode 登录页成功提交密码后仍被误读为验证码步骤。修复：词表加 post（覆盖 postcode/post_code/post_code 形态）；可顺带 invite（inviteCode）——若加 invite 须给不误伤例证（不存在以 invite+code 命名的验证码字段，需论证）。测试：RED=postcode 字段+refused 场景现 HEAD 误报 codeRequested；GREEN=不误报，且 postal/zip 既有用例零回退、真验证码主路径零回退。
owned：agent-computer/src/sign-in.ts、agent-computer/tests/sign-in.test.ts。

## T11c：connect-app-card 关闭页签防护（r5-chunkA connect-app-card.tsx:216）

现状：url 到达时若空白页签已被用户关闭，tab.location.replace 抛 DOMException 逸出 onSuccess 未处理；setBlockedUrl 兜底不可达；卡片挂满 5 分钟。修复：`if (!tab || tab.closed)` 走与被拦截相同的 setBlockedUrl(authorizationUrl) 兜底；replace 包 try/catch 异常同样落兜底。测试：closed tab → 渲染 blockedUrl 链接不等待；replace 抛错 → 兜底；既有 waiting 禁用/超时/second-press 用例零回退。
owned：app/src/components/channels/connect-app-card.tsx、对应测试文件（connect-app-card 相关现有测试内加用例）。

## 集成与后续

串行集成（顺序 T11a→T11b→T11c，逐个字节核验+组合树门）→ F01-R5 Codex 完整终审（4f88d9b310..新 HEAD）→ OCR R6（A/B 不变 + C3=4f88d9b310..新 HEAD）→ R6 终裁 → V03 终版 → C01。
