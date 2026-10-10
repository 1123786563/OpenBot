# 企业 Go 运行时候选：接入与运行手册

本册说明如何把 `runtime-go/`（R1–R4 验证候选）通过**企业入口**接入 OpenBot 并跑通一条真实对话。整合计划见 `docs/superpowers/plans/`（运行时候选 01 册）；本手册对应其后的"对接"工作。

## 架构一页

```
浏览器/客户端
   │  POST /api/enterprise/v1/runs   (会话 cookie + x-openbot-tenant + Idempotency-Key)
   ▼
企业入口 (server/src/enterprise, :3101)
   ├─ 会话 + 租户 scope 中间件
   ├─ RunService (runs/service.ts)      ← ob_ent_run_writer 登录：thread/预算/run 行
   ├─ 能力铸造（HMAC 派生，只存 sha256）← ob_ent_runtime_writer 登录：attempt/capability 行
   ├─ RunGateway (runs/gateway.ts)      ← 构造 AG-UI body + 三头，SSE 透传，事件落账本
   ├─ 验证路由 /internal/enterprise/v1/runtime/validate   ← Go 出站验身份
   └─ 工具面   /internal/enterprise/v1/tool-invocations   ← Go 回调受控工具
   ▼
Go 运行时候选 (runtime-go, :4203, compose profile "go-runtime")
   ├─ 三头认证 → 向企业入口 validate 验 RuntimeInvocation 信封
   ├─ AG-UI 执行（trpc-agent-go + OpenAI 兼容模型端点，如 GLM）
   └─ 受控工具 → 回调企业入口 prepare/execute
```

安全不变量（任何改动不得破坏）：
- Go 不持有签名密钥、不访问业务库；身份只能来自验证过的信封。
- 能力凭证按 `HMAC-SHA256(keyEncryptionKey, "enterprise-runtime-capability|audience|tenant|run")` 派生，账本只存 sha256；重启可重推导。
- 输入摘要冻结：`[{"content":…,"role":…}]` 紧凑 JSON、无 HTML 转义、U+2028/2029 显式转义（TS↔Go 金样本测试锁死：`input-digest.test.ts`）。
- 信封摘要冻结：严格解析后按键序紧凑 JSON + SHA-256（`envelope-digest.test.ts` 金样本）。
- 候选可整体禁用：不设任何 `ENTERPRISE_RUNTIME_*` 变量即不挂载、不开池。

## 启动步骤

1. **数据库**：需要 02/03 册的企业库（32 张 enterprise_* 表）+ 五个 runs 能力角色。测试环境：
   ```bash
   docker compose up -d openbot-enterprise-test-pg   # :5434
   bun --env-file=.env server/scripts/enterprise-test-db.ts roles
   bun --env-file=.env server/scripts/enterprise-test-db.ts migrate
   ```
2. **离线供种**（角色合同：release/route/grant/账户归 operator 离线供应）：
   ```bash
   bun --env-file=.env server/scripts/enterprise-runtime-seed.ts
   ```
3. **环境变量**（`.env`，完整清单见 `.env.example` 末段）：
   - `ENTERPRISE_RUNTIME_SERVICE_CREDENTIAL`（与 Go 共享）
   - `ENTERPRISE_RUNTIME_RUN_WRITER_DATABASE_URL` / `..._RUNTIME_WRITER_DATABASE_URL`
   - `ENTERPRISE_RUNTIME_MODEL_BASE_URL` / `MODEL_ALIAS` / `MODEL_CREDENTIAL` / `MODEL_ROUTE_REF`
   - `ENTERPRISE_RUNTIME_EXECUTION_URL` / `CANCEL_URL`（指 Go :4203）
4. **启动三个进程**：
   ```bash
   bun run --filter server dev:enterprise        # 企业入口 :3101
   docker compose --profile go-runtime up go-runtime
   ```
   或开发态直跑 Go：`cd runtime-go && go run ./cmd/runtime -addr=127.0.0.1:4203 -validation-endpoint=http://127.0.0.1:3101/internal/enterprise/v1/runtime/validate -model-base-url=$ENTERPRISE_RUNTIME_MODEL_BASE_URL -model-alias=$ENTERPRISE_RUNTIME_MODEL_ALIAS -model-route-ref=e2e-model-route-ref -expert=assistant-v1=./experts/assistant-v1.txt -governed-tools=enterprise_echo=v1 -callback-endpoint=http://127.0.0.1:3101/internal/enterprise/v1/tool-invocations`

## 一键冒烟

```bash
bun --env-file=.env server/scripts/enterprise-runtime-e2e.ts
```
真实 Go 进程 + 真实账本 + 真实模型端点：断言 SSE 事件契约、账本行（run/attempt/双能力/事件）、预算挂账、受控工具与取消路径。退出码即结论。

## 测试矩阵

| 套件 | 覆盖 |
|---|---|
| `runtime-config.test.ts` | 配置块解析/禁用语义/边界拒绝 |
| `envelope-digest.test.ts` + `input-digest.test.ts` | 两个冻结摘要的 TS↔Go 金样本 |
| `runtime-verifier.test.ts` | 真实验证器：凭证/绑定/撤销/过期/账本故障 |
| `tool-plane.test.ts` | 真实工具面：治理注册表/摘要绑定/回执 |
| `runs/service.test.ts` | 真实账本集成：创建束/幂等/授权/预算/事件/跨租户 |
| `runs/gateway.test.ts` | 网关单元面：SSE 透传/映射/重放/取消 |

## 已知边界（如实声明）

- 网关 `POST /runs` 当前同时承载 create+execute；03 册 E1-C 的正式路由合同（202 create-only）由并行工作流实现中，落地后执行流应迁至独立 seam（`POST /runs/:id/execution`），create 交还正式路由。
- 取消信封在网关进程内存中登记；网关重启后取消回答"unknown"并标 `reconciliation_required`（恢复归 E2）。
- 工具面操作登记为进程内存（P3/E1 落地持久操作账本后替换）。
- 事件读取走 runtime-writer 登录（会话鉴权已在路由层完成）。
