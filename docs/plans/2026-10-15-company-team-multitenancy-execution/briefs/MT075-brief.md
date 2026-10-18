# MT075 / Issue #118 实现 Brief — coordinator 下发

你是 MT075 的实现者（backend_implementer）。RED→GREEN→REFACTOR；票据正文优先；未提交检查点；无提交/推送/合并/生产迁移/部署授权。

## 任务（#118，Epic #201 治理组前置）

平台级管理（部署配置、平台静态能力、全局身份审计）与公司/团队管理动作分开授权；公司管理员不能修改平台策略，平台操作身份也不能借此读取公司业务内容。

## 验收（四条）

1. 公司管理员调用平台级管理入口被拒绝；平台身份调用公司管理入口需显式授权并留审计。
2. 每个管理入口都被分类为平台级或公司/团队级（清单可核对）。
3. 管理动作不隐含业务内容读取权（有专门越权测试）。
4. 分类结果回写 MT001 清单。

Verification：`bun test server/tests/multitenancy/admin-separation.test.ts`（新建，真实 PostgreSQL）。

## 前置契约（领取时复算 prereq-manifest 34 项哈希）

- 前置 = MT001-008 + MT012 + MT013 + MT007 全部 verified 集合。重点：
  - MT006 workspace-admin.ts + MT007 修复后扩展（restore/suspendCompanyMember + 审计 + revocation.ts 六 checkpoint——公司/团队管理动作的现有实现与审计通道，复用勿重造）
  - MT013 启动校验（平台身份/机器读角色 ob_ent_identity_operator 已在 RLS/角色面单独登记——MT012 交付；管理面分类与之对齐）
  - MT001 清单（archive/plans/multitenancy-execution/reports/MT001.md 与其检查点——分类回写目标）
- 报告在 archive/plans/multitenancy-execution/reports/。

## 可写文件

- 新建：`server/src/enterprise/tenancy/admin-separation.ts`（入口分类 + 授权判定）、`server/tests/multitenancy/admin-separation.test.ts`、support 夹具。
- 扩展（最小 + 披露）：MT001 清单文件（分类回写）；workspace-admin.ts 或路由层如需接入分类检查（纯追加/最小编辑，报告逐处披露）；index.ts 装配纯追加。
- **不得改**：resource-policy/visibility、store.ts、scope-gate.ts、startup-checks.ts、revocation.ts（只读消费其 checkpoint/审计通道；若需 seam 扩展升级问 coordinator）、enterprise-tenancy schema（经迁移任务）。
- 如需迁移：migrate-test.ts（MT075 任务）+ migration-tool.test.ts 窄例外（第 4 次先例形态）。

## 基线与环境

- 全量基线 **334/0/0skip**（12 文件）。完成后期望 334+新用例。
- 专用库端口 **55483**（容器 mt075-impl-pg，pgvector/pgvector:pg16，trust，psql 探针就绪）；迁移前置按依赖序 apply 全部任务 **MT004→MT008→MT112→MT012**（顺序不可乱）；五变量 URL 显式用户 + 随机口令 0600 env 用后删。
- typecheck + biome 触及文件（新增 0 告警，存量披露对照）。

## 交付物

archive/plans/multitenancy-execution/reports/MT075.md + archive/plans/multitenancy-execution/checkpoints/MT075/（全套）+ 分类清单（回写 MT001 的 diff 与哈希）。完成 worker_done 附 --report-path。
