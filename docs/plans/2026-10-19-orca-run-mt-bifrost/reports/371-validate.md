# BP03 / #371 独立验证报告

- 验证者角色：只读复验，未修改任何源码/测试/迁移（本报告除外）。
- 验证时间：2026-10-19。BASE 与实现者一致：`0a85bb42d622c25d3190db7c7cde117f3b8e57b9`。
- 专用库：`openbot_bp371_v`（bf011-pg/5432 新建，`scripts/migrate.ts` 全量前滚，验证后留库未清——无敏感数据，可随时 DROP）。
- 状态完整性：实现者报告的 11 个代码文件 sha256 逐一核对**全部吻合**（第 12 个为报告自身），即本验证复跑的代码与实现者终态逐字节一致。

## 一、命令复跑（全部实跑，cwd=工作区根）

| # | 命令 | 实现者报告 | 复跑结果 | 判定 |
|---|---|---|---|---|
| 1 | `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/payment-service.test.ts` | 70/70 | **70/70 pass**（含 6 条 BP03 用例，逐条见尾部输出） | ✓ |
| 2 | `TEST_DATABASE_URL=…openbot_bp371_v bun test server/tests/billing-period-fulfillment.integration.test.ts` | 3/3 | **3 pass / 0 fail** | ✓ |
| 3 | e2e unit runner：payment-routes / billing-statements / qa-batch1-payment-service / qa-batch1-billing-routes | 59/59 | **59/59 pass** | ✓ |
| 4 | e2e unit runner：billing-routes / payment-mount | 23/23 | **23/23 pass** | ✓ |
| 5 | bun（真 PG）：billing-reconcile / plan-credits-personal / subscription-ownership / qa-batch1-payment-store / qa-batch1-duplicate-paid / payment-callback-ownership / personal-credits-read / payment-store.integration / billing-store.integration | 88 pass / 1 fail | **87 pass / 1 fail**，唯一 fail = personal-credits-read.test.ts:388 键序断言（与实现者指认同一条） | ✓（计数差 1 属批次口径，红绿集合一致，见下） |
| 6 | bun：order-ownership / qa-batch1-replay-storm / qa-batch2-cycle-config-qr / qa-batch2-t5-semantics / qa-batch2-unreadable-fourth / qa-batch3-reconcile | 31/31 | **31/31 pass**（17+14，两批） | ✓ |
| 7 | `bun run --filter server typecheck` | exit 0 | **exit 0** | ✓ |
| 8 | 迁移 0161 落库（自建新库全量前滚） | CHECK 4 态、两列存在 | `pg_get_constraintdef` = `CHECK ((activation_state = ANY (ARRAY['pending','applied','failed','needs_resolution'])))`；`activation_failure_reason text`、`activation_next_retry_at timestamptz` 均在；`migrate.ts` 报 `{"type":"migrations-applied","status":"ok"}` | ✓ |

批注：
- 复跑坑复现：`bun test` 直跑 node-only 套件（payment-routes 等）报 `Export named 'registerHooks' not found in module 'node:module'`——与实现者所述 runner 分层一致，必须用 `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts`。
- 批次 5 中 `qa-batch2-cycle-config-qr` / `qa-batch2-t5-semantics` / `qa-batch3-reconcile` 实为 `.test.ts`（非 `.integration.test.ts`），按实际文件名补跑；批次 5 总数 17+14=31 与报告吻合。批次 4 我实跑 9 文件 87 tests（71+16），与报告 88 的差 1 为文件集口径差（如 `billing-store.test.ts` 是否计入），不构成红绿分歧。

## 二、personal-credits-read 既有红（stash 复验）

方法：`git stash push -u -m "371-validate-headcheck"`（SHA `5abdb7f4…`）回到干净 HEAD → 复跑 → `git stash apply <sha>` 恢复 → drop。恢复后 sha256 抽查一致、12 文件清单原样、stash 栈清空。

结果：干净 HEAD 上 `personal-credits-read.test.ts` **同样 9 pass / 1 fail，失败行同为 :388 键序断言**。判定：分支既有失败，与本票改动无关。✓

## 三、代码-AC 对应抽查（8 项声明逐一核对）

