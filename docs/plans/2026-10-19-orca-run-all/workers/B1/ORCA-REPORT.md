# [bf-B1] Bifrost B 类核验 — #227 / #232 / #240 / #242 / #251

批次：bf-B1（Bifrost 域）。Worktree：`1123786563/bf027`（BASE `3ca32d49`）。
DB：`TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5561/bf027`（容器 `orca-all-bf027-pg`，pgvector，保留未删）。
**本批零改动**：5 票全部零代码变更，无未提交 diff（本报告除外）。

## 总览

| 票 | 标题 | 结论 |
|---|---|---|
| #227 | Bifrost 03.5 管理员立即同步 | **SATISFIED（零改动）** |
| #232 | Bifrost 03.10 选择器与不可用报错 | **SATISFIED（零改动）** |
| #240 | Bifrost 04.7 用户授权列表与单独撤销 | **SATISFIED（零改动）** |
| #242 | Bifrost 05.1 Customer 幂等开户 | **SATISFIED（零改动）** |
| #251 | Bifrost 05.10 用户侧 Key 状态展示与全版本撤销 | **BLOCKED-GAP**（UI 半未实现） |

---

## #227 Bifrost 03.5 管理员立即同步 — SATISFIED（零改动）

票面 Verification 路径与仓库现状**完全一致**（无漂移）：`server/tests/catalog-manual-sync.test.ts`、`app/tests/admin-catalog-sync-ui.test.tsx` 均存在且绿。

### AC 逐条实证

- **AC1 管理员触发后立即执行同步并返回结果 — ✓**
  `server/tests/catalog-manual-sync.test.ts:334` describe "an administrator's trigger runs the same sync and answers the outcome"：`success answers the synced time and the appended snapshot version count`（返回 syncedAt + snapshotVersion）；失败路径 `a failed sync answers the fixed reason and keeps the last-good snapshot`。
- **AC2 非管理员触发被拒绝 — ✓**
  `:312` "a member is refused with 403 and nothing runs"、`an anonymous caller is refused with 401"。
- **AC3 重复触发不产生并发同步或重复快照 — ✓**
  `:445` "repeated triggers share one sync"：`a second click while a sync runs joins it: one dial, one snapshot, one result`。
- **AC4 每次触发都有审计记录 — ✓**
  `:512` "every executed trigger is audited once per click, not per dial"；`:540` "a broken audit trail refuses the trigger"（审计写不进则不答成功）。
- UI 半（Implementation step 4 按钮 + 结果展示）— ✓ `app/tests/admin-catalog-sync-ui.test.tsx` 4 用例：按钮触发手动路由并回读目录、失败展示服务端固定 reason、运行中禁用按钮防双击、无 sync service 时提示不可用。

### 命令与输出

```
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5561/bf027 bun test ./server/tests/catalog-manual-sync.test.ts
  8 pass / 0 fail / 49 expect() calls
E2E_UNIT_SCOPE=app bunx e2e run --config e2e.unit.config.ts
  Test Files 128 passed (128) / Tests 967 passed (967)   ← 含 admin-catalog-sync-ui.test.tsx
```

改动文件：无。遗留：无。

---

## #232 Bifrost 03.10 选择器与不可用报错 — SATISFIED（零改动）

票面路径一致：`app/tests/model-picker-ui.test.tsx` 存在且绿（359 行，10 用例）。

### AC 逐条实证

- **AC1 可选模型、当前生效选择及来源层级 — ✓**
  "the picker lists the selectable models with the price label the snapshot reports, and an unset state says so"；"the effective selection names the layer it came from, for each of the three layers"（三层来源逐层断言）。
- **AC2 不可用/下架明确报错并要求重选 — ✓**
  "an unavailable selection shows its exact reason and a re-selection prompt — the stored model stays, nothing is substituted"；"a delisted model reports model_not_in_catalog with its own sentence"。
- **AC3 界面不自动替换模型 — ✓**
  同上用例标题内嵌 "nothing is substituted"；写入拒绝路径 "a refused write shows the server's refusal and changes nothing on screen"。
- **AC4 价格与后端快照一致、未知价格不显示免费 — ✓**
  "an unknown price never reads as free — not in the list, not on the excluded selection"。
- 加载失败诚实报错 — ✓ "a failed load is an honest error, not an invented list or selection"。

### 命令与输出

```
E2E_UNIT_SCOPE=app bunx e2e run --config e2e.unit.config.ts   # model-picker-ui.test.tsx 在 app 组内
  Test Files 128 passed (128) / Tests 967 passed (967)
```

改动文件：无。遗留：无。

---

## #240 Bifrost 04.7 用户授权列表与单独撤销 — SATISFIED（零改动）

票面路径一致：`server/tests/access-grant-revoke.test.ts`、`app/tests/user-authorizations-ui.test.tsx` 均存在且绿。

### AC 逐条实证

- **AC1 只能看到并撤销自己的授权 — ✓**
  "the list shows only the caller's own grants, with bot, identity, status and time"；"another person's grant is unrevokable and invisible: one uniform refusal"；无会话 401、无服务 503。
- **AC2 撤销立即 revoked、重复撤销幂等 — ✓**
  "revoking marks the grant revoked the instant the response returns, and the downstream use check refuses at once"；"a repeated revocation is idempotent: the same revoked grant, no second audit event"。
- **AC3 撤销不影响已发生消费的结算责任 — ✓**
  "revoking touches only the grant row: settled consumption keeps its ledger, reservations and grants"。
- **AC4 每次撤销都有审计记录 — ✓**
  "every real revocation writes one audit record naming the actor, and never a secret"。
- UI 半 — ✓ `user-authorizations-ui.test.tsx` 4 用例：授权列表渲染（身份/状态/创建时间）、只有 active 有 Revoke 且只撤该 grant、拒绝时明说、空态文案。

### 命令与输出

```
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5561/bf027 bun test ./server/tests/access-grant-revoke.test.ts
  8 pass / 0 fail / 40 expect() calls
