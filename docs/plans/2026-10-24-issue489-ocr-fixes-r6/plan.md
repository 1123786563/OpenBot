# #489 F06 修复波（OCR R6 有效 finding）

依据：`.archive/runs/2026-10-23-issue489-orchestration/ocr/r6-adjudication.md`（R6 全量终裁）。两任务 owned_files 互不相交，可并行（K 上限内）。全部自集成分支 HEAD 派生，无提交检查点交付（沿 F04/F05 惯例；after-all/increment diff + status，SHA-256 留证）。

## 全局约束

- 每任务仅改自己的 owned_files；不动他人文件；测试先行（RED→GREEN）；Claude 独立审核（Spec+质量双轴）后才集成。
- 验证入口一律真实调度路径（ADR 0008）：agent-computer sign-in=`E2E_UNIT_SCOPE=agent-computer OPENBOT_COMPUTER_BROWSER=1 bunx e2e run --config e2e.unit.config.ts sign-in`（真 Chromium，仓库根）；tool-activity=`bun test ./app/tests/tool-activity.test.tsx`（bun 驱动层直跑，ADR 0008 part-3 组）。
- tsc/biome 与 F05 同口径：agent-computer tsc 0；server tsc 恰 3 条 BASE（bootstrap-local-gateway TS2339）；app tsc 与裸 BASE 同环境逐字节一致；biome owned 文件净（不经管道直取退出码）。
- 禁新增 drizzle 迁移。

## T12a：sign-in 提交标记清理 + 验证码步宽限（R6A-M1 + R6A-M2，同文件合一）

**R6A-M1（medium）现状**：`markSubmit`（agent-computer/src/sign-in.ts:206-221）设新 `submit` 标记前不清旧标记；`markLoginFields` 仅在 fillSignIn 开头清全标记、`markCodeField` 只清 code 标记。SPA 站点隐藏登录表单但保留 DOM 时：密码步已在登录提交按钮打 submit 标记，fillSignInCode 再给验证码表单按钮打标记 → `page.locator('[data-openbot-login="submit"]')`（submitFrom :226）命中两元素 → Playwright strict mode 抛错被 catch 吞 → 统一报「The verification code could not be typed into the page」，该类站点验证码流程必败。
**修复**：`markSubmit` 设标记前先清除既有 submit 标记（与 markCodeField 开头清理对称），使 locator 恒命中新标记的单元素。
**R6A-M2（medium）现状**：`fillSignInCode`（:347-377）提交+settle 后单次判 `codeFieldVisible`，无 fillSignIn 给验证码字段出现留的 2s 宽限；慢 SPA 重渲染晚于 networkidle 时旧验证码框仍在 → 误报「码被拒」→ 服务端重开 code_required → 诱导重输已消费 OTP。
**修复**：镜像 fillSignIn 宽限——仍可见时 `waitForTimeout(2_000)` 后复查一次；复查仍可见才维持 refused 语义。
**测试（现有 sign-in 套件内加用例）**：M1 RED=隐藏登录表单保留 DOM+验证码面板场景，现 HEAD 点击抛 strict-mode → 通用失败；GREEN=提交成功、codeFieldVisible 正确。M2 RED=settle 后延迟（>0 且 <2s）替换验证码页的场景，现 HEAD 误报 refused；GREEN=宽限内消失→不误报且 submitted 语义不变。既有用例（one-time-code 主路径、拒绝组合护栏、moved origin、T11b 词表）零回退。
owned：agent-computer/src/sign-in.ts、agent-computer/tests/sign-in.test.ts。

## T12b：折叠组 MCP 步骤渲染边界（R6A-M3）

**现状**：tool-activity 折叠组 StepRow 以 `Streamdown` 直接渲染任意供应商文本（app/src/components/channels/tool-activity.tsx:463-476），整条路径无 `ToolRenderBoundary`；单工具路径（TranscriptToolCall→ToolRenderBoundary→ServerToolLine）受保护，此新路径不变量失效——病态 markdown 抛错将冒泡卸载整个 transcript（tool-boundary 存在理由/chat-messages 语义在案）。
**修复**：以 ToolRenderBoundary（定位其真实模块路径）包住每个折叠步骤行的输出块或整行，使单步骤渲染失败降级为本地回落；不改 StepRow 渲染内容语义、不动单工具路径。
**测试**：行为驱动优先——构造使 Streamdown/markdownComponents 抛错的步骤输出或注入抛错子组件，断言组内该行显示回落而其余 transcript 存活；若 Streamdown 抛错不可注入，则退化为渲染树断言（Boundary 包裹+fallback 路径直测）+ R1 独立裁定强度。既有 tool-activity/browser 步骤/失败/撤销用例零回退。
owned：app/src/components/channels/tool-activity.tsx、app/tests/tool-activity.test.tsx。

## 集成与后续

串行集成（T12a→T12b，逐个字节核验+组合树门）→ Codex 完整终审（4f88d9b310..新 HEAD，五派）→ OCR R7（A/B 不变 + C4=4f88d9b310..新 HEAD）→ R7 终裁 → V03 终版 → C01。
