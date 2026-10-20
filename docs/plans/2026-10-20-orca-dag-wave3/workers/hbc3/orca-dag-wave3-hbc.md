# Orca DAG Wave 3 — hbc 混合域批次报告

- Worktree: `/Users/wuyongjun/orca/workspaces/OpenBot/hbc3`（branch `1123786563/hbc3`，base = main@2306caaa）
- 批次（按序）: #378、#381、#373、#405、#411
- 约束遵守：GitHub 只读；未 commit、未 push；测试库 `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5567/hbc3`（容器 `orca-w3-hbc-pg`，pgvector pg16，roles.sql + 全链迁移已初始化）；未触碰 `docs/plans/` 运行目录、`server/src/mastra/**`、Bifrost 计价维度票。
- 层纪律（ADR 0008）：bun 驱动文件用 `bun test ./<file>`；e2e 原生文件用 `bunx e2e run --config e2e.unit.config.ts <file>`。本报告逐条注明所用层与退出码。

## 任务简报勘误

任务简报把 #411 描述为「P0 CSP 增加 form-action、收紧 connect-src」——这是 **#409** 的标题（#409 已由另一流处理，标签 `agent:ready-for-review`）。协调器 DAG（`docs/plans/2026-10-20-orca-dag-wave3/dag.json`，nodes[169]）确认批次第五张是 **#411「server 读取 renewal-status 并在证书不可用时关闭」**，票号为准，本批次按 #411 实际票面执行。

## 逐票结论

### #378 [Hindsight 02] 敏感候选与过期清理 — **SATISFIED（零改动，main 已含等价实现）**

等价实现核验：Wave1 交付 `a891698f`（#377/#378 功能）与 `55963e51`（#398 medium 修复含 backup/health/sensitivity）均在 HEAD 内（`e55b3c04` 的内容经 55963e51 重落）。逐条 AC 对照：
- 凭据拒收五路径齐备：`create`/`update`（store.ts:384/506 `CREDENTIAL_REFUSAL`）、`formMemory`（Bot 观察，非 normal 一律拒）、`completeSync`（store.ts:818 计数丢弃）、`sync`（ingestion.ts:282 只留 normal）；日志载荷只带 `droppedSensitive` 计数，无内容。
- 医疗/财务/客户资料：明确要求时入 `unreviewed` 候选（二次确认），Bot 自动学习不提出；编辑成敏感类回落 unreviewed（fix1 F-M1）。
- 30 天过期：`expireStaleCandidates`（store.ts:613）仅 tombstone `unreviewed` 且未删除且 >30 天，幂等；已确认记忆不触碰；接入 sweep（index.ts:2200）。

证据（本 worktree 原样运行，零改动）：
- `bun test ./server/tests/memory-sensitivity.test.ts ./server/tests/memory-expiry.test.ts` → 10 pass / 0 fail（exit 0）
- `bun test ./server/tests/memory-store.integration.test.ts ./server/tests/memory-defaults.integration.test.ts ./server/tests/memory-intelligence.integration.test.ts` → 46 pass / 0 fail（exit 0）
- `bunx e2e run --config e2e.unit.config.ts memory.test.ts memory-runtime memory-shared-source memory-default-source-tool intelligence-memory.test.ts` → 32 pass（exit 0；五个 e2e 原生套件在 bun 层报 `registerHooks` 属层错配，ADR 0008 语义）

### #381 [Hindsight 04] 租户身份与 Hindsight bank 隔离 — **SATISFIED（已实施）**

main 无等价实现（`resolvePayerForCompanyContext` 零消费者、`personal_memories` 无租户列、Wave1 只有单一共享 API key）。交付：

OpenBot 侧（新 `server/src/hindsight/bank-scope.ts`）：
- 唯一把身份换算成 Hindsight 落位的 seam：`resolveHindsightBankScope(scope)` 消费 #82 已验证的 `assertTrustedScope`（issuedScopes WeakSet），手造/克隆 scope 一律 `UNVERIFIED_SCOPE`；客户端提交 bank ID 无入口。
- 派生而非选择：`companySchemaFor`/`userBankFor`/`teamBankFor`/`sourceBankFor`/`botBankFor` = `ob_[ctusb]_<sha256 16hex>`；同一全局用户两家公司 → 两个 schema 两个 bank（测试证明）。
- `mintBankScopeAssertion`：HMAC-SHA256 短时效断言（v1.<body>.<sig>，规范化 JSON 定键序），`verifyBankScopeAssertion` 为服务端校验的逐字节镜像；`bankScopeAssertionSecret` 拒绝空声明。

