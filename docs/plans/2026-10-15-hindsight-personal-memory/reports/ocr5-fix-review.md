# OCR 轮 5 fix 批次独立复审（聚焦 · 只读）

- **审阅人**：OCR 轮 5 fix 复审 Agent（Orca 分派，task_fbd370058dc7 / ctx_ac208c7128b6）
- **审阅对象**：`/Users/wuyongjun/trea/OpenBot-hindsight-exec`，HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` + 全部未提交改动
- **基线**：`reports/ocr4-fix-review.md`（OCR 轮 4 复审，23 文件 sha256 全表）+ `reports/ticket-380.md` 末尾《附录：ocr5-fix》（被审对象自述，task_c11c6036bc85，2026-10-16 23:0x CST）；"reports/" 指 `docs/plans/2026-10-15-hindsight-personal-memory/reports/`
- **纪律**：只读。未 commit/push，未修改任何被审文件（本报告除外）；未触碰真实容器配置（`openbot-hindsight` 审阅前后均 `Up (healthy)`、8888 仅绑 127.0.0.1、9999 保持不发布、`/version` 应答正常、started 时间未变）；未运行 `iostat -c`。stand-in 行为矩阵用本审阅独立探针端口 19112–19115、日志/产物全部入 `/tmp/ocr5rev-*`，用后已删除并复核 0 残留、0 监听、0 残留进程。

## 结论速览

| 维度 | 判定 |
| --- | --- |
| 检查点完整性（23 个交付文件 sha256 全表） | **PASS**（19 个未改动文件 == ocr4-fix-review 基线逐字节，含 index.ts `21f9fd8c…`/health.ts `ffa9d477…`/config.ts `6ce1b396…`/verify-health.ts `590ffddf…`；4 个本轮改动文件 == ocr5-fix 附录"改后"值（example `8e3d247e…`/standin `85852251…`/README `ddf476b0…`/backup.sh `d7237dfd…`）。**零偏差**） |
| 变化集 == 预期（4 文件 + 报告追加） | **PASS**（example/README/standin 以主 worktree 改前副本真 diff：恰 1+2+2 hunk，逐 hunk 归属附录声明；backup.sh 无 `19beb92f` 改前副本留存，以 wave-2 副本 `b7270f9d` 做累计 diff：恰 4 hunk = ocr4 已记录 3 处 + 本轮唯一新 hunk `@@57`（全 `#` 注释行，sweep 块本体与 wave-2 **逐字节一致**）；全仓 mtime 扫描 post-22:45 仅另有 ocr4 复审者报告与 `ledger.md`（裁决 13 记账，编排事实源）。**交付物零夹带**） |
| medium（example 占位符 + standin 非回环硬护栏） | **已解决**（example 无未注释 9100/host.docker.internal 赋值残留，`change-me-gateway-base-url` 与文件 `change-me-*` 惯例一致；bareOrigin 对该值类 fail-loud 实测成立。护栏矩阵亲测 9 场景全过：默认回环可用、`--host 0.0.0.0` 无旗标 5 行拒绝 exit 2 零监听、`--allow-non-loopback` 可绑定且 `/v1` 往返 200、`--port` 缺参/`abc`/`70000`/`0`/`--port --host` 均单行可读报错 exit 2、杀进程后端口归零） |
| 顺手 low×3（端口校验、req error 处理器、backup.sh 注释） | **已解决**（端口域 1..65535 校验实测；中途断连 curl exit 28 → 日志记 `{"kind":"request-error","error":"Error: aborted"}`、**进程存活**、后续往返 200；backup.sh 新注释与 `config.ts` 实测一致：`MIN_BACKUP_RETENTION_DAYS = 1`、`< 1 → backup_retention_days` 违规，失实旧注释已消除且"双侧 fail-loud"表述与两侧代码行为吻合） |
| 附录声明不修项（standin `path.startsWith` 近死代码、log 写入 try/catch + EADDRINUSE、verify-health `process.exit` 截断） | **自洽**（通读确认三处均原样未动，与"留待 Wave 2"声明一致；verify-health.ts 哈希仍 `590ffddf…` 未改） |
| 新问题引入 | **无 critical/high/medium**（1 low：附录 medium 段"照抄即被 config.ts 拒绝"的机制表述精度；2 info：ledger.md 未在附录变化集内声明、头部索引行仍止于 ocr3-fix。见 §5） |
| 测试/类型/语法（全部亲自复跑） | **PASS**（**规范 ticket-378 §2 清单 12 文件 104 pass / 0 fail / 408 expect**；hindsight 2 文件 **26/0/61**；`bunx tsc --noEmit` exit 0；`bash -n backup.sh`、`node --check gateway-standin.mjs` 均通过） |
| 附录哈希表与实测 | **一致**（4 个"改后"值逐一相符；F-C1 口径保持闭合：附录引用的 12 文件命令与 ticket-378 §2 清单逐字一致，含 bot-lifecycle.integration.test.ts） |
| **总体判定** | **PASS** |

