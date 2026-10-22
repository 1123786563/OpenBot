# Better Auth 接入：任务间接口约定

状态：候选实施接口，随 [主计划](plan.md) 评审；不是已存在的代码 API。本文确定实施者不能各自选择的边界；只有固定版本可行性验证通过后，才将接口实现写入相应源码。数据库事务、Scope 和内部执行能力不能由 HTTP JSON 反序列化获得。

## 1. 文件与类型所有权

| 文件/文件组 | 责任 | 首次拥有者 |
| --- | --- | --- |
| `server/src/auth/directory/contracts.ts` | 命令、固定角色、结果、actor、内部事务类型；不访问数据库 | P01，P04 冻结 |
| `server/src/auth/directory/transaction-adapter.ts` | 请求局部数据库绑定、嵌套事务/savepoint；不含业务授权 | P01 |
| `server/src/auth/directory/executor.ts` | 锁内认证授权、幂等、BA 调用、finalizer、提交 | P04 |
| `server/src/auth/directory/finalizer.ts` | 最终集合校验、版本、存根/资格投影、审计/outbox | P04 |
| `server/src/auth/directory/principal-registry.ts` | 首次业务主体幂等建立，沿用历史身份及代际 | P04，P06/P08/P12 消费 |
| `server/src/auth/directory/identity.ts` | 独立全局身份命令 executor/终结；不伪造 tenant | P04 协议，P12 实际 Admin/session 接线 |
| `server/src/auth/directory/team-grants.ts` | 公司管理者授予/撤销固定团队管理 Grant | P09 |
| `server/src/auth/mail.ts`、`password-recovery.ts` | BA 验证/恢复邮件 callback、事务内 outbox receipt、恢复 ingress 与真实投递接口 | P08；P04 提供身份 executor 内部事务边界 |
| `server/src/db/schema/auth-directory.ts` | BA 目录/命令，以及新团队管理 Grant、provisioning rule | P03 |
| `server/src/db/schema/enterprise-credentials.ts`、`server/src/enterprise/tenancy/credential-ownership.ts` | 凭据授权来源版本、个人归属及 use/disclose | P03 schema，P14 行为；P16 消费 |
| `server/src/auth/directory/team-extension.ts` | 精确团队管理能力下复用 BA adapter 的固定两类操作 | P01 原型，P09 角色/Grant 分支，P12 规则分支 |
| `server/src/auth/directory/ingress.ts` | 原生 HTTP/服务端 API 的操作分类与可信命令构造 | P04 |
| `server/src/auth/directory/lifecycle.ts` | 开通、暂停、恢复、删除申请与外部初始化 | P06 |
| `server/src/auth/company-assurance.ts` | CompanyAssurance 类型和关闭实现先产出；完整签发/核验/撤销 | P04 类型/关闭实现，P11 接管实现 |
| `server/src/auth/company-auth-routes.ts`、`sso-evidence.ts` | 自有公司认证 OIDC callback/SAML ACS 及原始协议证据 | P01 evidence bridge 可行性，P11 接完整流程 |
| `app/src/lib/auth/ui-provider.tsx` | 将固定 UI 产物接入现有 Router/Query 的 OpenBotAuthProvider | P02 |
| `app/src/lib/auth/auth-plugin.ts`、`app/src/lib/auth/organization-plugin.tsx` | 固定 UI client/plugin glue | P02 |
| `app/src/components/auth/` | Auth/Settings registry 组件根；组织组件固定在 `organization/`，ui-source.json 展开精确文件 | P02 生成，P07/P10/P13 串行消费 |
| `apps/openmuse/apps/mobile/App.tsx`、`src/api.ts`、真实 provider/媒体调用点 | 将 openbot 辅助模块挂载到应用，生产请求/流/回调/下载接线 | P20，完整相对路径见主计划 |
| `tests/config/e2e-bun-suites.json` | 新增测试逐文件 driven 分区；native 文件不加入 | P01 建组，各新增测试 Task 更新自己的增量 |
| `server/src/auth/directory/authority.ts`、`read-gate.ts` | authority 事务内读取/写 gate/release gate，原生目录读 gate | P04，P03 schema；P23 只核对装配 |
| `server/src/enterprise/tenancy/directory-readiness.ts` | authority/数据库能力/完整装配检查 | P23 |
| `server/scripts/better-auth/{inventory,migrate-directory,verify-directory}.ts` | M0–M3 前置迁移工具 | P25（P04 后），P22 按最终 schema 扩展 |
| `server/src/db/schema/access-grants.ts`、`gateway.ts` | 个人模型 Grant/Key 的主体及签发代际 | P03；P12 签发消费，P16 准入消费 |
| `server/src/bot-services/access-grants.ts`、`server/src/gateway/{key-issuance,key-renewal}.ts` | 个人模型授权与已挂载 Bot Service claim/renew | P12 |
| `server/src/auth/mobile-session.ts`、`mobile-session-routes.ts` | OpenBot 企业 mobile session 交接/在线准入 | P12 |
| `apps/openmuse/apps/server/src/{app,auth,workspace}.ts`、`enterprise.ts` | OpenMuse server 企业 BFF、DTO/执行/媒体接线 | P17；后端文件不交给 P20 |
| `e2e.config.ts`、`e2e.better-auth.config.ts`、`tests/support/better-auth-preflight.ts` | 默认/BA Web 互斥收集及共享强制 preflight | P10；P20 创建独立 BA Mobile config |
| `scripts/lib/e2e-manifest.mjs`、`scripts/e2e-coverage-audit.mjs`、`tests/bun-suites.test.ts` | files/groups 一致、稳定组名、BA URL 注入、配置/target 审计 | P01 分区/URL，P10 浏览器审计；P20 增 Mobile |
| `shared/auth-directory.ts` | 可公开的 listing/selection/error DTO；不含可信对象或秘密 | P05，P07 消费 |

P01 使用测试隔离 schema 验证适配方案；P03 才建立生产 schema。P01 的最小 finalizer 测试支架不能被当作 P04 的业务实现。

## 2. 版本、actor 与命令

`Version` 使用非负安全整数：数据库 bigint 的值必须满足 `0 <= value <= 9007199254740991`，应用读取和递增均检查 `Number.isSafeInteger`；溢出拒绝命令，不回绕。既有 `memberEpoch: number` 保持形状。资格首次建立取 1；历史回填只能采用经核实的版本，不能把未知历史补成 1。

