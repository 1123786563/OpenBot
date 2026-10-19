# [mt-M3] 批次核验报告：#83、#85、#111、#115、#117（MT040/42/68/72/74）

批次：[mt-M3]，worktree `1123786563/mt011` @ HEAD `3ca32d49`。日期：2026-10-19。
零代码改动（`git status` 仅本报告未跟踪；本报告覆盖上一批 [mt-M2] 报告，票号见标题）。

**注意（协调器元数据漂移）**：批次说明把 #111 写作“MT037 对象存储归属迁移（注意与 #161/#162 线关系）”，但 `gh issue view 111` 实际票面是 **[M] MT068 清理、保留与恢复带可核验归属与不可伪造 manifest**（Epic #199 OpenMuse 个人域）。本报告以票面正文为准处理；#161/#162 关系不适用于本票。

## 结论速览

| 票 | MT | 结论 | 一句话 |
|---|---|---|---|
| #83 | MT040 | **BLOCKED-GAP** | 学习容器/研究/演示记录的多租户隔离完全未实施 |
| #85 | MT042 | **SATISFIED（零改动）** | `scan-executor.test.ts` 15/15 全绿，AC1–4 逐条实证 |
| #111 | MT068 | **BLOCKED-GAP** | §9 单用户删除轨道在，但签名/审计/归属锚定缺失 |
| #115 | MT072 | **SATISFIED（零改动）** | 付款账户解析四条 AC 由账务域等价交付全量实证 |
| #117 | MT074 | **SATISFIED（零改动）** | “映射不搬余额”设计交付全部 AC 性质，等价测试全绿 |

---

## #85 [J] MT042 全局扫描只有调度权 —— SATISFIED（零改动）

**路径漂移**：票面 `server/tests/multitenancy/scanner-scope.test.ts` 不存在；实际落地 `server/tests/multitenancy/scan-executor.test.ts`（文件头第 2 行明确 "MT042（Issue #85）"），源模块 `server/src/enterprise/runs/scan-executor.ts`，迁移 `MT042` 在 `server/scripts/multitenancy/migrate-test.ts:1626`（job_ownership 的 operator 扫描臂读策略，app.scan_sweep 上下文门控）。均已在 main（git tracked；worktree HEAD 含这些交付）。

**依赖核验**：Blocked by #84（MT041）已在 main——`job-ownership.test.ts` 23/23 pass。

### AC 逐条实证（scan-executor.test.ts 六个 describe，15/15 pass / 0 fail / 0 skip）

| AC | 用例组 | 实证 |
|---|---|---|
| 1. 扫描器列出跨公司到期任务但不读业务内容 | `AC1: the scan lists due jobs across companies as metadata, never business content` | 平台连接元数据认领 work_items，SELECT 不含 payload 列 |
| 2. 每项执行前从持久化记录重建 Scope，队列消息字段不信任 | `AC2: the scope is rebuilt from the persisted record; message fields are hints only` | 先读 job_ownership 权威行，再经真实签发入口 createScopeResolver(entrypoint="schedule") |
| 3. 机器身份不获得 dev-local-user/普通用户权限 | `AC3: the machine identity is type-isolated from user identities` | 机器 Scope 与用户 Scope 类型隔离，尝试即拒 |
| 4. 反序列化 Scope 被拒，只有签发入口有效 | `AC4: only the issuance entry produces a valid scope; deserialization is refused` | 与 MT005 scope-gate 共用实现（票面备注要求），结构≠信任 |
| （附加）撤销语义 | `revocation and malformed input (machine semantics)` | 成员资格撤销后执行被拒 |
| （附加）租约纪律 | `execution and lease discipline (MT041 consumption)` | MT041 claim/finish/release 消费 |

### 命令与输出

```sh
source /tmp/mt011-env.sh
bun test ./server/tests/multitenancy/job-ownership.test.ts    # 23 pass / 0 fail
bun test ./server/tests/multitenancy/scan-executor.test.ts    # 15 pass / 0 fail / 0 skip
```

（scan-executor 依赖字母序在前套件先落迁移的既有顺序耦合：单跑前先用 migrate-test 幂等 apply 了 MT012/MT014/MT041/MT042，见环境节。）

---

## #115 [N] MT072 支付回调/outbox/对账从原记录解析付款账户 —— SATISFIED（零改动）

