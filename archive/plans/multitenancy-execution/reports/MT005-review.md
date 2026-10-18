# MT005 / Issue #48 独立复审报告（Independent Pi Reviewer）

- 审阅人：独立 Pi Reviewer（与实现者 task_70d54b54ba2e / ctx_2a8e4c341143 无共享会话）
- 工作树：`/Users/wuyongjun/orca/workspaces/OpenBot/i6-review-mt005`，BASE `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`
- 审阅契约：`docs/plans/2026-10-15-company-team-multitenancy-execution/briefs/MT005-review-brief.md`（绝对权威）
- 性质：只读复审；本文件是本次任务唯一新建/修改的文件（另有 1 个经 coordinator 裁决 #6 授权的快照修复复制，见 §1.2）
- 无提交/推送/合并；被审文件零修改

---

## 0. Verdicts（两个独立结论）

| 结论 | 判定 |
| --- | --- |
| **Spec compliance（Issue #48 五条验收）** | **PASS** —— 五条全部由真实受限角色测试钉住，并在本工作树独立环境（专用 pgvector/pgvector:pg16 @127.0.0.1:55460）复现：scope-gate 套件 23/0、全回归 148/0/0 skip（含 MT003 assigned-db 正向运行）、typecheck 0、biome 与 HEAD 存量基线完全一致。 |
| **Code quality** | **PASS（无 critical/high/medium 代码 finding）** —— seam 落点、gate 事务形状、裁决 #1/#2、expand-only 边界全部核实。findings 见 §3：medium ×1（快照打包缺陷，非代码）、low ×1（MT004 时代 checkpoint 工件不一致，非 MT005 代码）、info ×3。 |

**总体验收结果：succeeded**（快照修复经授权后，全部指定复跑完成，无遗留 blocked）。

---

## 1. 快照核验

### 1.1 Manifest 复算

- `git rev-parse HEAD` = `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` = manifest 首行 BASE ✓
- `review-sha256-manifest.txt` 逐条复算：**40/40 OK，`shasum -a 256 -c` 退出码 0** ✓
- 预期 git 状态核实：`server/src/db/schema/enterprise-tenancy.ts` tracked ` M`（MT004 交付，本票零改动，哈希 `c4fc5145…` 与 prereq 链一致）；其余清单内文件全部 untracked ✓

### 1.2 Coordinator snapshot repair（裁决 #6）

**发现**：`review-package.json` 的 `newFiles` 与实现者 `sha256-manifest.txt`（第 9 行）均声明 `server/tests/multitenancy/support/scope-gate.ts`（哈希 `7f32f54383babe7f94fca2f8c75d7422c127d2a5bdfa7d3b7e9165ae767a787d`），但该文件**既不在 `review-sha256-manifest.txt`，也不在工作树**。它是 `scope-gate.test.ts` 的唯一缺失 import（`createScopeGateFixture`），缺它则 23 用例套件与全回归均无法加载 —— 指定复跑被阻塞。

**处置（经 coordinator `ask` 授权，裁决 #6）**：
1. 复制前复算 `i6-mt005/server/tests/multitenancy/support/scope-gate.ts` = `7f32f543…` ✓（与快照内三处声明一致：review-package.json、sha256-manifest.txt、coordinator 独立复算）
2. 复制到本工作树后落盘哈希复算 = `7f32f54383babe7f94fca2f8c75d7422c127d2a5bdfa7d3b7e9165ae767a787d` ✓
3. 缺失根因：coordinator 转移清单人工遗漏（support/ 下仅列 fixture.ts 与 scenarios.ts）
4. 该文件随后纳入审阅对象（见 §2.6）

修复后 41 个审阅对象文件全部哈希核实。**此为本次复审对工作树的唯一写入（除本报告）**。

---

## 2. 审阅要点逐项结论

### 2.1 seam 落点（对照 `reports/seam-identification-mt005.md`）✓

