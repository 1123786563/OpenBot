# MT076 独立复审报告 — 人员提升/降级/离职按公司授权（Issue #119）

- 复审者：独立 Reviewer（Pi，Orca Task `task_3c5358595349` / Dispatch `ctx_9f34beea88e4`，全新会话，未参与实现）。
- 日期：2026-10-17。被审树：`i10-review-mt076`（HEAD = `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`，与 prereq-manifest BASE 一致）。
- 方法：只读被审文件 + checkpoint 证据独立复算 + 独立环境全量复跑（容器 `mt076-review-pg`，pgvector/pgvector:pg16，仅回环 + 随机口令，六变量 env 0600 用后已删）。唯一新建 = 本报告；未修改任何被审文件；无提交/推送/合并。
- **总结论：五项裁决 A–E 全部通过；独立复跑全部达标（聚焦 16/0/0、全量 593/0/0·23 文件·0 skip、typecheck 0、biome 5 文件 0/0、活库授权与 journal 抽查吻合）。装配核对以密码学方式证明本票增量为纯追加。发现 2 条纯文档计数误差（互不相关、无代码影响）与 1 条测试基线引用 nit，均非阻塞，见 §7。**

---

## 0. 装配核对（brief 指定独立验证项）——通过

coordinator 披露：本树 = EXE 67 项前置（577 基线，22 测试文件）+ 本票 5 交付；3 新文件整复制，2 共享文件 after 版本整复制（before 哈希已与 EXE 现态核对）。独立核对结果：

1. **manifest 计数**：`checkpoints/prereq-manifest.txt` 实测 **67 条**哈希条目（+1 行 BASE 头），与 brief 下发清单 67 项一致。
2. **67 项逐条复算（当前树）**：**65 OK + 2 DIFF**；2 个 DIFF 恰为两个授权触点（`migrate-test.ts`、`migration-tool.test.ts`）的 after 版本，无 MISSING、无未披露漂移。
3. **before 态密码学复原**：`checkpoints/MT076/changes.diff` 反向 patch 到当前树两文件 → SHA-256 逐字节复现 before 哈希 `09bf0400…`（migrate-test）与 `2a1ce227…`（migration-tool），与 manifest 条目及 `before-hashes.txt` 完全一致。即 **本票对两个共享文件的增量为纯追加**：`migrate-test.ts` +33 行（MT076 任务块 + 1 行注册），`migration-tool.test.ts` +4 行（3 行裁决注释 + 1 条 `"MT076",`），0 删除行，既有票内容零触碰。
4. **allowlist 位置**：`ALLOWED_TASK_IDS` 实测 11 项，`"MT076"` 位于 `"MT026"` 与 `"MT077"` 之间——即 sort() 序正确位（MT075 从未注册迁移任务，不在表内；brief 的「MT075 与 MT077 之间」按有序邻域理解为 before-MT077，实际位置满足）。`new Set(ALLOWED_TASK_IDS) == new Set(TASKS.keys())` 断言在独立复跑中通过。
5. **3 个新文件**：当前 SHA-256 与 `after-hashes.txt` 逐字节一致（`ff01c87a…` / `0fc9ccf2…` / `17e32d1b…`）。

**结论：装配未改变本票增量语义；「本票 5 交付」在树上完整且逐字节可证。**

## 1. 裁决 A —— 四条验收 —— 通过

实现核心：`createCompanyPeopleLifecycleService`（promote/demote/offboard），全部动作只收受信 `CompanyAdminContext`（首行 `assertTrustedAdminContext`，伪造上下文在触碰数据库前拒绝），API 面无租户参数（公司归属只来自上下文），事务内 advisory 锁（tenant → admin → target 规范序）+ admin 重验（active + tenant_admin + epoch 相等 + principal active）→ pin 目标 → 动作。16 用例独立复跑 16/0/0，逐条：

