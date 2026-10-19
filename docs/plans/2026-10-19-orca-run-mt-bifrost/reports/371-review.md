# BP03 / #371 独立 Review 报告

- Reviewer 角色：只读，未修改任何文件（本报告除外）。BASE 与实现者/验证者一致：`0a85bb42`。
- 输入：票面 #371、批准 Spec `docs/specs/2026-10-15-billing-payment-account-and-fulfillment-design.md` §订单、收款与交付、git diff（9 M + 0161.sql + 新集成测试）、实现者报告 371-impl.md、验证者报告 371-validate.md。
- 方法：逐文件读 diff 与新文件全文，重点核验任务指定的风险面（迁移 0161、claimed-owner 过滤、告警误报面、契约翻转授权、`activation_backlog` 与 needs_resolution 的交互）；未复跑测试套件（验证者已独立复跑全绿），仅做静态核对与代码路径追踪。

## 结论 1 — Spec compliance：**通过**（无阻塞项）

三条 AC 与 Spec 语义完整覆盖，证据链真实：

- **AC1（幂等两半恢复）**：单元双向用例（grant 拒写 / stamp 拒写）+ 集成真 PG 下 `plan:<orderId>` 键恰 1 行、payout 恰 1 次、第三 pass 与读侧不变。`replaySafeGrantor` 区分"被问"与"落地"，断言的是幂等契约本身而非实现细节。Spec §3"其中一步成功、另一步失败时只重试未完成项"成立。
- **AC2（处理中+告警；确定性冲突待处置）**：`fulfillmentState` 三态映射正确（paid 未落=processing、applied=delivered、冲突=needs_resolution，未收款 null）；告警加宽后 3 连续未落地 pass 触发恰一次且不重复；冲突单落 needs_resolution、退出 sweep 清单（`listPaidPendingActivationOrders` 既有 `inArray(['pending','failed'])` 天然排除）、不表示完成。Spec §4"不能永远只靠无限重试"落地。
- **AC3（Payer 继承与无周期不发放）**：收款方断言 `openbot-personal-<ownerPayerRef.id>`（订单 Payer 派生）；订阅投影 owner 戳 = 订单 owner；`grant_no_period` 场景下 attempts=0、不 applied。Spec"周期结束依据缺失时不发无限期额度"成立。
- **对账证据**：集成第 3 例对真 reconciler 全库跑，本票订单零 half-finding（missing/owner_mismatch/amount_mismatch/applied_without_subscription/backlog），冲突单唯一 finding=`duplicate_paid_order`。这满足 Spec §3"交付完成的判断必须同时核对订阅权益和本期应发积分，不依赖一次函数调用返回成功"的读侧要求。
- **确定性冲突范围判定：与 Spec 相容**。Spec §4 的 needs_resolution 触发词面是"重复、迟到或落在已被另一订单覆盖的权益周期的收款"——三项全是**收款/权益归属冲突**事实；plan 不存在/非月付/外币是目录规则事实（供应商侧可改正），维持 P1-4"永远重试+3 连败告警"是既有已钉语义，未被 Spec 授权扩入 needs_resolution。实现者的解读与验证者判定一致，我复核维持。
- **qa-batch1 契约翻转：被票面授权**。旧断言"duplicate 仍在 sweep 重试清单"与 AC2 明文"不能无限重试"直接冲突；翻转最小（仅末段 10 行），duplicate_paid 证据可见性断言保留。属执行票面，非规避测试。
- **运营处置出口**（查看证据/授权处置/留最终结果）未在本票实现，归 #373（本票 blocking 它），符合票面 Scope boundary"不实现续期策略"之外的切片划分，非缺口。

一处实现注记（非偏差、不升级）：Spec §3 说交付状态"至少区分 pending、processing、delivered、needs_resolution"，实现把未收款（字面 pending）表达为 `fulfillmentState: null`——收款状态由 `status` 字段承载（两状态独立），null 表示"未欠交付"，语义等价且类型 docblock 已写明。建议在 #373 或账务展示票落地页面语义时把这个映射写进领域词汇表。

## 结论 2 — Code quality：**通过**（无阻塞项）

