# -*- coding: utf-8 -*-
from pathlib import Path
import json,re,hashlib,datetime,subprocess
ROOT=Path.cwd(); D=ROOT/'docs/design/2026-10-20-workspace-redesign'; O=D/'handoff/refinement'
if (O/'implementation-detail.md').exists():
 raise SystemExit('Historical first-round generator: second-round refinement exists. Do not overwrite; reconcile the new detail and metadata before regenerating.')
J=lambda p:json.loads(p.read_text())
def write(name,v): (O/name).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n' if not isinstance(v,str) else v)
pages=J(D/'pages.json')['pages']; pages[6]['mobile']='纵向排列，待办置前；配置/管理组默认展开，危险操作独立（取代旧稿折叠候选）。'; routes=J(D/'pages.json')['routes']; evidence=J(O/'source-evidence.json'); bysrc={e['source']:e for e in evidence}
# Values are proposal data only; this script never writes app/.
colors={
'canvas':('#F5F7FA',
'#111318'),
'surface':('#FFFFFF',
'#191D26'),
'overlay':('#FFFFFF',
'#242B38'),
'foreground':('#192131',
'#EBEFF7'),
'hover-surface':('#EEF1F6',
'#242B38'),
'hover-surface-foreground':('var(--ob-foreground)',)*2,
'muted-surface':('var(--ob-hover-surface)',)*2,
'muted-text':('#526079',
'#A2ACBE'),
'action':('#315FCF',
'#3D6BDA'),
'action-foreground':('#FFFFFF',)*2,
'action-hover':('#2853BD',
'#345FC7'),
'secondary-surface':('var(--ob-muted-surface)',)*2,
'secondary-foreground':('var(--ob-foreground)',)*2,
'brand':('var(--ob-action)',)*2,
'brand-foreground':('var(--ob-action-foreground)',)*2,
'danger':('#B32745',
'#FF9EA7'),
'danger-foreground':('#FFFFFF',
'#30141B'),
'danger-soft':('color-mix(in srgb, var(--ob-danger) 10%, var(--ob-surface))',)*2,
'success':('#16704D',
'#69D5AC'),
'success-foreground':('#FFFFFF',
'#10231B'),
'border':('#D8DFE9',
'#303949'),
'field-border':('var(--ob-control-border)',)*2,
'field-background':('var(--ob-surface)',)*2,
'focus':('#315FCF',
'#8DB4FF'),
'sidebar':('#EEF1F6',
'#0D1015'),
'sidebar-foreground':('var(--ob-foreground)',)*2,
'sidebar-primary':('var(--ob-accent-text)',)*2,
'sidebar-primary-foreground':('var(--ob-foreground)',)*2,
'sidebar-accent':('#E2E8F2',
'#242B38'),
'sidebar-accent-foreground':('var(--ob-foreground)',)*2,
'sidebar-border':('var(--ob-border)',)*2,
'sidebar-ring':('var(--ob-focus)',)*2,
'chart-1':('#315FCF',
'#8DB4FF'),
'chart-2':('#8B570B',
'#F0BE69'),
'chart-3':('#16704D',
'#69D5AC'),
'chart-4':('#7040AD',
'#C3A2F2'),
'chart-5':('#A02C76',
'#F09ACB'),
'radius':('8px',)*2,
'shadow-card':('none',)*2,
'control-border':('#7A879B',
'#68788F'),
'accent-text':('#315FCF',
'#8DB4FF'),
'warning':('#8B570B',
'#F0BE69'),
'warning-foreground':('#FFFFFF',
'#2A1D08'),
'warning-soft':('color-mix(in srgb, var(--ob-warning) 10%, var(--ob-surface))',)*2,
'success-soft':('color-mix(in srgb, var(--ob-success) 10%, var(--ob-surface))',)*2,
'disabled-background':('var(--ob-muted-surface)',)*2,
'disabled-foreground':('var(--ob-muted-text)',)*2,
'shadow-overlay':('0 8px 24px rgb(25 33 49 / .12)',
'none'),
'backdrop':('rgba(0,0,0,.24)',
'rgba(0,0,0,.60)'),
'layout-app-sidebar':('280px',)*2,
'layout-config-sidebar':('256px',)*2,
'layout-rail':('64px',)*2,
'layout-prose':('672px',)*2,
'layout-wide':('1024px',)*2,
'layout-chat':('720px',)*2,
'layout-main-min':('480px',)*2,
'layout-craft-session':('224px',)*2,
'layout-craft-output':('420px',)*2}
old=set(re.findall(r'--ob-([\w-]+)\s*:',(ROOT/'app/src/styles/tokens.css').read_text()));assert old<=set(colors)
write('theme-contract.json',{'status':'待用户审阅',
'value_owner':'app/src/styles/tokens.css @layer ob-tokens',
'native_mapping_owner':'app/src/styles/heroui-theme.css @layer ob-theme',
'legacy_owner':'app/src/styles/legacy-ui-bridge.css @layer ob-legacy',
'existing_tokens':len(old),
'tokens':[{'name':'--ob-'+k,
'light':v[0],
'dark':v[1],
'existing':k in old} for k,v in colors.items()]})

def resolve(imp,src):
 p=(ROOT/'app/src'/imp[2:]) if imp.startswith('@/') else ROOT/src.parent/imp if imp.startswith('.') else None
 if p:
  for x in [p.with_suffix('.tsx'),p.with_suffix('.ts'),p/'index.tsx',p/'index.ts']:
   if x.is_file():return x.resolve().relative_to(ROOT)
 return None

