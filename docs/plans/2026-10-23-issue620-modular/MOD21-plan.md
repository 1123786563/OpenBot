# MOD21 计划（#641：明确 OpenMuse Mobile 与 BFF 的实际合同转译出口，第五批客户端）

状态：冻结（2026-10-27）。实施基点 `592512b6b`（与 MOD20 交付零文件交集，集成序不敏感；集成时落在届时集成 HEAD 上）。载体制裁=Orca 终端会话优先。

## 0. 侦察事实（编排者已核实 @ `592512b6b`，含只读普查代理报告+三项补查）

- **验收⑤存在性核验（合法零命中）**：`server/src/mobile-bff/` 存在且条件启用（assembly/http.ts:2519-2580 装配依赖即开关）；`apps/openmuse` 子模块 .gitmodules 登记**未克隆**（空目录、零 moduleRoot、零例外引用）——验收⑤明示零命中合法，不伪造工作面。
- **OPENMUSE 模块=14 个 moduleRoot**（mobile-bff+openmuse-{tasks,files,mail,calendar,...}，module-imports.json 全 business）。
- **BFF 聚合现状（验收①②③多已满足）**：四路由（/workspace、/conversations、/openmuse-bot、/activity）全为**投影映射零强转**（workspace.ts:102-129 等）；scope 信任锚=服务端 WeakSet 签发器+assertTrustedScope+DB membership 重验（openmuse-voice-mobile-tenancy.ts:780-831，零 token 自证）；`/api/mobile/*` 为 LEGACY_ENTRY registered-exception（「aggregates deployment-scoped stores」assembly-legacy.ts:139-166）；媒体 onError 语义锚 413/409/403/502/503+code 字段（routes.ts:94-128）；G01 回调公共门（http.ts:2604-2605）。
- **checker 例外 16 条触域**（当前基线 646/环 52）：
  - **3 条 MOD21 名下**（出口退出目标）：`agents/openmuse-template-store.ts→mobile-bff/openmuse-bot.ts`（M03→OPENMUSE）、`tenancy/openmuse-task-tenancy.ts→openmuse-tasks/store.ts`（M02→OPENMUSE）、`mastra/openmuse-task-entry.ts→openmuse-tasks/store.ts`（M05→OPENMUSE，type import）。
  - **13 条反向**（OPENMUSE→M0x，ticket=MOD04/05/06/12/14，exit_condition 全为「M0x 建立公开出口并让 OPENMUSE 改走」）：mobile-bff/{routes,workspace,activity,openmuse-bot}.ts → auth/guards(2)/profile-store(4)/profile-types(3)/channels/routes(3)/approvals/service(1)/routines/store(1)。
- **门面盘点**：`agents/public.ts`✓、`approvals/public.ts`✓、`auth/public.ts`✓ 已在；`channels/public.ts`✗、`routines/public.ts`✗（M04/AUTOMATION 出口缺失=择形点）。
- **测试基线**：server/tests/mobile-bff.test.ts（~20 用例，463 行：冷启动/空部署/归档分区/错误合同 409/403/413/502/503）；multitenancy/voice-mobile-bff.test.ts（MT066，573 行 4 describe，真实 PG，缺 env 自跳过）。

## 1. 目标形态

### A. OPENMUSE 窄出口（新文件×2）
- `server/src/openmuse-tasks/public.ts`：恰消费所需 re-export（OpenMuseTaskStep type+运行时面，实施普查冻结）；`server/src/mobile-bff/public.ts`：provisioner 面。零判定零新抽象。

### B. 三条 MOD21 例外退出
- 三消费点各改道公开出口（1-2 行/处）→ 簿记删 3（exit_condition 兑现）。

### C. 反向 13 条改道所有者门面（MOD16 marketplace 先例同形）
- agents(6)/guards(2)/approvals(1) 九条改走既有门面（能力缺口处门面 +identity delegate，恒等转发）。
- channels(3)/routines(1) 四条择形：(a) 新建 `channels/public.ts`+`routines/public.ts`（纯 re-export 既有符号；若需原文件补 export 受限 1-2 行）→ 全清；(b) 符号复杂非纯 re-export→该根例外 defer 登记。**择形结论报告冻结节**，不为清零而造抽象。
- 簿记预期：646→**630**（−16，全部 exit 兑现；环数与翻转变化如实登记——MOB16/MOD23 先例，31 条量级翻转属预期形态）。

