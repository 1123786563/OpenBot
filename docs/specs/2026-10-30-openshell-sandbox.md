---
id: SPEC-OPENSHELL-SANDBOX
status: approved
version: 1
approved_by: 当前用户
approved_at: 2026-10-30
approved_revision: D1–D25需求共识；不含尚未验证的技术实现、参数默认值或实施授权
approved_content_sha256: 18a9a030d6420887a10e15cbee946353a0e67e119fa730ddc9eff0694cbf458c
approval_ref: '../plans/2026-10-30-openshell-sandbox/design.md#整体确认记录'
---

# OpenShell 沙箱底座需求

## Problem Statement

OpenBot 的 Kubernetes computer 已按 Bot 使用独立 Sandbox，编码环境仍在共享容器中按工作目录区分 Bot。用户希望两种执行环境都获得可验证的进程、文件和网络隔离，同时保留登录资料、代码、预览、审批和审计等现有体验。当前网络策略在无配置时可放行，更新异步下发；容量的磁盘计账也不是底层硬限制，因此不能直接宣称现有行为满足新安全目标。

## Solution

为 Kubernetes 部署新增统一的 OpenShell 底座选择。每个合法执行归属中的 Bot 按需获得 computer 和编码两个独立沙箱，分别管理权限、存储和生命周期。OpenBot 统一鉴权、审批、记录意图和核对结果；OpenShell 执行底层隔离与网络策略。所有用户服务入口经 OpenBot 验证。设计必须通过本文验收映射及真实故障注入后才可宣称具备相应保证。

## User Stories

1. As a 部署管理员, I want to choose OpenShell for a Kubernetes deployment, so that computer and coding workloads use the same selected substrate.
2. As a 部署管理员, I want to see the active isolation mode and its verified capabilities, so that I can understand the deployment's actual guarantees.
3. As a Bot 用户, I want my computer isolated from other Bots, so that their processes cannot read my browser profile.
4. As a Bot 用户, I want my coding environment isolated from other Bots, so that their code cannot read or change my workspace.
5. As a Bot 用户, I want coding tools separated from my browser environment, so that generated code cannot directly read saved sign-ins.
6. As a 团队成员, I want execution confined to the authorized team and Bot, so that a shared logical Bot identity cannot expose another scope's data.
7. As a Bot 用户, I want stopped environments to retain files and sign-ins, so that I can resume work after idle shutdown.
8. As a Bot 用户, I want to reset the computer or coding environment separately, so that clearing one does not erase the other.
9. As a Bot 用户, I want an active preview to stay available, so that reading a page does not unexpectedly stop its coding environment.
10. As a Bot 用户, I want an idle preview to stop without losing code, so that unused resources can be reclaimed.
11. As a Bot 用户, I want authorized file transfer between the two environments, so that an artifact can be used without sharing both filesystems.
12. As a Bot 用户, I want an explicit refusal when a file path or scope is unauthorized, so that transfer cannot silently cross boundaries.
13. As a Bot 用户, I want a request path for temporary network access, so that a task can reach an approved destination.
14. As a 部署管理员, I want to approve network expansion separately for the computer and coding environment, so that each receives only required access.
15. As a 部署管理员, I want temporary grants to end with the task or time limit, so that permissions do not linger.
16. As a 部署管理员, I want revocation to close existing connections, so that removing a grant stops ongoing access.
17. As a 部署管理员, I want isolation or policy failure to stop affected execution, so that unsafe fallback cannot proceed.
18. As a Bot 用户, I want computer, coding, event stream and preview access checked through OpenBot, so that a direct service URL cannot bypass my permissions.
19. As a Bot 用户, I want a capacity shortage to queue or fail clearly, so that my task is not placed in a shared or weaker environment.
20. As a 部署管理员, I want hard CPU, memory and storage limits, so that a workload cannot consume unbounded deployment resources.
21. As a 审计员, I want critical operation intent and outcome recorded, so that network grants, reset and file transfer can be reconstructed.
22. As a 安全运维人员, I want emergency stop and policy tightening to work during central audit failure, so that containment is not delayed.
23. As a Bot 用户, I want interrupted external actions with unknown outcomes to await reconciliation, so that a payment or submission is not duplicated.
24. As a 部署管理员, I want execution to stop after control-plane loss exceeds the configured bound, so that an outdated policy does not run indefinitely.
25. As a 部署管理员, I want recovery to recheck ownership, policy and grants, so that stale authority does not resume work.

