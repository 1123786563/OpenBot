# MT111 / Issue #154 — 已启用集成的隔离与账户路由证据清单

日期：2026-10-22。交付工作区：mt20（未提交树）。机器可读事实源：
`server/src/enterprise/tenancy/integration-evidence.ts`（INTEGRATION_EVIDENCE
registry，本文件的人类可读投影；两者一致性由
`server/tests/multitenancy/integration-evidence.test.ts` 钉死——每条
basisRefs 指向的文件必须真实存在，引用编造不了）。

## 分类口径（三类闭集）

| 类别 | 语义 | 判定依据 |
| --- | --- | --- |
| 已启用并验证 | 隔离与付款账户路由各有仓内确定性/真实测试证据，且**无需供应商侧即可完整验证**（本仓自有的存储/隔离面） | basisRefs 指向真实测试 + 真实 seam |
| 已启用未验证 | 隔离与路由有**本地确定性**证据；供应商半边缺外部凭据未验证（AC3 的显式标记态） | basisRefs 指向本地测试；note 显式声明未验证 |
| 未落地 | 只有配置键映射或设计，配置面无消费者、无证据 | 键映射存在 + 消费者缺席 |

防伪造守卫：整张清单**零供应商已验证声明**（`isVendorClaimPresent` 全空）；
本测试环境没有供应商凭据，任何此类声明都算编造。

## 证据清单（与 MT001 externalDependencies 逐条对齐）

### 已启用并验证（4 项，全部为仓内可完整验证的存储面）

| 依赖 | 隔离/路由证据 | 付款账户路由 |
| --- | --- | --- |
| PostgreSQL（主库） | rls-core.test.ts（核心表 RLS+FORCE，真实库） | n/a |
| PostgreSQL（企业目录库） | connections.ts 能力核验 + rls-core.test.ts | n/a |
| PostgreSQL（企业数据库） | bots-ownership / conversations-list 等套件（真实 RLS） | n/a |
| PostgreSQL（租户运行时库） | conversations/store.ts + conversation-messages.test.ts | n/a |

### 已启用未验证（15 项：本地证据在，供应商半边缺凭据未验证）

| 依赖 | 本地隔离/路由证据 | 付款账户路由 | 负责票 |
| --- | --- | --- | --- |
| Opik 观测后端 | scope.ts 签发弱集 + opik-control-plane-auth / opik-bindings + **MT110 observability-authz（本轮）** | n/a | MT110 |
| Bifrost 模型网关 | gateway-credential / gateway-customer-provisioning + payer-accounts | **per-company**（公司↔Customer 映射） | MT069 |
| Lago 计费 | billing-lago-client + payer-accounts + settlement-idempotency | **per-company** | MT069 |
| 支付宝 | payment-alipay + payment-callback-ownership（回调按原记录解析付款账户，MT072 面） | deployment-key | MT072 |
| 微信支付 | payment-wechat + payment-callback-ownership | deployment-key | MT072 |
| Composio 应用目录 | composio-transport / composio-access + credential-lease | n/a | MT031 |
| OpenConnector | openconnector-transport / openconnector-access | n/a | MT031 |
| GitHub App | config-github-app + identity-github-callback | n/a | MT026 |
| Google OAuth | google-oauth-transport + oauth-state（state 绑定） | n/a | MT028 |
| agent-computer 服务 | computer-gateway + computer-allocation | n/a | MT046 |
| computer 基础设施 | computer-provider + computer-session-guard | n/a | MT046 |
| 代码沙箱 | codesandbox-gateway / codesandbox-client | n/a | MT046 |
| Redis（workshop 总线与锁） | workshop-bus / workshop-locks（本地确定性） | n/a | MT057 |
| Intelligence 运行时 | intelligence-authentication | n/a | MT050 |
| CopilotKit Runtime | copilot + copilot-usage-meter（用量按付款账户计量） | deployment-key | MT049 |
| 受管 Agent（AG-UI） | agent-adapters + runs-protocol（归属面） | n/a | MT049 |

### 未落地（3 项：键映射存在、配置面无消费者）

| 依赖 | 状态 |
| --- | --- |
| SMTP 邮件 | EXTERNAL_DEPS 有映射，仓内无任何 SMTP_* 读取 |
| AWS SES | 同上（SES_*） |
| AWS SNS | 同上（SNS_*） |

## MT001 清单回写（本轮增量）

1. **Opik 观测后端入列**：`CONFIG_SOURCES` 增加
   `src/ai-observability/config.ts`，`EXTERNAL_DEPS` 增加 `OPIK_` →
   「Opik 观测后端」（agent-runtime 闭环）。此前共享观测后端对 MT001
   清单不可见——父 Spec §8 点名的实际启用集成不在清单上。
2. **租户运行时库前缀修正**：`TENANT_STORAGE_RUNTIME_DATABASE_URL` →
   `OPENBOT_TENANT_STORAGE_RUNTIME_DATABASE_URL`（config.ts 的真实键名；
   原前缀永远匹配不到任何键，该依赖从未物化过）。

回写后 MT001 提取器物化 18 项依赖；registry 与清单互为闭集
（unmatched 两侧皆空，测试钉死）。

### 已知提取缺口（extraction-gap，如实披露）

- **Bifrost 模型网关**：键经 `gateway/endpoint-config.ts` 常量导出
  （`GATEWAY_URL_VARIABLE`）而非 `environment.*` 直读，提取器模式不可见。
- **Google OAuth**：键经 better-auth 装配（`src/index.ts` 的 process.env
  直读），同上。

两项都在 registry 里以 `inventoryVisibility: "extraction-gap"` 登记，
就绪闸单独披露（`extractionGaps`）；修提取器属 MT001 工具自己的后续
维护，不在本票扩。

## 就绪结论（AC4）

`integrationEvidenceReadiness()`：**ready = false**。阻断项 = 全部 15 项
enabled-unverified + 3 项 not-implemented（完整 blockers 列表即上表）。
未验证项阻断 MT130 就绪——MT129/MT130 的就绪检查消费本面；供应商半边
取得凭据并验证后逐项升级为 enabled-verified，blockers 清空才可能
ready=true。

## 边界

- 本票产出证据与状态，不新增集成功能；分类只认仓内可复核事实。
- 供应商半边（真实 Lago/Opik/Composio/沙箱/网关实例调用）在无凭据环境
  不可验证；`*.integration.test.ts` 的存在不等于供应商验证已完成。
- 本文档与 registry 由测试对账（存在性 + 三类闭集 + 未验证显式标记），
  两者漂移即测试失败。
