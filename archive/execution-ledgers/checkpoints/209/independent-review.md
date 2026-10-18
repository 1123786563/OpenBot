# Issue #209（Bifrost 01.3 兑换比例必填与合法性校验）— 独立只读 Review

- Reviewer：dispatched worker（task_2068058195f1 / dispatch ctx_19bc5eec8447），与实现者无同一会话
- 目标快照：worktree `issue5-209-2`，分支 `1123786563/issue5-209-2`，base `bab7c0b9` + 未提交变更（` M server/src/config.ts`；`?? server/src/gateway/`、2 个 `?? server/tests/gateway-conversion-rate*.test.ts`）
- 审查对象：实现 2 文件 + config.ts diff、测试 2 文件、`retry-2/checkpoint.md`、`retry-2/report.md`、票 `docs/tickets/bifrost-5/issues/01.3-conversion-rate-required-config.md`、ADR 0003
- 方法：只读审查 + 独立重跑全部验证命令；未编辑任何实现文件、未运行修复、未提交
- 文件哈希核验：5/5 文件 SHA-256 与 `retry-2/checkpoint.md` manifest 逐字节一致（`d43dbb35…` / `eda84eb8…` / `5b28118a…` / `89813d5a…` / `50165a1c…`）

## 结论

- **Spec compliance：PASS**（4/4 验收标准在本切片范围内交付，偏差均已记录且为协调者既有决策）
- **Code quality：APPROVE**（0 个阻塞/高危发现；2 个 Low/Nit 级观察，其中全部已知项均有 #210 移交记录）

## 独立重跑证据（2026-10-15，本机实测）

| 命令 | 声称 | 实测 | 一致 |
| --- | --- | --- | --- |
| `bun test server/tests/gateway-conversion-rate.test.ts` | 45 pass / 136 expect | 45 pass / 0 fail / 136 expect | ✅ |
| `TEST_DATABASE_URL=…5569/openbot_test bun test server/tests/gateway-conversion-rate.integration.test.ts`（串行 ×3） | 13 pass ×3，无 flake | 13 pass / 0 fail ×3（含 F1 并发用例） | ✅ |
| `bun run --filter server typecheck` | exit 0 | Exited with code 0 | ✅ |
| `bunx biome lint --error-on-warnings`（5 文件） | clean | Checked 5 files. No fixes applied. | ✅ |
| `bun test server/tests/config.test.ts` | 140 pass / 1 fail（预存） | 140 pass / 1 fail；唯一失败为 `config.auth` 的 `emailPassword: false` 深比较（config.test.ts:296-303），与本 diff 无交集（diff 只新增顶层 `bifrostConversionRate`，不触碰 auth）→ 确属预存 | ✅ |
| `bun test server/tests/billing-config.test.ts` | 41 pass | 41 pass / 0 fail | ✅ |
| 消费点 grep（`bifrostConversionRate`/`readConversionRate`/`billingReadiness`/`parseConversionRateInput`） | gateway/ + config.ts 之外零运行时消费 | 仅 `server/src/config.ts`、`server/src/gateway/conversion-rate.ts`、`server/src/gateway/conversion-rate-store.ts` 三处 | ✅ |

RED 阶段证据为执行者自述（模块缺失型失败），本 reviewer 未重放（需改动快照）；GREEN 及以上全部证据独立复现一致。

## 分维度评估

### 1. 兑换比例校验（conversion-rate validation）— 通过

- 单一纯函数 `parseConversionRateInput`（conversion-rate.ts:56-110）覆盖六类拒绝：`missing` / `zero`（:93，基于 `BigInt(digits)===0n`，非浮点）/ `negative`（:80）/ `invalid_format`（:65，正则 `^(-?)(\d+)(?:\.(\d+))?$` 拒绝科学计数、`+`、分隔符、阿拉伯-印度数字等）/ `precision_exceeded`（:85，>6 位小数）/ `out_of_range`（:100，>9 位整数）。
- 拒绝优先级（格式→负→精度→零→量级）自洽：`"00.000"→zero`、`"0.0000001"→precision_exceeded`、`"1234567890"→out_of_range` 均有逐条断言（test.ts:14-31、41-47、52-62）。
- 边界抽查：`"1."`/`".5"`/`"+1"`/全角外文数字均 invalid_format；BigInt 任意精度使超长数字串在量级检查前无溢出风险。

