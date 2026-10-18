# MT070 / Issue #113 设计 — 公司调用归属与同一余额的原子预扣

角色：backend_implementer。BASE f0520524（领取复算 01-prereq-recompute.txt）。前置链十四任务
已在专用容器 `mt070-impl-pg`（127.0.0.1:55528）按 brief 序真实 apply（04-prereq-chain.txt）；
基线复现 **770 pass / 0 fail / 29 文件 / 0 skip**（06-baseline.txt，首轮同数，二次运行撞
acceptance-harness 固定端口 45435 的瞬时竞态已复跑澄清——文件单跑与全量重跑均 770/0）。

## 1. 票面 → 实现面映射

票面四条验收（`gh issue view 113` 实取）+ Spec §7/§11 A9 + 票注「付款账户由服务端固定；
客户端指定账户的请求被拒绝」：

| # | 验收 | 实现面 | 证明（聚焦套件用例） |
|---|---|---|---|
| AC1 | 并发预扣证明总额不超余额（真实数据库并发用例） | 原子性来自既有 writer 的 `lockCustomer`（customer 行 `FOR UPDATE` 串行化同一账户全部预扣/结算）——本票**消费**该路径、零修改；并发测试用真实并行连接（池 ≥ 并发数）对同一公司余额同时开预扣 | "concurrent teams never overdraw the shared company balance"（甲/乙 ×N 并发 + 公司 B 并行，断言 Σheld ≤ balance、成功笔数确定、每笔预扣有归属行） |
| AC2 | 公司 A 不能消费公司 B 余额（伪造标识也拒） | (a) 付款方 = `resolveCompanyCustomer(tenantId)` 服务端解析，输入形状**没有**客户字段；(b) 运行时守卫拒绝客户端塞入的 `externalCustomerId`/`customer` 键 → `PAYER_ACCOUNT_FIXED`；(c) 伪造公司归属被复合外键事实拒：principal 非本公司成员 → `CALL_MEMBER_REQUIRED`；workspace 不属本公司 → `CALL_WORKSPACE_MISMATCH`；全部拒绝路径零写入 | "rejects a payer named by the caller"、"a principal who is not a member of the claimed company cannot draw its balance"、"a team from another company is refused under a valid membership" |
| AC3 | 每次预扣记录公司/团队/使用人/Bot 授权/稳定调用标识 | 新表 `billing_call_attributions`：reservation 1:1 归属行（复合外键同时证明 workspace 属公司、principal 是公司成员——MT004/MT010/MT041 同款结构纪律）；每次成功预扣恰好一行 | "records company, team, user, bot authorization, and the stable call key for every reservation" |
| AC4 | 预扣上界与幂等键语义不变（重复请求不重复预扣） | 上界判定与幂等键全部留在既有 `reserveCredits`（返回形状原样透传：`{reserved:true,reservationId}` / `{reserved:false,availableCents}`；重放同键同归属返回原预扣、终态预扣冲突、键+客户/金额不一致冲突——writer 原语义）；重复调用标识（不同幂等键、同 call_key）被服务预检 + `(tenant_id, call_key)` 唯一索引双重拒绝 → `CALL_KEY_CONFLICT`，结构上不可能二次预扣 | "refuses a hold above the ceiling and writes nothing"、"replays the same idempotency key without double-reserving"、"refuses an idempotency-key replay that changes the attribution"、"refuses a second reservation for an already-used stable call key"、"the call-key unique index backstops a concurrent duplicate call" |

A9 邻接（「用量可按团队/用户汇总」）：`usageSummary(tenantId)` 按 team/user 汇总
活动预扣（held）与已结算 charged——归属行使汇总成为归属事实的 GROUP BY，而不是独立台账。
A13 邻接（公司/个人账户分离）：「never draws a personal account into a company call」
——公司预扣只解析公司映射与公司账户，个人账户余额分毫不动。
A1 邻接（跨公司资源 ID）：AC2 的伪造标识组即 A1 在余额维度的形态。

## 2. 交付物（全部新文件 + 三处预授权窄追加）

