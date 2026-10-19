<!-- openbot-plugin-packages:PKG09:v1 -->
## Parent

https://github.com/1123786563/OpenBot/issues/459

## What to build

包调用在人工审批、定时执行或责任任务恢复后仍使用原 Run 的范围与版本；缺受管 Run 的入口明确拒绝，不能绕过包检查。

## Scope boundary

HTTP/内部回调、审批恢复、schedule/responsibility、memory ingestion 的包上下文传递和支持矩阵。

## Acceptance criteria

- [ ] tools、直接 call、内部 call、approval resume、schedule/responsibility、memory ingestion 每个实际入口均有正向或明确拒绝证据。
- [ ] 已有受管 Run 的后台入口重建可信 Scope，不能信任反序列化的客户端 scope。
- [ ] 审批期间改参数/账号/连接 generation、切团队或撤权后旧提案拒绝；不得复用旧 dispatch permit。
- [ ] 无受管 Run 的入口返回 PACKAGE_RUN_REQUIRED；缺逻辑私有 Bot 实际范围解析返回 PACKAGE_BOT_SCOPE_UNAVAILABLE。
- [ ] 未携带包上下文不能执行包来源资源；legacy 只在其原有合同下工作，无包→legacy 降级。
- [ ] 外部黑盒 Bot 没有受管回调时显示 unsupported；取消/重试不重置 operation identity 以绕过检查。

## Blocked by

- https://github.com/1123786563/OpenBot/issues/464

GitHub 同步建立正式 blocked-by；本节保留可读备份。前置状态关闭也须核验其交付已审查并集成，不能用假桩代替。

## Verification

逐入口 transport spy/真实 API 检查及受管后台/审批恢复集成测试，证据必须点名每个入口。

新增套件按 ADR 0008 分为 native 或 Bun-driven，由 tester-army e2e 统一调度/报告；targeted Bun 可定位行为，但不能代替统一入口证据。E2E_BUN_ONLY 按真实 group.name 筛选；真实角色/测试库缺失须标 blocked，不能将 skipped 或零测试当通过。

## Handoff

- source_issues：父 Issue 完整方案快照；本票覆盖 A02, A05, A07, A12。
- consumes：PKG05 受管包工具执行；现有 Run lease/attempt、审批和可信后台身份重建。
- produces：逐入口支持/拒绝清单；从持久化 Run 恢复的服务端包上下文；一致的拒绝码。
- owned_scope：HTTP/内部回调、审批恢复、schedule/responsibility、memory ingestion 的包上下文传递和支持矩阵。 不修改其他业务领域的权威数据或既有 Issue 范围。
- owner_role：主控拆 Task；后端归 backend_implementer，前端归 frontend_implementer，按稳定接口串行；验证对应 backend_validator/frontend_validator；独立 reviewer 给 Spec 与质量结论。
- 详细实现映射：本地实施计划 T6, T7；该计划按技术 Task 编排，本票按完整业务结果验收。执行前读取父方案并生成本票自己的单个 Task Brief。
- checkpoint：记录执行工作区、BASE/HEAD、已审查提交或未提交快照哈希、实际测试输出与 Review/OCR 轮次。
- resume_hint：先读 Ledger/Git/前置接口，仅恢复未 verified 的 Task；不要重做已有连接器安装系统。
- 约束：包不是授权；成员、Bot、账号、范围和动作分别检查；不能回退其他范围/账号或 legacy；不得保存 token 到包配置、日志、预览或模型。
- 本票的发布和 ready-for-agent 标签不是代码提交、推送、合并、生产执行授权；用户尚未要求开始实施。
