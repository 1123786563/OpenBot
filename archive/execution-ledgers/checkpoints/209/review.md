# Issue #209（Bifrost 01.3 兑换比例必填与合法性校验）独立 Review — 2026-10-15

Reviewer：独立只读 Pi reviewer（task_d2e574ce83b6 / dispatch ctx_ca8058cb628d，与执行者 task_f45c9d92c8ea 无关）。未编辑任何实现/测试文件，未提交。

## 快照确认（审查对象与执行者声明完全一致）

- Worktree：`/Users/wuyongjun/orca/workspaces/OpenBot/issue5-209`，分支 `1123786563/issue5-209`。
- `git rev-parse HEAD` = `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` = 声明 base（main `f0520524`）。
- `git status --porcelain -uall`：仅 ` M server/src/config.ts` + 4 个未跟踪实现/测试文件 + 2 个本 ledger 文件，与 checkpoint 清单一致；`git diff --numstat` = config.ts 单文件 31 插入 0 删除。stash 中两条记录来自 `billing-audit-remediation` 分支的既有历史，不属于本快照。
- **哈希核验（shasum -a 256，5/5 全部匹配 manifest）**：
  - `d43dbb35…7d33034` conversion-rate.ts ✓
  - `b8965266…e2f538` conversion-rate-store.ts ✓
  - `5b28118a…252cc86b` config.ts ✓
  - `89813d5a…3af3b38` gateway-conversion-rate.test.ts ✓
  - `23bbd49b…c58b1506` gateway-conversion-rate.integration.test.ts ✓

## 实际执行的验证命令与结果

```bash
shasum -a 256 <manifest 5 文件>                        # → 全部匹配（见上）
bun test server/tests/gateway-conversion-rate.test.ts  # → 45 pass / 0 fail（136 expect）
TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5569/openbot_test \
  bun test server/tests/gateway-conversion-rate.integration.test.ts  # → 12 pass / 0 fail（38 expect）
bun run --filter server typecheck                      # → Exited with code 0
bunx biome lint --error-on-warnings <5 个变更文件>      # → Checked 5 files. No fixes applied.
gh issue view 209/210/213/207 --repo 1123786563/OpenBot  # → 契约交叉核对（只读）
```

集成测试只跑专用库 127.0.0.1:5569/openbot_test（容器 `openbot-issue5-209-pg`）；`server/tests/support/database.ts` 在缺 `TEST_DATABASE_URL` 或指向 openbot 开发库时直接抛错，满足"不回退开发数据库"约束。未触碰任何生产/开发库。

## 一、Spec 合规性：**PASS**

### Ticket #209 验收标准逐条核验

| AC | 结论 | 证据 |
| --- | --- | --- |
| 1. 未配置比例时付费能力不可启用且状态可解释 | PASS | `readConversionRate()` 无行且无启动值 → `{configured:false, reason:"not_configured"}`；`billingReadiness()` → `{billingEnabled:false, reasonCode:"conversion_rate_missing", detail}`。全仓 grep 确认 `bifrostConversionRate`/`readConversionRate`/`billingReadiness` 无任何运行时消费点——本 diff 未新增任何可启用的付费能力入口，不存在绕过路径；实际强制门禁按 DAG 属 #213（01.7，Blocked by #210），符合逐切片功能准入约束。 |
| 2. 零/负/超精度/非法格式拒绝并返回具体原因 | PASS | 六种 reason 一一枚举（missing/zero/negative/invalid_format/precision_exceeded/out_of_range）；单测对 17 条非法输入逐条断言 reason 与消息；零判断基于 `BigInt(digits)===0n`，无浮点。 |
| 3. 合法比例保存后读取为精确值，无浮点误差 | PASS | bigint 分子/分母，jsonb 内十进制字符串持久化；集成测试覆盖 `0.000001→{1n,1000000n}`、`999999999.123456→{999999999123456n,1000000n}` 往返及新连接（重启语义）读取一致。 |
| 4. 启动与管理员写入两路径结论一致 | PASS | 两路径共用唯一纯函数 `parseConversionRateInput`；单测断言 `loadConfig` 抛错携带解析器消息片段，集成测试断言管理员写入对同批输入同批原因拒绝且不落库（invalid 后 `readStoredConversionRate` 仍 `not_configured`）。 |