def closure(starts):
 seen=set();todo=[Path(p) for p in starts]
 while todo:
  p=todo.pop()
  if p in seen or not (ROOT/p).is_file():continue
  seen.add(p);s=(ROOT/p).read_text()
  for imp in re.findall(r'(?:from\s+|import\s*\()["\']([^"\']+)',s):
   q=resolve(imp,p)
   if q and str(q).startswith('app/src/components/') and q not in seen:todo.append(q)
 return sorted(str(p) for p in seen)

# Independent accept/reject units; no production execution during refinement.
configs=[
('T01',
'主题变量与样式所有权',[],[], 'B1', ['app/src/styles/tokens.css',
'app/src/styles/heroui-theme.css',
'app/src/styles/legacy-ui-bridge.css',
'app/src/styles.css',
'app/DESIGN.md'],
 ['按 theme-contract.json 覆盖全部39个现有 token，添加 control-border/accent-text/warning 等确定值；保留导入分层和单一主题存储。',
'按 Spec §2 映射完整 HeroUI 原生变量，包括 background/foreground/border/radius/success/field 与 soft/hover；legacy input 改为 control-border。',
'在 DESIGN.md 记录待审阅稿获授权后的实际采用值；用真实 input/button/原生控件与 portal computed style 对照两主题，修复任何 fallback 默认值。'],['theme-preference',
'user-preferences'], '主题切换、首绘与portal配对；变量循环/未覆盖原生字段是阻塞问题'),
('T02',
'公共 wrapper 的状态与尺寸',[],['T01'],
'B1',[str(p.relative_to(ROOT)) for p in (ROOT/'app/src/components/ui').glob('*.tsx')],
 ['按 Spec §3 调整 Button cva 和 RouterLink 同源样式；保留 variant/size/mergeRefs/render 与真实 anchor。',
'Input/Textarea/Select/Combobox 去掉抵消 field fill 的中性化类，设置 1px control boundary、8px radius、2px focus；不动 identity/null/onChange。',
'Dialog/Sheet scrim 归 --ob-backdrop；菜单/tooltip surface 与 layer 保持；粗指针命中44px，disabled说明保持可读。'],['button-native',
'form-submit-controls',
'heroui-spike',
'composing-enter'],
'表单/ref/原生事件、anchor、portal焦点和嵌套ESC'),
('T03',
'外壳、PageShell 与通用详情响应式',[],['T02'],
'B1', ['app/src/routes/_authed/_app.tsx',
'app/src/routes/_authed/settings/route.tsx',
'app/src/routes/_authed/admin/route.tsx']+[str(p.relative_to(ROOT)) for p in (ROOT/'app/src/components/layout').glob('*.tsx')],
 ['设置三壳宽280/256/256、轨总宽64、移动Drawer min(280,100vw-32)；PageShell prose672/wide1024，PageRows圆角12。',
'SidebarShell 显式偏好与自动布局分离；增加可选 responsiveCompact:boolean=false，仅影响有效open，不写存储；用户本次显式toggle优先。SidebarToggle可达和快捷键合同不变。',
'DetailPanel MIN_MAIN_WIDTH=480，默认右栏400，保留调用方宽度；处理跨分支同一打开详情的本地输入状态保留，关闭后仍沿用原卸载策略。',
'遍历全部DetailPanel调用者，C=879/880、959/960处校验Sheet/并排；测试高度受限与底部可达。'],['sidebar-preference',
'sidebar-shortcut-layouts',
'computer-control-button'],
'响应式不污染偏好；所有DetailPanel消费者，含Skills/Craft tasks'),
('T04',
'Bots 名册与工作详情',[6,7],['T03'],
'B1',[],
 ['保留groupRoster分组算法和needsYou/pinned/yours/shared/hidden顺序，仅重排/统一行的视觉层级。',
'32px头像、64px最小行、名称和摘要两层；操作独立44px空间；隐藏区默认折叠，键盘可展开。',
'Bot详情身份→待办建议→启用通知→活动→配置→管理，全部配置/管理组展开；保留建议、审批与危险确认。'],['bot-roster',
'bot-needs-you',
'bot-profile',
'bot-manage',
'bot-settings-rows'],
'成员/管理员/本人/共享只读，长名称与部分请求失败'),
('T05',
'Bot 配置完整路径',list(range(8,16)),['T04'],
'B1',[],
 ['逐页应用672px配置组，按route-acceptance内content_order保留所有字段/入口。',
'职责/投递/记忆/审批/例行/能力/共享/基础设置分别保持当前对象与能力门禁；只修改布局和通用样式override。',
'打开每页的编辑弹窗/授权菜单，在窄屏校验长说明、敏感值掩码、保存失败不丢输入；不扩展模型授权或共享范围。'],['bot-responsibilities',
'bot-reaching-you',
'bot-memory',
'bot-approval',
'bot-sharing',
'bot-setup',
'bot-access'],
'资源归属/可管理能力、保存失败、Dialog内Select与键盘'),
('T06',
'Bot 运行、评估与导出链',list(range(16,24)),['T05'],
'B1',[],
 ['保留requireBotObservabilityAccess、父Outlet与详情返回链；使用1024px数据列，技术明细内部横滚。',
'runs/detail/datasets/evaluations/results/comparison/exports按各页源字段调整层次；先显示可用性再显示数据。',
'比较窄屏上下排且单位/方向/缺失相邻；同步中不当故障、未知不当0；不新增I-01入口组。'],['ai-observability',
'observability-route-guards'],
'父子路由链、canManage拒绝、缺失/禁用/上游故障与下载可用性'),
('T07',
'首页、新会话、单聊与群聊',[1,2,3,4,5],['T06'],
'B1',[],
 ['聊天阅读列720、顶栏48、message区域内部滚动、Composer为底部flex项；首页输入优先，无可用Bot如实呈现。',
'保持settings/watch/workshop互斥与show()和URL/Back；电脑400/工作坊480、容器门槛880/960；不复制任务状态或添加API。',
'保留群聊成员身份；/bot独立入口保留；校验首条失败草稿/附件、IME、stop/retry、上下文切换与电脑控制。'],['composer-',
'composing-enter',
'channel-',
'stopped-turn',
'transcript-attachments',
'computer-',
'failed-send'],
'输入/流式/滚动/附件、URL与控制释放；真实runtime缺失不得假称通过'),
('T08',
'首批独立验收与Review关卡',list(range(1,24)),['T07'],
'B1',[],['按verification-plan执行B1全矩阵与受影响页面冒烟，证据绑定B1检查点。',
'独立reviewer分别出Spec compliance/quality结论，再主控按OCR skill覆盖真实增量与完整交付；有效中高问题进入修复计划。'],[], 'T01–T07增量+首批完整交付；不签收未实施的后续页面'),
('T09',
'Craft 多面板会话与计划任务',[26,27,28],['T08'],
'B2',['app/src/components/craft/workspace-layout.tsx'],
 ['新增workspace-layout.tsx稳定挂载单个ChatPanel/OutputPanel，按Spec §6 C阈值与viewport表显示session224/chat480/output420。',
'保持draft/attachments/selected session/subagent/stream；输出tab首次挂载后保留实例，隐藏区inert；保持preview同一iframe及fullscreen定位前提。',
'index不自动建session；tasks编辑沿用DetailPanel；逐项验证390→1440→390切换、Sheet互斥、关闭/重开与后台运行。'],['craft-',
'scheduled'],
'iframe实例/草稿附件不丢、预览隔离与ticket不变'),
('T10',
'个人设置与账号完整路径',list(range(29,39)),['T03',
'T08'],
'B3',[],
 ['按Spec §7设置行和672px列处理偏好/通知/审批/记忆/账号/模型授权/密码；图库保留预览隔离。',
'设置导航256，窄屏标签在前；连接账号保留已有搜索、个人/共享/关联分组；gallery两列到单列。',
'验证绑定码预览再确认、无权限/过期、撤销、密码掩码；不改付款/公司归属或凭空授权。'],['user-preferences',
'update-routing',
'memory-settings',
'user-authorizations',
'model-picker',
'gallery-components',
'sign-in-card'],
'个人/共享身份、授权预览确认、保存失败与主题存储'),
('T11',
'个人账务与账户归属',[39,40,41],['T10'],
'B3',[],
 ['按1024px列重排订阅/个人积分/购买/发放/消费；显式显示原payer和币种，保留整数精度。',
'订单/账单/下载弹窗保持确认与分页；窄屏摘要/具名表格内部横滚，不删金额或状态。',
'测试未启用/无消费/读取异常/支付中与下载不可用，视觉不触发真实扣款。'],['billing-',
'invoice-'],
'个人与公司账户不得合并；金额/有效期/幂等与错误态'),
('T12',
'个人技能与跨Bot例行',[24,25],['T08'],
'B4',[],
 ['保持技能个人/工作区分组与选中编辑，新建/保存/取消在DetailPanel内，C门槛沿用T03。',
'例行任务显示所属Bot/调度/最近运行；与Craft任务和workshop schedules独立。',
'对长指令/编辑失败/无技能与只读进行表单和窄屏复核。'],['skills-read-failure',
'bot-access-skills'],
'长编辑区、保存失败与领域范围'),
('T13',
'管理目录与模型配置',list(range(42,47)),['T08'],
'B4',[],
 ['保留目录型admin首页与现有分组，无聚合指标。',
'凭据/服务/网关/目录使用672px表单或1024px记录列，status先于配置，所有弹窗同主题。',
'验证敏感值掩码、网关未配置/连接或认证失败、模型同步异常，不改变注册和开放权限。'],['admin-gateway',
'admin-catalog',
'model-picker'],
'admin guard、敏感字段、失败不当空数据'),
('T14',
'治理、电脑、人员与计费管理',[47,48,49,64,65,66,67,68],['T13'],
'B4',[],
 ['边界/团队审批/电脑目录按原对象分组，试运行输入与结果相邻、目录长路径可读。',
'人员与身份提供方保留角色/访问/删除确认；admin billing保留发放对象和清理执行状态。',
'审计1024px具名横滚；enterprise保留既有直达URL，I-02入口不新增；不改变策略锁定和付款主体。'],['boundaries-',
'approval-team',
'computer-driving',
'admin-credit',
'model-billing',
'audit-'],
'试运行/策略只读、真实维护动作不可因视觉验收触发'),
('T15',
'连接器和工具授权',list(range(50,56)),['T14'],
'B4',[],
 ['连接器列表→服务→Bot授权→工具规则保持返回链；按672px配置组与状态层次调整。',
'Composio/Open Connector保留各自字段、已有搜索、配置及添加操作；异步busy按条目保留。',
'验证共享账号模式影响确认、错误与禁用、普通成员拒绝；不把可连接等同本人已授权。'],['plugin-',
'composio-',
'brokered-account',
'approval-tools'],
'账号模式/服务身份/Bot身份、异步逐项状态'),
('T16',
'知识库创建与文档检索',[58,59],['T08'],
'B5',[],
 ['知识库列表保持新建/删除，详情按添加→上传→文档→检索顺序。',
'按Spec §7宽屏C≥1000/viewport≥1280时检索辅助320px，其他单列；文档既有筛选/排序/批删保留。',
'验证上传/处理/失败/空文档/无检索结果分别显示；选择跨行与批量删除确认保持，390px发送/上传可达。'],['knowledge',
'upload-'],
'上传任务/文档/检索各自状态，不新增切片/命中指标'),
('T17',
'部署技能、市场与学习配置',[56,57,60],['T15'],
'B4',[],
 ['部署技能作用范围清晰，长指令弹窗；市场复用当前专家/技能/连接器Tab与详情，不增加评分/价格。',
'统一market wb组件视觉override；宽屏三列/中两列/窄单列，保留admin能力控制。',
'学习配置按真实设置/目标/容器与投递状态排列；测试字段无效/容器未就绪/保存失败。'],['learning-admin',
'proposed-',
'authoring-tool'],
'部署与个人范围、市场现有操作与容器异常'),
('T18',
'组件管理与Playground',[61,62,63],['T17'],
'B4',[],
 ['组件目录/详情统一表面，配置Sheet保持原表单与预览实例。',
'Playground按C≥960且viewport≥1280双列，否则编辑/预览切换；稳定挂载保留draft，代码区域内部横滚。',
'验证非法输入、渲染失败、readonly/配置错误；不扩大执行或网络权限。'],['component-preview',
'playground-json',
'gallery-components'],
'代码/预览隔离、切换不丢草稿'),
('T19',
'管理可观测性双地址',[69,70],['T06',
'T14'],
'B4',[],
 ['两个URL保留同一ObservationAdminSummaryPage，按采集就绪/健康→范围→已有汇总顺序。',
'窄屏逐行展开，未知数量不归零；保持非管理员拒绝与原时间范围。',
'分别直达两地址及刷新返回，不能只测其中一个；I-02不改。'],['ai-observability-admin',
'observability-route-guards'],
'同组件双地址、能力缺失/同步/上游故障'),
('T20',
'认证、引导、租户与公开分享',list(range(71,77)),['T08'],
'B6',[],
 ['登录384px、引导/服务登录/选择公司团队672px、分享1024px；沿用现有步骤和公共/私有边界。',
'平台登录和为Bot登录服务明确来源；租户公司/团队两层不合并；分享不显示内部导航。',
'验证无提供方/请求过期/成员撤销/分享失效、长内容和200%缩放，不修改授权或执行维护动作。'],['sign-in',
'multitenancy',
'home-fallback',
'root-drop'],
'重定向/登录目标/租户隔离/公共分享泄露'),
('T21',
'全站验收与兼容收口',list(range(1,77)),['T09',
'T11',
'T12',
'T16',
'T18',
'T19',
'T20'],
'B7',[],
 ['重扫76/4/7及所有route-acceptance，兼容跳转按参数/返回/权限验收。',
'按独立检查点执行全站测试/类型/构建/静态检查/浏览器证据；逐页签收，不能以代表页签76页。',
'独立Spec/quality review与完整OCR，真实中高问题修复复审；记录低风险延期、环境阻塞及所有权范围后再收尾。'],[], '原始交付全范围与本次相对脏基线真实增量，全部有效中高finding清零')]

