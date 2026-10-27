# FIX-3：F-A5（#289 订阅 harness 边界）位置参数错位修复

工作区 `b5r-fix3`（分支 `1123786563/b5r-fix3`，BASE=6ec483c43）。仅改
`server/tests/subscription-harness-boundary.test.ts`；`server/src/**` 零改动。

## 结论

AUD-1 的裁决成立：**测试构造缺陷，非产品缺陷**。两条红断言的断言文本、期望值、
产品代码一字未改，只把位置实参对齐到 `builtInAgentConfiguration` 的当前签名，
套件即 4 pass / 0 fail。

## 根因复核

`git show 887f0cffd^:server/src/copilot.ts` 显示删除前的形参顺序：

| # | 删除前（13 参） | 现在（12 参） |
| --- | --- | --- |
| 1–10 | agent, model, apiKey, tools, computerGuidance, connectedVendors, standingInstructions, planModel, learnedSkills, governedModel | 同左 |
| 11 | `loadKnowledge?: LoadKnowledgeForBot` | `attribution?: { userId }` |
| 12 | `attribution?: { userId }` | `gatewayModel?: WorkbenchGatewayModelDial \| null` |
| 13 | `gatewayModel?: ...` | — |

`887f0cffd`（ADR 0009 全量移除知识库）删掉了第 11 个形参，但本文件按位置传参且
未同步：自删除点起，其后每个实参都错位一个槽位。

## 改动前后对照（逐断言）

### 断言 1 —「credit exhaustion 终态拒绝」（原 `:166-180`）

- **改动前**：13 个实参。dial 对象 `{ baseURL, apiKey }` 落在越界的第 13 位（被丢弃），
  第 12 位 `gatewayModel` 收到 `undefined` → 产品走 legacy 路径返回字符串模型 →
  `config.model?.doStream` 为 `undefined` → `Expected a callable model.`
- **改动**：删除多传的一个 `undefined`，dial 对象落到第 12 位 `gatewayModel`。
- **改动后**：产品经 gateway dial 构建模型，`doStream` 可调用；refusal 为
  `CreditInsufficientError`（`code=credits_exhausted`），`gateCalls=1`，审计写入
  `fallback:"none"`。PASS。

### 断言 2 —「subscription 路径在审计留痕」（原 `:228-241`）

- **改动前**：12 个实参。`{ userId: "person-1" }` 落在第 12 位 `gatewayModel`，
  第 11 位 `attribution` 收到 `undefined` → `attribution?.userId ?? null` 写 `userId: null`
  → `toContainEqual` 失败。
- **改动**：把 `{ userId: "person-1" }` 移到第 11 位 `attribution`，省略 `gatewayModel`。
- **改动后**：审计事件携带 `userId: "person-1"`，`kind/subscription_path_used/billing/provider/botId`
  全匹配。PASS。

### 断言 3（`:131`，原 `:121`）—— 核对结论：无同类错位

该调用传 8 个实参，止于 `planModel`。删除前的签名里 `planModel` 同样是第 8 位
（上表 #8 两侧一致），因此它**不是**「碰巧绿」——删除点在其之后，位置从未漂移。
它在修复前后都绿，且修复后仍绿。按任务要求未改动其语义。

## 护栏做法与理由

在测试文件内加了局部辅助函数，把三处调用改为经它转发：

```ts
const buildBuiltInAgentConfiguration = (
  ...args: Parameters<typeof builtInAgentConfiguration>
): ReturnType<typeof builtInAgentConfiguration> =>
  builtInAgentConfiguration(...args);
```

- **不碰 `server/tsconfig.json`**：AUD-1 明确不建议把 `tests` 纳入 `include`
  （会炸出数百条存量 `any`）。`server/tsconfig.json` 的注释本身也记着这个已知缺口。