## Implementation Decisions

- Preserve OpenBot as the authority for execution ownership, network grant intent, approval, audit and capacity admission; connect both workload types through the existing high-level service boundaries.
- Use one deployment-wide substrate selection and one OpenShell authorization workspace per authorized OpenBot team workspace. Represent each Bot's computer and coding workload as separate sandbox identities under the full execution scope.
- Keep the computer's established lifecycle contract and the coding service's authorized proxy contract as the primary integration seams. OpenShell driver calls, service forwarding, and identity mapping are adapter concerns; callers continue to address OpenBot services.
- Admit a workload only after isolation, effective policy and capacity have been established. A stopped sandbox retains disk state; reset removes only the chosen environment's state.
- Route all user-visible services through OpenBot authorization. Treat preview access as activity only when it reflects meaningful user interaction.
- Make network grants scoped, approved, time-bound where temporary, and report revocation only after effective-policy and established-connection checks.
- Keep control-plane management credentials in OpenBot's integration service, and apply independent execution expiry for control-plane loss.
- Resolve unknown external side effects before retry. Record critical operation intent before execution; preserve emergency containment when central audit is unavailable.

## Testing Decisions

- Test externally observable behavior at the OpenBot computer and coding service boundaries, preferably through one deployment-level integration harness for the selected substrate. Supplement it with a small number of driver contract tests for lifecycle generations, policy receipts and error translation.
- Reuse existing computer provider, computer sandbox, coding proxy, stream, preview and tenancy test patterns. The highest test seam should exercise authorized requests and actual denial/stop behavior rather than only mock a policy setter.
- Run selected Kubernetes, CNI, controller and storage combinations for isolation, persistent profile, SSE/WS/preview, network revocation, capacity and control-plane fault injection. Record which checks are simulated and which are real-cluster evidence.
- A good test proves an actor's allowed or refused outcome and the state left behind. It does not merely assert internal helper calls, static configuration text or the existence of an OpenShell API.

## 批准范围与来源

用户在 grill-with-docs 访谈逐项确认 D1–D25，随后对完整设计汇总回复「确认」，授权整理正式 Spec 和必要 ADR。上述指纹针对下文「已批准决定」中所有以 `- D` 开头的行，按 UTF-8、LF、末尾换行拼接。批准的是需求和边界，不代表技术能力已成立或授权代码实施、集群部署、提交和发布。

统一术语见根 [CONTEXT.md](../../CONTEXT.md)。架构取舍见 [ADR 0013](../adr/0013-openshell-sandbox-substrate.md)。[访谈记录与研究线索](../plans/2026-10-30-openshell-sandbox/design.md)保留逐项来源；冲突时以本 Spec 的批准范围为准。

本方案保留 [ADR 0006](../adr/0006-logical-private-bot-scoped-execution.md)中按实际业务范围解析执行环境的约束：每 Bot 两个沙箱指每个合法执行归属中的 Bot，而非全局 Bot ID 永久对应两台实例。同一逻辑私有 Bot 跨不同业务范围不得复用可变环境。本需求中的团队映射只确定底层分组，不恢复已作废的公司/团队旧 Spec 或批准新的成员目录设计；其他业务范围仍按其有效事实源判定，未批准的 Personal Space 不由本方案补充定义。

## 已批准决定

