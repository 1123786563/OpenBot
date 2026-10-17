# MT001 Independent Review — Issue #44 / DAG node MT001

- Reviewer: Task `task_dd99d9577f09` / Dispatch `ctx_a5c5b74f62f3`（独立审阅者，与实施 Task `task_4ae1247de41a` / Dispatch `ctx_2e3104fdb0bd` 无共享会话）
- 冻结包：`review-packages/MT001.json`，canonical SHA-256 `b5fc671702bec097c61598f1839802868aa06826d878eeeb6e8a87308bb19f24`
- 审阅对象：仅快照（source worktree `i6-mt001` @ `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`）

## 快照完整性核验（审阅者独立复算）

- Canonical 包哈希：按 coordinator 规定算法（去 `package_sha256` 后 `json.dumps(sort_keys=True, separators=(',',':'))` UTF-8 SHA-256）复算 = `b5fc6717…19f24`，与冻结值**一致**。
- 包内 8 个文件哈希逐一复算：**全部一致**（含两份源文件 `inventory.ts`/`inventory.test.ts` 与 5 份 checkpoint/report 工件 + before.json）。
- 源工作树状态：HEAD = `f0520524…`（= execution_base = source_head），`git status` 仅两个 untracked 目 录，与 `checkpoints/MT001/sha256-manifest.txt` 及 before.json（owned_paths 冻结归属）一致；无越界编辑证据。
- 验证命令独立复跑（本审阅者在 i6-mt001 上只读执行）：
  - `bun test server/tests/multitenancy/inventory.test.ts` → **23 pass / 0 fail / 4963 expect()**，与 verification.txt 一致。
  - `(cd server && bun run typecheck)` → 通过（exit 0）。
  - `bun server/scripts/multitenancy/inventory.ts`（stdout 模式）→ exit 0，digest = `01f59d4e8216ee9b75bc3d87e9d60e31b88038ad3f5abdb353b87ecb442a2f46`，与冻结 inventory.json **一致**（确定性复现）；539 入口 / 未归属 539 / 未分类 0；两阶段均 skipped 且带原因。

## 裁决一：Spec 合规 — **PASS**（无阻断项）

四条验收标准逐条评估（Issue #44 原文为准）：

### AC1 清单来自真实应用装配（部署入口与企业入口）而非手写常量，包含动态与条件注册的路由 — **PASS**

- 部署入口：`createApp`（`src/app.ts:326`，实测 `createApp.length === 48`）真实调用，bare（60 条唯一路由）与 full（526 条）两变体（inventory.ts:270-388 `deploymentFullArgs`、:1398 `buildInventory`）；路由从真实 Hono `app.routes` 表提取（:366-372），非手写常量。
- 企业入口：`createConversationRoutes`（真实线）与 `createUnavailableConversationRoutes`（降级线）两条装配均真实调用（inventory.ts:399-410）；kb 服务入口用真实 `src/kb/router` 的 `createApp` + `buildRoutes`（:628-641）。
- 动态/条件路由有实证：CopilotKit runtime 动态挂载并结构校验路由表（:283-298）；测试断言 `GET /api/agents` 为 `conditional`（仅 full，不在 bare）、`ALL /api/copilotkit/*` 存在、`WEB_BOT_AUTH=on` 才出现的 `/.well-known/…` 为 conditional、企业两条线互斥（`GET /api/enterprise/conversations` 仅 full；`ALL /api/enterprise/conversations/*` 仅 unavailable）——inventory.test.ts:139-171。冻结 inventory.json：always 70 / conditional 467 / serve-level 2，与 4 个装配（60/526/523/12）自洽。
- 任一可选面装配失败落 `note`，不静默（inventory.ts:222-231 `attempt`）；4 装配 note 均为空（assembled）。

### AC2 输出机器可读清单（入口、类型、所属业务闭环、负责人任务、状态）与人类可读缺口报告 — **PASS**

