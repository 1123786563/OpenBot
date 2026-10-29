# `.agents/rules` 规则链路审计与精简方案（复核版）

- 审计时间：2026-10-29（以 `HEAD` 中 `.agents/rules` 最近提交 `3583ecc13` 为准，工作区 `.agents/` 无未提交改动）
- 范围：`.agents/rules/` 全部 24 个文件（21 MD + 3 JSON）、入口 `AGENTS.md` / `CLAUDE.md`，以及规则的实际执行载体：`.coordination/v1/`、外部适配器 `/Users/wuyongjun/trea/openbot-coordination`、`.archive/runs/` 中的 18 个每日 Run 与 18 个规则类 Run、`.github/workflows/ci.yml`
- 性质：只读审计与方案。**本文不修改任何规则**；按 `execution.md` 分档，修改“授权/验证/审核/交付门禁的规则配置”属于**完整档**，落地须另行授权并走完整计划 + 独立审核
- 与同日旧报告 [2026-10-29-agent-rules-execution-audit.md](2026-10-29-agent-rules-execution-audit.md) 的关系：本文重新实测，并更正旧报告中已过时或不准确的几处结论（见 §7）

---

## 0. 结论摘要

**判定：当前规则体系“偏重，且局部冗余”，问题集中在专用链路（Orca / 共享协调 / 每日闭票审计）和规则自身的演进成本上；轻量档与标准档基本合理。**

1. **结构**：21 个 MD 文件的链接图里，除 `architecture.md`、`issue-tracker.md` 外的 19 个文件构成**同一个强连通分量**：从任一文件出发沿链接都能到达全部 23 个文件（闭包 148,700 字符）。文件之间有 31 组互相引用。按需加载目前只靠 `AGENTS.md` 末句的声明“链接是按需入口”来维持，图结构本身没有任何约束。
2. **冗余**：12 组跨文件重复声明（§2.1），核心概念平均分散在 4.6 个文件里（§3.3）。
3. **冲突**：4 项硬冲突，每项都对应一个真实的规则漏洞或执行偏差：`CLAUDE.md` 入口已经漂移；OCR 用户裁决没有回写进规则；指纹 v3 合同没有落到已部署的适配器里；规则写的是每日调度，实际是每小时调度。另有 4 项软张力（§2.4）。
4. **过度约束**：机器协调合同里约 5.6K 字符是迁移条款和验收矩阵。它们对“从 v3 起步部署”的当前实例已是死条款，或者已由适配器测试承担（§2.3）。贴标闭环配有预留算法、公平游标、三级预算，但共享 Ledger 里 4 张票的 `label_action` 全是 `none`，**闭环的写入路径至今没有执行过一次**。
5. **开销**：每日审计的必读量为 71.5K 字符，占语料 48%。每小时一次的触发在无可行动项时仍要完整重摄取 N=201、R=48。规则自身 5 天内有 19 次提交（+4,635/−1,608 行），18 个规则审计/精简类 Run 占归档 12.0GB。**规则维护已经成为这套体系最大的单项成本**。

**优化红线（任何方案都不得削弱）**：授权不扩权；批准与 `approval_ref` 核验；审核独立性；条件写 + 写后回读对账；子模块接收方远端可还原；敏感内容脱敏；`frozen_failed` 仅限修复；不得自行改票批准自己的范围缩减；分档体系本身。

---

## 1. 规则链路映射表

### 1.1 语料盘点（实测）

| 文件 | 字符 | 强约束词数¹ | 密度/千字 | 入度 | 出度 | 分组 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| coordination-format.md | 20,424 | 141 | 6.9 | 6 | 6 | D 协调 |
| closed-issue-daily-run.md | 5,847 | 11 | 1.9 | 6 | 10 | E 闭票 |
| checkpoints.md | 4,386 | 27 | 6.2 | 11 | 3 | C 证据 |
| closed-issue-audit.md | 3,735 | 11 | 2.9 | 4 | 9 | E 闭票 |
| orchestration-agents.md | 3,686 | 25 | 6.8 | 6 | 7 | D 编排 |
| review.md | 3,421 | 15 | 4.4 | 10 | 7 | C 审核 |
| artifacts.md | 3,420 | 14 | 4.1 | **13** | 4 | C 证据 |
| worktrees.md | 3,001 | 7 | 2.3 | 5 | 7 | D 编排 |
| delivery-gates.md | 2,707 | 7 | 2.6 | 9 | 9 | B 交付 |
| issue-delivery.md | 2,565 | 10 | 3.9 | 7 | 7 | B 摄取 |
| testing.md | 2,500 | 13 | 5.2 | 5 | 5 | C 验证 |
| orchestration.md | 2,325 | 3 | 1.3 | 5 | 10 | D 编排 |
| coordination-state.md | 2,322 | 7 | 3.0 | 9 | 3 | D 协调 |
| fingerprints.md | 2,166 | 10 | 4.6 | 2 | 4 | B 交付 |
| execution.md | 2,115 | 5 | 2.4 | 7 | 10 | A 基座 |
| design.md | 1,951 | 8 | 4.1 | 5 | 3 | A 基座 |
| orchestration-protocol.md | 1,721 | 5 | 2.9 | 2 | 7 | D 编排 |
| orchestration-review.md | 1,317 | 6 | 4.6 | 2 | 7 | D 编排 |
| architecture.md | 1,294 | 1 | 0.8 | 0 | 0 | A 基座 |
| domain.md | 549 | 0 | 0 | 1 | 2 | A 基座 |
| issue-tracker.md | 246 | 1 | 4.1 | 1 | 0 | A 基座 |
| **MD 合计** | **71,698** | 327 | | | | |
| coordination-schema.json | 43,171 | — | — | 2 | — | 18 个 `$defs`，`issue` 单定义 12,830 |
| fingerprints-vectors.json | 26,678 | — | — | 1 | — | 测试向量 |
| fingerprints.schema.json | 8,504 | — | — | 1 | — | 8 个 `$defs` |
| **全部** | **149,994** | | | | | 粗估 ≈ 9–10 万 token² |

¹ 计数词：必须/须/不得/禁止/不能/blocked。² token 为按字符粗估，不是实测值。

### 1.2 逐文件链路（触发 → 步骤 → 依赖 → 输出/流转）

记号：`→` 串行，`‖` 可并行，`[条件]` 条件分支。