---

## 1. 检查点完整性（sha256 全表重算）

对全部 23 个交付文件逐一重算 sha256（基线 = ocr4-fix-review §1 全表）：

**19 个未改动文件 == ocr4-fix-review 基线逐字节一致**：

| 文件 | 实测 sha256 |
| --- | --- |
| `server/src/index.ts` | `21f9fd8c007796904456303c99fb76297910b3b4890e8a4dd674c4060884a116` |
| `server/src/hindsight/health.ts` | `ffa9d47758bec4861951f8079c74e49e8a6a80c7fa9cfaa9e22cdff08ed5a563` |
| `server/src/hindsight/config.ts` | `6ce1b396a0e0476778b8fae76b09a73bf2628e86ea5ff97b793554ee1f69931c` |
| `server/tests/hindsight-health.test.ts` | `1d85e90438beaf7c3d06aad95535a103f5ff00783c268a834e476bfce75199e8` |
| `server/tests/hindsight-config.test.ts` | `783c9542b378ebd767caa7ca94da48c85f5ced36bacae07d7d80437f97ad87eb` |
| `server/src/memory/sensitivity.ts` | `18dc2d9a1b84a709e70a0b6a4f6429aa5793d226bbafa8586408d4a87e77bd67` |
| `server/src/memory/store.ts` | `c35f6f04b1c8e6768cda9e3f946c8a55c943c7831d3a3c3ea408b08cd713b44d` |
| `server/src/memory/ingestion.ts` | `0d13d16a0cb65603a97f7791095ecf62f2a55da2052bb67a86da6f104eaf9687` |
| `server/src/memory/tools.ts` | `93fa491b1ceb4e594ff717b8f56c8fd2629f162df58acfce83f6bf8c748ac93f` |
| `server/tests/memory-store.integration.test.ts` | `9a369e8ea79d107b71491264830148bba38a58ea6e97fa3daf1358922a39403e` |
| `server/tests/memory-runtime.test.ts` | `eb4b78f474af174577ce2e289258697d8d840d0e0c741cad62dc520c864b9abc` |
| `server/tests/memory-defaults.integration.test.ts` | `dd2d21c4a6691d6ed1a924c3b8578ec92042876e9e5ed506f1a932903363f765` |
| `server/tests/proactive-store.integration.test.ts` | `4d17689b54048ea9f43d35533990f9c5ffaecd44ee27eb1f04339bf568816fdc` |
| `server/tests/memory-sensitivity.test.ts` | `0701544d6e4b148000fad18ce5a577f5cb876d759780c46e8572eaacd7529a31` |
| `server/tests/memory-expiry.test.ts` | `f1fc63c9fb2a14d86837295defe99495a7ef615f2a680bb231cd289329c6ae98` |
| `server/tests/memory-intelligence.integration.test.ts` | `fdcce78399ebf5ef808c8ccbccb240862f74122f49cf545c30bdd00911be12d0` |
| `deploy/hindsight/docker-compose.yml` | `656efbb0869ffebf664fe6d5c68f8362ff5dc214b67cbb8c9dd8723d2285108a` |
| `deploy/hindsight/.gitignore` | `ad5f630d7c06efea8149b5c965b4b446417a3f71c8b85b320fcad925d2f5c572` |
| `deploy/hindsight/test/verify-health.ts` | `590ffddf075b1f47549c709e2bca1c383e395e9bba8a01d7fb19a6789dcefa5b`（附录声明本轮不改，实测未改） |

**4 个本轮改动文件 == ocr5-fix 附录"改后"值**：