**路径漂移**：票面 `server/tests/multitenancy/payer-resolution.test.ts` 不存在。等价交付是账务域（BP 计划）的付款归属族：`payer.ts`/`payer-legacy.ts`/`payer-company.ts`/`payer-personal.ts`/`payments/service.ts`/`usage-outbox.ts`/`reconcile.ts` + 各自测试。核心语义钉在 `server/src/billing/payments/service.ts`（PlanCreditGrantor seam 注释）：“账户 key 由 SERVICE 从订单自身 `ownerPayerRef` 派生，绝非部署默认 key、绝非任何投递载荷携带的东西（10.2：回调的发放跟随订单归属）”。

**依赖核验**：Blocked by #113（MT070 billing_call_attributions）已在 main（迁移在册，settlement-idempotency 消费）。

### AC 逐条实证

| AC | 证据（全绿） |
|---|---|
| 1. 回调体伪造公司/账户字段被忽略；账户来自原记录 | `order-ownership.integration.test.ts` 10 pass（PayerRef 插入时服务端绑定，never a request field）；`payer-company-resolution.test.ts`+`payer-personal-resolution.test.ts` 18 pass（伪造 tenantId/companyId 到不了解析答案，scope 缺失/手造/克隆一律拒）；`multitenancy/vendor-billing.test.ts` 22 pass（跨公司供应商回调拒绝，归属只从唯一映射解析） |
| 2. 重复事件不产生重复发放/结算/激活 | `payment-service.test.ts` 70 pass（幂等激活、duplicate_paid、plan:<orderId> 幂等键）；`qa-batch1-duplicate-paid.integration.test.ts` 1 pass（真实 SQL 顺序下顺序双付：B 保持 paid、被挡出激活、带 durable duplicate_paid 证据）；`billing-webhook.test.ts` 31 pass；`multitenancy/settlement-idempotency.test.ts`（MT071）15 pass（含真并发终态化恰入账一次） |
| 3. 无法解析账户的事件被隔离+运维可见，不落默认账户 | `payer.ts` unknown_owner 隔离（payerKey/createPayerAccount 拒绝该 kind，无收费路径可达）；needs_resolution 终态（drizzle 0161 + BP03 #371，payment-service.test.ts:1868 断言）；`payer-no-fallback.test.ts` 28 pass（不足额=点名账户类型的拒绝，绝不二次解析/换账户/落部署订阅） |
| 4. 对账结果按账户分域 | `reconcile.ts` 不变量 1（每个 applied 订单必须有归属其**自身账户**的存活投影行，10.3/AC14）+ 不变量 2（按 customer 的 Σ grants.used == Σ ledger.applied）；`billing-reconcile.integration.test.ts` 28 pass |

### 命令与输出

```sh
source /tmp/mt011-env.sh
bun test  ./server/tests/order-ownership.integration.test.ts            # 10 pass
bun test  ./server/tests/qa-batch1-duplicate-paid.integration.test.ts    # 1 pass
bun test  ./server/tests/billing-reconcile.integration.test.ts           # 28 pass (147s)
bun test  ./server/tests/billing-usage-outbox.integration.test.ts        # 12 pass
bun test  ./server/tests/billing-webhook.test.ts                         # 31 pass
bun test  ./server/tests/multitenancy/settlement-idempotency.test.ts     # 15 pass
bun test  ./server/tests/payer-no-fallback.test.ts                       # 28 pass
bun test  ./server/tests/payer-personal-resolution.integration.test.ts   # 8 pass（bun 层，driven 清单内）
bunx e2e run --config e2e.unit.config.ts server/tests/payment-service.test.ts server/tests/payer-company-resolution.test.ts server/tests/payer-personal-resolution.test.ts   # 70 + 18 pass（原生层）
```

两层制说明：`payment-service`/`payer-*-resolution.test.ts` 走 e2e-compat（module.registerHooks），bun 层跑不动，按 ADR 0008 用原生层单文件收集，全绿。

---

## #117 [N] MT074 历史余额只迁一次到原有公司，个人 Bifrost 路径不变 —— SATISFIED（零改动）

**路径漂移**：票面 `server/tests/multitenancy/balance-migration.test.ts` 不存在。等价交付是账务域 02.2 遗留归属迁移：`server/src/billing/payer-legacy.ts` + `payer-legacy-mapping.integration.test.ts`。

