# #54（MT011）核验报告 —— 无权对象按不可见处理，错误与计数不泄露存在性

**结论：zero-change-verified（已含实现，逐 AC 复验收尾，零改动）**

## 1. 等价实现定位（票面路径过时，属本仓库系统性常态）

- 票面 Verification 声明 `bun test server/tests/multitenancy/invisible-semantics.test.ts` —— **该文件不存在**。
- 等价实现按域搜索命中：
  - 实现：`server/src/enterprise/tenancy/not-found-semantics.ts`（文件头第 2 行即标注 `MT011（Issue #54）`）
  - 测试：`server/tests/multitenancy/not-found-semantics.test.ts`（文件头即标注 `MT011（Issue #54）：集中式 not-found 不可见语义 + 列表/游标/批量面`）
  - 支撑夹具：`server/tests/multitenancy/support/not-found-semantics.ts`
  - 装配：`server/src/index.ts`（multitenancy 能力通道下纯追加装配段）；`scenarios.ts` 追加隔离域枚举
- 前序交付报告：`archive/plans/multitenancy-execution/reports/MT011.md`（实现报告）+ `MT011-review.md`（独立复审，总裁决 **PASS**，四条验收全部成立，F1/F2 均为低危下游事项不阻断）。

## 2. 逐 AC 核验（票面四条 ↔ 复审报告裁决 ↔ 本区复跑）

| AC | 归档复审裁决（MT011-review.md） | 本工作区复核 |
|---|---|---|
| 1 无权对象返回与不存在一致的响应（状态码/错误体/时延无可区分信号） | A① 成立：五类拒绝（缺失/无权/已删除/跨团队/跨公司）逐例断言 `{"outcome":"deny","code":"RESOURCE_NOT_FOUND"}` 单元素字节集合 + 集中 HTTP 面（404 + `{"error":"RESOURCE_NOT_FOUND"}`）；时延面用确定性语句计数代理（decide 缺失 vs 无权语句数相等，>0 防 0=0 空洞） | 源码在位（`notFoundVerdict`/`notFoundHttpResponse`/`NOT_FOUND_HTTP_STATUS=404`）；复跑 19/0/204 全绿含该套件 |
| 2 列表与计数不包含无权对象；分页游标不因其存在而偏移 | A② 成立：keyset 游标只钉在最后一个可见项，7 可见=4 页精确断言、不可见项不消耗页位、键大于全部可见项的不可见项不制造末页游标、翻页中途软删无移位 | 同上，源码 `createResourceInventoryService`（list/count/游标）在位 |
| 3 批量接口不通过部分成功/失败差异推断存在性 | A③ 成立：混合批量逐 id 输出同一 canonical 条目、无聚合计数、无短路、对不存在 id 照常取锁（语句路径不按存在性分叉） | 同上，`resolveResourceBatch` 在位 |
| 4 语义在授权模块集中实现，各闭环复用（有共享测试） | A④ 成立：canonical 形状/守卫/序列化/HTTP 面只在 not-found-semantics.ts 一处；共享不变量套件把三个冻结闭环（MT008/009/010）全部拒绝钉在 canonical 形状上；列表/批量逐行判定复用 MT008 注册表 | 同上，共享套件（support/not-found-semantics.ts）在位 |

## 3. 本区复验命令与输出

一次性专用容器 `mt-w1-pg`（pgvector/pgvector:pg16，127.0.0.1:55490，trust），库 `openbot_enterprise_mtw1`（openbot_enterprise_ 前缀合规），受限登录 `ent_mtw1_{directory,data,operator}` 各持唯一 capability。制备 = `OPENBOT_BOOTSTRAP_ENTERPRISE_ROLES=on bun scripts/migrate.ts` + `enterprise-test-db.ts provision` + migrate-test.ts 26 任务按序 generate+apply（MT008 步骤 0001 即 `resource_visibility_column`）。

```
$ source /tmp/mt-w1-env.sh && bun test ./server/tests/multitenancy/not-found-semantics.test.ts
 19 pass
 0 fail
 204 expect() calls
Ran 19 tests across 1 file. [412.00ms]
```

与 MT011 实现报告 §3（01-focused-final：19 pass / 0 fail / 0 skip，204 expect）及复审报告独立复跑数字**逐项一致**。

## 4. 零改动证明

- 本票零文件改动（git 本票部分无变更；`server/src/enterprise/tenancy/not-found-semantics.ts`、测试与支撑文件均为 main 既有内容）。
- 无新迁移需求（MT011 报告明示复用既有表与 RLS）。

## 5. 遗留

- 无阻断遗留。复审 F1/F2（低危）属下游接线票事项：路由挂接（HTTP 端到端墙钟）、下游闭环逐字节接线，均为后续消费票范围，不在本票 Scope。
- 环境注记：CI 制备配方（migration-status 489 段）的 `migrate.ts` 单步在当前分支不产生 `enterprise_resources.visibility`（0055 迁移不含该列），必须再跑 migrate-test 任务迁移（MT008）——本报告制备配方已含此步，与该文档"6 个不自举文件"缺陷属同族顺序依赖问题（B 类整改域）。