Hindsight 侧（新 `deploy/hindsight/extensions/openbot_tenant/`，只读挂载进容器）：
- `OpenBotTenantExtension`：服务身份 = 共享 API key **+** 签名断言的配对，缺一 401；每公司一个 PostgreSQL schema（首请求 `run_migration` 自动供给；发现期不触碰引擎池，规避 `_get_pool`→`initialize()` 重入递归）；`allowed_bank_ids` 落在 RequestContext。
- `OpenBotOperationValidator`：retain/recall/reflect/consolidate/bank 读写/建 bank/mental models/curation 全部限定在断言授权 bank 内（403）；`resolve_tag_scope` 恒 None——tag 只分类不隔离；bank 列表只显示授权集。
- compose/env.example/README 更新（`HINDSIGHT_API_TENANT_ASSERTION_SECRET` ≡ OpenBot `HINDSIGHT_BANK_ASSERTION_SECRET`、`PASSTHROUGH_HEADERS`、扩展只读挂载）。

真实实例合约（票面 Verification）：`deploy/hindsight/test/contract-instance.sh start` 起一次性 Hindsight 1.0.0(digest a88678c0) + 网关 standin；`server/tests/hindsight-bank-isolation.contract.test.ts` 13 条全过：key 单独无授权 401、错 key 401、外密钥自签 401、篡改 body 401、过期 401、授权 bank retain/recall/文档读 200、同全局用户跨公司互不可见、跨公司/跨用户/猜测 bank 403、tag 无关 403、delete 允许/越权 403、bank 列表恰为授权集。
- `HINDSIGHT_CONTRACT_URL=… bunx e2e run --config e2e.unit.config.ts hindsight-bank-scope.test.ts hindsight-bank-isolation` → 23 pass / 1 skip（守护位）（exit 0）
- `bunx e2e run --config e2e.unit.config.ts hindsight-config hindsight-health` → 29 pass（无回归）
- `bun run --filter server typecheck` 本票文件 0 错误

### #373 [计费支付 BP05] 公司订阅续期与周期纠错 — **SATISFIED（已实施）**

