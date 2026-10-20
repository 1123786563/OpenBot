# orca-dag-wave2 MT 域票处理报告

- Worktree: mt2（自 main@c80927fa 新建，分支 1123786563/mt2 @ bf64d0f2）
- 测试库: postgres://postgres:postgres@127.0.0.1:5562/openbot_enterprise_mt2（容器 orca-w2-mt-pg；库名受 enterprise URL 校验强制 `openbot_enterprise_*` 前缀，原任务指定 `mt2` 库名不合规，已改用 `openbot_enterprise_mt2`）
- 环境: TEST_DATABASE_URL + ENTERPRISE_TEST_SETUP_DATABASE_URL=postgres 超级用户；ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL=受限 login 角色（enterprise_{directory,data,operator}_login，MEMBER OF ob_ent_*，已按 capabilityCatalogQuery 要求制备）+ options=-c role=ob_ent_*
- 库制备配方: 库由 **b7832879 主链**（migrate.ts，无 #436 的 0163）建底 + migrate-test.ts 全部 26 个 MT 任务按文件序应用（journal 全 applied）。⚠️ main 链（含 0163）建的库会让 MT003 replay 撞 already-exists；b7832879 链 + 全 MT 任务 = 收敛态，main 检出态测试直接 up-to-date。
- 测试命令: `cd server && . /tmp/mt2env.sh && bun test ./tests/multitenancy/<file>`（ADR 0008 driven 层，Bun 为执行运行时）

## 逐票结论

### #62 (MT019) Bot 生命周期动作逐项授权 — SATISFIED（分支核验，不重实施）
- 实现: 远程分支 1123786563/mt-w1 @ b7832879 已含 4 文件 +2294 行（server/src/enterprise/tenancy/bot-lifecycle.ts +728、server/tests/multitenancy/bot-lifecycle.test.ts +841、server/tests/multitenancy/support/bot-lifecycle.ts +679、reports/54-impl.md +46）
- 命令: `cd server && bun test ./tests/multitenancy/bot-lifecycle.test.ts`（检出 b7832879）
- 结果: **25 pass / 0 fail**（exit 0；无 skip，84 expect）
- AC 对照: AC1 每动作独立授权（SCOPED_ACTIONS 五动作 + remote-callback 独立入口，identity matrix 全身份×全动作）✓；AC2 回调归属仅持久化行、客户端归属键响亮拒绝 ✓；AC3 删除单事务级联（受众关闭+grants 物理删+归属行硬删，FK 级联回执零残留）✓；AC4 撤权后六动作一律 canonical not-found ✓
- 关键坑: b7832879 不能在 main 链（#436 后 0163）建的库上跑——MT003 replay 撞 already-exists 拒绝；需 b7832879 链库 + 全 26 MT 任务先应用。集成时需按 bf64d0f2 的收敛模式适配。
- 改动: 无（核验路径，零代码改动）

### #63 (MT020) 专家/模板安装与回执归属 — SATISFIED（已实施）
- 新增: server/src/enterprise/tenancy/marketplace-install.ts（服务：目录只读投影+装配点毒条目防御、install/upgrade/uninstall 单一判定入口、归属键一律拒绝、锁序 tenant→…→bot→marketplace-receipt）
- 新增: server/tests/multitenancy/support/marketplace-install.ts（真实 provision 双公司三团队五身份 + 受限三角色通道 + RLS 探针）
- 新增: server/tests/multitenancy/marketplace-install.test.ts（AC1-AC4 逐条 describe + 业务回归）
- 关键设计: 零新 schema——回执=enterprise_resources kind='marketplace-install'（id=产物 agentId，displayName='marketplace:<slug>'），产物=enterprise_bot_ownership（版本单一事实源=产物行 revision；resources 仅 operator visibility 列可 UPDATE，升级只写产物行；卸载=产物行硬删+回执行经产物缺失在判定面一律不可见）
- 命令: `cd server && bun test ./tests/multitenancy/marketplace-install.test.ts`
- 结果: **23 pass / 0 fail**（exit 0；tsc 对新文件 0 错误；相邻 bots-ownership 44/0 无回归）

