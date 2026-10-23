# Module 目录、数据所有权与依赖

本文从[架构主文档](../../specs/2026-10-23-modular-architecture-design.md)进入，继承其设计稿状态。以下为目标职责与允许依赖，不是当前代码已满足的声明。

## 1. 依赖规则

表中 ID 仅用于架构定位，不新增产品领域术语。例如 `M05 → M04` 表示 RunLifecycle 的实现可引用 Conversation 的公开 Interface；共同基础设施依赖不列入表。普通 HTTP、客户端和业务调用方不读取对方 store/integration 文件。

| ID | Module | 允许依赖的核心 Module |
| --- | --- | --- |
| M01 | IdentityDirectory | 无 |
| M02 | Access | M01 |
| M03 | BotCatalog | M02 |
| M04 | Conversation | M02 |
| M05 | RunLifecycle | M02, M03, M04, M06, M08, M09, M10, M12 |
| M06 | ModelAccess | M02, M07 |
| M07 | Billing | M02 |
| M08 | ToolAccess | M02, M07, M09 |
| M09 | ExecutionEnvironment | M02 |
| M10 | PersonalMemory | M02, M06, M08 |
| M11 | Observability | M02, M03, M05, M06 |
| M12 | PackageLifecycle | M02, M03, M08 |

此表是静态依赖上限，非每个 Module 都必须 import 全部依赖。M05 不静态引用 M11；内部 observer 由装配注入。M06 不静态引用 M05；Run 预算协作者通过 M06 消费的内部合同注入。M01 不静态引用 M02；身份/目录写与授权版本变化由受控事务组合协调。这样可消除当前按目录看到的循环，而不复制业务事实。

允许不同 Module 共同使用数据库连接、时钟、加密、日志与传输库；这些技术能力不决定付款、权限和业务终态。业务类型归所有者 Interface，跨宿主 DTO 才进入 shared。`integration.ts` 只允许 assembly 与明确登记的内部 Adapter 消费。

## 2. M01 IdentityDirectory

- 当前入口：`server/src/auth/`、`identity/`、`people/`、`enterprise/tenancy/` 内目录实现。
- 对外用例：认证/注销、当前身份、本人资格发现、目录命令、邀请生命周期、身份禁用与恢复。登录不要求先有公司资格；业务动作另行准入。
- 内部实现：Better Auth、SSO/SCIM、issuer/subject 映射、邮件/回调处理，以及候选迁移期的单权威目录 Adapter。
- 当前数据映射：core 中 users/accounts/sessions/verifications/user_roles；identity_links/challenges；企业 Principal、Tenant、Workspace 与成员目录。未来 BA schema 写权随获批迁移相位切换，不双写两套目录。
- 输出稳定身份/成员事实，不输出“此人可读所有公司内容”的推论。active organization/team 是选择状态。
- 验证面：错误账号/回调重放、单次邀请接受、停用 session、撤销与恢复不复活旧能力。BA 新合同按 #503/G0 获批范围实施。

## 3. M02 Access

- 当前入口：`enterprise/authz/`、`tenancy/store.ts`、`scope-gate.ts`、`revocation.ts` 及资源/共享判定。
- 对外用例：解析可信业务上下文、核验指定对象动作、按当前合同重验、受控授权变更。
- 拥有：资源登记和授权事实、来源限制、业务授权版本。消费 M01 的当前身份与成员状态；不维护第二份可独立管理的成员目录。
- 数据映射：enterprise_resources/resource_grants、personal-shares 中资源分享、业务 governance policy。财务 Grant 的业务定义归 Billing，Access 执行其声明的动作判定；表的具体写入方法归 Billing，不能另开通用 Grant SQL 后门。
- 对象归属由资源 Module 的只读归属 Adapter 提供；Access 内部只接收必要事实，不 import 各业务 store。装配注入这些 Adapter，读取仍受同事务/快照合同约束；事实读取不递归进入同一授权用例，不触发业务写入。
- 验证面：选择器伪造、同团队私有对象拒绝、撤权后的新动作拒绝、来源资格丢失、跨父对象访问拒绝。

## 4. M03 BotCatalog

- 当前入口：`agents/`、`team-bots/`、`enterprise/experts/`。
- 拥有：逻辑 Bot、档案字段归属、Bot 生命周期/可用性、专家固定版本、团队发布关系。
- 数据映射：agents、agent_profiles/preferences、bot_lifecycle、enterprise_bot_ownership/preferences、enterprise_expert_versions、enterprise_personal_bots/field_ownership、team_bot_*。
- 对外用例：创建/解析 Bot、读取固定专家版本、发布与撤回。包创建 Bot 调用该 Interface，并保留幂等安装来源。
- 引擎实例、浏览器登录态、每轮预算和连接密钥分别归 M05/M09/M07/M08。
- 验证面：同逻辑 Bot 不同范围无可变状态串用；发布撤回不删除用户历史资产；版本固定不被模板更新改写。

## 5. M04 Conversation