```ts
type Version = number;
type DirectoryRole = "owner" | "admin" | "member" | "auditor";
type DirectoryOperation =
  | "company.provision" | "company.profile.update"
  | "company.suspend" | "company.restore" | "company.deletion.request"
  | "invitation.create" | "invitation.accept" | "invitation.reject"
  | "invitation.cancel" | "invitation.resend"
  | "provisioning.rule.approve" | "provisioning.rule.revoke"
  | "member.provision" | "member.role.set" | "member.suspend"
  | "member.restore" | "member.remove" | "member.leave" | "owner.transfer"
  | "team.create" | "team.profile.update" | "team.archive.request"
  | "team.management.grant" | "team.management.revoke"
  | "team.member.add" | "team.member.remove";
type DirectoryTx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type EligibilityKey = Readonly<{
  tenantId: string; principalId: string;
  kind: "company" | "team"; scopeId: string;
}>;
type EligibilityVersion = Readonly<{
  epoch: Version; generation: Version; tombstone: boolean;
}>;
type DirectoryActor = Readonly<{
  userId: string | null; principalId: string | null;
  sessionId: string | null;
  kind: "session" | "platform" | "scim" | "jit" | "migration";
  bindingId: string | null;
  provisioning: Readonly<{
    eventId: string; ruleId: string; ruleRevision: Version; sourceSubject: string;
  }> | null;
}>; // 私有品牌/运行期签发登记；scim/jit 必须有固定 binding 及验证后的事件规则依据
type DirectoryCommand = Readonly<{
  operation: DirectoryOperation;
  tenantId: string; idempotencyKey: string;
  payload: Readonly<Record<string, unknown>>;
}>; // payload 按下表 Zod discriminated union 校验，不接受任意字段
type DirectoryResult = Readonly<{
  commandId: string; replayed: boolean; tenantId: string;
  workspaceId: string | null;
  versions: readonly Readonly<{key: EligibilityKey; value: EligibilityVersion}>[];
  resourceId: string | null;
  grantId: string | null; grantGeneration: Version | null;
}>;
interface Directory {
  execute(actor: DirectoryActor, command: DirectoryCommand): Promise<DirectoryResult>;
  listEligibleScopes(actor: DirectoryActor): Promise<ScopeListing>;
}
```

`Database` 引用现有 `server/src/db/client.ts` 的导出；公共调用者只见 `Directory`，不传 tx、executor 或“跳过权限检查”参数。actor 由认证层或固定 provisioning binding 签发；迁移 actor 在停写离线工具中签发，普通进程不得创建。开通命令的 tenantId 由服务器幂等预分配，不由普通用户指定既有公司的 ID。

| DirectoryOperation | payload 的允许字段 | 实现任务 |
| --- | --- | --- |
| `company.provision` | `name, slug, ownerUserId, defaultTeamName` | P06 |
| `company.profile.update` | `name?, slug?, logo?`；至少一个 | P08 |
| `company.suspend` / `company.restore` / `company.deletion.request` | `reason` | P06 |
| `invitation.create` | `email, role, workspaceIds` | P08 |
| `invitation.accept` / `invitation.reject` / `invitation.cancel` / `invitation.resend` | `invitationId` | P08 |
| `provisioning.rule.approve` | `bindingId, externalGroup, workspaceIds`；externalGroup 可空，role 固定 member | P12，P04 注册 |
| `provisioning.rule.revoke` | `ruleId, reason` | P12，P04 注册 |
| `member.provision` | `userId`；仅 scim/jit，最低角色及批准 rule 从 actor/服务器查取 | P12，P04 注册 |
| `member.role.set` | `userId, role` | P08 |
| `member.suspend` / `member.restore` / `member.remove` | `userId, reason` | P08 |
| `member.leave` | 空对象；目标只取当前主体 | P08 |
| `owner.transfer` | `nextOwnerUserId`；原 owner 原子降为 admin | P08 |
| `team.create` | `name`；workspace/team ID 服务器生成 | P08 |
| `team.profile.update` | `workspaceId, name` | P08 |
| `team.archive.request` | `workspaceId, reason` | P08 |
| `team.management.grant` | `workspaceId, userId, actions`；actions 为非空去重的 team.member.add/remove 子集 | P09 |
| `team.management.revoke` | `grantId, reason` | P09 |
| `team.member.add` / `team.member.remove` | `workspaceId, userId`；角色/Grant/批准规则依据由服务器按 actor 分类查取 | P09，P12 provisioning 接线 |

首期公司 owner 可明确设置另一名现有 active 成员为 owner，`owner.transfer` 另提供自身交接的原子动作；最后 owner 检查覆盖所有角色、暂停、退出和移除路径。邀请不能授予 owner；邀请接受不得覆盖已有角色。未知字段、未知动作、多个角色、客户端 actor/executor/status/epoch/payer 均拒绝。SCIM/JIT 首次公司成员用 member.provision；当前不存在、已有 active、已有 suspended 分别核验，不用虚构邀请或覆盖现有角色。恢复须命中明确批准的恢复策略，再调用 member.restore。actor.provisioning 只能由已验证 SCIM/JIT 事件及服务器规则构造，HTTP body 不接受该结构；公司角色/Grant actor 的 provisioning 为 null。一个事件的公司成员和团队变化由 executor 的内部原子组合执行，可为每个动作派生对应批准规则 actor，但固定同一 binding/company/event；任何子命令失败全部回滚，不能依次提交。

### 2.1 全局身份命令

`DirectoryCommand.tenantId` 保持必填；全局身份使用独立信封，不传空公司或虚构公司。全局 role 只有 user/admin，与 DirectoryRole 分开。

```ts
type IdentityOperation =
  | "identity.disable" | "identity.restore"
  | "identity.role.set" | "identity.session.revoke" | "identity.sessions.revoke"
  | "identity.user.create" | "identity.profile.update" | "identity.password.reset";
type IdentityCommand = Readonly<{
  operation: IdentityOperation; targetUserId: string;
  idempotencyKey: string; payload: Readonly<Record<string, unknown>>;
  secrets?: Readonly<{newPassword: string; resetToken?: string}>;
}>; // secrets 仅进程内传递，不写 receipt/outbox/日志
type IdentityActor = Omit<DirectoryActor, "kind"> & Readonly<{
  kind: "session" | "platform" | "migration" | "recovery";
  bindingId: null; provisioning: null;
}>;
type IdentityResult = Readonly<{
  commandId: string; replayed: boolean; userId: string;
  principalId: string; identityGeneration: Version;
}>;
interface Identity {
  execute(actor: IdentityActor, command: IdentityCommand): Promise<IdentityResult>;
}
type PrincipalRef = Readonly<{
  userId: string; principalId: string; identityGeneration: Version;
}>;
interface PrincipalRegistry {
  ensure(tx: DirectoryTx, userId: string): Promise<PrincipalRef>;
}
```

| IdentityOperation | payload | 锁内授权与结果 |
| --- | --- | --- |
| identity.disable / identity.restore | reason | 实时全局 admin；User/Principal 状态同改，有效状态变化推进 identityGeneration 并撤全部 session/proof |
| identity.role.set | role: user/admin, reason | 实时全局 admin；禁止公司角色输入，实际角色变化推进安全代际并撤全部 session/proof |
| identity.session.revoke | sessionId, reason | 当前用户或实时全局 admin；核验 session 属于目标，只撤对应 session/proof |
| identity.sessions.revoke | reason | 实时全局 admin 撤目标全部 session/proof；不推进长期授权代际 |
| identity.user.create | email, name, image? | 实时全局 admin；targetUserId 由服务器预分配并绑定幂等 receipt，调用 BA 建新 user、默认 user role 与 Principal；密码部署通过 secrets 传密码，SSO 部署不造密码/账号绑定；不授公司资格 |
| identity.profile.update | name?, image?；至少一项 | 实时全局 admin；仅资料字段，不增安全代际；email/role/status/任意 data 拒绝，邮箱换绑走已验证账户流程 |
| identity.password.reset | reason | admin 或同事务内锁定校验 reset-token 后签发的 recovery actor；原生恢复 route 是 token 唯一消费者，密码 hash/token、identityGeneration +1、全部 session/proof 同事务；不恢复 disabled 身份 |

