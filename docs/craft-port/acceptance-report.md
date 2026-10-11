# Craft 移植验收报告

> 验收执行：岑执衡（主理人亲自复核，原验收员中断后接手）｜2026-10-11
> 范围：`server/src/craft/`（25 文件 TS + AGENTS.template.md）+ `server/src/db/schema/craft.ts` + 迁移 0072

## 总判定：✅ 通过（有条件——3 个集成缝需部署时接线，见文末）

## A. 编译与静态质量

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| A1 | `bun run typecheck` | **PASS** | craft 模块 0 错误。仓库现存 4 个错误全部位于 `billing/payments/*` 与 `src/index.ts`（CreditWriter），经 `git status` 核实为用户本人未提交的 billing 重构 WIP + stash 遗留，与 craft 无关 |
| A2 | `biome check`（craft + schema） | **PASS** | 26 文件 0 error 0 warning（含 import 排序 assist 全绿） |
| A3 | 模块导入冒烟 | **PASS** | `import ./src/craft/index.ts` 成功，47 个导出；createCraftRoutes / loadCraftConfig / translateOpencodeEvent 均为 function |

## B. 行为契约对照（逐项对 onyx 源码）

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| B1 | SSE 帧格式 | PASS | turn-routes.ts: `event: message` + data JSON、`: keepalive` 注释行、四响应头（text/event-stream / no-cache,no-transform / keep-alive / X-Accel-Buffering: no）、15s 间隔 |
| B2 | Redis 键名/TTL | PASS | turn-state.ts:77-86 键名照搬 `craft:interactive_turn:{id}` 等 4 键；TTL 常量齐 |
| B3 | 配置派生族 | PASS | bun -e 断言：hardCap=1800 / soft=720(0.4×) / runnerStale=90 / activeTurnTtl=2700 / requestIdTtl=3600 全 PASS |
| B4 | 翻译器-delta | PASS | `message.part.delta`(delta+partID+field=text) → agent_message_chunk；partType=reasoning → agent_thought_chunk；assistant 角色过滤（message.updated 预登记后放行，未知角色无 hydrate 时保守丢弃——偏离#3 已声明） |
| B5 | 翻译器-tool | PASS | exit!=0 且位于 `state.metadata.exit`（onyx 同位置）→ status=failed；exit=0 → completed；首见 tool_call + 后续 tool_call_update；_meta.toolName/kind/title 映射正确（edit→Editing） |
| B6 | 翻译器-terminator | PASS | session.idle ×2 → 恰一次 PromptResponse(end_turn) |
| B7 | directory 参数 | PASS | serve-client.ts 全端点携带 `?directory=`（注释明示隐蔽坑） |
| B8 | AGENTS.md 占位符 | PASS | 8 占位符替换，ORGANIZATION_INSTRUCTIONS_SECTION 最后替换（防 token 二次展开） |
| B9 | send-message 契约 | PASS | message-routes.ts: client_request_id 幂等复用 turn_id、active_turn 冲突 409、attachments 路径校验（attachments/ 下、拒绝对路径与 ..） |
| B10 | store CAS | PASS | finalizeSessionInitialization WHERE status='initializing' + rowcount；reserveNextjsPort 23505 冲突重试 + 部分唯一索引兜底 |

## C. 集成完整性

| # | 项 | 结果 |
|---|---|---|
| C1 | DI 装配自洽 | PASS — createCraftRoutes 全部依赖可满足，无循环依赖 |
| C2 | app.ts 接入 | 建议：`craftConfig.enabled` 时 `app.route("/api/craft", createCraftRoutes({requireUser, deps}))`，与 workshop 同工厂风格 |
| C3 | Redis 降级 | PASS — turn-state 有完整内存实现（workshop/locks 双实现模式） |

## D. 实现者声明的偏离核实（抽 3）

1. fetchMessage 异步 hydrate 降级 — **属实**，serve-client.ts 注释明示，行为差距可接受（text 落点走 part.updated gap-fill）
2. permission.asked auto-allow — **属实**，一期无审批子系统
3. restore no-op — **属实**，warm-sandbox 兼容形状

## 有条件项（部署时必答的 3 个集成缝）

```ts
createCraftRoutes({ requireUser, deps: {
  botIdFor: async (sessionId) => ...,           // 会话 → Bot（沙箱路由）
  llmConfigFor: async (session) => ...,         // 模型目录 → CraftLLMProviderConfig
  sandboxConnectionFor: (botId) => ...,         // 沙箱网关 {baseUrl, token}
  userNameFor: async (userId) => ...,           // AGENTS.md 个性化
}})
```

另：`OPENBOT_CRAFT_ENABLED=true` 开启；`bun db:migrate` 应用 0072 迁移。

## 遗留（二期路线，已在架构报告 §五）

- 端到端冒烟（建会话→发消息→SSE→重载→interrupt）需 agent-sandbox 网关在线实测；opencode 版本差异逐条回归（风险点 1）
- fetchMessage 异步预水化（若实测发现 delta 丢角色）
- skills/MCP 推送 + dispose-pending 标记 + 快照 sleep/wake + webapp 代理 + 审批对接 OpenBot approvals
