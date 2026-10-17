# Bifrost 01.3（Issue #209）验收报告 — 兑换比例必填与合法性校验

Ticket：https://github.com/1123786563/OpenBot/issues/209（覆盖 AC12）
分支：`1123786563/issue5-209`（基于 main `f0520524`，未提交、未推送，按调度约束）

## 交付内容

| 文件 | 角色 |
| --- | --- |
| `server/src/gateway/conversion-rate.ts`（新增） | 纯校验模块：精确有理数解析、拒绝原因枚举、生效解析与计费就绪门禁 |
| `server/src/gateway/conversion-rate-store.ts`（新增） | 管理员写入/读取持久化：enterprise_settings 专用键 `gateway_conversion_rate`，无新迁移 |
| `server/src/config.ts`（修改） | 进程启动路径：读取 `BIFROST_CREDITS_PER_USD`，非法值携带具体原因拒绝启动；合法值暴露为 `config.bifrostConversionRate` |
| `server/tests/gateway-conversion-rate.test.ts`（新增） | 单元测试：逐条非法输入断言原因、精确性、双路径一致性、就绪门禁 |
| `server/tests/gateway-conversion-rate.integration.test.ts`（新增） | 集成测试：管理员写入拒绝/成功、版本递增、重启读取一致、精度极值、篡改行失败关闭 |

## 验收标准对照

- **未配置兑换比例时，任何付费模型能力都不可启用，且状态可解释** —
  `readConversionRate()` 在无存储行且无启动值时返回 `{ configured: false, reason: "not_configured" }`；`billingReadiness()` 据此返回 `{ billingEnabled: false, reasonCode: "conversion_rate_missing", detail }`。没有隐含默认比例，也不会回退到任何数值。
- **零、负数、超过精度上限或非法格式的比例被拒绝并返回具体原因** —
  解析器拒绝原因逐一区分：`missing`（含无隐含默认说明）/ `zero` / `negative` / `precision_exceeded`（>6 位小数）/ `out_of_range`（>9 位整数）/ `invalid_format`（科学计数法、符号、分隔符、其他文字系数字等）。零判断基于解析后的整数位（`BigInt(digits) === 0n`），全程无浮点。
- **合法比例保存后可被读取为精确值，不发生浮点误差** —
  值为 `bigint` 分子/分母有理数（如 "7.5" → `{75n, 10n}`）；持久化为 jsonb 内的十进制字符串；集成测试覆盖 `0.000001 → {1n, 1000000n}` 与 `999999999.123456 → {999999999123456n, 1000000n}` 的往返，以及新连接（重启语义）读取一致。
- **配置校验在进程启动与管理员写入两条路径上结论一致** —
  两条路径共用同一个纯函数 `parseConversionRateInput`。单元测试对每条非法输入断言 `loadConfig` 抛错与解析器拒绝一致；集成测试断言管理员写入对同批输入以同批原因拒绝且不落库。

## 交付给 #210 / 下游的契约（稳定读取接口）

- `ConversionRateConfig { numerator: bigint; denominator: bigint; rateVersion: number }`：1 USD = numerator/denominator 积分，精确有理数；`rateVersion` 0 = 启动环境值（从未经管理员保存），管理员保存从 1 起严格递增。
- `parseConversionRateInput(raw)`：唯一校验入口，两个强制路径共用；拒绝时携带 `reason` + 人类可读 `message`。
- `readConversionRate(database, bootRate?)`：生效比例读取入口（01.4 版本锁定、01.7 就绪门禁、06.5 结算消费）。语义：管理员保存行优先；否则启动环境值（rateVersion 0）；否则显式 `not_configured`；存储行不可读/非正数时按 `invalid` 失败关闭——不回退启动值，不猜测比例。
- `billingReadiness(status)`：计费就绪门禁，输出 `{ billingEnabled, reasonCode, detail }` 或 `{ billingEnabled: true, rate, rateVersion }`，供 #213 `assertGatewayReadyForBilling` 组装。
- 精度规则：整数位 ≤9、小数位 ≤6（`CONVERSION_RATE_MAX_INTEGER_DIGITS` / `CONVERSION_RATE_MAX_DECIMALS`）。
- 与 CREDIT_SCALE 的关系（写于模块文档）：兑换比例负责 USD→积分换算，CREDIT_SCALE（×100，`server/src/billing/credits.ts`）只负责积分内部整数化；两者独立，不得合并为一个数。
- 持久化说明（给 #210）：现存放于 `enterprise_settings` 表键 `gateway_conversion_rate`（值形如 `{ value: { numerator: "75", denominator: "10", rateVersion: 1 } }`，updatedBy/updatedAt 记录操作者与时间，写入事务内 `pg_notify(ENTERPRISE_TOPIC)`）。#210 的 Write scope 含"对应数据库迁移"，应将此单值行演进为不可变版本表并在其上实现 `rateVersionAt(requestTime)`。

## 边界与上报

- **范围外（未做，符合 Ticket 约束）**：未启用任何网关能力（No gateway enablement）；未新增数据库迁移（经协调者确认复用 enterprise_settings）；未接入管理员 HTTP 路由（路由不在本 Ticket Write scope，写入接口以 `saveConversionRate(database, raw, by)` 服务函数交付，路由挂载与权限校验归后续 Ticket）；未改 `.env.example`（不在 Write scope，集成时由统一配置文档 Ticket 处理，建议条目：`BIFROST_CREDITS_PER_USD=7.5`）。
- **协调决策记录**：曾就 (1) 持久化方式 (2) 环境变量名 (3) config.ts 与 #207 的共同编辑上报协调者，答复为全部按默认执行（enterprise_settings 复用 / `BIFROST_CREDITS_PER_USD` / config.ts 独立区块、分段合并），已照办。业务字段名沿用批准 Spec 的 `credits_per_usd` 语义。
- **发现并规避的重叠**：stale 分支 `1123786563/bifrost-wave1` 已含旧版 #209 实现（迁移 0113，与现 main 0121+ 冲突且契约缺 rateVersion）；本工作为按当前 main 与 Ticket 契约的独立重实现，未读取/移植其代码语义之外的任何内容。#207/#215/#234 的文件未触碰。
- **测试基线**：server 全量 8058 例中 95 失败经 pristine main 对照确认全部为预存/环境性失败（enterprise RLS、config.test.ts Google auth、knowledge retriever 在线服务依赖），与本 diff 无关；证据见同目录 `checkpoint.md`。

## 重跑

见同目录 `checkpoint.md` 的"验证命令"节（专用 `TEST_DATABASE_URL` 指向 127.0.0.1:5569 的 openbot_test）。
