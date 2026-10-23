# OpenBot 模块化渐进改造 · 编排方案（#620 / MOD01–MOD25）

日期：2026-10-23。类型：实施方案（编排层）。运行证据见 `.archive/runs/2026-10-23-issue620-orchestration/`（index.md 为入口）。

## 目标与授权

以 [#620](https://github.com/1123786563/OpenBot/issues/620) 为根、#621–#645（MOD01–MOD25）为执行切片的行为保持渐进模块化改造。本方案不新增业务功能、不改变现有产品行为、稳定 ID、Payer、公开 wire、同连接事务与撤权/审计合同；候选 BA/Personal Space 能力不因重构实施，BA 新合同须 #503/#504 G0 获批。

准入：用户明确选择子票并核验批准依据；`ready-for-agent` 标签不是准入。范围未确认前不派发实现。

## 工作区

- 集成分支 `1123786563/issue-620-integration`，原始 BASE `33b8117bda`；集成 Worktree `/Users/wuyongjun/orca/workspaces/OpenBot/issue-620-integration`。
- 任务 Worktree 从集成分支**当前已验证 HEAD** 派生，活跃上限 K=4（默认串行）；一票的开发/整改/审核复用同一任务 Worktree。
- 五份架构文档（docs/specs/2026-10-23-modular-architecture-design.md + docs/plans/modular-architecture/ 四分册）与 docs/plans/tickets/modular-architecture/ 各票 Brief 已在集成工作区并核对哈希（基线见 Run `issues/brief-sha256-baseline.txt`）。

## 调度

- DAG 见 Run `dag.json`：入口 MOD01（无内部前置），汇聚 MOD25；默认串行，共享入口文件（app/index/copilot/http-server/production-entry、schema 入口、tests/config、部署端口）不得并行修改。
- 单票流程：Brief+直接前置产出+对应合同/链路/AR → writing-plans 冻结函数级 owned_files → opencode 实施 → claude 独立审核（Spec compliance + code quality 两结论；Kimi 需本机正面证据方可选用）→ 有效 finding 回原实施 Agent 整改并重审 → 编排者合入本地集成分支 → 实际组合树验证（ADR 0008）→ verified 后释放后继。
- 无本地提交授权：任务增量以完整未提交检查点转移并核对哈希，证据入 Run `checkpoints/`。
- 每票 verified 即停在可用检查点，向用户报告并等待是否继续；到达 MOD25 或用户指定收口点时，codex 终审 + 一次全范围 OCR（原始 BASE→HEAD + 未提交交付）；有效问题开修复任务重走循环。
- 外部阻塞：MOD11 ← #618（open bug），MOD22 ← #619（open enhancement）；原缺陷回原票处理，不并入本树。#618 传递阻塞 14 票、#619 阻塞 2 票（详见 Run `verification/dag-validation.md`）。

## 验证与收尾

验证遵守 testing.md + ADR 0008（根 e2e 统一调度、manifest 分类、不以零用例/跳过/退出码 0 证明通过），证据入 Run `verification/<MOD>/`。Review/finding 裁决入 Run `reviews/`。不推送、不合并回 main、不关闭 Issue；提交与 GitHub 写入按届时授权单独核对。
