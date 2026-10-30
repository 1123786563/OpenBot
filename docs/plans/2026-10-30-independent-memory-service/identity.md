# 独立身份中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans；用户选择多 Agent 后才使用 superpowers:subagent-driven-development。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提供独立 Better Auth OIDC 身份中心并保持现有稳定主体连续。

**Architecture:** IDENTITY 独占全局身份、账户、会话与提供方配置；各业务应用是客户端。OpenBot 本地公司/团队目录维持原受控单一权威，全局身份的本地兼容行不能独立修改。

**Tech Stack:** Bun/Hono、Better Auth OAuth Provider、PostgreSQL/Drizzle、React/HeroUI 登录与授权页。

**Spec:** [已批准 Spec v3](../../specs/2026-10-30-independent-memory-service-design.md)，消费[跨仓库合同](contracts.md)，全局约束和 Review Focus 继承[计划入口](README.md)。本分册所有新路径相对拟建 IDENTITY 仓库。

## Global Constraints

精确 issuer、独立 client ID、PKCE、登记回调及会话撤销；不按邮箱自动合并，不复制可独立修改的目录，不执行未经批准的真实身份迁移。公司/团队目录不因登录身份共用而授予内容权限。

## Review Focus

错误 issuer/audience、回调重放或跳转出登记宿主由 I01 验证；相同邮箱、旧映射冲突、主体停用与历史引用连续由 I02 验证。

### I01：可独立运行的 OIDC 提供方

**Files:** Create `package.json`、`src/index.ts`、`src/auth/provider.ts`、`src/auth/clients.ts`、`src/db/schema.ts`、`src/config.ts`、`app/src/routes/login.tsx`、`app/src/routes/consent.tsx`、`e2e.unit.config.ts`、`tests/support/provider.ts`、`tests/oidc-provider.test.ts`。配置和脚手架与此可验收能力同一任务交付。

**Interfaces:** 提供合同中的 discovery/JWKS、authorization code + PKCE、token 和退出端点；登记 `openbot-web`、`memory-web` 两个不同客户端。内部运营入口与公开注册隔离，公共动态客户端注册首版关闭。

`IdentityConfig` 由 `src/config.ts` 定义：固定 issuer、独立数据库地址、密钥配置、两客户端登记及精确 redirect/logout URI 列表；从受控环境解析，缺项拒绝启动，配置不允许请求覆盖。具体插件配置由该解析结果构造。

- [ ] 写 `provider_login_binds_issuer_audience_and_pkce`、`replayed_code_is_rejected`、`unregistered_redirect_is_rejected`：真实启动 fixture provider；两客户端各自可登录，错误 verifier、issuer、audience、过期/重放 code 和任意 return URL 均拒绝。
- [ ] 在 IDENTITY 运行 `bun run test tests/oidc-provider.test.ts`，记录非零收集与预期失败；首个失败可为缺少入口/提供方实现，不能为缺依赖或错误配置。
- [ ] 实现 `createIdentityProvider(config: IdentityConfig): { fetch: (request: Request) => Promise<Response>; close: () => Promise<void> }` 于 `src/auth/provider.ts`。锁定与现有 Better Auth 基线兼容的提供方插件版本，迁移只用独立测试数据库；React/HeroUI 页面只处理登录、同意及安全回跳，不持有应用秘密。
- [ ] 同一命令转绿，再运行 `bun run typecheck`、`bun run build`。停止 OpenBot 业务进程的隔离 fixture 后，provider 两客户端认证仍可运行。
- [ ] 独立验收此提供方，不依赖记忆服务；记录版本和验证结果，提交遵守执行授权。

### I02：稳定主体解析、停用与身份连续性

**Files:** Create `src/subjects/registry.ts`、`src/subjects/routes.ts`、`src/subjects/schema.ts`、`src/subjects/fixture-import.ts`、`tests/subject-continuity.test.ts`、`tests/subject-status.test.ts`；Modify `src/auth/provider.ts`、`src/db/schema.ts`。

**Interfaces:** 消费合同中的 SubjectRef；实现 `resolveSubject(input: VerifiedSubjectInput): Promise<SubjectRef>` 和 `subjectStatus(subjectId: string): Promise<{ active: boolean; generation: number }>`，挂载合同规定的内部解析与状态 API。VerifiedSubjectInput 只由验证后的 OIDC/受控映射构造，不能直接接受 wire 类型断言。

`VerifiedSubjectInput` 定义在 `src/subjects/registry.ts`，是带私有品牌的 `oidc { issuer, subject }` 或 `legacy { legacyUserId, proofId }`；品牌分别由签名/issuer/audience 验证器、受控映射验证器签发。测试必须从真实验证入口取得，不以 `as` 制造受信输入。

- [ ] 写 `same_person_across_two_clients_has_one_canonical_subject`、`same_email_is_not_an_identity_link`、`conflicting_legacy_mapping_refuses_cutover`、`disabled_subject_cannot_refresh_or_reactivate`。fixture 保留旧 OpenBot userId/principalId 与两个历史资源引用，解析后全部指向同一原主体；相同邮箱的另一身份保持不同主体。
- [ ] 运行 `bun run test tests/subject-continuity.test.ts tests/subject-status.test.ts` 得到预期失败。
- [ ] 在 `registry.ts` 用稳定 `issuer + subject`/已核验映射查找 canonical subject；generation 单调递增，停用不能由新登录或 ensure 自动复活。提供受控 fixture 导入用于证明连续性，生产导入与切换单独列授权门槛，不在测试中读真实账号库。
- [ ] 明确 OIDC subject 类型配置：自有客户端采用可核验的同一 canonical subject 或显式服务端映射，不假设不同客户端天然返回相同 subject。旧用户兼容投影保留外键 ID，但注册、账户更改和停用事实的写入归中心。
- [ ] 同一测试转绿；验证两个客户端的登录/刷新都核验主体状态，状态 API 不可用时不能凭客户端 body 或过期快照创建身份。
- [ ] 在该任务产物中记录身份数据项、兼容投影和公司目录的唯一写入所有者，列出切换前/后及回滚步骤；缺少可证明的主体映射时禁止推进 O01 的实际切换。

## 交付边界

I01、I02 可用独立 fixture 客户端完成验证。现有 OpenBot 用户/账户接入的实际文件修改归 O01；不要在身份中心任务顺便迁移 OpenBot 全部公司/团队表或业务授权。若实施发现现有目录合同要求跨库原子写入而无法维持，不静默改为最终一致，先提交具名合同调整并按批准范围处理。