owned={}; tasks=[]
for tid,title,nums,deps,batch,extra,steps,testkeys,review in configs:
 selected=[p for p in pages if int(p['id'][1:]) in nums]
 candidates=[f for f in closure([p['source'] for p in selected]) if f.endswith('.tsx')]+extra
 if tid in ['T08',
'T21']:candidates=[]
 # Assign each production file once. ui/sidebar belongs T03 for geometry and persistence.
 if tid=='T02':candidates=[p for p in candidates if p!='app/src/components/ui/sidebar.tsx']
 if tid=='T03':candidates+=['app/src/components/ui/sidebar.tsx']+closure(['app/src/components/app-sidebar/app-sidebar.tsx','app/src/components/settings/settings-sidebar.tsx','app/src/components/admin/admin-sidebar.tsx'])
 predecessors={owned[p] for p in candidates if p in owned and owned[p]!=tid}
 files=[]
 for p in sorted(set(candidates)):
  if not p.endswith(('.tsx','.css','.md')):continue
  if p not in owned:owned[p]=tid;files.append(p)
 # Prior shared components are consumers only, never duplicate writers.
 for pred in sorted(predecessors):
  if pred not in deps:deps.append(pred)
 tests=sorted(str(p.relative_to(ROOT)) for p in (ROOT/'app/tests').rglob('*.test*') if any(k in p.name for k in testkeys))
 tasks.append({'id':tid,
'title':title,
'source_pages':[p['id'] for p in selected] if nums else [p['id'] for p in pages],
'task_kind':'foundation' if tid in ['T01','T02','T03'] else 'gate' if tid in ['T08','T21'] else 'page_delivery',
'source_issues':[],
'acceptance':[f'{p["id"]}: '+ '；'.join(p['actions']) for p in selected] or [review], 'depends_on':deps,
'dependency_basis':'公共主题→wrapper→骨架；业务组件import共享依赖按唯一写入者自动补边；批次gate为验收前置，非contains推断',
'batch':batch,
'owner_role':'frontend_validator' if tid in ['T08',
'T21'] else 'frontend_implementer',
'validator_role':'frontend_validator',
'reviewer_role':'reviewer',
'owned_files':files,
'test_files':tests,
'Consumes':[f'{d} verified checkpoint 中已审查的 token/公共props/业务组件' for d in deps],
'Produces':[review+'；不改变现有数据与事件公共API'],
'steps':steps,
'verification':['V-STATIC',
'V-NATIVE',
'V-DRIVEN',
'V-BROWSER'],
'review_scope':review,
'status':'pending',
'checkpoint':None})
# No cycle, including inferred edges; no page may disappear.
seen=set()
for t in tasks:
 assert set(t['depends_on'])<=seen,(t['id'],t['depends_on'],seen)
 seen.add(t['id'])
