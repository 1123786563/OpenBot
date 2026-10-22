# 文档级执行 Ledger

状态：实施前细化已交付；Spec/计划待用户审阅；所有生产实施Task为pending。

## 授权、隔离与原始基线

- 用户本轮授权：只新增/修改`docs/design/2026-10-20-workspace-redesign/handoff/refinement/`内文档与证据；可读其他文件，差异写入本目录。明确不派子Agent、不改生产代码、不提交/推送/合并/发布、不安装产品依赖、不创建对外Issue。
- 工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`；分支`feat/heroui-v3-migration`。
- 实际启动HEAD/BASE：`203d0f0244b2f898218fa12027089c631e8448d9`，与提示相符。
- `git rev-parse --absolute-git-dir`指向`OpenBot/.git/worktrees/heroui-migration`；common-dir是`OpenBot/.git`；superproject为空。已是隔离linked worktree，不另建、不清理它。
- 实际基线读取UTC时间见baseline.json（2026-10-20T11:56:11Z）；写权限通过在独占目录创建证据并读回核验。startup-status.txt记录所有tracked/untracked展开状态；baseline.json记录9360个既有普通文件哈希，排除本目录避免自引用。它不是干净HEAD；现有迁移全部是必须保留的脏基线。
- handoff/source-baseline对比：155项全部存在，154项相符，只有`docs/design/2026-10-20-workspace-redesign/SHA256.json`变化；旧/新哈希均在baseline.handoff_comparison，未回退。当前代码文件相对交接无哈希漂移。

## 已读取依据与采用方式

- AGENTS.md、CONTEXT.md、README、layout-contract、source-baseline；逐页pages.json/pages.md与路由及相关组件静态读取。
- 5张references图片均直接打开检查；visual-atlas不作为生产DOM母版。
- 当前styles/tokens/原生HeroUI安装CSS、wrapper、PageShell/SidebarShell/DetailPanel、Bots/Craft/聊天/知识库组件；引用与行号见source-evidence。
- 原迁移execution计划与H15报告：保留其native/driven证据和UI engine阻塞/全仓失败的真实口径，不重派H01–H15、不当作本次新主题通过。
- ADR0008、e2e.unit.config.ts、e2e-bun-suites.json、package scripts与driver选择器，作为本稿命令依据。
- Skills：impeccable用于Operate界面细化；using-git-worktrees仅核验现有隔离；writing-plans用于草案格式。impeccable context一次返回多应用目标选择，任务已明确app，因此直接读取PRODUCT/app DESIGN；未重开风格发现、未写PRODUCT/DESIGN，也未调用实施SDD/OCR或代理。

## 文档工作记录

| 节点 | 状态 | 检查点/证据 |
| --- | --- | --- |
| R01工作区/写权限/基线 | verified | baseline.json、startup-status.txt；HEAD匹配；独占目录可写 |
| R02路由重扫 | verified | 88个tsx文件，87 createFileRoute声明；76页面/4布局/7跳转；与缓存源绑定、分类无差异；__root额外处理 |
| R03源码差异与五图布局 | verified（静态） | gap-analysis；5图矩阵；非运行成功断言 |
| R04规格与Token | ready for user review | implementation-spec、theme-contract；39个现有ob Token全部覆盖；88指定对比度配对静态合格 |
| R05任务/DAG/逐页验收 | ready for user review | 21节点，270个明确生产文件唯一owner；所有页面一个主交付owner，主题/共享/验收gate另标task_kind |
| R06自查/边界核验 | verified（文档） | validation.json；baseline全部字节未变，无目录外新增文件、断链、DAG环或页面遗漏 |
| R07生产实现/测试/浏览器/独立Review/OCR | not started | 当前授权不含实施；任何生产验收结果均not_run |

所有静态验证与当前文档交付绑定delivery-manifest.json；manifest不包含自己。validate-docs.py会改写validation/contrast-check时间戳，重新运行后须重新生成manifest，避免把旧指纹当新证据。

## 决定、限制与恢复入口

- 确定建议值：280/256/64；prose672/wide1024/chat720；DetailPanel主区480、电脑400/工作坊480；Craft session224/output420。当前均待用户审阅，不声明批准。
- 一切领域/权限/付款归属保持；I-01/I-02未纳入实施，I-03不合并。图外评审工具排除。
- 首批T01–T08只推荐，不因交付文档自动实施。需要D01范围批准；D02为安全测试环境/身份/实际动态ID，缺项精确见verification-plan。无须重新询问CSS值。
- 恢复时先读execution-ready、baseline、validation与Git实际状态；如代码变化重扫并更新受影响页，不盲信87/76缓存。未经实施范围授权，不移动正式计划、不写生产文件、不启动后续流水线。
- 未来执行用PRE/POST未提交检查点和完整untracked内容，真实增量与完整交付双范围审查；不提交、不用共享stash。不把当前HEAD到HEAD空diff当审查证据。

## 第二轮细化补充

用户要求先细化再编写交接提示词。本轮继续仅写refinement，不派Agent、不实施生产代码。新增implementation-detail和code-agent-prompt，补充侧栏事件/存储表、DetailPanel源码生命周期风险与技术验证、有限兼容修复、串行所有权转移、测试分层和Code Agent交互边界。上轮“准备度无歧义”措辞收窄为产品目标确定；未运行生命周期证明。用户尚未在当前工作区执行B1启动指令。最终提示词范围等待用户选择；无回复时按此前B1建议模板交付，不据此启动代码。

注意：第二轮对自动生成的tasks/task-dag加了细化元数据与指针；build-docs.py保留第一轮生成记录，不能在未合入第二轮改动前直接重跑覆盖当前稿。
