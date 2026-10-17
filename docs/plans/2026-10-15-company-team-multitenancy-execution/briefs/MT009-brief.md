# MT009 / Issue #52 实现 Brief — coordinator 下发

你是 MT009 的实现者（backend_implementer）。RED→GREEN→REFACTOR；票据正文优先于本 brief；未提交检查点；无提交/推送/合并/生产迁移/部署授权。

## 任务（#52，Epic #189）

团队成员无需逐人授权即可使用明确发布为团队公共的 Bot（read/run）与公共知识库（read），但不能编辑其配置、上传或删除内容；管理动作与内容读取分别判定。

## 验收（五条，逐动作测试）

1. 团队成员可读取并运行团队公共 Bot；不能修改其配置、不能删除。
2. 团队成员可检索团队公共知识库；不能上传、删除或改变其范围。
3. read 通过不派生 run/write/delete/share/manage（逐动作测试）。
4. 资源依赖（模型、凭据、知识范围）无效时拒绝并给出可解释原因，不静默降级。
5. 非团队成员即使拿到资源 ID 也被拒绝，且响应不泄露其存在性。

Verification：`bun test server/tests/multitenancy/team-public-rules.test.ts`（新建，真实 PostgreSQL）。

## 前置契约（领取时复算 prereq-manifest 32 项哈希）

- 前置 = MT001-008 + MT112 + MT012 + MT013 全部 verified 集合（EXE 快照）。重点消费：
  - MT008 `resource-policy.ts`（判定注册表 workspace-v1/tenancy-v1 + decide()）与 `resource-visibility.ts`——**只读消费，不得修改**（发现缺陷升级问 coordinator）
  - MT005 `scope-gate.ts`/`store.ts` seam、MT006 `workspace-admin.ts`（MT007 修复中的 revocation 域**不在本树**——注意本树 workspace-admin.ts 为 MT006 态）
  - MT012 RLS 兜底 + 策略模板（报告 §7 在 reports/MT012.md）——如需新表/策略按模板
  - MT013 启动校验开关已在 config/index——你的装配段不得动它
- 报告在 reports/（MT004/005/006/008/012/013 + review）。

## 可写文件

- 新建：`server/src/enterprise/tenancy/team-public-rules.ts`（动作规则模块）、`server/tests/multitenancy/team-public-rules.test.ts`、所需 support 夹具 `tests/multitenancy/support/team-public-rules.ts`。
- 纯追加：`server/src/index.ts`（装配段，不动既有行含 MT013 启动段/MT006 路由段）；如需迁移 `server/scripts/multitenancy/migrate-test.ts`（新任务注册，**先例：任务 id 命名 MT009**）+ `migration-tool.test.ts` 窄例外（第 4 次先例：3 行裁决注释 + 断言追加，保持最小形态）。
- **不得改**：resource-policy.ts、resource-visibility.ts、store.ts、scope-gate.ts、workspace-admin.ts、revocation 域、enterprise-tenancy.ts（如需表变更经迁移任务实现而非 schema 改动时，schema 与迁移同票披露并升级确认）、startup-checks.ts。

## 基线与环境

- 全量基线 **305/0/0skip**（11 文件）。完成后期望 305+新用例。
- 专用库 pgvector/pgvector:pg16（端口 55479，容器 mt009-impl-pg），trust，psql 探针就绪；`enterprise-test-db.ts migrate` + **按依赖序 apply 全部任务 MT004→MT008→MT112→MT012**（MT012 依赖 MT112 锚点表，顺序不可乱；generate 各自 --out）。
- 五变量 URL 显式用户 + 随机口令 0600 env 用后删不打印。
- typecheck + biome 触及文件（新增 0 告警，存量披露对照）。

## 交付物

reports/MT009.md + checkpoints/MT009/（全套：sha256-manifest、changes.diff、before/after、red-green/、mutation/、verification/）。全量 0-skip 证据。完成 worker_done 附 --report-path。

## 接管说明（coordinator，2026-10-16 第 2 任）

- 前任实现者（ctx_c4d6f3b90d63）死于 14:28Z 后的上游 502（Retry 3 失败），死时处于**收尾阶段**：交付物已基本就位（team-public-rules.ts 8475b21a…、team-public-rules.test.ts 7087b61b…、checkpoints/MT009/ 全套：red-green 四档、verification 三档、mutation、changes.diff、after/before），**唯一缺 reports/MT009.md**。
- /tmp/mt009-* 有其工作文件（env.sh 0600 含库凭据可复用容器 mt009-impl-pg 仍在运行、biome-before/after、tpr-original）。
- **你的任务**：1) 复算 checkpoints/MT009/sha256-manifest 与交付哈希；2) **查清 verification/01-full-suite-12-files.txt 的 1 fail**（340 pass/1 fail——是未修缺陷、flaky 还是已由 GREEN-2 解决？RED→GREEN 链与最终态对齐后给结论）；3) 若交付有实质缺口按原 brief 补齐（TDD 纪律）；4) 独立复跑全绿门槛（聚焦 35/0/0 + 全量 340/0/0 + typecheck + biome）；5) 写 reports/MT009.md（含接管叙事与前任增量的甄别）；6) worker_done。
- 不得丢弃前任交付重来——按检查点受理与补全。
