# Issue #209 F1 修复报告 — `saveConversionRate` 并发重复版本号

执行者：dispatched worker（task_4172be01cac4 / dispatch ctx_53f700cd0beb）
对象：`docs/execution-ledgers/checkpoints/209/review.md` **F1 [Medium]**（仅此一项；F2/F3/F4 未触碰）
基础：未提交的 #209 基线实现（checkpoint.md 哈希清单），HEAD 未移动
状态：**未提交 / 未推送 / 未部署**（按调度约束）

## 1. 发现与根因（已核实）

`saveConversionRate` 原实现：事务内先普通 `SELECT`（无锁）读取 `rateVersion`，客户端
计算 `previousVersion + 1`，再以**常量版本号**执行 upsert。READ COMMITTED 下两个并发
保存都能在对方提交前完成读取、读到同一 vN、随后各自把常量 vN+1 写入（等待中的 upsert
在 EvalPlanQual 重检后仍然应用自己的常量 SET）→ 两次成功保存拿到同一版本号，违反
"admin saves start at 1 and strictly increment" 契约。Review F1 属实，非误报。

## 2. 修复设计

在 `saveConversionRate` 事务的**第一条语句**取事务级咨询锁：

```ts
await tx.execute(
  sql`select pg_advisory_xact_lock(hashtext(${CONVERSION_RATE_SAVE_LOCK_KEY}))`,
);
```

`CONVERSION_RATE_SAVE_LOCK_KEY = "openbot:gateway:conversion-rate-save"`（模块私有）。
锁随事务提交/回滚释放，读-算-写整体原子：并发保存排队而非并发派号，版本号唯一且严格
递增。与 `server/src/memory/defaults.ts` 的 check-then-write 咨询锁是同一仓库既有惯用法。

**备选方案与否决理由**：
- `SELECT … FOR UPDATE` 行锁：无法锁住"尚不存在的行"，两个并发首次保存仍会双双得到
  v1（经典 not-found 竞态），不采用。
- 单条 upsert 内服务端自增（`SET value = f(row.value)`）：可行但把 jsonb 存储形状复制
  进原生 SQL，维护成本高；本存储将被 #210 版本表整体替换，选择最小且惯用的改法。
- **无 schema / 迁移改动**（F1 修复不需要），`enterprise_settings` 值形状、公共签名、
  `pg_notify` 契约均不变。

## 3. 确定性并发测试（新增于既有集成测试文件）

`competing concurrent saves commit distinct, strictly increasing versions`：
第三方事务对目标行 `SELECT … FOR UPDATE` 并持锁 → 两个并发保存（"12.34"/admin-first
与 "0.5"/admin-second）各自完成读取后停靠在该行锁后（以 `pg_stat_activity` +
`pg_blocking_pids` + 专用 `application_name` 观测，与 agent-profile-store 测试同惯用法）
→ 释放持锁者 → 断言：两次保存都 `ok:true`、版本恰为 `{2,3}`、落库行 `rateVersion` 3
（= max）且分子/分母/`savedBy` 与拿到 v3 的那次一致。仅使用专用测试库
`127.0.0.1:5569/openbot_test`。

## 4. TDD 证据

- **RED**（修复前）：新测试确定性失败，收到 `[2, 2]`（期望 `[2, 3]`），其余 12 例全过 → 见 `red.md`。
- **GREEN**（修复后）：13 pass / 0 fail；修复后连续 6 次串行全绿 → 见 `green.md`。

## 5. 验证命令与结果（全部串行执行）

```bash
bun test server/tests/gateway-conversion-rate.test.ts
# → 45 pass / 0 fail

TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5569/openbot_test \
  bun test server/tests/gateway-conversion-rate.integration.test.ts
# → 13 pass / 0 fail（含新并发测试；连跑 6 次全绿；-t 单测连跑 3 次全绿）

bun run --filter server typecheck
# → server typecheck: Exited with code 0

bunx biome lint --error-on-warnings \
  server/src/gateway/conversion-rate-store.ts \
  server/tests/gateway-conversion-rate.integration.test.ts
# → Checked 2 files. No fixes applied.

bunx biome check --error-on-warnings --formatter-enabled=true <同两文件>
# → Checked 2 files. No fixes applied.（其间执行过一次 biome check --write 统一格式）
```

## 6. 检查点快照

