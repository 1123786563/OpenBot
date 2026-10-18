# MT016 独立复审报告（Issue #59 — Bot 与配置的创建、列表、详情按公司团队归属）

复审者：独立 Pi 会话（coordinator 下发 brief：`briefs/MT016-review-brief.md`）。
复审树：`i10-review-mt016`（coordinator 装配 = EXE 107 项前置 + 本票 7 交付）。BASE `f0520524`（与 `checkpoints/prereq-manifest.txt` 首行一致）。
授权边界：只读被审文件；唯一新建 = 本报告；未修复、未提交/推送/合并。

## 结论

**通过（pass with findings）** — 票面四条 + Issue #59 五条验收全部在本复审独立搭建的专用
PostgreSQL（pgvector/pgvector:pg16，仅回环，随机口令，用后销毁）上复现：聚焦 **44/0/0**
（143 expect）、全量 **682/0/0**（= 638 基线 + 44，0 skip，assigned 库真实 apply 集成实跑）、
typecheck exit 0、十二任务迁移链全 applied 并落账。接管审计与树内事实一致、第 1 任证据完整
保留；变异 6/6 含 MUT5 首轮存活→补测 MUT5b 的诚实记录成立；三方合并未改变 MT016 增量语义。
发现 4 项非阻塞问题（见 §7），均为合并格式漂移 / 证据卫生 / 口径计数级，不影响行为、隔离与验收。

## 1. A — 票面四条 + Issue #59 五条验收逐条裁决（全部成立）

Issue #59 经 `gh issue view 59` 实取核对：标题、五条验收、Verification
（`bun test server/tests/multitenancy/bots-ownership.test.ts`）、覆盖 A1/A2/A3 与
`docs/specs/2026-10-14-company-team-multitenancy-design.md` A1/A2/A3 行（L210–212）一致。
逐条 → 测试证据（本复审复跑全绿）：

| # | 验收 | 独立证据 | 裁决 |
|---|---|---|---|
| ① | 创建记录归属 + 列表仅范围内可见（brief1/issue1） | 验收 1 共 9 例：create 落 (公司+团队+owner+默认配置同行)；受限 data 角色真实读到行；owner 与同团队成员列表含、同公司他团队与另一家公司列表不含；归属键客户端声明 6 键形 + 「正确值也拒」；同 id 重复与跨公司占用同一 `BOT_ID_UNAVAILABLE`（23505 cause 链映射，跨公司拒绝文本不含对方公司 id） | ✅ |
| ② | 跨公司/非团队不可见语义，两错误消息相等断言（brief2/issue2） | 验收 2 共 6 例：不存在 id 与跨公司 id 的拒绝 `JSON.stringify` 逐字节相同且等于 MT011 canonical；跨团队、软删后同团队、跨公司 update/delete/偏好读写全部 canonical not-found（非 forbidden）；**同公司双团队成员 scope 钉死**（a1 Bot 对 a2 scope not-found、列表不含，切回 a1 scope 可见） | ✅ |
| ③ | 搜索/计数零泄露：a2 计数 0、keyset 翻页并集=全集且收敛（issue3） | 验收 3 共 4 例：a2 与另一家公司计数 0/列表空/游标 null；成员侧 limit=2 全流翻页，页并集 `Set` 相等、无重复、长度相等、末页 nextCursor null（对前序用例累积的全量可见集收敛，非仅本 describe——D3 修正后口径）；游标/limit 非法输入响亮拒绝 | ✅ |
| ④ | 偏好与默认配置同归属（brief4） + 双公司同名互不干扰（issue4） | brief-4 共 6 例：偏好逐主体、not-found 与 allow+null 两态严格分开、文档校验、清除幂等、RLS 主体自读探针；default_config 在归属行内（复合 FK 结构钉死）；验收 4 共 4 例：同名 Bot 各自归属、更新 A 配置逐字节不影响 B、revision 独立、偏好互不串扰 | ✅ |
| ⑤ | 编辑限归属授权成员 + 越权拒（brief3） + 删除/清理公司作用域（issue5） | brief-3 共 6 例：同团队非 owner 能读不能改/删（`BOT_EDIT_FORBIDDEN` 精确形状）；公司管理员非团队上下文连 scope 都无法铸造（`WORKSPACE_FORBIDDEN`）；真实撤权（suspendMembership 后 create `WORKSPACE_MEMBERSHIP_REQUIRED`、读取/列表 fail-closed）；epoch 策略（暂停→恢复 epoch+1 后旧 scope 仍被拒，新 scope 正常）。验收 5 共 5 例：枚举按公司返回事实全集；硬删除 (tenant, owner, ids) 三重钉死（混入他司 id 与同公司他人 id 精确只命中目标）；级联清偏好；幂等重放删 0 行；仅凭用户 id 错公司删不掉 | ✅ |

