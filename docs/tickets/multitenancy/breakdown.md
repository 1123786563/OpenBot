# 多租户整改 Ticket 拆解（待审阅）

父 Spec：https://github.com/1123786563/OpenBot/issues/6（Issue #6）。共 **143** 个 Ticket，20 组，其中 55 个由多依赖/多目标 Ticket 拆分而来。

粒度规则：每个 Ticket 必须能在单个 code agent 上下文内完成，使某个 agent 失败时另一个 agent 能很快接手；多依赖与多目标 Ticket 已进一步拆分。

排序：宽范围机械重构按 expand → migrate（按 blast radius 分批）→ contract 排序；每批一个 Ticket，保持每个 Ticket 是可独立验证的业务行为切片。

可立即开始（无阻塞）：MT001, MT002, MT103

验收覆盖：A1×55, A2×96, A3×36, A4×30, A5×40, A6×36, A7×19, A8×38, A9×19, A10×37, A11×33, A12×22, A13×22

校验：{"unique_slugs": true, "dependencies_exist": true, "deps_declared_earlier": true, "no_cycles": true, "declaration_order_topological": true, "acceptance_coverage_13": true, "no_unknown_ticket_references": true, "no_unresolved_tokens": true}

---


### A 基础/前置

1. **MT001 从真实装配生成全入口清单与覆盖缺口报告**
   - Blocked by: None
   - Delivers: 任何 agent 或审阅者都能运行一个清单命令，得到当前真实注册的全部 HTTP/内部/stream 入口、后台程序、数据表与外部依赖，并看到哪些入口还没有归属负责人。清单是多租户覆盖验收的唯一入口事实源，替代人工猜测。
   - Acceptance: A6, A11
2. **MT002 多公司多团队测试身份夹具与受限角色数据库 harness**
   - Blocked by: None
   - Delivers: 实现者可以在测试里一行拿到「公司 A 团队甲、公司 A 团队乙、公司 B 团队丙」以及仅属甲、仅属乙、甲乙双成员、同团队另一人、跨公司用户、公司管理员、平台操作身份、受限 Worker 身份等固定身份，并在真实受限 PostgreSQL 角色下打开业务事务。所有正向与越权测试共用同一套身份，避免每个 Ticket 自造夹具。
   - Acceptance: A6
3. **MT003 按任务生成迁移的安全迁移工具（dry-run/apply + manifest）**
   - Blocked by: MT001
   - Delivers: 实现者可以为某个 Ticket 生成固定编号的迁移，并以 dry-run 预览、以显式 manifest 执行 apply；工具拒绝生产库与隐式环境回退，保证多租户改造期间的 schema 变更可追溯、可重放、可核验。
   - Acceptance: A6, A12

### B 成员与作用域

4. **MT004 团队成员关系数据模型与复合约束**
   - Blocked by: MT003
   - Delivers: 系统可以记录「某人属于某公司的某个团队」，并同时证明该团队属于该公司、该人是该公司成员；成员关系带 active/suspended 状态与授权变更版本号。本 Ticket 只扩展数据模型，不改变现有可见性行为。
   - Acceptance: A1, A3
5. **MT005 团队资格进入集中授权 seam 与事务内重验**
   - Blocked by: MT002, MT004
   - Delivers: 每次业务访问都由集中授权入口判定「有效公司成员资格 + 有效团队成员资格」，并在同一业务事务内重验；撤权后的下一次请求立即失效。客户端提交的公司/团队标识只用于选择，不作为授权依据。
   - Acceptance: A1, A2, A5, A6
6. **MT006 公司与团队列表、选择与管理入口**
   - Blocked by: MT005
   - Delivers: 用户登录后能列出自己有权进入的公司与团队并选择当前工作范围；公司管理员能管理本公司的团队与成员名单，但不会因此获得业务内容读取权。没有可用团队时返回明确的空状态而不是默认团队。
   - Acceptance: A1, A3, A6
7. **MT007 成员停用与撤权的级联生效与审计留痕**
   - Blocked by: MT005, MT006
   - Delivers: 公司或团队管理员停用某人后，此人的后续请求、下载签发、订阅、任务敏感动作与凭据获取都失效，且变更留有可追溯的审计记录；其他公司的资格不被误删。
   - Acceptance: A5, A2

### C 资源授权策略

8. **MT008 资源可见性属性与 workspace-v1 策略版本（expand）**
   - Blocked by: MT005
   - Delivers: 资源可以标记为个人或团队公共，并通过新的策略版本表达团队公共授权；旧策略版本的语义保持不变，历史资源的暴露范围只能经明确迁移或明确选择改变。
   - Acceptance: A4, A2
9. **MT009 团队公共资源动作规则（可用不可改）**
   - Blocked by: MT008
   - Delivers: 团队成员无需逐人授权即可使用明确发布为团队公共的 Bot（read/run）与公共知识库（read），但不能编辑其配置、上传或删除内容；管理动作与内容读取分别判定。
   - Acceptance: A4, A2, A3
10. **MT010 个人资源权限与显式跨团队分享例外**
   - Blocked by: MT008
   - Delivers: 个人会话、个人文件与个人连接凭据继续按个人权限控制，团队成员资格不开放它们；同公司跨团队访问只能通过显式分享，并同时验证受众、动作、有效期与撤销状态。
   - Acceptance: A1, A2, A3, A4
11. **MT011 无权对象按不可见处理，错误与计数不泄露存在性**
   - Blocked by: MT009, MT010
   - Delivers: 当用户访问无权或跨范围的对象时，系统按 not-found 语义处理；错误文本、列表计数、分页游标和存在性检查都不泄露该对象是否存在。
   - Acceptance: A2, A1
12. **MT012 核心租户域表的 RLS 与受限业务角色兜底**
   - Blocked by: MT002, MT008
   - Delivers: 公司成员、团队、成员关系、授权、凭据与账务等核心租户域表启用行级安全，并以受限业务角色访问；即使应用层出错，跨公司查询与关联也在数据库层被拒绝。
   - Acceptance: A6, A1, A2

### D 运行配置