平台 actor 由服务器核验当前有效 session、BA Admin role 和部署认证规则后签发，不信任客户端 kind/platform 标志；公司 owner/admin 和 provisioning binding 都不能签发。migration 仅离线停写工具可用；首次管理员初始化需封存的一次性 bootstrap 记录，普通登录不再调用 seedRole/applyConfiguredAdmin/setRole 提权。查询用实时 platform-read gate，不伪造变更命令。recovery actor 无 session；仅恢复 ingress 在身份 executor 内、锁定重验固定 BA reset-token 后签发，内部登记绑定 transactionId/目标 user/token 的 HMAC 承诺，不能由 HTTP kind 字段创建、跨事务转移或借 receipt 绕过已消费 token。签发 actor 不消费 token，只准本事务目标 password.reset；原生恢复 route 的 consumeVerificationValue 是唯一消费者，顺序见 §5.1。secrets 不持久化，幂等冲突比较使用服务器密钥 HMAC 承诺，禁止可离线猜密码的明文/普通摘要。原生 Admin/Organization 读写按 §3.2 逐项处置，未知端点拒绝。

receipt 唯一域为 identity/actor/targetUserId/operation/key，校验 payload hash；重放先重验当前身份和管理权限，不重复增版、不返回 token/cookie。复用同连接事务、DML guard、终结标志、平台域审计及提交后 outbox；身份终结器核对 User/Principal/代际/session/proof 完整结果，故障或漏终结整体失败。按 userId/principal 稳定序取锁，不在持 principal 后等 tenant；身份命令不逐公司更新目录。普通注册/登录的 BA 合同独立于公司命令，但不能写受保护管理字段。

PrincipalRegistry 在命令的 principal 锁层执行：公司命令已取 tenant 锁，之后才能取 member/team/resource 锁。仅真实新 user 无主体历史时创建服务器 ID、identityGeneration=1，user_id 唯一约束使并发只产生一行；沿用已有 ID/状态/代际，ensure 不恢复 suspended 身份。已知历史映射/代际缺失阻断恢复，不补新主体。P04 实现，P06/P08/P12 在同一外层事务消费，finalizer 校验；用户接受邀请前可有合法 session 而 principalId 为 null，不能因此要求先有公司资格。

## 3. 内部事务能力

```ts
type PostCommitHook = Readonly<{
  hookId: string; kind: "read-only" | "disabled-cache-noop";
  run(): Promise<void>;
}>; // 内部登记、不可序列化；两类均无数据库写/缓存写/网络通知权限
type BaTxOutcome<T> = Readonly<{
  value: T; pendingHooks: readonly PostCommitHook[];
}>;
interface TransactionBoundBa {
  run<T>(tx: DirectoryTx, operation: () => Promise<T>): Promise<BaTxOutcome<T>>;
}
interface DirectoryFinalizer {
  finalize(tx: DirectoryTx, commandId: string): Promise<DirectoryResult>;
}
type TeamCommandAuthority =
  | Readonly<{kind: "company-role"; role: "owner" | "admin";
      memberEpoch: Version; companyGeneration: Version}>
  | Readonly<{kind: "team-grant"; grantId: string; grantGeneration: Version}>
  | Readonly<{kind: "provisioning-rule"; bindingId: string;
      eventId: string; ruleId: string; ruleRevision: Version}>;
type TeamMutationCapability = Readonly<{
  commandId: string; tenantId: string; workspaceId: string; teamId: string;
  actor: DirectoryActor; targetUserId: string;
  action: "team.member.add" | "team.member.remove";
  authority: TeamCommandAuthority;
}>; // 私有构造、事务绑定、单次消费；不经 HTTP/队列传输
interface ScopedTeamExtension {
  add(tx: DirectoryTx, capability: TeamMutationCapability, userId: string): Promise<void>;
  remove(tx: DirectoryTx, capability: TeamMutationCapability, userId: string): Promise<void>;
}
```

团队能力构造器在锁内按 actor 选择唯一 authority 分支：company-role 重验当前 owner/admin；team-grant 重验主体身份/公司/团队资格代际和 Grant 状态/generation；provisioning-rule 重验绑定、来源事件、当前批准规则/revision、固定 team 和目标成员。DB 命令记录/DML guard 保留相同判别依据，审计记录真实来源；不得制造占位 Grant、伪管理员或无依据的 provisioning 豁免。P03 的规则行至少含 bindingId/tenantId、externalGroup 或公司准入条件、固定 workspaceIds、最低 member 角色、approved/revoked 与 revision；规则批准/撤销通过 Directory 的 provisioning.rule.approve/revoke，由现有公司管理配置入口调用；actor 必须是当前公司 owner/admin，binding 必须固定此公司，scim/jit 无批准权，首发不新增客户自助 IdP 配置。相同 binding/externalGroup 的规则保留稳定 ID，变更固定目标或批准状态推进 revision，最低 role 固定 member；规则更新在 tenant 排他锁内推进 revision，旧能力不可复用，幂等重放也重验规则。规则撤销不偷偷改变其他来源成员，移除关系须明确命令。

P09 的公司管理接口固定为 `GET|POST /api/enterprise/workspace-scope/admin/teams/:workspaceId/management-grants` 和 `DELETE /api/enterprise/workspace-scope/admin/teams/:workspaceId/management-grants/:grantId`。GET 返回 `{grants: TeamManagementGrantView[]}`，POST 接 `{userId,actions}` + 幂等头，DELETE 从 path 取 grantId、body 只接 reason；写返回 DirectoryResult.grantId/grantGeneration，其余非 Grant 动作为 null。path Grant 必须属于明确 company/team；GET 也需当前公司管理授权。

```ts
type TeamManagementGrantView = Readonly<{
  grantId: string; tenantId: string; workspaceId: string; userId: string;
  actions: readonly ("team.member.add" | "team.member.remove")[];
  generation: Version; status: "active" | "revoked";
}>;
```

新团队管理 Grant 至少含 grantId、tenantId、workspaceId、principalId、固定 actions、generation、被授权人的 identity/company/team generation、status 及签发/撤销审计引用。公司 owner/admin 在公司管理上下文签发，受权人须是有效目标团队成员；team.management.revoke 和重新授权推进 Grant generation。company-role 授予者不必先加入目标团队；普通 scoped manager 不能调用管理 Grant 命令。同一 tenant/workspace/principal 保留稳定 Grant 行；授予动作集取非空去重的固定动作子集，改变动作、撤销或重授推进 generation，不物理删除后重置。Grant API 由 P09 生产、P10 消费，不把当前仅 read 的 resource grant 当作既有实现。

