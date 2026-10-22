# 设计与源码差异表

状态：待用户审阅；静态源码核对，不是运行验收。源码行证据与哈希见 source-evidence.json；完整当前基线见 baseline.json。生产文件未修改。

## 关键差异与明确决定

| ID | 分类 | 源码证据 | 本稿决定 | 阻塞首批？ |
| --- | --- | --- | --- | --- |
| G01 | 视觉变化 | styles/heroui-theme.css 空 ob-theme；legacy-ui-bridge 不声明 background/foreground/border/radius/success | T01完整原生变量表，不仅改ob值 | 需审阅Spec后放行 |
| G02 | 视觉变化 | tokens.css field-border透明；legacy input→ob-border；input/textarea中性化class | 字段1px control边界、稳定填充；legacy input改control；muted始终文本 | 已确定，无技术歧义 |
| G03 | 布局变化 | _app.tsx width340；settings/admin route width300；ui/sidebar icon3.2rem | 280/256/64，prose672/wide1024 | 已确定 |
| G04 | 布局变化 | DetailPanel MIN_MAIN_WIDTH400、default400；channel SCREEN400/WORKSHOP480 | 主下限480；右宽400/480保持；880/960阈值，所有调用者验证 | 已确定；不是纯换肤 |
| G05 | 既有能力 | channel route validateSearch/show settings/watch/workshop互斥；WorkshopPanel有process/files/artifacts/usage/share/schedules | 复用既有视图/权威状态，不造统一任务API或第二套运行状态 | 不阻塞 |
| G06 | 新增行为（仅局部视图） | craft route固定420输出；ChatPanel本地draft；OutputPanel条件渲染tab；PreviewTab同iframe fullscreen | T09稳定挂载+hidden/inert+首次懒挂载tab；按C1124/900和viewport切换 | 后续B2，不阻塞首批 |
| G07 | 既有能力 | BotRoster调用groupRoster、hidden本地展开；BotProfile及settings-rows/manage | 保留分组；详情配置不默认折叠；不造指标/搜索 | 不阻塞 |
| G08 | 既有能力/布局变化 | knowledge.$kbId AddDocument→UploadTasksPanel→DocumentList→RetrievalTest；已有keyword/sort/selected/bulkDelete | 原顺序保留，宽屏检索320辅助列，窄屏单列；保留真实筛选/批删 | 后续B5 |
| G09 | 视觉变化 | app/DESIGN.md声明issue502默认HeroUI；README当前新方向仍提案 | 它是当前基线；本稿待审阅的新方向覆盖候选，不冒称已批准 | 用户审阅本稿 |
| G10 | 新导航候选 | Bot观测路由guard；admin enterprise/observability现有导航未完整归组 | I-01/I-02单独决定；本稿均不实施，I-03不合并 | 不阻塞基础方案 |
| G11 | 既有能力 | CONTEXT payer/tenant/workspace；usage/orders/billing模型授权组件 | 个人/公司账户和登记/授权不因视觉统一混并 | 不阻塞；发现冲突即停相关Task |
| G12 | 证据差异 | visual-atlas纯HTML；h15 REPORT UI engine blocked、全仓194红；索引304状态不含生产DOM | 新生产证据单独取得，不把既有报告或atlas当新checkpoint通过 | 浏览器真实runtime/身份是执行前置 |
| G13 | 文档差异 | handoff source-baseline155项仅SHA256.json变化 | 记录实际哈希、不回退；路由87声明无变化 | 不阻塞 |
| G14 | 视觉变化/语义保留 | button cva+HERO_VARIANT、mergeRefs/adaptRender；router-link真anchor | 修改视觉class，不重写ref/原生事件/link语义；旧“black action”注释同步修正 | T02必须验证 |
| G15 | 布局变化 | sidebar-shell effect持久化open，mobile20rem变量未消费、primitive18rem | 显式偏好与responsiveCompact分离；移动宽度统一真正消费的变量 | T03必须验证 |
| G16 | 布局变化 | PageShell文档滚动与_app内部滚动不同 | 保留两种纵向滚动合同，不把设置页强行h-svh裁切 | 不阻塞 |

