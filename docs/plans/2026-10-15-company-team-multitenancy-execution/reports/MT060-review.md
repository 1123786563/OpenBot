# MT060 复审报告 — 独立复审（Issue #103 OpenMuse 任务/计划/监控/租约归属域）

- 复审者：MT060 独立复审 worker（Pi，Orca Task `task_3d4bce8b92b6` / Dispatch `ctx_f4ab44909db8`），全新会话，与实现者（三任接力）无共享上下文。
- 日期：2026-10-18。树：`/Users/wuyongjun/orca/workspaces/OpenBot/r15-mt060`，HEAD 实测 `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（= BASE；全部交付为未提交工作区改动，与 MT060.md「全程零 git 提交」一致，复审全程亦零提交零暂存，收尾复验 HEAD 未动）。
- 输入：brief `briefs/MT060-review-brief.md` + 实现 brief `briefs/MT060-brief.md` + `reports/MT060.md` + `checkpoints/MT060/` 全套（design/migration/red-green/mutation/verification/before-after-hashes）+ 被审 5 交付文件本体 + `checkpoints/prereq-manifest.txt`（BASE+268 快照）。
- 复审约束遵守：被审文件只读；唯一新建 = 本报告；不修复；无提交/推送/合并。4 处变异均为**临时受控实验**，收尾逐一字节还原并复验（见 §4）。

**结论先行：四条验收全部维持 PASS；冻结面与无夹带核对全部通过；4 组独立变异全部被恰好捕获且字节复原。1 项 Low 发现（R-1：biome「0 问题」在仓库钉版口径下不可复现，仅格式/导入排序，无行为影响），不阻塞验收。**

---

## 1. 交付物与前置完整性核验（无夹带）

- **prereq-manifest 268 项逐文件 SHA-256 复算**：264 项与当前字节一致；仅 4 项漂移 = 3 处预授权窄缝（`migrate-test.ts`、`schema/index.ts`、`migration-tool.test.ts`）+ 1 处预披露 RECTIFIED（`entry-context.test.ts` 令牌版）。**此外零漂移**——GREEN-1 接管修复若夹带了任何本票外文件改动，必在此现形；实测没有。
- **冻结面 17 项逐行复核**：`after-hashes.txt` 的 3 项 DIFF 当前哈希 = 存档 after= 值；14 项 SAME 当前哈希 = `before-hashes.txt` 逐字节一致（17/17 MATCH）。任务核心冻结对象 `openmuse-tasks/store.ts`、`routes.ts`、`runner.ts`、`work/queue.ts`、`index.ts` 全部 SAME，「服务面窄缝、既有权威 store 零复刻」坐实。
- **RECTIFIED 双哈希链闭合**：`verification/02`（before `d7e4d400…` = prereq-manifest 同文件值）→ `verification/03`（after `5b78842a…`）= 本树当前值。令牌语义（w14int→w15b_test）与 `entry-context.test.ts:192` 的硬断言 `openbot_enterprise_w15b_test` 一致。
- **三处窄缝与披露逐字吻合**：MT060 任务块位于 `migrate-test.ts:1819/1850` + TASKS 尾部注册 1 行（Map 尾、纯追加）；`migration-tool.test.ts:399-419` 仅追加注释 + `"MT060"`；`schema/index.ts:27` 纯追加 barrel 1 行。均与 `changes-summary.txt` 披露一致。

## 2. 独立复跑记录（三步配方，全部亲自执行）

环境：端口 55589 预检空闲；容器 `mt060-review-pg`（pgvector/pgvector:pg16，trust，仅回环映射，镜像 sha256:7b822b0a… 与实现者存档同镜像 ID）；`bun install` 1415 packages；库名按 **树内令牌版** 对齐（`openbot_enterprise_w15b_test` + `_assigned` + `openbot_kb_w15b_test`，属主角色 `ent_w15b_kb` 先于建库——review brief 的 `r15d_*` 缺省口径被其自身「令牌按树内版本环境对齐」条款覆盖，因 in-tree 硬断言钉死 w15b 令牌）；角色/库逐条 `psql -c`；七变量 env 0600（`/tmp/mt060-review-env.sh`），收尾已删。

| # | 步骤 | 实测结果 |
| --- | --- | --- |
| 1 | base migrate（`enterprise-test-db.ts migrate`） | `{"type":"migrations-applied","status":"ok"}`；受限登录面 4 LOGIN `ent_w15b_*` + 4 NOLOGIN `ob_ent_*`（与 verification/00、07 逐项一致） |
| 2 | 修正链序 19 前置 generate+apply + MT060 最后 | 20/20 全 applied、零失败；journal **20 任务 / 39 步**（= 前置 36 + MT060 3），逐任务步数与 verification/00 存档表完全一致；MT060 planDigest `1c934766…` |
| 3 | 聚焦套件 `openmuse-tasks.test.ts` | **31 pass / 0 fail / 168 expect**（2.8s；与本 brief 票面口径逐字一致；变异期间共复跑 8 次均 31/0/168） |
| 4 | 全量 `bun --no-env-file test tests/multitenancy`（变异注入前） | **1155 pass / 0 fail / 44 文件 / 12973 expect**（29.3s） |
| 5 | 全量复跑（全部变异 RESTORE 后收尾） | **1155 pass / 0 fail / 44 文件 / 12970 expect**（27.5s；与实现者终跑 verification/11 数字逐字一致） |
| 6 | typecheck `tsc --noEmit` | exit 0 |
| 7 | biome check 5 个触及文件 | **7 个诊断（见 Finding R-1）**；冻结文件 `job-ownership.ts` 干净 |
| 8 | 零提交校验 | HEAD `f0520524…` 未动、暂存区空、容器 `docker rm` 后 0 残留 |

注：两次全量 pass/fail 完全一致（1155/0/44），expect 计数 12973 vs 12970 有 ±3 的运行间波动（全量套件中存在 expect 记账非确定的共享用例）；收尾一跑与票面 12970 逐字一致。不影响任何结论。

## 3. 专项裁决

### 3.1 AC2 任务锁与租约按公司隔离 — ✅ PASS，证明力判定：充分

证明方式实为**「真实双连接锁持有实验」+「行状态机串行等价」的组合**，不是纯串行推演：

- **锁半边（真并发）**：AC2 用例 7 在一个打开的平台事务里真实持有 A 作用域 advisory 锁（`pg_advisory_xact_lock(hashtextextended(keyA))`），同一时刻经 operator 独立连接完成 B 公司的归属写入（`pinned` 断言通过）——这是两个真实连接的并发现场，不是时序侥幸；同事务内对照组（同键 A 作用域写入）真实阻塞至 `lock_timeout='2s'` 抛错，证明锁真实生效而非摆设。键派生 `scopeTaskLockKey`（JSON 含 tenant+workspace+principal）导出并被测试钉死，跨公司键结构性不相交。
- **租约半边（行状态机 + 作用域逐字比对）**：MT041 claim 是单行事务性状态迁移（`job_leases` 行），并发交错不可能产生部分状态；跨范围拒绝由 `JOB_LEASE_SCOPE_MISMATCH`（workspace 逐字比对，`job-ownership.ts:576`）判定，与并发时序无关。串行等价证明对该原语是充分的。7 用例覆盖：范围内认领、跨公司认领拒 + 持有人行零变化、同公司跨团队拒、A 持锁 B 立即得自己租约、释放后 B 仍不可认领 + renew/finish/release 全拒零写入、JOB_LEASE_HELD 与同持有人幂等、锁键互异 + 实测不阻塞。
- 残余风险披露：用例 7 的对照组以异常路径结束（ROLLBACK_MARKER），B pin 的持久化随事务回滚——验证语义完整、无资源泄漏；「真并发竞态调度下租约行不被双持」由 MT041 原子 INSERT ... ON CONFLICT 状态机承担（MT041 自有套件职责），本票消费面证明已足。

### 3.2 AC3 回填迁移 dry-run 预览 — ✅ PASS

- **preview 零写入**：用例在 preview 后对 4 个候选逐个断言 `scopeRowOf === undefined`；服务实现为纯 SELECT（平台主库通道），机器身份门卫在前。
- **与执行结果逐行一致**：oracle 用的是**注册迁移本体**——`buildPlan("MT060")` 取出 `legacy_task_backfill` 步语句，经 `runStatements` 在真实库执行；套件 beforeAll 另经真实 MT003 工具 generate→apply→replay 全链验证（replay 必须收敛为 up-to-date，否则 beforeAll 直接失败）。可回填集三元组（tenant/workspace/principal/user）、`attribution='backfill'`、歧义/无归属零行全部断言。
- **回放幂等**：重放语句后 `countScopeRows` 零新增；新增候选（solo3）走 preview→零行→执行→回填行一致闭环。
- **双团队/无成员零行**：ambiguous（a1a2 双团队）→ `ambiguous-membership`、orphan → `no-membership`，两团队上下文读取均不可见，隔离任务对一切 scope 不可见。
- 语义与 Spec §9.2「不按猜测分配」一致；执行权在 MT117、本票仅交付迁移+只读 preview 的边界披露属实。

### 3.3 AC4 后台触发遵守 MT042 作用域重建 — ✅ PASS（真实接线核实）

- **机器身份**：`assertTrustedMachineIdentity`（MT042 `scan-executor` 既有出口，只读消费）是 `previewLegacyBackfill`/`resolveForExecution`/`runUnderLease` 三入口第一道门；测试覆盖伪造对象、JSON 序列化往返、`dev-local-user` 字样三种拒法（MT042 同款）。
- **权威行语义**：`rebuildFacts` 经 operator 通道 + 事务本地 `app.scan_sweep='on'` 读 `openmuse_task_scopes`——扫描臂是 MT060 自有迁移第二步注册的（`openmuse_task_scope_operator_sweep_read`），无臂则跨公司零行；无协会行 → `OPENMUSE_TASK_RECORD_MISSING` 零回显（canary/taskId 双断言）。
- **真实签发入口**：fixture 的 `issueScheduleScope` 不是手搓 Scope——它把权威事实写入会话缝后调用**真实 `createScopeResolver`（entrypoint="schedule"）**，与生产签发半边同源；撤权后签发重验失败 → `OPENMUSE_TASK_SCOPE_REVOKED`。
- **hint 从不参与判定**：`resolveForExecution(machine, { taskId, hint })` 函数体内 hint 零读取（我以 MUT-R4 证明：一旦让 hint 覆盖，专设 canary 用例立即失败）；成功路径租约 finish/失败 release 的双完结语义、他人活租约 lease-held、孤儿任务重建先行拒绝均有用例钉死。
- 边界披露属实：路由/装配不接（MT016/MT022/MT059 同例），`runUnderLease` 供 sweep 调用方，队列面零改动（`work/queue.ts` 冻结 SAME）。

### 3.4 GREEN-1 存档 7 fail 修复的 diff 范围（四任披露核对）— ✅ 无夹带

- `red-green/GREEN-1-first.txt` 存档核实：23 pass / **7 fail**（AC3×3 + AC4×4，30 tests），与 MT060.md §0 披露一致；二任死于 GREEN 中途、mutation 未开始的叙述与目录证据吻合（mutation/ 文件齐备且均为三任时间线）。
- 三处修复定位核实：① 服务增 `platform` 通道、preview 改经它（`deps.platform` 注释与实现均在）；② fixture 会话缝改存 `{userId: facts.actorId,…}`（`support/openmuse-tasks.ts` 内注释与代码一致）；③ AC2 用例 4 末尾释放 b1 租约（断言全部先行，注释披露理由）。
- 新增 AC1 用例（同一人跨团队不可见）落位核实，其存在理由（MUT-1 恰好性）在 §4 MUT-R1 独立复验成立。
- 范围核对：三处修复 + 1 新用例全部位于本票自有新文件（服务/fixture/测试）；§1 的 prereq-manifest 268 项扫描证明**零**本票外文件被触碰——「无夹带」在哈希层面闭合。

## 4. 变异抽验（独立设计 4 处 ≥3：注入 → 聚焦捕获 → 字节复原 → 复绿）

| # | 注入点（文件:语义） | 捕获者（聚焦套件失败用例） | 结果 | RESTORE |
| --- | --- | --- | --- | --- |
| MUT-R1 | `openmuse-task-tenancy.ts` `authorizeTask` 拔掉三元组第二道防线（仅读门，gatedControl 不动） | AC1「同一人的跨团队上下文不可见：A1 pin 的任务从 A2 读取/取消零触达」 | **30 pass / 1 fail**，恰好且仅被该用例捕获 | `37f817e0…` 逐字节 ✓ → 31/0/168 复绿 |
| MUT-R2 | `job-ownership.ts:576` claim 的 workspace 逐字比对放宽为 tenant-only（冻结文件，临时受控改动） | AC2「同公司跨团队认领被拒（workspace 逐字比对）」 | **30 pass / 1 fail** | `45d1b500…`（=before-hashes）✓ → 31/0/168 复绿 |
| MUT-R3 | `previewLegacyBackfill` 歧义（count>1）分支改为按首行猜测入 attributable | AC3「preview 只读分类：唯一归属可回填；歧义与无归属进隔离清单」 | **30 pass / 1 fail** | `37f817e0…` ✓ → 31/0/168 复绿 |
| MUT-R4 | `resolveForExecution` 让 `input.hint` 覆盖权威协会行事实 | AC4「重建按权威协会行执行：伪造 hint 全部不采纳（canary 零出现）」 | **30 pass / 1 fail** | `37f817e0…` ✓ → 31/0/168 复绿 |

- 4 组变异每次失败面**恰好 = 1 用例**（无连带误伤），说明套件判定与实现语义一一对应、无搭车通过。
- 服务文件原始哈希 `37f817e0…` 与实现者 MUT-1/3/4 存档 RESTORE 哈希一致；`job-ownership.ts` `45d1b500…` = before-hashes 冻结值 = 实现者 MUT-2 RESTORE 哈希——**实现者自证的复原能力独立复验成立**。
- 变异全部收尾后：聚焦 31/0/168、全量 1155/0/44（§2#5）、typecheck 0，树回到被审基线。

## 5. 复审发现

- **R-1（Low，非阻塞）— biome「触及 8 文件 0 问题」在本树钉版口径下不可复现**：以仓库 pin 的 `@biomejs/biome@2.5.10` + 根 `biome.json` 复核 5 个触及文件，得 7 个诊断——`schema/openmuse-task-tenancy.ts` format ×1；`openmuse-task-tenancy.ts` organizeImports + format ×2；`openmuse-tasks.test.ts` organizeImports + format ×2；`support/openmuse-tasks.ts` organizeImports + format ×2（`job-ownership.ts` 干净）。全部为格式/导入排序（assist+format），**零 lint 规则违例、零行为影响、全部位于本票自有文件**。实现者存档 `verification/10、13` 显示 "Checked 8 files… No fixes applied" 无错误行，其调用口径（可能为 w15 树当时 biome 解析/配置状态）无法在本树重建。建议：下游接线票顺带 `biome check --write` 这 4 个自有文件（纯格式 churn）。
- **R-2（Cosmetic）— MT060.md §4 算术笔误**：「17 项 … 15 项逐字节 SAME；3 项 DIFF」实际为 17 = 3 DIFF + **14** SAME（15 疑将 RECTIFIED 的 entry-context 单列）。存档文件本身（before/after-hashes）自洽，仅报告散文口径不准；本复审以 17/17 实测复核为准。
- **Info — 全量套件 expect 计数存在 ±3 运行间波动**（本复审两次全量 12973/12970，pass/fail 恒 1155/0/44，后者与票面一致），提示全量套件中存在 expect 记账非确定的共享用例（非本票引入，可供套件卫生参考）。

## 6. 验收对照终判

| 票面验收 | 复审判 | 依据 |
| --- | --- | --- |
| 列表、详情、更新与取消只作用于当前范围；跨范围 ID 返回不可见语义 | ✅ 维持 PASS | §2#3 聚焦 31/0 亲跑 + §4 MUT-R1 证明第二道防线恰好被测 |
| 任务锁与租约按范围隔离：公司 A 的锁不阻塞也不被公司 B 复用 | ✅ 维持 PASS（证明力充分） | §3.1：真双连接锁持有实验 + 行状态机串行等价 + MUT-R2 |
| 只有 user_id 的旧根记录被补上公司与团队关联（迁移可 dry-run 预览） | ✅ 维持 PASS | §3.2：注册语句即 oracle、preview 零写入、幂等、隔离零行、attribution='backfill' + MUT-R3 |
| 后台触发遵守 MT042 的作用域重建规则 | ✅ 维持 PASS（真实接线） | §3.3：机器身份/扫描臂/真实签发入口三面接线核实 + MUT-R4 |

**复审结论：MT060 验收通过。四任披露的接管修复范围诚实、冻结面在 r15 树逐字节成立、变异自证可独立复现。唯一遗留 = R-1（biome 格式诊断，Low，建议下游票清理）。**