### 2. 精确算术（exact arithmetic）— 通过

- 表示为 bigint 有理数 `{numerator, denominator}`，输入→`BigInt(integerPart+decimalPart)` / `10n**decimals`，全程无浮点；grep 确认两模块无 `Number(`/`parseFloat`/`toFixed`/`Math.*`。
- 持久化为 jsonb 内十进制字符串（conversion-rate-store.ts:91-99），读回经 `digitsToBigInt`（:185-188）严格数字串校验。
- 极值往返 `0.000001→{1n,1000000n}`、`999999999.123456→{999999999123456n,1000000n}` 及新连接（重启语义）读取一致（integration test「precision extremes」「fresh database handle」），实测通过。

### 3. 并发版本化（concurrent versioning）— 通过

- `saveConversionRate`（conversion-rate-store.ts:53-115）：事务首语句取 `pg_advisory_xact_lock(hashtext(key))`（:69，事务级、commit 释放），再读上一版本 → `previousVersion + 1`（:88）→ upsert（:106）。两并发保存在锁上排队，各自观察到前一个已提交版本，版本严格递增且唯一。
- F1 用例（integration「competing concurrent saves」）为确定性构造：holder 先 `FOR UPDATE` 停驻行锁，两个竞争保存经 `pg_stat_activity`+`pg_blocking_pids` 确认双双停驻后才放行；断言两结果版本恰为 `{2,3}`、终行 v3 与胜者值/savedBy 一致。无锁实现下两者都会读到 v1 并重复发放 v2，该用例必然失败——测试真实钉住修复。3 次串行重跑无 flake。

### 4. 失败关闭（failure-closed）— 通过（附 F-1 低危观察）

- 读路径不可读/非正/版本非整数 → `reason:"invalid"`（conversion-rate-store.ts:143-160）；`effectiveConversionRate` 对 `invalid` 不回落启动值（conversion-rate.ts:141-142），即使 bootRate 存在也保持不可用——管理员已保存意图不可证明时不得被替换；`billingReadiness` → `conversion_rate_invalid` 明确禁用（:178-184）。篡改行（numerator="0"）集成用例实测失败关闭。
- 对 `bootRate` 亦做防御性正数校验（conversion-rate.ts:143-147），不信任调用方。

### 5. 无隐含默认（no implicit default）— 通过

- 启动路径：`gatewayConversionRate`（config.ts:1506-1517）缺省返回 `undefined`，非法即 throw 携带解析器具体原因；配置对象仅在存在时展开 `bifrostConversionRate`（:2813），无任何硬编码比例。
- 读取路径：无存储行且无启动值 → 显式 `not_configured` → `conversion_rate_missing`（"There is no implicit default" 文案即测试断言，test.ts:157-170）。

### 6. Payer / admission 边界 — 通过（切片级）

- 全仓 grep 确认新接缝在 `gateway/`+`config.ts` 之外零运行时消费点；diff 未触碰任何准入、预留、结算、payer 代码，不存在本切片新增的可启用付费能力入口，亦无绕过路径（无第二个解析器、无第二处读取 `gateway_conversion_rate`）。
- 父级不变量（fixed payer、provider 前严格准入、未知结果保留预扣）在本切片无运行时路径，无违反面。实际门禁组装归 01.7/#213（DAG 后续），符合"逐切片准入"，见 F-5。

### 7. 证据是否支撑声称的验收 — 支撑

- checkpoint/report 的全部可复现命令（上表 7 项）实测逐项一致；文件哈希 5/5 一致；`git status` 与申明一致（仅预期文件，未提交/未推送）；测试库为专用容器 `openbot-issue5-209-pg`(127.0.0.1:5569)，`tests/support/database.ts` 强制 `TEST_DATABASE_URL` 且拒绝 `openbot` 库名，无开发库回退面。
- 两条路径结论一致（AC4）由共享同一纯函数 + 双路径同批输入断言（test.ts:100-124 boot throw 携带解析器原因片段；integration INVALID_SAVES 6 类拒绝且不落库）支撑。

## 验收标准逐条判定