顺序固定为 tenant 排他锁 → user/principal（先按 userId 的主体建立锁，再按 principalId 稳定排序）→ company member → team member → resource；多目标同层稳定排序。全局身份禁用持 principal 排他锁，**不得**先拿 principal 后再等待 tenant；需同时处理公司时先按全局顺序取 tenant 锁。正常业务拿对应共享锁。目录事务复用现有 2s lock timeout / 5s statement timeout，外部等待一律在提交后。

命令上下文不是任意 `set_config` 字符串即可信：数据库只允许受限 directory-writer 调用受控函数建立命令记录，DML guard 验证记录、事务、允许动作与目标；data/directory-reader 不获调用权。禁止将完整数据库泄露防护声称为插件能力。SQL 函数固定 `search_path`、限定列、撤销 PUBLIC EXECUTE，函数所有者无通用业务读旁路。

幂等键唯一域为 actor/binding、tenant、operation、key；记录 payload hash。重放也先完成当前认证及目标可见性/管理权限检查，撤权后的请求不能借 receipt 读取或重做原动作。相同输入重放返回同一非敏感结果，不推进版本；同键不同内容返回 409 `IDEMPOTENCY_CONFLICT`。邀请邮件重发是新的受控命令，不复活取消/过期记录；receipt 不保存可重放的 Cookie、token 或秘密。

### 3.1 延迟 hook 与错误归属（P01 证明，P04/P12 接线）

executor 建立并独占外层 BA ALS store，`isTransactionActive=true`、同一 tx adapter 和 pendingHooks；内部 transaction 复用该 store，1.7.1 不自动建 savepoint。`run` 只返回同步结果与已登记/分类的队列，不提交、不自行 drain。executor 在提交前确认每个 hook 的处置，再 finalizer、约束、commit；只有 commit 成功才按登记顺序执行 pendingHooks 一次，回滚不执行。提交后允许队列失败单独记录，不伪报回滚或重放命令。adapter transaction 永远启用，与 SCIM 配置无关。BA 权威模式的 factory 硬前提是 secondaryStorage 未配置、session.cookieCache.enabled:false、session.storeSessionInDatabase:true、verification.storeInDatabase:true；启动检查拒绝相反配置，session/verification 始终从事务数据库读取。当前 OpenBot factory 未配置 secondaryStorage，故此限制不移除现有部署能力；legacy authority 保持原合同。以后启用缓存须另行设计受控 cache-sync、失败失效/重试与实时 DB gate，不能把缓存写标成 read-only。

| 现有 callback/hook | 分类与处置 | 最迟责任 |
| --- | --- | --- |
| sso.provisionUser / user.create.after 的 seedRole | 删除全局连接写；默认 user 及合法初始化由身份/目录 finalizer 同 tx 写兼容 role | P01 分类，P04/P12 实际迁入 |
| user.create.after 的 recordProvisioned | SCIM 事实/投影属于原子 finalizer，使用当前 tx | P04/P12 |
| session.create.after 的 applyConfiguredAdmin | 禁止运行期提权；移除，bootstrap 单独一次封存 | P01 禁止合同，P12 清旧路径 |
| session.create.after 的 stampSignIn | 身份 finalizer 同 tx 更新，不在 after 中用全局 database | P04/P12 |
| 验证/恢复/邀请邮件、webhook、失效通知 | finalizer 写加密 outbox 意图，提交后 delivery；不作为可重放 callback 发信 | P04/P08/P12 |
| BA 内部 deleteCachedUserSessions / mirrorSessionToSecondaryStorage | 固定配置无 secondaryStorage，来源分支不得登记；配置反例在启动前拒绝 | P01 固定版清单/配置反例，P04 factory |
| BA 内部 refreshUserSessions（updateUser/updateUserByEmail） | 即使无 secondaryStorage 仍登记；以固定版来源登记 disabled-cache-noop，提交后照常执行其早返回，回滚不执行，不能静默丢弃 | P01/P04 |
| 只读指标/非安全遥测 | 显式登记 read-only 后可入 pendingHooks | P01/P04 |
| 未登记 hook、任意 after 中全局连接 DML | 提交前拒绝；依赖包升级增加 hook 必须重新分类 | P01/P23 |

P01 必须逐一覆盖上述三个 BA 内部来源：禁用存储时 refresh 队列恰一次且零缓存 I/O，回滚零执行；另两者不登记，强行配置 secondaryStorage/cookieCache 在调用 route 前失败。登记以固定包来源、适配边界和运行证据为准，不靠匿名闭包字符串猜分类。普通注册/登录也由无 tenant 的身份事务终结，保留非致命登录审计政策；该政策不允许角色或 SCIM 投影事务外补写。P01 通过实际 BA hook 注册和受限连接断言分类不漏，不声称能凭闭包文本自动判定副作用。accept-invitation 的补偿若要执行，先 rollback-to-savepoint；否则保留首个 SQLSTATE/cause 后整命令回滚，禁止 25P02 覆盖原 guard 错误。

### 3.2 BA 1.7.1 原生端点处置表

以下 path 均相对 `/api/auth`，同时约束对应 `auth.api.*`；固定包新增/删除/改方法必须使 surface audit 失败。D=Directory 命令，I=Identity，R=实时 DirectoryReadGate（身份/公司/member lifecycle/assurance+原动作权限），S=只更新本人偏好且验证目标，U=OpenBot 自有本人发现/邀请窄读 adapter（对应 BA 原生 GET 关闭），P=平台只读 gate，X=后端 403/404。每个 BA organization GET 都需 suspended member、suspended company、missing proof 三个反例（R 走 gate，X 始终后端拒绝）；U 只在 OpenBot 自有 adapter 返回本人可见发现/邀请，不返回全目录。不存在的 method/path 也拒绝。