- 扩展确在 `createScopeResolver.resolve`（`server/src/enterprise/tenancy/store.ts:92-160`）：选择子拆分（`TENANT_REQUIRED`/`WORKSPACE_REQUIRED`，纯追加替换原双义判断）+ 团队资格判定（`WORKSPACE_FORBIDDEN`）+ `set_config('app.workspace_id', …, true)`，全部为纯追加；git diff 证实无既有语句删除/改写。
- proactive 侧 `resolveScope`（`deliveryScopeFor`，index.ts:2875 实现 / :2985 注入）**未触碰** —— `git diff server/src/index.ts` 仅含 802-806 一个 hunk（2 行头名 + 2 行注释），无其他改动。
- 裁决 #2 ✓：全仓 grep `conversations-v1` 仅命中两处**声明其不存在**的注释（scope-gate.ts:15-16、scope-gate.test.ts:21）；无任何新策略版本常量。

### 2.2 D1 重点：MT002 交付文件集成最小性 ✓ / 403-vs-404 语义正确性 ✓

以 prereq-manifest before 哈希（`f1112f0f…`/`667dd64e…`）在 i6-mt004 工作树定位 before 内容（哈希逐一相符）后自建 diff：

- **`support/fixture.ts`：恰好 3 块，全部纯追加**：
  1. 头注释「Current-shape note」→「MT005 note」（仅注释，无代码）；
  2. provisioning 后追加团队行插入（经受限 operator 角色 + 租户上下文 RLS，`insert into enterprise_workspace_memberships`），与 changes.diff 披露逐字一致；
  3. `ROUTE_ERROR_STATUS` 追加 `WORKSPACE_FORBIDDEN→403`、`WORKSPACE_REVOKED→403` 两映射。
  无任何既有语句删除/改写。
- **`fixtures.test.ts`：恰好 2 处断言改动**（跨团队读取、company-admin 读取：`404 RESOURCE_NOT_FOUND` → `403 WORKSPACE_FORBIDDEN`），其余 **19 个 MT002 断言逐行未动**（自建 diff 证实，仅伴随 2 处注释更新）。
- **语义判定：403 改动正确**。MT002 时代「团队资格=per-team grant」是 MT004 前的临时事实（fixture 头注释自述）；MT005 后资格是服务端真实行。测试显式钉住「真实但非成员的 team-a2」与「不存在的 workspace」错误码完全一致（`WORKSPACE_FORBIDDEN`）——403 泄露的只是调用者自身的资格缺失，不泄露目标存在性；同队内资源级 404 不可见断言原样保留。与 `TENANT_FORBIDDEN→403` 先例一致。

### 2.3 gate 事务形状 ✓（`server/src/enterprise/tenancy/scope-gate.ts`）

逐项对照 `conversations/store.ts:21-99` 标准形状：

| 形状要素 | conversations/store.ts | scope-gate.ts | 一致性 |
| --- | --- | --- | --- |
| `assertTrustedScope` 先于触库 | :25 | :54 | ✓ |
| read committed + lock_timeout 2s + statement_timeout 5s | :27-29 | :56-58 | ✓ |
| `set_config(…, true)` 全事务本地 | tenant/principal/user | + `app.workspace_id` | ✓（4 键全部 `true`） |
| advisory 共享锁顺序 | tenant→principal→membership | tenant→principal→membership→**workspace-membership** | ✓ 新键插在 membership 后（= seam 报告 §4.3 建议位置，在 resource 键之前；readLockKeys 的 tenant→principal→membership→resource 与之相容） |
| 公司重验 | status×3 + epoch + actor 绑定 → `SCOPE_REVOKED` | 同一判定集 | ✓ |
| 团队重验 | —（无） | 行存在 + `status='active'` → `WORKSPACE_REVOKED` | 新增，覆盖删除（行消失）与停用（status） |
| operation 在全部校验后执行 | ✓ | ✓（:131，最后一步） | ✓ |

管理写路径（support/scope-gate.ts 的 grant/suspend/remove）对同一键 `["enterprise","workspace-membership",tenant,workspace,principal]` 取**排他**事务锁，与闸门**共享**锁构成读写串行化 —— 与测试内 lock_timeout 探针断言一致。

### 2.4 验收 3「撤权即拒」证据真实性 ✓

- 同事务后续：suspended 后 gate → `WORKSPACE_REVOKED` 且 `operationRan === false`（criterion 3 用例 1/2/3）；
- 下一次请求：`resolve` → `WORKSPACE_FORBIDDEN`（同用例）；
- 串行化证明：in-flight gate 持锁期间，撤权写以 `canceling statement due to lock timeout` 失败（criterion 3 用例 4），提交后撤权立即生效、旧 scope 随即被拒。**我在独立 psql 会话用裸探针复现了同一语义**（见 §4.7）。

