# MT001 修复轮独立复审（MT001-fix）— 三项 Medium 发现关闭验证

- 审阅者：Task `task_4954961364b8` / Dispatch `ctx_57996559d8ac`（独立复审者，只读；与实施 Task `task_4f2c3bcba4f0` / Dispatch `ctx_fcebe2db6b0d` 无共享会话）
- 冻结包：`review-packages/MT001-fix.json`，canonical SHA-256 `e67e0c23d1b912721c23f54ee22d02626003b42e20838fbfa8e51c6605fa529a`
- 审阅对象：仅本复审工作树 `/Users/wuyongjun/orca/workspaces/OpenBot/i6-review-mt001` 内的冻结快照（source worktree `i6-mt001` @ `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`，未提交）
- 前置输入：`reports/MT001-review.md`（原轮审阅，发现 1–3 为 Medium）、`docs/plans/2026-10-15-i6-mt001-review-fixes.md`（修复计划）

## 一、快照完整性核验（审阅者独立复算）

- **Canonical 包哈希复算一致**：按 coordinator 规定算法（去 `package_sha256` 字段后 `json.dumps(sort_keys=True, separators=(',',':'))` UTF-8 SHA-256）复算 = `e67e0c23…29a`，与冻结值**一致**。
- **19 个文件哈希逐一复算**：SHA-256 与字节数**全部一致**（含 2 个源文件、2 份报告、原轮 3 份 + 修复轮 10 份 checkpoint 工件、修复计划、原轮 review package）。
- **Before 副本可信**：`checkpoints/MT001-fix/before-inventory.ts`（`8f4566f0…cc4d`）与 `before-inventory.test.ts`（`a41f47d7…ca1`）与原轮 review package `MT001.json` 冻结的修复前源文件哈希**逐字节一致**；修复轮 diff 工件（`source-diff-inventory.txt`、`source-diff-inventory-test.txt`）与 before→after 实际 diff 的 hunk **逐字节一致**（仅 a/b 头差异）。
- **原轮检查点未被触碰**：`checkpoints/MT001/inventory.json`（`ee7351c0…`）、`gap-report.md`（`97d61dab…`）、`sha256-manifest.txt`（`8e18cf9d…`）与原轮 package 冻结值一致。
- **无越界编辑**：本快照 HEAD = `f0520524…`（= execution_base = source_head），`git status` 仅 4 个 untracked 路径（两源文件目录 + 计划/报告/检查点目录），与 before.json `owned_paths` 及两份 sha256-manifest 记录一致；无提交/推送/合并/部署/迁移。

## 二、验证命令独立复跑（本复审者在冻结快照上只读执行）

- `bun test server/tests/multitenancy/inventory.test.ts` → **33 pass / 0 fail / 5088 expect()**，与冻结 verification.txt **完全一致**（原轮 23 例全保留，新增 10 例；测试 diff 纯加法，删除行数 = 0）。
- `(cd server && bun run typecheck)` → **exit 0**。
- `bunx biome check server/scripts/multitenancy/inventory.ts server/tests/multitenancy/inventory.test.ts` → **exit 0**（Checked 2 files, No fixes applied）。
- `bun server/scripts/multitenancy/inventory.ts --out …`（两次独立运行）→ exit 0，digest 均为 `0965ecfa0ef5a0e6427f66796843bdcc21904d5bd7b670ac7f2b18b5a3fe30c9`，与冻结 MT001-fix/inventory.json **一致**（确定性 + 快照字节等价双证明）。
- 复审环境 `TEST_DATABASE_URL` 与 `DATABASE_URL` 均未设置；CLI 两阶段（`live-table-crosscheck`、`enterprise-capability-assembly`）均显式 **skipped** 且带 `reason` + `requires`（`inventory.ts:1426-1433`、`inventory.ts:1445-1453`）；"a DATABASE_URL is never used as a fallback" 测试通过（`inventory.test.ts:18-21` NO_DATABASE fixture 携带开发库 DATABASE_URL 仍拒绝回退）。

## 三、三项 Medium 发现逐条关闭验证

### 发现 1（外部依赖结构性漏提：Redis/Qdrant/Ollama/微信支付）— **GENUINELY CLOSED**