| Method | Native path / server API | 处置与任务 |
| --- | --- | --- |
| POST | /admin/create-user | I identity.user.create，P12 |
| POST | /admin/update-user | I identity.profile.update，仅 name/image，P12 |
| POST | /admin/set-user-password | I identity.password.reset，P12；密码策略关闭时拒绝 |
| POST | /admin/set-role | I identity.role.set，P12 |
| POST | /admin/ban-user | I identity.disable，P12 |
| POST | /admin/unban-user | I identity.restore，P12 |
| POST | /admin/revoke-user-session | I identity.session.revoke，P12 |
| POST | /admin/revoke-user-sessions | I identity.sessions.revoke，P12 |
| GET | /admin/get-user | P，P12 |
| GET | /admin/list-users | P，P12 |
| POST | /admin/list-user-sessions | P，只读且核验目标，P12 |
| POST | /admin/has-permission | P，P12；不返回其他用户隐私 |
| POST | /admin/remove-user | X，P04/P12 |
| POST | /admin/impersonate-user | X，P04/P12；Admin 权限表移除 impersonate |
| POST | /admin/stop-impersonating | X，P04/P12；历史模拟 session 在迁移时撤销 |
| POST | /organization/create | X，P04；allowUserToCreateOrganization:false，开通走 P06 私有命令 |
| POST | /organization/delete | X，P04；disableOrganizationDeletion:true，走删除申请 |
| POST | /organization/remove-team | X，P04；走 team.archive.request，不物理删资产 |
| POST | /organization/update | D company.profile.update，P08 |
| POST | /organization/invite-member | D invitation.create，P08 |
| POST | /organization/accept-invitation | D invitation.accept，本人已验证邮箱规则，不预需 member/proof，P08 |
| POST | /organization/reject-invitation | D invitation.reject，本人邀请规则，P08 |
| POST | /organization/cancel-invitation | D invitation.cancel，P08 |
| POST | /organization/remove-member | D member.remove，P08 |
| POST | /organization/update-member-role | D member.role.set/owner.transfer，P08；最后 owner 保护 |
| POST | /organization/leave | D member.leave，P08 |
| POST | /organization/create-team | D team.create，P08 |
| POST | /organization/update-team | D team.profile.update，P08 |
| POST | /organization/add-team-member | D team.member.add，公司角色路径，P09；scoped manager 使用私有 adapter |
| POST | /organization/remove-team-member | D team.member.remove，公司角色路径，P09 |
| POST | auth.api.addMember（固定版无 HTTP path） | 仅 D 私有 member.provision + 受限 binding，P12；不得新挂裸 HTTP |
| GET | /organization/get-organization | R，P04/P11 |
| GET | /organization/get-full-organization | R，P04/P11 |
| GET | /organization/list-members | R，P04/P11 |
| GET | /organization/list-invitations | R，P04/P11 |
| GET | /organization/list-teams | R，P04/P11 |
| GET | /organization/list-team-members | R，P04/P11；核验 team 归属 |
| GET | /organization/get-active-member | R，P04/P11；active 仅 selector |
| GET | /organization/get-active-member-role | R，P04/P11 |
| GET | /organization/list | X；本人发现改用 OpenBot workspace-scope，P05 |
| GET | /organization/list-user-teams | X；本人团队从 OpenBot workspace-scope 取得，P05 |
| GET | /organization/get-invitation | X；最小落地信息改用 OpenBot invitations adapter，P08 |
| GET | /organization/list-user-invitations | X；本人邀请改用 OpenBot invitations adapter，P08 |
| POST | /organization/set-active | S，P05；null 清偏好，不授资格 |
| POST | /organization/set-active-team | S，P05；校验公司/team，null 清偏好 |
| POST | /organization/check-slug | 平台开通只读检查，P06；普通用户拒绝，防枚举 |
| POST | /organization/has-permission | R，只读查询，P04/P11 |
| POST | /organization/create-role | X，P04；dynamicAccessControl 不启用 |
| POST | /organization/update-role | X，P04 |
| POST | /organization/delete-role | X，P04 |
| GET | /organization/get-role | X，P04；固定角色能力走受控 DTO |
| GET | /organization/list-roles | X，P04 |

P04 建分类/拒绝框架，后续 owner 完成动作；P23 按固定版**全部** Admin/Organization HTTP 与 server API 清单逐项对账、生成按端点反例，不把 UI 隐藏或“未知即拒绝”当成已实现 P0。私有 company.provision 可在受控 adapter 内建目录，不临时改公开插件选项或冒充管理员。

OpenBot U 类 adapter：`GET /api/enterprise/invitations/:invitationId` 未登录仅返回最小落地状态，不含人员目录/秘密；已登录按本人已验证邮箱匹配返回该邀请。`GET /api/enterprise/invitations` 只返回本人有效邀请。P08 生产 read-routes.ts，P10 将 UI 查询接此 adapter；scope 发现由 P05 的 workspace-scope 提供。受邀者不需事先 member/proof，后续业务仍需。

### 3.3 过渡期 authority 合同（P03/P04 先产出）

```ts
type AuthorityState = Readonly<{
  authorityVersion: Version; phase: "M0" | "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7";
  directoryAuthority: "legacy" | "paused" | "ba";
  multiTenantReleased: boolean;
}>;
interface DirectoryAuthority {
  read(tx: DirectoryTx): Promise<AuthorityState>;
  requireWrite(tx: DirectoryTx, expectedVersion: Version, writer: "legacy" | "ba"): Promise<void>;
}
interface DirectoryReadGate {
  require(tx: DirectoryTx, actor: DirectoryActor, tenantId: string, nativeOperation: string): Promise<void>;
} // nativeOperation 仅由上述固定版清单签发，不接受任意客户端方法
```

P04 先产 `server/tests/better-auth/support/authority-matrix.ts` 的基础夹具，P25 扩充迁移状态；P04 本身不反向依赖 P25。M0/M1 的 legacy gate/写路径继续工作，不依赖 BA 空表、clock 或尚未实现 proof；BA 运行期目录写关闭。M2/M3 的目录写统一 503 DIRECTORY_MIGRATION_PAUSED，迁移 actor 离线回填；业务仅在旧快照一致且不依赖迁移写时走 legacy，否则明确维护。M4 在同一事务 CAS authorityVersion、收旧 DML、启 BA 写/读 gate；M5/M6 的 release gate 独立，不用于选择权威。权限、clock、proof 缺失在 ba 分支关闭；缺 authority/错版本/未知状态始终 503，不 fallback。P25 在 P04 后交付 M0–M3 工具，P22 扩展最终 schema 并完成切换/恢复；每个后续任务测试 legacy/ba 两分支。

## 4. Scope、选择及错误 DTO

```ts
type ScopeListing = Readonly<{ companies: readonly Readonly<{
  tenantId: string; organizationId: string; name: string;
  memberEpoch: Version; companyGeneration: Version;
  role: DirectoryRole; capabilities: readonly string[];
  teams: readonly Readonly<{
    workspaceId: string; teamId: string; name: string;
    workspaceMemberEpoch: Version; teamGeneration: Version;
  }>[];
}>[] }>;
type SelectionInput = Readonly<{tenantId: string; workspaceId: string}>;
type ValidatedSelection = SelectionInput & Readonly<{
  organizationId: string; teamId: string; memberEpoch: Version;
  workspaceMemberEpoch: Version; companyGeneration: Version;
  teamGeneration: Version; capabilities: readonly string[];
}>;
```

本节 BA-v1 DTO 只在 ba authority 广告/消费；legacy 下同名既有路由保持原 DTO、偏好和客户端分支，不用伪 BA ID 填充新 DTO。P04 的 `GET /api/enterprise/directory/authority` 给已认证客户端返回 `{authorityVersion,directoryAuthority,multiTenantReleased}`；P07/P10/P13/P19/P20/P21 仅在服务器广告 ba 合同时启用新 adapter，M4 前保留旧入口。新 enterprise Mobile 部署在前置未就绪时明确 503，不降级 standalone。

P05 扩展既有 `PlatformScope`，保留原字段，新增 `workspaceMemberEpoch, companyGeneration, teamGeneration, identityGeneration`。服务端私有身份关联保存 `sessionId` 及可空 `assuranceId`，不暴露到 listing；Worker 只从持久化 Run 恢复，经 resolver 重新签发可信对象。无证明需求的公司也不能绕过部署级 SSO。

