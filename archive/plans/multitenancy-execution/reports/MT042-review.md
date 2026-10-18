# MT042 独立复审报告 — 平台扫描作用域重建（Issue #85）

**Verdict：PASS**（附 1 项 Major 证据完整性 finding，已被复审者独立重放完全缓解；1 项 Minor 存档 provenance finding；2 项 Info。均不推翻交付质量结论。）

- 复审者：独立复审者（只读复审；除 brief 明示的变异重放外零生产/测试文件改动，零 git 提交）
- 对象树：r14-mt042 工作树（BASE=f0520524 + 未提交变更；MT042 内容与孤儿 checkpoint 对象 `3ee2c549` 字节级核对）
- 复审环境：**从零 provision**，容器 `mt042-review-pg`（pgvector/pgvector:pg16）@ 127.0.0.1:**55574**，库名 `openbot_enterprise_r14d` / `openbot_enterprise_r14d_assigned` / `openbot_kb_r14d`（review brief 指定，与实现轮 w14b/55564 完全隔离）
- 结论性数字均为复审者本轮亲跑；存档数字仅作交叉参照。

## 1. 复审方法与证据点

| # | brief 必做项 | 复审动作 | 结果 |
|---|---|---|---|
| 1 | 三步配方从零 provision（r14d/55574，链序 MT112→MT012） | 按存档 `provision-db.sh` 配方在 /tmp 生成复审副本（**存档脚本零改动**；其链序已含修正，见 §3-D1），container→三库+kb owner→base migrate→17 任务链 apply 一次成功 | ✅ journal 17 任务（MT042 最后，1 步 `job_ownership_operator_sweep_read` 策略臂），受限登录 4 登录角色（ent_r14d_*）+ 4 能力角色（ob_ent_*，含 identity_operator），与存档 12 号证据同构 |
| 2 | 聚焦 scan-executor.test.ts | `bun test tests/multitenancy/scan-executor.test.ts` | ✅ **15 pass / 0 fail / 105 expect / exit 0**（= 报告 13/18 号证据） |
| 2 | 全量回归 | `bun test tests/multitenancy/` | ✅ **1005 pass / 0 fail / 39 文件 / 12192 expect / exit 0**（= 报告 14/17 号证据口径） |
| 3 | 变异抽验 ≥4，必含 MUT10+MUT12 | 自建变异重放器：MUT1/MUT2/MUT4/**MUT10**/**MUT12** 共 **5 条**，逐条 注入→聚焦跑→字节复原→SHA-256 复核 | ✅ **5/5 KILLED**（详表 §2），终态哈希与 pristine 逐位一致 |
| 4 | 冻结面 5 文件 vs after-hashes.txt | 逐文件 SHA-256 复算 | ✅ **5/5 全等**（migrate-test.ts `03fb26…`、migration-tool.test.ts `2b3a83…`、tenancy/job-ownership.ts `45d1b5…`、scope-gate.ts `895b0e…`、schema/job-ownership.ts `ca6450…`） |
| 附加 | 静态安全核对（AC1–AC4 实现面） | 通读 scan-executor.ts（639 行）、support/scan-executor.ts、聚焦套件全文 | ✅ 见 §3 |
| 附加 | typecheck / biome（同口径） | `bun run typecheck`；`bunx biome check` 3 个触及文件 | ✅ 双 exit 0 |

环境依赖注记：本工作树初始无 `node_modules`，复审者执行 `bun install`（工作区依赖安装，非仓库文件改动）后测试方可运行。

## 2. 变异重放明细（5/5 KILLED，全部即时字节复原）

