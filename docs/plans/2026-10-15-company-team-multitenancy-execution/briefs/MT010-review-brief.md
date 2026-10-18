# MT010 / Issue #53 独立复审 Brief — coordinator 下发

你是 MT010 的独立复审者（全新 Pi 会话）。只读被审文件；唯一新建 = archive/plans/multitenancy-execution/reports/MT010-review.md；不修复；无提交/推送/合并授权；skipped 不算通过。完成 worker_done 附 --report-path。

## 审阅对象（工作树 = 前置 36 项 + 本票 9 交付）

新 5：`personal-share-rules.ts`（属主校验/share/revoke/分享感知判定门，有效期数据库时钟、撤销即删行）、`db/schema/personal-shares.ts`（enterprise_resource_shares 表）、`personal-share-rules.test.ts`（34 用例）、`support/personal-share.ts`、`support/scenarios.ts`。
编辑 4（声称最小）：`db/schema/index.ts`（barrel +1 行）、`migrate-test.ts`（MT010 任务纯追加）、`migration-tool.test.ts`（窄例外第 4 次同型）、`index.ts`（装配段纯追加，存量披露零新增）。
注意：本树 index.ts/schema index/migrate-test/migration-tool.test 均为本票版本——与实现树 manifest 对照；实现树基线与 EXE 现态的差是并行票（MT014）所致，非本票缺陷。

## 重点裁决

- **A. 分享表设计（MT012 模板合规）**：复合 FK 内嵌 tenant_id（跨公司受众/grantor 结构性 23503）、FORCE RLS、动作域 CHECK（read-only）、最小列授权（directory 零、data 仅 SELECT、operator SELECT+INSERT+DELETE 无 UPDATE）、identity_operator 永不授予——迁移 SQL 逐语句审 + 活库抽查。
- **B. 判定门三重语义**：既有 reader（404 不泄露）/策略判定 DENY/分享感知 DENY——受众外同团队 DENY（受众 scoped）、分享不流经 grants（grants 仍唯一属主）。
- **C. 时间与撤销语义**：过期以数据库时钟裁决（+600ms sleep 用例的真实性）、过去时点创建拒绝、撤销=删行+立即失效、活跃唯一性（SHARE_ALREADY_ACTIVE）、停用→恢复→旧 scope 仍拒（epoch）。
- **D. 越权面**：被分享方转授/revoke 均 NOT_RESOURCE_OWNER 且与不存在同形；tenant_admin 不能分享个人资源；非 private 不可分享；自分享拒绝。
- **E. 纯追加/窄例外/改动面**：pristine 重建哈希（4 编辑文件）；diff 逐行核对。
- **F. TDD 链与 5/5 变异**（MUT4 补用例序列诚实性）；受限角色 current_user 钉死。
- **G. 「三条门全拒」测试断言强度**：是否空洞拒绝（对照 a1-other 的团队资格已验声明）。

## 独立复跑（亲自执行并记录退出码）

1. 端口预检 55486；容器 mt010-review-pg（pgvector/pgvector:pg16，trust，psql 探针）；五变量 + 随机口令 0600 用后删。
2. base migrate + 按依赖序 apply **MT004→MT008→MT112→MT012** + MT010 CLI 链（dry-run→generate→apply→重复 up-to-date）。
3. `bun test tests/multitenancy/personal-share-rules.test.ts --timeout 30000`（预期 34/0/0skip）
4. 全量预期 **397/0/0skip** 14 文件 = 363+34（本树为 EXE 全量态 + 本票）。
5. typecheck；biome 触及文件（新增 0；index.ts 存量披露对照）。
6. 活库抽查：enterprise_resource_shares 的 pg_policies/授权矩阵/两 CHECK；journal MT010 步骤。
7. 清理容器与凭据。
