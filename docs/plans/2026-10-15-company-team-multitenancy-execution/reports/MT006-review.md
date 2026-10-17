# MT006 / Issue #49 — 独立复审报告

- Reviewer：独立 Pi Reviewer（task `task_2cc0673c78d3` / dispatch `ctx_bb502a2b7d1c`；与实现者无共享会话）
- 工作树：`/Users/wuyongjun/orca/workspaces/OpenBot/i6-review-mt006`；BASE `f0520524`（= manifest 首行）
- Brief：`MT006-review-brief.md`（worktree 根，coordinator 下发的接管版）
- 日期：2026-10-16（UTC）
- 只读约束遵守：本报告为本次复审新建/修改的唯一文件（快照修复除外，见 Finding-1，由 coordinator 亲自执行）

---

## Verdicts

| 结论 | 判定 |
|---|---|
| Spec compliance（Issue #49 四条验收） | **PASS（4/4）** |
| Code quality | **PASS**（无 critical/high/medium；low ×1、info ×5，见下） |
| 快照核验 | **PASS**（见下节；含一次已裁决修复的 post-delivery 删失事件，不影响交付物判定） |
| 独立复跑 | **PASS**（34/0、182/0/0skip、typecheck 0、biome D5 一致；命令与退出码见 §4） |
| TDD / 变异真实性 | **PASS**（RED 存档真实、5/5 变异被杀、D7 序列诚实披露；见 §5） |

---

## 1. 快照核验（先做，全部独立复算）

- `git rev-parse HEAD` = `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` = `review-sha256-manifest.txt` 首行 BASE。✅
- `checkpoints/MT006/review-sha256-manifest.txt` 31 个文件逐文件 `shasum -a 256` 复算：**31/31 全部一致**（无 MISMATCH/MISSING，退出路径干净）。✅
- prereq 不变面（`checkpoints/prereq-manifest.txt`，19 文件）：18/19 逐字节一致；唯一 DIFFERS 为 `server/src/index.ts`，其实际哈希 `ab32a9b1…` 与 `checkpoints/MT006/after-hashes.txt` 声明值**逐字节一致**——即本票票面授权的路由装配段追加。✅
  - 因此报告「store.ts / scope-gate.ts / MT001-MT005 交付测试文件未触碰（哈希证）」的声称**独立成立**。
- git 状态与 brief 预期一致：`M app.ts / M config.ts / M enterprise-tenancy.ts / M store.ts / M index.ts` + 清单内 untracked（含本票 4 个新文件）。
- **纯追加核验**：`git diff server/src/{app,config,index}.ts` 与 `checkpoints/MT006/changes.diff` 对应段 **`diff -u` 逐字节一致**（exit 0）。app.ts、config.ts 两个 hunk 全为 `+` 行（纯追加）；index.ts 三段变化 = import 块追加 + workspace-scope 路由装配段追加 + `createApp` 命名对象一行注册；其中 `x-openbot-tenant-id → x-openbot-tenant` 两行属 MT005 已集成交付的头名改动（changes.diff 头注明示，非本票改动）。未触碰 MT013 启动校验段。✅

### Finding-1（info，快照事件，非交付物缺陷）

`server/tests/multitenancy/support/workspace-scope.ts`（declared `a67cf0b8…`，列于 `review-package.json` 与 `sha256-manifest.txt`、被 `workspace-scope.test.ts:30` 导入、承担报告 §1.4/D1 的 operator DELETE 策略供给）在复审开始时**从工作树缺失**（~04:35 删失；疑似前一 reviewer 被平台强制终止的副作用，根树同期存在 `.!59529!.env` 中断残迹）。证据链：

- 缺失文件的**最终内容**可从 `changes.diff:2095-2496` 完整提取，提取物 `shasum -a 256` = `a67cf0b8c6d854c315b158d78224fa878ef720186fba0011c1a01905928c87d8`，与两份 manifest 及 `review-package.json` 声明值一致；
- reviewer 按 orchestration 规则 `ask` 升级，coordinator 裁决 #7（restore-and-continue）并亲自从实现树主副本恢复该文件；
- reviewer 独立复算恢复后文件哈希 = `a67cf0b8…`（与 manifest、changes.diff 提取物**三方一致**，且与提取物 `diff` 逐字节相同）。