| Mutant | design §6 定义 | 注入点（scan-executor.ts） | 捕获用例 | 判定 |
|---|---|---|---|---|
| MUT1 | 扫描认领投递 payload（AC1 泄漏） | 认领 SQL `returning` 追加 `"payload"` 列 + payload 贯通进 `ScannedItem` | AC1 "lists due jobs of two companies and never reads the payload"（Object.keys 恰 4 键断言破裂 + canary 泄入结局 JSON）；连带 AC2 ghost 用例（payload 泄入拒绝项） | **KILLED**（2 fail） |
| MUT2 | pin 缺失仍重建（AC2 权威行） | `SCAN_RECORD_MISSING` 早退改为伪造 facts 继续 | AC2 "refuses an item with no authoritative record"（code 断言 SCAN_RECORD_MISSING 落空） | **KILLED**（1 fail） |
| MUT4 | dev-local-user 拒绝移除（AC3） | 删除 `createMachineScanIdentity` 的 dev-local-user 拒绝分支 | AC3 "is not a user login"（`toThrow(MACHINE_IDENTITY_INVALID)` 落空） | **KILLED**（1 fail） |
| **MUT10** | 撤权成员仍执行（签发判定旁路）**[必含]** | `issueScheduleScope` 抛错改为手造 scope 继续执行 | 两条撤权用例（company/team membership revoked）——gate 以 UNVERIFIED_SCOPE 拒绝手造 scope → 结局变形，`refused/SCAN_SCOPE_UNRESOLVED` 断言破裂 | **KILLED**（2 fail；与报告"MUT10:2"一致） |
| **MUT12** | 拒绝理由回显消息值（零回显违约）**[必含]** | malformed 拒绝结局携带原始 key（经 claim 路径回传 rawKey） | "refuses a malformed key deterministically and never echoes it"（`item` 应 undefined + JSON 不含原始键，双双破裂） | **KILLED**（1 fail） |

每轮复原后 SHA-256 = pristine `27d675b619b3…f57d`（= 报告 §0.3 声明的生产文件哈希，= 复审终态哈希）；复原后聚焦套件复跑 15/0 绿。捕获日志存 /tmp/mt042-review/mutation/（复审会话产物，未写入仓库）。

## 3. 专项核对（票面安全核心）

### AC3 机器身份结构性不可冒充 — ✅
聚焦套件三个 AC3 用例、四个拒绝断言全部真实存在且断言到点：
1. `assertTrustedScope(machine)` → `UNVERIFIED_SCOPE`（scope 注册表拒收）；
2. MT041 `service.listJobs(machine)` → sentinel `UNVERIFIED_SCOPE`；
3. MT005 `gate.transaction(machine)` → sentinel `UNVERIFIED_SCOPE`；
4. 手造同形 `{kind:"machine-scan", id}` → `assertTrustedMachineIdentity` 抛 `MACHINE_IDENTITY_INVALID`（WeakSet 对象身份，结构≠信任）。
另有：`dev-local-user` 在签发入口响亮拒绝（MUT4 钉死）；机器 id 冒充 principal 走真实签发入口被 `TENANT_FORBIDDEN` 拒绝且转机器码；用户 Scope 驱动 `scanAndExecute` 被拒（`cannot be driven by a user scope`）。实现面执行者恒为 `{kind:"worker", id:<machine.id>}`，与 principal 词表隔离。

### AC4 反序列化 Scope 一律拒 — ✅
"rejects deserialized and cloned scopes and machine identities" 用例覆盖：`JSON.parse(JSON.stringify(scope))` 与 `structuredClone(scope)` 两种副本均被 gate 以 `UNVERIFIED_SCOPE` 拒绝；**且覆盖机器身份 clone**：`structuredClone(machine)` 驱动 `scanAndExecute` → `MACHINE_IDENTITY_INVALID`。断言到点。

### AC2 权威行重建 + AC1 载荷隔离 — ✅
- "executes under the authoritative record's scope, ignoring wrong message hints"：消息伪造 `tenantId/workspaceId/principalId`（指向 B 公司 + forged-principal），执行仍按权威 pin 行落 A 公司（scope 四字段断言 + `entrypoint === "schedule"` + `assertTrustedScope` + 租约行落在正确公司/团队）。
- "refuses an item with no authoritative record"：`SCAN_RECORD_MISSING` + canary/tenantId 零回显 + 零租约行。
- AC1 结构性白名单：认领 SQL `RETURNING "key","run_at","attempts"`（payload 列不在扫描面，MUT1 钉死）；`ScannedItem` 无载荷字段；`ScanExecuteContext` 不含 payload；canary 零出现在任何结局/回调。拒收矩阵六哨兵码确定性，`sentinelOf` 不透传内部错误文本。

### 披露① 复核（四任 +12/−7）— ✅ 无夹带
以 checkpoint 对象 `3ee2c549` 为基线对工作树 `scan-executor.test.ts` 做全文 diff：**恰好 +12/−7，且仅两处**——(a) AC1 调用点 `executorRecording(machine, recorded)` → `executorRecording(recorded)`（实参错位修复，与函数签名 `(into, behavior?)` 及其余全部调用点一致）；(b) MUT11 增强（malformed 用例追加 `widget:<id>` 越词表 offer，拒绝数 1→2 + 三条新断言）。生产文件 `scan-executor.ts`、`migrate-test.ts`、`migration-tool.test.ts`、support 文件与 `3ee2c549` **字节全等**——四任未改任何生产代码的声明属实。

