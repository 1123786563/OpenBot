# MT022 / Issue #65 执行计划 —— 会话生命周期权限（消息读写/重命名/归档/历史 replay 作用域授权）

票面（brief 绝对权威）+ Issue #65（Spec）：非成员不能读写会话消息、不能经历史 replay 绕过；
重命名与归档分别授权（可读不派生可改）；公共 Bot 使用者个人会话不入团队列表/搜索；撤权后
消息读写与 replay 立即失效（事务内重验）。不可见语义 = MT011 canonical RESOURCE_NOT_FOUND
逐字节同形；deny 零写入零副作用；真实 PostgreSQL + 受限 ob_ent_* 角色；缺 env 显式 skip。

## 环境事实（本计划核验）

- 专用容器 `mt022-impl-pg`（pgvector/pgvector:pg16）@ 127.0.0.1:**55563**（预检空闲）。
- 三库：`openbot_enterprise_w14a_test`（setup/base）+ `openbot_enterprise_w14a_test_assigned`
  （MT003 用例）+ `openbot_kb_w14a_test`（属主 `ent_w14a_kb`，先建）。
- 受限登录 `ent_w14a_{directory,data,operator}` 经 `enterprise-test-db.ts migrate` 配给。
- 七变量 env 0600：TEST_DATABASE_URL、ENTERPRISE_TEST_SETUP_DATABASE_URL、
  ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL、MT003_ASSIGNED_TEST_DATABASE_URL、
  KB_TEST_DATABASE_URL —— 用后删。
- 前置链十六任务：MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→
  MT016→MT041→MT027→MT028→MT070（MT021 十四链 + MT028/MT070，registry 顺序）。
- 冻结面核验：`conversations-list.ts` = `a7d5820b2d3fea40…`（与 brief 一致，before-hashes.txt）。

## 裁决（escalation 未答期间的保守裁定，报告披露）

- **Ruling Q1**：套件文件名取 Issue #65 Verification 字面
  `server/tests/multitenancy/conversation-messages.test.ts` —— 仓库冲突规则「Spec 为准」；
  brief 的 `conversation-actions.test.ts` 自述为「新文件**建议**」。模块文件仍按 brief 建议
  `conversation-actions.ts`。escalation msg_29bd4895c6e6 保持 pending，答复可推翻本裁定。
  风险：若协调者坚持 brief 名，需一次文件改名（成本≈0，无语义影响）。
- **Ruling Q2**：归档 = 授权判定面（方案B）。brief「如必须改（verified 交付文件），停下
  escalate」——方案A（注册 MT022 迁移 + archived_at 列）需改 migrate-test.ts /
  migration-tool.test.ts / enterprise-conversations.ts 三个 verified 文件，escalation 30 分钟
  未答；方案B（归档动作 = 独立授权判定，allow/deny，deny 零写入零副作用，不改任何既有文件，
  链保持十六）在既有授权内可完整交付且满足 AC2 字面（分别授权、可读不派生可改）。持久化
  留给下游接线票（与 MT009/MT011/MT016/MT021「服务面供下游接线」同例）。答复苏如选 A，
  属增量迁移票。风险：归档 allow 侧无持久写入，报告必须显著披露。

## 拥有文件（全部新建；既有文件零改动）

- 新建 `server/src/enterprise/tenancy/conversation-actions.ts` —— 五动作作用域服务
  （send / read / replay / rename / archive 授权 + 平台存储执行）。
- 新建 `server/tests/multitenancy/conversation-messages.test.ts` —— 票面 Verification 套件。
- 新建 `server/tests/multitenancy/support/conversation-actions.ts` —— 域夹具（MT021 同款）。

## 设计要点

- **每动作独立判定**（AC1/AC2/AC4）：send/read/replay/rename/archive 各自在一个数据事务内
  完成 assertScopeContext → assertTrustedScope → read committed + lock/statement timeout →
  set_config('app.*', true) → advisory 共享锁（tenant→principal→membership→workspace-membership，
  写动作再加 conversation 排他锁）→ 成员事实重验（公司 active+epoch、团队 active）→
  会话归属比对（RLS 租户臂 + workspace + principal）→ 执行或 canonical notFoundVerdict。
  replay 独立开事务独立重验（不是 read 的别名/委托）。
- **deny 零写入零副作用**：一切拒绝发生在任何 INSERT/UPDATE 之前；测试以 rawCount 不变量钉死。
- **公共 Bot 会话（AC3）**：消费 MT018 deriveThreadId 形状 `pubbot/<resourceId>/<principal>/<key>`
  + ownedByPrincipalId=使用者本人 → 团队他人 list/count/detail（MT021 冻结面消费）与五动作
  全部不可见/拒绝；发布者（同团队）亦不例外。
- **撤权（AC4）**：真实 MT006 suspendMembership（operator 通道）后旧 scope 五动作立即
  canonical 拒绝；「无 epoch bump 依赖」＝ status 判定独立可捕获（setup 通道构造
  status=suspended + epoch 与 scope 相等态，披露的测试缝隙）+ MT016 D4 同款
  suspend→restore（status active + epoch 失配）钉 epoch 臂。
- **平台存储面**：send/read/replay 只对 storage_backend='platform' 生效（digest 复用
  conversations/store.messageDigest，clientMessageKey 幂等/冲突语义与既有 append 同源；
  attachments=[] 属 MT024）；非平台 backend 响亮 `CONVERSATION_BACKEND_UNSUPPORTED`
  （披露 D 注：mastra/intelligence 写读仍归既有 conversations 服务）。

## TDD 波次

1. RED-1：夹具 + 测试先行，模块不存在 → `Cannot find module`（功能缺失型）。
2. GREEN：模块实现 → 聚焦套件全绿 0 skip。
3. 变异 ≥6：公司成员谓词移除 / 团队谓词移除 / 归属（principal）谓词移除（写侧）/ epoch 臂
   移除（restore 态捕获）/ status 臂移除（suspend+等 epoch 态捕获）/ canonical 码漂移 /
   fail-closed 移除 —— 每个新判定分支≥1 变异：注入→聚焦 fail→pristine sha256 还原闭环→复绿。
4. REFACTOR + 收尾：全量回归 =990+新增 /0/0/38+1、typecheck 0、biome 触及文件 0 新增、
   容器 docker rm 回显存档、reports/MT022.md、检查点全套。