存储与迁移契约 4 例（未验证通道装配拒绝 / RLS fail-closed 0 行 / 全部受限查询 `current_user`
以 `ob_ent_*` 执行 / 迁移计划确定性 2 步固定名 digest 稳定）随复跑全绿。44 例计数独立复核：
9+6+4+4+5+6+6+4 = 44 ✓。

## 2. B — 接管处置审计（与树内事实一致，成立）

- `takeover-audit-2nd.md` 的保留/修复/新增三分逐项对照树内事实：
  - **保留**：schema（与迁移 SQL 逐条对应——本复审活库 `\d` 实证两表结构/索引/CHECK/RLS
    与 `migrate-test.ts` 语句一致）、migrate-test 注册（授权点 #1）、barrel 1 行（授权点 #3）、
    测试主体、第 1 任证据。
  - **修复**：①模块公司级成员重验缺口——现码 `readVisibleOwnership` join
    `enterprise_memberships` 要求 `active + epoch === scope.memberEpoch`，`readMembershipFacts`
    供 create/list/count 同升（现码证实）；②夹具 `suspendTeamMember` 坏实现已替换为
    `suspendCompanyMembership`（经真实 `provision.suspendMembership`，现码证实，无未用
    import）；③migration-tool.test.ts 穷举断言已含 `"MT016"` + 裁决注释（现码证实）；
    ④`assertScopeContext` 已在 `assertTrustedScope` 之前（现码证实）。
  - **新增**：a1a2 双团队成员身份 + scope 钉死测试、epoch 策略测试、
    `reinstateCompanyMembership`（真实 MT007 面）均现码可见。
- 第 1 任证据完整保留：`before-hashes.txt`（HEAD + 3 既有文件 09bf0400/2a1ce227/e1954c8a）、
  `red-green/RED-1-module-missing.txt`（Cannot find module）、`verification/00-apply-prereq-tasks.txt`、
  `verification/01-baseline.txt`（577/22，与 brief 口径一致）全部在树，未被删除/篡改。
- 版本链旁证：MT016 before 值 09bf0400 与 `MT076/before-hashes.txt` 的 pre-MT076 态相同，
  `MT076/after` = 773dc1be、`MT069/after` = aa1ce426，链路自洽。

## 3. C — 变异 6/6 含 MUT5 诚实记录（成立）

`mutation-2nd/results.txt` 与逐变异存档核对：

| 变异 | 存档结果 | 捕获测试 |
|---|---|---|
| MUT1 公司级门移除 | 42 pass / 1 fail ✓ | 撤权 fail-closed 用例 |
| MUT2 epoch 比对移除 | 42 / 1 ✓ | epoch 策略（暂停→恢复后旧 scope 仍拒） |
| MUT3 owner 门移除 | 41 / 2 ✓ | brief-3 越权编辑 + owner revision |
| MUT4 清理 owner 钉死移除 | 42 / 1 ✓ | 公司作用域清理（同公司他人 Bot 被误删） |
| MUT5 团队匹配移除 | **首轮 43/0 存活**（存档 FIRST-SURVIVED）→ 补 a1a2 测试后 MUT5b 43/1 ✓ | 同公司双团队成员 scope 钉死用例（MT010 MUT4b 先例同构） |
| MUT6 23505 映射移除 | 43 / 1 ✓ | 同 id 重复创建（裸约束错误外泄） |

存活原因定性（团队匹配移除后用例仍过 = 该防线原无同公司双团队成员身份可捕获）与补测正当性
（MUT5b 捕获 + 该测试同时绿证正向语义）成立；每次还原后 pristine 复验：
`mutation-2nd/pristine-sha256.txt` 两行均 = `3bb3288b…` = **本树现文件哈希**（变异未残留），
且 GREEN-3（还原后聚焦复绿 44/0/0）在档、本复审复跑同值。

## 4. D — 三方合并语义等价（成立；一处纯格式漂移见 §7-F1）

- **4 新文件整复制**：本树 sha256 = `d5215a2b`/`3bb3288b`/`564d4d9a`/`ecf044e9` 与披露及
  sha256-manifest after 值逐一相同 ✓。
