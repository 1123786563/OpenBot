# [mt-M1] 批次核验报告：#62、#63、#66、#67、#68（MT019/20/23/24/25）

批次：[mt-M1]，worktree `1123786563/mt011` @ HEAD `3ca32d49`（包含 origin/main `295c0b89`）。
日期：2026-10-19。零代码改动（`git status` 仅本报告未跟踪）。

## 总览

**五张票全部 BLOCKED-GAP。** 预期主流"零改动 SATISFIED"不成立：这五张票的目标表面在
main 中是 pre-MT 的 per-person / channel-membership 实现，**不存在漂移到其他文件名的等价
实现**。MT 主干（MT001–MT018、MT021/22 等约 48 张票）已交付并有专门测试，但这五张恰是
尚未实施的下一波。

不存在等价实现的五路证据（对全部五票成立）：

1. **票面 Verification 文件全部不存在**：`bot-lifecycle.test.ts`、`marketplace-install.test.ts`、
   `group-membership.test.ts`、`attachments.test.ts`、`streams.test.ts` 在
   `server/tests/multitenancy/`（50 个测试文件）及全仓库均无，`git log --all` 亦无历史。
2. **测试套件票号覆盖表无此五票**：50 个 multitenancy 测试文件头注释逐一声明的票号
   （MT001–018、021、022、026–031、034、036–038、041、042、059、060、067、069–071、
   073、075–079、122、123）不含 MT019/20/23/24/25。
3. **生产代码边界注释两处点名推迟**：`server/src/enterprise/tenancy/bots-ownership.ts:61`
   （"逐动作生命周期授权（MT019）是后续票据的语义，本模块不预支"）、
   `server/src/enterprise/tenancy/conversation-actions.ts:52`（"attachments 恒为 []
   （MT024 附件票范围）"）。且 MT016 自述"本票不接路由"。
4. **目标路由全部只有 `requireUser`**：详见各票分节。仓库入口清单
   （`server/scripts/multitenancy/inventory.ts` 实测 569 个入口）ownerTicket 全部为
   null/unowned，无任何入口归属这五张票。
5. **GitHub 票面零认领**：五票均 OPEN、零评论、label 仅 `ready-for-agent`。

相邻已交付票的测试（本批各票最接近的等价验证命令替代物）单文件全部实证通过——证明
"已交付周界"定位准确且为绿，其中没有任何用例覆盖本批 AC：

| 相邻票 | 测试文件（实际名） | 结果 |
|---|---|---|
| MT016 #59 | `bots-ownership.test.ts` | 44 pass / 0 fail |
| MT017 #60 | `bot-publish.test.ts` | 35 pass / 0 fail |
| MT018 #61 | `public-bot-usage.test.ts` | 29 pass / 0 fail |
| MT007 #50 | `revocation.test.ts` | 29 pass / 0 fail |
| MT031 #74 | `plugin-install.test.ts` | 35 pass / 0 fail |
| MT004 #47 | `membership-model.test.ts` | 16 pass / 0 fail |
| MT009 #52 | `team-public-rules.test.ts` | 36 pass / 0 fail |
| MT022 #65 | `conversation-messages.test.ts` | 35 pass / 0 fail |
| MT005 #48 | `scope-gate.test.ts` | 23 pass / 0 fail |

合计 282 pass / 0 fail（专用企业测试库，见"环境与复现"）。

---

## #62 [E] MT019 Bot 生命周期动作逐项授权 —— BLOCKED-GAP

### 结论

逐动作授权（复制/隐藏/重置/删除/模板更新/远端回调）不存在。生命周期路由全部是
per-person 旧面：`server/src/agents/routes.ts`（duplicate:588 / hide:608 / unhide:622 /
delete:709 / callback-token:672,692）与 `server/src/agents/lifecycle-routes.ts`
（pause:169 / resume:180 / reset:216 / notifications:190）只有 `requireUser` +
`canManageAgent`（`server/src/agents/profile-policy.ts`：`ownerUserId === actor.id ||
actor.role === "admin"`，个人所有权 + 平台 admin，无公司/团队语义）。

### AC 逐条实证

- **AC1（每动作分别测试：公共使用者不能编辑/删除；团队管理者按明确管理权限才可）— 未实现。**
  "公共使用者不能编辑/删除"由个人所有权**顺带**满足（`canManageAgent` 拒绝非 owner）；
  但"团队管理者按明确管理权限"不存在——无公司/团队作用域的管理授权模型接到这些路由，
  MT016 服务层显式声明不预支 MT019（`bots-ownership.ts:61`）且自身不接路由（同文件
  "边界（诚实披露）"节）。无任何测试覆盖这些动作的租户越权。