coverage={p['id']:next(t['id'] for t in tasks if p['id'] in t['source_pages'] and t['id'] not in ['T08',
'T21']) for p in pages}
for t in tasks:
 t['verification_commands']=['bun run --cwd app typecheck','bun run --cwd app build',f"E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/{t['id'].lower()}/r01/native bunx e2e run --config e2e.unit.config.ts",f"E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/{t['id'].lower()}/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts"]
 if t['id']=='T16':t['verification_commands'].append('E2E_BUN_ONLY=app/src E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t16/r01/driven-src bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts')
 if t['id']=='T21':t['verification_commands'].append('bun run test:ci')
write('tasks.json',{'status':'draft_not_authorized',
'tasks':tasks,
'file_owners':owned})

# Per route explicit acceptance, backed by source evidence, not an atlas screenshot claim.
accept=[]
for p in pages:
 num=int(p['id'][1:]);task=coverage[p['id']];ev=bysrc[p['source']]
 permission=('admin角色；非管理员沿/admin布局redirect到/，不能读取管理数据' if p['path'].startswith('/admin') else
 '公开token可读；失效/撤销不显示内部资源或侧栏' if num==76 else '未登录入口；已登录按原/sign beforeLoad返回/' if num==71 else
 '登录+onboarding边界；服务端canManage及可观测guard，直接URL和嵌套子路由均不得绕过' if 16<=num<=23 else
 '登录+onboarding边界；本人/共享可读/不可访问Bot分别测，修改动作依服务端能力' if 7<=num<=15 else
 '登录+onboarding边界；保留当前公司/团队/个人授权范围，拒绝时不显敏感内容')
 long=('120字中英文名称、300字说明、200字符ID/地址、100条列表；名称换行或截断不挤出动作；完整内容在详情可读')
 if p['template']=='chat':long+='；100条消息、长代码与多附件仅内容区横滚，滚动锚点/软键盘输入可达'
 if p['template']=='billing' or num in [40,41,65]:long+='；最大金额/币种/到期日期不裁切，不合并payer'
 if p['template'] in ['config',
'editor']:long+='；长textarea输入/保存失败保留，label/error关联不丢'
 if num==27:long+='；iframe/文件树长路径内部滚动；切换不断流不重载iframe'
 source_components=closure([p['source']])
 accept.append({'id':p['id'],
'path':p['path'],
'source':p['source'],
'source_sha256':ev['sha256'],
'source_evidence':'source-evidence.json#'+p['source'],
'implementation_task':task,
'shared_tasks':['T01','T02','T03'],
'batch':next(t['batch'] for t in tasks if t['id']==task),
'template':p['template'],
'existing_capabilities':p['actions'],
'capability_evidence':{'basis':'路由及递归组件静态源码；不是运行成功证据',
'component_sources':source_components,
'existing_states_to_preserve':p['states']},
'change_scope':{'existing_capability':'不增加数据接口或能力；上述动作按源码合同保留',
'visual':'implementation-spec §2–4；两主题token/wrapper/字体/密度',
'layout': ('implementation-spec §5；DetailPanel 400→480为显式布局变化' if num==5 else 'implementation-spec §5–7；'+p['mobile']) if 'L' in p['change'] or num in [5,28,63] else '共享骨架宽度变化，页面现有区域顺序保持',
'new_behavior':'仅Craft/Playground的本地视图切换与保留状态' if num in [26,27,28,63] else '无新增业务行为',
'navigation':'I-01/02/03排除'},
'content_order':p['sections'],
'normal':{'actions':p['actions'],
'expected':'现有动作可达且事件一次，区域顺序与content_order一致'},
'exception':{'cases':p['states'],
'expected':'加载/空/错误/禁用区分；背景失败保留已有内容，保存失败保留输入；恢复仅沿用现有入口'},
'permission':{'case':permission,
'evidence_required':'角色/范围fixture、实际guard结果或对应自动化结果；禁止只凭按钮外观判定'},
'long_content':{'case':long,
'expected':'390px无整页横滚；200%缩放全部字段与动作可达'},
'narrow_screen':{'widths':[390,768,1280,1440],
'rule':p['mobile'],
'additional':'遵守Spec中的容器空间门槛；自动布局不写用户偏好'},
'notes':p['note'],
'acceptance_evidence':{'status':'not_run',
'required':['最终真实URL与已替换参数',
'checkpoint清单SHA256',
'身份/租户/能力与脱敏fixture来源',
'主题/语言/viewport/DPR/zoom',
'正常和本页异常/权限/长内容截图与操作trace',
'DOM/computed-style对比度、焦点与溢出结果',
'适用native/driven结果及独立Spec/quality review'],
'directory':f'docs/verification/workspace-redesign/{task.lower()}/'+p['id']}})
layout=[]
for r in routes:
 if r['kind']=='layout':layout.append({**r,
'task':'T03',
'permission':'保持源码beforeLoad；_authed登录/onboarding，admin额外role',
'checks':['展开/折叠刷新与快捷键',
'自动缩窄不写localStorage',
'Drawer关闭焦点恢复',
'内部滚动/文档滚动与skip link'],
'evidence':'V-BROWSER+V-STATIC，同checkpoint'})
redirects=[]
for r in routes:
 if r['kind']=='redirect':redirects.append({**r,
'task':'T21',
'target':J(D/'pages.json')['redirects'][r['url']],
'checks':['直接访问URL',
'search参数new/agent的实际分支（适用/agents）',
'刷新/Back/登录权限',
'不产生新的导航项或循环'],
'source_sha256':bysrc[r['source']]['sha256'],
'status':'not_run'})
write('route-acceptance.json',{'schema_version':1,
'status':'待用户审阅，生产验收未执行',
'count':{'pages':len(accept),
'layouts':len(layout),
'redirects':len(redirects)},
'scan':'route-rescan.json',
'pages':accept,
'shared_layouts':layout,
'compatibility_redirects':redirects,
'root_runtime':{'source':'app/src/routes/__root.tsx',
'note':'根路由createRootRoute非createFileRoute，不计第88个页面；主题/错误边界/portal回归由T01–T03覆盖'}})

