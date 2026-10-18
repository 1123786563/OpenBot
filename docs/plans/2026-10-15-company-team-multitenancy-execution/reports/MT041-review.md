# MT041 独立复审报告（Issue #84 — 任务/运行/触发/租约固定原始归属与配置版本）

复审者：独立 Pi 会话（MT041-review-brief.md 下发）。复审对象：本树（111 项前置 + 本票 7 交付）
与 `checkpoints/MT041/` 全部证据。只读复审；未修复、未提交、未推送。唯一新建 = 本报告。

## 0. 总裁决

**验收通过（四条 AC 独立复跑全绿），报告可信度有两处实质瑕疵，另有两处与仓库自身惯例的偏差 —— 合并裁决为「有保留通过（PASS with findings）」。**

- 独立复跑：聚焦 22/0/0、全量 **704/0/0 / 27 文件**（= 682 + 22，逐字命中 brief 预期）、
  typecheck 0、biome 触及 7 文件 0 error 0 warning、13 任务链在专用容器真实 apply 且 journal 13 行。
- 但：①报告声称「变异 18/18 KILLED」与证据矛盾（实为 17/18 + 1 个未披露存活变异，见 F1）；
  ②AC1 的「结构不可变」证明用例是空转测试（断言键格式错配，恒真，见 F2）——属性本身为真
  （复审在活库以超户核证），但钉死该属性的测试无效。
- F3（三表缺 FORCE RLS）与 F4（job_leases 表级 UPDATE 授权宽于先例）为低危加固项。

## 1. 重点裁决 A–F

### A. 四条验收逐条 —— 全部成立

| # | 裁决 | 复审依据 |
|---|---|---|
| ① 创建归属持久化、后续选择标识不改变 | **成立** | `job_ownership` (kind,object_id) 主键 + 双复合 FK（workspace∈company、principal∈company）；create-once：`onConflictDoNothing` 零写入，已存行读回后不同选择标识一律 `JOB_OWNERSHIP_MISMATCH`；4 个测试钉死（含跨团队/跨公司/幂等重放携带不同 basis 无法改写 creation 快照） |
| ② 租约仅同归属执行者可持有、跨范围拒 | **成立** | 认领三比：RLS 租户臂（跨公司 pin 结构性不可见）→ workspace 与 pin 逐字相等（跨团队拒）→ 活租约 `JOB_LEASE_HELD`；本人活租约幂等 held；过期/释放重认领 attempts+1（DB 时钟 `now()+make_interval`）；renew/finish/release WHERE 带持有人匹配。7 个测试全绿。**保留**：release 的持有人匹配行为在代码中存在但无测试钉死（见 F1） |
| ③ 配置版本可追溯执行依据 | **成立** | `job_config_snapshots` append-only（creation partial UNIQUE 每 job 一行 + execution 追加；两级 revision + canonical JSON SHA-256 内容绑定 digest）；测试用**真实 MT014** `createRuntimeConfigService.resolve` 产出依据、真实 revision 前进（operator 通道行级 upsert），历史 [creation rev1, execution rev2] 断言成立 |
| ④ 列表/详情只返有权范围 | **成立** | 成员视图：受信 Scope（WeakSet）→ data 角色 + 事务本地上下文 + 真实 RLS → 事务内成员重验（SCOPE_REVOKED，epoch/status 双查）→ workspace+principal 双过滤；管理视图：真实 MT006 authorizer，伪造上下文 `UNVERIFIED_ADMIN_CONTEXT`；跨团队/跨公司/不存在 + 管理视图跨公司 → 错误消息集合大小=1（逐字节断言）；B 公司空列表零泄漏 |

### B. 三表 RLS 与数据反证 —— 成立（策略矩阵活库核证）

- 复审独立容器（mt041-review-pg @55520）13 任务 apply 后抽查：
  - `pg_policies`：job_ownership 3 策略 / job_config_snapshots 3（经 join 归属行取租户）/ job_leases 4（多 UPDATE），roles 均为 ob_ent_data/ob_ent_operator，与迁移语句逐字一致。
  - 超户 `has_table_privilege` 全矩阵：**job_ownership / job_config_snapshots 对全部角色零 UPDATE/DELETE**，PUBLIC/identity_operator/directory 全零；job_leases 仅 operator 有 UPDATE、无人有 DELETE。**AC1「任何角色零 UPDATE/DELETE」属性为真**。
  - data 角色跨公司反证：测试用例（company-B data 角色数不出 company-A 的 pins/snapshots/leases，三表各 0）在我方复跑中真实通过；快照表策略经 join `job_ownership` 取租户，无独立 tenant 列可漏。
- **保留见 F3**：三表 `relforcerowsecurity = f`（ENABLE 未 FORCE），与全部既有新表（7 张全 =t）不一致。

### C. 迁移与 journal —— 成立

