# 模块化架构 AR01–AR18 全范围证据映射（MOD25 / Issue #645，根 #620）

> 收口级对账工件：每条 AR 给出定义摘要、当前代码/检查点证据载体与读数、覆盖定性（厚/薄/GAP）。
> 基点=集成分支 `d4dc024ed`；MOD25 收口读数=例外 523 / 违规 0 / 幻影 0 / 环 39。
> Run 检查点证据目录在主 checkout `.archive/runs/2026-10-23-issue620-orchestration/checkpoints/mod<NN>-r<k>/`（集成树外，具名引用；MOD01–24 各票审核 r1/r2 存证）。
> 本表只登记既有验证证据，不新增测试；「薄」=有存量载体但缺专项交错/重放级钉（见各行注）。

| AR | 定义摘要 | 证据载体与读数 | 覆盖定性 |
| --- | --- | --- | --- |
| AR01 | 状态写入点唯一所有者 | `server/tests/multitenancy/coverage-governance.test.ts`、`bots-ownership.test.ts`、`company-reservation.test.ts`（预扣唯一写者）、各 `*-public.test.ts` 门面委托等价组；checker 例外簿唯一写入者清单=迁移计划 §模块目录 A01 对账 | 厚 |
| AR02 | 新增依赖无环、跨 Module 只消费出口 | `scripts/check-module-imports.ts`+`tests/config/module-imports.json`：629→523 例外、违规 0、幻影 0、环 45→39（MOD25 P2-B1 后实读，`reports/mod25-verification/g1-new-p3.json`）；M-2 category 枚举校验负向自验在案；140 moduleRoots | 厚 |
| AR03 | 宿主配置/路由顺序/启动拒绝/shutdown 合同 | `server/tests/multitenancy/startup-checks.test.ts`、`assembly-enterprise.test.ts`、`assembly-legacy.test.ts`、`assembly-stream.test.ts`、`entry-context.test.ts`、`global-exception-closure.test.ts`；M-6（启动中段失败回滚窗口）=OCR r2 移交 lifecycle 设计票，未伪装清零 | 厚（M-6 缺口具名移交） |
| AR04 | 目录选择/管理角色不代替资源权限 | `server/tests/multitenancy/observability-authz.test.ts`、`company-admin-routes.test.ts`、`people-lifecycle.test.ts`、`identity-access-public.test.ts`、`team-public-rules.test.ts`、`public-bot-usage.test.ts` | 厚 |
| AR05 | 撤权/目录版本与业务写入按合同串行化 | 存量载体：`identity-access-public.test.ts`（epoch/撤权语义面）、`credential-lease.test.ts`、`cache-keys.test.ts`（迟到结果失效）；**交错双事务/回滚级专项钉少**——计划 §0.5 定性=薄，补写交错集成测试超本票机械范围，登记转后续票 | 薄 |
| AR06 | 同消息键只创建一份输入/Run | `server/tests/multitenancy/conversation-public.test.ts`（30 用例，MOD25 G5 抽件两侧 30/30 绿）、`run-lifecycle-public.test.ts`、`approval-resume-public.test.ts`（25 用例两侧绿，含 resume 单次消费） | 厚 |
| AR07 | 旧 Attempt/generation 不写新运行状态 | `run-lifecycle-public.test.ts`、`credential-lease.test.ts`（代次/租约）、`craft-sandbox-public.test.ts`（复位旧句柄负向，15 用例两侧绿）、`approval-resume-public.test.ts` | 厚 |
| AR08 | 引擎只用受管模型/工具，不直接写账务/消息 | `model-access-public.test.ts`、`model-invocation-budget-public.test.ts`、`agent-adapters.test.ts`（bun 层：两侧同形 15 pass/1 skip/1 fail/1 error，fail 系 BASE 同现环境件）、`voice-billing-seam.test.ts`、`tool-access-public.test.ts`；保留臂=plugin-packages 内件 ASSEMBLY 组合根（计划 §0.4 具名） | 厚 |
| AR09 | token 预算与资金预留双放行才 dispatch | `model-invocation-budget-public.test.ts`、`coverage-billing.test.ts`、`company-reservation.test.ts`（预留×预扣投影） | 厚 |
| AR10 | 未知费用不释放、重放不重扣、Payer 固定 | 存量载体：`billing-entries-public.test.ts`、`server/tests/batch-settlement.integration.test.ts`、`billing-reconcile.integration.test.ts`、`image-settlement.integration.test.ts`（bun 层配置件）、`credit-views.integration.test.ts`、M-4/M-5 收敛后 Payer 解析单源（MOD25 P3）；**provider 终态不明/断流重复通知的交错级重放钉少**——计划 §0.5 定性=薄，转后续票 | 薄 |
| AR11 | 同一批准只驱动一次有效动作 | `approval-resume-public.test.ts`（25 用例两侧绿：决定/恢复/重复消费面）、`tool-access-public.test.ts`、`craft/approval-gate` 族源级钉 | 厚 |
| AR12 | 环境操作在真实传输绑定范围与代次 | `craft-sandbox-public.test.ts`（MOD11 句柄族）、`craft-sandbox-gateway-scope.test.ts`、`craft-session-routes-scope.test.ts`、`web-copilot-scope.test.tsx`（app 层）；真实无 shim 栈=§5 收口后全范围 OCR 相位 | 厚（真实栈复核挂终审相位） |
| AR13 | 预览隔离可交互、端口配置单源 | `craft-preview-boundary.test.ts`（MOD22 A seam）、`craft-port-range-preflight.test.ts`、`craft-webapp-hmr.test.ts`、`craft-preview-origin-guard.test.ts`；#619 场景已由该 Run 各自验收 | 厚 |
| AR14 | 记忆未审核不可用、遗忘/来源撤销立即阻断 | `memory-public.test.ts`、`hindsight-memory-routes.test.ts`、`hindsight-sync-drain.contract.test.ts`、`app/tests/hindsight-sensitive-mutations.test.ts`、`learning-contract-seam.test.ts`（17 用例，MOD23 关闭零构造+快照消费） | 厚 |
| AR15 | 包升级不覆盖在途 pin、卸载保留资产 | `plugin-install.test.ts`、`marketplace-install.test.ts`、`package-lifecycle-boundary.test.ts`（15 用例，MOD16 pin 面）、`server/tests/marketplace-routes.test.ts` | 厚 |
| AR16 | 可选观测关闭不影响普通执行 | `observability-observer-public.test.ts`（26 用例；其中 D6 门面 export 面 1 条两侧同红=MOD17 交付后基线漂移、BASE 同现，登记不伪装）、`observability-authz.test.ts`、`telemetry-attribution.test.ts`、`telemetry-usage.test.ts`；强制审计独立=D4 源级钉在位 | 厚（1 条基线红两侧同形） |
| AR17 | 各端消费者保持自己的 wire 合同 | `mobile-bff-contract-seam.test.ts`（22 用例，MOD21 投影/scope 信任锚）、`conversation-public.test.ts`、`desktop` 六登录流 sign_in seam（MOD16/20；Rust 侧 cargo test 748/751 读数在主 checkout Run 台账——本树不可复跑，如实登记）、`public-bot-profiles.test.ts`；Bifrost 三门零装配=G-1 产品设计缺口（§4 登记），非本票 GAP 伪装 | 厚（cargo/Rust 证据引用 Run 台账；Bifrost 装配=GAP 具名） |
| AR18 | 支付收款与权益交付独立可靠 | `billing-entries-public.test.ts`、`company-payment-records`（billing/payments 路由族，M-4/M-5 收敛两侧绿）、`coverage-billing.test.ts`、`server/tests/payment-callback` 族；历史余额/订单不复制=迁移普查 §0.4 三门面内件保留臂 | 厚 |