`GET /api/enterprise/workspace-scope` 返回 listing；`POST /api/enterprise/workspace-scope/validate-selection` 接收 SelectionInput，返回 ValidatedSelection。公司管理不要求团队成员资格。`capabilities` 首期仅允许 `company:manage, team:members:manage, audit:metadata:read, finance:read`，按实际授权返回，写账务仍用专用动作检查。

错误：缺 selector 400；未认证 401；管理无权或 `COMPANY_REAUTH_REQUIRED` 403；不可见业务对象 404；幂等或版本竞争 409；基础设施或 authority/schema 不匹配 503。BA 原生响应保留固定版本约定，由 client adapter 统一映射 UI 错误；隐藏 ID 不加入错误文案。显式 organization/team 与 header 冲突 400 `SCOPE_SELECTOR_CONFLICT`，active session 只作偏好。

## 5. 公司证明、下载与执行

```ts
type VerifiedSsoEvidence = Readonly<{
  challengeId: string; providerId: string; protocol: "oidc" | "saml";
  issuer: string; subject: string; authenticatedAt: Date; strength: string;
  protocolRequestId: string;
}>; // 私有品牌，仅协议 verifier 生成
interface SsoEvidenceBridge {
  verify(request: Request): Promise<VerifiedSsoEvidence>;
}
type AssuranceRef = Readonly<{
  assuranceId: string; sessionId: string; tenantId: string;
  policyRevision: Version; identityGeneration: Version;
  companyGeneration: Version; expiresAt: string;
}>;
interface CompanyAssurance {
  require(tx: DirectoryTx, identity: DirectoryActor, tenantId: string): Promise<AssuranceRef | null>;
  challenge(identity: DirectoryActor, input: {tenantId: string; returnPath: string}):
    Promise<{challengeId: string; redirectUrl: string; expiresAt: string}>;
  complete(request: Request): Promise<{sessionId: string; tenantId: string; returnPath: string}>;
}
```

P04 在 `company-assurance.ts` 先导出上述类型及 `createClosedCompanyAssurance(deps): CompanyAssurance`：仅无额外证明策略的公司可 require→null；要求证明则 COMPANY_REAUTH_REQUIRED，challenge/complete 返回 503 COMPANY_AUTH_NOT_READY，P11 接管完整实现。P05 不导入尚不存在的 P11 文件，也不以可选依赖跳过核验；legacy authority 分支仍遵守 §3.3。

`require` 同样可在 data-role 业务事务调用：实现仅需要该角色获准的读取/受控查询，不借写角色运行业务。没有额外证明需求才返回 null；需要证明但缺失/失效抛受控 403。challenge 最大年龄 600 秒；returnPath 仅本站路径，禁止 `//`、外域、编码绕过及注入。证明有效期是 session 到期与真实认证时间加公司 maxAge 的较小值，不以回调时间充数。

新增 `POST /api/enterprise/company-auth/challenge`；普通登录保留 BA callback，公司证明改用 OpenBot evidence bridge：`GET /api/enterprise/company-auth/oidc/callback/:providerId`（code/state），`POST /api/enterprise/company-auth/saml/acs/:providerId`（签名 SAMLResponse/RelayState）。这些端点只接受协议响应，不接受 JSON claims。`SsoEvidenceBridge.verify(request): Promise<VerifiedSsoEvidence>` 的内部私有品牌结果包含 challengeId/providerId/issuer/subject/authenticatedAt/strength/protocolRequestId；OIDC 来自经签名/issuer/audience/nonce 校验的 id_token，SAML 来自经签名/recipient/InResponseTo 校验的原始断言，不能从 provisionUser userInfo 或回调时钟猜测。P01 用签名 OIDC/SAML IdP 证明 evidence 与 challenge 的一一绑定，再放行 P11。identity、challenge、assurance 在 session 轮换时同事务落定；旧 proof 失效。break-glass 独立、限公司、限时且明确配置，无配置不放行。

下载接口 `GET|HEAD /api/enterprise/files/:fileId/content` 由 P15 在 ingress 清单核对后注册，所有旧敏感下载/预览/分享转入同一服务。`createSensitiveDownloadRoutes(deps): Hono` 通过现有资源读/gate 鉴权；Range 首期只支持单区间，多区间返回 416。使用 `ReadableStream<Uint8Array>`、highWaterMark:0，在串行 pull 中短事务准入，每次至多一次 enqueue、**262144 字节**；下一批以下一次 pull 为界，所有 Bun/Hono 预读也重验，不用 write 返回推断交付完成。私有未授权缓冲最多一批；禁应用层预授权队列/额外转换缓冲，P15 测量运行时 pull/enqueue 与缓冲上限；缓冲/存储/网络等待不持 DB 锁。私有、no-store、无 CDN 旁路。

P03/P14 为凭据 use/disclose 来源和个人 owner 资格保存适用 identity/company/team generation；P16 的 lease 签发/重验和 P14 的 authorizeUse/disclosePlaintext 必须先比较来源版本。个人凭据仅保存 owner ID 不够；缺失/过时代际不从当前 Scope 自动补齐。P08/P12 的所有资格撤销路径使来源失效，P22 核验重签/撤销和重建；独立 cleanup 服务不能在外层事务之外补清理。

P16 为 Run/Job/审批/Grant/租约保存适用身份、公司、团队安全版本及可空 AssuranceRef。当前资格有效不代表旧能力有效；旧能力缺版本须经迁移核验重签或撤销。队列只是定位 Run/Job，payer 始终从持久化记录读取，不能采用新 session 或 UI 当前选择。外部工具请求一旦准入可产生不可撤回结果，后续动作仍重新核验。

### 5.1 验证邮件和真实客户端接线

P08 的 `server/src/auth/mail.ts` 导出 `createAuthMail(deps)`，返回 BA 1.7.1 类型约束的 `sendVerificationEmail`、`sendResetPassword` callback 和 outbox delivery adapter；`AuthMailDelivery.send({to, subject, text, html, idempotencyKey})` 返回 `Promise<{providerMessageId: string}>`。Delivery 是 G0 核验的实际邮件依赖，不用用户 Gmail 工具代替系统身份邮件。邮件意图绑定已验证的 user/email 及固定 BA 生成 URL，依适用事务提交后投递；token/URL 加密保存且不得进日志。P01/P08 证明 callback 不提前发送、失败可重试，无法安全装配则阻断该部署账户闭环。邮箱验证只改变邮箱控制权事实，不签发 CompanyAssurance。

密码部署的 factory 必须把 `sendResetPassword` 接到 emailAndPassword，并固定 resetPasswordTokenExpiresIn:3600、revokeSessionsOnPasswordReset:true；后者只是防御，真正安全失效由 Identity finalizer 原子完成。P08 `server/src/auth/password-recovery.ts` 提供私有 RecoveryIngress，原有公开 URL 不变，裸 BA handler/auth.api 恢复写方法不导出，也不经通配挂载另开入口。两个 POST 的唯一执行顺序如下：

