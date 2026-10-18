# MT021 独立复审报告（Issue #64 — 频道与会话列表、计数、分页游标的作用域）

复审者：独立 Pi 会话（coordinator 下发 brief：`briefs/MT021-review-brief.md`；未参与实现）。
复审树：`i12-review-mt021`（BASE `f0520524` + 213 项前置 + 本票交付）。授权边界：只读被审文件；唯一新建 = 本报告；未修复、未提交/推送/合并。

## 结论

**PASS with findings** — 门槛全部亲测通过：聚焦 **26 pass / 0 fail / 0 skip（128 expect）**、全量 **796 pass / 0 fail（30 文件）**＝基线 770 + 26、typecheck exit 0、触及 3 新文件 biome 0、十四任务迁移链全 applied（journal 14 行）、10 冻结文件 before==after 复核实测一致、3 新文件哈希==manifest、变异重放 3/3 捕获（MUT3/MUT4/MUT5，还原哈希复验==交付值后复绿）。

发现 3 项：**1 项 high（游标键微秒精度丢失——生产时间戳数据下翻页死循环/重复，测试种子全为整分钟故未暴露）+ 2 项 low**。high 项因服务未接路由（D5d）暂无用户可见影响，但属对票面验收 4 语义的真实偏离，建议 coordinator 在路由接线票之前裁定修复轮。

## 1. 复审环境（全部亲测，不采信存档）

1. `bun install --frozen-lockfile`（bun 1.4.2，本树无 node_modules）→ 1415 packages installed。
2. 端口预检：55534 空闲（lsof 无监听，无 +1）→ 容器 **`mt021-review-pg`**（pgvector/pgvector:pg16，仅绑 127.0.0.1，一次性随机口令）。
3. 三库：`openbot_enterprise_mt021_rev_test` + `openbot_enterprise_mt021_rev_assigned`（MT003 真实 apply）+ `openbot_kb_mt021_rev`（第 7 变量）。
4. 七变量 env 单文件 **0600**：`TEST_DATABASE_URL`、`MT003_ASSIGNED_TEST_DATABASE_URL`、`ENTERPRISE_TEST_SETUP_DATABASE_URL`（postgres 超户）、`ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL`（`ent_review_{dir,data,opr}`，经 enterprise-test-db 守卫 provision 成 `ob_ent_*` 能力角色会话，登录角色均非 super/bypassrls）、`KB_TEST_DATABASE_URL`。
5. `bun --no-env-file scripts/enterprise-test-db.ts migrate` → `{"type":"migrations-applied","status":"ok"}`。
6. 十四任务链逐任务 generate --out + `migrate --apply --manifest`：MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027 **全部 applied**；journal 实查 14 行，步数精确（MT112=4、MT069/MT076=1、其余各 2）。本票无迁移任务（与 D1 一致）。

## 2. 测试门槛（本复审独立环境实测）

| 门槛 | 复审实测 | 与实现者声明 |
|---|---|---|
| 聚焦 | `bun --no-env-file test tests/multitenancy/conversations-list.test.ts --timeout 60000` → **26 pass / 0 fail / 128 expect，无 skip** | 一致（26/0/0、128 expect） |
| 全量 | `bun --no-env-file test tests/multitenancy/ --timeout 60000` → **796 pass / 0 fail（30 文件，10786 expect）** | 一致（796/0/30）＝基线 770+26 |
| 基线 770/0/29 | 交付已在树中，不可独立复跑；由 796=770+26 与 focused 26 精确闭合佐证 | 口径一致 |
| typecheck | `bun run typecheck`（tsc --noEmit）→ **exit 0** | 一致 |
| biome | 触及 3 新文件 `bunx biome check` → **0 错误**；`src/index.ts` 存量 4×noConsole（L837/862/882/1871）+1×noNonNullAssertion（L4736）＝brief 声明的 BASE 欠账，无新增 | 一致 |

## 3. 本票专项审计重点逐项裁决

### 焦点 1：keyset 游标不变键——**成立，但发现 high 缺陷（见 §6-F1）**

- 代码事实：游标键 = `(created_at, id)`，`updated_at` 确实不入键；页游标钉在 `rows[limit-1]`（最后一个可见项）。中途改名用例（`renameConversationAsData` 不动 updated_at）与翻页中删行用例在真实库上复跑通过。
- **用例真实性缺口（brief 点名审查项）**：全部种子经 `at(minute)` 生成整分钟时间戳，经 `toISOString()` 无损往返；而生产写路径 `conversations/service.ts` insert 不带 `created_at` → 列默认 `now()`（活库实测 `now()::text` 返回微秒，如 `…23:24:16.359673+00`）。复审四步实证（§6-F1）：**生产形态的微秒时间戳会让该游标失效**。测试的「页并集==全量可见集」在种子域内成立，但未覆盖生产数据形态——正是本焦点要求审查的「真实性」。

