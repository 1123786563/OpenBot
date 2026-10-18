# Ticket #207 检查点独立 Review — Bifrost 01.1 网关地址与连接配置持久化

- **Reviewer**: 独立 Pi reviewer（与实现者不同 agent，非自审）
- **BASE**: `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（`git rev-parse HEAD` 独立核验一致；分支 `1123786563/issue5-207`）
- **检查点形态**: 未提交工作区快照；修改 4 文件 + 未跟踪 10 文件（8 交付物 + 2 ledger 文档），`git status --porcelain -uall` 全集核验，无额外文件
- **Review 方式**: 只读核验 + 在专用库 `openbot_207` 重跑验证命令；未修改任何实现/测试文件，未 commit、未 push、未做任何集成

## 结论

| 维度 | 结论 |
| --- | --- |
| **Spec compliance** | **PASS**（4 条验收标准全部以证据核验通过；与票面差异均已披露且理由成立） |
| **Code quality** | **CHANGES**（1 项 Medium 必修：timeout 无上界 → int4 溢出 → 500；其余为 Low/Info） |

代码质量整体优秀：单一职责的纯校验模块、单一事实源的拒绝文案、事务内原子版本递增 + commit 送达通知、严格只读形状。唯一的必修项是一个小而真实的输入验证缺口。

---

## 一、独立哈希清单（完整 SHA-256，逐文件独立计算）

`file-hashes.txt` 使用 16 位十六进制短哈希；下表为本次独立计算的**完整 SHA-256**，短哈希逐条比对全部一致（前 16 位匹配）。

| 文件 | 状态 | 完整 SHA-256 | 与清单短哈希一致 |
| --- | --- | --- | --- |
| `server/src/gateway/endpoint.ts` | untracked | `e845082383207ddce61f61e6100753d852b1a81fe3ba077a8ff8c27187bb0534` | ✓ |
| `server/src/gateway/config-store.ts` | untracked | `963f082e066142c8efc5191dc31352348331c84840a52e53dbf0e5db362b77c3` | ✓ |
| `server/src/gateway/routes.ts` | untracked | `da7e54dec6b9f12f90eccf3a56e225462834ea889c0c7910a42374993fbcc2f0` | ✓ |
| `server/src/db/schema/gateway.ts` | untracked | `849f91868518de0f3651676ae3428ee3c8e747429a98a13df3ae166714128f2d` | ✓ |
| `server/src/db/schema/index.ts` | modified | `f8fa962c18c03f6a3d2769a1bc371a7aa267312f36103b92d2112c931a4dacef` | ✓ |
| `server/drizzle.config.ts` | modified | `16e5456f894c58280b1d609b87708a30fe1b69d6c568f0618228719795863f32` | ✓ |
| `server/src/config.ts` | modified | `05873af2d6b5ccb270244177160df13dd5a2b7a684dab2708bd77aab9f808f00` | ✓ |
| `server/drizzle/0122_gateway_endpoint_config.sql` | untracked | `e452ae4f93086d2ca3d10a8b50e3a3db983e7d62ce8e3260811ac1e12da758d1` | ✓ |
| `server/drizzle/meta/0122_snapshot.json` | untracked | `31b406c9d58917e6da33276120e4e59fe477bd40f90fd54fba50737f5f714ff9` | ✓ |
| `server/drizzle/meta/_journal.json` | modified | `39e657fba083cd70d155857ff38f3ce85abd103f51d0c208cacf19f0e9be2cf8` | ✓ |
| `server/tests/gateway-endpoint-config.test.ts` | untracked | `838cc2f9c9d53175b1513866fe01d6a95e82c39d57aef47f508be8a80d308827` | ✓ |
| `server/tests/gateway-endpoint-config.integration.test.ts` | untracked | `1f0a03b14bd7862e3756445bff1252a9138fa2491f387adc57ca90dd1173dc84` | ✓ |

计算命令：`shasum -a 256 <12 files>`（macOS，2026-10-15 快照现场）。清单 `BASE=f0520524...` 行与实际 HEAD 一致。

## 二、验收标准逐条核验（对照 `docs/tickets/bifrost-5/issues/01.1-gateway-endpoint-config.md`）

| AC | 结论 | 证据 |
| --- | --- | --- |
| 管理员保存合法网关地址后，重启读取地址与 configVersion 一致 | **PASS** | 集成测试 "a reconstructed store (restart) reads the same endpoint and version"：新连接重建 store 读取相等（本 review 重跑通过）；`gateway_configs` 单行持久化，`openbot_207` 上 123 条迁移应用成功 |
| 空值、非 http(s)、带凭据、带 path 的地址被拒绝并返回可解释原因 | **PASS** | `parseGatewayBaseUrl` 五类拒绝（missing/protocol/credentials/path+query+fragment），单元测试逐条断言文案；HTTP 面 400 带具体 reason（集成测试断言 `"Gateway base URL must not carry credentials."`）；env 面启动即 throw。均本 review 重跑通过 |
| 只读查询响应中不存在任何凭据或 Secret 字段 | **PASS** | `readGatewayEndpoint` 显式 select 恰三列（baseUrl/requestTimeoutMs/configVersion）；表结构无任何 secret/token/password/credential 列（`\d gateway_configs` 核验）；GET/PUT 响应均为 `{gateway: 三字段}` 或 `{gateway: null}`；集成测试断言只读形状与行内列名均不匹配敏感词 |
| 连续两次成功保存 configVersion 严格递增，旧版本不可写回 | **PASS** | upsert `config_version = config_version + 1` 于事务内原子递增；输入不携带版本字段，结构性无法写回旧版本；集成测试三次保存 1→2→3 严格递增并断言读回一致 |

## 三、重点审查项（dispatch 指定关注点）

### 3.1 严格端点 URL 校验 — 通过（附 Info）
`endpoint.ts` 纯函数：trim → 非空 → WHATWG URL 解析 → 仅 http/https → 拒绝 username/password → `pathname.replace(/\/+$/,"")!=="" || search || hash` 拒绝。返回 `parsed.origin`（规范化存储）。与 `config.ts` 中 LAGO_API_URL 校验语义一致（同一拒绝模式，含 "/api/v1 专属提示" 差异为 LAGO 特有）。见 F3（Info）：WHATWG 宽松形态如 `http:/example.com` 被规范化接受为 `http://example.com`——与 LAGO 先例一致，存储值为规范化 origin，不构成缺陷。

