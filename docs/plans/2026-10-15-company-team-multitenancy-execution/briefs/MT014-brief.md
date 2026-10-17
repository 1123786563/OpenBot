# MT014 / Issue #57 实现 Brief — coordinator 下发

你是 MT014 的实现者（backend_implementer）。RED→GREEN→REFACTOR；票据正文优先；未提交检查点；无提交/推送/合并/生产迁移/部署授权。

## 任务（#57，Epic #190）

模型配置、Bot 默认、线程标识、凭据引用与套餐映射按公司/团队解析，而不是启动时装配一份全局配置；部署级基础设施（连接池、模板、密钥）继续共享。

## 验收（见票据 #57 正文 Acceptance criteria 全文——领取时从 github-intake.json 或票据读取并逐条映射）。

Verification：`bun test server/tests/multitenancy/runtime-config.test.ts`（新建，真实 PostgreSQL）。

## 前置契约（同 MT009 brief：32 项哈希复算；MT013 启动校验在 index.ts 启动段——你的运行配置装配必须与之共存）

- 重点前置：MT013（config.ts 开关 + startup-checks——多租户开关 on/off 与运行配置解析的交互要在测试中体现）、MT006（workspace 路由装配）、MT012（RLS/角色兜底——按公司解析配置的读取路径应经受限角色）。
- 部署级共享面（连接池/模板/密钥）不迁移——只把「按租户解析」的部分改走公司/团队维度。

## 可写文件

- 新建：`server/src/enterprise/tenancy/runtime-config.ts`（或按实现微调命名并报告说明）、`server/tests/multitenancy/runtime-config.test.ts`、support 夹具。
- 扩展（最小编辑 + 披露）：config.ts（如需新配置段——纯追加，不动 MT013 开关段）、index.ts（装配段纯追加，不动 MT013 启动段/MT006 路由段）。
- **不得改**：resource-policy/visibility/store/scope-gate/workspace-admin/revocation/startup-checks/enterprise-tenancy schema（迁移经 migrate-test 任务）。
- 如需迁移：migrate-test.ts（MT014 任务）+ migration-tool.test.ts 窄例外（第 4 次先例）。

## 基线与环境

- 全量基线 **305/0/0skip** → 完成 305+新用例。
- 专用库端口 **55481**（容器 mt014-impl-pg），其余同前（迁移前置按依赖序全 apply：MT004→MT008→MT112→MT012）。

## 交付物

reports/MT014.md + checkpoints/MT014/ 全套。完成 worker_done 附 --report-path。