| 文件 | 实测 sha256 | 附录改后值 |
| --- | --- | --- |
| `deploy/hindsight/hindsight.env.example` | `8e3d247e68b97bff1148795298835665fa7ceef153e1a62a4e14b274fd576be0` | 一致（改前 `d109e9f7…`） |
| `deploy/hindsight/test/gateway-standin.mjs` | `85852251eed0eac3bb5163f514e800c8b45cbbd9e2b140efb09033b17103a7a8` | 一致（改前 `9fd4baed…`） |
| `deploy/hindsight/README.md` | `ddf476b04c4ae14ffaad30059a5ae4da6e966c5069ae2a729015ed7fb3d792eb` | 一致（改前 `e4e8ac87…`） |
| `deploy/hindsight/backup.sh` | `d7237dfda0acdac5645f29b7cf57a3db687b24e1acf81a8d8c284467659dec59` | 一致（改前 `19beb92f…`） |

**隔离卫生**：HEAD 仍 `f0520524`；复审前后 `git status --porcelain` 均为 10 tracked M + 11 untracked 路径，与 ocr4-fix-review 记录的快照口径一致；未 commit/push。本机主 worktree（`orca/workspaces/OpenBot/hs03-selfhost-service`）保有 3 个本轮改前副本：`hindsight.env.example = d109e9f7…`、`gateway-standin.mjs = 9fd4baed…`、`README.md = e4e8ac87…`，与基线记录互证；`backup.sh` 仅有 wave-2 值 `b7270f9d…`（本轮改前 `19beb92f` 无副本留存，见 §2d 替代证法）。

## 2. 变化清单与"无夹带"证明

### 2a. hindsight.env.example —— 改前副本真 diff（`d109e9f7…` → `8e3d247e…`），恰 1 hunk

`@@ -15,19 +15,24 @@` 全部对应附录声明：

1. host 地址 NOTE 段改写：`host.docker.internal:9100` 指引降为纯注释，显式标注 "ONLY during isolated local verification … must NEVER be used in a real deployment"，`127.0.0.1:9100/v1` 同标"local verification only"，末行保留生产指引 "A real deployment fills in the approved gateway URL (e.g. http://bifrost:8080/v1)"。
2. `HINDSIGHT_API_LLM_BASE_URL` 与 `HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL` 两处默认值 `http://host.docker.internal:9100/v1` → `change-me-gateway-base-url`；embeddings 段注释同步改写。

### 2b. gateway-standin.mjs —— 改前副本真 diff（`9fd4baed…` → `85852251…`），恰 2 hunk

1. `@@ -19,25 +19,59 @@`：① Usage 头注补护栏说明（非回环 `--host` 需 `--allow-non-loopback`）；② 参数解析重写为 `readFlagValue()`——旗标缺参（含值误接下一旗标 `--port --host`，经 `value.startsWith("--")` 拒绝）→ 单行可读报错 + exit 2；③ 端口域校验 `Number.isInteger(port) && 1..65535`，否则单行报错 + exit 2；④ `LOOPBACK_HOSTS = {127.0.0.1, ::1, localhost}` 硬护栏：非回环且无 `--allow-non-loopback` → 5 行拒绝文案 + exit 2，且该守卫位于模块顶层、先于 `createServer`/`server.listen` 执行（通读确认，绑定任何端口之前退出）。
2. `@@ -91,6 +125,12 @@`：`req.on("error")`/`res.on("error")` 监听器，记 `request-error`/`response-error` 后继续服务，附 5 行动机注释（客户端中途断连不再以未捕获 ECONNRESET 崩掉替身）。

### 2c. README.md —— 改前副本真 diff（`e4e8ac87…` → `ddf476b0…`），恰 2 hunk

1. `hindsight.env.example` 布局条目：改述为 "change-me-* placeholders: fill in the approved gateway's OpenAI-compatible root **including /v1**"，host 地址标注 "**isolated local verification only** … must never be used in production"。
2. `test/gateway-standin.mjs` 布局条目：补 "Binds loopback only by default; a non-loopback `--host` … is refused unless `--allow-non-loopback` is also passed"。

### 2d. backup.sh —— wave-2 副本累计 diff（`b7270f9d…` → `d7237dfd…`），恰 4 hunk

