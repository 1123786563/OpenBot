# `.agents/rules` 规则体系全面审计与精简优化评估报告

- 审计日期：2026-10-29
- 审计范围：`.agents/rules/` 全部 21 个规则文件、3 个 JSON 数据文件，根 `AGENTS.md` 触发表，以及规则的实际执行载体（`.coordination/v1/`、`.archive/runs/`、`docs/plans/`、`.github/workflows/ci.yml`）
- 审计方法：全量逐条目阅读 + 引用图静态分析 + 部署/归档事实核验 + 条款级重复比对
- 结论速览：**核心业务约束设计是必要且基本无漏洞的，但执行链路存在结构性过重：机器协调合同（占语料 57%）相对其实际负载（4 票、0 历史事件）严重超配；6 组核心概念跨文件重复声明（平均扇出 2.8）；每日审计单票链路门禁密度达 10 道。判定：部分过重、局部冗余，整体可通过 P0/P1 优化削减约 25% 语料而不削弱任何核心约束。**

---

## 1. 规则链路映射表

### 1.1 语料盘点（实测）

| 类别 | 文件数 | 行数 | 字符数 | 估算 token |
| --- | --- | --- | --- | --- |
| 规则散文（.md） | 21 | 910 | 71,698 | ≈47,000 |
| 机器 Schema/向量（.json） | 3 | — | 78,296 | ≈20,000 |
| 合计 | 24 | — | 149,994 | **≈67,000** |

最大单文件：`coordination-format.md`（152 行）、`coordination-schema.json`（43KB，18 个 `$defs`，其中 `issue` 单定义 12,830 字符，占全 schema 50%）。

### 1.2 逐文件链路拆解

按职能域分五组。每条目格式：**触发前置条件 → 串行/并行步骤 → 上游依赖 → 输出与流转**。

#### A 组：通用执行基座（所有实施任务必经）

| 文件 | 触发前置条件 | 执行步骤（序） | 上游依赖 | 输出与流转 |
| --- | --- | --- | --- | --- |
| `execution.md` | 编写实施计划/实现/修复/派发/恢复 | ①分档（轻量/标准/完整）→②工作区与技能核查→③串行实施或多任务派发→④验证与审核→⑤（仅多 Agent/跨会话）派发与恢复 | 下游引用 `testing` `review` `artifacts` `issue-delivery` `checkpoints` `coordination-state` `worktrees` `orchestration` `closed-issue-*` | 档位决定后续全部门禁强度；计划入 `docs/plans/`；Ledger 入 `.archive/runs/` |
| `design.md` | 设计/Spec/ADR/任务拆分/需求冲突 | ①按优先级取事实源→②核批准元数据与 `approval_ref`→③核替代链（supersedes）→④设计工作流（Matt Skills） | `domain.md`、`artifacts.md` | 批准/替代决定回写 Spec/ADR；Ledger 记录有效版本与指纹 |
| `issue-tracker.md` | 查询/创建/拆分/更新 Issue | 单条事实声明（正式 tracker = GitHub `1123786563/OpenBot`；`ready-for-agent` 语义） | 无 | 被 `issue-delivery` 摄取步骤引用 |
| `domain.md` | 使用/修改领域术语 | ①查根 `CONTEXT.md`（OpenMuse 另查局部）→②沿用既有词→③改词义同步批准依据 | `design.md` | 词汇变更回写 `CONTEXT.md` |
| `architecture.md` | 新增 Module/改 Interface/跨 Module 调用/迁移目录/改事实所有权等 | ①读架构详细设计 Spec→②按需读目录/合同/链路/迁移四表→③五步改动流程（唯一所有者→Interface 记录→依赖核对→实施验证→同步定义） | `execution` `issue-delivery` `review`（显式声明不另起编排） | 架构定义同步至 `docs/plans/modular-architecture/` |

#### B 组：需求摄取与交付写入

