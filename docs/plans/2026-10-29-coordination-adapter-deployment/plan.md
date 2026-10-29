# 协调事务适配器与安全恢复工具部署 — 实施计划

> **status: implemented** — 批准者：用户 wuyj（2026-10-29 会话明确批准）；批准所针对版本指纹 sha256 前 16 位=01227a1de4996449（批准时所呈版本）；approval_ref=本会话用户指令「批准」。计划与规则冲突时以规则为准。
> **执行结果（2026-10-29）**：Task 1–11 全部完成（native inline + TDD，92 测试 6/6 验收）；终审 5 high+5 medium 已在修复波 R1 全部修复（RED→GREEN，base aceb3f2→38a7528）；config.json 已登记、coord verify=ok；run14 人工试运行通过（#260 审计 verified）。低危 4 项未获风险接受授权保持待处理。证据：`.archive/runs/2026-10-29-coordination-adapter-deployment-1856019/` 与 `.archive/runs/2026-10-29-closed-issue-daily-run14-trial-aceb3f2/`。

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现并通过验收一套单主机协调事务适配器 + 安全检查点恢复工具，登记 `.coordination/v1/config.json`，走完一票人工试运行，解除已关闭 Issue 每日审计链（run11–run13 capability_blocked）的主门禁。

**Architecture:** 独立仓库 `~/trea/openbot-coordination/`（不进 OpenBot 产品仓，避免与 upstream CopilotKit/OpenBot 的合并摩擦；协议文档/schema 仍以 OpenBot 仓 `.agents/rules/` 为唯一事实源，本地路径引用）。适配器 = 唯一公共事务入口 `transaction(request)`，加薄 CLI `coord`；恢复工具独立入口 `coord-restore`。数据根 = 已创建的 `/Users/wuyongjun/trea/OpenBot/.coordination/v1/`（不在可清理 Run/Worktree 中）。

**Tech Stack:** Python 3.11+（stdlib fcntl/hashlib/json；PyPI: `rfc8785` JCS、`jsonschema`）、pytest、venv。选 Python 因 fcntl.flock 在 stdlib（Node/Bun 需原生扩展）；协调规则本身以 `fcntl.flock` 为参照实现。

**Spec:** `.agents/rules/coordination-format.md`（适配器契约+验收矩阵）、`coordination-state.md`（部署边界+config 登记项）、`coordination-schema.json`（v3 唯一机器 schema）、`checkpoints.md`（恢复工具上限）、`closed-issue-daily-run.md`（每日语义消费方）、run13 归档 `.archive/runs/2026-10-29-closed-issue-daily-run13/`（缺口与恢复步骤）。计划与 Spec 冲突时以规则为准。

## Global Constraints（逐条源自规则，任务隐含全部遵守）

- 机器 schema 唯一来源为 coordination-schema.json，按本地文件读取，不访问其中标识 URI（format §数据外壳）。
- 时间 UTC RFC3339 `Z`；版本/generation 非负整数；token 密码学安全 UUID；数组按身份键排序（format §外壳）。
- resource_key 按 RFC 8785 JCS 编码的 JSON 数组；repo_identity 固定 `github.com/1123786563/openbot`（format §身份）。
- 锁：registry.guard 上 OS 排他锁（fcntl.flock），锁文件保持原 inode，不删除、不以 rename 替换（state §占用与释放）。
- 持久化：可恢复 journal、文件 flush+fsync、原子替换、父目录 fsync；失败不启动副作用（state §2）。
- 错误码固定集：`validation_failed / revision_conflict / resource_conflict / stale_relation / idempotency_conflict / stale_token / persistence_failure / unverifiable`；失败无副作用（format §公共事务入口）。
- request_hash = 除 request_id 外完整请求的 JCS+SHA-256；同 ID 同哈希返原回执不变 revision，同 ID 异哈希 `idempotency_conflict`（format §幂等）。
- 默认心跳 60s、expires_at=最后心跳+5min；仅核对后接管并递增 generation，不以 TTL 到期直接抢锁（state §4）。
- config.json 只含身份与受控凭据引用，不存秘密；缺项即 capability_blocked（state §位置与身份）。
- 恢复工具上限：最大文件数、单文件/总展开大小、压缩比、链接深度，全包验证与展开两阶段均执行；未配置或超限 blocked，不做部分恢复（checkpoints §36）。
- 适配器从追加事件重放公平性，不接受调用方提交的 n/r 计数；next_class 等游标只能由适配器推进（format §daily 语义）。
- 单主机（wuyjun-mac）、本地文件系统；网络文件系统不做锁后端（state §1）。