前置核验：BP03(#371) 已在 main（3ca32d49）；#292 个人周期契约（coverPeriod/前向 marker/幂等 grant）已在 main。缺口：① 续期 ledger 键 `plan-renewal:<subId>:<period>` 无账户维度——`credit_grants.idempotency_key` 全局唯一索引会把同字符串 ID 的个人/公司两个发放折叠成一个（Spec：两类 ID 幂等域必须含 type）；② `billing_subscriptions` 主键为裸 `external_subscription_id`——提供方按 customer 命名空间发 ID，同串两行不可表示，upsert 还会把行搬到另一 customer 而 owner 不动（错归属通道）。交付：

- `plan-renewals.ts`：键改 `plan-renewal:<accountKey>:<subId>:<periodStart>`（含一次性升级窗口说明：旧行为历史保留，前向 marker 保证升级重放不再发放）。
- schema + 迁移 `0164_subscription_customer_scoped_identity.sql`：主键改 `(external_customer_id, external_subscription_id)`（fresh 库全链迁移验证通过）；store/service/types/payments seam 同步（upsert 冲突目标复合化、行不再跨 customer 搬迁、stamp/advance 带_customer）。
- 新 `server/tests/billing-company-renewal.integration.test.ts`（真实 DB，5 case）：公司续期入公司账户一期一次/下期再发；个人+公司同字符串 ID 两行两账户互不吞没；无周期事实不预发不挪 marker；取消阻断未来周期、已付周期按锁定到期保留、Payer 不可被 delivery 改写。
- 回归：`subscription-ownership`（7）、`plan-credits-personal`（含 key 字面量更新）、`plan-renewal-grantor`（4，含新账户区分 case）全绿；bun manifest 已登记新套件（coverage audit 仅剩 main 既有 bot-lifecycle 缺口）。

证据：
- 票面 Verification 命令 `TEST_DATABASE_URL=… bun test server/tests/billing-webhook.test.ts server/tests/billing-period-fulfillment.integration.test.ts` → 34 pass / 0 fail（exit 0）
- `bun test ./server/tests/billing-company-renewal.integration.test.ts ./server/tests/subscription-ownership.integration.test.ts`（hbc3 与全新 hbc3_fresh 库各一轮）→ 12 pass / 0 fail（exit 0）
- `bun run --filter server typecheck`：本票 0 新错（main 既有 `scripts/bootstrap-local-gateway.ts` 3 错与票无关）

### #405 [Craft Preview P1] preview 代理转发应用 cookie 并安全处理 Set-Cookie — **SATISFIED（已实施）**

main 无等价实现（`EXCLUDED_REQUEST_HEADERS` 整体剥 `cookie`，响应整体剥 `set-cookie`）。交付（`server/src/craft/webapp-proxy.ts`）：
- 新 `WebappCookiePolicy`：默认 `strip-all`（旧同源挂载语义原样）；preview 代理传 `app-only`——请求侧仅剔除平台 pass（`PREVIEW_SESSION_COOKIE=openbot_preview_session`，按对过滤，全 pass 请求不带 cookie 头），应用自身 cookie 转发到 dev server；
- 响应侧 `sanitizeAppSetCookie`：上游 `Set-Cookie` 逐条净化后放行——`Domain` 属性剔除（host-only，不能落主站）、非绝对 `Path` 剔除、其余属性（HttpOnly/Secure/SameSite/Max-Age…）与 name=value 原样、`getSetCookie()`+`append` 保多条不丢。
- 测试：`craft-webapp-proxy.test.ts` +6 case（round-trip、Domain 拒绝、多 header、纯 pass 无 cookie 头、默认策略回归钉）。

证据：`bunx e2e run --config e2e.unit.config.ts craft-webapp-proxy` → 91 pass / 0 fail（exit 0；既有 header hygiene 用例全绿）；`craft-preview-origin` 113 pass；typecheck 本票 0 错。

### #411 [Craft Preview P0] server 读取 renewal-status 并在证书不可用时关闭 — **SATISFIED（已实施）**

main 无等价实现（`OPENBOT_TLS_STATUS_FILE`/`renewal-status` 在 `server/src` 零命中）。交付：
- 新 `server/src/craft/preview-tls-status.ts`：`tlsStatusVerdictOf`（ok/warn 且 daysLeft>0 → open；starting → 关闭并说明首签中；critical/failed/未知 band/过期 → 关闭并带 `healthReason`；解析失败 fail-closed）+ `createTlsStatusGate`（mtime+size 双键缓存，文件更新即重判无需重启）。
- `preview-origin.ts` `admission()`：仅 host 形态在模板校验后咨询 gate（dev 形态不依赖证书状态）；`OPENBOT_TLS_STATUS_FILE`（默认 `/etc/openbot/tls/renewal-status.json`）。
- 主 compose `migrate` 服务（server 镜像服务）加只读 `${OPENBOT_TLS_HOST_DIR:-./tls}:/etc/openbot/tls:ro`（`docker compose config` 校验通过）；host 运行的 API server 经 `OPENBOT_TLS_STATUS_FILE` 指向同一目录（文档注明）。
- 文档修正：`docs/tls-certs.md`「server 不读该文件」段改写为 #411 后的真实拓扑。
- 测试：`craft-preview-origin.test.ts` +8（五 health + 缺失 + 畸形/未知 band + 无重启重判 + dev 免疫，全部走真实临时文件与 env 派生链）；`craft-webapp-proxy.test.ts` +1 端到端（真实 origin + 缺失状态文件 → webapp-info `previewOrigin:null`+reason、签票 503）。

证据：`bunx e2e run --config e2e.unit.config.ts craft-preview-origin craft-webapp-proxy` → 213 pass / 0 fail（exit 0）；sidecar 侧 `bun test ./scripts/tls-pipeline.test.ts` → 117 pass / 0 fail（exit 0，未破坏 #359 契约）。

## 变更清单（sha256）

```
18dff3fe9cb4c4692e549fd3d7adcafcd636e5aa509adec52ba91f3045426c2d  deploy/hindsight/README.md
ec7921ba3320fbedbcb7837dac44aacf581ca0052bb244986b2fab8ccc2fd115  deploy/hindsight/docker-compose.yml
dd4fd78e4151b6275c52615ae0baae95c4bb4ae3820473063787890df1a5e409  deploy/hindsight/hindsight.env.example
c6c0ea51ffb100a7fe49a7bd25b146e53e70c6a1049e199f2633160daf9ce88e  docker-compose.yml
d4a8eb724c0fc5a46ee4cf12694ce77f9fe5da31ea1ff7680355e7f33dcc72ee  docs/tls-certs.md
15f8462b25afd9d3f5ea920d02c6bd0676b7f1f1439bd905fec026e2c601c3b1  docs/verification/e2e-bun-suites.json
d8371b31a02afb5df8a628f75023041defbf630e9592e6d57e45915f7c27813f  server/drizzle/meta/_journal.json
4dfa0e2b39ee7b3ef872f226e8769e9b35d94f944d53a1317718bce3a9424d03  server/src/billing/payments/service.ts
7788da5f771ecba5c062f13ac4cd8165b4f7f3dd3acb3085d3a0ac6cc3ad6641  server/src/billing/plan-renewals.ts
6d31bcf1d430ba45cd58a72b874b11b5cac0804a4fccf0741437aa42a640a2fe  server/src/billing/service.ts
9eeae26e92ddd5eb4d01c4dbecc248926283fde7ddb1cde34d4e76c8a5fb140c  server/src/billing/store.ts
cb75bc5d7c164762721ae43a881c147fd9c76bc0d378aac1f8047cf5a1c0c5c1  server/src/billing/types.ts
c103e430e54237962edf8d1420daa02bd2f311294d83449462f37f28a96d35c4  server/src/craft/preview-origin.ts
8647b74fffcbddf62193535689495cb07aab226ddade6e6fe5a8c2ea72619cd6  server/src/craft/webapp-proxy.ts
affc97a23b2eb090e368d8dbe1919d6adaa4f15d61ace27df57bf6ab8764894b  server/src/db/schema/billing.ts
20487e743edce555443f060aa7391c2e2d9496e8cbecd292a482e949fa4086d7  server/tests/craft-preview-origin.test.ts
5cea6158ebcfd34edfc75ba60e985bd4c4fff37f7b79db52e208e589ed6f4dd3  server/tests/craft-webapp-proxy.test.ts
1e7a038f737a23b3986a2e3dc891bacb971043dc0efd66fb0dfd74441b63b781  server/tests/plan-credits-personal.integration.test.ts
29068ba188d040a64ad48c6ac2087d1635549bd76a5336d26c1bb1ef1af8ccd7  server/tests/plan-renewal-grantor.test.ts
a327bd966b40a207c15c95d8145a64b226b72513cdce79507af1b3d3765331eb  server/tests/subscription-ownership.integration.test.ts
12da3bd9966eab705730c37581987a7d69a9e0ab328b74b7877283e5c0450deb  deploy/hindsight/test/contract-instance.sh
1f7158070b322540b189f00b082d6ae66d147b72f71ed2e051f28b68fbf87cc5  server/drizzle/0164_subscription_customer_scoped_identity.sql
ef21fd8a11fa68e0a9eef59ea88119919739aac3bc3754bd840fd617bc99ceca  server/src/craft/preview-tls-status.ts
cbed1949ddb296ac2bd81cd1ca72822434812ee9108ea436e3e356e3b5bd5ae8  server/src/hindsight/bank-scope.ts
46ab26156c51b289c0cb93ffd420e629f437c65f505ae19bf06642db220c9e75  server/tests/billing-company-renewal.integration.test.ts
ae760e310b7e98fbcea60fc9a2da78399e0a91a7409dabc655a0e17a2ea4d751  server/tests/hindsight-bank-isolation.contract.test.ts
2ed195e25c4fb57e8d611ff6aac7e9ff75201a1600ad93ba076adcb6ed0d9984  server/tests/hindsight-bank-scope.test.ts
865817a572568ce40959beb51c96a980b6d675aa543dbfc96fad7417d5d79936  deploy/hindsight/extensions/openbot_tenant/validator.py
3388d415c87a58fb83197e1333598a65531c24b3b42cce9176fb64a03e15ed8d  deploy/hindsight/extensions/openbot_tenant/tenant.py
35e99a4259e0fd0ec9fe614ba300fec1cd876ff835021010ee496131770cb0f3  deploy/hindsight/extensions/openbot_tenant/__init__.py
c674ca22c56b4ecdf7f7c9c16d2fba8e9506a6a603e3052d1c31bf35bb238562  deploy/hindsight/extensions/openbot_tenant/assertion.py
```

## 复现要点

- 测试库初始化：`docker exec orca-w3-hbc-pg psql -U postgres -c 'CREATE DATABASE hbc3;'` → `CREATE EXTENSION vector` → `psql < server/ops/enterprise/roles.sql` → `DATABASE_URL=… bun server/scripts/migrate.ts`。
- #381 真实实例：`sh deploy/hindsight/test/contract-instance.sh start`（自动复用 wave1 容器的 HF 缓存、起 9101 standin、8889 实例），随后带 `HINDSIGHT_CONTRACT_URL/API_KEY/ASSERTION_SECRET` 三环境变量跑合约套件；`stop` 收尾。
- #373 fresh 库验证：另建 `hbc3_fresh` 走全链迁移后同一套件复跑。

## 遗留与移交

- **#409 语义**：任务简报把 #409 的描述误贴到 #411；#409（CSP form-action/connect-src）不在本批次（DAG 亦未含），其 CSP 串已在 main（webapp-proxy.ts `WEBAPP_DEV_CSP`，#405 的钉死用例继续锁定）。
- main 既有问题（与批次无关、未处理）：`scripts/bootstrap-local-gateway.ts` typecheck 3 错；coverage audit 既有缺口 `server/tests/multitenancy/bot-lifecycle.test.ts`。
- BP01(#369)/BP02(#370)/BP04(#372) 的 GitHub 关闭引用是上游 commit 撞号（zstd 提交 #369），其公司购买代码不在 main——#373 已按 seam 通用性交付（owner pair 驱动），公司购买路由落地时直接受益，无需返工本票接口。
- 未 commit/push（按约束）；本报告即检查点，配合上述 sha256 可复验。