| 文件 | 触发前置条件 | 执行步骤（序） | 上游依赖 | 输出与流转 |
| --- | --- | --- | --- | --- |
| `issue-delivery.md` | 分析/计划/Review/实现单个或一组 Issue | ①只读摄取（分页/去重/完整性标记）→②递归子项→③contains/depends_on 分离→④**四时点 rescan**（实施前/恢复后/终审前/写入前后）→⑤（多任务时）DAG 校验 | `issue-tracker` `design` `execution` `artifacts` `delivery-gates` `checkpoints` | 需求版本/来源记录；DAG/Ledger 入 `.archive/runs/`；rescan 结果供各消费入口共享 |
| `delivery-gates.md` | 推送/合并/关闭 Issue/加标签 | ①登记目标与证据版本→②推送前新鲜度（固定 tree→条件写）→③写后回读对账（意图→applied_valid/stale）→④关闭/标签意图事务→⑤自动关闭与人审证据 | `execution` `issue-delivery` `fingerprints` `testing` `review` `coordination-state/format` `artifacts` | delivery_intent/action 回执；普通路径一份交付记录，机器路径入 Run receipts |
| `fingerprints.md` | 需求冻结/每日恢复/写入意图（仅机器协调流程） | ①规范化（身份/排序/CRLF→LF）→②JCS 编码→③SHA-256；输入合同分 requirements-v3 / daily-input-v3 | `fingerprints.schema.json`、`fingerprints-vectors.json`、`delivery-gates` `coordination-format` | 指纹进入 daily-input、Run manifest、意图绑定 |

#### C 组：验证、审核与证据

| 文件 | 触发前置条件 | 执行步骤（序） | 上游依赖 | 输出与流转 |
| --- | --- | --- | --- | --- |
| `testing.md` | 测试/类型检查/Lint/构建/验收 | ①先读测试 ADR→②最小相关测试+命令/退出码记录→③Docker 容器声明/隔离→④trap 清理→⑤被测版本绑定冻结树→⑥数据库/副作用服务隔离→⑦目标 SHA CI 核验 | ADR 0008、`artifacts` `coordination-state` `checkpoints` `delivery-gates` `review` | 输出入 `.e2e/<run-key>/`；CI 结论入交付记录 |
| `review.md` | 审查/处理 finding/最终交付 | ①按档位定审核范围与独立性→②finding 四级裁决（critical/high/medium 阻塞，low 记录）→③每任务≤5 轮修复、无进展升级→④变化后证据承接三档→⑤（完整/专项时）OCR 范围与覆盖对账→⑥完成与收尾 | `execution`（档位）`orchestration-agents`（升级）`artifacts` `checkpoints` `delivery-gates` | 审核报告/OCR 报告入 `.archive/runs/<run-key>/reviews|ocr/` |
| `checkpoints.md` | 固定交付内容/Review Package/派生下游/转移改动/子模块 | ①选检查点方式（单写入者轻量 vs 完整快照合同）→②完整快照：snapshot_generation 冻结→逐仓库采集→③子模块接收方远端可还原门禁→④敏感内容保护→⑤派生/转移核对→⑥冻结失败检查点（frozen_failed）→⑦安全还原（不可信包防护）→⑧审查镜像 | `review` `artifacts` `coordination-state` | manifest/快照入 `.archive/runs/<run-key>/checkpoints/`；与验证/Review 绑定 |
| `artifacts.md` | 创建/迁移 Agent 文档、执行记录或验证证据 | ①按内容归类表定位→②按档位保留证据（轻量/标准免 Run，完整用 Run 合同）→③Run 布局与唯一 archive_root→④policy manifest→⑤SDD 目录适配→⑥脱敏/外发/保留期→⑦旧目录迁移 | `testing` `checkpoints` `coordination-state` `execution` | `.archive/runs/<run-key>/` 目录树；脱敏与保留登记 |

#### D 组：多 Agent 编排与共享协调（专用强约束域）

