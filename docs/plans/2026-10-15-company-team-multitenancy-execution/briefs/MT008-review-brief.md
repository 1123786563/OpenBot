# MT008 / Issue #51 — 独立复审 Task Brief

你是独立 Pi Reviewer，只读审阅，与实现者（Task `task_abdbac221bdf` / Dispatch `ctx_3e5857d058e2`，已结算；第三次接管者，前两次死于平台事件非任务失败）无共享会话。

## 背景与快照

- 本树 = 实现树 i6-mt008 的逐文件副本；coordinator 已按 `checkpoints/MT008/sha256-manifest.txt` 复算 **29/29 一致**（产物以工作树根为路径基准、checkpoint 以 plan 目录为基准、`--` 结尾行为分节标题、`#` 为注释）。
- 前置含裁决 #9 修复的 4 个 MT006 文件（mt008-restore-{before,after}.txt 存档）——复算其哈希与 checkpoints/MT006/sha256-manifest.txt 声明值一致。
- 预期 git 状态：`M enterprise-tenancy.ts / store.ts / index.ts / config.ts / app.ts / migrate-test.ts / migration-tool.test.ts` + 清单 untracked（前五者含 MT005/MT006 前置增量 + 本票增量）。

## 目标

两个独立结论：(1) Spec compliance——Issue #51 四条验收（private/workspace 可见性+未标记资源回归 / 新策略版本独立注册+旧版本判定升级前后完全一致（对照测试）/ 旧 public→团队公共仅显式动作+工具不自动扩范围 / 跨公司引用永远拒绝）；(2) Code quality。finding 分级 critical/high/medium/low/info（file:line 证据）。

## 审阅对象

- 新文件：`enterprise/tenancy/resource-policy.ts`、`resource-visibility.ts`、`tests/multitenancy/resource-policy.test.ts`（29 用例）、`support/resource-policy.ts`
- 修改：`enterprise-tenancy.ts`（可见性属性 schema 追加）、`migrate-test.ts` + `migration-tool.test.ts`（迁移任务注册）、报告与 checkpoints

## 重点审查项（实现者披露，须独立定夺）

1. **继承套件 3 处测试修复**（red-green/RED-2 披露：factsOf helper override bug + suspended-member 用例「违反 MT005 seam」）——这是对 prereq 交付测试文件的修改：逐处对照 MT005-era 原文（before-hashes / EXE 侧 git 基线），判定是合理修复还是削弱既有语义；若语义变化必须升级 finding 并评估对 MT005 判定面（WORKSPACE_FORBIDDEN 等）的影响。
2. **1 个存活变异**（4 变异 3 杀 1 存活已披露）——定位其测试缺口，判定严重度（medium 候选）。
3. **迁移任务注册窄例外**：migration-tool.test.ts 的 ALLOWED_TASK_IDS 变化是否按裁决 #5 先例最小化（diff 行数、哈希存档、披露）。
4. AC2 对照测试真实性：同一输入集在旧版本注册前后的判定逐例一致（非仅新版本全绿）。
5. AC3 显式迁移：无清单/空清单零写入；自动扩范围路径不存在。
6. AC4 越权：A 公司主体引用 B 公司资源 403/404 语义不泄露存在性。
7. RLS/expand-only：schema 追加带 RLS+FORCE（MT004 惯例）；store.ts/scope-gate.ts 等前置文件未被改语义（对照 prereq 基线）。
8. TDD 链真实性（RED-1/RED-2/GREEN、变异存档、复原后哈希一致）。

## 独立复跑（必须亲自执行并记录退出码）

1. 端口预检 `lsof -i :55466`；起专用库（pgvector/pgvector:pg16，容器名 mt008-review-pg，**psql 探针就绪勿只用 pg_isready**；再建 assigned 库）。
2. `TEST_DATABASE_URL=postgres://postgres@… ENTERPRISE_TEST_SETUP_DATABASE_URL=… ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL=<三登录> bun scripts/enterprise-test-db.ts migrate` + `migrate-test.ts migrate MT004 --apply`（前置；如本票迁移任务有 apply 前置按报告补）。
3. `bun test tests/multitenancy/resource-policy.test.ts --timeout 30000`（预期 29/0/0skip）
4. 全量 `MT003_ASSIGNED_TEST_DATABASE_URL=… 其余同上 bun test tests/multitenancy/ --timeout 30000`（预期 **232/0/0skip** = 203+29）
5. `cd server && bun run typecheck`；`bunx biome check` 触及文件（存量比对披露）。
6. 清理容器与凭据。

## 产出

写 `reports/MT008-review.md`（唯一允许新建/修改文件）：Verdicts、findings、命令与退出码、哈希复算、三处测试修复的逐处判定、存活变异处置意见。

## 约束

只读被审文件；不修复；无提交/推送/合并授权；skipped/blocked 不算通过；完成按 preamble worker_done --outcome succeeded|failed 附 --report-path。

## 接管说明（coordinator，2026-10-16 首次接管）

- 前任复审者（ctx_9328117dccee）2026-10-16 08:31 UTC 派发、约 1 分钟后死于**上游 API 502 风暴**（Retry 失败、agent 循环终止），**无任何增量**（/tmp/mt008-review/ 不存在，报告未动笔）。死于平台事件，非任务失败。
- 工作树保持 coordinator 派发时转移的状态（交付物 29/29 哈希复核通过后未再触碰）。无遗留中间态需要甄别，按 brief 从头完整执行即可。
