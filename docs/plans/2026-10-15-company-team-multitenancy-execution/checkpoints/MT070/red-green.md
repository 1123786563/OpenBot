# MT070 TDD 全程记录（RED → GREEN）

## RED-1 — 迁移注册表断言（test-first）

- 编辑：`server/tests/multitenancy/migration-tool.test.ts` 穷举断言追加 "MT070"
  （brief 预授权编辑点，ruling #5 第 13 次先例）。
- 运行（全套 env，0 skip）：`bun --no-env-file test tests/multitenancy/migration-tool.test.ts`
- 结果：**41 pass / 1 fail** —— 唯一失败正是 allowlist 断言
  （"the allowlist is exactly the registry and the shipped self-check task"）。
- 证据：`red-green/RED-1-registry.txt`

## GREEN-1 — 注册 MT070 任务迁移

- 编辑：`server/scripts/multitenancy/migrate-test.ts` 纯追加 MT070 任务
  （单步 `company_call_attributions`，3 条语句）+ 注册表 1 行。
- 运行：同上
- 结果：**42 pass / 0 fail**。证据：`red-green/GREEN-1-registry.txt`

## RED-2 — 服务模块缺失（自然实验）

- 编辑：新写 `tests/multitenancy/company-reservation.test.ts`（票面 Verification
  指定路径）+ `tests/multitenancy/support/company-reservation.ts`（夹具），
  顶层 import 尚不存在的 `src/billing/company-reservation`。
- 运行：`bun --no-env-file test tests/multitenancy/company-reservation.test.ts`
- 结果：`Cannot find module '../../src/billing/company-reservation'` —— **0 pass / 1 fail / 1 error**。
- 证据：`red-green/RED-2-module-missing.txt`

## GREEN-2 — 实现 + 迁移落库

- 新增 `src/db/schema/call-attributions.ts`（与 MT070 迁移 SQL 一一对应）、
  `src/billing/company-reservation.ts`（公司预扣 seam）、schema barrel 追加。
- 迁移：`migrate-test.ts generate MT070` + `--apply --manifest`，journal 第 15 行落账
  （verification/07-mt070-migration.txt、14-journal-final.txt）。
- 途中三次真实缺陷修复（全部在 GREEN 前完成，red-green 循环内）：
  1. `check` 从 drizzle-orm 根导出不存在 → 改从 `drizzle-orm/pg-core` 导入；
  2. 夹具 `ids[companyKey]` 键形状错误（camelCase）→ `companyIdOf` 映射；
  3. call_key 预检误杀幂等键重放 → 预检放行「已有行即同一幂等键」的重放，
     归属漂移由归属行比对拒绝（JOIN credit_reservations 比对幂等键）。
  另修正测试侧两处：writer `settleReservation` 单对象入参形状；并发同 call_key
  兜底用例改 `Promise.allSettled`（败者是 rejection 而非 refused 形状）。
- 运行：**16 pass / 0 fail / 0 skip**。证据：`red-green/GREEN-1-focused.txt`
  （最终版；命名沿用票内先例——聚焦套件的最终 GREEN 存档）

## 收尾门槛（post-GREEN）

- 全量回归（票后）：**786 pass / 0 fail / 30 文件 / 0 skip**（= 770 基线 + 16 新增）
  —— `verification/08-full-regression.txt`、biome 收尾后复跑
  `verification/12-full-regression-post-biome.txt`、变异还原后终跑
  `verification/13-full-final.txt`（三次全量均 786/0）。
- typecheck：`bunx tsc --noEmit` = 0（`verification/09-typecheck.txt`）。
- biome：7 个触及文件 0 error 0 warning（首跑 6 error 2 warning → `--write` 修复
  过程 + optional-chain 手工修复 → 终跑干净；`verification/10-biome-first.txt`、
  `verification/11-biome-final.txt`）。
- 变异：12 变异 11 直接杀伤 + M06 单层等价（复合 M06b 杀伤），还原后哈希逐位一致
  （`mutation/results.txt`、`mutation/MUT6b-compound-retest.txt`）。