#### A 组：基座（所有任务按需）

| 文件 | 触发前置条件 | 执行步骤 | 上游依赖（读） | 输出与流转 |
| --- | --- | --- | --- | --- |
| execution.md | 写实施计划 / 实现 / 修复 / 派发 / 恢复 | ① 分档（轻量/标准/完整）→ ② 核 Git 基线、已有改动 → ③ 选技能，缺失时走等价流程 → ④ 串行实施 [多任务: SDD / Orca 派发] → ⑤ RED→GREEN→REFACTOR + 验证 + 自查 → ⑥ 按档审核（标准：1 次独立 Review；完整：再加独立行为验收）→ ⑦ [多 Agent/跨会话] 自足 Brief、Ledger 恢复 | issue-delivery（关联 Issue 先摄取）、testing、review、artifacts、checkpoints、worktrees、coordination-state、orchestration、closed-issue-* | 档位决定后续所有门禁强度；完整档计划写入 `docs/plans/` |
| design.md | 设计 / Spec / ADR / 拆分 / 需求冲突 | ① 事实源 7 级优先序 → ② 核批准元数据（ID/status/批准者/时间/指纹/`approval_ref`）→ ③ 核替代链（supersedes / superseded_by，检测成环）→ ④ Issue“已确认决定”权限核验 → ⑤ Matt Skills 设计流 → 移交 Superpowers | domain、issue-delivery、artifacts | 批准与替代写回 Spec/ADR；Ledger 记采用版本 |
| domain.md | 使用/修改术语、进入模块 | 查根 `CONTEXT.md` [OpenMuse 再查局部] → 沿用既有词 → 改义时同步批准依据/ADR | design、artifacts | `CONTEXT.md` 更新 |
| architecture.md | 新增 Module / 改 Interface / 跨 Module 调用 / 改事实所有权等 | 读架构 Spec → 按改动查四表之一 → 5 步（唯一所有者 → Interface → 依赖无环 → 实施验证 → 同步定义） | 无链接（引用 `docs/` 文档） | 同步 `docs/plans/modular-architecture/*` |
| issue-tracker.md | 查/建/拆/更新 Issue | 单条事实：tracker 为 `1123786563/OpenBot`，`ready-for-agent` 的语义 | 无 | 被 issue-delivery 引用 |

#### B 组：摄取与交付写入

| 文件 | 触发前置条件 | 执行步骤 | 上游依赖 | 输出与流转 |
| --- | --- | --- | --- | --- |
| issue-delivery.md | 分析/计划/Review/实现 Issue（单个/父级/一组） | ① 只读摄取（正文/验收/讨论/子项/依赖，记录来源与时间）→ ② 父级递归 + 分页 + 去重 → ③ contains 与 depends_on 分开存放 → ④ 外部阻塞取证 → ⑤ 不完整项打标记 → ⑥ **rescan ×4 个时点**（实施前、恢复后、终审前、外部写入前；写入后再核一次）→ ⑦ [多任务] DAG 校验（ID/环/覆盖/拓扑）→ ⑧ Ledger 登记交付目标 | issue-tracker、design、execution、checkpoints、artifacts、delivery-gates、worktrees | 需求版本 / DAG / Ledger → `.archive/runs/`；rescan 结果在各消费方共享 |
| delivery-gates.md | push / merge / 关闭 / 标签 | ① 登记目标（默认 `origin/main`）→ ② [机器路径] requirements-v3 指纹 → ③ 写前新鲜度：远程 ref == 预期 → 构造最终 tree → 组合验证 + 审核/OCR + CI → ④ 条件写 [merge queue 分支] → ⑤ 写后回读，判 `applied_valid` / `stale` → ⑥ 关闭/标签：完整 rescan → 意图落盘 → 条件写 → 写后 rescan → 失配纠正（每轮 ≤3 次）→ ⑦ Refs/Fixes 选择 + 人审证据 | execution、design、fingerprints、artifacts、testing、coordination-state/format、issue-delivery、review | `delivery_intent`、动作回执；普通路径只要一份交付记录 |
| fingerprints.md | 需求冻结 / 每日恢复 / 写入意图（仅机器路径） | 身份规范化 → 集合排序去重 → CRLF→LF → schema 校验 → RFC 8785 JCS → SHA-256；分 requirements-v3 与 daily-input-v3 两种 | fingerprints.schema.json、fingerprints-vectors.json、delivery-gates、coordination-format | 指纹进入 daily 记录、manifest、意图 |

#### C 组：验证、审核、证据

| 文件 | 触发前置条件 | 执行步骤 | 上游依赖 | 输出与流转 |
| --- | --- | --- | --- | --- |
| testing.md | 测试/类型/Lint/构建/验收 | ① 读 ADR 0008 → ② 最小相关测试，记录命令/退出码/用例数 → ③ Docker：列出已有容器 → 独立 project → 登记 → ④ trap 清理 → inspect 确认 → ⑤ 输出写入 `.e2e/<run-key>/` → ⑥ 被测版本绑定冻结树 → ⑦ DB/副作用服务隔离 → ⑧ 目标 SHA 的 CI 检查 [merge queue 分支] | ADR 0008、artifacts、coordination-state、checkpoints、review、delivery-gates | 测试证据 → 归档；CI 结论 → 交付记录 |
| review.md | 审查 / finding / 最终交付 | ① 按档定范围与独立性 → ② finding 四级裁决 → ③ 每任务 ≤5 轮，连续 2 轮无进展换上下文，第 4–5 轮升级能力 → ④ 变化后证据承接三档 → ⑤ [完整/闭票审计] OCR：preview 对账 → 执行 → 覆盖对账 → ⑥ 完成判定 + `integration_pending` | execution、orchestration-agents、design、checkpoints、artifacts、delivery-gates、worktrees | 报告 → `.archive/runs/*/reviews/`、`ocr/` |
| checkpoints.md | 固定交付 / Review Package / 派生 / 转移 / 子模块 | ① 选方式：单写者轻量 \| 完整快照 → ② [完整] snapshot_generation 两次采集对比 → ③ 逐仓库清单 + 输出分类（deliverable / rebuildable）→ ④ 子模块接收方远端可还原（隔离目录 fetch + 递归 checkout）→ ⑤ 敏感内容保护 → ⑥ 派生/转移 → ⑦ frozen_failed → ⑧ 安全还原（路径/类型/上限）→ ⑨ 审查镜像 | review、artifacts、coordination-state | manifest → `.archive/runs/*/checkpoints/` |
| artifacts.md | 创建/迁移文档、证据 | ① 按内容归类 → ② 按档保留证据 → ③ Run 布局 + 唯一 `archive_root` → ④ [机器] policy manifest → ⑤ [SDD] 工具目录适配 → ⑥ 保留与交付 → ⑦ 脱敏 / 外发 / `retain_until` → ⑧ 旧目录迁移 | testing、checkpoints、coordination-state、execution | 目录树、保留登记 |

