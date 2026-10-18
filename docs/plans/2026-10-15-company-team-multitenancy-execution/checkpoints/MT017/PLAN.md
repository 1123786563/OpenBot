# MT017 / Issue #60 实施计划 —— Bot 发布受众与旧 public 语义的显式迁移

日期：2026-10-17。实现者：backend_implementer（Orca Task `task_4ed9734d1c7d`）。
冻结 BASE：`f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（与 prereq-manifest 首行一致，
`verification/02-prereq-recompute.txt` 复算：BASE 一致 + 20 项直接消费文件哈希与
prereq-manifest 逐项一致，diff=0）。无提交/推送/合并/生产迁移/部署授权。

## 票面（gh issue view 60 实取）

发布 Bot 必须选择明确受众（团队公共或指定范围）；历史 public 标记只有经显式迁移
或显式发布才进入团队公共范围，绝不自动变成全公司/全平台公开。

1. 发布为团队公共后，团队成员按 MT009 规则可 read/run；非团队成员不可见。
2. 取消发布后团队成员立即失去使用权，已运行的会话按既有规则处理且不泄露内容。
3. 旧 public 资源在没有显式迁移动作时保持原暴露范围（对照测试）。
4. 发布受众不能设置为跨公司；此类请求被拒绝。

Verification：`bun test server/tests/multitenancy/bot-publish.test.ts`。
覆盖验收：A2（不可见性）、A3（多团队各自范围）、A4（公共使用无需逐人 grant）。

## 核心设计决策（先例驱动）

**发布 = 资源注册表上的显式受众事实，不写第二份权威。**

1. **发布状态落在 `enterprise_resources`**（kind='bot'，visibility='workspace'），
   与 MT036 知识库注册（kind='knowledge'）同构：MT009 的团队公共动作规则
   （read 经 MT008 判定、run 带依赖校验、管理动作拒绝、非成员 canonical
   not-found）原样适用于已发布 Bot——验收 1 的「按 MT009 规则」由此逐字成立，
   不复刻任何判定逻辑（Spec §4.2「不能通过新旧各写一份完成迁移」；MT010
   先例：分享事实不改归属行；MT036 先例：业务对象经资源注册进入授权面）。
2. **不注册新迁移任务**：设计不新增任何表/列/策略/授权。资源行 operator
   INSERT（租户范围）与 visibility 列级 UPDATE（MT008 授权，行策略钉
   app.tenant_id + app.resource_id）都是已验证交付。MT017 因此是纯模块 +
   测试 + 夹具三新文件——migrate-test.ts / migration-tool.test.ts / schema
   barrel / index.ts 全部零改动（比「授权编辑点」更窄的改动面）。
3. **发布/取消发布是 owner 动作**（MT016 编辑门同源：可见性门内
   owner_principal_id === scope.principalId，同团队非 owner =
   PUBLISH_FORBIDDEN，不可见者 = canonical not-found）。受众是显式输入：
   - 缺受众 → throw `PUBLISH_AUDIENCE_REQUIRED`（票面：必须选择明确受众）；
   - 受众形状坏 → throw `PUBLISH_AUDIENCE_INVALID`；
   - type ≠ "team" → deny `PUBLISH_AUDIENCE_UNSUPPORTED`（指定范围受众是
     后续票语义，本票只交付团队公共受众）；
   - 受众 tenant ≠ 归属 tenant → deny `PUBLISH_AUDIENCE_CROSS_COMPANY`
     （验收 4，响亮拒绝）；
   - 受众 workspace ≠ 归属 workspace（同公司跨团队）→ deny
     `PUBLISH_AUDIENCE_NOT_OWNING_TEAM`（fail-closed：跨团队共享是显式
     例外路径的业务，Spec §5.1，不在默认团队公共规则内偷放行）。
   判定顺序：受众纯校验（不触库）→ 可见性门 → owner 门——非成员对同一
   请求得到 canonical not-found，不泄露归属存在性。
4. **注册行不变量守卫**：同 (tenant, id) 资源行若 kind ≠ 'bot'、workspace ≠
   归属团队或 status ≠ 'active' → throw `BOT_PUBLISH_STATE_CONFLICT`
   （不变量破坏响亮拒绝，绝不静默改写）。已 'workspace' → 幂等 no-op；
   NULL/'private' → UPDATE 为 'workspace'（owner 对自己 Bot 的显式选择，
   与 MT008 迁移「绝不翻转 private」的**管理批量**语义不同——owner 动作
   优先于历史标记，属票面「显式发布」路径）；无行 → INSERT
   （display_name 取归属行服务端事实，kind='bot' 固定）。
5. **取消发布 = visibility 回 NULL**：团队公共使用路径立即关闭（下次判定
   即 not-found——MT008/MT009 全部调用时判定，无缓存）；显式 grant 不受
   影响（grant 路径与团队公共路径独立，MT009 验收 3 语义）；归属行与
   MT016 可见性不动（发布不改变归属；已签发 scope 不携带任何内容权，
   取消发布后同一 scope 的 read/run 立即 canonical not-found——验收 2 的
   「已运行会话不泄露」由调用时重验保证）。幂等：重复取消、未发布取消
   均 allow。status='deleted' 的注册行对取消发布 = 已非团队公共，幂等 allow。
6. **旧 public 对照**：旧 public 在企业域的表示 = 注册行 visibility NULL
   （MT008 冻结语义「NULL = 未标记/遗留」）。对照测试三件套：
   (a) NULL 注册行 + 遗留 grant → 无 grant 成员 read/run 全不可见（暴露
   范围没有自动变宽）；(b) 持遗留 grant 的成员 read 保持 allow（原暴露
   范围逐字保持）；(c) 经真实 MT008 `migrateLegacyResourcesToWorkspaceVisibility`
   manifest 入口显式迁移后成员 read/run 放行（delta 只来自显式动作）。
   另钉：MT016 createBot 不产生任何注册行（新 Bot 在显式发布前对成员
   read/run 不可见——「绝不自动」的结构性证据）。
7. **事务纪律与 MT016/MT008/MT009 同族**：assertScopeContext →
   assertTrustedScope → operator 事务（read committed + lock/statement
   timeout → 事务本地 app.* → advisory 锁）。锁序：tenant → principal →
   membership → workspace-membership → bot（共享，MT016 键族，钉住归属
   事实）→ resource（**排他**，["enterprise","resource",tenant,id] MT008
   键族——与判定读共享锁、MT008 迁移写排他锁串行化）。写路径全程受限
   operator 角色（夹具记录 current_user）；UPDATE 前 set app.resource_id
   （行策略要求，resource-visibility.ts 同款）。

## 诚实边界（模块头注释 + 报告 D-notes 钉死）

- 发布/取消发布只作用于 MT008/MT009 资源使用路径（read/run 及一切经注册
  表的团队公共面）；MT016 归属可见性（同团队列表/详情）是已验收的独立
  语义，本票不改其文件、不重复其判定——取消发布后同团队成员经 MT016 面
  仍可见该归属（归属未变），但使用权（run、注册表 read）立即关闭。
- 指定范围受众（people/group）、团队管理者代发布、发布审计字段属于后续
  票据；本票受众词表显式只含 "team"。
- 迁移动作复用冻结的 MT008 manifest 入口（真实调用，非重写）；票注
  「复用 MT003 工具的 manifest 机制」在无新 schema 对象前提下以
  「零新迁移任务」满足（provision 脚本仍经 MT003 工具按 brief 十四任务链
  逐任务 generate→apply 存档）。

## 交付物（三新文件，既有文件零改动）

1. `server/src/enterprise/tenancy/bot-publish.ts` — 发布服务
   （createBotPublishService({operator})）：publishBot / unpublishBot。
2. `server/tests/multitenancy/support/bot-publish.ts` — 夹具：双公司
   （A: A1/A2，B: B1）真实 provision、七身份、真实 scope resolver、
   MT016 createBotOwnershipService + MT009 createTeamResourceActionService +
   MT008 migrateLegacyResourcesToWorkspaceVisibility 全部真实装配、
   受限角色探针、data 角色注册行探针、operator 种子面（遗留注册行/grant/
   依赖）、dispose 清理。
3. `server/tests/multitenancy/bot-publish.test.ts` — 四验收逐条 describe
   （约 30 用例）。

## 测试矩阵 → 验收映射

- 验收 1（发布 → MT009 规则）：owner 发布 allow + 受众回显；注册行落库
  （受限 data 角色读）；无 grant 成员 read allow + run allow；管理动作
  TEAM_PUBLIC_ACTION_FORBIDDEN；非成员（同公司他团队）read/run canonical
  not-found 逐字节；跨公司成员逐字节同形；company-admin 无法铸造 scope；
  双团队成员 scope 钉死（a2 scope 不可见、a1 scope 可见）；发布前成员
  read/run 均不可见（发布的 delta）；发布后 run 依赖规则仍生效
  （坏依赖 → DEPENDENCY_INVALID，read 不受影响——MT009 规则原样适用）。
- 验收 2（取消发布）：取消后成员 read/run 立即 canonical not-found（与
  从未发布逐字节同形）；发布前签发的 scope 取消后同样被拒（无残留权）；
  取消幂等（重复/未发布均 allow）；显式 grant 在取消后仍 read allow、
  run 仍不可见（两路径独立）；非 owner 同团队成员发布/取消 =
  PUBLISH_FORBIDDEN；非成员/跨公司取消 = canonical not-found；MT016
  归属可见性不受发布/取消影响（对照钉死，两表面语义披露）。
- 验收 3（旧 public 对照）：(a)(b)(c) 三件套 + createBot 零注册行 +
  迁移不跨公司（B 公司成员对已迁移 A 公司 Bot 仍不可见）。
- 验收 4（跨公司受众）：跨公司受众 deny + 零写入（探针：无注册行 /
  visibility 原样）；同公司他团队受众 deny + 零写入；缺受众/坏形状
  throw；type=people deny UNSUPPORTED；forged scope UNVERIFIED_SCOPE；
  缺上下文 TENANT/WORKSPACE_REQUIRED；不变量冲突 BOT_PUBLISH_STATE_CONFLICT
  （kind 漂移行）；受限角色钉死（发布/取消全程 ob_ent_operator）。

## 门槛（brief 逐项）

聚焦全绿 0 skip；全量 ≥770+新增 0 skip；typecheck 0；触及文件 biome 0 新增
（新文件 3 个 + 零既有改动 → biome 检查 3 个新文件）；变异 ≥5 全捕获
（可见性门移除 / owner 门移除 / 跨公司受众拒绝移除 / 取消发布写路径移除 /
注册行 INSERT 路径移除——每个变异注入/还原哈希存档）；容器 docker rm -f
真实执行并回显存档；检查点全套 + reports/MT017.md + worker_done --report-path；
披露 D1–Dn。
