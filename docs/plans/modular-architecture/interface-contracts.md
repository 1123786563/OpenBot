# Module Interface 合同

继承[架构主文档](../../specs/2026-10-23-modular-architecture-design.md)的状态。本文描述目标行为，不是可直接复制编译的 SDK。现有合同迁移前维持兼容；真实签名、版本和范围需在对应已授权任务中冻结。

## 1. 三种可见性

| 可见性 | 放置与消费者 | 可携带内容 |
| --- | --- | --- |
| 业务 Interface | 所属 Module 的 public.ts；其他业务 Module | 业务输入/结果、稳定错误、服务器上下文引用；不泄漏供应商对象。 |
| 内部集成 Interface | integration.ts 或内部 adapter 合同；assembly/指定 Adapter | 同事务参与方法、执行 lease、预算协作者、observer、秘密读取；不进入客户端 wire。 |
| Wire 合同 | 真实跨宿主 shared 合同；HTTP/SSE/远端消费者 | 可序列化 DTO、版本、公开 ID；Scope 选择字段仍是意图，不是可信授权。 |

Module 对外一份有归属的业务 Interface；内部合同不是新增一套业务入口。优先通过已有用例收拢行为，禁止把所有 store 方法原样 re-export 为 public。

## 2. 上下文、身份与错误

服务器上下文区分三种用途：本人身份动作、明确范围的业务动作、绑定既有事实的服务协议动作。调用方不能以缺 tenant/workspace 的对象冒充个人业务范围。当前 `PlatformScope` 继续使用现有校验；未来完整 Personal Space 需独立批准。

受信任值通过服务器签发与运行期验证建立；readonly、brand、`as` 和 JSON 字段都不能证明授权。对象解析后才生成对应能力，敏感动作消费时按合同重验。

每次跨 Module 调用应明确：

1. 谁发起、作用于哪个资源动作、使用哪些服务器持久事实。
2. 何时检查当前资格、是否需要锁/事务、撤权与在途动作如何排序。
3. 输入重复如何收敛，冲突参数如何拒绝，未知结果如何查询。
4. 返回结果是否表示持久接受、实际完成、挂起、仅生成提案或结果未知。
5. 取消、超时、重试、并发与外部不可用的可观察行为。

错误使用现有具名代码映射到稳定类别：无资格、资源不存在/不可见、输入不支持、冲突、额度不足、暂不可用、外部结果未知。HTTP Adapter 按现有 wire 映射，不能在本次内部重构统一改写所有响应码。秘密、原始上游响应和非本人可见归属不进入公开错误。

拒绝不会生成成功 receipt；超时不证明外部动作未发生。可重试类别与具体重试入口由所有者返回/定义，客户端不据通用 retryable 布尔值自动重放写动作。

## 3. 十二个 Interface 的最小业务面

下列方法名是候选能力名，不取代现有签名。Context 是服务器受信对象；对客户端的参数由 HTTP Adapter 转换。

| Module | 业务用例 | 关键返回与约束 |
| --- | --- | --- |
| IdentityDirectory | currentIdentity、discoverMemberships、executeDirectoryCommand | 返回稳定 ID/当前事实；命令含版本与幂等键，原子终结；外部邮件在持久 outbox/receipt 协议中处理。 |
| Access | resolveContext、authorizeAction、changeGrant | 将 selector/object/action 解析为当前动作资格；只授权核验过的目标，输出不能跨对象使用。 |
| BotCatalog | createBot、getVersion、publish、withdraw | 固定 Bot/版本/发布引用；创建不自动授予模型或工具资格。 |
| Conversation | getOrCreate、append、history、subscribe | 返回持久消息 ID/序号和完整内容；history 不返回未完成 intent；内部 engine append 不接受伪造作者。 |
| RunLifecycle | start、stop、respondToWait、get、events | start 返回持久运行接受结果；respond 不承诺工具成功；终态可区分业务失败、取消与挂起。 |
| ModelAccess | availableModels、authorizeBot、revokeGrant、invoke | 固定授权、模型/价格/上限；流包含真实终结与用量处理结果，模型输出结束不等于结算结束。 |
| Billing | reserve、settle、resolveReservation、purchase、statement | 返回同一 Payer 的预留/账务/订单引用；费用未知不自动释放；调整和退款单独授权。 |
| ToolAccess | availableTools、connect、prepareAction、decide、execute、receipt | 连接与动作引用固定范围/版本；执行前重验；receipt 区分成功、失败、未执行和未知。 |
| ExecutionEnvironment | bind、inspect、release、reset | 返回按范围和代次绑定的受限句柄；不向普通调用方暴露 token/任意代理地址。 |
| PersonalMemory | propose、review、correct、recall、forget、evidence | 返回候选/已确认内容及来源依据；召回结果必须当前有权；清理状态独立于遗忘立即生效。 |
| Observability | queryRuns、readTrace、saveDatasetVersion、evaluate、export | 查询使用当前资格；评测走受管模型并拒绝真实生产写动作；导出有撤权与保留期合同。 |
| PackageLifecycle | preview、install、changeVersion、disable、remove、pin | 固定包 revision/安装版本；更新不修改既有 pin，安装不授权未授予的连接。 |

