# Bifrost 01.3（Issue #209）重派验收报告 — 兑换比例必填与合法性校验

Ticket：https://github.com/1123786563/OpenBot/issues/209（覆盖 AC12 首分句；"变更只影响新请求"与尾差累计分属 #210 / 06.5）
Worktree：`issue5-209-2`，分支 `1123786563/issue5-209-2`，base `bab7c0b9`（未提交、未推送、未部署，按调度约束）
执行者：task_70823a91f78b / dispatch ctx_a8e965009b72

## 交付内容与来源

| 文件 | 角色 |
| --- | --- |
| `server/src/gateway/conversion-rate.ts`（新增） | 纯校验模块：精确有理数解析（整数位 ≤9 / 小数位 ≤6）、六类拒绝原因枚举、`effectiveConversionRate` 生效解析、`billingReadiness` 计费就绪门禁 |
| `server/src/gateway/conversion-rate-store.ts`（新增） | 管理员写入/读取路径：`enterprise_settings` 专用键 `gateway_conversion_rate`（jsonb 十进制字符串，无浮点）；事务级咨询锁保证 `rateVersion` 并发下严格递增（F1 修复版）；`readConversionRate()` 稳定读取接口 |
| `server/src/config.ts`（修改，+31/-0） | 进程启动路径：`BIFROST_CREDITS_PER_USD` 非法值携带解析器具体原因拒绝启动；合法值暴露为 `config.bifrostConversionRate`；缺省 = 计费未启用，无隐含默认 |
| `server/tests/gateway-conversion-rate.test.ts`（新增） | 单元测试 45 例：17 条非法输入逐条断言 reason、精确性极值、启动路径一致性、就绪门禁 |
| `server/tests/gateway-conversion-rate.integration.test.ts`（新增） | 集成测试 13 例：管理员写入拒绝/成功、版本递增、重启读取一致、精度极值往返、篡改行失败关闭、确定性并发保存（F1） |

**来源申明（透明度）**：本 dispatch 为同票重试。上述 5 文件为前任执行者（worktree `issue5-209`，task_f45c9d92c8ea）交付、并经两轮独立只读 Review（Spec PASS / 质量 APPROVE，F1 并发缺陷已修复并独立复核，遗留仅 Low/Nit 且全部移交 #210）的实现的逐字节移植：本基线 `server/src/config.ts` 与其基线 `f0520524` 版本哈希相同，移植后 5/5 文件哈希与其 final-review manifest 一致（见 `retry-2/checkpoint.md`）。本次工作 = 移植 + 在本基线独立重跑全部验证（RED→GREEN 证据为本基线新产生）。前任 review 包位于 `issue5-209` worktree `docs/execution-ledgers/checkpoints/209/`（review.md / f1-repair/ / final-review.md），其中最终结论：Spec compliance **PASS**、Code quality **APPROVE**、F1 **RESOLVED**。

## 验收标准对照（本次基线实测复证）

- **未配置兑换比例时，任何付费模型能力都不可启用，且状态可解释** —
  `readConversionRate()` 无存储行且无启动值 → `{configured:false, reason:"not_configured"}`；`billingReadiness()` → `{billingEnabled:false, reasonCode:"conversion_rate_missing", detail}`。全仓 grep 确认新接缝在 `gateway/`+`config.ts` 之外零消费点：本 diff 未新增任何可启用的付费能力入口，不存在绕过路径；实际强制门禁组装属 #213（DAG 后续），符合逐切片准入。
- **零、负数、超过精度上限或非法格式的比例被拒绝并返回具体原因** —
  六类 reason 一一枚举（`missing`/`zero`/`negative`/`invalid_format`/`precision_exceeded`(>6 位小数)/`out_of_range`(>9 位整数)）；零判断基于 `BigInt(digits)===0n`，全程无浮点；45 例单测中 17 条非法输入逐条断言 reason 与消息。
- **合法比例保存后可被读取为精确值，不发生浮点误差** —
  值为 bigint 分子/分母有理数（"7.5"→`{75n,10n}`）；持久化为 jsonb 内十进制字符串；集成测试覆盖 `0.000001→{1n,1000000n}`、`999999999.123456→{999999999123456n,1000000n}` 往返与新连接（重启语义）读取一致，13/13 通过。
- **配置校验在进程启动与管理员写入两条路径上结论一致** —
  两路径共用唯一纯函数 `parseConversionRateInput`；单测断言 `loadConfig` 抛错携带解析器原因片段，集成测试断言管理员写入对同批输入同批原因拒绝且不落库。

## 交付给 #210 / 下游的契约（未变，经本次复核仍然成立）

- `ConversionRateConfig { numerator: bigint; denominator: bigint; rateVersion: number }`：1 USD = numerator/denominator 积分；`rateVersion` 0 = 启动环境值，管理员保存从 1 起并发下严格递增。
- `parseConversionRateInput(raw)`：唯一校验入口；`readConversionRate(database, bootRate?)`：生效读取（存储行优先 → 启动值 v0 → 显式 not_configured；存储行不可读/非正 → `invalid` 失败关闭）；`billingReadiness(status)`：可解释就绪门禁。
- 精度规则：`CONVERSION_RATE_MAX_INTEGER_DIGITS=9` / `CONVERSION_RATE_MAX_DECIMALS=6`。
- 与 CREDIT_SCALE 关系（模块文档内写明）：兑换比例负责 USD→积分，CREDIT_SCALE(×100) 只负责积分内部整数化，两者独立。
- 持久化现状（给 #210）：`enterprise_settings` 键 `gateway_conversion_rate` 单值行；#210 的 Write scope 含对应迁移，应演进为不可变版本表并实现 `rateVersionAt(requestTime)`，同时消化 F2（读取端不复检精度上限）与 N2（hashtext→hashtextextended）等移交项。

## 边界与约束遵守

- 范围外（与前次已记录偏差一致，未扩大）：未启用网关能力、无新迁移、未挂载管理员 HTTP 路由、未改 `.env.example`（建议条目 `BIFROST_CREDITS_PER_USD=7.5`，归统一配置文档 Ticket）。
- 调度约束：未 commit / 未 push / 未 deploy / 无生产清理动作；fixed payer / provider 前严格准入 / 未知结果保留预扣等父级不变量在本切片无运行时路径（无准入/结算代码被触碰），不存在违反面。
- 测试库专用（127.0.0.1:5569/openbot_test，容器 `openbot-issue5-209-pg`），运行前确认独占、串行执行；未触碰任何生产/开发库。

## 重跑

见 `retry-2/checkpoint.md`（全部命令可复制执行；集成测试需 `TEST_DATABASE_URL` 指向专用库）。
