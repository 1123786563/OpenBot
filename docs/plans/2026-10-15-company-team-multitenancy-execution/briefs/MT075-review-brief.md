# MT075 / Issue #118 独立复审 Brief — coordinator 下发

你是 MT075 的独立复审者（全新 Pi 会话）。只读被审文件；唯一新建 = archive/plans/multitenancy-execution/reports/MT075-review.md；不修复；无提交/推送/合并授权；skipped 不算通过。完成 worker_done 附 --report-path。

## 审阅对象（工作树 = 前置 36 项 + 本票 5 交付）

新 3：`admin-separation.ts`（分类规则表 platform 47/company 4 + 双面判定：平台面拒公司管理员、公司面要求平台身份显式三维绑定授权 + 受限 operator + 真实 RLS 审计写入）、`admin-separation.test.ts`（25 用例）、`support/admin-separation.ts`。
编辑 2（声称授权扩展 + 哈希证明）：`inventory.ts`（分类回写 MT001 清单，summary.managementPlanes，digest e517f743）、`workspace-scope-routes.ts`（MT001 装配盲区闭合：workspace-scope 5 入口纳入清单）。workspace-admin.ts/index.ts 声称零改动（before/after 佐证）。
注意：实现树基线（334）与本树（363，含并行 MT010/MT014 交付）不同为并行票所致，非缺陷。

## 重点裁决

- **A. 分类完备性与真实性**：platform 47/company 4 的清单是否与实际管理入口面对账（独立枚举核对）；workspace-scope 5 入口盲区闭合的 routes 元数据改动语义。
- **B. 双面判定语义**：平台面拒绝公司管理员（错误码不泄露）；公司面平台身份「显式三维绑定授权」（受众/动作/范围）+ 审计五要素；fail-closed（未分类入口默认拒）。
- **C. 审计通道**：经受限 operator + 真实 RLS（复用 MT007 先例还是新开面）；无旁路。
- **D. inventory.ts 回写**：digest 变化是否只含分类数据（无行为改动）；MT001 清单完整性。
- **E. workspace-scope-routes.ts 改动**：逐行 diff——是否纯元数据/标注（不改路由行为）。
- **F. 实现者披露核验**：①「config.test.ts 存在 1 例与本票无关既有失败」——**独立核验**：在本树跑 `bun --no-env-file test tests/config.test.ts`（预期 155/0；若复现失败，定位根因并裁定与本票无关性——本树 config.test.ts 为 MT013 集成版亲验过 155/0，若失败需查明是环境性还是真缺陷）；②跨面授权生产执行器属 MT076-079 的范围声明 grep 实证。
- **G. TDD 链与 5/5 变异**；RED-1 模块缺失真实性。

## 独立复跑（亲自执行并记录退出码）

1. 端口预检 55487；容器 mt075-review-pg（pgvector/pgvector:pg16，trust，psql 探针）；五变量 + 随机口令 0600 用后删。
2. base migrate + 按依赖序 apply MT004→MT008→MT112→MT012。
3. `bun test tests/multitenancy/admin-separation.test.ts --timeout 30000`（预期 25/0/0skip）
4. `bun --no-env-file test tests/config.test.ts`（预期 155/0——重点核验 F-①）
5. 全量预期 **388/0/0skip** 15 文件 = 363+25。
6. typecheck；biome 触及文件。CLI：inventory 重新生成 digest 对比 e517f743。
7. 清理容器与凭据。
