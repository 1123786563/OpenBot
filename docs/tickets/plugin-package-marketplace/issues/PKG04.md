<!-- openbot-plugin-packages:PKG04:v1 -->
## Parent

https://github.com/1123786563/OpenBot/issues/459

## What to build

管理员从已安装包的专家模板创建自己的范围内专家，重复确认返回同一个 Bot，创建后的专家只持有明确授予的 Skill。

## Scope boundary

模板校验、受限 built_in 创建、企业 ownership、模板来源、初始 Skill grant 与创建向导。

## Acceptance criteria

- [ ] 模板只接受约定的名称/说明/systemPrompt/包内 Skill 引用；endpoint/auth 及远端运行配置拒绝。
- [ ] 创建强制 built_in，不受部署 managedConfiguration 改写；创建者和归属由服务器确定。
- [ ] profile、ownership、来源和初始 Skill grant 同事务提交；中途故障全部回滚，无幽灵 Bot。
- [ ] actor+幂等键重复提交只返回原 agentId；同键异输入拒绝。
- [ ] 固定受限创建函数只有 operator 可 EXECUTE，PUBLIC 无权限；伪造范围/actor、非管理员和跨范围输入拒绝。
- [ ] 创建不自动授予 connector 工具、不自动连接账号或发布团队公共 Bot。
- [ ] 用户之后编辑 Bot 或私人 Skill不被包升级/卸载覆盖；创建来源仍可追踪。

## Blocked by

- https://github.com/1123786563/OpenBot/issues/462

GitHub 同步建立正式 blocked-by；本节保留可读备份。前置状态关闭也须核验其交付已审查并集成，不能用假桩代替。

## Verification

真实角色事务故障注入与重复创建测试，浏览器从模板创建→打开 Bot→使用已有 Skill 演示。

新增套件按 ADR 0008 分为 native 或 Bun-driven，由 tester-army e2e 统一调度/报告；targeted Bun 可定位行为，但不能代替统一入口证据。E2E_BUN_ONLY 按真实 group.name 筛选；真实角色/测试库缺失须标 blocked，不能将 skipped 或零测试当通过。

## Handoff

- source_issues：父 Issue 完整方案快照；本票覆盖 A08, A10。
- consumes：PKG03 的范围 Skill grant 和运行 pin；现有 AgentProfile/BotOwnership/ExpertVersion 权威接口。
- produces：instantiateExpert 与原子 profile+ownership+来源+Skill grant；可继续对话的 agentId。
- owned_scope：模板校验、受限 built_in 创建、企业 ownership、模板来源、初始 Skill grant 与创建向导。 不修改其他业务领域的权威数据或既有 Issue 范围。
- owner_role：主控拆 Task；后端归 backend_implementer，前端归 frontend_implementer，按稳定接口串行；验证对应 backend_validator/frontend_validator；独立 reviewer 给 Spec 与质量结论。
- 详细实现映射：本地实施计划 T3, T7, T8；该计划按技术 Task 编排，本票按完整业务结果验收。执行前读取父方案并生成本票自己的单个 Task Brief。
- checkpoint：记录执行工作区、BASE/HEAD、已审查提交或未提交快照哈希、实际测试输出与 Review/OCR 轮次。
- resume_hint：先读 Ledger/Git/前置接口，仅恢复未 verified 的 Task；不要重做已有连接器安装系统。
- 约束：包不是授权；成员、Bot、账号、范围和动作分别检查；不能回退其他范围/账号或 legacy；不得保存 token 到包配置、日志、预览或模型。
- 本票的发布和 ready-for-agent 标签不是代码提交、推送、合并、生产执行授权；用户尚未要求开始实施。