13. **MT013 多租户模式开关与启动就绪校验**
   - Blocked by: MT001, MT005
   - Delivers: 运维可以用一个显式开关进入多租户模式；该模式下启动会校验入口覆盖清单是否完整、是否仍存在单用户/开发绕过、数据库角色是否安全，任何一项不满足都拒绝启动而不是带着缺口上线。
   - Acceptance: A6, A11
14. **MT014 公司运行配置装配（替换部署级单份租户包）**
   - Blocked by: MT013, MT006
   - Delivers: 模型配置、Bot 默认、线程标识、凭据引用与套餐映射按公司/团队解析，而不是启动时装配一份全局配置；部署级基础设施（连接池、模板、密钥）继续共享。
   - Acceptance: A1, A6, A8
15. **MT015 缓存键与外部命名空间包含公司、团队与配置版本**
   - Blocked by: MT014
   - Delivers: 缓存、事件通道、对象存储前缀、向量命名空间等键都包含真实归属与配置版本，因此切换公司/团队或更新配置后不会读到旧范围的数据。
   - Acceptance: A8, A10, A1

### E Bot

16. **MT016 Bot 与配置的创建、列表、详情按公司团队归属**
   - Blocked by: MT014, MT009
   - Delivers: 用户创建、查看和编辑 Bot 时，Bot、其偏好与默认配置都固定在当前公司与团队；另一家公司或非团队成员看不到也改不了它。
   - Acceptance: A1, A2, A3
17. **MT017 Bot 发布受众与旧 public 语义的显式迁移**
   - Blocked by: MT016
   - Delivers: 发布 Bot 时必须选择明确受众（团队公共或指定范围），历史 public 标记只有经显式迁移或显式发布才进入团队公共范围，绝不会自动变成全公司或全平台公开。
   - Acceptance: A2, A3, A4
18. **MT018 使用团队公共 Bot 时保持使用者自己的会话与凭据**
   - Blocked by: MT017, MT009
   - Delivers: 团队成员运行公共 Bot 时，产生的会话、个人连接与个人凭据属于使用者本人，不会绑定为 Bot 创建者身份；创建者的私人凭据也不会因此暴露给使用者。
   - Acceptance: A4, A2, A1
19. **MT019 Bot 生命周期动作逐项授权（复制/隐藏/重置/删除/模板更新/远端回调）**
   - Blocked by: MT016, MT017
   - Delivers: 复制、隐藏、重置、删除、模板更新与远端回调等每个生命周期动作都单独授权，管理动作不因为可读或可运行而自动放行。
   - Acceptance: A2, A4, A5
20. **MT020 专家/模板安装与安装回执的公司团队归属**
   - Blocked by: MT016, MT017
   - Delivers: 从目录安装专家或模板时，安装记录、产生的资源与回执都归属发起安装的公司与团队；公共目录本身可全局只读，但安装与调用不能全局。
   - Acceptance: A1, A2, A4

### F 会话

21. **MT021 频道与会话列表、计数、分页游标的作用域**
   - Blocked by: MT016, MT014
   - Delivers: 用户看到的会话列表、未读计数与分页结果只包含当前公司团队范围内自己有权访问的会话；跨范围会话既不出现在列表，也不影响计数与游标。
   - Acceptance: A1, A2, A3
22. **MT022 消息读写、重命名、归档与历史 replay 的授权**
   - Blocked by: MT021
   - Delivers: 会话内的消息发送、读取、重命名、归档与历史线程 replay 都要求对应权限；公共 Bot 不会把使用者的个人会话公开给团队。
   - Acceptance: A2, A3, A4
23. **MT023 群聊成员与 Bot 席位的作用域**
   - Blocked by: MT022, MT018
   - Delivers: 群聊的创建、成员增删与 Bot 席位都限定在同一公司（且符合团队规则）范围内；不能把另一公司的用户或 Bot 拉进群，也不能通过群成员关系读到无权内容。
   - Acceptance: A1, A2, A3
24. **MT024 附件暂存上传、绑定、下载签发与清理的归属**
   - Blocked by: MT022
   - Delivers: 附件从暂存上传、绑定到会话、签发下载到过期清理，全链路都能追溯到上传时的公司与团队上下文；无权用户拿不到下载链接，撤销后已签发的访问也停止。
   - Acceptance: A2, A5, A8
25. **MT025 事件流订阅授权与外部线程映射归属**
   - Blocked by: MT022
   - Delivers: socket/SSE 订阅按订阅者权限校验，事件正文不泄露无权内容；与外部服务建立的线程映射固定公司团队归属，切换团队不会让旧线程继续推送。
   - Acceptance: A2, A5, A10

### G 身份与凭据

26. **MT026 公司 SSO/SCIM 配置归属与定向停用**
   - Blocked by: MT007, MT014
   - Delivers: 每家公司的 SSO/SCIM 配置独立保存与生效；SCIM 离职只撤销该公司的成员资格与资源权限，不会删除用户在其他公司的资格或全局身份。
   - Acceptance: A1, A5, A7
27. **MT027 连接凭据与站点登录归属，可用不等于可读明文**
   - Blocked by: MT014, MT010
   - Delivers: 连接凭据、站点登录与保存的账号都按真实归属（公司/团队/个人）保存；业务调用可以使用它们，但明文不会因“可用”而暴露给无权用户或其他范围。
   - Acceptance: A1, A2, A5
28. **MT028 OAuth 回调按服务端 state 固定归属**
   - Blocked by: MT027
   - Delivers: 发起 OAuth 时服务端保存发起公司、团队、用户与目标连接；回调只按这份持久状态绑定结果，用户在回调期间切换团队也不会把连接绑到错误的范围。
   - Acceptance: A7, A1, A5
29. **MT029 凭据取用 lease：固定用途、作用域且可撤销**
   - Blocked by: MT027, MT018
   - Delivers: 业务执行需要凭据时通过 lease 取用：lease 固定用途、作用域与有效期，可被撤销；个人凭据不会因为团队公共 Bot 而被自动共享给其他使用者。
   - Acceptance: A2, A5, A4
30. **MT030 全局身份、刷新锁与例外端点显式登记**
   - Blocked by: MT027, MT013
   - Delivers: 登录、健康检查、平台静态目录等全局端点被显式登记为例外并说明理由；会话刷新锁与全局身份逻辑保持全局语义，不会因为多租户改造而被误加归属或误开放。
   - Acceptance: A6, A11

