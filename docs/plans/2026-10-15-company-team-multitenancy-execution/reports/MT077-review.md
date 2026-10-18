# MT077 独立复审报告 — 网络、能力与模型路由策略和模板按归属保存（Issue #120）

- 复审者：独立 Reviewer（Pi，Orca Task `task_13c54eab85a8` / Dispatch `ctx_557a3c1c4573`，全新会话，未参与两任实现）。
- 日期：2026-10-17。被审树：`i9-review-mt077`（HEAD = `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`，与 prereq-manifest BASE 一致）。
- 方法：只读被审文件 + checkpoint 证据独立复算 + 独立环境全量复跑（容器 `mt077-review-pg` @ 127.0.0.1:55498，端口预检空闲）。唯一新建 = 本报告；未修改任何被审文件；无提交/推送/合并。
- **总结论：四项裁决 A/B/C/D 全部通过，独立复跑全部达标（37/0/0、495/0/0/17、typecheck 0、biome 0），装配核对确认合并未改变本票增量语义。无阻塞发现；4 条非阻塞观察项见 §7。**

---

## 0. 装配核对（brief 指定独立验证项）——通过

coordinator 披露：本树 = EXE 49 项前置（458 基线，含并行票 MT009）+ 本票 7 交付；三编辑文件已做三方语义合并。独立核对方法与结果：

1. **7 个交付文件哈希**：4 个新文件（`routing-policy.ts`、`enterprise-governance-policy.ts`、`routing-policy.test.ts`、`support/routing-policy.ts`）SHA-256 与 `checkpoints/MT077/after-hashes.txt` **逐字节一致**。
2. **合并差异穷举**：用 checkpoint diff（`0a1,1670` / `0a1,1132` 全量新增格式）重建实现树 after 态，SHA-256 复现 `6552cc36…`（migrate-test.ts）与 `53bf95ce…`（migration-tool.test.ts），与 after-hashes 一致；再与当前树 `diff`，**差异仅为纯新增**：
   - `migrate-test.ts`：+61 行 MT009 任务块（注释 + `RESOURCE_DEPENDENCY_TASK` 常量）+ 1 行注册（插在 CORE_RLS 与 PERSONAL_SHARE 之间，依赖序正确）；`GOVERNANCE_POLICY_TASK` 块与注册行逐字节未动。
   - `migration-tool.test.ts`：+3 行 MT009 裁决注释 + 1 行 `"MT009",` 断言；MT077 的 3 行注释（当前 363-365 行）与 `"MT077",`（374 行）原样在位。
   - `schema/index.ts`：当前哈希 = after-hash（`c74012ed…`），即合并后与本票交付逐字节相同；`export * from "./enterprise-governance-policy"` 在位。（checkpoint diff 中另两行 export——`enterprise-runtime-config`、`personal-shares`——属 46 项基线既有内容，非本票增量。）
3. **49 项 prereq-manifest 复算**：46 OK + 3 FAILED；3 个 FAILED 恰为三个被合并文件（其 manifest 哈希 = pre-MT077 的 EXE 基线态，被本票交付+MT009 合并覆盖后必然不同）——与 brief 披露的装配差异**精确吻合**，无未披露漂移。
4. **git 佐证**：`git status` 显示 4 个新文件为 untracked；`admin/capabilities.ts`、`admin/controls.ts`、`agent-computer/src/egress.ts`、`runtime-config.ts`（prereq 清单内）对 BASE 零修改——D3/D4「只读 import、零字节改动」独立证实。

**结论：合并未改变本票增量语义；「本票 7 交付」在合并树上完整且逐字节可证。**

## 1. 裁决 A —— 四条验收 —— 通过

实现核心：`resolveGovernancePolicy`（纯函数）+ `createRoutingPolicyService`（data 通道）/`createTemplateInstallReader`/`createTemplateInstallWriter`（operator 通道）。逐条：