修复与真实配置形态逐一对照（本复审者在快照源码独立复核）：

- `CONFIG_SOURCES` 改用真实路径 `src/kb/config/index.ts`（inventory.ts:1095-1100）；该文件真实存在，且 Qdrant/Ollama/KB_Redis/KB_Database/Reranker/Docreader 均为 `env("QDRANT_URL",…)`/`envInt("KB_QDRANT_BATCH",…)` 辅助函数形态（src/kb/config/index.ts:116-133），新 helper 正则 `\benv(?:Int|Float|Bool)?\(\s*"([A-Z0-9_]+)"`（inventory.ts:1162-1163）真实命中。
- `src/redis.ts:80-81` 的 `env.OPENBOT_REDIS_URL` / `env.WORKSHOP_REQUIRE_REDIS`（参数名为 `env`）由新直接成员正则 `(?:environment|env)\.([A-Z][A-Z0-9_]+)`（inventory.ts:1165）命中。
- `WECHAT` 前缀改为 `WXPAY_`（inventory.ts:1123），与 `src/config.ts:2400-2405` 的真实键 `WXPAY_MCHID/WXPAY_APPID/WXPAY_API_V3_KEY/…` 匹配。
- 冻结清单复核：externalDependencies 14 → **22**；`Redis（workshop 总线与锁）`（OPENBOT_REDIS_URL+WORKSHOP_REQUIRE_REDIS）、`Redis（KB BullMQ 队列）`（KB_REDIS_URL）、`Qdrant 向量库`（QDRANT_URL/QDRANT_API_KEY/KB_QDRANT_BATCH）、`Ollama 嵌入`（OLLAMA_BASE_URL）、`微信支付`（7 个 WXPAY_* 键）全部在列，带配置键级证据；`unmappedConfigKeys` 中 **0 个** WXPAY_/REDIS/QDRANT/OLLAMA 键（原轮 7 个 WXPAY 键全部移出 unmapped）。原 14 个依赖 id 无一删除/改名（纯加法）。
- 回归测试 3 例锁定（inventory.test.ts:351-393）：Redis 双行、Qdrant/Ollama 键集、WXPAY 键映射且 unmapped 无 WXPAY。测试对修复前代码逻辑上必红（修复前冻结清单 externalDependencies=14 无 Redis/Qdrant/Ollama 行）。

### 发现 2（后台程序结构性漏提：daemon/BullMQ/cron）— **GENUINELY CLOSED**

- `BACKGROUND_SOURCES` 增加 4 个 cron 脚本（inventory.ts:908-913）；提取形态按优先级扩展：cron 文档声明（`Run from a CronJob`，程序名=文件名）> 顶层 `void …();` 守护启动 > `= new Worker(`（BullMQ）> 原 `start*()`/`.start()`/`setInterval(`（inventory.ts:967-985）。
- 冻结清单复核：backgroundPrograms 7 → **13**，新增 6 条全部带稳定 file:line 证据：
  - `../worker/src/index.ts#main`，证据 `../worker/src/index.ts:190: void main();`（常驻 `for(;;)` 循环起于 worker/src/index.ts:184 — 本复审者独立核对源码一致）；
  - `src/kb/worker.ts#worker`，证据 `src/kb/worker.ts:83: const worker = new Worker(`（BullMQ）；
  - 4 条 cron 脚本（fire-routines.ts:4 / fire-workshop-schedules.ts:4 / cull-idle-computers.ts:4 / cull-staged-attachments.ts:9，证据行均为文档注释 `Run from a CronJob…` — 源码逐一核对一致）。
- 原 7 条 src/index.ts 条目**逐字节保留**（复审者对 pre/post 清单程序条目做字节级比对：全部一致）；`classifyProgram` 增加源级归属表（worker→responsibilities、kb/worker→knowledge，inventory.ts:939-942），原名字规则仅追加（routine/workshop/computer/attachment），不影响原分类。
- 误报排查：`Run from a CronJob` 在其余扫描源（src/index.ts、src/kb/worker.ts）无命中（复审 grep 复核），worker/src/index.ts:77 的"has no CronJob around it"注释不匹配该词组边界正则；`new Worker(` 正则不会误吞 `new WorkerOptions(` 等。
- 回归测试 3 例锁定（inventory.test.ts:395-437）：daemon 名称/证据行格式 `^\.\./worker/src/index\.ts:\d+: void main\(\);`、BullMQ 证据 `^src/kb/worker\.ts:\d+: .*new Worker\(`、4 cron 源的 `source:\d+: ` 稳定 file:line 证据。

