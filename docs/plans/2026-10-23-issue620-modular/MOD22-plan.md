# MOD22 计划（#642：让 Craft Workshop 的运行环境与预览各归其责，第五批）

状态：冻结（2026-10-27）。实施基点 `9dd28588d`（集成 HEAD，MOD19 已并入）。载体制裁=Orca 或编排者进程内（按会话死亡判据择形，落盘纪律入派发 prompt）。外部前置 #619 已收口（端口事实源 `config.ts portFromEnvironment`）。

## 0. 侦察事实（编排者已核实 @ `9dd28588d`，含只读普查代理报告）

- **运行/等待面（普查定论）**：craft/workshop **零引用** enterprise/runs——两条自有 turn 引擎（craft=opencode 事件流 turn-state；workshop=store 行+codesandbox StreamingRun）。`runs/public.ts`（MOD07）五能力 start/get/getActiveForThread/cancel/stop 无 waitFor/sweep，**形状与 craft/workshop turn 模型不兼容**。→ 本票**不替换自有引擎**（验收①「流程保持、没有第二份运行终态」=重构不得引入第二终态的负向约束，非替换指令）；「使用 M05」登记为 Adapter 候选后续票。
- **环境面**：craft/routes.ts:201-210 **第二个 `createSandboxGateway` 实例**绕过 MOD11 `handlesFor` 绑定（唯一真收口点；runtime.ts:7079 装配传同一组事实，双实例并存）。workshop 环境消费=装配注入 gatewayFor/clientFor（runtime.ts:6680/6699 已在注入），直 import 全为类型（orchestrator:21 等）——**workshop 环境面现状即注入式，无裸运行时绕过**。
- **Preview 分散面（主交付对象）**：票据（preview-ticket.ts issue/redeem/TTL）、通行证（preview-pass.ts MAC）、Origin 门（preview-origin.ts admission/:871-874 TLS 门/:1043-1128 入口根兑换）、TLS 状态（preview-tls-status.ts）、HMR 解析（webapp-proxy.ts :1386-:1627 四解析器+帧泵）**物理已在 craft/**，但**无单一边界**：`http-server.ts` 内联 preview 主机分派（:106-183）+CSWSH Origin 门（:139-150）+升级分发+socket 泵接线（:263-386）；`runtime.ts` 持 5 段装配（:6940-:7198）。
- **端口（验收④）**：preview-ticket.ts:31 已只消费 `config.ts portFromEnvironment`（#619 单一事实源）——**已满足**，D 负向钉固化（全 craft/ 零第二端口来源）。
- **workshop/preview.ts 未挂载生产**（唯一消费者=workshop-preview.test.ts）——线上 workshop preview=匿名分享路（public-routes.ts）。**本票不挂载**（挂载=新产品行为）；登记。
- **审批**：craft/approval-gate.ts 直用原始 ApprovalStore 系**刻意择形**（runtime.ts:7070-7073 注释：避开 approvalService 的 run 编排副作用）；MOD13 ApprovalsAccess 不接线 craft。登记观察，本票不动。
- **app 面**：craft/workshop 消费已 scoped（MOD19 后：streaming.ts/stream.ts 均经 useStreamScope；queries scoped 半边在）。本票 app 零改动预期。
- **测试基线**：preview 直关族=craft-preview-origin 120/ticket 25/pass 28/rejection 14/webapp-proxy 107/webapp-hmr 43/preview-socket 14/preview-origin-guard 26/workshop-preview 9 + 运行族 turn-state 15/sse-attach 2/idle-reaper 18/snapshot 10/orchestrator 7/headless 5 + 环境族 sandbox-gateway-scope 29/craft-sandbox-public 15。跑法分层：native 走根入口、manifest 件走 bun-suites 驱动（E2E_BUN_ONLY=子串）。**checker 基线 651**（MOD19 后）；server tsc 0；app tsc 63 存量（本票 app 零 hunk 预期）。

## 1. 目标形态

### A. Preview 内部集中（主交付）
- 新增 **craft 组内 Preview 单一内部边界**（候选 `craft/preview/index.ts` 或 `craft/preview.ts`——落点由实施者普查后冻结，照 MOD18 B 臂先例）：票据签发/兑换、Origin admission/TLS 门、HMR 四解析器+Origin 相等判定的**判定与配置消费**收拢为一个 seam。
- `http-server.ts` **退化**为：注入 Preview deps + 单一 dispatch 调用（升级分发/Origin 门的判定体迁入 seam；Bun upgrade/socket 泵的 plumbing 可留）。`runtime.ts` 5 段装配收拢（装配块合并为 Preview seam 构造+注入）。
- **判定逐字节等价**（MOD15 臂先例：搬移不改逻辑；迁移证明=原行移入）。
- **不移文件**（preview-ticket/pass/origin/tls-status 留原位；seam 做委托收拢）——除非实施者证明移动零涟漪，否则保持物理布局。

### B. craft 环境收口（第二网关实例收口）
- `craft/routes.ts:201-210` 自建实例 → 经 MOD11 `craftSandboxPublic.handlesFor(binding)` 取（同实例）；装配侧 runtime.ts:7079 事实传入路径不变。**路由树零新网关事实例**为完成态。

### C. 运行/等待面普查登记（零替换）
- 报告普查表登记：自有引擎保留裁决（形状不兼容证据：runs/public.ts 五能力 vs turn 模型差异）、Adapter 候选清单（入第二段台账）、「没有第二份运行终态」负向钉（D）。

### D. 新测试套件 `server/tests/multitenancy/craft-preview-boundary.test.ts`（新增全权）
1. D1 Preview seam 委托等价（搬迁前后判定行为钉：admission/TLS 门/票据单次/兑换只在入口根/HMR basePath verbatim——抽样既有族断言形状同）
2. D2 验收②负向（Preview 不借主站 cookie 写平台；TLS 不可用=原关闭合同——既有 preview-origin 族断言+新钉）
3. D3 验收③（fetch/HMR/basePath 合同不变——webapp-hmr 族断言+新钉）
4. D4 验收④（端口单一来源源级钉：craft/ 全树仅 portFromEnvironment 一处）
5. D5 B 收口钉（craft 路由树零第二网关事实例：source pin routes.ts 无 createSandboxGateway 直接构造）
6. D6 C 负向（craft/workshop 无第二运行终态写面：源级钉 turn 终态写点恰=既有清单）
7. D7 存量族两侧对照（直关族全量：preview 九套件+运行族六套件+环境族两套件）

## 2. owned_files（冻结——与普查交叉核对后）

`craft/preview.ts`（或 preview/index.ts，新增全权，若 A 择此形）；`http-server.ts`（受限：preview 判定体迁出，plumbing 保留）；`assembly/runtime.ts`（受限：preview 装配 5 段收拢+craft 网关注入改 handlesFor）；`craft/routes.ts`（受限：:201-210 第二网关收口）；`craft/webapp-proxy.ts`（受限：若 HMR 解析器移入 seam）；D 新增全权。其余全仓只读（**workshop/** 零 hunk——环境面现状已注入式+preview 不挂载；app/** 零 hunk；runs/public.ts/craft/public.ts 零改动**）。事实不符→停下上报。

## 3. 验证门

checker **651 基线**（seam 新边若成环须登记例外+逐条理由；预期 0 新增——seam 属 craft 组内）；server typecheck 0；D 全部根入口；**直关测试族两侧对照**（preview 九套件+运行六套件+环境两套件，BASE=基点树/IMPL=同树复跑，分层跑法）；biome 我方零新增；审计两侧对照（native+1、manifest 零 delta，MOD18 同法）；复跑独立落盘。

## 4. 验收映射

①→D6+C 普查；②→D2；③→D3；④→D4；⑤→报告登记节（#358 未完缺陷具名登记，不静默豁免）。