#### D 组：Orca 编排与共享协调

| 文件 | 触发前置条件 | 执行步骤 | 上游依赖 | 输出与流转 |
| --- | --- | --- | --- | --- |
| orchestration.md | 用 Orca 协调多 Agent | ① 运行边界：1 主控 / 1 集成树 / 1 交付入口 → ② 权威合同分发表 → ③ `worker-start` 监督派发 + 启动回执核对 → ④ 容量 K=4 + 1 → ⑤ 单任务阶段：实现 → 结算 Dispatch → 独立验证 ‖ 审核 → 串行集成（4 步）→ verified → 释放后继 → ⑥ 完整交付 | issue-delivery、execution、orchestration-*、worktrees、checkpoints、artifacts、delivery-gates、closed-issue-daily-run | Task/Dispatch 回执、集成记录 |
| orchestration-protocol.md | 派发/消息/集成/失败/恢复 | 权威 attempt / Dispatch → 派发前意图 → Delivery ID 去重后 ack → 资源原子声明 → RecoveryDecision 分流（5 类）→ 恢复核对清单 | orchestration、orchestration-agents、coordination-state/format、review、issue-delivery、checkpoints | RecoveryDecision、事件 |
| orchestration-agents.md | Orca 或闭票审计中选/派/复审 Agent | 7 阶段候选表 → 独立性判定（会话/贡献/历史缺口替代批准）→ 预期 ID 与实际回执比对 → 第 4–5 轮能力升级 | closed-issue-audit、orchestration*、checkpoints、review、execution | Brief/Ledger 中的身份记录 |
| orchestration-review.md | 任务审核 / 终审 / 关闭 | 任务级独立审核 → finding 回到原实施者 → 终审 + OCR 两关 → 修复 DAG（frozen_failed）→ 关闭条件 → 清理 | review、orchestration-agents、artifacts、issue-delivery、checkpoints、worktrees、delivery-gates | `close_pending` / `integration_pending` |
| worktrees.md | 建/复用/收尾 Worktree | 先找现有（Orca list + git list 交叉核对）→ 创建（命名/基线 SHA/引用）→ 默认串行 → 收尾：提交/未跟踪/子模块/**后台 workload**/ignored 分类 → 迁移恢复引用 → `worktree rm` | orchestration、execution、review、checkpoints、closed-issue-daily-run、coordination-state、artifacts | 清理报告 |
| coordination-state.md | 跨 Run 占用资源 / 恢复每日任务 | ① 部署与启用（config、适配器哈希、验收回执）→ ② 统一根与身份 → ③ issue_write_set + relation_snapshot → ④ 副作用前重核 → ⑤ 取得/心跳（60s/5min）/fencing/释放 → ⑥ 恢复引用迁移 | coordination-format、checkpoints、closed-issue-daily-run | claims/daily 写入（只经适配器） |
| coordination-format.md | 由 coordination-state 加载 | 身份编码 → 文件 Schema 与嵌套契约 → 每日调度（C/P/预留 n+r≤C/修复波次/等待算法）→ 状态不变量（≈14 条）→ 迁移 v1→v2、v2→v3、升级 → 事务入口（请求外壳/幂等/兼容矩阵）→ journal/fsync → 验收矩阵（37 行 + 补充） | coordination-schema.json、fingerprints、delivery-gates、closed-issue-*、coordination-state | 适配器强制执行的机器合同 |

#### E 组：闭票审计与每日自动化（最重链路）

| 文件 | 触发前置条件 | 执行步骤 | 上游依赖 | 输出与流转 |
| --- | --- | --- | --- | --- |
| closed-issue-audit.md | 审计已关闭的 ready-for-agent 票，或核对/添加待人审标签 | ① 冻结 N ∪ R（分页、排除 PR、记录游标）→ ② 对账已有 Run/人审 → ③ 固定交付契约与隔离树 → ④ 逐票摄取 + 验收映射 [not_planned → 核取消决定] [父票 → 递归 + 聚合] → ⑤ 逐票 5 步：验收可观察化 → 代码追溯 → 实际运行 → OCR → 证据归档 → ⑥ 六值裁决 → ⑦ 贴标：意图同事务 → 写入 → 写后 rescan → ⑧ 人审终态 / rejected 迁移 → ⑨ R 中 close/delivery 对账 | issue-delivery、design、delivery-gates、testing、review、orchestration-agents、coordination-format、artifacts、closed-issue-daily-run | N/R 矩阵、review manifest、三类动作意图/回执 |
| closed-issue-daily-run.md | 配置/运行每日审计修复 | ① 调度配置（daily 10:00、C=4、P=2、120 分钟、5 波）→ ② 能力 + 回执核对 → 冻结 daily_run_manifest → ③ 每 Run 7 步：独占/恢复 → 选 slot（公平轮转 + label 预留）→ 独立审计 ‖（≤P）→ 分流 → 修复波次 → 交付/动作 → 预算结算 → ④ Issue/PR 发布 → ⑤ 父树 epoch / 目标前移承接 / 稳定窗口 → ⑥ 公平调度与等待算法 | 全部 E/D 组 + testing、delivery-gates、review、artifacts | daily_run_manifest、slot 事件、修复波次 manifest |

### 1.3 场景必读量（按 `AGENTS.md` 触发表 + 各规则自身声明的“须读”计）

| 场景 | 必读文件 | 字符（含 AGENTS.md） | 占语料 |
| --- | ---: | ---: | ---: |
| 轻量修复（无 Issue） | 2 | 6,296 | 4% |
| 轻量 + 关联 Issue | 5 | 11,058 | 7% |
| 标准 + Issue | 7 | 17,899 | 12% |
| 完整档（持久化/发布） | 11 | 26,835 | 18% |
| Orca 多 Agent | 16 | 59,788 | 40% |
| **每日闭票审计** | **19** | **71,536** | **48%** |
| 每日 + 适配器维护 | 22 | 149,832 | 100% |
| 纯链接闭包（任一 SCC 成员） | 23 | 148,700 | 99% |

