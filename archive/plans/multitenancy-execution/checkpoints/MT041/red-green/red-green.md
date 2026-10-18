# MT041 red-green 记录（TDD 全程）

## RED-1 — 模块缺失（`red-green/RED-1-module-missing.txt`）

先写 `server/tests/multitenancy/job-ownership.test.ts` + `support/job-ownership.ts`（夹具、
22 用例，票面 Verification 指定路径），服务模块尚不存在：

```
error: Cannot find module '../../src/enterprise/tenancy/job-ownership'
0 pass / 1 fail
```

## RED-2 — 迁移缺失自然实验（`red-green/RED-2-migration-missing.txt`）

实现 schema + 服务 + 注册 MT041 迁移任务后、**尚未 apply 迁移**时运行聚焦套件：
22 用例全部以 `PostgresError: relation "job_ownership" does not exist` 失败——
证明测试真实依赖迁移（自然实验，等价于「移除建表语句」的变异杀伤）。

途中的两次真实缺陷（TDD 抓到，非测试问题）：
1. `set local lock_timeout = '2s', statement_timeout = '5s'` 不是合法 SQL（SET LOCAL
   不接受逗号多键）——改为逐条 execute。
2. 迁移 `ENABLE RLS` 语法错误（正确为 `ENABLE ROW LEVEL SECURITY`），apply 被工具拒绝
   → 修正语句、清理本票三表 + MT041 journal 行、重新 generate+apply（journal 复验一致）。
3. drizzle 列名两处漂移（schema `createdAt()` 帮手硬编码 "created_at"：快照表的
   capturedAt 与租约表的 updatedAt）——schema 文件改显式列名与迁移一致。

## GREEN — 聚焦套件（`red-green/GREEN-focused.txt`）

```
22 pass / 0 fail / 137 expect()
```

migration-tool.test.ts：42 pass / 0 fail（allowlist 穷举断言含 MT041）。

## REFACTOR

服务内部无重复可除；biome 修正（useOptionalChain、support 未用 import、格式化触及
区域全部在本票新增块内）；修复后聚焦 22/0、全量 660/0/26、typecheck 0（verification/06、07）。

## 变异对 TDD 的回验

18 个语义变异 16 个直接杀伤；MUT2 初版为无效变异（onConflictDoNothing 幂等改写不可观测），
替换为真实语义变异（重 pin 改写 creation 快照）后被新增强断言杀伤；MUT5 单层移除被
reclaim WHERE 第二道防线结构性兜底（等价变异），复合移除后被杀伤——见 `mutation/`。
