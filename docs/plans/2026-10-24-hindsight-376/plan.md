# #376 自托管 Hindsight 个人记忆集成 — 编排 Run 方案（2026-10-24）

Run：`.archive/runs/2026-10-24-hindsight-376/`（动态 DAG、Ledger、Brief、报告）。本文只写方案与验收方法。

## 事实与现状

- 根 Spec：`docs/specs/2026-10-15-hindsight-personal-memory-design.md`；ADR 0005；票面映射 `docs/plans/hindsight/personal-memory/acceptance-mapping.md`。
- 19 张子票（#377–#378、#380–#396）实现已由 2026-10-19/20/21 各波交付，并经 2026-10-23 合并浪潮并入本地 main（`b117c3c3e`）。全部 Issue 在 GitHub 仍 open（等待人工审核）。
- main 在既有验证证据之后有变更（合并浪潮、`20ade2b30` residue 修复、`27bdc381a` #489 撤权连接语义），旧报告不自动沿用。
- 前置：OpenBot-archive#41/#2 已 closed（2026-10-22）；本轮按用户指令在当前 HEAD 复核代码与测试证据（N-G0）。

## 本轮目标

在当前集成 HEAD 上完成：逐票独立验收审计 → 有效 finding 修复（实施→独立审核→集成）→ #396 聚合验收 → Codex 完整终审 → OCR。**不含**推送、远端合并、部署、生产迁移、全员启用（无授权；#396 的启用门禁完成后记 pending-authorization）。GitHub Issue 关闭另行核对授权后执行，否则记待关闭。

## 任务与依赖

| 节点 | 范围 | 依赖 |
| --- | --- | --- |
| N-G0 | 多租户前置复核（#41/#2/#6 代码+测试） | — |
| N-G1 | #377/#378/#392 审计 | — |
| N-G2 | #380/#381 审计（真实实例） | G0 结论交叉引用 |
| N-G3 | #382/#383/#384/#385 审计（真实实例+孤儿 SQL 核验） | 同 HEAD 并行 |
| N-G4 | #386/#387/#388/#389 审计 | G3 |
| N-G5 | #390/#391 审计 | G4 |
| N-G6 | #393/#394/#395 审计 | G4,G5 |
| N-FIX | 修复任务（逐 finding 从集成 HEAD 开分支） | 触发它的审计 |
| N-A | #396 聚合验收（Spec 五类场景+迁移对账+备份恢复+证据包） | G0–G6 |
| N-FR | Codex 完整终审（BASE..HEAD+未提交）→ 编排者 OCR 同范围 | N-A |

审计并行依据：全部实现已在集成 HEAD 组合树；审计节点互不传递产物、各自独立取证；某票 FAIL 使下游票特定 AC 证据失效时由修复波补验并记录失效面。活跃任务 Worktree ≤4（K=4）。

## 环境与验证方法

见 `.archive/runs/2026-10-24-hindsight-376/verification/env.md`：隔离 PG `h376-pg@5579`（每任务一库）、企业库 `h376-ent-pg@5580`、真实 Hindsight 1.0.0 合约实例 `127.0.0.1:8889`（digest 与 deploy 文档一致）。统一 e2e 驱动器跑测试；每文件记录命令/exit/用例数/跳过。

## 验收映射

- 子票逐 AC：各审计报告 `verification/g*-report.md`，每 AC MET/NOT-MET/UNVERIFIED + `文件:行号` + 测试读数。
- #396 聚合：Spec「验收场景」1–5（跨会话偏好+时间事实+派生判断；跨公司/团队隔离+管理员遮蔽；未审核候选全入口不可见+敏感；遗忘/撤权即时阻断+备份恢复不复活+清理状态；宕机/积压/预算耗尽降级+Intelligence 独有内容不进入），加类型检查/静态检查/构建、迁移对账、备份恢复演练、适用回归。
- 完成条件（不启用前提下）：G0–G6 verified、FIX 清零或披露、N-A 证据齐、终审+OCR 无有效 critical/high/medium。

## 风险与已知项

- 基线红 F1：`memory-sensitivity.test.ts`（`server/src/plugins/store.ts:5210` 64 字符工具名 vs 测试 fixture）。
- 19 个孤儿 SQL（不在 journal，fresh 迁移不受影响）；等价性核验在 N-G3。
- 企业库历史配方坑（RLS/GRANT 重放、role= URL）见 g0 brief。