- JOB_OWNERSHIP_TASK 两步（tables 6 语句 + rls 23 语句）逐条 expand-only：全部为 CREATE TABLE/INDEX/CHECK/FK/POLICY/GRANT/REVOKE，对象仅三张新表；零既有表改动（changes.diff 与 git 状态交叉证实：本票仅 4 新文件 + 3 授权窄触点）。
- GRANT 清单：ownership/snapshots 仅 SELECT+INSERT（operator）、SELECT（data）；job_leases 另授 operator UPDATE——**授权依据成立但宽于先例**（表级 vs 列级，见 F4）。
- 十三任务链在复审库 MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041 全部 apply，journal 13 行（实现树 12 任务 + 本树新增 MT016，口径吻合）；MT041 planDigest `069bd540…` 与 checkpoint manifest 逐字一致。

### D. 三方合并语义等价 —— 成立（最强证据：产物逐字节一致）

- 复审用本树共享文件独立 generate：`0001/0002/manifest.json` 与实现树 checkpoint 三文件 **`diff` 逐字节 IDENTICAL**，statementDigest（5e925dad…/5f6280b2…）一致——三方合并未改变本票增量语义，这是比 diff 审阅更强的等价证明。
- 定位与排序位：JOB_OWNERSHIP_TASK 块在 BOT_OWNERSHIP_TASK 之后、注册行紧随 BOT_OWNERSHIP 行；migration-tool.test.ts 穷举断言 "MT041" 位于 MT026/MT069 之间（字母序）；schema barrel `job-ownership` 位于 identity/learning 之间（字母序）。三处与 verification/09–11 存档 diff 语义一致（行号因 batch-1 合并自然漂移，无语义变化）。
- 本树共享文件哈希（bb0e7b2b/3a64c1fa/62cea701）≠ checkpoint 哈希（5422e902/27f9b8b5/f81d5b64）符合披露口径（batch-1 基线三方合并），非异常。
- 「GRANT UPDATE 类窄例外」裁决：三处窄触点均有 brief 预授权与 ruling #5 先例注释（第 8 次）；`GRANT UPDATE ON TABLE job_leases` 属本票自有新表 DDL，不属共享文件窄例外，无需外部授权，但最小性见 F4。

### E. TDD 链与披露 —— 链真实；变异计数声明不实（F1）

- RED-1（模块缺失，Cannot find module，0 pass/1 fail）→ RED-2（迁移未 apply 自然实验，22 用例全 `relation "job_ownership" does not exist`）→ GREEN（22/0）——证据链完整可信。
- D1（23 vs 25 文件口径）：披露属实，verification/01 实测 638/25，pass 数逐字一致。✓
- D2（受约束关联）：Spec §4.2 逐字授权（「固定记录**或受约束关联**公司、团队、发起主体及业务对象，关联不得跨公司或跨团队漂移」，docs/specs/2026-10-14-company-team-multitenancy-design.md:70）。✓
- D3–D6：均为范围/边界披露，与本票交付一致，无隐藏缺口。D8（迁移语法返工 + 两处 TDD 抓到的真实缺陷）与 red-green.md 记录吻合。
- **D7 不完整**：披露了 MUT2/MUT5 两个无效/等价变异的处置，但未披露 MUT18 存活（见 F1）。
- **F1（实质）**：报告称「18/18 KILLED（16 直接 + 2 重跑）」。证据核算：results.txt 直接杀伤 **15** 个（MUT1,3,4,6,7,8,9,10,11,12,13,14,15,16,17），存活 3 个（MUT2、MUT5、MUT18）；results-retest.txt 仅补杀 MUT2b/MUT5b。**合计 17/18，MUT18（release 持有人匹配移除）22 pass/0 fail 存活且无重跑、无披露**。直接杀伤数「16」亦与证据（15）不符。MUT18 非等价变异：它暴露真实测试缺口——**无「非持有人 release 被拒（JOB_LEASE_NOT_HELD）」用例**（ac2-renew 只测 renew/finish 错持有人；ac2-finish 的 release 是正确持有人）。服务代码确有该 WHERE 守卫（复审读码证实），行为无缺陷，但「每安全语义 ≥1 且全部捕获」门槛按证据未达标，且报告计数失实。

### F. 双口径账目 —— 成立

- 实现树 660 = 638 + 22 / 26 文件（25 + 1）；本树 **704 = 682 + 22 / 27 文件**（26 + 1）——复审独立复跑逐字命中（704 pass/0 fail/27 文件）。
- 4 新整复制文件哈希与 sha256-manifest 逐字一致（ca6450f0/45d1b500/77a66a18/ef3eab9a）；3 共享文件三方合并等价性见 D。

## 2. 发现清单（按严重度）