### H 插件与审批

31. **MT031 插件安装与连接归属（目录只读，安装不全局）**
   - Blocked by: MT027, MT016
   - Delivers: MCP、Composio、OpenConnector 等插件的公共目录可全局只读浏览，但安装、配置与连接都归属发起的公司/团队；另一公司看不到也调用不到这些安装。
   - Acceptance: A1, A2, A4
32. **MT032 工具调用时重新校验当前用户连接与 Bot 授权**
   - Blocked by: MT031, MT018
   - Delivers: 每次工具调用都按当前用户的连接与 Bot 授权重新校验，因此撤销授权、退出团队或停用连接会立即让工具不可用，即使会话仍在进行。
   - Acceptance: A2, A5
33. **MT033 技能与组件发布、组件数据函数的作用域**
   - Blocked by: MT031, MT009
   - Delivers: 技能与组件的发布范围、版本与数据函数调用都按公司/团队归属；团队公共技能对成员可用，但组件数据函数不会让无权用户读到他人数据。
   - Acceptance: A2, A4, A3
34. **MT034 共享账号审批绑定对象、参数摘要与归属**
   - Blocked by: MT031, MT029
   - Delivers: 共享账号的规则、申请与批准都锁定到具体对象、参数摘要与所属公司团队；改了团队或改了参数就不能复用旧批准，跨范围审批无法生效。
   - Acceptance: A2, A5, A1
35. **MT035 Host Access、签入帮助与危险动作审批的归属与既有行为保持**
   - Blocked by: MT034
   - Delivers: Host Access、签入帮助与危险动作审批在多租户下继续按归属授权，且既有审批交互（提问、恢复、原生确认）行为不回退。
   - Acceptance: A2, A5, A8

### I 知识与记忆

36. **MT036 知识库的团队归属与受限查询（独立库，不假装跨库外键）**
   - Blocked by: MT012, MT014
   - Delivers: 每个知识库固定公司与团队归属，查询只返回有权范围内的库与文档；主库与知识库是两个独立数据库，一致性由调用时授权与同步版本保证，不声称存在跨库外键。
   - Acceptance: A1, A2, A4
37. **MT037 检索在候选、重排与进入模型之前限制范围**
   - Blocked by: MT036
   - Delivers: 知识检索先确定允许的库与文档集合，再在检索端限制返回范围；无权内容不会进入重排、不会进入模型上下文，也不会通过引用泄露。
   - Acceptance: A2, A4, A8
38. **MT038 文档上传、删除、导入与重解析的作用域**
   - Blocked by: MT036
   - Delivers: 文档上传、删除、导入任务、重解析、原文件与 chunk/revision 都固定在发起时的公司与团队；后台导入任务不会把内容写进别的范围。
   - Acceptance: A2, A5, A8
39. **MT039 个人记忆与来源选择保持个人权限**
   - Blocked by: MT038, MT010
   - Delivers: 个人业务记忆、记忆来源选择与相关缓存按个人权限控制；团队成员资格不会让他人读到某人的记忆，公共 Bot 运行时也只会使用当前使用者被授权的记忆来源。
   - Acceptance: A4, A2, A1
40. **MT040 学习容器、研究与演示记录隔离**
   - Blocked by: MT036, MT014
   - Delivers: 学习容器、连接应用研究与演示记录按归属隔离；外部学习服务不会把不同公司的客户内容放进同一个容器或同一个命名空间。
   - Acceptance: A2, A8, A1

### J 任务与执行

41. **MT041 任务、运行、触发与租约固定原始归属与配置版本**
   - Blocked by: MT005, MT014
   - Delivers: 每个任务/运行/触发/租约在创建时固定公司、团队、发起主体、业务对象与配置版本；用户之后切换团队不会改变已创建任务的归属。
   - Acceptance: A2, A8, A5
42. **MT042 全局扫描只有调度权，每项执行重建业务作用域**
   - Blocked by: MT041
   - Delivers: 平台扫描可以发现所有公司的到期任务，但每项执行都必须依据服务器持久化记录重建业务作用域与资格；机器认证不能伪造普通用户身份，序列化 Scope 不被当作可信 Scope。
   - Acceptance: A8, A6, A2
43. **MT043 认领、重试与人工取消保持归属**
   - Blocked by: MT042
   - Delivers: 任务认领、失败重试与人工取消都在原归属范围内进行；取消只对有权主体生效，重试不会把任务漂移到别的公司或团队。
   - Acceptance: A8, A5, A2
44. **MT044 入站邮件、GitHub 与 Webhook 的归属解析**
   - Blocked by: MT042, MT028
   - Delivers: 入站邮件、GitHub 事件与 Webhook 通过服务端持久映射解析到正确的公司与团队，不接受载荷里自称的归属；无法解析归属的入站事件被隔离而不是落到默认范围。
   - Acceptance: A7, A8, A6
45. **MT045 主动建议与外部调用前后的事务边界**
   - Blocked by: MT042
   - Delivers: 主动建议、职责与计划类功能按归属生成与投递；数据库事务不跨外部网络调用持有，避免长事务持锁并保证失败可安全重试。
   - Acceptance: A8, A2

### K 执行隔离

46. **MT046 电脑与浏览器实例分配、远程屏幕与人工接管授权**
   - Blocked by: MT042, MT029
   - Delivers: 电脑/浏览器实例的分配与回收、远程屏幕查看与人工接管都要求对应权限；服务 token 本身不授予任意公司数据访问。
   - Acceptance: A1, A2, A5, A8
47. **MT047 快照、shell、文件、cancel/reset/cull 的归属**
   - Blocked by: MT046
   - Delivers: 执行侧的快照、shell 命令、文件读写、取消、重置与清理操作都按归属授权，工作目录与快照不跨公司/团队可见或可复用。
   - Acceptance: A1, A2, A8, A5