## Review Focus（规范未逐条点名、最可能咬人的失败类）

1. 锁 inode 被换（有人重建/替换 registry.guard 后旧 flock 失效）→ 持锁期间 inode 必须校验，替换尝试被拒（Task 3 测）。
2. 崩溃窗口（journal 已写、目标文件未替换，或反之）→ 重放必须无损无重（kill -9 实测，Task 3）。
3. 幂等漂移（同 request_id、内容被改后重放）→ 必须拒 `idempotency_conflict` 且 revision 不动（Task 5）。
4. 伪造游标（调用方直接提交 next_class/计数）→ 适配器必须从 history 重算并拒绝不一致（Task 6）。
5. 部署后漂移（config 登记后适配器文件被改）→ verify 必须按内容哈希判 blocked（Task 1+10）。

---

## File Structure（`~/trea/openbot-coordination/`，独立 git 仓）

```text
pyproject.toml              # 包 coord，deps: rfc8785, jsonschema; dev: pytest
config.schema.json          # config.json 自身的机器 schema（本计划 Task 1 定义）
src/coord/identity.py       # repo_identity 别名映射 / resource_key JCS / host_id 首锁初始化
src/coord/locking.py        # GuardLock: flock + inode 校验
src/coord/journal.py        # journal 追加/重放、flush+fsync、原子替换、父目录 fsync
src/coord/config.py         # config.json 加载校验（哈希比对 + 缺项→blocked）
src/coord/schema.py         # 本地 coordination-schema.json 加载 + $defs 校验
src/coord/claims.py         # 声明存储语义、mode 兼容矩阵、心跳/TTL、接管/generation
src/coord/daily.py          # slot 选票事务、公平游标重放、label 预算、波次/epoch 计数
src/coord/txn.py            # transaction(request) 编排 + 错误码
src/coord/cli.py            # CLI: coord txn|verify|heartbeat|release|show
src/coord/restore.py        # coord-restore 两阶段恢复 + 上限
samples/run_acceptance.py   # 验收矩阵驱动，产出 receipts/<case>.json
tests/                      # 与模块一一对应的 pytest 文件
```

数据根（运行时生成，不在实现仓内）：`.coordination/v1/{config.json, host.json, registry.guard, claims.json, repos/<repo-key>/daily-ledger.json, journal/, idempotency/}`。

---

### Task 1: 仓骨架 + config schema 与加载器

**Files:** Create `pyproject.toml`, `config.schema.json`, `src/coord/config.py`, `tests/test_config.py`
**Interfaces:** Produces `load_config(path) -> Config`（字段见 config.schema.json）、`Config.capability() -> "ok"|"blocked:<缺项>"`；后续所有任务从 Config 取 adapter 身份与根路径。

config.json 正式字段（本计划即为定义处；规则只锁内容清单，编码在此固定）：

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `config_version` | int | ✓ | 本 schema 版本，=1 |
| `coordination_root` | string | ✓ | 绝对路径，须存在且非 Run/Worktree 可清理区 |
| `adapter.entry` | string | ✓ | 适配器实现绝对路径 |
| `adapter.version` | string | ✓ | 语义版本 |
| `adapter.content_sha256` | string(64hex) | ✓ | 与 entry 实际文件 SHA-256 一致 |
| `adapter.schema_compatibility.ledger_schema_version` | int | ✓ | =3 |
| `adapter.schema_compatibility.schema_sha256` | string(64hex) | ✓ | coordination-schema.json 内容哈希 |
| `adapter.acceptance_receipts[]` | {case, evidence} | ✓≥5（完整性由 capability 校验） | claim_acquisition / idempotency_replay / crash_recovery / fairness_replay / v3_acceptance_matrix |
| `heartbeat_ttl` | {heartbeat_seconds:int, ttl_seconds:int} | ✓ | 默认 60/300 |
| `service_aliases` | object | ✓（可为空对象起步） | 键=别名，值=规范身份；仅登记已核实项 |
| `safe_restore_tool.entry/version/content_sha256` | 同 adapter | ✓ | 哈希一致 |
| `safe_restore_tool.acceptance_receipt` | {case, evidence} | ✓ | checkpoints 上限验收 |
| `safe_restore_tool.limits` | {max_files, max_single_file_bytes, max_total_bytes, max_compression_ratio, max_symlink_depth} | ✓ 全正数 | 恢复两阶段强制 |
| `credentials` | object | ✓（可为空） | 值只能是引用（`keyring:` / 路径），出现明文秘密即 validation_failed |

