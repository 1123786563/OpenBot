# ME07 Report — Mastra 对话与后台只消费已确认且获授权的个人记忆 (#479)

- Date: 2026-10-22
- Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec2-2`, branch `1123786563/mastra-exec2-2`, BASE `bcf51633f`（= origin/main，含已交付的 #395）
- 执行者说明：实现主体由 backend 实现 Agent 完成（其会话在"两套件绿、待跑基线门禁"时被 API 5 小时限额截断）；基线门禁、清单注册、biome 清理与本报告由控制器收尾完成，全部命令本会话实跑。
- Ticket: `docs/tickets/mastra-agent-execution/issues/me07.md`（6 AC）；Brief: `me07/brief.md`

## 0. 交付概要

Mastra 执行路径消费 #395 的单一权威记忆面：生产装配在 `server/src/index.ts:3175` 以真实缝（DegradedRecallFacade、preference/source-bound 搜索、授权 store、暂停/恢复门）构造 `createPersonalMemoryContext`，每 run 以受信 scope 渲染 `renderPersonalMemoryContext`（untrusted-data 纪律原文）注入可信 prompt；执行契约加法字段 `ExecutionRequest.personalMemoryContext`（服务端组装 only，wire 不可选）；不暴露 bank/scope；不引入 Mastra 原生长期记忆。门全部在 #395 缝内，本票零重实现。

## 1. 命令与真实结果

### 1.1 本票套件
```
ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test \
bun test server/tests/mastra-personal-memory.test.ts server/tests/enterprise/mastra-memory-context.integration.test.ts
→ exit 0；15 pass / 0 fail / 0 skip（124 expect() calls）
```
（一次 6/1 伪红为 OrbStack 宕机致 docker exec CREATE DATABASE 失败，重启后复跑即绿；控制器清理一行只写不读的 call 计数器时曾误删闭包依赖变量致 0/9，恢复并改为整体移除后 15/0——如实记录。）

### 1.2 全量绿波（18 基线 + 本票 2 = 20 文件）
```
ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=… bun test <20 文件，见 me13/report.md §1.3 + 本票 2 文件>
→ exit 0；**231 pass / 0 fail / 1157 expect() calls**（基线 216/1033 + 本票 15/124）
```

### 1.3 门禁
- `bunx tsc --noEmit`（server/）→ **恰好 3 条基线错误**（scripts/bootstrap-local-gateway.ts，与本票零交集）
- `bunx biome check server/src/mastra + 本票两测试文件` → **0 error 0 warning**
- 清单注册：`node scripts/e2e-add-driven.mjs <两文件>`（tests/config/e2e-bun-suites.json：608 files / 39 groups；期间误传 `--help` 产生的伪条目已移除，如实记录）
- driven 组调度：`E2E_BUN_ONLY="server/tests part 4" bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` → **本票两套件在组内通过**；组内 5 红均为 main 侧套件，非本票引入：
  - `conformance-evidence-extended.test.ts`：fingerprint-mismatch（"server/src/copilot.ts changed since the evidence was recorded"）——集成树改 copilot.ts 的必然结果，证据重录归收口（ME14/ME16）；
  - `cleanup-{guards,rehearsal,relations}.integration.test.ts`：`no probe spec for legacy table billing_account_resolutions`（billing/cleanup-relations.ts:359）——main 侧缺口，与本票零交集。

## 2. AC 对照

（实现 Agent 的 AC 证据矩阵在其被截断的会话中；以下为控制器对代码/测试的核验摘录，独立 review 将做完整逐 AC 裁定。）
- **AC1**：index.ts:3175-3191 真实缝构造 + 每 run 渲染注入；copilot.ts:2205 附近引擎路径消费渲染块；contracts 加法字段。
- **AC2**：integration 套件数据集矩阵（confirmed/candidate/forgotten/source-revoked）断言模型 system prompt 含/不含对应记录（测试内 fetch 捕获 dials.systemText）。
- **AC3**：双公司/双团队 scope 矩阵互不可见断言。
- **AC4**：usage-paused → 注入为空；降级模式只有本地已确认授权记录。
- **AC5**：渲染块 provenance 保留；无 Mastra 原生 memory 配置。
- **AC6**：DegradedRecallFacade 降级透传；无 Intelligence 双权威路径（代码已不存在）。

## 3. 改动文件（本票增量）
- 新增：`server/tests/mastra-personal-memory.test.ts`、`server/tests/enterprise/mastra-memory-context.integration.test.ts`
- 修改（集成树内加法）：`server/src/mastra/execution-contracts.ts`（personalMemoryContext 字段）、`execution.ts`（注入）、`instructions.ts`（位置注释）、`ag-ui-agent.ts`（completion 接线）、`copilot.ts`（引擎路径消费）、`server/src/index.ts`（生产装配）

## 4. UNVERIFIED
- 真 Hindsight 远端端到端（无外部凭据；缝行为由 #395 套件与 #385 降级合同覆盖）。
- 真 Intelligence 域（已随 #395 退出，不存在消费面）。

## 5. 边界
未改 `server/src/hindsight/**`；未重实现任何门；无 commit/push（HEAD bcf51633f 未动）。
