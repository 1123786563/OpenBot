# Better Auth 接入：验收映射与验证方法

本文件是 [主计划](plan.md) 的验收方法，不是测试执行报告。所有编号来自 [v2.3 Spec](../../specs/2026-10-22-better-auth-full-integration-design.md)，旧规格/旧 Issue 的测试注释仅作为现有实现背景，不能充当此次需求或通过证据。

## 1. 候选需求覆盖

| 需求 | 实现任务 | 最终验收 |
| --- | --- | --- |
| BA-R01 身份/业务 ID/payer 保留 | P03、P06、P12、P22 | BA01、BA15 |
| BA-R02 目录唯一写权威与原子性 | P01、P03、P04、P08、P12、P23 | BA08、BA09、BA18 |
| BA-R03 公司/邀请/角色/owner 生命周期 | P04、P06、P08、P10、P13 | BA04、BA05、BA06 |
| BA-R04 管理/财务/内容分权 | P08、P09、P10、P14、P18 | BA03、BA04、BA17 |
| BA-R05 显式范围、切换/流/缓存 | P05、P07、P19、P20、P21 | BA02、BA13 |
| BA-R06 即时新准入撤权与持久版本 | P03、P04、P05、P08、P12、P14、P15、P16、P22 | BA06、BA07、BA14、BA19 |
| BA-R07 SSO/SCIM 与会话公司证明 | P11、P12、P13、P16、P19、P20 | BA10、BA20 |
| BA-R08 全业务与启用外部能力隔离 | P14、P15、P16、P17、P21、P23 | BA02、BA03、BA09、BA14、BA16 |
| BA-R09 固定发起范围与付款 | P06、P16、P18 | BA11、BA12 |
| BA-R10 BA UI 与现有客户端/账户恢复/空态 | P02、P07、P08、P10、P12、P13、P17、P19、P20、P21 | BA01、BA05、BA13、BA17 |
| BA-R11 平台/审计/容量/财务控制 | P04、P06、P08、P12、P13、P18 | BA04、BA05、BA08、BA12 |
| BA-R12 迁移/恢复/单权威切换门槛 | P01、P03、P04、P25、P05及迁入gate各Task、P22、P23、P24 | BA15、BA16、BA18、BA19 |

## 2. BA01–BA20 的任务与测试位置

表中测试文件均为计划创建或扩展；不表示现在已存在或已通过。后端新套件统一位于 `server/tests/better-auth/`，Web 组件套件统一位于 `app/tests/better-auth/`。具体测试名与断言见各 Task；P24 汇总这些证据和下面的真实环境补验，不能仅将一张“通过”表当作证据。

