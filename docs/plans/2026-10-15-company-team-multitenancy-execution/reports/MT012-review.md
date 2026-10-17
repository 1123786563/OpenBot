# MT012 / Issue #55 — 独立复审报告（reviewer 会话）

- 复审者：独立 Pi 会话（Orca `task_5508aa21e0db` / Dispatch `ctx_e22ec2afca17`），与实现者无共享上下文。
- 日期：2026-10-16。工作树 BASE `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（实测 `git rev-parse HEAD` 一致）。
- 输入：`briefs/MT012-review-brief.md`（七项重点裁决 + 独立复跑门槛）。只读被审文件；未修复、未提交、未推送。
- **结论：通过（PASS，无阻断项）**。全部独立复跑门槛达标（§2），七项重点裁决逐项核验（§3），两项非阻断观察记录在 §5。

---

## 1. 工作树完整性与纯追加/窄例外核验（裁决 A）

- **prereq-manifest 29 项逐文件复算**：27 项未触及文件 SHA-256 与 manifest 逐字节一致；仅两个本票授权文件（`migrate-test.ts`、`migration-tool.test.ts`）不同，且分别等于 `after-hashes.txt` 记录值（`8d1d6ab6…`、`4ede3c5f…`）。✅
- **pristine 重建核验（两文件均独立执行）**：
  - `migrate-test.ts`：对当前文件反向应用存档 `changes.diff` 的 migrate-test 段 → SHA-256 = `c5bfb3d4…`（pristine）逐字节一致；diff 中该文件 0 删除行（唯一 `^-` 行属于另一文件），纯追加成立。✅
  - `migration-tool.test.ts`：反向应用 `migration-tool.test.diff` → SHA-256 = `c7569901…`（pristine）逐字节一致；唯一删除行 = 被多行化替换的原 `ALLOWED_TASK_IDS` 断言行，新增 = 3 行裁决注释 + 展开断言；注释形态与 diff 上下文中可见的 MT008 先例（ruling #5）完全同构。✅
- **新建文件**：`rls-core.test.ts` SHA-256 = `c25ebf15…`，与 `after-hashes.txt` 一致。
- **checkpoint 存档自洽**：`sha256-manifest.txt` 25 项中 24 项复算一致；唯一"失配"是清单对自身的自引用行（数学上不可满足，benign）。
- **变更面**：`git status` 的其余 modified/untracked 文件全部属于前置转移（哈希已由 manifest 钉死）；本票触碰面 = 报告 §8 声称的 2 改 + 1 新 + checkpoint/报告，无越界。✅

## 2. 独立复跑（全部亲自执行，退出码实测）

环境：端口预检 `lsof -i :55474` 空闲 → 专用容器 `mt012-review-pg`（`pgvector/pgvector:pg16`，`POSTGRES_HOST_AUTH_METHOD=trust`，仅 `127.0.0.1:55474` 回环映射；实现者首启用的 `-c trust` 形式被镜像拒绝，改用等价 env 形式——同语义）。**psql 探针**（`select version()` → PostgreSQL 16.15）就绪后方进入迁移，非仅 pg_isready。五变量 URL：setup 两变量显式 `postgres` 用户；三登录 `ent_mt012rev_{directory,data,operator}` 随机 32-hex 口令，仅存 0600 临时 env 文件（`/tmp`），用后删除，口令未打印未落盘。

| # | 命令（server/ 目录） | 实测结果 | 退出码 |
| --- | --- | --- | --- |
| 0a | `bun scripts/enterprise-test-db.ts migrate`（五变量 env） | `{"type":"migrations-applied","status":"ok"}`，三登录已 provision | 0 |
| 0b | `generate MT004 --out` + `migrate MT004 --apply --manifest`（前置） | `applied: MT004 … 已执行并记入 journal`（注：裸 `--apply` 无 `--manifest` 会被工具 refused，符合设计） | 0 |
| 1 | `bun test tests/multitenancy/rls-core.test.ts --timeout 30000` | **32 pass / 0 fail / 0 skip**（311 expect；MT112/MT008/MT012 由 beforeAll 真实 apply，journal 收敛） | **0** |
| 2 | `MT003_ASSIGNED_TEST_DATABASE_URL=… bun test tests/multitenancy/ --timeout 30000` | **264 pass / 0 fail / 0 skip，10 文件**（8147 expect；基线 232 + 本票 32） | **0** |
| 3 | CLI 链 `migrate MT012`（dry-run）→ `generate --out`→ `--apply --manifest` → 重复 `--apply` | dry-run `journal: 已应用 2/2`；apply/重放均 `up-to-date: 已应用 2 步，无需执行`；再生成文件与 `checkpoints/MT012/generated/MT012/` **逐字节相同**（diff -r 为空，planDigest `dbdb978a…` 一致，确定性生成坐实） | 0 / 0 / 0 / 0 |
| 4 | `bun run typecheck`（server） | `tsc --noEmit` 无输出 | 0 |
| 5 | `bunx biome check`（三触及文件） | `Checked 3 files … No fixes applied` | 0 |

expect 计数微差说明：本复跑 311/8147 vs 实现者存档 310/8144。差 1 来自 `dry-run previews honestly…` 用例内 `if (applied)` 条件断言——我的库是全新库、MT012 首次 apply 走 `applied` 分支（+1 expect）；实现者存档轮次时 MT012 已在 journal（`up-to-date` 分支）。其余 +2 为全套件中其他环境条件断言的同因微差。非缺陷。

## 3. 七项重点裁决

### A. 纯追加与窄例外最小性 — 通过
见 §1。`migrate-test.ts` 0 删除行（反向 patch 重建 pristine 哈希一致）；`migration-tool.test.ts` 唯一删除行 = 被替换断言行，注释形态与 MT008/MT112 先例同构；测试内 `the plan only appends…` 用例另以语句级白名单（无 DROP/INSERT INTO/DELETE FROM/CREATE|DROP POLICY；REVOKE/GRANT 仅限 `^REVOKE|GRANT EXECUTE ON FUNCTION`）钉死计划形状。

### B. REVOKE PUBLIC 语义面 — 通过
0002 共 3 条语句逐条审：(1) `CREATE OR REPLACE FUNCTION` 新对象；(2) `REVOKE EXECUTE ON FUNCTION … FROM PUBLIC`——PostgreSQL 函数默认对 PUBLIC 有 EXECUTE，该 REVOKE 仅收窄**本新函数**的默认授权面，语句对象明确指向 `ob_ent_reset_business_context()`，不触及任何既有对象；(3) `GRANT EXECUTE … TO ob_ent_directory, ob_ent_data, ob_ent_operator`——只新增授权。无任何对既有对象/策略/授权的收窄。运行时证据：套件内 apply 前后 `pg_policies` 计数与 `ob_ent*` 表级授权面快照逐字节相同断言通过；我另实测函数 proacl = `{postgres=X, ob_ent_directory=X, ob_ent_data=X, ob_ent_operator=X}`（PUBLIC 无、identity_operator 无）。expand-only 红线满足。

### C. 两侧对照真实性 — 通过（附一条保真度观察，见 §5-N1）
`dbSideRead` 是受限 data 角色事务内、经真实 RLS 过滤的行上直接计算的应用规则等价谓词。对照 `resource-policy.ts` 逐语义核验：own grant ∨ (visibility='workspace' ∧ 同团队有效成员) ∧ status='active'，同租户同团队由 WHERE `tenant_id/workspace_id` 钉住，与 `workspaceV1Decide`（baseline tenancy-v1 ∪ 团队公共放行、grant 路径不受成员状态影响）语义一致。**非自证循环的关键**：判定所依赖的事实（资源行可见性、grants 行、workspace_memberships 行）全部经真实 RLS 读取——跨公司行不可见折叠为 deny（与不存在同形，独立用例钉死）、grants/wm 受 restrictive own-principal 策略过滤（独立用例钉死他人事实 0 行可见）。对照断言强度诚实：9 个矩阵例 `db == workspaceV1` 双向全等；tenancy-v1 仅单向（allow ⟹ db allow），与其 ⊆ workspace-v1 的设计一致，未伪装成假双向。reader 状态码独立断言（200 仅授权路径，跟 tenancy-v1）。

### D. FORCE 语义 — 通过（目录级证据；附一条证据等级观察，见 §5-N2）
实测 9 表 `relrowsecurity`/`relforcerowsecurity` 全 `t`。测试用例逐表断言两标志。属主行为级约束（属主无策略 → 默认拒绝）在本环境不可直接实证：表 owner = `postgres`（superuser，实测 `pg_get_userbyid(relowner)`），superuser 无条件绕过 RLS，FORCE 对其无行为差异——实现者报告的表述（"属主不可绕过"挂在目录标志上）如实反映了这一证据等级，未夸大为行为实证。迁移机制本身正确：FORCE + 属主无 `TO` 策略即默认拒绝。

### E. 披露处置 — 通过
- **D1**（GREEN-1 27/5 测试侧缺陷）：存档 5 个失败用例名与三项原因（tenants 列名 `id`、数组参数化、`Bun.file` 深度）对应；最终文件中断言无弱化痕迹（矩阵例全等断言 + 0 行/行存活复核 + 23503/42501 精确码均在）。✅
- **D3**（catalog 快照经 setup 连接）：`information_schema.role_table_grants` 对非 grantor/grantee 确不完整可见，快照只读目录不触业务行，披露合理。✅
- **D4**（停用 stand-in）：`support/resource-policy.ts` 中 `setTeamMembershipStatus` 确经 setup（superuser）连接、只翻事实；两侧判定（dbSideRead/decide/reader）全部经受限角色 + 真实 RLS。✅
- **D5**（403 语义）：停用成员 reader 403 = 资格门先于资源存在性（MT005 seam 既定语义），与两侧 deny 结论一致，不泄露存在性。✅

### F. 变异真实性 — 通过
4/4 存档均以 DB 直改实施（计划内容不变——四份存档中 `the plan only appends…` 用例全 pass 可证实施未改迁移文件）：MUT1 撤销 data EXECUTE → 2 用例失败（执行 + 授权核验）；MUT2 漏清 `app.tenant_id` → 会话残留清理用例失败；MUT3 NO FORCE → FORCE 核验用例失败；MUT4 删 grants restrictive 策略 → 分享事实私有性用例失败。`RESTORE-green.txt` 32/0 复绿。失败用例名与变异点一一对应，无存档失败用例名缺失。

### G. 策略模板章节（§7）— 通过
抽查实测库内策略定义与模板逐条一致：data 读 `tenant_id = nullif(current_setting('app.tenant_id', true), '')`；grants 表 restrictive `principal_id = nullif(current_setting('app.principal_id', …))`（`enterprise_grant_self_read` RESTRICTIVE 实测在库）；operator UPDATE 钉 `id = nullif(current_setting('app.resource_id', …))`（`enterprise_resource_operator_update` 的 qual 与 with_check 实测一致）；directory 读 EXISTS 经 principals `user_id = nullif(...)`（`enterprise_workspace_membership_self_read` 实测同构）。上下文键清单 7 个与清理函数体逐键一致（`pg_get_functiondef` 实测）。模板可直接供下游复用。

## 4. 验收四条独立复核结论

1. **跨公司拒绝**：operator 9 表 SELECT 0 行、跨公司 UPDATE/DELETE 0 行且行存活、FK 三例 23503（复合 FK 内嵌 tenant_id）+ 重指列 42501、data/directory 写 42501、存在性不泄露（现存 vs 不存在逐字节同形）——用例齐备且在我复跑中全过。✅
2. **两侧一致**：见裁决 C。✅
3. **上下文清除 + 兜底**：三角色提交后同 backend PID 复用 + 7 键全空 + 0 行；回滚后干净；会话级残留经 `ob_ent_reset_business_context()` 清空（清理前 1 行可见 → 清理后 0 行）。✅
4. **无绕过角色**：3 capability + 3 login 角色 `rolsuper/rolbypassrls` 全 false（实测复跑通过）；identity_operator NOLOGIN、9 表四种 DML 全 false、无函数 EXECUTE（实测）、`ROLE_DATABASE_VARIABLES` 键 = 三业务角色；index.ts 装配静态核验（createDatabase 调用点白名单）。✅

## 5. 非阻断观察（不构成返工项）

- **N1（dbSideRead 保真度边角）**：dbSideRead 的 own-grant EXISTS 子查询未过滤 `g.action = 'read'`（decide() 的 LEFT JOIN 有 `action = 'read'`）；也未镜像 `revisionsAreSane`。在本 fixture 事实上（provisionDeployment 只造 read 授权、revision/aclEpoch 恒 sane）两侧判定重合，矩阵结论不受影响；若未来 fixture 引入非 read 动作的授权行，该谓词可能放宽 db 侧。建议下游复用模板时在对照谓词中带上 action 过滤。
- **N2（FORCE 证据等级）**：表 owner 为 superuser（postgres）时 FORCE 的属主约束只有目录级证据（relforcerowsecurity）。生产部署若主应用连接以非 superuser 属主连库，FORCE 的行为级效果值得在下游票据以一条属主角色实测钉死（当前测试环境无法表达）。

## 6. 复审环境清理

`docker rm -f mt012-review-pg` 已执行（`docker ps -a` 0 残留）；0600 env 文件已删除；随机口令未进入任何持久化产物；临时 /tmp 工作文件已清理。仓库工作树未被我修改（唯一新增 = 本报告）。
