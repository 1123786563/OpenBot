# MOD12 计划（#632：集中连接工具与秘密使用的受管动作出口，S6 M08）

状态：冻结（2026-10-26）。实施基点 `a44860553`（集成 HEAD）。实施 Agent claude；Brief 全文内嵌。

## 0. 侦察事实（编排者已核实 @ `a44860553`）

- M08=`server/src/plugins/`（27 文件 25.9k 行：broker.ts/access.ts〔brokerToolkitOf :242〕/tools.ts/store.ts/composio+mcp+openconnector+google-drive-rest 四 Adapter/oauth/shared-use 族/routes.ts…）+ `credentials.ts`（CredentialStore/CredentialSecretReader/CredentialExecutor 族）+ `passwords/`（票面仅「秘密使用部分」，普查证实其面）。
- **MOD12 环例外 74 条**（主体 app 侧 copilot/bot-tools→plugins/{queries,mutations,tool-result} 等）——两段式，消费者迁移属后续票（app 侧非本票 owned）。
- 跨模块（server 侧）消费者：`bot-services/{service-credentials,auth,registry}.ts`、`memory/{routes,ingestion}.ts`、`identity/{store,github-callback}.ts`、`app.ts`——普查冻结处置。
- 工具入口（验收⑤「不能通过直接 broker 调用绕过动作规则」的目标面）：`copilot.ts`、`codesandbox/{gateway,routes}.ts`、`craft/{streaming,approvals}.ts` 等——普查证实实际直调 broker 的入口。
- 存量测试：composio-broker-seam、credential-bundle-boundary、credential-rotation-leak.integration、bot-service-credential-routes、craft-mcp-* 族等（普查补全）。

## 1. 目标形态

### A. `server/src/plugins/public.ts`（新增全权；integration.ts 若 broker/vendor 适配需要则新增，普查裁决）

`ToolAccess` 出口门面（能力面以代码+验收证实后冻结，候选三态）：
- 连接表达三态：`visible` / `connected` / `authorizedExecutable`（验收①分别表达——委托 access.ts/tools.ts/catalogue.ts 现有判定）；
- `prepareAction`（动作准备：资格+环境连接资格分开——验收③）与受管执行入口；
- 秘密读取绑定用途+来源（验收②：不经公共 DTO/模型/普通日志——委托 credentials.ts CredentialSecretReader 现有判定，源级钉零 DTO/日志泄漏）。
硬约束：供应商差异留在 Adapter（验收④零新增 provider/动作）；不暴露 broker 整面与秘密材质；类型经组内签名提取；只 import M08 组内。

### B. 迁移臂（普查先行；验收⑤硬要求）

实际直调 broker/绕过动作规则的**目标工具入口**改经 A：主候选=copilot.ts、craft/{streaming,approvals}.ts、codesandbox/gateway.ts 中实际触 broker 的调用面（普查全表冻结）；bot-services/memory/identity 的 credentials 消费按普查裁决（其面若属「秘密使用」范畴则经门面，否则登记）。app 侧 74 例第二段登记。

### C. `server/tests/multitenancy/tool-access-public.test.ts`（新增全权）

1. 委托等价；2. 验收①三态分别表达（结构断言）；3. 验收②秘密绑定用途/来源+零 DTO/日志泄漏（源级钉+行为断言）；4. 验收③资格分开+撤销阻断（现状钉+存量对照）；5. 验收④供应商差异留 Adapter（负向钉：零新 provider/动作）；6. 验收⑤迁移完整性（直调 broker 入口普查表+迁移后零残留——源级钉）；7. 存量 plugin/credentials 套件两侧对照（双侧落盘、完整命令、复跑独立落盘）。

## 2. owned_files（冻结）

A/C 新增全权（integration.ts 若普查裁决需要）；迁移臂消费者文件（普查后冻结：copilot.ts/craft 侧/codesandbox 侧预期受限 hunk）；`assembly/runtime.ts`/`assembly/http.ts`（受限最小接线）；`tests/config/module-imports.json`（预期零 delta；新边照两段式先例报裁决）；`tests/config/e2e-bun-suites.json`（仅 driven 层时照先例）。其余全仓只读（plugins 内件/broker.ts/credentials.ts/passwords 内件零改动——除非适配必须先上报）。事实不符→停下上报。

## 3. 验证门

checker 658 基线一致；typecheck 0（合并后新基线）；审计 32 缺口零新增（+新测试 native）；D 全部根入口；存量 plugin/credentials 套件两侧对照（双侧落盘）；biome 我方零新增；复跑独立落盘。

## 4. 验收映射

①→C2；②→C3；③→C4；④→C5；⑤→C6。
