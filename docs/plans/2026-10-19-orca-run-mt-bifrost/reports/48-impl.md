# Issue #48 / MT005 实施报告 —— 团队资格进入集中授权 seam 与事务内重验

- 会话：orca worker（mt048-pilot 工作区，task_9434c226891d，2026-10-19）
- HEAD：`0a85bb42d622c25d3190db7c7c7de117f3b8e57b9`（分支 `1123786563/mt048-pilot`）
- git status 全量：**clean（零未提交改动）**
- 前会话完整交付记录：`archive/plans/multitenancy-execution/reports/MT005.md`（2026-10-16，i6-mt005 工作区）

## 0. 本轮性质：复验轮，零生产代码改动

MT005 的实现、测试与 fixture 已由前会话完成并经 checkpoint `253bf7e5` 入库。本轮工作是在当前
工作区按新测试基建（e2e 驱动层 + 专用库规范）**重建验证环境并复跑全部验收**，确认交付在当前
HEAD 上依然成立。实现文件自 `253bf7e5` 后的漂移审计：

| 文件 | 253bf7e5 后改动 | 性质 |
|---|---|---|
| `server/src/enterprise/tenancy/store.ts` | 无 | — |
| `server/src/enterprise/tenancy/scope-gate.ts` | 无（该提交新增） | — |
| `server/tests/multitenancy/support/scope-gate.ts` | 无 | — |
| `server/tests/multitenancy/support/fixture.ts` | 无 | — |
| `server/tests/multitenancy/scope-gate.test.ts` | `06e3c9bc` | 仅 runner import `bun:test` → `tests/support/bun-test-compat`（迁移波次，无断言改动，diff 已核对） |
| `server/src/index.ts` | 后续合并波次多次 | MT005 头名裁决仍在（`x-openbot-tenant`/`x-openbot-workspace`，index.ts:1043-1046、1113） |
| `server/tests/multitenancy/fixtures.test.ts` | `9f8312c0`（#45 MT002 修补） | 非本票域 |

## 1. 交付物（票面 What to build 的落点）

- **签发入口**（`store.ts` `createScopeResolver.resolve`）：选择子缺失分流 `TENANT_REQUIRED` /
  `WORKSPACE_REQUIRED`（不回退默认公司/第一团队）；同一目录事务内查
  `enterprise_workspace_memberships`（(tenant, workspace, principal) 行存在且 active），
  缺行/停用/不存在统一 `WORKSPACE_FORBIDDEN`（不泄露存在性）；`set_config` 补 `app.workspace_id`。
- **业务事务半边**（`scope-gate.ts` `createWorkspaceGate`，148 行）：`assertTrustedScope` →
  data 事务 → set_config 四键（事务本地）→ advisory 共享锁（含新键
  `["enterprise","workspace-membership",t,w,p]`）→ 公司成员重验（status×3 + epoch 等值，否则
  `SCOPE_REVOKED`）→ 团队成员重验（行存在且 active，否则 `WORKSPACE_REVOKED`，operation 不执行）。
- **请求头**（`index.ts`）：`x-openbot-tenant` / `x-openbot-workspace` 仅作选择，判定全来自服务端行。

## 2. 票面 AC 逐项证据（scope-gate.test.ts，五条 criterion 逐条 describe）

| AC | 结果 | 证据（本轮实测全绿） |
|---|---|---|
| 1 只有签发入口能产生 Scope；伪造/反序列化被拒 | ✅ | criterion 1（5 例）：签发 scope frozen 且过 `assertTrustedScope`；手造对象、`JSON.parse(JSON.stringify())`、`structuredClone` 均 `UNVERIFIED_SCOPE`；gate 对伪造 scope 触库前拒绝且 operation 不执行 |
| 2 缺公司/团队上下文明确拒绝，不回退 | ✅ | criterion 2（6 例）：无/空白 tenant → `TENANT_REQUIRED`；有 tenant 无 workspace（即使该成员只有一个团队）→ `WORKSPACE_REQUIRED`；公司成员无团队行 → `WORKSPACE_FORBIDDEN`（不自动准入）；未知 workspace 与真实非成员 workspace 错误码一致（无存在性泄露） |
| 3 团队移除/停用 → 同事务后续步骤 + 下次请求被拒 | ✅ | criterion 3（4 例）：停用/删除后 gate `WORKSPACE_REVOKED` 且 operation 未执行、下次 `resolve` `WORKSPACE_FORBIDDEN`；重新授予恢复且 epoch 严格递增；**串行化探针**：gate 持共享锁期间撤权写 `canceling statement due to lock timeout`，提交后立即生效 |
| 4 公司暂停 → 该公司全部团队资格失效，其他公司不受影响 | ✅ | criterion 4（3 例）：暂停公司 A → `TENANT_FORBIDDEN`/`SCOPE_REVOKED`，同身份公司 B 团队照常 resolve+gate 放行；反向撤 company-admin 不影响 b1-member；epoch 续约（status 仍 active）→ 旧 scope `SCOPE_REVOKED`、新 scope 携新 epoch 放行 |
| 5 判定只依赖服务端事实；头只做选择 | ✅ | criterion 5（5 例）：双团队正向选择；篡改 workspace 头（同公司他队/他公司队）→ `WORKSPACE_FORBIDDEN`；篡改 tenant → `TENANT_FORBIDDEN`；头不变而服务端停用后结果翻转 |