- [ ] **Step 1: 写失败测试** `test_config.py::test_minimal_config_ok`、`::test_missing_receipts_blocked`、`::test_hash_mismatch_blocked`、`::test_plaintext_secret_rejected`（用 tmp_path 造样例 config 与假 entry 文件）。
- [ ] **Step 2: 跑测试确认 FAIL**（模块不存在）。Run: `pytest tests/test_config.py -v`
- [ ] **Step 3: 实现** `config.schema.json`（上表机器化）+ `config.py`（jsonschema 校验 + sha256 比对 + capability 判定）。
- [ ] **Step 4: 跑测试 PASS**。
- [ ] **Step 5: Commit** `feat: config schema and loader`（独立仓首个提交含 `git init`）。

### Task 2: 身份模块

**Files:** Create `src/coord/identity.py`, `tests/test_identity.py`
**Interfaces:** Consumes rfc8785；Produces `repo_identity(url|alias)->str`、`resource_key(kind, *parts)->list`（JCS 数组）、`host_id(root, guard_lock)->uuid_str`（首锁内初始化 host.json，之后只读复用）。

- [ ] **Step 1: 失败测试**：`test_repo_identity_maps_aliases`（HTTPS/SSH/别名 → `github.com/1123786563/openbot`）、`test_resource_key_vectors`（用 format §身份表逐行：issue 元组、daily 元组、worktree 元组等，期望值逐字面断言）、`test_host_id_init_once_under_lock`（两次调用同值、host.json 幂等）。
- [ ] **Step 2: 确认 FAIL → Step 3: 实现 → Step 4: PASS**。
- [ ] **Step 5: Commit** `feat: identity normalization and host id`。

### Task 3: 锁与 journal（崩溃恢复核心）

**Files:** Create `src/coord/locking.py`, `src/coord/journal.py`, `tests/test_locking.py`, `tests/test_journal.py`
**Interfaces:** Produces `GuardLock(path)` 上下文管理器（持锁期间每操作前校验 inode==打开时 inode）、`Journal.append(entry)`、`Journal.replay()->list`、`atomic_replace(path, bytes)`（写临时→fsync→rename→父目录 fsync）。

- [ ] **Step 1: 失败测试**：`test_exclusive_hold`（第二进程取锁超时失败）；`test_inode_replacement_rejected`（持锁中外部 rename 替换 guard → 后续操作抛 `unverifiable`）；`test_kill9_mid_journal_replays_consistent`（子进程 journal 写一半 SIGKILL → 重放后无半条目、计数一致）；`test_atomic_replace_survives_crash`（模拟 rename 前后两个时点，目标文件始终完整旧或新）。
- [ ] **Step 2–4: FAIL→实现→PASS**（kill -9 用 `subprocess` + `os.kill`）。
- [ ] **Step 5: Commit** `feat: inode-stable lock and crash-safe journal`。

### Task 4: 声明事务核心（claims + mode 矩阵 + TTL）

**Files:** Create `src/coord/claims.py`, `tests/test_claims.py`
**Interfaces:** Consumes Task 2/3；Produces `acquire(claims)->receipt`、`claim_updates(updates)`（reserved→running→settling、活跃→unverifiable、unverifiable→running 须正面对账回执）、`renew`、`release`；mode 矩阵：read↔read 共享，read↔write / write↔write / aggregate↔write / 重叠 aggregate↔aggregate 互斥，daily 恒 write。

