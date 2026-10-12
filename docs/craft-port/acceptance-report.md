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

---

# 附：Craft Parity Remediation 验收（2026-10-13，检查点 `6c7c0d16`）

> 增量验收范围：六能力恢复（C1–C6），提交 `bf81d741..6c7c0d16`。证据基线：`remediation-verification.md`（真实 agent-sandbox 冒烟）+ 全量 craft 测试。总判定：**契约级验收通过；真实现场带 6 项命名 finding（F-A…F-F），修复回流控制器后复验。**

| # | 验收行 | 结果 | 证据 |
|---|---|---|---|
| R1 | 全部 craft 测试（28 文件） | **PASS** — 425/425（1245 断言） | remediation-verification §1 |
| R2 | server + agent-sandbox typecheck | **PASS** — 双 EXIT=0 | 同上 |
| R3 | agent-sandbox 测试套 | **PASS** — 72/72 | 同上 |
| R4 | C1/C2 managed content（渲染+倒置+双哈希+reload 真值） | **PASS** — 测试全绿；live：段落渲染、MCP seed 后 reload 重写 opencode.json | §2/§3(i) |
| R5 | C3 MCP mcp block + 中继凭证 | **PASS** — 测试全绿；**live：工具调用回程 `FIXTURE_ECHO:mcpping`，中继逐调用解密附挂 Bearer** | §3(i) |
| R6 | C4 connect_app | **PASS（装配级）**；**真实现场 GAP(F-B)**：插件不注册（工具目录 12 项无 connect_app） | §3(ii)(iii) |
| R7 | C5 webapp 工具+托管启动 | **PASS（脚本级 live）**：真 `bun run dev`+flock+pid cwd 守卫+ready 行逐字节+幂等重跑；**GAP(F-B) 工具、GAP(F-D) 初装缺脚本、GAP(F-E) 预览拓扑** | §3(vii) |
| R8 | C6 ZIP 双路由 | **PASS（live 字节级）**：disposition/sanitize/仅文件条目；真空 dir=22B 零条目 ZIP；缺失 404；**GAP(F-C)** 顶层仅子目录时空档 | §3(viii) |
| R9 | 无新依赖/迁移/schema 变更 | **PASS** — 范围内零 diff（仅 audit.ts +7 常量） | §5.3 |
| R10 | BLOCKED 沿袭（company-search） | **维持 BLOCKED** — 无 backed skill 落地 | §5.4 |
| R11 | OCR 覆盖（--audience agent） | **部分（8/34 文件,15 意见,无 Critical/High）— LLM 429 配额阻断,已记录 + 待 round 2** — `ocr-report-round1.md` | §6 |

**复验指引**：F-B/F-D 修复后重跑 §3(ii)(iii)(vii)；F-C 修复后重跑 §3(viii) 顶层目录用例；F-A/F-F 为平台级（auth fetch 补丁旁路 craft 流量 + CAS 复位 initializing），修复后重跑完整 turn 环。