### 发现 3（四装配外服务面缺位）— **GENUINELY CLOSED（显式登记为未装配，非路由覆盖）**

- 新增 `serviceSurfaces` 契约段与 `extractServiceSurfaces()`（inventory.ts:120-137 类型、1192-1292 实现）：恰好 4 面 —— `supervisor`、`go-runtime`、`agent-computer`、`agent-sandbox`，全部 `assemblyStatus=unassembled`、`routeEnumeration=not_enumerated`、`status=unowned`、`ownerTicket=null`。
- 证据行真实且可独立复算（本复审者逐行核对）：`supervisor/src/index.ts:77: const app = new Hono();`、`supervisor/src/index.ts:195: serve({…})`、`docker-compose.yml:423: go-runtime:`、`runtime-go/cmd/runtime/main.go:167: srv := &http.Server{`、`docker-compose.yml:60: agent-computer:`、`docker-compose.yml:102: agent-sandbox:`。
- **绝无被虚计为路由覆盖**（复审者四重独立验证）：
  1. `summary.byClosure` 仅由 `entrances` 构建（inventory.ts:1614-1624），serviceSurfaces 不进入任何闭环的 total/unowned 计数；
  2. 冻结清单 pre/post `entrances` 数组**逐字节相同**（539/539/0，`byClosure` 亦相同）——修复轮对入口面零扰动；
  3. serviceSurfaces 只新增 `summary.serviceSurfaces` 计数（inventory.ts:1651）与独立数组，绝不进入 `totalEntrances`/`routeEntrances`/`catchallEntrances`；
  4. 缺口报告专属区块标题即"服务面（已知部署 · 未装配 · 路由未枚举 ≠ 已覆盖）"（inventory.ts:1699），summary 行明示"列出不构成路由覆盖"（inventory.ts:1677-1679），区块尾注要求"统一上线验收前须为其单独补装配或显式登记为未覆盖"（inventory.ts:1714-1716）。
- 不做假装配的理由成立且如实披露：supervisor 模块顶层 `serve()` 导入即起服务、go-runtime 为 Go 进程、两个 agent-* 为 compose 镜像（inventory.ts:1215-1218 注释 + 各面 note），与修复计划"unless real assembly extraction can be safely added"一致。
- 证据标记缺失时不静默：note 追加 `⚠️ 证据标记未找到：…`（inventory.ts:1273-1278）。
- 回归测试 4 例锁定（inventory.test.ts:439-528）：恰好四面集合、unassembled/not_enumerated/unowned 语义、真实证据行、报告诚实措辞、`mutateServiceSurfaces` 漂移钩子证明服务面**参与 digest**。

## 四、专项评估

### 加法式契约兼容（Additive schema compatibility）— 通过

- `schemaVersion` 保持 1（inventory.ts:70）；新增仅加法：`CoverageInventory.serviceSurfaces`、`summary.serviceSurfaces`、`ServiceSurfaceEntry`、`BuildOptions.mutateServiceSurfaces`、导出 `extractServiceSurfaces()`；原字段名/语义零改动（复审者对照 before/after diff 逐段确认）。
- externalDependencies：14 个原 id 无一删除/改名，纯增 8 行；unmappedConfigKeys 35→45 属数据变化（WXPAY 移出 + 新扫描面引入 17 个未映射键，全部显式列出，见 Info-4）。
- 文件头契约注释（inventory.ts:16-18）与修复轮报告附录均文档化了新字段；原轮报告"生产的接口"节按"原报告原样保留"策略未回改，由附录补记（Info-6，非阻断）。

### Digest 行为 — 通过（带一个既有怪味）

- 确定性：实施者两次 + 本复审者两次独立运行，digest 恒为 `0965ecfa…30c9`；修复轮漂移（`01f59d4e…` → `0965ecfa…`）已在报告/verification 中声明并要求 MT132 消费前重冻结。
- 服务面参与 digest：漂移测试实证（inventory.test.ts:504-528）。
- 复审者从持久化 JSON 独立复算两个 digest（含修复前 `01f59d4e…`）**均可复现**，但需先按实现语义重建 `assemblies[].note: undefined`（见 Info-2）。