| 文件 | 触发前置条件 | 执行步骤（序） | 上游依赖 | 输出与流转 |
| --- | --- | --- | --- | --- |
| `orchestration.md` | 使用 Orca 协调多 Agent/规划/审查/恢复编排 Run | ①运行边界（单主控/单集成树/单交付入口）→②监督派发（worker-start+回执）→③分支与 Worktree 容量（K=4+1）→④DAG 调度与串行集成四步→⑤完整交付 | 权威合同分发表指向 `issue-delivery` `execution` `orchestration-agents/protocol/review` `worktrees` `checkpoints` `artifacts` | Task/Dispatch 回执、集成记录入 Run 根 |
| `orchestration-agents.md` | Orca Run 或闭票审计中选择/派发/复审/恢复 Agent | ①候选表（7 阶段×候选×选择时机）→②独立性判定（会话/贡献/历史缺口替代批准）→③回执核对→④失败后能力升级（第 4–5 轮） | `review`（轮次）`orchestration-protocol`（对账）`checkpoints`（终审覆盖） | 选定角色/预期 ID/实际回执入 Brief 与 Ledger；不可变 review manifest |
| `orchestration-protocol.md` | Orca 派发/消息/集成/失败/恢复 | ①权威状态与事件（业务 Task/阶段/Dispatch 分列）→②资源与并发（声明取得+集成串行）→③失败分流（RecoveryDecision）→④恢复核对清单 | `orchestration` `orchestration-agents` `coordination-state/format` `issue-delivery` `review` `checkpoints` | 事件/回执持久化至 Run 根；RecoveryDecision |
| `orchestration-review.md` | 任务审核/集成终审/finding/关闭 | ①任务级独立审核（worker-start 新会话）→②集成后终审+OCR 双关→③修复 DAG（frozen_failed 仅限修复）→④关闭条件与清理 | `review` `orchestration-agents` `checkpoints` `worktrees` `delivery-gates` `artifacts` | 终审/OCR 报告、关闭状态（close_pending/integration_pending 等） |
| `worktrees.md` | 创建/复用/结束 Orca Worktree 或分支 | ①先找现有归属（list 核对）→②创建时明确身份/基线/引用→③串行实现默认+并行须授权→④收尾核验（提交/未提交/子模块/后台 workload/ignored 文件）→⑤保全后才 `worktree rm` | `orchestration` `execution` `review` `checkpoints` `coordination-state` `artifacts` `closed-issue-daily-run` | Ledger/基线/清理报告入 `.archive/runs/` |
| `coordination-state.md` | 跨 Run 占用 Issue/工作区/数据库/端口/缓存或恢复每日任务 | ①部署状态与启用入口（config/适配器哈希/验收回执）→②位置与身份（coordination_root/host_id）→③issue_write_set 原子取得+relation_snapshot→④占用与释放（事务/心跳/fencing/结算）→⑤恢复引用迁移 | `coordination-format`（条款表）`checkpoints`（安全还原）`closed-issue-daily-run` | claims/daily-ledger 更新（经适配器）；回执入 Run |
| `coordination-format.md` | 登记资源/更新跨日队列/恢复索引（由 coordination-state 加载） | ①唯一身份与编码（repo_identity/repo-key/host_id/resource_key）→②文件 Schema 与记录身份（嵌套字段契约）→③每日 Run 调度与修复波次（C/P/预留/波次预算/等待算法）→④状态与调度不变量（~20 条）→⑤公共事务入口（请求外壳/幂等/兼容矩阵）→⑥持久化与崩溃恢复（journal/fsync）→⑦上线与升级验收样例（40+ 行矩阵） | `coordination-schema.json` `fingerprints` `delivery-gates` `closed-issue-*` | 适配器强制的机器合同；验收样例为部署门禁 |

#### E 组：闭票审计与每日自动化（最重链路）

| 文件 | 触发前置条件 | 执行步骤（序） | 上游依赖 | 输出与流转 |
| --- | --- | --- | --- | --- |
| `closed-issue-audit.md` | 审计已关闭 ready-for-agent 票/核对/添加待人审标签 | ①冻结 N∪R 集合（分页/完整性）→②对账已有 Run/人审→③固定原交付契约与隔离树→④逐票摄取+验收映射→⑤逐票五步（验收可观察化→代码追溯→实际运行→OCR→证据归档）→⑥裁决（verified/failed/blocked/unproven/not_applicable/not_required）→⑦贴标意图事务+写后 rescan→⑧拒绝后迁移（新 attempt） | `issue-delivery` `design` `delivery-gates` `testing` `review` `orchestration-agents` `coordination-format` `artifacts` `closed-issue-daily-run` | 不可变 review manifest、动作意图/回执、N/R 矩阵入 Run |
| `closed-issue-daily-run.md` | 配置/运行每日闭票审计修复 | ①调度配置（Orca automations，C/P/时间/波次预算）→②批次与并行边界→③每次运行七步（独占恢复→选 slot→独立审计→分流→修复→交付/动作→预算结算）→④发现后 Issue/PR 处理→⑤状态与完成条件（父树/epoch/目标前移承接/收敛稳定窗口）→⑥公平调度（类别轮转/queue_key/服务上界）→⑦自动化提示词 | 权威入口表指向 `closed-issue-audit` `orchestration-agents` `coordination-state/format` `orchestration` `testing` `delivery-gates` | daily_run_manifest、slot 事件、修复波次入 `.coordination` 与 Run 根 |

