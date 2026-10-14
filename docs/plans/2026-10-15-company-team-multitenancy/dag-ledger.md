# DAG、验收映射与执行 Ledger

日期2026-10-15。事实源为批准Spec/ADR/CONTEXT/Git与source-manifest。Root Issue：无，source_issues=[]；BASE `c0167c5cf33c441588fa20d3eb5a7e2ade789371`；workspace `/Users/wuyongjun/orca/workspaces/OpenBot/company-team-multitenancy`。执行授权门禁：计划待审阅，执行方法未选择，尚无生产代码执行。

## DAG与状态

所有依赖来自现有业务前置接口（不是父子包含关系）；数据库/文件共享补充排序依据见总计划。机器事实源为tasks.json；依赖校验通过后按拓扑串行。状态只用pending/ready/running/blocked/verified，本文当前全部pending。T01只有计划批准、方法选择及测试环境就绪后才ready。

| Task | Depends on | Owner / Validator | Acceptance | Status |
| --- | --- | --- | --- | --- |
| T01 全入口清单、隔离夹具与安全迁移工具 | 无 | backend_implementer / backend_validator | A6, A11 | pending |
| T02 公司/团队成员开通、选择与撤权 | T01 | backend_implementer / backend_validator | A1, A2, A3, A5, A6 | pending |
| T03 团队公共资源授权与旧接口作用域适配 | T02 | backend_implementer / backend_validator | A1, A2, A4, A5, A6 | pending |
| T04 公司运行配置与租户包装配 | T03 | backend_implementer / backend_validator | A1, A6, A8 | pending |
| T05 Bot 创建、发布、生命周期与专家安装 | T04 | backend_implementer / backend_validator | A1, A2, A3, A4, A8 | pending |
| T06 会话、群聊、历史线程与附件 | T05 | backend_implementer / backend_validator | A1, A2, A3, A4, A8 | pending |
| T07 登录、连接凭据、OAuth、SSO/SCIM | T04, T06 | backend_implementer / backend_validator | A1, A2, A5, A7, A8 | pending |
| T08 插件、技能、组件与共享账号审批 | T05, T07 | backend_implementer / backend_validator | A1, A2, A4, A5, A8 | pending |
| T09 知识、记忆、研究和学习 | T06, T08 | backend_implementer / backend_validator | A1, A2, A4, A8 | pending |
| T10 职责、计划、定时任务与主动执行 | T06, T08 | backend_implementer / backend_validator | A2, A5, A8 | pending |
| T11 电脑、沙箱、Agent 与 Runtime 执行隔离 | T05, T07, T08, T10 | backend_implementer / backend_validator | A1, A2, A5, A8 | pending |
| T12 Craft、Workshop、产物与分享 | T06, T08, T10, T11 | backend_implementer / backend_validator | A1, A2, A4, A5, A8 | pending |
| T13 OpenMuse 个人任务、文件、文档与个人域 | T06, T09, T10, T11, T12 | backend_implementer / backend_validator | A1, A2, A4, A5, A8 | pending |
| T14 OpenMuse 邮件日历、通知、操作与删除恢复 | T07, T08, T10, T13 | backend_implementer / backend_validator | A1, A2, A5, A7, A8 | pending |
| T15 公司钱包、团队用量与个人付款账户分离 | T04, T06, T10, T11, T13, T14 | backend_implementer / backend_validator | A7, A9, A12, A13 | pending |
| T16 公司/团队管理、路由政策与审计 | T02, T03, T04, T07, T08, T15 | backend_implementer / backend_validator | A1, A2, A5, A7, A9 | pending |
| T17 Web 公司/团队选择与统一请求缓存 | T02, T03, T04 | frontend_implementer / frontend_validator | A3, A6, A10 | pending |
| T18 Web Bot、会话、记忆与自动化工作流 | T05, T06, T07, T08, T09, T10, T17 | frontend_implementer / frontend_validator | A2, A3, A4, A10, A11 | pending |
| T19 Web 创作、管理、知识、插件与计费工作流 | T08, T09, T12, T15, T16, T17 | frontend_implementer / frontend_validator | A2, A4, A9, A10, A11, A13 | pending |
| T20 桌面原生组织上下文与凭据命名空间 | T07, T15 | backend_implementer / backend_validator | A7, A10, A13 | pending |
| T21 桌面公司连接、选择与本地状态隔离 | T07, T15, T17, T20 | frontend_implementer / frontend_validator | A3, A7, A10, A13 | pending |
| T22 Canonical OpenMuse Web/iOS/Android 选择与传输 | T13, T14, T15, T17 | frontend_implementer / frontend_validator | A2, A3, A7, A10, A11, A13 | pending |
| T23 日志、Trace、使用量与外部观测出口 | T11, T14, T15, T16 | backend_implementer / backend_validator | A1, A2, A8, A9, A13 | pending |
| T24 历史回填、跨库迁移与安全回退 | T05, T06, T07, T08, T09, T10, T11, T12, T13, T14, T15, T16, T23 | backend_implementer / backend_validator | A1, A2, A6, A12, A13 | pending |
| T25 主入口、Enterprise 与全客户端装配闭合 | T02, T03, T04, T05, T06, T07, T08, T09, T10, T11, T12, T13, T14, T15, T16, T23, T24 | backend_implementer / backend_validator | A1, A2, A5, A6, A8, A11 | pending |
| T26 全功能正向/越权验收、独立审查与统一上线证据 | T18, T19, T21, T22, T25, T20 | backend_implementer / backend_validator | A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13 | pending |

