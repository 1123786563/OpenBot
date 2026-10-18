# OCR fix 批次独立复审（diff-of-diffs · 只读）

- **审阅人**：OCR fix 批次复审 Agent（Orca 分派，task_f0f269c9dc79 / ctx_84b936095ad0）
- **审阅对象**：`/Users/wuyongjun/trea/OpenBot-hindsight-exec`，HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` + 全部未提交改动
- **基线**：`reports/final-delivery-review.md` §1 sha256 表（fix1 后状态）+ `reports/ticket-378.md` 附录 ocr-fix + `reports/ticket-380.md` 附录 ocr-fix（"reports/" 均指 `docs/plans/2026-10-15-hindsight-personal-memory/reports/`）
- **纪律**：只读。未 commit/push，未修改任何被审文件（本报告除外）；运行态探针全部写在 `/tmp/ocrfix-review-w`，专用测试库为既有容器 `openbot-hs01-378-pg`（127.0.0.1:5573）。

## 结论速览

| 维度 | 判定 |
| --- | --- |
| 检查点完整性（23 个交付文件 sha256 全表） | **PASS**（与两份 ocr-fix 附录逐字节一致；未改动文件同时与 final-delivery-review §1 基线一致） |
| 变化集 == 预期（hs01 6 文件 + hs03 3 文件，其余零变化） | **PASS**（逐文件 diff-of-diffs 证实，无预期外改动） |
| R1（口令不经 argv） | **已解决**（代码 + 本审阅实时探针：645 份 ps 快照 0 命中，备份链路 exit 0） |
| R2（RETENTION_DAYS=0 显式拒绝） | **已解决**（=0/=31/=abc 全 exit 1 且零文件；find 参数被 1..30 校验钉在 +0..+29） |
| R4（Linux host.docker.internal） | **已解决**（compose `extra_hosts: host-gateway` 渲染确认 + README Linux 节） |
| R7（Intelligence-only 行敏感编辑拒绝） | **已解决**（supersede 前拒绝、镜像原文保留、专用文案、集成测试通过） |
| R8（hindsight.env 回退取值） | **已解决**（本审阅实测：宿主 env 缺省时文件值 25 生效；宿主 env 31 压过文件 25） |
| 新问题引入 | **无 critical/high/medium**（2 条 info 级文档/边界备注，见 §5） |
| 测试/类型/语法（全部亲自复跑） | **PASS**（104/0/408 + 22/0/53 + tsc 0 + bash -n + shellcheck 0） |
| **总体判定** | **PASS** |

---

## 1. 检查点完整性（sha256 全表重算）

对审阅工作区全部 23 个交付文件逐一重算 sha256，与两份 ocr-fix 附录的"ocr-fix 后"值**逐字节一致**：

**hs01 侧（16 文件，对照 ticket-378 附录 ocr-fix 表）**：

| 文件 | 本次实测 sha256 | 与附录 | ocr-fix 改动 |
|---|---|---|---|
| `server/tests/memory-store.integration.test.ts` | `9a369e8e…39403e` | 一致 | 否 |
| `server/tests/memory-runtime.test.ts` | `eb4b78f4…c864b9abc` | 一致 | 否 |
| `server/tests/memory-defaults.integration.test.ts` | `dd2d21c4…903363f765` | 一致 | 否 |
| `server/tests/proactive-store.integration.test.ts` | `4d17689b…68816fdc` | 一致 | 否 |
| `server/src/memory/sensitivity.ts` | `18dc2d9a…7e77bd67` | 一致 | **是** |
| `server/src/memory/store.ts` | `c35f6f04…d713b44d` | 一致 | **是** |
| `server/src/memory/ingestion.ts` | `0d13d16a…f104eaf9687` | 一致 | 否（fix1 值） |
| `server/src/memory/tools.ts` | `93fa491b…8c748ac93f` | 一致 | 否 |
| `server/src/index.ts` | `ceb5e581…36266a42` | 一致 | 否 |
| `server/src/hindsight/health.ts` | `72cc7824…397ff57e` | 一致 | **是** |
| `server/src/hindsight/config.ts` | `d10aa347…3bc3bfab` | 一致 | 否 |
| `server/tests/memory-sensitivity.test.ts` | `0701544d…2eaacd7529a31` | 一致 | **是** |
| `server/tests/memory-expiry.test.ts` | `f1fc63c9…29c6ae98` | 一致 | 否 |
| `server/tests/memory-intelligence.integration.test.ts` | `fdcce783…911be12d0` | 一致 | **是** |
| `server/tests/hindsight-health.test.ts` | `f6fc21d6…51626229` | 一致 | **是** |
| `server/tests/hindsight-config.test.ts` | `52700e33…f2356d37` | 一致 | 否 |

**hs03 侧（7 个可入库文件，对照 ticket-380 附录 ocr-fix 表）**：`docker-compose.yml 656efbb0…`、`README.md e4e8ac87…`、`backup.sh 538d0fc4…`（均 **ocr-fix 改动**）；`hindsight.env.example d109e9f7…`（fix1 值，未动）、`.gitignore ad5f630d…`、`test/gateway-standin.mjs 9fd4baed…`、`test/verify-health.ts dff17709…`（未动）——全部一致。

**未改动 13 文件的双基线核验**：上述全部"否"文件同时与 final-delivery-review §1 记录的 fix1 后 sha256 逐字节一致（两套基线互相印证）。

**隔离卫生**：`deploy/hindsight/` 仅 7 个可入库文件（git-ignored 实值 `hindsight.env` 与 `backups/` 不在执行工作区，符合 final-delivery-review F-I8 卫生声明）；`git status` 与基线记录的文件集完全一致（10 个 tracked M = 原 9 个 + ocr-fix 新增改动的 `memory-intelligence.integration.test.ts`；无多余文件）。

**CONTEXT.md 说明**：两 worktree 副本不同（exec `92c7d982…` vs hs01-candidate-review `46341ddf…`），差异内容即 final-delivery-review F-L4 已记录的个人记忆 + billing 术语；exec 副本 mtime `2026-10-15 16:36` 早于本批次全部文件（`2026-10-16 03:33+`），证实该分歧源自裁决 6 集成期、**非 ocr-fix 批次所改**。CONTEXT.md 本不在 sha256 检查点表内。

## 2. diff-of-diffs 变化清单（fix1 基线 → 现工作区）

ocr-fix 前内容通过三个来源复原并逐一实测哈希命中：① `hs01-candidate-review` worktree（4 个 hs01 文件，哈希 = fix1 记录值）；② `hs03-selfhost-service` worktree（`health.ts`、`hindsight-health.test.ts`，哈希 = #380 基线值）；③ HEAD 提交版（`memory-intelligence.integration.test.ts`，`0c5e1317…`，本批前未被任何票改动）。实际 `diff -u` 结果：

| # | 文件 | 改前 → 改后 sha256 | 实测 diff 内容 |
|---|---|---|---|
| 1 | `server/src/memory/store.ts` | `809ebf7c…` → `c35f6f04…` | **仅 1 个 hunk**：`update()` intelligence 分支内、`enabled` 拒绝之后、取 `remoteId` 之前，新增 6 行——`patch.content && sensitivity !== "normal"` → `MemoryRefusedError`（专用文案，见 §3-R7） |
| 2 | `server/src/memory/sensitivity.ts` | `1e779ffc…` → `18dc2d9a…` | **仅 1 个 hunk**：`pwd`/`pass code` 的 `[=:]` 值分支不变；`is` 分支加 lookahead `(?=\S*(?:\d|[^\w\s.,!?;:]))`——后随 token 须含数字或非句读标点符号才命中 |
| 3 | `server/src/hindsight/health.ts` | `4ca854ce…` → `72cc7824…` | **恰 3 处**：① import `getLogger` + `PrivacyViolationId`（type import），模块级 `const log = getLogger("server")`；② `violations?: string[]` → `PrivacyViolationId[]`；③ catch 捕获 error 并 `log.info`（`type/error/detail/timestamp`，detail 含 HTTP status 文本），仍返回 `gateway_down`；④ deps 合并由 spread 改 per-key `deps?.fetch ?? …` / `deps?.now ?? …` |
| 4 | `server/tests/memory-intelligence.integration.test.ts` | `0c5e1317…`(=HEAD) → `fdcce783…` | **恰 +13 行**：R7 新测试（`rejects.toBeInstanceOf(MemoryRefusedError)` + `fake.live(ada)` 内容不变断言"拒绝而非 supersede"），插入位置在相邻 Intelligence 测试之间 |
| 5 | `server/tests/hindsight-health.test.ts` | `a84921aa…` → `f6fc21d6…` | **恰 +13 行**：deps 回退新测试（`now: undefined` 注入 + fetch 保持注入的确定性版本；断言 `service_up` + `version` + `checkedAt` 合法 ISO） |
| 6 | `server/tests/memory-sensitivity.test.ts` | `717b190d…` → `0701544d…` | **纯增 4 个断言 + 3 行注释**：正例 `"her pwd is p@ssw0rd"` → credential；反例 `"the passcode is required"`、`"our pwd is wrong"` → normal。无任何删改 |
| 7 | `deploy/hindsight/backup.sh` | `99564e0d…`(fix1) → `538d0fc4…` | 口令改 stdin（`printf \| docker compose exec -T sh -c 'IFS= read -r PGPASSWORD…'`）；校验改 `1..30`（0 显式拒绝，含指引文案）；宿主 env → 同目录 `hindsight.env` 锚定 sed 取值 → 默认 30 的三级解析（容忍引号/CR）；`umask 077` + 隐藏 `.part` 文件 + EXIT trap + `gzip -t` 后才 `mv`；cron 示例行加 `mkdir -p`；头注/sweep 注释同步。改前全文无本地副本（见 §5 备注 a），以附录 R1/R2/R8/R3/R12 描述 + 现文件全文审读核对，语义完全对应 |
| 8 | `deploy/hindsight/docker-compose.yml` | `20e53cbf…`(#380 原值) → `656efbb0…` | **恰 1 处**：hindsight 服务新增 `extra_hosts: ["host.docker.internal:host-gateway"]` + 注释（Engine ≥ 20.10 / Docker Desktop 原生差异）。镜像 pin、loopback 端口、9999 不发布、healthcheck 等其余内容与基线声明一致 |
| 9 | `deploy/hindsight/README.md` | `62ede825…`(fix1) → `e4e8ac87…` | Operating 节新增 Linux 说明段（映射语义、旧引擎/特殊网络回退 `docker0` 桥 IP、(re)create 时生效），其余声明未动 |

**预期外改动**：0。除上表 9 个文件外，全部交付文件（含 `config.ts`、`ingestion.ts`、`tools.ts`、`index.ts`、`hindsight-config.test.ts` 等）与基线逐字节一致；`memory-intelligence.integration.test.ts` 是 tracked 文件集中唯一的新增 M（其 diff 即第 4 行）。三个测试文件的 diff 均为**纯新增**，无断言删改/弱化。

## 3. OCR medium 逐项解决判定

### R7（hs01 · store.ts Intelligence 分支敏感编辑）— **已解决**
- 位置正确：credential 公共检查在分支前照旧拒绝；新检查在 `supersede` 之前，被拒编辑**不可能**触达 Intelligence 写路径——集成测试断言 `fake.live(ada)` 原文保留，证实"拒绝而非 supersede"。
- `sensitivity` 变量为分支前 `update()` 既有计算（fix1 F-M1 引入），无重复分类；`patch.content` 经 `memoryPatchSchema`（`z.string().trim().min(1)`）保证非空，`patch.content &&` 判空无漏洞。
- 专用文案与本地行 F-M1 回落语义区分合理（Intelligence 行无 reviewState 可回落）；本地行分支零改动。新测试在 12 文件套件与单文件运行均通过。

### R1（hs03 · backup.sh 口令不经 argv）— **已解决**
- 静态：口令仅经 `printf '%s\n' | docker compose exec -T` stdin 进入容器 shell（`IFS= read -r` + `export`），exec 参数仅 `pg-dump <bin> <user> <db>`；宿主 `printf` 为 builtin，无外部进程 argv 携带口令；`</dev/null` 防管道残留被下游消费；stdin EOF → `exit 3` loud fail。
- **本审阅实时探针**：真实容器完整备份复跑（exit 0），期间以 50ms 间隔采样宿主 `ps auxww` 共 645 行——`PGPASSWORD` 字样 **0 命中**、真实口令值 **0 命中**。容器内 `/proc/<pid>/environ` 的 PGPASSWORD 为执行者已记录的既有等价暴露（原 `-e` 方案同样存在），非本批新增。

### R2（hs03 · RETENTION_DAYS=0）— **已解决**
- **本审阅实测**（/tmp harness，正确 env 变量名）：`=0`、`=31`、`=abc` 均 `exit 1` 且打印含指引的拒绝信息（"to keep no backups, do not schedule this job"），`backups/` 目录零文件产生。
- 闭环成立：校验钉死 `1..30` ⇒ `find -mtime` 参数恒在 `+0..+29`，`-mtime -1` 退化不可能。边界语义（+N 整 24h 周期、精确 30.0 天删除）有 fix1 + ocr-fix 两轮附录测量记录，本次头注/注释与实现一致性经审读核实。

### R4（hs03 · Linux host.docker.internal）— **已解决**
- **本审阅实测** `docker compose config` 渲染：`host.docker.internal=host-gateway` 存在且仅此一处新增；注释含 Engine 版本前提。
- README Linux 节（54–59 行）：映射语义、无映射环境的回退（容器可达宿主地址如 `docker0` 桥 IP）、映射生效时机（容器 (re)create），与 compose 改动互相引用一致。本机 macOS 不受影响、容器未重建——与附录声明一致。

### R8（hs03 · 宿主 env 未设时从 hindsight.env 取值）— **已解决**
- **本审阅实测**：宿主 env 未设 + 同目录 `hindsight.env` 写 `HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS=25`（含干扰密钥键）→ 真实备份输出 `retention 25d`（文件回退生效）；宿主 env=31 压过文件 25 → 拒绝信息 `got "31"`（env 优先级 = compose 语义）。无文件时默认 30 由执行者附录记录（本工作区无 hindsight.env，§4 全套测试期间脚本行为亦与之相容）。
- 解析细节审读通过：`^KEY=` 锚定 + `tail -n 1` 最后一行生效、一层成对引号、CR 容忍；非裸整数仍被校验大声拒绝；其余键（密钥）不读不回显。

### 附带核验 R3/R12（非 medium，本批加固项）— **成立**
- R3：`umask 077`（实测产物 `-rw-------`）、隐藏 `.part` 名（双重不匹配 sweep 正式名 glob）、EXIT trap（失败路径无残留，附录有实测；本次成功路径 `backups/` 亦仅正式名文件）、`gzip -t` 通过后才 `mv`（实测 `gzip -t` OK + 明文 57,902 B 与附录逐字节同值 + `-- PostgreSQL database dump` 头）。
- R12：头注 cron 行含 `mkdir -p … && …` 及重定向先于脚本执行的说明。

## 4. 亲自复跑验证（全部在本审阅执行）

| 项 | 命令 | 结果 | 期望 |
|---|---|---|---|
| 全套 12 文件 | `cd server && TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5573/openbot_hs01_378_test' bun test …`（ticket-378 §2 文件清单） | **104 pass / 0 fail / 408 expect / 12 files** | 104/0 ✓ |
| hindsight 2 文件 | `bun test ./tests/hindsight-config.test.ts ./tests/hindsight-health.test.ts` | **22 pass / 0 fail / 53 expect** | 22/0 ✓ |
| 类型检查 | `cd server && bunx tsc --noEmit` | exit 0 | ✓ |
| 语法 | `bash -n deploy/hindsight/backup.sh` | 通过 | ✓ |
| Lint（加分项） | `shellcheck -S warning deploy/hindsight/backup.sh` | 0 findings | ✓ |
| 单文件抽查 | memory-intelligence（11 pass，含 R7 用例）、memory-sensitivity（7 pass/72 expect）、hindsight-health（含 deps 回退用例 + `hindsight-health-gateway-probe-failed` 日志行实测输出 `{"error":"Error","detail":"connection refused",…}`，状态键集不变） | 全过 | ✓ |
| 运行态探针 | §3 所列 R1/R2/R8/R3 实测（/tmp，仓库零写入） | 全过 | ✓ |