- [ ] **Step 1: 失败测试**（矩阵逐格 + format §矩阵表逐行）：`test_read_read_shares`、`test_read_write_conflicts`、`test_reentrant_acquire_returns_original_token`（同 owner 同资源重入不建新 token/generation）、`test_stale_token_rejected`、`test_renew_extends_expires_at`、`test_takeover_requires_settlement_evidence_and_bumps_generation`（TTL 过期不自动抢锁）。
- [ ] **Step 2–4: FAIL→实现→PASS**。
- [ ] **Step 5: Commit** `feat: claims store with compatibility matrix`。

### Task 5: 幂等库与错误码

**Files:** Create `src/coord/txn.py`（编排雏形）, `tests/test_txn_idempotency.py`
**Interfaces:** Produces `transaction(request)->receipt`（成功含 `request_id/request_hash/status=applied|replayed/transaction_sequence/revisions/claims/file_hashes`）；幂等存储 `owner_run+request_id → request_hash+原回执`，与协调根同寿命。

- [ ] **Step 1: 失败测试**：`test_same_id_same_hash_replays_original_without_revision_change`、`test_same_id_diff_hash_idempotency_conflict`、`test_error_codes_documented_and_reachable`（8 个错误码各造一个触发样例，断言稳定码+结构化 details+无副作用——用前后 claims.json 哈希不变证明）。
- [ ] **Step 2–4: FAIL→实现→PASS**。
- [ ] **Step 5: Commit** `feat: transaction entry with idempotency store`。

### Task 6: daily 选票与公平游标（从事件重放）

**Files:** Create `src/coord/daily.py`, `tests/test_daily.py`
**Interfaces:** Consumes claims；Produces `select_slot(...)` 事务（同事务记 slot_selected+服务序号+label 预算+next_class/consecutive_recovery 推进）、`settle_slot(...)`、`reserve/consume/release_label_budget`（消费/释放各至多一次）、公平重放 `replay_fairness(daily)->FairnessState`。

- [ ] **Step 1: 失败测试**（语义全引 format §daily + closed-issue-daily-run §公平调度）：`test_enqueue_sequence_fixed_at_first_selection`、`test_queue_key_order_last_slot_or_enqueue`、`test_class_rotation_recovery_new_revalidate`、`test_consecutive_recovery_cap_one`（A/A/B/B 时 B 必获服务）、`test_new_ticket_service_bound`（旧票连续动作不饿死新票）、`test_forged_cursor_rejected`（提交与 history 重放不一致的 next_class → validation_failed）、`test_label_budget_consumed_once`、`test_slot_events_idempotent_settle`。
- [ ] **Step 2–4: FAIL→实现→PASS**。
- [ ] **Step 5: Commit** `feat: daily slot selection with fairness replay`。

### Task 7: 波次与 epoch 计数

**Files:** Modify `src/coord/daily.py`, Create `tests/test_waves_epochs.py`
**Interfaces:** Produces `open_repair_wave(...)`（同事务核未结算波次+全局/Run 剩余额度，repair_rounds_total 精确+1，state_changed.refs 存 manifest；同 wave_id 幂等重放不重复计数）、epoch manifest 冻结/复核、v2→v3 迁移锚点（generation 高水位、不猜填）。

- [ ] **Step 1: 失败测试**：`test_wave_counts_once_per_wave_id`、`test_same_task_retry_requires_next_wave`、`test_quota_not_reset_by_task_split_or_new_run`、`test_epoch_freezes_target_sha`、`test_v2v3_migration_keeps_generation_highwater`。
- [ ] **Step 2–4: FAIL→实现→PASS**。
- [ ] **Step 5: Commit** `feat: repair waves and epoch manifests`。

### Task 8: v3 schema 语义校验接线

**Files:** Create `src/coord/schema.py`, `tests/test_schema_semantics.py`
**Interfaces:** Produces `validate_ledger(doc)`（结构 + format §外壳全部跨字段语义：`(resource_key,owner_run)` 唯一、daily repo-key 匹配、event_id 全局唯一、history 只追加、序号约束、class 非空时 eligible_since/input_fingerprint 必填…）。