- **①归属范围生效 + 跨范围不可见**：读取全程受限 `ob_ent_data` + 事务本地 `app.tenant_id` + FORCE RLS；缺公司行 = `GOVERNANCE_POLICY_NOT_FOUND`，与跨公司不可见同为 0 行、无默认回退。测试侧：A/B 两公司端到端各自解析、A1→B1→A1 逐字节相同、负向包含（A1 解析不含 B 路由/不含 A2 覆盖痕迹）、RLS 探针（data 角色按租户上下文只见本租户行）、安装读按团队隔离、写侧 RLS 证伪（A 上下文 UPDATE B 行命中 0 行且字节不变；混合复合键 = `TEMPLATE_INSTALL_NOT_FOUND`）。全部实跑通过。
- **②团队覆盖只收窄不放大（四道防线）**：代码逐行核对——capability：覆盖值 `!== false` 一律 `CAPABILITY_OVERRIDE_WIDENS_POLICY`（公司已开也拒——覆盖没有放大表达）；mode：`EGRESS_STRENGTH` 比较拒绝更弱 mode（已独立核实 `EGRESS_MODES` 数组序 = 弱→强：`allow_all < defaults_plus_allowlist < allowlist_only < deny_all`，索引映射成立）；rules：canonical JSON 比较，必须 ⊆ 公司规则清单，拒绝消息只含 index 不含值（canary 用例钉死零回显）；routes：必须 ⊆ 公司路由面 + 默认路由必须落在生效面内（收窄挤出公司默认且未给新默认 → 拒绝）。四道防线各有专门测试 + MUT1/2/3 变异捕获（§4）。另收窄到空路由被拒（`OVERRIDE_MODEL_ROUTING_EMPTY`，D8）。
- **③模板更新只落本范围安装、不回写平台**：`PLATFORM_TEMPLATES` 为进程内 `deepFreeze` 封闭清单（3 模板）——不是表、无任何语句引用、无 push 写路径（源级断言：无 `process.env`/`Bun.env`/`import.meta.env`、声明行含 `deepFreeze(`、无 `PLATFORM_TEMPLATES.push`）；「不可回写」是结构性质。install 拷贝目录条目（document 深相等 + sourceRevision=目录版本）；`updateInstall` 按 (tenant, workspace, ref) 复合键 + `revision = expectedRevision` CAS 谓词，陈旧 revision = `TEMPLATE_INSTALL_REVISION_CONFLICT` 且行不变；兄弟团队与 B 公司安装 before/after 深相等；`syncToCatalogRevision` 仅刷新本行副本；目录快照经全部操作后逐字节相同 + push 抛错。
- **④变更下一生效点立即体现、无跨范围缓存污染**：cacheKey = `routing-policy/v1/t=/w=/c=/o=` 纯入参模板串（代码核对：无进程状态、无环境读取——源级断言钉死）；公司 rev 3→4、覆盖 rev 1→2 均下一次 resolve 立即生效且 cacheKey 相应移动；A 版本翻转全程 B 的解析与 cacheKey 逐字节不变；两个独立已验证 data 通道实例同入参同输出；解析不突变入参（structuredClone 前后相等）+ 输出深冻结（`everyFrozen` + 赋值抛错）。

**注**：37 用例计数独立复核 = 8（验收1）+ 9（验收2）+ 11（验收3）+ 5（验收4）+ 4（存储契约）= 37 ✅；末位「plan 确定性」用例为纯 `test`（非 `itDb`），无 env 也执行——套件无「全 skip 假绿」结构。

## 2. 裁决 B —— 三表 DDL 与迁移 —— 通过

- **生成 SQL**：0001 = 6 语句（3×CREATE TABLE + 3×ADD CONSTRAINT，全部只涉新表；FK 分别指向 `enterprise_tenants(id)` cascade 与 `enterprise_workspaces(tenant_id,id)` 复合 cascade）；0002 = 30 语句（每表 REVOKE 四角色 + ENABLE + FORCE + 4 策略 + 3 GRANT × 3 表）。manifest `planDigest b6690cb2…`、statementCount 6/30 与生成物一致。
- **expand-only**：0001/0002 无任何 `ALTER` 既有表 / `DROP` / 既有策略改动；schema 文件只 import 既有 `enterpriseTenants`/`enterpriseWorkspaces` 作 FK 引用。
- **最小 RLS（活库抽查证实）**：三表 `relrowsecurity=t AND relforcerowsecurity=t`；12 条策略与设计一一对应（data 只 SELECT；operator SELECT/INSERT/UPDATE；overrides 与 installs 的 UPDATE 另要求 `app.workspace_id`——团队行行级收窄到该团队；policies 表 UPDATE 无 workspace 条件——公司行，正确）；`information_schema.role_table_grants` 确认 data=SELECT only、operator=SELECT/INSERT（DELETE 零授予；UPDATE 为列级授权）。
- **既有对象零改动（活库抽查证实）**：全部 28 张 enterprise 表的 RLS/FORCE/策略数抽查原样（MT014 runtime_config 4 策略、MT010 shares 4 策略等）；journal 恰为 8 任务 18 步（MT112=4，其余=2），无额外对象。
- **八任务依赖序真实执行**：`enterprise-test-db.ts migrate` 一次通过（schema + `ob_ent_*` 能力角色 + 三个受限登录）后，MT004→MT008→MT112→MT012→MT014→MT010→**MT009**→**MT077** 全部 `--apply` 成功（§6）。

## 3. 裁决 C —— GREEN-1 24/13→37/0 的 7 处修复诚实性 —— 通过

