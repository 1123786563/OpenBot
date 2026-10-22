# Code Agent 后续执行提示词

用途：在实施 Spec 与具体实施范围得到用户明确授权后，交给执行 Agent。此文件本身不构成授权。

在 `feat/heroui-v3-migration` 分支落实 OpenBot 现代科技工作台改造。先读本工作区 AGENTS.md、CONTEXT.md，以及 `docs/design/2026-10-20-workspace-redesign/handoff/refinement/execution-ready.md`、已审阅的 implementation-spec、对应 Task Brief 和 Ledger。

以用户当前授权的批次为执行范围。全站目标是 76 页，但本轮完成度按用户批准范围、已集成的检查点和验证事实判断。若仅授权首批，不扩展为全站生产修改；已授权端到端实施时，保存计划后直接执行，不重新询问执行方法。

实施依据优先级：批准的需求/ADR → 本轮实施 Spec → 用户参考图布局合同 → 逐页改造说明 → 草案视觉索引。图片中虚构数据、评审工具外层、状态矛盾和临时 Logo 不是生产需求。

先用 using-git-worktrees 核验当前隔离工作区；已有未提交迁移内容必须保留并作为基线。新 worktree 不会包含这些内容；只有在显式转移并核验文件哈希后才能跨工作区执行。不共享 stash。

按仓库规则使用 writing-plans 和 subagent-driven-development。主控管理 DAG/接口/集成/验证与 Review；纯前端实现使用 frontend_implementer，验证使用 frontend_validator，独立 reviewer 审 Spec compliance 和 code quality。默认沿拓扑序串行，子 Agent 只拿单个 Brief 与必要指针。共享样式、公共 UI、布局和锁文件的所有权必须唯一。

落实视觉与结构：
- 统一 `--ob-*`、HeroUI 原生变量、legacy bridge 与 portal 的亮暗主题；使用已有 HeroUI 版本和组件，维护应用包装的原生事件/ref/表单/链接合同。
- 同时落实空间分配、字号/行高、留白、圆角、层次、状态和响应式，不能只换色。
- 聊天采用导航/消息与固定输入/按需右栏；Bots 保留优先分组；Bot 详情突出待办和活动；Craft 使用会话/对话/输出的响应式工作区；设置与知识库沿用各自内容层次。
- 路由、URL 搜索参数、返回、权限、租户、账户、幂等、输入法、附件、流式、滚动锚点、电脑接管、预览隔离按原合同保留。

适用行为变化按 RED→GREEN→REFACTOR；保留纯视觉变化的浏览器证据，避免只断言类名。测试前读 ADR 0008，native 与 driven 按清单运行，报告写独立目录。完成适用 typecheck、lint/format、build 与真实浏览器验证。

每个 Task 完成后独立验证和 Review；之后主控用 open-code-review 对真实交付范围外层审查，始终 `--audience agent`，按仓库规则 SDD 修复与复审。背景包含本轮 Spec、布局合同、范围、既有脏基线；空 BASE..HEAD 不算已审查。有效 critical/high/medium 问题全部解决。

本地 commit/push/merge/deploy 仅按用户已有明确授权执行；没有本地提交授权时用完整 staged/unstaged/untracked 检查点和增量 Review Package，不停滞也不偷偷提交。

最终按页/任务报告 changed / inherited / verified / blocked / deferred。共享 Token 影响到某页不等于该页布局已完成。交付代码差异、真实生产截图、验证命令与结果、检查点、Review/OCR 报告、未完成项和精确限制。