| 验收 | 主责任务 | 必需测试文件 / 入口 | 关键判定与真实环境 |
| --- | --- | --- | --- |
| BA01 | P02、P08、P12、P13、P22 | `remote-identity-binding.test.ts`、`migration-recovery.test.ts`；Web `account-assurance.test.tsx` | 原账户/会话/account/password/历史 Run/订单/付款方不重复；已启用登录与客户端正向；密码部署真实 request-reset→邮件→设密码→重新登录，纯 SSO 保持关闭 |
| BA02 | P05、P07、P14 | `selection-api.test.ts`、`business-resource-matrix.test.ts`；Web `scope-selection.test.tsx` | A/B、伪 selector、A tenant+B team、猜 ID；显式目标不跟随 active |
| BA03 | P14、P21 | `business-resource-matrix.test.ts`；Web `business-scope-matrix.test.tsx` | 公共 Bot 正向、同团队私有/凭据拒绝、共享动作/依赖不扩大 |
| BA04 | P06、P08、P12、P18 | `membership-lifecycle.test.ts`、`provisioning-global-admin.test.ts`、`billing-capacity-audit.test.ts` | 最后 owner 并发、跨公司身份角色、财务/内容/平台分权 |
| BA05 | P04、P06、P08、P10、P13、P18 | `company-lifecycle.test.ts`、`membership-lifecycle.test.ts`、`principal-registry.test.ts`、`email-verification.test.ts`；Web `directory-pages.test.tsx`、`account-assurance.test.tsx` | 初始化失败保持 provisioning；无 Principal 新用户验证邮箱后接受邀请，同事务唯一主体/clock/投影；邀请状态/角色/并发席位、真实提交后邮件 |
| BA06 | P05、P08、P15、P16 | `scope-generations.test.ts`、`download-revocation.test.ts`、`execution-revocation.test.ts` | 真实共享/排他锁时序；撤权先提交后新业务/敏感动作拒绝 |
| BA07 | P03、P04、P05、P09、P14、P16、P18 | `directory-command.test.ts`、`scope-generations.test.ts`、`scoped-team-admin.test.ts`、`credential-source-generations.test.ts`、`execution-revocation.test.ts`、`billing-capacity-audit.test.ts` | 删除再加入/恢复不复活旧 Scope/资源及财务 Grant/审批/lease、凭据动作及个人凭据；新 Scope 也不能凭旧来源签新 lease/解密；幂等不增版 |
| BA08 | P01、P04、P08、P12、P23 | `transaction-contract.test.ts`、`directory-command.test.ts`、`principal-registry.test.ts`、`identity-command.test.ts`、`provisioning-global-admin.test.ts`、`personal-model-identity.test.ts`、`ingress-coverage.test.ts`、`mounted-assembly.test.ts` | Principal/BA/clock/投影/审计/outbox 每阶段故障全回滚；Identity 的 User/Principal/代际/session/proof 同样全回滚；BA 权威下 HTTP/auth.api/SCIM/JIT/Admin/CLI/startup 无信封不可写；延迟 hook 不丢、不用全局连接补写，SCIM HTTP 首建故障 roles/SCIM投影/member/clock 全回滚 |
| BA09 | P03、P05、P14、P23 | `schema-roles.test.ts`、`scope-generations.test.ts`、`mounted-assembly.test.ts` | 真实受限角色/RLS/复合 FK、池复用、存储/授权故障及 schema mismatch |
| BA10 | P01、P04、P11、P12、P23 | `sso-evidence-contract.test.ts`、`company-assurance.test.ts`、`provisioning-global-admin.test.ts`、`ingress-coverage.test.ts` | 密码/A IdP session 不满足 B proof；SCIM A deactivate 保留 B；无邀请/无 Principal 首次 provisioning；批准规则团队加入、撤规则/跨公司/能力跨请求拒绝；每个原生目录 GET 的暂停成员/暂停公司/缺 proof 反例；OIDC/SAML 签名断言时间与 state/RelayState 绑定；已启用真实 IdP/SCIM 测试租户；SSO 回调携带 provider.organizationId 不创建 member（organizationProvisioning 禁用） |
| BA11 | P16、P18 | `execution-revocation.test.ts`、`billing-capacity-audit.test.ts` | 真 Run/Job 领取重放/重试/恢复/离职保持 payer，proof 到期挂起，外部事实不重复 |
| BA12 | P18、P21 | `billing-capacity-audit.test.ts`；Web `business-scope-matrix.test.tsx` | 多团队同余额并发、个人 Key/账户分离、财务动作与用量账本对账 |
| BA13 | P07、P19、P20、P21 | Web `scope-selection.test.tsx`、`business-scope-matrix.test.tsx`；Desktop CompanySelection/OrgLocalState；Mobile tenancy/three-client-selection 和 `tests/e2e/better-auth/mobile/app.e2e.ts` | 真实 Mobile App/MuseApi/CopilotKit/媒体接线及 Web 多标签、Desktop、启用 iOS/Android 的真实回调/切换/登出/撤权；适配层测试不能替代 native |
| BA14 | P14、P15、P17、P21 | `business-resource-matrix.test.ts`、`download-revocation.test.ts`、`external-surface-matrix.test.ts` | 实际存储旧 URL/CDN、代理新请求/HEAD/Range/批次、lease、沙箱/浏览器/Memory/观测 |
| BA15 | P03、P04、P25、P22 | `schema-roles.test.ts`、`migration-expand.test.ts`、`migration-recovery.test.ts` | 同名/重复 workspace ID 保留、集合/哈希/FK/payer/owner、legacy/ba/paused 读写、M3→M4 同请求矩阵和真实备份恢复/回退；legacy tenant 回填获得按 interfaces §2 规则派生的确定性唯一 slug |
| BA16 | P17、P23、P24 | `external-surface-matrix.test.ts`、`mounted-assembly.test.ts`；`tests/config/better-auth-surfaces.json` | 固定版所有 Admin/Organization 读写逐项处置，删除/模拟登录/动态角色后端拒绝；全部实际路由/consumer/client/启用 provider 有正反证据；无未知例外 |
| BA17 | P01、P09、P10 | `scoped-team-admin.test.ts`；Web `directory-pages.test.tsx` | 从公司管理 API 授予/撤销/重授新团队 Grant 后，普通 member 仅甲团队成功，乙/公司角色/外部邀请/原生 BA 入口拒绝；不得自行委派，双身份/规则来源审计 |
| BA18 | P01、P04、P08 | `transaction-contract.test.ts`、`directory-command.test.ts`、`membership-lifecycle.test.ts` | 实际 adapter 合法中间顺序可提交；缺 member/缺终结/故障无半份状态或提前邮件 |
| BA19 | P03、P22 | `migration-recovery.test.ts` | 保留旧/新 Grant/审批/lease 及凭据授权来源，移除再加、重建不改 clock；内部自洽的旧恢复点无可信撤权高水位也拒绝重开；缺失/倒退/丢 tombstone 阻断 |
| BA20 | P11、P12、P13、P19、P20 | `company-assurance.test.ts`；Web `account-assurance.test.tsx`；native 实际回调 | 超时/策略/安全代际/session revoke/续期/重放/换账号/轮换/未知 claims 均有确定结论 |