- `CoverageInventory`（schemaVersion=1）入口条目字段齐全：`id/entrance/method/path/kind/type/businessClosure/ownerTicket/status/registration/registeredIn/registrations`（inventory.ts:81-103），测试锁定"恰好这些字段"且排序/唯一（inventory.test.ts:60-82）。
- 人类可读缺口报告按 23 个业务闭环枚举全部未归属入口，含数据表/后台程序/外部依赖/数据库阶段（inventory.ts:1485-1582）；gap-report.md 逐闭环计数相加 = 539（复核：7+21+23+9+19+52+3+43+33+59+12+17+6+20+1+21+11+77+5+41+32+8+19 = 539）。
- digest 为去 `generatedAt` 的稳定 SHA-256（:1329-1337），测试验证确定性（inventory.test.ts:99-107）；本审阅 CLI 复跑 digest 与冻结值一致。

### AC3 新增或删除一个入口后重跑清单，缺口报告随之变化，测试可检测到漂移 — **PASS**

- 新增：`mutateApp` 在 deployment-full 真实路由表上注入 `POST /api/drift-probe` → 清单+1、digest 变化、`unclassifiedEntrances`+1、缺口报告出现新条目与"未分类"区块（inventory.test.ts:266-293）。
- 删除：仅保留 `deployment-bare` 装配（= 条件入口来源消失）→ `GET /api/agents` 消失、totalEntrances 下降、digest 变化（inventory.test.ts:295-310）。
- serve() 层新增 WebSocket 升级分支由 tripwire 捕获：`server.upgrade(` 分支计数（实测 src/index.ts 恰 2 处）与已登记 stream 入口相等断言（inventory.test.ts:206-210）——新增第三分支会直接测试失败。注：删除/新增模拟发生在装配 seam（mutateApp/装配选择）而非改源文件，属测试内合理 seam，见 Info-7。

### AC4 缺少测试数据库配置时仍可运行（静态部分），数据库部分显式跳过并说明原因，不静默通过 — **PASS**

- `resolveTestDatabaseUrl`（inventory.ts:1188-1216）：`TEST_DATABASE_URL` 缺席 → refused，**绝不读 `DATABASE_URL` 兜底**；非法 URL/非 postgres 协议/未指名数据库均拒绝；指名 `openbot` 开发库的测试 URL 被拒绝（:1211）。
- 两阶段（`live-table-crosscheck`、`enterprise-capability-assembly`）skipped 时在 JSON `stages` 与报告中都带 `reason` + `requires`（:1236-1259、:1275-1298）；skipped 状态语义 = 未通过，报告明示"显式跳过 = 未通过，不静默"。
- 四个测试覆盖：无 TEST_DATABASE_URL 双阶段 skipped 且 reason 不含"通过"；环境里带着开发库 `DATABASE_URL` 也绝不回退（`NO_DATABASE` fixture，inventory.test.ts:18-21）；指名 openbot 的测试 URL 被拒；配置了但不可达的测试库响亮 `failed`（inventory.test.ts:334-397）。
- 命令 exit=0（静态部分可运行）——审阅者复跑确认。

### Spec A6 / A11 映射（Ticket「覆盖验收：A6, A11」）

- **A6（不回退默认；受限库跨范围拒绝）— MT001 份额 PASS**：A6 主体属后续闭环 Ticket；MT001 的份额是工具链层面的"不回退"纪律——专用 `TEST_DATABASE_URL`、拒绝 `DATABASE_URL` 回退、拒绝开发库指名、不可达响亮失败、skipped 不计通过，均有实现与测试（见 AC4）。这与 Ticket Handoff「缺少测试数据库配置时不得回退开发库」一致。
- **A11（明细清单为验收事实源；未分类/未归属阻断统一上线）— MT001 份额 PASS（带 3 项 Medium 完整性发现，须在 MT132 消费前跟踪修复）**：清单来自真实装配、539 入口全量枚举未归属、未分类入口机制化阻断（`unclassified` 哨兵 + 报告显式"阻断统一上线"区块 + 漂移测试证明新面会落入未分类）。§8 要求"从实际注册路由、后台入口、schema 和外部依赖生成明细"——路由/schema 满足；后台程序与外部依赖为静态候选提取（Scope boundary 明示），但存在下述 Medium-1/2 的结构性漏提，会使 A11 的"全部入口/后台程序/外部依赖"底数偏小。