### D. 新测试套件 `server/tests/multitenancy/mobile-bff-contract-seam.test.ts`
1. D1 出口等价钉（恰符号 re-export 与源同绑定）
2. D2 验收①钉：BFF workspace 投影面=roster+channels（不触 enterprise workspaces 类型）；readMobileAggregate 独立 scope 查询钉
3. D3 验收②钉：scope 信任锚（WeakSet 签发+assertTrustedScope+DB 重验；零 token 自证源扫）
4. D4 验收③钉：onError 语义锚 413/409/403/502/503+code 保留钉；G01 回调合同钉
5. D5 验收④⑤钉：BA PKCE/handle 零命中源扫；apps/openmuse 空子模块钉（.gitmodules 登记未克隆）
6. D6 改道等价：mobile-bff 四文件零内件直取源扫钉
7. D7 存量族两侧对照（mobile-bff.test.ts ~20+装配面；MT066 缺 env 自跳过两侧同形）

## 2. owned_files（v2 修订 2026-10-27——编排者裁决补列三门面）

**v2 修订事由**：实施普查复认证实 v1 §2 漏列三既有门面——§1.C「能力缺口处门面 +identity delegate」必然要求写 `agents/auth/approvals` 三 public.ts（MOD16 先例同形）。v2 将三者列入受限；委托/类型出口面按下表精确冻结，**零新逻辑**：

- `agents/public.ts`：`BotCatalog` +identity delegate `list`（恒等转发 profileStore.list，mobile workspace 聚合所需）+具名 type re-export `AgentActor`/`AgentProfile`（类型面，零逻辑）。
- `auth/public.ts`：具名 type re-export/守卫面（`AuthenticatedActor`/`AppVariables` 或实施普查实测的最小 guard 类型集，恒等 re-export）。
- `approvals/public.ts`：`ApprovalsAccess` +identity delegate `inbox`（恒等转发 ApprovalService.inbox，activity 聚合所需）。

- **全权新增**：`server/src/openmuse-tasks/public.ts`、`server/src/mobile-bff/public.ts`、`server/src/channels/public.ts`（择形 a 已证实可行：ChannelStore/AgentChannel 具名导出已在）、`server/src/routines/public.ts`（RoutineStore 具名导出已在）、D 套件。
- **受限**：`server/src/mobile-bff/{routes,workspace,activity,openmuse-bot}.ts`（import 改道）、`server/src/openmuse-tasks/store.ts`（若需补 export）、`server/src/mobile-bff/openmuse-bot.ts`（同）、`server/src/agents/openmuse-template-store.ts`（1-2 行改道）、`server/src/enterprise/tenancy/openmuse-task-tenancy.ts`（同）、`server/src/mastra/openmuse-task-entry.ts`（同）、`server/src/agents/public.ts`（v2：+list delegate+2 type re-export）、`server/src/auth/public.ts`（v2：guard 类型面）、`server/src/approvals/public.ts`（v2：+inbox delegate）、`server/src/channels/routes.ts`（补 export 若需）、`server/src/routines/store.ts`（补 export 若需）、`tests/config/module-imports.json`（簿记 −16+翻转如实）、门面钉面套件（若门面计数钉存在则同步，MOD16 先例披露）。
- **只读（硬边界）**：其余 server/**（含 assembly/tenancy 主干/copilot）、app/**、desktop/**、shared/**、toolkit/**。事实不符→停下上报。

## 3. 验证门

checker 646→630 期望（−16；环数/类别翻转如实登记，违规 0 幻影 0）；server typecheck 0；D 全部根入口；mobile-bff 族两侧对照（BASE=派发时基点树）；biome 我方零新增；审计两侧对照（native+1、**committed manifest 零 hunk 为门**）；台账 NEW 列逐件填写（MOD16 R1-F3 教训）；复跑独立落盘 `reports/mod21-verification/`。

## 4. 验收映射

①→D2；②→D3；③→D4；④→D5；⑤→§0 存在性核验+D5+登记（零命中合法）。

## 5. 登记节（报告必含）

apps/openmuse 未克隆现状与「deprecated/replaced by mobile-bff」定性；MT066 存量钉；装配条件启用语义（无显式 flag）；channels/routines 出口择形结论；门面能力缺口清单（若走 defer）；BA 企业 PKCE/handle 零命中声明。