- `RED-1-missing-module.txt`：`Cannot find module '../../src/enterprise/tenancy/routing-policy'`、0 pass/1 fail——功能缺失型 RED（路径显示实现树 `i8-mt077`，与「第 2 任在另一工作树从零实现」的两任披露一致）。
- `GREEN-1-first-run.txt` 实测 **24 pass / 13 fail**；日志内错误类别与报告 7 处修复**逐一可对**：
  1. `column "created_at" specified more than once`（insert/update 列重复）→ schema `createdAt()` 助手硬编码列名——**实现侧**（现码已改为 `timestampColumn(name)` 逐列命名）；
  2. `permission denied for table enterprise_template_installs`（update set 落到无列授权的 `created_at`）→ 同根因 #1 的另一表现；
  3. `GOVERNANCE_OVERRIDE_INVALID: … must be false`（`true` 被拒在 parse 层）→ **实现侧**语义搬移：现码 parse 接受布尔、resolve 语义层拒 `true`（`CAPABILITY_OVERRIDE_WIDENS_POLICY`），与「覆盖无放大表达」的领域语义一致；
  4. `TypeError: first.map is not a function` → buildPlan 返回 `MigrationPlan` 而非数组，**测试侧**形状修正；
  5. cacheKey 断言尾斜杠 → **测试侧**；
  6. GREEN-1 用例名「install writes cannot cross scopes: company A's writer cannot touch company B's install row」与现码用例名（「…operator context sees and moves zero rows…」）不同 → 跨范围写用例重写为真实 RLS 探针（`attemptCrossTenantInstallWrite`），**测试侧**，与披露一致；
  7. fixture 漏导入工厂函数（`expect(received).not.toBeNull()` 类失败）→ **测试侧**。
- 13 个失败用例均可归因到上述 7 处（多数由 #1 一处 schema 缺陷连锁）；无「改测试迁就实现」的掩盖痕迹——修复后语义恰好落回票面领域规则。`GREEN-2` 37/0/0、`GREEN-3`（REFACTOR 后）37/0/0 均为 140 expect。
- **归类结论：诚实。** 实现侧缺陷（schema 列名、parse/resolve 语义分层）与测试侧缺陷（形状/断言/夹具）划分与日志证据相符。

## 4. 裁决 D —— TDD 链 + 变异 5/5 + D1-D9 处置 —— 通过

- **TDD 链**：RED-1（模块缺失）→ GREEN-1（24/13，7 修复）→ GREEN-2（37/0/0）→ REFACTOR（biome 格式化/readonly 改局部构造/未用 import，语义零变化）→ GREEN-3 复绿。链条完整、时间戳连贯（00:05→00:16）。
- **变异 5/5 独立核对**（存档逐份读取）：
  | 变异 | 存档计数 | 失败用例靶向核对 |
  | --- | --- | --- |
  | MUT1 删 capability 放大防线 | 35/2 ✅ | 恰为验收 2 两个 `CAPABILITY_OVERRIDE_WIDENS_POLICY` 专门用例 |
  | MUT2 删 mode 强度比较 | 36/1 ✅ | 恰为 weaker-mode 用例（`Received: ""` 证明检查确被删除）|
  | MUT3 删 rules 子集校验 | 36/1 ✅ | 恰为 rules-canary 用例 |
  | MUT4 删 resolve 事务租户上下文 | 26/11 ✅ | 11 个失败全为 resolve 读取路径（验收 1/2/4），FORCE RLS fail-closed |
  | MUT5 删 CAS revision 谓词 | 36/1 ✅ | 恰为 stale-revision 冲突用例（丢失更新可复现）|
  pristine 哈希 `43c5c851…` = **当前树上实现文件哈希**（还原真实性闭环）。D7（MUT2 首跑假绿）披露与 README/存档一致：存档为正则命中后的有效重跑。
- **D1-D9 逐条处置**：全部核实为真实披露、无掩饰——
  - D1：MT015 在树内确无报告无代码（reports/ 无 MT015.md）；已实现 cacheKey 规则与 MT014 范式一致且被验收 4 钉死；保留「以后续票定义为准」的正确姿态。
  - D2：三处既有文件编辑经 §0 独立重建证明纯追加、0 删除/0 既有行修改。
  - D3：`admin/capabilities.ts` 对 BASE 零字节改动（git 证实）；部署层「group 可放宽」与公司/团队层「覆盖只收窄」分层论证成立，收敛留待后续治理票合理。
  - D4：`agent-computer/src/egress` 只读 import（git 证实零改动）；canary 用例钉死错误值不透传。
  - D5：AC3 的 update/CAS 语义确需生产面；writer 走受限 operator 通道 + 真实 RLS（非 superuser 旁路）；管理/HTTP 面留后续票，边界清晰。
  - D6：目录不落库 = 结构性不可回写（无表、无语句引用、深冻结、行为+源级双重钉死）；动态目录管理留平台面后续票，`syncToCatalogRevision` 即未来输入。
  - D7：见上，诚实。
  - D8：空路由拒绝而非「无路由可用」的语义论证与 MT014 D6 对齐，实现/测试一致。
  - D9：夹具经真实 `provisionDeployment`（operator 通道）建两家公司三团队；`attemptCrossTenantInstallWrite` 是 RLS 证伪探针而非生产写路径——核实无误。