覆盖验收（Handoff）：A1、A2、A5、A6 均由上述用例群覆盖。无权对象按不可见语义
（`WORKSPACE_FORBIDDEN` 统一码，无存在性差异），错误不泄露计数。

## 3. Verification（票面命令 → 实际落点）

票面命令 `bun test server/tests/multitenancy/team-eligibility.test.ts` 为计划期文件名；seam 识别
（dag-ledger「新栈 Seam 识别结论」）后实际落点为 `scope-gate.test.ts`（任务明示票面旧命令普遍
过时）。本轮全部在仓库根 cwd 执行：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `bun test ./server/tests/multitenancy/scope-gate.test.ts` | 0 | **23 pass / 0 fail / 0 skip**（934ms） |
| 同上 + `--reporter=junit --reporter-outfile=…`（驱动层 runBun 同参） | 0 | junit：`tests=23 assertions=49 failures=0 skipped=0`（留档 `48-scope-gate.junit.xml`） |
| `bun test ./server/tests/multitenancy/fixtures.test.ts ./server/tests/multitenancy/membership-model.test.ts ./server/tests/multitenancy/entry-context.test.ts` | 0* | 34 例：33 pass + MT122 缺表 1 fail（见披露 R3；补 MT014 迁移后驱动层全绿） |
| `E2E_UNIT_SCOPE=tests E2E_BUN_ONLY=server/tests/multitenancy bunx e2e run --config e2e.unit.config.ts` | 1* | multitenancy 3 组：part1 ✓（24 文件）、part3 ✓、part2 唯一红 = `oauth-state.test.ts`（MT028 票，见披露 R2）；scope-gate.test.ts 在 part2 内全绿 |
| `cd server && bun run typecheck`（tsc --noEmit） | 0 | 干净 |

skipped 计数：MT005 套件 0 skip（junit `skipped="0"`）；缺 env 时整套显式 skip 并把原因写进
用例名，绝不静默记通过——本轮环境齐全，未触发。

## 4. 数据库环境（专用测试库，未回退开发库）

- 实例：既有官方 enterprise 测试容器 `openbot-enterprise-test-pg`（127.0.0.1:5435，pgvector:pg16）。
- 库名：**`openbot_enterprise_mt048`**。任务指定 `openbot_mt048`，但本族校验
  （`server/tests/support/enterprise-database.ts` + `migrate-test.ts`）强制库名前缀
  `openbot_enterprise_*`，故取此前缀拼写——专用、独立于开发库，符合任务意图。
- 引导序列（全部 exit=0）：
  1. `create database openbot_enterprise_mt048`（空库）；
  2. `bun server/scripts/enterprise-test-db.ts migrate`：主迁移 **161/161**（journal 条数 = `server/drizzle/*.sql` 文件数，无 server/kb 共享版本表漂移——全新库无历史 journal）+ 受限 LOGIN 角色 `ent_mt048_{directory,data,operator}`（各恰一个 NOLOGIN capability，随机密码，0600 env 于 /tmp，未入库未打印）；
  3. `migrate-test.ts migrate MT004 --apply`（workspace memberships 表 + RLS）；
  4. `migrate-test.ts migrate MT008 --apply`（`enterprise_resources.visibility`，scope-gate fixture 链需要）；
  5. 为驱动层整组回归补齐注册表其余任务迁移（MT009/010/012/014/016/026–077/112 共 24 个）。
- 判定侧（resolver/gate）全部经受限 directory/data 角色真实 RLS 得出；管理写路径（撤权/epoch bump）
  走专用 setup 超级用户连接 + 排他 advisory 锁——前会话披露 D4 的替身，本轮沿用。

## 5. 检查点（未提交交付）