### 1.3 引用拓扑与传递闭包（实测）

被引用次数最高的文件（入度）：`artifacts.md`（12 个文件引用）、`checkpoints.md`（10）、`review.md`（9）、`execution.md`（8）、`coordination-format.md`（6）、`delivery-gates.md`（6）。

传递闭包（按触发场景实际需加载的文件集合）：

| 场景 | 传递闭包文件数 | 估算 token | 占语料比 |
| --- | --- | --- | --- |
| 轻量单模块修复 | 7 | ≈11,300 | 17% |
| 标准功能开发 | 10–12 | ≈20,000 | 30% |
| 完整档（持久化/发布） | 14–16 | ≈33,000 | 49% |
| Orca 多 Agent Run | 17 | ≈41,000 | 61% |
| **每日闭票审计** | **18/21** | **≈44,100** | **94%** |

关键结构事实：`AGENTS.md` 要求"按表中触发条件读取适用条款，不递归加载整个目录"，但 D/E 组任一入口的传递闭包都会覆盖 80%+ 语料——**懒加载设计在专用流程上实际失效**（详见 §3.4 C1）。

---

## 2. 问题识别

### 2.1 跨规则重复校验/重复声明（10 组，均附实证位置）

| 编号 | 重复内容 | 分布位置 | 性质 |
| --- | --- | --- | --- |
| D1 | label/close 失配保留验证结论的例外条款 | `delivery-gates.md` L30 与 `coordination-format.md` L73 近乎逐字双写，互相引用 | **真重复**：同一语义两处权威，改一处忘另一处即漂移 |
| D2 | stale→revalidating 状态机散文 | `delivery-gates.md` L24/L30、`coordination-format.md` L70/L73、`closed-issue-audit.md` L43，3 文件 5 处 | 真重复：流程侧与机器侧各写一遍，审计侧又复述一遍 |
| D3 | 修复预算（波次/轮次/5 上限） | `review.md` L11（Task 5 轮）、`coordination-format.md` L53-55/L71（票级 5 波）、`closed-issue-daily-run.md` L24/L44（两者并提） | 概念重复 + 术语易混：wave/round/attempt 三个计数器的定义分散 3 文件 6 处 |
| D4 | 审核独立性（干净会话/不参与实现/不继承状态） | `execution.md` L34/L38、`orchestration-agents.md` L15、`review.md` L7 | 部分重复：标准路径与 Orca 路径各写一遍实质相同的要求 |
| D5 | 档位证据要求 | `execution.md` L11-13 表、`artifacts.md` L20-22 表、`delivery-gates.md` L7 | 视角重复：流程表/产物表/交付边界三处描述同一分档证据梯度 |
| D6 | "机器协调合同何时适用"的边界声明 | `execution.md` L17/L40、`delivery-gates.md` L7、`issue-delivery.md` L21、`artifacts.md` L22、`checkpoints.md` L11 | **边界复述**：5 处各自措辞略异地声明"普通单写者免机器合同"，是漂移风险最高的一组 |
| D7 | 触发条件 | `AGENTS.md` 触发表 17 行 ↔ 每个规则文件首行触发语 | 结构性双维护（入口摘要 vs 文件权威），无一致性校验 |
| D8 | rescan 执行细节 | 所有权在 `issue-delivery.md` L17-21（含 L19 去重条款），但 `delivery-gates.md` L28 与 `closed-issue-audit.md` §1.3 又各自展开写前/结束重查细节 | 部分重复：去重条款存在，但消费方仍复述时点细节 |
| D9 | merge queue 核验 | `delivery-gates.md` L23 与 `testing.md` L21 两处 | 重复且超前：`ci.yml` 无 `merge_group` 触发器，队列未配置 |
| D10 | 共享资源清单（数据库/端口/Docker project/缓存/输出） | `testing.md` L8 与 `coordination-format.md` L12-20 resource_key 表 | 分层重复：流程侧与机器键侧各列一遍同一资源域 |

### 2.2 无实际业务价值的中间环节（5 项）

