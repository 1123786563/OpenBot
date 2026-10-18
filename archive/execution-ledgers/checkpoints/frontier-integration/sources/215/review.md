# 215 · Bifrost 02.1 PayerRef 账户模型与映射唯一性 — 独立评审

- Ticket: https://github.com/1123786563/OpenBot/issues/215（AC01/AC13 账户层基础）
- Reviewer: dispatched independent read-only Pi reviewer（task_f5d3ceba8e03；实现者为另一 session task_3124e76595a3，本 reviewer 未参与实现 —— 满足“不得自审”约束）
- 快照: worktree `issue5-215` @ BASE `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`，HEAD === BASE，全部变更未提交（3 个修改 + 6 个新增代码文件 + 4 个 ledger 文档，均未跟踪，与 `git status`/`git ls-files --others` 一致，无未申报文件）
- 评审时间: 2026-10-15T04:58:58Z（证据采集于 04:41–04:58Z）

## 裁决

| 维度 | 裁决 |
| --- | --- |
| **Spec compliance（规格符合）** | **PASS** |
| **Code quality（代码质量）** | **APPROVE**（附 F1–F7 findings，无阻断项） |

## 快照 SHA 清单确认

report.md 声明的 9 个文件哈希逐一重算，**9/9 完全一致**：

```
774c3591…499f  server/src/billing/payer-ref.ts                     ✓
315e33e5…0b60  server/src/billing/payer-account.ts                 ✓
400b037a…db4a  server/src/db/schema/payer.ts                       ✓
b3913af4…4ad   server/drizzle/0122_payer_accounts.sql              ✓
461beb3a…782d  server/tests/payer-ref.test.ts                      ✓
3775308f…f54   server/tests/payer-account.integration.test.ts      ✓
642981b1…8e15  server/src/db/schema/index.ts（修改）               ✓
623fe383…f38   server/drizzle.config.ts（修改）                    ✓
5229afd6…0f0f  server/drizzle/meta/_journal.json（修改）           ✓
```

ledger 四件（plan/red/green/report.md）在 `docs/execution-ledgers/checkpoints/215/` 未跟踪存在，内容与工作区一致。评审期间未做任何写操作（本文件除外，属任务要求的交付物）。

## 实际执行的命令与结果

