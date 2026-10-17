# Issue #209 最终 Review（F1 修复后最终检查点）— 2026-10-15

Reviewer：独立只读 Pi reviewer（task_1ca2dc7559a4 / dispatch ctx_a41a616b3d4a；与基线执行者 task_f45c9d92c8ea、F1 修复执行者 task_4172be01cac4、前次 reviewer task_d2e574ce83b6 均无关联）。未编辑任何实现/测试文件，未提交，未推送。

## 1. 快照身份与哈希核验

- Worktree：`/Users/wuyongjun/orca/workspaces/OpenBot/issue5-209`，分支 `1123786563/issue5-209`。
- `git rev-parse HEAD` = `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` = 声明 BASE（未移动）。
- `git diff --cached` 为空；`git status --porcelain -uall`：` M server/src/config.ts` + 未跟踪 `server/src/gateway/`（2 文件）、2 个测试文件、`docs/execution-ledgers/checkpoints/209/`（基线 3 份 + f1-repair 4 份 + 本文件）。stash 中两条记录为 `billing-audit-remediation` 分支既有历史，不属于本快照（与基线 review 记录一致）。
- **关键核验结论：相对前次 review 的基线 manifest（checkpoint.md），唯一发生变化的代码文件正是 `conversion-rate-store.ts` 与其集成测试 `gateway-conversion-rate.integration.test.ts`**；`conversion-rate.ts`、`config.ts`、单元测试三文件哈希与基线逐一相符（F1 修复"仅触碰两文件"的声明属实）。当前两变更文件哈希又与 `f1-repair/report.md` 的 manifest 逐一相符，即当前快照 = F1 修复完成态，此后无改动。

### 哈希清单（SHA-256，本 reviewer 实测）

```
d43dbb35470fc705aae1f3a51dbab21a14c1dd770beff066cf0fce6997d33034  server/src/gateway/conversion-rate.ts                   (与基线一致 ✓)
eda84eb8d7613ab55ac3259bc6af42ff51a60f099b299a8f4d9b81150e9d00fc  server/src/gateway/conversion-rate-store.ts            (F1 修复变更；= f1-repair manifest ✓)
5b28118a01e63245ecbe61bdc2d12f77876972faa1ecda77dd15afbf252cc86b  server/src/config.ts                                    (与基线一致 ✓)
89813d5a4c0e7e39fa3ee0f7d20b5781a17f35285856fe66e0a8f94003af3b38  server/tests/gateway-conversion-rate.test.ts            (与基线一致 ✓)
50165a1c5ec6952962214fd92e37e8e754c9c9d017f810fbaae552850eea8357  server/tests/gateway-conversion-rate.integration.test.ts (F1 修复变更；= f1-repair manifest ✓)
44973300f57739b80f7d0ebaf215595f3c27a08b886b8d5799ca262e75b4687c  checkpoints/209/checkpoint.md   (历史，未改 ✓)
f5c085719cdca08ca535535c4c25a365948aacccf1e891f908f010faa9d58be7  checkpoints/209/report.md       (历史，未改 ✓)
ce2f3b043984d548cdb2b414d5a37a7cc2ac7e4c0e1a7a425cceb81af76ab63e  checkpoints/209/review.md       (历史，未改 ✓)
667df3f3a7eeca72b8ce722773ff6e383fc37019c190feaacb56b0f6f5fed7e8  f1-repair/plan.md / red.md eb73b0cc… / green.md 3a88e858… / report.md b88df24d… (均 = f1-repair manifest ✓)
```

## 2. 实际执行的验证命令与结果（全部串行；专用测试库独占使用）

```bash
bun test server/tests/gateway-conversion-rate.test.ts
# → 45 pass / 0 fail（136 expect）

TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5569/openbot_test \
  bun test server/tests/gateway-conversion-rate.integration.test.ts
# → 13 pass / 0 fail（46 expect，含并发测试）
# → 串行重跑 2 次：13 pass / 0 fail ×2（合计 3/3 全绿，无 flake）

bun run --filter server typecheck
# → server typecheck: Exited with code 0

bunx biome lint --error-on-warnings \
  server/src/gateway/conversion-rate.ts server/src/gateway/conversion-rate-store.ts \
  server/src/config.ts \
  server/tests/gateway-conversion-rate.test.ts server/tests/gateway-conversion-rate.integration.test.ts
# → Checked 5 files. No fixes applied.

bunx biome check --error-on-warnings --formatter-enabled=true \
  server/src/gateway/conversion-rate-store.ts server/tests/gateway-conversion-rate.integration.test.ts
# → Checked 2 files. No fixes applied.

grep -rn "bifrostConversionRate|readConversionRate|billingReadiness|conversion-rate" server/src（排除 gateway/ 与 config.ts）
# → 无任何运行时消费点（无网关启用路径）
gh issue view 209 --repo 1123786563/OpenBot   # → 契约交叉核对（只读）
```