## 五图落实矩阵

| 图 | 实施结构 | 排除/差异 | Task/证据 |
| --- | --- | --- | --- |
| 01 chat | 导航→会话顶栏/消息/Composer→按需上下文 | 不造搜索/审批中心/统一任务API；示例矛盾状态不采纳 | T03/T07；P03实际URL+workshop/watch/settings，各880/960边界 |
| 02 knowledge-mobile | 身份→添加→上传→文档→检索→结果 | 排除顶部评审控制、P索引、源码说明和页脚；不固定截图宽度 | T16；P59真实390px及宽屏辅助列 |
| 03 settings-light | 单层设置导航→居中分组行 | 排除外侧P01索引；字号按产品14/22而非缩略图 | T03/T10；P29亮暗/label/保存失败 |
| 04 Craft | 全局导航/session/chat/output，多种本地视图 | 排除评审外框；保留224/480/420可读尺寸和同一iframe | T09；P27运行中390↔1440及Tab保留状态 |
| 05 Bots | 应用导航→标题/创建→需要你/置顶/自己/共享/隐藏 | 排除外层P索引、虚构资源与假头像，不改算法 | T04；P06分组/长名/隐藏展开/错误 |

## 逐页差异绑定

每行的“既有能力”来自路由与递归源组件的静态核对，动态成功状态必须由实施验证取得。V=视觉变化；L=布局变化；N=局部视图行为。这里不把目标状态等同已经在本机复现。

