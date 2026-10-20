# Dry-run 报告：orca-dag-wave2（R0–R4）

运行目录：`docs/plans/2026-10-19-orca-dag-wave2/`
生成：2026-10-19 晚 · 主协调器手工执行（Orca DAG 工具未实施，按 `2026-10-18-orca-dag-orchestration.md` R0–R7 流程只读演练）
BASE：main @ `c80927fa` · scope_revision 2 · 指纹沿用 `5987aaf2c419166e`（结构未变）
前序：承接 `2026-10-19-orca-run-all`（wave1 5/5 settle；scale_up 授权队列中 C 批组1 已完成 #436）。

## 1. 范围（R1 rescan rev 2）

同四根 #5/#6/#358/#376，节点 378 / 原生边 322 **与 rev1 完全一致**；40 张票 updated 全部为贴标/评论（`updated_since_rev1.json`），无结构变化。网络间歇 TLS 超时已按 F1 纪律重试闭环（32 首轮失败节点串行重试确认为空子项）。

## 2. 派发池（19 张，零 open blocker）

| 域 | 张数 | 票号 | 备注 |
| --- | --- | --- | --- |
| craft | 3 | #437、#433、#408 | 408 冲突组 {404,405,408,409} 其余三张已 RFR，冲突解除 |
| bf | 2 | #251、#287 | B 批其余 11 张全 RFR 等人工 |
| mt | 14 | #62–#167（见 state.json） | **#62 走核验集成**：mt-w1 远程分支 `b7832879` 已有实现（4 文件 +2294 行），不重实施 |

**不派发**：批次内已 RFR 票（等人工，共 27 张）；#436 delivered_but_open（修复在 main d6123571 + 已贴标）；插件包 #459 / HeroUI #443 两棵新树有活跃外部写入者（B.3 不接管）；pending_user 三项沿 rev1。

## 3. 批次结构与资源（R4）

域流模型沿 rev1：域内串行、域间并行，每流独立 worktree + 独立 PostgreSQL 测试库（pgvector）。

| 流 | worktree | DB | 队列（按序） |
| --- | --- | --- | --- |
| craft | craft2 | 5564 `orca-w2-craft-pg` | 437 → 433 → 408 |
| bf | bf2 | 5561 `orca-w2-bf-pg` | 251 → 287 |
| mt | mt2 | 5562 `orca-w2-mt-pg` | 62（核验集成）→ 63 → 66 → 67 → 68 → 75 → 76 → 78 → 82 → 83 → 111 → 121 → 143 → 167 |

- 建议预算：**3 worker 并行**（上轮 wave1 为 5 并行验证稳定）。
- Worker 模式：Orca Pi structured session；每票"先核验 main 已含等价实现，零改动 SATISFIED 预期主流"（上轮 5/5 中 3 张零改动）。
- 交付：未提交检查点（无提交授权）；验证后协调器复验；R7 达标票贴 `agent:ready-for-review`。
- 运行纪律（2026-10-19 retro）：票号从 scope.json 机械导出；验证命令一律从仓库根解析；清理 worktree 前先归档 worker 证据到 `workers/<name>/`。

## 4. 待授权

start 需确认：① 19 张派发池与三流结构；② 并行预算 3；③ 沿用"未提交检查点 + R7 贴标"交付模式。确认后 `orchestration run-create` 建新 Run 并按流派发。