48. **MT048 运行协议环节的归属：委托、能力、步骤、事件、恢复与取消**
   - Blocked by: MT042, MT046
   - Delivers: 运行从委托、能力协商、步骤执行、事件回传到恢复与取消的每个协议环节都携带并校验同一执行归属；恢复不能把运行漂移到别的公司或团队。
   - Acceptance: A8, A7, A2
49. **MT049 TypeScript agent 适配器统一消费已验证归属**
   - Blocked by: MT048
   - Delivers: 各 TypeScript agent 适配器（不同框架）都消费同一个已验证的执行归属与回调解析结果，不因框架不同而跳过授权。
   - Acceptance: A8, A7, A2
50. **MT050 Go Runtime、supervisor 与原生 agent 适配器的归属传递**
   - Blocked by: MT049
   - Delivers: Go Runtime、supervisor、agent-computer 与 agent-sandbox 等原生组件从调用方接收并回传同一执行归属，跨语言边界不丢失授权事实。
   - Acceptance: A8, A1, A2
51. **MT051 执行上界、审批与机密脱敏的既有保证不回退**
   - Blocked by: MT047, MT050
   - Delivers: 多租户改造后，已批准的执行上界、危险动作审批与机密脱敏行为保持不变；这是一张以回归为主的 Ticket。
   - Acceptance: A8, A5
52. **MT052 状态化公共 Bot 为不同使用者隔离浏览器与工作区**
   - Blocked by: MT046, MT018
   - Delivers: 当团队公共 Bot 需要登录态或本地工作区时，不同使用者获得各自隔离的浏览器 profile 与工作目录，或在验证为无状态后安全复用并回收；任何情况下不共享登录态。
   - Acceptance: A4, A2, A8

### L Craft/Workshop

53. **MT053 Craft 会话、turn、消息与快照的作用域**
   - Blocked by: MT022, MT046
   - Delivers: Craft 的会话、turn、消息与快照按公司与团队归属；无权用户既看不到列表，也不能通过 ID 或分享链接读取内容。
   - Acceptance: A1, A2, A4
54. **MT054 Craft 计划任务、子任务与应用连接的归属**
   - Blocked by: MT053, MT041
   - Delivers: Craft 的计划任务、子任务与应用连接在创建时固定归属，后台触发与执行遵守与通用任务相同的规则；连接不会跨范围复用。
   - Acceptance: A8, A2, A5
55. **MT055 产物与对象存储路径按归属隔离**
   - Blocked by: MT053
   - Delivers: Craft 与 Workshop 产生的产物在对象存储中按归属隔离寻址；路径前缀只用于寻址，任何读取都要经过授权，列举不会跨范围泄露。
   - Acceptance: A2, A8, A1
56. **MT056 签名下载与代理访问在签发点和访问点都授权，撤销即停止**
   - Blocked by: MT055, MT010
   - Delivers: 下载链接在签发时校验权限，在代理访问时再次校验；分享或访问被撤销后，新的签发被拒绝，已签发链接也无法继续通过代理取到内容。
   - Acceptance: A5, A2, A1
57. **MT057 Workshop 会话、执行、产物与沙箱实例关联的作用域**
   - Blocked by: MT053, MT047
   - Delivers: Workshop 的会话、turn、执行、产物与沙箱实例关联都按归属隔离；公开入口不再成为跨公司通道。
   - Acceptance: A1, A2, A8
58. **MT058 分享令牌改为有效分享授权（受众、有效期、撤销）**
   - Blocked by: MT056, MT010
   - Delivers: 分享链接不再是匿名跨公司通道：默认受众为同团队，显式同公司跨团队分享要验证受众与动作，撤销后访问立即停止。
   - Acceptance: A3, A2, A5

### M OpenMuse 个人域

59. **MT059 私有 OpenMuse Bot 按公司团队用户幂等创建**
   - Blocked by: MT016, MT014
   - Delivers: 每位用户在每个公司团队范围内拥有自己的私有 OpenMuse Bot；重复创建幂等，模板应用不会抹掉用户已有字段，两个公司的同一账号不会共用一个 Bot。
   - Acceptance: A1, A2, A4
60. **MT060 OpenMuse 任务、计划、监控与租约的作用域**
   - Blocked by: MT059, MT041
   - Delivers: OpenMuse 的任务、计划、监控与租约按公司团队用户归属；同一账号在两个公司不会共享任务锁、工作队列或监控状态。
   - Acceptance: A1, A2, A8
61. **MT061 OpenMuse 文件、PDF 检视/填写/传输与个人工作区的作用域**
   - Blocked by: MT060, MT055
   - Delivers: OpenMuse 的文件、PDF 检视、表单填写与传输，以及个人工作区，都按范围与个人权限隔离；一个公司的文件不会出现在另一个公司的处理链路或下载中。
   - Acceptance: A1, A2, A5
62. **MT062 OpenMuse 目标、想法、记忆与财务产物的作用域**
   - Blocked by: MT060, MT039
   - Delivers: 目标、想法、个人记忆与财务产物按范围与个人权限保存；精确动作提案、确认与取消的既有行为保持不变。
   - Acceptance: A2, A4, A1
63. **MT063 OpenMuse 连接器、邮件与日历动作的归属**
   - Blocked by: MT060, MT028
   - Delivers: 每个 Google/OAuth 连接、邮件与日历动作都绑定公司团队用户；连接不会被另一个范围的请求复用，动作执行前重新校验授权。
   - Acceptance: A7, A1, A2, A5
64. **MT064 OpenMuse 审阅动作提案与回执的归属**
   - Blocked by: MT063, MT034
   - Delivers: 审阅动作的提案、确认与回执都绑定公司团队用户；跨范围提案不可见也不可操作，既有精确动作行为不回退。
   - Acceptance: A2, A5, A7
65. **MT065 OpenMuse 活动流与通知的归属与正文过滤**
   - Blocked by: MT064
   - Delivers: 活动流只聚合当前范围事件，通知在投递时校验接收者权限且正文不含其无权访问的内容。
   - Acceptance: A2, A5, A7
66. **MT066 语音、听写与移动聚合接口只返回当前范围**
   - Blocked by: MT060, MT065
   - Delivers: 语音会话、听写与模型调用按归属记录并计费；移动聚合接口只返回请求所属范围的数据，不会一次带回多个公司的内容。
   - Acceptance: A2, A10, A9