### 3.2 Secret 不返回不存储 — 通过
行内无敏感列；读取接口列裁剪；`updatedBy`/`updatedAt` 为内部簿记不外露；`GatewayConfigRecord`（含簿记字段）类型未出现在任何读取接口。AC19（本票映射的验收）在此切片内满足。

### 3.3 Timeout 边界 — **发现 Medium 缺口（F1）**
`parseRequestTimeoutMs` 只校验正整数，**无上界**：DB 列为 int4（max 2,147,483,647）。实测（专用库探针）：`PUT requestTimeoutMs=3000000000` 通过解析 → INSERT 报 `PostgresError: integer out of range` → **500 Internal Server Error**（事务回滚，无脏数据），违背该路由自身"非法输入 400 带可解释原因"的契约。env 路径同样无上界（值仅入内存，但可配置出 ~596 小时的超时）。修复建议一行：`parseRequestTimeoutMs` 拒绝 `> 2_147_483_647`（DB 对齐）或更严格运营上限（如 600_000ms）。

### 3.4 configVersion 原子/单调语义 — 通过
单条 upsert 于单事务内完成"读当前值 +1"（Postgres 行锁串行化并发冲突更新，无丢失更新）；`pg_notify(GATEWAY_CONFIG_TOPIC, String(newVersion))` 在同一事务内发出、commit 送达——集成测试用独立 listener 连接实证收到新版本号。两次并发保存必然得到 n+1、n+2（第二事务阻塞于行锁后递增）。与 settings-store 的 commit 送达模式同构。

### 3.5 认证路由与未挂载是否满足本切片 — 满足（附 F5 集成注意）
`routes.use("*", requireUser)` 全覆盖；PUT 前置 `requireAdmin(context)`（403 语义与 `auth/guards.ts` 既有模式一致，非管理员 PUT 403 且版本不变已实证；非管理员 GET 允许读只读形状）。**未挂载到 app.ts**：全仓 grep 证实 `createGatewayConfigRoutes` 无任何生产引用。判断：票面 write scope 不含 app.ts，"越界即停并上报"约束下，交付可独立挂载的工厂 + 测试内按生产 seam 挂载验证 + 检查点显式披露，是正确处理而非静默降级。挂载一行留给集成者/01.2。**含义**：AC 在工厂 seam 层验证而非生产进程层——对本切片（配置持久化）可接受，但 01.2/01.8 消费时必须完成挂载，否则配置面不可达。

