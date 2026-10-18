# MT028 / Issue #71 执行计划 — OAuth 回调按服务端 state 固定归属

角色：backend_implementer（全新 Pi 会话，Orca task_61d771fae8e6）。BASE f0520524。
无提交/推送/合并/生产迁移/部署授权——交付为未提交工作树 + checkpoints/MT028/。
TDD 全程 RED→GREEN→REFACTOR；专用测试 PostgreSQL + 受限业务角色；缺
TEST_DATABASE_URL 不回退开发库；skipped 不算通过。

## 领取核验（已完成）

- BASE = f0520524f0faa2b4533b9d2f1aa692c8f907ba71 ✓（git log 实测）
- prereq-manifest 逐项复算：213 文件 sha256 全部 OK，0 missing，0 drift ✓
- 票面实取：`gh issue view 71` ✓（四条验收 + Scope boundary + Handoff notes）
- 父 Spec §6 OAuth 段 + §5.2/§11（A7/A1/A5）已读；CONTEXT.md「公司与团队」术语已读
- 直接前置先例已读：MT027 报告 + credential-ownership 模块/迁移/夹具（所有权、
  判定、审计、脱敏、restricted 通道事务形状）；MT026 identity-binding（服务端
  持久 intent + 不透明 state + 一次性消费 + TENANT_MISMATCH 不消费的先例——
  本票是其连接凭据版）；MT005 scope-gate（受信 Scope）；MT007 撤权审计
  （enterprise_security_events 写入通道：operator + app.tenant_id + app.operation_id）
- 环境：迁移 CLI `generate <task> --out DIR` + `migrate <task> --apply --manifest`；
  enterprise-test-db 守卫（setup 超户 + 三能力 URL=ent* 登录）；本票不触 kb 域
  （无 KB_TEST_DATABASE_URL 需求，kb 测试显式 skip 不计入本票门槛——与基线一致）

## 设计（一表一服务，纯新增 + 三处授权扩展点）

### 新文件
1. `server/src/db/schema/enterprise-oauth-state.ts` — `enterprise_oauth_states`：
   - id = 不透明 state 值（randomUUID，服务端生成，非回调可声明）
   - 归属三元组：tenant_id + workspace_id + principal_id，全部复合外键内嵌
     tenant_id（证明团队属本公司、发起人是本公司成员）——归属行结构性无法跨公司
   - purpose（闭集 CHECK：'connection' | 'site-login'，对齐 MT027 凭据 kind）+
     target（非机密寻址 ≤512）——「连接目的」
   - verifier（PKCE verifier ≥43，服务端生成）——持久行是流程秘密材料的唯一
     事实源；安全事件/响应/日志绝不携带
   - status（'pending'|'consumed'|'failed'）+ consumed_at/failed_at/failed_reason
     行形 CHECK 强制三态互斥自洽；expires_at > created_at 窗口 CHECK
   - RLS：ENABLE+FORCE；operator INSERT（tenant 臂）/ SELECT+UPDATE（state 臂
     app.oauth_state，无公司枚举）；data/directory 零策略零授权
2. `server/src/enterprise/tenancy/oauth-state.ts` — 服务（只走受限 operator 通道）：
   - `initiate(trustedScope, { purpose, target, ttlSeconds? })`：assertTrustedScope
     → 事务 pin app.tenant_id → 生成 state + verifier → INSERT pending 行 →
     返回 { state, codeChallenge(S256), expiresAt }。归属三元组只来自受信 Scope，
     客户端无法用自选 scope 发起。
   - `consume(state, { claimed?, securityAttributionTenantId? })`（无会话回调唯一
     归属入口）：state 臂读持久行 → 缺失/过期/重复/跨范围/发起人失格五拒绝 →
     归属完全来自持久行（claimed 只参与比对、永不决定）；跨范围不匹配响亮拒绝
     且**不消费**（MT026 先例：声称既不生效也不烧掉 state）；存活重验（公司成员
     资格 + 团队成员资格 active，A5）在消费前同一事务完成；一次性消费 =
     UPDATE ... WHERE status='pending' AND expires_at > now() 原子翻转。
     deny 一律携带安全事件（enterprise_security_events，eventType
     'oauth.state.rejected'，operator 通道 pin tenant+operation_id；缺失 state
     无归属公司，仅在调用方显式提供 attribution 租户时落事件，绝不臆造租户）。
   - `fail(state, { reason })`：pending→failed / consumed→failed（vendor 拒绝、
     落库失败、放弃三类闭集原因）；终态，consume 再遇 = REPLAYED——「重试必须
     新 state」由结构保证。
   - 模块自身零连接写入（不 import 任何凭据/连接表）——「回调失败无半成品连接」
     由结构保证：本模块唯一的写面是 state 行与安全事件；连接落库属调用方在同一
     allow 分支的下游职责。零 console、零 process.env；拒绝消息只含代码，
     绝不回显 state 值/verifier/token。