该事件为 post-delivery 工作树损坏，交付时点文件存在且有 GREEN/回归证据；不影响对交付物本身的判定。**相关联的工具性提示见 Finding-2。**

### Finding-2（info）

`review-sha256-manifest.txt`（31 文件）未包含 `support/workspace-scope.ts`，而 `sha256-manifest.txt`（7 文件）与 `review-package.json` 包含之——两份清单口径不一致。review manifest 若作为完整性权威，应为交付物声明的超集；建议后续票修正清单生成方式（本次由 Finding-1 的三方哈希一致补足证据）。

---

## 2. 验收逐条结论（Issue #49 四条）

### AC1 成员事实列表 — PASS

- 列表唯一事实源 = 目录事务内 self-read RLS（`app.user_id`）下的 `enterprise_memberships`（join principals/tenants）+ `enterprise_workspace_memberships`（`status='active'`）（`workspace-admin.ts:130-190` 附近），与 MT005 resolver 同源。
- 资格判定 = tenant + principal + membership 三个 `active`（`workspace-admin.ts` lister `eligible` 过滤）；suspended 公司行整公司隐藏、suspended 团队行单团队消失——均有测试钉死（criterion 1 第 6/7 例）。
- 无权公司/团队存在性不泄露：查询经 RLS 只见本人行；团队名经 data 角色租户上下文读取，RLS 不可见行跳过而非编造。
- 测试覆盖 8 例（双向多公司、admin 空团队、401、显式空列表、无 current/default 字段钉死）。

### AC2 显式空状态、不回退默认，选择经裁决 #1 头 — PASS

- 正例：列表内每个 (company, team) 经 `x-openbot-tenant`/`x-openbot-workspace` 头过**真实 resolver** 选择成功。
- 反例：未列出团队 → `WORKSPACE_FORBIDDEN`；唯一团队成员缺 workspace 头仍 `WORKSPACE_REQUIRED`（不自动选唯一团队）；空列表用户选任何公司 → `TENANT_FORBIDDEN`；空白头同拒。
- 列表服务端永不携带 current/selected/default/active 字段（测试反射断言）；`GET /` 路由不读任何选择头。

### AC3 公司管理员集中管理 + operator/RLS + 与 MT005 gate 同 advisory 键串行化 — PASS

- 集中入口：创建/加入/停用/移除全部经 `createWorkspaceAdminService` 单一服务面 + `createCompanyAdminAuthorizer` 签发信任 context（WeakSet + freeze，与 `createScopeResolver` 同构）；路由面不存在旁路。
- 受限 operator 角色 + RLS：写路径全部经 `verifyOperatorDatabase` 验证的 operator 通道；每操作 `read committed + lock/statement timeout + set_config(…, true)`（事务本地）；写中途 `app.operator_principal_id` 从操作者 pin 切换至目标成员（MT004 update/DELETE 策略按该上下文收束行范围）。
- 事务内重验：`revalidateAdmin` 在同一 operator 事务内重验 active×2 + `tenant_admin` + epoch 等值 + principal 行（经 principals operator 策略 pin）；漂移 → `SCOPE_REVOKED`。stale-epoch、降级 admin、伪造/反序列化 context 三类越权均有测试。
- **串行化证据真实性**：`workspaceMembershipLockKey`（`scope-gate.ts` 与 `workspace-admin.ts` **同一键串** `["enterprise","workspace-membership",t,w,p]`），gate 持 `pg_advisory_xact_lock_shared`、管理写持 `pg_advisory_xact_lock`，`hashtextextended(key,0)` 同键共享/排他互斥；键序 tenant → membership → workspace-membership 两侧同序（gate 多一把 principal 共享锁，不构成环）→ 无死锁且强制串行。测试以真实 `createWorkspaceGate` 事务持锁、管理写以 lock timeout 失败、释放后立即生效——且移除/停用后下一 gate 事务立即 `WORKSPACE_REVOKED`/`WORKSPACE_FORBIDDEN`（测试 criterion 3 第 8/9/14 例）。**串行化与「移除后 gate 立即可见」均为真实数据库行为，非替身。**
- operator 通道未配置/校验失败 → admin 路由 503（`WORKSPACE_ADMIN_UNAVAILABLE` / unavailable routes），绝不宽松替身（index.ts 装配段 + `createUnavailableWorkspaceScopeRoutes`，均有测试）。

### AC4 管理权不隐含业务读权 — PASS

