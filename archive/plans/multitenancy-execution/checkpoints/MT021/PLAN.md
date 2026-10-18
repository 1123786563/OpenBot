# MT021 / Issue #64 执行计划 —— 频道与会话列表、计数、分页游标的作用域

票面（brief 绝对权威）：列表/计数/分页游标三者在有权/无权混合数据下只反映可见集合；
他司会话 ID 详情不可见语义；切团队后立即变化无需重登；游标不因隐藏条目跳过/重复可见条目。
不可见语义复用 MT011（不自造错误码）；真实 PostgreSQL + 受限 ob_ent_* 角色；缺 env 显式 skip。

## 环境事实（已核验，verification/00-02）

- 专用容器 `mt021-impl-pg`（pgvector/pgvector:pg16）@ 127.0.0.1:**55529**（预检空闲）。
- 三库：`openbot_enterprise_mt021_test`（setup/base）+ `openbot_enterprise_mt021_assigned`（MT003 用例）
  + `openbot_kb_mt021_test`（KB 第 7 变量，属主 `ent_mt021_kb`）。
- 受限登录 `ent_mt021_{dir,data,opr}` 经 `enterprise-test-db.ts migrate` 配给（各自恰好一个 ob_ent_* 能力）。
- 前置链十四任务 MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027 全部
  generate+apply 落账（本票不注册迁移任务，链止于 MT027——见设计 D1）。
- 基线（实现前）：**770 pass / 0 fail / 29 文件 / 0 skip**（verification/01-baseline.txt，与 brief 一致）。
- prereq-manifest 213 项逐项复算 0 异常（verification/02-prereq-recompute.txt）。

## 拥有文件（新文件优先；既有文件零改动预期）

- 新建 `server/src/enterprise/tenancy/conversations-list.ts` —— 会话列表/计数/游标/详情作用域服务。
- 新建 `server/tests/multitenancy/conversations-list.test.ts` —— 票面 Verification 命令所指套件。
- 新建 `server/tests/multitenancy/support/conversations-list.ts` —— 域夹具（MT016 support 同款结构）。
- 预期既有文件改动：**无**（无迁移 → migrate-test.ts / migration-tool.test.ts / schema barrel 均不动；
  scenarios.ts 的 `"conversations"` 域已存在 → 不动）。若实施中出现必要例外，按窄例外纪律披露。

## 设计要点

- **可见性规则（个人会话，Spec §5.1）**：RLS 租户臂（ob_ent_data + app.tenant_id）→
  行 workspace_id === scope.workspaceId → 行 principal_id === scope.principalId（团队成员资格
  不开放他人会话）→ 事务内公司成员重验（active + epoch === scope.memberEpoch）与团队成员关系
  active。任一不成立 → 不可见。
- **列表/计数/游标只从可见项派生**：候选行按 `(created_at, id)` 全序（不可变键）读取；
  keyset 游标 `{v:1, at, id}` 只钉在最后一个可见项；第 limit+1 个可见项只签发下一页游标。
  updated_at 可变（消息追加会前进）→ 不入游标键（中途更新不跳不重）。
- **详情 = canonical 不可见**：`readVisibleConversation` 一切拒绝（不存在/跨公司/跨团队/
  他人会话/被撤权）返回 MT011 `notFoundVerdict()` 冻结实例，逐字节同形。
- **切团队立即变化**：scope 每请求经真实 resolver 铸造（同一 actor 身份、不同 workspace selector），
  服务按入参 scope 过滤，无进程级缓存（MT014 验收 4 同纪律）。
- **事务纪律**：与 MT008/MT011/MT016 判定入口同款 —— assertScopeContext → assertTrustedScope →
  read committed + lock/statement timeout → set_config('app.*', …, true) → advisory 共享锁
  （tenant → principal → membership → workspace-membership）。读路径全部经受限 data 角色。
- **输入校验响亮**：CONVERSATIONS_LIMIT_INVALID（1..200，缺省 50）、CONVERSATIONS_CURSOR_INVALID、
  CONVERSATION_ID_INVALID（UUID 形状）——不可见语义只有 RESOURCE_NOT_FOUND 一种（MT011 复用）。

## TDD 波次

1. RED-1：测试 + 夹具先行，模块不存在 → `Cannot find module`（功能缺失型）。
2. GREEN：模块实现 → 聚焦套件全绿 0 skip。
3. 变异 ≥5：workspace 过滤移除 / principal 过滤移除 / 游标钉候选行 / epoch 重验移除 /
   canonical 码漂移——逐个注入→聚焦捕获→pristine 还原（sha256 复验）→存档。
4. REFACTOR + 收尾：全量回归 ≥770+新增、typecheck 0、biome 触及文件 0 新增、
   容器 docker rm 真实执行回显存档、reports/MT021.md、检查点全套。