**新文件（4）**
- `server/src/db/schema/call-attributions.ts` — `billing_call_attributions`
  （与 MT070 任务迁移 SQL 一一对应）：
  - `reservation_id` 主键、FK → `credit_reservations.id` ON DELETE cascade
    （预扣在，归属在；预扣消失，归属随失——不复制预扣事实）
  - `tenant_id` FK → `enterprise_tenants`；`(tenant_id, workspace_id)` 复合 FK →
    `enterprise_workspaces`（证明 workspace 属该公司）；`(tenant_id, principal_id)`
    复合 FK → `enterprise_memberships`（证明 principal 是该公司成员）——
    伪造归属行在结构上不可能存在（MT010 分享表同款三复合外键纪律）
  - `bot_ref`（Bot/授权标识，服务层非空校验 + CHECK 非空串）、`call_key`
    （稳定调用标识）
  - `(tenant_id, call_key)` 唯一索引：一个稳定调用标识在公司内至多一条预扣归属
    ——「重复请求不重复预扣」的 DB 结构兜底（幂等键唯一索引之外的第二道闸）
  - 访问模型跟随 **MT069 D2 裁决**：billing 域事实表，owner 通道、无 RLS；
    受限 ob_ent_* 角色零授权（结构隔离，套件 has_table_privilege 反证钉死）
- `server/src/billing/company-reservation.ts` — 公司工作台预扣 seam（唯一新写入面）：
  - `reserveForCompanyCall(input)`：输入 `{tenantId, workspaceId, principalId, botRef,
    callKey, idempotencyKey, maximumCents, expiresAt}`——**没有付款账户字段**；
    运行时守卫拒绝带 `externalCustomerId`/`customer` 键的输入 → `PAYER_ACCOUNT_FIXED`
  - 预检序：非空形状 → 客户端付款账户守卫 → 映射解析（无映射
    `CUSTOMER_MAPPING_REQUIRED`，与 MT069 同码同语义）→ 活跃公司账户核验
    （缺失 `COMPANY_ACCOUNT_REQUIRED`）→ 成员资格（`CALL_MEMBER_REQUIRED`）→
    workspace 归属（`CALL_WORKSPACE_MISMATCH`）→ call_key 占用（`CALL_KEY_CONFLICT`）
  - 预扣委托既有 `creditsWriter.reserveCredits`（上界/幂等/终态语义原样）；
    `reserved:true` 后写归属行（`ON CONFLICT DO NOTHING` 幂等）：重放同键同归属
    → 同一 reservationId + 同一归属行（含崩溃窗口自愈：预扣已提交、归属行缺失时
    重放补写）；重放同键**不同归属** → `CALL_ATTRIBUTION_CONFLICT`（原预扣不动）
  - 并发同 call_key 竞态兜底：唯一索引 23505 → 对刚建的预扣 best-effort
    `releaseReservation`（全额退持，台账零动）→ `CALL_KEY_CONFLICT`
    ——输了竞态的重复调用不留幻影持有限额
  - `attributionOf(reservationId)` / `usageSummary(tenantId)`（按 team/user 的
    held=活动预扣 maximum、charged=已结算 charged 汇总）
  - 哨兵码全走计费 seam 惯例 `CODE: message`
- `server/tests/multitenancy/company-reservation.test.ts` — 票面 Verification 指定路径
- `server/tests/multitenancy/support/company-reservation.ts` — 夹具：spec §11 身份矩阵
  （公司 A 团队甲乙 = a1/a2、公司 B 团队丙 = b1）+ 两家公司计费映射/公司账户 +
  个人账户对照 + grant 种子（owner 通道；缺 env 显式 skip 不回退）

**预授权窄追加（3，diff 与哈希存档）**
- `server/scripts/multitenancy/migrate-test.ts` — 纯追加 MT070 任务（单步
  `company_call_attributions`，3 条语句）+ 注册表 1 行（brief 预授权扩展点；
  迁移链第十五任务）
- `server/tests/multitenancy/migration-tool.test.ts` — 仅穷举断言追加 "MT070"
  （ruling #5 第 13 次先例，带裁决注释）
- `server/src/db/schema/index.ts` — barrel 排序位追加 1 行
  `export * from "./call-attributions"`

## 3. 裁决（报告 D 披露的依据）

- **R1 域归属**：seam 放 billing 域（`src/billing/company-reservation.ts`）不放
  enterprise/tenancy——付款账户解析与预扣是账务事实（ADR 0004「预扣、结算、对账及
  尾差跟随同一账户」），消费的两个前置（payer-accounts、credits-writer）都在该域；
  归属行是预扣的账务事实扩展（谁的公司账户被预扣、为谁），跟随 billing 访问模型。
- **R2 归属时机**：归属行在预扣事务提交**之后**写入（writer 自管事务与 customer 锁，
  本票不可也不应重入）——存在崩溃窗口（预扣已提交、归属未写）；处置：归属写幂等
  （ON CONFLICT DO NOTHING）+ 重放自愈（同键重放发现归属缺失即补写，输入一致才成功）。
  归属行的存在性由唯一主键与重放协议保证最终一致。
