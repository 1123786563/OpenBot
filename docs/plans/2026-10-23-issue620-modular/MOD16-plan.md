# MOD16 计划（#636：封装插件包安装版本与运行 pin 并复用业务所有者，第四批扩展）

状态：冻结（2026-10-27）。实施基点 `d5ba262c1`（集成 HEAD，MOD23 已并入，checker 基线 649）。载体制裁=Orca 终端会话优先（死亡判据阶梯：Orca→nohup→编排者进程内，落盘纪律入派发 prompt）。

## 0. 侦察事实（编排者已核实 @ `d5ba262c1`，含只读普查代理报告+五项补查）

- **域**：`server/src/enterprise/plugin-packages/` 9 文件+`server/src/plugin-packages/` 3 文件+`server/src/marketplace/` 3 文件（routes/store=包入口，catalogue=纯常量数据源）。Schema 8 表齐备（`db/schema/enterprise-plugin-packages.ts`：installs 唯一键收敛 L122、revisions 不可变、plans、links L349、grants、**run pins L588**、experts 回执、changes 操作记录 L777 仅成功路径）。
- **pin 语义**：写=`runtime.ts prepareWithin`（与 run 行同事务，无 check-then-act 窗口）；读=`readPinnedSkills`（重验 install enabled+grant active；**生产零调用**，runtime.ts L51 自注「delivered, tested, 未接」）；生产链=assembly/runtime.ts:3153-3156→runs/service.ts:283-284→runner.ts:896/936-937。
- **验收①现状**：重复安装收敛**已成立**（HTTP Idempotency-Key→changes 回放 created:false/200；DB 唯一键兜底；REVISION_CONFLICT；存量测 package-install-routes.test.ts:555/672）。**缺口=部分失败零操作记录**（单事务 all-or-nothing 回滚+503，changes 仅成功写入）——系 PKG 业务功能（#459 系），本票钉现状诚实性+登记，**不新建失败台账**（票面「不新增业务功能」）。
- **验收②现状**：install 路径不写 skills/bots 表（install-service L591-690），links/experts 仅存 id+revision。**三越权路径**：(a) experts.ts:404 受限 SQL 函数一事务内直建 Bot；(b) marketplace/routes.ts 旧入口经所有者 store 但直取内件（deps.agents.create/softDelete、deps.skillWrites、deps.grants.grant:240）；(c) tenancy/marketplace-install.ts:561（生产未接线）。(b) 系本票封装主目标；(a)(c) 改道=事务语义行为变化→登记 defer。
- **checker 例外（域相关 34 条）**：32×MOD04（M12↔M02 家族，本票不动）+1×MOD05（marketplace/routes→agents/profile-store）+1×MOD12（marketplace/routes→plugins/store）+1×MOD16（runs/service.ts→plugin-packages/runtime type import L27，exit_condition=M12 建出口+M05 改道）。app 侧 MOD12 例外（app mutations）不属本票。
- **门面能力核对（实施者复核）**：`agents/public.ts` BotCatalog 有 createBot（委托 AgentProfileStore.create 同形）**缺 softDelete**；`plugins/public.ts` ToolAccess（MOD12 交付）**缺 installSkill/uninstallSkill/skillOwner/grant** 四面。MarketplaceDeps 现形（routes.ts:75-92）：`agents?: Pick<AgentProfileStore,"create"|"softDelete">`、`skillWrites?: Pick<PluginStore,"installSkill"|"uninstallSkill"|"skillOwner">`、`grants?: Pick<PluginStore,"grant">`；头部 L3/L6 两条 type import 即环边本体。
- **装配现状**：assembly/http.ts:2349/2353 直注 agentProfileStore/pluginStore；botCatalog 实例在 assembly/runtime.ts:3168-3172；toolAccess 实例化点实施者普查（无现成则装配点构造，按 MOD12 合同）。
- **测试基线**：package 族 native 10 件（artifact 43/catalogue 25/install-routes 26/grants-routes 19/read-routes 16/expert-routes 15/install.integration 1/marketplace-routes 9/multitenancy package-* 6）；manifest 件 tenant-package 57 系 **examples 部署包域名词陷阱，不属本票**。changeVersion/disable/remove 测试零命中（操作未实现，PKG06+）。
- **checker 基线 649/环 56**；server tsc 0。

## 1. 目标形态

### A. M12 窄公开出口（唯一新文件）
- 新建 `server/src/enterprise/plugin-packages/public.ts`：re-export **运行 pin 面**——`createPackageRuntime`+`type PackageRuntime/PreparePackageRunInput/PackageRunPinSnapshot/PinnedSkillSummary`（消费方=runs/service.ts 类型+未来 pin 读取方）。**零判定零缓存零新抽象**；服务面（PackageService 等）无现消费者**不预建**（验收④），装配根 kind=assembly 豁免直取内件。文件头注释写明出口纪律与票面 Produces 缺口归属。