67. **MT067 退出公司与全局账号删除是两个不同操作**
   - Blocked by: MT060, MT026
   - Delivers: 删除 API 明确区分「退出/清理某公司数据」与「独立授权的全局账号删除」；公司管理员不能触发全局身份删除，退出公司也不会影响其他公司资格。
   - Acceptance: A5, A1, A2
68. **MT068 清理、保留与恢复带可核验归属与不可伪造 manifest**
   - Blocked by: MT067
   - Delivers: purge、retention 与 restore 操作都携带归属与发起权限，并以不可伪造的 manifest 限定范围；不会仅凭 user_id 扫遍所有公司的外部文件或凭据。
   - Acceptance: A5, A12, A2

### N 账务

69. **MT069 公司计费 Customer 映射与公司/个人账户类型（expand）**
   - Blocked by: MT014, MT008
   - Delivers: 一个公司对应唯一明确映射的计费 Customer；积分账户增加 company/personal 类型与稳定标识约束。本 Ticket 只扩展模型，不改变既有扣费行为。
   - Acceptance: A9, A13, A12
70. **MT070 公司调用归属与同一余额的原子预扣**
   - Blocked by: MT069, MT041
   - Delivers: 公司工作台的每次被计费执行固定公司、团队、使用人、Bot/授权与稳定调用标识；多个团队并发消费从同一公司余额原子预扣，不会各自读一次余额后独立扣费。
   - Acceptance: A9, A13, A1
71. **MT071 结算、释放、尾差与重试幂等在新归属下保持**
   - Blocked by: MT070
   - Delivers: 结算、释放、尾差处理与重试在带公司/团队归属后仍保持既有幂等与金额保证；重放不会重复结算，也不会把费用记到另一个账户。
   - Acceptance: A9, A13, A12
72. **MT072 支付回调、订阅激活、outbox 与对账从原记录解析付款账户**
   - Blocked by: MT070
   - Delivers: 支付回调、订阅激活、用量 outbox 与对账都从已持久化的订单/调用记录解析付款账户，不接受客户端指定；重复事件幂等处理。
   - Acceptance: A7, A9, A13
73. **MT073 账务可见性：付款人订单、公司财务授权与团队用量视图**
   - Blocked by: MT070, MT010
   - Delivers: 付款人继续只能看到自己的订单与支付资料；公司财务读取是明确管理授权；团队用量视图只统计公司付款账户的消费，不把个人 Bifrost 直连消费算作公司支出。
   - Acceptance: A9, A13, A2
74. **MT074 历史余额只迁一次到原有公司，个人 Bifrost 路径不变**
   - Blocked by: MT069, MT003
   - Delivers: 按部署客户归属的历史积分只迁移一次到原有公司账户；已存在的个人余额保留个人归属；无法判断类型的记录先受控隔离再核验。外部 Bot 直连 Bifrost 的个人余额机制完全不变。
   - Acceptance: A12, A13

### O 治理

75. **MT075 部署级平台管理与公司/团队管理动作分离**
   - Blocked by: MT006, MT013
   - Delivers: 平台级管理（部署配置、平台静态能力、全局身份审计）与公司/团队管理动作分开授权；公司管理员不能修改平台策略，平台操作身份也不能借此读取公司业务内容。
   - Acceptance: A1, A2, A5
76. **MT076 人员提升、降级与离职按公司授权**
   - Blocked by: MT075, MT026
   - Delivers: 人员管理动作（提升、降级、离职）只作用于本公司范围，并与公司成员/团队资格、资源授权和审计一致；不会误删其他公司的资格。
   - Acceptance: A5, A1, A2
77. **MT077 网络、能力与模型路由策略和模板按归属保存**
   - Blocked by: MT075, MT014
   - Delivers: 网络策略、能力开关、模型路由与模板按公司/团队归属保存与生效；团队覆盖只收窄，不放大公司安全限制。
   - Acceptance: A1, A2, A8
78. **MT078 业务审计与身份审计分域，计费管理需明确授权**
   - Blocked by: MT075, MT073
   - Delivers: 业务审计、身份审计与平台审计分域保存与查询；计费管理动作需要明确授权，审计查询本身也不能成为跨范围读取通道。
   - Acceptance: A2, A5, A9
79. **MT079 纯个人偏好保持全局，业务配置按归属保存**
   - Blocked by: MT075, MT015
   - Delivers: 语言、主题等纯 UI 偏好可以继续是全局个人偏好；业务模型选择、提示词、默认资源与策略必须按归属保存，不会因偏好机制而跨范围泄露或覆盖。
   - Acceptance: A2, A10, A1

### P Web 客户端

80. **MT080 Web 公司与团队选择界面及无资格空状态**
   - Blocked by: MT006, MT009
   - Delivers: 用户在 Web 上能看到自己有资格的公司与团队并切换当前工作范围；没有可用团队时看到明确空状态，加载、错误与撤权状态都有对应界面，不会静默落到默认团队。
   - Acceptance: A3, A6, A10
81. **MT081 Web REST 与上传下载签发统一附加当前范围**
   - Blocked by: MT080, MT056
   - Delivers: REST 请求、上传通道与下载签发统一附加当前公司/团队选择，且只发送给已审核的同源业务路径。
   - Acceptance: A10, A6, A3
82. **MT082 Web SSE 与 WebSocket 建连、续订携带范围并终止旧连接**
   - Blocked by: MT081, MT025
   - Delivers: 流式连接在建连、续订与重连时携带当前范围；切换范围后旧连接被取消，不再推送旧范围事件。
   - Acceptance: A10, A6, A3
83. **MT083 按公司团队隔离查询缓存并拒绝旧 generation 的在途响应**
   - Blocked by: MT082
   - Delivers: 每个公司/团队的业务缓存互相隔离；切换范围时取消订阅、移除旧范围缓存，并拒绝旧 generation 的在途响应写入，因此用户不会看到上一个范围的数据闪现。
   - Acceptance: A10, A3, A6
84. **MT084 Web Bot 详情与配置页接入范围**
   - Blocked by: MT083, MT017, MT019
   - Delivers: Bot 详情与配置页在切换范围后只显示与保存当前范围的 Bot；残留路由对象不会复用旧范围数据。
   - Acceptance: A2, A3, A4, A10