## 4. 关键内部合同

### C01 身份/目录命令与授权版本

IdentityDirectory 命令核验操作者、目标、输入版本与幂等键。装配层的受控事务组合在同一连接内调用目录参与方法、Access 资格版本参与方法、强制审计和 outbox writer，全部成功才提交。

`DirectoryFactsReader` 只返回业务需要的当前身份/成员事实；读取不能因缓存而跳过撤权检查。原生 BA、SCIM、CLI、初始化和恢复入口均需接到批准的同一命令路径；目录写入入口的完整性以 #503 的实际覆盖清单为准。

同事务组合不能变成允许任意调用方传 SQL callback 的公开方法。具体 tx 类型为服务器内部集成细节，签发和模块参与方法在受控位置；迁移期间先封装现有 `WorkspaceGate.transaction`，不一次替换全部事务协议。

### C02 对象动作准入

资源所有者提供只读 `ResourceFacts` Adapter，含稳定根归属、版本和与动作有关的必要事实。Access 结合身份、成员、资源 Grant 与来源版本决定资格。对带外部副作用的动作，准入与 claim 按所属合同串行化，不能只在 HTTP 开始时检查一次。

下载、长流与租约使用遵守实际批准合同的检查粒度。内部“已验证”引用只证明其签发时事实，不自动保证未来有效；跨宿主必须消费现有服务认证/签名与在线检查协议，不能传 JSON 后 `as TrustedContext`。

### C03 Run 与执行 Adapter

从现有 `ExecutionBinding` / `ExecutionRequest` 整理内部执行合同，保留 scope、botId、runId、attemptId、generation、executionKey、threadId 的可信来源。外部入口不能填写这些权威字段。

执行 Adapter 消费：固定身份与版本、服务器重建历史、受管模型协作者、受管工具、经验证 Skill 快照、AbortSignal。产出：规范事件、待写完整消息、挂起事实、明确执行结果。执行 Adapter 不直接终结 Run 或另写账本；内部 driver 先核对持久证据后调用所有者转换状态。

Mastra snapshot、package fingerprint、engine run ID 保留在内部。保留现有兼容字段和 legacy 分支直到全部消费者按原迁移合同验收，不能只因新 Interface 更小就丢字段。

### C04 每次模型调用的双重预算

`InvocationBudget` 是 ModelAccess 消费、RunLifecycle 提供的内部协作者，核验当前 Run/Attempt/generation 与剩余 token 上限，签发/消费逐调用资格。ModelAccess 不 import Run store；装配把当前运行协作者注入执行请求。

Billing 独立根据服务器固定 Payer、模型价格版本和完整成本上限原子预留积分。两种预算都成功且 dispatch 的持久资格准备好，才允许发送 provider 请求。

凡现有批准合同要求一起原子写的 token/资金事实，使用同事务参与方法组合；跨 Bifrost 的协议则维持既有幂等预留/dispatch/settlement 协议。前一步完成后后一步失败必须留下可恢复状态；只有可证明未 dispatch 才补偿释放。不能在网络调用外面包长数据库事务。

内置受管调用和外部 Bot 个人 Key 路径共享 ModelAccess/Billing 准入语义；后者没有 OpenBot Run 时，仍检查个人模型授权、身份来源与 Payer，不能虚构 Run 来跳过检查。

### C05 Conversation 与消息存储

公开 Interface 使用完整消息模型和服务器消息引用。内部 `MessageStorage` Adapter 提供加载、按唯一 intent 写入和读取一致性证据；Mastra/保留 legacy 存储依现有合同接入，不预建无实际用途的新后端。

业务作者、thread、序号由 Conversation 控制；用户输入/engine 输出有不同受控入口。intent 与远端消息存储不能同事务时，先持久写意图，按唯一键执行并对账，只有可证完成才进入可见历史。模型不能读到不同于用户刷新所见的伪造历史。

### C06 审批、工具动作与运行等待

ToolAccess 保存 action/operation ID、规范参数摘要、连接/授权来源版本、目标、审批决定与副作用 receipt。RunLifecycle 保存 WaitRef、continuation revision、当前 Attempt/generation 和恢复 claim。