- `git rev-parse HEAD` = `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（与基线一致，未提交任何东西）
- staged diff：**空**。unstaged diff：仅基线遗留的 `server/src/config.ts`（+31/-0，本次未触碰）。
- `git status --porcelain -uall`：`M server/src/config.ts` + 未跟踪的
  `server/src/gateway/{conversion-rate,conversion-rate-store}.ts`、
  `server/tests/gateway-conversion-rate{.test,.integration.test}.ts`、
  `docs/execution-ledgers/`（基线 3 份文档 + 本次 f1-repair 4 份文档）。

### 哈希清单（SHA-256；前 5 项对照基线 manifest）

```
eda84eb8d7613ab55ac3259bc6af42ff51a60f099b299a8f4d9b81150e9d00fc  server/src/gateway/conversion-rate-store.ts            (变更：本修复)
50165a1c5ec6952962214fd92e37e8e754c9c9d017f810fbaae552850eea8357  server/tests/gateway-conversion-rate.integration.test.ts (变更：新增并发测试)
d43dbb35470fc705aae1f3a51dbab21a14c1dd770beff066cf0fce6997d33034  server/src/gateway/conversion-rate.ts                   (与基线一致 ✓)
5b28118a01e63245ecbe61bdc2d12f77876972faa1ecda77dd15afbf252cc86b  server/src/config.ts                                    (与基线一致 ✓)
89813d5a4c0e7e39fa3ee0f7d20b5781a17f35285856fe66e0a8f94003af3b38  server/tests/gateway-conversion-rate.test.ts            (与基线一致 ✓)
f5c085719cdca08ca535535c4c25a365948aacccf1e891f908f010faa9d58be7  docs/execution-ledgers/checkpoints/209/report.md        (历史，未改)
ce2f3b043984d548cdb2b414d5a37a7cc2ac7e4c0e1a7a425cceb81af76ab63e  docs/execution-ledgers/checkpoints/209/review.md        (历史，未改)
44973300f57739b80f7d0ebaf215595f3c27a08b886b8d5799ca262e75b4687c  docs/execution-ledgers/checkpoints/209/checkpoint.md    (历史，未改)
667df3f3a7eeca72b8ce722773ff6e383fc37019c190feaacb56b0f6f5fed7e8  docs/execution-ledgers/checkpoints/209/f1-repair/plan.md  (新增)
eb73b0cc8bab75374ef61167d86427fc07979c14f97b961d6690c4a0226880c0  docs/execution-ledgers/checkpoints/209/f1-repair/red.md   (新增)
3a88e85844e0a3aaabc28527b7da6e5e31159187ec06122c1d984b6b421d21f9  docs/execution-ledgers/checkpoints/209/f1-repair/green.md (新增)
<本文件>                                                            docs/execution-ledgers/checkpoints/209/f1-repair/report.md (新增)
```

### 代码级变更摘要（两文件均未跟踪，无法出 git diff，故列明）

`server/src/gateway/conversion-rate-store.ts`（净增 ~14 行）：
1. 模块头注释新增一段：并发保存由事务级咨询锁串行化，版本号唯一且严格递增。
2. 新增私有常量 `CONVERSION_RATE_SAVE_LOCK_KEY`。
3. `saveConversionRate` 事务首句新增 `pg_advisory_xact_lock(hashtext(...))` + 三行 why 注释。
   其余（SELECT/版本计算/upsert/notify）逐字未动。

`server/tests/gateway-conversion-rate.integration.test.ts`（净增 ~140 行）：
1. import 增加 `sql`。
2. 新增 `deferred()` 与 `waitForBlockedSaves()`（pg_stat_activity + pg_blocking_pids 轮询）助手。
3. 新增并发测试（见第 3 节；10s 超时）。原有 12 例逐字未动。

## 7. 范围与边界

- 仅修 F1；F2（读取侧上限复检）、F3、F4 按任务简报未触碰，仍留给 #210/后续。
- 未启用任何网关路径；未改无关 ticket/共享配置；未改 schema/迁移（无必要，未升级协调者）。
- 历史 `report.md` / `review.md` / `checkpoint.md` 未改动（哈希见上）。
- 父 Ledger 更新交由协调者；本 worker 未提交任何 commit。

## 8. 注意事项（给接手者）

- 本测试文件（含基线 12 例）假设独占使用专用测试库：**并行运行两个 `bun test` 进程指向
  同一测试库会互相干扰**（另一进程的 beforeEach 删行/播种会破坏并发测试的停靠观测；
  实验证实连既有用例也会失败）。验证/CI 必须串行执行本文件。
- #210 实施不可变版本表时，本咨询锁可随单值存储一并移除；"两管理员并发保存不得产生重复
  版本号"已由本测试锁定语义，迁移时应保留等价测试。