85. **MT085 Web Bot 共享与发布页按服务端能力展示**
   - Blocked by: MT084
   - Delivers: 发布与共享界面按服务端返回的能力展示可用动作：公共 Bot 使用者看到使用入口而无编辑/发布入口，管理者相反。
   - Acceptance: A2, A3, A4, A10
86. **MT086 Web Bot 职责、电脑与审批页面接入范围**
   - Blocked by: MT085, MT046, MT034
   - Delivers: Bot 的职责、电脑与审批页面按范围工作，撤权后管理入口消失且直接访问路由得到明确状态。
   - Acceptance: A2, A3, A4, A10
87. **MT087 Web 会话与群聊页面接入范围**
   - Blocked by: MT083, MT023
   - Delivers: 会话列表、详情与群聊创建/成员页面在切换范围后正确刷新，创建与操作只作用于当前范围。
   - Acceptance: A2, A3, A10, A11
88. **MT088 Web 技能与连接账号页面接入范围**
   - Blocked by: MT087, MT033, MT027
   - Delivers: 技能与连接账号页面按范围显示与操作；凭据界面默认脱敏，明文查看需独立授权。
   - Acceptance: A2, A3, A10, A11
89. **MT089 Web 记忆与定时任务页面接入范围**
   - Blocked by: MT088, MT039, MT041
   - Delivers: 个人记忆与定时任务页面按范围与个人权限显示；任务创建与取消只作用于当前范围。
   - Acceptance: A2, A3, A10, A11
90. **MT090 Web 通知与个人设置页面：偏好全局、业务配置按范围**
   - Blocked by: MT089, MT079
   - Delivers: 通知中心只显示当前范围的通知；个人设置中纯偏好保持全局，业务配置随范围变化。
   - Acceptance: A2, A3, A10, A11
91. **MT091 Web Craft 与 Workshop 页面接入范围**
   - Blocked by: MT083, MT057
   - Delivers: Craft 与 Workshop 的列表、详情、产物与执行页面按范围工作；产物下载走授权签发。
   - Acceptance: A2, A3, A4, A10
92. **MT092 Web 分享页的身份、受众与撤销状态**
   - Blocked by: MT091, MT058
   - Delivers: 分享页要求有效身份与受众；非同团队成员与跨公司访问者看到明确无权状态，撤销或过期后页面立即不可访问。
   - Acceptance: A2, A3, A4, A10
93. **MT093 Web 知识管理与文档处理页面接入范围**
   - Blocked by: MT083, MT038
   - Delivers: 知识库与文档页面按范围显示；检索结果不含无权内容，文档处理动作只作用于当前范围。
   - Acceptance: A2, A4, A10
94. **MT094 Web 插件、技能与组件页面接入范围**
   - Blocked by: MT093, MT033
   - Delivers: 插件与组件的目录浏览、安装、配置与发布界面按范围工作；公共目录可浏览但安装只影响当前范围。
   - Acceptance: A2, A4, A10
95. **MT095 Web people、身份提供方与凭据管理界面按能力开放**
   - Blocked by: MT083, MT076
   - Delivers: 人员、身份提供方与凭据管理界面只对具备相应公司能力的主体开放，且只显示本公司范围内容。
   - Acceptance: A2, A5, A9, A10
96. **MT096 Web 学习、企业与审计管理界面按能力开放**
   - Blocked by: MT095, MT078
   - Delivers: 学习、企业与审计管理界面按能力开放；审计查询与导出遵守范围与脱敏规则。
   - Acceptance: A2, A5, A9, A10
97. **MT097 Web 账单、订单与团队用量视图**
   - Blocked by: MT083, MT073
   - Delivers: 用户看到自己的订单与支付资料；具备公司财务授权的主体看到公司账务与按团队/用户汇总的用量，且用量只统计公司付款账户。
   - Acceptance: A9, A13, A10, A2

### Q 桌面

98. **MT098 桌面原生组织上下文模型与命令门控**
   - Blocked by: MT028
   - Delivers: 桌面端为每个组织连接保存冻结的 authority/用户/公司/团队上下文，原生命令只允许当前已验证的组织连接使用。
   - Acceptance: A7, A10, A13
99. **MT099 桌面凭据命名空间与 OAuth state 绑定 authority**
   - Blocked by: MT098, MT069
   - Delivers: 桌面凭据按组织命名空间隔离，个人 provider 连接保留独立空间；OAuth state 与恢复绑定发起 authority。
   - Acceptance: A7, A10, A13
100. **MT100 桌面切换或退出组织时清理公司媒体与订阅状态**
   - Blocked by: MT099
   - Delivers: 切换或退出组织时清理该组织的业务缓存、媒体与订阅，但不销毁用户其他公司的数据或个人授权；清理动作可验证且不误删。
   - Acceptance: A10, A7, A5
101. **MT101 桌面组织登录、公司团队选择与嵌入工作台携带选择**
   - Blocked by: MT099, MT082
   - Delivers: 桌面用户可以登录组织、选择公司与团队，嵌入的工作台请求携带该选择；组织登录与 OAuth 恢复都绑定发起归属。
   - Acceptance: A3, A7, A10
102. **MT102 桌面本地状态与业务缓存按组织隔离**
   - Blocked by: MT100, MT101
   - Delivers: 桌面本地存储、业务缓存与媒体文件按组织隔离，切换组织不会读到上一个组织的业务数据；本地状态损坏或过期时安全降级为需要重新选择。
   - Acceptance: A10, A3, A13

### R Canonical 移动端

103. **MT103 移动端 submodule 基线核对与可审查差异报告**
   - Blocked by: None
   - Delivers: 核对当前固定的 submodule 版本与实际已集成的 canonical 来源之间的差异，建立可审查基线并产出差异报告，避免把「缺少适配层的旧 gitlink」当作已完成集成。
   - Acceptance: A11
104. **MT104 移动端 tenancy 适配层：选择与缓存**
   - Blocked by: MT103, MT083
   - Delivers: 移动端（canonical OpenMuse）通过 tenancy 适配层获得公司/团队选择与按范围隔离的缓存，行为与 Web 侧规则一致。
   - Acceptance: A3, A10, A2