| # | 严重度 | 发现 | 影响 | 建议（后续票，本复审不执行） |
|---|---|---|---|---|
| F1 | **Medium** | 变异计数声明不实：「18/18 KILLED（16 直接 + 2 重跑）」vs 证据 15 直接 + 2 重跑 = **17/18**；MUT18（release 持有人匹配移除）存活、无重跑、D7 未披露。暴露测试缺口：无「非持有人 release 被拒」用例（AC2 的 release 侧持有人校验未被钉死） | 报告可信度受损；release 持有人校验处于「已实现但零测试钉死」状态（回归可静默丢失） | 补 1 个错误持有人 release → `JOB_LEASE_NOT_HELD` 用例；对交付字节重跑 MUT18b 证实杀伤；报告勘误 |
| F2 | **Medium** | AC1 证明用例「structurally forbids rewriting a pin」空转：断言键拼装 `${table_name}:${privilege_type}`，查询键却是 `${role}:UPDATE:${table}` 格式——`Map.has()` 恒 false，UPDATE/DELETE 缺席断言**永不失败**；且 `information_schema.table_privileges` 在受限角色下只见自身+PUBLIC 授权，即便修正键格式也证不了「任何角色」。用例内 PUBLIC 零授权子断言（role_table_grants count）有效 | 属性为真（复审超户矩阵核证），但指定证明测试是假阳性；AC1 的「结构不可变」实际靠迁移语句审计而非测试保证 | 以超户/SET ROLE 逐角色 `has_table_privilege` 重写该用例（含 job_ownership/snapshots 的 UPDATE/DELETE 全角色缺席断言） |
| F3 | Low | 三表仅 `ENABLE ROW LEVEL SECURITY`，无 `FORCE`（relforcerowsecurity=f）；既有 7 张多租户新表全 ENABLE+FORCE，MT012 更把「核心表必须 FORCE」固化为可重放清单；迁移 impact 文本自称「按既有模式」 | 受限角色非属主不受影响；残余风险仅在表属主连接可绕过 RLS | 后续 expand-only 任务补 `ALTER TABLE … FORCE ROW LEVEL SECURITY`（三表）并入 RLS 再断言清单 |
| F4 | Low | `GRANT UPDATE ON TABLE "job_leases"` 为表级（含 tenant_id/workspace_id/kind/object_id 等 12 列全列）；先例为列级最小授权（MT004 status/epoch、MT014 document/revision/updated_at、MT076 role 列）。叠加 UPDATE 策略仅租户臂，operator 通道缺陷可在**同租户内**改写超出租约语义的列（如 workspace_id、经 PK 搬移 kind/object_id） | 不破坏跨公司隔离（WITH CHECK 钉 tenant）；违反仓库自身「最小 GRANT」纪律与 impact 文本自称的「配套最小 GRANT」 | 收窄为列级：`(claimed_by_kind, claimed_by, lease_until, attempts, finished_at, last_error, updated_at)` |
| F5 | Info | 变异与 GREEN 证据跑在 biome 前字节（服务 6da53459），交付字节为 biome 后（45d1b500）；GREEN-focused.txt 记 137 expect()，交付测试文件为 140（MUT2b 补强 +3 后）。最终门槛（03/06 全量 660/0、补强后变异）均跑在交付字节上，行为等价有覆盖，但变异证据未对最终字节复跑 | 证据链时间线小裂缝，无行为影响 | 变异复跑纳入 biome 之后的收尾步骤（流程建议） |

## 3. 独立复跑记录（全部在复审专用环境，用后即清）

1. `bun install --frozen-lockfile`：1415 packages ✓
2. 55520 端口预检空闲；`mt041-review-pg`（pgvector/pgvector:pg16）@127.0.0.1:55520；六变量 env 文件 0600（TEST_DATABASE_URL + ENTERPRISE_TEST_SETUP/DIRECTORY/DATA/OPERATOR + MT003_ASSIGNED_TEST_DATABASE_URL），复审结束后容器已删、env 文件已删、临时 generate 目录已删 ✓
3. base migrate（enterprise-test-db.ts migrate，含三受限角色 login 供给）+ 十三任务链 generate+apply 全成功；journal 13 任务 26 步 ✓
4. 聚焦 `job-ownership.test.ts`：**22 pass / 0 fail / 0 skip**（无 skip，满足「skipped 不算通过」）✓
5. 全量 `tests/multitenancy/`：**704 pass / 0 fail / 27 文件** = 682 + 22 ✓
6. `bunx tsc --noEmit` = 0 ✓；`bunx biome check` 触及 7 文件 = 0 error 0 warning ✓
7. 活库抽查：pg_policies 10 条 / relrowsecurity=t、relforcerowsecurity=f（F3）/ 超户 has_table_privilege 全矩阵（F2 的属性核证 + F4 的授权宽度核证）/ 以 operator 角色 SET ROLE 复现 F2 的 information_schema 可见性 ✓

## 4. 结论

MT041 四条验收在独立环境下全部复现成立；expand-only、三方合并等价、账目口径（704=682+22/27）逐字核实；无 skip。**验收通过**。但报告存在一处计数失实与一处未披露存活变异（F1），AC1 的一个证明用例空转（F2），以及 FORCE RLS 与列级 GRANT 两处与仓库自身惯例的偏差（F3/F4）——建议 coordinator 将 F1/F2 计入报告勘误与后续小票，F3/F4 列入加固清单。本复审未做任何修复，未提交、未推送。
