# MT026 / Issue #69 独立复审报告 — 每公司 SSO/SCIM 隔离（两任实现终态）

- 复审者：MT026 独立复审（全新 Pi 会话，Orca task_bf0e9202445f / dispatch ctx_60e1f2927356，工作树 `i9-review-mt026`，BASE `f0520524`）
- 审阅对象：本树 = EXE 49 项前置（458 基线含 MT009）+ 本票 10 交付（新 8：`schema/enterprise-sso-scim.ts`、`sso-scim-config.ts`、`scim-directory.ts`、`identity-binding.ts`、三测试套件、`support/sso-scim.ts`；编辑 3 合并态：`schema/index.ts` barrel、`migrate-test.ts`、`migration-tool.test.ts`），即第 2 任从零实现 + coordinator 三方合并的装配终态
- 方法：只读被审文件；唯一新建为本报告；四项裁决 A–D 逐项独立取证；全部复跑亲自执行并记录退出码；专用容器 `mt026-review-pg`（55499）与 env 文件（0600 随机口令）用后已删
- 结论先行：**MT026 通过复审，附 1 项必须更正的文档完整性发现（F1：聚焦用例数claimed 39，实际 33）**。四条验收全部有真实测试钉死且全绿；RLS 反证为真 RLS（活库双探针实证）；审计/事务形状符合 MT007/MT006 范式；D2–D5 披露逐条属实；三方合并语义等价经哈希三角定位 + 内容核对 + 动态复跑三重证实；491/33/typecheck/biome/八任务迁移链全部精确命中预期。F1 不涉及代码与测试本身，但 MT026.md §2/§3 与 checkpoint `verification/01` 头部必须更正后方可归档。

---

## 1. 独立复跑结果（全部亲自执行，退出码逐一记录）

| # | 步骤 | 结果 | 退出码 |
|---|---|---|---|
| 1 | `lsof -i :55499` 端口预检（空闲）→ `docker run` mt026-review-pg（pgvector/pgvector:pg16，trust，仅绑 127.0.0.1）→ 容器内 psql 探针 | **PostgreSQL 16.15**（aarch64） | 0 |
| 2 | 双库创建（`openbot_enterprise_mt026rv` + `..._assigned`）+ 六变量 env 文件（TEST/SETUP/DIRECTORY/DATA/OPERATOR + MT003_ASSIGNED，随机口令，0600，用后已删） | OK | 0 |
| 3 | base migrate：`bun --no-env-file scripts/enterprise-test-db.ts migrate` | `{"type":"migrations-applied","status":"ok"}` | 0 |
| 4 | 八任务序 generate+apply：**MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT026** | 16/16 命令全 exit 0；journal 实录 MT004(2)/MT008(2)/MT112(4)/MT012(2)/MT014(2)/MT010(2)/MT009(2)/**MT026(2)**（末步 `0001_mt026_sso_scim_tables.sql, 0002_mt026_sso_scim_rls.sql`） | 0 |
| 5 | 聚焦三套件 `sso-scim-config + scim-directory + identity-binding` | **33 pass / 0 fail / 0 skip，94 expect，3 文件**（13+14+6；详见发现 F1） | 0 |
| 6 | 全量 `bun --no-env-file test tests/multitenancy/` | **491 pass / 0 fail / 0 skip，9172 expect，19 文件**（= 458 + 33，精确命中 brief 预期；另以 `(pass)` 行计数复核 491 行，无隐藏 skip） | 0 |
| 7 | `bun run typecheck`（tsc --noEmit） | clean | 0 |
| 8 | `bunx biome check` 触及 11 文件（8 新 + 3 合并态；brief 写 10，实际触及集为 11） | **Checked 11 files，0 诊断** | 0 |
| 9 | 活库目录抽查：三新表 `relrowsecurity=t, relforcerowsecurity=t`；`pg_policies` 恰 **11 条**与交付 DDL 逐条对应（sso_configs：data SELECT + operator SELECT/INSERT/UPDATE；bindings：operator SELECT/INSERT/UPDATE + 连接键臂 SELECT；intents：operator INSERT + state 臂 SELECT/UPDATE）；`role_table_grants` 最小矩阵（**ob_ent_directory 三表零授权**；data 仅 configs SELECT；operator SELECT/INSERT + 列级 UPDATE：configs=document/revision/updated_at、bindings=credential_ref/status/last_deprovision_*/deactivated_at、intents=consumed_at）；无 PUBLIC 授权 | 全部符合票面 | — |
| 10 | 活库 D3 反证探针：`users`/`sessions`/`revoked_access` 对全部 `ob_ent_%` 角色 `role_table_grants` 查询 | **0 行（零授权，结构性隔离实证）** | — |
| 11 | 无 env 反证探针：清空六变量后跑 identity-binding 套件 | **6 skip / 0 pass**，用例名带显式 skip 原因，**无开发库回退**（D2 契约实证） | 0 |
| 12 | 清理：`docker rm -f mt026-review-pg`、env 文件与 /tmp 中间产物删除 | 完成（容器/文件均已验证不存在） | — |

