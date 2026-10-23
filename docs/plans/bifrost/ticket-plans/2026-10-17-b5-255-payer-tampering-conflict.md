# b5-255 (Bifrost 06.4) — Reserve 篡改 payer 与自报账户的冲突语义

BASE: `bab7c0b9`（worktree `b5-255`，分支 `1123786563/b5-255`；前置 #253/#254 的 credit-reserve/payer 实现已由 coordinator 同步进本 worktree 基线，属未提交集成改动）。
测试库：`postgres://openbot:openbot@localhost:5590/openbot_b5_255`（b5-verify-pg 5590 容器全新库，已应用 roles.sql + 全部迁移至 0139+；严禁触碰 5432/live `openbot`）。

## 前置契约核实（已读实际实现）

- 06.2 `server/src/billing/credit-reserve.ts`：`CreditReserveRequest{grantId,payer:PayerRef,...}`、封闭拒绝词表 `RESERVE_REFUSAL_REASONS`、`validateRequest`（纯形状校验，DB 前零读写）、`reserveCreditInTransaction`（授权 FOR SHARE → Bot 状态 → payer 映射解析 → 开放范围 → 新鲜度 → 价格 → 同事务写入）。**代码内注释明确标注"grant-versus-request payer comparison is 06.4's conflict semantics"——即本票要补的 seam**。
- 02.x `server/src/billing/payer.ts`：`payerKey(ref)` 确定性推导账户键（kind 前缀隔离）；`unknown_owner` 隔离拒绝。
- 02.5 `server/src/billing/payer-binding.ts`：`PayerBinding` 冻结绑定、`assertSamePayer` 不切换语义——本票只消费其语义，不改该文件。
- 02.4 `server/src/billing/payer-personal.ts`：`foreignAccountIdentityKeys`（userId/externalCustomerId/payerId/accountId/companyId/tenantId）+ `findForeignAccountIdentity`——账户身份参数的跨面统一词表，本票复用。
- 04.5 `access-grants` schema：`{grantId,userId,botId,scope,source,status}`；scope 封闭词表 **只有 "model-access"（个人授权）**——因此"授权解析出的 payer"当前恒为 `{kind:"personal", id: grant.userId}`；公司授权 scope 不存在，"公司授权用个人账户"方向由服务端单点解析结构性排除。
- 06.1 `server/src/billing/credit-service-auth.ts`：`creditProtocolRoutes({authenticate,auditStore,endpoints})` 已有每调用 `credit_service.called/refused` 审计行；本票冲突事件是其上的专用增量。
- `server/src/audit.ts`：`auditEventTypes` 封闭词表、`recordAuditEvent(store,{eventType,targetType,targetId,initiator,payload})`（payload 自动脱敏）、`DEPLOYMENT_INITIATOR`。
- 06.3 `reserve-concurrency.integration.test.ts`：请求 payer 与授权一致——本票改动不影响其绿色。

## 设计决策

