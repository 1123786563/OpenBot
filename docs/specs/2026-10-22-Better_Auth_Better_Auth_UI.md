# Better Auth × Better Auth UI：完整功能清单与前后端一一对应矩阵

> **版本基线**：2026-10-22 ｜ **应用场景**：企业 Agent SaaS（OpenBot / Mastra / Next.js + Go Platform Core）｜ **目标**：开源、自托管、可商业化集成  
> **范围声明**：依据公开功能文档进行架构级功能核对；不是固定 npm 版本的逐页 E2E 测试报告。上线前应锁定版本复核 API、组件路径和许可证。

## 目录

1. [项目定位与结论](#1-项目定位与结论)
2. [一一对应状态定义与统计](#2-一一对应状态定义与统计)
3. [94 项详细功能对照矩阵](#3-94-项详细功能对照矩阵)
4. [前后端部署与插件接线方式](#4-前后端部署与插件接线方式)
5. [企业 Agent SaaS 可复用和必须自研的边界](#5-企业-agent-saas-可复用和必须自研的边界)
6. [纯开源与外部依赖检查](#6-纯开源与外部依赖检查)
7. [分阶段实施任务与验收](#7-分阶段实施任务与验收)
8. [官方资料与验证提示](#8-官方资料与验证提示)

## 1. 项目定位与结论

| 项目 | 职责 | 是否为独立管理系统 |
|---|---|---|
| **Better Auth** | 用户身份、登录注册、Session、认证与授权插件、组织成员、API | **不是**开箱即用的独立 IAM 控制台；嵌入 TS/Node 服务，亦可独立部署成 Auth Service |
| **Better Auth UI** | React / Solid 等前端登录、设置、组织管理、授权审批、账户管理组件 | **不是**完整的 SaaS 后台；可用 shadcn/ui 组件源码嵌入应用 |
| **Platform Core（自建）** | Tenant 业务生命周期、Agent / Knowledge / MCP 资源、数据隔离、配额权益、审计与结算 | 需要自行实现或组合额外开源组件 |

**结论**：Better Auth + Better Auth UI 可以构成“身份与组织管理子系统”的完整前后端基础，但不能自动构成完整的“企业 Agent SaaS 平台”。

后端插件、客户端插件、UI 插件的配置应一一配套；部分功能还要部署邮件/短信/支付/计量等服务。**组件已存在 ≠ 安装即启用 ≠ 已完成生产安全验收**。

## 2. 一一对应状态定义与统计

| 状态 | 定义 | 实施动作 |
|---|---|---|
| **完整对应** | 后端 API/插件与现成 UI 表单或页面都有对应 | 安装、接线、配置、测试即可；有时还需附加迁移/外部基础服务 |
| **部分对应** | 有 UI 核心交互，但缺少高级管理或业务闭环 | 扩展组件、后台 API、策略与数据层 |
| **仅后端** | 有插件/API，但无专门的 Better Auth UI 管理控制台 | 仅用于 API 时无需 UI；需要运营管理时自建页面 |
| **外部依赖** | 能力需要第三方 SaaS、收费服务或额外运营设施 | 严格纯开源场景先寻找自托管替代 |
| **需业务开发** | 不属于这两套产品的交付范围 | 在 Platform Core / Agent 平台单独建设 |

本清单共 **94 项（F001–F094）**：

| 编号段 | 类别 | 条目数 |
|---|---|---:|
| F001–F019 | 认证与账户核心 | 19 |
| F020–F032 | 登录方式与验证插件 | 13 |
| F033–F056 | 多租户、组织、权限、管理员 | 24 |
| F057–F074 | API Key、OAuth、MCP、Agent 授权 | 18 |
| F075–F084 | 安全、开发者与基础设施 | 10 |
| F085–F094 | 支付、订阅 UI 与外部提供方 | 10 |

## 3. 94 项详细功能对照矩阵

列说明：**Better Auth 功能**=业务能力；**后端模块/插件**=服务端实现；**Better Auth UI 页面/组件**=复用位置；**条件与缺口**=开发和上线前必须核查之处。

## A. 认证和用户账户（核心）
| 编号 | Better Auth 功能 | 后端模块 / 插件 | Better Auth UI 页面 / 组件 | 状态 | 条件与缺口 |
|---|---|---|---|---|---|
| F001 | 邮箱密码注册 | Core: signUp.email / credentials | SignUp、Auth | 完整对应 | 邮箱发送器需配置 |
| F002 | 邮箱密码登录 | Core: signIn.email | SignIn | 完整对应 | 登录策略由后端控制 |
| F003 | 社交 OAuth 登录 | Core: socialProviders / signIn.social | SignIn SocialProviders | 完整对应 | 需配置第三方 Provider 凭据 |
| F004 | 退出当前会话 | Core: signOut | SignOut、UserButton | 完整对应 |  |
| F005 | 邮箱验证 | Core: emailVerification | VerifyEmail、EmailVerificationEmail | 完整对应 | 需邮件服务 |
| F006 | 忘记密码 | Core: requestPasswordReset | ForgotPassword、ResetLinkSent | 完整对应 | 需邮件服务 |
| F007 | 重置密码 | Core: resetPassword | ResetPassword、ResetPasswordEmail | 完整对应 |  |
| F008 | 修改密码 | Core: changePassword | ChangePassword / SecuritySettings | 完整对应 |  |
| F009 | 更新姓名与头像 | Core: updateUser | UserProfile、UserAvatar | 完整对应 | 头像上传/存储需要配置 |
| F010 | 修改邮箱 | Core: changeEmail | ChangeEmail、ChangeEmailConfirmationEmail | 完整对应 | 需后端启用 |
| F011 | 账号关联/解绑 | Core: linkSocial / unlinkAccount | LinkedAccounts | 完整对应 | 后端必须限制不可用的解除操作 |
| F012 | 查看/撤销会话 | Core: listSessions / revokeSession | ActiveSessions | 完整对应 |  |
| F013 | 账户删除 | Core: user.deleteUser | DeleteUser UI、DangerZone | 完整对应（需启用） | 邮件确认取决于后端设置 |
| F014 | 登录后重定向 | Core Session + callbacks | AuthRedirect | 完整对应 | 开放重定向需进行白名单校验 |
| F015 | 用户按钮及用户展示 | Core: getSession | UserButton、UserView | 完整对应 |  |
| F016 | 自定义用户字段 | Core: additionalFields | Additional Fields 表单渲染 | 部分对应 | 数据规则和数据库迁移需配置 |
| F017 | Session TTL、刷新、缓存 | Core: session settings | 无可视化管理页面 | 仅后端 | 配置文件及监控自建 |
| F018 | 账号及凭据数据库模型 | Core: user/account/session/verification | 无数据库管理页面 | 仅后端 | Better Auth CLI 迁移 |
| F019 | 邮件模板 | Core 邮件回调 | 10 类 Email 模板组件 | 完整对应 | 邮件发送服务另接 |

## B. 登录方式与验证插件
| 编号 | Better Auth 功能 | 后端模块 / 插件 | Better Auth UI 页面 / 组件 | 状态 | 条件与缺口 |
|---|---|---|---|---|---|
| F020 | 双因素 TOTP / OTP | Two Factor Plugin | TwoFactorChallenge、TwoFactorSettings | 完整对应 | 默认不强制覆盖无密码及社交登录 |
| F021 | 备份恢复码 | Two Factor Plugin | TwoFactorChallenge、TwoFactorSettings | 完整对应 | 恢复码安全存储 |
| F022 | Passkey / WebAuthn | Passkey Plugin | Passkey 登录、Passkey 设置卡片 | 完整对应 | 生产域名及 WebAuthn RP 配置 |
| F023 | Magic Link 无密码登录 | Magic Link Plugin | Magic Link 登录表单、MagicLinkEmail | 完整对应 | 邮件服务 |
| F024 | 邮件验证码 | Email OTP Plugin | Email OTP 表单、OtpEmail | 完整对应 | 邮件服务 |
| F025 | 手机验证码与手机号管理 | Phone Number Plugin | PhoneNumber 登录/修改/找回页面 | 完整对应 | 短信网关需另接 |
| F026 | 匿名登录/访客升级 | Anonymous Plugin | Anonymous UI 登录入口/升级流 | 部分对应 | 业务侧要决定匿名数据合并策略 |
| F027 | 用户名登录 | Username Plugin | Username 登录字段/可用性校验 | 完整对应 | 用户名唯一约束 |
| F028 | Google One Tap | One Tap Plugin | One Tap UI 集成 | 部分对应 | Google 组件和域名配置 |
| F029 | Ethereum 钱包登录 | SIWE Plugin | SIWE 登录与钱包设置 | 完整对应 | 钱包签名、nonce 和域名校验 |
| F030 | 通用 OAuth Provider 登录 | Generic OAuth Plugin | 通用社交登录按钮 | 部分对应 | Provider 配置/客户控制台需自建 |
| F031 | 多账号并行登录 | Multi Session Plugin | SwitchAccountSubmenu、ManageAccounts | 完整对应 | 跨账户隔离检查 |
| F032 | 上次登录方式 | Last Login Method Plugin | Last Login Method UI 提示 | 完整对应 | 显示/标记登录方式 |

## C. 多租户、组织、权限和管理员
| 编号 | Better Auth 功能 | 后端模块 / 插件 | Better Auth UI 页面 / 组件 | 状态 | 条件与缺口 |
|---|---|---|---|---|---|
| F033 | 组织创建 | Organization Plugin | CreateOrganizationDialog | 完整对应 |  |
| F034 | 组织列表与选择 | Organization Plugin | Organizations、OrganizationSwitcher | 完整对应 |  |
| F035 | 个人空间与企业空间切换 | Organization Plugin | OrganizationSwitcher | 完整对应 | 个人空间是 UI 上下文，业务资源归属自建 |
| F036 | 编辑组织名称、Logo、Slug | Organization Plugin | OrganizationProfile | 完整对应 | Logo 存储另配 |
| F037 | 离开/删除组织 | Organization Plugin | OrganizationDangerZone、确认弹窗 | 完整对应 | 业务资产清理需自建 |
| F038 | 组织成员列表 | Organization Plugin | OrganizationMembers | 完整对应 | 组织成员表格部分过滤在客户端 |
| F039 | 邀请/重发/取消邀请 | Organization Plugin | InviteMemberDialog、OrganizationInvitations | 完整对应 | 邮件发送需配置 |
| F040 | 接受/拒绝邀请 | Organization Plugin | AcceptInvitation、UserInvitations | 完整对应 |  |
| F041 | 成员角色修改/移除 | Organization Plugin | OrganizationMembers、RemoveMemberDialog | 完整对应 |  |
| F042 | 组织 RBAC | Organization Plugin access control | OrganizationRoles / 角色选择 | 完整对应 | 需配置资源和动作定义 |
| F043 | 动态角色增删改 | Organization dynamicAccessControl | OrganizationRoles 权限矩阵 | 完整对应（需启用） | 需要服务端和 UI 双侧配置 |
| F044 | 团队管理 | Organization Teams | Teams Tab、TeamSwitcher | 完整对应（需启用） | 配额限制后端强制 |
| F045 | 团队成员分配 | Organization Teams | Teams Member Management | 完整对应（需启用） |  |
| F046 | 组织扩展配置/容量限额 | Organization callbacks、limits | 基础组织设置+扩展插槽 | 部分对应 | 配额决策由业务后台定义 |
| F047 | 平台用户搜索/列表 | Admin Plugin | Admin、AdminUsers | 完整对应 |  |
| F048 | 管理员创建/编辑用户 | Admin Plugin | AdminUsers 用户详情 | 完整对应 |  |
| F049 | 禁用/解禁用户 | Admin Plugin | AdminUsers | 完整对应 |  |
| F050 | 管理员模拟用户 | Admin Plugin | Admin 用户详情、StopImpersonating | 完整对应 | 需审计与保护敏感动作 |
| F051 | 管理员管理会话 | Admin Plugin | User Inspector Sessions | 完整对应 |  |
| F052 | SSO 企业身份发现/登录 | SSO Plugin | EmailFirstSignIn | 部分对应 | 企业 IdP 申请/审批/管理控制台仍需建设 |
| F053 | SCIM 企业用户组同步 | SCIM Plugin | 无专门 SCIM 管理控制台 | 仅后端 | 目录连接、映射和同步异常 UI 需自研 |
| F054 | 跨租户资源授权 | Organization + 业务授权 | 无通用资源实例 ACL 编辑器 | 需业务开发 | 推荐平台授权层/OpenFGA |
| F055 | 多租户数据隔离 | 无通用隔离引擎 | 无 | 需业务开发 | DB RLS、对象存储、向量检索隔离 |
| F056 | 订阅/Entitlement/配额 | 非 Organization 原生 | Billing UI 可展示一部分 | 需额外系统 | 独立计费/权益系统 |

## D. API Key、OAuth、MCP、Agent 授权
| 编号 | Better Auth 功能 | 后端模块 / 插件 | Better Auth UI 页面 / 组件 | 状态 | 条件与缺口 |
|---|---|---|---|---|---|
| F057 | 个人 API Key 创建、展示、删除 | API Key Plugin | ApiKeys、CreateApiKeyDialog | 完整对应 | 密钥仅在创建后展示一次 |
| F058 | 组织 API Key | API Key Plugin + Organization | OrganizationApiKeys | 完整对应（需配置） | 明确启用组织级配置 |
| F059 | API Key 过期和使用量 | API Key Plugin | ApiKeys 状态、到期及用量显示 | 部分对应 | 自定义限流策略/Metadata 表单自建 |
| F060 | JWT 签发与 JWKS | JWT Plugin | 无专门管理 UI | 仅后端 | 服务侧验签与授权 |
| F061 | Bearer Token | Bearer Plugin | 无专门管理 UI | 仅后端 | API 服务集成 |
| F062 | One-time Token | One-Time Token Plugin | 无专门管理 UI | 仅后端 | Token 消费流程由业务触发 |
| F063 | 开发/预览 OAuth Proxy | OAuth Proxy Plugin | 无专门管理 UI | 仅后端 | 开发环境基础设施配置 |
| F064 | OAuth 2.1 授权同意 | OAuth 2.1 Provider | OAuthConsent | 完整对应 |  |
| F065 | OAuth 注册继续流程 | OAuth 2.1 Provider | OAuthSignUp | 完整对应 |  |
| F066 | OAuth 选择账户 | OAuth 2.1 Provider + MultiSession | OAuthSelectAccount | 完整对应（需插件） |  |
| F067 | OAuth 已授权应用 | OAuth 2.1 Provider | AuthorizedApplications | 完整对应 | 删 Consent 不等于立刻吊销已签发 Token |
| F068 | 个人 OAuth Client 管理 | OAuth 2.1 Provider | OAuth Client Settings | 完整对应（需启用） | 密钥轮换仅显示一次 |
| F069 | 组织 OAuth Client 管理 | OAuth 2.1 Provider | 可接 OAuthClientManager 的组织 UI | 部分对应 | 需自建组织级 Manager API |
| F070 | OAuth Device Code 授权 | Device Authorization Plugin | DeviceAuthorization | 完整对应 | CLI/设备需调用轮询端点 |
| F071 | MCP OAuth 资源保护 | MCP Plugin | 共用 OAuth 基础 UI，无 MCP 专属管理台 | 部分对应 | MCP Registry/Tool Policy 自建 |
| F072 | Agent 能力授权审批 | Agent Auth Plugin | AgentApproval | 完整对应（实验性） | Agent Auth 协议/API 演进中 |
| F073 | Agent 已授权能力撤销 | Agent Auth Plugin | Agent Grants Security Card | 完整对应（实验性） | 对实际工具仍需强制策略校验 |
| F074 | Agent Registry/Tool Registry | 不属于 Better Auth | 无 | 需业务开发 | 建议自建 Agent SaaS 平台模块 |

## E. 安全、开发者与基础设施
| 编号 | Better Auth 功能 | 后端模块 / 插件 | Better Auth UI 页面 / 组件 | 状态 | 条件与缺口 |
|---|---|---|---|---|---|
| F075 | 验证码防机器人 | Captcha Plugin | Captcha UI 接入 | 部分对应 | 需选择配置外部验证提供商 |
| F076 | 已泄露密码检测 | Have I Been Pwned Plugin | 无专门设置界面；错误提示可通过 Auth 表单 | 仅后端/间接 UI | 需要外部数据查询 |
| F077 | 认证错误国际化 | i18n Plugin | Locales + AuthProvider 文案覆盖 | 部分对应 | UI 和后端错误文本需各自配置 |
| F078 | OpenAPI 文档生成 | Open API Plugin | 无管理 UI | 仅后端 | 可生成接口文档 |
| F079 | 集成/E2E 测试工具 | Test Utils Plugin | 无运行时 UI | 仅开发工具 |  |
| F080 | OAuth 引流归因 | Dub Plugin | 无对应管理 UI | 仅后端/外部 | 需要 Dub 服务 |
| F081 | 主题切换 | Better Auth 非必须 | Theme UI Plugin | UI 单侧能力 | light/dark/system |
| F082 | UI Provider/SSR/数据 Hooks | Better Auth SDK | AuthProvider、React Query、SSR helpers | 完整对应 | 路由/守卫须自行挂载 |
| F083 | 活动/审计日志 | Dash / Better Auth Infrastructure | Dash Activity | 外部依赖 | 非纯开源独立审计后端 |
| F084 | 企业安全策略总控台 | 部分 API/插件 | 无统一完整控制台 | 需业务开发 | 需要策略、审计、风控组合 |

## F. 支付订阅 UI 与外部提供方
| 编号 | Better Auth 功能 | 后端模块 / 插件 | Better Auth UI 页面 / 组件 | 状态 | 条件与缺口 |
|---|---|---|---|---|---|
| F085 | Stripe 订阅/套餐 | Stripe Plugin | Billing UI + Stripe Adapter | 对应，外部服务 | Stripe 不属于自托管开源支付服务 |
| F086 | Polar 订阅/套餐 | Polar Plugin | Billing UI + Polar Adapter | 对应，外部服务 | 组织级操作需按适配器能力检查 |
| F087 | Autumn 账单权益 | Autumn Billing Plugin | Billing UI + Autumn Adapter | 对应，外部服务 | 适配器为用户范围 |
| F088 | Creem 订阅 | Creem Plugin | Billing UI + Creem Adapter | 对应，外部服务 | 适配器为用户范围 |
| F089 | Dodo Payments 支付 | Dodo Payments Plugin | Billing UI + Dodo Adapter | 对应，外部服务 | 适配器为用户范围 |
| F090 | Commet 订阅/用量 | Commet Plugin | Billing UI + Commet Adapter | 对应，外部服务 | 适配器为用户范围 |
| F091 | 计费计划/套餐展示 | Billing Provider | PricingPlans、Billing View | UI 已有 | 需要提供计划数据和适配器 |
| F092 | 升级/取消/恢复/席位 | Provider Billing API | Billing View | 部分对应 | 各支付商支持的操作不相同 |
| F093 | 用量仪表和余额 | Provider Billing API | Metered Usage UI | 部分对应 | 需接真实 Usage/Balance |
| F094 | 全开源 Credits 计量结算 | Better Auth 不提供 | 可复用 Billing UI 适配 | 需业务开发 | 可开发 OpenMeter/Flexprice Adapter |


## 4. 前后端部署与插件接线方式

### 4.1 推荐模式

```text
OpenBot / Next.js / Mobile
    │  Web: Cookie Session；Mobile/独立服务: Token/OIDC（按客户端选型）
    ▼
Better Auth（Next.js Route 或独立 TS Auth Service）
    ├── Core Auth / Sessions / Account
    ├── Organization / Admin / RBAC
    ├── JWT / API Key / OAuth / MCP（按需求启用）
    └── PostgreSQL（身份库）
    │
    ├── Better Auth UI：Auth / Settings / Organization / Admin / Billing UI
    │
    ▼
Go Platform Core ←→ Mastra Agent Runtime
    ├── Tenant / Membership 业务投影、Entitlement、Audit
    ├── Agent / Knowledge / MCP / Memory 资源授权
    └── PostgreSQL RLS / 对象存储前缀 / 向量索引租户过滤
```

### 4.2 三端配置必须对应（以 Organization 为例）

**服务端**：启用 `organization()`；**客户端**：启用 `organizationClient()`；**UI**：安装 `@better-auth-ui/organization`，注册 `organizationPlugin()` 并挂载页面。

```bash
# shadcn/ui registry（前提：项目已安装 Better Auth、shadcn/ui、Sonner）
npx shadcn@latest add @better-auth-ui/auth
npx shadcn@latest add @better-auth-ui/settings @better-auth-ui/user-button
npx shadcn@latest add @better-auth-ui/organization
npx shadcn@latest add @better-auth-ui/admin
npx shadcn@latest add @better-auth-ui/api-key
```

> 注意：这里是前端安装命令。后端 Better Auth 插件需要单独配置，必要时执行 schema/migration。组织业务资源不能仅依赖前端 `setActive()` 的值完成授权。

### 4.3 最简 Organization 后端与客户端示例

```ts
// auth.ts（示例片段）
import { betterAuth } from 'better-auth'
import { organization } from 'better-auth/plugins'
export const auth = betterAuth({
  // database: your PostgreSQL adapter / pool
  plugins: [organization({ teams: { enabled: true } })],
})

// auth-client.ts（示例片段）
import { createAuthClient } from 'better-auth/react'
import { organizationClient } from 'better-auth/client/plugins'
export const authClient = createAuthClient({
  plugins: [organizationClient({ teams: { enabled: true } })],
})
```

> 示例仅演示插件配对，不是可以直接部署的完整服务。项目仍需配置数据库、SESSION/SECRET、域名、可信来源、邮件发送和 Next.js Route Handler。

## 5. 企业 Agent SaaS 可复用和必须自研的边界

| 平台能力 | 对应情况 | 实施建议 |
|---|---|---|
| 登录注册、Session、MFA | Better Auth + Better Auth UI 可复用 | 优先直接复用 F001–F032 |
| 企业创建、成员邀请、角色、团队 | Organization 后端与 UI 可复用 | 优先直接复用 F033–F046 |
| 平台管理员用户管理 | Admin 后端与 UI 可复用 | 使用 F047–F051，并强化模拟登录审计 |
| 企业客户 SSO | 登录 UI 可用；IdP 管理后台需额外设计 | 先做单个企业集成，再开放客户自助配置 |
| OAuth 客户端/授权/设备码 | 部分 UI 已存在 | 参考 F064–F070，校验 Token 安全策略 |
| Agent 身份能力审批 | 新增插件与授权 UI | 作为实验功能评估，**不能替代后端强制权限检查** |
| Agent、Skill、Knowledge、MCP 业务资源 | **不属于**这两套产品 | 自建 Registry / Resource APIs / 管理页面 |
| 资源级细粒度 ACL | Organization RBAC 不充分 | 初期业务授权；复杂共享关系再引入 OpenFGA |
| 数据隔离 | **不属于**认证框架职责 | 所有资源携带 tenant_id，DB RLS、缓存键、向量查询、对象存储、后台任务均需隔离 |
| 计量、配额、Credits | Billing UI 可复用，结算非原生 | 用开源计量/计费系统，并开发 BillingAdapter |
| 全链路审计 | Better Auth UI Dash 需外部服务 | 自建 OSS Audit Service，统一 tenant/user/run/trace 维度 |

### 特别需要防范的四类误用

1. **以 Active Organization 替代鉴权**：组织切换只标记上下文，资源读取和工具调用必须在服务端验证 Membership + Permission + Resource Tenant。
2. **以 API Key 代替模型计费**：Better Auth API Key 不是模型 Token/成本/预算账本；模型网关仍需执行相应治理。
3. **以 OAuth Consent 撤销等同 Token 即刻失效**：应同时配置 Token 撤销、有效期、Introspection 或服务端拒绝列表策略。
4. **以 UI 权限隐藏代替服务端授权**：Agent Tool、MCP Server、异步 Job、Memory Retriever 都必须重复进行服务端校验。

## 6. 纯开源与外部依赖检查

| 组件/能力 | 严格全开源策略 | 风险或注意 |
|---|---|---|
| Better Auth 核心 | 可自托管，代码开源 | 锁定所用版本和实际插件许可证 |
| Better Auth UI | 使用开源 shadcn/ui 组件源码 | Better Auth UI 是独立社区项目，应单独跟踪发布与兼容性 |
| Organization / Admin / JWT / API Key | 可作为开源身份子系统组合 | 本身不保证 SaaS 业务数据隔离 |
| Better Auth Infrastructure / Dash Activity | **不作为必须依赖** | Dash UI 对接 Infrastructure 服务，不是纯开源自托管审计方案 |
| Stripe / Polar / Autumn 等 BillingAdapter | 可复用 UI 层，不把提供方计入 OSS 基础设施 | 这些是第三方服务集成，非本地开源结算服务 |
| OpenMeter / Flexprice | 研究其具体 OSS 许可证及功能范围后选择 | 不把项目所有 Enterprise 功能视为免费开源；需自建 UI Adapter |
| 企业 SSO / SCIM | 使用可自托管的已公开插件/协议能力 | 对照锁定版本核查收费边界与 IdP 自助管理流程 |
| 外部邮件/短信服务 | 选择自建邮件设施或可替换 Provider | 代码开源不意味着发送服务免费/无依赖 |
| 支付通道 | 账务系统可以开源 | 银行卡等真实支付清算通常仍涉及外部持牌支付通道 |

**许可证备注**：Better Auth 和 Better Auth UI 仓库分别维护；整合商业产品前，应以实际安装版本、所用插件及其直接依赖的 `LICENSE`/发布包为最终依据。纯开源要求不宜只核对顶层仓库许可证。

## 7. 分阶段实施任务与验收

| 阶段 | 任务 | 对应功能编号 | 关键验收 |
|---|---|---|---|
| P0 | 认证与账户中心 | F001–F019 | 注册/登录/退出/改密/会话撤销可用；未登录资源拒绝访问 |
| P0 | 多租户组织管理 | F033–F046 | A/B 两企业可切换，跨企业请求不可越权；邀请角色正确生效 |
| P0 | 平台管理员功能 | F047–F051 | 禁用用户后无法继续访问；模拟登录可审计 |
| P0 | JWT / API Key（如启用） | F057–F061 | Key 撤销与 Token 到期生效；Go 服务严格验签/鉴权 |
| P0 | 后台租户数据隔离 | F054–F056 | API、DB、对象、检索、任务全部具备越权测试 |
| P1 | 无密码、安全认证 | F020–F032 | OTP 频控、Passkey RP、2FA 恢复、账号关联安全测试 |
| P1 | 企业 SSO / SCIM | F052–F053 | JIT/映射/禁用/跨租户 SSO 与成员同步测试 |
| P1 | OAuth 与 Device Flow | F064–F070 | PKCE、Scope、回调白名单、Device Code 过期及拒绝测试 |
| P2 | MCP / Agent 授权 | F071–F074 | OAuth Token 与 Tool Policy 组合有效，审批前不得执行 |
| P2 | 纯开源 Billing UI 适配 | F085–F094 | 每次调用核对组织授权、幂等计量、退款和结算一致性 |
| P2 | 开发者工具、审计与监控 | F075–F084 | 安全事件、Trace、审计字段满足企业合规要求 |

### 上线前必测案例

- 用户 U 同时属于租户 A 和 B；A 为 owner，B 为 member，无法执行 B 的管理员操作。
- 未授权租户无法根据猜测到的 Agent ID、Knowledge ID、MCP ID 读取或执行资源。
- 被移除组织成员后，旧浏览器 Session、API Key、已发 Token 不能继续产生越权操作（注意 Token 撤销传播与短 TTL）。
- Memory、RAG、Artifact、沙箱工作区及后台任务不能跨租户读取。
- 组织级 BillingAdapter 禁止使用未经校验的前端 `organizationId` 读取其他组织账单。
- 用户模拟登录、权限变更、密钥创建/撤销都生成不可篡改或可追溯的审计事件。

## 8. 官方资料与验证提示

- Better Auth 功能与插件列表：https://better-auth.com/docs/plugins
- Better Auth OAuth Provider：https://better-auth.com/docs/plugins/oauth-provider
- Better Auth MCP：https://better-auth.com/docs/plugins/mcp
- Better Auth GitHub：https://github.com/better-auth/better-auth
- Better Auth UI GitHub：https://github.com/better-auth-ui/better-auth-ui
- Better Auth UI shadcn/ui Quick Start：https://better-auth-ui.com/docs/shadcn
- Better Auth UI Organization：https://better-auth-ui.com/docs/shadcn/plugins/organization
- Better Auth UI Admin：https://better-auth-ui.com/docs/shadcn/plugins/admin
- Better Auth UI OAuth Provider：https://better-auth-ui.com/docs/shadcn/plugins/oauth-provider
- Better Auth UI Agent Auth：https://better-auth-ui.com/docs/shadcn/plugins/agent-auth
- Better Auth UI Device Authorization：https://better-auth-ui.com/docs/shadcn/plugins/device-authorization
- Better Auth UI API Key：https://better-auth-ui.com/docs/shadcn/plugins/api-key
- Better Auth UI Billing：https://better-auth-ui.com/docs/shadcn/plugins/billing
- Better Auth UI Dash：https://better-auth-ui.com/docs/shadcn/plugins/dash

**更新建议**：后续升级 Better Auth 或 Better Auth UI 时，逐条以 F001–F094 编号记录 API、组件、数据库迁移、许可证和 E2E 变化；不得仅以插件列表中出现某项名称来认定其已上线。
