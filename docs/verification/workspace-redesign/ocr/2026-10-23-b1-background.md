# OpenBot B1 工作台视觉改造 — OCR 评审背景

## 交付范围

HeroUI v3 工作台视觉改造首批(T01–T08),覆盖 P01–P23 共 23 个页面与共享层(主题变量、公共 wrapper、外壳/PageShell/DetailPanel)。需求事实源:

- docs/design/2026-10-20-workspace-redesign/handoff/refinement/implementation-spec.md
- docs/design/2026-10-20-workspace-redesign/handoff/refinement/theme-contract.json
- docs/design/2026-10-20-workspace-redesign/handoff/refinement/route-acceptance.json
- docs/design/2026-10-20-workspace-redesign/handoff/layout-contract.md
- 正式计划:docs/plans/2026-10-20-workspace-redesign-b1.md;执行记录:docs/plans/2026-10-20-workspace-redesign-b1-ledger.md

## 评审关注点

1. 共享层合同:主题 token 与 HeroUI 原生变量映射、`--accent`/`--muted` 语义、控制边界与装饰边界分离、wrapper 保留 ref/原生事件/表单/anchor/键盘/portal 语义。
2. 布局合同:应用侧栏 280px、配置侧栏 256px、图标轨 64px、配置列 672/1024/720px、DetailPanel 主区下限 480px、右栏 400/480px 与并排/Sheet 切换阈值。
3. 行为保持:URL/Back/IME/附件/流式/停止重试/滚动锚点、Bots 分组算法、聊天右栏复用既有权威状态、权限与租户归属不变。
4. 非目标(发现即报告违规):不新增统一任务 API、搜索、筛选、统计指标、审批中心;不合并会话导航;不把参考图示例内容/缩略图字号写进产品。
5. 测试基础设施:mock.module 注销、preload 同步预热等修复不得改变被测语义。

## 重要边界说明

- 本 worktree 的大体量 diff 中,大部分为**既有未提交 HeroUI 迁移基线**(用户的工作,先于本批任务存在,已被用户的同步提交吸收进历史);B1 增量为共享层与页面改造。评审按代码当前状态的问题为准,不要求区分历史归属,但**不得**把保留基线误报为应删除内容。
- 禁止建议:提交/推送、依赖增删、重构到 T09+ 范围。
