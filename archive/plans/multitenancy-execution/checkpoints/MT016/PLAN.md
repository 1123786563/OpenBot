# MT016 execution plan (TDD) — Bot 归属固定（Issue #59）

- [ ] prereq-manifest 67/67 hash recompute OK（claim time 已复算通过）
- [ ] dedicated container mt016-impl-pg (55491, pgvector/pgvector:pg16) + 2 DBs + migrate + 9 tasks（MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026）
- [ ] baseline full suite: 577 pass / 0 fail / 0 skip / 22 files（与 brief 一致）
- [ ] RED-1: bots-ownership 模块测试先行 → Cannot find module（存档）
- [ ] GREEN-1: schema enterprise-bot-ownership（2 新表）+ MT016 迁移任务 + 服务模块（create/list/count/get/update/delete/preferences/company-scoped cleanup）
- [ ] 验收逐条映射（brief 票面 4 条 + issue #59 5 条；不可见语义复用 MT011 canonical 形状）
- [ ] full regression ≥577+新增 / 0 fail / 0 skip + typecheck 0 + biome 触及文件 0 新增
- [ ] mutation tests 全捕获 + restore 后 sha256 复验 + 聚焦复绿
- [ ] checkpoints（red-green, verification, mutation, hashes, changes.diff, sha256-manifest, review-package.json）
- [ ] reports/MT016.md + worker_done --report-path

## 设计要点

- 新文件优先：`server/src/enterprise/tenancy/bots-ownership.ts`、`server/src/db/schema/enterprise-bot-ownership.ts`、`server/tests/multitenancy/bots-ownership.test.ts`、`server/tests/multitenancy/support/bots-ownership.ts`。
- 授权编辑面（最小）：`migrate-test.ts` 追加 MT016 任务；`migration-tool.test.ts` 仅穷举断言行 + 裁决注释；`db/schema/index.ts` 追加 1 行 barrel。
- 可见性门 = 同公司 + 同团队 + active + 有效团队成员；编辑/删除 = 门内再验 owner（无管理身份隐式继承）；不可见 = MT011 canonical `{outcome:"deny",code:"RESOURCE_NOT_FOUND"}`。
- 偏好/默认配置同归属：default_config 在归属行内（结构上不可分离）；偏好行复合 FK → 归属行 + 公司成员（Spec §4.2 子记录规则）。
- 公司作用域清理：enumerate/hardDelete 按 (tenant_id, owner_principal_id, agent_id) 三重钉死；user id 单独不删任何行。

## 第 2 任接管执行记录（2026-10-17，task_efba8c4dab4b / ctx_63d9a394c9ad）

- [x] 接管审计（takeover-audit-2nd.md）：保留 4 文件 + 3 授权编辑增量；修复模块公司级成员重验缺口、支持夹具撤权契约断点、migration-tool MT016 穷举行、判定顺序
- [x] 专用容器 mt016-impl2-pg @ 55502（55501 被占 +1）+ 双库 + migrate + 角色配给 + 9 前置任务 applied（verification/02-env-setup-2nd.txt）
- [x] RED-2 接管基线 38/4 存档（red-green/RED-2-2nd-takeover-baseline.txt）
- [x] GREEN：聚焦 44/0/0（GREEN-3-2nd-post-mutation-restore.txt）；全量 621/0/0（23 文件，基线 577+44；verification/07-final）
- [x] 变异 6/6 捕获（MUT5 首轮存活→补双团队成员测试→MUT5b 捕获；mutation-2nd/results.txt）+ 还原 sha256 复验 + 复绿
- [x] typecheck 0（verification/05）；biome 触及 7 文件 0 新增（verification/06，含 barrel 排序修复）
- [x] 十一任务注册表穷举行（migration-tool.test.ts，授权编辑点 #2）+ 迁移链全 applied
- [x] after-hashes-2nd / changes.diff / sha256-manifest / review-package.json
- [x] reports/MT016.md（含接管处置与 D1–D8 披露）+ worker_done --report-path