| 页 | 分类与源码 | 保留能力 | 决定与差异 | 首批/阻塞 |
| --- | --- | --- | --- | --- |
| P01 / | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/_app/index.tsx` | 发送消息、选择同事 | T01；主输入是首要焦点；首页不添加无来源的任务统计或推荐内容。；探索区改为可横滑列表，输入区保留触控空间。 | B1，审阅后无额外产品决定 |
| P02 /channel/new | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/_app/channel/new.tsx` | 选择收件人、发送首条消息 | T01；；收件人换行排列，输入区保持可见；不预先创建空频道。 | B1，审阅后无额外产品决定 |
| P03 /channel/$channelId | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/_app/channel/$channelId.tsx` | 发送/停止/重试、打开上下文面板 | T01；右栏仍是三种互斥视图；保留搜索参数、返回关闭、输入法与滚动锚点契约。；主对话优先，右栏转全宽 Sheet；输入法与软键盘不遮挡发送。 | B1，审阅后无额外产品决定 |
| P04 /group/$channelId | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/_app/group/$channelId.tsx` | 查看成员、发送消息 | T01；不添加单 Bot 专用电脑/资料面板。；头像与名称同行，成员详情按需展开；消息不压成多列。 | B1，审阅后无额外产品决定 |
| P05 /bot | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/_app/bot.tsx` | 开始新对话、打开电脑 | T01；保留独立入口语义，不静默重定向至频道。；复用聊天的单主区与 Sheet 规则。 | B1，审阅后无额外产品决定 |
| P06 /bots | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/_app/bots.index.tsx` | 创建 Bot、打开 Bot 详情、展开隐藏项 | T01；保留现有分组与优先级；不用卡片网格替代需要快速扫描的列表。；行列表保留，摘要允许两行，状态与操作不挤占名称。 | B1，审阅后无额外产品决定 |
| P07 /bots/$agentId | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/_app/bots.$agentId.index.tsx` | 打开对话、处理待办、启用/暂停、进入配置 | T01；状态与活动优先，配置其次；不新增无数据支撑的绩效指标。；纵向排列，待办置前；配置/管理组默认展开，危险操作独立（取代旧稿折叠候选）。 | B1，审阅后无额外产品决定 |
| P08 /bots/$agentId/responsibilities | 既有能力 / 视觉变化；`app/src/routes/_authed/_app/bots.$agentId.responsibilities.tsx` | 新建职责、编辑职责、启停职责 | T01；；弹窗适应整屏并保留底部提交，长目标自动换行。 | B1，审阅后无额外产品决定 |
| P09 /bots/$agentId/reach | 既有能力 / 视觉变化；`app/src/routes/_authed/_app/bots.$agentId.reach.tsx` | 配置联系渠道、修改投递目标 | T01；复用 ReachingYou 现有字段与操作，不推导新的渠道能力。；字段单列，目标长地址换行。 | B1，审阅后无额外产品决定 |
| P10 /bots/$agentId/memory | 既有能力 / 视觉变化；`app/src/routes/_authed/_app/bots.$agentId.memory.tsx` | 管理来源、设置主动研究、打开个人记忆 | T01；明确 Bot 来源与用户已确认的个人记忆是不同对象。；来源与范围说明不截断，配置保持单列。 | B1，审阅后无额外产品决定 |
| P11 /bots/$agentId/approvals | 既有能力 / 视觉变化；`app/src/routes/_authed/_app/bots.$agentId.approvals.tsx` | 添加/编辑规则、删除规则 | T01；不把规则配置页改成虚构的全局待办收件箱。；规则条件分行展示，作用对象保持可见。 | B1，审阅后无额外产品决定 |
| P12 /bots/$agentId/routines | 既有能力 / 视觉变化；`app/src/routes/_authed/_app/bots.$agentId.routines.tsx` | 管理例行任务、查看运行 | T01；；任务名、调度与状态分层；次要操作放菜单。 | B1，审阅后无额外产品决定 |
| P13 /bots/$agentId/access | 既有能力 / 视觉变化；`app/src/routes/_authed/_app/bots.$agentId.access.tsx` | 管理技能、管理授权、配置交接 | T01；不把部署可连接、个人已授权和 Bot 已授予访问混成一个开关。；每种能力单独分组，范围说明保持完整。 | B1，审阅后无额外产品决定 |
| P14 /bots/$agentId/sharing | 既有能力 / 视觉变化；`app/src/routes/_authed/_app/bots.$agentId.sharing.tsx` | 修改共享范围、管理发布 | T01；个人资源与团队发布继续遵守原权限。；共享范围先于操作，长成员信息换行。 | B1，审阅后无额外产品决定 |
| P15 /bots/$agentId/setup | 既有能力 / 视觉变化；`app/src/routes/_authed/_app/bots.$agentId.setup.tsx` | 编辑身份、修改连接、管理回调凭据 | T01；；单列字段，敏感值保持现有掩码与操作方式。 | B1，审阅后无额外产品决定 |
| P16 /bots/$agentId/runs | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/_app/bots.$agentId.runs.tsx` | 选择运行、切换筛选 | T01；同步中不表现为失败，未知数量不显示为 0。；记录改为摘要行；ID 可复制的能力以实际已有入口为准。 | B1，审阅后无额外产品决定 |
| P17 /bots/$agentId/runs/$bindingId | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/_app/bots.$agentId.runs.$bindingId.tsx` | 查看已有引用、展开步骤 | T01；保留当前按步骤分组的事实，不虚构完整 Trace 瀑布图。；概览单列，步骤长内容折叠；禁止整页横向滚动。 | B1，审阅后无额外产品决定 |
| P18 /bots/$agentId/datasets | 既有能力 / 视觉变化；`app/src/routes/_authed/_app/bots.$agentId.datasets.tsx` | 打开数据集 | T01；；名称与版本同组显示，辅助字段后移。 | B1，审阅后无额外产品决定 |
| P19 /bots/$agentId/evaluations | 既有能力 / 视觉变化；`app/src/routes/_authed/_app/bots.$agentId.evaluations.tsx` | 打开数据集、打开实验结果、比较实验 | T01；数据集页与评估页复用列表但保留各自路由。；两区上下排列，筛选按内容换行。 | B1，审阅后无额外产品决定 |
| P20 /bots/$agentId/evaluations/$datasetId | 既有能力 / 视觉变化；`app/src/routes/_authed/_app/bots.$agentId.evaluations.$datasetId.tsx` | 选择版本、查看数据集内容 | T01；；版本控件占满可用宽度，结构化内容局部滚动。 | B1，审阅后无额外产品决定 |
| P21 /bots/$agentId/evaluations/experiments/$experimentId/$executionId | 既有能力 / 视觉变化；`app/src/routes/_authed/_app/bots.$agentId.evaluations.experiments.$experimentId.$executionId.tsx` | 查看样本、使用现有执行操作 | T01；；样本摘要先行，明细按需展开；指标不强制多列。 | B1，审阅后无额外产品决定 |
| P22 /bots/$agentId/evaluations/experiment-comparisons | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/_app/bots.$agentId.evaluations.experiment-comparisons.tsx` | 选择比较对象、执行比较、查看差异 | T01；数值差异必须标明方向、单位与缺失，不能只用红绿表达结论。；窄屏左右实验改为上下；同一指标的基线与候选相邻。 | B1，审阅后无额外产品决定 |
| P23 /bots/$agentId/exports | 既有能力 / 视觉变化；`app/src/routes/_authed/_app/bots.$agentId.exports.tsx` | 查看任务、下载可用导出 | T01；；任务状态与操作同组，错误原因可展开。 | B1，审阅后无额外产品决定 |
| P24 /skills | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/_app/skills.tsx` | 新建技能、编辑技能 | T01；；编辑转 Sheet，长指令有独立滚动，不遮挡提交。 | B1，审阅后无额外产品决定 |
| P25 /routines | 既有能力 / 视觉变化；`app/src/routes/_authed/_app/routines.tsx` | 管理任务、查看现有运行 | T01；；每项明确所属 Bot，避免与 Craft 任务混淆。 | B1，审阅后无额外产品决定 |
| P26 /craft | 既有能力 / 视觉变化 / 布局变化 / 新增局部视图行为；`app/src/routes/_authed/_app/craft/index.tsx` | 创建会话、选择会话、打开计划任务 | T01；；默认显示会话列表，选择后进入对话；不自动创建会话。 | B1，审阅后无额外产品决定 |
| P27 /craft/$sessionId | 既有能力 / 视觉变化 / 布局变化 / 新增局部视图行为；`app/src/routes/_authed/_app/craft/$sessionId.tsx` | 发送/停止、切换输出、管理会话 | T01；建议 1024–1279px 输出按需展开；不擅自新增拖拽分栏或后台能力。；小于 768px 使用对话/输出视图切换；会话列表按需打开。 | B1，审阅后无额外产品决定 |
| P28 /craft/tasks | 既有能力 / 视觉变化 / 布局变化 / 新增局部视图行为；`app/src/routes/_authed/_app/craft/tasks.tsx` | 新建任务、编辑任务 | T01；与 Bot routines、工作坊 schedules 保持独立领域入口。；列表优先，编辑 Sheet；时间必须附带时区上下文。 | B1，审阅后无额外产品决定 |
| P29 /settings | 既有能力 / 视觉变化；`app/src/routes/_authed/settings/index.tsx` | 切换偏好、编辑常驻指令 | T01；；设置标签在上、控件在下；键位标签不挤压说明。 | B1，审阅后无额外产品决定 |
| P30 /settings/notifications | 既有能力 / 视觉变化；`app/src/routes/_authed/settings/notifications.tsx` | 管理路由、管理现有设备入口 | T01；；投递目标和结果保持相邻，日志细节展开。 | B1，审阅后无额外产品决定 |
| P31 /settings/approvals | 既有能力 / 视觉变化；`app/src/routes/_authed/settings/approvals.tsx` | 修改确认偏好、维护规则 | T01；；优先显示规则适用范围，复杂条件换行。 | B1，审阅后无额外产品决定 |
| P32 /settings/memory | 既有能力 / 视觉变化；`app/src/routes/_authed/settings/memory.tsx` | 记住事实、管理已有记忆 | T01；用户已确认事实与候选建议不混合为同一已知事实。；记忆正文可读，来源和操作放次行。 | B1，审阅后无额外产品决定 |
| P33 /settings/connected-accounts | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/settings/connected-accounts/index.tsx` | 连接/管理账号、查看授权 | T01；服务可用与用户本人已连接必须显示为不同状态。；搜索全宽，服务名/身份/状态分层。 | B1，审阅后无额外产品决定 |
| P34 /settings/connected-accounts/$key | 既有能力 / 视觉变化；`app/src/routes/_authed/settings/connected-accounts/$key.tsx` | 连接/重新连接、撤销连接 | T01；；主操作明确作用于哪个账号；长授权说明不截断。 | B1，审阅后无额外产品决定 |
| P35 /settings/model-access | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/settings/model-access.tsx` | 输入绑定码、预览并确认授权、管理已有授权 | T01；管理员登记 Bot 不等于用户授予模型访问；不自动确认。；输入、预览和确认连续单列，确认对象始终可见。 | B1，审阅后无额外产品决定 |
| P36 /settings/passwords | 既有能力 / 视觉变化；`app/src/routes/_authed/settings/passwords.tsx` | 删除登录信息 | T01；；显示站点和账号，不在列表暴露密码。 | B1，审阅后无额外产品决定 |
| P37 /settings/components-gallery | 既有能力 / 视觉变化；`app/src/routes/_authed/settings/components-gallery/index.tsx` | 打开组件预览 | T01；；两列逐步变单列，预览尺寸受限且不抢滚动。 | B1，审阅后无额外产品决定 |
| P38 /settings/components-gallery/$name | 既有能力 / 视觉变化；`app/src/routes/_authed/settings/components-gallery/$name.tsx` | 查看组件 | T01；；预览横向内容只在内部滚动，元信息在下。 | B1，审阅后无额外产品决定 |
| P39 /settings/usage | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/settings/usage.tsx` | 使用已有购买/升级入口、筛选消费 | T01；公司与个人账户不可合并展示成一个余额；不增加虚构用量图。；账户摘要纵向排列，消费表转摘要行或局部横滚。 | B1，审阅后无额外产品决定 |
| P40 /settings/orders | 既有能力 / 视觉变化；`app/src/routes/_authed/settings/orders.tsx` | 翻页/查看现有订单信息 | T01；；订单金额、状态、时间优先；来源说明可展开。 | B1，审阅后无额外产品决定 |
| P41 /settings/invoices | 既有能力 / 视觉变化；`app/src/routes/_authed/settings/invoices.tsx` | 筛选账单、打开详情、下载 | T01；；详情单列，金额/币种/状态保留，下载入口不隐藏。 | B1，审阅后无额外产品决定 |
| P42 /admin | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/index.tsx` | 进入配置模块 | T01；维持目录型首页，不在没有聚合接口时改为统计仪表盘。；分组目录保持单列或两列；不新增指标占位。 | B1，审阅后无额外产品决定 |
| P43 /admin/credentials | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/credentials.tsx` | 添加凭据、管理现有凭据 | T01；；表单单列，敏感值只按已有安全契约展示。 | B1，审阅后无额外产品决定 |
| P44 /admin/bot-services | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/bot-services.tsx` | 注册服务、编辑服务 | T01；；地址换行，注册弹窗在小屏单列。 | B1，审阅后无额外产品决定 |
| P45 /admin/gateway | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/admin/gateway.tsx` | 保存现有配置、执行已有检查 | T01；地址、限流和凭据分组；不把连接成功等同于业务调用一定成功。；状态解释在表单前，错误贴近对应字段。 | B1，审阅后无额外产品决定 |
| P46 /admin/model-catalog | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/model-catalog.tsx` | 同步模型、修改已支持配置 | T01；；模型名称与能力摘要同行，技术 ID 次行。 | B1，审阅后无额外产品决定 |
| P47 /admin/boundaries | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/boundaries.tsx` | 配置策略、执行试运行 | T01；；输入→结果上下排列，拒绝原因完整可读。 | B1，审阅后无额外产品决定 |
| P48 /admin/approvals | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/approvals.tsx` | 修改团队策略、维护规则 | T01；；团队与个人设置标记清楚，规则条件换行。 | B1，审阅后无额外产品决定 |
| P49 /admin/computers | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/computers.tsx` | 管理主机目录、维护目录授权 | T01；；目录长路径局部滚动或换行，状态使用文字。 | B1，审阅后无额外产品决定 |
| P50 /admin/plugins | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/plugins/index.tsx` | 打开连接器、打开集成配置 | T01；；服务身份和配置状态优先，长描述换行。 | B1，审阅后无额外产品决定 |
| P51 /admin/plugins/$key | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/plugins/$key.tsx` | 启停服务、配置账号模式、管理 Bot/工具授权 | T01；模式改变的影响必须在原确认流程内展示。；服务状态在前，账号模式说明紧贴控件。 | B1，审阅后无额外产品决定 |
| P52 /admin/plugins/$key/bots/$agentId | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/plugins/$key_.bots.$agentId.tsx` | 修改共享使用授权 | T01；；确认操作前保留 Bot 和连接器名称。 | B1，审阅后无额外产品决定 |
| P53 /admin/plugins/$key/tools/$tool | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/plugins/$key_.tools.$tool.tsx` | 启停工具、修改规则 | T01；；长工具名换行，规则与解释相邻。 | B1，审阅后无额外产品决定 |
| P54 /admin/plugins/composio | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/plugins/composio.tsx` | 保存现有接入配置、管理集成 | T01；；字段单列，回调与密钥说明允许换行。 | B1，审阅后无额外产品决定 |
| P55 /admin/plugins/open-connector | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/plugins/open-connector.tsx` | 保存现有接入配置、管理连接器 | T01；；与 Composio 保持结构一致，保留各自字段差异。 | B1，审阅后无额外产品决定 |
| P56 /admin/skills | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/skills.tsx` | 编写技能、执行已有技能维护 | T01；与个人技能使用同一视觉，明确部署级范围。；长指令独立滚动，提交按钮可见。 | B1，审阅后无额外产品决定 |
| P57 /admin/market | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/admin/market.tsx` | 切换分类、查看资源、执行已有安装/创建入口 | T01；移除旧 Wb 视觉差异；不新增排行榜、评分、价格或推荐结论。；分类栏可横滑，资源网格降为单列；详情可滚动。 | B1，审阅后无额外产品决定 |
| P58 /admin/knowledge | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/knowledge.index.tsx` | 新建知识库、打开知识库、删除 | T01；；列表摘要两行，删除置次要动作。 | B1，审阅后无额外产品决定 |
| P59 /admin/knowledge/$kbId | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/admin/knowledge.$kbId.tsx` | 添加文档、管理文档、测试检索 | T01；不新增切片可视化或命中率指标；结果仅展示现有检索字段。；上传、文档和测试依次排列；宽屏检索测试可放辅助列。 | B1，审阅后无额外产品决定 |
| P60 /admin/learning | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/learning.tsx` | 保存现有学习参数 | T01；；目标与容器字段分组，长配置自动换行。 | B1，审阅后无额外产品决定 |
| P61 /admin/components | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/components/index.tsx` | 打开组件 | T01；；预览网格逐级降列。 | B1，审阅后无额外产品决定 |
| P62 /admin/components/$name | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/components/$name.tsx` | 打开配置、修改现有组件配置 | T01；；预览在上、信息在下，配置转全宽 Sheet。 | B1，审阅后无额外产品决定 |
| P63 /admin/playground | 既有能力 / 视觉变化 / 布局变化 / 新增局部视图行为；`app/src/routes/_authed/admin/playground.tsx` | 编辑输入、运行预览 | T01；不在重设计中扩大代码执行或网络权限。；编辑/预览切换，保留草稿；代码区域内部横滚。 | B1，审阅后无额外产品决定 |
| P64 /admin/people | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/people.tsx` | 执行已有角色与访问操作 | T01；；姓名、身份与角色同行，操作放次行。 | B1，审阅后无额外产品决定 |
| P65 /admin/billing | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/billing.tsx` | 发放积分、执行计费清理 | T01；保持幂等提交与原确认步骤；不新增自动清理策略。；发放与清理分隔，确认对象/金额/影响保持可见。 | B1，审阅后无额外产品决定 |
| P66 /admin/identity-providers | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/identity-providers.tsx` | 维护提供方配置 | T01；；元数据在代码容器内滚动，常规字段单列。 | B1，审阅后无额外产品决定 |
| P67 /admin/audit | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/admin/audit.tsx` | 翻页、查看已有事件信息 | T01；不凭设计稿添加后端尚未提供的筛选条件。；先展示决定、动作、时间；长事件信息按需展开。 | B1，审阅后无额外产品决定 |
| P68 /admin/enterprise | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/enterprise.tsx` | 修改现有策略、执行现有维护操作 | T01；当前主导航未列出此入口，导航调整另列 I-02。；按职责分组；复杂配置弹窗单列。 | B1，审阅后无额外产品决定 |
| P69 /admin/observability | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/admin/observability.tsx` | 切换时间范围、使用已有明细入口 | T01；与 /admin/ai-observability 同组件；不生成超出管理范围的全局总数。；健康与范围说明置前，Bot 汇总逐行展开。 | B1，审阅后无额外产品决定 |
| P70 /admin/ai-observability | 既有能力 / 视觉变化；`app/src/routes/_authed/admin/ai-observability.tsx` | 切换时间范围、使用已有明细入口 | T01；保留现有双路由渲染，不在本次视觉方案中改重定向。；健康与范围说明置前，Bot 汇总逐行展开。 | B1，审阅后无额外产品决定 |
| P71 /sign | 既有能力 / 视觉变化；`app/src/routes/sign.tsx` | 使用已配置身份方式登录 | T01；不新增账号密码注册或未配置的登录提供方。；单列居中，按钮触控区域至少 44px。 | B1，审阅后无额外产品决定 |
| P72 /onboarding | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/onboarding.tsx` | 继续、返回、完成现有引导 | T01；保留现有步骤内容，不虚构强制接入或自动授权。；步骤主体单列，底部操作不被键盘遮挡。 | B1，审阅后无额外产品决定 |
| P73 /sign-in/$requestId | 既有能力 / 视觉变化；`app/src/routes/_authed/sign-in/$requestId.tsx` | 提交当前登录请求 | T01；与平台登录视觉同源，但必须明确本次登录目标；不暴露敏感信息。；短表单聚焦，错误贴近字段。 | B1，审阅后无额外产品决定 |
| P74 /tenant/selection | 既有能力 / 视觉变化；`app/src/routes/_authed/tenant/selection.tsx` | 选择公司、选择团队、执行已有重试 | T01；公司和团队为两个层级，不使用模糊的单一工作空间选择。；两个选择器上下排列，切换后旧团队状态清晰更新。 | B1，审阅后无额外产品决定 |
| P75 /tenant/channels | 既有能力 / 视觉变化 / 布局变化；`app/src/routes/_authed/tenant/channels.tsx` | 选择范围、查看频道 | T01；管理范围保持原查询契约。；选择器在前，详情下移；技术标识单独换行。 | B1，审阅后无额外产品决定 |
| P76 /share/$token | 既有能力 / 视觉变化；`app/src/routes/share.$token.tsx` | 浏览分享、举报 | T01；不展示内部侧栏、隐私配置、内部调试信息或未授权下载。；预览容器自适应，长内容内部滚动。 | B1，审阅后无额外产品决定 |