**设计重构（记录在代码头注释，属已批准账务计划的决策）**：“迁移”交付为**写一次的归属映射，不搬余额**——payer-legacy 明确声明 “从不删除/改写遗留记录、从不建 grant/ledger 行、从不把余额搬到个人或公司账户；只写 payer_accounts 行”，归属只与正向派生的 key 比对（部署自身 claimed id + 公司目录实际持有的 tenant id），绝不从 key 形状或用户身份猜 kind。这比字面“搬一次”更强：不存在重复入账或复制到个人账户的路径。

**依赖核验**：Blocked by #112（MT069）已在 main（`payer-accounts.test.ts` = MT069，22 用例族）；#46（MT003 迁移工具）已在 main（`migration-tool.test.ts`）。

### AC 逐条实证

| AC | 证据（全绿） |
|---|---|
| 1. 迁移幂等：重复执行不重复入账/复制到个人 | `payer-legacy-mapping.integration.test.ts` 7 pass：`the first run classifies every key exactly once and touches no money row` + `a second run adds no mapping and rewrites no classification`（already_mapped 跳过，永不重分类） |
| 2. 无法判断类型→隔离清单+阻断启用，不按用户身份猜 | 同套件 `unknown_owner records are quarantined: auditable, never consumable`：审计读得到隔离行、写路径（payerKey/createPayerAccount）拒绝该 kind，无任何收费路径可达 |
| 3. 个人 Bifrost 直连路径回归未变 | `payer-no-fallback.test.ts` 28 pass（一次请求一个 payer，绝不切换账户/落部署订阅；进程恢复从持久映射重建）；`payer-personal-resolution(.integration).test.ts` 18+8 pass；`multitenancy/settlement-idempotency.test.ts` 15 pass（AC2 明写“归属预扣 × **个人直连对照**”） |
| 4. 总额守恒+对账证据 | 迁移本身零 money row 触碰（守恒结构性成立）；`payer-account.integration.test.ts` 11 pass（subject↔key 双向唯一）；`billing-reconcile.integration.test.ts` 28 pass（逐 customer 的 grants/ledger 恒等式审计） |

### 命令与输出

```sh
source /tmp/mt011-env.sh
bun test ./server/tests/payer-legacy-mapping.integration.test.ts   # 7 pass
bun test ./server/tests/payer-account.integration.test.ts          # 11 pass
# 个人路径回归命令见 #115 节
```

（注：票面“Bifrost 个人路径回归套件”的 Bifrost-5 仓库检出不在本 worktree（`bifrost/` 目录为空），其 OpenBot 侧接缝——bot-services 凭据/准入与 credits-writer 余额行为——由上列 payer/personal/settlement 套件钉死。）

---

## #83 [I] MT040 学习容器、研究与演示记录隔离 —— BLOCKED-GAP

**核验过程（先按“已含等价实现”纪律排查，全部落空）**：
- `grep MT040|Issue #83` 于 server/tests、server/src/enterprise、server/scripts/multitenancy：**零命中**。迁移注册表（migrate-test.ts）无 MT040 条目；enterprise/tenancy 无 learning 相关模块。
- schema 现状：`server/src/db/schema/learning.ts`（learningSettings 全局、learningThreadBindings 仅 userId+containerId）与 `demonstrations.ts`（ownerUserId+botId）——**无任何公司/团队归属列，也不在 enterprise_resources 注册体系内**。
- learning 域代码（`server/src/learning/ensure-container.ts`、`routes.ts`）是部署级 Intelligence 项目容器管理（admin 面），`demonstrations/store.ts` 纯 ownerUserId 过滤。`inventory.ts` 仅把 /api/admin/learning 归类为 agent-runtime 入口，无隔离实现。

**缺口（每条都需迁移+服务判定+接线+专门测试，远超 20 行）**：
1. 容器分配记录归属 + 回收清理后才能跨范围复用（现为部署级单容器，无归属/回收语义）。
2. 研究与演示记录按公司/团队范围可见性（现为个人 owner 级）。
3. 外部学习服务（Intelligence）调用命名空间/路径按归属隔离且不含明文凭据（现为部署凭据 + project slug 全局）。
4. 撤销访问后运行中学习任务在下一敏感动作失败/取消（fence 机制不存在）。

依赖（#79 MT036、#57 MT014）均已在 main，不阻塞开工；建议专项派发（预计一张独立票的工作量：迁移 + tenancy 模块 + learning/demonstrations 接线 + multitenancy 测试）。