105. **MT105 移动端流式与媒体传输携带当前范围**
   - Blocked by: MT104, MT025
   - Delivers: 移动端的流式响应、上传下载与媒体请求携带当前公司/团队选择，切换范围后旧连接与旧媒体缓存失效。
   - Acceptance: A10, A2, A7
106. **MT106 Web、iOS、Android 三端选择与缓存一致性验证**
   - Blocked by: MT104, MT105
   - Delivers: 在同一身份矩阵下验证三端的选择、空状态、切换与撤权行为一致，缓存不跨范围污染。
   - Acceptance: A2, A3, A10, A11
107. **MT107 移动聚合接口范围与三端流式/媒体一致性验证**
   - Blocked by: MT106, MT066
   - Delivers: 验证移动聚合接口逐子查询只返回当前范围，并在三端验证流式与媒体请求的范围一致性。
   - Acceptance: A2, A3, A10, A11

### S 观测

108. **MT108 Trace、日志与事件的归属字段注入**
   - Blocked by: MT050, MT065
   - Delivers: trace、日志与业务事件携带真实公司、团队与执行归属，使共享观测后端上的记录可按范围追溯。
   - Acceptance: A8, A9, A13, A2
109. **MT109 用量事件的账户区分与脱敏回归**
   - Blocked by: MT108, MT069
   - Delivers: 用量事件能区分公司与个人付款账户，避免标识冲突或重放到另一账户；既有脱敏规则在新增字段后仍生效。
   - Acceptance: A8, A9, A13, A2
110. **MT110 共享观测后端的查询、导出与 trace 链接授权**
   - Blocked by: MT109, MT078
   - Delivers: 共享观测后端上的公司查询、导出与 trace 链接仍需授权；部署级 dashboard 不会直接开放给普通租户，审计与观测查询分域。
   - Acceptance: A1, A2, A9
111. **MT111 已启用集成的隔离与账户路由证据**
   - Blocked by: MT109, MT072
   - Delivers: 对实际启用的外部集成（模型网关、观测后端等）提交隔离与账户路由证据；未落地的设计不被当作已验证，计划中的配置也不算证据。
   - Acceptance: A13, A9, A11

### T 迁移与收尾

112. **MT112 创建原有公司与默认团队并建立映射**
   - Blocked by: MT003, MT004
   - Delivers: 为历史部署创建「原有公司」与默认团队，并建立与既有部署身份、计费 Customer 的明确映射，作为后续回填的锚点。
   - Acceptance: A12, A1, A2
113. **MT113 历史根记录归属回填并保持既有个人授权**
   - Blocked by: MT112, MT074
   - Delivers: 把历史业务根记录归属到原有公司与默认团队，同时保持既有个人授权不变；无法唯一归属的记录进入受控隔离清单。
   - Acceptance: A12, A1, A2
114. **MT114 主库子记录回填第一批：Bot、会话、凭据与插件**
   - Blocked by: MT113, MT016, MT021, MT027, MT031
   - Delivers: 主库中 Bot、会话与附件、凭据与插件相关子记录按复合关联回填公司/团队归属，保证不会关联到与父记录不同的公司。
   - Acceptance: A12, A1, A6
115. **MT115 主库子记录回填第二批：记忆、任务、Craft/Workshop、OpenMuse、账务与策略**
   - Blocked by: MT114, MT039, MT041, MT053, MT057, MT060, MT069, MT077, MT109
   - Delivers: 剩余主库业务对象的子记录按同一复合关联规则回填，沿用第一批的进度与校验机制，不重复实现回填框架。
   - Acceptance: A12, A1, A6
116. **MT116 知识库侧归属回填与独立进度记录**
   - Blocked by: MT113, MT036
   - Delivers: 知识库（独立数据库）中的库、文档、chunk 与 revision 归属回填，并单独记录进度，不声称与主库存在单事务。
   - Acceptance: A12, A1, A6
117. **MT117 跨库一致性校验、断点续跑与回填报告**
   - Blocked by: MT114, MT115, MT116
   - Delivers: 把主库与知识库的回填结果做跨库一致性校验，检测一侧成功一侧失败的情况，并输出可复核的回填报告。
   - Acceptance: A12, A1, A6
118. **MT118 对象存储文件与产物的归属迁移**
   - Blocked by: MT117, MT055, MT061
   - Delivers: 对象存储中的业务文件、附件与产物按归属迁移或建立映射，路径规则与授权一致，迁移幂等可续跑。
   - Acceptance: A12, A8, A6
119. **MT119 外部线程、浏览器状态与向量命名空间迁移**
   - Blocked by: MT118, MT037, MT052
   - Delivers: 外部线程映射、浏览器登录态与工作目录、向量集合命名空间按归属迁移或受控隔离，避免跨范围状态残留。
   - Acceptance: A12, A8, A6
120. **MT120 无法归属外部状态的隔离清单与启用阻断**
   - Blocked by: MT119
   - Delivers: 无法唯一归属的外部状态进入可运维查看的隔离清单，并在清单非空时阻断多租户启用。
   - Acceptance: A12, A8, A6
121. **MT121 冻结写入、备份恢复、失败隔离与回退程序（含演练）**
   - Blocked by: MT120
   - Delivers: 交付可执行的上线与回退程序：冻结写入、备份、恢复、失败隔离，以及「存在多公司数据后不能回退到不理解归属的旧版本」的安全回退路径，并完成一次演练。
   - Acceptance: A12, A11
122. **MT122 部署主入口按已认证身份建立上下文并使用作用域工厂**
   - Blocked by: MT014, MT005, MT041
   - Delivers: 部署主入口的每个 HTTP 与内部入口都从已认证身份建立请求上下文，并通过作用域工厂获取业务依赖。
   - Acceptance: A6, A1, A8, A11
123. **MT123 移除启动期默认公司状态并保持 API 兼容**
   - Blocked by: MT122
   - Delivers: 启动流程不再保留默认公司、默认线程标识或单用户绕过；既有 API 路径与 DTO 能力保持兼容。
   - Acceptance: A6, A1, A8, A11