- **实测护栏真的会触发**（用一次性临时 config 只检查本文件，验证后删除）：
  - 当前正确版本 → `tsc --noEmit` 0 错误、退出 0。
  - 少传一个实参（dial 落进 `attribution` 槽）→ `TS2353`：
    `'baseURL' does not exist in type '{ userId: string | null; }'`。
  - 还原原始缺陷形态（多传一个实参，共 13 个）→ `TS2554`：
    `Expected 3-12 arguments, but got 13` —— 正是本次 bug 的形状。
- **现状披露**：`server/tsconfig.json` 的 `include` 不含 `tests/`，`bun run tsc --noEmit`
  实测 `--listFiles` 中本文件计数为 0，故该护栏**今天是静默的**，只有将来扩大
  typecheck 范围时才真正拦截。它同时是一份可执行的形参契约文档。这一点已在代码
  注释里写明，不作夸大。

## 命令与读数

全部在 `/Users/wuyongjun/orca/workspaces/OpenBot/b5r-fix3` 执行。该件不在 bun 清单，走原生入口。

### 修复前（BASE 树，未改动）

```
./node_modules/.bin/e2e run --config e2e.unit.config.ts \
  server/tests/subscription-harness-boundary.test.ts
→ Tests  2 failed | 2 passed (4)
```

与 AUD-1 复现读数一致（先决条件满足，未触发「停下报我」）。

### 修复后

```
./node_modules/.bin/e2e run --config e2e.unit.config.ts \
  server/tests/subscription-harness-boundary.test.ts
→ EXIT=0
→ Test Files  1 passed (1)
→ Tests  4 passed (4)
```

四个用例：断言 1 标记 subscription、断言 2 不入 credit admission、断言 1 的终态拒绝、
断言 2 的审计留痕 —— 全绿。

### 类型检查

```
cd server && bun run tsc --noEmit   → EXIT=0，error TS 计数 0
```

零错误（比「零新增」更强）。

### 回归（邻近套件，2 件）

选择理由：两者都直接调用 `builtInAgentConfiguration`，且覆盖同一批产品路径
（usage meter / credit admission、gateway dial 路由），正是本次改动所依赖的形参序。

1. `server/tests/copilot-usage-meter.test.ts` —— 纯单元、不依赖数据库。
   `→ Test Files 1 passed (1) / Tests 36 passed (36)`，退出 0。无回归。
2. `server/tests/workbench-gateway-routing.integration.test.ts` —— 覆盖 gateway dial
   （断言 1 所依赖的路径）。该套件有 **2 条存量红**，与本次改动无关：
   - `streaming settles through the meter and non-streaming dials the gateway too`：
     日志 `builtin-run-scope-resolution-failed`（TypeError）导致模型不可计量。
   - `the credit gate still refuses before the gateway is dialed, naming who ran it and
     on which Bot`：`ASSERTION_FAILED: expected null to be "user-091"`。

   已做基线对照：把本文件还原为未改动版本、用同一个已迁移库复跑，
   **失败集合逐条一致**（`IDENTICAL_FAILURE_SET`），读数为 `2 failed | 5 passed (7)`
   两侧相同。故属存量失败，不是本改动的回归。两件都跑在
   `openbot_b5r_fix3_subboundary`（283 表）上，第 2 件已确认不是环境缺库所致。

### 格式/静态检查

`biome check server/tests/subscription-harness-boundary.test.ts` 报 1 条
`assist/source/organizeImports`。**存量**：把文件还原到 BASE 版本同样报这 1 条
（计数 1 对 1），且本次改动未触碰 import 块。

## 环境与清理

- 测试库 `openbot_b5r_fix3_subboundary`（`openbot-test-pg:5433`，283 表，
  owner `openbot`），迁移命令 `bun scripts/migrate.ts`，退出 0。
  用完已删除。
- 一次性验证用临时 `tsconfig.guard-check.json` 已删除，未入库。
- 未 push；未改动 `server/src/**`；未改动断言文本与期望值。