### #66 (MT023) 群聊成员与 Bot 席位作用域 — SATISFIED（已实施）
- 新增: server/src/enterprise/tenancy/group-membership.ts（createGroup/inviteMember/removeMember/addBotSeat/removeBotSeat/readGroup 单一判定入口）
- 新增: server/tests/multitenancy/support/group-membership.ts（真实 provision + MT016 ownership/MT017 publish 真服务装配 + operator 探针）
- 新增: server/tests/multitenancy/group-membership.test.ts（AC1-AC4 逐条 describe）
- 关键设计: 零 schema——群=resources kind='group-chat'，成员=grants action='read'（跨公司邀请/不存在用户 canonical not-found 同形）；席位=resources kind='group-bot-seat'（visibility 列在场标记，operator 唯一可 UPDATE 列）；席位授权=Bot owner ∨ tenant_admin + MT017 发布注册行事实（与发布一致）；成员计数走 operator 通道（grants self_read restrictive 语义披露）
- 命令: `cd server && bun test ./tests/multitenancy/group-membership.test.ts`
- 结果: **18 pass / 0 fail**（exit 0；tsc 新文件 0 错误）

### #67 (MT024) 附件暂存/绑定/签发/清理归属 — SATISFIED（已实施）
- 新增: server/src/enterprise/tenancy/attachments.ts（stageUpload/bindToConversation/issueDownloadUrl/resolveDownload/revokeUpload/cleanupStaleUploads）
- 新增: server/tests/multitenancy/support/attachments.ts（真实 provision + MT006 真实撤权路径 + 会话种子 stand-in + operator 探针）
- 新增: server/tests/multitenancy/attachments.test.ts（AC1-AC4 逐条 describe）
- 关键设计: 零 schema——附件=resources kind='attachment'（行本体即上传上下文，AC4）；路径 tenant/workspace/ref 分段+服务端随机 ref（AC1）；签名 URL=ref.expiry.HMAC 双点校验（签发点可见门+代理点 token+权限重验，AC1/AC2）；visibility 列双态生命周期（NULL=有效/'private'=撤销/清理，operator 唯一可 UPDATE 列，披露复用）；可见门=上传者 grant 本人（MT008 NULL 资源走 grant 语义对齐）；清理双过滤 tenant+workspace 不跨公司（AC3）；绑定会话校验走 data 通道（conversations 授权面是 ob_ent_data）
- 命令: `cd server && bun test ./tests/multitenancy/attachments.test.ts`
- 结果: **15 pass / 0 fail**（exit 0；tsc 新文件 0 错误）

### #68 (MT025) 事件流订阅与外部线程映射归属 — SATISFIED（已实施）
- 新增: server/src/enterprise/tenancy/streams.ts（openSubscription/pushEvent/cancelSubscription/bindExternalThread/readThreadByExternal/renewSubscriptionByExternal）
- 新增: server/tests/multitenancy/support/streams.ts（含 a1a2-member 双团队身份驱动切换场景；MT006 真实撤权）
- 新增: server/tests/multitenancy/streams.test.ts（AC1-AC4 逐条 describe + 撤权用例置末防身份污染）
- 关键设计: 订阅=resources kind='event-subscription' + 订阅者 grants read 行（个人订阅事实持久，推送面 join 验订阅者）；撤权后旧 epoch scope 推送 → readSubscriberFacts 事实重验失败 → closed；正文白名单闭形 {type,status,message} 三键（构造面键数校验，AC2 形状保证）；外部映射=kind='thread-mapping'（同串两租户各行，RLS 隔离）；切换范围收旧（开订阅时其他 workspace 活跃订阅关闭，线程清单经 data 通道预取——conversations 授权面 ob_ent_data）
- 命令: `cd server && bun test ./tests/multitenancy/streams.test.ts`
- 结果: **16 pass / 0 fail**（exit 0；tsc 新文件 0 错误）

## #75 / MT032 — 工具调用重校验：SATISFIED

- 实现：`server/src/enterprise/tenancy/tool-invocation.ts`（sha256 51f70a3d223017fefe783b15bb731918159736608881a052ca4418340ae65d56，纯新增零 schema）
  - 单一判定入口 `authorizeToolInvocation`：每次调用全新 data 事务重验（零缓存 → AC3 结构保证）。
  - 门 0 调用者事实（membership active + epoch 重验）；门 1 Bot（bot_ownership 本人 active+workspace ∨ MT017 发布注册行 kind='bot' visibility='workspace'）；门 2 连接（enterprise_credentials personal/owner 或 team/workspace + MT027 'use' 动作行，删除即撤销）。
  - 不可见 → MT011 canonical not-found（他人连接与不存在同形）；可见但无权 → 明确码 TOOL_BOT_NOT_USABLE / TOOL_CREDENTIAL_NOT_USABLE。