| 编号 | 环节 | 位置 | 判定依据 |
| --- | --- | --- | --- |
| V1 | v1→v2 迁移条款 | `coordination-format.md` L81 前半 | schema `const: 3`，`.coordination` 从未有过 v1/v2 部署（0 历史事件），纯死代码 |
| V2 | `fingerprints-vectors.json`（27KB 测试向量）置于规则目录 | 同目录 | 属适配器验收数据；适配器在独立仓库 `openbot-coordination` 且已自带 `samples/receipts`，规则目录不应承载测试数据 |
| V3 | policy manifest 与 Git 的双链固定 | `artifacts.md` L32 | 规则与代码同仓，Git 提交本身已固定政策版本；独立 policy_sha256 字节链在单机单仓场景收益低（多仓/外部入口场景除外） |
| V4 | SDD 工具目录适配整节 | `artifacts.md` L38-45 | 为单一外部工具链（Superpowers）维护 8 行专用合同；若当前流程不再使用即为沉淀成本 |
| V5 | run-key 后缀 + 不可变 Run ID 双标识 | `artifacts.md` L26 | 轻微：目录名后缀与 index 内完整 ID 双重身份，人工任务用 UUID 后缀价值有限 |

### 2.3 约束范围超出实际需求的过度限制（5 项）

| 编号 | 约束 | 位置 | 实际需求对照 |
| --- | --- | --- | --- |
| O1 | 安全还原完整防护规范（路径穿越/NTFS ADS/symlink TOCTOU/解压炸弹/文件数与压缩比上限） | `checkpoints.md` L42-46 | 规则自述"仓库未提供该工具实现"；当前唯一恢复路径是 cp/git/显式复制。**为不存在的工具维护 5 行高密度规范 + 被 `coordination-state.md` 部署入口引用**，约束范围超出当前需要 |
| O2 | 40+ 行上线与升级验收矩阵 | `coordination-format.md` §上线与升级验收样例 | 实际协调负载：4 条 claim、4 票 daily 记录、0 历史事件。验收矩阵规模对标的是多主机高并发生产系统 |
| O3 | 公平调度的服务上界/连续恢复限制/类别轮转完整算法 | `closed-issue-daily-run.md` L64-74 + `coordination-format.md` L75-78 | 服务对象是 4 票队列；算法已由适配器强制，规则散文再全文复述一遍属超配 |
| O4 | merge queue 全链路条款（入队授权/候选固定/重建撤放行） | `delivery-gates.md` L23、`testing.md` L21 | 队列未配置（`ci.yml` 无 merge_group），纯前瞻约束 |
| O5 | 完整快照合同边界的反复自证 | `checkpoints.md` L7/L11、`artifacts.md` L22、`execution.md` L40 | 每处都要声明"单写者/只读 reviewer 不触发整套协议"——豁免边界本身成为需要反复维护的内容 |

### 2.4 逻辑冲突与结构性张力（3 项）

| 编号 | 内容 | 判定 |
| --- | --- | --- |
| C1 | `AGENTS.md`"不递归加载整个目录" ↔ D/E 组入口传递闭包达 18/21 文件 | **结构性张力（非文本矛盾）**：懒加载入口设计与深度互引的规则图不匹配。专用流程的 Agent 事实上必须全量加载，触发表形同虚设 |
| C2 | 修复双路径：主控直接修复已授权局部 finding（`execution.md` L24）↔ Orca 终审 finding 必须建修复 DAG/方案（`orchestration-review.md` L15） | 已用"专用编排修复遵守其派发路径"消歧，**非硬冲突**，但读者必须先判定自己处于哪条路径，判别成本分布在 4 个文件中 |
| C3 | rescan"同边界共享、不重复请求"（`issue-delivery.md` L19）↔ 每日贴标路径实际新鲜度门禁链：摄取冻结 → slot 接纳 → 副作用前重核（`coordination-state.md` L31）→ 写前意图 → 写后完整 rescan | 各时点语义上必要（外部写者可在任意时点间改动），**非冲突但密度过高**：单票贴标 5 道新鲜度关卡，且每道各有记录要求 |

未发现直接互相矛盾的死锁条款；既有冲突均已被"权威合同分发表"机制（`orchestration.md` L11-18、`closed-issue-daily-run.md` L5-11）缓解。该机制是本规则体系最重要的去重设计，应保留并扩展。

---

## 3. 四维度量化评估

评分 1–5（5=最重）。依据为 §1/§2 实测数据。