### 无新增静默遗漏 — 通过

- 服务面证据标记缺失 → note 显式 ⚠️；unmapped 键全量列出；装配失败落 note（沿袭原轮）；cronDoc/daemon/BullMQ 形态优先级注释清晰。
- 结构性残留（非新增）：`CONFIG_SOURCES`/`BACKGROUND_SOURCES` 的 `existsSync` 静默跳过模式沿袭原轮（inventory.ts:956、1152）；缓解是三条真实路径现已被回归测试钉死（文件消失 → 测试红），可接受（Info-7）。

### 证据工件安全/脱敏 — 通过

- 本复审者对 19 个包文件独立做凭据模式扫描（URL 带凭据 / AKIA / sk- / 私钥头 / ghp_ / xox）：**零真实凭据命中**。唯一模式命中为 `postgres://openbot:openbot@localhost:5432/openbot` —— 系测试文件 NO_DATABASE fixture 的本地开发占位串（修复前即存在，用于证明绝不回退 DATABASE_URL），verification.txt 中对该命中的注记属实。
- inventory.json / gap-report.md 仅含配置键**名**与源码行切片，无任何环境变量**值**；cli-run.stderr 仅含警告与日志元数据（KEY_ENCRYPTION_KEY 警告只提及键名与指引，不含键值）。

### 新增回归 — 未发现

- 原轮 23 例测试零改动全绿；7 条后台程序、14 个外部依赖、539 入口、byClosure、serve 升级 tripwire（2/2）全部保持；`resolveTestDatabaseUrl`（inventory.ts:1362-1389）与原轮逐字一致（仍拒绝 DATABASE_URL 回退、仍仅拒绝精确 `openbot` 库名——Info 级发现 8 如实保持原状）；企业阶段门槛行为不变（发现 6 保持原状）。
- `classifyPath` 仅一处 biome 格式化变更（语义等价，diff 可证）。
- 发现 4（pino 污染默认 stdout 模式）本复审者复现仍在：默认模式 stdout 首行为 pino 日志、`json.load` 失败；`--out` 模式（checkpoint 所用）JSON 文件干净不受影响——与实施者"保持原状、不在本轮范围"的披露一致。

## 五、发现清单（本轮复审；severity / blocking）