E2E_UNIT_SCOPE=app bunx e2e run --config e2e.unit.config.ts
  967 passed（含 user-authorizations-ui.test.tsx）
```

改动文件：无。遗留：无。

---

## #242 Bifrost 05.1 Customer 幂等开户 — SATISFIED（零改动）

**票面路径漂移**：声明的 `server/tests/customer-provisioning.integration.test.ts` 不存在；等价实现为 **`server/tests/gateway-customer-provisioning.integration.test.ts`**，文件头注释第一句即 "Bifrost 05.1 (#242) against a real PostgreSQL"，四条 AC 注释逐条对齐。实现位于 `server/src/gateway/customer.ts` + `server/src/db/schema/gateway.ts`。

### AC 逐条实证

- **AC1 并发开户只留下一个有效映射 — ✓**
  describe "concurrent provisioning leaves exactly one valid mapping"：`six connections racing the same ref all answer the one customerId`（六连接真并发，唯一索引仲裁而非读检查）。
- **AC2 重复开户返回同一 customerId — ✓**
  "the second provision takes the fast path: same id, one row, no remote call"；另有 409 收敛远端已存在实体、映射可读（`readGatewayCustomerMapping`，供 05.3/05.8）。
- **AC3 门禁未就绪时开户被拒绝 — ✓**
  "the gate's refusal is the end of the path: no remote call, no row"；无门禁服务部署入口也拒绝。
- **AC4 开户不产生任何余额或积分 Grant — ✓**
  "no billing customer, grant, ledger, reservation or payer account appears"（逐表断言）。
- 附加：远端不可达/超时/凭据拒绝/非法响应全部类型化拒绝、绝不写半截映射。

### 命令与输出

```
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5561/bf027 bun test ./server/tests/gateway-customer-provisioning.integration.test.ts
  17 pass / 0 fail / 65 expect() calls
```

改动文件：无。遗留：无（路径漂移已在上文记录）。

---

## #251 Bifrost 05.10 用户侧 Key 状态展示与全版本撤销 — BLOCKED-GAP

**票面声明的 `app/tests/user-key-status-ui.test.tsx` 不存在，且整条 UI 切片未实现。** 服务层前置已交付，但用户可达面完全缺失，缺口跨 server 路由 + UI 组件 + 测试，远超 20 行单票边界，不就地实施。

### AC 逐条核对（全部未满足于 UI 面）

- **AC1 用户看到每个 Bot 的 Key 状态与期限、看不到明文 — ✗**
  用户侧唯一入口 `/api/model-access` 只有 `GET /grants`、`POST /grants/:grantId/revoke`（`server/src/bot-services/access-grants.ts:907,917`，04.7 范围）。授权页组件 `app/src/components/settings/model-access-authorizations.tsx`（109 行）只渲染 grant 字段，grep 无 credentialVersion/expiresAt/期限概念；`app/src/routes/_authed/settings/model-access.tsx` 注释明说 "No key appears here"。
- **AC2 "撤销全部有效版本"动作 — ✗（UI/路由缺）**
  服务层语义已存在：`server/src/gateway/key-revocation.ts` `revokeForUser`，`server/tests/key-revocation.test.ts:197` "revocation retires every active key version of the grant"（05.7 交付）。但没有接到任何用户路由，UI 无按钮。
- **AC3 远端不可用时展示错误而非空列表 — ✗**
  无用户 Key 状态查询端点可谈错误态；`key-state-sync.test.ts`（05.8）只覆盖 server 同步侧。
- **AC4 撤销后界面状态立即更新 — ✗**
  该界面不存在（04.7 的 grant 撤销 refetch 是另一张票的行为）。

### 缺什么（留给专项派发）

1. 用户侧 Key 状态查询路由（消费 05.4 状态字段：状态、期限、credentialVersion、不含 secret）——服务层数据已齐（`key-expiry.test.ts:600` 证明 status view 可查）。
2. 用户侧"撤销全部有效版本"动作路由，接 `key-revocation.ts` 的 `revokeForUser`。
3. UI：在 model-access 授权页扩展 Key 状态/期限/credentialVersion 展示 + 撤销全部按钮 + 远端 401 错误态（不伪装空列表）。
4. `app/tests/user-key-status-ui.test.tsx`（状态渲染、撤销全部、远端错误态、无 secret 断言）。

### 命令与输出（定位证据）

```
grep -rln credentialVersion app/src app/tests        → 无命中
ls app/tests | grep -i key                          → 仅 carousel-keyboard / hotkey-layouts / live-screen-keyboard（无关）
grep -rn "revoke" server/src/bot-services/access-grants.ts → 仅 grants/:grantId/revoke（04.7）
bun test ./server/tests/key-revocation.test.ts 的能力属 05.7（#248），不在本票缺口内
```

改动文件：无。遗留：见上 4 项缺口，建议单票专项实施。

---

## 全批共用验证

```
bun run --filter server typecheck   → Exited with code 0
bun run --filter app typecheck      → Exited with code 0
E2E_UNIT_SCOPE=app bunx e2e run --config e2e.unit.config.ts
  → Test Files 128 passed (128) / Tests 967 passed (967) / 3.74s
```

- biome lint：本批零改动文件，无可 lint 对象，跳过（非通过性跳过——无 diff）。
- DB 容器 `orca-all-bf027-pg` 保留未删。
- git 状态：除本报告（未跟踪 ORCA-REPORT.md）外工作区干净，无提交、无推送。
