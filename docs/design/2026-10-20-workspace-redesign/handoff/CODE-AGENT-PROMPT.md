# Code Agent 初始提示词：把全站设计细化成可执行任务

你接手 OpenBot 的 HeroUI 视觉改造。当前阶段为**实施前细化**：交付可审阅的 Spec、任务拆分和验收方案，生产代码留待明确的实施范围授权。用户已经确定现代科技工作台方向，并要求吸收五张参考图的布局；不重新做风格发现。

## 工作区与授权

- 在 `/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`，分支 `feat/heroui-v3-migration` 工作。
- 已知 HEAD 是 `203d0f0244b2f898218fa12027089c631e8448d9`；启动时实际核验并记录。存在大量未提交 HeroUI 迁移内容，这是本任务必须保留的当前代码基线。
- 当前文件所有权：只新增/修改 `docs/design/2026-10-20-workspace-redesign/handoff/refinement/` 内的文档与证据。阅读其他文件，发现需更正之处写入差异表。
- 你不是唯一曾操作该代码库的 Agent。保留他人改动；不 reset、clean、stash、提交、推送、合并、发布、不安装产品依赖、不创建对外 Issue。
- 这是完整所有权交接。原 Agent 不监控执行。当前细化由你完成，不再派发子 Agent。

## 按需读取的事实源

启动先读 `AGENTS.md`、`CONTEXT.md` 和以下三个入口：

1. `docs/design/2026-10-20-workspace-redesign/README.md`：视觉、布局、主题及导航建议边界。
2. `docs/design/2026-10-20-workspace-redesign/handoff/layout-contract.md`：用户五张参考图中哪些区域要实现、哪些是评审工具；这是布局细化的强制输入。
3. `.archive/runs/2026-10-20-workspace-redesign-b1/source-baseline.json`：交接时的 Git/文件状态，启动时比较但不回退变化。

分析某个页面时才读 `pages.json` 中对应页、`pages.md` 对应条目及 `source` 文件和必要下钻组件。87 个路由声明对应 76 页面、4 布局、7 跳转，需要重扫核对而非盲信缓存。
看视觉时打开 `handoff/references/` 中相关图片；`visual-atlas.html` 是结构草案，不是生产 HeroUI 页面或逐像素验收母版。
查已有迁移验证时读 `docs/plans/2026-10-19-heroui-v3-migration-execution.md` 和 `.archive/runs/2026-10-19-heroui-migration/` 的相关报告；不要重派已完成的组件迁移任务。
制定验证命令前必须读 `docs/adr/0008-test-runner-tester-army-e2e.md`、`e2e.unit.config.ts` 和 `tests/config/e2e-bun-suites.json`。

## 必须完成的细化

1. 核验工作区、当前 Git 与写权限，建立文档级 ledger。当前任务是计划和设计细化，不运行生产变更流水线。
2. 核对现有设计与真实代码；输出 `gap-analysis.md`，每条注明“既有能力/视觉变化/布局变化/新增行为”、源码证据、决定、对首批是否阻塞。普通 CSS 选择自行确定，领域/权限/新导航问题列出明确问题。
3. 输出 `implementation-spec.md`：把候选范围值收敛为确定值，写出具体 CSS token、亮暗配对、HeroUI 原生变量映射、圆角/字号/行高、容器尺寸、断点及状态矩阵。状态标为“待用户审阅”，不冒称已批准。
4. 输出 `route-acceptance.json`：76 页分别绑定源文件、改造任务、既有能力、变化范围、正常/异常/权限/长内容、窄屏规则和验收证据要求。共享布局和兼容跳转单独映射，重扫后无漏项。
5. 输出 `task-dag.md` 和分批实施计划草案。首批推荐“主题与公共骨架 → Bots/Bot 详情 → 聊天”，Craft/设置/知识库列为后续独立批次。全站总范围保留，首批不是把其余页面宣布完成。
6. 每个实施 Task 指定 source_pages、depends_on、owner_role、validator_role、owned_files、Consumes/Produces、具体步骤、真实验证命令与预期、失败处理、审查范围。前端生产实现路由为 frontend_implementer；规划 Agent 不冒充实现者。
7. 输出 `execution-ready.md`：精确说明哪些任务已无实施歧义、哪些需要用户决定、建议下一条启动指令。附短的首批执行 Brief。至此停止当前细化，不因完成文档而开始生产实现。

## 必须解决的实现歧义

- heroui-theme.css 当前近乎为空，legacy bridge 不再映射 background/foreground/border/radius/success；建立完整变量所有权表，避免只改 `--ob-*` 留下一半默认主题。`--accent` 与 `--muted` 含义保持 HeroUI 合同。
- 设计对 surface 的边界和 control boundary 分层：表单依赖边界时使用足够对比的控件边界；不能把 muted 文本误映射为背景。
- 对现有 wrapper 的类、variant、尺寸、中性化样式和 portal 分别决定修改落点，保留 ref、原生事件、表单和 anchor 语义。
- 应用 280px、设置/后台 256px、轨 64px、配置 672–720px 等目前有候选值或范围；先查看真实内容，再在 Spec 选择确定值。响应式策略与用户偏好必须互不污染。
- DetailPanel 当前主区下限 400px、方案建议 480px；决定是否统一与对电脑/工作坊的影响，不把阈值变化冒称只是换肤。
- 聊天图的右栏布局落到既有 settings/watch/workshop，不新增统一任务接口或复制两套互相冲突的执行状态。
- Craft 多面板折叠/切换需精确定义：哪个断点隐藏什么、打开/关闭/切换如何保留 draft、selected session、preview 与运行状态。
- 图中的评审外层（页面查找、P01 索引、源码/改造说明）只服务文档，正式产品排除；图示缩略字号不能照搬为产品字号。
- I-01/02/03 导航增强与布局改造分开，基础方案保留导航/权限；不因看起来需要就发明搜索/筛选/指标或更改个人/公司账户归属。
- 主题图、视觉索引和生产页截图是不同证据；为首批指定真实浏览器 URL、状态、视口和检查点，不以 304 次索引渲染代替生产验证。

## 计划与验收规则

遵循仓库允许的计划位置和 Superpowers 写计划格式；未批准 Spec 的计划明确标为草案。当前允许产物统一写在本任务独占的 refinement/ 中；正式计划落位作为后续启动步骤，不创建第二份互相竞争的事实源。
使用现有测试和受控浏览器场景验证行为；纯色值不编写镜像 CSS 的脆弱单元测试。类型检查/构建/变更文件静态检查的命令从 package scripts 核实。native/driven 测试按 ADR 分流，每轮独立输出目录。
未来实施使用未提交检查点；本地提交尚未授权。验证证据绑定同一检查点，独立 Spec/quality review 与 OCR 覆盖本次真实增量及完整交付范围。既有脏基线独立记录，不能当作本次新增，也不能丢弃。
细化缺少必要数据时输出精确缺口、可继续的部分和最少问题，不用泛泛“待细化”结束。

完成报告列出：新增文档路径、布局参考落实矩阵、源代码差异、首批边界、未解决决定、下一步执行入口；如未实施就明确未实施。
