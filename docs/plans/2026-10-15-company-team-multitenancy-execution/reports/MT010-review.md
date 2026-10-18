# MT010 / Issue #53 独立复审报告 —— 个人资源权限与显式跨团队分享

- 复审者：MT010 独立复审（全新 Pi 会话，Orca task_864b49319e6f / dispatch ctx_a430bf86c58f，工作树 `i7-review-mt010`，HEAD `f0520524`）
- 审阅对象：本树 9 交付（新 4 + 编辑 5；brief 所列「新 5」中的 `support/scenarios.ts` 实为编辑——它在 before-hashes/prereq-manifest 中均有 before 哈希 `cdca14ca…`，非新建）
- 方法：只读被审文件；唯一新建为本报告；全部验证亲自执行并记录退出码；专用容器 `mt010-review-pg`（55486）用后已删，凭据文件（0600 随机口令）用后已删
- 结论先行：**MT010 本票交付通过复审**。七项裁决全部有证据支撑；9 文件哈希与实现树 checkpoint 逐一相符；34/397（在修正装配后的重建树上）/typecheck/biome/CLI 链全部复现。发现 1 项**树装配缺口（非本票缺陷）**、2 项轻微备忘、1 项报告笔误，均不阻塞。

---

## 1. 独立复跑结果（全部亲自执行）

| # | 步骤 | 结果 | 退出码 |
|---|---|---|---|
| 1 | 端口预检 55486（空闲）→ `docker run` mt010-review-pg（pgvector/pgvector:pg16，trust）→ psql 探针 PostgreSQL 16.15 | OK | 0 |
| 2 | 双库创建 + 五变量 env（随机口令，`chmod 600`，用后已删）+ `bun --no-env-file scripts/enterprise-test-db.ts migrate` → `{"type":"migrations-applied","status":"ok"}`，150 表 + `ob_ent_*`/`ent_review_*` 供给 | OK | 0 |
| 3 | 按依赖序 apply **MT004→MT008→MT112→MT012**（各 dry-run/generate/apply） | 全部 OK | 0×12 |
| 4 | MT010 CLI 链：dry-run（2 步/14 语句）→ generate（planDigest `63f010a0…` 确定性一致）→ apply（journal 记账）→ 重复 apply = **up-to-date** | OK | 0×4 |
| 5 | 聚焦 `bun test tests/multitenancy/personal-share-rules.test.ts --timeout 30000` | **34 pass / 0 fail / 0 skip，132 expect** | 0 |
| 6 | 全量 `bun test tests/multitenancy/ --timeout 30000`（本装配树 + `MT003_ASSIGNED_TEST_DATABASE_URL`） | 368 pass / **1 fail / 0 skip**（唯一失败 = MT014 模块缺失，见 §4.1；28 用例未运行；368+28+1=397） | 0 |
| 7 | 全量复跑于 **EXE+MT014+MT010 /tmp 重建树**（仅补齐 MT014 装配缺口，未触碰本树；重建方法见 §4.1） | **397 pass / 0 fail / 0 skip，14 文件，8672 expect** | 0 |
| 8 | `bun run typecheck` | clean | 0 |
| 9 | `biome check` 触及 8 文件（新 4 + scenarios/migrate-test/migration-tool/schema-index） | clean，0 finding | 0 |
| 10 | `biome check src/index.ts` → 6 errors + 1 warning（4× noConsole、1× noNonNullAssertion、organizeImports、format）；与 pristine 基线（EXE 树 `addc265c…` = 逐字节重建的 before 态）**逐规则完全相同** → 存量欠账、零新增，D3 披露独立证实 | 与披露一致 | — |
| 11 | 活库抽查：`pg_policies` 4 条（data SELECT / operator SELECT+INSERT+DELETE，无 UPDATE、无 directory、无 identity_operator）；`information_schema.role_table_grants`（directory 0 行、data 仅 SELECT、operator DELETE+INSERT+SELECT）；两 CHECK（`enterprise_share_action` = 'read'、`enterprise_share_validity` expires>created）；3 条复合 FK 内嵌 tenant_id；`relrowsecurity=t, relforcerowsecurity=t`；journal 含 MT010 步骤 1-2（digest 与 dry-run 一致） | 全部符合 MT012 模板 | — |
| 12 | 清理：`docker rm -f mt010-review-pg`、env 文件与 /tmp 重建树删除 | 完成 | — |

环境备注：本树 `node_modules` 为空，需先 `bun install`（1415 包，exit 0）；`MT003_ASSIGNED_TEST_DATABASE_URL` 为第 6 个必需变量（缺省时 migration-tool 的 MT000 真实 apply 用例显式 skip——**skipped 不算通过**，设置后 2 例转 pass）。

## 2. 七项裁决逐项复审

