# Ticket #207 执行检查点（run 2）— Bifrost 01.1 网关地址与连接配置持久化

- **Worktree**: `/Users/wuyongjun/orca/workspaces/OpenBot/issue5-207-2`，分支 `1123786563/issue5-207-2`
- **BASE**: `bab7c0b9`（= 前次 BASE `f0520524` + 1 个纯 docs 提交，`server/` 无差异，已用
  `git diff f0520524..bab7c0b9 -- <4 个受修改文件>` 验证为空）
- **检查点形态**: 未提交工作区快照（dispatch 约束：不 commit、不 push、不 publish）。
  文件哈希清单见同目录 `file-hashes.txt`，验证证据见 `verify.md`，复审结论见 `review.md`。
- **执行方式**: 按 Ticket #207 Handoff 续做条款，把前次派发（worktree `issue5-207-timeout`）
  已通过独立终审（PASS/APPROVE）的 F1 修复后检查点**字节级转移**到本工作树
  （12 个实现文件 SHA-256 与 `checkpoints/207/f1-repair/report.md` 终稿清单逐一核对一致），
  并在本工作树**独立重跑全部验证**。计划：`docs/superpowers/plans/2026-10-15-issue5-207-2-checkpoint-transfer.md`。
- **测试库**: 专用 `postgres://openbot:openbot@localhost:5432/openbot_207_2`
  （本地 `openbot-postgres-1` 容器内新建，123 条迁移全新应用）。未触碰 `openbot`（开发库）、
  `openbot_test`、`openbot_207`（前次专用库）及任何他票库。
- **网关未启用**: 只交付配置持久化与校验；没有任何代码把模型流量切到网关，路由未挂载 app.ts。

## 交付契约（供 #208/#211/#213 消费，与前次检查点完全一致）

- `server/src/gateway/config-store.ts`
  - `type GatewayEndpointConfig = { baseUrl: string; requestTimeoutMs: number; configVersion: number }`
    — 只读、非敏感三字段，读取接口只返回它
  - `saveGatewayEndpoint(database, input, by): Promise<GatewayEndpointConfig>` — 事务内 upsert
    单例行，`config_version` 每次 +1（结构性单调：输入不携带版本，旧版本无从写回），
    commit 时 `pg_notify('gateway_config_changed', <version>)`（与 settings-store 相同的
    commit 送达通知模式）
  - `readGatewayEndpoint(database): Promise<GatewayEndpointConfig | undefined>`
  - `GATEWAY_CONFIG_TOPIC = "gateway_config_changed"`；re-export `parseGatewayEndpointInput` / `GatewayEndpoint`
- `server/src/gateway/endpoint.ts` — 纯校验（无 db/HTTP 依赖）：`parseGatewayBaseUrl`、
  `parseRequestTimeoutMs`（正整数且 ≤ 2,147,483,647，int4 上界，F1 修复）、
  `parseGatewayEndpointInput`、`GATEWAY_ENDPOINT_ERRORS`
- `server/src/gateway/routes.ts` — `createGatewayConfigRoutes({ database, requireUser })`：
  `GET /endpoint`（requireUser，只读三字段）、`PUT /endpoint`（requireAdmin；非法输入 400
  带可解释原因）。**未挂载到 app.ts**（见"与票面差异"）
- `server/src/db/schema/gateway.ts` — `gateway_configs` 单行表（id PK、base_url、
  request_timeout_ms 默认 10000、config_version、updated_by、updated_at），迁移
  `drizzle/0122_gateway_endpoint_config.sql`（journal idx 122）
- `server/src/config.ts` — `GATEWAY_BASE_URL` / `GATEWAY_REQUEST_TIMEOUT_MS` 拒绝式校验
  （沿用 LAGO_API_URL 语义：必须 http(s) origin、不得带凭据/path/query/fragment；timeout
  为正整数且 ≤ int4 上界；仅设 timeout 拒绝启动），产出
  `DeploymentConfig.gateway?: { baseUrl, requestTimeoutMs }`（未设置则无该块）

## 验证结果（本工作树独立复跑；命令与原始输出见 verify.md）

| 验证 | 结果 |
|---|---|
| 转移完整性：12 文件 SHA-256 == f1-repair 终稿清单 | 12/12 一致 |
| `bun test tests/gateway-endpoint-config.test.ts` | 16 pass / 0 fail |
| `TEST_DATABASE_URL=…openbot_207_2 bun test tests/gateway-endpoint-config.integration.test.ts` | 9 pass / 0 fail |
| `bun run typecheck`（tsc --noEmit） | exit 0 |
| `bunx biome lint --error-on-warnings`（9 个改动源/测试文件） | exit 0 |
| 回归 `bun test tests/config.test.ts` | 140 pass / 1 fail；唯一失败为 BASE 既有（本工作树以 BASE 版 config.ts 复现归因，见 verify.md） |
| 迁移应用 `bun scripts/migrate.ts`（openbot_207_2） | `{"type":"migrations-applied","status":"ok"}`，123 条；`\d gateway_configs` 结构与 schema 一致 |

## 与票面差异（沿用前次已审查决策，非静默降级；终审已确认）

1. **settings-store.ts 未改动**：网关配置落在专用单行表 `gateway_configs`
   （`server/src/db/schema/gateway.ts` + 迁移 0122），通知复用 settings-store 的
   "事务内 pg_notify、commit 送达"模式但用独立 topic。理由：EnterpriseSettings 是扁平 KV
   行，把带单调版本号的结构塞进去只能读-改-写，无法在 upsert 内原子递增；专用表
   `config_version = config_version + 1` 结构性保证单调且旧版本不可写回（输入不携带版本字段）。
2. **routes 未挂载 app.ts**：app.ts 不在本票 write scope（"越界即停并上报"）。路由模块已交付
   并按生产 seam（requireUser + requireAdmin）在测试中独立挂载验证；挂载一行
   `app.route("/api/admin/gateway", createGatewayConfigRoutes({ database, requireUser }))`
   留给集成者或 01.8 UI 票。
3. **依赖注入容器未注入**：票面 Implementation step 4（config 注入应用容器）同样需要 app.ts
   改动，超出 write scope；下游经 `readGatewayEndpoint(database)` 直接读取 configVersion，
   接口已就绪。
4. **迁移为手工构造**：仓库 `drizzle-kit generate` 因既有快照链冲突（0054/0055、0086/0096
   parent collision，BASE 上即可复现，非本次引入）无法生成。0122 快照 = 0121 快照 +
   gateway_configs 表块，SQL 与 journal 按同一惯例手写；`scripts/migrate.ts` 全新库应用成功，
   表结构与 schema 一致（本工作树复验）。
5. **GATEWAY_BASE_URL="" 视为未设置**：与 LAGO_* 的 `optional()` 语义一致（trim 后空串即未
   设置）；空串在管理员保存路径（JSON body）中被 `parseGatewayBaseUrl` 拒绝并有专门用例。

## 失败即弃 / 续做

- 本票全部改动未提交，`git status` 即检查点；如需回退，删除新增文件并
  `git checkout -- server/src/config.ts server/src/db/schema/index.ts server/drizzle.config.ts server/drizzle/meta/_journal.json`。
- 续做入口：读本文件 + `file-hashes.txt` + 复跑 verify.md 的验证命令；测试库 `openbot_207_2`
  可删可重建，不影响他库。