- 测试：`server/tests/multitenancy/tool-invocation.test.ts`（11/11 pass，退出码 0）+ `support/tool-invocation.ts`（真实 ownership/publish/scope resolver/suspendMembership，seedConnection 为披露的 setup stand-in）。
  - `cd server && . /tmp/mt2env.sh && bun test ./tests/multitenancy/tool-invocation.test.ts`
- 回归：`bot-publish.test.ts` 35/0；tsc 无新文件错误。
- 调试记录：enterprise_credentials.display 是 jsonb 且有 `enterprise_credential_display_shape` check（只允许 label 键，禁 envelope/secret 类键）；envelope 是 text。测试断言修正两处：AC2 同形用例的 Bot 需 publish（否则被 Bot 门 deny 码拦截到不了连接门）；AC3 跨范围与 AC4 "未发布且非本人" 同构 → 期望 deny 码而非 not-found。撤权用例置套件末尾（MT006 停用持久，a1-other 不再复用）。

## #76 / MT033 — 技能与组件发布、组件数据函数作用域：SATISFIED

- 实现：`server/src/enterprise/tenancy/skills-components.ts`（sha256 55a5964cc00a5af5e7e92991220afe8d505c04c3e1724c545489e7a1e8d8afea，纯新增零 schema）
  - 发布行 = enterprise_resources（kind='skill'/'component'，visibility='workspace'=团队公共活跃行，revision=版本）；发布者归属 = grants 'read' 行（MT024 附件上传者同款事实面）。
  - 版本 append-only（operator 对 resources 只有 INSERT + visibility/acl_epoch UPDATE，无 revision UPDATE/无 DELETE——已查 information_schema.column_privileges 核实）：升级 = 旧行 visibility→'private'（软删，行策略需 set_config app.resource_id）+ 新行 INSERT；回放幂等收敛、回退明确码 COMPONENT_VERSION_NOT_MONOTONIC。
  - invokeComponentFunction 会话门按**调用者本人** principalId 重验（AC2：作者身份不放大）；unpublish 软删活跃行 → 成员下一次 not-found（AC4 立即）。
  - 拒绝形状：不可见 canonical not-found；可见但被拒 → SKILL_READ_ONLY / SKILL_PUBLISH_FORBIDDEN / COMPONENT_VERSION_NOT_MONOTONIC。
- 测试：`server/tests/multitenancy/skills-components.test.ts`（票面钉死路径；13/13 pass，退出码 0）+ `support/skills-components.ts`（真实 provision/scope resolver/suspendMembership，seedConversation 为披露 setup stand-in）。
  - `cd server && . /tmp/mt2env.sh && bun test ./tests/multitenancy/skills-components.test.ts`
- 回归：`group-membership.test.ts` 18/0；tsc 新文件 0 错误（修一处 SkillPublishDecision 联合类型漏 COMPONENT_VERSION_NOT_MONOTONIC）。
- 本票 AC 无撤权（MT006）项，无身份污染问题；受限角色探针在场。

## 终态小结（worker：task_f2da738381ce / mt2 worktree）

- 范围（协调者裁决 6 张）全部 SATISFIED：#62（mt-w1@b7832879 核验 25/0）、#63（23/0）、#66（18/0）、#67（15/0）、#68（16/0）、#75（11/0）、#76（13/0）。
- 整体回归：`bun test` 6 文件同跑 **96 pass / 0 fail**（exit 0）；tsc 对全部新增文件 0 错误；相邻既有测试无回归（bot-publish 35/0、group-membership 18/0）。
- 未 commit / 未 push（约束遵守）；改动全部为纯新增文件（5 个实现模块 + 6 套测试与 support），零公共文件改动、零 schema 迁移。
- 集成注意事项：库名合规化 mt2→openbot_enterprise_mt2；#436（0163 restore-drifted-tables）与 MT003 replay 冲突的收敛适配见头部配方节。