环境备注：server/node_modules 已预装，无需 bun install。

## 2. 四项裁决逐项复审

**A. 四条验收 — 通过（逐用例清点 + 全绿复跑 + 活库反证）。**
- **AC1（SCIM 停用只影响本公司）**：`deprovisionMember` 单 operator 事务内完成成员 suspended+epoch+1、该公司 grants 逐行删除、绑定行 last_deprovision 事实、审计事件。multi-company 身份断言逐项核对（A 撤销：status/epoch/grantsDeleted>0/事后 grants=0；B 原样：epoch 相同、grants 计数不变；全局 principal 仍 active 经 directory 自读臂）。配套负例全绿：未知连接 NOT_BOUND 零写入、二次停用 already_suspended 零写入、非本公司成员 NOT_FOUND 零跨公司写入、停用绑定后 resolve/deprovision/provision 全部 DEACTIVATED。全局登录面由**活库零授权探针**（第 10 步）结构性钉死。
- **AC2（SSO 配置仅限本公司管理员 + 跨公司不可见）**：受信 CompanyAdminContext（WeakSet，`assertTrustedAdminContext`）+ API 无租户参数；伪造上下文在任何 DB 访问前 `UNVERIFIED_ADMIN_CONTEXT`；跨公司上下文签发本身被 MT006 authorizer 以 `TENANT_FORBIDDEN` 拒绝；无配置与"别家有配置"同码 `SSO_CONFIG_NOT_FOUND`；`SCIM_BINDING_EXISTS` 对本司重复与外司碰撞同码（不泄漏持有者）；停用未知/外司 key 同码 `SCIM_BINDING_NOT_FOUND`。存储层真实 RLS 反证：operator/data pin B 查不到 A 的行（且 pin A 的 sanity 断言证明"篱笆是 pin 而非空表"）。
- **AC3（SCIM 不能创建/改他司成员）**：租户只来自绑定行（`withBoundTenant` 先按连接键臂取行、后 pin 租户）；输入携带 tenantId 在任何 DB 访问前 `TENANT_ATTRIBUTION_NOT_ACCEPTABLE`（双公司零写入断言）；role 只认 member（`SCIM_ROLE_NOT_ASSIGNABLE`）；已存在成员零写入幂等；raw-SQL 跨公司 INSERT 被 withCheck 响亮拒绝（真 RLS 反证）。合并态下 MT009 用例同绿，证明目录反应与依赖表互不越界。
- **AC4（回调按服务端持久状态归属）**：state 服务端 `crypto.randomUUID` 生成、创建时持久化归属；解析按 state 臂读持久行；一次性消费（二次 `STATE_CONSUMED`）；伪造公司 → `IDENTITY_BINDING_TENANT_MISMATCH` 且**不烧 state**（诚实回调随后仍解析成功——该用例钉死了"声称既不生效也不消耗"）；未知/过期/已消费分别响亮拒绝；operator 按公司 pin 枚举意图 → 0 行（state 臂反证）。

**B. RLS/受限角色 — 通过（活库实证 + 反证用例全绿）。**
"restricted 角色对全局身份表零授权"声明经活库 `role_table_grants` 实证为真（users/sessions/revoked_access 对 ob_ent_% 全部 0 行）——AC1 的"全局登录不受影响"确为结构性事实而非仅服务层纪律。真实 RLS 反证用例五处全部为**带 pin/不带 pin 对照的真过滤断言**（sso_configs operator/data 双角色、bindings operator、跨公司 INSERT withCheck、intents 公司枚举、审计双 pin），且 connections.ts 的能力校验（NOLOGIN capability、无 bypassrls、无第二成员关系、login 无 enterprise 特权）为夹具前置。目录角色对三新表零策略零授权（活库确认）。

**C. 审计与事务形状 + D2–D3 处置 — 通过。**
- 审计：`recordScimDirectoryAuditEvent` 写同一张 `enterprise_security_events`，event id = operation id，满足该表 INSERT 策略的双 pin（tenant+operation，活库策略原文核对）；事件集合封闭（三类型白名单 + 输入守卫）；未改 revocation.ts（其当前哈希 = prereq manifest 逐位一致，只读消费成立）。测试实证 D4：无 operation pin 时审计流 0 行可读，持 pin 恰好 1 行。
- 事务形状：read committed + lock 2s/statement 5s + 事务本地 set_config + advisory 锁（成员锁键序同 MT006/MT008 家族）；撤权=删行范式（grants 先枚举后逐行删，resource_id+operator_principal_id 双 pin）与 MT007 一致。
- **D2 处置属实**：夹具环境探针只认显式六变量；本人无 env 反证跑出 6 skip/0 pass（显式 skip 名、绝不回退开发库），六变量齐备时全量 0 skip——"skipped 不算通过"纪律在本复跑中成立。
- **D3 处置属实**：见 B；受限角色结构性无法触及部署级身份面为本人在本树活库独立实证，非转述。
- D5（provision 不创建全局 principal）与代码一致：`principalOf` 走 directory 自读臂，缺失/停用一律拒绝（`SCIM_PRINCIPAL_NOT_FOUND`），成员关系 INSERT 是唯一写入面。