## 2.1 补充合同的必需验证

下列为新增的验收证据要求，状态均为待实施验证，不因写入文档成为已通过。

| 合同 / 来源 | 生产任务与入口 | 必需反例及正向 |
| --- | --- | --- |
| F01 凭据来源 | P03/P14 source schema/authorizeUse/disclosePlaintext，P16 lease.issue，P22 recovery | 保留旧 use/disclose 和个人 owner，移除再加拿新 Scope，旧 lease/新 lease/直接明文均拒绝；显式新授权才成功，B 公司不受影响 |
| F02 真实 Mobile 接线 | P20 实际 App/MuseApi/CopilotKit/媒体，P12/P17 BFF | 断开实际挂载使浏览器用例失败；真实 native 回调、切换、旧响应/旧流、下载撤权单列 |
| F03 团队 Grant 生产 | P09 真实 management-grants POST/DELETE，P10 UI | 公司管理者授予→普通 member 只管理甲团队→撤销后含 receipt 重放拒绝→重授新版本；自行委派/乙团队/原生 BA 管理拒绝 |
| F04 首次 provisioning | P04 注册 member.provision，P12 SCIM HTTP/JIT callback | 无邀请首次建立成员成功，已在 B 的同主体加入 A 不影响 B；每步故障回滚，重放不增版/不覆盖角色；factory 硬前提 `sso({organizationProvisioning:{disabled:true}})` 启动拒绝相反配置，ingress 拒绝客户端 organizationId，M2 inventory 核验 `sso_providers.organization_id` 存量为空 |
| F05 邮箱验证 | P08 email-verification.test.ts + 实际邮件，P13 UI | signup→发送/重发→验证→邀请接受；过期、邮箱变化、错账号拒绝，验证不能签公司 SSO proof |
| F06 逐文件登记 | 每个新增测试 Task，P24 coverage audit | RED/GREEN 目标文件/用例确实执行，0 collection error/非 skip；漏登记失败，native/driven 不重计 |
| M1 全局身份 | P04 identity-command.test.ts，P12 实际 Admin/session/旧 role | user/Principal/identityGeneration/session/proof/审计/outbox 任一步失败全回滚；恢复不复活旧能力；无 envelope 的 seedRole/安全写拒绝 |
| M2 Principal 首建 | P04 principal-registry.test.ts，P06/P08/P12 公共命令 | 无主体新用户并发接受或 provisioning 仅一行；故障不留孤立主体；既有 suspended/损坏历史不能被 ensure 恢复或重置 |
| M3 规则授权依据 | P12 provisioning-global-admin.test.ts/真实 SCIM | 批准 rule 加团队成功；未批准/撤销/过期 revision/跨公司/跨请求复用拒绝，审计记规则而非假 Grant |
| L1 文件及共享边界 | P02/P14/P20/P22 派发前清单预检 | UI 根目录与清单一致，P14 在迁移共享链，P22 未提交前置文件检查点已明确，子模块源码独立冻结 |

## 2.2 本版确认缺陷的逐项验收（F1–F4 / H1–H4 / M1–M3 / L1–L3）

这些编号与 §2.1 的旧 F01–F06/M1–M3 分开，不因重名覆盖历史结论。此表全是**待实施验收要求**；本轮文档自检不能替代以下运行证据。