### 3.6 启动/配置优先级与网关保持禁用 — 通过
`gatewayEnvConfig`：两者皆未设 → 无 `gateway` 块；仅设 timeout → 拒绝启动；BASE_URL 非法 → 拒绝启动（复用与保存路径同一解析器，同一文案）。空串经 `optional()` trim 语义视为未设置（与 LAGO_* 一致，披露项 5 准确）。**无任何消费者**：`config.gateway` / `readGatewayEndpoint` / `GATEWAY_CONFIG_TOPIC` 在 gateway 模块与测试之外零引用，模型流量未切换，网关保持禁用。env 与 DB 行的运行时优先级仅作为 seam 契约注释（DB 为运行时事实源、env 为部署级默认），实际裁决顺延至 01.5/01.7——本切片未引入冲突。

### 3.7 Drizzle 迁移 0122 与 #215/#234 碰撞 — **确认三方碰撞（F5），未集成（遵 dispatch）**
- 本快照 `0122_snapshot.json`：`id=533380cc-…`，`prevId=fbb4e855-…` == 0121 的 id（链局部完好）；表集合 == 0121 全表 + 恰好一个 `public.gateway_configs`（其余表逐字节相等）；journal idx=122、`when` 单调（1792008991185 → 1792039004488）；SQL 与 openbot_207 实际表结构一致（PK only，无 singleton 索引，与快照 `indexes:{}` 一致）。
- 表块来源核验：与波次 1 已验证的 `bifrost-wave1` 0112 快照表块逐字段相等，唯一差异为披露的 `gateway_configs_singleton` 唯一索引移除（与 PK 重复）；wave1 0112 的 prevId 确为当前 0121 的 id（检查点声称准确）。
- **碰撞事实**（各 sibling worktree 只读探查）：`issue5-207` = `0122_gateway_endpoint_config.sql`；`issue5-215` = journal idx 122 `0122_payer_accounts`（有 SQL/journal 但**缺 0122 快照文件**，其侧不自洽）；`issue5-234` = `0122_bot_services.sql` + snapshot `id=efa2f5db-…`。三方 prevId 均为 fbb4e855（同一 0121 基座）。
- **结论**：idx 122 必须在集成时裁决（先落者保留 0122，其余重编号为 0123+ 或按序 rebase 快照链）；这是集成者决策，非本检查点缺陷，但若两份 0122 同时合入将导致迁移历史分叉。
- 既有链断裂核验：BASE 上确有快照 parent 断裂，实际为 **0005/0055/0073/0086/0087** 五处（检查点报告引用 "0054/0055、0086/0096" 索引略不精确，但"BASE 即存在、非本次引入、阻断 drizzle-kit generate"的实质成立）。

### 3.8 与 #209 的 config.ts 交叉 — 逻辑隔离，仅文本相邻
#209 worktree 未提交改动：新增 `BIFROST_CREDITS_PER_USD` → `bifrostConversionRate`（独立模块 `gateway/conversion-rate`）。两者：不同 env 变量、不同字段（`gateway` vs `bifrostConversionRate`）、不同函数（`gatewayEnvConfig` vs `gatewayConversionRate`）——**零语义耦合**。插入点相邻（import 块、`billingConfig` 之后的函数块、`loadConfig` 展开），预计合并时出现小文本冲突，机械可解。集成时无需改任何一方逻辑。

### 3.9 专用数据库安全与测试报告准确性 — 通过
- `tests/support/database.ts`：无 `TEST_DATABASE_URL` 即抛错、拒绝 `openbot` 库、强制 postgres 协议——无开发库回退路径。
- 本 review 全程仅连接 `openbot_207`（localhost:5432）；该库 123 条迁移、`gateway_configs` 现为 0 行（测试 afterAll 清理 + 探针自清理）。`openbot`、`openbot_test`、`openbot_wave1` 等未触碰。
- **报告准确性**：13/0、8/0、typecheck exit 0、biome exit 0（9 个 TS 文件）逐项重跑一致；"123 条迁移" 一致；`config.test.ts` 的 "enables Google authentication…" 失败经干净 BASE 提取（`git archive f0520524` 至 /tmp，仅 symlink node_modules）复跑证实 **BASE 原样存在**，与本次改动无关——该披露属实。唯一不精确处为 3.7 所述既有断裂索引引用。

## 四、Findings 汇总