本轮改前值 `19beb92f` 无副本留存（/tmp 演练目录已被清理），改用累计 diff 分解证法：`diff -u` wave-2 → 现值恰 **4 hunk**，其中 3 个与 ocr4-fix-review §2a 逐条对上（`@@3` 头注指针、`@@141` placement 注释 + sweep 块、`@@205` 末尾删除），**唯一本轮新 hunk 为 `@@ -57,9 +58,11 @@`**：

- 改动行全部为 `#` 注释（旧 3 行 → 新 5 行，落于声称的 55-62 注释块区域内），紧随其后的可执行校验块（`RETENTION_DAYS` 域检查 + exit 1）逐字未动；
- 新注释："which rejects 0 exactly the same way (config.ts pins the same 1..30 domain: MIN_BACKUP_RETENTION_DAYS = 1, and validateHindsightPrivacy reports backup_retention_days below that floor) … fails loudly on BOTH sides"——与 config.ts 实测一致（§3）；失实旧注释（"accepts 0 as within its ≤30 ceiling — would still report compliant"）已消除；
- **sweep 块完整性**：从两版分别提取 `# Retention sweep.` 起至 `find … -delete` 止的整块（19 行），`diff` 零输出——**逐字节一致**，ocr4 搬迁成果未被本轮破坏。

### 2e. ticket-380.md —— 只追加《附录：ocr5-fix》

该附录位于文件末尾（第 367–409 行），其后无其他内容。其中验证证据段引用的规范 12 文件清单经逐词比对与 ticket-378 §2 清单**逐字一致**（12 文件、含 `bot-lifecycle.integration.test.ts`、未替换任何文件）——F-C1 口径保持闭合。

### 2f. 全仓 mtime 扫描（夹带穷尽核查）

`find . -newermt "2026-10-16 22:45:00"`（排除 .git/node_modules）命中恰 7 项：ocr4 复审者自己的报告（22:45:39）、`ledger.md`（23:01:18，裁决 13 编排记账）、4 个交付文件（23:03–23:04）、ticket-380.md（23:08:17）。19 个未改动交付文件无一晚于 22:45。**预期外交付物改动：0**（ledger.md 见 findings F-E2）。

## 3. medium + 顺手 low 逐项解决判定

### medium（example 占位符 + standin 硬护栏）— **已解决**

- **example**：`grep -E '^[^#].*9100'` 与 `grep -E '^[^#].*host\.docker\.internal'` 均 **0 行**（无未注释残留）；`change-me-gateway-base-url` 与文件既有 `change-me-hindsight-api-key`/`change-me-gateway-api-key` 的 `change-me-<资源>` 惯例一致。
- **照抄 fail-loud 推理核实（实测）**：`cd server && bun -e` 以 `loadHindsightConfig` 探针三例——`change-me-gateway-base-url` → **REJECTED**："HINDSIGHT_MODEL_GATEWAY_URL must be a valid http(s) URL, got a value that is not a URL."；旧默认 `http://host.docker.internal:9100/v1` → **REJECTED**："…must be a bare origin: no path, query, or fragment."；对照裸 origin `http://bifrost:8080` → ACCEPTED。占位符（及旧默认）在该值类上确被 config.ts fail-loud 拒绝；但注意 `loadHindsightConfig` 读取集为 `HINDSIGHT_API_URL`/`HINDSIGHT_MODEL_GATEWAY_URL` + `HINDSIGHT_PRIVACY_*`，**不含被改的两个 `HINDSIGHT_API_LLM_BASE_URL`/`…EMBEDDINGS_OPENAI_BASE_URL` 键**（server/src 全文 grep 零命中）——拒绝发生在同值家族经 config.ts 读的变量与 Hindsight 自身 provider 客户端，机制表述精度见 findings F-E1。
- **护栏矩阵（全部亲测，探针端口 19112–19115，日志 `/tmp/ocr5rev-*.log` 用后已清）**：