- **3 共享文件为合并态**（57283cfc/950a6a71/18257d47 ≠ 实现树 after d6ab2222/20618042/
  e9bd49d2，与披露一致）。实现树原文件不在本树，字节级直接比对不可得；等价性按 brief
  指示用 diff 定位 + 结构与行为双重证明：
  - `migrate-test.ts`：`BOT_OWNERSHIP_TASK` 块（含边界空行恰 136 行界约定）位于
    `export const TASKS` 之前（L1004–1137）、注册行 `[BOT_OWNERSHIP_TASK.id, …]` 紧随
    `PAYER_ACCOUNT_TASK` 之后、2 步（tables 7 语句 + rls 25 语句）、digest 确定（计划
    确定性测试通过，复跑 planDigest `0f6723b5…`）——增量定位与 coordinator 披露一致；
    前置票链（09bf0400→MT076→MT069→+MT016）与 13 项 TASKS 注册表（…PEOPLE_LIFECYCLE、
    PAYER_ACCOUNT、BOT_OWNERSHIP）合并顺序自洽。
  - `migration-tool.test.ts`：仅 `"MT016"` 行（L386，在 MT014 与 MT026 之间，13 项穷举
    断言字典序）+ 3 行裁决注释（L375–377，注明 ruling #5 先例与第 2 任补齐）。
  - `schema/index.ts`：1 行 `export * from "./enterprise-bot-ownership"`（L17，字母序在
    enterprise-conversations 前）。
  - **行为证明**：本复审全新容器上 12 任务依序 generate→apply 全部 applied 并记 journal
    （MT016 两步 7+25 语句与任务声明一致）；聚焦套件 beforeAll 的 generate→apply→replay
    收敛（replay = up-to-date）；活库表结构与 RLS/GRANT 与 SQL、schema 文件三方一致。
    合并未改变 MT016 增量语义——成立。

## 5. E — 报告口径（定性成立，一处计数滑差见 §7-F4）

- **票号**：`gh issue view 59` 实取标题/五条验收/Verification 与实现完全对应；实现者 brief
  票号 #62 为 coordinator 简报笔误、实现者实取纠正——**简报笔误非实现缺陷**，定性成立。
- **双口径账目**：实现树 621 = 577+44（01-baseline 577/22 + GREEN-3 44 → verification/04、
  07 各 621/23）✓；本树 682 = 638+44（本复审复跑实测 682/0/0）✓。测试账两树均精确。
- **文件数**：brief 预期本树 24 文件，实测 26（§7-F4）——638 基线在本树实为 25 文件
  （preferences/people-lifecycle/payer-accounts 三文件同在装配窗 02:52 拷入，其中后两者为
  MT076/MT069 交付），coordinator 沿用了实现树 22+1 的文件计数。不影响任何验收。
- **D1–D8 披露逐条处置核实**：D1 接管三分（§2）✓；D2 MUT5 存活→补测（§3）✓；D3 分页/
  枚举断言对齐「当前作用域全部可见事实」票面语义、负向排他用例独立保留——非放松 ✓；D4
  epoch 独立捕获（MUT2）✓；D5 判定顺序（§6）✓；D6 边界（owner-only/MT017/MT019/扫描
  边界/不接路由，模块头诚实注记）✓；D7 环境记录（55501 占用 +1→55502 有档；本复审按
  brief 用 55512）✓；D8 夹具身份先例（suspend operator=被操作主体、reinstate 经真实
  tenant_admin——夹具码证实）✓。

## 6. F — TDD 链与 D5 判定顺序（成立）

- RED-1（第 1 任 `Cannot find module`）→ RED-2-2nd 接管基线 **38 pass / 4 fail**（42 测试、
  121 expect，存档含 4 个失败用例名）→ GREEN-1（42/134）→ +a1a2 补测 → GREEN-3（**44/0/0、
  143 expect**）。链条完整、数字两两自洽。
- D5：RED-2 存档中「缺上下文」用例当时实收 `UNVERIFIED_SCOPE`（信任门先行）即第 1 任缺口
  的直接证据；现码 9 个受 scope 方法均 `assertScopeContext` → `assertTrustedScope`，复跑中
  缺上下文得 `TENANT/WORKSPACE_REQUIRED`、forged scope（形状完整）仍被信任门拒为
  `UNVERIFIED_SCOPE`——两类响亮拒绝各有其码，顺序不泄露信息，越权语义正确。

