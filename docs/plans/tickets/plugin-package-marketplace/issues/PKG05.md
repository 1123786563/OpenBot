<!-- openbot-plugin-packages:PKG05:v1 -->
## Parent

https://github.com/1123786563/OpenBot/issues/459

## What to build

用户为包选择自己在原范围授权的账号，Bot 只调用明确授予的受管工具；连接或权限失效会阻断下一次派发。

## Scope boundary

包资源到已有 connector install 的引用、当前 actor 连接解析、工具 grant/pin、同步 Run 的受管派发与就绪 UI。

## Acceptance criteria

- [ ] 包只引用已有受管 connector key，清单 URL/stdio 命令/任意 token 不能成为执行配置；Google 保持 OpenConnector 合同。
- [ ] V1 只用当前调用者本人在原范围的账号；发布者、管理员、他人或另一团队账号不得借用。
- [ ] grant 精确到资源/工具，schema digest 和 effect 与受管目录一致；Skill 声明不授予工具。
- [ ] 每次调用重验 scope、Bot、Run/attempt、pin、grant、连接 generation、策略和审批，不与 legacy grant OR 放行。
- [ ] 只有 dispatched CAS 成功后可交给 transport；撤权/停用若先完成，网络调用次数为 0。
- [ ] 已 dispatched 的结果保留成功/失败/unknown 事实；写超时或派发后崩溃不得自动重发。
- [ ] 连接需求、账号选择、授权工具及失败原因可在界面检查；秘密不进入目录/预览/日志/模型。
- [ ] #75 前置未验证并集成时保持 blocked，不在本票重做通用连接治理。

## Blocked by

- https://github.com/1123786563/OpenBot/issues/462
- https://github.com/1123786563/OpenBot/issues/75

GitHub 同步建立正式 blocked-by；本节保留可读备份。前置状态关闭也须核验其交付已审查并集成，不能用假桩代替。

## Verification

用真实受限数据库和可控 transport 观察放行/拒绝次数，并对受支持连接执行真实账号 smoke；完成授权→调用→断连→下一次拒绝演示。

新增套件按 ADR 0008 分为 native 或 Bun-driven，由 tester-army e2e 统一调度/报告；targeted Bun 可定位行为，但不能代替统一入口证据。E2E_BUN_ONLY 按真实 group.name 筛选；真实角色/测试库缺失须标 blocked，不能将 skipped 或零测试当通过。

## Handoff

- source_issues：父 Issue 完整方案快照；本票覆盖 A02, A04, A05, A07。
- consumes：PKG03 的范围授权与 Run pin；#75 的当前用户连接/Bot 授权实时重验；已有 MCP/OpenConnector/Composio、ActionPolicy 和审批。
- produces：TrustedManagedAccess、包工具绑定、package dispatch operation/argsDigest/connection generation 与既有工具回执关联。
- owned_scope：包资源到已有 connector install 的引用、当前 actor 连接解析、工具 grant/pin、同步 Run 的受管派发与就绪 UI。 不修改其他业务领域的权威数据或既有 Issue 范围。
- owner_role：主控拆 Task；后端归 backend_implementer，前端归 frontend_implementer，按稳定接口串行；验证对应 backend_validator/frontend_validator；独立 reviewer 给 Spec 与质量结论。
- 详细实现映射：本地实施计划 T5, T6, T7, T8；该计划按技术 Task 编排，本票按完整业务结果验收。执行前读取父方案并生成本票自己的单个 Task Brief。
- checkpoint：记录执行工作区、BASE/HEAD、已审查提交或未提交快照哈希、实际测试输出与 Review/OCR 轮次。
- resume_hint：先读 Ledger/Git/前置接口，仅恢复未 verified 的 Task；不要重做已有连接器安装系统。
- 约束：包不是授权；成员、Bot、账号、范围和动作分别检查；不能回退其他范围/账号或 legacy；不得保存 token 到包配置、日志、预览或模型。
- 本票的发布和 ready-for-agent 标签不是代码提交、推送、合并、生产执行授权；用户尚未要求开始实施。