- 当前入口：`channels/`、`enterprise/conversations/`、`mastra/conversations.ts`、`conversation-runtime.ts`、消息 parts/intent。
- 拥有：会话和 Channel 的归属、参与关系、消息单写者、稳定顺序、完整消息与附件引用、历史读写协议。
- 数据映射：channels/channel_memberships/channel_agents/attachments、enterprise_conversations/messages/message_parts、group 消息/线程映射、mastra_message_intents/attachments。
- Mastra 存储编解码与 registry 访问是内部 Adapter；Conversation 不向普通调用方暴露 resolveMastraBinding。现有方法先保留兼容，再迁移调用者。
- 附件元数据和使用授权归 Conversation；实际字节归文件或存储 Module，读取必须验证资源当前权限。不能因拥有 attachment ID 就任意读字节。
- 验证面：重复消息仅一份、history 与模型读取一致、失败 intent 不伪装完成、tool-call/result 与附件保真、未授权历史不可见。

## 6. M05 RunLifecycle

- 当前入口：`enterprise/runs/`、`mastra/continuation-*`、runner/resume-driver/headless，以及入口散落的运行编排。
- 拥有：Run/Attempt、租约与 generation、运行事件、固定发起事实、运行 token 上限和逐调用 capability、等待/恢复记录。
- 数据映射：enterprise_runs/run_attempts/model_budget_reservations/model_invocation_capabilities/run_outbox/runner_events、mastra_execution_continuations/receipts。
- 公共用例仅为启动、取消/停止、提交等待回应、读取状态和事件。领取、续约、complete/fail、capability issue 等进入内部 worker/engine Interface，不向浏览器开放。
- 消费 Conversation 的单写者；消费 PackageLifecycle 的固定版本；引擎只执行已准入事实。总 token 使用确认与 Billing 的资金结算分别持久化。
- 验证面：旧 generation 无法写新 Attempt、恢复不换 Scope/Payer、不重复执行已确认副作用、终态与业务证据一致。

## 7. M06 ModelAccess

- 当前入口：`gateway/`、`bot-services/`、`enterprise/models/`、governed model 组合中的模型接入部分。
- 拥有：模型开放范围、偏好、能力目录、价格/上限证据、Registered Bot 服务身份、Bot 用户绑定、Model Access Grant 与 Virtual Key。
- 数据映射：gateway_*、bot_services、bot_binding_offers、access_grants、enterprise_model_routes。字段含义依当前 schema；不因统一目录就合并不同授权概念。
- 内部 Adapter：Bifrost 管理/dispatch、受支持模型协议与内置 SDK 模型包装。供应商 credential 通过受限秘密读取 Adapter 获取，授权用途限服务器解析的模型路由。
- M05 的 token 预算协作者由装配注入；本 Module 不写 enterprise_run_* 表。资金由 M07 预留/结算；可用模型必须同时满足授权、能力、可定价和可强制限额合同。
- 验证面：免费模型也检查身份资格，Key 过期/撤销、未知能力、异步结果、价格版本锁定、无费用证据不释放。

## 8. M07 Billing

- 当前入口：`billing/`、`billing/payments/`、付款范围解析与相关 protocol endpoint。
- 拥有：Payer 映射、财务 Grant、Credit Ledger、Reservation、实际 Settlement/尾差、异步费用状态、订单/收款事实/权益交付。
- 数据映射：billing_*、payer_accounts、credit_*、payment_*、async_*、realtime_*、batch_*、tool_call_charges、usage_outbox。若同名业务 job 不是计费 job，以完整表名/字段核验，不按通配符直接授权写入。
- 内部子 Module：积分账本；消费预留与结算；支付与权益；只读对账与证据化处置。使用同一账务事实，保持各自状态含义。
- 已发生费用可在成员撤销后按原付款依据结算；这不授予新调用资格。账务恢复用服务端原始协议事实，不依赖当前 UI 选择。
- 验证面：并发共享余额、重复 callback/ack、未知费用保留、个人与公司不互相兜底、收款成功但权益待交付可独立追踪。

## 9. M08 ToolAccess

- 当前入口：`plugins/`、`credentials.ts`、`passwords/`、`approvals/`、共享工具使用与凭据租约。
- 拥有：连接授权、工具目录/暴露、凭据存取、工具与 sign-in 审批决定、动作参数摘要、执行幂等与外部副作用 receipt。
- 数据映射：mcp_*/composio_connections/brokered_connections/plugin_grants、skills/skill_tools、credentials、saved_logins/sign_in_requests、approval_*、shared_use_*、enterprise_credential_*、enterprise_shared_use_*、enterprise_plugin_*。
- 内部子 Module：连接供应商 Adapter、凭据保管、动作批准与执行记录。所有秘密读取显式绑定用途和服务器确定的授权依据，模型凭据、工具 OAuth、人工 sign-in 不相互借用资格。
- 已学习 Skill 的候选/审核/归档权威归 Learning；这里拥有可调用目录和显式安装/暴露事实。PackageLifecycle 只保存安装版本与链接。
- 消费 M09 执行能力；有额外费用的工具消费 M07 的受管计费合同。未知外部效果保持待处置，不能靠新 runId 绕过幂等。
- 验证面：参数变化审批失效、重复批准只一次执行、凭据不进模型/日志、连接撤权阻断后续动作。

