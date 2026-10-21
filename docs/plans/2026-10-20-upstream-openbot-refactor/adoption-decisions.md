# E01 后续架构与客户端差距评估（UP11 / AC A12）

- 日期：2026-10-20。角色：architect（只读生产代码与文档；唯一写入为本文件与 `evidence/e01/architect-report.md`）。
- 正式 Issue：[#498](https://github.com/1123786563/OpenBot/issues/498)（本地票 `docs/tickets/upstream-openbot-update/issues/up11.md`）；父 Spec：[#489](https://github.com/1123786563/OpenBot/issues/489)（本地 `docs/specs/2026-10-20-upstream-openbot-adoption-design.md` §8）。
- **本文件是评估与采用/延期决定，不宣称任何功能已上线。** Out of Scope（父 Spec §Out of Scope）继续成立：不新建第二套移动客户端、不实装 Antigravity、不做 toolkit 拆包。

## 固定对象与证据路径约定

| 对象 | SHA / 基线 | 读取方式 |
|---|---|---|
| 本仓库 worktree | 分支 `upstream-openbot-update`，HEAD `3b4a7c68132c3507300408346a44fb9d56f3c14c`（工作树含本轮在途实施改动） | 直接只读 |
| OpenMuse 子模块 gitlink | `491d6215fa508808289053757e5084c875b7318c`（`git ls-tree HEAD apps/openmuse`） | `git --git-dir=/Users/wuyongjun/trea/OpenBot/.git/modules/apps/openmuse show 491d6215:<path>` |
| 上游 CopilotKit/OpenBot | `e8bb27368ff436958b614292ae91283e51d5a813` | `git show e8bb2736:<path>` |

- 证据写法：`e8bb2736:<path>:<line>` = 上游固定提交；`491d6215:<path>:<line>` = 子模块固定提交；`file:line` = 本 worktree 工作树（HEAD `3b4a7c68`；仅 `server/src/audit.ts` 的行号与 HEAD 相差 3 行，已双注）。
- 事实源：父 Spec §8、up11 六条 criteria、ADR 0002–0010、Mastra 已批准 Spec（只引用不修改）、既有矩阵 `docs/research/2026-10-20-upstream-openbot-feature-matrix.md`。

## 矩阵误判修正（以本轮复核为准）

| 矩阵原判定 | 修正后 | 证据 |
|---|---|---|
| 根目录无 `mobile/` → 移动端"缺失" | **OpenMuse mobile 存在且为唯一移动产品**：位于 `apps/openmuse` 子模块 `apps/mobile/`，非仓库根目录；有页面、有 API、有测试与运行录像。根目录有没有 `mobile/` 不构成业务缺失 | `491d6215:apps/mobile/package.json:1-12`；`491d6215:apps/mobile/README.md`；父 Spec §8 `docs/specs/2026-10-20-upstream-openbot-adoption-design.md:114` |
| 记忆镜像"部分具备（未找到定期迁移式同步）" | **已具备**：`server/src/memory/store.ts` 有明确的镜像资格谓词与逐人单飞镜像流程，仅镜像本人已确认（`confirmed`/`edited`）、启用、未删除、非空的个人记忆到 Intelligence | `server/src/memory/store.ts:65-71`（`mirrorEligible` SQL 与谓词）、`:111`（"the person has accepted is mirrored there"）、`:129-130`（one mirror pass per person）；`server/src/memory/intelligence.ts:18-22`（GRANT `user: read-write, project: none`） |
| 网页研究上游路径 `server/src/web-research.ts` | **路径错误**：上游 `e8bb2736` 不存在 `server/src/web-research.ts`；实际为根级共享模块 `shared/research.ts`（server 与 app 共用），配套 `server/tests/web-research.test.ts`，server 侧集成在 `server/src/plugins/*` | `git show e8bb2736:shared/research.ts:2`（"by role rather than by provider, shared by the server and the app"）；`git ls-tree e8bb2736 server/tests/`（`web-research.test.ts`）；`git show e8bb2736:server/src/web-research.ts` → fatal 不存在 |

本地对研究角色的吸收（A10）由本轮 R01–R03 在途任务交付（`docs/plans/2026-10-20-upstream-openbot-refactor/implementation-plan.md:49`），worktree 已出现未提交的 `shared/research.ts`、`shared/research.test.ts`，不在本评估重复判定。

---

## 1. 移动端

**现有入口**
- OpenMuse mobile（唯一现有移动产品）：子模块 `apps/mobile/`，Expo + React Native + `@copilotkit/react-native`，入口 `index.js`/`App.tsx`，主界面 `491d6215:apps/mobile/src/screens.tsx`、`agent-ui.tsx`、`chat.tsx`、`computer-workspace.tsx`、`threads.tsx`、`workspace.tsx`；README 声明 Chat/Activity/Ideas/Goals/Apps 五主导航与 Mail/Calendar/Browser/Files/Connections（`491d6215:apps/mobile/README.md` "Behavior" 节）。
- 上游 mobile：`e8bb2736:mobile/app/` 共 10 个 expo-router 页面（`index`/`conversation`/`bots`/`bot`/`approvals`/`computer`/`memory`/`plugins`/`routine`/`rules`），better-auth（expo + SSO 插件）登录（`e8bb2736:mobile/src/auth.ts:1-30`）。

**行为差距**
- OpenMuse mobile **有页面**：对话、活动、任务、通知、电脑工作区、线程、PDF 阅读、邮件/日历/浏览器/文件/连接（`491d6215:apps/mobile/src/` 60+ 文件）。审批以任务状态进入聊天流：`waiting_approval` 状态与"确认"操作（`491d6215:apps/mobile/src/agent-ui.tsx:101,445`、`strings.ts:783-789`）。
- 上游 mobile 有、OpenMuse mobile **没有**的形态：审批收件箱独立页、记忆开关独立页、插件授权独立页、例程详情页（含运行历史 `RoutineRun`）、规则页（`e8bb2736:mobile/src/api.ts:45,87-141` 类型即对应页面数据）。OpenMuse mobile 源码内 `git grep -i routine` 零命中——无任何例程移动页面；记忆/插件/规则同样无独立页。
- OpenMuse mobile 有、上游 mobile 没有的：AG-UI headless hooks 聊天、电脑工作区与草稿、邮件提案-审阅流、日历时区编辑、PDF 工具卡、JEV 工具卡、任务/通知恢复（`491d6215:apps/mobile/README.md`）。

**约束**
- **不复制第二套 mobile 到根目录**（父 Spec §8 `docs/specs/2026-10-20-upstream-openbot-adoption-design.md:114`；up11 AC1）。上游 mobile 依赖 better-auth/Expo 55/RN 0.83 与上游服务器身份合同，OpenMuse mobile 走子模块自己的 API 与 Bearer 会话，两套身份/协议不可混接。
- 三态登记（up11 AC1）：
  - 有页面：见上，`491d6215:apps/mobile/src/` 文件清单。
  - 有 API：`MuseApi` Bearer 客户端 + `POST /api/session`（`491d6215:apps/mobile/src/api.ts:1-45`），指向子模块 monorepo 自己的 `apps/server`。
  - 已实测：9 个测试文件（`491d6215:apps/mobile/test/`：api-response、assistant-markdown、browser-address、computer-status、conversation-queue、date-time、jev-actions、relative-date、strings）；monorepo `pnpm test` 包含 `apps/mobile/test/*.test.ts`、`pnpm typecheck` 包含 mobile（`491d6215:package.json:16,18`）；CI 实际执行（`491d6215:.github/workflows/ci.yml:24-28`）；运行录像 `491d6215:assets/demos/2026-09-16/mobile.mp4`、`web.mp4`、`2026-09-23/jev-live-web.mp4`；`build:web/ios/android` 导出脚本（`491d6215:apps/mobile/package.json:7-10`）。

**复用方案**
- OpenMuse mobile 继续作为唯一移动产品。上游 mobile 的能力对照只产出一个"页面级 backlog 候选清单"（审批收件箱页、记忆页、插件授权页、例程详情页、规则页），未来按纵向切片在 OpenMuse mobile 内实现，复用其既有 `MuseApi`、`agent-ui.tsx` 任务状态与 strings 双语机制，不引入 better-auth/expo-router 新栈。

**后续验收**
- 若未来启动某个页面补全：以"OpenMuse mobile 内新增该页面 + 双语 strings + `apps/mobile/test/` 新增测试 + `pnpm --dir apps/mobile typecheck` 与 `build:web` 通过 + 至少一条演示/截图证据"为独立验收边界；上游 `mobile/` 目录本身不进入本地树。

**采用或延期结论**
- **延期**（页面级补全候选，不建第二套客户端）。本轮不移动端实施；评估完成不等于任何移动页面已上线。

**证据路径**
- `491d6215:apps/mobile/package.json`、`README.md`、`src/api.ts:1-45`、`src/agent-ui.tsx:101,445`、`package.json:16,18`（子模块根）、`.github/workflows/ci.yml:24-28`、`assets/demos/2026-09-16/mobile.mp4`。
- `e8bb2736:mobile/app/`（页面清单）、`mobile/src/api.ts:45-151`、`mobile/src/auth.ts:14-30`、`mobile/package.json`。
- `docs/specs/2026-10-20-upstream-openbot-adoption-design.md:114`；`docs/research/2026-10-20-upstream-openbot-feature-matrix.md:20`。

## 2. Antigravity harness

**现有入口**
- 上游：`agent-antigravity/`（Python/FastAPI，`e8bb2736:agent-antigravity/src/main.py`；Dockerfile 基于 `python:3.12-slim`，SDK 捆绑 glibc Go `localharness`，`e8bb2736:agent-antigravity/Dockerfile:4-6`）；catalogue 行 `credential: "google"`、port 4214（`e8bb2736:shared/harnesses.json` antigravity 行）。
- 本地：无该 harness；模型访问走 Bifrost 虚拟 Key 网关（`server/src/gateway/key-issuance.ts`、`model-scope.ts`），凭据按"用户 × Bot 授权"逐个发放。

**行为差距**
- 上游凭据模型是**部署级单 Key**：provider 硬编码 pin 到 google（`e8bb2736:agent-antigravity/src/main.py:3` "GEMINI-ONLY, AND PINNED"、`:54` `pinned_provider="google"`），Key 从部署环境变量读取（google 行 `key_variable` 或 `GEMINI_API_KEY` 回落，`:57-66`），可选 base_url 指向任意 Gemini 兼容端点（`:76-84` `GeminiAPIEndpoint(base_url=...)`，URL 为 API ROOT 且 harness 自行追加 `/v1beta/models/<model>:streamGenerateContent`）。
- 本地授权模型是**逐用户**：每个"用户 × Bot 授权"发放有有效期的 Bifrost 虚拟 Key、可独立撤销（`docs/adr/0002-per-user-bot-model-access.md:7`）；直连请求以 OpenBot 同步积分预留为准入、调用后可靠结算（`docs/adr/0003-bifrost-openbot-credit-admission.md:7,9`）；模型默认关闭、管理员按完整定价逐个开放（`server/src/gateway/model-scope.ts:1-18`）。
- 差距实质：上游 Antigravity 的 Key 归部署、消费归部署单 Key，无逐用户归属/撤销/预算准入；本地任何 harness 接入都必须经 Run/Attempt 绑定的受控网关（ADR 0010 `docs/adr/0010-mastra-execution-openbot-governance.md:7`）。

**约束**
- ADR 0002 明确拒绝"所有用户共享部署余额/每用户所有 Bot 共用一个 Key"（`docs/adr/0002:11`）；上游 `GOOGLE_API_KEY` 部署共享形态与之正面冲突。
- ADR 0003 只允许"价格完整且可强制成本上限"的调用能力启用（`docs/adr/0003:9`）；Antigravity 若经网关，需先有讲 Gemini `v1beta` 协议并实现 reserve/settle 准入的兼容门面——上游没有，本地也没有。
- 父 Spec Out of Scope 明确"Antigravity 实装"不做（`docs/specs/2026-10-20-upstream-openbot-adoption-design.md:149`）。

**复用方案**
- 不旁路接入。若将来采用，前置条件为：(a) 实现 Gemini v1beta 兼容网关门面，接 Bifrost 同步预留/结算；(b) 逐用户凭据签发路径（复用 `gateway/key-issuance.ts`）；(c) Gemini 价格快照覆盖。三者齐备后按 harness catalogue 新行（`credential: google`）重新评估。

**后续验收**
- 独立验收边界：新增 harness 行 + 网关门面后，"两个用户同一 Antigravity Bot 的调用在台账分别归属、撤销其一 Key 后仅其一失败、缺价格时拒绝启用"；在此证据出现前，任何"Antigravity 已接入"的表述不成立。

**采用或延期结论**
- **延期**（不兼容项明确延期，而非旁路接入；up11 AC2）。理由：凭据归属与预算准入模型不可调和，且父 Spec 已将其列 Out of Scope。

**证据路径**
- `e8bb2736:agent-antigravity/src/main.py:3,50-66,76-84`、`agent-antigravity/Dockerfile:4-6`、`agent-antigravity/requirements.txt`。
- `e8bb2736:shared/harnesses.json`（antigravity 行 `credential: "google"`）、`shared/model-providers.json`（google 行 key/base_url 变量名）。
- `docs/adr/0002-per-user-bot-model-access.md:7,11`、`docs/adr/0003-bifrost-openbot-credit-admission.md:7,9`、`docs/adr/0010-mastra-execution-openbot-governance.md:7`。
- `server/src/gateway/key-issuance.ts`、`server/src/gateway/model-scope.ts:1-18`。

## 3. 统一 harness 目录（单一事实源）

**现有入口**
- 上游：`shared/harnesses.json` 14 行（crewai、llamaindex、agno、langgraph、google-adk、antigravity、pydantic-ai、microsoft-agent-framework、claude-agent-sdk、strands、ag2、langroid、mastra、byo-url），字段含 `credential`/`maintainer`/`mark`/`webCreate`/`webSummary`；TS 侧 `shared/harnesses.ts` 提供类型与 `WEB_HARNESSES` 过滤（`e8bb2736:shared/harnesses.ts:24-27,70`）；桌面经 `include_str!("../../../shared/harnesses.json")` 构建期内联（`e8bb2736:desktop/src-tauri/src/harness.rs:197-198`）；Web 建 Bot 对话框直接渲染 `WEB_HARNESSES`（`e8bb2736:app/src/components/agents/create-agent-dialog.tsx:1,637`）。
- 本地：桌面 `desktop/src-tauri/src/harness.rs` 的 `catalogue()` 在 Rust 内硬编码 13 行（crewai、llamaindex、agno、langgraph、google-adk、pydantic-ai、microsoft-agent-framework、claude-agent-sdk（`credential: Anthropic`）、strands、ag2、langroid、mastra、byo-url；`desktop/src-tauri/src/harness.rs:156-310`，byo-url 行 `:299-310`）；Web 侧 `app/src/components/agents/create-agent-dialog.tsx` 是 OpenMuse 自己的向导，`builtin | managed` 二分（`:75,100`），**不消费任何 harness 目录**。

**行为差距**
- 与上游行集相比，本地桌面仅缺 `antigravity` 行（与第 2 项延期一致）；`webSummary`/`webCreate` 两个 Web 侧字段本地不存在。
- 本地有两处上游没有的 harness 资产：`agent-trpc/`（Go workbench Bot 容器，`agent-trpc/Dockerfile.bot:1-6`）与 `agent-sandbox/`（`@openbot/agent-sandbox`，bun 沙箱 harness，`agent-sandbox/package.json:1-8`）——它们不在任何目录数据里，加 harness 靠改 Rust 代码。
- 上游解决的"双端第二副本漂移"问题在本地形态不同：漂移风险目前只在桌面单端（Web 根本不读目录）；一旦 Web 向导要列 harness，就会出现第二副本。

**约束**
- 保留本地差异（up11 AC3）：`agent-trpc`/`agent-sandbox` 行、桌面的 `Maintainer`/`Credential` 语义、Mastra 远程 transport 差异（`desktop/src-tauri/src/harness.rs:141-151` 注释：Mastra 经 `getRemoteAgents` 桥接，其余行是 AG-UI 路由）、Web 向导的 builtin/managed 产品分叉。
- 桌面不是根 bun workspace 成员，运行时读不到根文件——上游因此选 `include_str!` 构建期内联（`e8bb2736:shared/harnesses.ts:11-14`），本地沿用同一机制，不引入运行时文件依赖。

**复用方案**
- 采用"一个 JSON、两种语言读"的机制：根级新增 `shared/harnesses.json` 作为单一事实源；桌面 `harness.rs` 的 `catalogue()` 改为从该文件反序列化（`serde_json::from_str(include_str!(...))`），本地 13 行迁入 JSON 并追加 `agent-trpc`/`agent-sandbox` 行；可选提供 `shared/harnesses.ts` 类型封装。Web 向导保持 builtin/managed 分叉不变，暂不消费目录；`webSummary`/`webCreate` 字段随 Web 消费一并引入。

**后续验收**
- 独立验收边界：桌面 `catalogue()` 输出与迁移前行集等价（新增行除外）的单元测试；`shared/harnesses.test.ts` 式数据校验（每个 `mark` 有对应 vendored 文件、credential 枚举闭合）；Web 对话框行为零变化；无运行时网络/文件读取。

**采用或延期结论**
- **采用机制、后续任务交付**（本轮只做评估，不改代码）。行集差异（antigravity）随第 2 项延期；Web 消费与 `webCreate` 语义延期到 Web 向导需要 harness 列表时再引入。

**证据路径**
- `e8bb2736:shared/harnesses.json`（14 行与 `_readme`）、`shared/harnesses.ts:11-14,24-27,70`、`desktop/src-tauri/src/harness.rs:159,197-198`、`app/src/components/agents/create-agent-dialog.tsx:1,179,637`。
- `desktop/src-tauri/src/harness.rs:156-310`（本地 catalogue 13 行）、`:141-151`（Mastra transport 注释）；`app/src/components/agents/create-agent-dialog.tsx:75,100`。
- `agent-trpc/Dockerfile.bot:1-6`、`agent-sandbox/package.json:1-8`（本地独有 harness）。
- `docs/research/2026-10-20-upstream-openbot-feature-matrix.md:22`（矩阵"部分具备"行，本评估细化）。

## 4. toolkit（run-turn / headless-tools / lock / lease / cancel 映射去重）

**现有入口**
- 上游：`toolkit/` workspace 包（`e8bb2736:toolkit/package.json`）：`run-turn.ts`（无头单轮：写 Intelligence thread、平台 thread lock 获取/续期/清理、gateway 在 cron 关键路径上的取舍说明）、`lease.ts`（`keepLease` 心跳；409 `THREAD_LOCK_RENEWAL_FAILED` 判锁冲突；`LockLapsedError`）、`limits.ts`（`TURN_LIMITS`：`turnTimeoutMs` 5 分钟、`abortGraceMs` 5 秒兜底、`lockTtlSeconds` 120）、`headless-tools.ts`（`HeadlessTool.hidden`、`HeadlessToolSuspension` + `OPENBOT_WAITING_METADATA` 挂起元数据）、`continuation.ts`（`ApprovalContinuation` + AsyncLocalStorage）、`initiator.ts`（审计发起者）、`ports.ts`（`TurnAdmission`：拒暂停 Bot/无 grant/模型不在允许表，返回合并 AbortSignal；`ComponentCatalog`；RunLock 端口）。
- 本地：同一引擎仍在 `server/src/routines/run-turn.ts`，直接 import server 模块（`../agents/lifecycle` 的 `guardBotTurn`、`../admin/controls` 的 `headlessTurnRefusal`、`../components/headless`、`../approvals/native-context` 的 `OPENBOT_WAITING_METADATA`、`../computer/headless-tools`）；与 `toolkit/src/run-turn.ts` 的 diff 约 600 行，集中在 import 路径与 ports 抽取（上游改为 `@openbot/shared/*` 与注入端口），主干逻辑同源（两文件共享 "THE LOCK LIFECYCLE IS NOW OURS TO KEEP CORRECT" 等成段注释，`server/src/routines/run-turn.ts:31-49` vs `e8bb2736:toolkit/src/run-turn.ts` docstring）。

**行为差距**
- 上游把"准入/目录/锁"抽成注入端口（`e8bb2736:toolkit/src/ports.ts:8-44`），使 turn 引擎可被 server 之外的宿主复用；本地引擎与 server 内部模块紧耦合，不可独立复用——这是**打包与依赖方向**差异，不是行为缺失。
- 本地已有对应行为物：Bot 生命周期逐动作授权（MT019 已并入，`server/src/agents/lifecycle.ts` `guardBotTurn`）、无头组件工具、审计发起者、挂起元数据。

**约束**
- **不建第二套 Run/Attempt 权威**（up11 AC4；Mastra Spec 权威表 `docs/specs/2026-10-19-mastra-agent-execution-migration-design.md:57`：Run/Attempt/generation/owner lease/取消 权威 = OpenBot RunService，Mastra 仅映射；`:65` "不建立第二套授权、预算或消息权威"）。
- toolkit 的 thread lock 是 CopilotKit Intelligence 平台资源（Redis、按 thread，`e8bb2736:toolkit/src/run-turn.ts` docstring "WHY A SECOND RUNNER INSTANCE IS SAFE"），属**引擎级互斥**，不是业务 owner lease；两者不可互相替代。

**复用方案（映射去重表）**

| toolkit 概念 | 本地/Mastra 已批准对应物 | 去重结论 |
|---|---|---|
| 平台 thread lock（acquire/renew/cleanup，120s TTL） | 引擎级互斥；业务 owner lease 归 RunService（Mastra Spec `:57`、生命周期表 `:104-115`） | 保留平台锁为引擎互斥；不将其提升为业务运行状态权威 |
| `keepLease`（心跳、409 冲突即失主、`LockLapsedError` 停轮） | owner lease 续期/失效行为要求（ME05 / A06、A18：失效实例不得发布终态，Mastra Spec `:113`） | 作为 ME 票行为要求吸收；不引入第二套 lease 状态机 |
| `TURN_LIMITS`（5 分钟超时、5s abort 兜底） | 后台执行取消/超时与"结果不明"处置（ME09 / A10；Mastra Spec `:115` 未知 receipt 不自动重放） | 作为超时与兜底语义的验收输入 |
| `HeadlessToolSuspension` + `OPENBOT_WAITING_METADATA` | 持久挂起与恢复（ME05/ME06 / A06、A07；continuation CAS 认领与过期回收，Mastra Spec `:124`） | 复用本地 `../approvals/native-context` 同名机制，不新造等待元数据 |
| `ApprovalContinuation` + `initiator` | 审批恢复证据 + 审计发起者（ME05 / A06、A17） | 复用本地 approvals/audit 模块 |
| `TurnAdmission` 端口（拒暂停/无 grant/模型不允许） | `guardBotTurn`（MT019）+ 准入模块（ME04/ME09 / A05、A10） | 行为已存在；ports 只是依赖倒置形态，随拆包决策处理 |

**后续验收**
- 若 ME 系列落地后确需跨包复用 turn 引擎：独立验收边界为"按 `ports.ts` 形态提取，注入端口全部来自 OpenBot 权威模块，提取后 run-turn 行为与现 server 内版本一致（既有 routine/headless 测试全绿），且无任何新增运行状态存储"。
- 反向验收（防重复建票）：不新建"实现 lock/lease/settle/cancel"的票——这些行为已由 ME02/ME04/ME05/ME09/ME14 覆盖；E01 不得产生与之平行的执行引擎票。

**采用或延期结论**
- **延期拆包采用**：toolkit 不作为本轮新依赖（父 Spec §1 `docs/specs/2026-10-20-upstream-openbot-adoption-design.md:56` "本次不将上游 toolkit 作为新强制依赖"）；其 lock/lease/settle/cancel 行为要求按上表映射进 Mastra 已批准票，权威唯一（RunService + 网关台账）。

**证据路径**
- `e8bb2736:toolkit/src/run-turn.ts`（docstring）、`toolkit/src/lease.ts:1-50`、`toolkit/src/limits.ts:10,20,30-41`、`toolkit/src/headless-tools.ts:23-46`、`toolkit/src/continuation.ts:9-19`、`toolkit/src/ports.ts:8-44`、`toolkit/package.json`。
- `server/src/routines/run-turn.ts:31-49,308-321`；`diff <(git show e8bb2736:toolkit/src/run-turn.ts) server/src/routines/run-turn.ts` ≈600 行（import/ports）。
- `docs/specs/2026-10-19-mastra-agent-execution-migration-design.md:54-65,104-115,121-126,137-139`；`docs/adr/0010-mastra-execution-openbot-governance.md:7`；`docs/specs/2026-10-20-upstream-openbot-adoption-design.md:56`。

## 5. 既有能力核验（不重复建实现票）

**现有入口 / 行为差距 / 证据**

1. **记忆镜像**：`server/src/memory/store.ts:65-71`（`mirrorEligible`：未删除 + 启用 + `reviewState IN ('confirmed','edited')` + 非空）、`:111`（OpenBot 行保留为 Intelligence 内容的记录）、`:129-130`（逐人单飞防并发双写）；Intelligence 侧 grant 恒为 `user: read-write, project: none`（`server/src/memory/intelligence.ts:18-22`）；隐私约束走 ADR 0005/Hindsight（`server/src/hindsight/config.ts:1-12`）。测试：`server/tests/memory-*.test.ts`、`intelligence-memory.test.ts`、`memory-intelligence.integration.test.ts`。结论：**已具备**，矩阵"部分具备"修正为"已具备"（见上文修正表）。
2. **Learning**：`server/src/learning/auto-assign.ts:1-10`（`AUTOMATIC_LEARNING_CONTAINER_ID` + 部署发起者审计）、`ensure-container.ts:1-12`（三条凭据路径：浏览器会话/CLI 兑换/服务 token，均以 runtime key 反证容器归属）、`settings.ts`。测试：`learning-auto-assign.test.ts`、`learning-ensure-container.test.ts`、`learning-settings.integration.test.ts`、`learning-runtime.test.ts` 等。结论：**已具备**。
3. **身份绑定（Slack/GitHub）**：`server/src/identity/`（`providers.ts`、`github-oauth.ts`、`github-callback.ts`、`slack-redeem.ts`、`retire.ts`、`audit-failure.ts`）。测试 13 个：`identity-providers.test.ts`、`identity-github-callback.integration.test.ts`、`identity-slack-redeem.test.ts`、`identity-retire.integration.test.ts` 等。结论：**已具备**（与矩阵第 9 行一致）。
4. **审计 CSV 导出**：路由返回 `text/csv; charset=utf-8` 并带 `audit-events-<day>.csv` 附件名与 `X-Audit-Export-Truncated` 头（`server/src/app.ts:1570-1596`，`:1587`）；导出动作本身写 `audit.exported` 审计事件（`server/src/audit.ts:477`（HEAD）/`:480`（工作树））；测试 `server/tests/audit-export.test.ts`、`app/tests/audit-export-truncated.test.tsx`。结论：**已具备**。

**约束**
- 本节为核验性登记（up11 AC5）：四项能力全部存在实现与测试证据，**不创建任何重复实现票**；后续涉及这些域的工作必须引用上述模块作为唯一实现入口（如 Mastra 迁移的记忆票消费 `server/src/memory/` 合同，Mastra Spec `:130-131`）。

**复用方案 / 后续验收**
- 复用即"引用，不重建"；无需独立验收。若未来上游在这些域出现新行为，按父 Spec 正常拆票并在票内引用本节证据路径作为"已覆盖基线"。

**采用或延期结论**
- **已具备**（无需采用动作）。

## 6. 剩余缺口汇总（采用/延期与验收边界）

| 缺口 | 结论 | 理由 | 独立后续验收边界 |
|---|---|---|---|
| OpenMuse mobile 缺上游式独立页（审批收件箱/记忆/插件/例程/规则） | 延期（backlog 候选） | 现有产品以聊天流 + Web 端覆盖同类操作；新建页面是增量而非补缺 | 第 1 项"后续验收"；每页独立纵向切片，OpenMuse mobile 现有 test/typecheck/build 管线验证 |
| Antigravity harness | 延期（不旁路） | 部署级单 Key 与 ADR 0002/0003 逐用户授权、预留结算不兼容；父 Spec 列 Out of Scope | 第 2 项三前置条件 + 双用户归属/撤销验收 |
| harness 单一目录机制 | 采用机制，后续任务交付 | 桌面单端硬编码将随 Web 需求变成双副本漂移；上游已验证 JSON + include_str + TS 类型模式 | 第 3 项行集等价测试；Web 行为零变化 |
| toolkit 拆包 | 延期（行为要求映射进 ME 票） | 行为已由本地 server 内实现 + Mastra 已批准票覆盖；拆包是打包问题 | 第 4 项"若提取"边界；禁止平行执行权威票 |
| 启动诊断（A09）、三 provider 研究（A10） | 非本任务缺口 | 已由本轮 D01 与 R01–R03 在途交付（`implementation-plan.md:48-49`） | 见对应 Task 与 AC，不在 E01 重复验收 |

**声明**：本文件全部结论为架构评估与决定登记；除在途任务（D01、R01–R03 等）已授权范围外，不构成任何功能实现、合并或上线事实。
