# b5-208 实施计划 — Bifrost 01.2 管理凭据加密存储与只写语义

BASE: `bab7c0b9`（branch `1123786563/b5-208`，worktree `/Users/wuyongjun/orca/workspaces/OpenBot/b5-208`）。
协调者已批准的越界伴随改动：schema 枚举、迁移 0124、app.ts 挂载、index.ts 装配（见 ask 记录）。

## 消费的前置契约（已读实际实现）

- 01.1 `server/src/gateway/endpoint-config.ts`：GatewayEndpointConfig/configVersion、validateGatewayEndpointInput 严格拒绝风格、gatewayEndpointControls() 全局访问模式。
- `server/src/credentials.ts`：encryptSecret/decryptSecret、createCredentialStore（create/rotate/findLiveByKey/readSecret）、CredentialKind 由 schema 枚举派生。
- `server/src/gateway/conversion-rate-store.ts`：enterprise_settings 行 + 事务级 advisory lock + GATEWAY_SETTINGS_TOPIC 通知的房内风格。
- `server/src/bot-services/routes.ts` + `server/tests/bot-service-routes.test.ts`：管理员路由与路由测试模式（requireUser + requireAdmin + no-store + 503 缺席语义）。
- `server/src/admin/settings-store.ts`：member() 角色读取（与 requireAdmin 同一 user_roles 表），GATEWAY_ENDPOINT_KEY 行先例。

## 设计决定

1. **凭据类型注册**：`credential_kind` 枚举追加 `gateway_admin`（`server/src/db/schema/core.ts`），CredentialKind 自动派生，credentials.ts 无需改动；迁移 0124 仅 `ALTER TYPE credential_kind ADD VALUE 'gateway_admin'`（仿 0008）。
2. **引用行**：`enterprise_settings` 新键 `gateway_admin_credential`，value = `{ credentialId, configVersion, fingerprint, updatedAt(ISO) }`；由本模块（gateway/admin-credential.ts）直接读写该表，不改 settings-store.ts。configVersion 从 1 起单调递增，仅服务端分配（输入携带即拒绝）。
3. **凭据行**：credentials 表 kind=`gateway_admin`、provider=`bifrost`、keyId=`admin`；加密值用现有 encryptSecret(AES-GCM)。唯一活跃行由既有 `credentials_active_key_idx` 保证。
4. **保存=原子轮换**：一个事务内 advisory lock（`openbot:gateway:admin-credential-save`）→ 读引用行 → 有则 store.rotate（旧行撤销+新行插入）否则 store.create → upsert 引用行。凭据行与引用行同事务提交，杜绝"新凭据已入库但引用仍指旧行"。
5. **指纹**：sha256(明文) hex 后 4 位，写入引用行供脱敏展示；不可还原明文。
6. **只写语义**：任何读取路径（GET 状态、audit、日志）只出现 state/configVersion/fingerprint/updatedAt；adminKey 明文与密文 envelope 不出服务。
7. **resolveGatewayAdminCredential(ref?)**：仅服务端内部。ref 缺省解析当前；携带 ref 时与当前引用严格相等（credentialId+configVersion），否则 `GatewayAdminCredentialStaleError`（旧引用立即失效）。未配置/引用行损坏/凭据行被撤销 → `GatewayAdminCredentialNotConfiguredError`（fail closed + log.warn，不伪装成"已配置但失败"）。返回 { adminKey, ref } 供 01.5 绑定探测版本。
8. **全局入口**：模块内 install/accessor（`installGatewayAdminCredentialService` / `gatewayAdminCredentialControls()`），index.ts 装配时安装，对称于 gatewayEndpointControls()；路由经 createApp 参数注入（仿 botServices，可测）。
9. **路由**：`/api/admin/gateway/credential` — GET 脱敏状态；PUT 写入/轮换（body `{ adminKey }`，严格键）。requireUser+requireAdmin、no-store、服务缺席 503、非管理员 403。响应体永不含明文。
10. **审计**：`gateway_admin_credential.saved`（payload 仅 configVersion/fingerprint/previousCredentialId?）；失败路径 `gateway_admin_credential.save_refused` 用 reasonWithoutStatement 防止 drizzle params（含密文 envelope）落入 append-only 审计。

## 文件级变更

| 文件 | 动作 | 内容 |
|---|---|---|
| `server/src/db/schema/core.ts` | 改（批准越界） | credentialKind 追加 `gateway_admin` + 注释 |
| `server/drizzle/0124_gateway_admin_credential.sql` | 新（批准越界） | `ALTER TYPE "public"."credential_kind" ADD VALUE 'gateway_admin';` |
| `server/drizzle/meta/_journal.json`、`meta/0124_snapshot.json` | 改/新（批准越界） | drizzle-kit generate 产物 |
| `server/src/gateway/admin-credential.ts` | 新 | 类型、校验、指纹、行读写、服务工厂、install/accessor、两个错误类 |
| `server/src/gateway/admin-credential-routes.ts` | 新 | Hono 路由工厂 |
| `server/src/app.ts` | 改（批准越界） | import + 挂载路由（服务经模块级 accessor 解析；实际执行未新增 createApp 参数，避免破坏 baseline 在途票 identity-app-wiring.test.ts 的尾位参数计数，详见 .omc/reports/b5-208.md） |
| `server/src/index.ts` | 改（批准越界） | 构造服务、传入 createApp、安装全局 |
| `server/tests/gateway-credential.test.ts` | 新 | 纯函数：输入校验、指纹、存储行分类、脱敏形状 |
| `server/tests/gateway-credential.integration.test.ts` | 新 | 专用库：保存/轮换/解析/旧引用拒绝/并发序列化/重启一致/审计与日志脱敏/越权 |

## RED → GREEN

RED（先写，观察失败）：
```bash
cd server && bun test tests/gateway-credential.test.ts            # 模块不存在而失败
TEST_DATABASE_URL=postgres://$(grep '^DATABASE_URL=' ../.env | cut -d= -f2- | sed -E 's|.*://([^@]*)@|\1@|;s|/[a-zA-Z0-9_-]+$|/openbot_b5_208|') bun test tests/gateway-credential.integration.test.ts
```

GREEN 顺序：
1. schema 枚举 + drizzle-kit generate（核对仅 ALTER TYPE）+ 对测试库执行迁移。
2. admin-credential.ts 最小实现 → 单元测试绿。
3. 路由 + app.ts/index.ts 装配 → 集成测试绿。

## 验证命令（最终）

```bash
cd server && bun test tests/gateway-credential.test.ts
DATABASE_URL=<openbot_b5_208> bun test tests/gateway-credential.integration.test.ts
bun run typecheck
bunx biome lint --error-on-warnings src/gateway/admin-credential.ts src/gateway/admin-credential-routes.ts tests/gateway-credential.test.ts tests/gateway-credential.integration.test.ts src/db/schema/core.ts src/app.ts src/index.ts
```

## AC → 证据映射

| AC | 证据 |
|---|---|
| 响应体无明文 | 集成测试对 GET/PUT 响应 JSON.stringify 做明文/base64 变体断言 |
| 日志与审计无明文/可还原片段 | 注入 pino 内存流捕获模块日志 + 读回 audit_events payload，断言不含明文、base64、密文 envelope |
| 轮换后 configVersion 递增、旧引用拒绝 | 集成测试 rotate → v2，resolve(oldRef) 抛 StaleError；旧凭据行 revoked |
| 未配置显式"未配置" | GET → { state:"unconfigured" }；resolve 抛 NotConfiguredError；损坏行读作未配置+warn，不伪装已配置 |