## 验收映射

| Acceptance | Tasks |
| --- | --- |
| A1 | T02, T03, T04, T05, T06, T07, T08, T09, T11, T12, T13, T14, T16, T23, T24, T25, T26 |
| A2 | T02, T03, T05, T06, T07, T08, T09, T10, T11, T12, T13, T14, T16, T18, T19, T22, T23, T24, T25, T26 |
| A3 | T02, T05, T06, T17, T18, T21, T22, T26 |
| A4 | T03, T05, T06, T08, T09, T12, T13, T18, T19, T26 |
| A5 | T02, T03, T07, T08, T10, T11, T12, T13, T14, T16, T25, T26 |
| A6 | T01, T02, T03, T04, T17, T24, T25, T26 |
| A7 | T07, T14, T15, T16, T20, T21, T22, T26 |
| A8 | T04, T05, T06, T07, T08, T09, T10, T11, T12, T13, T14, T23, T25, T26 |
| A9 | T15, T16, T19, T23, T26 |
| A10 | T17, T18, T19, T20, T21, T22, T26 |
| A11 | T01, T18, T19, T22, T25, T26 |
| A12 | T15, T24, T26 |
| A13 | T15, T19, T20, T21, T22, T23, T24, T26 |

所有R1–R7经批准Spec的A1–A13映射落到任务；全功能闭环由surface-inventory/T01运行清单绑定，T26汇总未覆盖条目阻断release。

## 恢复与报告字段

每个Task报告必须含：
- Brief、scope、owned_files、Consumed/Produced Interface、前置已集成检查点；
- 前后HEAD与完整范围快照、manifest hash、实际测试命令/退出码/关键skips及报告；
- Spec compliance/code quality结论、finding ID/ruling/修复轮次、实际agent_type/模型/推理等级；
- status、当前有效checkpoint ID、集成状态、validator/reviewer报告hash；
- 失败/环境阻塞及对验收影响，不把未知当通过。

恢复时先读此Ledger、tasks.json、Git及报告，不重派verified任务。基线本身未执行产品测试，不能误认成已通过。只在同一串行worktree集成后放行下游；跨worktree显式转移及hash核对。

## 初始记录

- 已批准书面设计与ADR，原目录状态已更新。
- Orca建立本工作区并固定BASE，setup hooks跳过（当前只规划）。
- 七份未提交必要文档已复制并hash核对；原tests/e2e/bot-chat.e2e.ts等其他会话改动未带入。
- 各节点尚未派发，没有commit、RED/GREEN、产品Review或OCR报告。最终发布授权未提供。