### 3.1 分流程评分矩阵

| 流程 | 执行耗时 | 资源占用 | 开发成本（规则新增/修改） | 维护成本（故障排查） | 依据 |
| --- | --- | --- | --- | --- | --- |
| 轻量修复 | 2 | 1 | 2 | 2 | 7 文件 ≈11K token；2 道门禁（验证+自查）；无产物强制 |
| 标准功能 | 3 | 2 | 3 | 3 | 10–12 文件 ≈20K token；4 道门禁（计划/验证/独立 Review/收尾） |
| 完整档任务 | 4 | 3 | 4 | 4 | 14–16 文件 ≈33K token；6–8 道门禁；Run 合同+policy manifest |
| Orca 多 Agent | 4 | 4 | 4 | 4 | 17 文件 ≈41K token；K=4+1 工作区；回执/对账逐阶段留痕 |
| **每日闭票审计** | **5** | **4** | **5** | **5** | 18 文件 ≈44K token（94% 语料）；单票 ≈10 道门禁；状态机争议需对账 5 个文件 |
| 规则体系自身演进 | — | — | **5** | **5** | 见 3.2/3.3 |

### 3.2 可对比量化指标

| 指标 | 实测值 | 说明 |
| --- | --- | --- |
| 语料总量 | 910 行 / ≈67K token | 21 MD + 3 JSON |
| 机器协调域占比 | 57%（format 152 行 + state 42 行 + daily-run 80 行 + audit 49 行 + 3 JSON ≈38K token） | 服务于 4 票/0 历史事件的负载 |
| 核心概念平均扇出 | **2.8 文件/概念**（D1–D6、D9、D10 共 8 组：5,3,3,3,5,2,2,2 处） | 任一语义变更平均需同步 2.8 处 |
| 单次语义变更同步点 | 3–4 文件（散文+schema+验收矩阵+引用方） | 实测 D1/D3 变更路径 |
| 规则变更频率 | **37 次提交 / 近 14 天**（2.6 次/天） | 规则本身处于高频演进期，放大上述同步成本 |
| 门禁密度（每日单票） | ≈10 道（摄取冻结/epoch/slot 接纳/独立审计/分流/修复波次/终审/OCR/交付/标签意图+写后对账） | 其中新鲜度类 5 道（C3） |
| 证据存储 | 92 个 Run（65 含 index，71%）；单 Run 峰值 **12GB**；多个 600MB+ | `.archive/` 被 gitignore，本机留存 |
| 协调部署实际负载 | 4 claim / 4 票 / 0 历史事件 | 对比 O2 的 40+ 验收行 |
| schema 单定义峰值 | `issue` def 12,830 字符（占 schema 50%） | 人工审查困难，只能靠适配器 |

### 3.3 维护成本热点（故障排查路径实测）

1. **"贴标为何被拒"排查**：需依次对账 `closed-issue-audit.md` §3 → `delivery-gates.md` §关闭/标签 → `coordination-format.md` 状态不变量 → `coordination-schema.json` issue def → 验收矩阵对应行，**跨 5 个文件**，其中状态机散文在 3 处（D2）。
2. **"修复预算是否耗尽"排查**：需区分 Task 轮次（`review.md`）、票级波次（`coordination-format.md`）、Run 预算（`closed-issue-daily-run.md`）三个计数器（D3）。
3. **"本任务要不要机器合同"**：需核对 5 处边界声明（D6）才能确认，而答案在绝大多数场景是"不需要"。

### 3.4 综合判定

- **执行耗时**：轻量/标准档开销合理（分档设计有效）；完整档可接受；**每日审计链路过重**（94% 语料传递闭包 + 10 道门禁）。
- **资源占用**：证据归档体积大但属可审计性必要代价；协调基础设施本身占用极小（200KB），**主要开销在上下文 token 而非磁盘**。
- **开发成本**：规则高频演进期（2.6 提交/天）叠加 2.8 的概念扇出，**每次语义变更的回归面是全体系最重的成本项**。
- **维护成本**：状态机与预算语义的多文件分布使排查必须跨 4–5 文件对账，且散文与 schema 双源需人工保持一致。

---

## 4. 正式评估结论

**判定：当前规则执行流程"部分过重、局部冗余"——核心业务约束（授权、独立性、条件写、子模块可还原、脱敏、新鲜度）设计必要且未发现漏洞，但承载方式存在三类可证实的超重：**

