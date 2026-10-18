# MT007 / Issue #50 独立复审 Brief — coordinator 下发

你是 MT007 的独立复审者（全新 Pi 会话，与实现者无共享上下文）。只读被审文件；唯一允许新建文件 = reports/MT007-review.md；不修复；无提交/推送/合并授权；skipped 不算通过。完成 worker_done 附 --report-path。

## 审阅对象

工作树 = BASE f0520524 + 前置转移（prereq-manifest.txt，领取时逐项复算）+ 本票交付（实现者声称）：
1. `server/src/enterprise/tenancy/revocation.ts`（新：六 checkpoint 失效点清单 + cascade guard 委托 MT005 gate + 审计事件写入）
2. `server/src/enterprise/tenancy/workspace-admin.ts`（扩展：restoreTeamMember/suspendCompanyMember/restoreCompanyMember + 既有 suspend/remove/reactivate 补审计）
3. `server/src/enterprise/runs/events.ts` + `runner.ts`（事件订阅入口接入 + 生产装配，16 行）
4. `server/tests/multitenancy/revocation.test.ts`（新 29 用例）
- checkpoints/MT007/（before/after、changes.diff、red-green/、mutation/、verification/）+ reports/MT007.md。
- **本树环境说明**：前置含全部已 verified 交付（MT001-008/112/012/013——基线全量 334 = 305 + 本票 29，与实现者环境 261 不同是实现树基线差异，非缺陷）。

## 验收（Issue #50 四条）+ 重点裁决

1. 团队停用后六面拒绝（列表/详情/下载签发/事件订阅/任务敏感动作/凭据取用）逐点测试
2. 公司停用：范围内全失效 + 他公司资格数据完好
3. 恢复后按当前策略重新生效、无旧拒绝缓存
4. 审计五要素（操作者/对象/范围/版本/时间）

重点裁决：
- **A. 单一失效入口（票据备注义务）**：失效点是否集中在 revocation.ts 单一判定入口供下游复用（vs 散落重复实现）；cascade guard 是否真委托 MT005 gate（不复制判定逻辑）。
- **B. 改动面**：prereq drift 是否恰为授权文件（workspace-admin.ts + events.ts + runner.ts）；index.ts 若有装配是否纯追加。
- **C. D5 核验**：tests/enterprise runner 51 个存量失败与 16 行编辑无关性——对照证据是否成立（可抽查重放）。
- **D. 审计写入路径**：审计事件是否经受限通道/正确事务语义写入（复用 MT006 operator 通道还是新开面——越权风险）。
- **E. TDD 链**（RED→GREEN、6/6 变异、复原哈希）与报告诚实性。
- **F. 范围边界**：实现者声明「下载/任务/凭据入口尚不存在（scope-carrying entrances），下游闭环票再接」——验证该声明的真实性（grep 现有入口面），防止把应做未做藏进披露。

## 独立复跑（必须亲自执行并记录退出码）

1. 端口预检 `lsof -i :55478`；专用容器 mt007-review-pg（pgvector/pgvector:pg16，trust，psql 探针就绪）；五变量 URL 显式用户 + 随机口令 0600 env 用后删。
2. `bun scripts/enterprise-test-db.ts migrate` + **按依赖序 apply 全部任务 MT004→MT008→MT112→MT012**（注意 MT012 依赖 MT112 锚点表；generate 各自 --out）。
3. `bun test tests/multitenancy/revocation.test.ts --timeout 30000`（预期 29/0/0skip）
4. 全量 `MT003_ASSIGNED_TEST_DATABASE_URL=… bun test tests/multitenancy/ --timeout 30000`（预期 **334/0/0skip** 11 文件 = 305+29）
5. `cd server && bun run typecheck`；`bunx biome check` 触及文件（新增 0 告警，存量披露对照）。
6. 清理容器与凭据。