1. `POST /api/auth/request-password-reset {email,redirectTo}`：恢复 ingress 在无 tenant 的同连接身份事务中调用原生 BA request route。固定版先写 verification，再通过 runInBackgroundOrAwait 调 sendResetPassword；该 helper 即使 await 也会吞 callback 错误，不能用原生返回成功判断邮件已登记。受控 factory 禁配 advanced.backgroundTasks.handler；callback 只在当前活跃事务内登记加密 outbox 意图及 token/user/command 绑定的内部 receipt，并把开始、完成、原始错误写请求局部状态。原生返回后、提交前，executor 检查本事务实际创建的每个 reset verification 恰有一个完成的 outbox receipt，且没有 pending/失败 callback；缺失或失败先抛保留的原异常并回滚。未知邮箱没有新 token/outbox，仍返回固定版相同 `{status:true,message}`。迟到 callback/关闭事务能力不得写库或发信；实际邮件只能由提交后 outbox worker 发送。验证邮件 callback 也适用此提交围栏，不能只关闭 background handler。
2. 邮件链接 `GET /api/auth/reset-password/:token` 仅校验并进入 P13 本站 `/reset-password`，不消费 token。`POST /api/auth/reset-password {token,newPassword}`：恢复 ingress 先用非授权定位读取找目标，再进入 Identity executor 的单一外层事务，按 user/principal→verification 顺序加锁并重验目标、有效期、未消费 token，签发 §2.1 的本事务 recovery actor，构造 identity.password.reset。随后在同一 tx 调固定 BA 原生 POST，**只有它**调用 consumeVerificationValue 和写密码 hash；不先消费、不先提交、不在 onPasswordReset 中另开 Identity.execute。原生同步步骤后，Identity finalizer 推进 identityGeneration、撤全部 session/proof、检查 hash/token/受影响事实并写审计，全部成功才 commit。onPasswordReset 不承担原子安全写。任一步失败 token 可重试、hash/代际/session/proof 均未变化；并发消费只有一个成功，已消费重放不能借 receipt 成功。

Admin `/api/auth/admin/set-user-password` 则由平台 actor 进入 Identity.execute，内部调用其受控 BA 密码写入并走同一 finalizer，不索取或消费 recovery token。redirectTo/callbackURL 只允许本站 `/reset-password` 及服务器保存的本站后续路径，不信任邮件/客户端任意目标；成功后重新登录及取得公司证明。秘密加密投递、日志脱敏和 no-referrer 同适用；纯 SSO 不开放这些入口。P01 证明固定版可包裹和观察 token/receipt，P04 产身份 executor 边界，P08 完成实际 HTTP/邮件恢复接线；任何边界不可实现则 blocked，不降级为 callback 后补写。

P20 将 tenancy/transport/company-assurance 挂载到真实 App、MuseApi、CopilotKit/流、native callback、PDF/附件和缓存路径。企业模式的 authority/session 由服务器交接，不接受 standalone accessKey 作为公司身份；服务器 BFF 前置由 P12/P17 交付。根白名单 driver 只对辅助模块计数，真实 App/API/provider 接线由 P20 的独立 Expo web 浏览器用例验证，支持平台真客户端另列，不能只证明 headers 纯函数。

### 5.2 企业 Mobile BFF：可调用路由与 DTO（P12/P17 生产，P20 消费）

选定保留 OpenMuse server。enterprise App 的 API origin 显式指向此 BFF；authority origin 显式指向 OpenBot，均来自部署受控配置，不能根据用户 header 任意代理。OpenMuse 原 `Workspace`（`apps/openmuse/packages/domain/src/index.ts`）仍是响应合同；OpenBot `/api/mobile/workspace` 是另一合同，不可赋值、强转或直接透传。P17 固定两端合同版本/digest 并用实际服务器响应校验。

```ts
type EnterpriseSessionInput = Readonly<{
  authMode: "enterprise"; intentId: string; code: string;
  codeVerifier: string; redirectUri: string;
}>;
type EnterpriseSessionResponse = Readonly<{
  token: string; mode: "live"; authMode: "enterprise"; authority: string;
  expiresAt: string; user: Readonly<{id: string; principalId: string | null}>;
  scope: ValidatedSelection | null;
}>;
type MobileBffError = Readonly<{
  error: string; code: string; requestId: string;
  tenantId?: string; // 仅已确认本人可见的目标
}>;
```

`token` 是仅供注册 OpenMuse BFF 使用的 opaque session handle，服务端只存摘要，绑定 issuer/subject→user、BA session、identityGeneration、clientId、固定 audience 和到期；不是 BA Cookie、standalone owner token 或通用 OpenBot bearer。期限取 BA session 到期与签发后 1800 秒较小值，无离线宽限/refresh；到期重走交接，BA session 撤销/换账号即失效。未入职可 principalId/scope 为 null，仅允许账户/本人 scope 发现，不能读 workspace。selection 是显式 header，token 中的 scope 只作初始显示，不赋新公司权限。

| 服务 / 路由 | 请求与凭据 | 响应 / 接线 |
| --- | --- | --- |
| OpenBot `GET /api/enterprise/mobile/authorize` | clientId=openmuse-mobile、注册 redirectUri、state、PKCE S256 codeChallenge；系统浏览器完成现有 BA 登录后绑定实际 session；可信 origin/CSRF/用户意图检查 | 只重定向注册回调 `code,state,intentId`；code 单次、120 秒，绑定 session/client/authority/redirect/PKCE，不把 session token 放 URL |
| BFF `POST /api/session` | EnterpriseSessionInput；禁止 accessKey/owner/用户指定 authority | EnterpriseSessionResponse；BFF 用注册服务凭据调用下条 exchange，失败原样受控返回，不尝试 standalone |
| OpenBot `POST /api/enterprise/mobile/session/exchange` | 注册 BFF 服务认证 + 上述一次性 code/PKCE/intent；锁内核验原 BA session/身份和 issuer/subject 映射 | EnterpriseSessionResponse；code 消费和 session handle 建立同事务，重放/错 BFF/错 verifier 拒绝；P12 |
| OpenBot `POST /api/enterprise/mobile/session/authorize` | 仅注册 BFF 服务认证，body 为 session handle、requestId、稳定 selector、白名单 operation、可选 resourceId；客户端不能直接调用 | 内部 actor/session/scope/assurance 及 admissionId；每次业务/敏感检查点在线重验，禁止缓存正向授权或冒充平台 actor；P12 |
| BFF `GET /api/workspace?q=...` | Bearer handle + x-openbot-tenant/workspace，q 为可选搜索文本 | **直接返回原 Workspace**，按下表逐字段来源和资源过滤；不是 `{user,agents,channels}`；P17 |
| BFF `GET /api/enterprise/workspace-scope`、`POST .../validate-selection` | 同一 handle；BFF 服务端转译到已绑定 BA actor，不接外部 Cookie | ScopeListing/ValidatedSelection，未选范围时可发现；P17 |
| BFF `POST /api/enterprise/company-auth/challenge` | handle + `{tenantId,returnPath}`；原 BA session 仍有效 | 透传 §5 的 challenge DTO，系统浏览器/原生 callback 仍绑定原意图，完成后重新 validate；P17 |
| BFF `/api/copilotkit/*`（固定 SDK 方法/子路径） | 同一 Bearer/selector，保留固定 CopilotKit SDK 原 wire body；body 中 actor/company/team/payer 不可信 | 固定 SDK runtime 响应及 SSE；服务器 runtime adapter 固定 actor/Run/scope/payer，每个新模型/工具动作实时 gate，断线/撤权取消后续动作；P17 |
| BFF `POST /api/media-tickets` | handle/selector + `{path,method:GET或HEAD}`，path 只允许已核验的文件 content/browser preview/console | `{url,expiresAt}`，最多 60 秒的 opaque 定位 ticket，绑定 session/资源/范围；不是离线授权；P17 |
| BFF `GET\|HEAD /api/files/:id/content`、浏览器 preview/console | 支持 Bearer+selector；不能设置 header 的 native/Image/PDF 使用上述 ticket | 每次新请求/Range/pull 在线重验；文件转 P15 下载代理，私有 no-store，不重定向对象存储；P17 |
| BFF 其余已启用 `/api/agent/*`、`/api/computer/*`、mail/calendar/actions/drafts/conversation/google callback | 现有 Zod/领域 DTO，统一 enterprise middleware；callback 用服务器持久 OAuth state 固定 actor/scope | 保留原客户端 wire schema，逐路由 method/DTO/授权动作登记 P17 清单；未知路由不落 standalone owner auth |