### 539 未归属入口的诚实性与 unclassified=0 的证据性

- **诚实性：成立。** 539 条入口每条都带 method/path/kind/type/闭环/registration/装配来源逐条枚举在缺口报告中；`ownerTicket` 默认 null、status=unowned，归属只能经显式 `--ownership` 输入翻转（测试覆盖精确>前缀>闭环优先级，inventory.test.ts:240-264）；23 闭环计数相加恰为 539；无任何入口被静默归入某闭环或吞掉。作为"可行动缺口"：后续 Ticket 可直接按 entrance/前缀/闭环认领，契约字段已冻结（报告「生产的接口」节）。
- **unclassified=0：有证据支撑，非造假。** 分类器对未知路径返回 `unclassified`（`classifyPath` inventory.ts:771-789；测试 `/totally/new/surface` → unclassified），前缀匹配是段感知的（`/api/me` 不会吞 `/api/memory`，测试断言），尾表 `/*` 仅匹配字面量全局兜底路由、不会掩盖新面（漂移测试的 `/api/drift-probe` 落未分类即证）。unclassified=0 是"当前 539 条路径全部命中 curated 前缀表"的 computed 结果。保留意见：前缀表本身是人工元数据（代码注释明示"清单来自装配，分类来自本表"），个别归属（如 `POST /api/route`→bot）是判断而非机器校验——见 Info-9。数据表侧 25 张未分类、程序侧 3 个未分类均如实披露，未掩饰。

## 裁决二：代码质量 — **PASS**（无阻断缺陷；下列发现供后续跟踪）

实现结构清晰（装配→提取→分类→归属→阶段→digest→双输出），失败路径可见不静默，测试 23 例覆盖契约/装配/漂移/数据库纪律且断言真实行为而非实现细节；实现者报告与 Concerns 披露诚实（含 presence 替身、serve 层 tripwire、参数位次风险）。

## 发现清单（severity / blocking vs info，含文件:行）