## 7. 发现（非阻塞 4 项）

- **F1（合并格式漂移）**：三方合并把 MT016 块插入 `migrate-test.ts` 时两侧各多出 1 个空行
  （L1002/L1138 双空行），本树 `bunx biome check`（触及 7 文件）报 1 个 format error；
  实现树该文件 biome 干净（verification/06 在档）。纯格式、零语义（复跑全绿）。**建议
  coordinator 在集成时对该共享文件跑一次 `biome check --write`（单文件 2 行删）**；本复审
  无修复授权，未动。
- **F2（changes.diff 完整性）**：`checkpoints/MT016/changes.diff` 头注声明含三处授权编辑
  相对 HEAD，实际只含 `schema/index.ts` + 4 新文件 diff，migrate-test.ts 与
  migration-tool.test.ts 的增量 diff 缺失（before/after 哈希与本复审活库行为仍钉住状态，
  且 MT069 亦用摘要式 changes.diff 引用 verification 文件——先例存在）。证据卫生级。
- **F3（报告笔误）**：`reports/MT016.md` §3 称 brief-3「7 例」，实际该 describe 6 例
  （总数 44 正确：9+6+4+4+5+6+6+4）。
- **F4（brief 文件计数滑差）**：复审 brief「24 文件」与实测 26 不符（见 §5）——测试数
  682=638+44 精确，仅文件账沿用实现树口径未及更新。coordinator 口径事项，非交付缺陷。

## 8. 独立复跑记录（本复审自建环境，全程 0 skip）

1. 依赖：本树 bun 1.4.2，root/server node_modules 就绪，未重装。
2. 端口 55512 空闲 → 容器 `mt016-review-pg`（pgvector/pgvector:pg16，`-p 127.0.0.1:55512`，
   随机口令）→ 双库 `openbot_enterprise_mt016`(+`_assigned`) → 六变量 env 0600（setup=
   postgres 超户；`ent_review_{dir,data,opr}` 前缀登录过 enterprise-test-db 守卫；含
   `MT003_ASSIGNED_TEST_DATABASE_URL`）。
3. `enterprise-test-db.ts migrate` ok → 12 任务（MT004→MT008→MT112→MT012→MT014→MT010→
   MT009→MT077→MT026→MT076→MT069→MT016）generate→apply 全部 applied 并记 journal。
4. 聚焦 `bots-ownership.test.ts` → **44 pass / 0 fail / 0 skip（143 expect）**；套件内
   MT016 replay 收敛。
5. 全量 `bun --no-env-file test tests/multitenancy/ --timeout 30000` → **682 pass / 0 fail /
   0 skip（26 文件）**；assigned 库真实 apply 集成测试实跑（非 skip）。
6. `bun run typecheck` → exit 0；biome 触及 7 文件 → 1 个格式 error（F1，合并痕迹）。
7. 活库抽查：`enterprise_bot_ownership`（复合 PK + `agent_id` 全局唯一 + status/versions
   CHECK + 双复合 FK cascade + FORCE RLS 5 策略）、`enterprise_bot_preferences`（复合 PK +
   双复合 FK cascade + restrictive 自读 + FORCE RLS 4 策略）；列级 UPDATE 仅钉
   (display_name, default_config, status, revision, acl_epoch, updated_at)/(preferences,
   updated_at)；`mt_task_migration_journal` 12 任务步数精确（MT112:4、MT016:2、MT076:1、
   MT069:1 等）。
8. 清理：容器已删（`docker ps -a` 无 mt016-review）、env/口令文件已删并验证不存在、迁移
   临时目录已删。

## 9. 裁决汇总

| 项 | 裁决 |
|---|---|
| A 票面四条 + issue 五条 | 全部成立（44 用例真实 PostgreSQL + 受限角色 + 真实 RLS） |
| B 接管审计 | 与树内事实一致；第 1 任证据完整保留 |
| C 变异 6/6 | 成立；MUT5 首轮存活→补测记录诚实；pristine 复验一致 |
| D 三方合并语义等价 | 成立；一处纯格式漂移（F1，非语义） |
| E 报告口径 | 票号笔误定性成立；双口径账目精确；D1–D8 逐条核实 |
| F TDD 链 + D5 | RED→RED→GREEN 链完整；判定顺序修复实证 |

**总体：通过（pass with findings，4 项均非阻塞）**。skipped=0 门槛在复跑中成立。