在线 authorize 只准入当前 requestId/operation/resource 的一次动作，不发可跨请求复用的授权。OpenMuse 的 scoped store/执行 adapter 必须消费服务器上下文并执行对象动作授权，不能只把 userId 填进旧 owner 字段；目录/业务撤权先提交则下一次 authorize 拒绝。批量 workspace 返回仅限当前 namespace 和可见资源；每次新的模型调用、工具动作、下载 pull 重新准入，不把首次 workspace/session 检查延续到整条流。已准入在途动作按 Spec §5.4/5.5 处理。

| Workspace 字段 | enterprise 数据来源与映射 |
| --- | --- |
| mode/profile | mode 固定 live；profile.name/email 来自绑定的 BA user，不来自 accessKey/local-user |
| mail/events | OpenMuse 已绑定公司/team/principal 的邮箱/日历连接及 scoped store；仅当前资源授权集合，未知 owner 数据隔离 |
| files | scoped artifact 元数据，ID 保持映射；内容 URL 仅 BFF 在线代理/ticket，无公共签名存储直连 |
| browsers | 当前范围和用户可见的 browser session，preview/console 由 BFF 重写为在线 ticket URL |
| actions/activity | 固定发起范围的提案/审批及事件；决定/执行再次走 OpenBot gate，不信任客户端覆盖 actor |
| connections | 当前 namespace 的 provider 状态及公开 capabilities；无 secret，无跨公司连接复用 |
| runtime | provider=openbot；configured/openbotConfigured 来自实际企业执行 adapter readiness，richThreads 仅真实支持时给出；禁止 sample 假成功 |

缺 selector 400 SCOPE_REQUIRED，冲突 400 SCOPE_SELECTOR_CONFLICT，失效 session 401 SESSION_EXPIRED/SESSION_REVOKED，回调换账号 401 ACCOUNT_CHANGED，缺 proof 403 COMPANY_REAUTH_REQUIRED，不可见资源 404 RESOURCE_NOT_FOUND，authority/依赖不可用 503 AUTHORITY_UNAVAILABLE；响应统一 MobileBffError，SSE 在 headers 后失效则发同 code 的受控错误事件并终止，不重试到旧 origin。401 清身份与选择；403 保留目标但暂停业务，完成 challenge 后再验证；503 保持失败状态。enterprise 配置要求显式 authority/API origin，服务端 `authMode=enterprise` 禁止 accessKey、sample seed 和默认 local-user；standalone 仅在明确 standalone 配置和独立部署可用，模式不由 body/header 切换。

P12 验一次性 session/在线准入；P17 用真实 OpenMuse createApp + OpenBot authority 完成 workspace/CopilotKit/媒体/追加认证五条路由合同，并冻结子模块后端文件清单；这些前置未 verified 时 P20 blocked。P20 的真实 App e2e 逐请求记录最终 route、actor、company、team，断开 App→BFF 接线必失败，enterprise 的 standalone accessKey 反例必须拒绝。

### 5.3 个人模型 Grant/Key（P03/P12/P16/P18）

`access_grants` 新增授权 principalId/identityGeneration；`gateway_virtual_keys` 固定 sourceIdentityGeneration，与 Grant/user/customer 对应。只允许 active 真实用户显式授权签发当前代际；授权者尚无 Principal 时在无 tenant 的 principal 锁层同事务调用 PrincipalRegistry.ensure，不借加入公司补主体；全局恢复不回填旧行。重新授权须用户当前有效且再次确认：在 principal→grant 锁内将同一 user/Bot/externalIdentity 的旧 active 但代际失效行置 revoked，保留其原代际/历史引用，再新建新 grantId/当前代际及新 Key；不改旧行代际、不复用旧 grantId。与现有 one-active-per-identity 部分唯一索引一致，并发重授权仅一个当前 active Grant。P12 的 resolveForBot、claim 和 renew 在最终本地签发事务按 principal→grant→key 锁序重验 User/Principal/status/generation/Bot/Grant；初始锁外检查不能代替，远端 Key 操作不持 DB 锁，返回前再完成本地有效性落定，不满足则不披露并补偿回收。禁用/重置提交先于最终准入则失败；新命令持 principal 排他锁且不等 tenant。

P16 的实际网关新调用以已认证 Key 的本地 valueHash/keyId 解析来源，不接受 body 中 userId/代际；同一在线准入短事务内比较实时身份、来源 Grant/Key 代际及原账务规则，再准入 provider dispatch。没有版本/存储不可用/错来源一律拒绝，无 outbox 或正向缓存宽限。personal 模型路径不要求公司成员资格，某公司移除不影响它。P18 验证禁用前已发生调用、未知费用和延迟 usage 仍按原个人 payer/customer 结算；恢复与重授权不得重绑历史费用。P25/P22 迁移旧 Grant/Key：有明确授权与主体历史证据才重签当前能力，否则撤销并提示重新授权，禁止按 active 状态补版本。真实部署 Bifrost/governance 入口须有集成证据，credit-reserve 辅助测试不能替代。

## 6. 接口变更与装配规则

接口声明的类型、operation 和字段名在全计划中唯一。生产 schema/类型只能由所属任务修改；后续任务若发现无法实现，先提交具体冲突与修订建议，更新接口及所有调用者计划，再串行集成。不得局部增加 `skipAuthorization`、`asAdmin` 或将 BA team.id 塞进 workspaceId。

`server/src/app.ts` 只接收组合后的服务，`server/src/index.ts` 只负责创建和注入；各 Task 添加自己的参数和挂载调用，不互相复制初始化逻辑。P23 对实际挂载和后台消费者做闭环核验；最终新写端点开放还受独立的 authority version 与 rollout gate 控制。