## 10. M09 ExecutionEnvironment

- 当前入口：`computer/`、`sandbox/`、`codesandbox/`、`host-access/`、scope 绑定与 execution surfaces。
- 拥有：环境定位、运行/环境代次、控制租约、范围绑定浏览器/代码工作区和远端传输。
- 数据映射：sandbox_instances、computer_snapshot/page_frame、相关 execution_capability_leases/host_access_grants；控制状态位于远端时保留其唯一写入宿主。
- 对外句柄按可信范围、Bot、目的、所需能力绑定，内部处理地址/token/headers。缓存至少包含合同要求的范围与环境代次，不能以 botId 作为唯一业务缓存键。
- 远端 agent-computer/agent-sandbox/supervisor 继续拥有当地执行实现；工具的业务审批和外部动作幂等归 M08。电脑 action policy 的当前协议在迁移时逐项分类，不能只移目录而停用检查。
- 验证面：#618 的 file/serve/event/snapshot 范围一致、旧租约拒绝、新环境不复用旧登录态、缺范围不发请求。

## 11. M10 PersonalMemory

- 当前入口：`memory/`、`hindsight/`、企业 personal-memory 与 OpenMuse 记忆适配。
- 拥有：候选、审核、更正、生效时间、来源、派生依据、暂停、授权召回、遗忘与清理状态。
- 数据映射：personal_memories/memory_sources、enterprise_personal_memories、generic_personal_preferences、source_bound_memories、derived_judgment_*、hindsight_*。
- openmuse_memories 先区分产品私有笔记与受治理个人记忆：通过明确 Adapter 接现有语义，不默认整表迁入、不因同名合并。
- Hindsight 索引/判断、同步和本地降级是内部实现；最终返回内容重新从 OpenBot 权威读取并核验。后台有成本调用经 M06，来源读取经 M08。
- 验证面：未审核不可召回、来源撤销即时阻断、故障降级仍检查权限、远端清理与停止使用分别展示。

## 12. M11 Observability

- 当前入口：`ai-observability/`、`telemetry/`、观测相关 shared DTO。
- 拥有：脱敏运行投影、关联 ID、案例/数据集不可变版本、评测实验与导出/保留期任务。
- 数据映射：ai_observation_*。业务审计表不因此转为本 Module 所有：安全审计使用既有审计写入 Module 的受控 writer，各业务命令负责提供真实审计事实与事务要求。
- 观察写入通过内部 sink/observer 接收，不让模型或客户端选择归属。受控评测消费 M06；运行查询只消费 M05/M03 公开只读 Interface。
- 验证面：禁用观测不影响普通运行；安全审计的强制失败规则不被降级；导出撤权、Judge 计费、隔离评测拒绝生产写工具。

## 13. M12 PackageLifecycle

- 当前入口：`plugin-packages/`、`enterprise/plugin-packages/`、`marketplace/` 的安装入口。
- 拥有：可信 manifest、不可变包 revision、安装计划与差异、资源链接、运行 pin、升级/回滚/停用/撤回。
- 数据映射：enterprise_package_*、enterprise_run_package_pins、expert_installs 的安装来源。Bot/工具实体仍由 M03/M08 创建；包只记录链接与固定版本。
- Learning/Skill 内容通过内部 SkillProvider 合同接入，不静态依赖整个可选学习实现。Run 使用本 Module 的 pin Interface，不由包管理 Run。
- 验证面：安装重复收敛、升级不改变在途 pin、卸载保留用户资产、安全撤回阻断新动作、外部效果未知不重复发送。

## 14. 扩展与横向事实

| Module/能力 | 所有者与调用约束 |
| --- | --- |
| Craft | craft_sessions/messages/snapshots/schedules 及其范围映射；使用 M05/M09，预览票据、Origin、TLS 为内部 Preview 子 Module。 |
| Workshop | workshop_* 及范围/沙箱绑定；使用运行和环境能力，保留业务计划/产物语义。 |
| OpenMuse 文件/任务/邮件/日历等 | 每个业务拥有自身对象与操作状态；BFF 聚合协议，依赖实际所有者和 Access；子模块内部遵守自己的规范。 |
| Automation | routines/responsibilities/proactive/delivery 与各自触发、投递和重试事实；work_items/job_ownership/job_leases 逐 job 类型登记，引用持久 Run，不自建执行循环。 |
| Learning | learning_*、enterprise_learning_* 与学习候选/审核/版本；可选 Intelligence Adapter；提供经验证 Skill 快照。 |
| Voice/Dictation | 媒体会话与客户端参与，使用受管模型/费用/资格；转写不会因“辅助功能”绕过准入。 |
| Audit/DB/配置 | 技术基础 Module 维护受控写入/迁移/配置解析；业务权限、归属和事实由对应所有者声明。 |

此目录是主表族映射，不是全库逐表验收清单。具体迁移开始前必须将该切片实际读取/写入的每张表、每个远端写入点映射到所有者；未映射对象不能默认为 shared 所有。