### 1.4 每日闭票单票的端到端门禁链（实测展开）

```text
能力核验 → daily 声明 → N∪R 冻结 → epoch/目标冻结 → slot 选择(+label 预留)
 → 独立审计会话(身份核验) → 行为测试 → OCR → 主控对账 → finding 分流
 → [修复] 开波次 → 修复 → 独立复审 → 终审 → OCR
 → 交付: 写前新鲜度 → 条件写 → CI → 写后回读
 → 贴标: 写前 rescan → 意图同事务 → 写入 → 写后 rescan → 结算
```

不进入修复时有 13 道门禁，进入修复时有 22 道。其中**新鲜度类 5 道**：摄取冻结、结束前重查、副作用前重核（`coordination-state.md` L31）、写前 rescan、写后 rescan。

---

## 2. 问题识别

### 2.1 跨规则重复校验 / 重复声明（12 组）

| ID | 重复内容 | 位置 | 性质 | 处理方向 |
| --- | --- | --- | --- | --- |
| R1 | label/close 失配时“保留 Agent 验证结论”的例外 | delivery-gates L30 ≈ coordination-format L73 | 真重复（几乎逐字），两处互引 | 散文只留 delivery-gates 一份；format 只保留机器不变量 + 指针 |
| R2 | stale → revalidating → 禁止复活 verified 的状态机 | delivery-gates L24/L30、coordination-format L33/L70/L73、closed-issue-audit L37/L43 | 3 个文件 6 处 | 同上 |
| R3 | 修复上限 5：Task 轮次 / 票级波次 / Run 波次 | review L11、coordination-format L53–55/L71、daily-run L24/L44、orchestration-agents L27 | 3 个“5”定义在 4 个文件里 | 在 format 里集中写一张“计数器定义表” |
| R4 | 审核独立性（干净会话、不参与实现、不继承状态） | execution L34、orchestration-agents L15/L31、review L7、closed-issue-audit L18 | 4 个文件 | execution L34 为唯一定义；Orca 只增量写 ID/Dispatch 核验 |
| R5 | “普通单写者不进入机器合同”的边界 | execution L17/L40、issue-delivery L21、artifacts L22、checkpoints L11、delivery-gates L7、coordination-state L3 | **6 处，措辞各不相同** | 在 execution 里写唯一判定表，其余改为一句引用 |
| R6 | 分档证据梯度 | execution 分档表、artifacts L20–22、delivery-gates L7 | 视角重复 | artifacts 只留存放位置，删掉档位复述 |
| R7 | rescan 时点 | issue-delivery L17–19（所有者）；delivery-gates L28、closed-issue-audit §1.3、orchestration-protocol L24、orchestration-review L13 又各自展开 | 部分重复 | 消费方只写“按 issue-delivery 的 X 时点” |
| R8 | merge queue 门禁 | testing L21 与 delivery-gates L23 | 重复，且是超前约束（`ci.yml` 中 `merge_group` 出现 0 次） | 合成一条条件式条款 |
| R9 | 共享资源清单（DB/端口/Docker/缓存/输出） | testing L8/L29、coordination-state L3、coordination-format 资源表 | 流程侧和机器键侧各列一遍 | 流程侧只写“按 resource_key 表登记” |
| R10 | 公平调度算法 | daily-run L64–74 与 coordination-format L75/L78 + 验收矩阵 4 行 | 散文复述适配器已经强制的算法 | daily-run 留 3 行摘要 |
| R11 | 触发条件 | AGENTS.md 表 ↔ 每个文件首句 ↔ **CLAUDE.md 表** | 三处维护，CLAUDE.md 已漂移（见 C1） | 入口单源化 |
| R12 | “不扩大授权”声明 | 8 个文件 11 处 | 低害重复，但每处都要逐条核读 | AGENTS 常驻规则已有，文件内只保留有特殊语义的那几处 |

### 2.2 无实际业务价值的中间环节（6 项）

| ID | 环节 | 位置 | 判定依据（实测） |
| --- | --- | --- | --- |
| V1 | v1→v2 迁移条款 | coordination-format L81（255 字符） | 当前实例 `claims.json` 和 daily 都是 `schema_version=3`，2026-10-29 直接以 v3 部署；没有 v1/v2 数据可迁移 |
| V2 | v2→v3 迁移条款 | coordination-format L83（722 字符）+ 验收矩阵 2 行 + L152 补充 | 理由同上。适配器以 v3 起步，该条款对本实例是死条款 |
| V3 | `fingerprints-vectors.json`（26,678 字符）放在规则目录 | rules/ | 适配器源码和测试里**没有发现对该文件或 `fingerprints.schema.json` 的引用**（grep `src/ tests/`）。它占据规则语料的 18%，却没有被执行 |
| V4 | 每小时空轮的完整冻结 | daily-run §每次运行 1–2 | run17、run18 是“零名额 idle 轮”，仍完整执行：能力 6 项、N=201/R=48 重摄取 + 结束前复核、claims 3 次事务、manifest 冻结（每轮约 13 个文件）。结论与上一轮相同 |
| V5 | 规则中的过时声明 | coordination-format L3“不宣称仓库已有可用实现”；checkpoints L44“仓库未提供该工具实现” | 适配器 v0.1.0 与 `restore.py` 已部署，`config.json` 登记了验收回执。过时声明会诱发误判为 `capability_blocked` |
| V6 | SDD 工具目录适配整节 | artifacts L38–45 | `.superpowers/sdd/` 只有 6 个历史目录，最新是 10-27；Orca 路径不使用它。属于低频专用合同 |

### 2.3 约束范围超出实际需求的过度限制（5 项）

