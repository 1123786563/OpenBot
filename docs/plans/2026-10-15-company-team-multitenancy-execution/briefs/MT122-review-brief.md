# MT122 独立复审 brief

角色：独立复审者（**只读复审**）。对象：MT122 入站上下文装配域。树=r14-mt122（BASE+240+增量 5 文件）。
- 生产：server/src/enterprise/tenancy/entry-context.ts、server/src/app.ts（M）、server/src/index.ts（M）
- 测试：entry-context.test.ts、support/entry-context.ts
实现报告：archive/plans/multitenancy-execution/reports/MT122.md；证据：archive/plans/multitenancy-execution/checkpoints/MT122/。实现者四任补完（三任报告曾有 6 处「待补」）。

## 必做
1. 三步配方 provision（库名 openbot_enterprise_r14c_*，端口 55573）。
2. 聚焦 entry-context.test.ts（实现者 GREEN-2 21/0）+全量（1011/0/39）+基线复现（990/0/38）。
3. MUT1-5 抽验 ≥3 条重注入+RESTORE（4d33cc1f 字节复原为基准之一，以树内实际哈希为准）。
4. 冻结面核对。
## 专项核对
- **fail-closed 语义**：上下文装配失败（header 缺失/畸形/多租户未启用）时是否一律拒绝而非回退默认租户——这是本票核心安全属性，需在聚焦用例中逐一验证存在性。
- **AC4 证据**：实现报告声称的 AC4（装配面不得泄露租户存在性）证据是否真实。
- app.ts/index.ts 装配改动是否最小（只接入 entry-context，无行为重排）。
- 四任补完质量：三任 6 处「待补」是否全部补齐（对比报告版本演进）。
## 输出
archive/plans/multitenancy-execution/reports/MT122-review.md：verdict+分级 findings；worker_done。