### 披露③ 链序修正 — ✅
存档 `provision-db.sh` 链序为 `MT004→MT008→MT112→MT012→…→MT042`（脚本头注记修正原因：MT012 对 MT112 创建的 `enterprise_deployment_anchors` 做 ENABLE/FORCE RLS）。与 MT041.md §2 存档已验证链序（`MT004→MT008→MT112→MT012→…`）MT112→MT012 相对序一致。复审在全新 r14d 库上按该序一次通过，实证修正有效（旧序在全新库上会于 MT012 失败的机理成立：复审库在 MT112 前不存在该表）。

### 历史存档分裂闭环 — ✅
red-green 存档确有分裂：GREEN-1（11 pass/4 fail，AC1 fail）、GREEN-3（AC1 fail 且伴 5s 超时）vs GREEN-2/GREEN-4（14 pass/1 fail，AC1 **pass**）；GREEN-5/6 与 verification/01、02 确如披露仅存 3–7 行摘要尾。机制闭环成立：`3ee2c549` 版本 AC1 调用点即存在实参错位，`machine` 落入 `into: RecordedExecution[]` → 回调内 `into.push` TypeError → 被 gate 事务 catch → 两项结局恒 released → AC1 断言 `["executed","executed"]` 必红（GREEN-1/3 实录）；GREEN-2/4 的 pass 只能来自其间未落盘的编辑往返（报告推测合理）。复审亲跑修复后版本，AC1 用例确定性绿（15/0），闭环完成。

## 4. Findings（分级）

### Major
- **F1（证据完整性）：`checkpoints/MT042/mutation/` 在交付树中缺失。** 报告 §0.2/§2 声称的 12 份 `MUT*-TEST-FAILS.txt` + `README.md` 既不在工作树、也不在 checkpoint 对象 `3ee2c549` 内（verification/12–20 在，mutation/ 不在），报告的「12/12 KILLED」自证在交付态**无法从存档核验**。缓解：复审独立重放 5/12（含两条必含项）全部 KILLED、复原字节级无损，实质质量声明得到独立佐证；且该缺失恰被 review brief「复审者自行重注入」程序兜住。**处置建议**：coordinator 决定是否要求补档或以本复审重放记录替代；不据此翻 verdict。

### Minor
- **F2（存档 provenance）：本工作树 HEAD 漂移至 BASE f0520524（detached），checkpoint 对象 `3ee2c549` 无任何 ref 可达（reflog 空）。** 报告/brief 所述「checkpoint 描述本树」在本 materialized 树上不成立，全部 MT042 内容处于未提交状态。「零 git 提交」约束对四任与复审者均属实；内容完整性已由复审者对 8 个关键文件做 `git show 3ee2c549:<path>` 字节级比对排除漂移。**处置建议**：coordinator 尽快以显式 ref 落盘保全，避免对象被 gc。

### Info
- **F3：存档与复审的 expect() 计数差 2**（13 号 103 vs 复审 105；14 号 12190 vs 12192；17 号 12189）。pass/fail/文件数逐项相等，无门槛影响；推测为 bun 版本或环境相关断言计数差异。
- **F4（配方确认，非缺陷）**：provision-db.sh 已含链序修正（披露③成立），复审无需「先修再跑」；r14d/55574 从零一次成功，未触碰 55568 备用端口。

## 5. 结论

票面四条验收（AC1 元数据扫描/载荷零可见、AC2 权威行重建/消息仅提示、AC3 机器身份类型隔离、AC4 反序列化拒收）在独立重建的环境（r14d/55574）上由 15 用例聚焦套件 + 1005/0/39 全量回归 + 5/5 变异重放（含必含 MUT10/MUT12）+ 5/5 冻结面哈希全等 + typecheck/biome 双零，**全部独立复现达标**。两项披露（①测试修复、③链序修正）经字节级/存档级核对属实且无夹带；历史 GREEN 分裂的「实参错位必红」解释机制闭合。唯一 Major finding 是变异自证存档缺失（F1），属证据落盘问题而非实现缺陷，已被复审重放缓解——**verdict：PASS**。

*复审产物（会话临时区，未入仓库）：/tmp/mt042-review/{provision-run.log, focused-run.log, full-run.log, mutation/*.log, run-mutations.py, scan-executor.pristine.ts}*