- D1：首要目标为增强 Bot 执行环境的隔离及出站网络约束，减少自研维护为第二目标；可以接受有明确安全收益的额外运维成本。
- D2：迁移范围同时覆盖 agent-computer 与 agent-sandbox 的沙箱底座。交付顺序、是否同时切换及现有数据迁移方式尚未决定。
- D3：第一阶段作为 Kubernetes 下的新增部署选择；不据此移除现有部署实现。
- D4：隔离能力不可用、网络策略未就绪或确认失效时，拒绝新任务，并阻止受影响沙箱继续执行；不静默降级。来源：用户回复「Q4 是」。具体检测与终止机制待核实。
- D5：OpenBot 是 Bot 网络权限的权威来源与变更授权入口，OpenShell 执行下发的约束。来源：用户回复「Q5 是」。策略同步、撤销和运维变更处置细节待定。
- D6：项目处于开发期，本次不要求已有 Bot 数据迁移及旧环境回退方案。来源：用户回复「Q6 不需要 正在开发」。此决定不免除新环境运行期间的持久化要求；不授权删除现有数据。
- D7：每个 Bot 的 computer 与编码环境使用两个独立沙箱，可分别授权网络权限、停止和重置；编码进程不可直接读取浏览器登录资料。来源：用户回复「Q7 是」。沙箱身份须保留公司租户、团队工作空间和 Bot 的执行归属。
- D8：停止与闲置回收保留浏览器登录资料、编码工作文件及恢复会话所需磁盘数据；启动允许重新运行进程，不要求恢复进程内存和未保存编辑状态。两类环境分别重置，各自清除所属数据。来源：用户回复「Q8 是」。异常崩溃下的数据保证仍待定。
- D9：编码预览服务与编码环境同处运行；有效预览访问阻止闲置停止，无任务且无有效访问后才进入闲置停止，再次打开时按需启动。后台轮询不得无限续期；具体活动判据待定。来源：用户回复「Q9 是」。
- D10：两类沙箱无共享可读写目录，通过 OpenBot 授权的文件传递接口显式复制；检查两端执行归属及目标路径，浏览器登录资料不进入普通传递范围。来源：用户回复「Q10 是」。
- D11：未授权网络目的默认拒绝；管理员可预配置规则，Bot 仅可申请扩大权限，由有权的人通过 OpenBot 批准，区分 computer 与编码环境；临时申请须明确目的、范围与有效期。审批角色及授权范围待定。来源：用户回复「Q11 是」。
- D12：网络权限撤销须终止已有连接；底层不能可靠即时撤销时，允许停止受影响沙箱，确认新策略生效后再启动；受影响任务应显示中断原因。撤销完成前不能报告已生效。来源：用户回复「Q12 是」。底层实现能力待核实。
- D13：沙箱进程不持有 OpenShell、Kubernetes 控制面管理凭据或其他 Bot 凭据，只获得任务所需权限；文件传递及网络申请经过 OpenBot 受限接口并校验执行归属。来源：用户回复「Q13 是」。
- D14：环境可自动恢复，但不自动重放有外部副作用且结果未知的操作；先核对外部状态或由用户处理，可证明幂等的操作允许重试。来源：用户回复「Q14 是」。
- D15：网络授权、撤销、重置、文件传递等关键操作先可靠记录意图，再执行并记录结果；审计不可用时拒绝普通破坏性操作。紧急停止及权限收紧仍执行，并通过可恢复记录保留证据，恢复后核对补齐结果。来源：用户回复「Q15 是」。可恢复审计机制与故障验收待设计。
- D16：临时网络授权限定沙箱和明确期限，在任务结束或到期时撤销（以先发生者为准）；延期需再次授权。长期规则由管理员单独配置。来源：用户回复「Q16 是」。
- D17：容量不足时排队，超过等待期限明确失败；不通过共享 Bot 沙箱或降级隔离缓解容量不足。两类环境分别计量并受部署总预算约束；任务开始前检查所需容量，运行中任务不因新任务到来被强制驱逐。来源：用户回复「Q17 是」。预算数值、硬限制及排队公平性待定。
- D18：第一版仅部署管理员可批准网络扩权，不增加公司或团队委托审批；普通任务审批权不包含网络扩权。来源：用户回复「Q18 是」。
- D19：新的默认拒绝、强撤销及授权流程先限定于 OpenShell 模式，现有部署模式保持各自行为，界面须明确当前模式与隔离能力。来源：用户回复「Q19 是」。
- D20：以部署配置统一选择沙箱底座，OpenShell 模式同时用于 computer 与编码环境；第一版不支持按公司、团队或 Bot 混选底座。来源：用户回复「Q20 是」。
- D21：computer、OpenCode、SSE、WebSocket及预览等入口统一经 OpenBot 校验用户和 Bot 归属，不提供可绕过校验的底层公开入口。来源：用户回复「Q21 是」。入站认证及头部传递须实测。
- D22：一个 OpenBot 团队工作空间对应一个 OpenShell 工作空间，内部按 Bot 与环境类型分配独立沙箱；团队内每 Bot 的权限仍由 OpenBot 检查。来源：用户回复「Q22 是」。底层 namespace 映射与选定发布版本支持待核实。
- D23：仅 OpenBot 集成服务按需持有 OpenShell 控制面权限；普通用户与 Bot 不直接成为 OpenShell 成员或取得控制面凭据。来源：用户回复「Q23 是」。集成服务凭据粒度和轮换机制待设计。
- D24：每个沙箱具有 CPU、内存、持久存储硬限制，两类沙箱分别设额度且受部署总预算约束；具体额度可配置，容量验证后确定默认值；存储超限不能自动删除登录资料或工作文件。来源：用户回复「Q24 是」。硬配额须在所选存储后端验证，PVC声明容量本身不能直接视为写入硬配额。
- D25：控制面失联后允许短暂恢复窗口，超过宽限期必须通过独立于失联控制链路的机制阻止受影响沙箱继续执行；恢复须重新核对归属、策略及授权。宽限期可配置，60秒仅为待验证候选值。来源：用户回复「Q25 是」。此机制为设计要求，不是已证明的OpenShell能力。

