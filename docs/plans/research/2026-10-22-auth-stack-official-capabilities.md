# Auth stack research (official sources, 2026-10-22)

范围：仅核对 Better Auth、Keycloak、OpenFGA 与 PostgreSQL 相关一手文档/源仓库；不评价未知项目，不把推断写成产品事实。

## 已验证事实

### Better Auth

- Better Auth 核心仓库与 `better-auth` npm 包声明 MIT；核心是 TypeScript、可自托管的认证/授权框架。[LICENSE](https://github.com/better-auth/better-auth/blob/main/LICENSE.md) · [package.json](https://github.com/better-auth/better-auth/blob/main/packages/better-auth/package.json)
- Organization 插件提供 organization/member/invitation 管理、可选 teams、组织角色与自定义 access-control statements；插件 schema 包含 `organization`、`member`、`invitation` 等表，可用 CLI 迁移/生成。[Organization docs](https://better-auth.com/docs/plugins/organization)
- SSO 插件官方支持 OIDC、OAuth2、SAML 2.0；文档明确：需要客户自助配置 SSO 时应联系 enterprise。插件可把 provider 关联到 organization，并支持 `resolveUser` 映射到既有用户。[SSO docs](https://better-auth.com/docs/plugins/sso)
- SCIM 插件文档标为 v1.8 Beta，提供 inbound SCIM 2.0 服务，可创建、更新、停用、删除 users/groups；SCIM provisioning 本身不会创建登录方式或授予应用访问，认证需另行配置。[SCIM docs](https://better-auth.com/docs/beta/plugins/scim)
- PostgreSQL 是官方适配器：可传 `pg.Pool`，CLI 支持 schema generation/migration；可选 joins 和非 `public` schema。[PostgreSQL adapter](https://better-auth.com/docs/adapters/postgresql)

### Keycloak

- Keycloak Organizations 是 realm 内的组织/B2B 能力：成员管理、邀请、通过 identity brokering onboarding、identity-first login，以及向 token 传播组织 claims。需在 realm settings 启用 Organizations。[Server Administration Guide](https://www.keycloak.org/docs/26.8.1/server_admin/)
- 组织可配置域名；Keycloak 可按 email domain 识别组织并按组织路由身份提供商/认证流程。组织可关联 identity providers，并把外部 IdP claims/attributes 映射到 organization groups。[Server Administration Guide](https://www.keycloak.org/docs/26.8.1/server_admin/)
- Keycloak 官方支持 OIDC 与 SAML identity providers（identity brokering），并支持 LDAP/Active Directory user federation；组织成员与 LDAP 有边界：LDAP 用户要加入组织，官方说明需启用 LDAP import，否则组织成员关系不会同步。[Identity brokering](https://www.keycloak.org/docs/latest/server_admin/#_identity_broker) · [LDAP federation](https://www.keycloak.org/docs/latest/server_admin/#_user-storage-federation) · [Organizations](https://www.keycloak.org/docs/26.8.1/server_admin/)
- 组织 membership 可通过内置 `organization` scope 放入 OIDC token；支持 `organization`、`organization:<alias>`、`organization:*` 等 scope 形式。组织组也可映射到 OIDC claims 和 SAML assertions。[Organization token claims](https://www.keycloak.org/docs/26.8.1/server_admin/)
- Keycloak 26.7.0 的官方发布说明称 Organizations 支持 organization-level FGAP `manage`/`view`；该初始能力不细分 members/groups/IdP 子资源权限。[FGAP announcement](https://www.keycloak.org/2026/05/org-fgap)
- PostgreSQL 是 Keycloak 官方支持的生产数据库（当前文档列 PostgreSQL 14–18；具体支持版本随 Keycloak 版本变化），默认 `dev-file` 仅适合开发。[Database guide](https://www.keycloak.org/server/db) · [Supported configurations](https://www.keycloak.org/server/supported-configurations)

### OpenFGA + PostgreSQL

- OpenFGA 是独立的开源细粒度授权服务，提供关系型授权模型语言与 HTTP/gRPC API；其架构文档列出 PostgreSQL、MySQL、SQLite datastore。[OpenFGA](https://openfga.dev/) · [architecture source](https://github.com/openfga/openfga/blob/main/docs/architecture/architecture.md)
- OpenFGA 的 store 保存 authorization model 与 relationship tuples；`check`、`list-objects` 等 API 计算关系图。官方仓库提供使用 PostgreSQL 的 Docker Compose 示例。[architecture source](https://github.com/openfga/openfga/blob/main/docs/architecture/architecture.md) · [server README](https://github.com/openfga/openfga/blob/main/README.md)
- OpenFGA 的 PostgreSQL datastore 与 Better Auth/Keycloak 的用户、组织、会话表不是同一内置 schema；把身份/组织事件同步为 tuples、定义模型并在应用请求中调用 OpenFGA，属于集成层工作（这是基于各自官方架构的推断）。

## 针对当前 MVP 的可行性判断

### Verified fact

- Better Auth 官方提供认证、组织成员/团队、OIDC/SAML SSO、SCIM（但当前 SCIM 文档版本标 Beta）以及 PostgreSQL 持久化能力；这不证明项目锁定的 1.7.1 版本或当前装配已满足所有业务验收；其官方 SSO 文档支持把 OIDC/SAML provider 关联 organization。[Organization](https://better-auth.com/docs/plugins/organization) · [SSO](https://better-auth.com/docs/plugins/sso) · [SCIM](https://better-auth.com/docs/beta/plugins/scim) · [PostgreSQL](https://better-auth.com/docs/adapters/postgresql)
- Keycloak 可作为上游 OIDC IdP：Keycloak 官方提供 OIDC discovery/token endpoints，Better Auth generic OAuth/OIDC 插件官方文档明确以 Keycloak 为 corporate IdP 示例。[Better Auth Generic OAuth](https://better-auth.com/docs/plugins/generic-oauth) · [Keycloak hostname/discovery](https://www.keycloak.org/server/hostname)

### Inference

- 对“个人/小企业、MVP、不引入 OpenFGA”的范围，保留 Better Auth 认证与项目既有本地授权，组件数量和同步面更小；引入 Keycloak 会增加独立 IAM 部署、realm/IdP 配置与运维边界。该段是工程推断，不是厂商承诺。
- Keycloak + Better Auth 作为“上游 OIDC IdP + 应用会话”在协议层可行，但组织 membership/claims 如何映射到 OpenBot 公司成员关系与本地权限，需应用侧明确实现；官方资料未声明两者自动同步。
- 若未来需要跨多个服务共享关系型授权模型，OpenFGA 可作为独立授权层；这会增加 tuple/model 同步、服务调用和一致性设计，不能仅因双方都使用 PostgreSQL 就视为开箱即用。

### Recommendation (scope-limited)

- 保持当前 MVP 的 Better Auth + PostgreSQL + 本地授权路线；暂不加入 OpenFGA。
- 若需要企业客户通过 Keycloak 登录，优先将 Keycloak 作为 OIDC provider 接入 Better Auth SSO；先验证 claims、组织绑定和退出/禁用语义，再决定是否需要 Keycloak Organizations/LDAP/SCIM 的额外能力。
- 许可边界应单独核对实际安装包版本；目前可核验的 Better Auth 核心与 npm 包为 MIT，SSO/SCIM 是否由托管/enterprise 服务提供附加能力不等于核心插件改变许可证。[MIT license](https://github.com/better-auth/better-auth/blob/main/LICENSE.md) · [SSO enterprise note](https://better-auth.com/docs/plugins/sso)

## 主要限制与注意事项

- Better Auth SCIM 页面当前明确为 Beta；SCIM provisioning 不授予登录权限，不能把“已同步用户”当作“已完成认证/授权”。
- Better Auth SSO 文档把客户自助 SSO dashboard 放在 Better Auth Infrastructure/enterprise 语境；自行部署插件与托管 dashboard 是不同能力边界。
- Keycloak 的 organization groups 与 realm groups 隔离；组织组可进 token，但官方说明初始 FGAP 不提供按 members/groups/IdP 子资源的独立管理权限。
- OpenFGA 只负责授权决策/关系数据；官方架构未把其定位为用户目录、OIDC/SAML broker 或 SCIM 服务。

## 与本项目已批准设计的对照

以下是仓库现有设计依据的对照记录，而非对外部产品的额外推断：

- [ADR 0004](../../adr/0004-company-team-tenancy.md) 已接受共享应用 PostgreSQL、全局 User/Principal，以及 Tenant（公司）与 Workspace（公司内平级团队）模型。
- `docs/specs/2026-10-14-company-team-multitenancy-design.md` §5 要求在同一事务内完成成员重验、授权和读写；§6 规定 SCIM 只影响关联 Company。
- `docs/specs/superpowers/2026-10-09-enterprise-ai-platform-design.md` §3 已选 Better Auth；§6 记录当前 MVP 不引入 OpenFGA，并要求未来引入时另立 ADR。
- `docs/specs/2026-10-16-enterprise-personal-agent-product-permissions-spec.md` §2 的目标用户是个人/小企业（该部分标为 draft）。

据此，当前交付建议是 **Better Auth + PostgreSQL + 本地 TypeScript 授权**；保留现有 ActionPolicy/审批/预算/RLS 边界。OpenFGA 的未来定位仅是关系判定服务，不能替代审批、预算或 RLS。OpenFGA 官方一致性文档说明 `HIGHER_CONSISTENCY` 会跳过缓存，但不能修复应用投影积压；官方 best-practices/source-of-truth 与 immutable-models 文档还要求明确 source of truth，并固定用于调用的 `modelId`。[Consistency](https://openfga.dev/docs/interacting/consistency) · [Source of truth](https://openfga.dev/docs/best-practices/source-of-truth) · [Immutable models](https://openfga.dev/docs/getting-started/immutable-models)

## Casdoor 官方能力对照

### 已验证事实

- Casdoor 官方仓库将其定位为可自托管的 IAM/SSO 身份提供者；同一用户目录对外提供 OAuth 2.0、OIDC、SAML 2.0、CAS、LDAP 和 SCIM，另含 WebAuthn/TOTP/MFA。[官方仓库 README](https://github.com/casdoor/casdoor)
- Casdoor 以 Organization 作为用户归属和对象 owner。官方仓库的登录示例使用 `organization/username`，源码创建用户时把 `authForm.Organization` 写入 `User.Owner`；登录/查找也按 application organization 查找用户。[README](https://github.com/casdoor/casdoor) · [account.go](https://github.com/casdoor/casdoor/blob/master/controllers/account.go) · [auth.go](https://github.com/casdoor/casdoor/blob/master/controllers/auth.go)
- 这意味着 Casdoor 的原生用户模型是单个 `User` 记录带一个 organization owner；同一身份跨多个公司/Company 的成员关系不是其该模型的原生多对多 membership 表（这是基于官方 `User.Owner` 模型的推断）。OpenBot 的全局 Principal + 多 Company 成员关系仍需应用侧映射/维护。
- Casdoor 内置 Casbin policy/model 做 ACL、RBAC、ABAC 等授权；官方 CLI 示例直接调用 `enforce`。Casbin 是 Casdoor 内置策略执行层，OpenFGA 是独立关系授权服务，两者没有官方声明的自动互操作或 tuple 同步。[Casdoor README](https://github.com/casdoor/casdoor) · [Casdoor CLI](https://github.com/casdoor/casdoor-cli)
- 官方文档/仓库列出 PostgreSQL；数据库 syncer 也支持从 PostgreSQL 导入用户。[Database syncer](https://casdoor.org/docs/syncer/Database/) · [官方仓库](https://github.com/casdoor/casdoor)
- 官方仓库列出 LDAP“同步自目录或作为 LDAP 服务”、SCIM 2.0 provisioning/de-provisioning。SCIM 与 LDAP 是 Casdoor 目录能力；它们不会自动变成 OpenBot 的 Company membership 语义，需应用侧定义映射。[官方仓库 README](https://github.com/casdoor/casdoor)
- 官方源码包含 WeCom（企业微信）provider 关联/登录逻辑；Casdoor provider 列表和官方文档也覆盖微信、WeCom、DingTalk、Lark/飞书等社会化/企业身份提供商（具体可用项随版本/provider 配置变化）。[auth.go](https://github.com/casdoor/casdoor/blob/master/controllers/auth.go) · [Casdoor providers](https://casdoor.org/docs/provider/overview)

### 限制与推断

- Casdoor 作为“身份目录 + SSO + Casbin 授权”更接近独立 IAM；若仅把它作为现有 Better Auth 的上游 OIDC provider，OpenBot 仍需处理全局 Principal、跨 Company membership、SCIM 关联 Company 和本地审批/RLS。官方资料没有声明 Casdoor 会自动同步这些应用域关系。
- Casdoor 的 organization owner 不能直接表达一个全局用户同时属于多个 Company；可以通过多组织/映射或应用侧关系表补足，但具体方案属于本项目设计，不是 Casdoor 官方保证。
- 与 OpenFGA 的边界同样适用于 Casbin：Casdoor/Casbin 或 OpenFGA 的授权结果不能替代 OpenBot 的 ActionPolicy 审批、预算约束和 PostgreSQL RLS。

### 对当前项目的建议

Casdoor 可行的最小接入路径是作为上游 OIDC provider（项目已有 Casdoor provider server 配置），保留 Better Auth 会话、全局 Principal、多 Company membership 和本地 TypeScript 授权。对当前个人/小企业 MVP，继续采用 Better Auth + PostgreSQL + 本地授权；Casdoor 仅在需要独立身份目录、LDAP/SCIM 或中文企业身份 provider 时再评估。上述建议是工程推断。

## Better Auth UI（最新版官方资料）

- 当前官方 UI 项目是 `better-auth-ui/better-auth-ui`，React 包为 `@better-auth-ui/react`；仓库 README 明确以 shadcn/ui 与 HeroUI 为两套 UI 方案，仓库 MIT。旧资料中的 `@daveyplate/better-auth-ui`/`<AuthUIProvider>` 属于 legacy 文档，不能与当前 API 混用。[官方仓库](https://github.com/better-auth-ui/better-auth-ui) · [React package](https://www.npmjs.com/package/@better-auth-ui/react) · [legacy React docs](https://legacy.better-auth-ui.com/integrations/react)
- 当前 shadcn 安装通过 `npx shadcn@latest add @better-auth-ui/auth`（也可单独安装 settings/user-button/all）；组件复制进应用，数据层由 `@better-auth-ui/react` 提供。[shadcn quick start](https://better-auth-ui.com/docs/shadcn)
- `AuthProvider` 是当前 API，接收 `authClient`、TanStack Router 的 `navigate`、可选 `socialProviders`、`emailAndPassword`、`plugins`、`viewPaths` 与 `queryClient` 等；官方示例使用 `@tanstack/react-router` 的 `useNavigate/useParams`，因此 React + Vite + TanStack Router 可以按 provider/route 方式接入。[AuthProvider](https://better-auth-ui.com/docs/shadcn/components/auth-provider) · [organization plugin example](https://better-auth-ui.com/docs/shadcn/plugins/organization)
- 当前动态认证组件名为 `<Auth />`，可按当前 path 或显式 view 渲染登录、注册、忘记密码等视图；旧版 `<AuthView>` 只出现在 legacy `@daveyplate` 文档。[Auth component](https://better-auth-ui.com/docs/shadcn/components/auth/sign-in) · [legacy AuthView](https://legacy.better-auth-ui.com/integrations/react)
- HeroUI 通过 `@better-auth-ui/heroui` 包提供 packaged React components；shadcn 方案要求项目已有 Better Auth、shadcn/ui、Sonner。[official repository](https://github.com/better-auth-ui/better-auth-ui) · [shadcn prerequisites](https://better-auth-ui.com/docs/shadcn)
- SSO/custom providers 仍由 Better Auth server/client 配置提供；UI 的 `socialProviders` 只控制 provider buttons，不能替代后端 provider、callback route、secret 或数据库迁移。[AuthProvider props](https://better-auth-ui.com/docs/shadcn/components/auth-provider) · [Better Auth SSO](https://better-auth.com/docs/plugins/sso)
- Better Auth server options 可将 `emailAndPassword.enabled` 关闭，或设置 `disableSignUp` 关闭密码注册；这些是 server-side policy。账户删除需要已登录且密码或 fresh session/verification 等条件，sessions 可列出、撤销或在密码变更时撤销其他会话。[options](https://better-auth.com/docs/reference/options) · [email/password](https://better-auth.com/docs/authentication/email-password) · [user/account deletion](https://better-auth.com/docs/concepts/users-accounts) · [session management](https://better-auth.com/docs/concepts/session-management)
- 当前 UI React 数据层依赖 TanStack Query；官方 React 文档要求 `QueryClientProvider` 位于 `AuthProvider` 之上，`AuthProvider` 可接收 `queryClient`。因此登录、登出、账户/会话 mutation 的缓存刷新应通过其 query/mutation helpers 或传入的 QueryClient 处理；不要把旧 `@daveyplate` API 名称推断成当前接口。[React reference](https://github.com/better-auth-ui/better-auth-ui/blob/main/apps/docs/content/docs/react/index.mdx) · [AuthProvider](https://better-auth-ui.com/docs/shadcn/components/auth-provider)

对现有项目的限定结论：Better Auth UI 是前端组件/数据层，不提供 Better Auth server、PostgreSQL adapter、schema migration、SSO provider 或组织业务规则；这些仍需沿用现有后端。以上为官方 API 核对，未修改业务代码。
