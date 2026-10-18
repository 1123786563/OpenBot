# MT074 RED→GREEN 记录

## RED-1（迁移注册表穷举断言）

- 编辑：`server/tests/multitenancy/migration-tool.test.ts` 穷举断言追加 "MT074"
  （ruling #5 第 21 次先例，带裁决注释）。
- 证据：`red-green/RED-1-allowlist.txt` —— 41 pass / **1 fail**
  （"the allowlist is exactly the registry and the shipped self-check task"，
  received 多出 "MT074"）。

## GREEN-1（迁移任务注册 + 表 + barrel）

- 编辑：`server/scripts/multitenancy/migrate-test.ts` 纯追加
  `VENDOR_BILLING_INTERACTIONS_STATEMENTS`（3 语句）+ `VENDOR_BILLING_INTERACTION_TASK`
  （单步 `vendor_billing_interactions`）+ TASKS 注册表 1 行；
  `server/src/db/schema/vendor-billing.ts` 新建；`server/src/db/schema/index.ts`
  barrel 追加 1 行（字母序 usage-outbox 与 voice 之间）。
- 途中一次执行序错误（const 声明在被引用之后 → TDZ ReferenceError）在 GREEN 前
  发现并修正（语句常量移到任务常量之前）——如实记录，不掩盖。
- 证据：`red-green/GREEN-1-allowlist.txt` —— **42 pass / 0 fail**。
- 迁移真实执行：`migrate-test.ts generate MT074 --out …` + `migrate MT074 --apply
  --manifest …`，journal 落账（`verification/01-prereq-chain-journal.txt`：23 任务
  43 步，MT074 = 1 步）；psql \d 存档于会话，manifest planDigest
  e096b27f…/statementDigest fcaedefc…（`verification/migration/generated/MT074/`）。

## RED-2（模块缺失）

- 编辑：`server/tests/multitenancy/vendor-billing.test.ts` +
  `server/tests/multitenancy/support/vendor-billing.ts` 新建，引用未存在的
  `../../src/billing/vendor-billing`。
- 证据：`red-green/RED-2-missing-module.txt` —— "Cannot find module
  '../../src/billing/vendor-billing'"，0 pass / 1 fail。

## GREEN-2（服务实现）

- 编辑：`server/src/billing/vendor-billing.ts` 新建（调用面 + 回调锁 + 审计读）。
- 首跑夹具缺陷（非实现缺陷）：MT069 `billing_customer_mappings` 对
  `billing_customers` 有外键，夹具补客户行（生产开通流同序）——修复后重跑。
- 第二处夹具缺陷（非实现缺陷）：fake vendor 调用记录跨用例累积，断言"供应商未被
  调用"的用例读到先前用例的记录——补 `forgetCalls()` 用例自清理。两处均为测试
  基础设施修正，服务实现零改动。
- 证据：`red-green/GREEN-2-focused.txt` —— **22 pass / 0 fail**（聚焦套件，
  真实 PostgreSQL）。

## REFACTOR

- biome 首跑 6 error（3 文件 organizeImports FIXABLE + 3 文件 format）→
  `--write` 修复（机械修复：import 排序与引号/折行格式；--write 原始输出未存档，
  终态见 `verification/10-biome-final.txt` = 7 触及文件 0 error，exit 0）。
  narrow-slit 复核：`narrow-edits.diff` 对 migrate-test.ts 的 4 个 hunk 全部为
  纯追加（0 删除/0 修改既有行）。
- typecheck：`bunx tsc --noEmit` = 0（`verification/09-typecheck-final.txt`）。

## 变异与还原

- 13 变异：12 直接 KILLED + M05 单层等价（SURVIVED）→ 复合 M05b（三臂全移）
  KILLED（`mutation/M05b-compound-retest.txt`）——MT070 M06/M06b「两层防护本就是
  设计」先例：隔离行 type/tenant 全空由 MT069 行形状 CHECK 结构性保证，status 臂
  是 belt-and-suspenders。
- 每次注入→聚焦→恢复→sha256 闭环全录（`mutation/results.txt`，13/13
  restore-vs-pristine=OK）；完成后服务文件 SHA-256
  a2ccc8e50a91ae4a85fce968bcab141c20783190a70212e54bb1a8c8c43d159f 与交付一致。

## 终态验证

- 聚焦（变异后）：22/0（`verification/07-focused-post-mutation.txt`）。
- 全量回归（变异后）：**1244 pass / 0 fail / 48 文件**（= 1222 基线 + 22 新增，
  `verification/08-full-post-mutation.txt`）。
- 基线复现：1222/0/47（`verification/00-baseline-1222.txt`，环境令牌无需微修——
  brief 预授权"已根治"）。
- 前置链：19 前置修正序 + MT029→MT073→MT060→MT074 全落账
  （`verification/01-prereq-chain-journal.txt`，23 任务 43 步）。
- prereq 漂移：284 项逐项复算，漂移恰为 3 个授权窄缝文件、0 missing。