## 行为与责任边界

部署选择 OpenShell 时，两类工作负载均使用该底座；开发阶段可按验证步骤逐步接入，但不能以只支持其中一类作为完整交付。物理沙箱按需创建，并分别绑定实际执行归属、Bot、环境类型及运行代际；产品身份不是独立授权凭据。

OpenBot 保留业务身份和归属校验、审批和权限意图、运行生命周期协调、容量准入、关键操作审计及服务入口。OpenShell 承接隔离、网络规则执行和底层沙箱生命周期。集成服务持有的控制面权限必须与所需范围匹配，工作负载不持有此类权限。具体凭据协议、服务拓扑及数据库写入边界属于后续技术设计。

OpenCode 和预览位于编码沙箱，computer 独立保存浏览器资料。停止保留磁盘数据，恢复启动新进程；重置只清除目标环境。状态读取不得因查询本身唤醒环境，用户主动再次打开已停止的预览可按需启动。停止与重置、状态与唤醒沿用已有 computer 合同，不将 OpenShell 内存挂起 API 当作必要前提。

网络授权区分环境类型。任务结束或授权到期触发临时规则撤销，不能因任务控制链路失联无限延续授权。只有确认最终有效策略和已有连接处置后，才能报告撤销完成；provider附加规则或并发变更不能悄悄恢复已撤销访问。无法确认隔离或策略有效时拒绝执行；控制面失联按 D25 适用有界宽限期，不将其扩大为已知策略失效后的继续执行许可。

正常关键操作记录意图后执行并核对结果。紧急停止及收紧权限不被中央审计故障阻挡，但要有可恢复证据。状态未知不等于成功或可重试：有外部副作用的操作遵守 D14。具体恢复日志、幂等、并发和故障状态合同须在实施前设计。

## 验收映射

下列场景将已批准需求转成验收检查，具体工具、环境和证据布局由实施计划确定；本轮未执行这些验收。