### 父 Spec / ADR / CONTEXT 对齐

- **AC12 第一分句（missing configuration prevents enablement）**：由上述 AC1 满足；"changes affect new requests only / 尾差累计"分属 #210（版本锁定）与 06.5，按 Blocked-by 链正确分期，本 Ticket 交付了支撑它们的 `rateVersion` 字段。
- **Q14/Q19（比例必填、无隐含默认、变更只影响新请求）**：无默认值在解析器、启动路径、读取路径三处成立；`missing` 拒绝消息明文声明 "there is no implicit default"；`effectiveConversionRate` 对存储行 invalid 时**不**回退启动值（fail closed，有测试）。
- **ADR-0003（请求锁定兑换比例）**：`ConversionRateConfig.rateVersion`（0=启动值，保存从 1 起）正是 01.4 锁定所需的最小契约。
- **ADR-0002/0004（付款账户归属）**：本切片无付款/准入运行路径，不存在账户切换面；N/A，未违反。
- **CONTEXT.md 术语**："Credit Conversion Rate（同一部署统一比例）"被尊重——单键单值，无按用户/按 Bot 比例。
- **Write scope**：仅 `server/src/gateway/`（2 新文件）、`config.ts` 兑换比例区块（纯新增 31 行）、2 个测试文件；ledger 文档为 Ticket Handoff 强制要求。无迁移、无管理员 HTTP 路由、未改 `.env.example`——均为已记录的协调者批准偏差（#210 的 Write scope 明确含"对应数据库迁移"），合规。

## 二、代码质量：**APPROVE**（附发现，均非阻塞）

整体质量高：与 settings-store 既有模式一致（`{value}` jsonb 包装、事务内 `pg_notify`、upsert 显式 `updatedAt`）、注释解释 why、测试确定性且直接命中公共接缝。发现如下：

### F1 [Medium] 并发保存可产生重复 rateVersion，与文档化的"严格递增"契约不符
- 文件：`server/src/gateway/conversion-rate-store.ts` L54-95（`saveConversionRate`）。
- 证据：事务内先普通 `SELECT`（L54，无 `FOR UPDATE`），再 `previousVersion + 1`（L60-69），再 upsert（L87）。READ COMMITTED 下两个并发保存可同读 vN、同写 vN+1：两次成功保存只递增一次版本号，违反 `conversion-rate.ts` L20-21 与 store 文档声明的"admin saves start at 1 and strictly increment"。
- 现实影响：管理员路由尚未挂载，当前暴露面为零；且 #210 的 Write scope 与测试清单明确要求不可变版本表与"两个管理员同时变更不产生重复版本号"——本存储本就是 #210 要替换的过渡形态。
- 建议：#210 实施时必须以行锁/串行化或单条 `UPDATE … SET` 服务端自增修复；过渡期内应在交接说明中把该单值存储明确标注为"非并发安全，由 01.4 版本表取代"（当前 report 已部分表述，建议补 concurrency 限定词）。

### F2 [Low] 读取侧未复检本模块自身的精度上限不变量
- 文件：`server/src/gateway/conversion-rate-store.ts` L106-145（`readStoredConversionRate`）。
- 证据：读取校验只查形状与非正（L126-133 `numerator<=0n / denominator<=0n`），不查 `CONVERSION_RATE_MAX_INTEGER_DIGITS`(9)/`MAX_DECIMALS`(6) 或分母为 10 的幂。被篡改但为正的 20 位分子行会读为 `configured:true`，计费在非法比例上保持可用。文档化策略是"不可读或非正 → invalid"，实现与文档一致，故非违约；但与模块自述"validated like a credential"的姿态相比是防御纵深缺口（仅直接 DB 篡改可达）。
- 建议：读取时复检位数上限（或由 #210 版本表写入端保证并加读取断言）。