- **①离职只撤本公司（AC1）**：双公司成员（真实 MT026 目录供应 A/B 两公司成员 + 每公司一条团队行 + 一条资源授权）在 A 被离职后——A 成员行 `suspended` + epoch+1、grants 清零（`grantsDeleted` = 事前计数）、团队行保留（级联失效语义，不删行）；**B 侧成员行/epoch/grants/团队行四项与事前逐项相等**；`requestAs` 真实请求 A→403 `TENANT_FORBIDDEN`、B→200 正向放行；principal 全局保留 active，且 directory/data/operator 三角色对 `users`/`sessions`/`revoked_access` 的 `has_table_privilege` 逐一断言为 false（MT026 D3 结构事实复核，全局身份结构性不可触）。✅
- **②提升/降级只动本公司角色 + epoch 推进（AC2）**：A 提升后 B 成员行整体 `toEqual(before)`、grants 数不变；demote 对称（A 行变更、B 行不动）；**demoted admin 旧上下文**（真实 MT006 authorizer 在晋升窗口内签发）随后调用因 epoch 漂移被拒 `SCOPE_REVOKED` 且零写入；对非管理员降级、对已管理员提升均 `COMPANY_MEMBER_NOT_FOUND` + 行不变。✅
- **③无权主体不可见语义 + 三动作审计（AC3）**：B 公司管理员对 A 成员提升与对捏造 id 提升两错误**消息相等**断言（`crossMessage === unknownMessage === "COMPANY_MEMBER_NOT_FOUND"`）+ 事前事后的行相等（零存在泄漏、零写入）；伪造上下文三动作全部 `UNVERIFIED_ADMIN_CONTEXT`（WeakSet 信任标记，数据库访问前拒绝）；非管理员解析上下文 `TENANT_ADMIN_REQUIRED`；封闭词表外输入（`to: "nobody"`、空白 principalId）`INVALID_REQUEST`。审计：三动作事件经 `report.auditEventId` 以 **tenant+operation 双 pin** 读回，五要素（event_type、operator_principal_id + operator_user_id 双记、target_principal_id、epoch、动作细节 role_from/role_to 或 grants_deleted）逐一断言。✅
- **④与 SCIM 停用同构（AC4）**：真实 `createCompanyScopedDirectoryReconciler` 做同态对照——SCIM deprovision 与管理员离职落同一谓词集（suspended、epoch+1、grants 清零、团队行保留、principal 不动）；目录不能解除管理员离职（`SCIM_REPROVISION_NOT_ALLOWED`，状态零变更）；对已 SCIM 停用成员的离职 `COMPANY_MEMBER_NOT_FOUND` 零写入。两通道不产生第二套语义。✅

夹具零 mock 授权路径（真实 MT006 authorizer、真实 MT026 reconciler/config service、验证过的受限角色连接）；缺 env 整套显式 skip 不回退开发库（契约与 scim-directory.test.ts 同型）。16 用例计数独立复核 = AC2:5 + AC1:3 + AC3:5 + AC4:3 = 16 ✅。

## 2. 裁决 B —— GRANT UPDATE("role") 窄例外 —— 通过（最小性成立）

- **基线事实复核**：`server/drizzle/0056_enterprise_tenancy_rls.sql:133` 确为 `GRANT UPDATE ("status", "epoch") ON TABLE "enterprise_memberships" TO ob_ent_operator`——role 列基线刻意不可写；本票是第一个需要写 role 列的已验证票据，扩展理由成立。
- **最小性**：生成 SQL 恰 1 语句 `GRANT UPDATE ("role") … TO ob_ent_operator;`（单表、单列、单角色、expand-only——无 REVOKE、无策略改动、无既有对象变更；manifest `planDigest 2bb77ef4…`、statementCount 1 与生成物一致，且与我独立生成的 SQL 逐字节相同）。MT008 列级授权先例同构。
- **RLS 受限写面被测试钉死**：行面由既有策略 `enterprise_membership_operator_update` 收紧（USING/WITH CHECK 双臂 pin `tenant_id = app.tenant_id AND principal_id = app.operator_principal_id`）——服务在 admin 重验后才 pin 目标，role 写只能落在当次事务 pin 死的那一行；16 用例全程实跑真实 RLS，跨公司/伪造/未验上下文全部被拒；MUT8（拒绝码泄漏角色状态）、MUT11（审计 pin 移除 → 真实 RLS INSERT 拒绝，8 fail）证明受限面真实生效。
- **活库抽查**：`information_schema.column_privileges` 中 `enterprise_memberships` 的 UPDATE 列授权在非 owner 角色中**仅有 ob_ent_operator**（epoch/role/status 三列；directory/data 零授权）；`pg_policies` 中该表 UPDATE 策略仍恰为既有 1 条，未被本票改动。
- **更窄替代评估**：列级 GRANT 已是该体系确立的最窄授权形态（不能在 GRANT 上条件化事务状态）；替代方案（SECURITY DEFINER 函数/触发器/新角色）都是更大范式变更，违背 MT008 先例与最小 diff 纪律。无更窄合理替代。