- **AC2（远端回调必须匹配持久化归属，不接受回调体指定公司/团队）— 未实现。**
  `server/src/agents/callback-token.ts` 全文零 tenant/workspace/scope 引用；
  模板更新面 `POST /api/admin/openmuse-template/apply` 是平台 admin 面，无归属校验。
  （`grep -n "tenant\|workspace\|scope\|company" server/src/agents/callback-token.ts` → 0 命中。）
- **AC3（删除 Bot 后发布/受众/安装回执/授权同时失效，无悬挂引用）— 未实现。**
  `routes.ts:709` 的 delete 走 per-person store，无租户级联；`deletion-semantics.ts`
  是 MT067（公司数据清理 vs 全局账号删除双轨），与 Bot 删除级联是不同域。
- **AC4（撤权后 MT007 生命周期动作同样被拒）— 未实现。**
  生命周期路由不消费 MT005 scope-gate / entry-context 受信 Scope；
  `revocation.test.ts`（29 pass）只实证服务层事务门，不含生命周期路由。

### 命令与输出摘要

```sh
gh issue view 62 --repo 1123786563/OpenBot --json title,body,state   # OPEN, ready-for-agent, 0 评论
ls server/tests/multitenancy/ | grep -i lifecycle                    # 无 bot-lifecycle.test.ts
grep -rn "MT019" server/                                             # 仅 bots-ownership.ts:61（推迟声明）
TEST_DATABASE_URL=…（见环境节） bun test server/tests/multitenancy/bots-ownership.test.ts  # 44 pass
TEST_DATABASE_URL=… bun test server/tests/multitenancy/revocation.test.ts                  # 29 pass
```

### 缺什么（不实施）

- 生命周期动作的逐动作授权判定服务（复用 MT016 归属行 + MT011 canonical deny 形状）；
- 路由接线（六类动作入口换装受信 Scope / MT005 gate）；
- callback-token / 模板更新回调的持久化归属匹配；
- Bot 删除的租户级联（发布 MT017 受众、安装回执、授权行）；
- 专门测试文件（票面 `bot-lifecycle.test.ts`）。

## #63 [E] MT020 专家/模板安装与安装回执归属 —— BLOCKED-GAP

### 结论

`server/src/marketplace/` 全模块自述"Everything here is per-person"：目录是编译期常量
（`catalogue.ts`），安装回执 `MarketplaceStore` 按**人**记账（app.ts:593 注释：
"which expert each person installed"），零 tenant/workspace 引用
（`grep -n "tenant\|company\|workspace" server/src/marketplace/store.ts catalogue.ts` → 0 命中）。

### AC 逐条实证

- **AC1（公共目录只读可见、不含公司私有内容）— 顺带成立，非本票交付。**
  目录是 `CATALOGUE_EXPERTS/CATALOGUE_SKILLS` 编译期常量，结构上只读且无私有内容；
  但这是既有设计，不是租户隔离的结果。
- **AC2（安装产生的 Bot/技能/配置记录当前公司与团队；他公司不可见/升级）— 未实现。**
  安装写 `agents`/skills 行，无任何归属层（对比：插件目录 MT031 `plugin-catalog.ts` 为
  插件面实现了完整安装归属——`plugin-install.test.ts` 35 pass——但那是 #74 的交付物，
  覆盖 MCP/Composio/OpenConnector，不含专家/模板安装）。
- **AC3（升级/卸载按安装回执校验归属，不接受请求体指定归属）— 未实现。**
  `POST/DELETE /api/marketplace/{experts,skills}/:slug/install` 只有 `requireUser`，
  回执无归属字段可校验。
- **AC4（同一模板两家公司分别安装互不影响）— 未实现。**
  回执按 (person, slug) 记账，无公司维度隔离可言。

### 命令与输出摘要

```sh
grep -rn "tenant\|company\|workspace" server/src/marketplace/        # 0 命中
head -20 server/src/marketplace/routes.ts                            # "Everything here is per-person"
TEST_DATABASE_URL=… bun test server/tests/multitenancy/plugin-install.test.ts   # 35 pass（MT031 邻域）
```

### 缺什么（不实施）

安装回执的 tenant/workspace 归属列与迁移、安装/升级/卸载的归属判定（可复用 MT031 的
判定形状）、双公司隔离测试（票面 `marketplace-install.test.ts`）。

## #66 [F] MT023 群聊成员与 Bot 席位的作用域 —— BLOCKED-GAP

### 结论

群聊是 legacy channels 域：`server/src/channels/group.ts` + `routes.ts` 的成员模型是
`channelMemberships`（channel × user），**没有公司/团队概念**，也无从拒绝"跨公司"加人
（`grep -n "tenant\|workspace" server/src/channels/group.ts` → 0 命中）。
Bot 席位 `POST/DELETE /api/team-bots/:botId/assignments`（`server/src/team-bots/routes.ts:67,84`）
不经过 MT017 发布授权判定（`bot-publish.ts` 的授权服务未接线到该路由）。