### F3 [Nit] 解析器拒绝原因的优先级未文档化 + 前导零按文本位数判超限
- 文件：`server/src/gateway/conversion-rate.ts` L84-101。
- 证据：小数位检查先于整数位检查，`"1234567890.1234567"` 返回 `precision_exceeded` 而非 `out_of_range`（确定性强，可接受但未声明优先级）；`"0000000001"`（数值为 1，文本 10 位整数）被拒为 `out_of_range`。均为保守拒绝、不违反 AC；建议注释声明优先级或规范化前导零。

### F4 [Nit] `savedBy/savedAt` 以显式 `undefined` 属性展开
- 文件：`server/src/gateway/conversion-rate-store.ts` L141-145。`{ savedBy: undefined }` 使属性存在但为 undefined；建议条件构造对象。无行为影响。

### I1 [集成关注点，非本 diff 缺陷] `server/src/config.ts` 与 #207（01.1）的共同编辑
- #207 的 Write scope 同样含 `server/src/config.ts` 与新增 `server/src/gateway/` 模块；两者都会动 import 块与 `DeploymentConfig` 类型。本 diff 纯新增（0 删除）、位于独立区块（import ~L33、类型 ~L431、helper ~L1499、装配 ~L2788/L2813），文本冲突面小，但集成合并后须重新执行本文件清单哈希核验与两组测试，且由集成者确认 `gateway/` 目录命名不撞车。按任务要求仅记为集成关注点。

### 重点核验小结（任务指定关注面）

1. **精确有理数安全** ✓ —— 全链路（解析/持久化/读取/就绪）无浮点；`\d` 在 JS 正则为 ASCII-only，其他文字系数字落 `invalid_format`（有测试）；`digitsToBigInt` 只接受纯 ASCII 数字串。
2. **付费配置 fail-closed / 无默认** ✓ —— 见 Spec 合规 AC1 与 Q14/Q19 段。
3. **持久化与 rateVersion 契约** ✓（除 F1 并发限定）—— 键 `gateway_conversion_rate`、`{value:{numerator,denominator,rateVersion}}` 十进制字符串、0=启动值/保存自 1；重启读取一致有测试。
4. **未授权网关启用** ✓ —— 本 diff 未引入任何启用路径或默认值；门禁函数仅供 #213 组装。
5. **启动/管理员路径一致性** ✓ —— 单一共享解析器；`optional()` 对空白值的"视为未设置"与解析器 `missing` 结论等价（均为未配置，非非法）。
6. **损坏行为** ✓ —— 篡改行 → `invalid` → 计费关闭、不回退启动值（有测试）；缺口见 F2。
7. **面向 #210/#213 的测试与接口稳定性** ✓ —— 导出面（类型/解析器/eff门函数/store 三函数/键常量/两个上限常量）与 #210 "Consumes 01.3 的 ConversionRateConfig 与校验语义"、#213 `blockingReasons` 聚合（`reasonCode+detail` 可直接映射）精确对齐；#210 改存储时 `readConversionRate(database, bootRate?)` 签名可保留。

## 三、限制

- 全量套件回归（8058 例 / 95 预存失败）未独立重跑，pristine-main 对照结论取自 checkpoint.md；本 review 仅重跑 Ticket 声明的两个测试文件 + typecheck + lint（全部通过）。
- 测试库为执行者预置容器（迁移已应用），reviewer 未重复执行 roles.sql/migrate.ts。
- TDD RED→GREEN 证据为 checkpoint 的历史声明，无法在完成态复核。
- `.env.example` 未含 `BIFROST_CREDITS_PER_USD`（声明的范围外项）；集成时需由统一配置文档 Ticket 落实，否则启动校验对运维不可发现（提示已写入 report）。

## 结论

- **Spec compliance：PASS**（4/4 AC 达成；范围偏差均为已批准并记录的协调决策；与父 Spec AC12、Q14/Q19、ADR-0002/0003/0004、CONTEXT.md 无冲突）。
- **Code quality：APPROVE**（F1 为对 #210 的移交条件而非本切片阻塞项；F2-F4 为加固建议）。
- Reviewer 独立于执行者，未自我批准；后续 #210 开工前应先消化 F1（并发版本原子性）与 F2（读取侧上限复检）。