## 未迁移 / 不适用 / 真实环境阻塞（票面验收②逐项区分）

- **未迁移（出口未覆盖=收窄不适用）**：148 条可改道集中 42 条符号未被公开出口覆盖（value 33+mixed 5+type-only 4），涉及 `auth/guards(requireAdmin/createRoleRepository)`、`approvals/types(ApprovalGate/ApprovalStore/currentApprovalContext 等)`、`plugins/tools(REFUSAL_MARKER——出口文件具名注释拒绝导出)`、`routines/store(Routine*)`、`channels/routes 1 条`、`agents/profile-store(AgentNotFoundError)`——扩门面=行为合同变化，超本票机械范围（障碍节已登记，等编排者裁决）。VOICE 域（本票实测口径，与计划 §0.2 的 9+7 略异如实更正）：在改道集中的 voice 源 8 条全部经 B1 收窄、例外簿存活 0；存活 VOICE 相关例外 9 条=app 侧 7 条（archive/outbox/use-voice-call/webrtc/websocket → stream-scope/auth/channels 出口未覆盖）+ `server/src/voice/summary.ts` 2 条（→plan-model/titler，不在改道集=出口未覆盖）——均不收。
- **不适用**：445 条 partial（所需符号未上公开出口，扩门面不收）+ 36 条目标模块无公开出口（计划 §0.3，维持登记不处置）；旧出口删除候选=0（三门面内件活消费者、plugin-packages ASSEMBLY 保留臂、readPinnedSkills 测试钉）。
- **真实环境阻塞**：driven/真实 PG 族缺 env 时两侧同形自跳过（MT066 类，G5 对照法）；Bifrost 三门（gateway 装配面）零生产装配=产品设计缺口 G-1，非代码 GAP；`server/src/desktop-telemetry.test.ts` 等桌面联调需 live key，挂 §5 收口后相位。
- **证据在集成树外**：MOD19「死出口四处」登记项的本 Run 证据仅存主 checkout `.archive/runs/2026-10-23-issue620-orchestration/`（checkpoints/、reviews/），集成树不可验证——事实披露，不伪装已核。
- **M-3/M-6/M-7/M-8**：OCR r2 移交四项（日志纪律票 / lifecycle 设计票 / 生产首条接线装配票 / mastra 接线票），原文引用与指派见 MOD25 收口报告 §4 登记节。

## 移交项引用（保持 OCR r2 DAG 原指派）

- M-3 → `server/src/assembly/http.ts` cancel/audit-failed catch 补日志（202 响应不变）→ **M11 后续日志纪律票**
- M-6 → `server/src/assembly/runtime.ts` 启动中段失败回滚窗口（stopRegistered 尾部集中 vs 就近注册）→ **lifecycle 设计票（MOD03 R1-F6 同族）**
- M-7 → `server/src/assembly/runtime.ts` credentialLease 不可达链 + 6 operator 连接池零消费者 → **生产首条接线装配票（MOD04 延后项）**
- M-8 → `server/src/assembly/runtime.ts` mastraContinuationRouteDeps 已构造未挂载（迁移前既有缺口）→ **mastra 接线票（非回归）**