| Finding | owner / test | 必需断言与入口 |
| --- | --- | --- |
| F1 | P03/P12/P16/P18/P25/P22；personal-model-identity、gateway-identity-admission、billing-capacity-audit | 实际挂载 Bot Service claim/renew 禁用前成功；disable 提交且 outbox 暂停后两者拒绝；restore 后原 Grant 仍拒绝。原有效 Key 从实际启用网关入口新请求不得 dispatch；显式重授权原子撤旧 stale-active/new grantId，兼容原唯一索引、并发仅一 active、新 Key 正向，旧 Key 不换绑。保留个人 payer/历史费用，公司移除不误撤个人授权；credit-reserve 辅助用例不足 |
| F2 | P12 mobile-authority-contract、P17 mobile-bff-contract、P20 真 App | 同时覆盖登录、原 Workspace 首屏 DTO、一次 CopilotKit 流、媒体读取、公司追加认证；逐条最终 route/actor/company/team。App 断开到新 BFF 接线必失败，enterprise 的 standalone accessKey 拒绝；服务器合同未 verified 不放行 P20 |
| F3 | P08 password-recovery、P12/P13 account-assurance 与 session.e2e | request-reset→真实收邮件→原生 POST 设密码→重新登录；原生 route 唯一消费、actor 校验不消费，故障 token 可重试且 hash/代际/session/proof 不变，并发仅一次成功。outbox 失败即使 BA 吞错也回滚 token/意图，迟到 callback 不写库/发信；3600 秒过期、重复消费、恶意 redirectTo 均拒绝。旧 session/proof/适用长期能力与个人 Grant/Key 失效，disabled 身份不恢复；纯 SSO 不开放。邮箱验证测试不得替代 |
| F4 | P10/P20 e2e-browser-isolation，P24 audit | 默认/BA Web/BA Mobile 静态收集互斥且文件/config/实际 target/preflight 一一对应；缺任何必需 origin 时能收集该套件的入口在访问前非零退出。Mobile 不得访问默认 3010，错 target 也失败；无数据库/业务服务可验证 |
| H1 | P01 transaction-contract、P04/P12 实际 SCIM HTTP | deferred_after_hooks_are_classified_not_dropped、after_hook_writes_cannot_use_global_connection；角色/SCIM投影/成员/clock 每个迁入 finalizer 的 hook 步骤故障，全提交或全不存在；固定内部缓存三来源逐项登记：禁用存储时 refresh no-op 提交后恰一次/零缓存 I/O，另两者不登记；启用 secondaryStorage/cookieCache 在 route 前拒绝；允许队列 commit 后恰一次，回滚不执行 |
| H2 | P01 sso-evidence-contract、P11 company-assurance | 签名 OIDC 与 SAML 测试 IdP 各一，authenticated_at 等于 id_token auth_time/断言 AuthnInstant，strength 来自验证的声明；改变 state/nonce/RelayState/InResponseTo 后无 proof 落库。正常 BA callback 不等于已有原始证据，任一启用协议不具备合同则 blocked |
| H3 | P04/P11/P23 ingress-coverage/mounted-assembly | 对 interfaces §3.2 的每个 BA organization 原生 GET 独立断言：暂停成员/暂停公司/缺证明均 403或404；X 类 GET（含原生发现/本人邀请）后端拒绝；OpenBot 自有窄读 adapter 只见本人且过滤失效资格/邀请。每个端点均有可对账 testId，不能只测一条 list-members |
| H4 | P04 基础 authority-matrix/P25 migration-expand，相关 Task legacy_authority_keeps_existing_tenancy_green，P22 migration-recovery | M0/M1 原 gate/旧受控写保留，缺 BA clock 不拒旧租户；M2/M3 各 writer 暂停，M4 原子切权威。M3→M4 同请求矩阵和既有 multitenancy 适用回归，任何检查点不产生 BA-only 与 legacy 双写 |
| M1 | P04/P08/P12/P13/P23 ingress-coverage/provisioning-global-admin | Admin 创建/编辑/密码/禁用/恢复/单个及批量撤 session 各走 Identity；受控字段外输入拒绝。remove-user、organization/delete/remove-team、impersonate/stop-impersonating 后端拒绝；检查固定插件选项和 access-control。全部固定版原生 HTTP/server API 清单逐项覆盖 |
| M2 | P15 download-revocation、P17 BFF 媒体、实际 Bun/Hono | highWaterMark:0；慢客户端在撤权前最多一次 enqueue、单批<=262144 字节；撤权后下一 pull 拒绝、enqueue 不增。记录 pull/enqueue 与实际应用层缓冲上限，不以 writer.write 返回判定交付，不对运行时附加队列作未测豁免 |
| M3 | P01 tests/e2e-manifest-contract、bun-suite-env、每个 Task audit | 仅 append files、不更新 groups 时审计非零；files=flatten(groups)，无重复/未知文件，新 BA 文件不漂移既有组名；BA 子进程收到专属 setup/reader/data/operator/auth-writer URL（只记录角色存在性），缺配置不继承 MT/共享 URL |
| L1 | P01 transaction-contract | accept-invitation guard/约束 SQL 故障仍返回首个 SQLSTATE/cause；补偿不以 25P02 掩盖，最终状态全部回滚 |
| L2 | P05 owned_files 静态核验 | store/scope-gate/revocation/workspace-admin/workspace-scope-routes 全在 server/src/enterprise/tenancy/，Brief 不再给不存在的根路径 |
| L3 | P04 closed-assurance、P05 Scope、P11 完整实现 | P04 先产 CompanyAssurance 类型/关闭实现；无额外策略可 null、需要证明则明确拒绝；P05 必需注入且不跨向未来文件，legacy 不受未实现 proof 影响 |