git status 全量输出（`git status --porcelain=v1`）：仅本目录三个新增未提交文件
（`48-impl.md`、`48-scope-gate.bun-test.log`、`48-scope-gate.junit.xml`），即检查点交付物本身；
票面七个代码/测试产物无任何未提交改动。产物已在 HEAD `0a85bb42` 中（实现经 checkpoint
`253bf7e5`，测试 compat 迁移经 `06e3c9bc`）；本轮零代码改动。

逐文件 sha256（HEAD 内容）：

```
2f8cbef72f8af7c21a2687d7cd9be199e6cfc1dc6703e2d3bf8f8dfd66654c1f  server/src/enterprise/tenancy/store.ts
895b0e548513223e148a4a631dabe4181a0964d853ce2a099158813901d9b107  server/src/enterprise/tenancy/scope-gate.ts
72d36974e621e7d2477269e7848c7b0878c5c6ca108f7b38f21ee71236dacdfc  server/src/index.ts
1aa3872291e932d415235a0636dc204cb3a76b3d4d7f6b619e5718c4d0a33cc2  server/tests/multitenancy/scope-gate.test.ts
7f32f54383babe7f94fca2f8c75d7422c127d2a5bdfa7d3b7e9165ae767a787d  server/tests/multitenancy/support/scope-gate.ts
da29a2a5da604292f4ef566b841b9b443fed382536b3456bfc0dbdd69ff7dd78  server/tests/multitenancy/support/fixture.ts
4bf1ca4480226705af6a22f96ee110146d34995bb627fa8ebe2bc4fcfe76233c  server/tests/multitenancy/fixtures.test.ts
```

## 6. 披露与遗留

- **R1（验证轮定位）**：本轮未重写实现/测试，也未重跑前会话的 4 组变异测试（其记录在
  archive 报告 §4，全捕获）。不重跑的依据：实现四文件自 `253bf7e5` 起 sha 可溯零改动、
  测试文件唯一漂移是无断言的 runner import 迁移（diff 已核对）。如需变异复演可按 archive
  报告 §4 的变异点在本库重放。
- **R2（驱动层组内他票红，非本票）**：part 2 唯一失败 `oauth-state.test.ts`
  （"MT028 initiation: the persisted row fixes the attribution"，`ENOENT … oauth-state.ts`，
  相对路径解析失败）。MT028/#? 为另一票文件，本票未触碰；建议归属票或波次收口处理。
- **R3（MT122 缺表 → 环境顺序，非缺陷）**：单跑 `entry-context.test.ts`（MT122/#165）需
  MT014 的 `enterprise_runtime_configs` 表；补齐任务迁移后驱动层 part 1 全绿。首轮失败时
  MT014 fixture 在库中残留 3 行 principal（mt014- 前缀，dispose 不彻底），已清理。
- **R4（MT112 迁移数据步骤不幂等，#158 票）**：`MT112` 表步骤（1–2）成功，数据回填步骤在
  被其他票测试写过的库上撞 `enterprise_principal_user` 唯一键失败（"幂等写入"对污染库不成立）。
  影响仅 legacy-anchor 类测试的锚点数据行，与本票验收无关；建议 #158 修迁移幂等性。
- **R5（前会话披露沿用）**：`resolveForThread` 未扩展团队判定（D2，expand-only，线程路径属后续
  接线票）；团队 epoch 未入 scope 形状（D3，MT008 级决策）；管理写路径超级用户替身（D4）。
- **R6（环境清理）**：库 `openbot_enterprise_mt048` 与角色 `ent_mt048_*` 保留供复验；
  清理命令：`dropdb -h 127.0.0.1 -p 5435 -U postgres openbot_enterprise_mt048` +
  `drop role ent_mt048_directory, ent_mt048_data, ent_mt048_operator`（密码文件 /tmp/mt048.env
  为 0600，可径直删除）。共享容器上其他库/角色未触碰。

## 7. 结论

票面五条 AC 全部有本轮实测证据；Verification 测试全绿（23/23，双形状：bun 直跑 + 驱动同参
junit）；typecheck 通过；同族回归绿（本票直接关联面），驱动层整组仅余他票文件红（R2/R4）。
按「Evidence over claims」，Issue #48 的实现与验证在当前 HEAD 成立，可交独立 review。

## 8. 本目录证据文件 sha256

7c1da92ba8784634d0e9422c451461826a82400733a53d0ce0cf3a04f48d9bed  docs/plans/2026-10-19-orca-run-mt-bifrost/reports/48-scope-gate.bun-test.log
1f9d34c38a06e212f4a155dd37778ea0b446a9753a4fb3d00192ff6a82940570  docs/plans/2026-10-19-orca-run-mt-bifrost/reports/48-scope-gate.junit.xml