| # | Severity | 阻断? | 发现 | 证据 |
|---|---|---|---|---|
| 1 | Minor（沿袭原轮发现 4，非本轮引入，未恶化） | 否 | 默认 stdout 模式仍被 pino 日志行污染，`| jq` 会解析失败；MT132 若用 `--out` 模式不受影响，建议后续波次修复 | inventory.ts:1813-1830 `withCleanStdout`；复审者复跑默认模式实录（stdout 首行 `{"level":30,…openmuse-mail-placeholder…}`） |
| 2 | Info | 否 | digest 对内存对象计算，`assemblies[].note: undefined` 以字面 `undefined` 参与哈希但不出现在落盘 JSON —— 第三方无法从 inventory.json 朴素复算 digest（重建 note:undefined 后可复算，复审者已验证两个冻结 digest 均可复现）。既有行为，非本轮引入 | inventory.ts:1495-1507 `stableStringify`/`digestOf`；复审者复算实验 |
| 3 | Info | 否 | TDD RED 阶段输出未作为工件冻结（报告声明 10 例先红）；但复审者对照 before 代码与冻结 pre-fix 清单逻辑验证：新断言（serviceSurfaces 字段、Redis 行、worker daemon）对修复前实现必然失败，red-ability 成立 | 报告 MT001.md 修复轮节；before-inventory.ts；checkpoints/MT001/inventory.json |
| 4 | Info | 否 | `unmappedConfigKeys` 35→45：新增的 KB 功能开关（KB_EMBED_MODEL 等 13 个）与 PORT/SERVER_PORT 等 4 个通用键待后续闭环归类；已全量显式列出（非静默），且报告如实声明 35→45 | checkpoints/MT001-fix/inventory.json `unmappedConfigKeys`；MT001.md 诚实性声明 |
| 5 | Info | 否 | `applyOwnership(serviceSurfaces, ownership, {})` 允许闭环级认领把服务面翻成 `owned` —— 语义为"有 Ticket 认领责任"，与路由覆盖（仍 not_enumerated）正交；建议 MT132 消费时文档化"owned ≠ covered" | inventory.ts:1607；inventory.ts:1302-1356 `applyOwnership` |
| 6 | Info | 否 | 原轮报告"生产的接口（字段名勿改）"节未回补 `serviceSurfaces`；由修复轮附录补记，符合"原报告原样保留"策略，但 MT132 读者需读附录才能拿到完整契约 | reports/MT001.md（原节 + 修复轮附录） |
| 7 | Info | 否 | `CONFIG_SOURCES`/`BACKGROUND_SOURCES` 的 `existsSync` 静默跳过为沿袭模式；现被回归测试有效钉死（路径失效即测试红），可接受 | inventory.ts:956、1152 |
| 8 | Info（沿袭原轮发现 5/6/8/9/10，均未恶化） | 否 | createApp 参数位次依赖、企业 runtime URL 只作门槛未验证、开发库拒绝仅匹配精确 `openbot`、闭环前缀表为人工元数据、外部依赖复用 tablePrefixes 认领目标——全部保持原状，与实施者披露一致 | inventory.ts:270-388、1445-1480、1382-1385、683-760、1601-1607 |
| 9 | Info（新增建议） | 否 | `SERVICE_SURFACE_SPECS` 为静态手列清单：未来 compose 新增服务不会自动登记，也无类似 `serveUpgradeBranches` 的 tripwire。符合本轮"显式登记"的设计意图，但建议后续波次为 compose 服务名增加漂移 tripwire（对比 compose 顶层服务 vs 已登记面） | inventory.ts:1219-1252 |

## 六、裁决

### 裁决一：Spec 合规（相对修复计划 `2026-10-15-i6-mt001-review-fixes.md` 与原轮发现 1–3）— **PASS**

- 三项 Medium 发现全部**真实关闭**，非表面修补：每一项都有 (a) 对真实仓库源码的形态核对（本复审者独立重验，非转引实施者证据）、(b) 冻结清单中的可复核产物、(c) 锁定行为的回归测试（10 例新增、对修复前代码逻辑必红）。
- 服务面处理符合计划 Review Focus 的全部要点：显式列出、unassembled/not_enumerated、不声称路由枚举、未被计入路由覆盖（ entrances 逐字节不变 + byClosure 排除 + 报告显式声明）、未验证即 unowned。
- 契约加法兼容（schemaVersion=1 不变、原字段零改动）；digest 确定性复现；数据库纪律（无 TEST_DATABASE_URL 显式 skipped、绝不读 DATABASE_URL 回退）经复审者在本快照独立复跑确认不变。
- 过程合规：无越界编辑、无提交/推送/合并/部署/迁移/启用/发布；检查点哈希链完整且本复审者全部独立复算通过。

### 裁决二：代码质量 — **PASS**

- 实现是最小而准确的既有 seam 扩展：不动装配/分类/归属主流程，仅修正提取源与形态、新增显式登记段；诚实语义贯穿类型层（`unassembled`/`not_enumerated` 字面量联合类型）与输出层（JSON 字段 + 报告措辞 + ⚠️ 缺证标注）。
- 测试断言真实行为（真实源码行、真实键名、digest 漂移），非实现细节镜像；原 23 例零删改。
- 未发现本轮引入的任何回归；沿袭发现（Minor 1 项 + Info 若干）均如实披露、未恶化，按计划留在后续波次。

### 后续跟踪建议（非阻断）

1. 修复轮 digest `0965ecfa…` 已取代 `01f59d4e…` 成为新的待冻结基线，MT132 消费前须以本包（canonical `e67e0c23…`）重冻结。
2. 将发现 9（compose 服务名 tripwire）与发现 1（stdout 污染）纳入下一次清单维护波次。
3. MT132 文档化"服务面 owned ≠ covered"与 digest 的 note:undefined 复算约定（发现 5、2）。

**结论：MT001 修复轮通过独立复审，三项 Medium 发现确认关闭，可进入集成；无阻断项。**