## 2.3 第三轮审核发现的逐项验收（F-01–F-10）

此表与 §2.1/§2.2 编号分开保存，全是**待实施验收要求**；写入文档不等于已通过。

| Finding | owner / test | 必需断言与入口 |
| --- | --- | --- |
| F-01 critical | P01 transaction-contract、P04 ingress、P23 mounted-assembly/surfaces | `native_http_handler_is_never_used_for_directory_writes`：对每条目录写端点发真实 HTTP 请求，断言请求内 BA 写与 executor 外层事务 `txid_current()` 相同；只用 auth.api 夹具为假阳性。P23 清单中仍可达 `auth.handler` 的写端点（含 SCIM PUT/PATCH/DELETE）全部列为失败 |
| F-02 high | P12 provisioning-global-admin、P25/P22 inventory | `sso_callback_with_provider_organization_id_never_creates_member`：provider 带 organizationId 的 OIDC/SAML 回调不产生 member 行；`sso({organizationProvisioning:{disabled:true}})` 缺失或被改启动拒绝；/sso/register 等请求 body 含 organizationId 拒绝；M2 inventory 核验 `sso_providers.organization_id` 存量为空 |
| F-03 high | P01 transaction-contract 源码扫描、P23 surfaces | interfaces §3.1 直写清单逐项有处置且与扫描结果一致；邀请重发不经原生 resend 分支直写 expiresAt；包升级引入清单外直写时扫描非零失败 |
| F-04 medium | P25 inventory、P08/P12/P22 各自接线 | 静态 legacy 目录写入者清单含 deletion-semantics.ts:290/378/544、root-backfill.ts:205–211、scripts/enterprise-runtime-seed.ts:43–46 并逐项写明处置阶段；清单外新写入者被扫描发现即失败 |
| F-05 medium | P25 migration-expand | `legacy_tenants_receive_deterministic_unique_slugs`：每个回填 tenant 得到归一化、唯一、重跑幂等的 slug；冲突按稳定规则加后缀；BA 唯一约束违例阻断回填 |
| F-06 medium | P09 scoped-team-admin、P23 surfaces | 不存在与既有 `DELETE …/members/:principalId` 同形的第二路由；path ID 类型为 OpenBot principalId，服务端解析为 BA userId，不能用 BA member.id/userId 直删 |
| F-07 medium | P02 ui-compatibility | `organization_components_do_not_call_x_class_endpoints`：OrganizationSwitcher/Members 等组件不调用 X 类原生 GET；ui-source.json 对每个组件声明“注入 OpenBot adapter”或“不复用” |
| F-08 low | P01 hook 分类、P04/P08 接管 | link-account `dispatchVerificationEmail` 在 deferNonDatabaseWrites 为真时入 pendingHooks 的情况被登记分类；启用相关邮件配置前投递已由 outbox 接管，未启用有配置反例 |
| F-09 low | P03 schema-roles | 既有 epoch integer 列与新建 bigint 版本列逐列类型明确；`Number.isSafeInteger` 比较不因列类型混用失效，迁移不改既有列类型 |
| F-10 low | P03 schema-roles/启动检查 | auth-writer 对 principals 的受控写、data 对 clocks/assurance 的受控读 GRANT 存在且最小化；缺授权时反例与启动检查失败 |

## 3. 统一验证入口

所有命令均由任务实现者/验证者在**已核验的执行工作区根目录**运行；以下示例是后续执行方法，本轮不运行。报告根路径使用 task/attempt 隔离，如 `.archive/runs/<执行 run>/verification/P01/attempt-01/`；尖括号是执行前必须替换的路径参数，不能原样交给 shell。