## #111 [M] MT068 清理、保留与恢复带不可伪造 manifest —— BLOCKED-GAP

**核验过程**：
- 票面 `server/tests/multitenancy/purge-restore.test.ts` 不存在；`grep MT068|Issue #111` 唯一命中是 `deletion-semantics.test.ts` / `deletion-semantics.ts`（MT067/#110），且两处**明确把物理 purge 划给 MT068 未实施**（“physical purge belongs to MT068”、“失效证据落在生产门上…根记录行归 MT068 purge 面”）。
- 账务域的 `cleanup-manifest/cleanup-dry-run/cleanup-execution` 家族是 legacy billing 清点（group 21.x），域不对口（MT068 是 OpenMuse 个人域的外部资源 purge/retention/restore）。
- §9 单用户账号删除轨道**已存在**：`server/src/openmuse-deletion/`（manifest/purge/purge-connectors/purge-relational/retention/restore/fence/store）+ `server/tests/openmuse-deletion.test.ts`。

**已有 vs 缺口**（对照票面四 AC）：
- AC1 服务端生成 manifest ✓（D04：从各模块 §9 seam 枚举，durable 行，无任何路由接受客户端 manifest——结构上拒绝）；**签名/校验 ✗**（全模块无 hmac/signature，manifest 不携带公司/团队归属锚定）。
- AC2 清理只触及 manifest 列出范围 ✓（purge 由 manifest 行驱动，gap 行显式记录）；跨公司维度：当前个人域资源均 owner 级，无公司资源在范围内（结构性满足，但无隔离断言）。
- AC3 restore 只回原范围 ✓（§9 restore 按 userId 围栏解除）。
- AC4 **审计 ✗**（deletion routes 无 recordAuditEvent 接线，只有 marker/report 行）；失败可安全重跑 ✓（retryable_error + 终态行跳过，purge.ts 头注释明证）。

缺口收敛为：manifest 签名/校验机制 + 归属锚定 + 删除路由审计接线 + multitenancy 域 purge-restore 测试。涉及 openmuse-deletion 全家 + 新迁移 + 新测试，远超 20 行，且与 MT067 交付的冻结面耦合，应专项派发而非就地补。

---

## 环境与复现（容器保留未删）

- 容器 `orca-all-mt011-pg`（pgvector/pg17，5562）。**票面 `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5562/mt011` 不可用**：(a) 超户名是 `enterprise_setup`（镜像 POSTGRES_USER 覆盖了 postgres）；(b) 库名 `mt011` 不过 `enterprise-database.ts:188` 的 `/^openbot_enterprise_/` 门禁，MT 族探针整套 skip。沿用前批配方 `/tmp/mt011-env.sh`（指向 `openbot_enterprise_mt011`）。
- **修复了一处环境漂移**：`ent_mt011_{dir,data,oper}_login` 三个受限角色密码与 env 文件不符（宿主侧 28P01；容器内 psql 走 localhost trust 规则验不出来）。以超户 ALTER ROLE 重置为 env 文件文档值——与 [mt-M1] 批同款修复路径。
- **任务迁移补齐（幂等 apply，经 /tmp bootstrap 调 runMigrateTest）**：MT012/MT014/MT041/MT042（#85 族）、MT069/MT070/MT073/**MT074**（#115/#117 族；注意注册表 MT074 是“波次 16 补位”的供应商计费审计表 billing_vendor_interactions，与票 #117 的 MT074 **撞码但内容无关**）。主 drizzle 链已是 162/162（至 0161_payment_activation_needs_resolution）。
- 顺序耦合照旧：multitenancy 族单文件独跑依赖共享库已被字母序在前套件迁移（本次以 bootstrap 显式补齐规避，未改任何测试代码）。

## 改动文件

**无产品/测试代码改动。** `git status --short` 仅 `?? ORCA-REPORT.md`。临时引导脚本在 /tmp（mt011-bootstrap2/3.ts），不入库。

## 遗留

- #83、#111 两张 BLOCKED-GAP 待协调器专项派发（缺口说明见上）。
- 协调器批次备注中 “#111=MT037 对象存储归属迁移” 与实际票面不符，请修正派发元数据。
- 迁移注册表 MT074 撞码（注册表=供应商计费补位；票面=历史余额迁移）建议后续统一编号，避免歧义。