| 场景 | 实测 | 期望 |
| --- | --- | --- |
| 默认绑定（`--port 19112`） | `127.0.0.1:19112 LISTEN`；`POST /v1/chat/completions` → HTTP 200 + `chat.completion` JSON；kill 后 0 监听 | ✓ |
| `--host 0.0.0.0` 无旗标 | **exit 2**；stderr 恰 **5 行**拒绝文案（未鉴权/个人记忆载荷/仅隔离验证/绝不指向生产/opt-in 指引）；lsof **0 监听**（绑定前拒绝） | ✓ |
| `--host 0.0.0.0 --allow-non-loopback --port 19114` | 绑定 `*:19114`；`/v1/chat/completions` 与 `/models` 均 HTTP 200；kill 后 **0 监听** | ✓ |
| `--port`（缺参） | 单行 `--port requires a value, e.g. --port <value>`，**exit 2** | ✓ |
| `--port abc` | 单行 `--port must be a whole number between 1 and 65535 (got "abc")`，**exit 2** | ✓ |
| `--port 70000` / `--port 0` | 同上单行可读报错，**exit 2** | ✓ |
| `--host`（缺参） | 单行 `--host requires a value…`，**exit 2** | ✓ |
| `--port --host x`（值误接旗标） | 单行 `--port requires a value…`，**exit 2** | ✓ |
| 杀进程后端口归零 | 场景 1/3/5 各 kill 后 lsof 均 0 监听 | ✓ |

### 顺手 low×3 — **已解决**

- **请求流 error 处理器**：`curl --limit-rate 10k --max-time 1` 上传 2MB 请求体强制中途 abort（curl **exit 28**）→ 替身日志记 `{"kind":"request-error","error":"Error: aborted"}`，**进程存活**（kill -0 通过），随后 `/v1/chat/completions` 往返仍 **HTTP 200**；kill 后 19115 归零。
- **backup.sh 注释一致性**：config.ts 实测 `export const MIN_BACKUP_RETENTION_DAYS = 1`（行 82）、`privacy.backupRetentionDays < MIN_BACKUP_RETENTION_DAYS → violations.push("backup_retention_days")`（行 130–133）——0 被服务端拒绝；backup.sh 侧同域校验 `… -lt 1 -o … -gt 30 → exit 1`。新注释"双侧同 1..30 域拒绝 0"与两侧实现吻合（详见 §2d）。
- **端口校验**：见上表 `--port` 六连测，NaN/undefined 裸崩已消除。

## 4. 亲自复跑验证（全部在本审阅执行）

| 项 | 命令/方法 | 结果 | 期望 |
| --- | --- | --- | --- |
| 规范 12 文件套件 | `cd server && TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5573/openbot_hs01_378_test' bun test ./tests/memory-sensitivity.test.ts ./tests/memory-expiry.test.ts ./tests/memory-store.integration.test.ts ./tests/memory-runtime.test.ts ./tests/memory.test.ts ./tests/memory-intelligence.integration.test.ts ./tests/memory-shared-source.test.ts ./tests/memory-defaults.integration.test.ts ./tests/memory-default-source-tool.test.ts ./tests/proactive-store.integration.test.ts ./tests/intelligence-memory.test.ts ./tests/bot-lifecycle.integration.test.ts`（容器 `openbot-hs01-378-pg` Up 23h；清单与 ticket-378 §2 逐字一致） | **104 pass / 0 fail / 408 expect / 12 files** | 104/0/408 ✓ |
| hindsight 2 文件 | `bun test ./tests/hindsight-config.test.ts ./tests/hindsight-health.test.ts` | **26 pass / 0 fail / 61 expect** | 26/0/61 ✓ |
| 类型检查 | `cd server && bunx tsc --noEmit` | exit 0 | ✓ |
| 语法检查 | `bash -n deploy/hindsight/backup.sh`；`node --check deploy/hindsight/test/gateway-standin.mjs` | 均通过 | ✓ |
| example 复核 | `grep -E '^[^#].*9100'`、`grep -E '^[^#].*host\.docker\.internal'` | 均 0 行 | ✓ |
| README 复核 | `grep -rn -- '--host 0.0.0.0'`（全仓 .md + mjs） | 交付物内仅 2 处命中：standin Usage 护栏说明、README 第 45 行护栏条目（同条目含 `--allow-non-loopback`）；**无裸用法** | ✓ |
| 附录哈希表 | 4 个"改后"值 vs 实测 | 逐一一致 | ✓ |
| F-C1 口径 | 附录引用清单 vs ticket-378 §2 原文 | 逐字一致（含 bot-lifecycle） | ✓ |
| 探针清理 | `rm /tmp/ocr5rev-*`；lsof 19112–19115；pgrep standin | 0 残留 / 0 监听 / 0 进程 | ✓ |
| 真实容器复核（审阅前后各一次） | `docker ps` + `curl /version` | 全程 `Up (healthy)`、8888 仅 127.0.0.1、9999 不发布、`/version` 应答正常、started 未变 | ✓ |