## 3. 裁决 C —— 审计通道 —— 通过

- 事件集合封闭：`PEOPLE_LIFECYCLE_AUDIT_EVENT_TYPES = company_member.{promoted,demoted,offboarded}`，写入前运行时守卫（类型/tenant/操作者/对象/epoch/details 形状），越界抛 `PEOPLE_LIFECYCLE_AUDIT_EVENT_INVALID`。
- 同表同策略：写 `enterprise_security_events`，INSERT 经既有 `enterprise_security_event_operator_insert`（WITH CHECK `tenant_id = app.tenant_id AND id = app.operation_id`，活库确认在位）——不改 revocation/scim-directory/admin-separation 任何既有写入方。
- tenant pin 由调用方事务负责：`set_config('app.tenant_id', context.tenantId, true)` 事务本地设置（代码核对）；operation pin = 事件 id 本身。
- **MUT11 杀伤机制为真实 RLS 拒绝**：`results.txt` 记录 MUT11（operation pin 移除）→ **8 fail**——无 pin 时策略 WITH CHECK 求值为 NULL → INSERT 被数据库拒绝，非断言层假杀伤。
- 拒绝类调用不产审计行（授权拒绝 ≠ 管理动作，MT075 范式），AC3 测试的零写入断言覆盖无计数泄漏面。

## 4. 裁决 D —— TDD 链 + 变异 + 「ruling #5 第 7 次」口径 —— 通过（含 1 条文档计数误差）

- **RED-1**：`01-red-fullfile.txt` = `Cannot find module '…/people-lifecycle'`（模块缺失，0 pass / 1 fail，失败原因 = 功能缺失）✅。
- **RED-2（自然实验）**：`02-green-first.txt` = 11 pass / 4 fail，4 个失败全部 `PostgresError: permission denied for table enterprise_memberships`（Postgres 42501）——迁移授权缺失的等价变异由数据库真实拒绝杀伤，非测试断言杀伤 ✅。随后注册任务 → migration-tool 断言先 RED → 追加 `"MT076"` → 回绿 → 聚焦 58 pass（16 + migration-tool 42）。
- **GREEN/REFACTOR**：`03-green-focused.txt` 58/0（2 文件）；refactor 记录（withTargetMember 信任断言去重、grants 删除 returning 校验、biome/tsc 收窄）与最终代码形态一致。
- **变异 14/14 KILLED**：`run-mutations.sh` 逐行核对——变异对象仅为被测实现模块（备份→单点替换→聚焦套件→恢复），结果文件逐条 fail 计数齐全，恢复后 sanity 16 pass + "MODULE RESTORED CLEAN"。14 条覆盖：信任检查、事务内重验、promote/demote epoch、已管理员守卫、封闭词表、空 principalId、grants 删除、离职审计、泄漏码、在职守卫、降级前置、MUT11 审计 pin、离职停用写。+ RED-2 自然杀伤 1 条（授权缺失）= 计数逐一核对相符 ✅。未变异项披露合理（advisory 锁序单线程不可观测、returning 校验为纵深防御）。
- **「ruling #5 先例第 7 次」定性：文档计数误差，非事实错误**。allowlist 实测 11 项 = MT000（自检）+ MT004（ruling #3 原始裁决）+ **9 项 ruling #5 条目**——MT076 恰为第 9 项，与 brief 口径一致。计数漂移**先于本票存在**：MT012 报告自称第 3 次、MT014 与 MT009 都自称第 4 次、MT026 与 MT077 都自称第 6 次；按真实序列（MT112→MT008→MT012→MT014→MT010→MT009→MT077→MT026→MT076）本票应为第 9 次。MT076 的「第 7 次」是沿用了已经漂移的 running counter。窄例外的实质纪律（仅断言行 + 裁决注释、diff/哈希存档、brief 预授权）每票都完好，此误差纯属注释/报告簿记，建议 coordinator 在后续票统一以「allowlist 第 N 项」为准。

## 5. 裁决 E —— 报告数字 —— 复算吻合（含 1 条计数口径误差）