- **R3 call_key 重复语义**：同公司同 call_key 再次预扣（哪怕换了幂等键）→ 拒绝
  （`CALL_KEY_CONFLICT`），不静默去重返回旧预扣——「稳定调用标识」是事实标识不是第二
  幂等键；静默返回会把"新调用偷用旧标识"放行为免费预扣。
- **R4 汇总口径**：held = 活动（reserved）预扣 maximum 之和；charged = 已结算预扣的
  charged 之和（ledger 权威口径不变，汇总只是归属维度的投影）。
- **R5 未接线面**：HTTP 路由/`src/index.ts` 装配不属本票（与 MT069/MT041 同边界：
  库层 seam；调用方接线属下游票）。settle/release 仍走既有 writer 原路径（幂等结算
  语义即票面「重试不重复结算」的既有保证，零修改）。

## 4. 测试矩阵（聚焦套件，全部真实 PostgreSQL）

1. 归属记录：成功预扣 → 归属行五元组逐字段断言 + writer 侧 `availableBalance` 反映持有限额
2. 上界：maximum > 余额 → `{reserved:false, availableCents:balance}` + 零写入
3. 并发（AC1）：A 家 a1/a2 两队 10 并发 ×250（余额 1000）与 B 家 4 并发 ×250 同时
   `Promise.all` → A 恰 4 笔成功 Σ=1000、6 笔 `{reserved:false,availableCents:0}`；
   B 全 4 笔成功 Σ=1000；每笔成功都有归属行；Σheld(A) ≤ balance(A) 且 Σheld(B) ≤ balance(B)
4. 伪造付款方：输入携带 `externalCustomerId`（B 的客户）→ `PAYER_ACCOUNT_FIXED` 零写入
5. 伪造公司（AC2）：仅属 A 的 principal 声称 tenant=B+team-b1 → `CALL_MEMBER_REQUIRED`
   零写入；随后 B 合法成员仍能足额预扣（余额未被咬掉）
6. 伪造团队：A 家双成员以 tenant=A 声称 workspace=team-b1 → `CALL_WORKSPACE_MISMATCH`
   零写入；反向（B 成员声称 A 家 a1 团队）同拒
7. 幂等重放（AC4）：同键同归属两次 → 同 reservationId、余额只咬一口、归属恰一行
8. 归属漂移拒绝：同键换 team → `CALL_ATTRIBUTION_CONFLICT`、原归属原预扣不动
9. call_key 占用：同 call_key 换幂等键 → `CALL_KEY_CONFLICT` 零新预扣
10. call_key 并发兜底：两并发同 call_key 不同键 → 恰一笔 reserved、另一笔
    `CALL_KEY_CONFLICT`、终态只有胜者的活动预扣（败者若有瞬持已全额退持）
11. 无映射公司 → `CUSTOMER_MAPPING_REQUIRED` 零写入
12. 映射在、公司账户未注册 → `COMPANY_ACCOUNT_REQUIRED` 零写入
13. 个人账户隔离（A13）：个人账户 grant 在侧，公司预扣后个人余额分毫不动
14. 汇总（A9）：两队各预扣 + 一笔结算 → byTeam/byUser 的 held/charged 与事实一致；
    B 家不出现在 A 家汇总
15. 未改回归：公司预扣经 `writer.settleReservation` 原路径结算成功（charged/applied、
    ledger 幂等键 `reservation:<id>`）——seam 未分叉扣费路径
16. 结构隔离：ob_ent_directory/data/operator + PUBLIC 对 `billing_call_attributions`
    零表级授权（has_table_privilege 全枚举反证）

变异计划（服务文件，逐个注入→聚焦套件→还原→哈希复验）：
M01 PAYER_ACCOUNT_FIXED 守卫移除、M02 映射解析移除（直接用输入客户——输入没有客户
字段，改为让守卫返回输入假想键/或跳过解析走空客户）、M03 公司账户核验移除、
M04 成员预检移除、M05 workspace 预检移除、M06 call_key 预检移除、M07 归属行写入移除、
M08 归属漂移冲突移除（重放改归属静默通过）、M09 23505 兜底 release 移除、
M10 汇总 workspace 过滤移除（跨公司泄漏）、M11 汇总 principal 过滤移除、
M12 上界结果形状破坏（reserved:false 改 reserved:true）。
