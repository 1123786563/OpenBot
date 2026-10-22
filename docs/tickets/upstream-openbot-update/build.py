"""Build local review drafts only. Does not call GitHub or implement product code."""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
SPEC = 'docs/specs/2026-10-20-upstream-openbot-adoption-design.md'
PLAN = 'docs/plans/2026-10-20-upstream-openbot-refactor/implementation-plan.md'
TICKETS = [
 dict(id='UP01',title='无 hostname 的无登录配置拒绝启动',depends_on=[],acceptance=['A01'],plan_tasks=['S00','S01'],roles=['backend_implementer'],deliver='维护者设置无登录部署地址时，无法识别主机的配置明确拒绝启动，原合法本地部署继续使用。',criteria=[
 '对 public URL、app URL 和 trusted origins 分别覆盖无 hostname 输入，不能将其当作单标签私网名称。',
 '合法 localhost、loopback、现有合法私网部署继续启动；已配置认证 provider 时保持原优先级。',
 '测试从真实配置加载入口验证，不只测试内部 hostname 帮助函数。',
 '拒绝错误可读，不携带凭据；其他配置字段和默认值不作额外改变。',
 '同版本定向回归、Spec/quality Review 和工作区检查点证据齐全。'],verification='以现有基础 fixture 加载合法/非法配置，对每个地址字段分别验证启动结果。',boundary='只修地址可识别性，不重写认证模型或所有 IP 分类。',produces='稳定的无登录地址拒绝行为与配置边界回归。'),
 dict(id='UP02',title='shell 参数凭据在事件导出前正确脱敏',depends_on=[],acceptance=['A02'],plan_tasks=['S00','S02'],roles=['backend_implementer'],deliver='Bot 执行含秘密参数的命令后，外部事件收集器收到可追溯但不含这些秘密的审计事件。',criteria=[
 '覆盖 docker login、sshpass、redis-cli、mysql、curl 上游新增参数形态与引号值，不仅匹配厂商 token 前缀。',
 '区分密码选项与端口/数据库参数；裸 flag 不吞后续 flag，无关命令结构保留。',
 '已有 header、token、JSON body、URL 用户信息脱敏回归通过。',
 '真实本地 OTLP collector 收到的 body 不含 fixture secret，事件类型及动作关联保持。',
 '与现有 Opik 内容投影及多租户回归边界协调；实际发现共享文件冲突先集成，不修改他人 Issue 状态。',
 '报告本次覆盖的命令集合，不宣称净化任意 shell 语法或已删除历史日志。'],verification='函数边界加真实事件到 OTLP collector 的输出验证，使用明显虚构秘密。',boundary='shell 参数补丁；不扩大为重做整个 observability 或追溯历史。',produces='参数脱敏规则、实际导出无泄漏证据。'),
 dict(id='UP03',title='邮件触发按正文编码与 HTML 字符读取内容',depends_on=[],acceptance=['A03'],plan_tasks=['S00','S03'],roles=['backend_implementer'],deliver='用户发送不同编码或 HTML-only 邮件，Bot 的触发任务收到正确正文。',criteria=[
 '每个 MIME part 先解 transfer encoding，再按自己的 charset 解码；base64 与 quoted-printable 均覆盖。',
 '未知 charset 回落 UTF-8，multipart 维持既有 plain-text 优先级及递归深度限制。',
 'HTML 引用覆盖 named/decimal/hex/nbsp；双层引用只解一层，plain text 不执行 HTML 解码。',
 'SNS 签名验证、topic allowlist、发送人过滤与正文上限保持。',
 '以邮件输入到触发正文的公共 seam 验证，不用内部 decoder 单测代替完整验收。'],verification='受控 MIME 输入和 SNS/trigger fixture，断言 Bot 实际获得正文。',boundary='只涉及入站邮件触发，不改 OpenMuse 邮件 BFF 或主动发送。',produces='稳定邮件文本语义及多编码回归。'),
 dict(id='UP04',title='例程时间描述去重并保持实际调度不变',depends_on=[],acceptance=['A04'],plan_tasks=['S00','S04'],roles=['mechanical_worker'],deliver='例程含重复分钟时，用户和模型只看到每个实际时间一次。',criteria=[
 '0,30,0 9 * * * 只描述 09:00 和 09:30；0,0 只描述一次。',
 '去重后保持排序和原有文案格式，其他 cron 形态兼容。',
 '下一次触发时间、时区、DST 和最小间隔规则不变。',
 '原有 weekday 别名、重复星期和无法自然描述的 fallback 回归通过。',
 '交付定向验证与独立审查证据，补丁只涵盖描述语义。'],verification='描述输出断言及现有 next-occurrence/DST 测试。',boundary='不修改 cron 执行或扩展自然语言调度格式。',produces='去重描述行为和调度不回退证明。'),
 dict(id='UP05',title='只有实际屏幕活动自动开屏并准确撤回拒绝动作',depends_on=[],acceptance=['A05'],plan_tasks=['S00','U01'],roles=['frontend_implementer'],deliver='用户只在 Bot 的浏览器显示操作时自动看到屏幕，被拒动作可撤回自己的开屏而不影响用户面板。',criteria=[
 '浏览器显示动作采用明确路径集合；文件/shell/未知请求不自动开屏。',
 '每个公告具有独立标识，仅明确未执行的对应拒绝撤回；网络失败/500/abort 不假定动作未发生。',
 '不关闭用户手动打开、早前有效动作打开、设置或 Workshop 面板。',
 '沿用现有 epoch 启发式并明确其限制；用户关闭后在该 epoch 内不重开。',
 '切 Bot/范围和卸载后清理订阅，迟到事件不影响新范围。',
 '验证窄屏与键盘关闭，现有手动屏幕入口继续可用。'],verification='请求到面板的真实事件序列和 UI 行为，覆盖乱序/拒绝/手动操作。',boundary='改造活动/UI；不引入新服务器 Run 权威或修改 gateway 权限。',produces='可撤回的屏幕公告合约及面板使用行为。'),
 dict(id='UP06',title='在当前对话安全连接 Bot 需要的个人应用',depends_on=[],acceptance=['A06'],plan_tasks=['S00','U02','U03'],roles=['backend_implementer','frontend_implementer'],deliver='用户在当前对话收到连接入口，完成个人应用授权后看到真实连接状态，并自行再次发起任务。',criteria=[
 '服务端结构化提示只针对可自助连接的个人账户缺失/断开/撤销；缺 grant、管理员共享账户等保持各自拒绝原因。',
 'codec 严格校验并支持 title 中引号/花括号；提示只影响展示，服务端每次执行/连接仍独立校验授权。',
 '授权在新 tab 打开且 opener 断开；popup blocked、无 URL 的 key 模式、错误和超时都有可操作退路。',
 '轮询仅等待时每 2 秒，最多 5 分钟；只有本人的未撤销有效连接能显示成功。',
 '授权窗口返回/关闭不算成功；切组织、取消和卸载后旧响应不污染新卡片。',
 '保留原对话；连接成功只提示再发起，不自动重放工具，尤其写操作。',
 '旧客户端仍能显示可读拒绝；中英界面、键盘和 status 提示可用。'],verification='服务端连接拒绝→工具结果→卡片→connect API→本人连接列表的完整链路；模拟 OAuth 完成与撤权。',boundary='复用既有 connect/queries，不创建第二套 OAuth 或扩大账户归属。',produces='连接提示合约、卡片与可验证的个人账户连接闭环。'),
 dict(id='UP07',title='工具活动摘要可展开且人工决定始终可见',depends_on=['UP06'],acceptance=['A07'],plan_tasks=['U04'],roles=['frontend_implementer'],deliver='用户看到一行相邻工具活动摘要，能展开每步参数结果，同时直接看到审批、连接和人工介入要求。',criteria=[
 '相邻普通 connector/browser 调用分组，文本打断分组，单 connector 保持原单行行为。',
 '连接卡片、审批、Team Bot consent、接管和自定义组件工具保持独立可见。',
 '分组以首步骤稳定 ID 保持流中状态，成功/失败/拒绝计数随真实结果更新。',
 '完整参数/结果可展开，原错误信息和来源链接不丢失。',
 '沿用现有结果转义、untrusted envelope 和 renderer，不把供应商内容当作授权。',
 '验证流式更新、展开状态、窄屏、键盘及中英文，历史消息无需迁移。'],verification='从真实 transcript item 到最终 UI 的分组与流式更新，特别覆盖 UP06 连接结果。',boundary='仅视图投影，不改消息存储、工具执行或引入新研究依赖。',produces='稳定工具摘要与人工操作可见性边界；供研究标签接入。'),
 dict(id='UP08',title='私有登录在密码之后安全完成验证码步骤',depends_on=[],acceptance=['A08'],plan_tasks=['S00','L01','L02','L03'],roles=['backend_implementer','frontend_implementer'],deliver='用户先输入密码，网站确实出现验证码要求后再输入 code；对话等待真实完成，秘密不进入模型或日志。',criteria=[
 '初次表单不问 code，兼容旧客户端随密码带来的 code 也不提前输入；仅实际检测到 code 字段才进入 code_required。',
 '新增私有 Computer/API code 入口沿用 owner/Bot/origin/服务认证/人工控制和有效期规则，验证码不是模型工具参数。',
 'code_required 非终态，pending 列表可见且不恢复 Agent；只有显式 code 提交领取执行 lease。',
 '并发提交只一个 CAS 成功，其余 409；错误 code 返回可显式重试状态，回密码页要求重新登录。',
 '外部结果不明或执行 lease 到期进入 failed 并说明不确定，不自动重发、不声称成功。',
 '迟到结果不能覆盖取消/到期，不保存密码或重新恢复 Agent；重启只恢复状态，不重发秘密。',
 'code 不落库/聊天/追踪/日志，表单与 mutation variables 清理；密码只有本人明确保存才进既有加密 vault。',
 '迁移只扩展状态约束，编号按本地 journal 分配；fresh/upgrade 两条路径通过。',
 'schema→Computer→API→UI 协调发布；回滚前排空/终结 code_required/filling，保留扩展 schema。',
 '独立登录页面、聊天 dialog、保存密码路径及挂起恢复均覆盖，双端验证与独立 Review 通过。'],verification='真实私有请求→受控本地登录页→code→终态/continuation；含数据库、并发、崩溃、迟到与回滚组合。',boundary='一张完整业务票；内部按 Computer 协议、service/schema、UI 三个 Task 串行实施，不交给无上下文 Agent 同时改。',produces='两阶段登录协议、持久状态机、完整私有 UI 和兼容/回滚证据。'),
 dict(id='UP09',title='启动时有界诊断模型与已启用的可选服务',depends_on=[],acceptance=['A09'],plan_tasks=['S00','D01'],roles=['backend_implementer'],deliver='维护者在启动日志看到有用的模型/可选依赖诊断，服务不会因诊断失败而被阻断。',criteria=[
 '3 秒预算并取消支持的网络请求，不无限重试，不遗留无限网络请求。',
 '未配置 key、不支持 lookup、未启用学习/Intelligence 分别 skipped；不强制新增可选依赖。',
 '仅官方元数据或批准网关 lookup；兼容服务 404 不直接判模型不存在，不绕虚拟 Key 或产生推理账单。',
 '供应商凭据拒绝、模型不可用、entitlement 不可用、超时、未知结果分类明确且每次启动只报告一次。',
 '日志只保留安全诊断，不记录 key、认证 header 或包含凭据 URL。',
 '由真实启动装配验证非阻断与缺配置分支，Hindsight/普通聊天依赖边界不变。'],verification='注入只读网络 seam 的确定性失败/超时测试，加应用启动装配证明。',boundary='诊断只提供建议，不作为授权事实或第二套 readiness 权威。',produces='非阻断诊断与可解释结果分类。'),
 dict(id='UP10',title='技能通过授权角色使用 Parallel Exa Firecrawl 研究',depends_on=['UP07'],acceptance=['A10'],plan_tasks=['R01','R02','R03'],roles=['backend_implementer','frontend_implementer'],deliver='用户选择研究技能后可使用已授权供应商搜索/读取，切换 provider 不损失技能声明、来源和过程说明。',criteria=[
 'search/fetch 逻辑角色与实际授权求交，不能因技能声明获得新 grant；旧 Parallel 真实 ref 仍可用。',
 'catalogue 固定 reviewed host/path/认证 header；未知高风险工具 fail closed，启动任务/改变状态的能力不因 provider 名被当 read。',
 '缺 key、认证拒绝、撤权、超时、政策拒绝分别报告；不自动切供应商绕过限制。',
 'MCP/egress/凭据/预算/Payer/审计走原路径，记录实际 provider/tool；外部 credits 不伪装 token 或重复计量。',
 '共享工具角色同时用于引导语、技能选择和对话摘要；合法逻辑角色不当失效 ref 删除。',
 '来源链接和真实步骤结果保留，页面数量依据真实返回，未知工具仍可显示原名。',
 '不默认启用新 provider 或后台研究，单 Parallel 老配置升级后继续可用。',
 'mock 合约与实际 provider 联调证据分开记录，缺真实 key 标 blocked，不用全 skip 宣称验收。'],verification='从技能声明→授权工具集合→受控 MCP 请求→用户摘要/来源的闭环，覆盖三 provider 及同版本隔离/费用回归。',boundary='完整研究业务票；内部先角色/catalogue，再调用/选择，再 UI；不引入 toolkit。',produces='供应商无关研究声明、受控调用与一致 UI。'),
 dict(id='UP11',title='核验移动端 harness toolkit 与已批准方向的复用边界',depends_on=[],acceptance=['A12'],plan_tasks=['S00','E01'],roles=['architect'],deliver='维护者得到有证据的采用/延期决定，后续能明确哪些能力继续建设、哪些已由现有产品覆盖。',criteria=[
 '固定现有 OpenMuse 子模块 SHA，分别记录有页面、有 API、有运行证据，不复制根目录第二套 mobile。',
 'Antigravity 的 Gemini 凭据需求与当前逐用户模型网关授权逐项比较；不兼容时明确延期而非旁路接入。',
 '统一 harness 目录方案保留本地框架差异，明确跨语言复用关系。',
 'toolkit lock/lease/settle/cancel 与 Mastra 已批准票映射去重，不建立第二套 Run/Attempt 权威。',
 '现有记忆镜像、Learning、身份绑定、CSV 导出核验证据列出，不重复建实现票。',
 '每个剩余缺口有采用/延期理由及独立后续验收边界；评估完成不宣称功能已上线。'],verification='只读源码/Spec/ADR 对照矩阵，经独立 reviewer 审核。',boundary='只交付评估文档；不改生产客户端、运行引擎或 harness。',produces='后续采用决定与去重映射。'),
 dict(id='UP12',title='完成更新集成验收回滚演练与全范围独立审查',depends_on=[f'UP{i:02}' for i in range(1,12)],acceptance=['A11'],plan_tasks=['V01'],roles=['coordinator','backend_validator','frontend_validator','reviewer'],deliver='维护者获得绑定同一交付版本的验收、回滚、独立 Review/OCR 证据，能判断是否允许上线。',criteria=[
 '父 Spec A01–A12 无遗漏，每条绑定实际集成检查点、命令、执行数、报告，不以文件存在/Issue closed 替代行为证据。',
 '两公司/两团队、个人与公司 Payer、撤权/停止/审批恢复、记忆审核和 Craft 预览无回退。',
 'native/driven 测试实际执行可对账；适用 typecheck/lint/build 通过，真实环境阻塞明确说明。',
 'fresh/upgrade DB、登录组件兼容组合、排空新状态后回滚均演练，外部动作不自动重放。',
 '独立 Spec + quality Review 通过；OCR 覆盖原始 BASE 到 HEAD 及全部未提交交付，无失败/跳过文件造成的覆盖空洞。',
 '有效 critical/high/medium finding 经编号修复计划→SDD→复验→复审→完整 OCR，直到消除；真实 blocker 不记完成。',
 '所有验证/审查/延期决定持久保存，清理前可恢复；推送、合并、生产迁移/发布依授权另行处理。'],verification='完整集成范围、真实部署形状回归、迁移/回滚演练和完整 OCR 报告。',boundary='整体验收与常规修复；不自动取得生产上线或共享分支权限。',produces='可审阅最终交付包及剩余限制。')
]