### 焦点 2：隐藏条目不消耗页位——**成立**

- 归属谓词（tenant RLS + workspace + principal）在 SQL WHERE 内先于 LIMIT 生效，隐藏行物理上不进入候选流，`LIMIT limit+1` 只消费可见行。
- 键最大他人行 c9（minute 50）不制造末页游标：验收 1 翻页用例断言 `pages.at(-1) === null`，复审复跑通过；`rows.length > limit` 判定使第 limit+1 可见行只签发游标不入页。MUT3 变异重放（游标钉 `rows[limit]`）实测 **4 fail / 22 pass**——验收 1 页并集 + 验收 4 全链 ×3 全部捕获，与实现者存档逐例一致。

### 焦点 3：canonical 同形——**成立**

- `readVisibleConversation` 全部拒绝路径收敛到唯一出口 `notFoundVerdict()`（not-found-semantics 冻结实例 `{outcome:"deny",code:"RESOURCE_NOT_FOUND"}`，结构守卫钉死恰好 2 键）。
- 测试侧：不存在/跨公司/跨团队/他人会话四类拒绝 + canonical 基准构成**单元素字节集**（`JSON.stringify` 相等断言）；第五类（撤权）在验收 3 的撤权后与恢复后详情两例以 `isCanonicalNotFound`（逐字节同形判定）分别钉死。五类拒绝全部收敛且被断言覆盖。MUT5 重放（拒绝码漂移 RESOURCE_NOT_FOUND→RESOURCE_MISSING，从撤权路径注入）实测 **2 fail / 24 pass**——字节同形断言真实捕获。

### 焦点 4：MUT4 epoch 独立捕获——**成立**

- 「暂停→恢复（真实 MT007 restore：status 回 active 且 epoch+1）后旧 scope 仍被拒」用例在 GREEN 阶段预置（D4），恢复态下 status 检查放行、仅 epoch 比对能拒——防线独立。
- 重放实测：移除 `company.epoch === scope.memberEpoch` 后聚焦套件 **恰好 1 fail / 25 pass**，失败用例即该恢复态用例；无其他用例代偿。与实现者存档一致，独立可捕获性成立。

## 4. 活库抽查（psql 直查，与交付声明一致）

- `enterprise_conversations`：列结构与默认值（created_at/updated_at `defaultNow()`）、3 CHECK（backend 枚举/backend_version>0/last_seq>=0）、3 复合 FK cascade、owner_idx (tenant,workspace,principal)、tenant_thread 唯一索引——与 schema 文件一致。
- **RLS forced**（relrowsecurity=t, relforcerowsecurity=t）；策略 `enterprise_conversations_data_scope` TO `ob_ent_data`，USING/WITH CHECK 均为 `tenant_id = NULLIF(current_setting('app.tenant_id',true),'')`——单租户臂 + 应用层团队/本人谓词的结构与模块头描述一致。
- 列级授权：`ob_ent_data` INSERT/SELECT 全列，UPDATE 仅 (last_seq, title, updated_at)，**无 DELETE**——与 D2 披露一致（硬删须经 setup 通道）。
- 能力角色 NOLOGIN、登录角色无特权的矩阵成立（pg_roles 实查）。

## 5. 边界核对（逐项实测）

- 3 交付文件 sha256 逐项 == sha256-manifest：`38fb0267…`/`5a89bbb2…`/`a028f792…`（复审终态复验一致）。
- 10 冻结文件（not-found-semantics、enterprise-conversations schema、store、connections、scope-gate、contracts、scenarios、migrate-test、migration-tool.test、schema barrel）sha256 逐项 == before-hashes == after-hashes ——**before==after 复核实测成立**。
- `conversations-list` 不在 213 项 prereq-manifest 中（50 条 tests/multitenancy 前置均他票）→ 3 文件确为本票新建；worktree-state before→after 唯一新增行即本票模块文件（测试文件位于整目录未跟踪项 `?? server/tests/multitenancy/` 内，由 prereq-manifest 反证归属）。
- 授权编辑点之外零改动：本票无 schema barrel/migrate-test/migration-tool 改动，与「无迁移」声明自洽。

## 6. 发现（按严重级）

### F1（high）游标键微秒精度丢失：生产时间戳形态下翻页死循环/重复可见项

