# Local OpenMuse vs upstream OpenBot feature matrix

**Checked:** 2026-10-20 (Asia/Shanghai)  
**Local baseline:** `1123786563/OpenBot` `main` at `d7f68d0ea60b1cfe6da4ff70c4522c227510580d`  
**Upstream baseline:** `CopilotKit/OpenBot` `main` at `e8bb27368ff436958b614292ae91283e51d5a813`  
**Method:** read-only comparison of tracked files at those commits. The working tree had 214 staged, unstaged, or untracked entries and is excluded from every verdict below.

## How to read the statuses

- **已具备**: the local baseline has the same user-facing capability or equivalent behavior, even if its implementation differs.
- **部分具备**: local code has the underlying area or a narrower/adjacent capability, but does not show the upstream behavior or integration being compared.
- **缺失**: no corresponding local implementation was found at the baseline.

This matrix focuses on notable upstream capabilities since the shared base and selected nearby capabilities. It is not an exhaustive audit of all 8,007 changed paths. Upstream paths use `upstream/main:<path>`; local paths refer to the local baseline.

## Feature matrix

| 功能 | 状态 | 本地位置（HEAD） | 上游位置（main） | 判定依据 |
|---|---|---|---|---|
| 移动端客户端（Bot、对话、审批、电脑、插件、记忆、例程、规则） | 缺失 | 无 `mobile/` | `mobile/app/`, `mobile/src/`, `mobile/package.json` | 本地树没有移动端目录；上游有 Expo 应用及多个产品页面。 |
| Google Antigravity agent harness | 缺失 | 无 `agent-antigravity/`；已有 `agent-adk/`, `agent-ag2/`, `agent-microsoft/` 等 harness | `agent-antigravity/src/main.py`, `agent-antigravity/Dockerfile`, `shared/harnesses.json` | 本地没有此专用 harness；现有其他 agent 框架不等同于 Antigravity。 |
| 通用 harness 单一目录供 UI/桌面等复用 | 部分具备 | `app/src/components/agents/create-agent-dialog.tsx`, `desktop/src-tauri/src/harness.rs` | `shared/harnesses.json`, `shared/harnesses.ts`, `app/src/components/agents/create-agent-dialog.tsx` | 本地 UI 与桌面均有框架选择/映射，但未发现上游的 shared catalogue 单一事实源。 |
| Agent turn engine 提取为 toolkit 包 | 缺失 | `server/src/agents/`, `server/src/routines/run-turn.ts` | `toolkit/src/run-turn.ts`, `toolkit/src/headless-tools.ts`, `toolkit/src/copilotkit/agents.ts`, `toolkit/package.json` | 本地仍在 server 内；上游已拆为 workspace package。属于架构差异，用户能力可能等价。 |
| 对话内直接连接 Bot 要用的未连接应用 | 部分具备 | `app/src/components/plugins/`, `app/src/routes/_authed/settings/connected-accounts/index.tsx` | `app/src/components/channels/connect-app-card.tsx`, `app/src/components/channels/chat-transcript.tsx` | 本地有账户连接管理及插件授权，但没找到在当前对话渲染连接卡片/连接后轮询确认的同等流程。 |
| 电脑屏幕仅在需要时自动打开，并可撤销被拒动作触发的打开 | 部分具备 | `app/src/lib/copilot/computer-activity.ts`, `app/src/components/computer/live-screen.tsx`, `app/src/components/channels/browser-activity.tsx` | `app/src/components/computer/use-auto-watch-screen.ts`, `agent-computer/src/authorisation.ts` | 本地已有活动事件和实时屏幕；上游新增独立 hook，按活动/撤销事件控制自动开关。是否有等价撤销语义需进一步逐事件核验，暂列部分。 |
| 网页研究：Parallel | 已具备 | `server/src/plugins/tools.ts`, `server/tests/parallel-research.test.ts`, `reference/parallel-research.md` | `server/src/web-research.ts`（工具适配）, `server/tests/web-research.test.ts`, `reference/web-research.md` | 本地已有 Parallel 研究工具说明、注册与测试；与上游新抽象的模块路径不同。 |
| 网页研究：Exa 与 Firecrawl | 缺失 | `server/src/plugins/tools.ts`, `reference/parallel-research.md` | `server/src/web-research.ts`, `server/tests/web-research.test.ts`, `reference/web-research.md`, `.env.example` | 本地入口明确绑定 Parallel；未找到 Exa/Firecrawl provider 注册或对应配置。 |
| Routine 定时任务及自然语言调度描述 | 已具备 | `server/src/routines/schedule.ts`, `server/src/routines/runner.ts`, `app/src/components/routines/routines-list.tsx` | `server/src/routines/schedule.ts`, `app/src/components/routines/`（相关页面） | 本地有 routines 与 schedule 实现。 |
| Slack/GitHub 账户关联（人员身份绑定） | 已具备 | `server/src/identity/`, `app/src/components/settings/linked-accounts.tsx`, `app/src/lib/identity/` | `server/src/identity/`, `app/src/components/settings/linked-accounts.tsx` | 本地已有 Slack/GitHub linked-account 页面与身份实现；上游新增的同类能力本地已覆盖。 |
| 个人记忆同步到 CopilotKit Intelligence | 部分具备 | `server/src/memory/intelligence.ts`, `server/src/memory/ingestion.ts`, `server/src/learning/` | `server/src/memory/intelligence.ts`, `server/src/learning/`, migration `server/drizzle/0054_memory_on_intelligence.sql` | 本地已有 Intelligence 记忆和 Learning 集成；未找到上游为已审阅/启用记忆做的定期迁移式同步行为，故列部分。 |
| Automatic Learning 自动创建/分配容器 | 已具备 | `server/src/learning/auto-assign.ts`, `server/src/learning/ensure-container.ts`, `server/src/learning/settings.ts` | `server/src/learning/auto-assign.ts`, `server/src/learning/ensure-container.ts`, `scripts/setup-learning.ts` | 两边均有自动分配/创建相关模块；上游说明新增默认策略，本地已有对应领域逻辑。未逐项判定默认值是否完全一致。 |
| 登录验证码在密码通过后才询问 | 部分具备 | `agent-computer/src/sign-in.ts`, `app/src/lib/copilot/sign-in-tool.ts` | `agent-computer/src/sign-in.ts`, `server/drizzle/0056_sign_in_code_step.sql`, `app/src/lib/copilot/sign-in-tool.ts` | 本地已有人工协助登录，但上游新增明确的 password → code 两阶段 API/持久状态；本地路径未见 `code_required` 状态或独立 code endpoint。 |
| 面向用户的工具调用折叠摘要行 | 部分具备 | `app/src/components/channels/chat-transcript.tsx`, `app/src/components/channels/browser-activity.tsx` | `app/src/components/channels/tool-activity.tsx`, `app/src/components/channels/chat-transcript.tsx` | 本地有工具/浏览器活动 transcript；上游明确新增相邻 connector/browser 步骤折叠、展开详情与失败计数，尚未确认本地具有相同交互。 |
| 启动时诊断 Intelligence entitlement 与模型 key 可用性 | 缺失 | `server/src/index.ts`, `server/src/config.ts`（启动配置） | `server/src/intelligence-entitlement-check.ts`, `server/src/model-availability-check.ts`, `server/src/index.ts` | 上游有专门的非阻断启动诊断模块；本地未找到对应诊断入口。 |
| 审计记录 CSV 导出 | 已具备 | `server/src/audit.ts`, `server/tests/audit-export.test.ts`, `app/tests/audit-export-truncated.test.tsx` | 上游 #751 的 audit export 路由与相关测试 | 本地已有审计导出接口和 UI 侧测试。 |
| 遥测 shell 命令凭据脱敏（包括 flag 后的独立单词） | 部分具备 | `server/src/telemetry/scrub.ts`, `agent-computer/src/`（命令执行） | `server/src/telemetry/scrub.ts`, `server/tests/telemetry*` | 本地已有通用 scrubber；上游增加了命令参数形态的具体凭据识别。现有本地实现需用该输入集验证，故列部分。 |
| 例程相同分钟去重描述 | 缺失（该边界行为） | `server/src/routines/schedule.ts`, `server/tests/routine-schedule.test.ts` | `server/src/routines/schedule.ts`, routines tests | 本地测试覆盖 `0,30` 两个分钟，但没有对 `0,30,0` 重复值去重；上游专门修复该输入。 |
| 上游近期开源桌面/部署、安全修复（headed browser、Web Bot Auth 默认值、IPv6/SSRF、启动配置等） | 部分具备 | `agent-computer/src/authorisation.ts`, `agent-computer/src/egress.ts`, `desktop/`, `.env.example` | `agent-computer/src/`, `desktop/`, `.env.example`, `charts/` | 本地有相同安全域和桌面/部署实现，但上游持续合入了多项针对性边界修复；不能据目录判定逐项行为等价，建议按 changelog 逐条做安全回归。 |

## 重点差距摘要

比较明确的新增产品/结构差异是：移动端、Antigravity harness、toolkit 包、Exa/Firecrawl provider、启动时 entitlement/model 诊断。连接卡片、自动看屏、验证码分步和工具活动摘要属于“本地有相关基础功能，但上游特定交互可能未覆盖”。

本地同时有大量上游没有的 OpenMuse/企业功能（如多租户、计费、Craft、OpenMuse mobile/backend integration 等），本表不是对本地价值或整体完成度的排名。

## Sources

- Local repository tracked files at `d7f68d0`.
- Upstream repository tracked files at `e8bb273`.
- Upstream [CHANGELOG.md](https://github.com/CopilotKit/OpenBot/blob/main/CHANGELOG.md), [README.md](https://github.com/CopilotKit/OpenBot/blob/main/README.md), [web research documentation](https://github.com/CopilotKit/OpenBot/blob/main/reference/web-research.md).
- Local paths above are relative to repository root; upstream paths are relative to `CopilotKit/OpenBot`.