3. `server/tests/multitenancy/support/oauth-state.ts` — 夹具（包 resource-policy
   基座：两公司三团队真实名册 + 受限 operator 通道 + 受信 Scope 签发）+
   canary 扫描 + 安全事件读回（operator，pin tenant+operation_id）+ 目录探针
   （超户，只读）。
4. `server/tests/multitenancy/oauth-state.test.ts` — 验收套件（Ticket Verification
   指定路径）。

### 授权扩展点（纯追加，前像哈希存档）
5. `server/src/db/schema/index.ts` — barrel 追加 1 行（排序位 enterprise-oauth-state）
6. `server/scripts/multitenancy/migrate-test.ts` — 追加 MT028 任务（第十五；
   两步：建表 + RLS/最小授权）
7. `server/tests/multitenancy/migration-tool.test.ts` — allowlist 追加 "MT028"
   （ruling #5 第 13 次，带裁决注释）
8. `server/src/index.ts` — 装配段追加 `oauthState`（受限 operator 通道，缺通道
   fail-closed = null；与 MT010/MT027 同纪律）

## 测试映射（票面四条验收 → 套件 describe）

- AC1 回调绑定发起时公司/团队/用户/连接目的、与回调时选择无关：
  initiate(受信 scope)→consume→allow binding 三元组+purpose+target 逐字段相等；
  claimed 租户/团队/属主各不匹配变体 → CROSS_SCOPE 且永不改写；相同 claimed
  与无 claimed 的 binding 输出逐字节一致。
- AC2 缺失/过期/重复/跨范围拒绝+安全事件：五拒绝码逐一（MISSING/EXPIRED/
  REPLAYED/CROSS_SCOPE/INELIGIBLE）+ 各自安全事件行（type='oauth.state.rejected'、
  details.code、零 secret）；MISSING 无归属不落行、显式 attribution 才落；
  跨范围后原流程仍可正常消费（不烧 state）；并发/顺序双消费恰一 allow。
- AC3 回调失败无半成品连接、重试用新 state：consume allow→fail→终态 REPLAYED；
  重试=新 initiate→新 state 值；模块源面断言零连接表引用（kb 先例
  authoritySource 扫描同款）；失败路径后 state 行计数恰等于发起计数。
- AC4 响应与日志零 token 明文：canary（verifier/state/伪 token）扫描全部
  deny 输出 + 错误消息 + 安全事件 details 序列化零命中；allow binding 仅在
  类型化 verifier 字段携带流程材料（无任何 token 字段）。
- 存储栅栏（MT027 先例）：RLS ENABLE+FORCE；data/directory 零授权；operator
  无 state 臂读不到任何行（防枚举）；跨公司 scope 上下文零泄漏。

## 验证门槛（brief）

1. 端口 55530 起预检（占用 +1 记录）；专用容器 mt028-impl-pg @ 127.0.0.1:55530
   （pgvector/pgvector:pg16，trust，双库 openbot_enterprise_mt028_test + _assigned）
2. 基线：改动前全量 multitenancy 套件 770/0/29 文件实测存档
3. RED：模块缺失聚焦失败存档 → GREEN：聚焦全绿 0 skip 存档
4. 全量回归 ≥770+新增、0 fail、0 skip 存档
5. 变异测试逐个注入→聚焦→恢复→sha256 校验闭环，全捕获存档
6. typecheck 0；biome 触及文件 0 新增（收尾复跑存档；src/index.ts 存量欠账
   4×noConsole+1×noNonNullAssertion 为 BASE 先在，反向核验记录）
7. 迁移 generate+apply 十五任务链 MT004→…→MT027→MT028 真实落账（journal 存档）
8. 容器 docker rm 真实执行并回显输出存档（coordinator 亲验）
9. reports/MT028.md + sha256 manifest + before/after hashes + worker_done --report-path

## 变异候选（≥8）

M1 消费原子臂丢 status='pending'（双消费放行）；M2 过期检查移除（过期可消费）；
M3 跨范围比对短路（claimed 不比对）；M4 归属三元组改用 claimed（回调选择生效）；
M5 安全事件写入移除（拒绝不留痕）；M6 fail 终态臂丢 status 限制（已消费可再失败/
复活）；M7 initiator 存活重验移除（失格仍消费）；M8 verifier 缺失放行/行形
CHECK 松绑（RLS SELECT 授权扩到 data 角色）。

## 诚实披露预留

D1 缺失 state 安全事件的归属边界（无归属公司不落行，attribution 参数显式供给）；
D2 消费存活重验用 status 不比对 epoch（epoch 纪律属 scope-gate 域，state 行是
发起时快照，fail-closed 已由 status 覆盖 A5 停用面）；D3 verifier 入行属本票
设计延伸（连接目的持久行的单一事实源；票面未点名 PKCE，理由存档）；
D4 装配 fail-closed= null 的边界（企业 OAuth 连接发起不可用，旧个人流不受影响）；
其余按实披露。
