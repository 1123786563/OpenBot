# FIX-4 Report — R2B-F1 funding shelter + R2B-F2 comment correction

**Worker:** Orca worker `orca_session_id:1dae1e67-a07c-4d85-9349-ce1ccb863814`
**Task:** `task_d7f2c5253778` / Dispatch: `ctx_087807d58f89` / Run: `run_3af21ba694ad`
**Date:** 2026-10-26
**Branch:** `1123786563/b5r-fix2`（接续提交，未 push）
**Base:** `465486a0c`（FIX-2b / REV-2b INTEGRABLE 基线）

> **修订沿革**：本报告为 Run 内活文档——FIX-4 初版后由 FIX-5（OCR round-1 整改）与 FIX-6（OCR round-2 整改，随提交 da0d4ad56）两波就地修订；§2 末注、§4 基线段、§5 首条均为后波修订。修订史见 `git log`（分支 `1123786563/b5r-audit-integration`，本地可审计，未 push 系本 Run 授权边界）。

## 1. 结论

REV-2b 裁决的 R2B-F1（medium）与 R2B-F2（low）均已整改完毕，全部验收项实际运行通过：

| 验收项 | 结果 |
|---|---|
| RED 复现（修复前 HEAD `465486a0c`） | `companyGrant=0`、deleted=3（payer/grant/order），与 REV-2b §6 同形 |
| GREEN（修复后） | `companyGrant=1`、deleted=2（legacy payer/order 仍删）、`postPassed=true`、`accountingPassed=true` |
| 七件 cleanup 套件净库全绿 | **77 pass / 0 fail / 1129 expect**（全新库 `openbot_b5r_fix4_final`，逐件同跑一次） |
| 新增防过度保护用例 | 绿（含防过度保护臂：纯 legacy 键 + registry-personal 键资金仍被真删） |
| `cd server && bun run tsc --noEmit` | exit 0，无输出 |
| biome 对改动文件 | 零新增（HEAD 基线两文件均干净；交付前 `biome check` 干净） |

## 2. 改动语义（只改两个文件）

### `server/src/billing/cleanup-relations.ts`

**R2B-F1（资金庇护扩展）**：ownership pass 原有断言不变——账户形状判定、映射/归属全表保护、SET NULL/NO ACTION/CASCADE 上行庇护闭包全部原样保留。在其后新增一段：

- 从 `ownershipRowByKey` 里收集全部受保护 0163 行的 `external_customer_id`（公司/隔离/注册外 personal/未知形状账户 + 公司支付映射行所指的键）；
- 对 `credit_grants` / `credit_ledger` / `credit_reservations` 三张资金表做行扫描，凡是这些键的资金行一律 `protect(row, "funding_of_protected_key")`——**跟随所有权判定，不再要求 `billing_call_attributions` 链存在**；
- 新 `ProtectionKind` 成员 `funding_of_protected_key` 让评估 manifest 如实点名庇护原因，与 `protects_owned_record`（FK 精确庇护）区分。

**不过度保护**：只有受保护 0163 行指明的客户键进入 `ownedCustomerKeys`；纯 legacy 无主键（无任何 0163 行）其资金行一行也不进保护集，清理语义原样。`protect()` 对已在保护集的行是 no-op，行为本身幂等。

**R2B-F2（注释纠偏，两处）**：

- `billing_credit_accounts` 注册表注释（原 ":356" 段）：由「0163 row-shape CHECKs pin the three legal shapes」改写为「schema 声明形状约束，但已发 0163 迁移未创建任何 CHECK，ownership pass 即运行时强制」；
- `unknown_account_shape` 分支注释（原 ":1041" 段）：由「Current CHECKs reject every other shape…」改写为「schema 声明了形状 CHECK 但 0163 迁移未创建；此分支即运行时强制」。

提交信息不改写（历史检查点不动），与 REV-2b 要求一致。

**R2B-INFO-3（fixture 泄漏）按 brief 要求不在本轮范围，未触碰。**

### `server/tests/cleanup-relations.integration.test.ts`

新增第三个 describe：「R2B-F1 (REV-2b): funding rows follow their key's 0163 ownership verdict」（1 个用例，~420 行 fixture/断言）。真实执行全链路：分类 → 21.3 评估 → 21.5 新鲜守卫 → dry-run → 真实授权执行 → 落盘后盘点。

四个臂：

1. **公司键**（legacy 证据 + 真实 `bindCompanyCustomer`/`registerCompanyAccount` + 注册后经真实 `createCreditWriter().grantCredits` 写入的无归属 promo grant + settled ledger/hold）：客户/账户/映射/全部资金行存活；
2. **隔离键**（`quarantineUnknownAccount` + 无归属 grant）：账户与资金行存活；<br>
   （注：unknown-shape 与注册外 personal 键无直接用例臂；隔离键的 ledger/reservations 庇护亦未直接断言——已知缺口，登记后续补臂。）
3. **registry-personal 臂（防过度保护）**：账户 owner 在 `testUserIds` 注册表内——账户、客户、资金全部真实删除；
4. **纯 legacy 臂（防过度保护）**：无任何 0163 行——客户、legacy payer/order、grant、settled ledger/hold 全部真实删除。

并断言评估 manifest 中庇护资金行携带 `funding_of_protected_key`、新鲜守卫对庇护资金行拒绝为 `not_in_verified_deletion_scope`、而纯 legacy 资金行在 deletable 列表中。

## 3. RED / GREEN 双读数

复现脚本 `/tmp/rev2b-money.ts`（REV-2b 复核材料，未修改；`R2B_SUFFIX` 换后缀防撞幂等键）。

### RED（HEAD `465486a0c`，库 `openbot_b5r_fix4_red`，全新库）

