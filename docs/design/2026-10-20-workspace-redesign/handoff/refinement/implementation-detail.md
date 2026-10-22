# 第二轮细化：首批执行合同与交接交互

状态：待用户审阅；本轮仍只有文档授权。本文补充 implementation-spec 和 task-dag，不是第二套执行Ledger。若本文识别出旧稿过度承诺，以下说明优先；正式实施前将其合入同一份 docs/plans 首批计划。

## 1. 本轮补齐的缺口

| 缺口 | 收敛决定 | 对执行的影响 |
| --- | --- | --- |
| 首批23页容易被理解成三种代表页 | P01–23各自签收；T05八个配置页、T06八个观测页不能靠P07/P03截图替代 | route-acceptance每页必须有pass/fail/blocked |
| T01–03 source_pages含76页容易扩大授权 | foundation的source_pages表示影响面；只有P01–23是B1页面交付，其他只测共享层回归 | 后续页面专题布局/新视图仍未授权 |
| 最早被import的组件就成永久owner | 改为“当前Task唯一写入者”；后续Task可通过预先登记的串行所有权转移继续修改同一文件 | 不必为普通后续业务样式修改都倒派给旧Agent |
| 原生CSS变量有值，不等于wrapper真正采用 | 分别检查原生组件、wrapper、业务override、portal四层computed style | T01与T02各有不同验收，不混成改Token即可完成 |
| DetailPanel草稿保留原稿没有可行性证据 | 明确当前分支会重挂详情；不能声称只改480常量就能保留本地表单 | T03先做生命周期RED与方案验证，见§4 |
| 所有Task都重跑完整app两层测试 | 按修改风险分层；Task跑相关用例，公共层/批次再跑完整app两层 | 命令入口不变，覆盖不得减，避免机械重复运行 |
| 移动自动收起和用户偏好关系含糊 | 写明状态优先级、事件与存储效果 | 不靠effect跟踪effectiveOpen后持久化 |
| 交接提示词误称用户“已经审阅批准” | 提示词只写“本次采用此规格并授权指定范围”，不编造历史批准 | 发送提示词是未来启动授权；本轮不是 |

## 2. 首批可审阅成果与执行顺序

| Task | 一次可独立检查的成果 | 放行前必须看到的证据 |
| --- | --- | --- |
| T01 | 两主题值源、原生映射和legacy别名统一 | 主题变量解析无循环/无意外fallback；原生Button/Input/Surface状态计算值；主题存储路径未新增 |
| T02 | wrapper状态、尺寸与浮层视觉接入 | 六variant/八size；native ref/onChange/submit/anchor仍正确；嵌套弹窗焦点与ESC |
| T03 | 三壳尺寸、持久化隔离、PageShell、DetailPanel阈值 | 280/256/64实测、672/1024上限；resize无存储写入；879/880/959/960和生命周期案例 |
| T04 | P06分组列表、P07工作详情 | 所有现有分组/待办/活动/配置/管理操作可达；长名和空/错误/只读 |
| T05 | P08–15各配置页及其浮层 | 每页一次主要操作路径、保存失败保留输入、权限/敏感值检查 |
| T06 | P16–23完整观测链 | 列表→详情/刷新/Back、guard拒绝、同步/禁用/故障/空、单位/缺失/下载 |
| T07 | P01–05完整聊天路径 | 首页→新会话→已有单聊/群聊；IME、附件失败、停止/重试、滚动、右栏URL与控制 |
| T08 | 首批完整签收包 | 23页覆盖、共享层跨页回归、最终同版本验证、独立Spec/quality与OCR |

执行顺序继续串行T01→…→T08。顺序中的质量gate不等于产品或数据依赖；不为了保持编号引入接口依赖，也不因为现有组件互相import就判定视觉任务循环。

## 3. 侧栏状态转移表

保留 `openbot-sidebar` 和 expanded/collapsed词汇，不增加第二个持久化key。

