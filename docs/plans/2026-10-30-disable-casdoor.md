# 关闭当前 Casdoor 接入，保留集成代码

> 执行方式：当前会话串行实施，最后独立行为验证及 Review。未经用户要求不提交、不推送，不操作共享数据库或停止现有服务。

**Goal:** 当前部署仅使用 Better Auth 邮箱密码登录，Casdoor 不再注册或出现在登录入口。

**Architecture:** 复用现有 `OPENBOT_EMAIL_PASSWORD` 和按环境配置注册 provider 的机制。让邮箱密码认证足以构造 AuthConfig，并在已有 AuthConfig 时禁止单用户旁路。保留 Casdoor adapter、UI、部署资源、数据库及相关测试。

**Tech Stack:** TypeScript、Better Auth、Bun、tester-army e2e。

**Spec / 批准来源:** 本会话用户确认现用 Better Auth 内置登录，并明确选择“关闭接入，保留代码”。ADR 0011 的身份及会话选型继续有效。此文记录该选择及实施步骤。

## 范围与约束

- 选择的方案：关闭当前部署的 Casdoor 配置，保留代码以便恢复。另一方案是彻底删除 provider、UI、部署及测试，用户未选择。
- 本地 `.env` 只注释三个 `CASDOOR_OAUTH_*` 配置，保留原值供恢复；已有 `OPENBOT_EMAIL_PASSWORD=true`、会话秘密和管理员配置保持。
- 不增加开关、依赖、数据迁移或新的认证方式，不调整已有账号或权限。
- 保留会话 secret、URL、管理员及半套 OAuth 配置的原有校验；密码登录不能回退为全员管理员。
- 保全当前工作区的 runtime/computer/bifrost 等既有改动。只读核验运行态，不擅自重启共享进程。
- 按 execution.md 完整档执行；计划与证据分别存 docs/plans 和 .archive。独立 reviewer 只读源码和脱敏配置状态。

## Review Focus

1. 没有 OAuth 时邮箱密码认证能否独立启用，provider 列表是否为空。
2. 显式设置 SINGLE_USER 也不能覆盖已启用的邮箱密码认证。
3. 邮箱密码关闭或使用非 true 值时不能意外启用认证。
4. 邮箱密码独立配置仍强制要求足够强的 secret、URL 和管理员名单。
5. OAuth 配置完整性和已有 Casdoor 配置兼容行为不能回归；浏览器入口消费能力列表应隐藏 Casdoor。

## Task 1：修复邮箱密码独立启动并关闭本地接入

**Files:** `server/src/config.ts`、`server/tests/config.test.ts`、`.env.example`、本地忽略的 `.env`。

**Interfaces:** 消费现有 `loadConfig(environment)`、`authConfig(environment, google)` 和 `configuredAuthProviders(auth)`；保持公开接口及 provider 列表含义不变。

- [ ] 在 config.test.ts 增加无 OAuth 的邮箱密码启动用例，断言 auth.emailPassword=true、Casdoor 缺席、provider 列表为空、singleUser=false，覆盖显式 SINGLE_USER=true。
- [ ] 增加关闭/无效开关和缺 secret、短 secret、缺 URL、缺管理员的回归断言；从 e2e 正式入口执行并观察失败。
- [ ] 在 authConfig 中将 emailPassword 纳入认证启用条件，复用该布尔值；在 loadConfig 的 singleUser 判断中使用 AuthConfig 是否存在。
- [ ] 在 .env.example 说明邮箱密码可以独立启用以及如何关闭 Casdoor；注释本地 .env 的三个 Casdoor 配置项，禁止在日志和证据中输出原值。
- [ ] 运行 e2e 正式入口的 config 和 single-user 相关测试，检查退出码、实际用例数与失败/跳过；执行改动文件的 Biome 检查。
- [ ] 用真实本地环境加载配置，仅输出 auth/password/providers/singleUser 的脱敏结果；只读检查运行态 capabilities，区分磁盘配置与当前进程配置。
- [ ] 独立 reviewer 执行行为验证及 Spec/质量 Review；处理本次变更引入的阻塞 finding。最终报告未完成的真实登录、进程重启和远端 CI 项。

**验证命令:** `E2E_UNIT_SCOPE=server E2E_UNIT_OUTPUT=.e2e/casdoor-disable-20261030/config bun run test -- server/tests/config.test.ts`；single-user 若在 driven 清单则由 `E2E_BUN_ONLY=server/tests/single-user.test.ts` 加 e2e 驱动入口执行。

**失败处理:** 配置校验保持 fail closed；若邮箱密码不能独立构造或禁止旁路，先保留 Casdoor 本地配置，修复回归再关闭。运行态未重启则明确标记待生效，不宣称现有进程已切换。任何已存在账户登录情况未经凭据验证不作成功断言。