```
execution: {"committed":true,"deleted":3,
  deletedByTable:[payer_accounts:1, credit_grants:1, payment_orders:1],
  postPassed:true, accountingPassed:true}
after: {customer:1, account:1, mapping:1, legacyPayer:0, companyGrant:0,
        reclassifiedAs:"unknown_owner"}
```

与 REV-2b §6 观察完全同形（companyGrant=0 即资金被删）。

### GREEN（修复后，库 `openbot_b5r_fix4_green`，全新库）

```
execution: {"committed":true,"deleted":2,
  deletedByTable:[payer_accounts:1, payment_orders:1],
  postPassed:true, accountingPassed:true}
after: {customer:1, account:1, mapping:1, legacyPayer:0, companyGrant:1,
        reclassifiedAs:"unknown_owner"}
```

公司资金存活；legacy payer/order 仍删；post/accounting 两个终态不变。评估 manifest 中 grant 以 `REMOVED(cascade_impact_on_retained)` + `impact=[credit_grants/...(funding_of_protected_key)]` 呈现。

### 新增用例的 RED 对照

将产品文件暂存回 HEAD（保留新测试文件），在全新库 `openbot_b5r_fix4_redcheck` 上跑 `cleanup-relations`：**14 pass / 1 fail**——唯一失败即新 R2B-F1 用例；14 项既有用例（含 R2-F1 两条复现回归）不受影响，证明新断言在修复前可复现红灯、且未改写既有语义。

## 4. 套件与静态门禁

全部读数均在 `openbot-test-pg@5433`，各库均经 `bun scripts/migrate.ts` 全新迁移；命令形如（口令已按约定不落档，见 brief DSN 段）：

```bash
TEST_DATABASE_URL='postgresql://openbot@127.0.0.1:5433/openbot_b5r_fix4_final' \
  bun test tests/cleanup-classification.integration.test.ts \
           tests/cleanup-enumeration.integration.test.ts \
           tests/cleanup-relations.integration.test.ts \
           tests/cleanup-dry-run.integration.test.ts \
           tests/cleanup-guards.integration.test.ts \
           tests/cleanup-execution.integration.test.ts \
           tests/cleanup-rehearsal.integration.test.ts
# → 77 pass / 0 fail / 1129 expect, exit 0（净库，七件一次跑完）

cd server && bun run tsc --noEmit            # exit 0
bunx biome check server/src/billing/cleanup-relations.ts \
                  server/tests/cleanup-relations.integration.test.ts
# → Checked 2 files, no errors, no fixes pending
```

净库声明：七件套件在 `openbot_b5r_fix4_final`（全新库）一次性跑完，未复用；无 dry-run 计数漂移。作为对照，`cleanup-relations` 单件在 `openbot_b5r_fix4_suite`（全新库）15/15 pass 409 expect。

对基线的增量：base `465486a0c` 以**相同七件列名**于净库同口径重跑得 **76 pass / 0 fail / 1077 expect**（本复跑为 FIX-6 波按 OCR2R-M3 执行，库/目录名如实记录当时资源：`openbot_b5r_fix6_base`；方法：`git worktree add /tmp/fix6-base-wt 465486a0c`，node_modules 符号链接自主 checkout，`cd server && bun test <七件列名>`）。FIX-4 树 = 76 基线 + 1 新用例 = 77 pass / 1129 expect；FIX-6 树（account_key 形状判定 + 漂移臂）= 78 pass / 1155 expect，同口径链条闭合。

## 5. 风险与边界披露

- `funding_of_protected_key` 是新增 `ProtectionKind` 成员；消费面双向核（FIX-6/OCR2R-M2）：(a) tsc 与全仓检索确认无对 ProtectionKind 的穷举 switch 消费者；(b) 检索（`rg`，`server/src` + `app/src`）确认无以 protection kind 为键的 reason/展示 Record 映射——dry-run 的 `pulledCandidates.byReason` 以 `RemovalReason`（非 ProtectionKind）为键，relations evidence 串与守卫拒删文案均把原始 kind 字符串直接透传。FIX-6 已在 R2B-F1 用例补断言：被庇护资金行的守卫拒删 `evidence` 含 `funding_of_protected_key`（dry-run 哈希覆盖的 relations evidence 同源），无外部破坏性。
- 资金行庇护以 0163 行上的 `external_customer_id` 为准：映射行的 `external_customer_id` 即公司键。三个资金表均逐表核实了归属列（`credit_grants.external_customer_id`、`credit_ledger.external_customer_id`、`credit_reservations.external_customer_id` 存在于 schema 与本表 probe spec）。
- 隔离账户键的资金行同样受保护（失败关闭方向，与 AC18「公司金融史保留」一致）；未知形状账户 fail-closed 后其键资金亦受保护，符合「unreadable ownership cannot be evidence for deletion」（源码审读结论；直接断言缺口见 §2 末注，补臂已登记后续票）。
- R2B-INFO-2（三个 0163 表全扫）的扫描成本延续到资金三表——沿用既有 `scanReachableTable` 全扫模式，量级不变。

## 6. 交付物

| 产物 | 位置 |
|---|---|
| 产品修复 + 注释纠偏 | `server/src/billing/cleanup-relations.ts`（+49/-8 净行，含新 ProtectionKind 与资金庇护段） |
| 回归测试 | `server/tests/cleanup-relations.integration.test.ts`（+422 行，第三个 describe） |
| 本报告 | 本文件 |
| 提交 | `1123786563/b5r-fix2` 上接续提交，未 push |
| 测试库 | `openbot_b5r_fix4_red/redcheck/suite/green/final` 于交付后由协调器裁决处置（保留备查） |
