# B5-210 比例不可变版本与请求锁定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把兑换比例从可变单值改为不可变版本记录：每次管理员变更生成新版本（版本号、生效时间、精确值、操作者），提供 `rateVersionAt(requestTime)` 时间点解析与按版本号读取，使变更只影响新请求、已锁定准入按旧版本结算。

**Architecture:** 新增 append-only 表 `gateway_rate_versions`（数据库触发器拒绝 UPDATE/DELETE/TRUNCATE，沿用 audit trail 的 0000/0012 模式）。`enterprise_settings` 的 `gateway_conversion_rate` 行保留为"当前生效版本"的单独标记（01.3 契约不变）。`conversion-rate-store.ts` 的 `save()` 在同一事务内先插入不可变版本行再更新指针（沿用 advisory lock 串行化）；新增 `rateVersionAt()` 与 `readRateVersion()` 查询。环境比例是静态的 version 0，不入版本表。

**Tech Stack:** TypeScript / Bun test / Drizzle ORM / PostgreSQL 16（专用测试库 `openbot_b5_210` @ localhost:5593，容器 `b5-210-pg`）

**Spec:** docs/specs/2026-10-14-bifrost-github-spec.md（AC12）、docs/specs/2026-10-14-bifrost-integration-design.md（Q9/Q14/Q17/Q19）、docs/adr/0003-bifrost-openbot-credit-admission.md（"请求锁定兑换比例及价格依据"）

## Global Constraints

- 历史版本不可改写：数据库层强制（触发器），不只是缺少 API。
- 管理员修改只创建新版本；`save()` 返回形状与 01.3 完全兼容（`{ok:true, numerator, denominator, rateVersion}`）。
- `readConversionRate()` 外部行为不变（指针行优先、其次环境比例 version 0、否则 not_configured）。
- 环境比例 = rateVersion 0，静态，不生成版本记录。
- 结算侧版本锁定实现属 06.5，本票只交付版本记录与查询（锁定契约的读取面）。
- 金额精确性：一切值走 `parseConversionRate()`（bigint、最低项化），存储用十进制字符串，不经过 float。
- 禁止 git commit/push/stash；禁改 Write scope 之外文件（drizzle.config.ts、schema/index.ts 的接线行、01.3 测试的清理函数属本票迁移与测试范围的必要接线）。
- 不使用内存 mock 替代 SQL 事务保证；测试需 TEST_DATABASE_URL（专用库）。

## Review Focus

1. **同一毫秒内的两次保存**：两次 save 落在同一 JS 毫秒时时间点查询的边界。→ 测试用实际 `effectiveAt` ± 1ms 取锁定时刻，并用 SQL 断言 v1.effective_at < v2.effective_at（µs 精度）。
2. **指针行被删后继续保存**：指针可变、版本不可变，指针丢失时 next 版本必须取 `max(版本表)`+1 而非回到 1（PK 冲突或历史分叉）。→ 专属测试。
3. **TRUNCATE 绕过**：行级触发器挡不住 TRUNCATE（0012 的教训）。→ 触发器从一开始就同时挡 TRUNCATE，并有测试。
4. **篡改/损坏的版本行**：损坏行不得被静默解析为任何比例。→ 读取一律经过与 01.3 `parseStored` 同风格的响亮拒绝。
5. **回填的非法数据**：迁移回填只接受形状合法的指针行（数字字符串、正整数版本），非法形状跳过而不是把猜测写进历史。

---

### Task 1: 不可变版本表 + 迁移（RED→GREEN）

**Files:**
- Create: `server/src/db/schema/gateway.ts`
- Modify: `server/src/db/schema/index.ts`（接线 export）
- Modify: `server/drizzle.config.ts`（schema 列表接线）
- Create: `server/drizzle/0128_gateway_rate_versions.sql`（drizzle-kit generate + 手写回填/触发器）
- Modify: `server/drizzle/meta/_journal.json`、`server/drizzle/meta/0128_snapshot.json`（generate 产物）
- Test: `server/tests/gateway-rate-version.integration.test.ts`

**Interfaces:**
- Consumes: 01.3 `parseConversionRate()`、`enterprise_settings` 行形状 `{value:{numerator,denominator}, rateVersion}`、append-only 触发器模式（drizzle/0000+0012）。
- Produces: 表 `gateway_rate_versions(rate_version PK, numerator text, denominator text, effective_at timestamptz default now(), recorded_by text, recorded_at timestamptz default now())` + `effective_at DESC` 索引；触发器拒绝 UPDATE/DELETE/TRUNCATE；drizzle 导出 `gatewayRateVersions`。