**A. 分享表设计（MT012 模板合规）— 通过。**
迁移 SQL（migrate-test.ts MT010 任务）与活库现态双重核验：复合主键 `(tenant_id, resource_id, principal_id, action)`；`enterprise_share_action` CHECK 钉死 read-only（服务层 `SHARE_ACTION_UNSUPPORTED` + 数据库 23514 双层，测试逐层钉死）；`enterprise_share_validity` CHECK 要求 `expires_at > created_at`；三条复合 FK 内嵌 tenant_id 分别证明资源归属、受众成员资格、grantor 成员资格——跨公司分享行结构性不可能（测试以 23503 双向钉死：受众侧 + sharer 侧，且 sharer 侧用例特意选无既有分享行的受众，保证触发的是 granted_by FK 而非 23505）；`REVOKE ALL … FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator` + 最小授权矩阵（活库复验）；FORCE RLS 活库 `relforcerowsecurity=t`。`identity_operator` 零授权。

**B. 判定门三重语义 — 通过。**
三条门（真实 reader 404/`RESOURCE_NOT_FOUND`、workspace-v1 与 tenancy-v1 策略判定 DENY、分享感知判定 DENY）对同团队他人 × session/file/connection 三 kind 全部钉死；正向对照（属主 200）排除假门。分享受众 scoped：受众外同团队同事 DENY（独立用例）；分享不流经 grants：受众的 reader 路径仍 404 且 grants 快照仍只有属主一行（独立用例 + ownership snapshot）。判定服务不触碰 resource-policy（纯新增模块），deny 单一形状 `RESOURCE_NOT_FOUND`，跨公司拒绝与不存在拒绝 verdict JSON 逐字节相等（测试断言 `JSON.stringify` 相等）。

**C. 时间与撤销语义 — 通过。**
过期由数据库时钟裁决：SQL 内 `${expiresAt} > now()`（MUT3 变异证明该比对承载安全语义）；+600ms 窗口用例为真实时序测试（先 ALLOW → sleep 900ms → DENY → 行仍在，判定时事实非行删除）；过去时点创建拒绝（`SHARE_EXPIRY_INVALID`，应用时钟仅作创建时拒绝、安全判定不依赖）；撤销=删行（无可达中间态；`revoked=false` 幂等语义与「已撤销」一致）；活跃唯一（服务层 `SHARE_ALREADY_ACTIVE` + 主键兜底）；停用→恢复→旧 scope 仍拒（epoch 前进）、新 scope 立即恢复——三段断言齐全。轻微备忘见 §4.3/§4.4。

**D. 越权面 — 通过。**
被分享方转授 → `NOT_RESOURCE_OWNER`；被分享方 revoke → `NOT_RESOURCE_OWNER`；不存在资源/同团队同事/公司管理员（tenant_admin 身份不改变属主判定的 role-blind 语义）四路同码不泄露存在性；非 private（显式置 `visibility='workspace'`）→ `SHARE_TARGET_NOT_PERSONAL`；自分享 → `SHARE_AUDIENCE_SELF`。撤销即删行 + operator DELETE 策略要求行内 `granted_by = 操作者`，无 UPDATE 授权——部分改写路径不存在。

**E. 纯追加/窄例外/改动面 — 通过（附装配缺口，见 §4.1）。**
9 文件 sha256 与实现树 after-hashes **逐一相符**。4+1 编辑文件的 MT010 增量按 changes.diff 逐行定位后**从本树现文件外科手术式剔除 → 重建 pristine → 哈希复验**：
- `src/db/schema/index.ts`：git diff HEAD = 恰 +1 行；pristine = git HEAD `7d38d054…` ✓
- `src/index.ts`（-26 行）、`support/scenarios.ts`（-1 行）：pristine = `addc265c…`/`cdca14ca…` = **本树 prereq-manifest 值** ✓（即这两文件 = EXE 态 + MT010 纯追加）
- `scripts/multitenancy/migrate-test.ts`（-73）、`tests/multitenancy/migration-tool.test.ts`（-4）：pristine = `8d1d6ab6…`/`4ede3c5f…` = **实现树 before-hashes**，非本树 prereq-manifest（`7cfbbc0b…`/`edd0bc01…`）——与 brief 预告一致：这两文件在本树为「实现树整版」而非「EXE 态 + MT010 追加」，MT014 对其的增量不在本树。MT010 自身增量在两种基线上都是纯追加、0 删除。窄例外形态与 MT012 先例同型（穷举断言 + 裁决注释），活库 journal 与 allowlist 断言自洽。

**F. TDD 链与 5/5 变异 — 通过。**
RED-1 = 模块缺失（0 pass/1 fail，与 MT008 同型）；GREEN-1 34/0/132；GREEN-2 339/0（实现树态）。变异 5/5 捕获且计数逐条对上：MUT1 33/1、MUT2 30/4、MUT3 33/1、MUT5 33/1；**MUT4 序列诚实**——首轮存活日志属实（34/0 @ 130 expect，epoch 核对对「停用」场景是 status 翻转的冗余防线）、补「停用→恢复→旧 scope 仍拒」用例后 MUT4b 33/1（131 expect）、最终 132 expect；RESTORE-green 复绿 34/0。受限角色钉死：`current_user = ob_ent_data / ob_ent_operator` 断言在收尾 describe；判定全程经受限 data 角色 + 真实 RLS，superuser 仅用于 catalog 断言与离线安排替身（D5，判定侧从不使用）。

