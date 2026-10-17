# Ticket #207 执行检查点 — Bifrost 01.1 网关地址与连接配置持久化

- **BASE**: `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（分支 `1123786563/issue5-207`，未推送）
- **检查点形态**: 未提交工作区快照（按 dispatch 要求：不 commit、不 push、不 publish）。文件哈希清单见同目录 `file-hashes.txt`。
- **测试库**: 专用 `postgres://openbot:openbot@localhost:5432/openbot_207`（本地 openbot-postgres-1 容器内新建，123 条迁移全新应用）。未触碰 `openbot`（开发库）、`openbot_test`、`openbot_wave1`。
- **网关未启用**: 本次只交付配置持久化与校验；没有任何代码把模型流量切到网关。

## 交付契约（供 #208/#211/#213 消费）

- `server/src/gateway/config-store.ts`
  - `type GatewayEndpointConfig = { baseUrl: string; requestTimeoutMs: number; configVersion: number }` — 只读、非敏感三字段，读取接口只返回它
  - `saveGatewayEndpoint(database, input, by): Promise<GatewayEndpointConfig>` — 事务内 upsert 单例行，`config_version` 每次 +1，commit 时 `pg_notify('gateway_config_changed', <version>)`（与 settings-store 相同的 commit 送达通知模式）
  - `readGatewayEndpoint(database): Promise<GatewayEndpointConfig | undefined>`
  - `GATEWAY_CONFIG_TOPIC = "gateway_config_changed"`；re-export `parseGatewayEndpointInput` / `GatewayEndpoint`
- `server/src/gateway/endpoint.ts` — 纯校验（无 db/HTTP 依赖）：`parseGatewayBaseUrl`、`parseRequestTimeoutMs`、`parseGatewayEndpointInput`、`GATEWAY_ENDPOINT_ERRORS`
- `server/src/gateway/routes.ts` — `createGatewayConfigRoutes({ database, requireUser })`：`GET /endpoint`（requireUser，只读三字段）、`PUT /endpoint`（requireAdmin；非法输入 400 带可解释原因）。**未挂载到 app.ts**（见"与票面差异"）
- `server/src/db/schema/gateway.ts` — `gateway_configs` 单行表（id PK、base_url、request_timeout_ms 默认 10000、config_version、updated_by、updated_at），迁移 `drizzle/0122_gateway_endpoint_config.sql`（journal idx 122）
- `server/src/config.ts` — `GATEWAY_BASE_URL` / `GATEWAY_REQUEST_TIMEOUT_MS` 拒绝式校验（沿用 LAGO_API_URL 语义：必须 http(s) origin、不得带凭据/path/query/fragment；timeout 为正整数；仅设 timeout 拒绝启动），产出 `DeploymentConfig.gateway?: { baseUrl, requestTimeoutMs }`（未设置则无该块）

## 验证命令与结果（可重跑）

```
cd server
bun test tests/gateway-endpoint-config.test.ts
# 13 pass / 0 fail（parse 六类拒绝逐条断言文案；env 校验接受/半配置/非法逐条；路由 403 与 400 均不触库）

TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_207 bun test tests/gateway-endpoint-config.integration.test.ts
# 8 pass / 0 fail（三次保存 configVersion 严格递增 1→2→3 且旧值不可写回；重建 store(新连接)读取一致；
#   只读形状恰为三字段、行内无 secret/token/password/credential/key 列；pg_notify 送达新版本号；
#   管理员 PUT 200 且响应为只读三字段；非管理员 PUT 403 且版本不变；非法 PUT 400 带原因；非管理员可读只读形状）

bun run typecheck        # tsc --noEmit，exit 0
bunx biome lint --error-on-warnings <9 个改动文件>   # exit 0（仓库根执行）
```

测试库初始化：`docker exec openbot-postgres-1 psql -U openbot -d postgres -c "CREATE DATABASE openbot_207 OWNER openbot"`，然后 `cd server && DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_207 bun scripts/migrate.ts` → `{"type":"migrations-applied","status":"ok"}`（123 条）。

## 与票面差异（均为主动决策，非静默降级）

1. **settings-store.ts 未改动**：票面 write scope 提到 "settings-store.ts 的网关配置行与其迁移"。网关配置落在专用单行表 `gateway_configs`（`server/src/db/schema/gateway.ts` + 迁移 0122），通知复用 settings-store 的"事务内 pg_notify、commit 送达"模式但用独立 topic。理由：EnterpriseSettings 是扁平 KV 行，把带单调版本号的结构塞进去只能读-改-写，无法在 upsert 内原子递增；专用表 `config_version = config_version + 1` 结构性保证单调且旧版本不可写回（输入不携带版本字段）。与 Issue #207 Handoff 评论（波次 1, commit 49b7b063）记录的已验收布局一致，下游消费路径不变。
2. **routes 未挂载 app.ts**：app.ts 不在本票 write scope（"越界即停并上报"）。路由模块已交付并按生产 seam（requireUser + requireAdmin）在测试中独立挂载验证；挂载一行 `app.route("/api/admin/gateway", createGatewayConfigRoutes({ database, requireUser }))` 留给集成者或 01.2 UI 票。
3. **依赖注入容器未注入**：票面 Implementation step 4（config 注入应用容器）同样需要 app.ts 改动，超出 write scope；下游经 `readGatewayEndpoint(database)` 直接读取 configVersion，接口已就绪。
4. **迁移为手工构造**：仓库 `drizzle-kit generate` 因既有快照链冲突（0054/0055、0086/0096 parent collision，BASE 上即可复现，非本次引入）无法生成。0122 快照 = 0121 快照 + gateway_configs 表块（该表块逐字取自波次 1 已验证的 0112 快照，其 base id 与当前 0121 相同），去掉了冗余的 `gateway_configs_singleton` 唯一索引（与 PK 重复；schema 未声明它）；SQL 与 journal 按同一惯例手写。`scripts/migrate.ts` 应用成功，表结构与 schema 一致。
5. **GATEWAY_BASE_URL="" 视为未设置**：与 LAGO_* 的 `optional()` 语义一致（trim 后空串即未设置）；空串在管理员保存路径（JSON body）中被 `parseGatewayBaseUrl` 拒绝并有专门用例。

## 已知无关失败（BASE 即存在，未由本次改动引起）

- `server/tests/config.test.ts` "enables Google authentication when its complete deployment contract is present"（在 BASE f0520524 的原始 config.ts 上同样失败，已用原始文件替换复跑验证）。

## 失败即弃 / 续做

- 本票全部改动未提交，`git status` 即检查点；如需回退，删除上述新增文件并 `git checkout -- server/src/config.ts server/src/db/schema/index.ts server/drizzle.config.ts server/drizzle/meta/_journal.json`。
- 续做入口：读本文件 + `file-hashes.txt` + 复跑"验证命令"；测试库可删可重建（openbot_207 专用，不影响他库）。
