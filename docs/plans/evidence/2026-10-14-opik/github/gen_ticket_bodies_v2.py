#!/usr/bin/env python3
"""Generate per-ticket GitHub issue bodies for the Opik v2 breakdown.

Behaviour-level only: no file paths, no code snippets (per to-tickets skill).
File-level planning belongs to Superpowers writing-plans, not to the ticket.
"""
import json, pathlib, re

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "ticket-drafts-v2"
OUT.mkdir(exist_ok=True)

PARENT_URL = "https://github.com/1123786563/OpenBot/issues/4"
PARENT_TITLE = "[Spec] Opik 自托管：安全运行追踪、版本评测与企业租户预留"
INHERIT = ("This slice inherits the parent Spec's safety, authorization, tenancy-reservation, "
           "billing, and real-verification constraints and does not expand its non-goals.")

# id, slug, title, what, handoff, covers, [acceptance]
T = [
("T01","observability-module-seam","观测后端模块骨架与路由注册 seam",
 "建立观测后端模块的目录约定与单一注册入口，使后续每个 Ticket 只新增自己的路由模块即可挂载，不再编辑应用主入口；统一注入认证用户、可信 scope 与 Bot 归属。",
 "路由注册约定 + 观测请求上下文的注入方式", ["A5"],
 ["后续每个观测 Ticket 只新增自己的路由模块即可挂载，应用主入口只保留一处注册。",
  "请求上下文（已认证用户、可信 scope、Bot 归属）以统一方式注入；未认证或无归属的请求在进入业务逻辑前被拒绝。",
  "观测模块未启用时注册不产生任何行为变化，现有接口与 tracing 保持原样。",
  "目录与命名约定写入模块说明，接手的 agent 只读该约定即可新增路由，不依赖父会话上下文。"]),

("T02","observability-ui-i18n-seam","观测 UI 独立 i18n 命名空间与路由约定",
 "为观测界面建立独立的双语命名空间与路由约定，使后续前端 Ticket 不再争用既有共享文案文件，并统一八类可用性状态的表达。",
 "i18n 命名空间 key 约定 + 前端共享类型位置 + 路由命名约定", ["A5"],
 ["观测界面文案集中在独立双语命名空间，新增前端 Ticket 不需要编辑既有共享文案文件。",
  "disabled、empty、forbidden、basic、omitted、truncated、syncing、unavailable 八类状态在英文与中文均有明确文案且语义不混用。",
  "Bot 维度与管理维度路由约定确定并可被后续页面直接复用；直接输入路由时仍执行权限校验。",
  "前端共享类型位置确定，后端契约变化时只需改一处类型定义。"]),

("T03","opik-optional-deployment","Opik 可选部署与版本锁定清单",
 "平台运维可用可选部署启动真实自托管 Opik，服务与 SDK 版本锁定为实际验证过的值；关闭集成时现有执行与 tracing 行为完全不变。",
 "非浮动版本清单 + 启动/关闭/健康检查步骤", ["A1"],
 ["可选部署能启动真实自托管实例；未部署或未启用时现有 Agent 执行与 tracing 行为完全不变。",
  "服务镜像与 SDK 版本锁定为实际验证过的具体值（tag/digest），不使用浮动标签。",
  "运维文档给出启动、关闭、健康检查与故障排查步骤，且不泄露凭据。",
  "相关配置进入环境变量样例，缺省时集成保持关闭。"]),

("T04","opik-contract-manifest","上游契约冒烟与 VerifiedOpikContract manifest",
 "对真实自托管实例验证 OTLP 写入、查询、项目、数据集、实验与删除契约，产出后续所有上游序列化唯一依据的 manifest。",
 "VerifiedOpikContract manifest（版本、fixture、ID 映射、删除证据、正文上限）", ["A1","A11","A13"],
 ["对真实实例逐项验证 OTLP 写入、查询、项目、数据集、实验与删除，全部 pass 后才产出 manifest。",
  "manifest 记录服务 tag/digest、SDK 精确版本、对应上游提交、实际请求响应 fixture、ID 映射、删除证据与支持的正文上限。",
  "canary 凭据、账号标识与原始附件不出现在任何实际写入或诊断输出中。",
  "删除后记录在真实实例确实查不到；缺环境或跳过实测时不得报告验证成功。"]),

("T05","redaction-projection","采集侧脱敏投影与安全内容策略",
 "在任何写入或导出前对内容做语义白名单投影，排除凭据、内部能力、连接串、账号标识、reasoning 与原始附件；无法可靠处理的自由文本降级为仅指标。",
 "安全投影接口 + 内容策略版本号", ["A4"],
 ["凭据、内部能力、连接串、账号标识、reasoning 内容与原始附件在任何写入或导出前被排除。",
  "语义字段白名单驱动投影；无法可靠处理的自由文本降级为仅指标，而不是原样透传。",
  "治理覆盖正文、metadata、异常、名称与 URL，不只覆盖输入输出两个字段。",
  "内容策略带版本号并可被下游冻结引用；canary 测试证明无泄露。"]),

("T06","trusted-scope-seam","可信 scope seam 与企业预留拒绝",
 "把授权范围、存储定位与评测资格集中在可替换 seam，当前只实现工作台适配器；未知企业 scope 拒绝且不回退，不提前固定租户模型。",
 "ObservationScope 解析接口 + 两个测试 scope 的构造方式", ["A5","A12"],
 ["授权范围、存储定位与评测资格集中在可替换 seam，当前只实现工作台适配器。",
  "两个测试 scope 使用相同资源 ID 时互相隔离，游标、缓存与任务不跨 scope。",
  "未知企业 scope 被拒绝且不回退到工作台 scope。",
  "不创建租户表、不伪造租户、不引入隐式租户头，不把 workspace/project 布局当作授权证明。"]),

("T07","ownership-storage-bindings","观测归属存储 schema 与可信绑定",
 "OpenBot 保留权威归属、存储定位、非敏感版本引用与持久任务状态；绑定幂等且可在部分成功后恢复；Opik metadata 不能改变业务归属。",
 "归属存储表结构 + 绑定/解析 API", ["A1","A5","A11","A12"],
 ["OpenBot 保留权威归属、存储定位、非敏感版本引用与持久任务状态；Opik metadata 不能改变业务归属。",
  "绑定建立幂等；远端成功但本地确认丢失时可恢复关联，不产生重复主体。",
  "scope 参与记录键与归属解析；归属缺失或伪造时拒绝。",
  "使用专用 PostgreSQL 测试库验证唯一性、幂等与隔离；缺测试库不回退开发库、不记为通过。"]),

("T08","opik-port-adapter","Opik HTTP 适配器与 port 抽象",
 "全部上游调用经单一 port 抽象，序列化只由契约 manifest 驱动；对抗性故障可注入且不伪装成功，上游异常不阻塞正常 Agent 结果。",
 "OpikPort 接口 + 对抗性 fixture 注入方式", ["A1","A4","A10","A13"],
 ["全部上游调用经单一 port 抽象；序列化只由契约 manifest 驱动，不各自发明请求格式。",
  "超时、5xx、部分成功与归属漂移可注入；失败如实返回，不伪装成功或空列表。",
  "上游慢响应或离线时调用有界，不阻塞正常 Agent 结果。",
  "归属漂移等关键异常暂停后续写入并可告警，不静默继续。"]),

("T09","config-and-health","配置开关与健康状态（禁用零影响）",
 "集成关闭时现有执行与 tracing 完全不变；启用但故障时给出可解释状态；Opik 慢响应、离线或队列饱和不改变正常 Agent 结果。",
 "就绪/健康查询接口 + 有界异步写入入口约定", ["A1","A10"],
 ["集成关闭时现有执行与 tracing 行为完全成立；启用但故障时给出可解释状态而非静默降级。",
  "就绪条件统一：关闭、未配置、认证失败或缺必需能力时明确不可用，不启用任何观测写入。",
  "Opik 慢响应、离线或队列饱和不改变正常 Agent 执行结果；丢弃与延迟可被观察。",
  "健康状态不含凭据或敏感响应内容。"]),

("T10","run-termination-and-basic","run 终结语义与 basic 远程路径能力标记",
 "run 记录在实际完成、失败、取消或明确未知状态时终结，HTTP 首帧不结束 run；内置与经过 OpenBot 的远程 AG-UI 执行都建立可信归属，远程路径只记录实际观察到的事件并标记 basic。",
 "run/attempt 终结状态机 + capability（detailed/basic/unavailable）判定入口", ["A2","A3","A5","A10"],
 ["HTTP 首帧不结束 run；run 记录在实际完成、失败、取消或明确未知状态时终结。",
  "成功、错误、重试、确认取消、断连与未知结局正确区分，每个 attempt 唯一终结。",
  "工具提议不冒充执行。",
  "内置与经过 OpenBot 的远程 AG-UI 执行都建立可信 Bot/thread/run/attempt 关联。",
  "远程路径只记录实际观察到的事件并明确标记 basic，不声称不可见的内部调用不存在。"]),

("T11","creator-read-api","创建者只读查询接口",
 "创建者按当前管理权查询自己 Bot 的运行列表与安全详情；伪造归属、猜测 ID 与跨 scope 游标不能扩大访问；移交或撤权后历史、分页与缓存立即不可读。",
 "只读查询 REST 契约（请求/响应/错误语义/游标）", ["A2","A5","A6","A10","A12"],
 ["仅当前有管理权的创建者与范围内管理员可查询；public 聊天权、伪造归属、猜测 ID 与跨 scope 游标不能扩大访问。",
  "列表与详情返回实际状态、耗时、安全内容与版本引用；provider usage 缺失时返回明确 unavailable。",
  "移交或撤权后历史详情、分页与缓存立即不可读。",
  "不暴露任意上游查询代理；两个测试 scope 的相同资源 ID 互相隔离。",
  "上游不可用时返回可解释错误，不伪装为空列表。"]),

("T12","run-list-page","创建者运行列表页",
 "创建者在自己的 Bot 页面筛选并查看运行列表，看到真实状态、耗时与能力标记，覆盖各类可用性与故障状态。",
 "列表组件与查询 hook 契约", ["A2","A5","A6","A10"],
 ["创建者在 Bot 页面筛选并查看运行列表，看到真实状态、耗时与能力标记。",
  "覆盖空、禁用、无权限、同步中与上游不可用状态；文案双语且语义不混用。",
  "键盘与窄屏可完成筛选并进入详情；直接输入路由仍执行权限校验。",
  "恶意正文只作为文本渲染，不产生可执行内容。"]),

("T13","run-detail-page","创建者运行详情页与可用性状态",
 "创建者查看单次运行的安全详情：实际状态与耗时、脱敏内容、版本引用、provider usage 或明确的 unavailable；basic 与 unavailable 明确标注。",
 "详情页组件契约（步骤树在后续 Ticket 扩展同一组件）", ["A2","A3","A4","A5","A6"],
 ["展示单次运行的实际状态与耗时、脱敏内容、版本引用，以及 provider usage 或明确 unavailable。",
  "basic 与 unavailable 明确标注，不显示不可观察的内部步骤。",
  "撤权、移交与跨 scope 访问在页面与接口两侧都被拒绝。",
  "Opik 故障时页面如实展示同步/缺失/故障状态，不影响用户已获得的正常回答。"]),

("T14","builtin-model-spans","内置执行的模型调用记录",
 "内置路径的模型调用带实际 provider usage 或明确 unavailable；不重复调用 provider、不改变已有 metered finish 与 Settlement 顺序、不重复计算 usage。",
 "模型 span 记录接口 + usage 缺失语义", ["A2","A3","A4","A8"],
 ["内置路径的模型调用带实际 provider usage；缺失时明确 unavailable，不当 0。",
  "不重复调用 provider、不改变已有 metered finish 与 Settlement 顺序、不重复计算 usage。",
  "拒绝或结算失败不记录为成功 span。",
  "模型 span 的输入输出经脱敏投影；canary 不出现在真实实例。"]),

("T15","tool-and-retrieval-steps","工具提议 vs 真实执行与检索步骤",
 "工具提议、真实 execute 与缺少回执三者分开记录与展示；未知浏览器执行不显示成功；检索步骤与片段可定位且无秘密 canary。",
 "步骤类型枚举 + 提议/执行/回执缺失判定", ["A2","A3","A4"],
 ["工具提议、真实 execute 与缺少回执三者分开记录与展示。",
  "未知浏览器执行不显示成功。",
  "检索步骤与片段可定位；输入输出、错误与日志无秘密 canary。",
  "步骤类型判定不依赖框架内部实现细节。"]),

("T16","langgraph-callbacks","LangGraph callback 接入同一受治理 OTel 路径",
 "默认 LangGraph 路径的框架 callback 进入同一受治理 OTel 路径，不另开未处理的自动上传；模型、工具与检索父子关系正确后才标记 detailed。",
 "LangGraph 侧 tracing 接入方式与版本约束", ["A2","A4","A13"],
 ["默认 LangGraph 路径的框架 callback 进入同一受治理 OTel 路径，不另开未处理的自动上传。",
  "模型、工具与检索父子关系在真实实例验证正确后才标记 detailed。",
  "输入输出、错误与日志无秘密 canary。",
  "其他远程路径保持 basic 与原协议，不因该接入被改变。",
  "agent runtime 模块自身测试通过，不依赖服务端未完成能力。"]),

("T17","context-propagation-id-mapping","跨服务与动态进程上下文传播与 ID 映射",
 "宿主、容器与支持动态创建的进程真实传播 W3C 上下文；OTel 与 Opik 标识使用显式映射而不假定相等。",
 "传播环境变量约定 + ID 映射位置", ["A2","A13"],
 ["宿主、容器与支持动态创建的进程真实传播 W3C 上下文。",
  "OTel 与 Opik 标识使用显式映射，不假定相等。",
  "跨服务父子关系在真实实例可验证。",
  "loopback 地址与凭据不混淆、不泄露。"]),

("T18","step-tree-ui","运行详情页步骤树",
 "创建者在既有详情页展开可信步骤树，定位具体模型、工具与检索操作并关联跨服务过程；basic 路径不显示不存在的内部步骤。",
 "步骤树组件与只读步骤查询契约", ["A2","A3","A5"],
 ["创建者在既有详情页展开可信步骤树，定位具体模型、工具与检索操作。",
  "跨服务过程可关联；ID 映射不暴露内部实现。",
  "basic 路径不显示不存在的内部步骤；能力标记与列表一致。",
  "键盘、窄屏与双语成立；恶意内容只作文本渲染。"]),

("T19","dataset-immutable-versions","数据集 schema 与不可变版本冻结",
 "版本冻结安全输入、参考结果、工具 fixture、hash、策略版本、来源与上游定位；候选与后续修改不改变已保存版本；部分成功可恢复或清理。",
 "数据集版本读取 API + 冻结字段清单", ["A4","A7","A11","A12"],
 ["版本冻结安全输入、参考结果、工具 fixture、hash、策略版本、来源与上游定位。",
  "候选与后续修改不改变已保存版本。",
  "上游与本地引用部分成功可恢复或清理；pending/syncing 不冒充成功。",
  "scope 参与版本键与读取；使用专用 PostgreSQL 验证隔离与幂等。",
  "真实实例证明独立快照与固定 hash。"]),

("T20","case-review-and-save","案例审查与保存接口",
 "候选只来自有权访问的安全运行；仅指标的记录不能被自动伪造为文本样本，必须提供审查后的合成或脱敏案例；拒绝原始附件与任意生产工具。",
 "案例审查/保存 REST 契约 + 脱敏语义限制说明", ["A4","A5","A6"],
 ["候选只来自有权访问的安全运行；越权或猜测 ID 不能成为候选。",
  "仅指标的记录不能被自动伪造为文本样本，必须提供审查后的合成或脱敏案例。",
  "拒绝原始附件与任意生产工具进入数据集。",
  "跨 Bot 复用需要显式授权复制，不隐式共享。",
  "已保存案例采用评测保留引用；未保存候选随源追踪生命周期。"]),

("T21","dataset-pages","数据集页面（审查 / 保存 / 版本）",
 "创建者在页面检查候选输入、参考结果与工具 fixture，看到脱敏语义提示后保存，并查看冻结版本历史。",
 "数据集页面组件与查询 hook 契约", ["A4","A5","A7"],
 ["创建者在页面检查候选输入、参考结果与工具 fixture，并看到脱敏语义限制提示后保存。",
  "可查看冻结版本历史；已保存版本不因后续编辑变化。",
  "覆盖空、故障、同步中与审查提示状态；双语、键盘与窄屏可用。",
  "越权访问与直接路由输入被拒绝。"]),

("T22","experiment-freeze-submit","实验 schema 与冻结配置幂等提交",
 "提交时冻结数据集版本、Bot 配置、Prompt、模型参数、fixture 与评分器版本；幂等重试不产生第二个实验。",
 "实验记录结构 + 幂等键约定", ["A7","A9"],
 ["提交时冻结数据集版本、Bot 配置、Prompt、模型参数、fixture 与评分器版本。",
  "幂等重试不产生第二个实验。",
  "scope 参与实验键；猜测 ID 或撤权不能读取。",
  "配置版本引用可追溯到具体冻结来源。"]),

("T23","isolated-evaluation-execution","隔离执行与生产写工具拒绝",
 "隔离 thread 与测试工具复用公共执行路径，不写生产会话、memory、learning 或业务数据；未知生产写工具被拒绝。",
 "隔离执行入口 + 工具白名单/拒绝策略", ["A8","A10"],
 ["隔离 thread 与测试工具复用公共执行路径，不写生产会话、memory、learning 或业务数据。",
  "未知生产写工具被拒绝，而不是静默跳过。",
  "被测执行保持公共行为语义；评测不改变生产执行路径。",
  "执行失败与外部未知结局如实记录。"]),

("T24","evaluation-job-orchestration","持久任务编排：有界并发、每样本重授权、取消与 lease",
 "复用现有持久任务能力实现有界并发评测；每个样本执行前重新授权；取消停止新调度；结果未知或 lease 恢复不自动重复调用或扣费。",
 "任务状态机 + 取消/lease 语义", ["A6","A10","A12"],
 ["持久任务有界并发；进程重启或 lease 恢复后继续而不重复执行已完成样本。",
  "每个样本执行前重新授权；撤权后停止读取与消费。",
  "取消停止新调度；结果未知或 lease 丢失不自动重复调用或扣费。",
  "双 worker 并发认领测试成立；任务状态可解释。"]),

("T25","evaluation-billing-admission","评测调用的计费准入与结算接线",
 "被测调用遵守适用 Credit Gate、Admission、Reservation 与 Settlement 规则；缺失 usage 不当 0；计费台账保持权威。",
 "评测侧计费准入接口 + 预算不足时的调用前拒绝语义", ["A8"],
 ["被测调用遵守适用 Credit Gate、Admission、Reservation 与 Settlement 规则。",
  "缺失 usage 不当 0；计费台账保持权威，观测侧成本只作分析用途。",
  "预算不足或准入失败在调用前拒绝，不产生供应商调用。",
  "结算幂等，重放不重扣。"]),

("T26","rule-scorers","规则评分器",
 "确定性检查输出格式、必需字段与工具名称/参数；结果与规则版本可追溯到安全运行；不依赖模型 Judge 即可完整运行。",
 "Scorer 接口 + 规则版本化约定", ["A7","A9"],
 ["确定性检查输出格式、必需字段与工具名称/参数。",
  "结果与规则版本可追溯到具体安全运行。",
  "缺失评分不伪造为 0；评分失败与执行失败分开。",
  "不依赖模型 Judge 即可完整运行。"]),

("T27","controlled-model-judge","受控模型 Judge 评分",
 "仅允许显式批准的模型入口、凭证与 rubric/scorer 版本；Judge 遵守预算与访问范围；只有已审查安全样本送给 Judge，理由经安全投影。",
 "Judge 准入清单 + 理由安全投影", ["A4","A7","A8"],
 ["仅允许显式批准的模型入口、凭证与 rubric/scorer 版本；不接受任意 provider 地址，不自动使用 Opik 默认模型。",
  "Judge 遵守适用 Credit Gate、Admission、Reservation/Settlement；预算不足或不受控时调用前拒绝，规则评测仍可用。",
  "只有已审查的安全样本、参考与 context 送给 Judge；SDK 自动追踪与理由经安全投影，canary 不进入上游或页面。",
  "逐样本显示分数、理由、版本、usage 与评分失败；Judge 故障不混入成功平均分。",
  "撤权、取消与外部未知结果沿用任务规则，不增加自动重跑或跨范围读取。",
  "受控假 provider 与真实实验验证门控、调用次数与账本；SDK 返回 score 不能代替预算证据。"]),

("T28","result-api-failure-classes","实验结果查询接口与失败分类",
 "逐样本返回分数、理由、版本、usage 与结果链接；执行失败、评分失败、取消、待协调与同步故障分别展示，平均分不掩盖缺失或失败样本。",
 "结果查询 REST 契约 + 失败分类枚举", ["A5","A7","A9"],
 ["逐样本返回分数、理由、版本、usage 与结果链接。",
  "执行失败、评分失败、取消、待协调与同步故障分别展示；平均分不掩盖缺失或失败样本。",
  "实验与结果读取遵守 scope/Bot 授权；猜测 ID 或撤权不能跨范围读取。",
  "结果可回链到安全执行记录。"]),

("T29","comparison-api","实验对比接口与兼容性判定",
 "仅对冻结样本集、hash 与评分定义兼容的实验给出结论；输出有效样本数、逐项 delta、退化案例与回链运行，不兼容时解释差异而不宣称赢家。",
 "对比 REST 契约 + 兼容性判定规则", ["A9"],
 ["仅对冻结样本集、hash 与评分定义兼容的实验给出结论；不兼容时解释差异而不宣称质量赢家。",
  "输出完成率、有效评分数、执行/评分失败、逐项 delta、耗时与实际 usage；缺失值不当 0 或静默剔除。",
  "退化样本链接到安全案例与执行记录；unknown/basic/metrics-only 保持明确，不捏造解释。",
  "两次实验都通过当前 scope/Bot 授权；规则实验即可完成对比，不依赖模型 Judge。"]),

("T30","experiment-pages","实验页面（提交 / 逐样本结果 / 取消）",
 "创建者在双语可访问页面提交实验、查看逐样本分数与理由、区分失败类型并取消；结果可回链到运行详情。",
 "实验页面组件契约", ["A5","A7","A8"],
 ["创建者在双语可访问页面提交实验、查看逐样本分数与理由并取消。",
  "失败类型分别展示；Judge 故障不混入成功平均分。",
  "键盘、窄屏与直接路由越权校验成立。",
  "结果可回链到运行详情。"]),

("T31","comparison-page","实验对比页面",
 "创建者比较两次实验的配置差异、有效样本与退化案例，并从退化案例回到相关安全执行详情；不兼容时不显示误导性赢家结论。",
 "对比页面组件契约", ["A9"],
 ["展示两次实验的配置差异、有效样本数、逐项 delta 与退化案例。",
  "从退化案例回到相关安全执行详情。",
  "不兼容时明确解释，不显示误导性赢家结论。",
  "双语、键盘与窄屏成立；机器可读安全结果可用。"]),

("T32","control-plane-protection","采集入口认证与控制台/私有 API 保护",
 "采集入口要求内部生产者认证；整个 Opik 控制面（含私有 API）受保护，不能绕过应用角色检查；复用现有身份系统而非第二套用户库。",
 "控制面访问规则 + 内部生产者凭据发放方式", ["A4","A5","A13"],
 ["采集入口要求内部生产者认证；未认证写入被拒绝。",
  "整个 Opik 控制面（含私有 API）受保护，私有 API 不能绕过应用角色检查。",
  "使用现有身份系统或平台私有访问，不建立第二套 Opik 用户库。",
  "普通用户不能读取连接配置、管理诊断或凭据；整实例控制台仅限相应平台资格。"]),

("T33","admin-summary-and-ingest-faults","管理员范围汇总与采集故障排查",
 "管理员按授权范围汇总 Bot 运行与评测，筛选故障、丢弃、延迟与未绑定记录，并区分业务失败、采集不可用与尚未具备的能力。",
 "管理汇总 REST 契约 + 故障分类枚举", ["A5","A6","A10","A12"],
 ["先限定授权 scope 再汇总运行、实验与状态；相同 ID 或受限管理角色不能跨范围。",
  "按 Bot 与时间筛选，显示 pending、失败、丢弃、最近采集与未绑定状态。",
  "缺失 usage 或 basic 内部缺失不算 0 或健康；区分业务失败、采集不可用与能力未具备。",
  "Opik 故障保留真实同步/缺失状态且正常 Agent 继续执行；汇总不进入运行关键路径。",
  "无需先完成模型 Judge 或对比 Ticket 即可验证。"]),

("T34","bounded-exports-revocation","有界异步导出与下载即时撤权",
 "有权用户请求运行/实验的机器可读导出并查看状态；导出有界异步且不改变正常 Agent 结果；每次下载重新校验当前权限，撤权后旧链接立即失效。",
 "导出任务与下载鉴权契约", ["A4","A6","A10","A11"],
 ["导出仅使用授权安全 DTO，不含原文附件、凭证、未处理正文、可执行 HTML 或私有原文 URL。",
  "任务、文件与分页引用绑定 scope/Bot；客户端不能指定上游项目或用 export ID 跨范围读取。",
  "页面区分 queued、running、ready、failed、revoked；仅 ready 且当前有权才可下载。",
  "移交或撤权后旧链接立即失效；下载经受控接口，不产生绕过授权的长期公开链接。",
  "导出有界异步，不改变正常 Agent 结果；无法建立可信绑定时不导出该 run 的业务内容。"]),

("T35","retention-and-real-deletion","保留期与真实删除验证",
 "默认 7 天 trace、30 天数据集/实验且可运维调整；先撤销可见性再按可信定位清理上游与导出；仅验证实际查不到后才报告完成。",
 "清理状态机 + 删除证据格式", ["A6","A11","A12"],
 ["默认 trace 7 天、数据集与实验 30 天，可运维调整；到期先撤销可见性、停止受影响任务、失效缓存与下载。",
  "按可信定位清理上游 trace/span、样本、实验与导出文件；隐藏条目不等于删除。",
  "上游失败保留定位与 pending/failed 以重试；仅验证实际查不到后才报告完成。",
  "清理不跨项目或范围影响其他 Bot；未知归属需受控处理，不猜测。",
  "删除 Bot、数据集或范围后账务与审计不被级联删除。",
  "实际存储、文件与备份保留策略有证据和操作说明；真实实例证明清理效果与故障恢复。"]),

("T36","admin-and-export-pages","管理员汇总页面与创建者导出状态页",
 "管理员在后台查看范围内汇总、健康与故障排查；创建者查看导出状态与下载；权限变化即时反映在页面上。",
 "管理页面组件契约 + 导出状态组件契约", ["A5","A6","A10","A11"],
 ["管理员在后台查看范围内汇总、健康与故障排查；受限管理角色看不到范围外数据。",
  "创建者查看导出状态与下载；权限变化即时反映。",
  "双语、键盘与窄屏成立；直接路由越权被拒绝。",
  "故障、同步中与未启用状态明确区分。"]),

("T37","end-to-end-acceptance","端到端验收与真实实例证据闭环",
 "对真实自托管 Opik 跑通采集、查询、评测、ID 映射与删除的全范围验收，汇总 13 条验收标准的证据，并完成独立 review 与全范围 OCR 闭环。",
 "验收证据索引", ["A%d" % n for n in range(1, 14)],
 ["对真实自托管 Opik 跑通采集、查询、评测、ID 映射与删除，逐项形成证据。",
  "父 Spec 的 A1–A13 每条都有可核验证据或明确缺口说明；跳过与缺环境不记为通过。",
  "完成独立 Spec 合规与代码质量 review，并跑全范围 OCR，无有效 critical/high/medium findings。",
  "适用测试、类型检查、Lint 与前端构建全部通过；受影响的 agent runtime 模块测试通过。",
  "交付实际变更范围、接口契约、迁移与回退说明、验证命令与结果、检查点哈希。"]),
]