### 2.5 验收 4 跨公司隔离 + stale-epoch ✓

- 公司 A 暂停 → A 侧 `resolve`/gate 双双被拒（`TENANT_FORBIDDEN`/`SCOPE_REVOKED`），同身份公司 B 正向放行（正反两测）；
- stale-epoch 用例（M4 暴露缺口后 test-first 补写）真实存在（scope-gate.test.ts criterion 4 用例 3）：epoch+1 且 status 保持 active → 旧 scope 即刻 `SCOPE_REVOKED`、新 scope 携新 epoch 放行；被 M4v3 变异 RED 捕获、还原后 GREEN。

### 2.6 验收 1/2/5 与头只做选择 ✓

- 验收 1：本栈信任机制 = `issuedScopes` WeakSet + `Object.freeze` + `assertTrustedScope`（seam 报告 §1.1 证实等价保留）；测试钉住手造/JSON 反序列化/structuredClone 全部 `UNVERIFIED_SCOPE`，gate 对伪造 scope 在触库前拒绝且 operation 不执行。测试钉的是真实机制而非旧栈私有构造器，判定成立。
- 验收 2：无 tenant → `TENANT_REQUIRED`；有 tenant 无 workspace → `WORKSPACE_REQUIRED`（即便成员只有一个团队，不回退）；空白头同样拒绝；company-admin（无团队行）→ `WORKSPACE_FORBIDDEN` 不自动准入。
- 验收 5/裁决 #1：头名改动核实为 `server/src/index.ts:804`/`:806` 两行（`x-openbot-tenant`/`x-openbot-workspace`）；篡改 workspace/tenant 头分别 `WORKSPACE_FORBIDDEN`/`TENANT_FORBIDDEN`；头不变而服务端状态翻转 → 结果翻转。
- 旧头名残面：`runner-production.test.ts:1164`、`:1616` 两处 `x-openbot-tenant-id` 为**故意伪造**惰性头，断言「wire 值不产生权威」（scope.tenantId = `tenant-actor-a`，绝非 `tenant-evil`），改名后依旧成立，未动正确（finding I-1）。
- support/scope-gate.ts（快照修复后补审）：fixture 的 resolver/selectors/requestFor 均用裁决 #1 头名；admin 写与 `bumpCompanyMembershipEpoch` 均持排他事务锁；dispose 先清自有行再释放 MT002 夹具。实现与披露一致。

### 2.7 D2/D3/D4 披露合理性

| 披露 | 复核 | 处置意见 |
| --- | --- | --- |
| **D2** resolveForThread 不扩展 | `git diff` 证实 `resolveForThread`（store.ts:162-443）零改动 | **可接受**。MT004 前会话无团队行，扩展会静默收紧既有语义，违反 expand-only；gate 判定面 = resolve() + 业务事务，与票面一致。线程路径团队判定归后续接线任务（建议在后续票验收中显式覆盖）。 |
| **D3** 团队 epoch 不入 PlatformScope | scope 形状仅 `memberEpoch`（公司级）；团队重验=存在+active | **可接受，已缓解**。移除（行删）与停用（status）均被钉住；残余窗口 = 「撤权后无任何 gate 事务介入即重授权」时已签发 scope 对该次撤销不可见 —— 缓解为 gate 每事务重验 + 下一次 resolve 重新签发。公司级 epoch 等值已钉死并被变异捕获（M4）。属形状约束的诚实披露，无需升级。 |
| **D4** 管理写路径超级用户替身 | 授权面核实：`ob_ent_operator` 对该表仅 SELECT/INSERT（information_schema.role_table_grants 实查），无 UPDATE/DELETE；UPDATE policy 钉 `app.operator_principal_id` 而生产无写路径设置它 | **可接受**。判定侧（resolver/gate/RLS 读）全部经受限 directory/data 角色真实 RLS 得出；超级用户仅是离线管理通道的替身，且排他锁纪律与生产一致。与 seam 报告 §2.4「operator 离线通道」框架吻合。 |

### 2.8 TDD 真实性与 D5