测试导入遵守 ADR 0008：可在 Node 运行的用 `tests/support/e2e-compat.ts`；确有 Bun SQL/加载语义依赖的通过现有 Bun 驱动层调度，不以直接 `bun test` 作为根测试入口。新 `server/tests/better-auth` 需要专用目录组、正确 URL 与受限角色；P01 在 `scripts/lib/e2e-manifest.mjs` 的 DIRECTORY_ISLANDS 建组并仅登记当时已存在的测试。此后每个 Task 在 RED 前按逐文件加载证据更新自身 `tests/config/e2e-bun-suites.json` 增量，native 文件不加入 driven；所有权见主计划共同登记步骤。DIRECTORY_ISLANDS 只对清单内文件分组，不自动扫描后续文件；不能预登记不存在的未来文件。每 Task 核对新增文件确实在目标分区，漏登记反例必须非零失败。分区改动须由 P01 扩展的 writeManifest 保留既有组、生成稳定 BA 批次的 files/groups 同一增量；只变本任务新增/受影响新岛组，不重排既有 part N。审计强制每个 files 成员恰在一组，组无清单外文件/重复；files-only 注册非零失败。driver 无匹配组/零实际用例非零，不能 skip。

### V-B：后端实际 DB/adapter 与装配

示例（P01；各 Task 将输出目录换为自己的 ID，driver group 固定包含 `server/tests/better-auth`）：