| 命令 | 结果 |
| --- | --- |
| `shasum -a 256` ×9 文件 | 与 report 清单 9/9 一致 |
| `bun test server/tests/payer-ref.test.ts` | 9 pass / 0 fail（24 expect） |
| `TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5561/openbot_test bun test server/tests/payer-account.integration.test.ts` ×3 | 每轮 9 pass / 0 fail（含 6 连接并发用例） |
| 两文件合并运行 ×1 | 18 pass / 0 fail / 56 expect —— 与 green.md 的 18/18 一致（未完整复跑其 8× 声明，见 Limitations） |
| `bun run --filter server typecheck` | exit 0 |
| `bunx biome lint --error-on-warnings` ×7 变更文件 / `biome format` ×5 | clean / clean |
| 测试库状态核查（`docker exec openbot-215-pg psql -d openbot_test`，只读 SELECT） | `payer_accounts` 存在；`__drizzle_migrations` 末行 hash === 0122 SQL 的 SHA-256、when === journal 1792039063976；FK CASCADE + kind CHECK 四值闭合 + 两个 unique index 齐备；`payer_accounts` 0 行、无 p215 残留（teardown 有效的独立佐证） |
| snapshot 链只读核查（python 解析 meta/*.json） | 0054/0055 prevId 同指向 0053（分叉）；0086/0096 id 与 prevId 完全相同（重复）；journal 123 条无重复、末条 0122 —— 实现者声明的仓库级 `drizzle-kit generate` 预存故障属实且 BASE 即存在 |
| 相邻回归：`bun test ./server/tests/billing-credits-writer.integration.test.ts` ×多轮 | 15–16 pass；**发现预存 flake（F3）**，与本 Ticket 无关（该文件未在本 diff 中） |

## 验收标准核验（对照 Issue #215）

| AC | 独立核验 | 结论 |
| --- | --- | --- |
| 同一主体并发创建只留一个有效映射 | 6×max:1 独立连接池 Promise.all 并发；断言恰一 `created:true`、单一 account id、库内恰一行；本 reviewer 重跑 3 轮全绿；DB 层 `(kind,owner_id)` unique index 为原子权威 | ✓ |
| 一个 externalCustomerId 不能属于两个账户，违反时写入失败 | 双向均有测试：异主体撞键 → `payer_accounts_external_customer_unique_idx` 原始违反透传（service 路径 + 直接 INSERT 路径各一）；同主体换键 → `payer_accounts_owner_unique_idx` 违反 | ✓ |
| 不同账户 Grant/台账互不可见、读取不跨账户聚合 | A grant+reserve+settle 后经 `writer.availableBalance`/`credits.grants`/`credits.consumption` 现有公开读取面断言 B 全零；无新增聚合面 | ✓ |
| 不产生余额复制/分摊/迁移 | 新账户 availableBalance=0、credit_grants/credit_ledger 0 行；legacy_deployment 推导 === `deploymentExternalCustomerId(id)`（原键不动，零迁移）；diff 未触碰 credits-writer/计费算法 | ✓ |

Produces 契约四项（PayerRef 四 kind、PayerAccount 双向唯一存储、payerKey 解析、createPayerAccount 幂等）逐项与实现一致；Write scope 未越界（仅 payer* 模块、schema/迁移注册、测试、checkpoint 文档）。

## 重点关注项分析

- **Payer 身份不漂移（non-drift）**：key 推导把 kind 编码进前缀（`payer-personal-` / `payer-company-` / 委托 `openbot-deployment-`），固定前缀 + 追加 id 在各 kind 内外均单射（prefix 不同即无跨 kind 碰撞，已推演；单测对同 id 三 kind 抽样验证）；真正的权威是 DB 双唯一索引而非推导串。`createPayerAccount` “既有行永远胜过推导值”，显式绑定不被 provisioning 改写（代码路径 + 测试均覆盖）。✓
- **unknown_owner fail-closed**：三处独立收口——推导层抛 `PayerOwnerUnknownError`（payer-ref.ts switch 默认分支）、provisioning 经推导即拒（测试 `-unk2` 验证）、`payerKey` 在 lookup 之前先按 kind 拒绝（“有行也拒”，测试插入 unknown_owner 行后仍拒）。审计可读、消费不可用，与 02.2 交接语义一致。✓
- **外部客户唯一性**：`external_customer_id` unique index + 服务层不吞异主体撞键（re-read 未中 → 原样重抛原始 violation，测试断言具体索引名）。✓
- **并发/原子性**：ON CONFLICT 指定 `(kind,owner_id)` + 跨索引竞态捕获回读。该修复针对的真实 Postgres 行为（speculative insertion 下另一 arbiter 先报 unique violation）与 8× 稳定声明、本人 4× 复跑（1×合并 + 3×单文件）一致。回读按 `(kind,owner_id)` 提交态读：命中即同主体收敛，未命中即真撞键重抛——语义正确。✓
- **幂等**：重复 create → `created:false`、同 id/同 key，库内一行。✓
- **无余额迁移**：见 AC4。✓
- **SQL/journal 正确性**：0122 SQL 与 schema.ts 逐项对应（PK、kind CHECK 四值、两 unique index、FK→billing_customers.external_id onDelete cascade；external_id 为 PK，FK 合法）；journal idx 122 `version:"7"` 与 0120/0121 同版式；runtime migrator（scripts/migrate.ts + migration-runner）只读 journal+SQL，已在专用库验证落库。✓（缺 snapshot 见 F1）
- **schema 集成**：drizzle.config.ts 头部注释明确要求“加 schema 文件同一变更内登记”——已登记；schema/index.ts 导出按字母序插入正确。✓

## Findings

### F1 · Medium（预存集成债，非本 Ticket 引入，需跟进工单）
**缺失 `0122_snapshot.json`；仓库级 snapshot 链已断（0054↔0055 分叉、0086↔0096 重复，BASE 即如此，已只读核实）**
- 文件/位置：`server/drizzle/meta/`（无 `0122_snapshot.json`）；`server/drizzle/meta/_journal.json:858-864`
- 证据：meta 目录 122 个 snapshot（0000–0121）；0054 与 0055 的 prevId 同为 0053.id；0086 与 0096 的 id 与 prevId 完全相同
- 影响：runtime 迁移不受影响（已验证）；但在链条修复工单完成前，任何 `drizzle-kit generate` 既跑不通、修好后也不知道 `payer_accounts` 存在，可能生成 drop/re-create。实现者已如实上报并建议另立工单（report.md 关键发现 2）——成立，但**不得遗忘**：修复链条时必须连带补 0122 快照或以 generate 重放核验。
- 处置建议：合并前在 #216+ 计划中显式登记该依赖；不阻断本 Ticket（Write scope 禁止其修链条）。

### F2 · Low
**`isPayerAccountCollision` 以英文错误消息子串匹配，而非 SQLSTATE 23505 + constraint 名**
- 文件/位置：`server/src/billing/payer-account.ts:184-196`（`"duplicate key value violates unique constraint"` + `'"payer_accounts_'`）
- 证据：postgres.js/drizzle 当前版本沿 cause 链保留原始消息（生产代码与测试的 `failureSentence` 同样走 cause 链，自洽）；但驱动升级或错误包装变化会静默破坏该判定，退化为“回读未中 → 重抛”路径仍正确、但失去同主体收敛
- 建议：改判 `error.code === "23505"` 且 `error.constraint` 以 `payer_accounts_` 开头（postgres.js 暴露该字段）。可并入 02.2 或顺手修复，不阻断。

### F3 · Low（预存，与本 Ticket 无关，影响回归声明复现性）
**`billing-credits-writer.integration.test.ts` "a hold spans grants earliest-expiry first…" 存在偶发失败：`ORDER BY amount DESC` 在两笔等额(300/300) grant 上平局顺序不定**
- 文件/位置：`server/tests/billing-credits-writer.integration.test.ts:211-214`
- 证据：本人复现 ~1 fail / 5 runs（cg-1930… 与 cg-13a4… 行序互换）；该文件不在本 diff 中
- 影响：checkpoint report “相邻 90 pass” 的复现依赖运气；不影响 #215 结论（ payer 套件全绿、该 flake 与 payer 变更无因果）
- 建议：测试补 tiebreak（`ORDER BY amount DESC, grant_id`），另开小修。

### F4 · Info
**`createPayerAccount` 两条写入（客户地板 + 账户插入）不在同一事务**
- 位置：`server/src/billing/payer-account.ts:92-104`
- 中途崩溃至多留下孤儿 `billing_customers` 行（幂等、无 FK 悬挂、无余额），重试自愈。可接受，无需改。

### F5 · Info
**集成测试文件持有 7 个连接（共享池 + 6×max:1 racer），`afterAll` 中统一关闭**
- 位置：`server/tests/payer-account.integration.test.ts:66-71, 88-96`
- 与 `tests/support/database.ts` 的连接预算注释（默认每文件 2）张力可控（racer 是文件内声明性需求且已关闭），套件继续膨胀时注意 100 连接上限。

### F6 · Info
**CONTEXT.md 尚无 PayerRef/付款账户词条**
- 本 Ticket Write scope 不含 docs/，契约已沉淀在 checkpoint ledger 与模块 docstring；建议随 02.2（首个真实消费者）或专门 docs 切片把 PayerRef、payer_accounts、unknown_owner 隔离语义补进领域词汇表，避免下游各自造词。

### F7 · Integration note（协调者已声明）
**与并行 #234 的共享文件碰撞：`drizzle.config.ts`、`src/db/schema/index.ts`、`meta/_journal.json`**
- 若 #234 也追加迁移，journal `idx 122` 极可能撞号，集成时须重编号并核验双方 schema 注册的并集；两分支各自的 `_journal.json` 追加块会文本冲突。按指示本评审仅对 #215 快照独立下结论，#215 侧文件本身自洽。

## RED 证据评注（minor）

`red.md` 仅各记 "0 pass / 1 fail / 1 error（Ran 1 test）"——对新模块属“import 即败”的全红形态（时间戳 04:35 先于 green 04:44），可采信但颗粒度浅（未逐用例列红）。后续 Ticket 建议按用例记录失败摘要。

## Limitations

1. 未复现实现者的 mutation check（删除 onConflictDoNothing 应使 2 用例失败）——reviewer 只读，不改文件；该项采信 green.md 记录并标注为未独立复现。
2. 未运行 `drizzle-kit generate`（会写仓库）；改为只读解析 snapshot 链核实其预存断裂声明。
3. “8× 连续稳定”未完整复跑：本人合并运行 1× + 集成套件单跑 3×，均 18/18 或 9/9 全绿。
4. 相邻回归抽查受 F3 flake 与批量运行 300s 超时限制：billing-credits-writer 套件单独多轮运行（除 F3 偶发）全绿；consumption/summary 等其余 7 套件未逐个复跑，采信 green.md 的 90-pass 记录。
5. 迁移仅在既有专用测试库（openbot-215-pg/openbot_test，已由实现者应用）上做只读状态核验，未新建库重放全量迁移。

## 结论

Issue #215 四条验收标准全部成立且由数据库层真实约束 + 多连接集成测试支撑，Produces 契约与父 Spec #5（AC01/AC13）、ADR 0002/0003/0004 的付款方归属/不漂移/隔离规则一致，CreditWriter 语义零改动，无余额迁移。**Spec compliance: PASS。** 代码分层清晰（纯契约/服务/schema 三层）、并发收敛与 fail-closed 语义有真实证据，findings 无阻断项。**Code quality: APPROVE**（F1 需跟进工单登记，F2/F3 建议顺手修复，F7 为 #234 集成时必修）。