状态：`preferredOpen:boolean` 从parseStoredSidebarOpen初始化；`manualOverride:boolean|null` 仅当前外壳挂载期；`responsiveCompact:boolean` 由布局条件决定；`mobileOpen:boolean` 使用现有mobile状态。

桌面有效open：`manualOverride ?? (responsiveCompact ? false : preferredOpen)`。viewport<768时只读mobileOpen决定Drawer，桌面状态保留但不控制Drawer。responsiveCompact仅对多面板页1280–1439生效；其他页面false。

| 事件 | 状态效果 | 持久化 |
| --- | --- | --- |
| 首次挂载 | preferredOpen读取已有key；manualOverride=null；mobileOpen=false | 不写；不把缺失key自动补成expanded |
| resize/ResizeObserver/路由条件变化 | 重新计算responsiveCompact与effectiveOpen | 不写 |
| 桌面显式toggle/快捷键 | next=!effectiveOpen；preferredOpen=next；manualOverride=next | 仅此处applySidebarOpen(next) |
| 移动toggle/遮罩/ESC | 仅改变mobileOpen | 不写桌面偏好 |
| 外壳卸载/刷新 | 清除本地manualOverride，下一外壳从key初始化 | 不另写 |

实现保留SidebarShell现有props，增加可选responsiveCompact=false；`SidebarProvider.onOpenChange`应走显式desktop事件路径，不能让自动计算调用它。布局渲染不做存储effect。对应测试在缺失key/expanded/collapsed三种初始条件验证，spy覆盖“resize调用0次setItem、显式toggle一次”。

## 4. DetailPanel生命周期：先验证，再签收

源码事实：当前 detail-panel.tsx 在 `overlay ? <Sheet> : <motion.div>` 两个不同React分支渲染detail；跨阈值会重挂详情。`Sheet` 的modal参数已被忽略，Drawer实际总是modal，不能靠 `modal=false` 把它当桌面非模态面板。SkillFields通过useForm持有草稿，ScheduledTaskEditor通过本地useState持有form/seeded/error。根部颜色变化与常量变化不会修复这些生命周期问题。

T03的确定目标仍为：DEFAULT_DETAIL_WIDTH400、MIN_MAIN_WIDTH480；只在实际content width不足时转Sheet，电脑/工作坊分别400/480。resize不是用户关闭，不得调用onClose、不改search；显式关闭沿用原卸载/重开合同。

**实施方法的硬边界：**保留HeroUI modal的焦点/滚动锁；禁止复制两份相同detail、靠改变portal container假装React实例稳定、使用已忽略的modal=false、通用DOM序列化恢复表单、localStorage保存敏感草稿。

T03先完成一个受控生命周期用例：detail内输入本地草稿、设置一个滚动位置并记录mount计数；打开后按C=960→959→960切换，验证onClose=0、URL不变、草稿保留。该测试在原实现应暴露重挂问题。测试实现与库API可行性由执行者按实际安装类型选择，不能在计划阶段宣称已经证明。

B1允许的解决路径：让需要持久的表单状态归属于断点分支之外的调用者，并传给detail编辑组件；HeroUI Sheet仍负责窄屏行为。具体字段沿用现有SkillFormValues/FormState，不引入统一业务任务模型。跨断点的“值/dirty状态保留”与“所有组件DOM节点不变”是两个要求：本批承诺前者；电脑连接/控制释放必须单独回归，不能仅用表单测试推断。

如该修复需要触碰P24 Skills/P28 Craft tasks：它是T03共享阈值的**兼容修复子步骤**，只允许状态所有权和必要prop接线，不允许顺带实施这两页专题视觉/多面板。正式Brief必须列出实际必要文件和类型，再串行转移相应文件所有权；不提前把整页宣布完成。相关候选文件为skills.tsx、new-skill.tsx、edit-skill.tsx、skill-fields.tsx、craft/tasks.tsx、scheduled-task-editor.tsx。此兼容修复范围须在最终启动提示词明确列明；如果最终只授权严格原owned_files，则不能承诺该额外修复已经授权。