1. **新拒绝码 `payer_conflict`**（封闭词表 `RESERVE_REFUSAL_REASONS` 新成员 + `REFUSAL_SENTENCES` 一句显示文案）。语义：请求声明的 payer（或请求携带的任何账户键）与服务端从授权解析出的 payer 不一致——fail-closed，绝不静默采纳自报值。
2. **服务端 payer 单点解析**（credit-reserve.ts 内，grant 读到后）：`grant.scope === "model-access"` → `{kind:"personal", id: grant.userId}`；其他 scope 值（DB check 约束下不可达，防御分支）→ `grant_invalid`。解析是结构性的：只消费 grant 行字段，请求体无法参与。
3. **事务内比对（新 step 2，grant+Bot 检查后、映射解析前）**：`request.payer` ≠ 解析结果（kind 或 id 任一不等）→ `payer_conflict`。原 `unknown_owner` 提前拒绝被比对吸收（unknown_owner 永不等于解析结果 → payer_conflict，比 payer_unresolved 更准确的旁路信号）；映射缺失/键不.derive 仍走 `payer_unresolved`。比对通过后以**解析出的 payer**（服务端事实）做映射查找与后续写入。
4. **自报账户键拒绝（`validateRequest` 纯形状层，DB 前）**：a) `payer` 对象键必须是恰好的 `{kind,id}`——任何额外键（如 `externalCustomerId`）→ `payer_conflict`；b) 请求顶层出现 `foreignAccountIdentityKeys` 词表任一键 → `payer_conflict`（复用 `findForeignAccountIdentity`，拒绝 detail 记录请求原样的键名）。原实现会**静默忽略**多余字段——这正是本票要移除的"兼容路径"。
5. **审计接线**：`audit.ts` 词表新增 `credit_reserve.payer_conflict`；`CreditReserveServiceDependencies` 增可选 `auditStore`；service 包装层在 outcome 为 `payer_conflict` 时写审计行（targetType `credit_protocol`，targetId=请求声明且形状合法的 grantId，initiator=DEPLOYMENT_INITIATOR，payload 记 stage/field/requestedPayer/resolvedPayer——供 22.2 核查旁路尝试）。审计写失败：记日志、不影响已决定的拒绝（同 06.1 recordRefusal 纪律）。仅 payer_conflict 写专用审计行：06.1 已对每个协议调用留 `credit_service.called/refused`，其余拒绝码不重复。
6. **无迁移、无 schema 改动**；HTTP 面沿用 422+`code`（冲突语义在码不在状态字）。
7. **既有测试契约更新**（属本票冲突语义的超越范围，报告中记录）：reserve-revalidation 的 "a payer ref with no account mapping refuses"（personal/nobody 现在先撞比对 → payer_conflict）与 "a quarantined unknown_owner payer ref refuses"（payer_unresolved → payer_conflict）。补 payer_unresolved 新可达路径测试：删除映射行后同 payer 请求 → payer_unresolved。

## 文件级计划

| 文件 | 动作 |
| --- | --- |
| `server/src/billing/credit-reserve.ts` | 修改：词表+`payer_conflict`；`validateRequest` 严格键检查；事务内 grant→payer 解析与比对；service 层审计接线（`auditStore?` 依赖） |
| `server/src/audit.ts` | 修改：`auditEventTypes` 新增 `credit_reserve.payer_conflict`（审计接线） |
| `server/tests/reserve-payer-tampering.test.ts` | 新增（票面 Verification 指定文件名）：三类篡改拒绝 + 零写入 + 审计断言 + 参数不存在性断言 + HTTP 422 边界 |
| `server/tests/reserve-revalidation.integration.test.ts` | 修改：两处既有期望码更新 + payer_unresolved 新路径测试 |

## RED→GREEN 验证命令

```bash
cd server
export TEST_DATABASE_URL='postgres://openbot:openbot@localhost:5590/openbot_b5_255'
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test ./tests/reserve-payer-tampering.test.ts    # RED→GREEN；文件参数必须 ./ 前缀
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test ./tests/reserve-revalidation.integration.test.ts
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test ./tests/reserve-concurrency.integration.test.ts
bun run typecheck
bunx biome lint --error-on-warnings src/billing/credit-reserve.ts src/audit.ts tests/reserve-payer-tampering.test.ts tests/reserve-revalidation.integration.test.ts
```

RED 判定：篡改类请求当前分别得到 payer_unresolved（篡改 payer）或 200/静默忽略（自报键），断言 payer_conflict + 审计行 → 失败即 RED，证据存 `.omc/reports/b5-255-red.log`。

## Review Focus

- 比对必须在映射解析**之前**：若先按请求 payer 查映射，伪造账户（真实存在且有余额）会在比对前读到他人行——顺序即安全属性（测试钉死：公司/他人账户真实存在仍拒）。
- 严格键检查不得把合法请求拒掉：`{kind,id}` 恰好两键通过（control 测试）。
- 审计行不得缺席也不得误报：仅 payer_conflict 写 `credit_reserve.payer_conflict`，reserved 不写。
- 拒绝零写入：所有篡改拒绝前后 `credit_reservations`/`billing_customers` 行数零差（含他人账户）。
