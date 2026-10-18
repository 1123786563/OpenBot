# MT131 / Issue #174 — 独立复审 Task Brief（review2，恢复会话）

你是独立 Pi Reviewer，只读审阅，与实现者（Task `task_9b95a3b8cb96` / Dispatch `ctx_c83a96b3959d`，已结算）无共享会话。

## 目标

两个独立结论：(1) Spec compliance——Issue #174 四条验收标准；(2) Code quality。有效 finding 按 critical/high/medium/low/info 分级（含 file:line 证据）。

## 快照与完整性核验（先做）

- `git rev-parse HEAD` 应为 `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` 前缀（f0520524f0faa2b4533b9d2f1aa692c8f907ba71 开头）；不符即停。
- 逐条复算 `archive/plans/multitenancy-execution/checkpoints/MT131/review-sha256-manifest.txt` 每个文件 SHA-256；不匹配 → worker_done --outcome failed。
- `git status --porcelain` 只含清单内 untracked 路径。
- 冻结包 `archive/plans/multitenancy-execution/review-packages/MT131.json` 的 7 文件哈希与磁盘一致。

## 审阅对象

- `server/scripts/multitenancy/acceptance-harness.ts`
- `server/tests/multitenancy/acceptance-harness.test.ts`
- 报告 `archive/plans/multitenancy-execution/reports/MT131-harness.md` 与 `archive/plans/multitenancy-execution/checkpoints/MT131/**`
- 前置（只读）：MT001 `inventory.ts`/`inventory.test.ts`、MT002 `support/fixture.ts`、`support/scenarios.ts`、`fixtures.test.ts`（已验证集成的 f0520524f0faa2b4533b9d2f1aa692c8f907ba71 快照）

## 审阅要点

1. Issue #174 四条验收逐条对照测试证据。
2. harness 隔离性：数据库、端口（45436 预留）、外部命名空间前缀互不污染开发栈；不读 root `.env`。
3. 覆盖语义：只有 `entrances` 算路由覆盖；`serviceSurfaces` unassembled/not_enumerated 不算；缺正向或缺拒绝侧 = uncovered，绝不合成通过；未注册/异常场景必须报错。
4. 毒化正向控制：故意注入的未授权观察必须被发现（harness 自检能力）。
5. 消费 MT002 接口签名不变：`createIsolationFixture(domain, options?)`、`registerIsolationDomain`、`runIsolationScenario`、`registeredIsolationDomains`、`FIXTURE_IDENTITIES`、`SPEC_IDENTITY_MATRIX`。
6. `evaluator` 是自验 seam，文档声明生产调用必须省略。
7. 代码质量与报告声明一致性。

## 独立复跑（必须亲自执行并记录退出码）

1. 端口预检：`lsof -i :55444`、`lsof -i :45436`（应空闲）。
2. 起专用库：`docker run --rm -d --name openbot-i6r2-mt131-pg -e POSTGRES_DB=openbot_enterprise_mt131_review -p 127.0.0.1:55444:5432 postgres:16`。
3. 自建环境文件 `/tmp/mt131-review2-env.sh`（权限 0600，自生成随机密码，绝不打印内容；结构参照 `server/tests/support/enterprise-database.ts` 与 MT131-harness.md 记录的 setup：TEST_DATABASE_URL、ENTERPRISE_TEST_SETUP_DATABASE_URL 及三个受限角色 URL，指向 127.0.0.1:55444/openbot_enterprise_mt131_review）。按报告记录的受控方式执行 enterprise migrate 并建立受限角色。
4. `source /tmp/mt131-review2-env.sh && OPENBOT_MT131_HARNESS_PORT=45436 bun test server/tests/multitenancy/acceptance-harness.test.ts`（以测试实际读取的环境变量名为准，先读测试文件确认）。
5. `cd server && bun run typecheck`；`bunx biome check server/scripts/multitenancy/acceptance-harness.ts server/tests/multitenancy/acceptance-harness.test.ts`。
6. 清理：删除 /tmp/mt131-review2-env.sh；`docker rm -f openbot-i6r2-mt131-pg`。
   环境/凭据阻塞的项标记 blocked + 原因，不当通过也不宣称失败。

## 产出

写 `archive/plans/multitenancy-execution/reports/MT131-review2.md`（本工作树内唯一允许新建/修改的文件）：Verdicts、findings、命令与退出码、哈希复算。

## 约束

- 只读被审文件与前置；不修复 finding；不改 MT001/MT002 文件与共享 support。
- 无提交/推送/合并/生产迁移/部署授权；skipped/blocked 不算通过。
- 按 preamble `worker_done --outcome succeeded|failed` 结算，摘要含两结论与 finding 计数，附 `--report-path`。
