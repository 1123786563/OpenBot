# MT070 复审报告 — 公司调用归属与同一余额原子预扣（Issue #113）

角色：独立 Pi 复审者（全新会话，未参与实现）。复审树 i12-review-mt070，HEAD=BASE
`f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（亲验 `git rev-parse`）。工作树为未提交交付
（213 项前置 + 本票），与实现报告披露一致。

## 结论：PASS with findings

票面四条验收全部在真实 PostgreSQL 上亲测复现；门槛 9 项全部亲测达标；交付边界哈希
逐项吻合。findings 共 3 项（1 medium / 2 low），无一动摇交付正确性；medium 项为存档
证据缺陷（claim 本身已被本复审独立复现证实）。

---

## 1. 复审门槛复验（全部亲测，不采信存档）

| # | 门槛 | 本复审实测 | 证据 |
|---|---|---|---|
| 1 | `bun install --frozen-lockfile` | 1415 包安装成功，无版本漂移（与 D8 披露一致） | 本地执行 |
| 2 | 端口预检 + 专用容器 + 三库 + 七变量 env 0600 | 55533 空闲（按指定端口使用，无需 +1）；`pgvector/pgvector:pg16` 容器 `mt070-review-pg`，`-p 127.0.0.1:55533:5432`（`docker port` 回显仅回环）+ 随机口令；三库 `openbot_enterprise_mt070r_test` / `_mt070r_assigned`（MT003 用例）/ `openbot_kb_mt070r_test`（KB 属主 `ent_mt070r_kb`）；env 七变量（TEST_DATABASE_URL、MT003_ASSIGNED、ENTERPRISE_TEST_SETUP=postgres 超户、DIRECTORY/DATA/OPERATOR=ent_mt070r_* 受限角色 + options role=ob_ent_*、KB_TEST_DATABASE_URL）写入 `/tmp/mt070-review-env.sh`，权限 0600 实测 `ls -la` | 本地执行 |
| 3 | base migrate → 十六任务链逐任务 generate+apply | `enterprise-test-db.ts migrate` = `migrations-applied ok`；MT000→MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027→**MT070** 全部 generate+apply ok；活库 journal 亲查 **16 任务 / 32 步全落账**；MT070 生成 SQL 与 checkpoints 存档 **diff = IDENTICAL** | 本地执行 + psql 亲查 |
| 4 | 聚焦全绿 0 skip；全量 786/0/30 | 聚焦 **16 pass / 0 fail / 0 skip**（97 expect）；全量 `bun --no-env-file test tests/multitenancy/ --timeout 60000` = **786 pass / 0 fail / 30 文件 / 0 skip**（= 770+16、29+1，与票门槛一致）。变异轮后聚焦复跑再证 16/0 | 本地执行（两次） |
| 5 | typecheck 0；biome 触及 7 文件 0 新增 | `bunx tsc --noEmit` exit 0；`bunx biome check` 7 个触及文件 **0 error 0 warning**；`src/index.ts` 存量欠账实测 **4×noConsole + 1×noNonNullAssertion**（与披露的 BASE 欠账逐项一致，非本票新增） | 本地执行 |
| 6 | 活库抽查（psql 直查） | `billing_call_attributions`：relrowsecurity=**f**、pg_policy=**0 行**（与 D2「billing 域、owner 通道、无 RLS」披露一致）；grants 矩阵亲查**仅 postgres 属主 7 项**，ob_ent_*/PUBLIC 零授权；CHECK `billing_call_attribution_refs_present` 在位；**4 条外键**逐条与声明一致（含两条复合 FK → enterprise_workspaces/enterprise_memberships，两表 relrowsecurity=t，RI 经属主特权内部触发器不受 RLS 影响——D2 声明成立）；唯一索引 `(tenant_id, call_key)` + tenant_idx 在位 | psql 亲查 |
| 7 | 变异重放 ≥3 | **重放 4 个**：M01（守卫移除）15/1 KILLED、M10（汇总租户过滤移除）14/2 KILLED、M12（上界拒绝形状破坏）14/2 KILLED、**M06b（预检+兜底复合移除）14/2 KILLED**。全部：注入后文件确有变化（非 no-op）→ 聚焦 → 记数 → 恢复 → **恢复哈希 == 冻结值 ea3fc1e9…逐位一致** → 聚焦复绿 16/0。M01/M10/M12 注入哈希与实现者 results.txt **逐字节相同**（207467c2…、5153296f…、afe8a3eb…） | 本地执行 |
| 8 | 交付哈希 == after-hashes；授权点之外零改动 | 4 新文件 + 3 窄编辑文件共 7 个 SHA-256 **逐项 == after-hashes.txt**；3 个窄编辑文件 hash 对（before→after）与 sha256-manifest CHANGED 段一致；8 个 UNCHANGED 关键前置文件（credits-writer/capacity/payer-accounts×2/credit-reservations/credits/billing/enterprise-tenancy）**逐位 == manifest**；窄编辑提取块在现文件实测在位（migrate-test.ts:1392/1440、migration-tool.test.ts:400、schema/index.ts barrel:6）；MT070 生成迁移与窄编辑内嵌 SQL 逐条一致 | shasum 亲算 |
| 9 | 清理真实执行 + deletion check=0 + 临时文件删除 | `docker rm -f mt070-review-pg` **真实执行**，回显 `mt070-review-pg`；随后 `docker ps -a | grep -c mt070-review` = **0**；`/tmp/mt070-review-env.sh`、`/tmp/mt070-review-pgpw.txt`、`/tmp/mt070r-pristine-service.ts`、`/tmp/mt070-review-out/` 全部删除，ls 复验 **No such file or directory**（exit 1） | 本地执行（输出在上文会话存档） |

---

## 2. 本票专项审计重点（6 项逐项）

### 2.1 D3 归属时机与崩溃窗口 — **披露如实，窗口真实存在，兜底有界**（finding F2）

代码亲读：`writer.reserveCredits`（自管事务 + customer 行锁）提交后，归属行才 INSERT。
崩溃窗口（预扣已提交、归属未写）结构上存在。披露的处置亲验成立：

- 归属写幂等（`ON CONFLICT DO NOTHING` target reservation_id PK）；
- 同幂等键重放自愈：重放路径预检放行 → writer 幂等返回原 reservationId → 归属 INSERT
  补写 → 逐字段比对后成功（测试 "replays the same idempotency key…" 侧证补写路径可达）；
- **对账面现状**：无主动 reconciliation job/sweep；未被重试的孤儿预扣仅能靠
  `credit_reservations`（有行无归属）人工比对发现。影响有界：容量口径排除过期预扣
  （capacity.ts "reserved, unexpired" 亲读），孤儿持有限额随 expiresAt 自然让出；
  台账/预扣行仍是可查事实。seam 未接线（D6），无生产调用方，窗口暂不可达。
  **建议**：下游接线票补「无归属预扣」对账视图/清扫，或评估归属随 writer 事务同写
  （实现报告已如实升级，本复审维持该升级建议）。

### 2.2 AC1 并发用例真实性 — **真重叠，计数精确**

- 夹具连接池 `max: 18` ≥ 14 并发，14 个 attempt 同 tick 经 `Promise.all` 全部起飞，
  各持独立池连接——不存在池串行伪装；
- 串行化点 = writer 事务内 `SELECT … FOR UPDATE`（credits-writer.ts:534 `for("update")`
  亲读）——这正是被测的原子性机制本身；
- 计数断言精确：恰 4 成功 Σheld=1000=余额、6 拒且逐一断言 `availableCents:0`（FOR
  UPDATE 序列化下前 4 笔咬满后后继必见 0——该断言本身就是「真并发」的指纹）、D 家同瞬
  4/4 成功（异锁不受 C 饱和殃及）、逐笔归属核对、汇总口径 Σheld 双家各 1000。若原子性
  破裂（读-改-写竞态）必现 5+ 成功/Σ=1250，精确计数即红。

### 2.3 D2 域归属（billing 域、owner 通道、无 RLS）— **零表级授权断言复核通过**

套件内 5 角色（4×ob_ent_* + public）× 4 特权 = 20 项 `has_table_privilege` 反证全绿
（聚焦亲跑）；活库 `information_schema.role_table_grants` 亲查仅属主 postgres——
与 MT069 先例一致，结构隔离（零授权）强于 RLS 臂的论证成立（复合 FK 引用 RLS 表的
RI 检查经内部属主特权路径，2.3 的 psql 证据 + 全量 786/0 佐证）。

### 2.4 M06 单层等价与 M06b 复合证据 — **claim 成立，存档证据缺陷**（finding F1）

- 单层等价论证亲验成立：M06 仅移除服务预检时，`(tenant_id, call_key)` 唯一索引兜底
  独立产出同一哨兵 `CALL_KEY_CONFLICT`、败者退持、净零幻影——16 用例全绿
  （SURVIVED=等价变异），与 MT041 D7「两层防护本就是设计」先例一致；
- **但存档 `mutation/MUT6b-compound-retest.txt` 有缺陷**：文件头声明 "The compound
  removal is caught"，正文唯一落档的计数却是 `0 fail / 97 expect() / Ran 16 tests`
  ——与 pristine 绿跑指纹相同，**没有落档任何被杀轮次的 pass/fail 计数**；
- 本复审独立重放 M06b（预检 `existingCall && false` + 兜底 `isUniqueViolation && false`
  双移除）：**14 pass / 2 fail KILLED**，恰好是两个 call_key 用例红（哨兵码与余额断言
  双杀），恢复哈希逐位一致。**结论：M06b 被杀的 claim 为真，但原存档不能作为该 claim
  的证据**——按本工作流「evidence over claims」标准记 medium。

### 2.5 幂等 / call_key 冲突矩阵 — **逐路径核对全部通过**

| 输入组合 | 代码路径（亲读） | 钉死用例（亲跑） |
|---|---|---|
| 同幂等键 + 同归属（重放） | 预检放行（同键）→ writer 幂等返回原 reservationId → 归属 DO NOTHING → 比对一致 → 同果；余额只咬一口 | "replays the same idempotency key…"（second.reservationId==first、balance=before−250） |
| 同幂等键 + 换归属（漂移） | 预检放行（同键）→ writer 原单返回 → 归属 DO NOTHING → 五字段比对不一致 → `CALL_ATTRIBUTION_CONFLICT`，原预扣原归属不动 | "refuses an idempotency-key replay that changes the attribution"（balance=before−100、原 workspace 不变） |
| 同 call_key + 换幂等键（顺序） | call_key 预检拒 → `CALL_KEY_CONFLICT`，干净哨兵零写入 | "refuses a second reservation for an already-used stable call key"（balance=before−100） |
| 同 call_key + 换幂等键（并发） | 预检竞态 → 唯一索引 23505 兜底 → 败者 `releaseReservation` 全额退持 + 同哨兵 | "the call-key unique index backstops…"（恰 1 成 1 拒、balance=before−100、胜者归属在） |
| （旁支）同 call_key + 同幂等键 + 换归属 | 同键放行 → 归属比对杀 → `CALL_ATTRIBUTION_CONFLICT`（矩阵一致，无孤立用例，可接受） | — |
| （旁支）同幂等键换金额/客户 | writer 原语义 `CreditReservationConflictError`（credits-writer 零改动，哈希位同） | AC4 语义不变由 manifest + 全量回归覆盖 |

### 2.6 D1 基线竞态（acceptance-harness 45435）— **本复审未复现**

实现者披露其第二轮基线撞固定端口 bind 瞬态 1 fail（单文件复跑 17/0、全量复跑 770/0）。
本复审全量单跑即 **786/0/30**，未撞该签名；按 brief 先例仅作披露，不影响判定。

---

## 3. Findings

| 级别 | 编号 | 内容 | 影响/建议 |
|---|---|---|---|
| **medium** | F1 | `checkpoints/MT070/mutation/MUT6b-compound-retest.txt` 存档缺陷：正文唯一计数 `0 fail / 97 expect` 与 pristine 绿跑指纹相同，未落档被杀轮次计数，与其头部 "caught" 声明矛盾 | M06b KILLED 的 **claim 已由本复审独立重放证实**（14/2，恢复哈希位同），故不降 PASS；但该存档文件不可作为证据。建议 coordinator 裁定：要求实现轮补落正确 M06b 存档（注入哈希 + 被杀计数），或在验收记录中标注该文件作废、以本复审重放为准 |
| **low** | F2 | D3 崩溃窗口披露如实但兜底依赖「同键重试」：从未被重试的孤儿预扣无主动对账面（仅 credit_reservations 有行无归属可人工比对）；影响有界（过期即让出容量、台账事实可查） | 维持实现报告自身的升级：下游接线票补孤儿预扣对账视图/清扫，或评估归属与预扣同事务（需改 writer 事务边界，本票无授权，维持不动） |
| **low** | F3 | 存档脚本漂移：`provision-db.sh` 头注释仍为 MT041-fix/13-task/55521 旧文案（正文实为 16 任务/55528）；其 `env` 输出的 assigned 库名 `…_mt003_assigned` 与 `test-env.sh` 的 `…_mt070_assigned` 不一致 | 纯存档卫生问题；本复审独立建库建 env，未采信两脚本，全部门槛达标不受影响。建议后续票统一模板 |

无 critical / high finding。未发现越权改动、未发现 skip 伪装、未发现删除不实。

## 4. 边界与只读声明

- 本复审**只读被审文件**；唯一新建 = 本报告；未修复任何发现（交 coordinator 裁定）。
- 变异注入全部即时恢复，7 个交付文件终态哈希复验 == 冻结值（M01/M10/M12/M06b 恢复后
  逐一 `shasum` 亲算，均 `ea3fc1e9…`）。
- 容器/库/env/临时文件已全部删除并回显复验（见 §1 门槛 9）。
- 复审过程心跳 3 次；未发 Slack/GitHub 等外部通道。