若仍无法在现有依赖/接口约束下证明可行，停止T03受影响步骤，保留RED证据和具体技术冲突；可继续T01/T02独立验证，但不得把T03置verified或偷偷删除保留草稿验收。

## 5. 文件所有权：允许串行转移，禁止同时写

原tasks.json file_owners用作首次派发的默认分配，不是跨整个项目永不变化的禁令。每次转移记录 `path/from_task/to_task/prior_checkpoint/change_reason/allowed_change/review_scope`。只有原写入者已停止、前检查点已保存，才能开始下一写入者；新Task验证覆盖对已有消费者的影响。

需预先登记的业务文件：

| 文件 | 首次所有权 | 允许的后续转移 |
| --- | --- | --- |
| bot-profile/access.tsx、suggestions/proactive-panel.tsx | T04 | T05配置阶段；不改API/能力判断 |
| bot-profile/attention.tsx、channels/avatar.tsx | T03 | T04/T07；仅业务展示与尺寸，不改分组/状态算法 |
| skills/skill-fields.tsx、skill-tools.tsx | T07默认 | 若T03生命周期修复需要先转给T03，再在T07/T12显式转回；保持字段/提交合同 |
| ui/button/input/select等 | T02 | 下游仅在核实公共缺陷时通过修复Task转移，不为单页局部样式随意改公共API |
| craft/scheduled-task-editor.tsx | T09默认 | 可提前转给T03做§4有限兼容修复，T09以后再移交；B1不做Craft多面板 |

下游引用现有组件不代表必须等未来视觉owner完成；只有消费新增/变更接口或同版本验证要求才建立硬依赖。串行实施顺序仍保持。Task Brief列清当前有效owner，不能仅说“按原表”同时又授权多个Agent写。

## 6. 验证分层与每轮产物

入口命令沿用verification-plan，不重新发明测试运行器。当前清单中的native/driven归属在执行当时再核验；新增测试也要纳入覆盖audit，不能依赖空收集通过。

- T01/T02/T03：各自针对性用例与真实DOM检查；公共层终态执行完整app native+driven一次，绑定公共层最终检查点。若之后公共层又变更，则补受影响检查。
- T04/T05/T06/T07：首先运行各Task test_files中的相关用例；driven单文件bun test仅用于诊断，正式结果由匹配的e2e group报告承载；native用e2e文件过滤。Task新增的行为测试必须实际被收集。
- T08：在最终首批检查点运行app typecheck/build、变更静态检查、完整app native+driven、浏览器验收和独立Review/OCR。只有同hash有效证据可以复用；不能把早期T01结果用于后期被修改的公共文件。
- 每个Task不机械重复完整app两层；task-dag现列的完整命令是可用入口和批次覆盖要求，正式计划需按本节列清本Task哪些实际跑、哪些在gate汇总。

产物最少包括PRE/POST、diff package、命令与exit/收集数量、fixture来源、截图trace索引、Spec/quality结论、OCR范围与覆盖。报告分pass/fail/blocked；skip和未覆盖不算pass。

## 7. Code Agent的交互合同

最终提示词必须明确是“写实施计划”还是“实施代码”，不能一边说停止在计划一边授权自动实施。尚未收到用户对范围问题的回答时，默认沿用此前推荐B1，并明确这只是交接模板的建议范围，本轮不启动它。

Code Agent启动后应：

1. 用简短清单报告实际工作区、基线漂移、采用范围与可读事实源。
2. 自行解决CSS和已确定接口内的普通实现选择；保存正式计划后按已授权范围继续。
3. 遇到缺少fixture/权限/真实冲突，提出一个具体问题，给推荐选项和影响，同时继续独立任务；不得泛泛询问“是否继续”。
4. 必须等待回答的情形：扩大生产范围、改变领域/权限/导航合同、缺少安全环境而需写真实业务数据、提交/发布等尚未授权动作。时间经过不算批准。
5. 状态询问时简短回答然后继续原任务；上下文恢复先读Ledger/Git，不重做已完成Task。

本轮无生产实施、无独立代码Review、无OCR结论；新增细化不能冒充技术方案已在浏览器证明可行。
