# MOD02 实施计划（Issue #622 · 抽离 HTTP 路由装配并保持认证与挂载顺序）

Run：2026-10-23-issue620-orchestration（Orca run_b80194003f42）。计划版本：v1（2026-10-24）。
Brief 原文：`docs/plans/tickets/modular-architecture/MOD02.md`（验收以其 4 条为准，覆盖 AR03 / S1）。
前置：MOD01 verified 已集成（集成分支 HEAD `8d17ec1f3`；checker/清单可复用）。

## Global Constraints

- **用户原则**：原则上只移动代码，需要适配时才写代码。本票主体 = 把 `createApp` 的挂载段**原样迁移**到 `server/src/assembly/http.ts`；适配仅限：导入搬家、闭包变量显式化为装配依赖参数、类型引用。**不重排、不重写、不「顺手优化」任何挂载/中间件/路由逻辑。**
- 行为保持：启用路由的方法、认证、错误与响应合同不变；未认证/错误 scope/preview Origin/合法请求判定不变；可选能力关闭不挂空成功路由；缺必要配置保持原拒绝。
- **不得整体搬文件**（验收第 4 条）：`app.ts` 保留 deps 接口/解构、配置校验、常量与导出（UPLOAD_BODY_LIMIT_BYTES、defaultReadinessProbe、createDeploymentRequireUser、credentialInput 等），只把挂载段委托出去。
- 无提交授权：未提交工作树增量交付；禁 git commit/push/stash。
- 验证遵守 ADR 0008（新测试必须 e2e-compat 原生收集，先例 `server/tests/learning-runtime.test.ts:1`）。

## owned_files（冻结）

| # | 文件 | 权限 |
| --- | --- | --- |
| 1 | `server/src/assembly/http.ts` | 新增，全权：具名 HTTP 装配工厂（单一具名导出，如 `assembleHttpApp(deps)`：Hono 实例化 + 全部中间件与路由挂载，**次序与 app.ts 原序逐一对应**；依赖全部经显式参数传入） |
| 2 | `server/src/app.ts` | 修改受限：`createApp` 内自 `const app = new Hono…`（≈:881）至 `return app` 前的挂载段，替换为对装配工厂的单点委托；对外签名/返回/AppVariables 不变；段内原闭包引用（含段内创建的 `requireUser` 等）成为装配工厂内部逻辑或显式依赖 |
| 3 | `server/src/http-server.ts` | 预期**零改动**；仅当装配接线必要时最小 diff 并在报告说明 |
| 4 | `server/tests/module-http-assembly.test.ts` | 新增，全权：装配矩阵测试（导入 `../../tests/support/e2e-compat`） |
| 5 | `tests/config/module-imports.json` | 条件修改：仅当挂载段迁移使 checker 基线边变化时 `--baseline` 重收敛；逐条 delta 说明；新例外 ticket=MOD02；禁止手改消除违规 |

其余全部只读。超范围=违规，先停并报告。

## Task 步骤（单任务串行）

1. 阅读集：MOD02.md 原文 → 设计稿 S1/AR03 与 A 决定 → module-catalog（ASSEMBLY 与各 M 的挂载语义）→ runtime-flows 对应链路 → MOD01 checker 用法（`bun run scripts/check-module-imports.ts`）。
2. 定界：通读 `createApp`（:365–:3244），把挂载段（≈:881–:3240）与其依赖的闭包变量列成显式清单；列出段内创建、段后不用的局部（随段迁移）。
3. 迁移：挂载段**逐行搬运**至 `assembly/http.ts` 具名工厂；app.ts 同位置改为单点委托；导入按使用方拆分；不做语义改动。
4. 矩阵测试：三态（能力启用/关闭/缺必要配置）验证不挂空成功路由、缺配置原拒绝；未认证/错误 scope/preview Origin 反例保持原判定；用真实 deps 组装（可参照既有 e2e-compat 套件的构造方式）。
5. 验证：typecheck（server 无新增错误，存量 bootstrap-local-gateway 3 条已知）；新测试根入口收集全绿；跑 ≥3 个直接消费 createApp 的既有套件作行为回归；checker 全量（无新增违规；基线 delta 文档化或零 delta）；审计新文件 accounted。
6. 报告：实际消费者清单、闭包→显式依赖映射表、挂载次序对账（迁移前后挂载序列逐一对照）、验收 4 条勾选、保留臂、命令与退出码、增量 SHA-256。

## Consumes / Produces

- Consumes：MOD01 checker 与例外基线、现有公开 wire、现有 e2e-compat 套件构造方式。
- Produces：具名 HTTP 装配工厂与窄依赖合同；app.ts 原入口兼容；新旧路由挂载次序对账表。

## Review Focus

- 挂载次序对账表是否逐一对应（防重排/防丢挂载）；是否「只移动」（diff 应以搬运为主，适配最小）。
- 闭包引用是否全部显式化（无隐藏全局/隐式捕获）；deps 参数是否窄而具名。
- app.ts 是否保留实质内容（非整文件搬家）；http-server.ts 是否零改动。
- 矩阵测试三态真实性；既有套件回归选择是否有代表性（覆盖认证/Origin/能力开关）。
- 基线 delta（若有）逐条可解释、ticket=MOD02、无目录级豁免、无手改规避。

## 验收映射（AR03 · S1）

见 Brief 原文 4 条；完成标准=四条全勾 + 组合树验证通过 + 行为零变化证据。
