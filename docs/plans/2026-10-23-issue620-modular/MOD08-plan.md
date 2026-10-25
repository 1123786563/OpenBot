# MOD08 计划（#628：统一可用模型发现与个人 Bot 模型授权出口，M06 目录部分）

状态：冻结（2026-10-25）。实施基点 `9e6ef2093`（集成 HEAD）。实施 Agent **claude**（用户常任指令，本票为首票）；Brief 全文内嵌。

## 0. 侦察事实（编排者已核实 @ `9e6ef2093`）

- M06 组：`server/src/gateway/`（33 文件 ~14.4k 行：catalog/model-scope/model-capability-filter/capability-availability/key-issuance|expiry|renewal|revocation|state-sync/customer-provision/price-* 等）+ `server/src/bot-services/`（access-grants/registry/auth 等）+ `server/src/enterprise/models/`。
- 75 条 MOD08 环例外（全部「X→M06」入向，主体=billing/*→gateway/{catalog,price-snapshot,conversion-rate,…}），exit_condition 两段式「M06 建立 public/integration 出口并让 M07 改走公开出口」——**本票=出口段**，billing 消费者迁移属后续票。
- **生产路由族真实挂载**：`assembly/http.ts:1423` `createModelSelectionRoutes(requireUser, botServices ?? undefined)`、`:1441` `createModelDiscoveryRoutes(...)`。
- model-scope 组内消费者：admin-routes/model-capability-filter；跨模块（billing/acceptance-matrix）不动。Key 生命周期跨模块消费者：bot-services/access-grants+registry（M06 组内）、billing/personal-key-isolation+acceptance-matrix（M07，不动）。
- 存量测试：catalog-auto-sync/catalog-freshness-gate/catalog-model-ref/key-expiry/key-issuance/key-drift-handling/access-grant-key-status.integration 等。

## 1. 目标形态

### A. `server/src/gateway/public.ts`（新增全权）

`createModelAccessPublic({...})` → 能力级薄委托（capability 名以 interface-contracts 候选为准，pi/claude 证实后冻结）：
- `discoverModels`：真正可用模型发现（可见目录≠可执行——委托 capability-availability/model-capability-filter 现有判定，验收①）；
- `authorizeModel`：个人 Bot 模型授权（委托 model-scope 现有判定，验收②④）；
- Key/Grant 生命周期状态出口（委托 key-expiry/revocation/renewal 与 access-grants 现有读取，验收③）。
硬约束：只 import M06 组内；不 re-export store/Bifrost Customer/Key 同步实现；零新策略；类型经组内签名提取（MOD05/06/07 先例）。

### B. `server/src/gateway/integration.ts`（新增全权）

具名臂：封装 Bifrost Customer/Key 同步实现入口（customer-provision/key-state-sync 一带，实际面以代码为准）——「调用方不直接操纵同步实现」；装配点改经具名臂；内件零改动。

### C. 迁移臂（生产真实）

`model-discovery-routes.ts` 与/或 `model-selection-routes.ts` 的可用模型/授权 handler 改经 A 门面（生产挂载 http.ts :1423/:1441 已核实）；实际迁移面由执行者普查后冻结（消费者普查表入报告，MOD07 惯例）。billing/**、tenancy、agents 不动（第二段登记）。

### D. `server/tests/multitenancy/model-access-public.test.ts`（新增全权）

1. 委托等价（替身同参/同结果/同错误实例）；2. 验收①可见≠可执行（未知价格/上限维持不可用——capability-availability 现状钉）；3. 验收②服务认证≠用户授权（bot-services auth 与 model-scope 分离断言）；4. 验收③Key 过期/撤销/续期维持原用户与授权来源（现状源级钉+存量 key-* 对照）；5. 验收④个人路径与公司业务权限分开（结构断言）；6. 验收⑤不补做 Bifrost 未实现能力（负向断言）；7. 存量 catalog/key 套件 BASE 对照（两侧证据落盘——MOD06 R1-F6）。

## 2. owned_files（冻结）

A/B/D 新增全权；`gateway/model-discovery-routes.ts`、`gateway/model-selection-routes.ts`（受限：handler 经门面）；`assembly/http.ts`/`assembly/runtime.ts`（受限：B 臂装配+挂载传参最小 hunk）；`tests/config/module-imports.json`（预期零 delta）。其余全仓只读（billing/**、enterprise/models/**、tenancy、mastra、db/schema 显式不碰）。事实不符→停下上报；纯类型零运行时最小适配可先行但置顶登记待裁决。

## 3. 验证门

checker 654 零 delta；typecheck 恰 3；审计 26 缺口+607 native（新测试计入）；D 全部根入口；存量 catalog/key 套件两树对照（两侧落盘）；biome 我方文件零新增诊断（BASE 对照行文如实）。

## 4. 验收映射（Issue #628 五条）

①→D2；②→D3；③→D4；④→D5；⑤→D6。75 例出口段=Produces 段兑现；billing 消费者迁移登记第二段。
