# MT007 / Issue #50 — 独立复审报告

- Reviewer：独立 Pi Reviewer（task `task_31e2d9d68754` / dispatch `ctx_674db5bd9bd2`；与实现者无共享会话）
- 工作树：`/Users/wuyongjun/orca/workspaces/OpenBot/i7-review-mt007`；BASE `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（任务开始与结束 `git rev-parse HEAD` 一致）
- Brief：`docs/plans/2026-10-15-company-team-multitenancy-execution/briefs/MT007-review-brief.md`（coordinator 下发）
- 实现报告：`docs/plans/2026-10-15-company-team-multitenancy-execution/reports/MT007.md`
- 日期：2026-10-16（UTC）
- 只读约束遵守：本报告为本次复审新建的唯一文件；审阅期间唯一的生产文件写动作 = D5 抽查重放（brief 明文允许「可抽查重放」），events.ts/runner.ts 临时反转为 BASE 版本后已逐字节还原并哈希复验（见 §4.5）；无提交/推送/合并。

---

## Verdicts

| 结论 | 判定 |
|---|---|
| Spec compliance（Issue #50 四条验收） | **PASS（4/4）**（AC1 中 download/task/credentials 三面按检查点契约 + 真实披露交付，披露经独立 grep 证实为真，见裁决 F） |
| 六项重点裁决 A–F | **全部 PASS**（B 含已声明的实现树/复审树基线差异说明；C 经本树重放直接证实；F 披露真实性独立验证） |
| 独立复跑 | **PASS**（revocation 29/0/0skip、全量 334/0/0skip、typecheck 0、biome 0；命令与退出码见 §4） |
| TDD / 变异真实性 | **PASS**（RED-1/2/3 存档真实、6/6 变异被杀、复原哈希与本树逐字节一致；报告变异计数口径缺陷 1 项，low，见 Finding-1） |
| Code quality | **PASS**（无 critical/high；low ×1、info ×5，见 §6） |

---

## 1. 快照核验（先做，全部独立复算）

- `checkpoints/prereq-manifest.txt`（BASE 行 + 31 文件哈希）逐项 `shasum -a 256` 复算：**30/31 逐字节一致；唯一 DIFFERS = `server/src/enterprise/tenancy/workspace-admin.ts`**——恰为本票 brief 明文授权的「恢复动作 + 审计」扩展文件。✅
- 本票 5 个交付物哈希（`checkpoints/MT007/sha256-manifest.txt` 声明值）与本树实际文件逐一比对：**5/5 一致**（revocation.ts `62464499…`、workspace-admin.ts `731a30e6…`、events.ts `74432778…`、runner.ts `ff564d8d…`、revocation.test.ts `bf78fb72…`），reports/MT007.md `78473464…` 亦一致。✅
- **改动面（裁决 B 的证据基础）**：`git diff f0520524 -- server/src` 的 tracked 漂移 = 7 文件，其中 events.ts（+12）/runner.ts（+4）为本票 16 行编辑、逐 hunk 与 `checkpoints/MT007/changes.diff` 及报告声称一致；其余 5 文件（app.ts/config.ts/enterprise-tenancy.ts/store.ts/index.ts）均在 prereq-manifest 内且哈希未漂移（= 前置转移物，非本票改动）。untracked 新文件中仅 revocation.ts 与 tests/multitenancy/revocation.test.ts 属本票。**本票实际写面恰为授权四文件 + 2 新文件；index.ts 零改动**（装配在 runner.ts 生产组合内完成，无需动 index.ts）。✅
- **基线差异说明（info，非缺陷）**：`checkpoints/MT007/after-hashes.txt`「不得改清单」中 index.ts/migrate-test.ts/migration-tool.test.ts 三项哈希（`ab32a9b1…`/`c5bfb3d4…`/`c7569901…`）与本树实际值（= prereq-manifest 的 `addc265c…`/`8d1d6ab6…`/`4ede3c5f…`）不一致。甄别结论：这三个文件在本树经 MT012/MT013 后续前置转移再次演进（review-brief「本树环境说明」已预声明：复审树前置含 MT001-008/112/012/013，与实现者 261 基线环境不同是**实现树基线差异，非缺陷**）。复审的裁决基准是 coordinator 为本树构建的 prereq-manifest（31 文件）——按此基准本票未触碰任何不得改文件。两棵树中本票对 index.ts 均零改动，双树互证。✅

## 2. 验收逐条结论（Issue #50 四条）

| # | 验收 | 判定 | 证据 |
|---|---|---|---|
| 1 | 团队停用后六面拒绝（逐点测试） | **PASS** | criterion 1 共 13 例：停用前六检查点正向对照全 allow；停用后六检查点逐一 `{deny, WORKSPACE_REVOKED, level:team}`（参数化逐点）；resolve→`WORKSPACE_FORBIDDEN`；列表经真实 routes GET /（停用团队消失）；详情经真实 `requestAs` seam（403）；事件面经真实 runner-event service + 生产同款 guard（replay 首查即拒、subscribe 首轮轮询即中止，附 3s 安全 abort）。download/task/credentials 三面以检查点契约逐点拒绝证明（guard 层），真实入口尚不存在——见裁决 F |
| 2 | 公司停用：范围内全失效 + 他公司完好 | **PASS** | criterion 2 共 4 例：六检查点逐一 `{deny, SCOPE_REVOKED, company}` + resolve→`TENANT_FORBIDDEN`；同用户两个团队 scope 同时失效（一事实全团队级联）；multi-company 在公司 B resolve ✓/六检查点 allow ✓/资源 200 ✓，B 行 status=active、A 行 status=suspended（事实行保级，资格不误删）；公司级写与 gate 在 membership 锁上真实串行化（持锁期 55P03 lock timeout，释放后立即生效） |
| 3 | 恢复后按当前策略重新生效、无旧拒绝缓存 | **PASS** | criterion 3 共 4 例：团队恢复后**同一 scope 对象**六检查点重新 allow（无缓存的结构性直接证据，guard 每次读实时行）；epoch 严格递增；公司恢复后 fresh scope 全 allow（epoch=恢复后版本）、旧 scope 保持拒绝且拒绝由实时 epoch 事实重推导（断言 staleScope.memberEpoch < restored.epoch——按策略拒绝而非缓存）；no-op 状态按既有 not-found 码拒绝且不泄露存在性 |
| 4 | 审计五要素（操作者/对象/范围/版本/时间） | **PASS** | criterion 4 共 5 例覆盖 6 动作（团队停用/恢复/移除、重激活、公司停用+恢复）：每动作返回 auditEventId 并经受限 operator 角色 + `tenant_id + operation_id` RLS 钉真实读回；断言 event_type、actor_id=操作者 principal、details 双记 principal/user、target_principal_id、tenant+workspace 范围、epoch=返回成员关系版本、created_at 非空；跨公司 scope 读不到该事件（RLS tenant 钉） |

测试计数独立复核：29 = 3（criterion 0）+ 13（criterion 1）+ 4 + 4 + 5。✅

## 3. 六项重点裁决

### A. 单一失效入口 — PASS

- `revocation.ts` 的 `createRevocationGuard` 是唯一判定入口：`decide(scope, checkpoint)` 先 `parseRevocationCheckpoint`（封闭集合，未列名检查点抛 `REVOCATION_CHECKPOINT_UNKNOWN`，杜绝拼错名字静默绕过）+ `assertTrustedScope`（伪造 scope 不触库），随后**完全委托 MT005 `createWorkspaceGate(data).transaction`** 做事务内两级重验——同一事务形状、同一锁序（tenant→principal→membership→workspace-membership）、同一事实行。本文件**零行重验逻辑复制**（gate 抛 `SCOPE_REVOKED`→company 级 deny、`WORKSPACE_REVOKED`→team 级 deny，判定与 gate 语义结构上不可漂移）。基础设施故障原样上抛、不折叠为 allow/deny。grep 全树无第二处成员撤权判定实现（workspace-admin 的 `revalidateAdmin` 是 MT006 管理面操作者身份重验，属另一关注点，非成员撤权判定）。票面「下游复用、不散落」义务落实。✅

### B. 改动面 — PASS（含已声明基线差异说明）

- prereq-manifest 31 文件中唯一漂移 = 授权文件 workspace-admin.ts（§1）。events.ts/runner.ts 为 git-tracked 文件、diff vs BASE 恰为 16 行（12+4），与 changes.diff 逐 hunk 一致。index.ts 在本树与 manifest 逐字节一致（零改动、无需纯追加性核验）。revocation.ts/revocation.test.ts 为授权新建。无任何未授权写面。✅
- workspace-admin.ts 扩展经抽查为「三处最小编辑 + 纯追加动作」：错误语义、事务形状、锁键序与 MT006 既有面同构；`addTeamMember` 重激活分支补审计（created 分支 `auditEventId: null`，语义正确）。

### C. D5 核验（51 存量失败与 16 行编辑无关）— PASS（本树重放直接证实）

- 当前树（含 16 行）跑 D5 点名 5 个 tests/enterprise 套件：**63 pass / 51 fail / 114 tests**，与实现者存档证据完全一致。
- 临时反转 events.ts/runner.ts 至 BASE（两文件未被前置票触及，BASE 即前置态）复跑同 5 文件：**63 pass / 51 fail——逐字节相同的失败面**。编辑无关性不依赖对照文件成立，而是本树直接重放证实。失败根因（store.ts resolver 要求团队成员行、合成夹具未建行）与实现者披露一致。✅

### D. 审计写入路径 — PASS（复用受限通道，无越权新开面）

- `recordRevocationAuditEvent` 在**调用方既有的 operator 事务内**写既有表 `enterprise_security_events`（零 schema 变更，enterprise-tenancy.ts 哈希未动）；通道 = MT006 同款受限 operator 角色（`OperatorDatabase`），无新角色、无 superuser 路径。
- 事务语义正确：审计与成员关系变更**同事务原子提交**（回滚即双双不存在）；事件 id 兼作 operation id，`set_config('app.operation_id', …, true)` 事务本地钉定，INSERT 经真实 RLS withCheck（`tenant_id = app.tenant_id AND id = app.operation_id`，schema enterprise-tenancy.ts:301-323）——测试经 `queryRestricted('operator')` 真实读回并验证跨公司不可见，RLS 路径是活的而非纸面。✅

### E. TDD 链与报告诚实性 — PASS（1 项 low 计数口径缺陷）

- RED 链真实：RED-1（模块缺失 0 pass/1 fail）→ RED-2（管理动作缺失 14/16，`suspendCompanyMember is not a function`）→ RED-3（仅 events 两例失败 27/2）→ GREEN 29/0/158 expects。归档路径均为实现树 `i7-mt007`，无事后拼接痕迹。RED-2 归档「Ran 30 tests」比 GREEN 多 1：经 diff 定位为内层 describe 的 beforeAll 失败呈现的 `(unnamed)` 条目，非用例数不一致。✅
- 变异 6/6 全部被杀（失败面 9/1/5/1/6/2 唯一失败测试，退出码均 1）；**复原哈希核验**：pre-mutation-hashes.txt 三文件哈希与本树当前值逐字节一致（62464499/731a30e6/74432778）。
- **Finding-1（low，报告计数口径）**：报告 §4 的变异失败数（MUT2=2、MUT3=10、MUT4=2、MUT5=12、MUT6=4）为归档 bun 输出中 `(fail)` 行的出现次数（bun 会在底部 recap 重复打印失败用例），是唯一失败测试数的 2×；MUT1 因归档无 recap 重复而恰好相等（9=9）。全部 kill 裁决方向不受影响，但数字应按唯一失败测试数（1/5/1/6/2）表述。见 §6。

### F. 范围边界声明真实性 — PASS（披露属实，无藏掖）

- 对披露 D1 点名的全部入口面独立 grep：craft/、workshop/、credentials.ts、passwords/、host-access/、openmuse-tasks/、work/、responsibilities/、routines/、untrusted-content.ts **均无 `PlatformScope` 引用**——「下载/任务/凭据入口尚不存在 scope-carrying 形态」的声明为真。
- 反向核验（防止把应做未做藏进披露）：perimeter 内真实存在的面——列表（MT006 lister，实时行过滤）、详情（MT005 resolver→403）、事件订阅（本票真实接入 events.ts:384-386 + runner.ts:889 生产恒接）——**全部已接入并有真实 seam 测试**；三个尚不存在入口交付为封闭集检查点 + 单一判定入口（下游复用契约），与票据备注的「失效点清单是下游闭环票的复用基础」一致。范围边界成立：应做未做为零，未做已披露且披露为真。✅

## 4. 独立复跑（全部亲自执行，退出码如下）

### 4.1 环境

- 端口预检 `lsof -i :55478` → 空（exit 1，端口空闲）；专用容器 `mt007-review-pg`（pgvector/pgvector:pg16，trust，55478）psql `select version()` 探针 2 次就绪（PostgreSQL 16.15）。
- 两库：`openbot_enterprise_mt007_review`（setup）+ `openbot_enterprise_mt003_assigned`；五变量 URL 显式用户（postgres + 三个 `ent_mt007rev_*` 登录），随机口令仅存 0600 env `/tmp/mt007-review.env`，未打印，用后已删。
- `bun install`（本工作树无 node_modules，属环境准备非交付缺陷）。

### 4.2 迁移

| 步骤 | 退出码 |
|---|---|
| `bun scripts/enterprise-test-db.ts migrate`（fresh schema + capability 角色 + 3 受限登录） | **0** |
| `migrate-test.ts generate MT004 --out …` + `migrate MT004 --apply --manifest …` | 0 / **0** |
| 同 MT008（visibility 列，fixtures 套件前置） | 0 / **0** |
| 同 MT112（锚点表） | 0 / **0** |
| 同 MT012（依赖 MT112 锚点表，依赖序在其后） | 0 / **0** |

### 4.3 测试

| 命令 | 退出码 | 结果 |
|---|---|---|
| `bun test tests/multitenancy/revocation.test.ts --timeout 30000` | **0** | **29 pass / 0 fail / 0 skip**（158 expects）✅ |
| `MT003_ASSIGNED_TEST_DATABASE_URL=… bun test tests/multitenancy/ --timeout 30000` | **0** | **334 pass / 0 fail / 0 skip**（12 文件，8430 expects）✅（首跑 333/1 瞬态，见 4.6） |

（brief 写「11 文件」：实际含 tests 的文件为 12——prereq 11 文件 + 本票 revocation.test.ts；总数 334 = 305 + 29 与 brief 预期一致。）

### 4.4 静态

| 命令 | 退出码 | 结果 |
|---|---|---|
| `cd server && bun run typecheck` | **0** | `tsc --noEmit` 干净 ✅ |
| `bunx biome check`（5 个触及文件） | **0** | Checked 5 files, 0 findings（新文件 0 告警；触及的存量文件亦 0 告警）✅ |

### 4.5 D5 抽查重放（裁决 C）

- 含 16 行：`bun test tests/enterprise/{run-success-contract,runner-events,runner-production,runner-scope,run-active-lookup}.test.ts` → exit 1，63/51。
- 反转 16 行（`git show f0520524:…` 覆盖两文件）→ 同命令 → **63/51，失败面相同**。
- 还原：backup 复制回写，`shasum -a 256` = `74432778…`/`ff564d8d…`（与 sha256-manifest 逐字节一致），`git diff --stat` 复归 16 insertions，backup 即删。

### 4.6 首跑 333/1 瞬态的甄别（非交付物缺陷）

全量首跑唯一失败 = `acceptance harness CLI > writes a machine-readable report and exits 0 on an honest run`（子进程 exit 1，MT131/MT003 前置域文件，与本票四文件无任何依赖关系）。三次复证：① 单独手跑 harness → exit 0、self-check passed；② 单跑 acceptance-harness.test.ts → 17/0；③ 全量复跑 → 334/0/0skip。判定为 12 文件并行执行下 harness 子进程（动态端口 + 正向控制种子）的资源竞争瞬态，非 MT007 交付缺陷。

## 5. 交付环境与复审树差异备忘

实现者环境全量基线 261（232+29）；复审树前置含 MT012/013 等后续转移，基线 305，总期望 334。review-brief 已预声明此为实现树基线差异非缺陷；复审以本树 prereq-manifest 为裁决基准后，两树的本票交付物哈希**逐字节一致**（5/5），判定不受差异影响。

## 6. Findings

| # | 级别 | 位置 | 内容 |
|---|---|---|---|
| 1 | low | reports/MT007.md §4 | 变异失败计数按 bun `(fail)` 行出现次数统计（含底部 recap 重复行），MUT2–MUT6 报告值为唯一失败测试数的 2×（如 MUT3 报 10、归档唯一失败 5）。kill 裁决与复原哈希均真实成立，仅数字口径需修正 |
| 2 | info | checkpoints/MT007/after-hashes.txt | 「不得改清单」三项哈希反映实现树（MT006 代 index.ts 等），与本树后续前置转移后的状态不同——已甄别为声明的基线差异，复审基准（prereq-manifest）下无违規 |
| 3 | info | revocation.test.ts criterion 1 | AC1 三面（download.issue/task.sensitive/credentials.access）以检查点契约层测试交付（guard 逐点拒绝），真实入口由下游闭环票接入——披露 D1 经独立 grep 证实为真，属诚实范围声明而非缺陷 |
| 4 | info | server/src/enterprise/runs/events.ts:297 | `revocation` 为可选依赖（保 MT 既有测试零影响的 legacy 形状），生产组合恒接；下游全部调用方多租户化后建议收紧为必选，防未来组合点漏装 |
| 5 | info | reports/MT007.md §1.3/D3 | wired replay 每次调用先跑 guard 事务再跑 repository 事务（200ms 轮询下每订阅约 5 次重验/秒）——零侵入换串行成本，已诚实披露并留下游折入事务的 seam 选项 |
| 6 | info | checkpoints/MT007/red-green/RED-2 | 归档「Ran 30 tests」含 1 个 beforeAll 失败的 `(unnamed)` 条目，非用例数不一致（终态 29 用例稳定） |

## 7. 复审环境清理声明

容器 `mt007-review-pg` 已 `docker rm -f`；`/tmp/mt007-review.env`（0600）、`/tmp/mt007-review-migrations/`、各次运行输出与 D5 重放 backup 已删。工作树仅新增本报告；events.ts/runner.ts 经 D5 重放后已逐字节还原（哈希复验一致）。

---

— MT007 独立复审者，2026-10-16（UTC）