**D. TDD 链 + 变异 + 装配核对 — 通过（附 F1 计数更正）。**
- TDD 链自洽：RED-1（registry 断言先行 40/1）→ GREEN-1（42/1skip）→ RED-2（模块缺失 0 pass/3 fail）→ GREEN-2（01 终态）。历史不可重放，但链路与 artifacts 时间线无矛盾。
- 变异：16/16 KILLED，逐条 fail 计数与基线记录在案；MUT10 首跑 SURVIVED → 补"管理员停用不被目录解除"用例 → MUT10b KILLED，该用例在交付文件中在位且本复跑全绿。**注意：mutation/results.txt 自身的基线计数（sso 12、directory 13→14、identity-binding 5）是 33 真实计数的第一手旁证**（见 F1）。
- 装配核对：见 §3。

## 3. 装配核对（coordinator 三方合并语义等价）— 通过

独立方法：EXE prereq-manifest（49 项）× 当前工作树 × MT026 before/after-hashes 三方比对 + 合并内容逐处归属核对 + 动态复跑。

1. **哈希三角定位**：manifest 49 项中 **46 项与当前工作树逐字节一致**；仅有的 3 个 DIFF 恰好就是三个被合并文件（migrate-test/schema index/migration-tool）——本树 = EXE 49 前置态 + 三文件合并变更，无第四处偏差。
2. **schema/index.ts**：EXE 版与 MT026 before 哈希相同（`917d78fc`），合并结果与 MT026 after 哈希相同（`94af3dba`）＝ EXE barrel + 恰一行 `enterprise-sso-scim` 导出，与 brief "+1 export" 逐字吻合。
3. **migration-tool.test.ts**：合并态同时含 MT009（EXE 增量）与 MT026 的裁决注释 + allowlist 项（"MT009"、"MT026" 在位，穷举断言语义 = 两侧窄编辑之和）；registry 断言在合并树上真实通过（全量套件内）。
4. **migrate-test.ts**：MT026 任务块（2 步：sso_scim_tables/sso_scim_rls）与 narrow-edit diff（verification/07）逐语句一致，插入位（PERSONAL_SHARE 之后）与 registry 行在位；MT009 任务块并存；TASKS 9 项 = allowlist 9 项（含 MT026）。
5. **新 8 文件**：与 MT026 after-hashes 逐字节一致（合并未触碰交付物）。
6. **动态证实**：八任务迁移链、migration-tool 断言、全量 491（含 MT009 的 36 与 MT026 的 33）全部在合并树上亲自复现。

## 4. 发现（Findings）

- **F1（重要度：中；文档完整性，非代码缺陷，不阻塞但必须更正）——聚焦用例数 claimed 39，实际 33。**
  实际三套件 = 13（sso-scim-config）+ 14（scim-directory）+ **6（identity-binding）** = 33（本复跑 33 pass/94 expect/3 files 实证）。而 MT026.md §2（"identity-binding.test.ts（12 用例）… 共 39 用例"）、§3（"聚焦套件 39/0/3"）与 checkpoint `verification/01-new-suite-final.txt` 头部（"39 pass … 12 identity-binding = 39"）声称 39。该声称与交付字节不可调和：交付文件哈希被 after-manifest 钉死（`bce34b1b`），其产出必然是 33；且同报告 §3 的 455=422+**33**、brief 的 491=458+**33**、mutation 日志的 identity-binding **5-pass 基线**全部指向 33。"39/12"应为誊写/汇总错误（可能混入第 1 任规划期的用例设计数）。**处置要求**：更正 MT026.md §2/§3 与 01 头部计数（或在 01 加显著勘误注记）；全量算术（491）与全部验收证据不受影响。
- **F2（trivial）**：brief 称"biome 触及 10 文件"，实际触及集为 11（8 新 + 3 合并态）。本人按 11 文件执行，0 诊断。
- **F3（备忘，无需行动）**：`readSsoConfig`/`listScimBindings` 读取路径不做事务内管理员重验（写路径全部重验）——与 MT006 workspace-admin 先例完全同构（7 个写方法重验、list/resolve 不重验），服务头注释亦如实限定"每个**写**事务重验"；仅 MT026.md §2 AC2 单元格"事务内重验"未写明限写路径，措辞可再精确。

## 5. 结论

**MT026 通过独立复审。** 四条验收、RLS 反证、审计/事务形状、TDD/变异、D2–D5 披露、三方合并装配全部有本复跑的一手证据支撑；491/0/0/19、33 聚焦、typecheck、biome、八任务迁移链全部命中。唯一实质发现 F1 为交付报告与 checkpoint 中的用例计数膨胀（39→33），证据链（mutation 基线 + 全量 delta + brief 算术）三方向互证，更正文档后即可归档；代码、测试、迁移与装配本身无阻塞问题。