```sh
E2E_UNIT_OUTPUT=.archive/runs/ba-execution/verification/P01/red E2E_BUN_ONLY=server/tests/better-auth ./node_modules/.bin/e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

`ba-execution` 在开工时换为实际 run-key，报告独立保留 red/green。group 内可能包含其他已集成 Task 的套件，核对目标文件确在被执行组、目标测试名及 Bun 实际用例数，不能只看外层一条聚合用例。第一次 RED 是目标行为失败；GREEN 是目标与受影响已集成行为全通过，0 collection errors、目标用例不 skip。P01 将驱动层没有匹配组从 skip 改为非零失败。

数据库配置沿现有 enterprise fixture 的严格验证：setup、directory-reader、data、operator 及新增 auth-writer 连接分开；测试库名/主机约束保留。P01 的 bunEnv 先独立匹配 better-auth island，不落 MT 分支。注入规则固定：BA_TEST_DATABASE_URL→TEST_DATABASE_URL/DATABASE_URL/ENTERPRISE_TEST_SETUP_DATABASE_URL；BA_TEST_DIRECTORY_DATABASE_URL→ENTERPRISE_TEST_DIRECTORY_DATABASE_URL；BA_TEST_DATA_DATABASE_URL→ENTERPRISE_TEST_DATA_DATABASE_URL；BA_TEST_OPERATOR_DATABASE_URL→ENTERPRISE_TEST_OPERATOR_DATABASE_URL；BA_TEST_AUTH_WRITER_DATABASE_URL 原名给 BA fixture。全部必填且同一隔离 openbot_enterprise_* 库/不同受限角色，缺任何一个非零 blocked，不能继承全局或 MT URL；旧 multitenancy 注入不改变。测试用假 URL 捕获子进程参数核验，不在报告输出真实 DSN。生产 writer 配置由 P03/P23 显式建模。凭据从已配置秘密源注入，不在计划/日志打印 DSN，不回退开发数据库；真实生产数据不作为测试夹具。

旧受影响 `server/tests/multitenancy` 或 `server/tests/enterprise` 按其实际 manifest group 追加最小回归；没有 Bun 耦合、属于 native 的文件用精确文件路径直接传给 e2e。先读取实际清单再决定路径，禁止盲用一个命令导致零用例。

### V-F：前端/适配器

Node 可收集例子（P07）：

```sh
E2E_UNIT_OUTPUT=.archive/runs/ba-execution/verification/P07/green E2E_UNIT_SCOPE=app ./node_modules/.bin/e2e run --config e2e.unit.config.ts app/tests/better-auth/scope-selection.test.tsx
```

P02 的 `app/src/lib/auth/ui-compatibility.test.tsx`、P10/P13/P21 的文件同理；`E2E_UNIT_SCOPE=desktop` 运行 Desktop TS 套件。若该文件被实际分区列为 Bun-driven，改用 `E2E_BUN_ONLY=<包含该文件的真实组名>` 和 `tests/bun-suites.test.ts`，并核对目标执行数；不要同时两种入口重复计数。React/happy-dom 状态污染时依据实测把该套件独立分组，不以换运行时掩盖产品失败。

预期：目标测试均执行、断言通过、无 collection error；键盘/焦点/错误恢复的可操作检查有记录。组件测试和纯 adapter 测试只证明其范围，不证明真浏览器/原生登录。

### V-I：浏览器、IdP、邮件、存储和外部系统

P10 同时修改默认 e2e.config.ts、创建 BA Web config/共享 preflight/engine manifest 和审计；P20 增独立 Mobile config。默认入口不收 BA 子树，也拒绝显式 BA 文件 override；BA config 在创建 engine/导航前 preflight，每个 BA 文件仍有 suite guard。三套收集/target 固定如下，不能只数 engine tier：

| config / package script | 仅收集 | target / 必需 origin |
| --- | --- | --- |
| e2e.config.ts / test:ui | 原 tests/e2e/*.e2e.ts，明确排除 better-auth 子树 | 既有默认 Web target，不收任何 BA 文件 |
| e2e.better-auth.config.ts / test:ui:better-auth | tests/e2e/better-auth/web/*.e2e.ts | BA Web，显式 E2E_BA_APP_ORIGIN/E2E_BA_API_ORIGIN 及构建 digest |
| e2e.better-auth-mobile.config.ts / test:ui:better-auth:mobile | tests/e2e/better-auth/mobile/*.e2e.ts | 独立 Expo web Mobile target，显式 E2E_BA_MOBILE_ORIGIN/E2E_BA_API_ORIGIN/authority 及 Mobile 构建 digest，绝不回到 3010/8787 |

- Web directory.e2e.ts（P10）：开通、注册/验证/邀请、Principal 首建、角色及团队管理 Grant。
- Web session.e2e.ts（P13）：启用登录、密码恢复真实邮件/重新登录/旧安全能力失效、公司追加认证及回调。
- Web business.e2e.ts（P21）：A/B、多标签、私有资源、下载/流、财务及撤权。
- Mobile app.e2e.ts（P20）：真实 Expo web App/MuseApi/CopilotKit/provider；登录→原 Workspace 首屏→一次流→媒体→公司追加认证，记录最终路由/actor/company/team，断接线必须失败。enterprise accessKey 不得兜底，native bridge 仍按 V-N。

静态收集及负例无需数据库/业务服务，由 P10/P20 创建的 tests/e2e-browser-isolation.test.ts 与 audit --engine-list 核对真实 config collector、每文件预期 target 和 preflight。增加未登记 BA 文件、默认误收 BA、BA Web 指 Mobile、移除 Mobile origin 四反例均须非零；网络 spy 断言拒绝前 0 站点访问。真实 e2e list/run 缺对应 origin 也须先失败，不能显示 skipped 作为 blocked。

```sh
node scripts/e2e-coverage-audit.mjs --engine-list
E2E_UNIT_OUTPUT=.archive/runs/ba-execution/verification/P10/isolation ./node_modules/.bin/e2e run --config e2e.unit.config.ts tests/e2e-browser-isolation.test.ts
E2E_BA_OUTPUT=.archive/runs/ba-execution/verification/P24/browser-web ./node_modules/.bin/e2e run --config e2e.better-auth.config.ts
E2E_BA_OUTPUT=.archive/runs/ba-execution/verification/P24/browser-mobile ./node_modules/.bin/e2e run --config e2e.better-auth-mobile.config.ts
```

配置必须对 APP/API origin、测试用户/IdP 与模型/浏览器引擎先做 preflight，缺必要输入明确 blocked，不能默认打生产。真实测试 IdP/SCIM tenant、邮件接收器、私有对象存储及启用沙箱/模型供应商分别记录标识和版本，脱敏保留证据。官方 HTTP 接口/测试签名 IdP 合同用例与真实已启用 IdP 验收分开；前者不能代替后者。

旧 URL 失效测试必须用**切换前**保存的受控敏感对象 URL，再于新访问路径已关闭/撤权后访问，检查存储/CDN 实际响应；不能只断言新代理返回 403。下载以实际 Bun/Hono highWaterMark:0 的串行 pull/准入/enqueue 屏障计数；撤权前最多一批 enqueue<=262144 字节，下一 pull 拒绝、计数不再增加，记录应用层缓冲上限并禁止额外变换预读队列。write 返回不是交付证据；OS/网络/客户端已有缓存不作可追回承诺。

### V-N：Desktop、Mobile 和子模块

- Desktop TS 由 V-F；Rust `cargo check --locked --manifest-path desktop/src-tauri/Cargo.toml`，适用原生用例按仓库已登记的 foreign runner 从 `desktop/src-tauri` 执行 `cargo test --locked --lib`，归档真实 test count 与环境限制。Rust 属于现有显式 native 例外，不声称由 e2e 执行。Mac/Windows/Linux 的实际支持范围开工确定，未部署的平台不伪造验收。
- P20 创建根目录 `tests/better-auth-mobile.test.ts`，由 e2e-compat 注册固定用例，白名单调度子模块 transport/tenancy/three-client-selection/company-assurance 的 Bun 测试并解析 JUnit 实际执行数/失败/skip；单独子进程和报告路径，0 用例失败。禁止扩大根 glob 导入整个子模块测试库，禁止依赖原 `pnpm test`（它不覆盖这些 src 下的 Bun 套件）。

```sh
E2E_UNIT_OUTPUT=.archive/runs/ba-execution/verification/P20/mobile ./node_modules/.bin/e2e run --config e2e.unit.config.ts tests/better-auth-mobile.test.ts
bun run --cwd desktop typecheck
pnpm --dir apps/openmuse/apps/mobile typecheck
pnpm --dir apps/openmuse/apps/mobile exec expo export --platform web --output-dir "$PWD/.archive/runs/ba-execution/verification/P20/mobile-web"
```

真 Desktop/启用 iOS/Android 的安装包版本、OS、设备或模拟器、authority 和 callback/切换/撤权结果单列归档。三个 JS store 实例的一致性测试不等于三台设备验证。辅助模块、实际 App 浏览器装配和真 native 证据分开计数，不能以同一 driver 聚合结果重复充数。P20 的调用点清单包括 App.tsx、api.ts、CopilotKit/流、native callback、details/PdfReader 和缓存，P24 只核验不补写接线。P17 先冻结子模块后端 enterprise BFF 检查点并交付合同；P20 只改移动客户端。两任务的子模块工作区和 `.git` 独立记录、独立 Review/OCR，superproject 仅显示 dirty gitlink 不够。

### V-Q：静态、覆盖对账及最终回归

每 Task 先最小行为再受影响静态检查；Lint/format 只选本次文件，不带 `--write` 修无关代码。最终 P24 运行适用全范围：

```sh
bun run typecheck
bun run build
bun run --cwd desktop typecheck
bun run --cwd desktop build
node scripts/e2e-coverage-audit.mjs
bun scripts/check-better-auth-surfaces.ts
E2E_UNIT_OUTPUT=.archive/runs/ba-execution/verification/P24/ci bun run test:ci
```

Lint 使用 `./node_modules/.bin/biome lint --error-on-warnings` 后接经检查点 manifest 明确列出的本次源文件；生成/vendored 文件按仓库既定忽略配置，不新设大范围排除。`git diff --check` 检查本次完整范围。子模块另跑其适用 typecheck/build/lint（依现有 package scripts，不换包管理器），Rust 适用静态/原生检查按 V-N。

P16 另按 Bifrost 已登记 foreign runner 执行实际变更的 Go/governance 测试，归档子模块源码/配置 digest、网关实际 request→online identity admission→provider dispatch 证据；不能只审 gitlink 或运行 OpenBot 辅助测试。

预期：目标类型/构建/Lint 无新错误，测试实际执行数与覆盖清单可对账；全量 test:ci 不允许用最小测试替代。既有无关失败须绑定基线、说明可复现证据及交付影响；真实交付阻塞不能以“旧失败”略过。已通过同版本证据只复用一次，不无故反复全量执行。

## 4. 状态、证据及资源生命周期

执行矩阵至少记录 `BA ID / task / testId / checkpoint hash / command / exit / executed / failed / skipped / blocked reason / provider-client version / evidence path / reviewer`，状态区分 pending/running/blocked/verified。测试结果变化或源文件变更使受影响证据失效；与当前检查点不匹配的报告不能支持完成。

需要容器/数据库/本地服务时，先记录已有资源归属；优先复用适用依赖，需新建使用唯一 project/标签和专用端口。测试流程用 finally/trap 清理**本次创建**的容器/测试数据库/临时服务，成功失败中断都执行；共享服务不停止，不调用共享 `scripts/stop.sh` 或 compose down，不删共享卷。结束检查已记录 ID 不再运行，清理失败明确报告。

P24 的完整 Review/OCR 需覆盖原始 BASE..HEAD（若有本次提交）以及全部未提交交付与子模块源码；保存每轮报告、finding 裁决、修复计划和复审。OCR provider/凭据失败如实报告，不假称用 Codex 模型别名已配置 OCR。最终没有有效 critical/high/medium，且各能力真实验收齐备后才能标记“实施验收完成”；M6 发布仍需届时授权。