- [ ] **Step 1: 写失败测试** — `server/tests/gateway-rate-version.integration.test.ts`：save 后数据库存在版本行（原值十进制字符串、recorded_by=操作者、effective_at≈now）；raw SQL `UPDATE gateway_rate_versions SET numerator='1'` 与 `DELETE`、`TRUNCATE` 均被拒绝（异常消息含 append-only），拒绝后原值不变。运行期望：表不存在 → FAIL。
- [ ] **Step 2: schema 文件 + generate + 手写回填/触发器 SQL**，在专用库重放 `bun scripts/migrate.ts`。回填语句仅接受 `key='gateway_conversion_rate'` 且 value 形状合法（`^\d+$` 项、正整数 rateVersion）的行，以 `updated_at`/`updated_by` 入历史；`ON CONFLICT DO NOTHING`。测试步骤 1 转 GREEN。
- [ ] **Step 3: 手工验证回填路径**（ scratch 库插入"迁移前"指针行 → 重放 0128 回填语句 → 断言版本行 → drop scratch），结果记录进报告。

### Task 2: store 的版本写入与查询（RED→GREEN）

**Files:**
- Modify: `server/src/gateway/conversion-rate-store.ts`
- Test: `server/tests/gateway-rate-version.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 表与 `gatewayRateVersions`；01.3 `createConversionRateStore({database, environmentRate?})`、`GATEWAY_SETTINGS_TOPIC`、advisory lock `hashtext('gateway_conversion_rate')`。
- Produces:
  - `type RateVersionRecord = { rateVersion: number; numerator: bigint; denominator: bigint; effectiveAt: Date; recordedBy: string }`
  - `type RateVersionResolution = { resolved:true; source:"admin" } & RateVersionRecord | { resolved:true; source:"environment"; rateVersion:0 } & ConversionRate | { resolved:false; reason:"not_configured"; explanation:string }`
  - `type LockedRateVersion = { found:true; source:"environment"; rateVersion:0 } & ConversionRate | ({ found:true; source:"admin" } & RateVersionRecord) | { found:false; reason:"not_found" | "not_configured" }`
  - `rateVersionAt(requestTime: Date): Promise<RateVersionResolution>` — `WHERE effective_at <= $t ORDER BY effective_at DESC, rate_version DESC LIMIT 1`，无行回退环境 v0 / not_configured。
  - `readRateVersion(rateVersion: number): Promise<LockedRateVersion>` — 锁定契约的按版本号读取；0=环境（需配置），缺失=found:false。
  - `save(input, by)` 行为扩展：同一事务（advisory lock → 读指针 → next = max(指针版本, max(版本表))+1 → INSERT 版本行 → upsert 指针 → pg_notify），返回形状不变；损坏版本行的读取经 `parseConversionRate` 响亮拒绝。

- [ ] **Step 1: 写失败测试**（同文件追加）：历史保留（两次 save 后 v1 原值/操作者/生效时间不变，`readConversionRate()`→v2，`rateVersionAt(v2 之后)`→v2）；时间点解析（锁定时刻恒解析 v1，即使 v2 已存在——结算用旧版本；变更后时刻解析 v2——新请求用新版本；v1 之前时刻→环境 v0 / 未配置）；并发（两个 store `Promise.all` save → 版本号相邻不重复、两行都在、SQL 断言 effective_at 随版本严格递增）；审计字段逐版本存在；`readRateVersion(99)`→found:false；指针行被删后 save 续接 max+1；环境 v0 语义（配置环境比例时 `rateVersionAt(早期)`→env v0、`readRateVersion(0)`→env 值）。运行期望：`rateVersionAt is not a function` → FAIL。
- [ ] **Step 2: 实现 store 扩展**，步骤 1 全 GREEN；`bun test server/tests/gateway-conversion-rate.test.ts` 保持 22 pass（01.3 契约不回归）。
- [ ] **Step 3: 扩展 01.3 测试清理函数**（`cleanupStoredRate` 增加 `TRUNCATE gateway_rate_versions`，附注释引用 0012 的 TRUNCATE 语义），重复跑两遍 01.3 + 本票测试确认幂等。

### Task 3: 全量验证与报告

- [ ] **Step 1:** `cd server && bun run typecheck` 通过。
- [ ] **Step 2:** `TEST_DATABASE_URL=… bun test server/tests/gateway-rate-version.integration.test.ts server/tests/gateway-conversion-rate.test.ts` 全绿（专用库，无 skip）。
- [ ] **Step 3:** `bunx biome lint --error-on-warnings` 于全部变更文件通过。
- [ ] **Step 4:** 写 `.omc/reports/b5-210.md`：变更文件清单、逐条 AC 证据（命令+输出摘要）、迁移/回退说明、检查点（未提交 diff 摘要 + 文件哈希）、遗留风险。