def build():
    state = OUT/'tickets.json'
    if state.exists():
        current = json.loads(state.read_text())
        if current.get('parent_issue') or any(t.get('issue_number') for t in current.get('tickets', [])):
            raise SystemExit('Refusing to overwrite a publication manifest containing real Issue identifiers.')
    OUT.mkdir(parents=True,exist_ok=True)
    (OUT/'issues').mkdir(exist_ok=True)
    parent='UP-SPEC'
    manifest=dict(repo='1123786563/OpenBot',feature='upstream-openbot-update',parent_key=parent,parent_issue=None,status='draft-awaiting-review',publication_authorized=False,implementation_started=False,spec=SPEC,implementation_plan=PLAN,proposed_labels=['enhancement','ready-for-agent'],parent_body_file='parent-issue.md',tickets=[])
    for t in TICKETS:
        refs=', '.join(t['depends_on']) or '无（完成执行基线核验后可开始）'
        roles=' → '.join(t['roles'])
        body=f"""## Parent

UP-SPEC：OpenBot 上游能力更新（本地父 Spec 草稿，待发布；这里不是 GitHub 编号）。

## What to build

{t['deliver']}

## Acceptance criteria

"""+'\n'.join('- [ ] '+x for x in t['criteria'])+f"""

## Blocked by

{refs}。

以上仅列真实交付前置。默认串行调度不产生额外业务依赖；父子 contains 也不代表执行依赖。

## Scope boundary

{t['boundary']}

## Verification

{t['verification']}

## Handoff

- 覆盖父验收：{', '.join(t['acceptance'])}。
- 实现专业角色：{roles}；跨端按明确协议先后派发，单票作为完整业务验收单位。
- 内部实施 Task：{', '.join(t['plan_tasks'])}；共享 S00 是执行准备，不重复实现。
- Produces：{t['produces']}
- 事实源：父 Spec、仓库 CONTEXT/适用 ADR，以及 tickets manifest 指向的详细实施计划。文件级所有权与测试命令在实施计划，不复制到本票。
- 前置通过须有已审查检查点并集成到当前执行工作区；标签/关闭状态不替代证据。
- 复用同版本有效验证；实现者不批准自己的交付，验证者不修改业务/测试源修到通过。
- 交付前绑定 Git 状态/哈希、验证证据、Spec/quality 两项 Review。缺环境记 blocked，不把 skipped 算通过。
- 当前是未发布草稿。任何发布、实施、提交、推送、合并或生产上线按用户实际授权处理，不从本票状态推导。
"""
        file='issues/'+t['id'].lower()+'.md'
        (OUT/file).write_text(body)
        manifest['tickets'].append(dict(t,file=file,published_title=f"[Upstream {t['id']}] {t['title']}",status='proposed',issue_number=None,issue_id=None,url=None,body_sha256=hashlib.sha256(body.encode()).hexdigest()))
    spec=(ROOT/SPEC).read_text()
    pbody='## Status\n\n本地待审阅父 Spec 草稿；发布前按已确认决定更新状态。\n\n'+spec+'\n\n## Proposed sub-issues\n\n'+'\n'.join(f"- [ ] {t['id']}：{t['title']}（依赖：{', '.join(t['depends_on']) or '无'}）" for t in TICKETS)+'\n'
    (OUT/'parent-issue.md').write_text(pbody)
    manifest['parent_body_sha256']=hashlib.sha256(pbody.encode()).hexdigest()
    (OUT/'tickets.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    print('Generated local parent + 12 issue drafts. No tracker changes.')

if __name__=='__main__':
    build()