批准动作先核验原 action 与摘要；重复批准返回同一决定。恢复 driver 通过原 WaitRef claim 当前 continuation，并再次请求 ToolAccess 消费该决定。审批变更、参数变化、来源撤销或旧 generation 都不执行工具。外部供应商不提供幂等能力时，发出后超时进入 unknown；不承诺跨网络 exactly once。

审批持久化到恢复通知之间允许通过 outbox 重试；成功记录后通知丢失不得再执行一次工具。现有 receipt/claim 的最终校验集中在执行前，不由前端按钮禁用代替。

### C07 环境绑定与能力句柄

bind 的输入来自服务器解析的执行归属与允许能力，包含所需的公司/团队/Bot、实际资源/执行引用及代次；不把客户端 botId 视为足够归属。输出为目的受限的句柄，后续 file/serve/event/snapshot/browser 操作自动携带协议要求。

传输 Adapter 处理地址、token、scope headers、连接池和续约。句柄内部检查当前资格与代次，缓存键不能省略范围。环境复位使旧句柄失效；普通 inspect 不获得 reset/凭据披露权。

Craft Preview 的票据是定位与有限访问协议，不能绕过源会话、撤权、Origin/TLS 和主站 cookie 隔离合同。端口配置由部署装配统一解析，业务代码消费已验证配置。

### C08 包、Skill 与运行 pin

PackageLifecycle 预览产生不可变差异和 revision；安装/升级固定输入摘要。创建 Bot、安装/暴露工具或 Skill 时调用所属 Module 并保留来源链接，部分失败按安装操作记录恢复，不把半安装展示成功。

pin 在启动事务中按固定 installation/revision 写入，Run 仅引用结果。Learning 的可选 SkillProvider 返回经验证固定版本；关闭学习不伪造 learned Skill。停用/撤回后新敏感动作按相应合同重验，在途 pin 不被换成新内容。

### C09 观察、审计与评测

每个生产 Module 发布自己的受控观察，归属和关联 ID 来自可信运行事实；内部 observer 由 assembly 连接到 Observability。Opik/OTel SDK 不出现在普通业务 Interface。

纯观测可选和强制安全审计分别装配：前者按有界队列/丢弃策略故障隔离，后者按动作合同同事务或拒绝操作。评测调用通过 ModelAccess 保留实际费用；评测工具执行使用隔离 Adapter，不把生产凭据带入实验。

## 5. 幂等、版本与事务检查表

| 场景 | 幂等/固定依据 | 冲突与失败处理 |
| --- | --- | --- |
| 目录修改 | 操作者、目标、命令键、输入摘要与预期版本 | 同键不同输入拒绝；审计/版本/outbox 失败整体回滚。 |
| 消息与运行启动 | 持久客户端消息键、thread、输入摘要 | 重放返回原消息/Run；不同输入冲突；不再触发一次执行。 |
| 模型调用 | 原付款账户、调用 ID、价格/上限版本 | 重复 reserve/settle 收敛；未知 dispatch 留恢复记录。 |
| 工具审批/执行 | 原 operation、argsDigest、连接代次、receipt | 参数或授权变更拒绝；外部未知转待处置。 |
| continuation | 原 WaitRef、revision、Attempt/generation | CAS 只有一个驱动者；旧 claim 无写权。 |
| 支付 | 订单与独立渠道交易 ID | 重复/迟到收款仍记录真实交易，权益不重复发放。 |
| 包安装/升级 | 范围、安装请求键、包 revision、差异摘要 | 部分完成保留 operation；回滚不删除用户独立资产。 |
| 记忆同步/遗忘 | 权威记录版本、来源撤销版本、同步工作 ID | 旧同步不可复活遗忘，清理证据与停用分别保留。 |

同库跨 Module 的组合顺序必须复用当前锁层级；调整锁顺序需要独立设计和并发验证。所有者只写自己状态，不在公共 Interface 暴露任意 Database 或 transaction callback。内部参与方法由 assembly 的具名用例调用，保持业务不变量可验证。

## 6. 前端与跨宿主合同

前端每个领域的 query keys、mutation、DTO 转译和状态在现有 lib 目录内聚合。唯一范围选择协调 Module 维护当前选择代次，切换时终止旧流/清理范围缓存/拒绝迟到结果；后端仍独立授权。浏览器缓存既不签发 Scope，也不决定 Payer。

Desktop/Mobile 的登录回调与 BFF handle 依其现有/获批合同绑定原始意图。OpenMuse 原 Workspace DTO 与 OpenBot mobile workspace DTO 明确转译并校验版本，不通过强转伪装兼容。

Worker 消费持久 Run/Job 引用，领取/重试/恢复重新在线准入；AG-UI 客户端保持协议兼容。每个实际远端 Adapter 至少验证真实传输合同与有意义的测试 Adapter；没有真实变化或真实测试需求的 Seam 不预先抽象。