proposal = json.loads((HERE / "ticket-proposal-v2.json").read_text())
deps = {t["id"]: t["blocked_by"] for t in proposal["tickets"]}
assert [x[0] for x in T] == list(deps), "ticket id mismatch with proposal"

records = []
for tid, slug, title, what, handoff, covers, acc in T:
    n = int(tid[1:])
    lines = ["## Parent", "", f"{PARENT_TITLE} — {PARENT_URL}", "",
             "## What to build", "", what, "", INHERIT, "",
             "## Acceptance criteria", ""]
    lines += [f"- [ ] {a}" for a in acc]
    lines += ["", "## Blocked by", ""]
    d = deps[tid]
    if not d:
        lines.append("None (can start immediately).")
    else:
        for b in d:
            bt = next(x[2] for x in T if x[0] == b)
            lines.append(f"- {b} {bt}  <!-- issue-link -->")
    lines += ["", "## Handoff", "",
              f"Produces: {handoff}.",
              f"Covers parent acceptance: {', '.join(covers)}.",
              "A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.",
              ""]
    body = "\n".join(lines)
    (OUT / f"{n:02d}-{slug}.md").write_text(body)
    records.append({"id": tid, "n": n, "slug": slug, "title": title,
                    "issue_title": f"[Opik {tid}] {title}",
                    "blocked_by": d, "covers": covers, "handoff": handoff,
                    "acceptance_count": len(acc), "draft_file": f"ticket-drafts-v2/{n:02d}-{slug}.md"})

(HERE / "ticket-issue-content-v2.json").write_text(
    json.dumps({"parent": {"number": 4, "url": PARENT_URL}, "tickets": records},
               ensure_ascii=False, indent=1))
print(f"generated {len(records)} issue bodies into {OUT.name}/")
print("acceptance total:", sum(r["acceptance_count"] for r in records))
print("covers union:", sorted({c for r in records for c in r["covers"]}, key=lambda x: int(x[1:])))