# Source-backed page-by-page delta table plus concentrated ambiguity rulings.
gaps='''# 设计与源码差异表\n\n状态：待用户审阅；静态源码核对，不是运行验收。源码行证据与哈希见 source-evidence.json；完整当前基线见 baseline.json。生产文件未修改。\n\n## 关键差异与明确决定\n\n| ID | 分类 | 源码证据 | 本稿决定 | 阻塞首批？ |\n| --- | --- | --- | --- | --- |\n| G01 | 视觉变化 | styles/heroui-theme.css 空 ob-theme；legacy-ui-bridge 不声明 background/foreground/border/radius/success | T01完整原生变量表，不仅改ob值 | 需审阅Spec后放行 |\n| G02 | 视觉变化 | tokens.css field-border透明；legacy input→ob-border；input/textarea中性化class | 字段1px control边界、稳定填充；legacy input改control；muted始终文本 | 已确定，无技术歧义 |\n| G03 | 布局变化 | _app.tsx width340；settings/admin route width300；ui/sidebar icon3.2rem | 280/256/64，prose672/wide1024 | 已确定 |\n| G04 | 布局变化 | DetailPanel MIN_MAIN_WIDTH400、default400；channel SCREEN400/WORKSHOP480 | 主下限480；右宽400/480保持；880/960阈值，所有调用者验证 | 已确定；不是纯换肤 |\n| G05 | 既有能力 | channel route validateSearch/show settings/watch/workshop互斥；WorkshopPanel有process/files/artifacts/usage/share/schedules | 复用既有视图/权威状态，不造统一任务API或第二套运行状态 | 不阻塞 |\n| G06 | 新增行为（仅局部视图） | craft route固定420输出；ChatPanel本地draft；OutputPanel条件渲染tab；PreviewTab同iframe fullscreen | T09稳定挂载+hidden/inert+首次懒挂载tab；按C1124/900和viewport切换 | 后续B2，不阻塞首批 |\n| G07 | 既有能力 | BotRoster调用groupRoster、hidden本地展开；BotProfile及settings-rows/manage | 保留分组；详情配置不默认折叠；不造指标/搜索 | 不阻塞 |\n| G08 | 既有能力/布局变化 | knowledge.$kbId AddDocument→UploadTasksPanel→DocumentList→RetrievalTest；已有keyword/sort/selected/bulkDelete | 原顺序保留，宽屏检索320辅助列，窄屏单列；保留真实筛选/批删 | 后续B5 |\n| G09 | 视觉变化 | app/DESIGN.md声明issue502默认HeroUI；README当前新方向仍提案 | 它是当前基线；本稿待审阅的新方向覆盖候选，不冒称已批准 | 用户审阅本稿 |\n| G10 | 新导航候选 | Bot观测路由guard；admin enterprise/observability现有导航未完整归组 | I-01/I-02单独决定；本稿均不实施，I-03不合并 | 不阻塞基础方案 |\n| G11 | 既有能力 | CONTEXT payer/tenant/workspace；usage/orders/billing模型授权组件 | 个人/公司账户和登记/授权不因视觉统一混并 | 不阻塞；发现冲突即停相关Task |\n| G12 | 证据差异 | visual-atlas纯HTML；h15 REPORT UI engine blocked、全仓194红；索引304状态不含生产DOM | 新生产证据单独取得，不把既有报告或atlas当新checkpoint通过 | 浏览器真实runtime/身份是执行前置 |\n| G13 | 文档差异 | handoff source-baseline155项仅SHA256.json变化 | 记录实际哈希、不回退；路由87声明无变化 | 不阻塞 |\n| G14 | 视觉变化/语义保留 | button cva+HERO_VARIANT、mergeRefs/adaptRender；router-link真anchor | 修改视觉class，不重写ref/原生事件/link语义；旧“black action”注释同步修正 | T02必须验证 |\n| G15 | 布局变化 | sidebar-shell effect持久化open，mobile20rem变量未消费、primitive18rem | 显式偏好与responsiveCompact分离；移动宽度统一真正消费的变量 | T03必须验证 |\n| G16 | 布局变化 | PageShell文档滚动与_app内部滚动不同 | 保留两种纵向滚动合同，不把设置页强行h-svh裁切 | 不阻塞 |\n\n## 五图落实矩阵\n\n| 图 | 实施结构 | 排除/差异 | Task/证据 |\n| --- | --- | --- | --- |\n| 01 chat | 导航→会话顶栏/消息/Composer→按需上下文 | 不造搜索/审批中心/统一任务API；示例矛盾状态不采纳 | T03/T07；P03实际URL+workshop/watch/settings，各880/960边界 |\n| 02 knowledge-mobile | 身份→添加→上传→文档→检索→结果 | 排除顶部评审控制、P索引、源码说明和页脚；不固定截图宽度 | T16；P59真实390px及宽屏辅助列 |\n| 03 settings-light | 单层设置导航→居中分组行 | 排除外侧P01索引；字号按产品14/22而非缩略图 | T03/T10；P29亮暗/label/保存失败 |\n| 04 Craft | 全局导航/session/chat/output，多种本地视图 | 排除评审外框；保留224/480/420可读尺寸和同一iframe | T09；P27运行中390↔1440及Tab保留状态 |\n| 05 Bots | 应用导航→标题/创建→需要你/置顶/自己/共享/隐藏 | 排除外层P索引、虚构资源与假头像，不改算法 | T04；P06分组/长名/隐藏展开/错误 |\n\n## 逐页差异绑定\n\n每行的“既有能力”来自路由与递归源组件的静态核对，动态成功状态必须由实施验证取得。V=视觉变化；L=布局变化；N=局部视图行为。这里不把目标状态等同已经在本机复现。\n\n| 页 | 分类与源码 | 保留能力 | 决定与差异 | 首批/阻塞 |\n| --- | --- | --- | --- | --- |\n'''
for a in accept:
 p=next(p for p in pages if p['id']==a['id']);cls='既有能力 / 视觉变化'+(' / 布局变化' if 'L' in p['change'] or a['id'] in ['P05',
'P28',
'P63'] else '')+(' / 新增局部视图行为' if a['id'] in ['P26',
'P27',
'P28',
'P63'] else '')
 gaps+=f'| {a["id"]} {a["path"]} | {cls}；`{a["source"]}` | '+ '、'.join(p['actions'])+' | '+a['implementation_task']+'；'+p['note']+'；'+p['mobile']+' | '+('B1，审阅后无额外产品决定' if a['batch']=='B1' else '后续独立批次，不阻塞B1')+' |\n'