复跑后 `git status` 与审阅前完全一致（无新增文件/改动）；HEAD 仍 `f0520524`。

## 5. Findings（无 critical / high / medium）

| # | 级别 | 发现 | 建议 |
|---|---|---|---|
| F-A1 | info | `ticket-378.md` 附录 ocr-fix 第 5 条称 sensitivity 新增"正反例各 2 条"，实际 diff 为**正例 1 + 反例 2**（is 分支正例 `"the pwd is hunter2"` 系 fix1 既有断言，非本批新增）；断言覆盖语义等价，仅计数表述不精确 | 无需行动；如后续修订报告可顺手更正 |
| F-A2 | info | `is` 分支收窄后，纯小写字母形态的值（如 "my pwd is hunter"，无数字/符号）不再判为 credential——这是裁决选择的价值形态折中（`[=:]` 显式赋值分支仍全捕），方向为减少散文误拒，与"宁误拒"基线的偏移已在裁决与头注中披露 | 记录为已裁决边界；Wave 2 如收紧需与 #394 一并设计 |

（备注：`backup.sh` 的 hs03 改前内容在本机无副本可 diff——`99564e0d`/`20e53cbf`/`62ede825` 三个 fix1 值仅存于附录记录；该 3 文件的 diff-of-diffs 以"现文件全文审读 + 附录逐项语义核对 + sha256 链（基线值 ≠ 现值）"方式完成，其余 6 文件为逐字节真 diff。）

## 6. 总体判定

**PASS。** 当前工作区与两份 ocr-fix 附录的检查点逐字节一致；变化集恰为授权的 hs01 6 文件 + hs03 3 文件，无预期外改动，测试 diff 纯新增；五项 OCR medium（R1/R2/R4/R7/R8）全部以代码审读 + 本审阅独立实测（含实时 ps 探针、拒绝路径复跑、env 回退复跑、compose 渲染）证实真正解决；104/0、22/0、tsc 0、bash -n、shellcheck 0 全部亲自复现。仅 2 条 info 级备注，无阻塞。可进入提交流程（仍须由有提交授权方执行）。

— 审阅完成于只读工作区，未改动任何被审文件（本报告除外），未 commit/push。