### B. M05 改道（checker 主目标）
- `enterprise/runs/service.ts:27` type import 改道 `../plugin-packages/public`（1 行）→ MOD16 例外 exit_condition 兑现，簿记删 1 条（649→648）。

### C. marketplace 旧入口改走所有者门面（验收②主目标）
- `agents/public.ts`：BotCatalog **+1 delegate** `softDeleteBot`（恒等委托 profileStore.softDelete；命名随 createBot 风）。
- `plugins/public.ts`：ToolAccess **+4 delegate** `installSkill/uninstallSkill/skillOwner/grant`（恒等委托 store 同名函数；docblock 注明 MOD16  marketplace 改道所驱）。
- `marketplace/routes.ts`：MarketplaceDeps 两字段类型改道门面 Pick（agents→`Pick<BotCatalog,"createBot"|"softDeleteBot">`；skillWrites+grants→ToolAccess 对应能力，deps 字段名尽量不动）；调用点改名（:197 create→createBot、:256/:282 softDelete→softDeleteBot、:224/:316/:359 skillOwner、:226/:331 installSkill、:372 uninstallSkill、:240 grant）；头部 L3/L6 import 改道 `../agents/public`/`../plugins/public`。
- `assembly/http.ts:2349/2353`：注入改道门面实例（botCatalog/toolAccess；实例可达性择形由实施者普查后冻结：runtime 装配传出 或 http 就地包装既有 store——**行为零变化**为硬约束）。
- checker 簿记：MOD05+MOD12 两条 server 例外 exit 兑现删除（648→**646**）；环数变化如实登记。
- **等价性硬约束**：marketplace-routes 9 用例两侧对照全绿；委托恒等=行为零变化（门面零新策略）。

### D. 新测试套件 `server/tests/multitenancy/package-lifecycle-boundary.test.ts`（新增全权）
1. D1 出口等价钉（public re-export 与 runtime.ts 源同 identity；恰 5 符号钉）
2. D2 门面委托恒等（softDeleteBot/4 ToolAccess delegate = store 同名函数行为钉：调用转发+参数透传+返回值恒等）
3. D3 验收①钉：重复安装收敛源级钉（幂等唯一索引名+replay created:false 路径存在）；失败诚实性钉（changes 表写入点恰在成功路径=源扫；503 PACKAGE_STORAGE_UNAVAILABLE 合同钉）
4. D4 验收②钉：install 路径零写 skills/bots 表（install-service 源扫钉）；links/experts 仅存 id+revision（schema 形状钉）；experts.ts 直建路径**已知缺口钉**（现状仅 1 处+防扩散：新增直建即红）
5. D5 改道等价（runs/service.ts import 源级钉=恰 1 处且经 public；marketplace/routes.ts 零 profile-store/plugins-store 直 import 源扫钉）
6. D6 存量族两侧对照（package 族 native 10 件+marketplace-routes；BASE=基点树首跑）

## 2. owned_files（冻结——与普查交叉核对后）

- **全权新增**：`server/src/enterprise/plugin-packages/public.ts`；D 套件。
- **受限**：`server/src/enterprise/runs/service.ts`（1 行 import）；`server/src/marketplace/routes.ts`（deps 类型+6 调用点+2 import）；`server/src/agents/public.ts`（+1 delegate）；`server/src/plugins/public.ts`（+4 delegate）；`server/src/assembly/http.ts`（注入 2 点）；`tests/config/module-imports.json`（簿记 −3）。
- **只读（硬边界）**：`plugin-packages/**` 与 `enterprise/plugin-packages/**` 其余全部、`db/schema/**`、`shared/**`、`toolkit/**`、`app/**`、`plugins/store.ts`、`agents/profile-store.ts`、其余 assembly 文件。事实不符→停下上报。

## 3. 验证门

checker **649→646 期望**（−3 例外兑现；环数与类别变化如实登记，违规 0 幻影 0）；server typecheck 0；D 全部根入口（`./node_modules/.bin/e2e run --config e2e.unit.config.ts <file>`）；marketplace-routes 9+package 族 native 件两侧对照（BASE=基点树或 /tmp 独立 detached）；biome 我方零新增；审计两侧对照（native+1、**committed manifest 零 hunk 为门**，MOD22 裁决口径）；复跑独立落盘 `reports/mod16-verification/`（含 commands.md 复现台账）。

## 4. 验收映射

①→D3+存量 201/200 用例对照（部分失败操作记录缺口=登记 PKG 业务票）；②→C+D4（experts/tenancy 两路径=登记 defer）。

## 5. 登记节（报告必含）

changeVersion/disable/remove 零实现（interface-contracts L50 六动作缺三，PKG06+）；部分失败操作记录缺口；experts.ts:404 直建 Bot（事务语义 defer）；tenancy/marketplace-install.ts 未接线；plugin-packages/catalogue.ts→enterprise/contracts 结构倒挂；expert_installs 归属偏差（catalog 称 M12，实际 marketplace/store 自写）；readPinnedSkills 生产未接线（runtime.ts L51 自注）；tenant-package 名词陷阱声明。