| # | Severity | 阻断? | 发现 | 证据 |
|---|---|---|---|---|
| 1 | Medium | 否（MT132 消费清单前须修） | 外部依赖静态提取结构性漏提已映射系统：`CONFIG_SOURCES` 含不存在的 `src/kb/config.ts`（实际为 `src/kb/config/index.ts`，`existsSync` 守卫静默跳过）→ Qdrant/Ollama 从未提取；`src/redis.ts:80` 用 `env.OPENBOT_REDIS_URL`（参数名 `env`）不匹配正则 `environment\.([A-Z]…)`（inventory.ts:1085）→ Redis 缺失；`EXTERNAL_DEPS` 前缀 `"WECHAT"`（inventory.ts:1055）与实际键 `WXPAY_*` 不匹配 → 微信支付落入 unmapped。冻结清单 externalDependencies=14 中无 Redis/Qdrant/Ollama/微信支付（审阅者已对 inventory.json 复核） | inventory.ts:1037,1055,1069-1086；src/kb/config/index.ts:118,124；src/redis.ts:80 |
| 2 | Medium | 否（同上须跟踪） | 后台程序提取对其自身扫描源结构性漏提：`BACKGROUND_SOURCES` 含 `worker/src/index.ts`（无限循环 `for(;;)` :184 + `void main()`，routines 常驻扫描）与 `src/kb/worker.ts`（BullMQ `new Worker(` :83 常驻文档处理 worker），但正则仅匹配 `start[A-Z]…(`/`.start()`/`setInterval(`，两文件 0 条目；cron 驱动脚本（server/scripts/fire-routines.ts、fire-workshop-schedules.ts、cull-idle-computers.ts、cull-staged-attachments.ts，§8 职责闭环明列 `server/scripts/`）不在扫描源内。backgroundPrograms=7 全部来自 src/index.ts（该文件内匹配点恰 7 处，审阅者已复核），真实后台程序底数被低估 | inventory.ts:875-935；worker/src/index.ts:184,196；src/kb/worker.ts:83 |
| 3 | Medium | 否（AC 文义未违；A11 底数问题） | 部署拓扑中四个装配之外的服务面未入清单也未在缺口报告标注：`supervisor`（独立 Hono 进程，token 门禁路由，supervisor/src/index.ts:77+）、`go-runtime`（runtime-go/cmd/runtime/main.go:167 `http.Server`，execution/cancel 路由）、`agent-computer`/`agent-sandbox`（compose 独立服务）。AC 文义（"部署入口与企业入口"）已满足，但 What-to-build 的"全部 HTTP 入口"与 A11 事实源定位下这些面缺位；建议后续 Ticket 补装配或至少在 assemblies 区登记为未覆盖面 | docker-compose.yml:423-440（go-runtime）；supervisor/src/index.ts:77-101 |
| 4 | Minor | 否 | 默认 stdout 模式被 pino 日志行污染：`withCleanStdout` 重挂 `process.stdout.write`，但 pino 持有原始流引用，`{"level":30,…,"type":"openmuse-mail-placeholder-action-ids"…}` 先于 JSON 打到 stdout，`| jq` 消费会解析失败（verification.txt 亦可见该行）。`--out` 模式（checkpoint 所用）不受影响，inventory.json 干净 | inventory.ts:1613-1630；审阅者复跑 stdout 实录 |
| 5 | Minor | 否（已披露 Concern #1） | `createApp` 全量位置参数表（args[0..47]）依赖形参位次：`createApp` 增参会位次漂移，真路由工厂可能落在错误位次造成清单**静默收缩**（现有测试仅断言 full-bare>200，可被收缩吸收）。缓解：仓库既有 shared-wiring 测试同约定会先暴露 + digest 供 MT132 固定比对 + 工厂抛错落 note | inventory.ts:270-388（275 `new Array(createApp.length)`） |
| 6 | Info | 否 | `enterprise-capability-assembly` requires 3 个 URL（directory/data/runtime）但 ok 路径仅验证 directory+data（`result.verified: ["directory","data"]`），runtime URL 只作门槛未验证 | inventory.ts:1261-1298（1293） |
| 7 | Info | 否 | 漂移测试的"新增/删除"发生在装配 seam（mutateApp 注入路由 / 装配选择器），未改真实源文件——单测内合理选择，已注释说明；若要更强的源级漂移证据可由 MT132 在集成环境改源重跑比对 digest | inventory.test.ts:266-310 |
| 8 | Info | 否 | 开发库拒绝仅匹配数据库名恰为 `openbot`（`openbot_dev` 等变体可绕过）；主保障（结构上绝不回退 `DATABASE_URL`）不受影响 | inventory.ts:1211 |
| 9 | Info | 否 | 业务闭环前缀表为人工元数据，`unclassified=0` 表示"当前全部路径命中表"而非机器校验的语义正确性；个别归属是判断题，后续闭环 Ticket 认领时可顺带纠偏 | inventory.ts:683-756,771-789 |
| 10 | Info | 否 | `applyOwnership` 对外部依赖复用 `tablePrefixes` 目标（按依赖 id 匹配）——契约轻微复用怪味；重叠认领时按 ticket 键序先到先得，确定但任意 | inventory.ts:1128-1186,1427-1431 |

## 结论

- **Spec 合规：PASS**——四条 AC 全部满足且有可复现证据；A6/A11 的 MT001 份额达成，数据库纪律（无 TEST_DATABASE_URL 回退、显式 skip、不静默通过）严格成立。
- **代码质量：PASS**——无阻断缺陷；3 项 Medium（外部依赖漏提、后台程序漏提、四装配外服务面缺位）不违反本 Ticket AC 文义，但因清单是 A11 验收与 MT132 的"唯一入口事实源"，应在后续闭环/MT132 消费前修复或显式登记，修复将改变 digest（属预期漂移，须重冻结）。
- 过程合规：无越界编辑（git status 仅两个 owned untracked 文件）、无提交/推送/合并/部署、检查点哈希链完整且审阅者可复算。