- 无团队行的 admin 连 scope 都签不出（`WORKSPACE_FORBIDDEN`）。
- **越权正证**：admin 经管理面显式自加入团队后，经真实 `requestAs`→reader 路径读团队资源仍 **404**（无 grant 即不可见），finally 中移除自加行复原。
- 管理面最小化：管理 DTO 仅含 membership 事实字段（workspaceId/principalId/status/epoch，反射钉死）；admin 服务对象无任何 resource/read 方法（反射钉死）。
- 403/404 语义：非成员建队/跨公司管理 → `TENANT_ADMIN_REQUIRED`/`TENANT_FORBIDDEN`（403）；非公司成员/未知 principal 加入 → 同码 404 不可区分（不泄露存在性）；跨公司团队移除 → 404 且零写入（数据库侧查证行完好）。

---

## 3. Findings（按严重度；均不阻塞交付）

| # | 级别 | 位置 | 内容 |
|---|---|---|---|
| 1 | info | 工作树/`changes.diff:2095-2496` | 快照删失事件：`support/workspace-scope.ts` post-delivery 缺失，coordinator 裁决 #7 恢复，三方哈希一致补证；非交付物缺陷（详见 §1 Finding-1） |
| 2 | info | `checkpoints/MT006/review-sha256-manifest.txt` | review manifest 未含 declared 交付物 `support/workspace-scope.ts`（7 文件版含）——清单口径不一致，建议修正生成方式（详见 §1 Finding-2） |
| 3 | low | `workspace-scope-routes.ts`（`POST /admin/teams`）vs `workspace-admin.ts` `createTeam` | 空 `workspaceId` 处理不对称：路由层 `WORKSPACE_ID_PATTERN` 把 `""` 拒为 `INVALID_REQUEST`（400），服务层却把 `""` 视为「生成 id」（`requestedId !== ""` 分支自路由面不可达，属死分支）。无害，但两端口径建议对齐 |
| 4 | info | `workspace-scope-routes.ts` `errorResponse` | 映射表含 `WORKSPACE_FORBIDDEN`/`UNVERIFIED_SCOPE` 等 store.ts 语义码，本路由面不会抛出——共享映射表的无害冗余 |
| 5 | info | `workspace-admin.ts` lister | 每个有团队的公司各起一个 data 事务补团队名（N+1 形状）——受 per-tenant RLS 上下文约束属必要形状；预期规模下无问题，留作规模信号 |
| 6 | info | `red-green/GREEN-1-mt006-suite.txt` | GREEN 存档为 33/33（demoted-admin 用例补写前）；报告 §3 已诚实披露序列，最终 34 用例态由 182 = 148+34 回归与本次独立 34/0 复跑共同证明 |

## 4. 独立复跑（全部亲自执行；退出码为实测）

环境：`docker rm -f` 后全新 `pgvector/pgvector:pg16` 容器 `127.0.0.1:55463`（复用被拒——前任容器残留其自身 LOGIN 角色与未知口令，独立性要求重建）；双库 `openbot_enterprise_mt006_review` + `openbot_enterprise_mt003_assigned`；受限登录三角色由 reviewer 自备 URL（随机口令，0600 env 文件置于 `/tmp`，用后已删）。

| # | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 1 | `shasum -a 256`（review manifest 31 文件逐个） | 0（全匹配） | 31/31 一致 |
| 2 | `shasum -a 256`（prereq 19 文件逐个） | — | 18/19 一致；index.ts = after-hash `ab32a9b1…` |
| 3 | `git diff <3 文件>` vs `changes.diff` `diff -u` | 0 | 逐字节一致 |
| 4 | `bun scripts/enterprise-test-db.ts migrate` | 0 | schema + ob_ent_* capability 角色 + 3 登录角色 |
| 5 | `bun --no-env-file scripts/multitenancy/migrate-test.ts generate MT004 --out /tmp/…` | 0 | **planDigest `39b91e0f…` 与报告声称一致** |
| 6 | `… migrate MT004 --apply --manifest …` | 0 | 20 张 enterprise 表 + RLS 落库 |
| 7 | `bun test tests/multitenancy/workspace-scope.test.ts --timeout 30000` | **0** | **34 pass / 0 fail**（105 expect） |
| 8 | `MT003_ASSIGNED_TEST_DATABASE_URL=… TEST_DATABASE_URL=… ENTERPRISE_TEST_*… bun test tests/multitenancy/ --timeout 30000` | **0** | **182 pass / 0 fail / 0 skip**（7422 expect，7 文件，313s） |
| 9 | `cd server && bun run typecheck` | **0** | `tsc --noEmit` 干净（高负载机器 ~6 分钟） |
| 10 | `bunx biome check`（4 新文件） | **0** | **0 findings** |
| 11 | D5 比对：BASE `git show f0520524` 提取物（/tmp 镜像 biome.json 保持 `server/src/**` override 生效）vs 改后同名文件 | — | index.ts 6e+1w、app.ts 2e+1w、config.ts 1e —— **BASE 9 errors + 2 warnings = CURRENT 9 errors + 2 warnings，净新增 0** |
| 12 | `grep -c "(skip)"` 回归输出 | 0 行 | **0-skip 声明真实**（含 MT003 assigned-db real-apply 实跑） |