| ID | 约束 | 位置 | 实际负载对照 | 结论 |
| --- | --- | --- | --- | --- |
| O1 | 37 行验收矩阵 + 补充段（3,764 字符），放在规则正文 | coordination-format §上线与升级验收样例 | 适配器已有 `v3_acceptance_matrix` 回执和 12 个测试文件。矩阵本质上是适配器的测试规格 | 迁到适配器仓库，规则里只留“启用须有当前哈希的矩阵回执” |
| O2 | 贴标闭环的预留算法（n+r≤C）+ 公平游标 + 三级预算 | format L47–49、daily-run L64–74 | 共享 Ledger 中 4 张票 `label_action` 全为 `none`，归档中没有 label `applied_valid` 回执；**闭环写入路径执行次数为 0** | 保留门禁，散文压缩；算法以适配器为准 |
| O3 | 审查镜像的完整还原 | checkpoints §审查镜像 | `2026-10-27-closed-issue-rules-eee807a6/review-mirror` 单目录 **12GB**，占全部归档（15GB）约 80% | 规定镜像方式（共享对象库的 detached worktree + 只应用授权增量 + 排除可重建依赖目录），并设体积上限 |
| O4 | merge queue 全链路 | delivery-gates L23、testing L21 | 未启用 | 压缩为“启用前须另立规则”1 句 |
| O5 | 安全还原平台细节（NTFS ADS、Windows 保留名等） | checkpoints L42–46 | 单主机 darwin；`restore.py` 已实现并有 `restore_limits` 回执 | 细节迁到适配器设计文档，规则保留 3 条门禁 |

### 2.4 逻辑冲突与漏洞

#### 硬冲突（规则与规则、规则与事实不一致，已经造成执行偏差或留下漏洞）

| ID | 冲突 | 证据 | 风险 |
| --- | --- | --- | --- |
| **C1** | `CLAUDE.md` 入口漂移 | `CLAUDE.md` 修改于 10-24，`AGENTS.md` 修改于 10-29。前者**缺少 4 行触发项**（闭票审计、每日、检查点、共享协调）；Issue 行写的是“用户要求实现…Issues → 随后读执行、测试和审查规范”，后者是“分析/计划/审查或实施 → 摄取不启动实施”；也缺少“关联 Issue 不自动升级”这一条 | **高**。`orchestration-agents.md` 把 claude 定为实施与终审的候选。Claude 系 Agent 读 `CLAUDE.md` 时既拿不到闭票审计入口，也会被引向旧的“完整 Issue 流程” |
| **C2** | OCR 频次：规则与用户裁决不一致 | review L38 要求“所有已关闭 Issue 回溯审计…执行 OCR”，closed-issue-audit §2.4 要求逐票做 OCR；但 run15–18 的 ledger 写的是“按用户 2026-10-20 裁决：中间轮不跑，仅最终提交前一次”，**这一裁决不在任何规则、Spec 或 ADR 里** | **高**。两者必有一方失效：要么每日 Run 在持续违反规则，要么规则要求了用户已经否决的开销。design.md 明确写着“聊天与执行摘要不能替代事实源” |
| **C3** | 指纹 v3 合同没有落到实现 | fingerprints.md 要求按 schema 校验，再对完整规范输入（Issue、来源、决定、依赖、policy…）做 JCS 后哈希，并“须用标准及项目向量验收”。适配器 `daily.py::_input_fp` 只对 `candidates` 做 JCS 后哈希，源码和测试里没有发现引用 `fingerprints.schema.json` 或向量文件的地方 | **高（规则漏洞）**。规则声称有“需求未变”的机器门禁，实际执行的是更弱的校验，失配判定可能漏报。`requirements_fingerprint` 只是透传字段 |
| **C4** | 调度频率 | daily-run L20 写的是“daily, 10:00”；run16–18 的 ledger 记录“automation rrule=FREQ=HOURLY…未改（无授权）”，并且每轮都在“配置偏差留档” | 中。按每小时计算，空轮成本放大 24 倍；偏差被反复记录却没有被纠正 |

#### 软张力（文本不矛盾，但带来执行或理解成本）

| ID | 张力 | 说明 |
| --- | --- | --- |
| T1 | 懒加载声明与强连通链接图 | AGENTS 要求“不递归加载”，但 19 个文件互相可达；是否加载全靠阅读者自己克制，Orca/每日场景实际要读 40–48% 的语料 |
| T2 | 修复双路径 | execution L24 允许“主控直接修复局部 finding”，orchestration-review L15 要求“建修复 DAG”。已用“专用编排走其路径”消歧，但判别依据分散在 4 个文件 |
| T3 | 新鲜度关卡密度 | 单票贴标前后有 5 道新鲜度核验，每道都有独立的记录要求（§1.4）。语义上必要，记录上冗余 |
| T4 | 两个“5” | review 的 Task 级 5 轮和 format 的票级 5 波是正交的两个计数器，但两者都会触发“第 4–5 轮升级”，容易被误当成同一个计数器 |

**结论**：未发现会造成死锁的互斥条款。C1–C4 都属于**规则与现实脱节**，其中 C1、C3 已构成实际的约束缺口，修复它们会**加强**约束。

---

## 3. 四维量化评估

### 3.1 执行耗时（代理指标）

| 指标 | 实测值 | 说明 |
| --- | --- | --- |
| 每日审计必读量 | 71,536 字符 / 19 文件 | §1.3；Orca 为 59,788 |
| 单票门禁数 | 13（无修复）/ 22（有修复） | §1.4 |
| 新鲜度关卡 | 5 道/票 | T3 |
| 每日 Run 频次 | 实际每小时一次（规则写的是每日） | C4 |
| 10-29 当日每日 Run | 7 个（run12–18，含 trial） | run12/13 整轮 `capability_blocked`（run13 记“连续第 3 个整轮”）；run17/18 零名额 idle；verified 记数为 0 的有 4 个 |
| 空轮固定动作 | 能力 6 项 + N∪R 249 票摄取 ×2 + 3 次 claims 事务 + manifest 冻结 | run18 ledger |

### 3.2 资源占用

| 指标 | 实测值 |
| --- | --- |
| `.archive/runs` 总量 | 15GB / 94 个 Run |
| 单一审查镜像 | 12GB（eee807a6/review-mirror） |
| 18 个每日 Run 归档 | 合计 ≈ 58MB；空轮约 13 个文件 / 56–88KB |
| 共享协调根 | 200KB；claims revision 已到 92+，daily revision 84，journal 95 行 |
| 事务放大比 | 84 次 daily revision 对应 5 次 slot 选择（`slot_sequence=5`）、4 张票，**约 17 次事务/slot** |

### 3.3 规则新增 / 修改的开发成本