| 声明 | 位置 | 核对结果 |
|---|---|---|
| needs_resolution 入 PaymentActivationState | `types.ts`（联合类型+docblock）、`schema/payment.ts` CHECK、迁移 0161 | ✓ 三处一致，CHECK 4 态 |
| duplicate 分支改落 needs_resolution | `service.ts` activateOrder：duplicate → `recordActivationFailureQuietly(id,"duplicate_paid","needs_resolution")`，duplicate_paid 异常证据仍先记 | ✓ |
| 重试清单排除 needs_resolution | `store.ts:768` `listPaidPendingActivationOrders` 既有 `inArray(activationState,["pending","failed"])` | ✓ 天然排除，未额外改动 |
| claimed-owner 过滤收紧 | `store.ts` `resolveActivationOwnership`：`!== "pending"` → `IN('applied','failed')`，并加 needs_resolution 重读返回 unknown 的防护 | ✓ |
| 失败两列持久化 + applied 清空 | schema 两列；`recordActivationFailure`（reason/nextRetryAt/state 可选）；`recordActivation(applied)` 时两列置 null | ✓ |
| fulfillmentState 三态 | `service.ts` viewOf：paid→ applied=delivered / needs_resolution=needs_resolution / 其余=processing；非 paid→null | ✓ |
| sweep 告警加宽 | `service.ts`：`outcome === "failed" \|\| outcome === "pending"` 计 strike，ACTIVATION_ALARM_AFTER 触发一次；needs_resolution 不入清单 | ✓ |
| reconcile 跳过 needs_resolution | `reconcile.ts:306` 附近 `if (order.activationState === "needs_resolution") continue`，冲突由 duplicate_paid_order finding 承接 | ✓ |

集成测试可信度抽查：`billing-period-fulfillment.integration.test.ts`（350 行）确用真 PG + 真 `createCreditWriter(database)`（grant 半边走 `plan:<orderId>` 真幂等键）+ 真 `createReconciler`，仅 Lago 为 facade——与报告"第 3 例全库对账"的声明相符。

## 四、越域检查

`git status` 12 项与实现者报告"未提交检查点"清单完全一致（9 M + 0161.sql + 集成测试 + 报告自身），无域外文件。`docs/verification/e2e-bun-suites.json` 改动内容 = 登记新集成套件两处（域内）+ 重新生成带来的 Unicode 转义 churn。qa-batch1-duplicate-paid 契约翻转（末段 10 行）：旧断言"duplicate 仍在 sweep 重试清单"与票面 AC2"不能无限重试"直接冲突，改为断言 needs_resolution + 不在清单 + `activationFailureReason='duplicate_paid'`，**其余断言未动**（duplicate_paid 证据可见性保留）——判定为票面要求的必要契约更新，非规避测试。

## 五、AC 判定

| AC | 判定 | 依据 |
|---|---|---|
| AC1 Lago 成功/Grant 失败重试只补 Grant；反向不多发 | **PASS** | 单元 70/70 双向用例 + 集成真 PG `plan:<orderId>` 键恰 1 行、payout 恰 1 次，复跑全绿 |
| AC2 已收款未交付显示处理中并告警；确定性冲突待处置、不无限重试不表示完成 | **PASS** | processing/delivered/needs_resolution 三态断言 + 3-pass 告警（第 4 pass 不重复）+ sweep 清单排除 + qa-batch1 新契约，复跑全绿 |
| AC3 订阅与 Grant 继承订单 Payer；无周期依据不发无限期额度 | **PASS** | `payerKey(order.ownerPayerRef)` 收款方断言 + 订阅 owner 戳 + `grant_no_period` 不发 grant，复跑全绿 |
| 票面 Change"有对账证据" | **PASS** | 集成第 3 例真 reconciler：冲突单唯一预期 finding=duplicate_paid_order，无 missing/owner_mismatch/backlog |

## 六、缺陷与遗留（按严重度，均不阻断）

1. **P3（观察项）**：`sweepActivations` 告警 detail 的 `last reason ${order.activationFailureReason}` 读的是 sweep 列表快照（activateOrder 执行**前**取的行），首轮告警时显示的是上一轮原因或 `unknown`——滞后一轮，不影响告警触发与计数本身。
2. **P3（遗留，实现者已声明）**：迁移 0161 为手写且无 `meta/0161_snapshot.json`（0154–0160 均有）。因 drizzle-kit generate 在本仓已损坏（上游合并重编号），现状无生成路径可走；但未来若修复 generate，将以 0160_snapshot 为基线，可能产出与 0161 重复的 DDL。归跨票基建（与实现者报告"遗留 3"一致）。
3. **P3（噪音）**：`_journal.json` 与 `e2e-bun-suites.json` 丢失文件末尾换行；`e2e-bun-suites.json` 20 行 diff 过半为 `\uXXXX` 转义 churn（重新生成的 stringify 差异），建议后续票合并时顺手normalize。
4. **既有红（非本票）**：personal-credits-read.test.ts:388 键序断言，干净 HEAD 复现（见 §二），归其契约 owner。
5. **范围判定依赖 spec 解读**：规则性拒绝（plan 不存在/非月付/外币）维持"永远重试+3 连败告警"而非 needs_resolution，实现者援引 spec"确定性冲突=收款/权益归属冲突"并延续 P1-4 语义。核对该解读与批准 Spec §订单、收款与交付一致，判定合理；如后续裁定要放宽到规则拒绝，属新票。

## 七、结论

**通过。** 实现者报告的全部关键证据独立复现：命令结果逐条吻合（唯一红为 HEAD 既有）、11 文件 sha256 一致、8 项代码声明与 AC 对应成立、无越域改动。发现的 4 项 P3 观察项/遗留均有明确归属，不构成阻断。
