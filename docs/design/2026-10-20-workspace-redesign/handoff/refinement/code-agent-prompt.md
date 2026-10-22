# 可复制给 Code Agent 的首批实施提示词

使用说明：以下正文是待用户发送的交接模板。当前对话只细化文档，并未启动实施。默认范围为推荐首批B1；用户若选择仅计划或全站实施，必须先改正文中的授权范围，不能让执行Agent猜测。

---

你接手 OpenBot HeroUI 工作台视觉改造。请依据已完成的设计细化，编写正式实施计划，并在本次授权范围内完成代码、验证、独立Review、OCR及必要修复。

## 一、范围与工作区

本次采用以下规格作为实施依据：

`docs/design/2026-10-20-workspace-redesign/handoff/refinement/`

先读README、implementation-detail.md、implementation-spec.md、theme-contract.json、task-dag.md、tasks.json、route-acceptance.json、verification-plan.md、execution-ready.md。implementation-detail.md是第二轮补充，明确生命周期风险、串行所有权转移、测试分层与交互规则；需要合入正式计划，不另建竞争事实源。

授权范围：首批T01–T08，主题/公共wrapper/骨架→Bots与详情配置/观测链→首页和聊天，共P01–P23。共享层对其他页面做回归冒烟；不自动开始T09–T21。

额外允许T03为DetailPanel阈值变更完成必要的草稿兼容修复：可有限修改P24 Skills/P28 Craft tasks相关编辑状态所有权和prop接线，必须按implementation-detail §4–5事先列出文件、类型、转移记录和验证。此例外不授权这些页面的专题视觉改造、Craft多面板、业务协议或新功能。