- **机理**：列 `created_at timestamptz` 无精度声明（PG 默认微秒）+ 默认 `now()`（微秒）；游标经 JS Date 往返——`row.createdAt.toISOString()` 只保留毫秒。下一页谓词 `(created_at, id) > (at::timestamptz, id)` 在微秒 > 被截断毫秒时把**边界行自身重新纳入**。
- **四步实证（本复审专用容器）**：① bun-sql 驱动把 `'…00:00:00.123456+00'` 读成 Date，`toISOString()` 输出 `…123Z`（微秒丢失）；② `now()::text` 实测微秒形态；③ PG 行比较 `('00:01:00.123456','x') > ('00:01:00.123','x')` = true（边界行重纳入）；④ 端到端——经真实 fixture + 真实服务，把一行种子 UPDATE 为微秒 `created_at` 后 limit=1 翻页：**页链 6 步全部重复同一行（unique=1/6，guard 耗尽），第 2、3 行永不可达**。
- **影响**：凡 `created_at` 带亚毫秒的生产行（生产写路径默认全带），该服务的分页不收敛且重复可见项——直接抵触票面验收 4「游标不因隐藏条目而跳过或重复可见条目」。测试未暴露的根因是种子全为整分钟时间戳（焦点 1 的用例真实性缺口）。
- **先例偏差**：MT016 `bots-ownership.ts` 以 `created_at::text`（SQL 文本保微秒）作游标键源；MT021 改用 JS Date 序列化，偏离了既有的精度安全模式。
- **缓解事实**：服务未接路由（D5d），本树无用户可见影响；写路径 `enterprise_conversations` 的行由 conversations 服务 `defaultNow()` 落库，缺陷处于「已交付构件、待接线引爆」状态。
- **建议（交 coordinator 裁定）**：修复轮把游标键源改为 SQL 侧 `created_at::text`（对齐 MT016），并补一条微秒时间戳种子用例（fixture 种子通道显式 `::timestamptz` 字面量即可注入）；修复前不得在路由接线票中启用该分页面。
- 探针脚本仅存于 /tmp 并已随环境销毁；被审文件零改动（终态哈希复验 `38fb0267…` 一致）。

### F2（low）结构合法但 `at` 非时间戳的游标逃出既定拒绝码

`decodeCursor` 只校验 JSON 形状（v/at/id 非空字符串），`{"v":1,"at":"garbage","id":"x"}` 通过校验后在 SQL `::timestamptz` 抛裸驱动错误（实测报错体为 "Failed query: …"，非 `CONVERSATIONS_CURSOR_INVALID`）。无效游标的「响亮且受控拒绝」契约对该输入类不成立。未接路由故无暴露面；建议修复轮在 decode 时校验 `at` 可解析（或把 PG 22007 归一为既定拒绝码）。测试的无效游标用例（非 base64url/坏 JSON/缺字段）未覆盖此类。

### F3（low）变异证据链的 pristine 哈希与交付终态不一致（证据卫生）

`mutation/pristine-sha256.txt` 记录 `5b6ed95f…`，交付终态为 `38fb0267…`——pristine 快照早于 biome `--write` 重排版，故「还原后与 pristine 一致」钉住的是 pre-biome 变体而非交付字节，检查点中无「还原后 == 交付哈希」的存档环节。行为无差（纯格式）；本复审以自身重放闭合该缺口：每次注入→聚焦→**还原至交付字节→sha256==`38fb0267…` 复验→聚焦复绿 26/0/0**。建议后续票把 pristine 快照取在 biome 收尾之后。

## 7. 清理核验（真实执行并回显）

- `docker rm -f mt021-review-pg` → 回显容器名；`docker ps -a` 复查无 mt021-review 容器（deletion check exit 1 = 已不存在）。
- env 文件（0600）、口令文件、3 个探针脚本、迁移临时目录、备份文件全部删除，`ls` 逐项确认不存在。
- 被审树零残留：交付文件终态哈希 `38fb0267e9cc3cd812e83cf12fe4cd397756108f8503287dab76ec363ebae496` 复验一致；仓库内唯一新建 = 本报告。

## 8. 裁决汇总

| 项 | 裁决 |
|---|---|
| 票面验收 1（列表/计数/游标只反映可见集合） | 成立（真实 PostgreSQL + 受限角色 + 真实 RLS 复跑；同团队他人/他团队/他公司/键最大隐藏行逐 id 精确排除） |
| 票面验收 2（他司会话 ID 详情不可见语义） | 成立（canonical 逐字节同形 + 五类拒绝收敛单出口；字节集断言真实） |
| 票面验收 3（切团队立即变化） | 成立（双团队身份 A1→A2→A1、真实撤权、暂停→恢复 epoch 防线全复现） |
| 票面验收 4（游标不跳不重） | **种子域内成立；生产微秒时间戳形态下不成立（F1，high）** |
| 门槛（聚焦/全量/typecheck/biome/迁移链/边界/清理） | 全部亲测通过；实现者报告数字逐项与实测一致，无虚报 |
| 变异 | 实现者 6/6 存档逻辑自洽；复审独立重放 3/3 捕获（MUT3=4 fail、MUT4=1 fail、MUT5=2 fail），还原哈希复验一致 |

**总体：PASS with findings（1 high + 2 low；high 项建议在路由接线前安排修复轮，修复方案见 F1）**。
