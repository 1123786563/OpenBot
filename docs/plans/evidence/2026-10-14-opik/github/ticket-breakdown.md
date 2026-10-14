# Opik vertical ticket breakdown

Status: SUPERSEDED — never published. The user asked for finer granularity (one code-agent context per ticket), so this 10-ticket breakdown was re-cut into 37 tickets in `ticket-breakdown-v2.md`, published as GitHub #7–#43 on 2026-10-15. Kept for history only.

Parent Spec: https://github.com/1123786563/OpenBot/issues/4

1. **管理员验证 Opik 自托管连接与采集健康**
   - Blocked by: None
   - Delivers: 管理员在 OpenBot 中确认自托管 Opik 的连接与合成采集结果，并准确区分未启用和故障；包含可选部署、兼容锁定、受保护入口及最小可信范围装配。

2. **创建者查看受授权的安全运行记录**
   - Blocked by: 1
   - Delivers: 创建者完成工作台对话后，在自己的 Bot 页面查看运行列表和安全详情；覆盖可信归属、真实流生命周期、脱敏、分页与权限变化，远程路径明确显示基础能力。

3. **定位内置与 LangGraph 的模型、工具和检索步骤**
   - Blocked by: 2
   - Delivers: 创建者在既有运行详情中定位内置执行与默认 LangGraph 的模型调用、可信工具执行和检索步骤，并关联跨服务过程。

4. **从安全案例保存不可变评测集版本**
   - Blocked by: 2
   - Delivers: 创建者从可用脱敏运行或审查后的合成案例建立评测集，在页面检查输入、参考结果与工具 fixture 后保存并查看冻结版本。

5. **运行隔离评测并查看规则评分**
   - Blocked by: 4
   - Delivers: 创建者选择冻结数据集及 Bot 配置提交独立评测，查看逐样本规则评分、运行结果、失败和取消，并关联安全执行记录。

6. **使用受预算控制的模型 Judge 评分**
   - Blocked by: 5
   - Delivers: 创建者在既有评测流程选择批准的模型评分器，查看基于参考答案或业务 rubric 的评分和理由，Judge 遵守部署预算及访问范围。

7. **比较版本并定位退化样本**
   - Blocked by: 5
   - Delivers: 创建者比较两次实验的配置、有效样本、分数及退化案例，并回到相关安全执行详情。

8. **管理员按管理范围汇总并排查采集故障**
   - Blocked by: 5
   - Delivers: 管理员在后台汇总 Bot 运行和评测，筛选故障、丢弃和未绑定记录，区分业务失败、采集不可用及尚未具备的能力。

9. **导出安全运行与评测报告并即时撤销下载资格**
   - Blocked by: 5
   - Delivers: 有权用户从 OpenBot 请求运行/实验的机器可读导出，查看导出状态，并在每次下载时重新校验当前权限。

10. **按保留期和删除请求清理真实 Opik 数据**
   - Blocked by: 9
   - Delivers: 管理员落实 7 天追踪和 30 天评测保留策略，创建者删除有权管理的评测集；页面显示真实清理状态，数据最终从上游及导出存储移除。

Rule evaluation and comparison do not wait for the Judge. Dataset/evaluation work does not wait for detailed runtime steps. Enterprise tenancy and Bifrost designs are not artificial blockers for the current workbench scope. Shared state remains integrated serially.

After approval, draft numbers become real GitHub links and native relationships. The parent carries aggregate acceptance without body/status changes. The earlier 13 implementation Tasks remain a draft and must be reconciled with the approved ticket graph rather than published one-for-one.