### AC 逐条实证

- **AC1（跨公司用户/Bot 无法入群，拒绝不泄露存在性）— 未实现。** 加成员入口只查
  channel 成员资格，无公司边界可比对。
- **AC2（群成员只能访问该群内容）— 部分（个人维度）。** 既有 channel 成员解析
  （"WHO MAY BE HERE" per-request、非成员同 not-found）提供个人级隔离；无租户语义。
- **AC3（移除成员后读取与事件订阅立即失效）— 未实现（订阅面）。** 成员行删除后 HTTP
  读取会 fail；但 WS/SSE 订阅连接的即时失效无租户/会话级机制（与 #68 同根）。
- **AC4（Bot 席位变更经过与 Bot 发布一致的授权判定）— 未实现。** assignments 路由
  无 MT017 判定接线。

### 命令与输出摘要

```sh
grep -n "tenant\|workspace\|enterprise" server/src/channels/group.ts           # 0 命中
grep -n "publication\|assignments" server/src/team-bots/routes.ts              # 42/63/67/84，无授权判定
TEST_DATABASE_URL=… bun test server/tests/multitenancy/team-public-rules.test.ts   # 36 pass（MT009 邻域）
TEST_DATABASE_URL=… bun test server/tests/multitenancy/membership-model.test.ts    # 16 pass（MT004 邻域）
```

### 缺什么（不实施）

群成员模型的公司/团队边界（或 channel↔workspace 归属映射迁移）、席位变更的授权接线、
移除成员的订阅即时失效、专门测试（票面 `group-membership.test.ts`）。

## #67 [F] MT024 附件暂存上传、绑定、下载签发与清理的归属 —— BLOCKED-GAP

### 结论

附件链路全程 legacy：`server/src/channels/attachments.ts` + `attachments` 表
（`server/src/db/schema/core.ts:558`）只有 `channelId` + `uploadedBy`（个人/频道维度），
无 tenant/workspace 列、无对象存储按归属分桶/前缀、无签名 URL 归属校验。
enterprise 侧 `conversation-actions.ts:52` 明示 attachments 留空给 MT024。

### AC 逐条实证

- **AC1（存储路径按归属隔离、不可猜测、签名 URL 双点校验权限）— 未实现。**
  附件按 id/频道存取，无归属维度可隔离。
- **AC2（无权下载=不可见语义；撤销后新签发拒绝、已签发链接失效）— 未实现。**
  下载门是 channel 成员资格（个人），无撤销失效机制。
- **AC3（清理任务只处理自己归属范围）— 未实现。** 无租户维度清理边界。
- **AC4（上传上下文持久化，绑定/下载不依赖客户端重述归属）— 未实现。**
  持久化的上下文只有 channel+user，无公司/团队归属可携带。

### 命令与输出摘要

```sh
grep -A8 'attachments = pgTable' server/src/db/schema/core.ts        # channelId + uploadedBy，无归属列
grep -n "attachments 恒为" server/src/enterprise/tenancy/conversation-actions.ts  # :52 留给 MT024
TEST_DATABASE_URL=… bun test server/tests/multitenancy/conversation-messages.test.ts  # 35 pass（MT022 邻域）
```

### 缺什么（不实施）

附件表归属迁移、对象存储路径归属隔离、签名下载签发/代理双点校验、暂存清理的租户边界、
专门测试（票面 `attachments.test.ts`）。

## #68 [F] MT025 事件流订阅授权与外部线程映射归属 —— BLOCKED-GAP

### 结论

订阅表面（`channels/socket.ts`+routes 的 WS、`workshop/events.ts` 的 SSE、craft 流）全部
按 channel 成员/会话 Cookie 校验（个人维度），无订阅者受信 Scope 校验、无事件正文按
订阅者权限过滤、无公司/团队切换后取消旧订阅的机制。外部线程面：
`POST /api/threads/mint`（channels/attachments.ts:86 注释，"/bot chat 的 scratch thread"）
与 handoff-delivery 的 scratch thread 均无归属。enterprise conversations
（`server/src/enterprise/conversations/service.ts`，MT021/22）**确有**租户钉死的 thread
mapping（tenantId/workspaceId 全程比对），但那是企业入口 `/api/enterprise/conversations/*`
的交付物，不覆盖部署主入口的订阅与线程面。

### AC 逐条实证

- **AC1（订阅时校验权限；撤权后停止推送并断连）— 未实现。** 订阅建立走成员/会话校验，
  无 MT005 gate 续订重验，撤权不断连。