- **sha256-manifest**：34 项全 OK（报告写「33 项」，为计数笔误，见 §7-O3）。

## 5. 独立复跑（本复审树，全新容器）

| 项 | 命令 | 结果 | 预期 | 判定 |
| --- | --- | --- | --- | --- |
| 端口预检 | `lsof -i :55498` | 空闲 | 空闲 | ✅ |
| 容器 | `mt077-review-pg`（pgvector/pgvector:pg16，127.0.0.1:55498，trust） | up | — | ✅ |
| 六变量 env | /tmp 文件 0600（TEST/SETUP/DIRECTORY/DATA/OPERATOR + MT003_ASSIGNED），用后已删 | — | — | ✅ |
| 基础 migrate | `bun --no-env-file scripts/enterprise-test-db.ts migrate` | `{"type":"migrations-applied","status":"ok"}` exit 0 | 一次通过 | ✅ |
| 八任务 | generate + `migrate --apply --manifest` × MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077 | 全部 applied，journal 8 任务 18 步 | 依赖序全 apply | ✅ |
| 聚焦 | `bun --no-env-file test tests/multitenancy/routing-policy.test.ts --timeout 60000` | **37 pass / 0 fail / 0 skip**，140 expect，exit 0 | 37/0/0 | ✅ |
| 全量 | `bun --no-env-file test tests/multitenancy/ --timeout 60000` | **495 pass / 0 fail / 0 skip / 17 文件**，9218 expect，exit 0 | 495/0/0/17（458+37） | ✅ |
| typecheck | `bun run typecheck`（tsc --noEmit） | exit 0 | exit 0 | ✅ |
| biome | `bunx biome check`（7 触及文件） | Checked 7 files，No fixes applied，exit 0 | exit 0 | ✅ |
| 清理 | 容器 stop/rm、env 删除、/tmp 产物删除 | 完成 | — | ✅ |

全量 495 = 458（EXE 49 项基线，含 MT009 用例）+ 37（本票），17 = 16 + 1 文件——与 brief 预期精确一致，无需「先查装配」分支。零 skip：skipped 不计通过的纪律在本树成立。

## 6. 观察项（非阻塞，不要求修复）

- **O1**：报告 §7 交付物清单中的实施计划 `2026-10-16-mt077-routing-policy-impl-plan.md` 不在本复审树。核实为**系统性复制策略**：本树无任何票的 impl-plan（仅 briefs/checkpoints/reports），非本票特有缺失；不影响代码与验收证据。建议 coordinator 在归档侧确认该文件留存于实现树。
- **O2**：`routing-policy.test.ts` 存在用例间状态耦合（write→assert→restore 模式，依赖 describe 内执行序）。当前 restore 纪律严格执行且全绿，属可接受的 e2e 折衷；后续如增加用例注意保持。
- **O3**：两处计数笔误（不影响实质）：报告 §7 称 manifest「33 项」，实测 34 项（全 OK）；MUT4 的 README 归纳「验收 1 全体」实为「全部 resolve 读取路径用例（验收 1/2/4 共 11 个）」，实质正确、表述略宽。
- **O4**：`routeList` 复用 `routeRef` 时以 `{ value: entry }` 临时包装入参——可行但稍隐晦（judgement call，非违规）；biome/tsc 全绿。

## 7. 结论

| 裁决 | 内容 | 判定 |
| --- | --- | --- |
| A | 四条验收（归属生效/只收窄/模板不回写/生效点即时+无污染） | **通过** |
| B | 三表 DDL 与迁移（expand-only、最小 RLS、既有对象零改动、活库抽查） | **通过** |
| C | GREEN-1 7 处修复诚实性（测试侧 vs 实现侧归类） | **通过（诚实）** |
| D | TDD 链 + 变异 5/5 + D1-D9 处置 + 装配核对 | **通过** |

独立复跑 37/0/0、495/0/0/17、typecheck 0、biome 0 全部达标；装配核对证明三编辑文件的 MT009 合并未触碰本票增量（逐字节可证）。两任实现（第 1 任无磁盘增量、第 2 任从零）的披露与树内证据无冲突。**MT077 复审通过，无阻塞发现。**