| 指标 | 实测值 | 说明 |
| --- | --- | --- |
| 规则提交频率 | 19 次 / 5 天（10-25 起），+4,635 / −1,608 行，128 个文件次 | `git log -- .agents/rules` |
| 规则类审计/精简 Run | 18 个，其中 10-29 当天 9 个 | 规则在“修 → 审 → 再修”的循环里 |
| 15 个核心概念的平均分布 | **4.6 个文件/概念**（rescan 8、脱敏 8、不扩权 8、`approval_ref` 6、`integration_pending` 6、独立性 6…） | 关键词实测 |
| 状态机一处语义变更的同步点 | 6 处：delivery-gates、format 散文、schema、适配器代码、验收矩阵、closed-issue-audit | R1/R2 |
| 互引对 | 31 组 | 改动任一文件的回归面都会扩散到整个 SCC |

### 3.4 故障排查的维护成本

| 排查问题 | 需对账的文件/位置 |
| --- | --- |
| “贴标为什么被拒” | closed-issue-audit §3 → delivery-gates §关闭/标签 → format 不变量 → schema `issue` def（12.8K）→ 验收矩阵 → 适配器代码：**6 处** |
| “修复预算是否耗尽” | review L11 / format L53–55 / daily-run L44 中的 3 个计数器 |
| “本任务要不要机器合同” | R5 的 6 处边界声明 |
| “为何 capability_blocked” | coordination-state + format L3 + checkpoints L44 + config；其中 2 处是过时声明（V5） |
| 过时/漂移的规则陈述 | 4 处（C1、C4、V5×2） |

### 3.5 综合评分（1 = 轻，5 = 重；依据见 3.1–3.4）

| 流程 | 执行耗时 | 资源占用 | 开发成本 | 维护成本 |
| --- | :-: | :-: | :-: | :-: |
| 轻量 | 1 | 1 | 2 | 2 |
| 标准 | 2 | 1 | 2 | 2 |
| 完整 | 3 | 2 | 3 | 3 |
| Orca 多 Agent | 4 | 3 | 4 | 4 |
| 每日闭票审计 | **5** | **4**（镜像） | **5** | **5** |
| 规则体系自身演进 | — | 4（12GB 级 Run） | **5** | **5** |

---

## 4. 正式评估结论

1. **是否过重**：**是，集中在 D/E 组和规则自身的演进上**。轻量档（4%）和标准档（12%）的读入与门禁合理，分档设计有效，应保留。
2. **是否冗余**：**是**。12 组重复声明、6 处机器合同边界复述、迁移和验收矩阵等死条款或错位条款合计约 5K 字符，再加上 26.7K 未被执行的测试向量。
3. **是否存在漏洞**：**存在 2 个**（C1 入口漂移、C3 指纹合同未落地）。另有 1 个规则与授权事实的冲突（C2）和 1 个配置偏差（C4）。
4. **核心约束本身**：红线条款设计必要，未发现可以删除的核心门禁。**优化对象是承载方式，不是约束强度。**

### 4.1 可优化节点清单（按优先级）

| 优先级 | 节点 | 问题 | 调整方向 | 风险 |
| --- | --- | --- | --- | --- |
| **P0-1** | `CLAUDE.md` | C1、R11 | 入口单源化，CLAUDE.md 只指向 AGENTS.md | 低；加强约束 |
| **P0-2** | 指纹合同 ↔ 适配器 | C3、V3 | 二选一：A 在适配器中实现 v3 并用向量测试；B 规则降级为如实描述实际算法，并把“需求未变”判定改回完整 rescan 比对 | 中；A 加强约束，B 不削弱（回到可核实的强校验） |
| **P0-3** | OCR 频次 | C2 | 请用户确认 10-20 裁决，作为具名例外写入 review.md（带 `approval_ref`）；未确认前以规则为准 | 低 |
| **P0-4** | 调度频率 | C4、V4 | 规则与配置对齐（需用户授权）；增加空轮快速路径 | 低；不涉及副作用 |
| **P0-5** | 过时声明 | V5 | 改为“以 config 登记的适配器/工具 + 当前回执为准” | 低 |
| **P1-1** | 机器合同适用判定 | R5、R6 | 在 execution.md 写唯一判定表，5 处改为引用 | 低 |
| **P1-2** | 状态机散文 | R1、R2 | delivery-gates 作为唯一散文源；format 只留机器不变量 | 低 |
| **P1-3** | 计数器 | R3、T4 | format 中加计数器定义表 | 低 |
| **P1-4** | 验收矩阵 / 迁移条款 / 安全还原细节 | O1、O5、V1、V2 | 迁到适配器仓库，规则保留门禁句 | 低 |
| **P1-5** | 审查镜像 | O3 | 规定镜像构造方式与体积上限 | 中；要验证隔离不变 |
| **P1-6** | 编排三件套 | R4、R7 | protocol + review 并入 orchestration.md；agents 保持独立 | 低 |
| **P1-7** | 公平调度 / merge queue / 资源清单 | R8、R9、R10、O4 | 删除复述，留指针 | 低 |
| **P2-1** | 链接图 | T1 | 引入“必读 / 参考”两类链接，并用脚本校验 | 低 |
| **P2-2** | coordination-format 拆分 | §1.3 | 拆为操作员视图（≈5K）与适配器规格（迁仓） | 中 |
| **P2-3** | 规则变更节流 | §3.3 | 规则修改走批次，不再每轮审计都改规则 | 低 |
| **P2-4** | SDD 节 | V6 | 确认停用后冻结并移出 | 低 |

---

## 5. 落地方案（操作说明）

> 前置：本方案属于完整档规则修改。按 execution.md，须先写入 `docs/plans/<date>-rules-slimming/`，每个 P 项单独提交，每项完成后由独立 reviewer 核验“约束不减”（§5.5 的检查单）。

### 5.1 P0：修漏洞、消冲突

**P0-1 入口单源化**
- 操作：`CLAUDE.md` 全文替换为一行：“本仓库 Agent 入口见 [AGENTS.md](AGENTS.md)，内容以其为准。”如果需要被工具自动加载，可改为 symlink 指向 AGENTS.md（Claude 系工具支持读 symlink；需实测确认）。
- 保全：触发表只剩一份，消除 R11 的三处维护。