集成测试仅指向 `127.0.0.1:5569/openbot_test`（容器 `openbot-issue5-209-pg`，运行中已确认）；`tests/support/database.ts` 缺 `TEST_DATABASE_URL` 或库名为 `openbot` 时直接抛错，不可能回退开发库。遵守了"不得并行对同一库跑其他测试"的约束（串行执行，3 次之间无并发进程）。

## 3. F1 解决判定：**已修复（RESOLVED）**

针对前次 review F1 [Medium]（并发保存可产生重复 `rateVersion`），逐项独立评估：

1. **锁的作用域与取锁时机正确**。`pg_advisory_xact_lock(hashtext(CONVERSION_RATE_SAVE_LOCK_KEY))` 是事务内**第一条语句**（conversion-rate-store.ts L69-71），先于读取：整个 读→`previousVersion+1`→upsert 临界区被锁覆盖。锁为事务级，提交/回滚自动释放，无需显式解锁，连接异常死亡时由服务端回收——不存在锁泄漏路径。校验在事务外先行（L59-63），非法输入不取锁。与模块自述的仓库既有惯用法（`memory/defaults.ts` L59 同为 `pg_advisory_xact_lock(hashtext(key))`）一致。
2. **hashtext 碰撞含义已评估，无正确性风险**。`hashtext` → 32 位 int4 → 隐式提升为 bigint 锁标识，键空间 2^32；与仓库内其他 `hashtext`/`hashtextextended` 锁键理论上可碰撞，但咨询锁只是串行化原语：碰撞的最坏后果是无关模块间**多余等待**（spurious serialization），绝不破坏同键互斥——同键字符串在同一 PG 实例内 `hashtext` 结果确定，所有 `saveConversionRate` 必然映射到同一锁标识。见 N2（建议性）。
3. **跨进程串行化成立**。咨询锁由 PostgreSQL 服务端按会话强制，跨连接、跨 OS 进程有效；多副本部署（`pg_notify` 契约暗示的多进程共享一库）下所有保存仍互斥。测试用独立连接池（各自 `application_name`）演示了跨会话互斥，进程边界由服务端语义覆盖。
4. **错误/回滚行为正确**。upsert 或 `pg_notify` 抛错 → drizzle 事务回滚 → 锁随事务释放，版本号未落库，无半提交状态。锁序为 咨询锁→行锁（upsert），无其他路径反序取锁（该行仅本模块写；测试 holder 取行锁但不取咨询锁），无死锁环。
5. **测试确定性与专用库安全达标**。测试设计让持锁第三方事务先以 `SELECT … FOR UPDATE` 停靠目标行，两个并发保存必然先完成读取再停靠（修复前双双停靠行锁 → 确定性 RED `[2,2]`；修复后一停靠行锁、一停靠咨询锁，释放后串行提交 `{2,3}`）。`waitForBlockedSaves` 以 `pg_stat_activity`+`pg_blocking_pids` 观测"两个会话均阻塞"，且带"提前 settle 即抛错"哨兵，杜绝空转通过；断言钉死可观察契约（双双 ok、版本恰为 [2,3]、落库为 v3 且分子/分母/savedBy 与 v3 获得者一致）；finally 释放并关闭两个临时库句柄；10s 用例超时 + 5s 轮询上限合理。READ COMMITTED 下每条语句取新快照，等锁的第二个保存在第一个提交后重读 v2 → 写 v3，语义正确。串行-only 约束已写入 f1-repair/report.md §8（对同一库并行跑两个 bun test 进程会互扰，本 review 遵守）。
6. **前次 review 的 RED 证据内部自洽**：`[2,2]` 失败形态与未修复代码的结构性竞态完全吻合（常量版本 SET 在 EvalPlanQual 重检后照常应用），非测试布线错误；GREEN 后 3 次串行全绿（本 review 独立复现）。

**结论：F1 [Medium] 真实修复，非表面修补。**"admin saves start at 1 and strictly increment"（conversion-rate.ts L20-21 契约）在并发下成立，并为 #210（不可变版本表 + "两管理员并发保存不得产生重复版本号"）锁定了可迁移的测试语义。

## 4. Spec 合规性：**PASS**

| #209 验收标准 | 结论 | 证据 |
| --- | --- | --- |
| 1. 未配置比例时付费能力不可启用且状态可解释 | PASS | 代码与前次 PASS 基线逐字节一致（哈希核验）；本 review 再次全仓 grep 确认 `bifrostConversionRate`/`readConversionRate`/`billingReadiness` 在 `gateway/`+`config.ts` 之外零消费点——无任何启用路径、无绕过。实际门禁组装属 #213（DAG 后续），符合逐切片功能准入。 |
| 2. 零/负/超精度/非法格式拒绝并返回具体原因 | PASS | 解析器未变；45 例单元测试全绿（17 条非法输入逐条断言 reason）。 |
| 3. 合法比例保存后读取为精确值，无浮点误差 | PASS | bigint 有理数 + jsonb 十进制字符串未变；集成测试含极值往返与"重启"读取，13 例全绿。 |
| 4. 启动与管理员写入两路径结论一致 | PASS | 两路径仍共用唯一纯函数 `parseConversionRateInput`；双路径一致性测试全绿。 |

