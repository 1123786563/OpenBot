# 模块架构工作规则

新增 Module、调整公开 Interface、增加跨 Module 调用、移动业务目录或更换 Adapter 时读取。

## 阅读入口

先读[模块化架构详细设计](../../docs/specs/2026-10-23-modular-architecture-design.md)的状态、事实源和架构决定，再按本次改动读取：

| 改动 | 必需参考 |
| --- | --- |
| 选择归属、调整数据写入或依赖 | [模块目录](../../docs/plans/modular-architecture/module-catalog.md)中的所属 Module 与直接依赖 |
| 定义/修改调用方式、错误、幂等或能力 | [Interface 合同](../../docs/plans/modular-architecture/interface-contracts.md)中的对应合同 |
| 修改聊天、恢复、模型、工具、预览或后台链路 | [运行链路](../../docs/plans/modular-architecture/runtime-flows.md)中的对应流程 |
| 开始架构迁移或验证迁移结果 | [迁移方案](../../docs/plans/modular-architecture/migration-plan.md)中的任务与验收 |

该架构方向已获认可；详细合同是设计稿。采用前核对批准 Spec/ADR、当前 Git 与任务授权；图中的目标文件和 Interface 不表示当前代码已实现。候选 BA 与 Personal Space 需求按各自批准门槛处理。

## 改动步骤

1. 确定本次业务事实的唯一所有者，列调用者、读写表和外部动作。完成标准：每项状态写入归到一个 Module 或明确的受控事务组合。
2. 记录消费/产出 Interface，包括范围、错误、幂等、事务与失败语义。完成标准：调用方无需了解供应商协议或复刻所属 Module 的业务规则。
3. 区分当前兼容行为和目标行为，核对直接依赖。完成标准：目标 import 不成环，已有例外具名且有迁移出口；涉及改变产品行为时有对应批准依据。
4. 按既有任务流程实施和验证。完成标准：对应架构验收有匹配当前代码的证据，实际消费者迁移完整，秘密与可信能力未进入公共 wire。
5. 同步受影响的唯一架构定义及其链接。完成标准：Module 归属、Interface、运行链路和任务计划相互一致；运行报告仍归 `.archive/`。

不要从本规则推导新的实施、提交或发布授权。Issue 实施流程继续使用 execution/issue-delivery/review 规范，架构文档不另起一套编排器。