**P0-2 指纹合同对齐**（推荐方案 A）
- A：在 `openbot-coordination` 中实现 `requirements_v3()` / `daily_input_v3()`，按 `fingerprints.schema.json` 校验输入后做 JCS + SHA-256；把 `fingerprints-vectors.json` 移到适配器的 `tests/fixtures/`，新增向量测试；`config.json` 登记新回执。规则侧 `fingerprints.md` 只保留规范化规则与“精确字段以适配器仓库 schema 为准”。
- B（过渡）：fingerprints.md 和 coordination-format L37 如实写明当前 `daily-input-v3` 的实际输入；“需求未变”判定一律走 issue-delivery 的完整 rescan 内容比对，不以指纹相等放行。
- 保全：A 补上缺失的门禁；B 回落到已执行的强校验。两者都不削弱约束。

**P0-3 OCR 例外入规**
- 操作：请用户确认 2026-10-20 的裁决原文。确认后在 review.md §OCR 增加一条：“闭票审计/每日 Run 中，OCR 仅在**最终提交（进入交付目标）前**对授权增量执行一次；中间轮及无提交的审计轮次记 `not_run: deferred_to_final (approval_ref=…)`；贴标仍须有覆盖当前目标 SHA 的 OCR 证据。”同步修改 closed-issue-audit §2.4。
- 保全：贴标前仍有 OCR 门禁，只是把重复执行改成一次。

**P0-4 调度对齐与空轮快速路径**
- 操作 1（需用户授权）：要么把 automation 改回 daily 10:00，要么把规则改为“每小时 + 空轮快速路径”。二者择一，规则必须与配置一致。
- 操作 2：在 daily-run §每次运行 1 之前插入“空轮快速路径”：在不取 daily 写声明的前提下，只读取 N∪R 编号集合哈希、共享 Ledger 的等待条件，判断 `retry_after` 是否到期以及授权 observed 是否变化。**若集合哈希与上一轮一致且没有任何等待到期或唤醒**，记 `idle_fastpath` 并退出，不冻结 manifest、不重摄取全量。只要有任一候选可接纳，就走原完整流程。
- 保全：快速路径不产生任何副作用，也不放行任何结论；放行前的完整摄取与 rescan 不变。

**P0-5 过时声明**：coordination-format L3 与 checkpoints L44 改为“以 `config.json` 登记的入口、版本、内容哈希及当前验收回执为准；未登记或哈希不符时 blocked”。

### 5.2 P1：合并、删减、简化

| 操作 | 具体做法 | 预估字符变化 |
| --- | --- | ---: |
| **P1-1 判定表** | execution.md §先分档后新增 6 行表：“触发机器合同 = Orca ∨ 跨 Run 共享资源 ∨ 每日/闭票自动化 ∨ 跨 Run/主机恢复；其余走普通路径（单交付记录、无 policy manifest、无完整快照）”。issue-delivery L21、artifacts L22、checkpoints L11、delivery-gates L7、coordination-state L3 改为“机器合同适用性见 execution 判定表” | −600 |
| **P1-2 状态机** | 删除 coordination-format L73 的散文和 L33 后半段，替换为“失配/纠正/例外语义按 delivery-gates §关闭/标签；适配器强制进入条件见 schema”。closed-issue-audit L37/L43 同样改为指针 | −450 |
| **P1-3 计数器表** | format §每日 Run 中新增 3 行表：`task_review_rounds`（review.md，≤5，第 4–5 轮升级）/ `repair_rounds_total`（票级波次，跨 Run，≤5）/ `max_run_repair_rounds`（单 Run 开波数）。review L11、daily-run L24/L44、orchestration-agents L27 引用该表 | −300 |
| **P1-4 迁出** | ① 验收矩阵 §上线与升级验收样例 → `openbot-coordination/docs/acceptance-matrix.md`，规则里留 1 句；② 删除 v1→v2；v2→v3 + L87 升级段 → 适配器 `docs/migration.md`，规则留“迁移须原根原锁冻结、备份、保留 generation 高水位，验收前不接受新写入”1 句；③ checkpoints §安全还原第 2–3 段的平台细节 → 适配器 `docs/restore.md`，规则留 3 条：不可信输入、全包预检零部分写、`.git` 元数据禁写 | −5,000 |
| **P1-5 镜像** | checkpoints §审查镜像新增：“镜像用 `git worktree add --detach <BASE>`（与源仓库共享对象库），再只应用授权增量；`node_modules` 等可重建依赖按 rebuildable 声明重建，不复制；体积超过主机配置上限（建议 2GB）先裁决。子模块的远端可还原核验仍在无 alternates 的隔离目录单独执行” | +200（换来约 −10GB/次） |
| **P1-6 编排合并** | orchestration-protocol.md（1,721）+ orchestration-review.md（1,317）并入 orchestration.md，分为“§执行权与恢复”“§审核与关闭”两节；去掉与 review.md/issue-delivery 重复的轮次与 rescan 复述；更新 6 处入链 | −800，文件数 −2 |
| **P1-7 去复述** | daily-run §公平调度压缩为 3 行（类别轮转、queue_key、服务上界由适配器强制）；delivery-gates L23 + testing L21 合并为 testing 中一句“merge queue 未启用；启用前须另立门禁规则并核 `merge_group`”；testing L8/L29 的资源清单改为引用 resource_key 表；独立性（R4）只在 execution L34 定义 | −1,400 |

### 5.3 P2：结构治理

- **P2-1 链接分级**：规则内链接分为 `必读:`（执行本流程前必须读）与普通参考两类，约定只有“必读”链接构成加载闭包。新增 `scripts/check-agent-rules.mjs`（项目用 bun，可直接 `bun run`）：校验链接可达与锚点、AGENTS 表覆盖全部非数据规则文件、必读闭包无环且每个场景不超过预算、CLAUDE.md 是指针。纳入 CI 的 lint 阶段。
- **P2-2 拆分 format**：在 P1-4 之后，coordination-format.md 只保留操作员需要的部分（身份表、C/P/预留规则、等待三形状、错误码）≈ 5–6K；事务外壳、journal/fsync、嵌套字段契约迁到适配器 `docs/spec.md`，作为适配器的“协议规格”。规则里写明“适配器维护须读该规格”。
- **P2-3 变更节流**：在 artifacts 或 AGENTS 常驻规则里加一句“规则修改按批次进行；每日审计 Run 发现规则问题时只登记到 `docs/plans/rules-backlog.md`，不在审计 Run 内修改规则”。
- **P2-4**：确认 SDD 停用后，把 artifacts §SDD 移到 `docs/plans/research/` 并留指针。