工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`
分支：`feat/heroui-v3-migration`
交接记录HEAD：`203d0f0244b2f898218fa12027089c631e8448d9`

启动实际核验，读取AGENTS.md、CONTEXT.md和refinement中的baseline/ledger/validation/delivery-manifest。存在必须保留的大量未提交迁移；实际漂移记录后判断影响，不回退他人工作，不把全部脏文件算成本次新增。

禁止reset/clean/共享stash、本地提交、推送、合并、发布/部署、安装或升级产品依赖、创建对外Issue。没有新Issue需求，不重新摄取或实施原H01–H15。

## 二、先写计划，再实施

读取布局合同及五张原图：

- docs/design/2026-10-20-workspace-redesign/handoff/layout-contract.md
- handoff/references/ 下五张图片。

按using-git-worktrees核验当前已隔离的worktree；按writing-plans形成：

`docs/plans/2026-10-20-workspace-redesign-b1.md`

建立持久Ledger，记录本次授权、BASE、实际脏基线、任务、文件当前owner、前后检查点、测试、Review与OCR。正式计划引用原规格/逐页验收；旧task-dag标记为历史细化并留下正式计划指针，不维护两套活跃状态。

计划必须落实implementation-detail里的状态转移与生命周期验收，细化每个Task实际修改、接口和测试归属。保存并展示计划路径后直接执行，不再问是否开始，不重新做风格发现。

使用仓库SDD流程，串行T01→T08。本次显式允许未来实施用子Agent；上一轮“不派Agent”仅适用于文档细化。

- 生产前端：frontend_implementer。
- 只读行为验证：frontend_validator。
- 独立Spec compliance与quality：reviewer。
- 主控负责集成、Ledger、OCR与修复编排。

每次只派一个Task Brief、必要事实源/接口/当前文件所有权/报告路径，使用干净上下文，子Agent不得再派Agent。专业角色升级按AGENTS记录具体原因，不能因任务多直接改用default。

## 三、执行中的确定合同

1. 完整映射HeroUI原生变量与ob值，保持accent=强调填充、muted=弱文本；必要控件边界与装饰线分开。
2. wrapper保留ref、原生事件一次、表单/anchor、键盘/portal语义；不能只改Token却留下neutralizer和业务override。
3. 应用280px、设置/后台256px、轨总宽64px；prose672/wide1024/chat720为最大宽。
4. 用户偏好、自动compact与mobileOpen分离。只有显式桌面toggle/快捷键写openbot-sidebar；resize/首次挂载不写。状态算法按implementation-detail §3。
5. DetailPanel主区480，电脑右栏400/工作坊480；边界880/960是容器content width，不是浏览器宽度。
6. T03先证明草稿生命周期用例；现有Sheet modal=false无效，不能用它伪造桌面非模态Drawer。草稿状态提到断点分支之外；不复制detail，不保存敏感draft到localStorage。
7. 保留Bots分组/隐藏项/原有配置管理与权限；保留观测guard/Outlet/返回链及缺失、禁用、同步、上游故障区别。
8. 聊天复用settings/watch/workshop和权威运行状态；保留IME、草稿附件、流式滚动、停止/重试、Back与电脑控制释放。
9. 不增加搜索/筛选/指标/审批中心/统一任务API，不改变个人/公司付款主体、租户/团队/资源归属。I-01/I-02排除，I-03不合并。
10. 评审索引外层、P编号、源码说明与生成图示例数据不进入产品；生产字号按Spec。

文件唯一owner表示同一时刻一个写入者。按implementation-detail §5允许预先登记的串行转移；记录path/from/to/前检查点/允许改动/回归范围。不能让下游Agent越权写，也不能为了普通后续样式修改反复倒派旧任务。

## 四、检查点、测试与真实浏览器

不commit。每Task PRE/POST保存HEAD/status、tracked staged/unstaged diff、范围内untracked完整内容和hash，生成包含新增/删除文件的真实增量package。既有迁移单列基线。

测试前读取ADR0008、e2e.unit.config.ts、e2e-bun-suites.json和package scripts；命令取verification-plan。按implementation-detail §6安排相关Task检查和公共层/最终完整app检查，不机械地每个Task重跑全部套件。native/driven分别有实际收集与执行证据，新测试不许静默漏跑。

每轮独立输出目录。app typecheck/build、变更静态检查、相关行为和最终app两层验证均需真实结果；不得为纯色值写CSS镜像单测。生成脚本导致的文件变化也进入检查点。

浏览器P01–23各自验收，至少390/768/1280/1440四视口、双主题双语、长内容、权限/异常、200%缩放、焦点和reduced-motion。具体场景与证据字段按verification-plan，不用代表页截图或visual-atlas渲染次数替代逐页签收。

优先只读使用已有安全测试环境、身份和fixture；可启动并管理属于本任务的本地开发进程，不杀未知进程、不改共享.env、不输出凭据。Bot/channel/run等ID来自实际服务或产品链接，证据记录最终真实URL。需要写fixture但无法证明环境隔离时先问具体范围，不在真实公司执行付款、清理、授权、删除或外发消息。

## 五、独立Review、OCR与修复

验证者不得改业务/测试来修绿；实现者不得批准自己。Spec与quality分别判定，报告绑定同一POST hash；代码再变更，补受影响验证和Review。

主控按open-code-review Skill运行OCR，始终--audience agent。workspace审查必须覆盖实际未提交交付；本次真实增量与首批完整交付都需要覆盖。若存在本次已提交范围，额外覆盖记录的真实BASE到HEAD。空BASE..HEAD不是证据。

保留每轮scope/检查点/exit/warning/skipped/coverage/provider信息。有效critical/high/medium必须通过修复计划、验证、独立复审及OCR复审消除。本次包含范围内修复授权，无需每个finding重新问。凭据/工具/覆盖失败如实报告，不编造通过。

## 六、与你交互的方式与停止条件

启动简短报告实际工作区、基线漂移、采用范围和下一Task。普通CSS/接口内实现选择自行解决；不要泛问“要继续吗”。

遇到真实冲突或必要输入，提出一个具体问题，给推荐选项及影响，同时继续不依赖答案的工作。以下依赖动作必须等回答：扩大生产范围、改变领域/权限/导航合同、写入尚未确认隔离的业务环境、提交或发布。等待时间不算批准。

状态询问简短回答后继续原任务。恢复先读Ledger/Git，不重派已verified任务。环境缺项保留具体证据，相关验收标blocked，不降低标准或用旧截图替代。

结束时报告完成的Task/逐页验收、实际改动、命令/证据、最终检查点、Spec/quality/OCR结论及限制。只有必要验证和完整审查均通过才称B1完成；真实阻塞必须明确说明。

完成T08后停止，不自动做T09及后续，不提交/推送/合并/发布。