- [ ] **Step 1: 失败测试**：对每个语义条款造一个违规样例断言拒绝（≥10 个用例，逐一对应 format 行文）。
- [ ] **Step 2–4: FAIL→实现→PASS**（jsonschema 先结构，语义自实现）。
- [ ] **Step 5: Commit** `feat: v3 schema and semantic validation`。

### Task 9: 安全恢复工具 coord-restore

**Files:** Create `src/coord/restore.py`, `tests/test_restore.py`
**Interfaces:** Consumes config.limits；Produces `coord-restore package <src>` / `coord-restore expand <pkg> <dst>`：全包验证与展开两阶段；仅普通文件/目录/通过校验的符号链接；硬链接/设备/FIFO/socket 拒绝；超限即整包拒绝，零部分展开。

- [ ] **Step 1: 失败测试**：`test_two_phase_limit_enforcement`（文件数/单文件/总量/压缩比/链接深度各造一个超限包）、`test_special_file_types_rejected`、`test_symlink_cycle_rejected`、`test_no_partial_expansion_on_breach`。
- [ ] **Step 2–4: FAIL→实现→PASS**。
- [ ] **Step 5: Commit** `feat: two-phase safe restore with hard limits`。

### Task 10: 验收矩阵 + 真实 config.json 登记

**Files:** Create `samples/run_acceptance.py`; 数据根 Create `.coordination/v1/config.json`（真实值）
**Interfaces:** Consumes 全部模块；Produces `receipts/<case>.json`（JCS 规范化+SHA-256），case 覆盖：claim_acquisition、idempotent_replay、crash_recovery、fairness_replay、v3_acceptance_matrix（format §验收矩阵逐行：双读者释放后写者可取得、integration_pending→revalidating/blocked 可落盘、无 slot 失效事件可重放、跨 Run 恢复不重占名额、A/B 持续可行动时 C 必获服务、epoch 目标前移保历史不贴标、v2→v3 高水位迁移、关闭 pending 对账不依赖当前标签）、restore_limits。

- [ ] **Step 1: 驱动脚本跑通全部 case 并产出回执**（回执含输入、期望、实际、工具版本与内容哈希）。
- [ ] **Step 2: 计算适配器/恢复工具/schema 实际哈希，写真实 config.json**，`coord verify` 返回 capability=ok。
- [ ] **Step 3: 部署后漂移演练**：改一个字节→verify 必须 blocked→还原→ok（Review Focus #5 闭环）。
- [ ] **Step 4: Commit（实现仓）+ 在 OpenBot run 归档记录 config 登记回执**（`/Users/wuyongjun/trea/OpenBot/.archive/runs/<run-key>/receipts/`，run-key 执行时定）。

### Task 11: 一票人工试运行与启用

**Files:** OpenBot 仓 `.archive/runs/<new-run-key>/`（试运行证据）
**Interfaces:** Consumes 已登记能力；步骤在 OpenBot 主 checkout 以 run14 试运行执行（用户触发）。

- [ ] **Step 1: 试运行走完一票**：以适配器事务取得 `daily:github.com/1123786563/openbot` 声明 + 原子选票（队首 #260 audit slot），走读取→隔离工作区→审计→证据落归档→安全结算→释放声明；核对恢复路径（中途 kill 一个只读探测进程后按接管协议对账）。
- [ ] **Step 2: 结果判定**：试运行通过 → 后续每日 Run 以已登记能力执行（run15 起 capability 解除）；失败 → 保持 capability_blocked，修复后重试（不降低验收标准）。
- [ ] **Step 3: 记录**：把 config 路径、适配器身份、验收证据入口写入该 Run 归档 index；更新 memory。

## 回滚与边界

- 回滚 = 删除/清空 `.coordination/v1/config.json` → 立即回到 capability_blocked 只读姿态（即 run11–13 现状），数据根其余文件保留。
- 本计划不扩大任何 GitHub 写入、贴标、提交/推送授权；不改动自动化调度（armed 保持）。
- 多主机不在范围：跨主机写同一资源按 state 规则保持 blocked。
- 实现仓地址、维护责任人（默认 wuyj + Claude 会话）在 config.json 生成时固化。