| AC | 判定 | 依据 |
| --- | --- | --- |
| 未配置时任何付费能力不可启用且状态可解释 | PASS（接缝级，见 F-5） | `billingReadiness` 可解释 reasonCode；零消费点 = 本 diff 未新增任何可启用付费入口 |
| 零/负/超精度/非法格式拒绝并返回具体原因 | PASS | 六类 reason 逐条断言（17 条非法输入 × 单测；6 条 × 集成） |
| 合法比例保存后可读取为精确值无浮点误差 | PASS | bigint 有理数 + jsonb 十进制字符串 + 极值往返/重启读取实测 |
| 启动与管理员写入两路径结论一致 | PASS | 唯一共享解析器；双路径同批输入同批原因，非法写入不触库 |

## Findings

| # | 严重度 | 位置 | 内容 | 处置建议 |
| --- | --- | --- | --- | --- |
| F-1 | Low（已知，已移交） | `server/src/gateway/conversion-rate-store.ts:121-168`（尤其 :143-160 校验块、:185-188 `digitsToBigInt`） | 读端只校验"可读且为正"，不复检 9/6 位上限、分母是否 10 的幂、有理数是否契约形：被直接篡改为"正但越界"的 jsonb 行会读为 `configured:true` 并放行计费（fail-open 于该篡改类）。写端有完整校验，利用需 DB 直写权限。 | 与 report.md 记录的 F2 一致，随 #210 不可变版本表一并收紧（读取端复检上限/形态，或版本表使篡改不可表达）。本切片可接受。 |
| F-2 | Nit（已知，已移交） | `server/src/gateway/conversion-rate-store.ts:69` | `hashtext` 32 位咨询锁键，与他键理论碰撞只会过度串行化，无正确性影响（N2）。 | #210 换 `hashtextextended`。 |
| F-3 | Nit | `server/src/gateway/conversion-rate-store.ts:161-166` | `savedBy/savedAt` 以显式 `: undefined` 分支展开，风格噪音。 | 可在 #210 顺手简化，不阻塞。 |
| F-4 | Info | `server/src/config.ts:506-508,1506-1507` | 启动路径经 `optional()` 将纯空白 `BIFROST_CREDITS_PER_USD` 视为缺省（非拒绝）。结果同为"计费未启用"的失败关闭方向，且与全仓环境读取风格一致；仅"缺省 vs 非法"语义在路径间有细微差。 | 无需动作；若 #210 收紧可考虑区分。 |
| F-5 | Info（范围裁定，非缺陷） | `retry-2/report.md`（边界与约束遵守节） | AC1 首句的强制组装属 #213/01.7；本切片交付可解释门禁原语且未新增启用面。裁定符合票面"逐切片准入"与 DAG。 | #213 接手时消费 `billingReadiness`。 |
| F-6 | Info | `retry-2/checkpoint.md` | RED 阶段证据为自述（模块缺失型失败），本 reviewer 未重放（需改动快照）；GREEN 起全部证据已独立复现。 | 无需动作。 |

无 High/Medium 发现；无新增（未记录）缺陷。

## 代码质量评估

- **结构**：纯核（conversion-rate.ts，无 IO）与存储（conversion-rate-store.ts）分层清晰，接缝小而深；`ConversionRateConfig`/`readConversionRate`/`billingReadiness` 契约对 #210 明确。
- **注释**：模块/函数注释把"为何"（credential 级校验、无浮点、F1 锁序、pg_notify 惯例）与审查历史锚定，可维护性好。
- **测试**：单元 45 + 集成 13 覆盖六类拒绝逐 reason、极值精确性、重启语义、篡改失败关闭、确定性并发；F1 用例以停驻式构造消除时序 flake（3/3 稳定）。
- **一致性**：`pg_notify(ENTERPRISE_TOPIC,'')` 与 settings-store.ts:107 惯例一致；config.ts 写法（optional + 条件展开）与既有 webBotAuth 等模式一致；测试库防回退护栏到位。
- Write scope 合规：改动恰为票面允许范围（gateway/ + config.ts 比例校验 + 对应测试）+ 执行 ledger；`.env.example` 未动为已记录偏差。

**最终判定：Spec compliance PASS；Code quality APPROVE。**