复跑备注：第 7 项首次尝试未带 `--timeout` 时 beforeAll 钩子撞 bun 默认 5s 上限（高负载机器上夹具冷启动 >5s；本次机器同时运行 5+ 个其他 agent 的 tsc/test 负载）——改用与回归一致的 `--timeout 30000` 后全绿。属测试基建超时参数问题，非交付缺陷；建议后续把夹具重套件的超时参数固化为惯例。

## 5. TDD / 变异真实性

- **RED 存档真实**：`red-green/RED-1-modules-missing.txt` 为真实 `bun test` 输出（`Cannot find module …/workspace-scope-routes`，0 pass / 1 fail / exit 1）。
- **GREEN**：33/33 → 补 demoted-admin 用例 → 34（第 4 节表格与回归 182=148+34 互证；Finding-6）。
- **5/5 变异全部被杀**：MUT1（lister 删 active 过滤，2 例）、MUT2（空列表注入 default，2 例）、MUT3（删角色+epoch 检查，2 例）、MUT4（仅删 epoch，1 例）、MUT5（删目标公司成员检查，1 例）——逐条记录为真实测试失败输出（如 MUT2 记录 31 pass / 2 fail / exit 1，失败用例名与 README 表一致）。
- **D7 自我修正序列诚实**：MUT3 首轮仅 1 例（角色半边被 authorizer 签发侧同名检查遮蔽）→ 按 MT005 M4 先例补钉「降级 admin → SCOPE_REVOKED」用例（钉既有行为、立即通过）→ MUT3 重跑 2 例。角色变更经 setup 通道的事实已在报告 §4/D2 披露。
- **变异后复原**：当前 `workspace-admin.ts` sha256 = `07767157…80ee30` = `mutation/pre-mutation-hash.txt` = review manifest 值，三方一致。✅

## 6. D1/D2 替身处置意见

- **D1（operator DELETE 策略由测试支撑文件供给）— 接受**。理由：(a) 生产写路径本身经受限 operator 角色 + **真实 RLS 策略**执行并被测试证明（跨公司 404 零写入、pin 切换行为、缺失行 404 均为数据库侧行为）；(b) 供给方式幂等（pg_policies 目录查重）且策略语义与 MT004 update 策略同构（tenant + operator_principal pin 至目标成员）；(c) 不注册 migrate-test 新任务的原因是硬约束——`migration-tool.test.ts:347` 把 `ALLOWED_TASK_IDS` 钉死为 `["MT000","MT004"]`，注册表追加必然破坏 MT001-MT005 只读基线。**条件**：生产 DELETE 策略迁移必须落在 schema 链后续票（报告已承诺）；建议把该后续票显式建票跟踪，否则 remove 在未打补丁的生产库将 500（fail-closed，不泄露，但功能缺失）。
- **D2（降级通道超级用户替身）— 接受**。被钉的判定面（`revalidateAdmin`）全部经 operator 角色真实 RLS 得出；setup 连接仅翻转事实（role 列），operator 的 UPDATE 列授权仅 status/epoch 属 MT004 事实；与 MT005 D4 同类先例，披露诚实且 finally 复原。

## 7. 复审者清理声明

专用容器 `mt006-review-pg` 已 `docker rm -f`；`/tmp` 下 env（0600）、提取物、biome 镜像目录已删；工作树仅新增本报告（外加 coordinator 裁决 #7 恢复的交付物文件，哈希三方验证一致）。

— MT006 independent Pi Reviewer，2026-10-16（UTC）