| # | 严重度 | 位置 | 问题与证据 | 处置建议 |
| --- | --- | --- | --- | --- |
| F1 | **Medium（必修）** | `server/src/gateway/endpoint.ts:46-56`；`server/src/config.ts:1514` | timeout 无上界：`PUT requestTimeoutMs=3000000000` 实测 `PostgresError: integer out of range` → 500（事务回滚无脏写），破坏"非法输入 400 带原因"契约；env 路径同样无界 | `parseRequestTimeoutMs` 增加 `raw <= 2_147_483_647`（int4 对齐）或运营上限（如 600_000）；补一条拒绝用例 |
| F2 | Low | `server/drizzle/meta/_journal.json:867` | 文件丢失末尾换行（原文件有），产生永久性 diff 噪音 | 恢复尾部 newline（与既有 journal 惯例一致） |
| F3 | Info | `server/src/gateway/endpoint.ts:31-43` | WHATWG 宽松 URL（`http:/example.com`、IDN）被规范化接受为 origin 存储——与 LAGO_API_URL 同语义先例一致，存储值为规范化 origin | 可接受；如需更严可在 parse 显式拒绝（非必须） |
| F4 | Info | `server/src/gateway/routes.ts` | PUT 需完整三元组（无部分更新）；仅改 timeout 需重发 baseUrl | 切片内合理；01.2 UI 需按全量表单提交 |
| F5 | Info（集成阻塞项） | `server/drizzle/`（三方 worktree） | idx 122 三方碰撞（207/215/234 各自未提交 0122，同基 0121）；#215 侧还缺 0122 快照文件 | 集成时由集成者裁决唯一 0122 并重编号其余；本票不处理（遵"do not integrate"） |
| F6 | Info（已披露差异复核） | 检查点报告"与票面差异" | 六项差异全部复核属实：专用表替代 settings-store 行（单调版本需原子 upsert，扁平 KV 行做不到——理由成立，且与 wave1 已验收 commit 49b7b063 布局一致）；路由未挂载/未注入容器（app.ts 越界即停，正确）；迁移手工构造（链断裂 BASE 即存在，快照/SQL/journal 三方自洽，wave1 表块来源与 base-id 声称均核验属实）；空串=未设置（optional 语义一致） | 无需处置；挂载与容器注入转交集成者/01.2 |

**无任何 High/Critical 发现。** 未发现 secret 泄露、权限绕过、版本回写、开发库污染或报告失实。

## 五、验证命令与实际结果（本 review 全部重跑）

```bash
cd server
bun test tests/gateway-endpoint-config.test.ts
  # → 13 pass / 0 fail / 39 expect()  [与报告一致]
TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_207 \
  bun test tests/gateway-endpoint-config.integration.test.ts
  # → 8 pass / 0 fail / 30 expect()   [与报告一致；仅触 openbot_207]
bun run typecheck        # tsc --noEmit → exit 0  [一致]
# 仓库根：
bunx biome lint --error-on-warnings <9 个 TS 交付文件>   # exit 0, "Checked 9 files"  [一致]
bun test tests/config.test.ts
  # → 140 pass / 1 fail："enables Google authentication…"（BASE 干净提取复跑同样失败 → 既有，与本次无关）

# 哈希：shasum -a 256 <12 文件> → 全部与 file-hashes.txt 短哈希前缀吻合（见第一节）
# 快照链：python3 解析 0121/0122/wave1-0112 → prevId 链、表集合差分、表块 diff 全核验
# 碰撞探查：ls/git show 各 sibling worktree（只读）→ 三方 0122 确认
# DB 状态：docker exec openbot-postgres-1 psql -d openbot_207 → 123 迁移、\d gateway_configs 与 schema 一致
# F1 探针：/tmp 一次性脚本挂载真实路由 PUT 3e9 → 500 "integer out of range"（已自清理，行数 0）
```

## 六、限制（Limitations）

1. 并发保存的行锁串行化由 upsert 语义与 Postgres 隔离级别推断 + 单进程顺序测试实证；未跑多进程压力竞争（票面验收为顺序两次保存，已覆盖）。
2. 运行时 Bifrost 行为、01.2/01.5/01.7 下游消费、app.ts 挂载后端到端 HTTP 行为不在本切片，未验证。
3. "未触碰 openbot/openbot_test/openbot_wave1"为现时态核验（连接面 + 测试代码面），无法历史性证明过去的执行；测试代码中无任何指向这些库的路径。
4. sibling worktree（#215/#234/#209）为并行工作区，其内容随时变动；本报告记录的是 review 时刻快照。
5. biome 未覆盖 SQL/JSON 交付文件（仓库惯例如此）；0122_snapshot.json 未逐字节人工审阅全部 161 表（以与 0121 的集合差分 + gateway 表块字段级 diff 替代，等价性更强）。

## 七、复审建议

修复 F1（一行上界 + 一条测试用例）并顺手 F2 后，本检查点即可交集成者处理挂载与 0122 编号裁决（F5）。Spec 侧无需返工：验收标准、契约产出（`GatewayEndpointConfig` 三字段只读形状、单调版本、save/read 接口、共享解析器）均达标且与 wave1 交接一致。
