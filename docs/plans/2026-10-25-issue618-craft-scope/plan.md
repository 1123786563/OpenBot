# #618 Craft sandbox gateway execution scope 注入方案

Run: `.archive/runs/2026-10-25-issue618-orchestration/`（Ledger 为执行事实源）

## 问题

`agent-sandbox` 代理（MT050，`agent-sandbox/src/proxy.ts:205-215`）要求每个请求携带 `x-openbot-tenant-id` / `x-openbot-workspace-id`，缺失或与 Bot 首次绑定 scope 不一致均 403。craft 侧 `server/src/craft/sandbox-gateway.ts` 的三组出站请求（file API、opencode-serve client + event bus、snapshot/restore）只带 `x-sandbox-token` + `x-openbot-bot-id`，导致 MT050 开启的沙箱上 craft 会话创建/文件读写/snapshot 必 403（上层 500）。

既有正解先例：`server/src/codesandbox/client.ts`（`SandboxClientOptions.executionScope` → 两个归属头）与 `server/src/enterprise/tenancy/execution-surfaces.ts`（按 ExecutionTarget 归属构造 client）。

## 设计裁决

1. **scope 是部署级单值，不是每请求用户值。** craft 的沙箱是部署级单一资源：`server/src/craft/config.ts:186`（"OpenBot routes all of craft to one deployment-chosen Bot workspace"）与 `server/src/index.ts` fix-ocr17 段（"The deployment's sandbox identity facts, shared by EVERY craft surface"）把所有 craft 面绑到同一 baseUrl/token/botId。MT050 将 bot 绑定到首个 scope，之后异 scope 即拒；若按会话用户注入不同 scope，同一部署 bot 必然跨 scope 被拒。故可信 scope 必须与 baseUrl/token/botId 同一信任平面、同一部署一致。
2. **来源 = 部署接线（config env），不从请求头透传，不伪造默认值。** 与 `OPENBOT_CRAFT_SANDBOX_GATEWAY_URL/TOKEN/BOT_ID` 并排新增部署级 tenant/workspace 配置（两者齐全才构成可用 scope）。craft config 现无任何 tenant/workspace 项（已核）；无 DB 侧对该部署 bot 的权威归属行（enterprise_bot_ownership 属企业 Bot 目录域，craft 部署 bot 不在其中——实施时须复核此论断并留证据）。
3. **fail-closed 于发送边界。** scope 不可用（配置缺失/不完整）时，gateway 出站方法返回可展示错误（craft errors 纪律），不发无归属请求。不给默认公司/团队。
4. **注入面 = 全链路。** fileApiFor（list/write/writeBytes/delete/read/readBytes）、serveClientFor（OpencodeServeClient 全部端点）、eventBusFor（PodEventBus SSE /event）、snapshotArchiveFor、restoreWorkspace。凡经 `craftSandboxConnection`/gateway URL 出站的 craft 面（含 webapp proxy / HMR 升级半边若走 gateway 代理）逐一审计：同样带头或给出不走 gateway 代理的证据。OpencodeServeClient/PodEventBus 构造参数加 executionScope，镜像 codesandbox/client.ts 模式。
5. **不泄漏。** scope 值不进模型上下文、普通日志、客户端 DTO；错误文案遵循既有脱敏（需要标识时用 describeExecutionScope 一类既有形态）。

## 不做

- #433 `/file/content` absent→404 契约。
- agent-sandbox 侧任何改动（MT050 门保持原样）。
- #631/MOD11 能力句柄绑定（后续票，本轮交付后评估解除其外部阻塞）。

## 验收方法（映射 #618 Acceptance）

| AC | 方法 | 证据归处 |
| --- | --- | --- |
| AC1 三组请求带头（可信值） | `server/tests/craft-sandbox-gateway-scope.test.ts` 逐请求断言 | verification/T1-*.md |
| AC2 同 Bot 跨 scope 被拒 | 真实栈负向：同 bot 异 scope 直打 gateway → 403；craft 侧无先绑后串用（单值 scope 设计） | verification/T2-*.md |
| AC3 缺失 fail-closed | 单测：scope 缺失时方法抛可展示错误、fetchImpl 零调用 | 同上 |
| AC4 单测覆盖 | 三组头 + 缺失 + 不匹配路径全断言 | 同上 |
| AC5 真实栈跑通 | N05 配方去 shim：agent-sandbox(MT050)+server+casdoor，会话创建+文件读写+snapshot | verification/T2-*.md |
| AC6 不泄漏 | 单测断言错误/DTO/日志不含归属值；真实栈日志抽查 | 同上 |

## 任务 DAG

T1 实施（TDD）→ R1 独立审核 → INT1 集成+组合验证 → T2 真实栈 → FR Codex 终审 → OCR → 报告（含 #631 阻塞解除判断）。