| 数字 | 报告声称 | 独立复算 | 判定 |
|---|---|---|---|
| 聚焦套件 | 16 pass / 0 fail / 0 skip | **16/0/0**（本机独立复跑） | ✅ |
| 全量回归 | 593 pass / 0 fail / 23 文件 | **593/0/23，0 skip**（复跑两次；577+16=593 自洽） | ✅ |
| 全量基线 | 577/0/22 | `00-baseline-full.txt` 实录 577/0/22 ✅；当前树 manifest 中 22 个既有测试文件哈希全部未变 | ✅ |
| typecheck | 0 errors | `bunx tsc --noEmit` = 0 | ✅ |
| biome | 5 文件 0/0 | 5 触及文件 `bunx biome check` = 0 error 0 warning | ✅ |
| **prereq 领取复算** | **66/66 哈希一致** | manifest 实测 **67 条**；交付后现态 65 OK + 2 授权 DIFF；BASE 态 2 触点 before 哈希与 manifest 逐字节一致（§0.3 密码学复原）→ 领取时应为 **67/67** | ⚠️ **66 为计数误差**（少记 1 项），复算行为本身完好、无实质遗漏 |
| 迁移 journal | 10 任务落账（报告 §2）/ brief「十一任务」 | 主库 journal 实测 10 业务任务（MT004…MT076，步数 2/2/4/2/2/2/2/2/2/1）；**MT000（3 步）落在 assigned 库**——两库合计 11 任务 ID 全落账 | ✅（口径：MT000 在 assigned 库） |

## 6. 独立复跑记录（环境差异披露）

- **端口**：brief 指定 55501 预检——被并行 worker 容器 `mt069-impl-pg` 占用（与实现票 D5 同类瞬时冲突）→ 改用 **55502**（预检空闲，同为仅回环绑定）；容器 `mt076-review-pg`（pgvector/pgvector:pg16，随机口令）。
- **六变量 env**（TEST / SETUP / DIRECTORY / DATA / OPERATOR / MT003_ASSIGNED）写入 0600 文件，全程 source 使用，**用后已删并验证不存在**。
- 链路：base migrate（`enterprise-test-db.ts migrate`，未省略）→ MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→**MT076** 十任务各自 dry-run → generate --out → apply --manifest 全部成功；我生成的 MT076 SQL 与 checkpoint 留证逐字节相同。
- 本地一次性依赖安装（`bun install`，本 review 树 node_modules 缺失，属环境准备，未触碰被审文件）。
- 清理：`docker rm -f mt076-review-pg`、env 文件删除、容器与文件不复存在已验证。实现票遗留容器 `mt076-impl-pg` 不属本票清理范围，未动。

## 7. 发现项（全部非阻塞）

1. **【文档计数】「ruling #5 先例第 7 次」应为第 9 次**（§4）——running counter 自 MT009/MT014 起已漂移，本票沿用；实质纪律无损。建议后续票改用「allowlist 第 N 项」口径。
2. **【文档计数】报告「prereq 66/66」应为 67/67**（§5）——少记 1 条；逐条复算行为完好（今日 65+2 与装配披露精确吻合），无实质遗漏。
3. **【测试 nit】AC2 首用例的 epoch 断言引用了 B 公司基线**（`promoteReport.membership.epoch` 对比 `(beforeB?.epoch ?? 0) + 1`，应为 A 公司 `beforeA`）——当前夹具两家 epoch 同为 1，断言成立；若未来两公司 epoch 基线分化，该断言会产生**假失败**（不是假通过，无掩盖风险；A 侧 epoch 仍经报告值与 afterB 逐项相等间接钉住）。建议后续顺手改为 beforeA。
4. **【观察】offboard 不校验目标 principal 的全局状态**——与 AC1「全局身份保留」及票面范围一致（公司面动作不触身份面，测试已结构断言三角色零特权），非缺陷，仅记录设计边界。

## 8. 最终判定

**PASS。** 四条验收全部由真实 RLS 下的端到端用例钉死并独立复现；GRANT 窄例外最小性成立且活库证实；审计通道封闭且 MUT11 由真实 RLS 拒绝杀伤；TDD 链与变异 14/14+1 证据齐全可信；593/16/typecheck/biome 全部独立复现。装配以哈希密码学核对为纯追加。2 条文档计数误差 + 1 条测试基线 nit 均不阻塞，无需修改被审文件。