| 验收 | 需求 | 通过条件 |
| --- | --- | --- |
| A01 部署与工作负载 | D1–D3、D6、D19–D20 | Kubernetes新增选择同时支持computer与编码；原部署行为与既有数据不被本次自动改动；模式及能力可见。 |
| A02 隔离与归属 | D4、D7、D13、D22–D23 | 同Bot两类环境独立；跨Bot、跨团队及实际业务范围的文件、网络和管理访问被拒绝；无工作负载控制面管理凭据；策略或隔离失效时不执行。 |
| A03 持久化与重置 | D8 | 登录资料、工作文件及会话磁盘数据经普通stop/start保留；分别reset只影响目标环境；进程崩溃、Pod重建和控制服务重启另记录实测保证，不能声称恢复RAM或保证网站永不要求重新登录。 |
| A04 预览和入口 | D9、D21 | HTTP、SSE、WS和预览均校验用户与执行归属，无裸入口绕过；长流、刷新、断线、认证头和超时可用；有效访问防止闲置停止，后台轮询不能永久续期，再次主动访问可唤醒。 |
| A05 文件传递 | D10 | 跨沙箱仅经受控复制，两端归属和目标路径验证成立，浏览器登录资料不可经普通传递外发。 |
| A06 网络授权与撤销 | D5、D11–D12、D16、D18 | 未授权地址拒绝，只有部署管理员可扩权；临时授权先到期或先结束即撤销；现存长连接断开，核最终有效规则且处理并发和provider附加规则，不提前报告成功。 |
| A07 审计与未知结果 | D14–D15 | 注入审计故障后普通关键破坏操作不执行；紧急收紧仍执行并可恢复核对证据；未知副作用不自动重放。 |
| A08 容量与资源 | D17、D24 | CPU、内存和存储硬限制实际生效；两类计量及部署总预算约束成立；不足排队、超时失败，不降低隔离、不因新任务驱逐运行任务、不删用户数据腾空间。 |
| A09 失联约束 | D25 | 控制面失联、网络分区及执行约束组件故障场景中，独立机制在配置期限阻止继续执行；恢复重新核验归属、策略和授权；正常网络中的远程stop不替代此验证。 |

## 技术条件与尚待验证项

- 固定 OpenShell 发布版本、镜像摘要、Agent Sandbox controller/CRD、CNI、存储与宿主内核兼容组合。官方文档研究基线不等于选定部署版本。
- 自定义镜像支持不能替代 Chromium 兼容性验证。Kubernetes 驱动仍可能依赖 Sandbox controller/CRD；不能据此声称删除该依赖。
- 验证工作空间与 namespace 的映射、最小控制面凭据、轮换及所有服务入口不可绕过的部署配置。
- 独立运行授权执行机制是尚待设计的关键条件，不能假定 OpenShell 原生提供。沙箱内可被任务控制的普通心跳进程不能单独证明约束成立。
- 确认策略加载回执、旧连接关闭、并发更新及附加规则的最终效果。
- PVC声明容量不自动证明磁盘写入硬配额；所选存储后端须实际验证超限行为。
- 设计可恢复审计、生命周期代际、受控文件传递、容量协调、队列超时与公平性、有效预览活动判据。
- CPU/内存/存储额度、队列等待和闲置期限以验证结果确定可配置默认值；失联宽限期60秒仍是候选，不能作为已验证SLO。

上述缺口是技术设计和验收门槛，不是静默豁免。无法满足时报告证据并重新确认需求取舍，不能通过放宽安全边界将验收标为通过。

## 范围与非目标

首版不做已有Bot数据迁移和旧环境回退，不要求RAM恢复，不新增委托网络审批角色，不支持按Bot混选底座。旧部署模式的安全行为统一不属本次范围。保留浏览器工具、OpenCode产品协议、预览及OpenBot治理能力；本方案不是将这些产品能力整体交给OpenShell。

正式实施计划、接口合同、资源数值、实测、GitHub写入和部署均需后续对应任务授权。本 Spec 不修改其他领域的已批准事实所有权，也不以研究文档替代实测。

## Further Notes

2026-10-30 已发布至正式 tracker：[Issue #734](https://github.com/1123786563/OpenBot/issues/734)，状态 OPEN，标签 `ready-for-agent`。发布前用户明确批准以 OpenBot 对外的 computer 与编码服务接口作为最高测试接缝，辅以少量 OpenShell 适配器合同测试；这是本 Spec「Testing Decisions」的来源。发布后回读正文与准备内容一致（SHA-256 `7b9151fe7aa79a4846f5d6a3c0a1bccb1a711d7a0ec7ccfa0ed4b74dc121192e`），并确认标签。该标签表示需求与验收已定义，不表示技术验证门槛已通过或任务可越过依赖直接实施。