- **AC12 首分句 / Q14 / Q19**：无隐含默认在三处（解析器/启动/读取）继续成立；`rateVersion` 契约经 F1 修复后在并发下严格递增，强化了 01.4 请求锁定与 06.5 结算回读的支撑（ADR-0003"请求锁定兑换比例"）。
- **ADR-0002 / 0004**：本切片无付款账户/准入运行路径，无违反面；N/A 维持。
- **CONTEXT.md**："Credit Conversion Rate 同一部署统一比例"——单键单值存储未变，无按用户/Bot 比例。
- **范围核验**：无网关启用、无迁移、无管理员路由挂载、无 `.env.example` 改动（均为基线已记录的协调者批准偏差，本次未扩大）；F1 修复自身零 schema 变更、公共签名/值形状/`pg_notify` 契约不变。

## 5. 代码质量：**APPROVE**

### 仍有效的遗留发现（均非阻塞，F1 修复按简报未触碰）

- **F2 [Low]（沿用）** 读取侧不复检本模块自身的精度上限/幂十分母不变量（conversion-rate-store.ts `readStoredConversionRate`）：被直接篡改但为正的超限行会读为 `configured:true`。与文档化"unreadable/non-positive → invalid"策略一致故非违约；建议 #210 版本表写入端保证 + 读取断言。
- **F3 [Nit]（沿用）** 拒绝原因优先级未文档化（小数位先于整数位）；前导零按文本位数判超限（`"0000000001"` → `out_of_range`）。保守拒绝，不违反 AC。
- **F4 [Nit]（沿用）** `savedBy/savedAt` 以显式 `undefined` 属性展开。无行为影响。

### 本次新发现（均为 Nit）

- **N1 [Nit]** `waitForBlockedSaves` 的文档注释称"两个竞争保存都已完成读取并停靠在**行锁**后"——该描述只对修复前形态成立；修复后第二个保存停靠在咨询锁后且尚未读取。等待条件本身（≥2 个阻塞会话）对两种形态都精确正确，仅注释滞后，建议随 #210 迁移测试时订正。
- **N2 [Nit]** 锁键用 `hashtext`（32 位空间）而非更新模块普遍采用的 `hashtextextended(key, 0)`（64 位）。同键互斥不受影响，跨模块碰撞仅致多余等待；与被引用的 `memory/defaults.ts` 惯用法一致属可辩护选择。#210 以版本表替换本存储时可一并消解。

无 Critical / High / Medium 级发现。

## 6. 限制

- 全量套件回归未独立重跑（8058 例 / 95 预存失败的 pristine-main 对照沿用 checkpoint.md 结论）；由于 5 个代码文件中 3 个与基线逐字节一致、另 2 个已由本 review 全量重测（45+13×3 全绿），回归风险已被实质覆盖。
- 两份变更文件的"基线版本"不在 VCS（未跟踪），"仅此两文件变更"系经 checkpoint.md ↔ f1-repair/report.md ↔ 当前实测的三级哈希链核验，而非 git diff 直证。
- RED 证据（`[2,2]`）为历史记录（red.md），本 review 未回滚代码复现（需改动工作区，违反只读约束）；其与结构性竞态的吻合度经分析确认。
- hashtext 碰撞行为未做实证测试（纯分析；后果上限为无关等待）。
- 串行化保证以"所有写入方均为修复后代码"为前提；因修复前存储从未提交/部署，不存在混合版本窗口，该前提天然成立。

## 7. 结论

- **Spec compliance：PASS**（4/4 AC 达成；F1 修复未引入范围扩张，未触碰任何已批准偏差之外的区域；与 AC12/Q14/Q19、ADR-0002/0003/0004、CONTEXT.md 无冲突）。
- **Code quality：APPROVE**（F1 [Medium] 判定 **RESOLVED**：事务级咨询锁作用域/时机正确、跨进程互斥成立、错误回滚干净、确定性并发测试三连绿；遗留 F2 [Low] 与 F3/F4/N1/N2 [Nit] 均为 #210/后续的可移交加固项，不阻塞本检查点）。
- Reviewer 独立于执行者与前次 reviewer；未编辑实现/测试，未提交。#210 开工时应消化 F2，并在以不可变版本表替换单值存储时迁移"并发保存唯一递增版本"测试语义。

— 记录于 2026-10-15 13:22 CST（2026-10-15T05:22:54Z）