1. **机器协调合同相对实际负载严重超配**（57% 语料服务 4 票/0 事件负载，含为不存在工具维护的防护规范与未启用队列的全链路条款）；
2. **核心概念跨文件重复声明**（8 组、平均扇出 2.8，构成规则演进的主要回归面）；
3. **专用链路门禁密度与传递闭包过大**（每日单票 10 道门禁、94% 语料加载，懒加载入口设计在 D/E 组失效）。

**不应削弱的核心约束清单**（优化红线）：分档体系、批准与 `approval_ref` 核验、审核独立性、条件写与写后对账、子模块接收方远端可还原门禁、敏感内容脱敏、frozen_failed 仅限修复、"不自行改票批准自己"。

### 可优化节点标注（按优先级）

| 优先级 | 节点 | 对应问题 | 调整方向 |
| --- | --- | --- | --- |
| **P0-1** | `coordination-format.md` v1→v2 迁移条款 | V1 | 删除，保留 2 行通用迁移纪律 |
| **P0-2** | `fingerprints-vectors.json` | V2 | 迁至 `openbot-coordination` 适配器仓库，规则侧留指针 |
| **P0-3** | D1/D2 状态机双写 | D1、D2 | 指定 `delivery-gates.md` 为状态机散文唯一所有者；`coordination-format.md` L73 删复述留指针 |
| **P0-4** | `checkpoints.md` §安全还原 | O1 | 降级为 `docs/specs/` 设计规范；规则保留 3 行"未部署即 blocked"门禁 |
| **P1-1** | 5 处机器合同边界声明 | D6、O5 | 在 `execution.md` 设唯一"机器合同适用判定表"，其余 4 处改引用 |
| **P1-2** | wave/round/attempt 术语 | D3 | 在 `coordination-format.md` 设唯一定义表，`review.md`/`daily-run` 引用 |
| **P1-3** | `orchestration-protocol.md` | 引用三角 | 并入 `orchestration.md`（agents/review 因被审计域直接引用而保留独立） |
| **P1-4** | 公平调度散文 | O3 | daily-run 保留 3 行摘要+指针，算法细节以适配器验收矩阵为准 |
| **P1-5** | merge queue 条款 | D9、O4 | 合并为 `testing.md` 单条条件式条款，`delivery-gates.md` 引用 |
| **P2-1** | AGENTS.md 表 vs 文件头 | D7 | 增加一致性校验脚本（或表格纯指针化） |
| **P2-2** | policy manifest 双链 | V3 | 允许 policy_sha256 以规则目录 Git tree hash 等价生成（修指纹合同，需走完整档） |
| **P2-3** | SDD 适配节 | V4 | 确认使用状态后冻结或删除 |

---

## 5. 精简优化落地方案

### 5.1 P0 操作说明（低风险，不触碰任何核心约束）

**P0-1 删除 v1→v2 迁移条款**
- 操作：`coordination-format.md` L81 删除 v1→v2 句，保留"迁移须在锁内备份、核活跃拥有者、全体参与者兼容后切换"一句；同步删除验收矩阵中仅针对 v1→v2 的行（如有）。
- 约束保全：v2→v3 与通用迁移纪律仍在；schema `const:3` 不变。

**P0-2 迁移测试向量**
- 操作：`fingerprints-vectors.json` 移入 `openbot-coordination` 仓库验收目录；`fingerprints.md` L3 改为"固定向量见适配器仓库 `<路径>`"。
- 约束保全：向量内容不变，仅存放位置变化；适配器验收能力不受影响。

**P0-3 状态机单一所有权**
- 操作：`coordination-format.md` L73 删除例外条款复述，改为"失配纠正与例外按 [交付门禁](delivery-gates.md) §关闭/标签"；`closed-issue-audit.md` L43 的 `delivered＋stale/revalidating` 复述同样改为指针。`delivery-gates.md` 保持现状为唯一散文权威；`coordination-format.md` 仅保留机器可强制的不变量（进入/退出条件）。
- 约束保全：状态机语义一字不删，只删复述；机器强制逻辑在 schema/适配器侧不变。