### 5.4 预期收益（估算，依据 §1.1 的节字符数；落地后以 P2-1 脚本实测为准）

| 指标 | 现状 | P0+P1 后 | P0+P1+P2 后 |
| --- | ---: | ---: | ---: |
| 规则 MD 字符 | 71,698 | ≈ 63,000（−12%） | ≈ 48,000（−33%） |
| 规则目录总字符（含 JSON） | 149,994 | ≈ 110,000（−27%） | ≈ 94,000（−37%） |
| 规则文件数 | 24 | 21 | 20 |
| 每日审计必读量 | 71,536 | ≈ 62,000（−13%） | ≈ 47,000（−34%） |
| Orca 必读量 | 59,788 | ≈ 52,000（−13%） | ≈ 42,000（−30%） |
| 核心概念平均分布文件数 | 4.6 | ≈ 2.5 | ≈ 1.8 |
| 状态机变更同步点 | 6 | 4（散文 1 + schema + 代码 + 矩阵） | 3 |
| 机器合同边界声明 | 6 处 | 1 处 | 1 处 |
| 空轮成本 | 完整冻结（约 13 文件、5 道关卡） | `idle_fastpath`：只读 2 项、0 事务 | 同左 |
| 每日 Run 频次 | 24/天（实际） | 与规则一致（1/天，或 24/天但空轮走快速路径） | 同左 |
| 审查镜像单次体积 | 12GB（实测峰值） | 共享对象库 + 排除依赖目录，预计降到 GB 以下（**需实测**） | 同左 |
| 已知漏洞/冲突 | 4 硬 + 4 软 | 0 硬 + 2 软（T1 待 P2-1，T3 保留） | 0 硬 + 1 软（T3，必要的新鲜度） |
| 核心门禁数量 | 基线 | **不减**（C3 方案 A 会 +1） | 不减 |

维护收益：语义同步点减少一半以上；“贴标被拒 / 预算耗尽 / 是否要机器合同”三类排查各从 3–6 处收敛到 1–2 处；规则规格与适配器测试同仓后，schema/矩阵与实现漂移（C3 这类问题）可由 CI 发现。

### 5.5 约束不减检查单（每个 P 项落地后由独立 reviewer 逐条打勾）

- [ ] 授权：提交、推送、合并、关闭、标签、部署的授权条款数量与范围不变
- [ ] 批准：`approval_ref`、替代链、“不自行改票批准自己”仍在 design.md
- [ ] 独立性：execution L34 的定义完整，Orca 的增量（ID/Dispatch 核验）仍在
- [ ] 条件写与写后回读：delivery-gates 的写前新鲜度、写后对账、纠正三段完整
- [ ] 子模块：接收方远端可还原门禁（隔离目录、无 alternates）未被 P1-5 的镜像共享对象库影响
- [ ] 脱敏：artifacts §脱敏与 checkpoints 敏感项完整
- [ ] `frozen_failed` 仅限修复、业务后继 blocked
- [ ] 迁出的内容在目标仓库可读，规则里的指针可达（P2-1 脚本通过）
- [ ] 适配器 `config.json` 回执与新规则哈希一致；未一致时 `capability_blocked`

### 5.6 风险与回退

- 每个 P 项单独提交，可以单独回退；P1-4 / P2-2 涉及跨仓库迁移，回退时恢复规则侧原文即可，适配器侧可以保留。
- P0-2 方案 A 会改变已部署适配器，属于完整档：需要计划、独立审核、OCR（代码）和新回执。上线前继续按方案 B 执行。
- P0-3、P0-4 依赖用户决定；没有决定前不改规则和配置，只登记。
- 活跃 Run 不自动套用新规则（execution L17）；落地后第一个每日 Run 须记录 `policy_changed`。

---

## 6. 证据索引

| 事实 | 来源 |
| --- | --- |
| 字符数、入度/出度、闭包、31 组互引 | 对 `.agents/rules/*` 的 Python 解析（2026-10-29） |
| CLAUDE.md 漂移 | `ls -la`（10-24 vs 10-29）；两文件触发表 diff：CLAUDE 缺 checkpoints、closed-issue-audit、closed-issue-daily-run、coordination-state |
| 协调实例负载 | `.coordination/v1/claims.json`（`schema_version=3`）；daily-ledger：4 票 #260–263、`slot_sequence=5`、`revision=84`、`label_action` 全为 none；`journal/log.jsonl` 95 行 |
| 指纹实现 | `openbot-coordination/src/coord/daily.py::_input_fp`；`src/`、`tests/` 中无 `fingerprints.schema`/`vectors` 引用 |
| 适配器已部署 | `config.json`：adapter v0.1.0、restore.py、6 项验收回执 |
| OCR 裁决 | `.archive/runs/2026-10-29-closed-issue-daily-run15/ledger.md` L7/L62、run16 L8 |
| 每小时调度 | run16 L39、run17 L46、run18 L57 |
| idle 空轮 | run17、run18 ledger 标题与 §2 |
| 12GB 镜像 | `du -sh .archive/runs/2026-10-27-closed-issue-rules-eee807a6/*` |
| 规则提交频率 | `git log --since=2026-10-25 -- .agents/rules`：19 次，+4,635/−1,608 |
| merge queue 未启用 | `grep -c merge_group .github/workflows/ci.yml` = 0 |

## 7. 对同日旧报告的更正

| 旧报告结论 | 复核结果 |
| --- | --- |
| “安全还原为不存在的工具维护规范”（O1） | 已过时：`restore.py` 已部署并有回执；现在的问题是**规则中的过时声明**（V5） |
| “4 claim / 4 票 / 0 历史事件” | claims 当前有 4 条记录；4 票各有 3–6 条票级 history，顶层 history 为 0 |
| 场景闭包 “每日 18/21 文件 94%” | 按链接闭包是 23 文件 99%；按规则自身声明的必读集是 19 文件 48%。旧报告把两种口径混在了一起 |
| “37 次提交 / 近 14 天” | 本次口径为 10-25 起 5 天 19 次 |
| 未识别 | 新增 C1（CLAUDE 漂移）、C2（OCR 裁决未入规）、C3（指纹未落地）、C4（每小时调度）、O3（12GB 镜像） |
