# MT007 / Issue #50 实现Brief — coordinator 下发

你是 MT007 的实现者（backend_implementer）。按 RED→GREEN→REFACTOR 交付；本 brief 与票据正文冲突时以票据正文为准。

## 任务（#50，Epic #188）

公司或团队管理员停用某人后，此人的后续请求、下载签发、订阅、任务敏感动作与凭据获取都失效，且变更留有可追溯的审计记录；其他公司的资格不被误删。

## 验收（票据四条，全部逐点测试）

1. 团队停用后：列表、详情、下载签发、事件订阅、任务敏感动作、凭据取用全部被拒绝（逐点测试）。
2. 公司停用后：该公司范围内全部团队权限失效；同一用户在另一公司的资格与数据完好。
3. 恢复成员后权限按当前策略重新生效，不残留旧的拒绝缓存。
4. 每次停用/恢复/撤权写入审计：操作者、对象、范围、版本、时间。

Verification：`bun test server/tests/multitenancy/revocation.test.ts`（新建，真实 PostgreSQL）。

## 事实源与前置契约

- 父 Spec #6（R1–R7 / A1–A13 / §8）、ADR 0004（accepted）/0002/0003、CONTEXT.md「公司与团队」。覆盖 A5、A2。
- BASE `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`；前置已由 coordinator 转移（`checkpoints/prereq-manifest.txt` 29 文件自校验通过）= MT001–MT006 + MT008 + MT112 verified 集合。
- 领取时先复算 prereq-manifest 哈希；读取实际交付契约：MT005 scope-gate（seam + 事务内重验 revalidate）、MT006 workspace-admin（停用/移除动作、advisory 锁键序、operator 通道）、MT008 resource-policy（判定注册表）。前置报告在 `reports/`（MT004/005/006/008/112 及 review）。
- **票据备注（必须遵守）**：你的失效点清单是下游各闭环 Ticket 的复用基础——把失效点做成可复用的单一判定入口，不要散落各处；下游不会各自实现撤权判断。

## 可写文件（票面域；其余只读）

- 新建：`server/src/enterprise/tenancy/revocation.ts`（失效点清单/级联判定 + 恢复语义 + 审计事件写入；命名可按实现微调但须在报告说明）、`server/tests/multitenancy/revocation.test.ts`、审计如需独立模块则新文件。
- 扩展（纯追加/最小编辑，报告披露 diff）：`server/src/enterprise/tenancy/workspace-admin.ts`（如需补「恢复」动作——勘察 MT006 已有停用/移除语义后决定）。
- 业务动作接入点（下载签发/事件订阅/任务敏感动作/凭据取用）：先勘察 server/src 相应路由/服务的现有入口，以最小面接入失效判断（优先复用 scope-gate seam 或你的 revocation 入口）；每个接入点在报告中列出 file:line 与接入方式。
- `server/src/index.ts` 如需装配：纯追加段（不要动既有行）。**本票不得改**：enterprise-tenancy.ts、migrate-test.ts、migration-tool.test.ts（MT012 并行中）、resource-policy.ts、resource-visibility.ts、store.ts（如确需 seam 扩展，升级问 coordinator）。

## 基线与环境

- 全量基线：`bun test tests/multitenancy/ --timeout 30000` = **232 pass / 0 fail / 0 skip**（9 文件）。完成后期望 232+你的新用例。
- 专用库：pgvector/pgvector:pg16 容器（端口 55471，容器名 mt007-impl-pg），trust；**psql 探针等就绪勿只用 pg_isready**；`bun scripts/enterprise-test-db.ts migrate` + `migrate-test.ts migrate MT004 --apply`（前置）。
- 五变量 URL 必须带显式用户（postgres://postgres@…；三登录角色随机口令、0600 env、用后删、不打印）。
- typecheck 与 biome（触及文件存量比对披露）。

## 交付物（未提交检查点）

reports/MT007.md + checkpoints/MT007/（sha256-manifest.txt、changes.diff、before/after-hashes、red-green/、mutation/、verification/）。全量 0-skip 证据。完成后 worker_done --outcome succeeded|failed 附 --report-path。无提交/推送/合并/生产迁移/部署授权。