## 5. Findings（无 critical / high / medium）

| # | 级别 | 发现 | 建议 |
| --- | --- | --- | --- |
| F-E1 | low | 附录 medium 段"照抄不改会被 config.ts `bareOrigin` 校验 fail-loud 拒绝"的机制表述不精确：config.ts（含 `loadHindsightConfig` 全文）**不消费**被改的 `HINDSIGHT_API_LLM_BASE_URL`/`HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL` 两键（server/src grep 零命中；config.ts 只读 `HINDSIGHT_API_URL`/`HINDSIGHT_MODEL_GATEWAY_URL` + `HINDSIGHT_PRIVACY_*`）。bareOrigin 对该值类的 fail-loud 行为本审阅实测属实（占位符 → "not a URL"；旧默认 → "no path"），但拒绝路径是同一网关根在 config.ts 读的变量（验证流中操作者需把 approved gateway 根填入 `HINDSIGHT_MODEL_GATEWAY_URL`）与 Hindsight 自身 provider 客户端，而非这两个键自身被 config.ts 校验。修复本身的安全效果不受影响（占位符确实不可照抄即用） | 后续修订附录措辞：把"照抄即被 config.ts 拒绝"收敛为"同一占位符值一旦进入 config.ts 读取的 URL 变量（HINDSIGHT_API_URL / HINDSIGHT_MODEL_GATEWAY_URL）即被 bareOrigin fail-loud 拒绝（已实测）"；或在附录注明两键的消费方是 Hindsight 容器 |
| F-E2 | info | `ledger.md`（23:01:18，裁决 13 记账：轮 5 findings 裁决 + 修法 + 后续流程）在本轮执行窗口被更新，不在附录声明的"仅 4 文件 + 本报告"集合内。属 AGENTS.md 认可的编排事实源（Git + Superpowers Ledger），与历轮 ledger 更新模式一致（裁决 11/12 同类），且内容为本轮裁决记录而非交付物——**非夹带**，但严格读附录声明时会显得变化集不穷尽 | 后续附录末尾加一句"ledger 已同步裁决 N"或明确 ledger 不在交付物口径内 |
| F-E3 | info | 头部引用块（第 26–32 行）指针仍止于 ocr3-fix，未为 ocr4-fix/ocr5-fix 追加导航行——与轮 4 复审 F-D2 同类，系"只追加"纪律的自然结果，不算偏差 | 维护者裁量：大版本 checkpoint 时在头部补总索引行 |

**遗留卫生备注**：/tmp 中仍存有更早轮次的旧探针残档（`gateway-standin-ocr3.log/.out`、`hindsight-gateway-standin-ocr4.log`、`hindsight-standin.out` 等），非本轮产物、不在本审阅清理范围，仅记录供后续统一清扫。本轮执行者对其声明的探针产物（19102–19107 日志/stdout 转储/2MB 请求体）清理属实——/tmp 复核无相应残留，F-D1 教训已吸收。

## 6. 总体判定

**PASS。** medium 修复（example 网关 URL 默认值改 `change-me-gateway-base-url` 占位符 + host.docker.internal 指引降级为仅隔离验证注释；gateway-standin.mjs 非回环硬护栏）与 3 条顺手 low（参数解析可读报错、请求流 error 处理器断连存活、backup.sh 注释如实化）经改前副本真 diff 逐 hunk 归属 + 本审阅独立护栏矩阵 9 场景实测（含 5 行拒绝 exit 2 零监听、`--allow-non-loopback` 往返 200、断连后进程存活）证实真正解决且无行为回归；23 文件 sha256 全表零偏差，交付物变化集与附录声明穷尽对齐、零夹带（backup.sh 以 wave-2 累计 diff + sweep 块逐字节比对证明本轮 delta 恰为单一注释 hunk）；声明不修的 3 条 low 确未改动、自洽；规范 12 文件套件 104/0/408、hindsight 26/0/61、tsc 0、bash -n/node --check 通过；工作区隔离卫生（HEAD 不变、git status 不变、真实容器零触碰、探针端口与 /tmp 全清）。仅 1 low（附录机制表述精度）+ 2 info（ledger 记账口径、头部索引行），无阻塞。

— 审阅完成于只读工作区，未改动任何被审文件（本报告除外），未 commit/push。