124. **MT124 企业入口装配接入统一上下文与授权**
   - Blocked by: MT123
   - Delivers: 企业入口的每个路由都接入统一上下文建立与授权规则，不使用单独的可见性判断。
   - Acceptance: A2, A5, A6, A11
125. **MT125 旧 REST、Copilot 与移动聚合入口装配与兼容**
   - Blocked by: MT124, MT066
   - Delivers: 旧 REST、Copilot 与移动聚合入口接入同一规则，因此旧接口不能成为绕过新规则的旁路，同时保持既有兼容。
   - Acceptance: A2, A5, A6, A11
126. **MT126 流式与长连接入口的上下文与订阅授权装配**
   - Blocked by: MT123, MT025
   - Delivers: SSE、WebSocket 与长连接入口在建连、续订与重连时都建立并校验上下文，订阅按订阅者权限过滤，切换范围后旧连接被终止。
   - Acceptance: A10, A2, A6
127. **MT127 全局登录、健康检查与平台静态目录例外登记闭合**
   - Blocked by: MT125, MT030
   - Delivers: 全局登录、健康检查与平台静态目录等端点被逐项显式登记为例外并说明理由与责任人；未登记端点一律要求归属上下文。
   - Acceptance: A6, A11, A13
128. **MT128 机器回调与个人 Bifrost 直连路径例外登记闭合**
   - Blocked by: MT127, MT069
   - Delivers: 机器回调与个人 Bifrost 直连路径作为独立例外登记：回调例外只覆盖回调本身，个人直连路径与公司路径的账户解析互不影响。
   - Acceptance: A6, A11, A13
129. **MT129 多租户启动就绪强制与缺口阻断**
   - Blocked by: MT123, MT128, MT013, MT012
   - Delivers: 多租户模式启动时强制校验入口覆盖、例外登记、隔离清单、单用户绕过与数据库角色安全；任何缺口都阻止启动并输出机器可读报告。
   - Acceptance: A6, A8, A11
130. **MT130 Worker 与后台装配去默认公司**
   - Blocked by: MT129, MT042
   - Delivers: Worker 与后台程序装配不含启动期默认公司；每项执行按持久记录重建业务作用域，机器身份不获得普通用户权限。
   - Acceptance: A6, A8, A11
131. **MT131 验收 harness 与独立测试环境**
   - Blocked by: MT001, MT002
   - Delivers: 交付验收 harness：使用独立测试端口、数据库与外部命名空间，可与开发环境并行运行，并能按入口清单驱动用例。
   - Acceptance: A11, A1, A2, A6
132. **MT132 身份矩阵 runner 与逐入口覆盖状态输出**
   - Blocked by: MT131, MT128
   - Delivers: 用固定身份矩阵对真实注册入口逐项运行正向与越权用例，并输出机器可读的覆盖状态与缺口清单。
   - Acceptance: A11, A1, A2, A6
133. **MT133 覆盖证据：Bot、会话与附件**
   - Blocked by: MT132, MT019, MT024
   - Delivers: 用验收 harness 为 Bot、会话与附件闭环补齐正向与越权证据，并关闭发现的缺口。
   - Acceptance: A1, A2, A3, A4, A11
134. **MT134 覆盖证据：插件审批、知识与记忆**
   - Blocked by: MT133, MT035, MT040
   - Delivers: 为插件与审批、知识与记忆闭环补齐正向与越权证据，重点覆盖检索范围与审批归属。
   - Acceptance: A1, A2, A3, A4, A11
135. **MT135 覆盖证据：后台任务与执行隔离**
   - Blocked by: MT132, MT045, MT051
   - Delivers: 为后台任务、电脑与沙箱、运行协议与原生适配器补齐归属与越权证据，重点覆盖状态串用风险。
   - Acceptance: A2, A5, A8, A11, A12
136. **MT136 覆盖证据：Craft/Workshop、OpenMuse 与删除恢复**
   - Blocked by: MT135, MT058, MT068
   - Delivers: 为 Craft/Workshop、分享、OpenMuse 全部业务与删除恢复补齐正向与越权证据。
   - Acceptance: A2, A5, A8, A11, A12
137. **MT137 覆盖证据：公司/个人付款账户与账务可见性**
   - Blocked by: MT132, MT073
   - Delivers: 为公司与个人付款账户路由、原子预扣、结算幂等与账务可见性补齐证据，全部在真实数据库上取得。
   - Acceptance: A7, A9, A12, A13, A11
138. **MT138 覆盖证据：治理、审计与观测出口**
   - Blocked by: MT137, MT079, MT111
   - Delivers: 为管理与治理动作、审计分域、观测查询与导出补齐正向与越权证据。
   - Acceptance: A7, A9, A12, A13, A11
139. **MT139 覆盖证据：Web 客户端**
   - Blocked by: MT132, MT097
   - Delivers: 为 Web 端选择、缓存、在途响应、深链接与长连接补齐验收证据。
   - Acceptance: A3, A10, A11, A13
140. **MT140 覆盖证据：桌面与移动端**
   - Blocked by: MT139, MT102, MT107
   - Delivers: 为桌面与移动端（Web/iOS/Android）补齐选择、本地状态、流式与媒体的验收证据。
   - Acceptance: A3, A10, A11, A13
141. **MT141 缺口关闭与阻塞项清单**
   - Blocked by: MT121, MT130, MT134, MT136, MT138, MT140
   - Delivers: 汇总全部覆盖证据中的缺口与未验证项，关闭可修复缺口，并把真实阻塞项显式列出。
   - Acceptance: A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13
142. **MT142 独立 Review 与完整范围代码审查**
   - Blocked by: MT141
   - Delivers: 由独立验证者与 reviewer 对完整交付范围做 Spec 合规与代码质量审查，并完成完整范围代码审查与复审。
   - Acceptance: A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13
143. **MT143 统一上线候选包与证据汇总**
   - Blocked by: MT142
   - Delivers: 在缺口关闭与审查通过后形成统一上线候选包：变更范围、迁移与回退程序、验证命令与结果、审查结论；生产执行仍需用户单独授权。
   - Acceptance: A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13