write('gap-analysis.md',gaps)

# Machine-readable DAG is canonical; markdown adds explicit task steps and role contracts.
head='''# OpenBot Workspace Redesign Implementation Plan\n\n> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.\n\n**Goal:** 将76页的既有能力落到统一HeroUI主题与五图布局，首批仅T01–T08。\n\n**Architecture:** tokens→原生映射→wrapper→共享骨架；各业务在现有数据/权限/状态接口上做视觉与明确的布局变化。稳定挂载负责局部多面板切换，领域状态仍由原组件与服务拥有。\n\n**Tech Stack:** React19、Tailwind4、HeroUI v3当前安装版、TanStack、Bun与tester-army e2e。\n\n**Spec:** [implementation-spec.md](./implementation-spec.md)，**待用户审阅，本计划是草案，不构成实施授权**。\n\n## Global Constraints\n\n- 不提交/推送/合并/发布、不安装产品依赖、不创建对外Issue。未来实施采用未提交检查点。\n- 保护baseline.json中的既有脏基线；只审查真实增量，完整交付范围另行覆盖。\n- 保留路由/权限/个人与公司归属；I-01/02/03不进入基础实施；不新增搜索/指标/API。\n- 当前所有权仅refinement/，本轮不执行以下生产步骤；授权后正式计划移入docs/plans并更新指针，本稿归档，不保持两份活跃事实源。\n- 原H01–H15不是本计划Task，不重新迁移组件底座。批准来源需在未来ledger记录。\n\n## Review Focus\n\n1. T01/T02：portal读错主题或neutralizer抵消原生变量；真实DOM抽样原生与wrapper，嵌套popup ESC两次只关闭相应层。\n2. T03：自动布局覆盖用户持久化偏好；resize后存储不变，用户toggle后刷新保留；C边界879/880/959/960。\n3. T04/T05/T06：共享成员与管理权限不同，表单/直达子路由不得旁路canManage，敏感值不得进入DOM。\n4. T07：IME回车误发、首条失败丢附件、流式滚动跳跃；受控消息序列和可信键盘操作验证。\n5. T09/T18：视图隐藏或跨断点卸载导致draft/运行/iframe重建；记录DOM identity与状态前后值。\n\n## DAG、批次和执行状态\n\n完整结构见[tasks.json](./tasks.json)，每个Task含id/source_issues/acceptance/depends_on/owner_role/validator_role/owned_files/Consumes/Produces/verification/status。没有Issue输入，source_issues=[]；source_pages是本轮需求来源，不虚构Issue树。\n\n所有节点pending：尚未批准也未执行；批准后仅前置verified且同一已审查检查点已集成才置ready→running→verified。blocked须具体记原因。不因DAG就绪并行实现；串行单worktree无提交，前后快照、完整untracked内容和hash绑定审查。\n\n| 批次 | 节点 | 独立验收范围 |\n| --- | --- | --- |\n| B1 推荐首批 | T01–T08 | 主题/公共骨架→Bots/详情与配置/观测链P06–23→聊天P01–05；23页+共享布局 |\n| B2 | T09 | Craft P26–28 |\n| B3 | T10–T11 | 设置P29–38、个人账务P39–41 |\n| B4 | T12–T15、T17–T19 | 技能例行、后台治理/配置/市场/观测/预览 |\n| B5 | T16 | 知识库P58–59 |\n| B6 | T20 | 独立流程P71–76 |\n| B7 | T21 | 全站76页+4布局+7跳转，不用B1宣布全站完成 |\n\n拓扑执行按Task编号；dependency含import得到的共享前置。T01–T03全站影响大，只允许冻结接口后的串行下游；后续任务消费已分配组件时不得改其文件，发现必要改动则登记一个原owner修复Task、审查新检查点后再继续。\n\n## Task内共同完成步骤\n\n- [ ] 捕获前检查点：HEAD、staged/unstaged diff、范围内untracked完整副本/哈希；记录无关修改为基线。\n- [ ] 先复现与本Task有关的可观察布局/状态问题；适用行为变更以RED→GREEN→REFACTOR验证，不为纯色值写CSS镜像测试。\n- [ ] 执行本Task下列具体步骤；不改变公共事件/领域接口；只在owned_files内写。\n- [ ] 执行V-STATIC/NATIVE/DRIVEN/BROWSER与本Task指定案例，预期/环境阻塞见verification-plan；验证者只读。\n- [ ] 记录后检查点、任务增量package和验证hash；独立reviewer分别判Spec/quality；有效finding退回原owner，相关验证和review重做。\n- [ ] 无提交：以检查点ID代替commit，禁止git add/commit；所有前置verified后才放行下游。\n\n## 具体任务\n\n'''
for t in tasks:
 head+=f'### Task {int(t["id"][1:])}: {t["title"]} ({t["id"]})\n\n'
 head+=f'**source_pages:** {", ".join(t["source_pages"])}。**depends_on:** {", ".join(t["depends_on"]) or "无"}。**状态:** pending。\n\n'
 head+=f'**角色:** owner_role={t["owner_role"]}；validator_role=frontend_validator；独立reviewer=reviewer（Spec + quality）。\n\n**Files / owned_files:**\n\n'
 if not t['owned_files']:head+='- 仅未来指定的验证/审查报告目录 `docs/verification/workspace-redesign/'+t['id'].lower()+'/`；不写生产/测试源文件。\n'
 for f in t['owned_files']:head+='- '+('Modify' if (ROOT/f).exists() else 'Create')+': `'+f+'`\n'
 head+='\n**Interfaces:**\n\n- Consumes: '+('；'.join(t['Consumes']) or '当前脏基线；Spec及theme-contract确定值')+'。\n- Produces: '+'；'.join(t['Produces'])+'。\n'
 if t['id']=='T03':head+='- 新增可选 `SidebarShell({children,className,width,responsiveCompact?:boolean})`，默认false；显式override仅本次访问，保留原调用方props；DetailPanel签名不改。\n'
 if t['id']=='T09':head+='- 新建 `CraftWorkspaceLayout({sessionId:string})` 组合现有 SessionSidebar/ChatPanel/OutputPanel；ChatPanel/OutputPanel既有 `{sessionId:string}` 不改。route只传当前params；不新增服务接口。\n'
 head+='\n**具体步骤:**\n\n'
 for i,s in enumerate(t['steps'],1):head+=f'- [ ] Step {i}: {s}\n'
 head+='\n**验证命令与预期:** 在仓库根执行本目录 verification-plan 的 V-STATIC、V-NATIVE、V-DRIVEN，输出目录中的 TASK 必须替换为 `'+t['id'].lower()+'`、ROUND替换为实际轮次；均应exit0且非零用例。V-BROWSER逐页检查该Task的route-acceptance，截图与trace绑定同一后检查点，失败不得置verified。\n\n'
 head+='\n```bash\n'+'\n'.join(t['verification_commands'])+'\n```\n\n'+ '**变更文件静态检查:** `bunx biome check` 加本Task真实变更的owned_files参数数组；禁止 --write；预期exit0或有逐项基线归因。\n\n'
 if t['test_files']:head+='**现有针对性测试文件（运行器按清单分流，文件本身不自动授权重写）:**\n\n'+''.join('- `'+p+'`\n' for p in t['test_files'][:6])+'\n'+('完整测试集合见 tasks.json 对应 test_files（此处仅列前6项）。\n\n' if len(t['test_files'])>6 else '')
 head+='**失败处理:** 核对是否基线/环境/本次增量；禁止reset/stash/删能力。真实失败由该文件唯一owner修复，消费者暂停；缺runtime/身份记blocked、保留可继续的静态证据。\n\n**Review范围:** '+t['review_scope']+'；逐页normal/exception/permission/long/narrow，前后增量包含新增/删除文件。\n\n'
head+='''## 计划自检与共享文件预检\n\n- 76个页面均有一个主实现owner；4布局与7跳转分开；覆盖由validate-docs.py实际验证。\n- task id唯一、dependency存在、无自环/环，编号序即有效拓扑；所有leaf可达T21。\n- 每个生产文件仅一个owner；复用组件的读写依赖已补边；只读gate不取得生产所有权。\n- 共享接口：theme-contract→T01、wrapper既有props→T02、SidebarShell可选props/DetailPanel不变→T03、Craft稳定组合→T09；不改变服务器/Query返回类型。\n- 任务内部检查：owned文件/步骤/source_pages一致；各异常与权限由route-acceptance绑定，五条Review Focus在指定Task中有浏览器案例。\n- 跑测前核验ADR0008、manifest与实际checkpoint；旧H15证据不跨主题改动复用。\n'''
write('task-dag.md',head)
print('created',len(tasks),
'tasks;',len(accept),
'pages; owners',len(owned))