- **迁移 0161（手写、无 meta snapshot）——维持 P3，不要求集成前修**。判据：仓库迁移应用路径是 `scripts/migrate.ts`（自读 journal+SQL，不依赖 snapshot），验证者在专用库实测前滚成功、CHECK 4 态与两列俱在；票面亦未授权生产迁移。真实风险是"未来修复 drizzle-kit generate 后以 0160_snapshot 为基线产出与 0161 重复的 DDL"——前提本身就是一张基建票，届时必须先回填 0161 基线再生成（见下方归属）。
- **claimed-owner 过滤收紧：正确**。owner = 已 claim 周期的行（applied 落地 / failed 已 claim 未落地，P1-4 既有语义）；needs_resolution 是已裁决落败方，排除正确——否则重放路径会把 duplicate 抬成 owner 造成双发。真 store 两处防护（过滤收紧 + fresh 重读 needs_resolution 返回 unknown）与 memory 双同步，测试替身不漂移。
- **告警加宽误报面：可控**。3 连续 pass（默认 sweep 60s ≈ 3 分钟持续失败）才触发、`(order_id, code)` 业务键幂等恰一行、任何落地/升级清零；<3 pass 的瞬时抖动不触发。`activation_backlog` 审计只看 pending/failed（`!== 'pending' && !== 'failed'` → continue），needs_resolution 不产生 backlog 噪音；`plan_grant_missing` 审计跳过 needs_resolution（不发 grant 正是冲突的正确状态），冲突单由 anomaly→`duplicate_paid_order` 单一入口承接，无双重告警。
- **store/service 边界：干净**。`recordActivationFailure` 是无业务逻辑的单 UPDATE（state 迁移决策留在 service 的 verdict 语义里），`recordActivation(applied)` 无条件清两列正确；`recordActivationFailureQuietly` 吞错有明确注释（best-effort，重试即恢复，收敛方向不变——needs_resolution 落库失败则下轮 sweep 重走 duplicate 分支再落）。
- **测试断言质量：高**。见结论 1 各 AC；另核 `case "duplicate"`（service.ts:1219）属 `settlement.kind` 而非 activateOrder 返回值，返回类型收窄无残留调用方；回调路径 duplicate 只记证据不落态，由下轮 sweep 补落 needs_resolution，收敛一致。
- **验证者 4 项 P3 复核——均不升级**：
  1. 告警 detail 读 sweep 快照原因、滞后一轮：纯诊断文本缺陷，不影响触发与计数；归 BP05/#373 处置界面票（修法：activateOrder 后读回，或删掉该短语）。
  2. 迁移 meta 基线缺口：如上，归基建票（修 generate 时回填 0161）。
  3. 两 JSON 丢末尾换行 + `\uXXXX` 转义 churn：落地提交前顺手补换行（约 30 秒），normalize 归并票顺手做。
  4. personal-credits-read:388 既有红：干净 HEAD 复现，归其契约 owner，非本票。
- **Reviewer 新增观察（非阻塞，均为可选项）**：a) `activationStrikes` 内存 Map 对进入 needs_resolution 后退出清单的订单不清零（残留量级=历史冲突订单数，可忽略，可顺手在 else 分支已覆盖——needs_resolution 返回走 else 已清，实际残留仅限"清单已排除后从未再被扫"的窗口，无行动必要）；b) 新集成测试 afterAll 清理用 `createdBy=prefix` 精确匹配（正确，避开了旧套件 LIKE order_id 的既有陷阱），但未清 `paymentEvents` anomaly 行——prefix 隔离下无碍，可选补一行删除。

## 阻塞清单

无。

## 非阻塞建议与归属

| # | 建议 | 归属 |
|---|---|---|
| 1 | 告警 detail 原因滞后一轮（P3-1） | BP05 / #373 处置与运维可见性票 |
| 2 | 修复 drizzle-kit generate 时先回填 0161 meta 基线，防重复 DDL（P3-2） | 跨票基建票（与上游同步坑同源） |
| 3 | 落地提交前补两 JSON 末尾换行；`\uXXXX` 转义 normalize（P3-3） | 本票落地时顺手 |
| 4 | `fulfillmentState` null↔"未收款 pending" 的映射写进领域词汇表 | #373 或账务展示票 |
| 5 | `needs_resolution` 的人工处置出口（拉回 pending / 人工核销） | #373（票面已排） |
| 6 | 旧套件 `order_id LIKE prefix%` 永不清除的清理缺陷 | 既有跨票基建（实现者遗留 4，未越域正确） |
| 7 | `activationNextRetryAt` 若需指数退避门禁 | 另立票（Spec 未要求，当前记录语义够用） |