**G. 「三条门全拒」断言强度 — 通过，非空洞拒绝。**
dedicated 用例以受限 operator 查询钉死 a1-other 在 team-a1 的 `enterprise_workspace_memberships` 行存在且 `status='active'`（`rows.length=1`）——团队资格确凿在手仍被三门全拒；且跨团队同公司成员（a2，公司成员资格在手）同样 DENY。正向对照（属主 200/ALLOW）与负向对照齐备，排除「资源本来就不可读」的假阳性。

## 3. 交付物完整性

- `checkpoints/MT010/sha256-manifest.txt`：33 个实体条目 `sha256sum -c` 全部 OK（4 行为注释头，非格式错误）。
- 9 交付文件哈希 = after-hashes 逐字节一致；before/after/changes.diff/红绿/变异/验证日志齐备且自洽。
- 报告（reports/MT010.md）四条验收 → 测试证据映射逐条可追溯；D1–D7 披露经独立复验全部属实（D3 见 §1#10；D6 见 §2-F）。

## 4. 发现（均不阻塞本票通过）

**4.1〔重要 · 树装配缺口，非 MT010 缺陷 → 需 coordinator 处置〕本树缺 MT014 文件集，397 基线在本装配树上不可达。**
本树 prereq-manifest 收录了 MT014 的测试文件（`tests/multitenancy/runtime-config.test.ts`、`support/runtime-config.ts`，哈希与 EXE 树一致），但**未收录其被测模块** `src/enterprise/tenancy/runtime-config.ts` 与 `src/db/schema/enterprise-runtime-config.ts`，且 migrate-test.ts/migration-tool.test.ts 取的是实现树整版（无 MT014 任务注册与断言条目）。后果：全量在本树上 368 pass / 1 fail（`Cannot find module '…/runtime-config'`，runtime-config.test.ts 全文件 29 例中 1 fail + 28 未运行）/ 0 skip。
**根因与 MT010 无关的实证**：(a) MT010 的 9 交付不含也不得含这些文件（不在其可写清单）；(b) brief 已预告四个文件的 MT014 差异，但 runtime-config 模块缺不在预告范围且直接违反本 brief 自己的「397/0/0skip」成功标准；(c) 在 /tmp 重建树上（EXE 树的 2 个 MT014 src 文件 + EXE 版 migrate-test/migration-tool.test/schema-index 各自叠加 MT010 已验证的纯追加增量，本树 src/index.ts/scenarios.ts 本就是 EXE+MT010 态）全量 **397/0/0skip、14 文件、exit 0**——MT014 缺口是唯一阻塞项，补齐后基线精确成立。重建树已删除；本树未做任何修改。
→ 建议 coordinator 重新装配本树（EXE 态 + MT010 增量方向合并），或将 MT014 文件集补入 prereq 清单后重跑全量。

**4.2〔trivial · 报告笔误〕** reports/MT010.md D4 称「110 行纯新增」；按 changes.diff 实际为 **105 行**（72+1 migrate-test、4 migration-tool.test、1 scenarios、4+22 index.ts、1 schema-index）。「纯新增、0 删除」的实质主张经哈希重建证实成立，仅计数有误。

**4.3〔minor · 语义命名〕`SHARE_ALREADY_ACTIVE` 在「既有分享行已过期」时同样抛出**：服务层查行存在性（主键也不允许共存），过期行未撤销前向同一受众重开窗口会得到「already active」字样的拒绝，需先 revoke（删过期行）再 share。测试覆盖 revoke→重开窗，未覆盖「过期后不 revoke 直接重开」。fail-closed、无安全影响，仅错误名与实态略有出入；可在 MT058/092 消费该服务时细化（如区分 `SHARE_WINDOW_EXISTS`）或补一条用例钉死现行为。

**4.4〔minor · 测试稳健性〕DB 时钟过期用例的 600ms 正向窗口**：首个 ALLOW 断言须在 share 创建后 600ms 内完成。本机与实现树多轮运行均稳定，但重载 CI 上理论上可能翻 flake（安全关键的 DENY 侧不受影响，ALLOW 侧是正向对照）。可观察后续 CI；必要时放宽正向窗口（如 +2s）而不弱化 DENY 断言。

## 5. 结论

MT010（Issue #53）九项交付在独立复审下全部成立：分享表结构性杜绝跨公司（A）、三重判定门语义完整不泄露（B/G）、数据库时钟与删行式撤销语义真实钉死（C）、越权面全封闭（D）、改动面纯追加且哈希可重建（E）、TDD 链与 5/5 变异含 MUT4 诚实披露（F）。聚焦套件 34/0/0skip、typecheck、biome（触及文件零新增）、CLI 链、活库模板合规全部复现；全量 397/0/0skip 在补齐 MT014 装配缺口的重建树上精确复现，本装配树上的唯一失败经根因分析确认在 MT014 文件集缺失，非本票缺陷。放行建议：MT010 本票通过；§4.1 装配事项交回 coordinator 处置；§4.2–4.4 作为备忘不阻塞。