- RED-1（模块缺失，1 error）→ RED-2（9 pass/13 fail，resolve 侧断言）→ GREEN（22/22 → 23/23）存档链完整（red-green/*.log）。
- M4 首轮 22/22 逃逸被**诚实记录**（M4v2），随后 test-first 补写 stale-epoch 用例：M4v3 RED（1 fail）→ green-stage5 23/23。M2/M3 v1 的模块级错误/钩子超时在 results.txt 中注明作废，以断言级证据为准。变异后生产哈希复原（本快照 manifest 复算 40/40 OK 即为佐证）。
- **D5 核实**：以 HEAD 内容 + 仓库 biome 2.5.10 + 仓库 biome.json 建立基线（注意：biome 的 override 规则依赖项目根解析，跨根 `--config-path` 会漏报 —— 首次基线尝试因此失真，已用正确项目根重跑）：HEAD 基线 = **noNonNull ×1（warning）+ organizeImports ×1 + noConsole ×5 + format ×1 = 7 errors + 1 warning**，与本工作树触及文件完全同集同数；行号偏移（noNonNull 4541→4543、store noConsole 69→70）纯为追加行的位移效应。5 个新增/改动的 MT005 文件 0 诊断。D5 披露准确，expand-only 不动存量成立的论证成立。

---

## 3. Findings

| # | 级别 | 位置 | 内容 |
| --- | --- | --- | --- |
| F-1 | **medium**（流程，非代码） | `checkpoints/MT005/review-sha256-manifest.txt`（缺失项） | 审阅快照遗漏声明文件 `server/tests/multitenancy/support/scope-gate.ts`（review-package.json `newFiles` 与实现者 sha256-manifest.txt 均含它），导致指定复跑在快照内不可执行。已经裁决 #6 哈希校验修复并完成全部复跑。建议 coordinator 修正转移清单流程：`review-package.json.files` 与 `review-sha256-manifest.txt` 应由同一生成物派生。 |
| F-2 | **low**（MT004 时代工件，非 MT005 代码） | `checkpoints/MT004/generated/`（各前置工作树） | 该目录的 `manifest.json` planDigest=`380faa4b…`（10 语句，无 FORCE RLS），而当前 `migrate-test.ts`（哈希 cb0891c6，跨 MT003→MT005 声明 byte-unchanged 且本快照核实）确定性生成 planDigest=`39b91e0f…`（11 语句，含 `ALTER TABLE … FORCE ROW LEVEL SECURITY`，与 drizzle `enableRLS()` 语义一致）。两者不可能出自同一工具字节 —— MT004 时代的 generated 工件早于当前工具状态或经手改，prereq 链对 `migrate-test.ts` 的「unchanged」记录与工件不一致。对 MT005 无影响：apply 门禁按 digest 拒绝陈旧 manifest，实现者 setup 必然使用当前 plan（其 apply exit 0），我方环境同路径复现。建议后续票重新 generate 一次入档以消除歧义。 |
| I-1 | **info** | `server/tests/enterprise/runner-production.test.ts:1164`、`:1616` | 两处故意伪造头仍用退役名 `x-openbot-tenant-id`。断言语义（wire 值非权威）与头名无关、依旧成立，expand-only 未动可接受；但保留旧名可能误导后来者以为该头仍有效。建议后续卫生批次改为新头名（断言不变）。 |
| I-2 | **info** | `server/src/enterprise/tenancy/scope-gate.ts:124-130`（对照 conversations/store.ts:46-84） | conversations 版公司重验 JOIN `enterpriseWorkspaces`（要求 workspace 行存在），gate 版不 JOIN、由团队重验的存在性检查兜底（workspace 不存在 → 无成员行 → `WORKSPACE_REVOKED`）。语义等价且更集中，仅记录差异供后续统一共享 seam 时参考。 |
| I-3 | **info**（对 brief 的勘误） | 本报告 §4.6 | brief 预期「147/0/0 skip（w/ assigned-db env）」；实际带 assigned-db env 运行为 **148 pass / 0 fail / 0 skip** —— 原 skip 用例转为通过，计数 +1。实现者报告的 147/0/1 为无 assigned-db env 变体，两者自洽。 |

无 critical/high finding。无代码级 medium。

---

## 4. 独立复跑记录（全部亲自执行；专用库 pgvector/pgvector:pg16 @ 127.0.0.1:55460）

| # | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 4.1 | `lsof -i :55460`（预检） | 1 | 端口空闲 |
| 4.2 | `docker run --rm -d --name openbot-i6r2-mt005-pg -e POSTGRES_DB=openbot_enterprise_mt005_review -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55460:5432 pgvector/pgvector:pg16` | 0 | `PostgreSQL 16.15 (Debian 16.15-1.pgdg12+2) on aarch64…` 就绪 |
| 4.3 | `bun server/scripts/enterprise-test-db.ts migrate`（env 指向 55460；受限登录随机密码写 0600 env、库外临时文件） | **0** | `{"type":"migrations-applied","status":"ok"}` |
| 4.4 | `bun server/scripts/multitenancy/migrate-test.ts generate MT004 --out <库外临时目录>` → `migrate MT004 --apply --manifest …` | **0** | `applied: MT004`；实查 `relrowsecurity=t, relforcerowsecurity=t`，5 policies，`ob_ent_directory/data`=SELECT、`ob_ent_operator`=INSERT/SELECT（与 D4 披露一致） |
| 4.5 | `bun test server/tests/multitenancy/scope-gate.test.ts`（5 env 齐备） | **0** | **23 pass / 0 fail** / 49 expect()（首轮因探针还需 `ENTERPRISE_TEST_SETUP_DATABASE_URL` 显式 skip 25 —— skip 有名有因，不计通过；补 env 后全绿） |
| 4.6 | `cd server && MT003_ASSIGNED_TEST_DATABASE_URL=<同库> TEST_DATABASE_URL=<同库> ENTERPRISE_TEST_{SETUP,DIRECTORY,DATA,OPERATOR}_DATABASE_URL=… bun test tests/multitenancy/` | **0** | **148 pass / 0 fail / 0 skip**，15.0s，无需 `--timeout 30000`（见 I-3 勘误） |
| 4.7 | psql 裸探针（`pg_advisory_xact_lock_shared` vs `pg_advisory_xact_lock`，同键） | — | 持共享期间排他尝试 → `ERROR: canceling statement due to lock timeout`（exit 3）；共享+共享立即成功；释放后排他成功 —— 与闸门(共享)/撤权写(排他)串行化语义及测试断言一致 |
| 4.8 | `cd server && bun run typecheck` | **0** | `tsc --noEmit` 干净 |
| 4.9 | `bunx biome check`（触及 7 文件，仓库 biome 2.5.10 + 仓库 biome.json） | 1 | 7 errors + 1 warning **全部为 HEAD 存量**（HEAD 基线同集同数，§2.8/D5）；5 个新增/改动 MT005 文件 0 诊断 |
| 4.10 | 清理 | — | 容器删除（`docker ps -a` 无残留、端口复测空闲）、0600 env 文件 shred 删除、临时目录删除 |

环境阻塞项：无（快照修复后）。

---

## 5. 哈希与证据索引

- 审阅快照 manifest：40/40 OK（`shasum -a 256 -c`，exit 0）；修复文件前后哈希 `7f32f54383babe7f94fca2f8c75d7422c127d2a5bdfa7d3b7e9165ae767a787d`（三处声明 + 复制前后实测一致）。
- D1 before 状态定位：i6-mt004 工作树 `fixture.ts`=`f1112f0f…`、`fixtures.test.ts`=`667dd64e…`（与 prereq-manifest before 值逐一相符）。
- expand-only 零改动核实：`conversations/store.ts`、`contracts.ts`、`authz/service.ts`、`provision.ts` 与 `git show HEAD:` 逐一 diff 为空。
- 被审文件全部只读；未修复、未提交、未推送、未合并。

## 6. 结论

MT005 在其票面契约内实现完整且诚实：seam 落点与 seam 报告一致、五条验收全部有真实受限角色测试并在独立环境复现、D1 集成最小且 403 语义正确、D2/D3/D4 边界披露与代码事实相符、TDD 与变异证据链真实（含 M4 缺口的诚实自曝与修补）。代码质量无 critical/high/medium finding；F-1（快照打包）与 F-2（MT004 时代工件）为流程/档案级事项，已分别以裁决 #6 修复与勘误留档。

— Independent Pi Reviewer，2026-10-16（UTC）