**P0-4 安全还原降级**
- 操作：将 `checkpoints.md` L42-46 的防护细节（路径拒绝清单、平台特殊名、句柄级核验、类型白名单、上限配置）整体迁入 `docs/specs/2026-10-29-untrusted-restore-design.md`；`checkpoints.md` 保留：①不可信包按不可信输入处理；②恢复工具须满足该规范并经验收，未部署即 blocked、不做部分恢复；③`.git` 元数据禁写。`coordination-state.md` 的引用改指规范文档。
- 约束保全：blocked 门禁与"不部分恢复"语义保留；未来建工具时规范完整可取。

### 5.2 P1 操作说明

**P1-1 机器合同适用判定表**：在 `execution.md` 新增 8 行以内的判定表（触发机器合同 = Orca / 共享资源 / 每日自动化 / 跨 Run 恢复；其余一律普通路径），替换 `delivery-gates.md` L7、`issue-delivery.md` L21、`artifacts.md` L22、`checkpoints.md` L11 四处边界复述为单句引用。

**P1-2 预算术语表**：`coordination-format.md` 增加"计数器定义表"（repair_rounds_total=票级波次累计；Task 整改轮次=review.md 的 5 轮；Run 预算=max_run_repair_rounds），`closed-issue-daily-run.md` L24/L44 与 `review.md` L11 改为引用该表。

**P1-3 合并 orchestration-protocol.md**：将其 28 行并入 `orchestration.md` 的"权威状态、资源与恢复"节；`orchestration-agents.md`/`orchestration-review.md` 保留（被 `closed-issue-audit.md`、`review.md` 直接引用，合并会扩大那些入口的闭包）。

**P1-4/P1-5**：按 §4 表列方向执行，均为"删复述留指针"。

### 5.3 P2 操作说明

- **P2-1**：在 `scripts/` 增加轻量校验（比对 AGENTS.md 表行与文件首行触发语的文件名覆盖），纳入现有 lint 流程；不做强制文案一致。
- **P2-2**：属指纹合同变更，按完整档走（计划+独立 Review+OCR），不在本轮直接改。
- **P2-3**：先查 `.archive/runs/` 中 SDD 目录使用痕迹再决定删/留。

### 5.4 预期收益预估

| 指标 | 现状 | 优化后（P0+P1） | 变化 |
| --- | --- | --- | --- |
| 规则散文行数 | 910 | ≈700 | **−23%** |
| JSON 字符数 | 78,296 | ≈51,000 | **−35%** |
| 语料总 token | ≈67,000 | ≈50,000 | **−25%** |
| 每日审计传递闭包 | 18 文件 / ≈44K token | 16 文件 / ≈35K token | **−20%** |
| 核心概念平均扇出 | 2.8 | ≤1.5 | **−46%** |
| 单次语义变更同步点 | 3–4 文件 | 1–2 文件 | **−50%+** |
| 状态机排查跨文件数 | 5 | 3 | −2 |
| 门禁数量/核心约束 | 基线 | **不变** | 0（红线保全） |

维护成本定性收益：规则演进期（2.6 提交/天）下，同步点减半直接等比降低漂移概率；状态机与预算语义收敛到单一权威后，"贴标被拒/预算耗尽"两类高频排查从多文件对账降为单文件+schema 对账。

### 5.5 风险与回退

- 全部 P0/P1 操作均为"删复述、留指针、迁位置"，不改变任何门禁的判定逻辑；逐项独立提交，任一异常可单独回退。
- P0-3/P1-1 涉及多文件引用改写，完成后应跑一次每日审计链路的干读核验（按 `closed-issue-daily-run.md` §自动化任务提示词走读一遍加载路径）确认无断链。
- P2-2 触及指纹合同，不在本方案授权范围内实施，仅列为方向。

---

## 附录：证据索引

- 引用图与行数统计：对 `.agents/rules/*.md` 的 grep/wc 实测（2026-10-29）
- 协调部署状态：`.coordination/v1/config.json`（适配器 `openbot-coordination` v0.1.0）、`claims.json`（4 条）、`repos/…/daily-ledger.json`（4 票、0 历史事件）
- 归档使用：`.archive/runs/` 92 个目录（65 含 index），峰值 12GB
- 规则演进：`git log -- .agents/rules/` 近 14 天 37 次提交；最近两次收敛提交为 `1392e6fa6`（Condense agent rules into single-owner references）、`3583ecc13`（Trim agent rule prose and drop duplicate definitions）
- merge queue 未配置：`.github/workflows/ci.yml` 无 `merge_group` 触发器