- **AC2（事件正文不含订阅者无权内容，含错误与状态事件）— 未实现。** 无正文过滤层。
- **AC3（外部线程 ID 携带归属且需授权；他公司线程 ID 不能读取/续订）— 主入口未实现**
  （threads/mint、scratch threads 无归属）；企业入口已实现（MT021/22，非本票范围）。
- **AC4（切换公司/团队后旧范围订阅取消）— 未实现。** 无范围概念可切换。

### 命令与输出摘要

```sh
grep -n "upgradeWebSocket\|channelMember" server/src/channels/routes.ts        # 成员资格=userId 比对（:426-429）
grep -rn "MT025" server/                                                       # 0 命中
TEST_DATABASE_URL=… bun test server/tests/multitenancy/scope-gate.test.ts      # 23 pass（MT005 邻域）
TEST_DATABASE_URL=… bun test server/tests/multitenancy/conversation-messages.test.ts  # 35 pass（企业线程邻域）
```

### 缺什么（不实施）

订阅建立/续订的受信 Scope 校验与撤权断连、事件正文过滤、threads/mint 与 scratch thread
的归属持久化、范围切换的订阅取消、专门测试（票面 `streams.test.ts`）。

---

## 改动文件

**无产品/测试代码改动。** `git status --short` 仅 `?? ORCA-REPORT.md`（本报告，覆盖上一
批 #54 的旧报告）。五张票全为 BLOCKED-GAP，缺口远超 ≤20 行就地补的阈值（每张都需要
迁移 + 服务判定 + 路由接线 + 专门测试），且互相与 MT125（选择头铺设）纠缠，应留专项派发。

## 环境与复现

容器 `orca-all-mt011-pg`（pgvector/pg17，端口 5562）按纪律保留。库与角色实测状态：

- 主库 `openbot_enterprise_mt011`（前次 #54 会话建，主链 + MT004/008/009/010 已应用）。
- 本批新增库 `openbot_enterprise_mt011b`（同容器）：`CREATE DATABASE` 后只跑
  `server/scripts/enterprise-test-db.ts migrate`（要求全新库；先跑 `scripts/migrate.ts`
  会被 fresh-schema 守卫拒绝），`{"type":"migrations-applied","status":"ok"}`。
- 角色 `ent_mt011_{directory,data,operator}_login` 前次会话密码未知，本批用超户
  `enterprise_setup` 重置为已知值（见 `/tmp/mt011b-env.sh` 配方，含
  `?options=-c%20role%3Dob_ent_*` 由 `enterprise-database.ts` 钉死的写法）。
- 票面 `TEST_DATABASE_URL=…/mt011` 不可用：库名不匹配
  `enterprise-database.ts:188` 的 `/^openbot_enterprise_/`，探针会整套 skip。

### 既有事实（非本批引入，建议转告在途 CI 修复线 #399/#402）

全量 corpus 单进程按 manifest 顺序（`docs/verification/e2e-bun-suites.json` part1+2，50 文件，
`xargs bun test`）在新库上：**817 pass / 133 fail / 81 skip**。首块多米诺是
`bot-publish.test.ts` 自 apply 的任务迁移 MT112：其 `legacy_anchor_rows` 步骤对
`enterprise_principals` 的 INSERT 用 `ON CONFLICT ("id") DO NOTHING`，但实际撞的是
**user_id 唯一索引 `enterprise_principal_user`**（`drizzle/0055_enterprise_tenancy.sql:84`）
——字母序在前的套件先落了 users+principal 行后，锚点 INSERT 即 duplicate key，下游
116 个 "Failed query" 连锁。同库同 env 下逐文件单跑：上述 9 个目标文件全部 0 fail
（含 corpus 中失败的 bot-publish 35✓ / team-public-rules 36✓ / public-bot-usage 29✓，
在 corpus 完成后的库状态上复测）。即：**套件间共享库顺序耦合在 main 上真实存在**，
与记忆中"main CI 修复进行中"一致；未做任何修改（超出本批授权与 20 行阈值）。

另：81 skip 为 `kb-ownership`/`retrieval-restriction` 等需要 `KB_TEST_DATABASE_URL`
的套件显式跳过，未计为通过。

## 遗留

1. 五张 BLOCKED-GAP 票待协调器决定专项派发顺序；建议 #62 优先（MT016/17/18/22 依赖链
   已就绪，接线面最清晰），#66/#68 共享"订阅与成员失效"机制可同批。
2. MT112 锚点种子的 `ON CONFLICT` 目标约束不匹配（id vs user_id 唯一）+ corpus 顺序
   耦合——属 main 既有缺陷，建议并入 CI 修复票（#399/#402 在途）。
3. 容器保留；`openbot_enterprise_mt011b` 与重置后的角色密码留给后续批次复用
   （配方 `/tmp/mt011b-env.sh`，重启丢失后按本节重建）。
